/**
 * THE BETRAYED WILL — ai-test.mjs
 *
 * The enemy AI suite.
 *
 * §11 says the AI must not cheat. That sentence is easy to satisfy on paper and
 * almost impossible to satisfy by discipline: the natural way to write an enemy
 * is to read the player's position, then subtract a few handicap numbers and call
 * the result "fair". It is not fair, because such an enemy never actually loses
 * track of you - it only pretends not to. So this suite does not test that the AI
 * has handicaps. It tests that the AI is STRUCTURALLY UNABLE to use information
 * it has not perceived:
 *
 *   - the player's true state is read by exactly one method, and everything
 *     downstream steers toward a MEMORY that is a copy taken at the moment of
 *     perception. Move the player out of sight and the guard walks to where you
 *     WERE. That is asserted directly, not inferred.
 *   - a guard commits to a swing based on the distance to its memory, so a player
 *     who steps aside during the windup is genuinely missed. The AI is allowed to
 *     be wrong; a test proves it can be.
 *   - an enemy's top speed is MOVE.RUN_SPEED and never MOVE.SPRINT_SPEED, and a
 *     save file cannot grant it more. If the AI could outsprint the player, every
 *     alert would be a forced fight.
 *   - movement goes through CollisionWorld.moveCapsule() and routes on the same
 *     nav grid by the same A* as everything else. A guard is asserted to stay out
 *     of geometry every single frame, in a generated region with a wall in it.
 *   - damage, stagger, block, parry and i-frames come from combat.js, which both
 *     sides call. There is no second damage path for the AI.
 *   - GroupCoordinator caps simultaneous attackers at AI.GROUP_ATTACK_SLOTS, so
 *     six enemies is a fight rather than six times the declared damage per second.
 *
 * Also asserted: the perception model itself (cone, peripheral band, exposure from
 * light and stance, range scaled by exposure, detection time, noise falloff and
 * weather masking), the full escalation ladder, reaction and aim delays, retreat,
 * stuck recovery, determinism for a given seed, and the frame budget.
 *
 * Run: node tests/ai-test.mjs
 */

import { describe, test, assert, runAndExit, measure } from './harness.mjs';
import { Vec3 } from '../src/core/math.js';
import { AI, COMBAT, MOVE, PERF, STEALTH, WORLD } from '../src/core/constants.js';
import { CollisionWorld, wallCollider } from '../src/sim/collision.js';
import { NavGrid } from '../src/sim/navgrid.js';
import { Pathfinder } from '../src/sim/astar.js';
import { PlayerController, emptyIntent } from '../src/sim/player.js';
import { SwingPhase, Side, StaggerLevel, resolveMelee } from '../src/sim/combat.js';
import {
  AISquad, AIState, AgentMemory, EnemyAgent, GroupCoordinator, detectTimeFor,
  effectiveDetectRange, exposureFor, makeGuard, makeRng, noiseAudibility,
  perceptionProbe, viewConeFactor,
} from '../src/sim/ai.js';

/* ------------------------------------------------------------------- rig */

function flatWorld(opts = {}) {
  const cw = new CollisionWorld(4);
  cw.setBounds(new Vec3(-60, -30, -60), new Vec3(60, 40, 60));
  cw.groundHeight = 0;
  cw.heightFn = null;
  if (opts.wall) {
    // A sight-and-body blocking wall across the middle, with gaps at both ends so
    // a path exists around it. Without the gaps the correct answer is "no path",
    // which would test the failure branch rather than the routing.
    const h = opts.wall.height ?? 3.4;
    const half = opts.wall.half ?? 6;
    cw.add(wallCollider(-half, 3, half, 3, 0, h, 0.4,
      { kind: 'wall', blocksSight: true, blocksCamera: true, material: 'mudBrick' }));
  }
  return cw;
}

function makeNav(cw, half = 40) {
  const grid = new NavGrid({
    bounds: { minX: -half, maxX: half, minZ: -half, maxZ: half },
    cellSize: WORLD.NAV_CELL_SIZE,
  });
  grid.build(cw, { agentHeight: MOVE.CAPSULE_HEIGHT });
  return grid;
}

/** A guard with a real collision world, so locomotion goes through moveCapsule. */
function guard(opts = {}) {
  const cw = opts.collision ?? flatWorld({ wall: opts.wall });
  const nav = opts.nav ?? (opts.noNav ? null : makeNav(cw));
  const g = new EnemyAgent({
    id: opts.id ?? 'guard',
    pos: opts.pos ?? new Vec3(0, 0, 0),
    yaw: opts.yaw ?? 0,
    collision: cw,
    nav,
    pathfinder: nav ? new Pathfinder(nav) : null,
    pathTimeBudgetMs: opts.pathTimeBudgetMs,
    pathMaxNodes: opts.pathMaxNodes,
    rng: makeRng(opts.seed ?? 12345),
    patrol: opts.patrol,
    health: opts.health,
  });
  if (opts.maxSpeed !== undefined) g.maxSpeed = opts.maxSpeed;
  return g;
}

/** A truth sample: the player's REAL state, as the game loop would hand it over. */
function truth(x, z, extra = {}) {
  return {
    playerPos: new Vec3(x, extra.y ?? 0, z),
    stance: extra.stance ?? 'stand',
    speed: extra.speed ?? 0,
    noiseRadius: extra.noiseRadius ?? 0,
    lightLevel: extra.lightLevel ?? STEALTH.LIGHT_EXPOSURE_DAY,
    inShadow: extra.inShadow ?? false,
    weather: extra.weather ?? 'clear',
    isNight: extra.isNight ?? false,
  };
}

/** Drive a guard for N frames against a fixed truth sample. */
function drive(g, t, frames, dt = 1 / 60) {
  let last = null;
  for (let i = 0; i < frames; i++) last = g.update(dt, t);
  return last;
}

/** Push suspicion straight to a band, for tests about decisions not detection. */
function forceSuspicion(g, value, rememberPos = null) {
  g.suspicion = value;
  g.suspicionHold = STEALTH.SUSPICION_DECAY_DELAY;
  if (rememberPos) g.memory.noteSighting(rememberPos, 1);
  return g;
}

/* ============================================ the pure perception model */

