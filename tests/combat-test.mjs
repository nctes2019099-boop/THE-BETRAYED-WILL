/**
 * THE BETRAYED WILL — combat-test.mjs
 *
 * The melee suite. Combat is the system a player touches most often and forgives
 * least, and almost every melee bug in existence is one of four things: a swing
 * that hits more than once, a hit that lands out of nowhere, a rule that applies
 * to the player but not to the enemy (or the reverse), and a number that was
 * invented at the call site instead of declared.
 *
 * What is asserted, and why it matters:
 *   - ONE hit per swing, proven by resolving the same swing on every frame of
 *     its active window. At 60 fps that window is ~7 frames; without
 *     `hitConsumed` a single sword swing would apply its damage seven times.
 *   - a critical is the FINAL LINK OF A CHAIN, never a dice roll. Randomness in
 *     damage makes the game unreproducible, untestable and unbalanceable, so the
 *     crit is earned by committing to four uninterrupted hits instead.
 *   - resolveMelee() is the ONLY arbiter. Both sides arrive at it, so "the AI
 *     must not cheat" (§11) is a property of the architecture rather than a
 *     promise the AI code has to keep. This suite proves it by swapping the
 *     roles of the two fighters and demanding the same rules come back.
 *   - each side strikes with its OWN declared damage, so the enemy constants
 *     cannot sit unused while enemies silently hit for player numbers.
 *   - blocking is a RESOURCE, not an answer: it costs stamina, it does not cover
 *     the back, and running out is a guard break.
 *   - a parry is a REVERSAL: the defender takes nothing and the attacker is the
 *     one who ends up staggered.
 *   - geometry is shared: melee arc, block coverage, backstab, lock-on cone,
 *     finisher angle and takedown angle all go through one angle function, so
 *     the conventions cannot drift apart between systems.
 *   - the layer is deterministic, frame-rate tolerant, save/load safe, and fast
 *     enough to run for a crowd every frame.
 *
 * Run: node tests/combat-test.mjs
 */

import { describe, test, assert, runAndExit, measure } from './harness.mjs';
import { Vec3 } from '../src/core/math.js';
import { COMBAT, MOVE, STEALTH } from '../src/core/constants.js';
import { CollisionWorld } from '../src/sim/collision.js';
import { PlayerController, PlayerState, emptyIntent } from '../src/sim/player.js';
import {
  ATTACKS, Combatant, HitOutcome, STAGGER_DURATION, Side, StaggerLevel, Swing,
  SwingPhase, angleOffFacing, attackProfile, blockCovers, canFinisher,
  canTakedown, feedbackFor, isBackstab, pickLockTarget, resolveMelee,
  withinMeleeReach, advanceHitstop, hitstopActive,
} from '../src/sim/combat.js';

/* ------------------------------------------------------------------- rig */

const DT = 1 / 240;          // small enough that no phase window can be skipped
const FACING = 0;            // yaw 0 faces +Z, matching camera and player
const AWAY = Math.PI;        // faces -Z

function flatWorld() {
  const cw = new CollisionWorld(4);
  cw.setBounds(new Vec3(-60, -30, -60), new Vec3(60, 40, 60));
  cw.groundHeight = 0;
  cw.heightFn = null;
  return cw;
}

function makePlayer(pos = new Vec3(0, 0, 0), opts = {}) {
  return new PlayerController({ collision: flatWorld(), pos: pos.clone(), ...opts });
}

function fighter(o = {}) {
  const c = new Combatant({
    id: o.id ?? 'fighter',
    side: o.side ?? Side.NEUTRAL,
    pos: o.pos ?? new Vec3(0, 0, 0),
    yaw: o.yaw ?? FACING,
    maxHealth: o.maxHealth,
    health: o.health,
    stamina: o.stamina,
    maxStamina: o.maxStamina,
  });
  if (o.blocking) c.blocking = true;
  if (o.parryTimer) c.parryTimer = o.parryTimer;
  if (o.iframes) c.iframes = o.iframes;
  if (o.injured) c.injured = true;
  return c;
}

/** A duck-typed fighter with no methods at all: proves the resolver is not
 *  secretly depending on Combatant internals. */
function plain(o = {}) {
  return {
    id: 'plain', pos: o.pos ?? new Vec3(0, 0, 0), yaw: o.yaw ?? FACING,
    health: o.health ?? COMBAT.ENEMY_MAX_HEALTH, maxHealth: o.maxHealth ?? COMBAT.ENEMY_MAX_HEALTH,
    stamina: o.stamina ?? MOVE.STAMINA_MAX, maxStamina: o.maxStamina ?? MOVE.STAMINA_MAX,
    blocking: !!o.blocking, parryTimer: o.parryTimer ?? 0, iframes: 0, hitIframes: 0,
    dead: false, isDead: false, side: o.side, injured: !!o.injured,
  };
}

/** Run a swing to the end of its recovery without chaining. */
function drain(s, maxFrames = 6000) {
  for (let i = 0; i < maxFrames; i++) {
    s.update(DT);
    if (!s.busy) return true;
  }
  return false;
}

/**
 * A swing sitting in its ACTIVE phase, at a chosen link of the combo chain.
 * Reached by simulating real frames rather than by poking phase fields, so the
 * tests exercise the same timeline the game does.
 */
function liveSwing(kind = 'light', chain = 1) {
  const s = new Swing(kind);
  for (let i = 1; i < chain; i++) {
    if (!s.start()) throw new Error(`chain link ${i} was refused`);
    if (!drain(s)) throw new Error(`chain link ${i} never finished`);
  }
  if (!s.start()) throw new Error('final swing start was refused');
  for (let i = 0; i < 6000; i++) {
    s.update(DT);
    if (s.phase === SwingPhase.ACTIVE) return s;
  }
  throw new Error('swing never reached its ACTIVE phase');
}

/** Attacker at the origin facing the defender, defender facing back: a clean,
 *  legal, non-backstab hit. */
function frontPair(o = {}) {
  return {
    attacker: fighter({ pos: new Vec3(0, 0, 0), yaw: FACING, side: o.attackerSide, ...o.attacker }),
    defender: fighter({ pos: new Vec3(0, 0, 1.5), yaw: AWAY, ...o.defender }),
  };
}

/** Attacker behind a defender who is facing away: a legal backstab. The
 *  attacker still faces its target, so only the DEFENDER's facing differs. */
function backPair(o = {}) {
  return {
    attacker: fighter({ pos: new Vec3(0, 0, -1.5), yaw: FACING, ...o.attacker }),
    defender: fighter({ pos: new Vec3(0, 0, 0), yaw: FACING, ...o.defender }),
  };
}

/* ============================================== the attack table itself */

describe('the attack table is declared, not invented', () => {
  test('every timing, cost and damage field in ATTACKS is finite and sane', () => {
    for (const kind of Object.keys(ATTACKS)) {
      const p = ATTACKS[kind];
      for (const f of ['windup', 'active', 'recovery', 'damage', 'staminaCost', 'hitstop', 'rumble', 'blockStamina']) {
        assert.finite(p[f], `${kind}.${f} is not a finite number`);
        assert.gt(p[f], 0, `${kind}.${f} must be positive, was ${p[f]}`);
      }
      assert.ok(p.windup > 0 && p.active > 0 && p.recovery > 0, `${kind} has a zero-length phase`);
    }
  });

  test('the table carries real damage — the multipliers have something to multiply', () => {
    // Regression guard for a genuine defect: COMBAT declared CRIT_MULTIPLIER and
    // BACKSTAB_MULTIPLIER but no base damage at all, so every multiplier in the
    // game multiplied nothing. A crit table with no base number is untunable.
    for (const k of ['LIGHT_DAMAGE', 'HEAVY_DAMAGE', 'ENEMY_LIGHT_DAMAGE', 'ENEMY_HEAVY_DAMAGE']) {
      assert.finite(COMBAT[k], `COMBAT.${k} is missing`);
      assert.gt(COMBAT[k], 0, `COMBAT.${k} must be positive`);
    }
    assert.finite(COMBAT.ENEMY_MAX_HEALTH, 'COMBAT.ENEMY_MAX_HEALTH is missing');
    assert.gt(COMBAT.ENEMY_MAX_HEALTH, 0, 'enemies must have health to lose');
  });

  test('a heavy is slower, dearer and harder-hitting than a light', () => {
    const l = ATTACKS.light, h = ATTACKS.heavy;
    const lt = l.windup + l.active + l.recovery;
    const ht = h.windup + h.active + h.recovery;
    assert.gt(ht, lt, 'a heavy that is not slower than a light has no cost');
    assert.gt(h.staminaCost, l.staminaCost, 'a heavy must cost more stamina');
    assert.gt(h.damage, l.damage, 'a heavy must reward its risk');
  });

  test('a light attack takes several hits to kill; a heavy takes fewer', () => {
    const hp = COMBAT.ENEMY_MAX_HEALTH;
    const lightHits = Math.ceil(hp / COMBAT.LIGHT_DAMAGE);
    const heavyHits = Math.ceil(hp / COMBAT.HEAVY_DAMAGE);
    assert.gt(lightHits, 2, `an enemy dies in ${lightHits} light hits — combat has no length`);
    assert.lt(lightHits, 14, `an enemy takes ${lightHits} light hits — combat is a slog`);
    assert.lt(heavyHits, lightHits, 'heavy must be the efficient option, or nobody will use it');
  });

  test('lockTime is exactly windup + active + 70% of recovery', () => {
    for (const kind of Object.keys(ATTACKS)) {
      const p = ATTACKS[kind];
      const s = new Swing(kind);
      assert.close(s.lockTime, p.windup + p.active + p.recovery * 0.7, 1e-12,
        `${kind} lockTime drifted from its declared phases`);
    }
  });

  test('every stagger severity has a declared duration', () => {
    for (const level of Object.values(StaggerLevel)) {
      assert.ok(level in STAGGER_DURATION, `STAGGER_DURATION has no entry for ${level}`);
      assert.finite(STAGGER_DURATION[level], `${level} duration is not finite`);
    }
    assert.equal(STAGGER_DURATION[StaggerLevel.NONE], 0, 'NONE must not stun at all');
    assert.gt(STAGGER_DURATION[StaggerLevel.KNOCKDOWN], STAGGER_DURATION[StaggerLevel.LIGHT],
      'a knockdown must outlast a light stagger');
  });

  test('attackProfile tolerates junk input instead of returning undefined', () => {
    assert.equal(attackProfile('light'), ATTACKS.light);
    assert.equal(attackProfile('heavy'), ATTACKS.heavy);
    assert.equal(attackProfile('banana'), ATTACKS.light, 'an unknown kind must fall back, not crash');
    assert.equal(attackProfile(undefined), ATTACKS.light);
    assert.equal(attackProfile(null), ATTACKS.light);
  });
});

