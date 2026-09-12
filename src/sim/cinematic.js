/**
 * THE BETRAYED WILL — cinematic.js
 *
 * The runtime director for the nine authored cinematics: what shot is on screen,
 * where the camera sits for it, and what the mission system is told when the
 * sequence has actually been watched.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * MissionManager.playCinematic() already fired at mission start and mission end,
 * set the flags a cinematic promises, and completed CINEMATIC objectives. What it
 * could not do is show anything: it emitted CUTSCENE_START and CUTSCENE_END in the
 * same synchronous call, so the sequence had zero duration and the authored shot
 * lists - subject, seconds, framing - were read by nothing at all. The camera's
 * cinematic solver, twoShot() and orbitShot() were exercised only by camera-test.
 * Every cutscene was accounted for and invisible.
 *
 * This module owns the clock the way conversation.js owns the dialogue clock: the
 * content describes what happens, the camera knows how to frame a position, and
 * something in between has to decide which shot is live at t=17.3s. That decision
 * is pacing, and pacing belongs in a pure, testable layer rather than in the DOM.
 *
 * ── The camera is not handed back mid-sequence ──────────────────────────────
 * ThirdPersonCamera._inferMode() returns CINEMATIC whenever ctx.cinematic is set,
 * and that check precedes FINISHER. So one shot authored as mode:'FINISHER'
 * (Evan, in the confrontation) is framed here using the finisher's own camera
 * constants rather than by switching ctx mid-scene: a cutscene that returned the
 * camera to the gameplay solver for a few frames would snap the player's view to
 * wherever they happened to be standing, which reads as a bug, not a cut.
 *
 * ── Named characters the world has no body for ──────────────────────────────
 * Landmarks carry a position. The player carries a position. Orin and Evan do not:
 * CHARACTERS is narrative data, and the world spawns guards, not cast. Rather than
 * invent bodies here, a character with no resolvable position is anchored to a
 * landmark the same cinematic films - which keeps the shot in the place the scene
 * was authored for - and every such anchor is counted in `fallbacks` and surfaced
 * in describe(). A silent guess would look correct in a test and wrong on screen;
 * a counted guess is a work order.
 */

import { Events, globalBus } from '../core/bus.js';
import { Vec3, lerp, clamp01, easeInOutCubic } from '../core/math.js';
import { CAM, COMBAT } from '../core/constants.js';
import { twoShot, orbitShot } from './camera.js';
import { CHARACTERS, CINEMATIC_MAP } from '../content/story.js';
import { LANDMARK_MAP, LANDMARKS_BY_REGION } from '../content/world-data.js';

/**
 * Framing vocabulary. Distances and heights are in metres and tuned against
 * CAM.FOV_CINEMATIC; `push` is how far the camera travels toward the subject over
 * the shot, and `drift` how far it swings sideways. Both exist because a locked-off
 * procedurally-generated frame looks like a screenshot, and a slow move is what
 * tells the player this is a shot rather than a loading screen.
 */
export const FRAMING = Object.freeze({
  close: Object.freeze({ distance: 2.75, height: 1.52, targetHeight: 1.55, push: 0.45, drift: 0.34, fov: 38 }),
  wide: Object.freeze({ distance: 9.60, height: 3.35, targetHeight: 1.30, push: 1.15, drift: 0.90, fov: 54 }),
  twoShot: Object.freeze({ pad: 1.15, elevation: 0.35, push: 0.60, fov: CAM.FOV_CINEMATIC }),
  orbit: Object.freeze({ radius: 4.20, height: 1.60, targetHeight: 1.25, sweep: Math.PI * 0.75, steps: 24, fov: CAM.FOV_CINEMATIC }),
});

/** Finisher-authored shots use the finisher's own camera numbers. */
const FINISHER_FOV = 40;

/** The player character, resolved from content rather than hardcoded. */
export const PLAYER_CHARACTER = Object.values(CHARACTERS).find((c) => c.player === true)?.id ?? null;

