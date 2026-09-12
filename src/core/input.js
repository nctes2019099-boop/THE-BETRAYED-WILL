/**
 * THE BETRAYED WILL — input.js
 *
 * Keyboard, mouse, touch and gamepad, reduced to the one `intent` object
 * PlayerController.update() consumes.
 *
 * ── Edge versus level ────────────────────────────────────────────────────────
 * Some intent fields mean "this happened" and some mean "this is being held". The
 * distinction is not stylistic: PlayerController calls startAttack() on every frame
 * `attackLight` is true and buffers a jump on every frame `jump` is true, so a held
 * button delivered as a level re-enters those paths sixty times a second. Edges are
 * therefore counted rather than latched - a counter, not a boolean, because two
 * presses inside one frame are two presses and a boolean silently eats the second
 * (which is how a double-tap dodge stops working on a slow frame).
 *
 * ── Physical codes, not characters ───────────────────────────────────────────
 * Bindings use `e.code`. On an Arabic keyboard layout the characters under WASD are
 * not W/A/S/D, so a game bound to `e.key` becomes unplayable in its own first-class
 * language. Codes are layout-independent.
 *
 * ── Three devices, one notion of "held" ──────────────────────────────────────
 * The keyboard holds codes; a touch button and a gamepad pad hold actions. Those
 * are not the same thing, and pretending they are is why gamepad support usually
 * half-works. `isActionDown` therefore checks the code bindings and a separate
 * `levelHeld` set, which is the only place touch and gamepad levels live.
 *
 * ── Testability ──────────────────────────────────────────────────────────────
 * No host global is named anywhere in this file: the DOM target and the gamepad
 * snapshot are both injected, so src/core stays headless and a test can drive a
 * fake controller through the real mapping. Nothing touches the DOM unless a target
 * is attached. Every event arrives
 * through `handleEvent(type, ev)`, so a test drives the real funnel with plain
 * objects and gets a real intent back. There is no second code path for tests.
 *
 * One layering note: this file imports `emptyIntent` from ../sim/player.js, an
 * upward import. The alternative is restating a 28-field contract here, and a
 * duplicated contract drifts. The intent shape is owned by its consumer.
 */

import { Events, globalBus } from './bus.js';
import { CAM, INPUT, MOVE } from './constants.js';
import { emptyIntent } from '../sim/player.js';

export const InputSource = Object.freeze({
  KEYBOARD: 'keyboard',
  MOUSE: 'mouse',
  TOUCH: 'touch',
  GAMEPAD: 'gamepad',
});

/** Delivered as one frame of true per press. */
const EDGE_ACTIONS = Object.freeze([
  'jump', 'dodge', 'interact', 'crouch', 'shoulderSwap', 'cameraReset',
  'attackLight', 'attackHeavy', 'parry', 'fire', 'lockOn', 'useItem',
]);

/** Read as a level every frame, straight from the binding. */
const LEVEL_ACTIONS = Object.freeze(['sprint', 'block', 'aim', 'ledge']);

/** Actions the game loop reads directly rather than through the intent. */
const UI_ACTIONS = Object.freeze(['pause']);

/** Gamepad standard mapping onto the same actions the keyboard uses. */
const PAD_MAP = Object.freeze([
  [0, 'jump'], [1, 'dodge'], [2, 'interact'], [3, 'lockOn'],
  [4, 'aim'], [5, 'attackHeavy'], [6, 'sprint'], [7, 'attackLight'],
  [9, 'pause'], [10, 'ledge'], [8, 'crouch'],
]);

const MOUSE_CODE = (button) => `Mouse${button}`;

function normalizeBindings(bindings) {
  const out = {};
  for (const [action, codes] of Object.entries(bindings ?? {})) {
    out[action] = [...new Set((codes ?? []).filter((c) => typeof c === 'string' && c))];
  }
  return out;
}

