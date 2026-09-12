/**
 * THE BETRAYED WILL — lighting.js
 *
 * Time of day, weather, interiors and firelight.
 *
 * ── The one rule this file exists to enforce ─────────────────────────────────
 * What the player SEES and what the AI PERCEIVES must come from the same number.
 *
 * Stealth here is driven by `lightLevel`, which feeds exposureFor() in src/sim/ai.js
 * and from there detection range and detection time. Nothing in the simulation set
 * that value - only the tests did - so before this file existed there was no
 * authority for it at all, and the obvious way to fill the gap is to let the
 * renderer pick a brightness for the picture and the AI pick a different one for
 * perception. That produces the single worst failure a stealth game can have: a
 * guard spots you in what is visibly shadow, or fails to see you in what is visibly
 * daylight. §11's "the AI must not cheat" is not only about handicaps; an AI that
 * sees better than the player can is cheating even with every handicap in place.
 *
 * So `lightLevelAt()` is the authority for both. The lighting rig renders the
 * preset, and the same preset's `lightLevel` is what the game loop hands to the
 * perception system. They cannot drift, because there is only one of them.
 *
 * ── Values are the declared ones ─────────────────────────────────────────────
 * STEALTH.LIGHT_EXPOSURE_DAY / _NIGHT / _TORCH are the endpoints. Dawn and dusk are
 * interpolated between them rather than invented, and standing near a fire raises
 * the level to the declared torch value. No brightness in this file is a number a
 * renderer thought looked nice.
 */

import * as THREE from '../../vendor/three/three.module.js';
import { CAM, PERF, STEALTH } from '../core/constants.js';

const lerp = (a, b, t) => a + (b - a) * t;
const mixHex = (a, b, t) => {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  return (Math.round(lerp(ar, br, t)) << 16)
    | (Math.round(lerp(ag, bg, t)) << 8)
    | Math.round(lerp(ab, bb, t));
};

/** Halfway between the declared night and day exposure, for the in-between hours. */
const TWILIGHT_LEVEL = (STEALTH.LIGHT_EXPOSURE_NIGHT + STEALTH.LIGHT_EXPOSURE_DAY) / 2;

/**
 * Presets per `region.timeOfDay`.
 *
 * `lightLevel` is the stealth-authoritative exposure of open ground under this sky,
 * and it is the value the AI receives. Everything else here is how that same fact is
 * drawn.
 */
export const TIME_OF_DAY = Object.freeze({
  day: Object.freeze({
    lightLevel: STEALTH.LIGHT_EXPOSURE_DAY,
    sky: 0x9dc4dd, horizon: 0xd8cba8, sun: 0xfff2d8, sunIntensity: 2.6,
    sunElevationDeg: 58, sunAzimuthDeg: 150,
    hemiSky: 0xbcd8ea, hemiGround: 0x8a7454, hemiIntensity: 0.85,
    ambient: 0.28, fogNear: 40, fogFar: PERF.CULL_DISTANCE, fogDensity: 0.0035,
    isNight: false, shadowStrength: 1.0,
  }),
  morning: Object.freeze({
    lightLevel: TWILIGHT_LEVEL + 0.08,
    sky: 0xbcd2e0, horizon: 0xe8c79a, sun: 0xffd9a0, sunIntensity: 1.9,
    sunElevationDeg: 22, sunAzimuthDeg: 95,
    hemiSky: 0xa8c4d8, hemiGround: 0x9a8258, hemiIntensity: 0.7,
    ambient: 0.24, fogNear: 26, fogFar: PERF.CULL_DISTANCE * 0.8, fogDensity: 0.006,
    isNight: false, shadowStrength: 0.85,
  }),
  dusk: Object.freeze({
    lightLevel: TWILIGHT_LEVEL,
    sky: 0x6a5a78, horizon: 0xc8794a, sun: 0xff9a52, sunIntensity: 1.35,
    sunElevationDeg: 9, sunAzimuthDeg: 265,
    hemiSky: 0x6f6a86, hemiGround: 0x6a5334, hemiIntensity: 0.5,
    ambient: 0.2, fogNear: 20, fogFar: PERF.CULL_DISTANCE * 0.62, fogDensity: 0.009,
    isNight: false, shadowStrength: 0.7,
  }),
  night: Object.freeze({
    lightLevel: STEALTH.LIGHT_EXPOSURE_NIGHT,
    sky: 0x0d1220, horizon: 0x1b2130, sun: 0x9fb4d8, sunIntensity: 0.34,
    sunElevationDeg: 44, sunAzimuthDeg: 210,
    hemiSky: 0x223049, hemiGround: 0x14161c, hemiIntensity: 0.3,
    ambient: 0.12, fogNear: 12, fogFar: PERF.CULL_DISTANCE * 0.45, fogDensity: 0.016,
    isNight: true, shadowStrength: 0.35,
  }),
});