/** A shot boundary is a hard cut. Film grammar, and safer than blending through a wall. */
export const HARD_CUT = true;

function landmarkVec(id, heightAt) {
  const lm = LANDMARK_MAP[id];
  if (!lm?.pos) return null;
  const [x, y, z] = lm.pos;
  const ground = typeof heightAt === 'function' ? heightAt(x, z) : null;
  return new Vec3(x, Number.isFinite(ground) ? ground : (y ?? 0), z);
}

export class CinematicDirector {
  /**
   * @param {object} opts
   * @param {object} [opts.bus]            event bus
   * @param {string} [opts.language]       'ar' | 'en'
   * @param {Function} [opts.resolveSubject] (id) => Vec3 | null — live positions
   * @param {Function} [opts.heightAt]     (x, z) => number — terrain height
   */
  constructor({ bus = globalBus, language = 'ar', resolveSubject = null, heightAt = null } = {}) {
    this.bus = bus;
    this.language = language === 'en' ? 'en' : 'ar';
    this.resolveSubject = resolveSubject;
    this.heightAt = heightAt;

    this.current = null;
    this.elapsed = 0;
    this.duration = 0;
    this.shotIndex = -1;
    this.stopReason = null;
    this._onEnd = null;
    this._orbitCache = null;
    this._fallbacks = new Set();

    this.stats = { played: 0, refused: 0, completed: 0, skipped: 0, shots: 0, samples: 0 };
  }

  get active() { return this.current !== null && this.stopReason === null; }

  /** Characters that could not be resolved to a real position this run. */
  get fallbacks() { return [...this._fallbacks]; }

  setLanguage(language) {
    this.language = language === 'en' ? 'en' : 'ar';
    // The title card is drawn from the START payload, so a language switch mid-scene
    // has to republish it or the card stays in the language just switched away from.
    if (this.active) this.bus.emit(Events.CUTSCENE_START, this._startPayload(true));
  }

  /* ------------------------------------------------------------------ play */

  /**
   * Begin a cinematic.
   *
   * @param {string} id
   * @param {object} [hooks]
   * @param {Function} [hooks.onEnd] called once when the sequence finishes or is
   *   skipped. MissionManager uses it to emit CUTSCENE_END and complete the
   *   objective - after the player has watched, not before.
   * @returns {{ok: boolean, reason: string|null}}
   */
  play(id, hooks = {}) {
    if (this.active) return this._refuse('busy');
    const cin = CINEMATIC_MAP[id];
    if (!cin) return this._refuse('unknown');

    const shots = Array.isArray(cin.shots) ? cin.shots.filter((s) => s && s.subject) : [];
    if (!shots.length) return this._refuse('no-shots');

    // `seconds` and the shot list agree in all nine cinematics, but the shot list is
    // what actually gets sampled, so it is the authority when they ever disagree.
    const summed = shots.reduce((a, s) => a + (Number.isFinite(s.seconds) ? s.seconds : 0), 0);
    const duration = Number.isFinite(cin.seconds) && cin.seconds > 0 ? cin.seconds : summed;
    if (!(duration > 0)) return this._refuse('no-duration');

    this.current = cin;
    this.shots = shots;
    this.elapsed = 0;
    this.duration = duration;
    this.shotIndex = 0;
    this.stopReason = null;
    this._onEnd = typeof hooks.onEnd === 'function' ? hooks.onEnd : null;
    this._orbitCache = null;
    this.stats.played++;
    this.stats.shots += shots.length;

    this.bus.emit(Events.CUTSCENE_START, this._startPayload(false));
    return { ok: true, reason: null };
  }

  _refuse(reason) {
    this.stats.refused++;
    return { ok: false, reason };
  }