describe('the perception model is built from declared constants', () => {
  test('exposure matches the declared light levels for day and night', () => {
    assert.close(exposureFor({ isNight: false }), STEALTH.LIGHT_EXPOSURE_DAY, 1e-9);
    assert.close(exposureFor({ isNight: true }), STEALTH.LIGHT_EXPOSURE_NIGHT, 1e-9);
    assert.close(exposureFor({ lightLevel: 1 }), 1, 1e-9);
    assert.close(exposureFor({ lightLevel: 0 }), 0, 1e-9);
  });

  test('crouching and going prone reduce exposure by the declared scales', () => {
    const stand = exposureFor({ lightLevel: 1, stance: 'stand' });
    const crouch = exposureFor({ lightLevel: 1, stance: 'crouch' });
    const prone = exposureFor({ lightLevel: 1, stance: 'prone' });
    assert.close(crouch, stand * STEALTH.CROUCH_EXPOSURE_SCALE, 1e-9);
    assert.close(prone, stand * STEALTH.PRONE_EXPOSURE_SCALE, 1e-9);
    assert.lt(prone, crouch, 'prone must be harder to see than crouching');
    assert.lt(crouch, stand, 'crouching must be harder to see than standing');
  });

  test('moving makes you more visible, and shadow makes you less', () => {
    // Base light below 1, because exposure clamps at 1: from a fully lit start the
    // movement multiplier is invisible and the assertion would test the clamp.
    const still = exposureFor({ lightLevel: 0.5, speed: 0 });
    const running = exposureFor({ lightLevel: 0.5, speed: MOVE.RUN_SPEED });
    assert.close(running, still * STEALTH.MOVEMENT_EXPOSURE_SCALE, 1e-9);
    assert.gt(running, still, 'a sprint across a courtyard must be more visible than standing');
    assert.equal(exposureFor({ lightLevel: 1, speed: MOVE.SPRINT_SPEED }), 1,
      'exposure must clamp at 1 rather than exceed it');
    const shadowed = exposureFor({ lightLevel: 0.5, inShadow: true });
    assert.close(shadowed, still * STEALTH.SHADOW_EXPOSURE_SCALE, 1e-9);
    assert.lt(shadowed, still);
  });

  test('weather reduces exposure, and every declared weather is honoured', () => {
    for (const [name, scale] of Object.entries(STEALTH.WEATHER_EXPOSURE)) {
      assert.close(exposureFor({ lightLevel: 1, weather: name }), scale, 1e-9,
        `weather "${name}" did not apply its declared exposure scale`);
    }
    assert.lt(STEALTH.WEATHER_EXPOSURE.dust, STEALTH.WEATHER_EXPOSURE.clear,
      'a dust storm must hide the player better than clear air');
  });

  test('exposure is always inside 0..1 and never NaN', () => {
    const junk = [
      {}, { lightLevel: NaN }, { lightLevel: Infinity }, { speed: NaN },
      { stance: 'banana' }, { weather: 'apocalypse' }, { lightLevel: -5, speed: -9 },
      { lightLevel: 99, speed: 1e9, stance: 'crouch', inShadow: true, weather: 'storm' },
    ];
    for (const j of junk) {
      const e = exposureFor(j);
      assert.finite(e, `exposureFor(${JSON.stringify(j)}) was not finite`);
      assert.gte(e, 0, 'exposure went negative');
      assert.lte(e, 1, 'exposure exceeded 1');
    }
  });

  test('the view cone is 1 inside, PERIPHERAL_MULTIPLIER in the band, 0 outside', () => {
    const main = STEALTH.VIEW_CONE_DEG * 0.5;
    const periph = STEALTH.PERIPHERAL_CONE_DEG * 0.5;
    assert.equal(viewConeFactor(0), 1);
    assert.equal(viewConeFactor(main - 0.5), 1);
    assert.equal(viewConeFactor(main + 0.5), STEALTH.PERIPHERAL_MULTIPLIER);
    assert.equal(viewConeFactor(periph - 0.5), STEALTH.PERIPHERAL_MULTIPLIER);
    assert.equal(viewConeFactor(periph + 0.5), 0);
    assert.equal(viewConeFactor(180), 0);
  });

  test('the view cone is left-right symmetric', () => {
    // An asymmetric cone would make one shoulder safe to walk past and the other
    // lethal, which reads as a bug no matter how it was tuned.
    for (let deg = 0; deg <= 180; deg += 5) {
      assert.equal(viewConeFactor(deg), viewConeFactor(-deg), `asymmetry at ${deg}°`);
    }
  });

  test('a 360° guard is impossible and a blind guard is impossible', () => {
    assert.lt(STEALTH.PERIPHERAL_CONE_DEG, 360,
      'a full-circle view cone makes cover meaningless');
    assert.gt(STEALTH.VIEW_CONE_DEG, 0, 'a guard that cannot see is not a guard');
    assert.equal(viewConeFactor(179), 0, 'directly behind must always be safe');
  });

  test('detection range spans exactly DETECT_RANGE_MIN to DETECT_RANGE_MAX', () => {
    assert.close(effectiveDetectRange(0), STEALTH.DETECT_RANGE_MIN, 1e-9);
    assert.close(effectiveDetectRange(1), STEALTH.DETECT_RANGE_MAX, 1e-9);
  });

  test('detection range is monotonic in exposure and shorter at night', () => {
    let prev = -1;
    for (let i = 0; i <= 20; i++) {
      const e = i / 20;
      const day = effectiveDetectRange(e, false);
      const night = effectiveDetectRange(e, true);
      assert.gte(day, prev - 1e-12, 'range fell as exposure rose');
      prev = day;
      assert.lt(night, day, `night must be shorter than day at exposure ${e}`);
    }
  });

  test('full exposure is spotted in DETECT_TIME_DAY, and darkness takes longer', () => {
    assert.close(detectTimeFor(1, false), STEALTH.DETECT_TIME_DAY, 1e-9);
    assert.close(detectTimeFor(1, true), STEALTH.DETECT_TIME_NIGHT, 1e-9);
    assert.gt(STEALTH.DETECT_TIME_NIGHT, STEALTH.DETECT_TIME_DAY);
    assert.close(detectTimeFor(0.5, false), STEALTH.DETECT_TIME_DAY / 0.5, 1e-9,
      'half exposure must take twice as long');
  });

  test('zero exposure is never spotted, however long you wait', () => {
    assert.equal(detectTimeFor(0), Infinity,
      'a fully hidden player must not be spotted by standing still long enough');
    assert.equal(detectTimeFor(NaN), Infinity);
    assert.equal(detectTimeFor(-1), Infinity);
  });

  test('noise is silent beyond its radius and total at its source', () => {
    assert.equal(noiseAudibility(STEALTH.NOISE_SILENT, 1), 0);
    assert.equal(noiseAudibility(0, 0), 0);
    assert.equal(noiseAudibility(10, 20), 0, 'a sound must not carry past its declared radius');
    assert.close(noiseAudibility(10, 0), 1, 1e-9);
  });

  test('noise falls off monotonically with distance', () => {
    let prev = Infinity;
    for (let d = 0; d <= 12; d += 0.5) {
      const a = noiseAudibility(STEALTH.NOISE_RUN, d);
      assert.lte(a, prev + 1e-12, `audibility rose with distance at ${d} m`);
      prev = a;
    }
    assert.equal(noiseAudibility(STEALTH.NOISE_RUN, STEALTH.NOISE_RUN + 0.01), 0);
  });

  test('rain and storms mask footsteps — a real stealth tool, not flavour', () => {
    const d = 4;
    const clear = noiseAudibility(STEALTH.NOISE_RUN, d, 'clear');
    const rain = noiseAudibility(STEALTH.NOISE_RUN, d, 'rain');
    const storm = noiseAudibility(STEALTH.NOISE_RUN, d, 'storm');
    assert.close(rain, clear * STEALTH.AMBIENT_MASK_RAIN, 1e-9);
    assert.close(storm, clear * STEALTH.AMBIENT_MASK_STORM, 1e-9);
    assert.lt(storm, rain, 'a storm must mask more than rain');
    assert.lt(rain, clear, 'rain must mask something');
  });

  test('the noise table is ordered so louder actions carry further', () => {
    const ordered = [
      STEALTH.NOISE_SILENT, STEALTH.NOISE_CROUCH_WALK, STEALTH.NOISE_WALK,
      STEALTH.NOISE_RUN, STEALTH.NOISE_SPRINT,
    ];
    for (let i = 1; i < ordered.length; i++) {
      assert.gt(ordered[i], ordered[i - 1],
        'the movement noise ladder is not monotonic, so sprinting could be quieter than walking');
    }
    assert.gt(STEALTH.NOISE_SHOUT, STEALTH.NOISE_SPRINT, 'a shout must carry further than a sprint');
    assert.gt(STEALTH.NOISE_COMBAT_HIT, STEALTH.NOISE_RUN,
      'a fight must be audible further than a run, or combat could stay secret');
  });

  test('perceptionProbe explains every gate, so a refusal is debuggable', () => {
    const g = guard({ noNav: true, yaw: 0 });
    const probe = (t) => perceptionProbe(g, t);
    assert.equal(probe(truth(0, 5)).reason, 'visible');
    assert.equal(probe(truth(0, -5)).reason, 'outside-cone', 'behind the guard');
    assert.equal(probe(null).reason, 'no-truth');
    assert.equal(probe({}).reason, 'no-truth');
    const high = truth(0, 5, { y: 6 });
    assert.equal(probe(high).reason, 'vertical', 'a player on a roof is out of the vertical band');
    const far = truth(0, 5);
    far.playerPos = new Vec3(NaN, 0, 5);
    assert.equal(probe(far).reason, 'non-finite');
  });

  test('perceptionProbe reports out-of-range for a hidden body at distance', () => {
    const g = guard({ noNav: true, yaw: 0 });
    const p = perceptionProbe(g, truth(0, 12, {
      stance: 'crouch', inShadow: true, lightLevel: STEALTH.LIGHT_EXPOSURE_NIGHT, isNight: true,
    }));
    assert.equal(p.reason, 'out-of-range');
    assert.notOk(p.visible);
    assert.lt(p.range, p.distance, 'the probe must show why: range below distance');
  });
});

/* ========================================================= agent memory */

