/**
 * THE BETRAYED WILL — camera-test.mjs
 *
 * The third-person camera suite. A camera bug is the single most reported class
 * of defect in a third-person game, and almost all of it reduces to one
 * property: the camera must never be inside geometry. §10 states that as a hard
 * gate (CAM.MAX_PENETRATION_TOLERANCE is exactly 0.0, not "small"), so this
 * suite treats it as an invariant to be proven on adversarial geometry rather
 * than a number to be eyeballed.
 *
 * What is asserted, and why it matters:
 *   - worst penetration is EXACTLY 0 m, on walls, corners, ceilings, thin
 *     geometry and a full 360° orbit in every generated region
 *   - retraction is INSTANT (a clipped camera for even one frame is visible)
 *     while recovery is GRADUAL (a snap-back is worse than the clip)
 *   - every framing distance and FOV converges to its declared constant, so a
 *     tuning change cannot silently diverge from the game
 *   - pitch, distance and shake stay inside their declared bounds
 *   - auto-centre never interrupts a player who is standing still and looking
 *   - accessibility: reducedMotion really does suppress shake
 *   - the solver is deterministic, frame-rate independent, and survives hostile
 *     save data and a missing collision world
 *
 * Run: node tests/camera-test.mjs
 */

import { describe, test, assert, runAndExit, measure } from './harness.mjs';
import { Vec3 } from '../src/core/math.js';
import { CAM, MOVE, PERF } from '../src/core/constants.js';
import { CollisionWorld, boxCollider, wallCollider } from '../src/sim/collision.js';
import { PlayerController, Stance, emptyIntent } from '../src/sim/player.js';
import {
  ThirdPersonCamera, CameraMode, twoShot, orbitShot, subjectScreenFraction,
} from '../src/sim/camera.js';
import { World } from '../src/sim/world.js';

// Built once and shared: the final test orbits the camera in real generated
// geometry across every region, and rebuilding 20 regions per test would
// dominate the runtime.
const sharedWorld = new World();
sharedWorld.buildAll();

const DT = 1 / 60;
const DEG = Math.PI / 180;

/* ------------------------------------------------------------------- rigs */

/**
 * A wall spanning x[-12,12] at a given z, thick and tall enough that no camera
 * angle can slip over or around it. `thickness` matters: thin geometry is the
 * classic tunneling case for a single-ray solver.
 */
const wallAt = (z, opts = {}) => (cw) => {
  cw.add(wallCollider(-12, z, 12, z, 0, opts.height ?? 3.4, opts.thickness ?? 0.4,
    { kind: 'wall', blocksCamera: true, blocksMovement: true, material: 'mudBrick' }));
};

/** A collision world from a list of builder callbacks. */
function makeWorld(build = []) {
  const cw = new CollisionWorld(4);
  cw.setBounds(new Vec3(-60, -30, -60), new Vec3(60, 40, 60));
  cw.groundHeight = 0;
  cw.heightFn = null;
  for (const b of build) b(cw);
  return cw;
}

/** Flat, empty ground: framing tests must measure the solver, not geometry. */
const flatWorld = () => makeWorld();

function makePlayer(world, pos = new Vec3(0, 0, 0)) {
  return new PlayerController({ collision: world, pos: pos.clone() });
}

function makeCam(world, opts = {}) {
  return new ThirdPersonCamera({ collision: world, ...opts });
}

/** Run the camera for `frames`, returning the last state. */
function settle(cam, player, frames = 120, ctx = {}) {
  let st = null;
  for (let i = 0; i < frames; i++) st = cam.update(DT, player, ctx);
  return st ?? cam.state();
}

/** Drive the player into a crouch through the real input path. */
function crouch(p, frames = 30) {
  for (let i = 0; i < frames; i++) {
    const it = emptyIntent();
    it.crouchHeld = true;
    p.update(DT, it, { crouchMode: 'hold' });
  }
  return p;
}

/** Drive the player to a real sprint on open ground. */
function sprint(p, seconds = 2.0) {
  const frames = Math.round(seconds / DT);
  for (let i = 0; i < frames; i++) {
    const it = emptyIntent();
    it.moveZ = 1; it.sprint = true;
    p.update(DT, it);
  }
  return p;
}

/** Dense penetration measurement at a position — the strictest probe set. */
const penAt = (cam, pos) => cam.measurePenetration(pos, CAM.COLLISION_RADIUS, { dense: true });

/** Assert the camera is provably outside every solid, with a useful message. */
function assertNoPenetration(cam, st, label) {
  const pen = penAt(cam, st.position);
  assert.close(pen, 0, CAM.MAX_PENETRATION_TOLERANCE + 1e-9,
    `${label}: camera penetrated geometry by ${pen.toFixed(4)} m at `
    + `(${st.position.x.toFixed(2)},${st.position.y.toFixed(2)},${st.position.z.toFixed(2)})`);
  assert.ok(st.position.isFiniteVec(), `${label}: camera position is not finite`);
}

/* --------------------------------------------------------------- framing */