export class InputManager {
  constructor({
    target = null, bus = globalBus, bindings = null,
    gamepad = INPUT.GAMEPAD_POLL, gamepadProvider = null,
  } = {}) {
    this.bus = bus;
    this.target = target;
    this.bindings = normalizeBindings(bindings ?? INPUT.BINDINGS);
    this.gamepadEnabled = gamepad === true;
    /**
     * `() => pads`, supplied by the browser layer from src/platform/browser.js.
     * Injected rather than read from a host global so that src/core stays headless,
     * and so a test can hand in a fake pad and assert the real mapping instead of
     * skipping it because no controller is plugged in.
     */
    this.gamepadProvider = typeof gamepadProvider === 'function' ? gamepadProvider : null;

    /** Codes currently held (keyboard, mouse, gamepad buttons). */
    this.down = new Set();
    /** Actions held by touch or gamepad, which have no code to bind. */
    this.levelHeld = new Set();
    /** action -> presses queued but not yet consumed. */
    this.edges = new Map();

    /** Accumulated look in radians, from mouse and touch drags. */
    this.lookDeltaRad = { x: 0, y: 0 };
    /** Accumulated look normalized -1..1, from a gamepad stick. */
    this.lookAnalog = { x: 0, y: 0 };
    /** Move axis from a touch stick or gamepad, normalized -1..1. */
    this.moveAnalog = { x: 0, y: 0 };
    this.wheelDelta = 0;

    this._padMoveActive = false;
    this._padLookActive = false;

    this.pointerLocked = false;
    this.sensitivityScale = INPUT.MOUSE_SENSITIVITY_SCALE;
    this.attached = false;
    this.lastSource = InputSource.KEYBOARD;

    this.stats = { events: 0, presses: 0, drops: 0, rebinds: 0, focusLosses: 0 };

    this._codeToActions = new Map();
    this._handlers = null;
    this._rebuildIndex();
    if (target) this.attach(target);
  }

  /* ------------------------------------------------------------- bindings */

  _rebuildIndex() {
    this._codeToActions.clear();
    for (const [action, codes] of Object.entries(this.bindings)) {
      for (const code of codes) {
        if (!this._codeToActions.has(code)) this._codeToActions.set(code, []);
        this._codeToActions.get(code).push(action);
      }
    }
  }

  bindingsFor(action) { return [...(this.bindings[action] ?? [])]; }
  actionsFor(code) { return [...(this._codeToActions.get(code) ?? [])]; }

  /**
   * Rebind one action to one code. Returns a reason instead of throwing: a rebind
   * screen shows the refusal, it does not crash.
   */
  rebind(action, code) {
    if (!(action in this.bindings)) return { ok: false, reason: 'unknown-action' };
    if (INPUT.PROTECTED_BINDINGS.includes(action)) return { ok: false, reason: 'protected' };
    if (typeof code !== 'string' || !code) return { ok: false, reason: 'bad-code' };

    const others = this.actionsFor(code).filter((a) => a !== action);
    if (others.length) return { ok: false, reason: `already bound to ${others.join(', ')}` };

    this.bindings[action] = [code];
    this._rebuildIndex();
    this.stats.rebinds++;
    this.bus.emit(Events.SETTINGS_CHANGED, { scope: 'input', action, code });
    return { ok: true, reason: null };
  }

  resetBindings() {
    this.bindings = normalizeBindings(INPUT.BINDINGS);
    this._rebuildIndex();
    this.bus.emit(Events.SETTINGS_CHANGED, { scope: 'input', action: null, code: null });
  }

  serializeBindings() {
    return {
      version: 1,
      bindings: Object.fromEntries(Object.entries(this.bindings).map(([a, c]) => [a, [...c]])),
    };
  }

