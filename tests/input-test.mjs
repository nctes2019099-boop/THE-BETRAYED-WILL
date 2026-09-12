/**
 * THE BETRAYED WILL — input-test.mjs
 *
 * The input suite: everything between a player's hand and the `intent` object
 * PlayerController.update() consumes.
 *
 * This layer is where a game quietly becomes unplayable, and almost none of its
 * failures look like failures. A held button that re-enters the attack path every
 * frame reads as "combat is twitchy". A jump edge latched with a boolean reads as
 * "double-tap dodge sometimes doesn't work". A stick axis that is only written when
 * non-zero reads as "the character drifts after I let go". None of those throw, so
 * none of them get fixed by playing once - they get fixed by asserting the shape of
 * the signal.
 *
 * What is pinned here:
 *
 *   - the intent returned is exactly emptyIntent()'s contract, no keys added or
 *     dropped, because a field the input layer invents is a field nothing reads.
 *   - edges are one frame wide per press, two presses in one frame are two frames,
 *     and an auto-repeat from a held key is not a press at all.
 *   - levels stay true while held and false the moment they are released.
 *   - mouse and touch look travel the radians path; a gamepad stick travels the
 *     normalized path, because PlayerController applies its response curve there
 *     and skipping it changes how the camera feels.
 *   - releasing a stick returns the axis to zero. The obvious implementation gets
 *     this wrong, and this suite is why it stays right.
 *   - focus loss drops every held code. A player who alt-tabs out holding W must
 *     not come back to a character still running with no keyup coming.
 *   - bindings are physical codes, so an Arabic keyboard layout plays identically.
 *   - rebinds refuse collisions and protected actions, and a corrupt binding set is
 *     repaired with a report rather than left to strand an action.
 *
 * Run: node tests/input-test.mjs
 */

import { describe, test, assert, runAndExit, measure } from './harness.mjs';
import { InputManager, InputSource } from '../src/core/input.js';
import { CAM, INPUT, MOVE } from '../src/core/constants.js';
import { emptyIntent, PlayerController } from '../src/sim/player.js';
import { EventBus, Events } from '../src/core/bus.js';
import { Vec3 } from '../src/core/math.js';
import { CollisionWorld } from '../src/sim/collision.js';

const DT = 1 / 60;

/** A manager with no DOM target and no gamepad, driven only by handleEvent(). */
function mk(overrides = {}) {
  return new InputManager({ bus: new EventBus(), gamepad: false, ...overrides });
}

const key = (im, code, extra = {}) => im.handleEvent('keydown', { code, ...extra });
const up = (im, code) => im.handleEvent('keyup', { code });
const tap = (im, code) => { key(im, code); up(im, code); };
const click = (im, button) => im.handleEvent('mousedown', { button });
const release = (im, button) => im.handleEvent('mouseup', { button });

/** A fake pad in the standard mapping shape. */
function fakePad({ axes = [0, 0, 0, 0], pressed = [] } = {}) {
  const buttons = Array.from({ length: 17 }, (_, i) => ({
    pressed: pressed.includes(i),
    value: pressed.includes(i) ? 1 : 0,
  }));
  const pad = { connected: true, axes: [...axes], buttons };
  return pad;
}

