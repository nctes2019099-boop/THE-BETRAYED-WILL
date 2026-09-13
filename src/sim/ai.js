/**
 * THE BETRAYED WILL — ai.js
 *
 * Enemy perception, decision and movement.
 *
 * ── The one rule this module is built around ────────────────────────────────
 * §11 says the AI must not cheat. The usual way to fail that is to write an AI
 * that *looks* fair: it reads the player's true position, then subtracts a few
 * "fairness" numbers (a reaction delay, a random accuracy spread) and calls that
 * a handicap. It is not a handicap, because the AI still never loses track of
 * you - it just pretends not to. Players feel the difference immediately even
 * when they cannot name it, and it is why "the guards know where I am" is the
 * single most common complaint about stealth games.
 *
 * So the fairness here is structural, not arithmetic:
 *
 *   1. The player's true state arrives as `_truth` and EXACTLY ONE method reads
 *      it: `_perceive()`. Everything downstream - deciding, steering, choosing
 *      to swing - reads `this.memory`, which is what the agent believes. A
 *      belief that is wrong produces wrong behaviour, which is the point.
 *   2. `_perceive()` is a real sensor: view cone, peripheral falloff, exposure
 *      from light and stance, range scaled by that exposure, vertical tolerance,
 *      and a line-of-sight raycast through actual generated geometry. Break any
 *      one of them and the agent genuinely stops seeing you.
 *   3. An agent commits to a swing based on its distance to where it LAST SAW
 *      you, not to where you are. resolveMelee() then fairly resolves against
 *      reality - so if you stepped aside during the windup, the blow misses.
 *      The AI is allowed to be wrong. That is the whole game.
 *   4. Movement goes through CollisionWorld.moveCapsule(), the identical entry
 *      point PlayerController uses, and routes are found on the same nav grid by
 *      the same A*. An enemy cannot pass through a wall the player cannot.
 *   5. An enemy's top speed is MOVE.RUN_SPEED, never MOVE.SPRINT_SPEED. If the
 *      AI could outsprint the player, disengaging would be impossible and every
 *      alert would be a forced fight.
 *   6. Damage, stagger, block, parry and i-frames all come from combat.js, which
 *      both sides call. The AI has no private damage path.
 *   7. GroupCoordinator caps simultaneous attackers at AI.GROUP_ATTACK_SLOTS.
 *      Six enemies is a fight; sixty points of damage per second is a execution.
 *
 * Nothing here touches the DOM or Three.js. Every suite that drives this module
 * runs headless in plain Node.
 */

import { Vec3, clamp, shortestAngle } from '../core/math.js';
import { AI, COMBAT, MOVE, STEALTH, PERF } from '../core/constants.js';
import { Events } from '../core/bus.js';
import { Pathfinder } from './astar.js';
import {
  ATTACKS, Combatant, HitOutcome, Side, StaggerLevel, SwingPhase, angleOffFacing,
  resolveMelee,
} from './combat.js';

/* ------------------------------------------------------------------ states */

export const AIState = Object.freeze({
  IDLE: 'idle',             // at a post, watching
  PATROL: 'patrol',         // walking a route
  SUSPICIOUS: 'suspicious', // heard or glimpsed something, turning to look
  INVESTIGATE: 'investigate', // walking to the last known position
  SEARCH: 'search',         // sweeping the area around it
  CHASE: 'chase',           // hostile, pursuing
  ATTACK: 'attack',         // hostile, in range, committed to a swing
  CIRCLE: 'circle',         // hostile, in range, waiting for an attack slot
  RETREAT: 'retreat',       // badly hurt, breaking away
  DOWN: 'down',             // staggered / knocked down, cannot act
  DEAD: 'dead',
});

/** States in which the agent is openly hostile and will kill on sight. */
const HOSTILE = Object.freeze(new Set([AIState.CHASE, AIState.ATTACK, AIState.CIRCLE]));

/** States that own a body and refuse new orders until they expire. */
const HELD = Object.freeze(new Set([AIState.DOWN, AIState.DEAD]));

/* ------------------------------------------------------- tuning derivations */

// Derived from declared constants rather than invented, so a tuning change to
// the capsule moves the eye line with it instead of leaving guards seeing over
// walls they should not see over - or through floors they should.
const EYE_HEIGHT = MOVE.CAPSULE_HEIGHT * 0.92;
const TARGET_CHEST_HEIGHT = MOVE.CAPSULE_HEIGHT * 0.55;

/** How far an agent stands from a waypoint before it counts as reached. */
const WAYPOINT_TOLERANCE = MOVE.CAPSULE_RADIUS * 1.6;

/**
 * A tiny seedable generator.
 *
 * AI must be deterministic for the same seed: a tester reproducing "the guard
 * walked into the wall in the courtyard" needs the run to repeat, and the
 * combat suite asserts bit-identical replays. Math.random() would make both
 * impossible. Injected so a test can pin it, defaulted so production is seeded.
 */