/* ======================================================== swing lifecycle */

describe('the swing lifecycle', () => {
  test('a new swing is idle and cannot connect', () => {
    const s = new Swing('light');
    assert.equal(s.phase, SwingPhase.IDLE);
    assert.notOk(s.busy, 'an idle swing must not lock the body');
    assert.notOk(s.isActive, 'an idle swing must not be hittable');
    assert.equal(s.chain, 0);
    assert.notOk(s.hitConsumed);
  });

  test('phases advance windup → active → recovery, in that order', () => {
    const s = new Swing('light');
    assert.ok(s.start());
    const seen = [];
    for (let i = 0; i < 2000; i++) {
      s.update(DT);
      const last = seen[seen.length - 1];
      if (s.phase !== last) seen.push(s.phase);
      if (!s.busy && seen.length >= 3) break;
    }
    assert.equal(seen[0], SwingPhase.WINDUP, `first phase was ${seen[0]}`);
    assert.equal(seen[1], SwingPhase.ACTIVE, `second phase was ${seen[1]}`);
    assert.equal(seen[2], SwingPhase.RECOVERY, `third phase was ${seen[2]}`);
  });

  test('the swing is not hittable during its windup', () => {
    const s = new Swing('heavy');
    s.start();
    let hittableDuringWindup = 0;
    for (let i = 0; i < 2000; i++) {
      s.update(DT);
      if (s.phase === SwingPhase.WINDUP && s.isActive) hittableDuringWindup++;
      if (s.phase !== SwingPhase.WINDUP) break;
    }
    assert.gt(i_frames_of_windup(s), 0, 'the heavy windup produced no frames at all');
    assert.equal(hittableDuringWindup, 0,
      'a swing that can connect before its windup ends cannot be reacted to or dodged');
  });

  test('exactly one hit per swing, even resolving every frame of the window', () => {
    const { attacker, defender } = frontPair();
    const s = liveSwing('light');
    const before = defender.health;
    let hits = 0;
    for (let i = 0; i < 40; i++) {
      const r = resolveMelee(attacker, defender, s);
      if (r.outcome === HitOutcome.HIT) hits++;
      s.update(DT);
    }
    assert.equal(hits, 1, `one swing connected ${hits} times — the classic melee bug`);
    assert.close(before - defender.health, COMBAT.LIGHT_DAMAGE, 1e-9,
      'the damage applied over the whole window must equal one hit, not many');
  });

  test('an attack cannot cancel its own recovery', () => {
    const s = new Swing('light');
    s.start();
    for (let i = 0; i < 2000; i++) { s.update(DT); if (s.phase === SwingPhase.RECOVERY) break; }
    assert.equal(s.phase, SwingPhase.RECOVERY, 'the swing never reached recovery');
    assert.notOk(s.start(), 'recovery is the punishment for committing; it must not be cancellable');
  });

  test('cancel() only rescues a swing that has not become dangerous yet', () => {
    const windup = new Swing('light');
    windup.start();
    assert.ok(windup.cancel(), 'a windup must be cancellable, or a mis-press is always punished');
    assert.equal(windup.phase, SwingPhase.IDLE);

    const active = liveSwing('light');
    assert.notOk(active.cancel(), 'an active swing must not be cancellable');
  });

  test('the combo chain counts up to its declared maximum and then ends', () => {
    const s = new Swing('light');
    const chainSeen = [];
    for (let i = 0; i < COMBAT.COMBO_MAX_CHAIN * 2; i++) {
      assert.ok(s.start(), `link ${i + 1} was refused`);
      chainSeen.push(s.chain);
      drain(s);
    }
    const expected = [];
    for (let i = 1; i <= COMBAT.COMBO_MAX_CHAIN * 2; i++) {
      expected.push(((i - 1) % COMBAT.COMBO_MAX_CHAIN) + 1);
    }
    assert.deepEqual(chainSeen, expected,
      `chain ran ${chainSeen.join(',')} — expected ${expected.join(',')}`);
  });

  test('a critical is the final link of the chain, deterministically', () => {
    // Random damage would make the game unreproducible: a tester could not
    // distinguish a balance bug from an unlucky roll, and a replay could not be
    // verified. The crit is therefore a property of the chain, not a dice roll.
    const s = new Swing('light');
    let crits = 0;
    const trials = COMBAT.COMBO_MAX_CHAIN * 25;
    for (let i = 0; i < trials; i++) {
      s.start();
      if (s.isFinisherBlow) crits++;
      drain(s);
    }
    assert.equal(crits, trials / COMBAT.COMBO_MAX_CHAIN,
      `${crits} crits in ${trials} swings — the crit must land on exactly every ${COMBAT.COMBO_MAX_CHAIN}th`);
  });

  test('a full chain crits through the resolver by exactly CRIT_MULTIPLIER', () => {
    const { attacker, defender } = frontPair();
    const s = liveSwing('light', COMBAT.COMBO_MAX_CHAIN);
    assert.ok(s.isFinisherBlow, 'the rig did not reach the final chain link');
    const r = resolveMelee(attacker, defender, s);
    assert.equal(r.outcome, HitOutcome.HIT);
    assert.ok(r.crit, 'the final link of a full chain must crit');
    assert.close(r.applied, COMBAT.LIGHT_DAMAGE * COMBAT.CRIT_MULTIPLIER, 0.02,
      `crit applied ${r.applied}`);
  });

  test('the first link of a chain never crits', () => {
    const { attacker, defender } = frontPair();
    const r = resolveMelee(attacker, defender, liveSwing('light', 1));
    assert.notOk(r.crit, 'a crit on the first swing would make chaining pointless');
    assert.close(r.applied, COMBAT.LIGHT_DAMAGE, 1e-9);
  });

  test('reset() forgets the chain, so a save cannot carry a pending crit', () => {
    const s = liveSwing('light', COMBAT.COMBO_MAX_CHAIN);
    assert.ok(s.isFinisherBlow);
    s.reset();
    assert.equal(s.chain, 0);
    assert.equal(s.phase, SwingPhase.IDLE);
    assert.notOk(s.isFinisherBlow);
  });

  test('serialize/restore round-trips a mid-swing state exactly', () => {
    const s = liveSwing('heavy', 3);
    s.update(DT);
    const data = s.serialize();
    const copy = new Swing('light');
    copy.restore(data);
    assert.equal(copy.kind, s.kind, 'kind did not survive the round trip');
    assert.equal(copy.phase, s.phase, 'phase did not survive the round trip');
    assert.equal(copy.chain, s.chain, 'chain did not survive the round trip');
    assert.close(copy.t, s.t, 1e-9, 'elapsed phase time did not survive the round trip');
    assert.equal(copy.hitConsumed, s.hitConsumed);
  });

  test('restore() survives hostile save data without producing NaN', () => {
    const hostile = [
      null, undefined, {}, { kind: 'banana', phase: 'nope', chain: -99, t: NaN },
      { kind: 'heavy', phase: SwingPhase.ACTIVE, chain: 1e9, t: 'soon' },
      { kind: 7, phase: 3, chain: null, t: Infinity },
    ];
    for (const data of hostile) {
      const s = new Swing('light');
      assert.doesNotThrow(() => s.restore(data), `restore threw on ${JSON.stringify(data)}`);
      assert.ok(Number.isFinite(s.t), `restore produced a non-finite t from ${JSON.stringify(data)}`);
      assert.ok(ATTACKS[s.kind], `restore produced an unknown kind: ${s.kind}`);
      assert.ok(Object.values(SwingPhase).includes(s.phase), `restore produced phase ${s.phase}`);
      assert.gte(s.chain, 0, 'chain went negative');
      assert.lte(s.chain, COMBAT.COMBO_MAX_CHAIN, 'chain exceeded its maximum');
    }
  });

  test('update() tolerates zero, negative, NaN and absurd dt', () => {
    // Every caller clamps dt before it reaches a Swing, but a system that turns a
    // bad dt into a NaN phase timer is a system that can permanently freeze a
    // fighter, so the tolerance is asserted rather than assumed.
    for (const bad of [0, -1, NaN, undefined, null, 'x', {}, 1e9, -1e9]) {
      const s = liveSwing('light');
      assert.doesNotThrow(() => s.update(bad), `update threw on dt=${String(bad)}`);
      assert.ok(Number.isFinite(s.t), `dt=${String(bad)} left a non-finite phase timer`);
      assert.ok(Object.values(SwingPhase).includes(s.phase), `dt=${String(bad)} left phase ${s.phase}`);
    }
    // Infinity is not a dt any caller can produce; it must still not throw.
    const inf = liveSwing('light');
    assert.doesNotThrow(() => inf.update(Infinity), 'update threw on dt=Infinity');
  });

  test('setKind refuses to corrupt a swing already in flight', () => {
    const s = liveSwing('light');
    const phaseBefore = s.phase;
    const tBefore = s.t;
    s.setKind('heavy');
    assert.equal(s.profile, ATTACKS.heavy, 'the profile should follow the requested kind');
    assert.equal(s.phase, phaseBefore, 'changing kind must not reset the phase');
    assert.close(s.t, tBefore, 1e-12, 'changing kind must not rewind the clock');
  });
});