describe('input — the intent contract', () => {
  test('01 · sample() returns exactly emptyIntent()’s keys', () => {
    const im = mk();
    const got = Object.keys(im.sample(DT)).sort();
    const want = Object.keys(emptyIntent()).sort();
    assert.deepEqual(got, want, 'input invented or dropped an intent field');
  });

  test('02 · an idle manager produces an all-neutral intent', () => {
    const intent = mk().sample(DT);
    assert.equal(intent.moveX, 0, 'idle moveX');
    assert.equal(intent.moveZ, 0, 'idle moveZ');
    assert.equal(intent.lookX, 0, 'idle lookX');
    assert.equal(intent.lookY, 0, 'idle lookY');
    for (const [field, value] of Object.entries(intent)) {
      if (typeof value === 'boolean') assert.equal(value, false, `${field} must start false`);
    }
  });

  test('03 · the intent PlayerController accepts is the one input produces', () => {
    // The point of the contract test is not that the keys match, it is that the
    // real consumer takes the result and the player actually walks. An empty world
    // with generous bounds, so nothing can interrupt the convergence being measured.
    const cw = new CollisionWorld(4);
    cw.setBounds(new Vec3(-1000, -20, -1000), new Vec3(1000, 40, 1000));
    const pc = new PlayerController({ collision: cw, bus: new EventBus(), pos: new Vec3(0, 0, 0) });
    const im = mk();
    key(im, 'KeyW');
    const start = { x: pc.pos.x, z: pc.pos.z };
    for (let i = 0; i < 60; i++) pc.update(DT, im.sample(DT), {});
    const travelled = Math.hypot(pc.pos.x - start.x, pc.pos.z - start.z);
    assert.gt(travelled, 0.05, 'holding forward did not move the player through the real controller');
    assert.ok(pc.pos.isFiniteVec(), 'and the position must stay finite');
    // Releasing must stop them. The controller has its own deceleration, so the
    // assertion is that it converges to rest - a bounded coast, then no further
    // movement - rather than that it halts on the frame the key came up.
    up(im, 'KeyW');
    const released = { x: pc.pos.x, z: pc.pos.z };
    for (let i = 0; i < 90; i++) pc.update(DT, im.sample(DT), {});
    const coast = Math.hypot(pc.pos.x - released.x, pc.pos.z - released.z);
    assert.lt(coast, 1.0, `releasing forward coasted ${coast.toFixed(3)}m; it must decelerate, not keep walking`);
    const settled = { x: pc.pos.x, z: pc.pos.z };
    for (let i = 0; i < 90; i++) pc.update(DT, im.sample(DT), {});
    assert.lt(Math.hypot(pc.pos.x - settled.x, pc.pos.z - settled.z), 1e-4,
      'the player must come to rest once the key is up');
  });

  test('04 · no non-finite value can escape sample()', () => {
    const im = mk();
    im.handleEvent('mousemove', { movementX: NaN, movementY: Infinity });
    im.setTouchMove(NaN, NaN);
    im.addTouchLook(NaN, 1 / 0);
    const intent = im.sample(NaN);
    for (const [field, value] of Object.entries(intent)) {
      if (typeof value === 'number') assert.finite(value, `${field} escaped as non-finite`);
    }
  });
});

describe('input — edges are exactly one frame wide', () => {
  test('05 · one press is one true frame, then false forever', () => {
    const im = mk();
    tap(im, 'Space');
    assert.equal(im.sample(DT).jump, true, 'press must register');
    assert.equal(im.sample(DT).jump, false, 'edge must not persist');
    assert.equal(im.sample(DT).jump, false, 'edge must not resurrect');
  });

  test('06 · two presses inside one frame are two frames of true', () => {
    // A boolean latch silently eats the second press, which is how a double-tap
    // dodge stops working on a slow frame. Counting does not.
    const im = mk();
    tap(im, 'Space');
    tap(im, 'Space');
    assert.equal(im.sample(DT).jump, true, 'first press');
    assert.equal(im.sample(DT).jump, true, 'second press must survive the same frame');
    assert.equal(im.sample(DT).jump, false, 'and then stop');
  });

  test('07 · an auto-repeat from a held key is not a press', () => {
    const im = mk();
    key(im, 'KeyE');
    assert.equal(im.sample(DT).interact, true, 'first press');
    key(im, 'KeyE', { repeat: true });
    assert.equal(im.sample(DT).interact, false, 'repeat must not re-trigger');
    key(im, 'KeyE', { repeat: true });
    key(im, 'KeyE', { repeat: true });
    assert.equal(im.sample(DT).interact, false, 'repeats never queue');
  });

  test('08 · a stuck key cannot queue edges without bound', () => {
    const im = mk();
    for (let i = 0; i < INPUT.MAX_EDGE_BUFFER + 25; i++) tap(im, 'Space');
    let trues = 0;
    for (let i = 0; i < INPUT.MAX_EDGE_BUFFER + 25; i++) if (im.sample(DT).jump) trues++;
    assert.equal(trues, INPUT.MAX_EDGE_BUFFER, 'edge queue must be capped');
    assert.gte(im.stats.drops, 25, 'dropped presses must be counted, not silent');
  });

  test('09 · every documented edge action behaves as an edge', () => {
    const cases = [
      ['Space', 'jump'], ['KeyQ', 'dodge'], ['KeyE', 'interact'], ['KeyC', 'crouch'],
      ['KeyX', 'shoulderSwap'], ['KeyR', 'parry'], ['KeyF', 'lockOn'], ['KeyG', 'useItem'],
    ];
    for (const [code, field] of cases) {
      const im = mk();
      tap(im, code);
      assert.equal(im.sample(DT)[field], true, `${field} should fire on press`);
      assert.equal(im.sample(DT)[field], false, `${field} should not persist`);
    }
  });

  test('10 · mouse attacks are edges, so holding a button does not re-swing', () => {
    // PlayerController calls startAttack() on every frame attackLight is true.
    const im = mk();
    click(im, 0);
    assert.equal(im.sample(DT).attackLight, true, 'click swings');
    assert.equal(im.sample(DT).attackLight, false, 'holding must not swing again');
    assert.equal(im.sample(DT).attackLight, false, 'still holding, still no swing');
    release(im, 0);
  });
});

