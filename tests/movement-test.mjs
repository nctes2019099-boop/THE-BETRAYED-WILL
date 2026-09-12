/**
 * THE BETRAYED WILL — movement-test.mjs
 *
 * The player controller suite. Movement is the thing the player touches every
 * second of the game, so it is tested against the tuning constants rather than
 * against hand-picked "looks right" numbers: if a designer changes RUN_SPEED,
 * these tests follow the constant instead of silently passing a stale value.
 *
 * What is asserted, and why it matters:
 *   - speeds converge to the declared constants (locomotion is not decorative)
 *   - the player STOPS when input is released (no ice-skating)
 *   - the player never ends a frame inside geometry (collision is authoritative)
 *   - step-up works at exactly STEP_HEIGHT and refuses just above it
 *   - coyote time and jump buffering work, because those are the difference
 *     between "responsive" and "the jump didn't register"
 *   - stamina exhausts and recovers at the declared thresholds
 *   - dodge i-frames exist only inside their declared window
 *   - a corrupted position recovers instead of falling through the world
 *   - a save round-trips, and never restores into a transient state
 *   - the simulation is deterministic and frame-rate independent
 *
 * Run: node tests/movement-test.mjs
 */

import { describe, test, assert, runAndExit, measure } from './harness.mjs';
import { Vec3, wrapAngle } from '../src/core/math.js';
import { MOVE, COMBAT, WORLD, PERF } from '../src/core/constants.js';
import { EventBus } from '../src/core/bus.js';
import { CollisionWorld, boxCollider, wallCollider } from '../src/sim/collision.js';
import { PlayerController, PlayerState, Stance, emptyIntent } from '../src/sim/player.js';
import { World } from '../src/sim/world.js';

// Built once and shared: test 38 drives the controller through real generated
// geometry, and rebuilding all 20 regions per test would dominate the runtime.
const sharedWorld = new World();
sharedWorld.buildAll();

const DT = 1 / 60;

/* ------------------------------------------------------------- test world */

/**
 * A small, explicit collision world: flat ground, one free-standing wall, one
 * step at exactly STEP_HEIGHT, one step just above it, and a pit. Deliberately
 * not the generated world — movement invariants must hold on known geometry so
 * a failure names the mechanism rather than a region.
 */
function makeWorld() {
  const cw = new CollisionWorld(4);
  cw.setBounds(new Vec3(-40, -20, -40), new Vec3(40, 40, 40));
  cw.groundHeight = 0;
  cw.heightFn = null;
  // Free-standing wall along Z at x = 6.
  cw.add(wallCollider(6, -10, 6, 10, 0, 3.0, 0.5,
    { kind: 'wall', blocksMovement: true, blocksSight: true, blocksCamera: true, material: 'mudBrick' }));
  // Step exactly at STEP_HEIGHT.
  cw.add(boxCollider(-6, MOVE.STEP_HEIGHT / 2, 0, 3, MOVE.STEP_HEIGHT, 3,
    { kind: 'step', blocksMovement: true, walkableTop: true, stepHeight: MOVE.STEP_HEIGHT, material: 'bakedBrick' }));
  // Step just above STEP_HEIGHT — must be refused.
  const tooTall = MOVE.STEP_HEIGHT + 0.30;
  cw.add(boxCollider(-6, tooTall / 2, 8, 3, tooTall, 3,
    { kind: 'step', blocksMovement: true, walkableTop: true, stepHeight: tooTall, material: 'bakedBrick' }));
  // Ledge for hang/mantle: a 2.2 m block with a walkable top.
  cw.add(boxCollider(0, 1.1, -14, 6, 2.2, 2.0,
    { kind: 'ledge', blocksMovement: true, walkableTop: true, stepHeight: 2.2, material: 'mudBrick' }));
  return cw;
}

/**
 * An empty world: flat ground, generous bounds, nothing to walk into.
 *
 * Speed, stamina, turn-rate and telemetry tests must measure the controller's
 * own convergence, so they need geometry that cannot interrupt it. makeWorld()'s
 * ledge block sits at z[-15,-13]; a sprint from the origin reaches it in about
 * two seconds, and the player then spends the rest of the test pressed against
 * it at zero velocity - which reads as "sprint is broken" or "stamina never
 * drains" when the rig is what broke. Every test that asserts a SPEED uses this.
 */
function makeFlatWorld() {
  const cw = new CollisionWorld(4);
  cw.setBounds(new Vec3(-1000, -20, -1000), new Vec3(1000, 40, 1000));
  cw.groundHeight = 0;
  cw.heightFn = null;
  return cw;
}

function makePlayer(opts = {}) {
  const bus = new EventBus();
  const events = [];
  const p = new PlayerController({
    collision: opts.collision === undefined ? makeWorld() : opts.collision,
    bus,
    pos: opts.pos ? opts.pos.clone() : new Vec3(0, 0, 0),
    injured: opts.injured === true,
    ...opts.extra,
  });
  p._testEvents = events;
  if (bus.onAny) bus.onAny((type, payload) => events.push({ type, payload }));
  return p;
}

/** Drive the controller for `seconds` with a fixed intent. */
function drive(p, seconds, intentMutator, ctx = {}) {
  const intent = emptyIntent();
  const frames = Math.max(1, Math.round(seconds / DT));
  let last = null;
  for (let i = 0; i < frames; i++) {
    const it = emptyIntent();
    Object.assign(it, intent);
    if (intentMutator) intentMutator(it, i, frames);
    last = p.update(DT, it, ctx);
  }
  return last;
}

/** Run until `predicate` holds or the time budget runs out. */
function driveUntil(p, maxSeconds, predicate, intentMutator) {
  const frames = Math.max(1, Math.round(maxSeconds / DT));
  for (let i = 0; i < frames; i++) {
    const it = emptyIntent();
    if (intentMutator) intentMutator(it, i, frames);
    p.update(DT, it);
    if (predicate(p, i)) return i;
  }
  return -1;
}

const planarSpeed = (p) => Math.hypot(p.velocity.x, p.velocity.z);

/* --------------------------------------------------------------- locomotion */