/** Frames the heavy windup occupies — used to prove the loop above ran. */
function i_frames_of_windup(s) {
  const s2 = new Swing(s.kind);
  s2.start();
  let n = 0;
  for (let i = 0; i < 4000; i++) { s2.update(DT); if (s2.phase === SwingPhase.WINDUP) n++; else break; }
  return n;
}

/* ================================================================ geometry */

describe('combat geometry', () => {
  test('angleOffFacing: 0° dead ahead, 180° directly behind, 90° to the side', () => {
    const o = new Vec3(0, 0, 0);
    assert.close(angleOffFacing(o, FACING, new Vec3(0, 0, 5)), 0, 1e-9);
    assert.close(angleOffFacing(o, FACING, new Vec3(0, 0, -5)), 180, 1e-9);
    assert.close(angleOffFacing(o, FACING, new Vec3(5, 0, 0)), 90, 1e-9);
    assert.close(angleOffFacing(o, FACING, new Vec3(-5, 0, 0)), 90, 1e-9);
  });

  test('angleOffFacing rotates with yaw', () => {
    const o = new Vec3(0, 0, 0);
    const target = new Vec3(0, 0, 5);
    assert.close(angleOffFacing(o, FACING, target), 0, 1e-9);
    assert.close(angleOffFacing(o, AWAY, target), 180, 1e-9,
      'turning around must put the same target behind you');
  });

  test('angleOffFacing never exceeds 180° and survives degenerate input', () => {
    for (let deg = 0; deg < 720; deg += 3) {
      const yaw = deg * Math.PI / 180;
      for (let t = 0; t < 360; t += 7) {
        const rad = t * Math.PI / 180;
        const a = angleOffFacing(new Vec3(1, 0, 1), yaw, new Vec3(1 + Math.sin(rad), 0, 1 + Math.cos(rad)));
        assert.finite(a, `non-finite angle at yaw=${deg} target=${t}`);
        assert.gte(a, 0, 'a negative angle would invert every facing test');
        assert.lte(a, 180 + 1e-9, `angle ${a} exceeded 180°`);
      }
    }
    assert.finite(angleOffFacing(null, 0, new Vec3(0, 0, 1)), 'null origin must not throw');
    assert.finite(angleOffFacing(new Vec3(0, 0, 0), 0, null), 'null target must not throw');
    assert.equal(angleOffFacing(new Vec3(2, 0, 2), 0, new Vec3(2, 0, 2)), 0,
      'a target at your own position must not produce NaN');
  });

  test('isBackstab honours BACKSTAB_ANGLE_DEG exactly', () => {
    const d = { pos: new Vec3(0, 0, 0), yaw: FACING };
    assert.ok(isBackstab(d, new Vec3(0, 0, -1.5)), 'directly behind must be a backstab');
    assert.notOk(isBackstab(d, new Vec3(0, 0, 1.5)), 'dead ahead must not be a backstab');
    // A point `deg` off the facing direction. Yaw 0 faces +Z, so +cos is ahead
    // and -cos is behind; mirroring this produces 180-deg and silently inverts
    // every boundary the test claims to check.
    const at = (deg) => {
      const r = deg * Math.PI / 180;
      return new Vec3(Math.sin(r) * 1.5, 0, Math.cos(r) * 1.5);
    };
    const threshold = COMBAT.BACKSTAB_ANGLE_DEG;
    assert.close(angleOffFacing(d.pos, d.yaw, at(threshold)), threshold, 1e-9,
      'the rig does not place the target where it claims to');
    assert.notOk(isBackstab(d, at(threshold - 1)),
      `${threshold - 1}° off facing must not count as a backstab`);
    assert.ok(isBackstab(d, at(threshold + 1)),
      `${threshold + 1}° off facing must count as a backstab`);
  });

  test('blockCovers the front and not the back, by BLOCK_ARC_DEG', () => {
    const dPos = new Vec3(0, 0, 0);
    assert.ok(blockCovers(dPos, FACING, new Vec3(0, 0, 1.5)), 'a raised guard must cover the front');
    assert.notOk(blockCovers(dPos, FACING, new Vec3(0, 0, -1.5)),
      'a guard that covers the back removes positioning from melee entirely');
    const half = COMBAT.BLOCK_ARC_DEG / 2;
    const at = (deg) => new Vec3(Math.sin(deg * Math.PI / 180) * 1.5, 0, Math.cos(deg * Math.PI / 180) * 1.5);
    assert.ok(blockCovers(dPos, FACING, at(half - 1)), 'just inside the arc must be covered');
    assert.notOk(blockCovers(dPos, FACING, at(half + 1)), 'just outside the arc must not be covered');
  });

  test('withinMeleeReach enforces the declared min, max and arc', () => {
    const a = { pos: new Vec3(0, 0, 0), yaw: FACING };
    const at = (z) => ({ pos: new Vec3(0, 0, z), yaw: AWAY });
    const mid = (COMBAT.MELEE_REACH_MIN + COMBAT.MELEE_REACH_MAX) / 2;
    assert.ok(withinMeleeReach(a, at(mid)).ok, 'mid-range must connect');
    assert.equal(withinMeleeReach(a, at(COMBAT.MELEE_REACH_MAX + 0.5)).reason, 'out-of-reach');
    assert.equal(withinMeleeReach(a, at(COMBAT.MELEE_REACH_MIN - 0.4)).reason, 'too-close',
      'standing inside the minimum reach must miss, or point-blank would be strictly best');
    assert.equal(withinMeleeReach(a, { pos: new Vec3(mid, 0, 0), yaw: AWAY }).reason, 'outside-arc',
      'a target at 90° must be outside a MELEE_ARC_DEG swing');
  });

  test('a defender on another level cannot be hit through the floor', () => {
    const a = { pos: new Vec3(0, 0, 0), yaw: FACING };
    const above = { pos: new Vec3(0, COMBAT.MELEE_VERTICAL_TOLERANCE + 1.0, 1.5), yaw: AWAY };
    assert.equal(withinMeleeReach(a, above).reason, 'vertical-miss');
    const sameLevel = { pos: new Vec3(0, COMBAT.MELEE_VERTICAL_TOLERANCE * 0.5, 1.5), yaw: AWAY };
    assert.ok(withinMeleeReach(a, sameLevel).ok, 'a small step must not break melee on stairs');
  });

  test('reach reports the distance and angle it measured, for explainable misses', () => {
    const a = { pos: new Vec3(0, 0, 0), yaw: FACING };
    const r = withinMeleeReach(a, { pos: new Vec3(0, 0, 1.5), yaw: AWAY });
    assert.close(r.distance, 1.5, 1e-9);
    assert.close(r.angleDeg, 0, 1e-9);
    assert.equal(r.reason, null);
  });
});

/* ================================================== resolveMelee: the arbiter */