describe('agent memory is a copy, not a wire to the player', () => {
  test('a new memory is empty and not fresh', () => {
    const m = new AgentMemory();
    assert.equal(m.lastKnownPos, null);
    assert.notOk(m.fresh);
    assert.equal(m.decayedConfidence, 0);
  });

  test('noteSighting COPIES the position — mutating the player does not move it', () => {
    // This is the structural no-cheat guarantee. If the memory held a reference
    // to the player's live Vec3, every "last known position" in the game would
    // silently track the player forever and the whole stealth layer would be
    // decoration. Copying is what makes a guard walk to where you WERE.
    const m = new AgentMemory();
    const live = new Vec3(1, 0, 2);
    m.noteSighting(live);
    live.x = 99; live.z = 99;
    assert.equal(m.lastKnownPos.x, 1, 'the memory followed the player — it is holding a reference');
    assert.equal(m.lastKnownPos.z, 2);
    assert.notEqual(m.lastKnownPos, live, 'the memory must not alias the source vector');
  });

  test('a memory ages and expires at MEMORY_DURATION', () => {
    const m = new AgentMemory();
    m.noteSighting(new Vec3(0, 0, 5));
    assert.ok(m.fresh);
    m.update(STEALTH.MEMORY_DURATION * 0.9);
    assert.ok(m.fresh, 'a memory expired early');
    m.update(STEALTH.MEMORY_DURATION * 0.2);
    assert.notOk(m.fresh, 'a memory older than MEMORY_DURATION must be gone');
    assert.equal(m.lastKnownPos, null);
  });

  test('confidence decays with age, so an old sighting is a guess', () => {
    const m = new AgentMemory();
    m.noteSighting(new Vec3(0, 0, 5), 1);
    const now = m.decayedConfidence;
    m.update(STEALTH.MEMORY_DURATION * 0.5);
    const later = m.decayedConfidence;
    assert.close(now, 1, 1e-9);
    assert.lt(later, now, 'confidence must fall as the memory ages');
    assert.gt(later, 0, 'a half-aged memory should still mean something');
  });

  test('a heard position is trusted less than a seen one', () => {
    const seen = new AgentMemory().noteSighting(new Vec3(0, 0, 5));
    const heard = new AgentMemory().noteNoise(new Vec3(0, 0, 5));
    assert.ok(seen.sawTarget);
    assert.notOk(heard.sawTarget);
    assert.gt(seen.confidence, heard.confidence,
      'sound gives a place to look, not a person to shoot at');
  });

  test('memory survives a save/load round trip', () => {
    const m = new AgentMemory();
    m.noteSighting(new Vec3(3.5, 1.25, -7.75), 0.8);
    m.update(4);
    const copy = new AgentMemory().restore(m.serialize());
    assert.close(copy.lastKnownPos.x, 3.5, 1e-9);
    assert.close(copy.lastKnownPos.z, -7.75, 1e-9);
    assert.close(copy.age, m.age, 1e-9);
    assert.close(copy.confidence, 0.8, 1e-9);
    assert.equal(copy.sawTarget, true);
  });

  test('memory survives hostile save data', () => {
    const junk = [null, undefined, {}, { lastKnownPos: 'nope', age: NaN, confidence: 99 },
      { lastKnownPos: [1, 2], age: -5 }, { lastKnownPos: [NaN, 0, 0] }];
    for (const j of junk) {
      const m = new AgentMemory();
      assert.doesNotThrow(() => m.restore(j), `restore threw on ${JSON.stringify(j)}`);
      assert.ok(m.lastKnownPos === null || m.lastKnownPos.isFiniteVec(),
        `restore produced a non-finite position from ${JSON.stringify(j)}`);
      assert.gte(m.confidence, 0);
      assert.lte(m.confidence, 1);
    }
  });
});

/* =================================================== group coordination */

describe('group coordination caps how many enemies attack at once', () => {
  test('slots default to the declared GROUP_ATTACK_SLOTS', () => {
    assert.equal(new GroupCoordinator().slots, AI.GROUP_ATTACK_SLOTS);
    assert.gte(AI.GROUP_ATTACK_SLOTS, 1, 'zero slots would make enemies unable to fight');
    assert.lt(AI.GROUP_ATTACK_SLOTS, 6,
      'if most of a group can attack at once the cap is decoration');
  });

  test('the request past the cap is refused', () => {
    const c = new GroupCoordinator(2);
    assert.ok(c.request('a'));
    assert.ok(c.request('b'));
    assert.notOk(c.request('c'), 'a third simultaneous attacker must be refused');
    assert.equal(c.inUse, 2);
    assert.equal(c.available, 0);
    assert.equal(c.telemetry.refused, 1);
  });

  test('an existing holder keeps its slot without consuming another', () => {
    const c = new GroupCoordinator(2);
    c.request('a');
    assert.ok(c.request('a'), 're-requesting must refresh, not fail');
    assert.equal(c.inUse, 1, 'one agent must not occupy two slots');
    assert.ok(c.request('b'));
  });

  test('a slot expires after GROUP_SLOT_RELEASE_TIME', () => {
    const c = new GroupCoordinator(1);
    c.request('a');
    assert.notOk(c.request('b'));
    c.update(AI.GROUP_SLOT_RELEASE_TIME * 0.9);
    assert.equal(c.inUse, 1, 'the slot expired early');
    c.update(AI.GROUP_SLOT_RELEASE_TIME * 0.2);
    assert.equal(c.inUse, 0, 'a stalled attacker must not hold a slot forever');
    assert.ok(c.request('b'), 'the freed slot must be usable');
    assert.equal(c.telemetry.expired, 1);
  });

  test('release frees a slot immediately', () => {
    const c = new GroupCoordinator(1);
    c.request('a');
    assert.ok(c.release('a'));
    assert.equal(c.inUse, 0);
    assert.ok(c.request('b'));
  });

  test('a hostile crowd never exceeds the cap, even over a long fight', () => {
    // The property that matters: not that request() can refuse, but that a real
    // group of enemies fighting for a while never exceeds the cap.
    const squad = new AISquad({ coordinator: new GroupCoordinator(AI.GROUP_ATTACK_SLOTS) });
    for (let i = 0; i < 6; i++) {
      squad.add({ id: `e${i}`, pos: new Vec3(Math.cos(i) * 1.4, 0, Math.sin(i) * 1.4) });
    }
    let worst = 0;
    for (let f = 0; f < 1800; f++) {
      for (const a of squad.agents) if (a._hasAttackSlot()) worst = Math.max(worst, squad.coordinator.inUse);
      squad.update(1 / 60, truth(0, 0));
      squad.coordinator.update(1 / 60);
    }
    assert.lte(squad.coordinator.inUse, AI.GROUP_ATTACK_SLOTS,
      `${squad.coordinator.inUse} agents held slots at once, cap is ${AI.GROUP_ATTACK_SLOTS}`);
    assert.lte(worst, AI.GROUP_ATTACK_SLOTS, `the cap was exceeded mid-fight (worst ${worst})`);
  });

  test('coordinator state survives a save/load round trip', () => {
    const c = new GroupCoordinator(3);
    c.request('a'); c.request('b');
    c.update(0.5);
    const copy = new GroupCoordinator().restore(c.serialize());
    assert.equal(copy.slots, 3);
    assert.equal(copy.inUse, 2);
    assert.ok(copy.holds('a'));
  });

  test('a junk slot count cannot produce zero slots', () => {
    for (const bad of [0, -5, NaN, undefined, null, 1.7, 'x']) {
      const c = new GroupCoordinator(bad);
      assert.gte(c.slots, 1, `slots became ${c.slots} from ${String(bad)}`);
      assert.ok(Number.isInteger(c.slots), 'slots must be a whole number');
    }
  });
});

/* ============================================== perception in a real agent */