export function makeRng(seed = 0x2f6e2b1) {
  let s = seed >>> 0 || 1;
  return function rng() {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/* ------------------------------------------------------------- perception */

/**
 * How visible a body is, 0..1, before the view cone and range are considered.
 *
 * Pure, so the whole stealth model can be tested without an agent, a world or a
 * frame loop. Every factor is a declared constant.
 */
export function exposureFor(opts = {}) {
  const light = Number.isFinite(opts.lightLevel)
    ? clamp(opts.lightLevel, 0, 1)
    : (opts.isNight ? STEALTH.LIGHT_EXPOSURE_NIGHT : STEALTH.LIGHT_EXPOSURE_DAY);
  let e = light;

  if (opts.inShadow === true) e *= STEALTH.SHADOW_EXPOSURE_SCALE;
  if (opts.stance === 'crouch') e *= STEALTH.CROUCH_EXPOSURE_SCALE;
  else if (opts.stance === 'prone') e *= STEALTH.PRONE_EXPOSURE_SCALE;

  const speed = Number.isFinite(opts.speed) ? Math.abs(opts.speed) : 0;
  if (speed > MOVE.WALK_SPEED * 0.5) e *= STEALTH.MOVEMENT_EXPOSURE_SCALE;

  const weather = STEALTH.WEATHER_EXPOSURE[opts.weather ?? 'clear'] ?? 1;
  e *= weather;

  return clamp(e, 0, 1);
}

/**
 * View-cone weighting: 1 inside the main cone, PERIPHERAL_MULTIPLIER in the
 * weaker peripheral band, 0 outside both.
 *
 * A guard with 360° vision makes cover meaningless. A guard with no peripheral
 * vision can be walked past at its shoulder, which reads as broken. Two bands
 * is the compromise, and both angles are declared.
 */
export function viewConeFactor(angleDeg) {
  if (!Number.isFinite(angleDeg)) return 0;
  const a = Math.abs(angleDeg);
  if (a <= STEALTH.VIEW_CONE_DEG * 0.5) return 1;
  if (a <= STEALTH.PERIPHERAL_CONE_DEG * 0.5) return STEALTH.PERIPHERAL_MULTIPLIER;
  return 0;
}

/**
 * How far an agent can actually see a body at this exposure.
 *
 * Linear between DETECT_RANGE_MIN and DETECT_RANGE_MAX, so an unlit crouching
 * figure is invisible past a few metres and a sprinting figure in daylight is
 * visible across a courtyard. Clamped at the declared minimum so a bright
 * target never becomes invisible at point-blank range.
 */
export function effectiveDetectRange(exposure, isNight = false) {
  const e = clamp(Number.isFinite(exposure) ? exposure : 0, 0, 1);
  const span = STEALTH.DETECT_RANGE_MAX - STEALTH.DETECT_RANGE_MIN;
  const r = STEALTH.DETECT_RANGE_MIN + span * e;
  return isNight ? r * 0.82 : r;
}

/** Seconds of sustained exposure needed to be spotted at this exposure level. */
export function detectTimeFor(exposure, isNight = false) {
  const base = isNight ? STEALTH.DETECT_TIME_NIGHT : STEALTH.DETECT_TIME_DAY;
  const e = clamp(Number.isFinite(exposure) ? exposure : 0, 0, 1);
  if (e <= 1e-6) return Infinity;      // never spotted, however long you wait
  return base / e;
}

/**
 * Whether a noise of the given radius is audible at this distance, and how
 * strongly. Ambient weather masks sound - rain hiding footsteps is a real
 * stealth tool, not a flavour line.
 */
export function noiseAudibility(noiseRadius, distance, weather = 'clear') {
  if (!Number.isFinite(noiseRadius) || noiseRadius <= 0) return 0;
  const d = Number.isFinite(distance) ? Math.max(0, distance) : Infinity;
  if (d > noiseRadius) return 0;
  if (d <= 1e-6) return 1;
  const mask = STEALTH.AMBIENT_MASK_RAIN && weather === 'rain' ? STEALTH.AMBIENT_MASK_RAIN
    : weather === 'storm' ? STEALTH.AMBIENT_MASK_STORM
      : STEALTH.AMBIENT_MASK_CLEAR;
  const falloff = Math.pow(1 - d / noiseRadius, 1 / STEALTH.NOISE_DECAY_EXPONENT);
  return clamp(falloff * mask, 0, 1);
}

/**
 * Evaluate every sight gate for one agent against one truth sample.
 *
 * Pure and exported for two reasons. The debug overlay needs to answer "why can
 * this guard not see me?" per gate, and the test suite needs to assert each gate
 * independently - a copy of this logic in either place would drift, and a
 * drifted copy is how an AI ends up seeing through walls in production while the
 * tests still pass. `_perceive()` calls this; nothing is duplicated.
 *
 * @param {EnemyAgent} agent
 * @param {object} truth the player's real state
 * @param {object} opts { raycast: boolean, losFallback: boolean }
 * @returns {object} every intermediate value, and the final `visible` verdict
 */
export function perceptionProbe(agent, truth, opts = {}) {
  const out = {
    dy: Infinity, verticalOk: false, angleDeg: 180, cone: 0, baseExposure: 0,
    exposure: 0, range: 0, distance: Infinity, inRange: false,
    losClear: opts.losFallback === true, visible: false, reason: 'no-truth',
  };
  if (!agent || !truth || !truth.playerPos) return out;
  const pos = truth.playerPos;
  if (!Number.isFinite(pos.x) || !Number.isFinite(pos.z)) { out.reason = 'non-finite'; return out; }

  const body = agent.body ?? agent;
  const eye = new Vec3(body.pos.x, body.pos.y + EYE_HEIGHT, body.pos.z);
  const chest = new Vec3(pos.x, (pos.y ?? 0) + TARGET_CHEST_HEIGHT, pos.z);

  out.dy = Math.abs(chest.y - eye.y);
  out.verticalOk = out.dy <= STEALTH.VERTICAL_TOLERANCE;
  if (!out.verticalOk) { out.reason = 'vertical'; return out; }

  out.angleDeg = angleOffFacing(eye, body.yaw, chest);
  out.cone = viewConeFactor(out.angleDeg);
  if (out.cone <= 0) { out.losClear = false; out.reason = 'outside-cone'; return out; }

  out.baseExposure = exposureFor({
    stance: truth.stance, speed: truth.speed, lightLevel: truth.lightLevel,
    inShadow: truth.inShadow, weather: truth.weather, isNight: truth.isNight,
  });
  out.exposure = out.baseExposure * out.cone;
  out.range = effectiveDetectRange(out.exposure, truth.isNight === true);
  out.distance = eye.distanceXZ(chest);
  out.inRange = out.distance <= out.range;
  if (!out.inRange) { out.losClear = false; out.reason = 'out-of-range'; return out; }

  if (opts.raycast !== false) {
    out.losClear = agent.collision
      ? agent.collision.hasLineOfSight(eye, chest) === true
      : true;
  }
  if (!out.losClear) { out.reason = 'no-line-of-sight'; return out; }

  out.visible = true;
  out.reason = 'visible';
  return out;
}

/**
 * What an agent believes about the player.
 *
 * This object - not the player - is the AI's entire universe. Every steering,
 * targeting and attack decision reads it. `lastKnownPos` is a COPY, taken at the
 * moment of perception, so it cannot silently track the player afterwards.
 */
export class AgentMemory {
  constructor() { this.clear(); }

  clear() {
    this.lastKnownPos = null;
    this.age = Infinity;          // seconds since the memory was formed
    this.sawTarget = false;       // was it sight, or only sound?
    this.confidence = 0;          // 0..1, how much the agent trusts the position
  }

  /** Record a sighting. Copies the position; never holds a reference. */
  noteSighting(pos, confidence = 1) {
    this.lastKnownPos = pos ? new Vec3(pos.x, pos.y ?? 0, pos.z) : null;
    this.age = 0;
    this.sawTarget = true;
    this.confidence = clamp(confidence, 0, 1);
    return this;
  }

  /** Record a sound: a position the agent will go and look at, less trusted. */
  noteNoise(pos, confidence = 0.45) {
    this.lastKnownPos = pos ? new Vec3(pos.x, pos.y ?? 0, pos.z) : null;
    this.age = 0;
    this.sawTarget = false;
    this.confidence = clamp(confidence, 0, 1);
    return this;
  }

  update(dt) {
    if (Number.isFinite(this.age)) this.age += Math.max(0, dt);
    if (this.age > STEALTH.MEMORY_DURATION) this.clear();
    return this;
  }

  get fresh() { return this.lastKnownPos !== null && this.age <= STEALTH.MEMORY_DURATION; }

  /** Memory fades: a position seen 20 s ago is a guess, not a fact. */
  get decayedConfidence() {
    if (!this.fresh) return 0;
    return this.confidence * clamp(1 - this.age / STEALTH.MEMORY_DURATION, 0, 1);
  }

  serialize() {
    return {
      lastKnownPos: this.lastKnownPos ? this.lastKnownPos.toArray() : null,
      age: Number.isFinite(this.age) ? this.age : -1,
      sawTarget: this.sawTarget, confidence: this.confidence,
    };
  }

  restore(data) {
    this.clear();
    if (!data) return this;
    if (Array.isArray(data.lastKnownPos)) {
      const p = Vec3.fromArray(data.lastKnownPos);
      if (p.isFiniteVec()) this.lastKnownPos = p;
    }
    const age = Number.isFinite(data.age) && data.age >= 0 ? data.age : Infinity;
    this.age = age;
    this.sawTarget = data.sawTarget === true;
    this.confidence = clamp(Number.isFinite(data.confidence) ? data.confidence : 0, 0, 1);
    return this;
  }
}

/* ------------------------------------------------------- group coordination */

/**
 * Who is allowed to attack right now.
 *
 * Without this, N enemies all swing on their own cooldowns and the player takes
 * N times the declared damage per second. That is not "harder", it is unfair in
 * a way the player cannot read or plan around, and it makes group size - rather
 * than positioning - the only thing that matters. AI.GROUP_ATTACK_SLOTS caps it,
 * and slots are released on a timer so a stalled attacker cannot hold one
 * forever and freeze the fight.
 */
export class GroupCoordinator {
  constructor(slots = AI.GROUP_ATTACK_SLOTS) {
    this.slots = Math.max(1, Number.isFinite(slots) ? Math.floor(slots) : AI.GROUP_ATTACK_SLOTS);
    /** @type {Map<string, number>} agentId -> seconds remaining on its slot */
    this.held = new Map();
    this.telemetry = { granted: 0, refused: 0, expired: 0 };
  }

  get inUse() { return this.held.size; }
  get available() { return Math.max(0, this.slots - this.held.size); }

  update(dt) {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    for (const [id, remaining] of this.held) {
      const next = remaining - step;
      if (next <= 0) { this.held.delete(id); this.telemetry.expired++; }
      else this.held.set(id, next);
    }
    return this;
  }

  /** True if this agent already holds a slot (and refreshes it). */
  holds(id) { return this.held.has(id); }

  request(id) {
    if (id == null) return false;
    if (this.held.has(id)) {
      this.held.set(id, AI.GROUP_SLOT_RELEASE_TIME);
      return true;
    }
    if (this.held.size >= this.slots) { this.telemetry.refused++; return false; }
    this.held.set(id, AI.GROUP_SLOT_RELEASE_TIME);
    this.telemetry.granted++;
    return true;
  }

  release(id) { return this.held.delete(id); }

  /** A dead or retreating agent must give its slot back immediately. */
  releaseAll(pred) {
    if (typeof pred !== 'function') { this.held.clear(); return this; }
    for (const id of [...this.held.keys()]) if (pred(id)) this.held.delete(id);
    return this;
  }

  serialize() { return { slots: this.slots, held: [...this.held.entries()] }; }

  restore(data) {
    this.held.clear();
    if (!data) return this;
    this.slots = Math.max(1, Number.isFinite(data.slots) ? data.slots : this.slots);
    for (const entry of data.held ?? []) {
      if (Array.isArray(entry) && entry.length === 2 && Number.isFinite(entry[1]) && entry[1] > 0) {
        this.held.set(entry[0], entry[1]);
      }
    }
    return this;
  }
}

/* ------------------------------------------------------------ the agent */

/**
 * One enemy.
 *
 * Composition over inheritance: `body` IS a Combatant, the exact same class the
 * melee resolver fights against when the player swings. There is no second
 * health bar, no second stamina pool and no second damage path for the AI.
 */
export class EnemyAgent {
  constructor(opts = {}) {
    this.id = opts.id ?? 'agent';
    this.bus = opts.bus ?? null;
    this.rng = typeof opts.rng === 'function' ? opts.rng : makeRng(0x51ed2701);
    this.collision = opts.collision ?? null;
    this.nav = opts.nav ?? null;
    this.pathfinder = opts.pathfinder ?? null;
    this.sidestepTimer = 0;       // stuck recovery: steer sideways, not into it
    this.sidestepDir = 1;
    this.group = opts.group ?? null;

    this.body = opts.body instanceof Combatant
      ? opts.body
      // The bus goes to the body as well as to the agent. Combatant.die() is the one
      // place every death passes through - a sword, a takedown, a finisher, a fall - and
      // it emits COMBAT_KILL through _emit(), which does nothing at all without a bus.
      // Every guard built by makeGuard() had one on the agent and none on the body, so a
      // guard killed by anything other than resolveMelee() died silently: no HUD, no
      // music sting, no audio cue, and nothing to tell the two apart from a guard who
      // was never there.
      : new Combatant({
        id: this.id, side: Side.ENEMY, pos: opts.pos ?? new Vec3(0, 0, 0),
        yaw: Number.isFinite(opts.yaw) ? opts.yaw : 0,
        maxHealth: opts.maxHealth, health: opts.health,
        bus: this.bus,
      });
    if (!(this.body.pos instanceof Vec3)) this.body.pos = new Vec3(0, 0, 0);

    /** The player's real state. READ BY _perceive() AND NOWHERE ELSE. */
    this._truth = null;

    this.memory = new AgentMemory();
    this.suspicion = 0;
    this.suspicionHold = 0;         // STEALTH.SUSPICION_DECAY_DELAY before decay
    this.state = AIState.IDLE;
    this.prevState = AIState.IDLE;

    // Timing
    this.tickAccum = 0;             // decision cadence (AI.TICK_INTERVAL)
    this.losAccum = 0;              // line-of-sight cadence (AI.LOS_UPDATE_INTERVAL)
    this.repathAccum = 0;
    this.reactionTimer = 0;         // humans are not instant (§11)
    this.reacting = false;          // true while that delay is being served
    this.aimDelay = 0;              // AI.AIM_DELAY_ON_FIRST_SIGHT
    this.attackCooldown = 0;
    this.stateTime = 0;
    this.searchTimer = 0;
    this.circleDir = this.rng() < 0.5 ? -1 : 1;
    this.circleTimer = 0;

    // Locomotion
    this.path = [];
    this.pathIndex = 0;
    this.patrol = Array.isArray(opts.patrol) ? opts.patrol.map(p => new Vec3(p.x, p.y ?? 0, p.z)) : [];
    this.patrolIndex = 0;
    this.home = this.body.pos.clone();
    this.homeYaw = this.body.yaw;     // the centre of an idle guard's scan
    this.scanPhase = this.rng() * Math.PI * 2;   // desynchronised across a group
    this.speedPlanar = 0;
    this.grounded = true;
    this.stuckTimer = 0;
    this.lastProgressPos = this.body.pos.clone();
    this.losClear = false;
    this.seesTargetNow = false;

    /** Per-agent speed ceiling. Never SPRINT: see the module header, rule 5. */
    this.maxSpeed = opts.maxSpeed ?? MOVE.RUN_SPEED;

    /**
     * Path query ceilings for this agent. Null means "use the tactical constants",
     * which is what the shipped game does.
     *
     * They are injectable because those constants are WALL-CLOCK ceilings. A
     * simulation stepped on a loaded machine gets different routes than the same
     * simulation stepped on an idle one, so nothing deterministic - a test, a replay,
     * a recorded save being verified - can be built directly on the default. Passing
     * 0 disables the clock; the node budget still bounds the work.
     */
    this.pathTimeBudgetMs = opts.pathTimeBudgetMs ?? null;
    this.pathMaxNodes = opts.pathMaxNodes ?? null;

    this.telemetry = {
      ticks: 0, perceptions: 0, sightings: 0, hearings: 0, paths: 0, pathFailures: 0,
      attacks: 0, slotsRefused: 0, stateChanges: 0, stuckEvents: 0, frames: 0,
      kinematicMoves: 0,
      maxDecisionMs: 0, totalDecisionMs: 0,
    };
  }

  /* -- accessors that mirror Combatant, so callers can treat either uniformly */
  get pos() { return this.body.pos; }
  get yaw() { return this.body.yaw; }
  get health() { return this.body.health; }
  get maxHealth() { return this.body.maxHealth; }
  get healthFraction() { return this.body.healthFraction; }
  get stamina() { return this.body.stamina; }
  get blocking() { return this.body.blocking; }
  get parryTimer() { return this.body.parryTimer; }
  get iframes() { return this.body.iframes; }
  get dead() { return this.body.dead; }
  get isDead() { return this.body.isDead; }
  get alive() { return this.body.alive; }
  get canAct() { return this.body.canAct; }
  get staggered() { return this.body.staggered; }
  get invulnerableReason() { return this.body.invulnerableReason; }

  /** The position this agent is actually steering toward. Never `_truth`. */
  get objective() {
    if (HELD.has(this.state)) return null;
    if (this.memory.fresh) return this.memory.lastKnownPos;
    if (this.state === AIState.PATROL) return this._patrolWaypoint();
    return this.home;
  }

  get isHostile() { return HOSTILE.has(this.state); }

  /* ------------------------------------------------------------ main loop */

  /**
   * Advance one frame.
   *
   * @param {number} dt seconds
   * @param {object} truth the player's REAL state: { playerPos, stance, speed,
   *                 noiseRadius, lightLevel, weather, isNight, player }
   * @returns {object} a snapshot of what this agent did and believes
   */
  update(dt, truth = {}) {
    this.telemetry.frames++;
    const t0 = nowMs();
    let step = Number.isFinite(dt) ? dt : 1 / 60;
    step = clamp(step, 0, 0.1);      // a tab-switch spike must not teleport a guard

    this._truth = truth ?? null;

    if (this.body.isDead) {
      this._setState(AIState.DEAD);
      this._releaseSlot();
      this._finishTiming(t0);
      return this.snapshot();
    }

    // A stagger owns the body. The agent still perceives - being hit does not
    // make you blind - but it cannot act, which is what makes a stagger worth
    // landing and a parry worth attempting.
    if (!this.body.canAct) {
      this._setState(AIState.DOWN);
      this._releaseSlot();
      this._perceive(step);
      this.memory.update(step);
      this.body.update(step);
      this._finishTiming(t0);
      return this.snapshot();
    }

    this._decayTimers(step);
    this._perceive(step);
    this.memory.update(step);
    this._updateSuspicion(step);

    // Decisions run on AI.TICK_INTERVAL, not every frame: perception and steering
    // stay smooth at 60+ fps while the expensive reasoning is budgeted.
    this.tickAccum += step;
    if (this.tickAccum >= AI.TICK_INTERVAL) {
      this.tickAccum = 0;
      this.telemetry.ticks++;
      this._decide();
    }

    this._act(step);
    this.body.update(step);
    this._finishTiming(t0);
    return this.snapshot();
  }

  _finishTiming(t0) {
    const ms = nowMs() - t0;
    this.telemetry.totalDecisionMs += ms;
    if (ms > this.telemetry.maxDecisionMs) this.telemetry.maxDecisionMs = ms;
  }

  _decayTimers(dt) {
    this.stateTime += dt;
    this.reactionTimer = Math.max(0, this.reactionTimer - dt);
    this.aimDelay = Math.max(0, this.aimDelay - dt);
    this.attackCooldown = Math.max(0, this.attackCooldown - dt);
    this.circleTimer = Math.max(0, this.circleTimer - dt);
    this.sidestepTimer = Math.max(0, this.sidestepTimer - dt);
    this.repathAccum += dt;
    this.losAccum += dt;
  }

  /* ------------------------------------------------------------ perception */

  /**
   * THE ONLY READER OF `_truth`.
   *
   * Runs on AI.LOS_UPDATE_INTERVAL for the expensive raycast, and every frame
   * for the cheap accumulation, so suspicion builds smoothly while geometry
   * queries stay inside the frame budget.
   */
  _perceive(dt) {
    const truth = this._truth;
    if (!truth || !truth.playerPos) return;
    this.telemetry.perceptions++;

    const pos = truth.playerPos;
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.z)) return;

    const eye = new Vec3(this.body.pos.x, this.body.pos.y + EYE_HEIGHT, this.body.pos.z);
    const chest = new Vec3(pos.x, (pos.y ?? 0) + TARGET_CHEST_HEIGHT, pos.z);

    // --- hearing: cheap, omnidirectional, and the reason a sprint is risky ----
    const noiseRadius = Number.isFinite(truth.noiseRadius) ? truth.noiseRadius : 0;
    const distHear = eye.distanceXZ(chest);
    const audible = noiseAudibility(noiseRadius, distHear, truth.weather ?? 'clear');
    if (audible > 0) {
      this.telemetry.hearings++;
      this._addSuspicion(STEALTH.SUSPICION_NOISE_GAIN * audible * dt * 3.2, 'noise');
      // Sound gives a position to investigate, but a much weaker one than sight.
      if (!this.memory.fresh || !this.memory.sawTarget) {
        this.memory.noteNoise(pos, clamp(0.3 + audible * 0.4, 0, 0.8));
      }
    }

    // --- sight: every gate lives in perceptionProbe(), see below --------------
    const probe = perceptionProbe(this, truth, {
      // Line of sight is the expensive part, so it runs on its own interval. The
      // cached result is reused between rays: a guard neither gains X-ray vision
      // in the 0.12 s between checks nor loses you for a single frame.
      raycast: this.losAccum >= AI.LOS_UPDATE_INTERVAL || this.losClear === false,
      losFallback: this.losClear,
    });
    this.losAccum = 0;
    this.losClear = probe.losClear;
    if (!probe.visible) { this.seesTargetNow = false; return; }

    // --- seen: accumulate toward a spot, at the declared detection time ------
    this.seesTargetNow = true;
    const { exposure, cone } = probe;
    const detectTime = detectTimeFor(exposure, truth.isNight === true);
    if (Number.isFinite(detectTime) && detectTime > 0) {
      this._addSuspicion((STEALTH.SUSPICION_MAX / detectTime) * dt, 'sight');
    }
    // A sighting always refreshes the memory - but the memory is a COPY, taken
    // now. It will not follow the player afterwards.
    const wasSeeing = this.memory.sawTarget && this.memory.age < AI.TICK_INTERVAL * 2;
    this.memory.noteSighting(pos, clamp(exposure, 0.2, 1));
    if (!wasSeeing) this.telemetry.sightings++;

    // First sight of a target costs an aim delay: the AI may not snap onto the
    // player in the same instant it becomes visible.
    if (this.aimDelay <= 0 && !this.isHostile) this.aimDelay = AI.AIM_DELAY_ON_FIRST_SIGHT;
  }

  _addSuspicion(amount, cause) {
    if (!Number.isFinite(amount) || amount <= 0) return;
    const before = this.suspicion;
    this.suspicion = clamp(this.suspicion + amount, 0, STEALTH.SUSPICION_MAX);
    if (this.suspicion > before) this.suspicionHold = STEALTH.SUSPICION_DECAY_DELAY;
    // Crossings are emitted on the declared event names. An event the UI has
    // never heard of is an event that will never be subscribed to, so the
    // suspicion meter and the "!" indicator would silently never appear.
    const crossed = (t) => before < t && this.suspicion >= t;
    if (crossed(STEALTH.SUSPICION_ALERT_THRESHOLD)) {
      this._emit('SUSPICION_CHANGED', { id: this.id, suspicion: this.suspicion, cause });
      this._emit('AI_ALERTED', { id: this.id, suspicion: this.suspicion, cause });
    }
    if (crossed(STEALTH.SUSPICION_SEARCH_THRESHOLD)) {
      this._emit('SUSPICION_CHANGED', { id: this.id, suspicion: this.suspicion, cause });
    }
    if (crossed(STEALTH.SUSPICION_COMBAT_THRESHOLD)) {
      this._emit('SPOTTED', {
        id: this.id, suspicion: this.suspicion, cause,
        lastKnownPos: this.memory.lastKnownPos ? this.memory.lastKnownPos.toArray() : null,
      });
    }
  }

  _updateSuspicion(dt) {
    if (this.suspicionHold > 0) { this.suspicionHold = Math.max(0, this.suspicionHold - dt); return; }
    if (this.suspicion <= 0) return;
    this.suspicion = clamp(this.suspicion - STEALTH.SUSPICION_DECAY_PER_SEC * dt, 0, STEALTH.SUSPICION_MAX);
  }

  /* -------------------------------------------------------------- deciding */

  /**
   * Choose a state from what the agent BELIEVES.
   *
   * Note what is absent: no reference to `_truth`. The thresholds are the
   * declared suspicion bands, and the memory's freshness decides whether a
   * hostile agent is chasing a person or a rumour.
   */
  _decide() {
    if (this.body.isDead) { this._setState(AIState.DEAD); return; }
    if (!this.body.canAct) { this._setState(AIState.DOWN); return; }

    // A reaction delay gates the transition INTO hostility. Without it the AI
    // responds in the same frame it perceives, which no human does. The gate is
    // two-phase: the first tick ARMES the delay and the agent visibly becomes
    // suspicious, and only once it has fully elapsed may the agent act on the
    // perception. Arming alone is not enough - a timer that is set but never
    // consumed leaves the agent permanently unable to turn hostile.
    const wantsHostile = this.suspicion >= STEALTH.SUSPICION_COMBAT_THRESHOLD
      && this.memory.fresh;

    if (wantsHostile && !this.isHostile) {
      if (!this.reacting) {
        this.reacting = true;
        this.reactionTimer = AI.REACTION_TIME_MIN
          + this.rng() * (AI.REACTION_TIME_MAX - AI.REACTION_TIME_MIN);
        this._setState(AIState.SUSPICIOUS);
        return;
      }
      if (this.reactionTimer > 0) return;    // still winding up
    }
    if (!wantsHostile) this.reacting = false;

    if (wantsHostile) {
      // Hurt badly: break away instead of committing. RETREAT_HEALTH_THRESHOLD is
      // a fraction of max health, so it scales with any future enemy tier without
      // a second constant - and a guard that fights to the death every time is a
      // guard the player never learns to read.
      if (this.body.healthFraction < AI.RETREAT_HEALTH_THRESHOLD) {
        this._setState(AIState.RETREAT);
        this._releaseSlot();
        return;
      }
      // Distance is measured to the LAST KNOWN position, never to `_truth`: the
      // agent may close on a rumour and swing at empty air, which is correct.
      const d = this._distanceToObjective();
      if (Number.isFinite(d) && d <= AI.ATTACK_RANGE) {
        this._setState(this._hasAttackSlot() ? AIState.ATTACK : AIState.CIRCLE);
      } else {
        this._setState(AIState.CHASE);
        this._releaseSlot();
      }
      return;
    }

    if (this.isHostile) {
      // Lost them. Do not teleport knowledge: fall back to searching the last
      // place they were seen, then calm down on the suspicion decay curve.
      this._setState(AIState.SEARCH);
      this.searchTimer = STEALTH.INVESTIGATE_SEARCH_TIME;
      this._releaseSlot();
      return;
    }

    if (this.suspicion >= STEALTH.SUSPICION_SEARCH_THRESHOLD && this.memory.fresh) {
      this._setState(AIState.SEARCH);
      if (this.searchTimer <= 0) this.searchTimer = STEALTH.INVESTIGATE_SEARCH_TIME;
      return;
    }
    if (this.suspicion >= STEALTH.SUSPICION_ALERT_THRESHOLD && this.memory.fresh) {
      this._setState(AIState.INVESTIGATE);
      return;
    }
    if (this.suspicion > STEALTH.SUSPICION_ALERT_THRESHOLD * 0.35) {
      this._setState(AIState.SUSPICIOUS);
      return;
    }
    this._setState(this.patrol.length > 1 ? AIState.PATROL : AIState.IDLE);
  }

  /* ---------------------------------------------------------------- acting */

  _act(dt) {
    switch (this.state) {
      case AIState.ATTACK: this._actAttack(dt); break;
      case AIState.CIRCLE: this._actCircle(dt); break;
      case AIState.RETREAT: this._actRetreat(dt); break;
      case AIState.SEARCH: this._actSearch(dt); break;
      case AIState.SUSPICIOUS: this._actSuspicious(dt); break;
      case AIState.IDLE: this._actIdle(dt); break;
      case AIState.PATROL:
      case AIState.INVESTIGATE:
      case AIState.CHASE:
      default: this._actMove(dt); break;
    }
  }

  _actIdle(dt) {
    // A posted guard scans back and forth across its own front. Sweeping makes
    // the view cone visible to the player, which is what turns stealth from
    // guessing into planning. It OSCILLATES rather than spinning: a guard turning
    // in endless circles looks broken, and worse, it eventually faces every
    // direction, so "stay behind the guard" stops being a strategy and becomes a
    // matter of waiting. The sweep stays inside the main cone, so a guard never
    // accidentally watches its own back.
    this.scanPhase += dt * 0.55;
    if (!Number.isFinite(this.scanPhase)) this.scanPhase = 0;
    const amplitude = (STEALTH.VIEW_CONE_DEG * 0.5 * 0.8) * Math.PI / 180;
    this.body.yaw = wrapYaw(this.homeYaw + Math.sin(this.scanPhase) * amplitude);
    this._moveToward(null, 0, dt);
  }

  _actSuspicious(dt) {
    // Turn toward where the sound or glimpse came from, and hold.
    const obj = this.memory.fresh ? this.memory.lastKnownPos : null;
    if (obj) this._turnToward(obj, dt, AI.TURN_RATE);
    this._moveToward(null, 0, dt);
  }

  _actSearch(dt) {
    this.searchTimer = Math.max(0, this.searchTimer - dt);
    const anchor = this.memory.fresh ? this.memory.lastKnownPos : this.body.pos;
    // Sweep a ring around the anchor rather than standing on it: a guard that
    // searches the exact tile it last saw you on looks mechanical.
    const phase = (STEALTH.INVESTIGATE_SEARCH_TIME - this.searchTimer) * 0.9;
    const radius = clamp(STEALTH.SEARCH_RADIUS * (0.35 + 0.65 * Math.abs(Math.sin(phase * 0.6))),
      0.5, STEALTH.SEARCH_RADIUS);
    const target = new Vec3(
      anchor.x + Math.cos(phase) * radius,
      anchor.y,
      anchor.z + Math.sin(phase) * radius,
    );
    this._moveToward(target, MOVE.WALK_SPEED * 0.85, dt);
    if (this.searchTimer <= 0 && !this.memory.fresh) {
      this.memory.clear();
      this.suspicion = Math.min(this.suspicion, STEALTH.SUSPICION_ALERT_THRESHOLD * 0.9);
    }
  }

  _actCircle(dt) {
    // In range but no attack slot: strafe instead of standing still. Standing
    // still reads as broken; crowding reads as unfair. Circling is both fair and
    // readable, and it lets the player pick which of the two slotted enemies to
    // deal with.
    if (this.circleTimer <= 0) {
      this.circleTimer = AI.CIRCLE_STRAFE_TIME * (0.6 + this.rng() * 0.8);
      if (this.rng() < 0.25) this.circleDir *= -1;
    }
    const obj = this.objective;
    if (!obj) { this._moveToward(null, 0, dt); return; }
    const dx = this.body.pos.x - obj.x;
    const dz = this.body.pos.z - obj.z;
    const len = Math.hypot(dx, dz) || 1;
    // Tangent to the circle around the objective, plus a little inward pull so
    // the agent does not drift out of range while strafing.
    const tx = (-dz / len) * this.circleDir + (dx / len) * -0.25;
    const tz = (dx / len) * this.circleDir + (dz / len) * -0.25;
    const tl = Math.hypot(tx, tz) || 1;
    const target = new Vec3(this.body.pos.x + (tx / tl) * 2.0, this.body.pos.y,
      this.body.pos.z + (tz / tl) * 2.0);
    this._turnToward(obj, dt, AI.TURN_RATE_COMBAT);
    this._moveToward(target, MOVE.WALK_SPEED, dt, { direct: true });
  }

  _actAttack(dt) {
    const obj = this.objective;
    if (!obj) { this._setState(AIState.CHASE); return; }
    this._turnToward(obj, dt, AI.TURN_RATE_COMBAT);

    // Commit based on the LAST KNOWN position. If the player moved during the
    // windup, resolveMelee() will miss them - the AI is allowed to be wrong.
    const dist = this._distanceToObjective();
    if (!Number.isFinite(dist) || dist > AI.ATTACK_RANGE) {
      this._setState(AIState.CHASE);
      this._releaseSlot();
      return;
    }
    if (this.aimDelay > 0 || this.attackCooldown > 0) { this._moveToward(null, 0, dt); return; }
    if (!this._hasAttackSlot()) { this._setState(AIState.CIRCLE); return; }
    if (this.body.staggered || this.body.swing.busy) { this._moveToward(null, 0, dt); return; }

    // Heavies are rarer and telegraphed: a long windup the player can read and
    // parry. Choosing heavy at random within a declared band keeps it varied
    // without making damage unpredictable.
    const kind = this.rng() < 0.28 ? 'heavy' : 'light';
    if (!this.body.startAttack(kind)) {
      this._setState(AIState.CIRCLE);
      return;
    }
    this.telemetry.attacks++;
    this.attackCooldown = AI.ATTACK_COOLDOWN;
    this._emit('COMBAT_ATTACK', { id: this.id, kind, chain: this.body.swing.chain });
    this._moveToward(null, 0, dt);
  }

  _actRetreat(dt) {
    const obj = this.memory.fresh ? this.memory.lastKnownPos : null;
    if (!obj) { this._moveToward(this.home, this.maxSpeed, dt); return; }
    // Straight away from the threat, at run speed, capped so the player can
    // still catch a retreating enemy but cannot be caught by one.
    const dx = this.body.pos.x - obj.x;
    const dz = this.body.pos.z - obj.z;
    const len = Math.hypot(dx, dz) || 1;
    const target = new Vec3(
      this.body.pos.x + (dx / len) * AI.RETREAT_DISTANCE,
      this.body.pos.y,
      this.body.pos.z + (dz / len) * AI.RETREAT_DISTANCE,
    );
    this._moveToward(target, this.maxSpeed, dt);
    if (this.body.healthFraction > AI.RETREAT_HEALTH_THRESHOLD * 1.6) {
      this.suspicion = Math.max(this.suspicion, STEALTH.SUSPICION_COMBAT_THRESHOLD);
    }
  }

  _actMove(dt) {
    const obj = this.objective;
    if (!obj) { this._moveToward(this.home, MOVE.WALK_SPEED * 0.6, dt); return; }
    const hostile = this.isHostile;
    const speed = hostile
      ? this.maxSpeed
      : this.state === AIState.INVESTIGATE ? MOVE.WALK_SPEED * 1.15 : MOVE.WALK_SPEED * 0.8;
    this._moveToward(obj, speed, dt, { usePath: true });

    // Arrival is decided here, in the state that owns the intent. It cannot live
    // in _nextWaypoint(), which returns the objective directly whenever there is
    // no path - so a patrol with no nav grid (or a path that failed to build)
    // would walk its first leg forever.
    const arrived = this.body.pos.distanceXZ(obj) <= WAYPOINT_TOLERANCE * 1.5;
    if (arrived) {
      if (this.state === AIState.PATROL) this._advancePatrol();
      else if (this.state === AIState.INVESTIGATE) {
        // Reached the place the noise came from and found nothing: look around
        // rather than standing on the exact tile, which reads as mechanical.
        this._setState(AIState.SEARCH);
        this.searchTimer = STEALTH.INVESTIGATE_SEARCH_TIME;
      }
    }
    if (hostile) this._turnToward(obj, dt, AI.TURN_RATE_COMBAT);
  }

  /* ------------------------------------------------------------ locomotion */

  /**
   * Move toward a world position through real collision and a real path.
   *
   * `usePath` routes via A* on the nav grid; without it the agent steers
   * directly, which is correct for short strafe and retreat vectors where a
   * full repath would cost more than it buys.
   */
  _moveToward(target, speed, dt, opts = {}) {
    if (!target || !(speed > 0) || dt <= 0) {
      this.speedPlanar = 0;
      this._applyMovement(new Vec3(0, 0, 0), dt);
      return;
    }
    if (opts.usePath === true) this._ensurePath(target);

    const next = this._nextWaypoint(target, opts);
    if (!next) { this.speedPlanar = 0; return; }

    let dx = next.x - this.body.pos.x;
    let dz = next.z - this.body.pos.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) { this.speedPlanar = 0; return; }
    dx /= len; dz /= len;

    // Stuck recovery: steer mostly sideways for a moment instead of pressing
    // into whatever is in the way. A budget-missed path query is RETRYABLE, not
    // "unreachable", so an agent can briefly have no path - and with no path it
    // steers directly at the objective, i.e. perpendicular into a wall, forever.
    // Sliding along the obstacle is what a person does, and it also gives the
    // next repath a different start position to work from.
    if (this.sidestepTimer > 0) {
      const sd = this.sidestepDir;
      const rx = -dz * sd, rz = dx * sd;      // rotate the heading 90 degrees
      dx = rx * 0.85 + dx * 0.35;
      dz = rz * 0.85 + dz * 0.35;
    }

    // Separation: push away from nearby agents so a group does not collapse into
    // one overlapping stack. This is fairness as much as polish - stacked enemies
    // all attack from the same pixel and the player cannot read who is swinging.
    const sep = this._separation();
    dx += sep.x * AI.SEPARATION_WEIGHT;
    dz += sep.z * AI.SEPARATION_WEIGHT;
    const sl = Math.hypot(dx, dz) || 1;
    dx /= sl; dz /= sl;

    const wanted = clamp(speed, 0, this.maxSpeed);
    this.speedPlanar = wanted;
    this._applyMovement(new Vec3(dx * wanted * dt, 0, dz * wanted * dt), dt);
    this._trackProgress(dt);
  }

  /** Apply a delta through the SAME capsule solver the player uses. */
  _applyMovement(delta, dt) {
    if (!(delta.length > 0)) return;
    if (!this.collision) {
      // Kinematic fallback, for headless rigs that are testing decisions rather
      // than locomotion. Production always supplies a collision world - AISquad
      // passes its own to every agent it creates - because an agent that moved
      // without collision resolution would walk through walls, which is precisely
      // the cheat §11 forbids. Counted rather than silent, so a mis-wired level
      // shows up in telemetry instead of as guards phasing through architecture.
      this.telemetry.kinematicMoves++;
      this.body.pos.x += delta.x;
      this.body.pos.y += delta.y;
      this.body.pos.z += delta.z;
      return;
    }
    const result = this.collision.moveCapsule(this.body.pos, delta, {
      radius: MOVE.CAPSULE_RADIUS, height: MOVE.CAPSULE_HEIGHT,
      grounded: this.grounded, allowStep: true,
    });
    if (result && result.pos && result.pos.isFiniteVec()) {
      this.body.pos.copy(result.pos);
      this.grounded = result.grounded !== false;
    }
    void dt;
  }

  /** Sum of push-away vectors from nearby agents, normalized to roughly 0..1. */
  _separation() {
    const out = new Vec3(0, 0, 0);
    const peers = this.group?.agents ?? null;
    if (!Array.isArray(peers) || peers.length < 2) return out;
    let count = 0;
    for (const other of peers) {
      if (!other || other === this || other.body.isDead) continue;
      const dx = this.body.pos.x - other.body.pos.x;
      const dz = this.body.pos.z - other.body.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > AI.SEPARATION_RADIUS || d < 1e-5) continue;
      const w = (AI.SEPARATION_RADIUS - d) / AI.SEPARATION_RADIUS;
      out.x += (dx / d) * w;
      out.z += (dz / d) * w;
      count++;
    }
    if (count > 0) { out.x /= count; out.z /= count; }
    return out;
  }

  _trackProgress(dt) {
    const moved = this.body.pos.distanceXZ(this.lastProgressPos);
    if (moved < AI.STUCK_PROGRESS_THRESHOLD * dt * 2) {
      this.stuckTimer += dt;
      if (this.stuckTimer >= AI.STUCK_TIME_LIMIT) {
        // No progress: drop the path and rebuild it. A guard grinding into a
        // doorframe for the rest of the level is the most visible AI failure
        // there is, and it is always a pathing problem, never a speed problem.
        this.telemetry.stuckEvents++;
        this.stuckTimer = 0;
        this.path = [];
        this.pathIndex = 0;
        this.repathAccum = AI.PATH_RECALC_INTERVAL;
        this.sidestepTimer = 0.65;
        // Alternate sides, so an agent in a corner does not pick the same wall
        // forever and walk in a circle.
        this.sidestepDir = -this.sidestepDir;
      }
    } else {
      this.stuckTimer = 0;
    }
    this.lastProgressPos = this.body.pos.clone();
  }

  _patrolWaypoint() {
    if (this.patrol.length === 0) return this.home;
    return this.patrol[this.patrolIndex % this.patrol.length];
  }

  _advancePatrol() {
    if (this.patrol.length === 0) return;
    this.patrolIndex = (this.patrolIndex + 1) % this.patrol.length;
    this.path = [];
    this.pathIndex = 0;
  }

  _ensurePath(target) {
    if (!this.nav || !this.pathfinder) return;
    const needsPath = this.path.length === 0
      || this.pathIndex >= this.path.length
      || this.repathAccum >= AI.PATH_RECALC_INTERVAL;
    if (!needsPath) return;
    this.repathAccum = 0;

    // Exceeded budgets are NOT "unreachable" at the tactical tier: the agent
    // keeps the path it has and retries next tick. Discarding a working path on
    // a budget miss is how a chase turns into a guard standing still.
    const result = this.pathfinder.findPath(
      this.body.pos.x, this.body.pos.z, target.x, target.z,
      {
        maxNodes: this.pathMaxNodes ?? AI.PATH_MAX_NODES_TACTICAL,
        timeBudgetMs: this.pathTimeBudgetMs ?? AI.PATH_TIME_BUDGET_MS_TACTICAL,
      },
    );
    this.telemetry.paths++;
    if (result && result.ok && Array.isArray(result.path) && result.path.length > 0) {
      this.path = result.path;
      this.pathIndex = 0;
    } else {
      this.telemetry.pathFailures++;
      if (result && result.retryable !== true) {
        // Genuinely unreachable: steer directly rather than freezing. Better a
        // guard that walks into a wall and gets stuck-detected into a repath than
        // one that gives up on a target it can plainly see.
        this.path = [];
        this.pathIndex = 0;
      }
    }
  }

  _nextWaypoint(target, opts) {
    if (opts.direct === true || !this.path || this.path.length === 0) return target;
    while (this.pathIndex < this.path.length) {
      const wp = this.path[this.pathIndex];
      if (!wp) { this.pathIndex++; continue; }
      const d = this.body.pos.distanceXZ(wp);
      if (d <= WAYPOINT_TOLERANCE) { this.pathIndex++; continue; }
      return wp;
    }
    // Path exhausted: if we are close to the objective, consider it reached.
    if (this.body.pos.distanceXZ(target) <= WAYPOINT_TOLERANCE * 1.5) {
      if (this.state === AIState.PATROL) this._advancePatrol();
      return null;
    }
    this.path = [];
    this.pathIndex = 0;
    return target;
  }

  /** Distance to what the agent believes it is going to. Never to `_truth`. */
  _distanceToObjective() {
    const obj = this.objective;
    if (!obj) return Infinity;
    return this.body.pos.distanceXZ(obj);
  }

  _turnToward(target, dt, rate = AI.TURN_RATE) {
    if (!target || dt <= 0) return;
    const dx = target.x - this.body.pos.x;
    const dz = target.z - this.body.pos.z;
    if (Math.abs(dx) < 1e-5 && Math.abs(dz) < 1e-5) return;
    // Yaw 0 faces +Z, matching combat.js and the camera.
    const wanted = Math.atan2(dx, dz);
    const diff = shortestAngle(wanted, this.body.yaw);
    const maxTurn = rate * dt;
    this.body.yaw += clamp(diff, -maxTurn, maxTurn);
    this.body.yaw = wrapYaw(this.body.yaw);
  }

  /* --------------------------------------------------------- group fairness */

  _hasAttackSlot() {
    if (!this.group?.coordinator) return true;   // ungrouped agents fight alone
    const ok = this.group.coordinator.request(this.id);
    if (!ok) this.telemetry.slotsRefused++;
    return ok;
  }

  _releaseSlot() {
    if (this.group?.coordinator) this.group.coordinator.release(this.id);
  }

  /* ------------------------------------------------------------- lifecycle */

  _setState(next) {
    if (this.state === next) return;
    this.prevState = this.state;
    this.state = next;
    this.stateTime = 0;
    this.telemetry.stateChanges++;
    if (next === AIState.DEAD || next === AIState.RETREAT || next === AIState.DOWN) this._releaseSlot();
    this._emit('AI_STATE_CHANGED', { id: this.id, from: this.prevState, to: next });
    if (next === AIState.SEARCH) this._emit('AI_SEARCHING', { id: this.id });
    // Losing track is a distinct, audible-to-the-player moment: it is when the
    // music and the guard barks should stand down, so it gets its own event
    // rather than being inferred from a state diff downstream.
    if (HOSTILE.has(this.prevState) && !HOSTILE.has(next)) {
      this._emit('LOST_TRACK', { id: this.id, from: this.prevState, to: next });
    }
  }

  /** External event: a shout, an alarm, a discovered corpse. */
  notify(kind, payload = {}) {
    switch (kind) {
      case 'corpse':
        this._addSuspicion(STEALTH.SUSPICION_CORPSE_GAIN, 'corpse');
        if (payload.pos) this.memory.noteNoise(payload.pos, 0.7);
        break;
      case 'shout':
        this._addSuspicion(STEALTH.SUSPICION_MAX * 0.75, 'shout');
        if (payload.pos) this.memory.noteNoise(payload.pos, 0.85);
        break;
      case 'alarm':
        this.suspicion = STEALTH.SUSPICION_MAX;
        if (payload.pos) this.memory.noteNoise(payload.pos, 0.9);
        this.reactionTimer = 0;      // an alarm is not a surprise
        break;
      case 'noise':
        if (payload.pos) this.memory.noteNoise(payload.pos, payload.confidence ?? 0.4);
        this._addSuspicion(STEALTH.SUSPICION_GLIMPSE_GAIN * 0.5, 'noise');
        break;
      case 'glimpse':
        this._addSuspicion(STEALTH.SUSPICION_GLIMPSE_GAIN, 'glimpse');
        if (payload.pos) this.memory.noteNoise(payload.pos, 0.5);
        break;
      default: break;
    }
    return this;
  }

  /** Called by the squad when this agent's body dies. */
  onDeath(cause = null) {
    this._setState(AIState.DEAD);
    this._releaseSlot();
    // Combatant.die() already emits on the bus; a second, differently-named
    // event here would fork the vocabulary and leave listeners choosing which
    // of two names to subscribe to.
    this.body.die(cause);
    return this;
  }

  serialize() {
    return {
      id: this.id,
      body: this.body.serialize(),
      memory: this.memory.serialize(),
      suspicion: this.suspicion,
      state: this.state,
      yaw: this.body.yaw,
      patrolIndex: this.patrolIndex,
      attackCooldown: this.attackCooldown,
      reactionTimer: this.reactionTimer,
      aimDelay: this.aimDelay,
      searchTimer: this.searchTimer,
      circleDir: this.circleDir,
      maxSpeed: this.maxSpeed,
      telemetry: { ...this.telemetry },
    };
  }

  restore(data) {
    if (!data) return this;
    if (data.body && typeof this.body.restore === 'function') this.body.restore(data.body);
    this.memory.restore(data.memory);
    this.suspicion = clamp(Number.isFinite(data.suspicion) ? data.suspicion : 0,
      0, STEALTH.SUSPICION_MAX);
    const st = Object.values(AIState).includes(data.state) ? data.state : AIState.IDLE;
    this.state = st;
    this.prevState = st;
    if (Number.isFinite(data.yaw)) this.body.yaw = wrapYaw(data.yaw);
    if (Number.isFinite(data.patrolIndex)) this.patrolIndex = Math.max(0, Math.floor(data.patrolIndex));
    this.attackCooldown = finiteOr(data.attackCooldown, 0);
    this.reactionTimer = finiteOr(data.reactionTimer, 0);
    this.aimDelay = finiteOr(data.aimDelay, 0);
    this.searchTimer = finiteOr(data.searchTimer, 0);
    this.circleDir = data.circleDir < 0 ? -1 : 1;
    if (Number.isFinite(data.maxSpeed) && data.maxSpeed > 0) {
      // A save cannot grant the AI a speed it was not built with.
      this.maxSpeed = clamp(data.maxSpeed, 0, MOVE.RUN_SPEED);
    }
    this.path = [];
    this.pathIndex = 0;
    this.stuckTimer = 0;
    this.lastProgressPos = this.body.pos.clone();
    return this;
  }

  snapshot() {
    return {
      id: this.id,
      state: this.state,
      suspicion: this.suspicion,
      health: this.body.health,
      pos: this.body.pos.clone(),
      yaw: this.body.yaw,
      seesTarget: this.seesTargetNow,
      memoryAge: this.memory.age,
      memoryFresh: this.memory.fresh,
      lastKnownPos: this.memory.lastKnownPos ? this.memory.lastKnownPos.clone() : null,
      speedPlanar: this.speedPlanar,
      attackSwingActive: this.body.swing.phase === SwingPhase.ACTIVE,
    };
  }

  _emit(type, payload) {
    if (!this.bus) return;
    const name = Events[type] ?? type;
    this.bus.emit(name, payload);
  }
}