describe('resolveMelee is the single arbiter of a melee hit', () => {
  test('no live swing means no hit, and no damage', () => {
    const { attacker, defender } = frontPair();
    const before = defender.health;
    for (const swing of [null, undefined, new Swing('light'), {}]) {
      const r = resolveMelee(attacker, defender, swing);
      assert.equal(r.outcome, HitOutcome.MISS, `outcome for ${swing?.phase ?? swing}`);
      assert.close(defender.health, before, 1e-12, 'a miss must not damage anyone');
    }
    assert.equal(resolveMelee(attacker, defender, new Swing('light')).reason, 'not-active');
  });

  test('a spent swing cannot connect again', () => {
    const { attacker, defender } = frontPair();
    const s = liveSwing('light');
    const first = resolveMelee(attacker, defender, s);
    assert.equal(first.outcome, HitOutcome.HIT);
    const before = defender.health;
    defender.hitIframes = 0;                    // isolate the consume rule from i-frames
    const second = resolveMelee(attacker, defender, s);
    assert.equal(second.outcome, HitOutcome.MISS);
    assert.equal(second.reason, 'already-consumed');
    assert.close(defender.health, before, 1e-12);
  });

  test('out of reach is a miss with an explainable reason', () => {
    const attacker = fighter({ pos: new Vec3(0, 0, 0), yaw: FACING });
    const defender = fighter({ pos: new Vec3(0, 0, COMBAT.MELEE_REACH_MAX + 1), yaw: AWAY });
    const r = resolveMelee(attacker, defender, liveSwing('light'));
    assert.equal(r.outcome, HitOutcome.MISS);
    assert.equal(r.reason, 'out-of-reach');
    assert.equal(r.damage, 0);
    assert.close(defender.health, defender.maxHealth, 1e-12);
  });

  test('outside the swing arc is a miss', () => {
    const attacker = fighter({ pos: new Vec3(0, 0, 0), yaw: FACING });
    const defender = fighter({ pos: new Vec3(1.5, 0, 0), yaw: AWAY });
    const r = resolveMelee(attacker, defender, liveSwing('light'));
    assert.equal(r.outcome, HitOutcome.MISS);
    assert.equal(r.reason, 'outside-arc');
  });

  test('a dead defender is not hit again — no corpse farming', () => {
    const { attacker, defender } = frontPair();
    defender.die('test');
    const before = defender.health;
    const r = resolveMelee(attacker, defender, liveSwing('light'));
    assert.equal(r.outcome, HitOutcome.MISS);
    assert.equal(r.reason, 'dead');
    assert.notOk(r.killed, 'killing an already-dead fighter would double-count a kill');
    assert.close(defender.health, before, 1e-12);
  });

  test('a dead attacker cannot land a hit', () => {
    const { attacker, defender } = frontPair();
    attacker.die('test');
    const r = resolveMelee(attacker, defender, liveSwing('light'));
    assert.equal(r.outcome, HitOutcome.MISS);
    assert.equal(r.reason, 'attacker-dead');
    assert.close(defender.health, defender.maxHealth, 1e-12);
  });

  test('dodge i-frames beat a hit, and the swing is still spent', () => {
    const { attacker, defender } = frontPair({ defender: { iframes: 0.5 } });
    const s = liveSwing('light');
    const before = defender.health;
    const r = resolveMelee(attacker, defender, s);
    assert.equal(r.outcome, HitOutcome.DODGED, 'a dodge must reliably beat a hit');
    assert.close(defender.health, before, 1e-12, 'i-frames must negate the damage entirely');
    assert.equal(r.applied, 0);
    assert.ok(s.hitConsumed, 'a dodged swing must still be spent, or dodging is free');
  });

  test('i-frames are checked before block and parry', () => {
    const { defender } = frontPair({ defender: { iframes: 0.5, blocking: true, parryTimer: 0.2 } });
    const attacker = fighter({ pos: new Vec3(0, 0, 0), yaw: FACING });
    const r = resolveMelee(attacker, defender, liveSwing('light'));
    assert.equal(r.outcome, HitOutcome.DODGED, 'dodge must win over guard, not be resolved as a block');
    assert.notOk(r.blocked);
    assert.notOk(r.parried);
  });

  test('a parry is a reversal: the defender takes nothing and the ATTACKER is staggered', () => {
    const { attacker, defender } = frontPair({ defender: { parryTimer: COMBAT.PARRY_WINDOW * 0.5 } });
    const defenderHealth = defender.health;
    const defenderStamina = defender.stamina;
    const r = resolveMelee(attacker, defender, liveSwing('light'));
    assert.equal(r.outcome, HitOutcome.PARRIED);
    assert.ok(r.parried);
    assert.close(defender.health, defenderHealth, 1e-12, 'a parry must cost the defender no health');
    assert.equal(r.applied, 0);
    assert.gt(attacker.staggerTimer, 0, 'the punishment must land on the attacker');
    assert.close(attacker.staggerTimer, COMBAT.PARRY_STAGGER_TIME, 1e-9);
    assert.notOk(attacker.canAct, 'a parried attacker must be open');
    assert.close(defender.stamina, defenderStamina, 1e-12,
      'a parry is free: the cost of missing the window is the punishment, not the attempt');
  });

  test('a parry only works while the window is open', () => {
    const { attacker, defender } = frontPair({ defender: { parryTimer: 0 } });
    const r = resolveMelee(attacker, defender, liveSwing('light'));
    assert.equal(r.outcome, HitOutcome.HIT, 'an expired parry window must not still protect');
    assert.notOk(r.parried);
  });

  test('a parry does not protect the back', () => {
    const { attacker, defender } = backPair({ defender: { parryTimer: COMBAT.PARRY_WINDOW * 0.5 } });
    const r = resolveMelee(attacker, defender, liveSwing('light'));
    assert.equal(r.outcome, HitOutcome.HIT, 'parrying a blow from behind would make it omnidirectional');
    assert.ok(r.backstab);
  });

  test('a block reduces damage by exactly BLOCK_DAMAGE_REDUCTION and costs health nothing', () => {
    const { attacker, defender } = frontPair({ defender: { blocking: true } });
    const healthBefore = defender.health;
    const staminaBefore = defender.stamina;
    const r = resolveMelee(attacker, defender, liveSwing('light'));
    assert.equal(r.outcome, HitOutcome.BLOCKED);
    assert.ok(r.blocked);
    assert.close(defender.health, healthBefore, 1e-12,
      'a block that leaks health is not a block');
    assert.close(r.applied, COMBAT.LIGHT_DAMAGE * (1 - COMBAT.BLOCK_DAMAGE_REDUCTION), 1e-9);
    assert.lt(r.applied, r.damage, 'a block must reduce the incoming number');
    assert.close(staminaBefore - defender.stamina, ATTACKS.light.blockStamina, 1e-9,
      'blocking must cost the declared stamina');
    assert.notOk(r.guardBroken, 'a full-stamina block must not break the guard');
  });

  test('a heavy block costs more stamina than a light one', () => {
    const light = frontPair({ defender: { blocking: true } });
    const heavy = frontPair({ defender: { blocking: true } });
    resolveMelee(light.attacker, light.defender, liveSwing('light'));
    resolveMelee(heavy.attacker, heavy.defender, liveSwing('heavy'));
    assert.gt(ATTACKS.heavy.blockStamina, ATTACKS.light.blockStamina,
      'blocking heavies for free would make guard the only viable answer');
    assert.gt(light.defender.stamina, heavy.defender.stamina,
      'the heavy block must drain more stamina than the light one');
  });

  test('a block does not cover the back', () => {
    const { attacker, defender } = backPair({ defender: { blocking: true } });
    const healthBefore = defender.health;
    const r = resolveMelee(attacker, defender, liveSwing('light'));
    assert.equal(r.outcome, HitOutcome.HIT, 'a guard that covers 360° removes positioning from melee');
    assert.notOk(r.blocked);
    assert.ok(r.backstab);
    assert.lt(defender.health, healthBefore, 'the backstab must actually land');
  });

  test('running out of stamina while blocking is a guard break', () => {
    const { attacker, defender } = frontPair({
      defender: { blocking: true, stamina: ATTACKS.light.blockStamina - 1 },
    });
    const r = resolveMelee(attacker, defender, liveSwing('light'));
    assert.equal(r.outcome, HitOutcome.BLOCKED);
    assert.ok(r.guardBroken, 'a guard with no stamina left must break');
    assert.equal(r.stagger, StaggerLevel.GUARD_BREAK);
    assert.equal(defender.stamina, 0);
    assert.close(defender.staggerTimer, COMBAT.GUARD_BREAK_TIME, 1e-9);
    assert.notOk(defender.canAct, 'a guard-broken fighter must be helpless');
    assert.notOk(defender.blocking, 'a broken guard must drop');
  });

  test('a clean hit applies the declared damage to a fighter with no methods at all', () => {
    const attacker = plain({ pos: new Vec3(0, 0, 0), yaw: FACING });
    const defender = plain({ pos: new Vec3(0, 0, 1.5), yaw: AWAY });
    const r = resolveMelee(attacker, defender, liveSwing('light'));
    assert.equal(r.outcome, HitOutcome.HIT);
    assert.close(defender.maxHealth - defender.health, COMBAT.LIGHT_DAMAGE, 1e-9,
      'the resolver must work on any object satisfying the interface');
    assert.close(r.applied, COMBAT.LIGHT_DAMAGE, 1e-9);
    assert.equal(r.reason, 'hit');
  });

  test('a hit routes through the defender’s own damage() when it has one', () => {
    const { attacker, defender } = frontPair();
    let routed = 0;
    const original = defender.damage.bind(defender);
    defender.damage = (amount, source) => { routed++; return original(amount, source); };
    const r = resolveMelee(attacker, defender, liveSwing('light'));
    assert.equal(routed, 1, 'the resolver must not bypass the defender’s own damage method');
    assert.close(r.applied, COMBAT.LIGHT_DAMAGE, 1e-9);
    assert.gt(defender.telemetry.damageTaken, 0, 'telemetry must record the hit');
  });

  test('a backstab multiplies by exactly BACKSTAB_MULTIPLIER', () => {
    const { attacker, defender } = backPair();
    const r = resolveMelee(attacker, defender, liveSwing('light'));
    assert.equal(r.outcome, HitOutcome.HIT);
    assert.ok(r.backstab);
    assert.close(r.applied, COMBAT.LIGHT_DAMAGE * COMBAT.BACKSTAB_MULTIPLIER, 0.02,
      `backstab applied ${r.applied}`);
  });

  test('backstab and crit stack, and both are reproducible', () => {
    const runs = [];
    for (let i = 0; i < 3; i++) {
      const attacker = fighter({ pos: new Vec3(0, 0, -1.5), yaw: FACING });
      const defender = fighter({ pos: new Vec3(0, 0, 0), yaw: FACING });
      const r = resolveMelee(attacker, defender, liveSwing('light', COMBAT.COMBO_MAX_CHAIN));
      assert.ok(r.backstab && r.crit, 'the rig did not produce a backstab crit');
      runs.push(r.applied);
    }
    assert.deepEqual(runs, [runs[0], runs[0], runs[0]],
      'the same inputs must produce the same damage every time');
    assert.close(runs[0], COMBAT.LIGHT_DAMAGE * COMBAT.BACKSTAB_MULTIPLIER * COMBAT.CRIT_MULTIPLIER, 0.05);
  });

  test('an explicit damage override wins, for special moves', () => {
    const { attacker, defender } = frontPair();
    const r = resolveMelee(attacker, defender, liveSwing('light'), { damage: 41 });
    assert.close(r.applied, 41, 1e-9, 'a scripted move must be able to declare its own damage');
  });

  test('a killing blow reports killed and leaves the defender dead', () => {
    const { attacker, defender } = frontPair({ defender: { health: 1 } });
    const r = resolveMelee(attacker, defender, liveSwing('light'));
    assert.ok(r.killed, 'a blow that empties health must report the kill');
    assert.ok(defender.isDead);
    assert.equal(defender.health, 0);
    assert.equal(r.stagger, StaggerLevel.KNOCKDOWN, 'a killing blow must not stagger a corpse');
  });

  test('damage never goes negative and health never goes below zero', () => {
    const { attacker, defender } = frontPair({ defender: { health: 2 } });
    const r = resolveMelee(attacker, defender, liveSwing('heavy'));
    assert.equal(defender.health, 0, 'health clamped at zero');
    assert.gte(r.applied, 0);
    assert.gte(r.damage, 0);
  });

  test('a staggered defender is still hittable — being stunned is not immunity', () => {
    const { attacker, defender } = frontPair();
    defender.applyStagger(StaggerLevel.LIGHT);
    assert.ok(defender.staggered);
    const before = defender.health;
    const r = resolveMelee(attacker, defender, liveSwing('light'));
    assert.equal(r.outcome, HitOutcome.HIT);
    assert.lt(defender.health, before);
  });

  test('hitstop is produced on a hit and on a parry, for both sides', () => {
    const hit = frontPair();
    const rh = resolveMelee(hit.attacker, hit.defender, liveSwing('light'));
    assert.gt(rh.hitstop, 0, 'a hit with no hitstop feels like nothing connected');
    assert.gt(rh.rumble, 0, 'a hit with no rumble is silent on a gamepad');

    const par = frontPair({ defender: { parryTimer: 0.1 } });
    const rp = resolveMelee(par.attacker, par.defender, liveSwing('light'));
    assert.gt(rp.hitstop, 0, 'a parry must have the strongest freeze in the game');
    assert.gt(rp.hitstop, rh.hitstop, 'a parry should stop time longer than a plain hit');
  });

  test('feedbackFor returns a presentation payload the renderer can consume', () => {
    const { attacker, defender } = frontPair();
    const r = resolveMelee(attacker, defender, liveSwing('light'));
    assert.ok(r.feedback, 'a resolved hit must carry feedback');
    const f = feedbackFor(r, ATTACKS.light);
    assert.ok(f && typeof f === 'object', 'feedbackFor must return data, not throw');
    assert.doesNotThrow(() => JSON.stringify(f), 'feedback must be serialisable for the debug overlay');
  });

  test('resolveMelee never throws, whatever it is handed', () => {
    const junk = [
      [null, null, null], [undefined, undefined, undefined], [{}, {}, {}],
      [{ pos: null }, { pos: null }, null],
      [{ pos: new Vec3(0, 0, 0) }, { pos: new Vec3(0, 0, 1) }, { phase: 'nope' }],
      [fighter({}), fighter({}), liveSwing('light')],
    ];
    for (const [a, d, s] of junk) {
      let r;
      assert.doesNotThrow(() => { r = resolveMelee(a, d, s); }, 'resolveMelee threw');
      assert.ok(r && typeof r.outcome === 'string', 'every call must return a full result');
      assert.finite(r.damage, 'damage must be finite even for junk input');
      assert.finite(r.applied, 'applied must be finite even for junk input');
    }
  });

  test('the result shape is complete and stable, so callers cannot read undefined', () => {
    const { attacker, defender } = frontPair();
    const r = resolveMelee(attacker, defender, liveSwing('light'));
    for (const key of ['outcome', 'reason', 'damage', 'applied', 'crit', 'backstab', 'blocked',
      'parried', 'guardBroken', 'killed', 'stagger', 'hitstop', 'rumble', 'distance', 'angleDeg']) {
      assert.ok(key in r, `result is missing ${key}`);
    }
    assert.finite(r.distance);
    assert.finite(r.angleDeg);
  });
});