describe('camera — framing and declared constants', () => {
  test('01 · an unobstructed camera sits at the declared distance behind the player', () => {
    const w = flatWorld();
    const p = makePlayer(w);
    const cam = makeCam(w);
    const st = settle(cam, p);
    assert.close(cam.distance, CAM.DISTANCE, 1e-3,
      `open-ground distance did not converge to DISTANCE ${CAM.DISTANCE}`);
    assert.close(cam.desiredDistance, CAM.DISTANCE, 1e-6, 'desired distance is not the gameplay constant');
    // The camera must be BEHIND the player along the view axis, not beside them.
    const toCam = Vec3.sub(st.position, st.focus);
    assert.close(toCam.length, CAM.DISTANCE, 0.35,
      'camera-to-focus distance does not match the solved distance');
    assertNoPenetration(cam, st, 'open ground');
  });

  test('02 · the focus sits at the declared height above the feet', () => {
    const w = flatWorld();
    const p = makePlayer(w);
    const cam = makeCam(w);
    const st = settle(cam, p, 60);
    // A stationary player has no velocity, so LOOK_TARGET_LEAD contributes
    // nothing and the focus height is exactly the constant.
    assert.close(st.focus.y, p.pos.y + CAM.HEIGHT_OFFSET, 1e-6,
      'focus height is not feet + HEIGHT_OFFSET');

    const c = crouch(makePlayer(w));
    assert.equal(c.stance, Stance.CROUCH, 'rig failed to crouch the player');
    const cam2 = makeCam(w);
    const st2 = settle(cam2, c, 60);
    assert.close(st2.focus.y, c.pos.y + CAM.HEIGHT_OFFSET_CROUCH, 1e-6,
      'crouched focus height is not feet + HEIGHT_OFFSET_CROUCH');
    assert.lt(st2.focus.y, st.focus.y, 'crouching did not lower the focus');
  });

  test('03 · every mode converges to its declared framing distance', () => {
    const cases = [
      [CameraMode.GAMEPLAY, CAM.DISTANCE],
      [CameraMode.COMBAT, CAM.DISTANCE_COMBAT],
      [CameraMode.LOCKED, CAM.COMBAT_STRAFE_DISTANCE + 0.9],
      [CameraMode.STEALTH, CAM.DISTANCE_STEALTH],
      [CameraMode.INTERIOR, CAM.DISTANCE_INTERIOR],
      [CameraMode.AIM, CAM.DISTANCE * 0.72],
    ];
    for (const [mode, expected] of cases) {
      const w = flatWorld();
      const p = makePlayer(w);
      const cam = makeCam(w);
      settle(cam, p, 180, { mode });
      assert.close(cam.desiredDistance, expected, 1e-6,
        `${mode} desired distance is ${cam.desiredDistance}, declared ${expected}`);
      assert.close(cam.distance, expected, 1e-3,
        `${mode} distance did not converge to ${expected} (got ${cam.distance.toFixed(3)})`);
    }
  });

  test('04 · crouching and interiors pull the camera in, never push it out', () => {
    const w = flatWorld();
    const p = crouch(makePlayer(w));
    const cam = makeCam(w);
    settle(cam, p, 180, { mode: CameraMode.GAMEPLAY });
    assert.close(cam.desiredDistance, CAM.DISTANCE_CROUCH, 1e-6,
      'crouching did not select DISTANCE_CROUCH');

    const standing = makePlayer(w);
    const cam2 = makeCam(w);
    settle(cam2, standing, 180, { mode: CameraMode.GAMEPLAY, region: { indoor: true } });
    assert.close(cam2.desiredDistance, CAM.DISTANCE_INTERIOR + 0.35, 1e-6,
      'an indoor region did not clamp the distance to the interior budget');
    assert.lt(cam2.desiredDistance, CAM.DISTANCE,
      'an interior pushed the camera further out than the open field');
  });

  test('05 · every mode converges to its declared FOV', () => {
    const cases = [
      [CameraMode.GAMEPLAY, CAM.FOV_DEFAULT],
      [CameraMode.COMBAT, CAM.FOV_COMBAT],
      [CameraMode.LOCKED, CAM.FOV_LOCKED],
      [CameraMode.AIM, CAM.FOV_AIM],
    ];
    for (const [mode, expected] of cases) {
      const w = flatWorld();
      const p = makePlayer(w);
      const cam = makeCam(w);
      const st = settle(cam, p, 240, { mode });
      assert.close(st.fov, expected, 0.05,
        `${mode} FOV did not converge to ${expected} (got ${st.fov.toFixed(3)})`);
    }
    assert.lt(CAM.FOV_AIM, CAM.FOV_DEFAULT, 'aiming must narrow the FOV or it is not a zoom');
  });

  test('06 · sprint widens the FOV, but only while actually fast', () => {
    const w = flatWorld();
    const p = sprint(makePlayer(w));
    assert.ok(p.sprinting, 'rig failed to reach a sprint');
    assert.gt(p.speedPlanar, MOVE.RUN_SPEED, 'rig did not exceed run speed');
    const cam = makeCam(w);
    const st = settle(cam, p, 240, { mode: CameraMode.GAMEPLAY });
    assert.close(st.fov, CAM.FOV_SPRINT, 0.05,
      `sprinting did not widen the FOV to FOV_SPRINT ${CAM.FOV_SPRINT} (got ${st.fov.toFixed(2)})`);

    // Walking must NOT get the sprint FOV, or speed feedback means nothing.
    const w2 = flatWorld();
    const walker = makePlayer(w2);
    for (let i = 0; i < 120; i++) {
      const it = emptyIntent(); it.moveZ = MOVE.RUN_THRESHOLD;
      walker.update(DT, it);
    }
    assert.notOk(walker.sprinting, 'walking was reported as sprinting');
    const cam2 = makeCam(w2);
    const st2 = settle(cam2, walker, 240, { mode: CameraMode.GAMEPLAY });
    assert.close(st2.fov, CAM.FOV_DEFAULT, 0.05,
      `walking widened the FOV to ${st2.fov.toFixed(2)} — speed feedback is not tied to speed`);
  });

  test('07 · the shoulder offset biases the pivot and mirrors on swap', () => {
    const w = flatWorld();
    const p = makePlayer(w);
    const right = makeCam(w);
    right.shoulderRight = true;
    const stR = settle(right, p, 180);

    const left = makeCam(w);
    left.shoulderRight = false;
    const stL = settle(left, p, 180);

    // Same player, same orientation: the two shoulders must give two different,
    // mirrored camera positions. If they coincide the over-the-shoulder framing
    // is decorative and cover peeking reads identically on both sides.
    assert.gt(stR.position.distanceXZ(stL.position), CAM.SHOULDER_OFFSET,
      'swapping the shoulder barely moved the camera');
    const midX = (stR.position.x + stL.position.x) / 2;
    const midZ = (stR.position.z + stL.position.z) / 2;
    // At yaw 0 the shoulder axis is world X, so the mirrored pair must be
    // symmetric about the player's own X.
    assert.close(midX, p.pos.x, 0.05, 'the shoulder pair is not mirrored about the player');
    assert.close(midZ, stR.position.z, 0.05, 'the shoulder swap moved the camera along the view axis');
    assert.close(Math.abs(CAM.SHOULDER_OFFSET_FLIP), CAM.SHOULDER_OFFSET, 1e-9,
      'SHOULDER_OFFSET_FLIP is not the mirror of SHOULDER_OFFSET');
    void stL;
  });

  test('08 · pitch is clamped inside its declared range and never sees under the floor', () => {
    const w = flatWorld();
    const p = makePlayer(w);
    const cam = makeCam(w);
    for (const pitch of [-50, 50, -CAM.PITCH_MAX - 1, CAM.PITCH_MAX + 1]) {
      cam.look(0, pitch);
      assert.gte(cam.pitch, CAM.PITCH_MIN - 1e-9, `pitch ${cam.pitch} fell below PITCH_MIN`);
      assert.lte(cam.pitch, CAM.PITCH_MAX + 1e-9, `pitch ${cam.pitch} exceeded PITCH_MAX`);
    }
    // Extreme pitch must still produce a legal, finite frame. Note the sign
    // convention: _directionFromAngles puts sin(pitch) on the camera->focus axis,
    // so PITCH_MAX drives the camera DOWN toward the floor and PITCH_MIN lifts it
    // up. Getting these the wrong way round makes the floor probe look dead.
    cam.setOrientation(0, CAM.PITCH_MIN);
    const stUp = settle(cam, p, 120);
    assert.ok(stUp.position.isFiniteVec(), 'extreme pitch produced a non-finite camera position');
    assertNoPenetration(cam, stUp, 'extreme pitch up');
    assert.gt(stUp.position.y, 1.0,
      `PITCH_MIN should raise the camera, but it sat at y=${stUp.position.y.toFixed(3)}`);

    cam.setOrientation(0, CAM.PITCH_MAX);
    const stDown = settle(cam, p, 120);
    assert.ok(stDown.position.isFiniteVec(), 'extreme pitch produced a non-finite camera position');
    assertNoPenetration(cam, stDown, 'extreme pitch down');
    assert.gte(stDown.position.y, CAM.COLLISION_RADIUS - 1e-6,
      `the camera went under the floor at PITCH_MAX (y=${stDown.position.y.toFixed(3)})`);
    // belowFloorEvents counts the floor clamp HAVING TO ACT, so a non-zero value
    // here is the probe working, not a failure: PITCH_MAX aims the camera below
    // the ground plane and the clamp is what stops it. Asserting zero would be
    // asserting the clamp never runs. What matters is that it ran and the result
    // is legal - which the two assertions above establish.
    assert.ok(CAM.FLOOR_PROBE, 'FLOOR_PROBE is disabled; a low pitch would see under the world');
    assert.gt(cam.telemetry.belowFloorEvents, 0,
      'the floor clamp never fired at PITCH_MAX - either the probe is dead or the rig never aimed low');

    // ...and in normal play it must stay silent, or the camera is fighting the
    // floor every frame.
    const normal = makeCam(w);
    settle(normal, p, 240);
    assert.equal(normal.telemetry.belowFloorEvents, 0,
      `the floor clamp fired ${normal.telemetry.belowFloorEvents} times at the default pitch`);
  });

  test('09 · distance stays inside [MIN_DISTANCE, desiredDistance] under every input', () => {
    const w = makeWorld([(cw) => {
      // A box room, so the camera is forced against every wall in turn.
      cw.add(wallCollider(-3, -3, 3, -3, 0, 3.2, 0.4, { kind: 'wall', blocksCamera: true, material: 'mudBrick' }));
      cw.add(wallCollider(-3, 3, 3, 3, 0, 3.2, 0.4, { kind: 'wall', blocksCamera: true, material: 'mudBrick' }));
      cw.add(wallCollider(-3, -3, -3, 3, 0, 3.2, 0.4, { kind: 'wall', blocksCamera: true, material: 'mudBrick' }));
      cw.add(wallCollider(3, -3, 3, 3, 0, 3.2, 0.4, { kind: 'wall', blocksCamera: true, material: 'mudBrick' }));
    }]);
    const p = makePlayer(w);
    const cam = makeCam(w);
    let worstPen = 0;
    for (let i = 0; i < 360; i++) {
      cam.look(3 * DEG, 0.4 * DEG * Math.sin(i / 9));
      const st = cam.update(DT, p, {});
      assert.gte(cam.distance, CAM.MIN_DISTANCE - 1e-6,
        `distance ${cam.distance} fell below MIN_DISTANCE ${CAM.MIN_DISTANCE}`);
      assert.lte(cam.distance, cam.desiredDistance + 1e-6,
        `distance ${cam.distance} exceeded the desired ${cam.desiredDistance}`);
      assert.ok(st.position.isFiniteVec(), 'orbiting a box room produced a non-finite position');
      worstPen = Math.max(worstPen, penAt(cam, st.position));
    }
    assert.close(worstPen, 0, CAM.MAX_PENETRATION_TOLERANCE + 1e-9,
      `orbiting inside a box room penetrated geometry by ${worstPen.toFixed(4)} m`);
  });
});