describe('movement — locomotion', () => {
  test('01 · an idle player does not drift', () => {
    const p = makePlayer();
    drive(p, 1.0);
    assert.close(p.pos.x, 0, 1e-6, 'idle player drifted on X');
    assert.close(p.pos.z, 0, 1e-6, 'idle player drifted on Z');
    assert.close(planarSpeed(p), 0, 1e-6, 'idle player has residual velocity');
    assert.ok(p.grounded, 'idle player left the ground');
    assert.close(p.pos.y, 0, 1e-6, 'idle player sank or floated');
  });

  test('02 · walk, run and sprint converge to the declared speeds', () => {
    // Each declared speed must be reachable at a real stick deflection. The
    // walk band tops out at exactly RUN_THRESHOLD, so WALK_SPEED lives there;
    // RUN_SPEED and SPRINT_SPEED live at full deflection. Asserting a speed no
    // input can produce is how a dead tuning constant goes unnoticed.
    const cases = [
      ['walk', MOVE.RUN_THRESHOLD, false, MOVE.WALK_SPEED],
      ['run', 1.0, false, MOVE.RUN_SPEED],
      ['sprint', 1.0, true, MOVE.SPRINT_SPEED],
    ];
    for (const [name, deflection, sprint, target] of cases) {
      const p = makePlayer({ collision: makeFlatWorld() });
      drive(p, 3.0, (i) => { i.moveZ = deflection; i.sprint = sprint; });
      assert.close(planarSpeed(p), target, target * 0.03,
        `${name} speed did not converge to ${target} (got ${planarSpeed(p).toFixed(3)})`);
    }
    assert.lt(MOVE.WALK_SPEED, MOVE.RUN_SPEED, 'constant ordering broken');
    assert.lt(MOVE.RUN_SPEED, MOVE.SPRINT_SPEED, 'constant ordering broken');
  });

  test('03 · the player stops when input is released — no ice-skating', () => {
    const p = makePlayer();
    drive(p, 1.5, (i) => { i.moveZ = 1; i.sprint = true; });
    const speedAtRelease = planarSpeed(p);
    assert.gt(speedAtRelease, MOVE.RUN_SPEED, 'did not reach sprint speed before release');
    const posAtRelease = p.pos.clone();

    drive(p, 1.0);   // no input
    assert.close(planarSpeed(p), 0, 0.05,
      `player still moving ${planarSpeed(p).toFixed(3)} m/s one second after releasing input`);
    const stopDistance = posAtRelease.distanceXZ
      ? posAtRelease.distanceXZ(p.pos)
      : Math.hypot(p.pos.x - posAtRelease.x, p.pos.z - posAtRelease.z);
    // Stopping distance from sprint must be short and bounded, otherwise the
    // player overshoots every interaction prompt and every cover corner.
    assert.lt(stopDistance, 3.0,
      `took ${stopDistance.toFixed(2)} m to stop from sprint — feels like skating`);
    assert.gt(stopDistance, 0.05, 'stopped instantaneously — that reads as jerky, not responsive');
  });

  test('04 · analogue deflection scales speed proportionally and continuously', () => {
    const speedAt = (deflection) => {
      const p = makePlayer({ collision: makeFlatWorld() });
      drive(p, 2.0, (i) => { i.moveZ = deflection; });
      return planarSpeed(p);
    };

    // Proportionality inside the walk band, measured across the USABLE range.
    // INPUT_DEADZONE is rescaled out rather than gated, so half of RUN_THRESHOLD
    // in RAW stick terms is deliberately not half of walking speed - demanding
    // raw proportionality here would demand the deadzone lurch back.
    const usable = (f) => MOVE.INPUT_DEADZONE
      + (MOVE.RUN_THRESHOLD - MOVE.INPUT_DEADZONE) * f;
    const quarter = speedAt(usable(0.25));
    const half = speedAt(usable(0.5));
    const threeQuarters = speedAt(usable(0.75));
    const full = speedAt(MOVE.RUN_THRESHOLD);
    assert.close(quarter / full, 0.25, 0.04,
      `a quarter of the usable stick gave ${(quarter / full * 100).toFixed(0)}% speed, expected ~25%`);
    assert.close(half / full, 0.5, 0.04,
      `half the usable stick gave ${(half / full * 100).toFixed(0)}% speed, expected ~50%`);
    assert.close(threeQuarters / full, 0.75, 0.04,
      `three quarters of the usable stick gave ${(threeQuarters / full * 100).toFixed(0)}% speed, expected ~75%`);
    assert.close(full, MOVE.WALK_SPEED, MOVE.WALK_SPEED * 0.03,
      `WALK_SPEED is not attainable at RUN_THRESHOLD deflection (got ${full.toFixed(3)})`);

    // Monotonic and continuous across the WHOLE stick. A band boundary must not
    // lurch the player: more deflection is never slower, and no single 0.05 step
    // may add more speed than its neighbours do. This is the assertion that
    // catches a dead constant or a discontinuous band switch.
    let prev = 0;
    let worstStep = 0;
    let worstAt = 0;
    for (let d = 0.05; d <= 1.0001; d += 0.05) {
      const sp = speedAt(d);
      assert.gte(sp, prev - 1e-6,
        `speed fell as deflection rose: ${d.toFixed(2)} gave ${sp.toFixed(3)} after ${(d - 0.05).toFixed(2)} gave ${prev.toFixed(3)}`);
      const step = sp - prev;
      if (step > worstStep) { worstStep = step; worstAt = d; }
      prev = sp;
    }
    assert.lt(worstStep, 0.35,
      `a ${worstStep.toFixed(3)} m/s jump at deflection ${worstAt.toFixed(2)} - the deflection curve is discontinuous`);
    assert.close(prev, MOVE.RUN_SPEED, MOVE.RUN_SPEED * 0.03,
      'full deflection did not reach RUN_SPEED');
  });

  test('05 · strafe and diagonal movement keep the speed budget', () => {
    // Input is normalised before it is used, so a full diagonal must reach the
    // same cap as a full straight push and must never exceed it - otherwise
    // players strafe-jump everywhere and the animation set stops matching.
    const p = makePlayer({ collision: makeFlatWorld() });
    drive(p, 3.0, (i) => { i.moveX = 1; i.moveZ = 1; });
    const diag = planarSpeed(p);
    assert.lte(diag, MOVE.RUN_SPEED * 1.02,
      `diagonal movement (${diag.toFixed(3)}) exceeds the straight-line budget`);
    assert.close(diag, MOVE.RUN_SPEED, MOVE.RUN_SPEED * 0.04,
      `a full diagonal (${diag.toFixed(3)}) did not reach the run band cap`);

    const q = makePlayer({ collision: makeFlatWorld() });
    drive(q, 3.0, (i) => { i.moveX = 1; });
    assert.close(planarSpeed(q), MOVE.RUN_SPEED, MOVE.RUN_SPEED * 0.04,
      `a full strafe (${planarSpeed(q).toFixed(3)}) did not reach the run band cap`);
  });

  test('06 · the body turns to face movement, at a bounded rate', () => {
    const p = makePlayer({ collision: makeFlatWorld() });
    drive(p, 0.6, (i) => { i.moveZ = 1; });
    const yawForward = p.yaw;
    drive(p, 1.2, (i) => { i.moveX = 1; });
    // Facing must have changed, but not snapped instantaneously: an instant turn
    // reads as robotic and breaks the animation blend. Yaw is an angle, so the
    // difference MUST be wrapped - a turn through +/-pi is the smallest possible
    // turn, not the largest, and an unwrapped delta reports ~2pi.
    assert.gt(Math.abs(wrapAngle(p.yaw - yawForward)), 0.05, 'body did not turn toward movement');

    const r = makePlayer({ collision: makeFlatWorld() });
    drive(r, 0.3, (i) => { i.moveZ = 1; });
    let prev = r.yaw;
    let maxDelta = 0;
    for (let i = 0; i < 30; i++) {
      const it = emptyIntent(); it.moveX = -1;
      r.update(DT, it);
      maxDelta = Math.max(maxDelta, Math.abs(wrapAngle(r.yaw - prev)));
      prev = r.yaw;
    }
    const maxTurnPerFrame = MOVE.TURN_RATE_GROUND * DT * 1.05;
    assert.lte(maxDelta, maxTurnPerFrame,
      `yaw changed ${maxDelta.toFixed(4)} rad in one frame, limit is ${maxTurnPerFrame.toFixed(4)}`);
    assert.gt(maxDelta, 0, 'the body never turned - the measurement proves nothing');
  });

  test('07 · crouching shortens the capsule and slows the player', () => {
    const p = makePlayer();
    const standingHeight = p.capsuleHeight;
    assert.close(standingHeight, MOVE.CAPSULE_HEIGHT, 1e-6, 'standing capsule height wrong');

    drive(p, 0.2, (i) => { i.crouch = true; });
    drive(p, 1.5, (i) => { i.crouchHeld = true; i.moveZ = 1; });
    assert.equal(p.stance, Stance.CROUCH, 'crouch request did not change stance');
    assert.close(p.capsuleHeight, MOVE.CROUCH_CAPSULE_HEIGHT, 0.06,
      'crouched capsule did not reach the declared height');
    assert.lt(p.capsuleHeight, standingHeight, 'crouching must make the capsule shorter');
    assert.close(planarSpeed(p), MOVE.CROUCH_SPEED, MOVE.CROUCH_SPEED * 0.15,
      'crouch speed does not match the constant');

    // Standing back up must be refused where there is no headroom.
    drive(p, 1.0, (i) => { i.crouch = true; });
    assert.equal(p.stance, Stance.STAND, 'crouch did not toggle back to standing');
  });
});