  /** Restores bindings, dropping anything that no longer names a real action. */
  restoreBindings(payload) {
    const problems = [];
    if (!payload || typeof payload !== 'object' || !payload.bindings) {
      return { ok: false, problems: ['payload has no bindings'] };
    }
    const next = {};
    for (const [action, codes] of Object.entries(payload.bindings)) {
      if (!(action in INPUT.BINDINGS)) { problems.push(`unknown action "${action}"`); continue; }
      if (!Array.isArray(codes)) { problems.push(`action "${action}" has no code list`); continue; }
      next[action] = [...new Set(codes.filter((c) => typeof c === 'string' && c))];
    }
    // Fill what is missing, and repair what was emptied - but only for actions that
    // are supposed to have a code. `fire` is deliberately unbound by default, since
    // it is what Mouse0 means while the bow is up, and repairing it would bind a
    // second shot key the player never asked for.
    for (const action of Object.keys(INPUT.BINDINGS)) {
      const def = INPUT.BINDINGS[action] ?? [];
      const cur = next[action];
      if (cur === undefined) {
        next[action] = [...def];
        problems.push(`action "${action}" restored to default`);
      } else if (!cur.length && def.length) {
        next[action] = [...def];
        problems.push(`action "${action}" had no usable codes`);
      }
    }
    // Two actions on one code is unusable; the later one falls back to default.
    const seen = new Map();
    for (const action of Object.keys(next)) {
      for (const code of next[action]) {
        if (seen.has(code) && seen.get(code) !== action) {
          problems.push(`"${code}" was bound to both ${seen.get(code)} and ${action}`);
          next[action] = [...INPUT.BINDINGS[action]];
          break;
        }
        seen.set(code, action);
      }
    }
    this.bindings = next;
    this._rebuildIndex();
    return { ok: problems.length === 0, problems };
  }

  /* -------------------------------------------------------------- attach */

  attach(target = this.target) {
    if (this.attached || !target || typeof target.addEventListener !== 'function') return false;
    this.target = target;
    this._handlers = {
      keydown: (e) => this.handleEvent('keydown', e),
      keyup: (e) => this.handleEvent('keyup', e),
      mousedown: (e) => this.handleEvent('mousedown', e),
      mouseup: (e) => this.handleEvent('mouseup', e),
      mousemove: (e) => this.handleEvent('mousemove', e),
      wheel: (e) => this.handleEvent('wheel', e),
      blur: () => this.handleEvent('blur', {}),
      visibilitychange: () => this.handleEvent('visibilitychange', {}),
      contextmenu: (e) => this.handleEvent('contextmenu', e),
      pointerlockchange: () => this.handleEvent('pointerlockchange', {}),
    };
    for (const [type, fn] of Object.entries(this._handlers)) target.addEventListener(type, fn);
    // `visibilitychange` is dispatched on a document, never on a window. With a window
    // target the listener above never runs, and keys held when the tab was hidden stay
    // latched on return - the character sprints forever. Register it on the window's
    // document as well. A document target has no `.document`, so this cannot double-fire.
    this._docTarget = null;
    const doc = target.document;
    if (doc && doc !== target && typeof doc.addEventListener === 'function') {
      doc.addEventListener('visibilitychange', this._handlers.visibilitychange);
      this._docTarget = doc;
    }
    this.attached = true;
    return true;
  }

  detach() {
    if (!this.attached || !this.target) return false;
    for (const [type, fn] of Object.entries(this._handlers ?? {})) {
      this.target.removeEventListener?.(type, fn);
    }
    if (this._docTarget) {
      this._docTarget.removeEventListener?.('visibilitychange', this._handlers?.visibilitychange);
      this._docTarget = null;
    }
    this._handlers = null;
    this.attached = false;
    this.releaseAll('detached');
    return true;
  }

  requestPointerLock() {
    const el = this.target;
    if (el && typeof el.requestPointerLock === 'function') { el.requestPointerLock(); return true; }
    return false;
  }

  /* ------------------------------------------------- the single funnel */

  /**
   * Every input event, from the DOM or from a test. `type` is the DOM event name,
   * so there is no translation layer between the browser and the simulation.
   */
  handleEvent(type, ev = {}) {
    this.stats.events++;
    switch (type) {
      case 'keydown': return this._key(ev, true);
      case 'keyup': return this._key(ev, false);
      case 'mousedown': return this._button(MOUSE_CODE(ev.button ?? 0), true, ev);
      case 'mouseup': return this._button(MOUSE_CODE(ev.button ?? 0), false, ev);
      case 'mousemove': return this._mouseMove(ev);
      case 'wheel': this.wheelDelta += ev.deltaY ?? 0; return true;
      case 'contextmenu': return true;
      case 'pointerlockchange':
        this.pointerLocked = ev.locked === true
          || (ev.locked === undefined && this.target?.isPointerLocked === true);
        return true;
      case 'blur':
      case 'visibilitychange':
        // Releasing everything on focus loss is correctness, not tidiness: a player
        // who alt-tabs out while holding W returns to a character still running,
        // and no keyup is coming to stop them.
        this.releaseAll('focus-lost');
        return true;
      default: return false;
    }
  }