describe('an agent perceives through the model, not through the player', () => {
  test('a guard facing away never spots a fully exposed player', () => {
    const g = guard({ noNav: true, yaw: Math.PI });   // faces -Z
    drive(g, truth(0, 6), 600);                        // player at +Z: behind it
    assert.equal(g.telemetry.sightings, 0);
    assert.notOk(g.memory.fresh);
    assert.equal(g.suspicion, 0, 'a guard spotted the player through the back of its own head');
    assert.notOk(g.isHostile);
  });

  test('a fully exposed player is spotted in the declared detection time', () => {
    const g = guard({ noNav: true, yaw: 0 });
    const exposure = STEALTH.LIGHT_EXPOSURE_DAY;      // what truth() feeds in
    let spottedFrame = -1;
    for (let f = 0; f < 600; f++) {
      g.update(1 / 60, truth(0, 6));
      if (spottedFrame < 0 && g.suspicion >= STEALTH.SUSPICION_COMBAT_THRESHOLD) spottedFrame = f;
    }
    assert.gt(spottedFrame, 0, 'the guard was fully hostile on frame 0 — perception has no cost');
    // Suspicion fills SUSPICION_MAX in detectTimeFor(exposure), so it crosses the
    // combat band at that time scaled by the band's fraction of the maximum.
    const expected = detectTimeFor(exposure, false)
      * (STEALTH.SUSPICION_COMBAT_THRESHOLD / STEALTH.SUSPICION_MAX);
    assert.close(spottedFrame / 60, expected, 2 / 60 + 1e-6,
      `spotted after ${spottedFrame / 60}s, the declared model says ${expected.toFixed(3)}s`);
  });

  test('a dimly lit player takes proportionally longer to spot', () => {
    const bright = guard({ noNav: true, yaw: 0 });
    const dim = guard({ noNav: true, yaw: 0 });
    const cross = (g, t) => {
      for (let f = 0; f < 3000; f++) {
        g.update(1 / 60, t);
        if (g.suspicion >= STEALTH.SUSPICION_COMBAT_THRESHOLD) return f / 60;
      }
      return Infinity;
    };
    const tb = cross(bright, truth(0, 6, { lightLevel: 1 }));
    const td = cross(dim, truth(0, 6, { lightLevel: 0.25 }));
    assert.finite(tb, 'a fully lit player was never spotted');
    assert.finite(td, 'a dimly lit player was never spotted');
    assert.close(td / tb, 1 / 0.25, 0.15,
      `a quarter of the light took ${(td / tb).toFixed(2)}x as long; the model says 4x`);
  });

  test('hostility is delayed by REACTION_TIME, never granted on the sight frame', () => {
    const g = guard({ noNav: true, yaw: 0 });
    let hostileFrame = -1;
    let seenFrame = -1;
    for (let f = 0; f < 900; f++) {
      g.update(1 / 60, truth(0, 6));
      if (seenFrame < 0 && g.memory.sawTarget) seenFrame = f;
      if (hostileFrame < 0 && g.isHostile) hostileFrame = f;
    }
    assert.gt(seenFrame, -1, 'the guard never saw an exposed player 6 m in front of it');
    assert.gt(hostileFrame, seenFrame,
      'the guard became hostile on the same frame it perceived — humans are not instant');
    const delay = (hostileFrame - seenFrame) / 60;
    assert.gte(delay, AI.REACTION_TIME_MIN * 0.9,
      `reaction took ${delay.toFixed(3)} s, declared minimum ${AI.REACTION_TIME_MIN} s`);
  });

  test('a crouching player in shadow at range is never spotted', () => {
    const g = guard({ noNav: true, yaw: 0 });
    drive(g, truth(0, 11, {
      stance: 'crouch', inShadow: true,
      lightLevel: STEALTH.LIGHT_EXPOSURE_NIGHT, isNight: true,
    }), 900);
    assert.equal(g.telemetry.sightings, 0, 'a hidden player was spotted — stealth is decoration');
    assert.equal(g.suspicion, 0);
    assert.equal(g.state, AIState.IDLE);
  });

  test('the same player is spotted when they stand up in the light', () => {
    const hidden = truth(0, 11, {
      stance: 'crouch', inShadow: true,
      lightLevel: STEALTH.LIGHT_EXPOSURE_NIGHT, isNight: true,
    });
    const exposed = truth(0, 11, { stance: 'stand', lightLevel: 1 });
    const a = guard({ noNav: true, yaw: 0 });
    const b = guard({ noNav: true, yaw: 0 });
    drive(a, hidden, 900);
    drive(b, exposed, 900);
    assert.equal(a.telemetry.sightings, 0);
    assert.gt(b.telemetry.sightings, 0,
      'standing in the light at the same spot must be spotted — otherwise exposure does nothing');
  });

  test('a wall blocks sight even at point-blank range', () => {
    const cw = flatWorld({ wall: { half: 20, height: 3.4 } });
    const g = guard({ noNav: true, yaw: 0, collision: cw });
    drive(g, truth(0, 6), 600);                 // wall at z=3, player at z=6
    assert.equal(g.telemetry.sightings, 0, 'the guard saw through a wall');
    assert.notOk(g.memory.fresh);
    const probe = perceptionProbe(g, truth(0, 6));
    assert.equal(probe.reason, 'no-line-of-sight');
  });

  test('stepping out from behind the wall is spotted', () => {
    const cw = flatWorld({ wall: { half: 20, height: 3.4 } });
    const g = guard({ noNav: true, yaw: 0, collision: cw });
    drive(g, truth(0, 6), 300);
    assert.equal(g.telemetry.sightings, 0);
    drive(g, truth(0, 1.5), 300);               // now on the guard's side
    assert.gt(g.telemetry.sightings, 0, 'a player who walked around the wall was not seen');
  });

  test('sprinting is heard from further away than crouch-walking', () => {
    const far = STEALTH.NOISE_CROUCH_WALK + 1.5;   // beyond a crouch-walk, inside a sprint
    // Both guards face AWAY (yaw 0 = +Z, the player is at -Z), and the idle scan
    // only sweeps inside their own cone. If they could see the player they would
    // walk over, close inside the crouch-walk radius, and start hearing it
    // legitimately - which is what made the first version of this test fail while
    // measuring nothing about noise at all.
    const quiet = guard({ noNav: true, yaw: 0 });
    const loud = guard({ noNav: true, yaw: 0 });
    drive(quiet, truth(0, -far, { stance: 'crouch', speed: MOVE.CROUCH_SPEED, noiseRadius: STEALTH.NOISE_CROUCH_WALK }), 300);
    drive(loud, truth(0, -far, { stance: 'stand', speed: MOVE.SPRINT_SPEED, noiseRadius: STEALTH.NOISE_SPRINT }), 300);
    assert.equal(quiet.telemetry.sightings, 0, 'the rig let the guard see the player');
    assert.equal(quiet.telemetry.hearings, 0, 'a crouch-walk was heard outside its declared radius');
    assert.gt(loud.telemetry.hearings, 0, 'a sprint was not heard inside its declared radius');
    assert.gt(loud.suspicion, quiet.suspicion,
      'noise must raise suspicion, or sprinting carries no risk');
  });

  test('a noise behind the guard still creates something to investigate', () => {
    const g = guard({ noNav: true, yaw: 0 });
    drive(g, truth(0, -4, { noiseRadius: STEALTH.NOISE_RUN }), 300);
    assert.equal(g.telemetry.sightings, 0, 'it heard the noise but must not have SEEN anything');
    assert.gt(g.telemetry.hearings, 0);
    assert.ok(g.memory.fresh, 'a heard noise must give the guard somewhere to walk to');
    assert.notOk(g.memory.sawTarget, 'a noise must not be recorded as a sighting');
    assert.gt(g.suspicion, 0);
  });

  test('suspicion decays once the player is gone, after the declared delay', () => {
    const g = guard({ noNav: true, yaw: 0 });
    drive(g, truth(0, 6), 240);
    const peak = g.suspicion;
    assert.gt(peak, 20, 'the rig did not build any suspicion');
    drive(g, truth(0, -60, { stance: 'crouch', lightLevel: 0 }), 60);
    const held = g.suspicion;
    assert.close(held, peak, 1e-9,
      'suspicion decayed before SUSPICION_DECAY_DELAY elapsed');
    drive(g, truth(0, -60, { stance: 'crouch', lightLevel: 0 }), 600);
    assert.lt(g.suspicion, held, 'suspicion never decayed, so an alert lasts forever');
  });
});

/* ================================================== the no-cheat property */