/* ---------------------------------------------------------------- the squad */

/**
 * A group of agents sharing one coordinator, one pathfinder and one frame budget.
 *
 * Sharing the Pathfinder is deliberate: each instance owns scratch arrays sized
 * to the grid, so one per agent would multiply both memory and allocation churn
 * for no benefit. Agents are ticked sequentially, so the scratch is never in use
 * by two queries at once.
 */
export class AISquad {
  constructor(opts = {}) {
    this.nav = opts.nav ?? null;
    this.collision = opts.collision ?? null;
    this.bus = opts.bus ?? null;
    this.rng = typeof opts.rng === 'function' ? opts.rng : makeRng(0x1a2b3c4d);
    this.coordinator = opts.coordinator ?? new GroupCoordinator();
    this.pathfinder = opts.pathfinder
      ?? (this.nav ? new Pathfinder(this.nav).warm() : null);
    this.agents = [];
    this.budgetMs = Number.isFinite(opts.budgetMs) ? opts.budgetMs : PERF.AI_BUDGET_MS;
    this.telemetry = { frames: 0, budgetExceeded: 0, worstFrameMs: 0, totalMs: 0 };
  }

  add(agentOrOpts) {
    const agent = agentOrOpts instanceof EnemyAgent
      ? agentOrOpts
      : new EnemyAgent({
        ...(agentOrOpts ?? {}),
        nav: this.nav, collision: this.collision, bus: this.bus,
        pathfinder: this.pathfinder, group: this, rng: agentOrOpts?.rng ?? this.rng,
      });
    agent.group = this;
    if (!agent.nav) agent.nav = this.nav;
    if (!agent.collision) agent.collision = this.collision;
    if (!agent.pathfinder) agent.pathfinder = this.pathfinder;
    this.agents.push(agent);
    return agent;
  }