/* ------------------------------------------------------- collision solver */

describe('camera — collision (the §10 zero-penetration gate)', () => {
  test('10 · a wall behind the player pulls the camera in to zero penetration', () => {
    const w = makeWorld([wallAt(-2.0)]);
    const p = makePlayer(w);
    const cam = makeCam(w);
    const st = settle(cam, p, 180);
    assert.lt(cam.distance, CAM.DISTANCE - 0.5,
      `the camera kept its open-ground distance ${cam.distance.toFixed(2)} despite a wall 2 m behind the player`);
    assertNoPenetration(cam, st, 'wall behind the player');
    assert.close(cam.telemetry.worstPenetration, 0, CAM.MAX_PENETRATION_TOLERANCE + 1e-9,
      'the solver recorded non-zero penetration');
  });

  test('11 · a corner (two walls) is solved, not just the single-ray case', () => {
    const w = makeWorld([wallAt(-2.0), (cw) => {
      cw.add(wallCollider(-2.0, -12, -2.0, 12, 0, 3.4, 0.4,
        { kind: 'wall', blocksCamera: true, material: 'mudBrick' }));
    }]);
    const p = makePlayer(w);
    const cam = makeCam(w);
    let worst = 0;
    for (let i = 0; i < 240; i++) {
      cam.look(2.5 * DEG, 0);
      const st = cam.update(DT, p, {});
      worst = Math.max(worst, penAt(cam, st.position));
    }
    assert.close(worst, 0, CAM.MAX_PENETRATION_TOLERANCE + 1e-9,
      `a wall corner let the camera penetrate by ${worst.toFixed(4)} m — the probe pattern is too sparse`);
    assert.gte(CAM.PROBE_RAYS, 5, 'PROBE_RAYS is too few to catch corners');
  });

  test('12 · a low ceiling pushes the camera down without penetrating it', () => {
    const w = makeWorld([(cw) => {
      // A 2.3 m ceiling: lower than the camera wants to sit at full distance.
      cw.add(boxCollider(0, 2.4, -3.0, 14, 0.4, 10,
        { kind: 'ceiling', blocksCamera: true, blocksMovement: true, material: 'poplarWood' }));
    }]);
    const p = makePlayer(w);
    const cam = makeCam(w);
    cam.setOrientation(0, CAM.PITCH_MIN);   // look up, driving the camera low
    let worst = 0;
    let lowest = 99;
    for (let i = 0; i < 180; i++) {
      const st = cam.update(DT, p, {});
      worst = Math.max(worst, penAt(cam, st.position));
      lowest = Math.min(lowest, st.position.y);
    }
    assert.close(worst, 0, CAM.MAX_PENETRATION_TOLERANCE + 1e-9,
      `the camera penetrated a low ceiling by ${worst.toFixed(4)} m`);
    assert.lt(lowest, 2.2, 'the ceiling never constrained the camera — the rig proves nothing');
    assert.ok(CAM.CEILING_PROBE, 'CEILING_PROBE is disabled; low interiors would clip');
  });

  test('13 · a thin wall does not let the camera through', () => {
    // Thin geometry is the classic tunneling case for a single-ray solver.
    const w = makeWorld([wallAt(-2.2, { thickness: 0.06 })]);
    const p = makePlayer(w);
    const cam = makeCam(w);
    const st = settle(cam, p, 180);
    assertNoPenetration(cam, st, 'thin wall');
    assert.gt(st.position.z, -2.2 + 0.03,
      `the camera passed through a 6 cm wall to z=${st.position.z.toFixed(3)}`);
  });

  test('14 · retraction is instant — a clipped camera is visible for even one frame', () => {
    const w = makeWorld([wallAt(-2.0)]);
    // Start the player well clear of the wall so the camera genuinely reaches
    // full arm length first. Retracting from an already-retracted state would
    // pass without testing anything.
    const p = makePlayer(w, new Vec3(0, 0, 12));
    const cam = makeCam(w);
    settle(cam, p, 180);
    assert.close(cam.distance, CAM.DISTANCE, 0.05,
      `rig did not reach full distance first (got ${cam.distance.toFixed(3)})`);

    // Now put the wall between the camera and the player in a single frame.
    p.setPosition(0, 0, 0.4);
    const st = cam.update(DT, p, {});
    assert.ok(CAM.COLLISION_SNAP_IN, 'COLLISION_SNAP_IN is off; retraction would be gradual');
    assert.lt(cam.distance, CAM.DISTANCE - 0.2,
      `the camera did not retract on the FIRST frame it was blocked (distance ${cam.distance.toFixed(3)})`);
    assertNoPenetration(cam, st, 'first frame after the wall came into play');
  });

  test('15 · recovery is gradual — the camera must not snap back', () => {
    const w = makeWorld([wallAt(-2.0)]);
    const p = makePlayer(w);
    const cam = makeCam(w);
    settle(cam, p, 180);
    const retracted = cam.distance;
    assert.lt(retracted, CAM.DISTANCE - 0.5, 'rig did not retract the camera');

    // Move the player into the open. One frame must NOT restore full distance.
    p.setPosition(0, 0, 14);
    const oneFrame = cam.update(DT, p, {});
    assert.lt(cam.distance, CAM.DISTANCE - 0.01,
      'the camera snapped back to full distance in one frame — exactly the violent recovery §11 forbids');
    assert.gt(cam.distance, retracted,
      'the camera did not begin recovering once the obstruction was gone');
    void oneFrame;

    // ...but it must fully recover, or the camera stays permanently pulled in.
    const recovered = settle(cam, p, 240);
    assert.close(cam.distance, CAM.DISTANCE, 0.02,
      `the camera never recovered its full distance (stuck at ${cam.distance.toFixed(3)})`);
    assertNoPenetration(cam, recovered, 'after recovery');
  });

  test('16 · solver-induced snaps are bounded, excluding legitimate look input', () => {
    const w = makeWorld([wallAt(-2.0), wallAt(2.0), (cw) => {
      cw.add(wallCollider(-2.0, -6, -2.0, 6, 0, 3.4, 0.4, { kind: 'wall', blocksCamera: true, material: 'mudBrick' }));
      cw.add(wallCollider(2.0, -6, 2.0, 6, 0, 3.4, 0.4, { kind: 'wall', blocksCamera: true, material: 'mudBrick' }));
    }]);
    const p = makePlayer(w);
    const cam = makeCam(w);
    let worstDistDelta = 0;
    let prev = CAM.DISTANCE;
    for (let i = 0; i < 600; i++) {
      // Move the player through the box so the camera is repeatedly obstructed
      // and released — the worst case for snap-back.
      p.setPosition(Math.sin(i / 40) * 1.2, 0, Math.cos(i / 55) * 1.2);
      cam.update(DT, p, {});
      worstDistDelta = Math.max(worstDistDelta, Math.abs(cam.distance - prev));
      prev = cam.distance;
    }
    // Instant retraction is allowed and expected; a full-distance snap in one
    // frame is not. Bound the per-frame change to the retraction range.
    assert.lt(worstDistDelta, CAM.DISTANCE,
      `the distance changed by ${worstDistDelta.toFixed(3)} m in one frame — more than the whole camera arm`);
    assert.equal(cam.telemetry.stuckEvents, 0,
      `the solver reported ${cam.telemetry.stuckEvents} stuck events in a solvable box room`);
    assert.equal(cam.telemetry.resolveFailures, 0,
      `the solver failed to resolve ${cam.telemetry.resolveFailures} times in a solvable box room`);
  });

  test('17 · the correction loop terminates within a bounded iteration count', () => {
    // Geometry close enough to force a long correction run, but far enough that
    // a legal position still exists above MIN_DISTANCE. An UNSOLVABLE case is
    // test 18's job; asserting "no resolve failures" here would be meaningless
    // against geometry that has no answer.
    const w = makeWorld([wallAt(-1.8, { thickness: 0.3 }), (cw) => {
      cw.add(boxCollider(0, 1.1, -2.8, 8, 2.2, 1.6,
        { kind: 'block', blocksCamera: true, blocksMovement: true, walkableTop: true, material: 'mudBrick' }));
    }]);
    // The verification pass is a SAFETY NET behind _solveDistance, so a rig in
    // which the primary solver always finds a legal arm never exercises it and
    // the iteration bound would be asserted against dead code. Moving the player
    // through clutter produces positions the single-axis solve gets wrong, which
    // is exactly what the net exists for.
    const p = makePlayer(w);
    const cam = makeCam(w);
    let worstPen = 0;
    for (let i = 0; i < 720; i++) {
      p.setPosition(Math.sin(i / 40) * 1.2, 0, Math.cos(i / 55) * 1.2);
      cam.look(0.05 * Math.sin(i / 7), 0.02 * Math.cos(i / 11));
      const st = cam.update(DT, p, {});
      assert.ok(st.position.isFiniteVec(), 'the correction loop diverged to a non-finite position');
      worstPen = Math.max(worstPen, penAt(cam, st.position));
    }
    assert.gt(cam.telemetry.correctionIterationsTotal, 0,
      'the verification pass never ran - the rig did not obstruct the camera');
    assert.close(worstPen, 0, CAM.MAX_PENETRATION_TOLERANCE + 1e-9,
      `the corrected camera still penetrated geometry by ${worstPen.toFixed(6)} m`);
    assert.lt(cam.telemetry.correctionIterationsWorst, 64,
      `the correction loop took ${cam.telemetry.correctionIterationsWorst} iterations in one frame`);
    assert.equal(cam.telemetry.resolveFailures, 0, 'the correction loop gave up');
  });

  test('18 · a fully enclosed player produces a finite frame, not a crash', () => {
    // The pathological case: geometry on every side, closer than MIN_DISTANCE.
    const w = makeWorld([(cw) => {
      // Interior 1.6 m across: comfortably wider than the player capsule
      // (2 * CAPSULE_RADIUS = 0.68 m) so the player is not spawned inside a
      // wall, but far narrower than the camera arm and even than MIN_DISTANCE,
      // so no legal camera position exists. That is the point.
      const t = 0.2;
      cw.add(boxCollider(0, 1.0, -0.9, 1.8, 2.0, t, { kind: 'wall', blocksCamera: true, material: 'mudBrick' }));
      cw.add(boxCollider(0, 1.0, 0.9, 1.8, 2.0, t, { kind: 'wall', blocksCamera: true, material: 'mudBrick' }));
      cw.add(boxCollider(-0.9, 1.0, 0, t, 2.0, 1.8, { kind: 'wall', blocksCamera: true, material: 'mudBrick' }));
      cw.add(boxCollider(0.9, 1.0, 0, t, 2.0, 1.8, { kind: 'wall', blocksCamera: true, material: 'mudBrick' }));
      cw.add(boxCollider(0, 2.1, 0, 1.8, t, 1.8, { kind: 'ceiling', blocksCamera: true, material: 'mudBrick' }));
    }]);
    const p = makePlayer(w);
    const cam = makeCam(w);
    let st = null;
    assert.doesNotThrow(() => { st = settle(cam, p, 120); },
      'an enclosed player threw inside the camera solver');
    assert.ok(st.position.isFiniteVec(), 'an enclosed player produced a non-finite camera position');
    assert.ok(st.forward.isFiniteVec(), 'an enclosed player produced a non-finite forward vector');
    assert.ok(st.up.isFiniteVec() && st.up.lengthSq > 0.5,
      'an enclosed player produced a degenerate up vector — the renderer would flip');
    assert.gte(cam.distance, 0, 'distance went negative when fully enclosed');
    assert.lte(cam.distance, CAM.DISTANCE + 1e-6, 'distance exceeded the arm length when enclosed');
  });

  test('19 · a full 360° orbit around an obstructed player keeps penetration at zero', () => {
    const w = makeWorld([(cw) => {
      // Asymmetric clutter: pillars, a low wall and a tall one, so no two
      // angles present the same problem.
      for (const [x, z, h] of [[-2.4, -1.8, 3.0], [2.6, -1.2, 1.1], [1.9, 2.4, 3.4], [-2.2, 2.1, 2.0]]) {
        cw.add(boxCollider(x, h / 2, z, 0.7, h, 0.7,
          { kind: 'pillar', blocksCamera: true, blocksMovement: true, material: 'bakedBrick' }));
      }
    }]);
    const p = makePlayer(w);
    const cam = makeCam(w);
    let worst = 0;
    let worstAngle = -1;
    for (let deg = 0; deg < 360; deg += 2) {
      cam.setOrientation(deg * DEG, CAM.PITCH_DEFAULT + 0.25 * Math.sin(deg * DEG));
      const st = settle(cam, p, 12);
      const pen = penAt(cam, st.position);
      if (pen > worst) { worst = pen; worstAngle = deg; }
    }
    assert.close(worst, 0, CAM.MAX_PENETRATION_TOLERANCE + 1e-9,
      `a full orbit penetrated geometry by ${worst.toFixed(4)} m at ${worstAngle}°`);
    assert.close(cam.telemetry.worstPenetration, 0, CAM.MAX_PENETRATION_TOLERANCE + 1e-9,
      'the solver telemetry recorded penetration during the orbit');
  });

  test('20 · penetration measurement itself reports a known-bad position as bad', () => {
    // Guards against a rig that asserts zero because the probe measures nothing.
    const w = makeWorld([(cw) => {
      cw.add(boxCollider(0, 1.5, -4, 6, 3, 4,
        { kind: 'block', blocksCamera: true, blocksMovement: true, material: 'mudBrick' }));
    }]);
    const cam = makeCam(w);
    const inside = new Vec3(0, 1.5, -4);       // dead centre of the block
    const outside = new Vec3(0, 1.5, 4);       // clear air
    assert.gt(cam.measurePenetration(inside, CAM.COLLISION_RADIUS, { dense: true }), 0,
      'measurePenetration reported a position INSIDE a solid as free — the probe proves nothing');
    assert.close(cam.measurePenetration(outside, CAM.COLLISION_RADIUS, { dense: true }), 0, 1e-9,
      'measurePenetration reported clear air as penetrating');
    // And with no collision world at all it must be inert, not throwing.
    const bare = new ThirdPersonCamera({});
    assert.equal(bare.measurePenetration(inside), 0, 'a camera with no world reported penetration');
  });
});