describe('the AI cannot use what it has not perceived', () => {
  test('a guard navigates to where it LAST SAW the player, not to where they are', () => {
    // The single most important assertion in this suite.
    const g = guard({ yaw: 0, wall: false });
    drive(g, truth(0, 6), 120);                 // sees the player at +Z
    assert.ok(g.memory.fresh && g.memory.sawTarget, 'the rig did not establish a sighting');
    const remembered = g.memory.lastKnownPos.clone();
    assert.close(remembered.z, 6, 1e-6);

    // The player now teleports behind the guard, out of every cone. The guard has
    // no way to know. It must keep going to +Z.
    const hidden = truth(0, -30);
    const probe = perceptionProbe(g, hidden);
    assert.notOk(probe.visible, 'the rig left the player visible');
    drive(g, hidden, 120);

    assert.gt(g.pos.z, 0.5,
      `the guard moved to z=${g.pos.z.toFixed(2)} — it tracked a player it cannot perceive`);
    assert.close(g.memory.lastKnownPos.z, remembered.z, 1e-6,
      'the memory moved without a new perception');
    assert.gt(g.objective.distanceXZ(hidden.playerPos), 20,
      'the steering objective is the player, not the memory');
  });

  test('the objective is always the memory or a patrol point, never the truth', () => {
    const g = guard({ yaw: 0, wall: false });
    const t = truth(0, 40);
    drive(g, t, 30);
    const obj = g.objective;
    if (obj) {
      assert.lt(obj.distanceXZ(g.memory.lastKnownPos ?? obj), 1e-6,
        'the steering objective is not the remembered position');
    }
    // With no memory at all, a posted guard falls back to its home, not to the
    // player: it must not wander toward someone it has never perceived.
    const idle = guard({ yaw: Math.PI, wall: false, noNav: true });
    drive(idle, truth(0, 30), 60);
    assert.ok(idle.objective === null || idle.objective.distanceXZ(idle.home) < 1e-6,
      'an unaware guard steered toward the player');
  });

  test('a guard swings at empty air when the player steps aside during the windup', () => {
    // The AI is allowed to be wrong. This proves it can be.
    const g = guard({ yaw: 0, wall: false, noNav: true });
    drive(g, truth(0, 1.6), 240);
    assert.ok(g.isHostile, 'the rig did not make the guard hostile');
    assert.ok(g.state === AIState.ATTACK || g.state === AIState.CIRCLE,
      `expected ATTACK/CIRCLE at 1.6 m, got ${g.state}`);
    const before = g.telemetry.attacks;

    // The player vanishes from every cone but the memory is still fresh and still
    // says 1.6 m — so the guard commits, and resolveMelee fairly misses.
    const gone = truth(-9, -9);
    assert.notOk(perceptionProbe(g, gone).visible);
    let swings = 0;
    const player = new PlayerController({ collision: flatWorld(), pos: new Vec3(-9, 0, -9) });
    for (let f = 0; f < 240; f++) {
      g.update(1 / 60, gone);
      if (g.body.swing.phase === SwingPhase.ACTIVE && !g.body.swing.hitConsumed) {
        swings++;
        const r = g.body.swing.hitConsumed ? null : resolveFor(g, player);
        if (r) assert.notEqual(r.outcome, 'hit', 'the guard hit a player it could not perceive');
      }
    }
    assert.gt(g.telemetry.attacks, before, 'the guard never committed to the stale memory');
    assert.close(player.health, player.maxHealth, 1e-12,
      'the player took damage from a guard that had no idea where they were');
    void swings;
  });

  test('an enemy’s top speed is RUN_SPEED, never SPRINT_SPEED', () => {
    const g = guard({ wall: false });
    assert.close(g.maxSpeed, MOVE.RUN_SPEED, 1e-9);
    assert.lt(g.maxSpeed, MOVE.SPRINT_SPEED,
      'if the AI can outsprint the player, disengaging is impossible and every alert is a forced fight');
    drive(g, truth(0, 20), 300);
    assert.lte(g.speedPlanar, MOVE.RUN_SPEED + 1e-9,
      `an enemy reached ${g.speedPlanar.toFixed(3)} m/s, above RUN_SPEED`);
  });

  test('a save file cannot grant the AI a speed it was not built with', () => {
    const g = guard({ wall: false, noNav: true });
    g.restore({ maxSpeed: 999 });
    assert.lte(g.maxSpeed, MOVE.RUN_SPEED,
      'a tampered or corrupted save gave the AI superhuman speed');
    g.restore({ maxSpeed: NaN });
    assert.close(g.maxSpeed, MOVE.RUN_SPEED, 1e-9, 'a NaN speed survived a restore');
  });

  test('a guard never ends a frame inside geometry, in a region with a wall', () => {
    const cw = flatWorld({ wall: { half: 6, height: 3.4 } });
    const nav = makeNav(cw);
    const g = guard({ yaw: 0, collision: cw, nav, wall: false });
    const t = truth(0, 12);                     // on the far side of the wall
    let violations = 0;
    let worstWhere = null;
    for (let f = 0; f < 1800; f++) {
      g.update(1 / 60, t);
      if (!cw.isSpaceFree(g.pos, MOVE.CAPSULE_RADIUS, MOVE.CAPSULE_HEIGHT)) {
        violations++;
        if (!worstWhere) worstWhere = `frame ${f} at ${g.pos.toArray().map(n => n.toFixed(2)).join(',')}`;
      }
      assert.ok(g.pos.isFiniteVec(), `the guard position went non-finite at frame ${f}`);
    }
    assert.equal(violations, 0,
      `the guard was inside geometry on ${violations} frames, first at ${worstWhere} — an enemy that walks through walls is cheating`);
  });

  test('a guard routes AROUND a wall rather than grinding into it', () => {
    const cw = flatWorld({ wall: { half: 6, height: 3.4 } });
    const nav = makeNav(cw);
    // Path with the clock disabled. The tactical budget is a WALL-CLOCK ceiling, so
    // on a loaded machine every query can miss it and the guard steers into the wall
    // having never been handed a route - which made this test fail under `run.sh`
    // while passing on its own. Machine speed is a performance property and is
    // measured by the budget tests; this one is about the routing decision, and with
    // the clock off `pathFailures === 0` below means what it says: no navigation
    // failure, rather than "the machine happened to be fast".
    const g = guard({ yaw: 0, collision: cw, nav, wall: false, pathTimeBudgetMs: 0 });
    // The wall blocks sight, so this must not rely on spotting the player: give
    // the guard a known position to reach, as an alarm or a shout would.
    forceSuspicion(g, STEALTH.SUSPICION_COMBAT_THRESHOLD + 1, new Vec3(0, 0, 12));
    drive(g, truth(0, 12), 2400);               // 40 s to walk around
    assert.gt(g.telemetry.paths, 0, 'the guard never asked for a path');
    assert.gt(g.pos.z, 3.6,
      `after 40 s the guard only reached z=${g.pos.z.toFixed(2)} — it never got past the wall`);
    assert.equal(g.telemetry.pathFailures, 0,
      `${g.telemetry.pathFailures} path queries failed — a guard that cannot get a route steers into the wall instead`);
    assert.lt(g.telemetry.stuckEvents, 12,
      `${g.telemetry.stuckEvents} stuck events: the guard is grinding into the wall instead of routing around it`);
  });

  test('a starved path budget keeps retrying instead of giving up on the target', () => {
    // The other half of the same concern. A wall-clock ceiling WILL be missed on a
    // loaded machine, so the degraded path is real gameplay and not a test artifact.
    // What must not happen is the agent treating a budget miss as "unreachable":
    // that discards the route and is how a chase ends with a guard standing still.
    const cw = flatWorld({ wall: { half: 6, height: 3.4 } });
    const nav = makeNav(cw);
    const starved = guard({ yaw: 0, collision: cw, nav, wall: false, pathTimeBudgetMs: 0.0001 });
    forceSuspicion(starved, STEALTH.SUSPICION_COMBAT_THRESHOLD + 1, new Vec3(0, 0, 12));
    drive(starved, truth(0, 12), 600);

    assert.gt(starved.telemetry.paths, 0, 'the agent never asked for a path');
    assert.gt(starved.telemetry.pathFailures, 0,
      'a 0.0001 ms ceiling should have been missed - the rig is not exercising the degraded path');
    assert.ok(starved.pos.isFiniteVec(), 'the agent position went non-finite while starved');

    // It kept asking for the whole window instead of concluding after the first
    // refusal that the target was unreachable. Queries run on the repath cadence, so
    // ten seconds is worth roughly thirty of them.
    assert.gte(starved.telemetry.paths, 10,
      `only ${starved.telemetry.paths} queries in 10 s - the agent gave up after being refused`);
    assert.gte(starved.telemetry.pathFailures, 10,
      `only ${starved.telemetry.pathFailures} refusals recorded against ${starved.telemetry.paths} queries`);

    // Reminded of the target, it asks again. Ten seconds of not seeing anyone decays
    // suspicion and the guard rightly loses interest, so this is a fresh sighting
    // rather than a continuation - the point is that a budget miss left nothing
    // latched that stops it ever routing again.
    forceSuspicion(starved, STEALTH.SUSPICION_COMBAT_THRESHOLD + 1, new Vec3(0, 0, 12));
    const asked = starved.telemetry.paths;
    drive(starved, truth(0, 12), 120);
    assert.gt(starved.telemetry.paths, asked,
      'the agent never asked for a route again after its queries were refused');
  });

  test('an enemy’s hit on the player uses the shared resolver and the enemy numbers', () => {
    const g = guard({ yaw: 0, wall: false, noNav: true });
    assert.equal(g.body.side, Side.ENEMY, 'an agent’s body must be on the enemy side');
    const player = new PlayerController({ collision: flatWorld(), pos: new Vec3(0, 0, 1.5) });
    player.yaw = Math.PI;                        // face the guard
    g.body.pos.set(0, 0, 0);
    forceSuspicion(g, STEALTH.SUSPICION_MAX, new Vec3(0, 0, 1.5));
    drive(g, truth(0, 1.5), 120);
    assert.ok(g.isHostile, 'the rig did not make the guard hostile');

    const before = player.health;
    let hitFor = -1;
    for (let f = 0; f < 900 && hitFor < 0; f++) {
      g.update(1 / 60, truth(0, 1.5));
      if (g.body.swing.phase === SwingPhase.ACTIVE && !g.body.swing.hitConsumed) {
        const r = resolveFor(g, player);
        if (r && r.outcome === 'hit') hitFor = r.applied;
      }
      player.hitIframes = 0;                     // isolate the damage number
    }
    assert.gt(hitFor, 0, 'the guard never landed a hit on a player standing in front of it');
    assert.ok(
      Math.abs(hitFor - COMBAT.ENEMY_LIGHT_DAMAGE) < 1e-6
      || Math.abs(hitFor - COMBAT.ENEMY_HEAVY_DAMAGE) < 1e-6,
      `an enemy hit for ${hitFor}; declared enemy damage is ${COMBAT.ENEMY_LIGHT_DAMAGE}/${COMBAT.ENEMY_HEAVY_DAMAGE}`);
    assert.lt(before - player.health, COMBAT.ENEMY_HEAVY_DAMAGE + 1e-6);
  });

  test('an enemy attack costs the same declared stamina as a player attack', () => {
    const g = guard({ wall: false, noNav: true });
    g.body.stamina = MOVE.STAMINA_MAX;
    assert.ok(g.body.startAttack('light'));
    assert.close(MOVE.STAMINA_MAX - g.body.stamina, COMBAT.ATTACK_STAMINA_LIGHT, 1e-9);
    const p = new PlayerController({ collision: flatWorld(), pos: new Vec3(0, 0, 0) });
    assert.ok(p.startAttack('light'));
    assert.close(p.maxStamina - p.stamina, COMBAT.ATTACK_STAMINA_LIGHT, 1e-9,
      'the same attack must cost the same on both sides');
  });

  test('an exhausted enemy cannot attack — stamina is a real constraint for the AI too', () => {
    const g = guard({ wall: false, noNav: true });
    g.body.stamina = 0;
    assert.notOk(g.body.startAttack('light'));
    assert.equal(g.body.telemetry.attacks, 0);
    forceSuspicion(g, STEALTH.SUSPICION_MAX, new Vec3(0, 0, 1.5));
    // Stamina is pinned at zero every frame. Simply setting it once would prove
    // nothing: regeneration refills it inside a second and the enemy attacks
    // legitimately, so the test would turn on the regen rate rather than on the
    // constraint it claims to check.
    for (let f = 0; f < 240; f++) {
      g.body.stamina = 0;
      g.update(1 / 60, truth(0, 1.5));
    }
    assert.equal(g.telemetry.attacks, 0,
      'an exhausted enemy attacked anyway — that is a resource the player has to manage but the AI does not');
    assert.ok(g.isHostile, 'the rig did not keep the enemy hostile, so it proved nothing');
    g.body.stamina = MOVE.STAMINA_MAX;
    drive(g, truth(0, 1.5), 120);
    assert.gt(g.telemetry.attacks, 0, 'the same enemy still could not attack once its stamina returned');
  });

  test('only GROUP_ATTACK_SLOTS enemies actually swing in a six-enemy group', () => {
    const squad = new AISquad({});
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2;
      squad.add({ id: `e${i}`, pos: new Vec3(Math.sin(angle) * 1.6, 0, Math.cos(angle) * 1.6) });
    }
    for (const a of squad.agents) forceSuspicion(a, STEALTH.SUSPICION_MAX, new Vec3(0, 0, 0));
    // Counted by STATE, not by swing.busy: an agent that has spent its slot and
    // is still finishing the recovery of one swing is not attacking, and counting
    // it would make the cap look violated by an animation tail.
    let maxAttacking = 0;
    let framesWithAttack = 0;
    for (let f = 0; f < 1200; f++) {
      squad.update(1 / 60, truth(0, 0));
      const attacking = squad.agents.filter(a => a.state === AIState.ATTACK).length;
      if (attacking > 0) framesWithAttack++;
      if (attacking > maxAttacking) maxAttacking = attacking;
    }
    assert.gt(framesWithAttack, 0, 'no enemy ever attacked — the rig proved nothing');
    assert.lte(maxAttacking, AI.GROUP_ATTACK_SLOTS,
      `${maxAttacking} enemies attacked at once; the cap is ${AI.GROUP_ATTACK_SLOTS}. Without the cap a group deals N times the declared damage per second, which is not "harder", it is unreadable`);
    const totalSwings = squad.agents.reduce((n, a) => n + a.telemetry.attacks, 0);
    assert.gt(totalSwings, AI.GROUP_ATTACK_SLOTS,
      'the cap prevented anyone but the first two from ever fighting');
  });

  test('a dead enemy releases its attack slot instead of blocking the living', () => {
    const squad = new AISquad({});
    const a = squad.add({ id: 'a', pos: new Vec3(0, 0, 1.4) });
    squad.add({ id: 'b', pos: new Vec3(1.4, 0, 0) });
    squad.coordinator.slots = 1;
    assert.ok(squad.coordinator.request('a'));
    assert.notOk(squad.coordinator.request('b'), 'the rig did not fill the single slot');
    a.onDeath('test');
    squad.update(1 / 60, truth(0, 0));
    assert.notOk(squad.coordinator.holds('a'), 'a corpse is holding an attack slot');
    assert.ok(squad.coordinator.request('b'), 'the living enemy could not take the freed slot');
  });

  test('agents do not stack: separation keeps a group spread out', () => {
    const squad = new AISquad({});
    for (let i = 0; i < 5; i++) squad.add({ id: `e${i}`, pos: new Vec3(i * 0.2, 0, 0) });
    for (const a of squad.agents) forceSuspicion(a, STEALTH.SUSPICION_MAX, new Vec3(0, 0, 14));
    drive(squad, truth(0, 14), 600);
    let minPair = Infinity;
    for (let i = 0; i < squad.agents.length; i++) {
      for (let j = i + 1; j < squad.agents.length; j++) {
        const d = squad.agents[i].pos.distanceXZ(squad.agents[j].pos);
        if (d < minPair) minPair = d;
      }
    }
    // Differential: the same group with separation disabled. An absolute
    // threshold would pass or fail on the walk speed and the frame count rather
    // than on whether separation does anything at all.
    const loose = new AISquad({});
    for (let i = 0; i < 5; i++) loose.add({ id: `e${i}`, pos: new Vec3(i * 0.2, 0, 0) });
    for (const a of loose.agents) {
      forceSuspicion(a, STEALTH.SUSPICION_MAX, new Vec3(0, 0, 14));
      a._separation = () => new Vec3(0, 0, 0);
    }
    drive(loose, truth(0, 14), 600);
    let minLoose = Infinity;
    for (let i = 0; i < loose.agents.length; i++) {
      for (let j = i + 1; j < loose.agents.length; j++) {
        minLoose = Math.min(minLoose, loose.agents[i].pos.distanceXZ(loose.agents[j].pos));
      }
    }
    assert.gt(minPair, minLoose,
      `separation changed nothing: ${minPair.toFixed(3)} m apart with it, ${minLoose.toFixed(3)} m without. A stacked group attacks from one pixel and the player cannot read who is swinging`);
    assert.gt(minPair, MOVE.CAPSULE_RADIUS * 0.5,
      `two enemies ended ${minPair.toFixed(3)} m apart even with separation on`);
  });
});