  remove(id) {
    const i = this.agents.findIndex(a => a.id === id);
    if (i < 0) return false;
    this.coordinator.release(id);
    this.agents.splice(i, 1);
    return true;
  }

  get(id) { return this.agents.find(a => a.id === id) ?? null; }
  get alive() { return this.agents.filter(a => !a.body.isDead); }
  get hostile() { return this.agents.filter(a => a.isHostile && !a.body.isDead); }

  /**
   * Tick every agent against one shared view of the player.
   *
   * The squad passes the truth ONCE; each agent's `_perceive()` decides what, if
   * anything, it learned. Work is abandoned when the frame budget is exhausted
   * so a large group degrades into slower decisions rather than a hitch.
   */
  update(dt, truth = {}) {
    const t0 = nowMs();
    this.telemetry.frames++;
    const step = clamp(Number.isFinite(dt) ? dt : 1 / 60, 0, 0.1);

    this.coordinator.update(step);
    // Dead agents must not hold attack slots: a corpse blocking a slot would
    // quietly cap the living enemies below the declared limit.
    this.coordinator.releaseAll(id => {
      const a = this.get(id);
      return !a || a.body.isDead || !a.isHostile;
    });

    const snapshots = [];
    for (const agent of this.agents) {
      const elapsed = nowMs() - t0;
      if (elapsed > this.budgetMs) {
        this.telemetry.budgetExceeded++;
        break;
      }
      snapshots.push(agent.update(step, truth));
    }

    const ms = nowMs() - t0;
    this.telemetry.totalMs += ms;
    if (ms > this.telemetry.worstFrameMs) this.telemetry.worstFrameMs = ms;
    return snapshots;
  }

