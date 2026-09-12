/**
 * THE BETRAYED WILL — browser.js
 *
 * The browser boundary, and the only place in the source tree allowed to name a
 * host API.
 *
 * src/core, src/sim and src/content are policed for DOM and host globals because the
 * entire test strategy depends on them staying headless: a simulation that can only
 * run in a browser cannot be asserted on sixty times a second in a CI run. Every
 * system that needs a host capability therefore takes it as an injected value, and
 * this file is where those values are produced.
 *
 * The rule is enforced by grep in lint.sh and by test 25 in verify.mjs, so the
 * discipline is not voluntary and cannot rot silently.
 */

import { SAVE } from '../core/constants.js';

/**
 * The real storage backend, or null when there is none.
 *
 * Null is a normal answer, not an error: private-mode browsers have historically
 * thrown on write rather than exposing nothing, and a page opened from file:// may
 * have no persistent storage at all. Callers fall back to memory and tell the player
 * their progress will not survive the session, which is better than a crash on boot.
 */
export function detectStorage() {
  try {
    const ls = typeof localStorage !== 'undefined' ? localStorage : null;
    if (!ls || typeof ls.setItem !== 'function') return null;
    // The only reliable probe is a write. Reading tells you nothing about whether a
    // later setItem will throw.
    const probe = `${SAVE.KEY_PREFIX}probe`;
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return ls;
  } catch {
    return null;
  }
}

/** True when a persistent backend exists. Used to warn before the first save. */
export function hasPersistentStorage() { return detectStorage() !== null; }

/**
 * A gamepad snapshot function for InputManager.
 *
 * Returned as a closure rather than read once, because pads connect mid-session and
 * the array must be re-read every frame. Wrapped so a browser that throws here does
 * not take the input layer down with it.
 */
export function gamepadPoller() {
  if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return null;
  return () => {
    try {
      const pads = navigator.getGamepads();
      return pads ? Array.from(pads) : [];
    } catch {
      return [];
    }
  };
}