  _key(ev, isDown) {
    const code = ev.code;
    if (typeof code !== 'string' || !code) return false;
    this.lastSource = InputSource.KEYBOARD;
    if (isDown) {
      this.down.add(code);
      // A held key sends repeats. The button is already down, so a repeat is not a
      // new press and must not queue another edge.
      if (ev.repeat !== true) this._pressCode(code);
    } else {
      this.down.delete(code);
    }
    return true;
  }

  _button(code, isDown, ev) {
    this.lastSource = InputSource.MOUSE;
    if (isDown) {
      this.down.add(code);
      this._pressCode(code);
    } else {
      this.down.delete(code);
    }
    if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
    return true;
  }

  _pressCode(code) {
    const actions = this._codeToActions.get(code);
    if (!actions) return false;
    let queued = false;
    for (const action of actions) queued = this._queueEdge(action) || queued;
    if (queued) this.stats.presses++;
    return queued;
  }

  _queueEdge(action) {
    const n = this.edges.get(action) ?? 0;
    if (n >= INPUT.MAX_EDGE_BUFFER) { this.stats.drops++; return false; }
    this.edges.set(action, n + 1);
    return true;
  }

  _mouseMove(ev) {
    const dx = ev.movementX;
    const dy = ev.movementY;
    if (typeof dx !== 'number' || typeof dy !== 'number'
      || !Number.isFinite(dx) || !Number.isFinite(dy)) return false;
    this.lastSource = InputSource.MOUSE;
    this.lookDeltaRad.x += dx * CAM.SENSITIVITY_X * this.sensitivityScale;
    this.lookDeltaRad.y += dy * CAM.SENSITIVITY_Y * this.sensitivityScale;
    return true;
  }

  /** Drops every held code, level and queued edge. */
  releaseAll(reason = 'explicit') {
    const had = this.down.size > 0 || this.edges.size > 0 || this.levelHeld.size > 0;
    this.down.clear();
    this.levelHeld.clear();
    this.edges.clear();
    this.moveAnalog.x = 0; this.moveAnalog.y = 0;
    this.lookAnalog.x = 0; this.lookAnalog.y = 0;
    this.lookDeltaRad.x = 0; this.lookDeltaRad.y = 0;
    this._padMoveActive = false;
    this._padLookActive = false;
    if (had && reason === 'focus-lost') this.stats.focusLosses++;
    return had;
  }

  /* ---------------------------------------------------------------- touch */

  /** Virtual move stick, already normalized -1..1 by the touch UI. */
  setTouchMove(x, y) {
    this.lastSource = InputSource.TOUCH;
    const m = Math.hypot(x, y);
    if (!(m > INPUT.TOUCH_STICK_DEADZONE)) { this.moveAnalog.x = 0; this.moveAnalog.y = 0; return; }
    const k = m > 1 ? 1 / m : 1;
    this.moveAnalog.x = x * k;
    this.moveAnalog.y = y * k;
  }

  /** Touch look drag, in pixels since the last sample. */
  addTouchLook(dxPx, dyPx) {
    if (!Number.isFinite(dxPx) || !Number.isFinite(dyPx)) return false;
    this.lastSource = InputSource.TOUCH;
    this.lookDeltaRad.x += dxPx * INPUT.TOUCH_LOOK_SENSITIVITY;
    this.lookDeltaRad.y += dyPx * INPUT.TOUCH_LOOK_SENSITIVITY;
    return true;
  }