/* ==================================================== the no-cheat symmetry */

describe('neither side cheats', () => {
  test('swapping attacker and defender obeys the same rules', () => {
    // The property §11 actually demands: not "the AI is limited" but "one rule
    // set, applied to whoever is swinging". Same geometry, roles exchanged.
    const a = fighter({ pos: new Vec3(0, 0, 0), yaw: FACING });
    const d = fighter({ pos: new Vec3(0, 0, 1.5), yaw: AWAY });
    const forward = resolveMelee(a, d, liveSwing('light'));

    const a2 = fighter({ pos: new Vec3(0, 0, 1.5), yaw: AWAY });
    const d2 = fighter({ pos: new Vec3(0, 0, 0), yaw: FACING });
    const reverse = resolveMelee(a2, d2, liveSwing('light'));

    assert.equal(forward.outcome, reverse.outcome, 'mirrored geometry must give mirrored outcomes');
    assert.equal(forward.reason, reverse.reason);
    assert.equal(forward.crit, reverse.crit);
    assert.equal(forward.backstab, reverse.backstab);
    assert.close(forward.distance, reverse.distance, 1e-9);
    assert.close(forward.angleDeg, reverse.angleDeg, 1e-9);
  });

  test('a parry works identically for both sides', () => {
    const playerParries = (() => {
      const { attacker, defender } = frontPair({ defender: { parryTimer: 0.1 } });
      return resolveMelee(attacker, defender, liveSwing('light'));
    })();
    const enemyParries = (() => {
      const attacker = fighter({ pos: new Vec3(0, 0, 1.5), yaw: AWAY, side: Side.PLAYER });
      const defender = fighter({ pos: new Vec3(0, 0, 0), yaw: FACING, parryTimer: 0.1 });
      return resolveMelee(attacker, defender, liveSwing('light'));
    })();
    assert.equal(playerParries.outcome, HitOutcome.PARRIED);
    assert.equal(enemyParries.outcome, HitOutcome.PARRIED,
      'if only the player can parry, the AI is being denied a declared mechanic');
    assert.close(playerParries.hitstop, enemyParries.hitstop, 1e-12);
  });

  test('a block works identically for both sides', () => {
    const { attacker, defender } = frontPair({ defender: { blocking: true } });
    const playerBlocks = resolveMelee(attacker, defender, liveSwing('light'));
    const a2 = fighter({ pos: new Vec3(0, 0, 1.5), yaw: AWAY });
    const d2 = fighter({ pos: new Vec3(0, 0, 0), yaw: FACING, blocking: true });
    const enemyBlocks = resolveMelee(a2, d2, liveSwing('light'));
    assert.equal(playerBlocks.outcome, HitOutcome.BLOCKED);
    assert.equal(enemyBlocks.outcome, HitOutcome.BLOCKED);
  });

  test('each side strikes with its OWN declared damage', () => {
    const playerHit = frontPair({ attackerSide: Side.PLAYER });
    const rp = resolveMelee(playerHit.attacker, playerHit.defender, liveSwing('light'));
    assert.close(rp.applied, COMBAT.LIGHT_DAMAGE, 1e-9, 'the player must use the player number');

    const enemyHit = frontPair({ attackerSide: Side.ENEMY });
    const re = resolveMelee(enemyHit.attacker, enemyHit.defender, liveSwing('light'));
    assert.close(re.applied, COMBAT.ENEMY_LIGHT_DAMAGE, 1e-9,
      'an enemy must use ENEMY_LIGHT_DAMAGE, not the player’s number');

    const enemyHeavy = frontPair({ attackerSide: Side.ENEMY });
    const rh = resolveMelee(enemyHeavy.attacker, enemyHeavy.defender, liveSwing('heavy'));
    assert.close(rh.applied, COMBAT.ENEMY_HEAVY_DAMAGE, 1e-9);

    assert.notEqual(COMBAT.ENEMY_LIGHT_DAMAGE, COMBAT.LIGHT_DAMAGE,
      'if the two numbers are identical the split is decorative');
  });

  test('an enemy cannot damage the player without a live swing', () => {
    // No ambient damage, no contact damage, no damage-at-a-distance. Over 1000
    // frames an enemy standing inside melee range with no swing must do nothing.
    const player = makePlayer(new Vec3(0, 0, 0));
    const enemy = fighter({ pos: new Vec3(0, 0, 1.2), yaw: AWAY, side: Side.ENEMY });
    const before = player.health;
    const intent = emptyIntent();
    for (let i = 0; i < 1000; i++) {
      player.update(1 / 60, intent, {});
      resolveMelee(enemy, player, enemy.swing);   // idle swing: must be a MISS
    }
    assert.close(player.health, before, 1e-12,
      'the player lost health with no enemy swing — that is ambient damage, i.e. cheating');
  });

  test('Combatant and PlayerController expose the same combat interface', () => {
    const c = fighter({});
    const p = makePlayer();
    for (const key of ['pos', 'yaw', 'health', 'maxHealth', 'stamina', 'blocking', 'parryTimer']) {
      assert.ok(key in c, `Combatant is missing ${key}`);
      assert.ok(key in p, `PlayerController is missing ${key}`);
    }
    for (const m of ['startAttack', 'startBlock', 'stopBlock', 'startParry', 'applyStagger', 'damage']) {
      assert.equal(typeof c[m], 'function', `Combatant.${m} is missing`);
      assert.equal(typeof p[m], 'function', `PlayerController.${m} is missing`);
    }
    for (const g of ['alive', 'isDead', 'canAct', 'staggered', 'invulnerableReason']) {
      assert.ok(g in c, `Combatant lacks ${g}`);
      assert.ok(g in p, `PlayerController lacks ${g}`);
    }
    assert.equal(p.maxStamina, MOVE.STAMINA_MAX,
      'the player and the AI must draw on the same stamina pool size');
  });

  test('Combatant.startAttack and PlayerController.startAttack refuse identically', () => {
    const c = fighter({ stamina: 0 });
    const p = makePlayer(new Vec3(0, 0, 0));
    p.stamina = 0;
    assert.notOk(c.startAttack('light'), 'a Combatant with no stamina must not attack');
    assert.notOk(p.startAttack('light'), 'the player with no stamina must not attack either');
    assert.equal(c.stamina, 0, 'a refused attack must not spend stamina');
    assert.equal(p.stamina, 0, 'a refused attack must not spend stamina');

    const c2 = fighter({});
    const p2 = makePlayer();
    assert.ok(c2.startAttack('light'));
    assert.ok(p2.startAttack('light'));
    assert.close(c2.maxStamina - c2.stamina, COMBAT.ATTACK_STAMINA_LIGHT, 1e-9);
    assert.close(p2.maxStamina - p2.stamina, COMBAT.ATTACK_STAMINA_LIGHT, 1e-9,
      'the same attack must cost the same stamina on both sides');
  });

  test('stamina recovers at the same declared rate for both sides', () => {
    const c = fighter({});
    c.stamina = 50;
    const p = makePlayer();
    p.stamina = 50;
    p.update(1 / 60, emptyIntent(), {});
    c.update(1 / 60);
    const pGain = p.stamina - 50;
    const cGain = c.stamina - 50;
    assert.gt(pGain, 0, 'the player did not recover stamina');
    assert.close(pGain, cGain, 1e-6,
      `player recovered ${pGain.toFixed(4)} but the AI recovered ${cGain.toFixed(4)} — two regen rates means one side can block and attack more often, which is an invisible cheat`);
  });
});