/* ------------------------------------------------------------------ jumping */

describe('movement — jumping and gravity', () => {
  test('08 · a jump leaves the ground and lands again', () => {
    const p = makePlayer();
    let wasAirborne = false;
    let apex = 0;
    const frames = Math.round(2.0 / DT);
    for (let i = 0; i < frames; i++) {
      const it = emptyIntent();
      if (i === 0) it.jump = true;
      if (i < 12) it.jumpHeld = true;
      p.update(DT, it);
      if (!p.grounded) wasAirborne = true;
      apex = Math.max(apex, p.pos.y);
      if (wasAirborne && p.grounded) break;
    }
    assert.ok(wasAirborne, 'the player never left the ground');
    assert.ok(p.grounded, 'the player never landed');
    assert.close(p.pos.y, 0, 1e-3, 'the player did not land back on the ground plane');

    // Apex must match ballistic physics for the declared jump velocity, within
    // the tolerance the jump-cut and gravity scale introduce.
    const expectedApex = (MOVE.JUMP_VELOCITY * MOVE.JUMP_VELOCITY) / (2 * MOVE.GRAVITY);
    assert.close(apex, expectedApex, expectedApex * 0.30,
      `apex ${apex.toFixed(3)} m does not match v^2/2g = ${expectedApex.toFixed(3)} m`);
    assert.equal(p.telemetry.jumps, 1, 'jump was not counted in telemetry');
  });

  test('09 · releasing jump early cuts the jump short (variable height)', () => {
    const apexFor = (holdFrames) => {
      const p = makePlayer();
      let apex = 0;
      for (let i = 0; i < 90; i++) {
        const it = emptyIntent();
        if (i === 0) it.jump = true;
        it.jumpHeld = i < holdFrames;
        p.update(DT, it);
        apex = Math.max(apex, p.pos.y);
        if (i > 4 && p.grounded) break;
      }
      return apex;
    };
    const short = apexFor(2);
    const full = apexFor(30);
    assert.lt(short, full * 0.92,
      `jump cut does nothing: hold 2 frames = ${short.toFixed(3)} m, hold 30 = ${full.toFixed(3)} m`);
    assert.gt(short, 0.05, 'a cut jump should still leave the ground');
    assert.close(full, (MOVE.JUMP_VELOCITY ** 2) / (2 * MOVE.GRAVITY), 0.35,
      'a fully held jump does not reach its ballistic apex');
  });

  test('10 · coyote time allows a jump just after walking off a ledge', () => {
    // Build a platform with a drop-off; walk off, then jump within COYOTE_TIME.
    const cw = new CollisionWorld(4);
    cw.setBounds(new Vec3(-20, -40, -20), new Vec3(20, 30, 20));
    // Deep pit: the "outside coyote" case must still be airborne when it tries
    // to jump, or it lands, becomes grounded again and the jump legitimately
    // works - which would make the assertion measure the floor, not coyote time.
    cw.groundHeight = -30;
    cw.heightFn = null;
    cw.add(boxCollider(-5, 1.0, 0, 10, 2.0, 12,
      { kind: 'platform', blocksMovement: true, walkableTop: true, stepHeight: 2.0, material: 'mudBrick' }));

    const attempt = (delaySeconds) => {
      // Start at the platform's centre. moveZ = -1 drives toward +Z in world
      // space (input is camera-relative), so the player walks off the z = +6
      // edge. Support is the capsule's base disc, so they leave the ground just
      // past z = 6 + CAPSULE_RADIUS, roughly 10.7 m of travel - about 2.6 s at
      // run speed. The budget below must cover that.
      const p = makePlayer({ collision: cw, pos: new Vec3(-5, 2.0, -4) });
      const leftFrame = driveUntil(p, 8.0, (pl) => !pl.grounded, (i) => { i.moveZ = -1; });
      if (leftFrame < 0) return { leftGround: false, jumped: false, landed: false };

      const waitFrames = Math.max(0, Math.round(delaySeconds / DT));
      for (let i = 0; i < waitFrames; i++) {
        if (p.grounded) return { leftGround: true, jumped: false, landed: true };
        p.update(DT, emptyIntent());
      }
      if (p.grounded) return { leftGround: true, jumped: false, landed: true };

      const it = emptyIntent();
      it.jump = true; it.jumpHeld = true;
      p.update(DT, it);
      return { leftGround: true, jumped: p.verticalVelocity > 0.1, landed: false };
    };

    const inside = attempt(MOVE.COYOTE_TIME * 0.4);
    assert.ok(inside.leftGround, 'player never walked off the platform - test rig is wrong');
    assert.ok(inside.jumped,
      `a jump ${(MOVE.COYOTE_TIME * 0.4).toFixed(3)}s after leaving the ground must still work (coyote time is ${MOVE.COYOTE_TIME}s)`);

    const outside = attempt(MOVE.COYOTE_TIME + 0.25);
    assert.ok(outside.leftGround, 'player never walked off the platform - test rig is wrong');
    assert.notOk(outside.landed,
      'the player reached the pit floor before the coyote check - deepen the pit');
    assert.notOk(outside.jumped,
      `a jump ${(MOVE.COYOTE_TIME + 0.25).toFixed(3)}s after leaving the ground still worked - air-jumping is not in this game`);
  });

  test('11 · jump buffering registers a press made just before landing', () => {
    const p = makePlayer();
    // Jump, and while still airborne but within the buffer window of landing,
    // press jump again. The second jump must come out on landing.
    let pressed = false;
    let secondJump = false;
    let firstApexPassed = false;
    for (let i = 0; i < 240; i++) {
      const it = emptyIntent();
      if (i === 0) { it.jump = true; it.jumpHeld = true; }
      if (i > 6 && p.verticalVelocity < 0) firstApexPassed = true;
      if (firstApexPassed && p.pos.y < MOVE.JUMP_BUFFER * 6 && !pressed) {
        it.jump = true; pressed = true;
      }
      const before = p.telemetry.jumps;
      p.update(DT, it);
      if (pressed && p.telemetry.jumps > before + 0 && i > 20) secondJump = true;
      if (secondJump) break;
    }
    assert.ok(pressed, 'never got close enough to the ground to press the buffered jump');
    assert.gte(p.telemetry.jumps, 2,
      `the buffered jump did not fire on landing (jumps=${p.telemetry.jumps}, buffer=${MOVE.JUMP_BUFFER}s)`);
    void secondJump;
  });

  test('12 · gravity pulls the player down and terminal velocity is capped', () => {
    const p = makePlayer({ collision: null });
    p.setPosition(0, 200, 0);
    p.grounded = false;
    let maxFall = 0;
    for (let i = 0; i < 400; i++) {
      p.update(DT, emptyIntent());
      maxFall = Math.max(maxFall, -p.verticalVelocity);
    }
    assert.gt(maxFall, 1, 'gravity did not accelerate the player');
    assert.lte(maxFall, MOVE.MAX_FALL_SPEED * 1.02 + 1e-6,
      `fall speed ${maxFall.toFixed(2)} exceeded MAX_FALL_SPEED ${MOVE.MAX_FALL_SPEED}`);
  });

  test('13 · a long fall applies fall damage on landing', () => {
    const p = makePlayer();
    p.setPosition(0, MOVE.FALL_DAMAGE_LETHAL_HEIGHT * 0.6, 0);
    p.grounded = false;
    const healthBefore = p.health;
    driveUntil(p, 6.0, (pl) => pl.grounded);
    assert.ok(p.grounded, 'player never landed');
    assert.lt(p.health, healthBefore,
      'a fall past the safe height dealt no damage');
    assert.equal(p.telemetry.fallDamageEvents, 1, 'fall damage was not counted once');
    assert.gt(p.landRecovery, 0, 'landing recovery was not applied');
  });

  test('14 · a lethal fall kills, and a safe fall does not damage', () => {
    const safe = makePlayer();
    safe.setPosition(0, MOVE.FALL_DAMAGE_SAFE_HEIGHT * 0.5, 0);
    safe.grounded = false;
    driveUntil(safe, 4.0, (p) => p.grounded);
    assert.equal(safe.health, COMBAT.PLAYER_MAX_HEALTH, 'a fall inside the safe height dealt damage');
    assert.equal(safe.telemetry.fallDamageEvents, 0, 'safe fall counted as damage');

    const lethal = makePlayer();
    lethal.setPosition(0, MOVE.FALL_DAMAGE_LETHAL_HEIGHT * 2.5, 0);
    lethal.grounded = false;
    driveUntil(lethal, 12.0, (p) => p.isDead || p.grounded);
    assert.ok(lethal.isDead || lethal.health <= 0,
      `a fall past the lethal height did not kill (health=${lethal.health})`);
  });
});