  _startPayload(resumed) {
    const cin = this.current;
    const loc = this.language === 'en' ? cin?.en : cin?.ar;
    const fallbackLoc = this.language === 'en' ? cin?.ar : cin?.en;
    return {
      cinematicId: cin?.id ?? null,
      seconds: cin?.seconds ?? 0,
      region: cin?.region ?? null,
      title: loc?.title ?? fallbackLoc?.title ?? cin?.id ?? '',
      text: loc?.text ?? fallbackLoc?.text ?? '',
      shots: this.shots?.length ?? 0,
      resumed: resumed === true,
    };
  }

  /* ---------------------------------------------------------------- update */

  /** Advance the sequence clock. Returns false when nothing is playing. */
  update(dt) {
    if (!this.active) return false;
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    this.elapsed += step;
    const idx = this._shotIndexAt(this.elapsed);
    if (idx !== this.shotIndex) this.shotIndex = idx;
    if (this.elapsed >= this.duration) { this._finish(false); return true; }
    return true;
  }

  /**
   * The player pressed through. A cinematic is skippable without apology: 40 seconds
   * of unskippable footage on a second playthrough is a penalty for having finished
   * the game, and the flags and objectives it sets are applied either way.
   */
  skip() {
    if (!this.active) return { ok: false, reason: 'not-active' };
    this._finish(true);
    return { ok: true, reason: 'skipped' };
  }

  _finish(skipped) {
    const cin = this.current;
    const cinematicId = cin?.id ?? null;
    const seconds = this.elapsed;
    const onEnd = this._onEnd;

    this.current = null;
    this.shots = null;
    this.elapsed = 0;
    this.duration = 0;
    this.shotIndex = -1;
    this.stopReason = skipped ? 'skipped' : 'ended';
    this._onEnd = null;
    this._orbitCache = null;

    if (skipped) this.stats.skipped++; else this.stats.completed++;

    this.bus.emit(Events.CUTSCENE_END, { cinematicId, seconds, skipped: skipped === true });
    // The mission system completes the objective here, after the watch, via the hook
    // it supplied. Emitting END first keeps the HUD teardown ahead of any objective
    // toast the completion produces.
    if (onEnd) onEnd({ skipped: skipped === true, seconds });
    this.stopReason = null;
    return { ok: true, reason: skipped ? 'skipped' : 'ended', cinematicId };
  }

  /* ---------------------------------------------------------------- camera */

  /**
   * What ThirdPersonCamera expects on ctx.cinematic.
   * Null when nothing is playing, which is what returns the camera to gameplay.
   */
  cameraPayload() {
    if (!this.active) return null;
    return {
      elapsed: this.elapsed,
      duration: this.duration,
      cinematicId: this.current.id,
      shotIndex: this.shotIndex,
      sample: (t) => this.sample(t),
    };
  }

  /**
   * Sample the whole sequence at t in [0, 1].
   *
   * Positions are resolved per sample rather than baked at play() time: the player
   * is one of the subjects in most two-shots, and a two-shot framed against where
   * the player stood 30 seconds ago is a shot of an empty doorway.
   */
  sample(t) {
    if (!this.active) return null;
    this.stats.samples++;
    const time = clamp01(Number.isFinite(t) ? t : 0) * this.duration;
    const found = this._shotAt(time);
    if (!found) return null;
    // found is {shot, start, index}. Reading seconds off the wrapper rather than off
    // the shot yields undefined, `undefined > 0` is false, and local silently pins to
    // 0 - which makes every shot a frozen frame for its whole span and turns a
    // three-shot sequence into three stills. The push and the drift were authored to
    // stop that, so this is the difference between a cutscene and a slideshow.
    const shot = found.shot;
    const seconds = Number.isFinite(shot.seconds) ? shot.seconds : 0;
    const local = seconds > 0 ? clamp01((time - found.start) / seconds) : 0;
    return this._frameFor(shot, local, found.index);
  }

  _shotIndexAt(time) {
    let acc = 0;
    for (let i = 0; i < this.shots.length; i++) {
      acc += this.shots[i].seconds ?? 0;
      if (time < acc) return i;
    }
    return this.shots.length - 1;
  }