/* ================================================== the player’s own combat */

describe('the player is driven by the same combat layer', () => {
  test('the attack intents declared in emptyIntent() are actually consumed', () => {
    const intent = emptyIntent();
    for (const key of ['attackLight', 'attackHeavy', 'block', 'blockHeld', 'parry']) {
      assert.ok(key in intent, `emptyIntent() is missing ${key}`);
    }
    // Regression guard: these fields existed from the start with nothing reading
    // them, so the entire melee layer was unreachable from a gamepad.
    const p = makePlayer();
    p.update(1 / 60, { ...emptyIntent(), attackLight: true }, {});
    assert.ok(p.swing.busy, 'attackLight did not start a swing');
  });

  test('attackLight costs ATTACK_STAMINA_LIGHT and locks locomotion', () => {
    const p = makePlayer();
    const before = p.stamina;
    p.update(1 / 60, { ...emptyIntent(), attackLight: true }, {});
    assert.close(before - p.stamina, COMBAT.ATTACK_STAMINA_LIGHT, 1e-9);
    assert.gt(p.attackLock, 0, 'a committed attack must lock locomotion');
    assert.close(p.attackLock, ATTACKS.light.windup + ATTACKS.light.active + ATTACKS.light.recovery * 0.7, 1e-9);
  });

  test('attackHeavy costs more and locks longer', () => {
    const l = makePlayer();
    const h = makePlayer();
    l.update(1 / 60, { ...emptyIntent(), attackLight: true }, {});
    h.update(1 / 60, { ...emptyIntent(), attackHeavy: true }, {});
    assert.lt(h.stamina, l.stamina, 'the heavy must leave less stamina than the light');
    assert.gt(h.attackLock, l.attackLock, 'the heavy must commit the player for longer');
    assert.equal(h.swing.kind, 'heavy');
  });

  test('heavy wins when both attack buttons are pressed on one frame', () => {
    const p = makePlayer();
    p.update(1 / 60, { ...emptyIntent(), attackLight: true, attackHeavy: true }, {});
    assert.equal(p.swing.kind, 'heavy',
      'a simultaneous press must do the committal thing the player was reaching for');
  });

  test('an attack is refused when stamina is short, and costs nothing', () => {
    const p = makePlayer();
    const short = COMBAT.ATTACK_STAMINA_HEAVY - 1;
    p.stamina = short;
    p.update(1 / 60, { ...emptyIntent(), attackHeavy: true }, {});
    assert.notOk(p.swing.busy, 'an attack started without the stamina to pay for it');
    assert.equal(p.attackLock, 0, 'a refused attack must not lock locomotion');
    // Compared with `gt`, not `close`: stamina regeneration runs before combat in
    // the same frame, so the exact value legitimately rises. What must not happen
    // is the cost being deducted from an attack that was refused.
    assert.gt(p.stamina, short - 1e-9,
      `a refused attack spent stamina: ${short} became ${p.stamina}`);
  });

  test('an attack cannot cancel its own recovery through the player', () => {
    const p = makePlayer();
    p.update(1 / 60, { ...emptyIntent(), attackLight: true }, {});
    const lock = p.attackLock;
    for (let i = 0; i < 5; i++) p.update(1 / 60, { ...emptyIntent(), attackLight: true }, {});
    assert.lte(p.attackLock, lock, 'mashing light must not extend or refresh the commitment');
    assert.equal(p.swing.chain, 1, 'mashing must not advance the combo chain');
  });

  test('a committed attack really stops the player moving', () => {
    const free = makePlayer();
    const committed = makePlayer();
    const walk = { ...emptyIntent(), moveZ: 1 };
    for (let i = 0; i < 12; i++) free.update(1 / 60, walk, {});
    committed.update(1 / 60, { ...walk, attackLight: true }, {});
    for (let i = 0; i < 11; i++) committed.update(1 / 60, walk, {});
    const freeDist = free.pos.distanceXZ(new Vec3(0, 0, 0));
    const committedDist = committed.pos.distanceXZ(new Vec3(0, 0, 0));
    assert.gt(freeDist, 0.05, 'the control run did not move, so the test proved nothing');
    assert.lt(committedDist, freeDist,
      `committing to a swing moved the player ${committedDist.toFixed(3)} m of the ${freeDist.toFixed(3)} m it would have covered`);
  });

  test('block is a hold model, matching the crouch hold model', () => {
    const p = makePlayer();
    p.update(1 / 60, { ...emptyIntent(), blockHeld: true }, {});
    assert.ok(p.blocking, 'holding block must raise the guard');
    p.update(1 / 60, emptyIntent(), {});
    assert.notOk(p.blocking, 'releasing block must lower the guard');
    const q = makePlayer();
    q.update(1 / 60, { ...emptyIntent(), block: true }, {});
    assert.ok(q.blocking, 'a block press must also raise the guard');
  });

  test('a parry opens exactly PARRY_WINDOW and then expires', () => {
    const p = makePlayer();
    p.update(1 / 60, { ...emptyIntent(), parry: true }, {});
    assert.close(p.parryTimer, COMBAT.PARRY_WINDOW, 1 / 60 + 1e-9,
      'the parry window must be the declared length');
    assert.ok(p.blocking, 'a parry attempt must still present a guard');
    let frames = 0;
    while (p.parryTimer > 0 && frames < 600) { p.update(1 / 60, emptyIntent(), {}); frames++; }
    assert.close(frames / 60, COMBAT.PARRY_WINDOW, 1 / 60 + 1e-6,
      `the window lasted ${frames / 60}s, declared ${COMBAT.PARRY_WINDOW}s`);
  });

  test('starting an attack drops the guard', () => {
    const p = makePlayer();
    p.update(1 / 60, { ...emptyIntent(), blockHeld: true }, {});
    assert.ok(p.blocking);
    p.update(1 / 60, { ...emptyIntent(), blockHeld: true, attackLight: true }, {});
    assert.notOk(p.blocking, 'you cannot swing and hold a guard at the same time');
  });

  test('applyStagger drops input for its declared duration, then restores control', () => {
    const p = makePlayer();
    assert.ok(p.applyStagger(StaggerLevel.LIGHT));
    assert.ok(p.staggered);
    assert.notOk(p.canAct);
    assert.equal(p.staggerLevel, StaggerLevel.LIGHT);
    assert.close(p.staggerTimer, COMBAT.STAGGER_TIME, 1e-9);
    assert.gt(p.attackLock, 0, 'a stagger must lock locomotion');
    const before = p.pos.clone();
    for (let i = 0; i < 10; i++) p.update(1 / 60, { ...emptyIntent(), moveZ: 1, attackLight: true }, {});
    assert.lt(p.pos.distanceXZ(before), 0.05, 'a staggered player must not walk away');
    assert.notOk(p.swing.busy, 'a staggered player must not attack');

    let frames = 10;   // the ten refusal frames above already burned 10/60 s
    while (p.staggered && frames < 600) { p.update(1 / 60, emptyIntent(), {}); frames++; }
    assert.close(frames / 60, COMBAT.STAGGER_TIME, 2 / 60 + 1e-6,
      `the stagger lasted ${frames / 60}s, declared ${COMBAT.STAGGER_TIME}s`);
    assert.ok(p.canAct, 'control must come back when the stagger ends');
    assert.equal(p.staggerLevel, StaggerLevel.NONE);
  });

  test('a heavier stagger wins, and an equal one refreshes rather than stacks', () => {
    const p = makePlayer();
    p.applyStagger(StaggerLevel.HEAVY);
    const heavy = p.staggerTimer;
    p.applyStagger(StaggerLevel.LIGHT);
    assert.close(p.staggerTimer, heavy, 1e-9,
      'a light stagger must not shorten a heavy one');
    assert.equal(p.staggerLevel, StaggerLevel.HEAVY);
    p.applyStagger(StaggerLevel.HEAVY);
    assert.lte(p.staggerTimer, COMBAT.HEAVY_STAGGER_TIME + 1e-9,
      'stagger durations must not stack, or a crowd could stun-lock the player forever');
  });

  test('a guard break makes the player helpless and refuses attacks', () => {
    const p = makePlayer();
    p.applyStagger(StaggerLevel.GUARD_BREAK);
    assert.ok(p.guardBroken);
    assert.notOk(p.canAct);
    assert.notOk(p.startAttack('light'), 'a guard-broken player must not be able to swing');
    assert.close(p.staggerTimer, COMBAT.GUARD_BREAK_TIME, 1e-9);
  });

  test('the player’s dodge i-frames are visible to the shared resolver', () => {
    // PlayerController needs invulnerableReason, or resolveMelee falls through to
    // a dead-check only and the player becomes MORE hittable than an enemy —
    // cheating in reverse, which is still cheating.
    const p = makePlayer();
    assert.equal(p.invulnerableReason, null, 'a standing player is hittable');
    p.iframes = 0.3;
    assert.equal(p.invulnerableReason, 'dodge-iframes');
    const enemy = fighter({ pos: new Vec3(0, 0, -1.5), yaw: FACING, side: Side.ENEMY });
    p.setPosition(new Vec3(0, 0, 0));
    const before = p.health;
    const r = resolveMelee(enemy, p, liveSwing('light'));
    assert.equal(r.outcome, HitOutcome.DODGED);
    assert.close(p.health, before, 1e-12, 'the player lost health through its own i-frames');
  });

  test('the player takes exactly the enemy’s declared damage from a clean hit', () => {
    const p = makePlayer(new Vec3(0, 0, 0));
    p.yaw = AWAY;   // face the enemy at -Z, so this measures a CLEAN hit
    const enemy = fighter({ pos: new Vec3(0, 0, -1.5), yaw: FACING, side: Side.ENEMY });
    assert.notOk(isBackstab(p, enemy.pos), 'the rig is measuring a backstab, not a clean hit');
    const before = p.health;
    const r = resolveMelee(enemy, p, liveSwing('light'));
    assert.equal(r.outcome, HitOutcome.HIT);
    assert.close(before - p.health, COMBAT.ENEMY_LIGHT_DAMAGE, 1e-9);
    assert.gt(p.hitIframes, 0, 'a hit must grant post-damage i-frames');
  });

  test('post-damage i-frames stop a single swing from draining health twice', () => {
    const p = makePlayer(new Vec3(0, 0, 0));
    const enemy = fighter({ pos: new Vec3(0, 0, -1.5), yaw: FACING, side: Side.ENEMY });
    resolveMelee(enemy, p, liveSwing('light'));
    const after = p.health;
    const r2 = resolveMelee(enemy, p, liveSwing('light'));
    assert.equal(r2.applied, 0, 'a second hit inside IFRAME_AFTER_DAMAGE must apply nothing');
    assert.close(p.health, after, 1e-12);
  });

  test('the player can block an enemy blow and lose no health', () => {
    const p = makePlayer(new Vec3(0, 0, 0));
    p.yaw = AWAY;                     // face the enemy, who is at -Z
    p.update(1 / 60, { ...emptyIntent(), blockHeld: true }, {});
    assert.ok(p.blocking);
    const enemy = fighter({ pos: new Vec3(0, 0, -1.5), yaw: FACING, side: Side.ENEMY });
    const before = p.health;
    const staminaBefore = p.stamina;
    const r = resolveMelee(enemy, p, liveSwing('light'));
    assert.equal(r.outcome, HitOutcome.BLOCKED, `expected a block, got ${r.outcome}/${r.reason}`);
    assert.close(p.health, before, 1e-12, 'the player lost health through a raised guard');
    assert.lt(p.stamina, staminaBefore, 'blocking must cost the player stamina too');
  });

  test('the player can parry an enemy blow and stagger the enemy', () => {
    const p = makePlayer(new Vec3(0, 0, 0));
    p.yaw = AWAY;
    p.update(1 / 60, { ...emptyIntent(), parry: true }, {});
    assert.gt(p.parryTimer, 0);
    const enemy = fighter({ pos: new Vec3(0, 0, -1.5), yaw: FACING, side: Side.ENEMY });
    const before = p.health;
    const r = resolveMelee(enemy, p, liveSwing('light'));
    assert.equal(r.outcome, HitOutcome.PARRIED);
    assert.close(p.health, before, 1e-12);
    assert.gt(enemy.staggerTimer, 0, 'the player’s parry must open the enemy up');
    assert.notOk(enemy.canAct);
  });

  test('combat is refused while dead', () => {
    const p = makePlayer();
    p.die('test');
    assert.equal(p.state, PlayerState.DEAD);
    p.update(1 / 60, { ...emptyIntent(), attackLight: true, blockHeld: true, parry: true }, {});
    assert.notOk(p.swing.busy, 'a dead player must not swing');
    assert.notOk(p.blocking, 'a dead player must not guard');
  });

  test('an injured Raynor hits softer, as declared', () => {
    const well = frontPair({ attackerSide: Side.PLAYER });
    const hurt = frontPair({ attackerSide: Side.PLAYER, attacker: { injured: true } });
    const rw = resolveMelee(well.attacker, well.defender, liveSwing('light'));
    const rh = resolveMelee(hurt.attacker, hurt.defender, liveSwing('light'));
    assert.close(rh.applied, rw.applied * COMBAT.INJURED_DAMAGE_SCALE, 1e-9,
      'the injury must cost something in combat, not only in movement');
    assert.lt(rh.applied, rw.applied, 'INJURED_DAMAGE_SCALE must actually reduce damage');
  });
});