  /**
   * Resolve every agent's live swing against a defender.
   *
   * Kept in the squad rather than in the agent so that ALL of a frame's melee is
   * resolved in one place, through one function, in a deterministic order. An
   * agent that resolved its own hit inline could be affected by a peer's hit
   * earlier in the same frame depending on array order, which is exactly the
   * kind of invisible order-dependence that makes combat feel arbitrary.
   */
  resolveAttacks(defender, opts = {}) {
    if (!defender) return [];
    const out = [];
    for (const agent of this.agents) {
      if (agent.body.isDead) continue;
      if (agent.body.swing.phase !== SwingPhase.ACTIVE) continue;
      const result = resolveMelee(agent.body, defender, agent.body.swing, {
        bus: this.bus, source: agent.id, ...opts,
      });
      if (result.outcome !== HitOutcome.MISS || result.reason !== 'not-active') {
        out.push({ id: agent.id, result });
      }
    }
    return out;
  }

  /** Broadcast to every agent - an alarm, a shout, a discovered body. */
  notifyAll(kind, payload = {}) {
    for (const a of this.agents) {
      if (a.body.isDead) continue;
      const d = payload.pos ? a.body.pos.distanceXZ(payload.pos) : 0;
      const radius = payload.radius ?? STEALTH.ALARM_PROPAGATION_RADIUS;
      if (payload.pos && d > radius) continue;
      a.notify(kind, payload);
    }
    return this;
  }