  _shotAt(time) {
    let acc = 0;
    for (let i = 0; i < this.shots.length; i++) {
      const seconds = this.shots[i].seconds ?? 0;
      if (time < acc + seconds || i === this.shots.length - 1) {
        return { shot: this.shots[i], start: acc, index: i };
      }
      acc += seconds;
    }
    return null;
  }

  /* --------------------------------------------------------------- framing */

  _frameFor(shot, local, index) {
    const subject = this._subjectPos(shot.subject);
    if (!subject) return null;
    const mode = shot.mode === 'FINISHER' ? 'FINISHER' : 'CINEMATIC';

    switch (shot.framing) {
      case 'orbit': return this._frameOrbit(subject, local, index, mode);
      case 'twoShot': return this._frameTwoShot(subject, local, mode);
      case 'wide': return this._frameStatic(subject, local, FRAMING.wide, mode);
      case 'close':
      default: return this._frameStatic(subject, local, FRAMING.close, mode);
    }
  }

  /** A locked-off-ish shot with a slow push and a small lateral drift. */
  _frameStatic(subject, local, f, mode) {
    // COMBAT, not CAM: the finisher camera numbers are declared with the finisher's
    // range and health thresholds. Reading them off CAM yields undefined, and
    // undefined inside a lerp is NaN inside a position - a black screen for one shot
    // of one cinematic, which only the player who reaches that scene would ever see.
    const dist = mode === 'FINISHER' ? COMBAT.FINISHER_CAMERA_DISTANCE : f.distance;
    const height = mode === 'FINISHER' ? COMBAT.FINISHER_CAMERA_HEIGHT : f.height;
    const ease = easeInOutCubic(local);
    const d = lerp(dist + f.push * 0.5, Math.max(0.6, dist - f.push * 0.5), ease);
    const yaw = this._yawFor(subject) + f.drift * (local - 0.5);
    const target = new Vec3(subject.x, subject.y + (mode === 'FINISHER' ? 1.30 : f.targetHeight), subject.z);
    const position = new Vec3(
      target.x + Math.sin(yaw) * d,
      subject.y + height + (mode === 'FINISHER' ? 0 : 0.12 * ease),
      target.z + Math.cos(yaw) * d,
    );
    const fov = mode === 'FINISHER' ? FINISHER_FOV : lerp(f.fov + 1.5, f.fov - 1.5, ease);
    return { position, target, fov };
  }

  /** A sweep around the subject, using the camera module's own orbit generator. */
  _frameOrbit(subject, local, index, mode) {
    const f = FRAMING.orbit;
    const key = `${index}:${subject.x.toFixed(2)}:${subject.z.toFixed(2)}`;
    if (!this._orbitCache || this._orbitCache.key !== key) {
      this._orbitCache = {
        key,
        frames: orbitShot(subject, {
          radius: mode === 'FINISHER' ? COMBAT.FINISHER_CAMERA_DISTANCE + 1.1 : f.radius,
          height: f.height,
          targetHeight: f.targetHeight,
          sweep: f.sweep,
          steps: f.steps,
          startAngle: this._yawFor(subject),
        }),
      };
    }
    const frames = this._orbitCache.frames;
    if (!frames?.length) return this._frameStatic(subject, local, FRAMING.close, mode);
    // Interpolate between generated frames: the generator yields 24 discrete
    // positions, and stepping through them at 60fps is visibly stuttery.
    const at = (frames.length - 1) * local;
    const i = Math.min(frames.length - 1, Math.floor(at));
    const j = Math.min(frames.length - 1, i + 1);
    const blend = at - i;
    const a = frames[i];
    const b = frames[j];
    return {
      position: Vec3.lerp(a.position, b.position, blend),
      target: Vec3.lerp(a.target, b.target, blend),
      fov: lerp(a.fov ?? f.fov, b.fov ?? f.fov, blend),
    };
  }