/* --------------------------------------------------------------- collision */

describe('movement — collision', () => {
  test('15 · the player never ends a frame inside geometry', () => {
    const cw = makeWorld();
    const p = makePlayer({ collision: cw });
    let worst = 0;
    // Circle-strafe straight into the wall at x = 6 from every approach angle.
    for (let angle = 0; angle < 360; angle += 15) {
      p.setPosition(0, 0, 0);
      const rad = angle * Math.PI / 180;
      for (let i = 0; i < 200; i++) {
        const it = emptyIntent();
        it.moveX = Math.cos(rad);
        it.moveZ = Math.sin(rad);
        p.update(DT, it);
        assert.ok(p.pos.isFiniteVec(), `position became non-finite at angle ${angle}`);
        if (cw.isSpaceFree(p.pos, p.capsuleRadius, p.capsuleHeight)) continue;
        worst = Math.max(worst, 1e-4);
      }
    }
    assert.lt(worst, 1e-9,
      'the player ended frames inside geometry — collision is not authoritative');
  });

  test('16 · a wall stops forward motion but allows sliding along it', () => {
    const cw = makeWorld();
    const p = makePlayer({ collision: cw, pos: new Vec3(0, 0, 0) });
    // Drive straight into the wall at x = 6 (moveX = +1 is world +X at camYaw 0).
    drive(p, 3.0, (i) => { i.moveX = 1; });
    const blockedX = p.pos.x;
    assert.lt(blockedX, 6 - MOVE.CAPSULE_RADIUS + 0.05,
      `player penetrated the wall: x=${blockedX.toFixed(3)}, wall face at 5.75`);
    assert.gt(blockedX, 4.0, 'player was stopped far short of the wall');

    // Now push diagonally: the component into the wall must be cancelled while
    // the parallel component carries the player along it. At camYaw 0 the input
    // (moveX=1, moveZ=1) resolves to world (+X, -Z), so the slide is toward -Z
    // and the signed displacement is NEGATIVE. Asserting a positive slide here
    // would fail against a controller that slides perfectly.
    const zBefore = p.pos.z;
    drive(p, 1.0, (i) => { i.moveX = 1; i.moveZ = 1; });
    const slid = p.pos.z - zBefore;
    assert.lt(slid, -0.5,
      `player did not slide along the wall (moved ${slid.toFixed(3)} m in Z; the input asks for -Z)`);
    assert.lt(p.pos.x, 6 - MOVE.CAPSULE_RADIUS + 0.05, 'player penetrated the wall while sliding');
    assert.ok(cw.isSpaceFree(p.pos, p.capsuleRadius, p.capsuleHeight),
      'player ended the slide inside the wall');
  });

  test('17 · step-up succeeds at STEP_HEIGHT and is refused just above it', () => {
    const cw = makeWorld();
    // The exact-height step spans x[-7.5,-4.5]; approach from +x and drive far
    // enough to CROSS it. The player therefore finishes the drive past the step
    // and back on the ground, so the final y alone proves nothing — it is 0
    // both for a player who climbed over and for one who walked straight
    // through. Assert instead on the highest point reached, on actually standing
    // on the tread, and on never being inside the solid volume.
    const ok = makePlayer({ collision: cw, pos: new Vec3(-4.0, 0, 0) });
    let maxY = 0;
    let onTread = false;
    let insideFrames = 0;
    const frames = Math.round(2.0 / DT);
    for (let i = 0; i < frames; i++) {
      const it = emptyIntent();
      it.moveX = -1;
      ok.update(DT, it);
      maxY = Math.max(maxY, ok.pos.y);
      if (ok.pos.x > -7.5 && ok.pos.x < -4.5) {
        if (ok.pos.y >= MOVE.STEP_HEIGHT - 0.05) onTread = true;
        else insideFrames++;
      }
      assert.ok(cw.isSpaceFree(ok.pos, ok.capsuleRadius, ok.capsuleHeight),
        `player ended a frame inside the step at (${ok.pos.x.toFixed(2)},${ok.pos.y.toFixed(2)})`);
    }
    assert.close(maxY, MOVE.STEP_HEIGHT, 0.06,
      `player never stood on a ${MOVE.STEP_HEIGHT} m step (max y=${maxY.toFixed(3)})`);
    assert.ok(onTread, 'player was never on top of the step it should have walked up');
    assert.equal(insideFrames, 0,
      `${insideFrames} frames inside the solid step volume — the step-up tunneled`);
    assert.lt(ok.pos.x, -7.5, 'player was stopped by a step it should have walked up and crossed');

    // The too-tall step is at (-6, 8).
    const blocked = makePlayer({ collision: cw, pos: new Vec3(-4.0, 0, 8) });
    drive(blocked, 2.0, (i) => { i.moveX = -1; });
    assert.close(blocked.pos.y, 0, 0.06,
      `player climbed a ${(MOVE.STEP_HEIGHT + 0.3).toFixed(2)} m step that exceeds STEP_HEIGHT (y=${blocked.pos.y.toFixed(3)})`);
    assert.gt(blocked.pos.x, -5.0, 'player walked through an oversized step');
  });

  test('18 · the player cannot leave the world bounds', () => {
    const cw = makeWorld();
    const p = makePlayer({ collision: cw });
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]]) {
      p.setPosition(0, 0, 0);
      drive(p, 12.0, (i) => { i.moveX = dx; i.moveZ = dz; i.sprint = true; });
      assert.ok(p.pos.isFiniteVec(), 'position became non-finite driving out of bounds');
      assert.lte(Math.abs(p.pos.x), 40, `escaped bounds on X: ${p.pos.x}`);
      assert.lte(Math.abs(p.pos.z), 40, `escaped bounds on Z: ${p.pos.z}`);
    }
  });

  test('19 · a corrupted position recovers instead of falling through the world', () => {
    const p = makePlayer();
    drive(p, 0.5, (i) => { i.moveZ = 1; });
    p.pos.set(NaN, NaN, NaN);
    p.verticalVelocity = NaN;
    p.update(DT, emptyIntent());
    assert.ok(p.pos.isFiniteVec(), 'NaN position was not recovered');
    assert.finite(p.verticalVelocity, 'NaN vertical velocity was not recovered');
    assert.equal(p.telemetry.nanEvents, 1, 'the NaN guard did not record the event');
    // And it must keep working afterwards, not just once.
    drive(p, 0.5, (i) => { i.moveZ = 1; });
    assert.ok(p.pos.isFiniteVec(), 'player did not recover control after the NaN guard fired');
    assert.equal(p.telemetry.nanEvents, 1, 'NaN guard fired repeatedly after recovery');
  });

  test('20 · an absurd dt is clamped — a tab-switch must not teleport the player', () => {
    const p = makePlayer();
    drive(p, 1.0, (i) => { i.moveZ = 1; i.sprint = true; });
    const before = p.pos.clone();
    p.update(30.0, (() => { const it = emptyIntent(); it.moveZ = 1; return it; })());
    const moved = Math.hypot(p.pos.x - before.x, p.pos.z - before.z);
    // The controller clamps dt to 0.1 s, so 30 s of input moves at most that far.
    assert.lt(moved, MOVE.SPRINT_SPEED * 0.1 + 0.5,
      `a 30 s dt moved the player ${moved.toFixed(2)} m — dt is not clamped`);
    assert.ok(p.pos.isFiniteVec(), 'position became non-finite on a huge dt');
  });
});