  /**
   * A touch button pressed or released. Touch buttons carry no key code, so a held
   * one lands in `levelHeld` - the set `isActionDown` also reads - and an edge one
   * queues a press. Without that split a touch block button would never block.
   */
  /**
   * A one-shot press from something that is not a key: a touch button, a tutorial
   * demonstrating a control, a debug hook.
   *
   * Only edge and UI actions can be pressed this way. A level action - sprint, block,
   * aim, ledge - is refused rather than latched, because a level with nothing to
   * release it is a stuck key: the character sprints until the page is reloaded and no
   * keyup is ever coming. Callers that mean to hold one use setTouchAction().
   *
   * @param {string} action
   * @param {string} [source]
   * @returns {boolean} whether a press was queued
   */
  pressAction(action, source = InputSource.TOUCH) {
    if (!EDGE_ACTIONS.includes(action) && !UI_ACTIONS.includes(action)) return false;
    this.lastSource = source;
    const queued = this._queueEdge(action);
    if (queued) this.stats.presses++;
    return queued;
  }

  setTouchAction(action, held) {
    if (!EDGE_ACTIONS.includes(action) && !LEVEL_ACTIONS.includes(action) && !UI_ACTIONS.includes(action)) {
      return false;
    }
    this.lastSource = InputSource.TOUCH;
    if (held) {
      if (EDGE_ACTIONS.includes(action)) this._queueEdge(action);
      else this.levelHeld.add(action);
    } else {
      this.levelHeld.delete(action);
    }
    return true;
  }

  /* -------------------------------------------------------------- gamepad */

  setGamepadProvider(fn) {
    this.gamepadProvider = typeof fn === 'function' ? fn : null;
    return this.gamepadProvider !== null;
  }