describe('input — levels are held, not latched', () => {
  test('11 · sprint is true while held and false the moment it is released', () => {
    const im = mk();
    key(im, 'ShiftLeft');
    assert.equal(im.sample(DT).sprint, true, 'held');
    assert.equal(im.sample(DT).sprint, true, 'still held');
    up(im, 'ShiftLeft');
    assert.equal(im.sample(DT).sprint, false, 'released');
  });

  test('12 · crouch is an edge AND a hold on the same key', () => {
    const im = mk();
    key(im, 'KeyC');
    const first = im.sample(DT);
    assert.equal(first.crouch, true, 'toggle request fires once');
    assert.equal(first.crouchHeld, true, 'hold is live');
    const second = im.sample(DT);
    assert.equal(second.crouch, false, 'toggle must not repeat while held');
    assert.equal(second.crouchHeld, true, 'hold continues');
    up(im, 'KeyC');
    const third = im.sample(DT);
    assert.equal(third.crouchHeld, false, 'hold ends on release');
  });

  test('13 · block carries both level fields PlayerController reads', () => {
    // player.js: `if (intent.block || intent.blockHeld)` - either must work.
    const im = mk();
    click(im, 1);
    const a = im.sample(DT);
    assert.ok(a.block && a.blockHeld, 'both block fields must be set while held');
    assert.equal(im.sample(DT).blockHeld, true, 'blockHeld persists');
    release(im, 1);
    const b = im.sample(DT);
    assert.ok(!b.block && !b.blockHeld, 'both clear on release');
  });

  test('14 · drawing the bow is holding aim, with no second button', () => {
    const im = mk();
    key(im, 'KeyV');
    const i = im.sample(DT);
    assert.ok(i.aim && i.aimHeld && i.drawHeld, 'aim, aimHeld and drawHeld together');
    up(im, 'KeyV');
    const j = im.sample(DT);
    assert.ok(!j.aimHeld && !j.drawHeld, 'all three release together');
  });

  test('15 · focus loss drops every held code and queued edge', () => {
    const im = mk();
    key(im, 'KeyW');
    key(im, 'ShiftLeft');
    tap(im, 'Space');
    im.handleEvent('blur', {});
    const i = im.sample(DT);
    assert.equal(i.moveZ, 0, 'forward must not survive alt-tab');
    assert.equal(i.sprint, false, 'sprint must not survive alt-tab');
    assert.equal(i.jump, false, 'a queued jump must not survive alt-tab');
    assert.equal(im.stats.focusLosses, 1, 'focus loss must be counted');
    assert.ok(!im.isDown('KeyW'), 'the code itself must be released');
  });

  test('16 · visibilitychange is treated as focus loss too', () => {
    const im = mk();
    key(im, 'KeyW');
    im.handleEvent('visibilitychange', {});
    assert.equal(im.sample(DT).moveZ, 0, 'a hidden tab must stop the player');
  });
});