/* ==================================================== gates: lock, finisher */

describe('lock-on, finisher and takedown gates', () => {
  test('pickLockTarget prefers the candidate closest to the facing direction', () => {
    const origin = new Vec3(0, 0, 0);
    const r = COMBAT.LOCK_ON_RANGE;
    const straight = fighter({ pos: new Vec3(0, 0, r * 0.5), id: 'straight' });
    const offset = fighter({ pos: new Vec3(r * 0.3, 0, r * 0.5), id: 'offset' });
    const picked = pickLockTarget([offset, straight], origin, FACING, {});
    assert.equal(picked, straight, 'angle must dominate the lock-on choice');
  });

  test('pickLockTarget ignores the dead and the out-of-range', () => {
    const origin = new Vec3(0, 0, 0);
    const dead = fighter({ pos: new Vec3(0, 0, 1.5) });
    dead.die('test');
    const far = fighter({ pos: new Vec3(0, 0, COMBAT.LOCK_ON_RANGE * 3) });
    assert.equal(pickLockTarget([dead, far], origin, FACING, {}), null,
      'locking onto a corpse or a distant enemy would pull the camera across the level');
  });

  test('pickLockTarget is sticky, so the lock does not flicker as the player turns', () => {
    const origin = new Vec3(0, 0, 0);
    const r = COMBAT.LOCK_ON_RANGE;
    const current = fighter({ pos: new Vec3(r * 0.28, 0, r * 0.45), id: 'current' });
    const better = fighter({ pos: new Vec3(0, 0, r * 0.44), id: 'better' });
    const sticky = pickLockTarget([better, current], origin, FACING, { current, canSwitch: false });
    assert.equal(sticky, current,
      'inside the switch cooldown the current target must be kept even when a better one exists');
  });

  test('pickLockTarget survives junk input', () => {
    assert.equal(pickLockTarget(null, new Vec3(0, 0, 0), 0, {}), null);
    assert.equal(pickLockTarget([], new Vec3(0, 0, 0), 0, {}), null);
    assert.equal(pickLockTarget([null, {}, { pos: null }], new Vec3(0, 0, 0), 0, {}), null);
    assert.equal(pickLockTarget([fighter({})], null, 0, {}), null);
  });

  test('canFinisher requires a wounded target, inside range and inside angle', () => {
    const attacker = fighter({ pos: new Vec3(0, 0, 0), yaw: FACING });
    const healthy = fighter({ pos: new Vec3(0, 0, COMBAT.FINISHER_RANGE * 0.5), yaw: AWAY });
    assert.equal(canFinisher(attacker, healthy).reason, 'target-healthy',
      'executing a full-health enemy would remove the fight');

    const wounded = fighter({
      pos: new Vec3(0, 0, COMBAT.FINISHER_RANGE * 0.5), yaw: AWAY,
      health: COMBAT.ENEMY_MAX_HEALTH * COMBAT.FINISHER_HEALTH_THRESHOLD * 0.5,
    });
    const ok = canFinisher(attacker, wounded);
    assert.ok(ok.ok, `a legal finisher was refused: ${ok.reason}`);

    const far = fighter({
      pos: new Vec3(0, 0, COMBAT.FINISHER_RANGE * 2), yaw: AWAY,
      health: COMBAT.ENEMY_MAX_HEALTH * COMBAT.FINISHER_HEALTH_THRESHOLD * 0.5,
    });
    assert.equal(canFinisher(attacker, far).reason, 'out-of-range');

    const sideways = fighter({
      pos: new Vec3(COMBAT.FINISHER_RANGE * 0.5, 0, 0), yaw: AWAY,
      health: COMBAT.ENEMY_MAX_HEALTH * COMBAT.FINISHER_HEALTH_THRESHOLD * 0.5,
    });
    assert.equal(canFinisher(attacker, sideways).reason, 'outside-angle');
  });

  test('canFinisher refuses the dead and the malformed', () => {
    const attacker = fighter({});
    const dead = fighter({ pos: new Vec3(0, 0, 1), health: 1 });
    dead.die('test');
    assert.equal(canFinisher(attacker, dead).reason, 'target-dead');
    const deadAttacker = fighter({});
    deadAttacker.die('test');
    assert.equal(canFinisher(deadAttacker, fighter({ pos: new Vec3(0, 0, 1), health: 1 })).reason, 'attacker-dead');
    assert.equal(canFinisher(null, null).reason, 'malformed');
  });

  test('canTakedown requires being behind the target, inside range', () => {
    const defender = fighter({ pos: new Vec3(0, 0, 0), yaw: FACING });
    const behind = fighter({ pos: new Vec3(0, 0, -STEALTH.TAKEDOWN_RANGE * 0.7) });
    const ok = canTakedown(behind, defender, {});
    assert.ok(ok.ok, `a legal takedown was refused: ${ok.reason}`);

    const inFront = fighter({ pos: new Vec3(0, 0, STEALTH.TAKEDOWN_RANGE * 0.7) });
    assert.equal(canTakedown(inFront, defender, {}).reason, 'not-behind',
      'a takedown from the front is not a stealth kill, it is a fight');

    const tooFar = fighter({ pos: new Vec3(0, 0, -STEALTH.TAKEDOWN_RANGE * 3) });
    assert.equal(canTakedown(tooFar, defender, {}).reason, 'out-of-range');
  });

  test('a takedown is refused while the player is detected', () => {
    const defender = fighter({ pos: new Vec3(0, 0, 0), yaw: FACING });
    const behind = fighter({ pos: new Vec3(0, 0, -STEALTH.TAKEDOWN_RANGE * 0.7) });
    assert.ok(canTakedown(behind, defender, { detected: false }).ok);
    assert.equal(canTakedown(behind, defender, { detected: true }).reason, 'detected',
      'a takedown that works while detected removes the entire stealth layer');
  });

  test('the takedown angle honours TAKEDOWN_ANGLE_DEG at its boundary', () => {
    const defender = fighter({ pos: new Vec3(0, 0, 0), yaw: FACING });
    const limit = 180 - STEALTH.TAKEDOWN_ANGLE_DEG * 0.5;
    const at = (deg) => {
      const r = deg * Math.PI / 180;
      const d = STEALTH.TAKEDOWN_RANGE * 0.7;
      return fighter({ pos: new Vec3(Math.sin(r) * d, 0, Math.cos(r) * d) });
    };
    assert.close(angleOffFacing(defender.pos, defender.yaw, at(limit + 2).pos), limit + 2, 1e-9,
      'the rig does not place the attacker where it claims to');
    assert.ok(canTakedown(at(limit + 2), defender, {}).ok, 'just inside the cone must work');
    assert.equal(canTakedown(at(limit - 2), defender, {}).reason, 'not-behind',
      'just outside the cone must be refused');
  });
});