/* --------------------------------------------------------- stamina and dodge */

describe('movement — stamina and dodge', () => {
  test('21 · sprinting drains stamina and exhaustion stops the sprint', () => {
    // Flat world: makeWorld()'s ledge block is 13 m away, which a sprint reaches
    // in about two seconds. Pressed against it the player's planar speed is
    // zero, and the drain condition (speed above WALK_SPEED * 0.6) never fires —
    // so the rig reports "sprinting drains no stamina" against a correct system.
    const p = makePlayer({ collision: makeFlatWorld() });
    assert.close(p.stamina, MOVE.STAMINA_MAX, 1e-6, 'stamina does not start full');
    drive(p, 6.0, (i) => { i.moveZ = 1; i.sprint = true; });
    assert.lt(p.stamina, MOVE.STAMINA_MAX, 'sprinting drained no stamina');

    // Exhaustion must be OBSERVED, not sampled at a fixed time. It recovers by
    // design: stamina regens to STAMINA_RECOVER_THRESHOLD, the lockout clears and
    // the player sprints again, so sustained sprinting OSCILLATES with a period of
    // roughly seven seconds. A long fixed drive therefore samples that oscillation
    // at an arbitrary phase and fails about half the time against a correct
    // system. Track the whole run instead, and measure the speed cap only once
    // exhaustion has held long enough for the sprint speed to bleed off.
    let sawExhausted = false;
    let lowestStamina = MOVE.STAMINA_MAX;
    let exhaustedFrames = 0;
    let exhaustedFor = 0;
    let maxSpeedExhausted = 0;
    const frames = Math.round(30.0 / DT);
    for (let i = 0; i < frames; i++) {
      const it = emptyIntent();
      it.moveZ = 1; it.sprint = true;
      p.update(DT, it);
      lowestStamina = Math.min(lowestStamina, p.stamina);
      if (p.exhausted) {
        sawExhausted = true;
        exhaustedFrames++;
        exhaustedFor += DT;
        if (exhaustedFor > 0.6) maxSpeedExhausted = Math.max(maxSpeedExhausted, planarSpeed(p));
      } else {
        exhaustedFor = 0;
      }
    }
    assert.ok(sawExhausted, 'player never became exhausted while sprinting');
    assert.gt(exhaustedFrames, 30,
      `exhaustion only held for ${exhaustedFrames} frames — it flickered instead of locking out`);
    assert.lte(lowestStamina, MOVE.STAMINA_EXHAUSTED_THRESHOLD + 1e-6,
      `exhaustion fired above its threshold (${lowestStamina} > ${MOVE.STAMINA_EXHAUSTED_THRESHOLD})`);
    assert.lte(maxSpeedExhausted, MOVE.RUN_SPEED + 0.05,
      `an exhausted player kept sprinting (${maxSpeedExhausted.toFixed(2)} m/s, cap is ${MOVE.RUN_SPEED})`);
  });

  test('22 · stamina recovers, but only past the recovery threshold', () => {
    const p = makePlayer({ collision: makeFlatWorld() });
    drive(p, 40.0, (i) => { i.moveZ = 1; i.sprint = true; });
    assert.ok(p.exhausted, 'test rig failed to exhaust the player');
    const atExhaustion = p.stamina;

    // Idle: stamina must regen after the delay.
    drive(p, 20.0);
    assert.gt(p.stamina, atExhaustion, 'stamina did not regenerate while idle');

    // The recovery threshold must exceed the exhaustion threshold, or stamina
    // oscillates on a single point and the sprint lockout flickers.
    assert.gt(MOVE.STAMINA_RECOVER_THRESHOLD, MOVE.STAMINA_EXHAUSTED_THRESHOLD,
      'recovery threshold must exceed the exhaustion threshold or stamina oscillates');

    // The gate itself, measured over ONE frame. Driving for seconds here lets
    // regen move the stamina value out from under the assertion: 1.5 s of regen
    // is worth about 10 stamina, which lifts a value parked one point below the
    // recovery threshold clear over it, so both halves of the test end up
    // measuring the regen rate instead of the gate they claim to test.
    const step = (pl) => {
      const it = emptyIntent();
      it.moveZ = 1; it.sprint = true;
      pl.update(DT, it);
    };

    const below = makePlayer({ collision: makeFlatWorld() });
    below.exhausted = true;
    below.stamina = MOVE.STAMINA_RECOVER_THRESHOLD - 1;
    step(below);
    assert.ok(below.exhausted, 'exhaustion cleared below the recovery threshold');
    assert.notOk(below.sprinting, 'the player sprinted while exhausted');

    const above = makePlayer({ collision: makeFlatWorld() });
    above.exhausted = true;
    above.sinceSprint = MOVE.STAMINA_REGEN_DELAY + 0.1;   // regen delay elapsed
    above.stamina = MOVE.STAMINA_RECOVER_THRESHOLD + 1;
    step(above);
    assert.notOk(above.exhausted, 'exhaustion did not clear at the recovery threshold');
  });

  test('23 · a dodge costs stamina, has i-frames only inside its window, and cools down', () => {
    const p = makePlayer();
    const before = p.stamina;
    const it = emptyIntent();
    it.moveZ = 1; it.dodge = true;
    p.update(DT, it);
    assert.equal(p.state, PlayerState.DODGE, 'dodge request did not enter the dodge state');
    assert.lt(p.stamina, before, 'dodge cost no stamina');
    assert.close(before - p.stamina, MOVE.DODGE_STAMINA_COST, 1e-6, 'dodge stamina cost does not match the constant');
    assert.equal(p.telemetry.dodges, 1, 'dodge was not counted');

    // i-frames must be active inside the window and gone after it.
    const sawIframes = [];
    for (let i = 0; i < Math.ceil((MOVE.DODGE_DURATION + 0.2) / DT); i++) {
      p.update(DT, emptyIntent());
      sawIframes.push(p.iframes > 0);
    }
    assert.ok(sawIframes.some(Boolean), 'dodge granted no i-frames at all');
    assert.notOk(sawIframes[sawIframes.length - 1],
      'i-frames outlived the dodge — the player would be permanently invulnerable');

    // Cooldown: an immediate second dodge must be refused.
    const p2 = makePlayer();
    const d1 = emptyIntent(); d1.dodge = true;
    p2.update(DT, d1);
    assert.equal(p2.state, PlayerState.DODGE, 'first dodge did not start');
    driveUntil(p2, 2.0, (pl) => pl.state !== PlayerState.DODGE);
    const d2 = emptyIntent(); d2.dodge = true;
    p2.update(DT, d2);
    assert.notEqual(p2.state, PlayerState.DODGE,
      'a second dodge started inside the cooldown window');
    assert.gt(p2.dodgeCooldown, 0, 'dodge cooldown was not running');

    // After the cooldown it must work again, or the ability is one-use.
    driveUntil(p2, MOVE.DODGE_COOLDOWN + 0.5, () => p2.dodgeCooldown <= 0);
    const d3 = emptyIntent(); d3.dodge = true;
    p2.update(DT, d3);
    assert.equal(p2.state, PlayerState.DODGE, 'dodge never became available again after its cooldown');
  });

  test('24 · a dodge is directional and covers ground', () => {
    // At camYaw 0 the input moveZ = +1 drives the player toward world -Z, so a
    // "forward" dodge displaces NEGATIVELY in z. Measuring `pos.z - zBefore` and
    // demanding it be positive fails against a dodge that works perfectly.
    const forward = makePlayer({ collision: makeFlatWorld() });
    drive(forward, 0.5, (i) => { i.moveZ = 1; });
    const zBefore = forward.pos.z;
    const it = emptyIntent(); it.moveZ = 1; it.dodge = true;
    forward.update(DT, it);
    driveUntil(forward, 1.5, (p) => p.state !== PlayerState.DODGE);
    const forwardDistance = zBefore - forward.pos.z;
    assert.gt(forwardDistance, 0.4,
      `a forward dodge covered only ${forwardDistance.toFixed(2)} m`);

    // moveX = +1 is world +X, so the sideways dodge displaces positively.
    const sideways = makePlayer({ collision: makeFlatWorld() });
    const xBefore = sideways.pos.x;
    const it2 = emptyIntent(); it2.moveX = 1; it2.dodge = true;
    sideways.update(DT, it2);
    driveUntil(sideways, 1.5, (p) => p.state !== PlayerState.DODGE);
    assert.gt(sideways.pos.x - xBefore, 0.3,
      'a sideways dodge did not move sideways — dodges are not directional');
  });

  test('25 · a dodge cannot be started with no stamina', () => {
    const p = makePlayer();
    p.stamina = 0;
    const it = emptyIntent(); it.dodge = true;
    p.update(DT, it);
    assert.notEqual(p.state, PlayerState.DODGE, 'dodged with zero stamina — the cost is not enforced');
  });
});