describe('input — movement axis', () => {
  test('17 · WASD maps to the axis PlayerController expects', () => {
    const im = mk();
    key(im, 'KeyW');
    assert.equal(im.sample(DT).moveZ, 1, 'forward is +Z');
    up(im, 'KeyW');
    key(im, 'KeyS');
    assert.equal(im.sample(DT).moveZ, -1, 'back is -Z');
    up(im, 'KeyS');
    key(im, 'KeyD');
    assert.equal(im.sample(DT).moveX, 1, 'right is +X');
    up(im, 'KeyD');
    key(im, 'KeyA');
    assert.equal(im.sample(DT).moveX, -1, 'left is -X');
  });

  test('18 · arrow keys are bound alongside WASD', () => {
    const im = mk();
    key(im, 'ArrowUp');
    assert.equal(im.sample(DT).moveZ, 1, 'ArrowUp moves forward');
  });

  test('19 · a keyboard diagonal is normalized, not faster', () => {
    const im = mk();
    key(im, 'KeyW');
    key(im, 'KeyD');
    const i = im.sample(DT);
    assert.close(Math.hypot(i.moveX, i.moveZ), 1, 1e-9, 'diagonal must not exceed unit length');
    assert.close(i.moveX, Math.SQRT1_2, 1e-9, 'diagonal X component');
  });

  test('20 · opposite keys cancel instead of picking a winner', () => {
    const im = mk();
    key(im, 'KeyW');
    key(im, 'KeyS');
    const i = im.sample(DT);
    assert.equal(i.moveZ, 0, 'forward and back together is standing still');
  });

  test('21 · bindings use physical codes, so an Arabic layout still walks', () => {
    // On an Arabic layout the character produced by the WASD positions is not W, A,
    // S or D. A game bound to `key` is unplayable in its own first-class language.
    const im = mk();
    im.handleEvent('keydown', { code: 'KeyW', key: 'ص' });
    assert.equal(im.sample(DT).moveZ, 1, 'physical code must drive movement regardless of layout');
    im.handleEvent('keyup', { code: 'KeyW', key: 'ص' });
    // And a bare `key` with no code does nothing, because nothing binds characters.
    const im2 = mk();
    im2.handleEvent('keydown', { key: 'w' });
    assert.equal(im2.sample(DT).moveZ, 0, 'input must not bind characters');
  });
});