/* ------------------------------------------------- helper for the above */

/** Resolve an agent's live swing against a defender through the shared resolver. */
function resolveFor(agent, defender) {
  return resolveMelee(agent.body, defender, agent.body.swing, { source: agent.id });
}

/* ================================================= states and decisions */

describe('decisions and the escalation ladder', () => {
  test('the full ladder runs idle → suspicious → investigate → chase → attack', () => {
    const g = guard({ yaw: 0, wall: false, noNav: true });
    const order = [];
    for (let f = 0; f < 1800; f++) {
      g.update(1 / 60, truth(0, 7));
      const last = order[order.length - 1];
      if (last !== g.state) order.push(g.state);
    }
    const idx = (s) => order.indexOf(s);
    for (const s of [AIState.IDLE, AIState.SUSPICIOUS, AIState.INVESTIGATE, AIState.CHASE, AIState.ATTACK]) {
      assert.gte(idx(s), 0, `the ladder never reached ${s}: saw ${order.join(' → ')}`);
    }
    assert.lt(idx(AIState.SUSPICIOUS), idx(AIState.INVESTIGATE), 'suspicion must precede investigation');
    assert.lt(idx(AIState.INVESTIGATE), idx(AIState.CHASE), 'investigation must precede a chase');
    assert.lt(idx(AIState.CHASE), idx(AIState.ATTACK), 'a chase must precede an attack');
    assert.close(g.pos.distanceXZ(new Vec3(0, 0, 7)), 0, AI.ATTACK_RANGE,
      'the guard attacked from outside its declared range');
  });

  test('a guard escalates through the declared suspicion bands', () => {
    const g = guard({ yaw: Math.PI, wall: false, noNav: true });
    forceSuspicion(g, STEALTH.SUSPICION_ALERT_THRESHOLD + 1, new Vec3(0, 0, 8));
    drive(g, truth(0, -40), 30);
    assert.equal(g.state, AIState.INVESTIGATE,
      `suspicion above ALERT must investigate, got ${g.state}`);

    const h = guard({ yaw: Math.PI, wall: false, noNav: true });
    forceSuspicion(h, STEALTH.SUSPICION_SEARCH_THRESHOLD + 1, new Vec3(0, 0, 8));
    drive(h, truth(0, -40), 30);
    assert.equal(h.state, AIState.SEARCH,
      `suspicion above SEARCH must search, got ${h.state}`);
  });

  test('a badly hurt enemy retreats instead of fighting to the death', () => {
    const g = guard({ yaw: 0, wall: false, noNav: true });
    forceSuspicion(g, STEALTH.SUSPICION_MAX, new Vec3(0, 0, 3));
    drive(g, truth(0, 3), 120);
    assert.ok(g.isHostile, 'the rig did not make the guard hostile');
    g.body.health = g.body.maxHealth * AI.RETREAT_HEALTH_THRESHOLD * 0.5;
    drive(g, truth(0, 3), 60);
    assert.equal(g.state, AIState.RETREAT,
      `an enemy at ${(g.body.healthFraction * 100).toFixed(0)}% health kept fighting`);
    const start = g.pos.clone();
    drive(g, truth(0, 3), 180);
    assert.gt(g.pos.distanceXZ(start), 0.5, 'a retreating enemy did not actually move away');
  });

  test('losing the player drops the guard to SEARCH, then calms it down', () => {
    const g = guard({ yaw: 0, wall: false, noNav: true });
    drive(g, truth(0, 6), 240);
    assert.ok(g.isHostile, 'the rig did not make the guard hostile');
    const hidden = truth(-40, -40, { stance: 'crouch', lightLevel: 0 });
    // Longer than SUSPICION_DECAY_DELAY plus the time to fall below the combat
    // band: suspicion is deliberately HELD for a moment after the target is lost,
    // so a short window would measure the hold and not the decay.
    drive(g, hidden, 420);
    assert.ok([AIState.SEARCH, AIState.INVESTIGATE, AIState.SUSPICIOUS].includes(g.state),
      `a guard that lost its target went to ${g.state}`);
    assert.notOk(g.isHostile, 'a guard with no idea where the player is must stop being hostile');
    drive(g, hidden, 2400);
    assert.lt(g.suspicion, STEALTH.SUSPICION_COMBAT_THRESHOLD,
      'suspicion never fell, so an alert lasts forever and stealth has no reset');
  });

  test('an alarm escalates immediately and ignores the reaction delay', () => {
    const g = guard({ yaw: Math.PI, wall: false, noNav: true });
    g.notify('alarm', { pos: new Vec3(0, 0, -8) });
    assert.equal(g.suspicion, STEALTH.SUSPICION_MAX);
    assert.equal(g.reactionTimer, 0, 'an alarm is not a surprise — it must not be delayed');
    drive(g, truth(0, -8), 30);
    assert.ok(g.isHostile || g.state === AIState.SEARCH,
      `an alarmed guard stayed ${g.state}`);
  });

  test('discovering a corpse is a major escalation', () => {
    const g = guard({ yaw: Math.PI, wall: false, noNav: true });
    const before = g.suspicion;
    g.notify('corpse', { pos: new Vec3(2, 0, -3) });
    assert.close(g.suspicion - before, STEALTH.SUSPICION_CORPSE_GAIN, 1e-9);
    assert.ok(g.memory.fresh, 'a corpse gives the guard somewhere to look');
    assert.gte(g.suspicion, STEALTH.SUSPICION_SEARCH_THRESHOLD,
      'a body on the floor must push a guard past mere curiosity');
  });

  test('a shout propagates only inside ALARM_PROPAGATION_RADIUS', () => {
    const squad = new AISquad({});
    const near = squad.add({ id: 'near', pos: new Vec3(0, 0, 0) });
    const far = squad.add({ id: 'far', pos: new Vec3(0, 0, STEALTH.ALARM_PROPAGATION_RADIUS * 2) });
    squad.notifyAll('shout', { pos: new Vec3(0, 0, 0), radius: STEALTH.ALARM_PROPAGATION_RADIUS });
    assert.gt(near.suspicion, 0, 'a guard next to a shout heard nothing');
    assert.equal(far.suspicion, 0,
      'a shout reached a guard outside its declared radius — the whole map alerts at once');
  });

  test('a staggered enemy perceives but cannot act', () => {
    const g = guard({ yaw: 0, wall: false, noNav: true });
    g.body.applyStagger(StaggerLevel.HEAVY);
    assert.ok(g.body.staggered);
    drive(g, truth(0, 5), 30);
    assert.equal(g.state, AIState.DOWN, 'a staggered enemy kept fighting');
    assert.equal(g.telemetry.attacks, 0, 'a staggered enemy attacked');
    assert.gt(g.telemetry.perceptions, 0, 'being hit must not make an enemy blind');
  });

  test('a dead enemy stops permanently and releases everything', () => {
    const g = guard({ yaw: 0, wall: false, noNav: true });
    g.onDeath('test');
    assert.equal(g.state, AIState.DEAD);
    const pos = g.pos.clone();
    drive(g, truth(0, 4), 300);
    assert.equal(g.state, AIState.DEAD);
    assert.close(g.pos.distanceXZ(pos), 0, 1e-9, 'a corpse moved');
    assert.equal(g.telemetry.attacks, 0, 'a corpse attacked');
  });

  test('stuck detection forces a repath instead of an eternal grind', () => {
    const g = guard({ yaw: 0, wall: false, noNav: true });
    forceSuspicion(g, STEALTH.SUSPICION_MAX, new Vec3(0, 0, 10));
    // Freeze the body so no progress is possible, which is what a bad path looks
    // like from the inside.
    const realMove = g._applyMovement.bind(g);
    g._applyMovement = () => {};
    drive(g, truth(0, 10), 600);
    assert.gt(g.telemetry.stuckEvents, 0,
      'an agent making no progress for 10 s never noticed — this is the guard grinding into a doorframe forever');
    g._applyMovement = realMove;
  });

  test('a patrol route is walked in order and loops', () => {
    const route = [new Vec3(6, 0, 0), new Vec3(6, 0, 6), new Vec3(0, 0, 6), new Vec3(0, 0, 0)];
    const g = guard({ yaw: 0, wall: false, noNav: true, patrol: route });
    assert.equal(g.state, AIState.IDLE);
    drive(g, truth(-50, -50, { stance: 'crouch', lightLevel: 0 }), 30);
    assert.equal(g.state, AIState.PATROL, 'a guard with a route did not patrol');
    const seen = new Set();
    for (let f = 0; f < 3600; f++) {
      g.update(1 / 60, truth(-50, -50, { stance: 'crouch', lightLevel: 0 }));
      seen.add(g.patrolIndex);
    }
    assert.equal(seen.size, route.length,
      `the patrol visited ${seen.size} of ${route.length} waypoints — a guard walking one leg of its route forever is the most visible AI bug there is`);
  });

  test('an agent survives hostile truth samples without going non-finite', () => {
    const g = guard({ yaw: 0, wall: false });
    const junk = [
      {}, null, undefined, { playerPos: null }, { playerPos: new Vec3(NaN, NaN, NaN) },
      { playerPos: new Vec3(1e9, 0, 1e9), stance: 7, speed: NaN, noiseRadius: Infinity },
      { playerPos: new Vec3(0, 0, 3), lightLevel: NaN, weather: 'void' },
    ];
    for (const j of junk) {
      assert.doesNotThrow(() => g.update(1 / 60, j), `update threw on ${JSON.stringify(j)}`);
      assert.ok(g.pos.isFiniteVec(), `a junk truth sample made the position non-finite: ${JSON.stringify(j)}`);
      assert.ok(Number.isFinite(g.suspicion), `suspicion went non-finite on ${JSON.stringify(j)}`);
      assert.ok(Number.isFinite(g.body.health), 'health went non-finite');
      assert.ok(Object.values(AIState).includes(g.state), `state became ${g.state}`);
    }
    for (const bad of [0, -1, NaN, undefined, 1e9]) {
      assert.doesNotThrow(() => g.update(bad, truth(0, 5)), `update threw on dt=${String(bad)}`);
      assert.ok(g.pos.isFiniteVec(), `dt=${String(bad)} made the position non-finite`);
    }
  });
});