/** Interiors get no sky at all, and lose a declared fraction of the outdoor level. */
const INTERIOR_DIMMING = 0.55;

/**
 * Weather tints and thickens the air, and multiplies exposure by the same factor the
 * AI uses. One table, because a dust storm that dims the picture but not perception
 * would let a guard see through it.
 */
export const WEATHER_LOOK = Object.freeze({
  clear: Object.freeze({ fogMul: 1.0, tint: 0xffffff, tintAmount: 0 }),
  overcast: Object.freeze({ fogMul: 1.5, tint: 0xb8bcc2, tintAmount: 0.35, sunMul: 0.55 }),
  dust: Object.freeze({ fogMul: 3.4, tint: 0xc2a06a, tintAmount: 0.6, sunMul: 0.5 }),
  rain: Object.freeze({ fogMul: 2.2, tint: 0x7d8794, tintAmount: 0.45, sunMul: 0.5 }),
  storm: Object.freeze({ fogMul: 3.0, tint: 0x4d5560, tintAmount: 0.6, sunMul: 0.34 }),
});

/** How far a fire raises the exposure of someone standing in it. */
const TORCH_RADIUS_M = 6.0;

export class LightingRig {
  constructor(scene, { shadows = true } = {}) {
    this.scene = scene;
    this.shadowsEnabled = shadows === true;

    this.hemi = new THREE.HemisphereLight(0xbcd8ea, 0x8a7454, 0.85);
    this.ambient = new THREE.AmbientLight(0xffffff, 0.28);
    this.sun = new THREE.DirectionalLight(0xfff2d8, 2.6);
    this.sun.castShadow = this.shadowsEnabled;
    if (this.shadowsEnabled) {
      // One shadow-casting light for the whole scene. A second would double the
      // shadow pass, and the firelight that would want it is animated - an animated
      // shadow map is the most expensive thing in a forward renderer.
      this.sun.shadow.mapSize.set(2048, 2048);
      this.sun.shadow.bias = -0.0008;
      this.sun.shadow.normalBias = 0.035;
      const s = 34;
      const c = this.sun.shadow.camera;
      c.left = -s; c.right = s; c.top = s; c.bottom = -s;
      c.near = 0.5; c.far = 160;
      c.updateProjectionMatrix();
    }
    scene.add(this.hemi, this.ambient, this.sun, this.sun.target);

    this.fog = new THREE.Fog(0x9dc4dd, 40, PERF.CULL_DISTANCE);
    scene.fog = this.fog;

    this.preset = TIME_OF_DAY.day;
    this.weather = 'clear';
    this.indoor = false;
    /** Fire positions from the current RegionMesh, for lightLevelAt(). */
    this.fires = [];
    this.applied = { sky: null, timeOfDay: null, weather: null, indoor: null };
  }

  get isNight() { return this.preset.isNight === true; }

  /**
   * Apply a region's lighting. Idempotent: re-applying the same combination does no
   * work, because the game loop calls this every frame and reallocating a fog object
   * sixty times a second is how a renderer acquires a stutter nobody can explain.
   */
  apply(regionDef, { weather = 'clear', fires = null } = {}) {
    const timeOfDay = TIME_OF_DAY[regionDef?.timeOfDay] ? regionDef.timeOfDay : 'dusk';
    const indoor = regionDef?.indoor === true;
    if (fires) this.fires = fires;

    if (this.applied.timeOfDay === timeOfDay && this.applied.weather === weather
      && this.applied.indoor === indoor && !fires) {
      return false;
    }
    this.applied = { timeOfDay, weather, indoor, sky: regionDef?.id ?? null };

    const base = TIME_OF_DAY[timeOfDay];
    const look = WEATHER_LOOK[weather] ?? WEATHER_LOOK.clear;
    const wx = STEALTH.WEATHER_EXPOSURE[weather] ?? 1;
    this.preset = base;
    this.weather = weather;
    this.indoor = indoor;

    // Interiors: no sky contribution, dimmed by a declared fraction. The dimming
    // applies to the stealth level too, so a dark interior is genuinely easier to
    // hide in - which is what the player can see.
    const dim = indoor ? INTERIOR_DIMMING : 1;
    this.effectiveLevel = base.lightLevel * dim * wx;

    const sky = mixHex(base.sky, look.tint, look.tintAmount);
    const horizon = mixHex(base.horizon, look.tint, look.tintAmount);
    this.scene.background = this._skyTexture(sky, horizon);

    this.hemi.color.setHex(mixHex(base.hemiSky, look.tint, look.tintAmount * 0.6));
    this.hemi.groundColor.setHex(mixHex(base.hemiGround, look.tint, look.tintAmount * 0.4));
    this.hemi.intensity = base.hemiIntensity * dim * (look.sunMul ?? 1);
    this.ambient.intensity = base.ambient * dim;

    this.sun.color.setHex(base.sun);
    this.sun.intensity = indoor ? base.sunIntensity * 0.12 : base.sunIntensity * (look.sunMul ?? 1);
    this._placeSun(base.sunElevationDeg, base.sunAzimuthDeg);

    this.fog.color.setHex(sky);
    this.fog.near = base.fogNear * (1 / look.fogMul) * 0.9;
    this.fog.far = base.fogFar;
    return true;
  }