describe('input — look', () => {
  test('22 · a mouse drag travels the radians path and is consumed once', () => {
    const im = mk();
    im.handleEvent('mousemove', { movementX: 100, movementY: 0 });
    const i = im.sample(DT);
    assert.equal(i.lookIsDeltaRadians, true, 'mouse must use the radians path');
    assert.close(i.lookX, 100 * CAM.SENSITIVITY_X * INPUT.MOUSE_SENSITIVITY_SCALE, 1e-9, 'scaled by sensitivity');
    assert.equal(im.sample(DT).lookX, 0, 'a drag must not be applied twice');
  });

  test('23 · vertical mouse movement is scaled independently', () => {
    const im = mk();
    im.handleEvent('mousemove', { movementX: 0, movementY: 40 });
    const i = im.sample(DT);
    assert.close(i.lookY, 40 * CAM.SENSITIVITY_Y * INPUT.MOUSE_SENSITIVITY_SCALE, 1e-9, 'Y sensitivity');
    assert.notEqual(CAM.SENSITIVITY_X, CAM.SENSITIVITY_Y, 'X and Y sensitivity should differ');
  });

  test('24 · sensitivityScale is a live setting, not a boot-time constant', () => {
    const im = mk();
    im.sensitivityScale = 2;
    im.handleEvent('mousemove', { movementX: 50, movementY: 0 });
    const scaled = im.sample(DT).lookX;
    im.sensitivityScale = 1;
    im.handleEvent('mousemove', { movementX: 50, movementY: 0 });
    const normal = im.sample(DT).lookX;
    assert.close(scaled / normal, 2, 1e-9, 'doubling the scale must double the turn');
  });

  test('25 · a gamepad stick uses the normalized path so its curve applies', () => {
    // PlayerController runs applyStickResponse on the normalized path. Sending a
    // stick as radians would skip the curve the camera was tuned against.
    const pad = fakePad({ axes: [0, 0, 0.8, 0] });
    const im = mk({ gamepad: true, gamepadProvider: () => [pad] });
    const i = im.sample(DT);
    assert.equal(i.lookIsDeltaRadians, false, 'a stick must not claim to be radians');
    assert.close(i.lookX, 0.8, 1e-9, 'the raw stick value must pass through');
  });

  test('26 · mouse and stick in the same frame combine as radians', () => {
    const pad = fakePad({ axes: [0, 0, 0.5, 0] });
    const im = mk({ gamepad: true, gamepadProvider: () => [pad] });
    im.handleEvent('mousemove', { movementX: 10, movementY: 0 });
    const i = im.sample(DT);
    assert.equal(i.lookIsDeltaRadians, true, 'radians path wins when both moved');
    assert.gt(i.lookX, 10 * CAM.SENSITIVITY_X, 'the stick contribution must be added');
  });

  test('27 · releasing a stick returns the axis to zero', () => {
    // The obvious implementation writes axes only when they are non-zero, which
    // leaves the last value in place and the character drifting after let-go.
    const pad = fakePad({ axes: [0.9, 0, 0, 0] });
    const im = mk({ gamepad: true, gamepadProvider: () => [pad] });
    assert.gt(im.sample(DT).moveX, 0.5, 'stick deflected');
    pad.axes[0] = 0;
    const i = im.sample(DT);
    assert.equal(i.moveX, 0, 'centered stick must stop movement');
    assert.equal(i.moveZ, 0, 'and leave nothing behind');
  });

  test('28 · stick drift inside the deadzone is rejected', () => {
    const pad = fakePad({ axes: [MOVE.INPUT_DEADZONE * 0.5, 0, CAM.GAMEPAD_DEADZONE * 0.5, 0] });
    const im = mk({ gamepad: true, gamepadProvider: () => [pad] });
    const i = im.sample(DT);
    assert.equal(i.moveX, 0, 'move deadzone');
    assert.equal(i.lookX, 0, 'look deadzone');
  });

  test('29 · a throwing gamepad provider cannot take the input layer down', () => {
    const im = mk({ gamepad: true, gamepadProvider: () => { throw new Error('driver fault'); } });
    let intent = null;
    assert.doesNotThrow(() => { intent = im.sample(DT); }, 'sample must survive a bad provider');
    assert.equal(intent.moveX, 0, 'and still return a usable intent');
  });

  test('30 · gamepad buttons map to the same actions the keyboard uses', () => {
    const pad = fakePad();
    const im = mk({ gamepad: true, gamepadProvider: () => [pad] });
    pad.buttons[0].pressed = true;
    assert.equal(im.sample(DT).jump, true, 'face button jumps');
    assert.equal(im.sample(DT).jump, false, 'once');
    pad.buttons[0].pressed = false;
    im.sample(DT);
    pad.buttons[6].pressed = true;
    assert.equal(im.sample(DT).sprint, true, 'shoulder sprints');
    assert.equal(im.sample(DT).sprint, true, 'and holds while the button is held');
    pad.buttons[6].pressed = false;
    assert.equal(im.sample(DT).sprint, false, 'then releases');
  });
});