/* ----------------------------------------------------------------- health */

describe('movement — health and injury', () => {
  test('26 · damage, healing and death respect the health bounds', () => {
    const p = makePlayer();
    assert.equal(p.health, COMBAT.PLAYER_MAX_HEALTH, 'player does not start at full health');
    p.damage(30, 'test');
    assert.equal(p.health, COMBAT.PLAYER_MAX_HEALTH - 30, 'damage was not applied exactly');
    assert.ok(p.alive, 'player died from non-lethal damage');

    p.heal(10);
    assert.equal(p.health, COMBAT.PLAYER_MAX_HEALTH - 20, 'healing was not applied exactly');
    p.heal(1000);
    assert.equal(p.health, p.maxHealth, 'healing exceeded max health');

    // damage() honours COMBAT.IFRAME_AFTER_DAMAGE, so the non-lethal hit above
    // still has this one gated and it would silently apply nothing. Clear the
    // window explicitly: the point of this assertion is the health CLAMP, not the
    // i-frame economy, which test 23 covers.
    p.hitIframes = 0;
    p.damage(100000, 'test');
    assert.ok(p.isDead, 'lethal damage did not kill the player');
    assert.gte(p.health, 0,
      `health went negative (${p.health}) — it must be clamped at zero`);
    assert.close(p.health, 0, 1e-9, 'lethal damage did not bring health to exactly zero');

    // A dead player must not keep simulating locomotion.
    const posAtDeath = p.pos.clone();
    drive(p, 1.0, (i) => { i.moveZ = 1; i.sprint = true; });
    const moved = Math.hypot(p.pos.x - posAtDeath.x, p.pos.z - posAtDeath.z);
    assert.lt(moved, 0.5, `a dead player moved ${moved.toFixed(2)} m under locomotion input`);
  });

  test('27 · health regenerates only after the regen delay', () => {
    const p = makePlayer();
    p.damage(40, 'test');
    const after = p.health;
    assert.gt(p.regenDelay, 0, 'taking damage did not start the regen delay');
    // Regen must not begin immediately, or combat attrition is meaningless.
    drive(p, COMBAT.REGEN_DELAY * 0.5);
    assert.close(p.health, after, 1e-6, 'health regenerated during the regen delay');
    drive(p, COMBAT.REGEN_DELAY * 2 + 3.0);
    assert.gt(p.health, after, 'health never regenerated after the delay');
    assert.lte(p.health, p.maxHealth, 'regen overshot max health');
  });

  test('28 · injured mode (Chapter 5+) reduces every speed band', () => {
    assert.notOk(makePlayer().injured, 'a fresh player should not be injured');
    assert.ok(makePlayer({ injured: true }).injured, 'injured flag not set');

    // The injury has to cost something in EVERY band, not just sprint, or it
    // reads as a sprint debuff rather than a wounded body. Each band is measured
    // at the deflection that actually produces it: walk at RUN_THRESHOLD, run and
    // sprint at full deflection, crouch at full deflection while crouched.
    const bands = [
      ['walk', { moveZ: MOVE.RUN_THRESHOLD }, MOVE.WALK_SPEED, MOVE.INJURED_WALK_SPEED],
      ['run', { moveZ: 1 }, MOVE.RUN_SPEED, MOVE.INJURED_RUN_SPEED],
      ['sprint', { moveZ: 1, sprint: true }, MOVE.SPRINT_SPEED, MOVE.INJURED_SPRINT_SPEED],
      ['crouch', { moveZ: 1, crouchHeld: true }, MOVE.CROUCH_SPEED, MOVE.INJURED_CROUCH_SPEED],
    ];
    for (const [name, input, healthyTarget, injuredTarget] of bands) {
      const healthy = makePlayer({ collision: makeFlatWorld() });
      const injured = makePlayer({ collision: makeFlatWorld(), injured: true });
      // crouchHeld is only read in 'hold' mode; the default is 'toggle', where it
      // is ignored and only a rising edge on `crouch` flips the stance. Driving
      // crouchHeld at a default-mode player leaves them standing and measuring the
      // RUN band, which is how a crouch assertion silently tests the wrong thing.
      // (Test 07 covers the toggle path.)
      const ctx = { crouchMode: 'hold' };
      drive(healthy, 3.0, (i) => Object.assign(i, input), ctx);
      drive(injured, 3.0, (i) => Object.assign(i, input), ctx);
      assert.close(planarSpeed(healthy), healthyTarget, healthyTarget * 0.04,
        `healthy ${name} did not converge to ${healthyTarget} (got ${planarSpeed(healthy).toFixed(3)})`);
      assert.close(planarSpeed(injured), injuredTarget, injuredTarget * 0.06,
        `injured ${name} did not converge to ${injuredTarget} (got ${planarSpeed(injured).toFixed(3)})`);
      assert.lt(planarSpeed(injured), planarSpeed(healthy),
        `injured ${name} (${planarSpeed(injured).toFixed(2)}) is not slower than healthy (${planarSpeed(healthy).toFixed(2)})`);
    }

    // The injury must be switchable at runtime — it is applied on Chapter 5.
    const p = makePlayer({ collision: makeFlatWorld() });
    p.setInjured(true);
    assert.ok(p.injured, 'setInjured(true) did not apply');
    p.stamina = MOVE.STAMINA_MAX;
    drive(p, 3.0, (i) => { i.moveZ = 1; i.sprint = true; });
    assert.close(planarSpeed(p), MOVE.INJURED_SPRINT_SPEED, MOVE.INJURED_SPRINT_SPEED * 0.12,
      'setInjured did not change the speed band');
    p.setInjured(false);
    assert.notOk(p.injured, 'setInjured(false) did not clear');
    p.stamina = MOVE.STAMINA_MAX;
    drive(p, 3.0, (i) => { i.moveZ = 1; i.sprint = true; });
    assert.close(planarSpeed(p), MOVE.SPRINT_SPEED, MOVE.SPRINT_SPEED * 0.06,
      'clearing the injury did not restore the healthy band');
  });
});