/* ------------------------------------------------------- modes and shots */

describe('camera — cinematic, finisher and shot helpers', () => {
  test('21 · cinematic mode bypasses the gameplay solver and follows the shot', () => {
    const w = flatWorld();
    const p = makePlayer(w);
    const cam = makeCam(w);
    const shots = orbitShot(new Vec3(0, 0, 0), { steps: 12, radius: 5 });
    let i = 0;
    const ctx = {
      mode: CameraMode.CINEMATIC,
      cinematic: {
        duration: 1,
        elapsed: 0,
        sample: () => shots[Math.min(i++, shots.length - 1)],
      },
    };
    const st = cam.update(DT, p, ctx);
    assert.equal(cam.mode, CameraMode.CINEMATIC, 'the cinematic mode was not selected');
    assert.close(st.position.distanceXZ(shots[0].position), 0, 1e-6,
      'the cinematic camera ignored the shot position');
    assert.close(st.fov, shots[0].fov, 1e-6, 'the cinematic camera ignored the shot FOV');
    // The gameplay arm length must not leak into a cinematic.
    assert.gt(Math.abs(st.position.distanceXZ(st.focus) - CAM.DISTANCE), 0.5,
      'the cinematic used the gameplay distance instead of the authored shot');
  });

  test('22 · a cinematic shot is still collision-verified', () => {
    // An authored camera path that clips through a wall is a shipped bug; the
    // cinematic bypass must not bypass the verification pass.
    const w = makeWorld([(cw) => {
      cw.add(boxCollider(0, 1.5, -3, 12, 3, 1.0,
        { kind: 'wall', blocksCamera: true, blocksMovement: true, material: 'mudBrick' }));
    }]);
    const cam = makeCam(w);
    const ctx = {
      mode: CameraMode.CINEMATIC,
      cinematic: {
        duration: 1, elapsed: 0,
        // Authored INSIDE the wall slab (z[-3.5,-2.5]), which is the case the
        // verification pass exists for. Note that a shot authored merely BEHIND
        // a wall is already legal as far as penetration goes - the solver
        // guarantees "not inside geometry", not "can see the subject"; occlusion
        // is an authoring concern, and pretending otherwise would make this test
        // assert something the code never promised.
        sample: () => ({
          position: new Vec3(0, 1.5, -3.0),
          target: new Vec3(0, 1.2, 0),
          fov: CAM.FOV_CINEMATIC,
        }),
      },
    };
    const camProbe = makeCam(w);
    assert.gt(camProbe.measurePenetration(new Vec3(0, 1.5, -3.0), CAM.COLLISION_RADIUS * 0.8, { dense: true }), 0,
      'rig error: the authored cinematic position is not actually inside the wall');
    const st = cam.update(DT, makePlayer(w), ctx);
    assert.ok(st.position.isFiniteVec(), 'the cinematic solver produced a non-finite position');
    assert.gt(Math.abs(st.position.z + 3.0), 0.1,
      `the cinematic camera stayed embedded in the wall at z=${st.position.z.toFixed(3)}`);
    assertNoPenetration(cam, st, 'authored cinematic embedded in a wall');
  });

  test('23 · finisher mode frames the pair and stays legal', () => {
    const w = makeWorld([wallAt(-1.6, { thickness: 0.4 })]);
    const p = makePlayer(w);
    const victim = { pos: new Vec3(0.9, 0, -0.4) };
    const cam = makeCam(w);
    let st = null;
    for (let i = 0; i < 120; i++) st = cam.update(DT, p, { mode: CameraMode.FINISHER, finisher: { victim, t: i / 120 } });
    assert.equal(cam.mode, CameraMode.FINISHER, 'the finisher mode was not selected');
    assert.ok(st.position.isFiniteVec(), 'the finisher camera produced a non-finite position');
    // Both actors must be in front of the camera, and reasonably close.
    const toPlayer = Vec3.sub(p.pos, st.position).length;
    const toVictim = Vec3.sub(victim.pos, st.position).length;
    assert.lt(toPlayer, 8, `the finisher camera was ${toPlayer.toFixed(2)} m from the player`);
    assert.lt(toVictim, 8, `the finisher camera was ${toVictim.toFixed(2)} m from the victim`);
    assertNoPenetration(cam, st, 'finisher next to a wall');
  });

  test('24 · twoShot frames both subjects and backs off with their separation', () => {
    const near = twoShot(new Vec3(-0.6, 0, 0), new Vec3(0.6, 0, 0));
    const far = twoShot(new Vec3(-3, 0, 0), new Vec3(3, 0, 0));
    assert.ok(near.position.isFiniteVec() && near.target.isFiniteVec(), 'twoShot produced a non-finite frame');
    assert.gt(far.distance, near.distance,
      'twoShot did not back off as the subjects separated — one of them would be out of frame');
    // The target must sit between the two actors, at the declared height.
    assert.close(near.target.x, 0, 1e-6, 'the two-shot target is not centred between the actors');
    assert.close(near.target.y, 1.45, 1e-6, 'the two-shot target height is not the default');
    // Both subjects must land inside the frame at the chosen distance.
    for (const [shot, a, b] of [[near, new Vec3(-0.6, 0, 0), new Vec3(0.6, 0, 0)],
      [far, new Vec3(-3, 0, 0), new Vec3(3, 0, 0)]]) {
      const d = shot.position.distanceXZ(a);
      const d2 = shot.position.distanceXZ(b);
      assert.lt(Math.abs(d - d2), 1e-6, 'the two-shot is not equidistant from both actors');
      assert.gt(subjectScreenFraction(1.75, shot.distance, shot.fov), 0.1,
        'a subject would be a speck in this two-shot');
    }
  });

  test('25 · orbitShot sweeps monotonically and stays at its declared radius', () => {
    const frames = orbitShot(new Vec3(2, 0, -3), { radius: 4.2, steps: 16, rise: 1.0 });
    assert.equal(frames.length, 16, 'orbitShot did not return the requested step count');
    let prevAngle = null;
    for (const f of frames) {
      assert.ok(f.position.isFiniteVec(), 'orbitShot produced a non-finite position');
      const r = Math.hypot(f.position.x - 2, f.position.z + 3);
      assert.close(r, 4.2, 1e-6, `orbit radius drifted to ${r.toFixed(3)}`);
      const a = Math.atan2(f.position.x - 2, f.position.z + 3);
      if (prevAngle !== null) assert.gte(a, prevAngle - 1e-9, 'the orbit reversed direction mid-sweep');
      prevAngle = a;
      assert.close(f.target.x, 2, 1e-9, 'the orbit target drifted off the subject');
    }
    assert.gt(frames[frames.length - 1].position.y, frames[0].position.y,
      'the requested rise was not applied');
    assert.close(frames[0].t, 0, 1e-9, 'the orbit does not start at t=0');
    assert.close(frames[frames.length - 1].t, 1, 1e-9, 'the orbit does not end at t=1');
  });

  test('26 · subjectScreenFraction matches the pinhole projection', () => {
    const visibleHeight = (dist, fov) => 2 * Math.tan((fov * 0.5) * DEG) * dist;
    for (const [size, dist, fov] of [[1.75, 3.5, 62], [1.75, 10, 62], [0.4, 2, 48], [1.75, 30, 68]]) {
      const got = subjectScreenFraction(size, dist, fov);
      const want = Math.min(1, size / visibleHeight(dist, fov));
      assert.close(got, want, 1e-9,
        `screen fraction for ${size} m at ${dist} m / ${fov}° was ${got}, expected ${want.toFixed(4)}`);
    }
    // Monotonic: further away is always smaller on screen.
    assert.gt(subjectScreenFraction(1.75, 2, 62), subjectScreenFraction(1.75, 8, 62),
      'a distant subject occupied more of the screen than a near one');
    // Narrower FOV (a zoom) makes the subject larger.
    assert.gt(subjectScreenFraction(1.75, 5, 40), subjectScreenFraction(1.75, 5, 70),
      'zooming in did not enlarge the subject');
    assert.lte(subjectScreenFraction(1e6, 0.001, 62), 1, 'screen fraction exceeded 1');
    assert.gte(subjectScreenFraction(1.75, 0, 62), 0, 'a zero distance produced a negative fraction');
  });
});