describe('input — the bow resolves one button into two meanings', () => {
  test('31 · Mouse0 swings when the bow is down', () => {
    const im = mk();
    click(im, 0);
    const i = im.sample(DT);
    assert.equal(i.attackLight, true, 'a swing');
    assert.equal(i.fire, false, 'and not a shot');
    release(im, 0);
  });

  test('32 · Mouse0 shoots when the bow is up', () => {
    const im = mk();
    key(im, 'KeyV');
    click(im, 0);
    const i = im.sample(DT);
    assert.equal(i.fire, true, 'a shot');
    assert.equal(i.attackLight, false, 'and not a swing');
    release(im, 0);
    up(im, 'KeyV');
  });

  test('33 · fire has no code of its own by default', () => {
    // It is what Mouse0 means while aiming. Giving it a code as well would queue a
    // shot alongside every swing.
    assert.equal(INPUT.BINDINGS.fire.length, 0, 'fire must be unbound by default');
    assert.includes(Object.keys(INPUT.BINDINGS), 'fire', 'but must still be a bindable action');
    const im = mk();
    assert.ok(im.rebind('fire', 'KeyB').ok, 'a player may still bind a dedicated shot key');
  });

  test('34 · a dedicated fire binding works and does not suppress a swing', () => {
    const im = mk();
    im.rebind('fire', 'KeyB');
    tap(im, 'KeyB');
    const i = im.sample(DT);
    assert.equal(i.fire, true, 'the bound key fires');
    assert.equal(i.attackLight, false, 'without swinging');
  });
});

describe('input — touch', () => {
  test('35 · a touch stick drives movement and is normalized', () => {
    const im = mk();
    im.setTouchMove(1, 1);
    const i = im.sample(DT);
    assert.close(Math.hypot(i.moveX, i.moveZ), 1, 1e-9, 'a corner drag must not be faster');
    assert.gt(i.moveZ, 0, 'forward component');
    assert.equal(im.activeSource(), InputSource.TOUCH, 'the source must be reported for prompt glyphs');
  });

  test('36 · touch drift inside the stick deadzone is ignored', () => {
    const im = mk();
    im.setTouchMove(INPUT.TOUCH_STICK_DEADZONE * 0.4, 0);
    assert.equal(im.sample(DT).moveX, 0, 'a resting thumb must not walk');
  });

  test('37 · a touch drag turns the camera on the radians path', () => {
    const im = mk();
    im.addTouchLook(120, 0);
    const i = im.sample(DT);
    assert.equal(i.lookIsDeltaRadians, true, 'a drag is a delta, not a stick');
    assert.close(i.lookX, 120 * INPUT.TOUCH_LOOK_SENSITIVITY, 1e-9, 'scaled by touch sensitivity');
    assert.equal(im.sample(DT).lookX, 0, 'consumed once');
  });

  test('38 · a touch level button holds across frames and an edge button does not', () => {
    const im = mk();
    im.setTouchAction('block', true);
    im.setTouchAction('dodge', true);
    const a = im.sample(DT);
    assert.ok(a.block && a.blockHeld, 'touch block must actually block');
    assert.equal(a.dodge, true, 'touch dodge fires');
    const b = im.sample(DT);
    assert.ok(b.block && b.blockHeld, 'block keeps holding without a key code');
    assert.equal(b.dodge, false, 'dodge does not repeat');
    im.setTouchAction('block', false);
    assert.equal(im.sample(DT).blockHeld, false, 'and releases');
  });

  test('39 · a touch action that is not a real action is refused', () => {
    const im = mk();
    assert.equal(im.setTouchAction('selfDestruct', true), false, 'unknown actions must be refused');
    assert.equal(im.sample(DT).moveX, 0, 'and must not corrupt the intent');
  });

  test('40 · a gamepad does not clobber a touch stick it is not driving', () => {
    // A connected-but-idle controller must not zero the player's thumb every frame.
    const pad = fakePad();
    const im = mk({ gamepad: true, gamepadProvider: () => [pad] });
    im.setTouchMove(0, 1);
    assert.close(im.sample(DT).moveZ, 1, 1e-9, 'touch drives while the pad is idle');
    pad.axes[0] = 0.9;
    assert.close(im.sample(DT).moveX, 0.9, 1e-6, 'the pad takes over when deflected');
    pad.axes[0] = 0;
    assert.equal(im.sample(DT).moveX, 0, 'and hands back when centered');
  });
});