  /**
   * Two actors in frame. The second is the player, because the player is present in
   * every one of these scenes and the content names only one subject. If the two are
   * effectively standing in the same place there is no two-shot to frame, and the
   * shot falls back to a close rather than producing a degenerate cross product.
   */
  _frameTwoShot(subject, local, mode) {
    const f = FRAMING.twoShot;
    const partner = this._playerPos();
    if (!partner || partner.distanceXZ(subject) < 0.75) {
      return this._frameStatic(subject, local, FRAMING.close, mode);
    }
    const base = twoShot(subject, partner, { pad: f.pad, elevation: f.elevation, fov: f.fov });
    const ease = easeInOutCubic(local);
    const d = lerp(base.distance + f.push * 0.5, Math.max(1.2, base.distance - f.push * 0.5), ease);
    const framed = twoShot(subject, partner, { pad: f.pad, elevation: f.elevation, fov: f.fov, distance: d });
    return { position: framed.position, target: framed.target, fov: framed.fov };
  }

  /* -------------------------------------------------------------- subjects */

  _playerPos() {
    if (!PLAYER_CHARACTER) return null;
    return this._resolve(PLAYER_CHARACTER);
  }

  _subjectPos(id) {
    const direct = this._resolve(id);
    if (direct) return direct;
    const lm = landmarkVec(id, this.heightAt);
    if (lm) return lm;
    const anchor = this._anchorFor(id);
    if (anchor) {
      // Counted, not silent: see the module header. This is a work order for the
      // content layer, which has no cast bodies to resolve against.
      this._fallbacks.add(id);
      return anchor;
    }
    return null;
  }

  _resolve(id) {
    if (typeof this.resolveSubject !== 'function') return null;
    const p = this.resolveSubject(id);
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null;
    return p instanceof Vec3 ? p : new Vec3(p.x, p.y, p.z);
  }

  /**
   * Where to stand a character the world has no body for: the first landmark this
   * same cinematic films, else the first landmark in its region, else the player.
   */
  _anchorFor(characterId) {
    for (const s of this.shots ?? []) {
      if (s.subject === characterId) continue;
      const lm = landmarkVec(s.subject, this.heightAt);
      if (lm) return lm;
    }
    const regionLandmarks = LANDMARKS_BY_REGION[this.current?.region] ?? [];
    for (const lm of regionLandmarks) {
      const v = landmarkVec(lm.id, this.heightAt);
      if (v) return v;
    }
    return this._playerPos();
  }

  /**
   * The angle the camera approaches a subject from. Standing it on the player's side
   * of the subject gives an over-the-shoulder read, which is what a scene between two
   * people looks like. With no player available the angle is derived from the subject
   * id so repeated shots of the same place are at least consistent between runs.
   */
  _yawFor(subject) {
    const player = this._playerPos();
    if (player && player.distanceXZ(subject) > 0.35) {
      return Math.atan2(player.x - subject.x, player.z - subject.z);
    }
    let h = 0;
    const key = `${this.current?.id ?? ''}|${subject.x.toFixed(1)}|${subject.z.toFixed(1)}`;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 100000;
    return (h / 100000) * Math.PI * 2;
  }

  /* ---------------------------------------------------------- diagnostics */

  describe() {
    return {
      active: this.active,
      cinematicId: this.current?.id ?? null,
      shot: this.shotIndex + 1,
      shots: this.shots?.length ?? 0,
      elapsed: Number(this.elapsed.toFixed(2)),
      duration: Number(this.duration.toFixed(2)),
      fallbackSubjects: this.fallbacks,
      stats: { ...this.stats },
    };
  }
}

/** Every cinematic id, for coverage checks. */
export const CINEMATIC_IDS = Object.freeze(Object.keys(CINEMATIC_MAP));

export { HARD_CUT as DEFAULT_CUT_MODE };