  _placeSun(elevationDeg, azimuthDeg) {
    const el = (elevationDeg * Math.PI) / 180;
    const az = (azimuthDeg * Math.PI) / 180;
    const r = 90;
    this.sun.position.set(
      Math.cos(el) * Math.sin(az) * r,
      Math.max(6, Math.sin(el) * r),
      Math.cos(el) * Math.cos(az) * r,
    );
  }

  /**
   * A vertical gradient sky drawn once per apply, not a cubemap.
   *
   * There are no downloaded images, so the sky is generated: a canvas gradient from
   * horizon to zenith. It is rebuilt only when the region or weather actually
   * changes, which `apply` already guards.
   */
  _skyTexture(skyHex, horizonHex) {
    if (typeof document === 'undefined' || !document.createElement) {
      return new THREE.Color(skyHex);
    }
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = 4; canvas.height = size;
    const ctx = canvas.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, size);
    const hex = (h) => `#${h.toString(16).padStart(6, '0')}`;
    g.addColorStop(0, hex(skyHex));
    g.addColorStop(0.62, hex(mixHex(skyHex, horizonHex, 0.65)));
    g.addColorStop(1, hex(horizonHex));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 4, size);
    if (this._skyTex) this._skyTex.dispose();
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.mapping = THREE.EquirectangularReflectionMapping;
    this._skyTex = tex;
    return tex;
  }

  /**
   * The exposure the AI is allowed to use at a world position.
   *
   * Open ground gives the region's level. Standing near a fire raises it toward the
   * declared torch value, falling off with distance, so hiding means staying out of
   * the light the player can see. This is the same function the game loop calls to
   * build the perception truth, and there is no other source for it.
   */
  lightLevelAt(x, z) {
    let level = this.effectiveLevel ?? this.preset.lightLevel;
    let nearFire = false;
    for (const f of this.fires) {
      const dx = f.x - x;
      const dz = f.z - z;
      const d = Math.hypot(dx, dz);
      if (d > TORCH_RADIUS_M * (f.scale ?? 1)) continue;
      const t = 1 - d / (TORCH_RADIUS_M * (f.scale ?? 1));
      const raised = lerp(level, STEALTH.LIGHT_EXPOSURE_TORCH * (this.indoor ? INTERIOR_DIMMING + 0.3 : 1), t);
      if (raised > level) { level = raised; nearFire = true; }
    }
    return { level: Math.min(1, Math.max(0, level)), nearFire };
  }

  /**
   * Keep the shadow frustum around the player.
   *
   * A shadow camera covering the whole region wastes most of its 2048 texels on
   * ground nobody can see. Following the player at a fixed radius keeps shadow
   * resolution high where it is on screen, which is the difference between shadows
   * that read as geometry and shadows that read as noise.
   */
  focusShadows(x, y, z) {
    if (!this.shadowsEnabled) return;
    this.sun.target.position.set(x, y, z);
    this.sun.target.updateMatrixWorld();
    const el = this.sun.position;
    this.sun.position.set(x + el.x * 0.6, Math.max(y + 12, el.y * 0.6), z + el.z * 0.6);
  }

  /** Fire positions for lightLevelAt(), taken from a built RegionMesh. */
  static firesFrom(regionMesh) {
    const out = [];
    for (const l of regionMesh?.lights ?? []) {
      const p = l.light.position;
      out.push({ x: p.x, y: p.y, z: p.z, scale: 1, intensity: l.base });
    }
    // A hearth is physically bigger than a lamp, and lights a wider patch of floor.
    for (const prop of regionMesh?.space?.props ?? []) {
      if (prop.kind === 'fire') out.push({ x: prop.x, y: prop.y, z: prop.z, scale: 1.7, intensity: 1 });
    }
    return out;
  }

  /** A short human-readable description, for the HUD and for debugging. */
  describe() {
    return {
      timeOfDay: this.applied.timeOfDay,
      weather: this.weather,
      indoor: this.indoor,
      isNight: this.isNight,
      lightLevel: Number((this.effectiveLevel ?? this.preset.lightLevel).toFixed(3)),
      fov: CAM.FOV_DEFAULT,
    };
  }

  dispose() {
    this._skyTex?.dispose();
    this.scene.remove(this.hemi, this.ambient, this.sun, this.sun.target);
    this.sun.dispose?.();
  }
}

export { TORCH_RADIUS_M, INTERIOR_DIMMING, TWILIGHT_LEVEL };