/* --------------------------------------------------- determinism and savings */

describe('movement — determinism, serialization and telemetry', () => {
  const script = [
    { moveZ: 1, dur: 0.7 }, { moveX: 1, dur: 0.4 }, { jump: true, jumpHeld: true, dur: 0.1 },
    { dur: 0.8 }, { moveZ: 1, sprint: true, dur: 1.2 }, { crouch: true, dur: 0.1 },
    { crouchHeld: true, moveZ: -1, dur: 0.9 }, { dodge: true, moveZ: 1, dur: 0.1 },
    { dur: 1.0 }, { moveX: -1, moveZ: 1, sprint: true, dur: 1.5 },
  ];

  function runScript(seedOffset = 0) {
    const p = makePlayer({ pos: new Vec3(0, 0, seedOffset) });
    for (const step of script) {
      const frames = Math.max(1, Math.round((step.dur ?? DT) / DT));
      for (let i = 0; i < frames; i++) {
        const it = emptyIntent();
        for (const k of ['moveX', 'moveZ', 'sprint', 'crouch', 'crouchHeld', 'jump', 'jumpHeld', 'dodge']) {
          if (step[k] !== undefined) it[k] = i === 0 ? step[k] : (k.endsWith('Held') || k === 'sprint' || k === 'crouchHeld' ? step[k] : false);
        }
        p.update(DT, it);
      }
    }
    return p;
  }

  test('29 · identical input produces an identical trajectory', () => {
    const a = runScript(0);
    const b = runScript(0);
    assert.close(a.pos.x, b.pos.x, 1e-9, 'X diverged between identical runs');
    assert.close(a.pos.y, b.pos.y, 1e-9, 'Y diverged between identical runs');
    assert.close(a.pos.z, b.pos.z, 1e-9, 'Z diverged between identical runs');
    assert.close(a.health, b.health, 1e-9, 'health diverged');
    assert.close(a.stamina, b.stamina, 1e-9, 'stamina diverged');
    assert.equal(a.state, b.state, 'state diverged');
    assert.deepEqual(a.telemetry, b.telemetry, 'telemetry diverged between identical runs');
  });

  test('30 · a different starting position produces a different trajectory', () => {
    // Guards against a rig that accidentally asserts nothing.
    const a = runScript(0);
    const c = runScript(20);
    assert.ok(Math.abs(a.pos.z - c.pos.z) > 1 || Math.abs(a.pos.x - c.pos.x) > 1,
      'the rig produced identical results from different starts — the test proves nothing');
  });

  test('31 · movement is frame-rate independent within tolerance', () => {
    // A game that plays differently at 30 fps and 144 fps is not shippable on
    // the mid-range mobile hardware this title targets.
    const runAt = (dt, seconds) => {
      const p = makePlayer({ collision: makeFlatWorld() });
      const frames = Math.round(seconds / dt);
      for (let i = 0; i < frames; i++) {
        const it = emptyIntent();
        it.moveZ = 1; it.sprint = true;
        p.update(dt, it);
      }
      return p;
    };
    const a = runAt(1 / 60, 2.0);
    const b = runAt(1 / 30, 2.0);
    const c = runAt(1 / 120, 2.0);
    const dist = (p) => Math.hypot(p.pos.x, p.pos.z);
    assert.close(dist(b), dist(a), dist(a) * 0.06,
      `30 fps travelled ${dist(b).toFixed(3)} m vs 60 fps ${dist(a).toFixed(3)} m`);
    assert.close(dist(c), dist(a), dist(a) * 0.03,
      `120 fps travelled ${dist(c).toFixed(3)} m vs 60 fps ${dist(a).toFixed(3)} m`);
    assert.close(a.stamina, b.stamina, MOVE.STAMINA_MAX * 0.06,
      'stamina drain is frame-rate dependent');
  });

  test('32 · serialize/deserialize round-trips the live state', () => {
    const p = makePlayer();
    drive(p, 1.2, (i) => { i.moveZ = 1; i.sprint = true; });
    p.damage(25, 'test');
    p.setInjured(true);
    const data = p.serialize();
    const json = JSON.parse(JSON.stringify(data));   // must survive a real save file

    const q = PlayerController.deserialize(json, { collision: makeWorld() });
    assert.close(q.pos.x, p.pos.x, 1e-6, 'position X did not round-trip');
    assert.close(q.pos.z, p.pos.z, 1e-6, 'position Z did not round-trip');
    assert.close(q.health, p.health, 1e-6, 'health did not round-trip');
    assert.close(q.stamina, p.stamina, 1e-6, 'stamina did not round-trip');
    assert.equal(q.injured, p.injured, 'injured flag did not round-trip');
    assert.equal(q.stance, p.stance, 'stance did not round-trip');
    assert.close(q.yaw, p.yaw, 1e-6, 'yaw did not round-trip');

    // And the restored player must keep simulating correctly.
    drive(q, 1.0, (i) => { i.moveZ = 1; i.sprint = true; });
    assert.ok(q.pos.isFiniteVec(), 'a restored player produced a non-finite position');
    assert.gt(planarSpeed(q), MOVE.WALK_SPEED, 'a restored player could not move');
  });

  test('33 · deserialize never restores a transient or dead state', () => {
    // §19 P0 prevention: restoring into DEAD or a ledge state soft-locks the
    // player on load, with no input able to recover.
    for (const bad of [PlayerState.DEAD, PlayerState.LEDGE_HANG, PlayerState.LEDGE_CLIMB]) {
      const q = PlayerController.deserialize({ state: bad, pos: [1, 0, 1] }, { collision: makeWorld() });
      assert.notEqual(q.state, bad, `deserialize restored the transient state ${bad}`);
      assert.ok(q.alive, `deserialize left the player dead after restoring ${bad}`);
      drive(q, 0.5, (i) => { i.moveZ = 1; });
      assert.ok(q.pos.isFiniteVec(), `a player restored from ${bad} could not simulate`);
    }
  });

  test('34 · deserialize survives corrupt and hostile save data', () => {
    const hostile = [
      null, undefined, {}, { pos: 'nope' }, { pos: [NaN, NaN, NaN] },
      { pos: [1e12, -1e12, 1e12] }, { health: -9999 }, { health: 1e9 },
      { stamina: NaN }, { yaw: Infinity }, { stance: 42 }, { state: 'not-a-state' },
      { crouchBlend: 99 }, { cameraPitch: 1e6 },
    ];
    for (const data of hostile) {
      let q;
      assert.doesNotThrow(() => { q = PlayerController.deserialize(data, { collision: makeWorld() }); },
        `deserialize threw on ${JSON.stringify(data)}`);
      assert.ok(q.pos.isFiniteVec(), `deserialize produced a non-finite position from ${JSON.stringify(data)}`);
      assert.finite(q.health, `deserialize produced non-finite health from ${JSON.stringify(data)}`);
      assert.finite(q.stamina, `deserialize produced non-finite stamina from ${JSON.stringify(data)}`);
      assert.finite(q.yaw, `deserialize produced a non-finite yaw from ${JSON.stringify(data)}`);
      assert.gte(q.health, 0, 'negative health survived deserialize');
      assert.lte(q.health, q.maxHealth, 'health above max survived deserialize');
      assert.gte(q.stamina, 0, 'negative stamina survived deserialize');
      assert.lte(q.stamina, MOVE.STAMINA_MAX, 'stamina above max survived deserialize');
      // A corrupt save must not leave the player dead on load.
      drive(q, 0.4, (i) => { i.moveZ = 1; });
      assert.ok(q.pos.isFiniteVec(), 'player could not simulate after a corrupt restore');
    }
  });

  test('35 · telemetry reports no sliding, no input lag and no NaN events', () => {
    const p = makePlayer({ collision: makeFlatWorld() });
    drive(p, 2.0, (i) => { i.moveZ = 1; i.sprint = true; });
    drive(p, 1.5);
    drive(p, 1.5, (i) => { i.moveX = 1; });
    drive(p, 1.0, (i) => { i.crouch = true; i.moveZ = 1; });
    assert.equal(p.telemetry.nanEvents, 0, 'NaN events during normal play');
    assert.equal(p.telemetry.slidingFrames, 0,
      `${p.telemetry.slidingFrames} frames where speed decayed too slowly after releasing input`);
    assert.gt(p.telemetry.distance, 1, 'telemetry did not accumulate distance');
    assert.gt(p.telemetry.topSpeed, MOVE.WALK_SPEED, 'telemetry did not record top speed');
    assert.equal(p.telemetry.frames, Math.round((2.0 + 1.5 + 1.5 + 1.0) / DT),
      'telemetry frame count does not match the frames driven');
  });

  test('36 · a scripted/cinematic override takes control and releases it', () => {
    const p = makePlayer();
    let calls = 0;
    p.setScripted((dt, pl) => { calls++; pl.pos.x += 0.01; });
    drive(p, 0.5, (i) => { i.moveZ = 1; i.sprint = true; });
    assert.gt(calls, 10, 'the scripted controller was not called every frame');
    assert.gt(p.pos.x, 0.1, 'the scripted controller did not move the player');
    assert.close(p.pos.z, 0, 1e-6, 'locomotion input ran while the player was scripted');

    p.setScripted(null);
    const zAtRelease = p.pos.z;
    drive(p, 0.5, (i) => { i.moveZ = 1; });
    // moveZ = +1 drives toward world -Z at camYaw 0, so the displacement is
    // negative; asserting pos.z > 0.1 would fail against a correct hand-back.
    assert.lt(p.pos.z - zAtRelease, -0.1,
      `control was not returned to the player after the cinematic (moved ${(p.pos.z - zAtRelease).toFixed(3)} m in Z)`);
  });

  test('37 · a full simulated minute stays inside the §24 frame budget', () => {
    const p = makePlayer({ collision: makeFlatWorld() });
    // measure() returns a SCALAR mean ms per call, not a {meanMs, maxMs} record,
    // so the distribution is collected here. It is collected deliberately rather
    // than asserting on the absolute maximum, because the max does not answer the
    // budget question. Measured over 3600 updates, the worst samples land on
    // DIFFERENT, NON-REPEATING indices every run: 8.4 ms at i=2890 and 8.3 ms at
    // i=3109 on one run, 5.1/1.0/2.1 ms at i=986/1106/2881 on the next, and no
    // outlier above 1 ms at all on a third. A genuine algorithmic spike recurs at
    // a fixed cadence; sparse, moving, sometimes-absent outliers of that size are
    // V8 garbage-collection pauses, which no player-controller work removes. So
    // the tight bounds go on the mean and on p99.9 (which is what actually catches
    // a per-frame cost regression), and the max keeps a generous ceiling that
    // still fails if a pause ever becomes catastrophic.
    const samples = [];
    const meanMs = measure(() => {
      const it = emptyIntent();
      it.moveZ = 1; it.sprint = true;
      const t0 = process.hrtime.bigint();
      p.update(DT, it);
      samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }, 3600, 120);
    samples.sort((a, b) => a - b);
    const pct = (f) => samples[Math.min(samples.length - 1, Math.floor(f * samples.length))];
    const worstMs = samples[samples.length - 1];

    // One player update must be a small fraction of the frame budget; the rest
    // belongs to AI, rendering and UI.
    assert.lt(meanMs, PERF.FRAME_BUDGET_MS * 0.05,
      `mean player update ${meanMs.toFixed(4)} ms exceeds 5% of the ${PERF.FRAME_BUDGET_MS} ms frame budget`);
    assert.lt(pct(0.999), PERF.FRAME_BUDGET_MS * 0.25,
      `p99.9 player update ${pct(0.999).toFixed(4)} ms exceeds a quarter of the frame budget`);
    assert.lt(worstMs, PERF.FRAME_BUDGET_MS * 3,
      `worst player update ${worstMs.toFixed(4)} ms is catastrophic — a hidden rebuild, not a GC pause`);
    assert.ok(p.pos.isFiniteVec(), 'player went non-finite during the sustained run');
  });

  test('38 · movement works against the real generated world, not just the rig', () => {
    // The synthetic rig proves mechanisms; this proves they hold on shipped
    // geometry, where furniture, doorways and terrain undulation interact.
    assert.equal(sharedWorld.regionSpaces.size, 20, 'shared world did not build every region');
    const regions = ['palace-court', 'market', 'poor-quarter', 'feast-hall', 'cellar-stair'];
    for (const id of regions) {
      const space = sharedWorld.region(id);
      const spawn = space.spawnPoints[0];
      const p = makePlayer({
        collision: space.collision,
        pos: new Vec3(spawn.x, spawn.y ?? space.elevation, spawn.z),
      });
      assert.ok(p.pos.isFiniteVec(), `${id}: spawn position is not finite`);
      for (let angle = 0; angle < 360; angle += 45) {
        p.setPosition(spawn.x, spawn.y ?? space.elevation, spawn.z);
        const rad = angle * Math.PI / 180;
        for (let i = 0; i < 90; i++) {
          const it = emptyIntent();
          it.moveX = Math.cos(rad); it.moveZ = Math.sin(rad);
          if (i === 30) it.jump = true;
          p.update(DT, it);
          assert.ok(p.pos.isFiniteVec(), `${id}: position went non-finite at ${angle} deg`);
          assert.ok(space.collision.isSpaceFree(p.pos, p.capsuleRadius, p.capsuleHeight),
            `${id}: player ended a frame inside geometry at ${angle} deg (${p.pos.x.toFixed(2)},${p.pos.y.toFixed(2)},${p.pos.z.toFixed(2)})`);
        }
      }
      assert.equal(p.telemetry.nanEvents, 0, `${id}: NaN events while moving through the region`);
    }
  });
});

runAndExit();
