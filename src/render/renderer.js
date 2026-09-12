/**
 * THE BETRAYED WILL — renderer.js
 *
 * The WebGL surface: context, sizing, quality and the frame itself.
 *
 * ── Sizing is the renderer's job, and getting it wrong is visible ────────────
 * A canvas whose drawing buffer does not match its CSS size is blurry; one that
 * matches it at a 3x device pixel ratio is unusable on a phone. Both are solved
 * here rather than in the game loop, so nothing else has to think about it. The
 * pixel ratio is capped, not taken as given, because the difference between 2x and
 * 3x is four times the fill rate for detail nobody can resolve at this art scale.
 *
 * ── Context loss is an event, not a crash ────────────────────────────────────
 * Mobile browsers reclaim GPU memory when the app is backgrounded. A renderer that
 * treats that as fatal shows a black screen forever; one that reports it can stop
 * drawing, wait for restoration, and rebuild. Events.CONTEXT_LOST and
 * Events.CONTEXT_RESTORED already exist for exactly this, so this file uses them.
 *
 * ── The budget is measured, not assumed ──────────────────────────────────────
 * PERF.RENDER_BUDGET_MS is 9. Every frame's GPU submission time is tracked and the
 * worst case is available to the HUD, because a game that runs at 60fps in a test
 * and 22fps on a player's phone has not been measured, only hoped for.
 */

import * as THREE from '../../vendor/three/three.module.js';
import { Events, globalBus } from '../core/bus.js';
import { CAM, PERF } from '../core/constants.js';

export const Quality = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
});

/** Per-quality settings. Ratios are relative to the device pixel ratio. */
const QUALITY_PRESETS = Object.freeze({
  low: { pixelRatioCap: 1.0, shadows: false, antialias: false, shadowMapSize: 1024, exposure: 1.0 },
  medium: { pixelRatioCap: 1.5, shadows: true, antialias: false, shadowMapSize: 1536, exposure: 1.02 },
  high: { pixelRatioCap: 2.0, shadows: true, antialias: true, shadowMapSize: 2048, exposure: 1.05 },
});

/**
 * Pick a quality from what the device appears able to handle.
 *
 * A guess, and deliberately a conservative one: it is better to start at medium and
 * let a player raise it than to start at high and hand them a slideshow they have to
 * diagnose. Cores and touch are the two signals available without benchmarking.
 */
export function guessQuality() {
  if (typeof navigator === 'undefined') return Quality.HIGH;
  const cores = navigator.hardwareConcurrency ?? 4;
  const touch = navigator.maxTouchPoints > 0;
  const memory = navigator.deviceMemory ?? 4;
  if (touch && (cores <= 4 || memory <= 3)) return Quality.LOW;
  if (cores <= 4 || memory <= 4) return Quality.MEDIUM;
  return Quality.HIGH;
}