  _pollGamepad() {
    if (!this.gamepadEnabled || !this.gamepadProvider) return false;
    let pads;
    try { pads = this.gamepadProvider(); } catch { return false; }
    if (!Array.isArray(pads)) return false;
    let pad = null;
    for (const p of pads) { if (p && p.connected) { pad = p; break; } }
    if (!pad) return false;
    this.lastSource = InputSource.GAMEPAD;

    const dead = (v, zone) => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) >= zone ? v : 0);
    const ax = pad.axes ?? [];
    // Axis ownership, not blind assignment. Writing the axes unconditionally would
    // zero a touch stick every frame a controller happens to be connected, and
    // writing them only when non-zero - the obvious version - leaves the last value
    // in place when the stick returns to center, so the character keeps drifting
    // after the player lets go. A pad owns an axis from its first deflection until
    // it returns inside the deadzone, and only then hands it back.
    const lx = dead(ax[0], MOVE.INPUT_DEADZONE);
    const ly = dead(ax[1], MOVE.INPUT_DEADZONE);
    if (lx !== 0 || ly !== 0) {
      this.moveAnalog.x = lx; this.moveAnalog.y = -ly; this._padMoveActive = true;
    } else if (this._padMoveActive) {
      this.moveAnalog.x = 0; this.moveAnalog.y = 0; this._padMoveActive = false;
    }
    const rx = dead(ax[2], CAM.GAMEPAD_DEADZONE);
    const ry = dead(ax[3], CAM.GAMEPAD_DEADZONE);
    if (rx !== 0 || ry !== 0) {
      this.lookAnalog.x = rx; this.lookAnalog.y = ry; this._padLookActive = true;
    } else if (this._padLookActive) {
      this.lookAnalog.x = 0; this.lookAnalog.y = 0; this._padLookActive = false;
    }

    const buttons = pad.buttons ?? [];
    for (const [index, action] of PAD_MAP) {
      const b = buttons[index];
      const pressed = typeof b === 'object' && b !== null ? b.pressed === true : Number(b) > 0.5;
      const code = `Pad${index}`;
      const was = this.down.has(code);
      if (pressed === was) continue;
      if (pressed) {
        this.down.add(code);
        if (EDGE_ACTIONS.includes(action)) this._queueEdge(action);
        else this.levelHeld.add(action);
      } else {
        this.down.delete(code);
        this.levelHeld.delete(action);
      }
    }
    return true;
  }

  /* ---------------------------------------------------------------- frame */

  isDown(code) { return this.down.has(code); }

  /** True while the action is held, from any device. */
  isActionDown(action) {
    if (this.levelHeld.has(action)) return true;
    const codes = this.bindings[action];
    if (!codes) return false;
    for (const code of codes) if (this.down.has(code)) return true;
    return false;
  }

  /** Take a queued press for an action that is not part of the intent. */
  takeAction(action) {
    const n = this.edges.get(action) ?? 0;
    if (n <= 0) return false;
    this.edges.set(action, n - 1);
    return true;
  }

  /** Accumulated wheel since the last call. */
  consumeWheel() { const w = this.wheelDelta; this.wheelDelta = 0; return w; }

  /**
   * Build this frame's intent.
   *
   * Each queued edge is read once and decremented, so one press produces exactly one
   * frame of true no matter how many frames pass before the next press, and two
   * presses inside one frame produce two frames of true.
   */
  sample(dt = 1 / 60) {
    this._pollGamepad();
    const intent = emptyIntent();
    const step = Number.isFinite(dt) && dt > 0 ? dt : 1 / 60;

    // --- move: digital keys first, analog only when no key is down -----------
    let mx = 0;
    let mz = 0;
    if (this.isActionDown('moveRight')) mx += 1;
    if (this.isActionDown('moveLeft')) mx -= 1;
    if (this.isActionDown('moveForward')) mz += 1;
    if (this.isActionDown('moveBack')) mz -= 1;
    if (mx === 0 && mz === 0) { mx = this.moveAnalog.x; mz = this.moveAnalog.y; }
    const mag = Math.hypot(mx, mz);
    if (mag > 1) { mx /= mag; mz /= mag; }
    intent.moveX = mx;
    intent.moveZ = mz;

    // --- look: radians from mouse and touch, normalized from a stick ----------
    // PlayerController has both paths and they are not interchangeable. The radians
    // path is applied directly; the normalized path goes through the stick response
    // curve. Sending a stick as radians skips the curve and feels wrong, and sending
    // a mouse drag as normalized throws the movement away.
    const drx = this.lookDeltaRad.x;
    const dry = this.lookDeltaRad.y;
    this.lookDeltaRad.x = 0;
    this.lookDeltaRad.y = 0;
    const ax = this.lookAnalog.x;
    const ay = this.lookAnalog.y;
    if (drx !== 0 || dry !== 0) {
      intent.lookIsDeltaRadians = true;
      intent.lookX = drx + ax * CAM.GAMEPAD_LOOK_SPEED * step;
      intent.lookY = dry + ay * CAM.GAMEPAD_LOOK_SPEED * step;
    } else if (ax !== 0 || ay !== 0) {
      intent.lookIsDeltaRadians = false;
      intent.lookX = ax;
      intent.lookY = ay;
    }

    // --- levels --------------------------------------------------------------
    for (const action of LEVEL_ACTIONS) intent[action] = this.isActionDown(action);
    intent.blockHeld = this.isActionDown('block');
    intent.aimHeld = this.isActionDown('aim');
    // Drawing the bow is holding aim. There is no second button for it.
    intent.drawHeld = this.isActionDown('aim');
    intent.jumpHeld = this.isActionDown('jump');
    intent.crouchHeld = this.isActionDown('crouch');

    // --- edges ---------------------------------------------------------------
    for (const action of EDGE_ACTIONS) {
      const n = this.edges.get(action) ?? 0;
      if (n <= 0) continue;
      this.edges.set(action, n - 1);
      intent[action] = true;
    }

    // Mouse0 is bound to both a swing and a shot. Which one the player meant is
    // settled by whether the bow is up, here rather than in two places downstream.
    if (intent.aimHeld && intent.attackLight) {
      intent.attackLight = false;
      intent.fire = true;
    }

    for (const f of ['moveX', 'moveZ', 'lookX', 'lookY']) {
      if (!Number.isFinite(intent[f])) intent[f] = 0;
    }
    return intent;
  }

  /** Which device produced the last input, for the on-screen prompt glyphs. */
  activeSource() { return this.lastSource; }
}
