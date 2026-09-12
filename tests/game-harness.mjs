/**
 * THE BETRAYED WILL — game-harness.mjs
 *
 * Shared boot helpers for the suites that drive the real browser layer headlessly.
 *
 * These lived inside runtime-test.mjs until a second suite needed them. Copying a
 * stub renderer is the kind of duplication that rots quietly: the two copies drift,
 * one suite starts testing a renderer shape the game no longer produces, and both
 * still pass. So they are extracted, and every suite that boots a Game boots it the
 * same way.
 *
 * Not a suite: it declares no tests and is skipped by run.sh's discovery, which
 * ignores harness.mjs by name. This file is imported, never run.
 */

import { EventBus } from '../src/core/bus.js';
import { PERF } from '../src/core/constants.js';
import { Game } from '../src/main.js';
import { MemoryStorage } from '../src/sim/save.js';
import * as THREE from '../vendor/three/three.module.js';

/**
 * A renderer that records instead of drawing.
 *
 * Everything the frame loop asks of a renderer is here, and nothing it does not ask
 * for. The WebGL submission is the one thing a headless suite cannot cover, and it
 * is the only thing this stub stands in for.
 */
export function stubRenderer(opts = {}) {
  return {
    scene: opts.scene ?? new THREE.Scene(),
    aspect: 16 / 9,
    quality: opts.quality ?? 'medium',
    renders: 0,
    lastCamera: null,
    disposed: false,
    info: {
      drawCalls: 0, triangles: 0, geometries: 0, textures: 0, programs: 0,
      lastFrameMs: 0, worstFrameMs: 0, overBudgetFrames: 0,
      budgetMs: PERF.RENDER_BUDGET_MS, maxDrawCalls: PERF.MAX_DRAW_CALLS,
      quality: 'medium', size: { w: 1280, h: 720, ratio: 1 },
    },
    render(camera) { this.renders++; this.lastCamera = camera; return 0.4; },
    syncCamera() {},
    resize() { return this.info.size; },
    setQuality(q) { this.quality = q; return true; },
    dispose() { this.disposed = true; },
  };
}

/**
 * Boot a game headlessly.
 *
 * A real in-memory save backend, so this is a normal boot and reports no problems.
 * A suite that wants the no-storage path passes `storage: null` explicitly, which is
 * a different situation and must be reported differently.
 *
 * `running` is cleared so a suite that never asked for a rAF loop does not get one.
 */
export function bootGame(overrides = {}) {
  const bus = new EventBus();
  const game = new Game({
    bus, language: 'ar', seed: 'mesopotamia', storage: new MemoryStorage(),
    rendererFactory: stubRenderer, ...overrides,
  });
  const report = game.boot();
  game.running = false;
  return { game, bus, report };
}

/**
 * Drive N frames through the real loop.
 *
 * 17ms rather than exactly FIXED_DT*1000. Stepping at precisely the step boundary is
 * the one interval where floating-point accumulation is pathological: 16.666666ms
 * rounds to a hair under 1/60s, so the accumulator misses the threshold on one frame
 * and catches up with two on the next. Real frames are never exactly that, and a
 * suite that only passes at a frame time no display produces is testing the rounding,
 * not the loop.
 */
export function step(game, n = 1, frameMs = 17) {
  for (let i = 0; i < n; i++) {
    game._frame((game.lastNow || 0) + frameMs);
  }
}