/* ============================================ squad, determinism, budget */

describe('the squad, determinism and the frame budget', () => {
  test('makeGuard builds an agent from plain content data', () => {
    const g = makeGuard(
      { id: 'court-1', pos: [3, 0, -4], yaw: 1.2, patrol: [[0, 0, 0], [5, 0, 0], [5, 0, 5]] },
      {},
    );
    assert.equal(g.id, 'court-1');
    assert.close(g.pos.x, 3, 1e-9);
    assert.close(g.pos.z, -4, 1e-9);
    assert.equal(g.patrol.length, 3);
    assert.ok(g.patrol[0] instanceof Vec3, 'patrol points must be Vec3, not arrays');
    assert.equal(g.body.side, Side.ENEMY);
  });

  test('a squad passes its world to every agent it creates', () => {
    const cw = flatWorld({});
    const nav = makeNav(cw);
    const squad = new AISquad({ collision: cw, nav });
    const a = squad.add({ id: 'a', pos: new Vec3(0, 0, 0) });
    assert.equal(a.collision, cw, 'an agent was created without the collision world');
    assert.equal(a.nav, nav);
    assert.equal(a.group, squad);
    assert.equal(a.pathfinder, squad.pathfinder,
      'each agent allocated its own Pathfinder — that duplicates grid-sized scratch arrays for no benefit');
  });

  test('the same seed produces identical AI, and a different seed does not', () => {
    const run = (seed) => {
      const g = guard({ yaw: 0, wall: false, noNav: true, seed });
      const out = [];
      for (let f = 0; f < 900; f++) {
        g.update(1 / 60, truth(0, 5 + (f % 90) * 0.02));
        out.push([Number(g.pos.x.toFixed(9)), Number(g.pos.z.toFixed(9)),
          Number(g.body.yaw.toFixed(9)), g.state, Number(g.suspicion.toFixed(9)),
          g.body.swing.chain, g.telemetry.attacks]);
      }
      return out;
    };
    const a = run(999);
    const b = run(999);
    assert.deepEqual(a, b, 'the same seed produced different AI — a bug would be unreproducible');
    const r1 = makeRng(1), r2 = makeRng(1), r3 = makeRng(2);
    assert.equal(r1(), r2(), 'the same seed produced different random numbers');
    const seq1 = Array.from({ length: 20 }, () => r1());
    const seq3 = Array.from({ length: 20 }, () => r3());
    assert.ok(seq1.some((v, i) => v !== seq3[i]),
      'different seeds produced the same sequence — the generator is not seeded');
  });

  test('a squad round-trips through a save mid-fight', () => {
    const squad = new AISquad({});
    for (let i = 0; i < 3; i++) squad.add({ id: `e${i}`, pos: new Vec3(i * 1.5, 0, 0) });
    for (const a of squad.agents) forceSuspicion(a, STEALTH.SUSPICION_MAX, new Vec3(0, 0, 4));
    drive(squad, truth(0, 4), 300);

    const data = JSON.parse(JSON.stringify(squad.serialize()));
    const copy = new AISquad({});
    for (let i = 0; i < 3; i++) copy.add({ id: `e${i}`, pos: new Vec3(0, 0, 0) });
    copy.restore(data);

    for (let i = 0; i < 3; i++) {
      assert.close(copy.agents[i].pos.x, squad.agents[i].pos.x, 1e-6, `e${i} position did not survive the save`);
      assert.close(copy.agents[i].suspicion, squad.agents[i].suspicion, 1e-6, `e${i} suspicion did not survive`);
      assert.equal(copy.agents[i].state, squad.agents[i].state, `e${i} state did not survive`);
      assert.close(copy.agents[i].health, squad.agents[i].health, 1e-6, `e${i} health did not survive`);
    }
    assert.doesNotThrow(() => copy.update(1 / 60, truth(0, 4)), 'a restored squad could not tick');
  });

  test('a squad resolves every live swing in one place, in order', () => {
    const squad = new AISquad({});
    const a = squad.add({ id: 'a', pos: new Vec3(0, 0, 0) });
    const b = squad.add({ id: 'b', pos: new Vec3(0, 0, -1.5) });
    const player = new PlayerController({ collision: flatWorld(), pos: new Vec3(0, 0, 1.5) });
    player.yaw = Math.PI;
    a.body.yaw = 0;
    b.body.yaw = Math.PI;
    for (const e of [a, b]) { e.body.startAttack('light'); }
    for (const e of [a, b]) {
      for (let k = 0; k < 400; k++) { e.body.swing.update(1 / 240); if (e.body.swing.phase === SwingPhase.ACTIVE) break; }
    }
    const before = player.health;
    const results = squad.resolveAttacks(player);
    assert.gt(results.length, 0, 'no swing was resolved');
    assert.equal(results[0].id, 'a', 'resolution order must follow the agent order, not the array after mutation');
    assert.lt(player.health, before, 'a resolved swing did no damage');
  });

  test('the squad abandons work rather than blowing the frame budget', () => {
    const squad = new AISquad({ budgetMs: PERF.AI_BUDGET_MS });
    for (let i = 0; i < 30; i++) squad.add({ id: `e${i}`, pos: new Vec3(i * 0.5, 0, 0) });
    assert.equal(squad.budgetMs, PERF.AI_BUDGET_MS);

    const tight = new AISquad({ budgetMs: 0 });
    for (let i = 0; i < 30; i++) tight.add({ id: `e${i}`, pos: new Vec3(i * 0.5, 0, 0) });
    const done = tight.update(1 / 60, truth(0, 5));
    assert.lt(done.length, 30,
      'an exhausted budget still ticked every agent — a crowd would hitch the frame instead of degrading');
    assert.gt(tight.telemetry.budgetExceeded, 0);
  });

  test('a squad of enemies stays inside the AI frame budget', () => {
    const cw = flatWorld({ wall: { half: 6 } });
    const nav = makeNav(cw);
    const squad = new AISquad({ collision: cw, nav });
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      squad.add({ id: `e${i}`, pos: new Vec3(Math.sin(angle) * 9, 0, Math.cos(angle) * 9) });
    }
    for (const a of squad.agents) forceSuspicion(a, STEALTH.SUSPICION_MAX, new Vec3(0, 0, 0));
    const t = truth(0, 0);
    const ms = measure(() => squad.update(1 / 60, t), 300, 30);
    assert.lt(ms, PERF.AI_BUDGET_MS,
      `8 enemies cost ${ms.toFixed(3)} ms of a ${PERF.AI_BUDGET_MS} ms budget`);
    console.log(`      squad of 8 (perception + decisions + pathing + collision): ${ms.toFixed(3)} ms/frame of a ${PERF.AI_BUDGET_MS} ms budget`);
  });

  test('an agent’s per-frame cost is small enough for a crowd', () => {
    const g = guard({ wall: false });
    forceSuspicion(g, STEALTH.SUSPICION_MAX, new Vec3(0, 0, 12));
    const t = truth(0, 12);
    const ms = measure(() => g.update(1 / 60, t), 2000, 100);
    assert.lt(ms, 0.25, `one hostile agent costs ${ms.toFixed(4)} ms/frame`);
    console.log(`      single hostile agent: ${ms.toFixed(4)} ms/frame → ${(ms * 8).toFixed(3)} ms for 8`);
  });

  test('perceptionProbe never throws and never returns a partial result', () => {
    const g = guard({ wall: false, noNav: true });
    const junk = [null, undefined, {}, { playerPos: null }, { playerPos: {} },
      { playerPos: new Vec3(0, 0, 3), stance: null, speed: 'fast' }];
    for (const j of junk) {
      let p;
      assert.doesNotThrow(() => { p = perceptionProbe(g, j); }, 'perceptionProbe threw');
      assert.ok(p && typeof p === 'object');
      assert.equal(typeof p.visible, 'boolean', 'visible must always be a boolean');
      assert.equal(typeof p.reason, 'string', 'a refusal must always carry a reason');
      assert.ok(p.visible === false || p.reason === 'visible');
    }
    assert.doesNotThrow(() => perceptionProbe(null, truth(0, 3)), 'a null agent threw');
  });
});

runAndExit();