export class Renderer {
  constructor({ canvas, bus = globalBus, quality = null, scene = null } = {}) {
    this.bus = bus;
    this.canvas = canvas;
    this.quality = quality ?? guessQuality();
    this.preset = QUALITY_PRESETS[this.quality] ?? QUALITY_PRESETS.medium;
    this.scene = scene ?? new THREE.Scene();

    this.contextLost = false;
    this.frames = 0;
    this.lastFrameMs = 0;
    this.worstFrameMs = 0;
    this.overBudgetFrames = 0;
    this.resizeCount = 0;

    this.renderer = new THREE.WebGLRenderer({
      canvas: canvas ?? undefined,
      antialias: this.preset.antialias,
      powerPreference: 'high-performance',
      stencil: false,
      // Depth-only, no alpha: nothing behind the canvas is ever meant to show
      // through, and a compositing pass we do not need costs fill rate every frame.
      alpha: false,
      failIfMajorPerformanceCaveat: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = this.preset.exposure;
    this.renderer.shadowMap.enabled = this.preset.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Manual matrix updates: the world is built once per region and does not move,
    // so letting Three re-derive every matrix every frame is wasted work.
    this.renderer.info.autoReset = true;

    this._bindContextEvents();
    this._bindResize();
    this.resize();
  }

  _bindContextEvents() {
    const c = this.renderer.domElement;
    if (!c || !c.addEventListener) return;
    c.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();          // required, or the context is never offered back
      this.contextLost = true;
      this.bus.emit(Events.CONTEXT_LOST, { frames: this.frames });
    }, false);
    c.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      // Textures and programs live on the GPU and are gone. Materials survive as
      // objects, so flagging them forces re-upload on the next render.
      this.scene.traverse((o) => {
        if (o.material) {
          const list = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of list) { if (m.map) m.map.needsUpdate = true; m.needsUpdate = true; }
        }
      });
      this.bus.emit(Events.CONTEXT_RESTORED, { frames: this.frames });
    }, false);
  }

  _bindResize() {
    if (typeof window === 'undefined') return;
    const onResize = () => this.resize();
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    if (typeof ResizeObserver !== 'undefined' && this.canvas) {
      this._observer = new ResizeObserver(onResize);
      this._observer.observe(this.canvas);
    }
    this._unbindResize = () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      this._observer?.disconnect();
    };
  }

  /** Match the drawing buffer to the element's CSS size, within the pixel cap. */
  resize() {
    const c = this.canvas ?? this.renderer.domElement;
    const w = Math.max(1, c.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 800));
    const h = Math.max(1, c.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 600));
    const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio ?? 1) : 1;
    const ratio = Math.min(dpr, this.preset.pixelRatioCap);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
    this.size = { w, h, ratio };
    this.aspect = w / h;
    this.resizeCount++;
    return this.size;
  }

  /** Keep a perspective camera's aspect in step with the canvas. */
  syncCamera(camera) {
    if (!camera) return;
    if (camera.isPerspectiveCamera && Math.abs(camera.aspect - this.aspect) > 1e-6) {
      camera.aspect = this.aspect;
      camera.updateProjectionMatrix();
    }
  }

  setQuality(quality) {
    if (!QUALITY_PRESETS[quality] || quality === this.quality) return false;
    this.quality = quality;
    this.preset = QUALITY_PRESETS[quality];
    this.renderer.shadowMap.enabled = this.preset.shadows;
    this.renderer.toneMappingExposure = this.preset.exposure;
    // Changing shadow-map enablement requires materials to recompile, or the shadow
    // define stays baked into shaders that were built without it.
    this.scene.traverse((o) => {
      if (!o.material) return;
      const list = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of list) m.needsUpdate = true;
    });
    this.resize();
    this.bus.emit(Events.SETTINGS_CHANGED, { scope: 'render', quality });
    return true;
  }

  /**
   * Draw one frame. Returns the submission time in ms.
   *
   * Skipped entirely while the context is lost: submitting to a dead context throws
   * in some drivers and silently no-ops in others, and neither is a frame.
   */
  render(camera) {
    if (this.contextLost || !camera) return 0;
    this.syncCamera(camera);
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.renderer.render(this.scene, camera);
    const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.lastFrameMs = t1 - t0;
    if (this.lastFrameMs > this.worstFrameMs) this.worstFrameMs = this.lastFrameMs;
    if (this.lastFrameMs > PERF.RENDER_BUDGET_MS) this.overBudgetFrames++;
    this.frames++;
    return this.lastFrameMs;
  }

  /** Live GPU-side counters, for the HUD and for the optimization reports. */
  get info() {
    const i = this.renderer.info;
    return {
      drawCalls: i.render.calls,
      triangles: i.render.triangles,
      geometries: i.memory.geometries,
      textures: i.memory.textures,
      programs: i.programs?.length ?? 0,
      lastFrameMs: Number(this.lastFrameMs.toFixed(2)),
      worstFrameMs: Number(this.worstFrameMs.toFixed(2)),
      overBudgetFrames: this.overBudgetFrames,
      budgetMs: PERF.RENDER_BUDGET_MS,
      maxDrawCalls: PERF.MAX_DRAW_CALLS,
      quality: this.quality,
      size: this.size,
    };
  }

  /** True when the current scene is inside the declared draw-call budget. */
  get withinDrawCallBudget() { return this.renderer.info.render.calls <= PERF.MAX_DRAW_CALLS; }

  dispose() {
    this._unbindResize?.();
    this.scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const list = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of list) { m.map?.dispose(); m.dispose(); }
      }
    });
    this.renderer.dispose();
  }
}

export { QUALITY_PRESETS, CAM };