describe('input — rebinding', () => {
  test('41 · a rebind takes effect in the very next sample', () => {
    const im = mk();
    assert.ok(im.rebind('jump', 'KeyJ').ok, 'rebind should succeed');
    tap(im, 'Space');
    assert.equal(im.sample(DT).jump, false, 'the old key must stop working');
    tap(im, 'KeyJ');
    assert.equal(im.sample(DT).jump, true, 'the new key must work');
  });

  test('42 · a rebind refuses to put two actions on one code', () => {
    const im = mk();
    im.rebind('jump', 'KeyJ');
    const res = im.rebind('dodge', 'KeyJ');
    assert.equal(res.ok, false, 'the collision must be refused');
    assert.includes(res.reason, 'jump', 'and the reason must name what is already there');
  });

  test('43 · protected bindings cannot be moved', () => {
    const im = mk();
    for (const action of INPUT.PROTECTED_BINDINGS) {
      assert.equal(im.rebind(action, 'KeyJ').reason, 'protected', `${action} must be protected`);
    }
  });

  test('44 · unknown actions and empty codes are refused, not thrown', () => {
    const im = mk();
    assert.equal(im.rebind('nope', 'KeyJ').reason, 'unknown-action');
    assert.equal(im.rebind('jump', '').reason, 'bad-code');
    assert.equal(im.rebind('jump', null).reason, 'bad-code');
  });

  test('45 · resetBindings restores the shipped map', () => {
    const im = mk();
    im.rebind('jump', 'KeyJ');
    im.resetBindings();
    assert.deepEqual(im.bindingsFor('jump'), [...INPUT.BINDINGS.jump], 'jump must be back to default');
    tap(im, 'Space');
    assert.equal(im.sample(DT).jump, true, 'and must work again');
  });

  test('46 · serialize and restore round-trips without complaint', () => {
    const a = mk();
    a.rebind('jump', 'KeyJ');
    const b = mk();
    const res = b.restoreBindings(a.serializeBindings());
    assert.ok(res.ok, `a clean round-trip must report no problems, got: ${res.problems.join('; ')}`);
    assert.deepEqual(b.bindingsFor('jump'), ['KeyJ'], 'the rebind must survive');
    assert.deepEqual(b.bindingsFor('fire'), [], 'an intentionally unbound action must stay unbound');
  });

  test('47 · a corrupt binding set is repaired with a report', () => {
    const im = mk();
    const res = im.restoreBindings({
      bindings: {
        nope: ['KeyQ'],        // unknown action
        jump: [],              // emptied
        dodge: 42,             // wrong type
        interact: ['KeyE', 'KeyE', null, 7], // duplicates and junk
      },
    });
    assert.equal(res.ok, false, 'a corrupt set must report problems');
    assert.ok(res.problems.some((p) => p.includes('unknown action')), 'unknown action reported');
    assert.deepEqual(im.bindingsFor('jump'), [...INPUT.BINDINGS.jump], 'emptied action restored');
    assert.deepEqual(im.bindingsFor('dodge'), [...INPUT.BINDINGS.dodge], 'mistyped action restored');
    assert.deepEqual(im.bindingsFor('interact'), ['KeyE'], 'duplicates and junk filtered');
  });

  test('48 · a restored set never leaves two actions on one code', () => {
    const im = mk();
    const res = im.restoreBindings({
      bindings: { jump: ['KeyT'], dodge: ['KeyT'], interact: ['KeyE'] },
    });
    assert.ok(res.problems.some((p) => p.includes('both')), 'the collision must be reported');
    const owners = {};
    for (const action of Object.keys(im.bindings)) {
      for (const code of im.bindingsFor(action)) {
        assert.ok(!owners[code], `code ${code} ended up on ${owners[code]} and ${action}`);
        owners[code] = action;
      }
    }
  });

  test('49 · a missing payload is refused rather than applied', () => {
    const im = mk();
    const before = im.bindingsFor('jump');
    assert.equal(im.restoreBindings(null).ok, false, 'null payload refused');
    assert.equal(im.restoreBindings({}).ok, false, 'empty payload refused');
    assert.deepEqual(im.bindingsFor('jump'), before, 'and the live bindings are untouched');
  });

  test('50 · every default binding names a real intent field or a UI action', () => {
    // A binding for an action nothing reads is a key that does nothing, which a
    // player reports as a bug and a designer cannot see.
    const intentKeys = Object.keys(emptyIntent());
    const allowed = [...intentKeys, 'pause', 'moveForward', 'moveBack', 'moveLeft', 'moveRight'];
    for (const action of Object.keys(INPUT.BINDINGS)) {
      assert.includes(allowed, action, `binding "${action}" maps to nothing`);
    }
  });
});