/* ================================================ determinism, hitstop, cost */

describe('determinism, hitstop and cost', () => {
  test('two identical combat runs are bit-identical', () => {
    const script = [];
    for (let i = 0; i < 240; i++) {
      // No locomotion input: this suite is proving that combat resolves
      // identically, and a script that walked the player out of reach would make
      // most frames trivial misses and weaken the claim.
      script.push({
        attackLight: i % 23 === 0,
        attackHeavy: i % 61 === 0,
        blockHeld: i % 37 < 12,
        parry: i % 89 === 0,
        sprint: i % 5 === 0,
      });
    }
    const run = () => {
      const p = makePlayer(new Vec3(0, 0, 0));
      const e = fighter({ pos: new Vec3(0, 0, -1.4), yaw: FACING, side: Side.ENEMY });
      const log = [];
      for (const s of script) {
        p.update(1 / 60, { ...emptyIntent(), ...s }, {});
        e.update(1 / 60);
        if (i_frames_marker(s)) e.startAttack(e.swing.chain >= 3 ? 'heavy' : 'light');
        for (let k = 0; k < 200; k++) { e.swing.update(DT); if (e.swing.phase === SwingPhase.ACTIVE) break; }
        const r = resolveMelee(e, p, e.swing);
        log.push([
          Number(p.health.toFixed(9)), Number(p.stamina.toFixed(9)),
          Number(p.pos.x.toFixed(9)), Number(p.pos.z.toFixed(9)),
          Number(p.attackLock.toFixed(9)), p.swing.phase, p.swing.chain,
          Number(p.parryTimer.toFixed(9)), p.blocking, p.staggerLevel,
          Number(e.health.toFixed(9)), r.outcome, Number(r.applied.toFixed(9)), r.crit,
        ]);
      }
      return log;
    };
    const a = run();
    const b = run();
    assert.equal(a.length, 240, 'the run produced no frames');
    assert.deepEqual(a, b, 'combat is not deterministic — a replay would diverge');
    const damaged = a.filter((row) => row[11] === HitOutcome.HIT).length;
    assert.gt(damaged, 0, 'the script never produced a hit, so determinism proved nothing');
  });

  test('hitstop freezes time by the declared factor and recovers', () => {
    const state = { hitstop: 0 };
    assert.notOk(hitstopActive(state), 'idle state must not be in hitstop');
    state.hitstop = COMBAT.HITSTOP_LIGHT;
    assert.ok(hitstopActive(state));
    let frames = 0;
    while (hitstopActive(state) && frames < 600) { advanceHitstop(state, 1 / 60); frames++; }
    assert.close(frames / 60, COMBAT.HITSTOP_LIGHT, 2 / 60 + 1e-6,
      `hitstop lasted ${frames / 60}s, declared ${COMBAT.HITSTOP_LIGHT}s`);
    assert.notOk(hitstopActive(state));
    assert.doesNotThrow(() => advanceHitstop(null, 1 / 60), 'advanceHitstop must tolerate a missing state');
    assert.doesNotThrow(() => advanceHitstop(state, NaN), 'advanceHitstop must tolerate NaN dt');
    assert.ok(Number.isFinite(state.hitstop), 'hitstop went non-finite');
  });

  test('resolveMelee is cheap enough to run for a crowd every frame', () => {
    const pairs = [];
    for (let i = 0; i < 12; i++) {
      pairs.push(frontPair());
    }
    // The live swing is built ONCE and restored each iteration. Simulating a
    // fresh windup inside the measurement would time the rig instead of the
    // resolver and report a number that means nothing.
    const saved = pairs.map(() => liveSwing('light').serialize());
    const swings = pairs.map(() => new Swing('light'));
    const ms = measure(() => {
      for (let i = 0; i < pairs.length; i++) {
        const p = pairs[i];
        swings[i].restore(saved[i]);
        p.defender.hitIframes = 0;
        p.defender.staggerTimer = 0;
        p.defender.blocking = false;
        p.defender.health = p.defender.maxHealth;
        resolveMelee(p.attacker, p.defender, swings[i]);
      }
    }, 60, 8);
    const perCall = ms / 12;
    assert.lt(perCall, 0.35,
      `resolveMelee costs ${perCall.toFixed(4)} ms per call; 12 enemies would cost ${(perCall * 12).toFixed(3)} ms of a 16.7 ms frame`);
    console.log(`      resolveMelee: ${perCall.toFixed(4)} ms/call, ${(perCall * 12).toFixed(3)} ms for 12 fighters`);
  });

  test('a full melee exchange stays inside one frame budget', () => {
    const player = makePlayer(new Vec3(0, 0, 0));
    const enemies = [];
    for (let i = 0; i < 6; i++) {
      enemies.push(fighter({
        pos: new Vec3(Math.cos(i) * 1.6, 0, Math.sin(i) * 1.6 - 1.6),
        yaw: FACING, side: Side.ENEMY, id: `e${i}`,
      }));
    }
    const intent = { ...emptyIntent(), moveZ: 1, attackLight: true, blockHeld: false };
    const saved = enemies.map(() => liveSwing('light').serialize());
    const ms = measure(() => {
      player.update(1 / 60, intent, {});
      for (let i = 0; i < enemies.length; i++) {
        const e = enemies[i];
        e.update(1 / 60);
        e.swing.restore(saved[i]);
        resolveMelee(e, player, e.swing);
        resolveMelee(player, e, player.swing);
      }
      player.iframes = 0; player.hitIframes = 0; player.staggerTimer = 0;
      player.health = player.maxHealth;
      for (const e of enemies) { e.health = e.maxHealth; e.hitIframes = 0; e.staggerTimer = 0; }
    }, 200, 20);
    assert.lt(ms, 4.0,
      `a 1-vs-6 exchange with the player costs ${ms.toFixed(3)} ms — that is ${((ms / 16.7) * 100).toFixed(1)}% of a 60 fps frame before rendering`);
    console.log(`      1-vs-6 melee frame (player + 6 AI + 12 resolutions): ${ms.toFixed(3)} ms`);
  });
});

/** True on frames where the scripted enemy should commit to a swing. */
function i_frames_marker(s) { return s.attackLight === true || s.attackHeavy === true; }

runAndExit();