/* ---------------------------------------------------- shake, accessibility */

describe('camera — shake and accessibility', () => {
  test('27 · shake is capped, decays, and returns to exactly zero', () => {
    const w = flatWorld();
    const p = makePlayer(w);
    const cam = makeCam(w);
    cam.addShake(CAM.SHAKE_MAX * 10);   // far more than any real event
    assert.lte(cam.shakeAmount, CAM.SHAKE_MAX + 1e-9,
      `shake exceeded SHAKE_MAX (${cam.shakeAmount} > ${CAM.SHAKE_MAX})`);

    let peak = 0;
    let st = null;
    for (let i = 0; i < 240; i++) {
      st = cam.update(DT, p, {});
      peak = Math.max(peak, st.shake.length);
    }
    assert.gt(peak, 0, 'shake produced no visible offset');
    assert.close(cam.shakeAmount, 0, 1e-4,
      `shake never decayed to zero (still ${cam.shakeAmount.toFixed(5)}) — the screen would buzz forever`);
    assert.close(st.shake.length, 0, 1e-4, 'the shake offset never settled');
    assertNoPenetration(cam, st, 'after shake settled');
  });

  test('28 · reducedMotion really does suppress shake (accessibility)', () => {
    const measurePeak = (reducedMotion) => {
      const w = flatWorld();
      const cam = makeCam(w);
      const p = makePlayer(w);
      cam.addShake(CAM.SHAKE_MAX);
      let peak = 0;
      for (let i = 0; i < 60; i++) {
        const st = cam.update(DT, p, { reducedMotion });
        peak = Math.max(peak, st.shake.length);
      }
      return peak;
    };
    const full = measurePeak(false);
    const reduced = measurePeak(true);
    assert.gt(full, 0, 'rig produced no shake to reduce');
    assert.lt(reduced, full * (CAM.REDUCED_MOTION_SHAKE_SCALE * 2.2),
      `reducedMotion barely helped: ${reduced.toFixed(4)} vs ${full.toFixed(4)} full`);
    assert.lt(CAM.REDUCED_MOTION_SHAKE_SCALE, 0.5,
      'REDUCED_MOTION_SHAKE_SCALE is not a meaningful reduction');
  });

  test('29 · shake never carries the camera into geometry', () => {
    // A shake offset applied AFTER the collision solve would reintroduce
    // clipping through the very wall the solver just respected.
    const w = makeWorld([wallAt(-2.0), wallAt(2.0)]);
    const p = makePlayer(w);
    const cam = makeCam(w);
    cam.addShake(CAM.SHAKE_MAX);
    let worst = 0;
    for (let i = 0; i < 180; i++) {
      const st = cam.update(DT, p, {});
      worst = Math.max(worst, penAt(cam, Vec3.add(st.position, st.shake)));
    }
    assert.close(worst, 0, CAM.MAX_PENETRATION_TOLERANCE + 1e-9,
      `shake offset pushed the camera ${worst.toFixed(4)} m into geometry`);
  });
});