describe('input — UI actions and frame cost', () => {
  test('51 · pause is readable but is not part of the intent', () => {
    const im = mk();
    tap(im, 'Escape');
    const i = im.sample(DT);
    assert.excludes(Object.keys(i), 'pause', 'pause must not leak into the intent');
    assert.equal(im.takeAction('pause'), true, 'the game loop takes it explicitly');
    assert.equal(im.takeAction('pause'), false, 'and only once');
  });

  test('52 · a pause press survives several frames before it is taken', () => {
    const im = mk();
    tap(im, 'Escape');
    im.sample(DT);
    im.sample(DT);
    im.sample(DT);
    assert.equal(im.takeAction('pause'), true, 'a menu key must not be eaten by frame timing');
  });

  test('53 · the wheel accumulates and is consumed once', () => {
    const im = mk();
    im.handleEvent('wheel', { deltaY: 120 });
    im.handleEvent('wheel', { deltaY: 120 });
    assert.equal(im.consumeWheel(), 240, 'both notches');
    assert.equal(im.consumeWheel(), 0, 'consumed');
  });

  test('54 · events without a usable code are ignored, not applied', () => {
    const im = mk();
    assert.equal(im.handleEvent('keydown', {}), false, 'no code');
    assert.equal(im.handleEvent('keydown', { code: '' }), false, 'empty code');
    assert.equal(im.handleEvent('keydown', { code: 7 }), false, 'non-string code');
    assert.equal(im.handleEvent('nonsense', {}), false, 'unknown event type');
    assert.equal(im.sample(DT).moveZ, 0, 'nothing moved');
  });

  test('55 · detach releases state and stops listening', () => {
    const listeners = [];
    const fakeTarget = {
      addEventListener: (t, fn) => listeners.push([t, fn]),
      removeEventListener: (t, fn) => {
        const i = listeners.findIndex(([a, b]) => a === t && b === fn);
        if (i >= 0) listeners.splice(i, 1);
      },
    };
    const im = new InputManager({ target: fakeTarget, bus: new EventBus(), gamepad: false });
    assert.ok(im.attached, 'attached on construction');
    assert.gte(listeners.length, 8, 'the real listener set must be installed');
    im.handleEvent('keydown', { code: 'KeyW' });
    assert.equal(im.detach(), true, 'detach reports success');
    assert.equal(listeners.length, 0, 'every listener removed');
    assert.equal(im.sample(DT).moveZ, 0, 'and held state dropped');
    assert.equal(im.detach(), false, 'detaching twice is a no-op, not an error');
  });

  test('56 · a rebind emits a settings-changed event the UI can react to', () => {
    const bus = new EventBus();
    const seen = [];
    bus.on(Events.SETTINGS_CHANGED, (p) => seen.push(p));
    const im = new InputManager({ bus, gamepad: false });
    im.rebind('jump', 'KeyJ');
    im.resetBindings();
    assert.equal(seen.length, 2, 'one event per change');
    assert.equal(seen[0].action, 'jump', 'the changed action is named');
    assert.equal(seen[1].action, null, 'a reset names no single action');
  });

  test('57 · sample() is cheap enough to run every frame', () => {
    const pad = fakePad({ axes: [0.4, 0.2, 0.1, 0] });
    const im = mk({ gamepad: true, gamepadProvider: () => [pad] });
    key(im, 'KeyW');
    key(im, 'ShiftLeft');
    im.setTouchMove(0.5, 0.5);
    const avgMs = measure(() => im.sample(DT), 4000, 200);
    assert.lt(avgMs, 0.05, `sample() averaged ${avgMs.toFixed(4)}ms; input must be far under a frame`);
  });
});

runAndExit();