  serialize() {
    return {
      agents: this.agents.map(a => a.serialize()),
      coordinator: this.coordinator.serialize(),
    };
  }

  restore(data) {
    if (!data) return this;
    this.coordinator.restore(data.coordinator);
    const saved = Array.isArray(data.agents) ? data.agents : [];
    for (const s of saved) {
      const agent = this.get(s?.id);
      if (agent) agent.restore(s);
    }
    return this;
  }
}

/* ------------------------------------------------------------------ helpers */

function wrapYaw(y) {
  if (!Number.isFinite(y)) return 0;
  const twoPi = Math.PI * 2;
  let r = y % twoPi;
  if (r > Math.PI) r -= twoPi;
  if (r < -Math.PI) r += twoPi;
  return r;
}

function finiteOr(v, fallback) {
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

let _now = null;
function nowMs() {
  if (_now === null) {
    _now = (typeof performance !== 'undefined' && performance.now)
      ? () => performance.now()
      : () => Date.now();
  }
  return _now();
}

/**
 * Convenience: build a guard with a patrol route from plain data.
 * Content files describe posts and routes as arrays; this keeps that data out of
 * the class constructor.
 */
export function makeGuard(spec = {}, shared = {}) {
  const agent = new EnemyAgent({
    id: spec.id ?? shared.id ?? 'guard',
    pos: Array.isArray(spec.pos) ? Vec3.fromArray(spec.pos) : spec.pos,
    yaw: spec.yaw ?? 0,
    patrol: Array.isArray(spec.patrol)
      ? spec.patrol.map(p => (Array.isArray(p) ? Vec3.fromArray(p) : p))
      : [],
    maxHealth: spec.maxHealth,
    health: spec.health,
    bus: shared.bus ?? null,
    nav: shared.nav ?? null,
    collision: shared.collision ?? null,
    pathfinder: shared.pathfinder ?? null,
    group: shared.group ?? null,
    rng: shared.rng,
  });
  if (spec.home === false) agent.home = agent.body.pos.clone();
  return agent;
}