/* ------------------------------------------- determinism, save, robustness */

describe('camera — determinism, serialization and robustness', () => {
  const script = [
    { dx: 0.05, dp: 0.01, frames: 40 }, { dx: -0.12, dp: 0.03, frames: 30 },
    { dx: 0.0, dp: -0.2, frames: 25 }, { dx: 0.31, dp: 0.0, frames: 50 },
    { dx: -0.02, dp: 0.11, frames: 35 },
  ];

  function runScript(seedZ = 0) {
    const w = makeWorld([wallAt(-2.0), (cw) => {
      cw.add(boxCollider(2.2, 1.0, 1.5, 0.8, 2.0, 0.8,
        { kind: 'pillar', blocksCamera: true, blocksMovement: true, material: 'bakedBrick' }));
    }]);
    const p = makePlayer(w, new Vec3(0, 0, seedZ));
    const cam = makeCam(w);
    for (const step of script) {
      cam.look(step.dx, step.dp);
      for (let i = 0; i < step.frames; i++) cam.update(DT, p, {});
    }
    return cam.state();
  }

  test('30 · identical input produces an identical camera state', () => {
    const a = runScript(0);
    const b = runScript(0);
    assert.close(a.position.x, b.position.x, 1e-12, 'camera X diverged between identical runs');
    assert.close(a.position.y, b.position.y, 1e-12, 'camera Y diverged between identical runs');
    assert.close(a.position.z, b.position.z, 1e-12, 'camera Z diverged between identical runs');
    assert.close(a.fov, b.fov, 1e-12, 'FOV diverged between identical runs');
    assert.close(a.distance, b.distance, 1e-12, 'distance diverged between identical runs');
    assert.equal(a.mode, b.mode, 'mode diverged between identical runs');
  });

  test('31 · a different player position produces a different camera state', () => {
    const a = runScript(0);
    const c = runScript(6);
    assert.gt(a.position.distanceXZ(c.position), 0.5,
      'the rig produced identical cameras from different player positions — the test proves nothing');
  });

  test('32 · orientation damping is frame-rate independent', () => {
    const runAt = (dt, seconds) => {
      const w = makeWorld([wallAt(-2.0)]);
      const p = makePlayer(w);
      const cam = makeCam(w);
      cam.look(1.2, 0.3);
      const frames = Math.round(seconds / dt);
      for (let i = 0; i < frames; i++) cam.update(dt, p, {});
      return cam;
    };
    // Driven to the STEADY STATE, because that is the frame-rate invariant.
    // Exponential damping reaches the same fixed point at any dt but samples it
    // differently mid-flight, so comparing part-way through the ease measures the
    // transient rather than the solver. Settled, all three rates must agree
    // exactly: this is the assertion that caught the arm length settling at three
    // different values (2.7716 / 2.8491 / 2.9477 m at 144 / 60 / 30 fps) when the
    // distance writeback absorbed the floor clamp's vertical lift.
    const a = runAt(1 / 60, 4.0);
    const b = runAt(1 / 30, 4.0);
    const c = runAt(1 / 144, 4.0);
    assert.close(b.distance, a.distance, 0.01,
      `30 fps settled at ${b.distance.toFixed(4)} m vs 60 fps ${a.distance.toFixed(4)} m - the arm length is frame-rate dependent`);
    assert.close(c.distance, a.distance, 0.01,
      `144 fps settled at ${c.distance.toFixed(4)} m vs 60 fps ${a.distance.toFixed(4)} m - the arm length is frame-rate dependent`);
    assert.close(b.fov, a.fov, 0.6,
      `30 fps FOV ${b.fov.toFixed(2)} vs 60 fps ${a.fov.toFixed(2)} — the FOV ease is frame-rate dependent`);
    assert.close(c.fov, a.fov, 0.3, 'the FOV ease is frame-rate dependent at 144 fps');
  });

  test('33 · serialize/restore round-trips through a real save file', () => {
    const w = makeWorld([wallAt(-2.0)]);
    const p = makePlayer(w);
    const cam = makeCam(w);
    cam.look(0.9, -0.35);
    settle(cam, p, 120);
    const json = JSON.parse(JSON.stringify(cam.serialize()));

    const restored = makeCam(w).restore(json);
    assert.close(restored.yaw, cam.yaw, 1e-9, 'yaw did not round-trip');
    assert.close(restored.pitch, cam.pitch, 1e-9, 'pitch did not round-trip');
    assert.close(restored.distance, cam.distance, 1e-9, 'distance did not round-trip');
    assert.close(restored.fov, cam.fov, 1e-9, 'FOV did not round-trip');
    assert.equal(restored.shoulderRight, cam.shoulderRight, 'shoulder side did not round-trip');
    assert.equal(restored.mode, cam.mode, 'mode did not round-trip');

    // And the restored camera must converge to the same frame, not merely hold
    // the numbers: a save that restores into a different view reads as a jump.
    const a = settle(cam, p, 120);
    const b = settle(restored, p, 120);
    assert.close(a.position.distanceXZ(b.position), 0, 0.05,
      'a restored camera settled somewhere other than where it saved');
  });

  test('34 · restore survives corrupt and hostile save data', () => {
    const hostile = [
      null, undefined, {}, 42, 'nope', [],
      { yaw: NaN }, { yaw: Infinity }, { pitch: 1e9 }, { pitch: -1e9 },
      { distance: -500 }, { distance: 1e9 }, { fov: NaN }, { fov: 1e6 },
      { position: 'nope' }, { position: [NaN, NaN, NaN] }, { position: [1e12, -1e12, 1e12] },
      { shoulderRight: 'yes' }, { mode: { evil: true } },
    ];
    const w = makeWorld([wallAt(-2.0)]);
    const p = makePlayer(w);
    for (const data of hostile) {
      const cam = makeCam(w);
      assert.doesNotThrow(() => cam.restore(data),
        `restore threw on ${JSON.stringify(data) ?? String(data)}`);
      assert.ok(Number.isFinite(cam.yaw), `restore produced a non-finite yaw from ${JSON.stringify(data)}`);
      assert.gte(cam.pitch, CAM.PITCH_MIN - 1e-9, 'a corrupt pitch below PITCH_MIN survived restore');
      assert.lte(cam.pitch, CAM.PITCH_MAX + 1e-9, 'a corrupt pitch above PITCH_MAX survived restore');
      assert.gte(cam.distance, CAM.MIN_DISTANCE - 1e-9, 'a corrupt distance below MIN_DISTANCE survived restore');
      assert.ok(Number.isFinite(cam.fov) && cam.fov > 0, 'a corrupt FOV survived restore');
      const st = settle(cam, p, 60);
      assert.ok(st.position.isFiniteVec(),
        `a camera restored from ${JSON.stringify(data)} produced a non-finite position`);
    }
  });

  test('35 · a hostile or absent dt cannot break the solver', () => {
    const w = makeWorld([wallAt(-2.0)]);
    const p = makePlayer(w);
    for (const dt of [NaN, Infinity, -Infinity, -1, 0, 1e-9, 30, 1e6]) {
      const cam = makeCam(w);
      let st = null;
      assert.doesNotThrow(() => { st = cam.update(dt, p, {}); }, `update threw on dt=${dt}`);
      assert.ok(st.position.isFiniteVec(), `dt=${dt} produced a non-finite camera position`);
      assert.ok(Number.isFinite(st.fov) && st.fov > 0, `dt=${dt} produced a non-finite FOV`);
      assert.gte(cam.distance, CAM.MIN_DISTANCE - 1e-6, `dt=${dt} drove distance below MIN_DISTANCE`);
    }
  });

  test('36 · a missing player or collision world degrades instead of throwing', () => {
    const cam = new ThirdPersonCamera({});
    let st = null;
    assert.doesNotThrow(() => { st = settle(cam, null, 60); }, 'a camera with no player threw');
    assert.ok(st.position.isFiniteVec(), 'a camera with no player produced a non-finite position');
    assert.ok(st.up.lengthSq > 0.5, 'a camera with no player produced a degenerate up vector');

    const w = flatWorld();
    const cam2 = makeCam(w);
    assert.doesNotThrow(() => settle(cam2, null, 60), 'a camera with no player but a world threw');
    const cam3 = makeCam(w);
    cam3.setCollision(null);
    assert.doesNotThrow(() => settle(cam3, makePlayer(w), 60), 'clearing the collision world threw');
    assert.ok(cam3.state().position.isFiniteVec(), 'clearing the collision world broke the position');
  });

  test('37 · auto-centre waits its delay, needs speed, and never fights look input', () => {
    const w = flatWorld();
    const p = makePlayer(w);
    const cam = makeCam(w);
    cam.look(1.4, 0);                     // player looks well away from travel
    const offCentre = cam.yaw;

    // Standing still: the camera must NOT re-centre, however long we wait.
    settle(cam, p, Math.round((CAM.AUTO_CENTER_DELAY + 2.0) / DT));
    assert.close(cam.yaw, offCentre, 1e-6,
      'the camera re-centred on a stationary player — looking around while standing is interrupted');

    // Moving fast, past the delay: it must ease back toward the body facing.
    const p2 = sprint(makePlayer(w));
    const cam2 = makeCam(w);
    cam2.look(1.4, 0);
    settle(cam2, p2, Math.round((CAM.AUTO_CENTER_DELAY + 1.5) / DT));
    const gap = Math.abs(((cam2.yaw - p2.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    assert.lt(gap, 1.4,
      `the camera never eased back toward the player while sprinting (still ${gap.toFixed(2)} rad off)`);
    assert.gt(CAM.AUTO_CENTER_DELAY, 1.0,
      'AUTO_CENTER_DELAY is so short that the camera would fight the player constantly');
  });

  test('38 · one camera update stays inside the §24 frame budget', () => {
    const w = makeWorld([wallAt(-2.0), wallAt(2.0), (cw) => {
      for (const [x, z] of [[-2.4, -1.8], [2.6, -1.2], [1.9, 2.4], [-2.2, 2.1]]) {
        cw.add(boxCollider(x, 1.5, z, 0.7, 3.0, 0.7,
          { kind: 'pillar', blocksCamera: true, blocksMovement: true, material: 'bakedBrick' }));
      }
    }]);
    const p = makePlayer(w);
    const cam = makeCam(w);
    let i = 0;
    // mean is the honest budget figure. The absolute maximum is not: it is
    // dominated by V8 garbage-collection pauses that land on different,
    // non-repeating frames each run (see movement-test 37 for the measurement).
    const samples = [];
    const meanMs = measure(() => {
      cam.look(0.02 * Math.sin(i / 7), 0.01 * Math.cos(i / 11));
      p.setPosition(Math.sin(i / 40) * 1.1, 0, Math.cos(i / 55) * 1.1);
      const t0 = process.hrtime.bigint();
      cam.update(DT, p, {});
      samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
      i++;
    }, 2400, 120);
    samples.sort((a, b) => a - b);
    const p999 = samples[Math.floor(samples.length * 0.999)];
    assert.lt(meanMs, PERF.FRAME_BUDGET_MS * 0.10,
      `mean camera update ${meanMs.toFixed(4)} ms exceeds 10% of the ${PERF.FRAME_BUDGET_MS} ms budget`);
    assert.lt(p999, PERF.FRAME_BUDGET_MS * 0.5,
      `p99.9 camera update ${p999.toFixed(4)} ms exceeds half the frame budget`);
    assert.equal(cam.telemetry.resolveFailures, 0, 'the solver gave up during the sustained run');
  });

  test('39 · the camera never detaches from the player beyond the declared arm', () => {
    const w = makeWorld([wallAt(-3.0), wallAt(3.0), (cw) => {
      cw.add(boxCollider(-2.5, 1.2, 0, 0.8, 2.4, 4,
        { kind: 'block', blocksCamera: true, blocksMovement: true, material: 'mudBrick' }));
    }]);
    const p = makePlayer(w);
    const cam = makeCam(w);
    let worst = 0;
    for (let i = 0; i < 600; i++) {
      p.setPosition(Math.sin(i / 30) * 1.5, 0, Math.cos(i / 23) * 2.2);
      cam.look(0.05, 0.02 * Math.sin(i / 5));
      const st = cam.update(DT, p, {});
      const d = st.position.distanceXZ(p.pos);
      worst = Math.max(worst, d);
      assert.ok(st.position.isFiniteVec(), 'the camera detached to a non-finite position');
    }
    const ceiling = CAM.DISTANCE_COMBAT + CAM.SHOULDER_OFFSET + 1.0;
    assert.lt(worst, ceiling,
      `the camera reached ${worst.toFixed(2)} m from the player, past the declared arm (${ceiling.toFixed(2)} m)`);
  });

  test('40 · zero penetration holds in real generated geometry, every region', () => {
    // The synthetic rigs prove mechanisms; this proves the gate holds on shipped
    // geometry, where doorways, colonnades, furniture and terrain undulation
    // combine in ways no hand-built box reproduces.
    assert.equal(sharedWorld.regionSpaces.size, 20, 'shared world did not build every region');
    let worstOverall = 0;
    let worstWhere = '';
    let frames = 0;
    for (const id of sharedWorld.regionSpaces.keys()) {
      const space = sharedWorld.region(id);
      const cam = makeCam(space.collision);
      const spawns = (space.spawnPoints ?? []).slice(0, 3);
      if (spawns.length === 0) continue;
      for (const spawn of spawns) {
        const p = makePlayer(space.collision,
          new Vec3(spawn.x, spawn.y ?? space.elevation, spawn.z));
        for (let deg = 0; deg < 360; deg += 30) {
          cam.setOrientation(deg * DEG, CAM.PITCH_DEFAULT);
          const st = settle(cam, p, 10);
          frames++;
          const pen = penAt(cam, st.position);
          if (pen > worstOverall) {
            worstOverall = pen;
            worstWhere = `${id} @(${spawn.x.toFixed(1)},${spawn.z.toFixed(1)}) yaw ${deg}°`;
          }
        }
      }
    }
    assert.gt(frames, 200, `the real-world sweep only produced ${frames} camera frames — it proved nothing`);
    assert.close(worstOverall, 0, CAM.MAX_PENETRATION_TOLERANCE + 1e-9,
      `the camera penetrated generated geometry by ${worstOverall.toFixed(4)} m at ${worstWhere}`);
  });
});

runAndExit();
