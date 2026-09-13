// THE BETRAYED WILL — combat.js
// PURE MODULE. No DOM, no Three.js, no timers, no unseeded randomness.
//
// Melee combat resolution: swing phases, hit detection, blocking, parrying,
// stagger, guard breaks, lock-on, and the gates for finishers and takedowns.
//
// WHY ONE MODULE FOR BOTH SIDES
// ----------------------------
// §11 requires that "enemy AI must not cheat". That is not achievable by asking
// the AI code to be polite; it has to be structural. So every combat rule lives
// here and is applied through a single duck-typed interface that the player
// controller and every enemy both satisfy. There is no second code path: an
// enemy that could ignore a parry window, strike outside its own arc, or hit
// through i-frames would need a different resolver, and none exists. When the
// player is hit by resolveMelee() and when a guard is hit by resolveMelee(), the
// same lines run.
//
// WHY DETERMINISTIC
// -----------------
// A fight that resolves differently on replay breaks the save/replay guarantee
// and makes bugs unreproducible. Crits are therefore NOT rolled: a critical is
// the final link of a full combo chain, so it is earned by commitment and can be
// tested by driving the chain. No Math.random anywhere in this file.

import { Vec3, clamp, shortestAngle, RAD2DEG } from '../core/math.js';
import { COMBAT, MOVE, STEALTH } from '../core/constants.js';
import { Events } from '../core/bus.js';

/* ------------------------------------------------------------------- enums */

/** Where a swing is in its lifecycle. */
export const SwingPhase = Object.freeze({
  IDLE: 'idle',         // nothing happening; a swing may be started
  WINDUP: 'windup',     // committed, telegraphed, does no damage yet
  ACTIVE: 'active',     // the blade connects; exactly one hit may land
  RECOVERY: 'recovery', // committed and vulnerable; cannot be dodged out of
  COMBO: 'combo',       // recovery ended inside COMBO_WINDOW; may chain
});

/** How a melee attempt resolved. */
export const HitOutcome = Object.freeze({
  MISS: 'miss',
  HIT: 'hit',
  BLOCKED: 'blocked',
  PARRIED: 'parried',
  DODGED: 'dodged',
});

/** Severity of a stagger. Drives animation and how long the victim is helpless. */
export const StaggerLevel = Object.freeze({
  NONE: 'none',
  LIGHT: 'light',
  HEAVY: 'heavy',
  GUARD_BREAK: 'guard-break',
  KNOCKDOWN: 'knockdown',
});

/** Seconds each stagger severity holds, straight from the declared constants. */
export const STAGGER_DURATION = Object.freeze({
  [StaggerLevel.NONE]: 0,
  [StaggerLevel.LIGHT]: COMBAT.STAGGER_TIME,
  [StaggerLevel.HEAVY]: COMBAT.HEAVY_STAGGER_TIME,
  [StaggerLevel.GUARD_BREAK]: COMBAT.GUARD_BREAK_TIME,
  [StaggerLevel.KNOCKDOWN]: COMBAT.KNOCKDOWN_TIME,
});

/** Which side a combatant fights for. Used only for target filtering. */
export const Side = Object.freeze({ PLAYER: 'player', ENEMY: 'enemy', NEUTRAL: 'neutral' });

/* ----------------------------------------------------------- attack table */

/**
 * The two melee attacks. Every number is a declared constant: the windup is what
 * makes an attack readable (§27), the active window is how long it can connect,
 * and the recovery is the punishment for whiffing. Asymmetry between light and
 * heavy is the whole decision: light is safe and weak, heavy is committal and
 * breaks guards.
 */
export const ATTACKS = Object.freeze({
  light: Object.freeze({
    kind: 'light',
    windup: COMBAT.LIGHT_WINDUP,
    active: COMBAT.LIGHT_ACTIVE,
    recovery: COMBAT.LIGHT_RECOVERY,
    damage: COMBAT.LIGHT_DAMAGE,
    staminaCost: COMBAT.ATTACK_STAMINA_LIGHT,
    stagger: StaggerLevel.LIGHT,
    hitstop: COMBAT.HITSTOP_LIGHT,
    rumble: COMBAT.RUMBLE_LIGHT,
    blockStamina: COMBAT.BLOCK_STAMINA_PER_HIT,
  }),
  heavy: Object.freeze({
    kind: 'heavy',
    windup: COMBAT.HEAVY_WINDUP,
    active: COMBAT.HEAVY_ACTIVE,
    recovery: COMBAT.HEAVY_RECOVERY,
    damage: COMBAT.HEAVY_DAMAGE,
    staminaCost: COMBAT.ATTACK_STAMINA_HEAVY,
    stagger: StaggerLevel.HEAVY,
    hitstop: COMBAT.HITSTOP_HEAVY,
    rumble: COMBAT.RUMBLE_HEAVY,
    blockStamina: COMBAT.BLOCK_HEAVY_STAMINA,
  }),
});

/** Resolve an attack kind to its profile, tolerating junk input. */
export function attackProfile(kind) {
  return ATTACKS[kind] ?? ATTACKS.light;
}

/* -------------------------------------------------------------- geometry */

/**
 * Signed-magnitude angle, in degrees, between the direction `pos` faces and the
 * direction from `pos` to `target`. 0 is dead ahead, 180 is directly behind.
 *
 * Every facing test in the game goes through this one function - melee arc,
 * block coverage, backstab, lock-on cone, finisher angle, takedown angle - so
 * the conventions cannot drift apart between systems.
 */
export function angleOffFacing(pos, yaw, target) {
  if (!pos || !target) return 180;
  const dx = target.x - pos.x;
  const dz = target.z - pos.z;
  if (dx === 0 && dz === 0) return 0;
  // Yaw 0 faces +Z, matching the camera and player conventions.
  const bearing = Math.atan2(dx, dz);
  return Math.abs(shortestAngle(bearing, yaw)) * RAD2DEG;
}

/** True when `attacker` is behind `defender`, by the declared backstab angle. */
export function isBackstab(defender, attackerPos) {
  return angleOffFacing(defender.pos, defender.yaw ?? 0, attackerPos)
    >= COMBAT.BACKSTAB_ANGLE_DEG;
}

/**
 * True when a raised guard actually covers the incoming blow. A block that
 * protects from all directions removes positioning from the melee entirely;
 * one that demands perfect facing is unusable on a gamepad. BLOCK_ARC_DEG is
 * the compromise, and it is declared rather than hardcoded here.
 */
export function blockCovers(defenderPos, defenderYaw, attackerPos) {
  return angleOffFacing(defenderPos, defenderYaw, attackerPos)
    <= COMBAT.BLOCK_ARC_DEG * 0.5;
}

/**
 * Reach test for a melee swing, in metres on the XZ plane plus a vertical
 * tolerance. Returns a reason on failure so a missed hit can be explained - in
 * the debug overlay, and in a test failure message.
 */
export function withinMeleeReach(attacker, defender, profile = ATTACKS.light) {
  const reachMin = profile.reachMin ?? COMBAT.MELEE_REACH_MIN;
  const reachMax = profile.reachMax ?? COMBAT.MELEE_REACH_MAX;
  const dx = defender.pos.x - attacker.pos.x;
  const dz = defender.pos.z - attacker.pos.z;
  const dist = Math.hypot(dx, dz);
  if (dist > reachMax) return { ok: false, distance: dist, reason: 'out-of-reach' };
  if (dist < reachMin) return { ok: false, distance: dist, reason: 'too-close' };
  const dy = Math.abs((defender.pos.y ?? 0) - (attacker.pos.y ?? 0));
  if (dy > COMBAT.MELEE_VERTICAL_TOLERANCE) {
    return { ok: false, distance: dist, reason: 'vertical-miss' };
  }
  const off = angleOffFacing(attacker.pos, attacker.yaw ?? 0, defender.pos);
  if (off > COMBAT.MELEE_ARC_DEG * 0.5) {
    return { ok: false, distance: dist, angleDeg: off, reason: 'outside-arc' };
  }
  return { ok: true, distance: dist, angleDeg: off, reason: null };
}

/* ------------------------------------------------------------------ swing */

/**
 * The lifecycle of one attack, and of the chain it belongs to.
 *
 * A swing may land EXACTLY ONE hit: `hitConsumed` is set by resolveMelee() on
 * the first connect, so holding the button against a crowd does not drain a
 * single enemy's health over several frames of the same active window. That is
 * the most common melee bug in existence and it is prevented by construction.
 */
export class Swing {
  constructor(kind = 'light') {
    this.setKind(kind);
    this.phase = SwingPhase.IDLE;
    this.t = 0;                 // seconds elapsed inside the current phase
    this.chain = 0;             // links in the current combo chain
    this.comboTimer = 0;        // COMBO_WINDOW remaining while in the COMBO phase
    this.resetTimer = 0;        // COMBO_RESET_TIME remaining before chain resets
    this.hitConsumed = false;
    this.hitsLanded = 0;
  }

  setKind(kind) {
    this.kind = ATTACKS[kind] ? kind : 'light';
    this.profile = ATTACKS[this.kind];
    return this;
  }

  /** True while a swing owns the body - locomotion and dodges are locked out. */
  get busy() {
    return this.phase === SwingPhase.WINDUP
      || this.phase === SwingPhase.ACTIVE
      || this.phase === SwingPhase.RECOVERY;
  }

  get isActive() { return this.phase === SwingPhase.ACTIVE && !this.hitConsumed; }

  /** True while a follow-up may be chained without restarting the combo. */
  get canCombo() {
    return this.phase === SwingPhase.COMBO && this.chain < COMBAT.COMBO_MAX_CHAIN;
  }

  /** True on the final link of a full chain - the committed blow that crits. */
  get isFinisherBlow() { return this.chain >= COMBAT.COMBO_MAX_CHAIN; }

  /** Seconds of locomotion lock this swing imposes, for PlayerController. */
  get lockTime() {
    const p = this.profile;
    return p.windup + p.active + p.recovery * 0.7;
  }

  /**
   * Begin a swing. Refuses while busy: an attack cannot cancel its own recovery,
   * because recovery is the punishment for committing.
   * @returns {boolean} whether the swing started
   */
  start() {
    if (this.busy) return false;
    if (this.chain >= COMBAT.COMBO_MAX_CHAIN) this.chain = 0;
    this.chain++;
    this.phase = SwingPhase.WINDUP;
    this.t = 0;
    this.hitConsumed = false;
    this.resetTimer = 0;
    this.comboTimer = 0;
    return true;
  }

  /** Abandon a swing before it becomes active (used by stagger and knockdown). */
  cancel() {
    if (this.phase === SwingPhase.WINDUP) {
      this.phase = SwingPhase.IDLE;
      this.t = 0;
      this.resetTimer = COMBAT.COMBO_RESET_TIME;
      return true;
    }
    return false;
  }

  /** Forget the chain entirely. */
  reset() {
    this.phase = SwingPhase.IDLE;
    this.t = 0;
    this.chain = 0;
    this.comboTimer = 0;
    this.resetTimer = 0;
    this.hitConsumed = false;
  }

  /**
   * Advance the swing.
   * @returns {{activated:boolean, finished:boolean, comboOpened:boolean, comboClosed:boolean, chainReset:boolean}}
   */
  update(dt) {
    const out = {
      activated: false, finished: false, comboOpened: false,
      comboClosed: false, chainReset: false,
    };
    if (!(dt > 0)) return out;
    const p = this.profile;

    switch (this.phase) {
      case SwingPhase.WINDUP:
        this.t += dt;
        if (this.t >= p.windup) {
          this.t -= p.windup;
          this.phase = SwingPhase.ACTIVE;
          out.activated = true;
        }
        break;

      case SwingPhase.ACTIVE:
        this.t += dt;
        if (this.t >= p.active) {
          this.t -= p.active;
          this.phase = SwingPhase.RECOVERY;
        }
        break;

      case SwingPhase.RECOVERY:
        this.t += dt;
        if (this.t >= p.recovery) {
          this.t = 0;
          out.finished = true;
          if (this.chain < COMBAT.COMBO_MAX_CHAIN) {
            this.phase = SwingPhase.COMBO;
            this.comboTimer = COMBAT.COMBO_WINDOW;
            out.comboOpened = true;
          } else {
            // A full chain has been spent; the combo counter starts decaying.
            this.phase = SwingPhase.IDLE;
            this.resetTimer = COMBAT.COMBO_RESET_TIME;
          }
        }
        break;

      case SwingPhase.COMBO:
        this.comboTimer -= dt;
        if (this.comboTimer <= 0) {
          this.comboTimer = 0;
          this.phase = SwingPhase.IDLE;
          this.resetTimer = COMBAT.COMBO_RESET_TIME;
          out.comboClosed = true;
        }
        break;

      default:
        // IDLE: the chain survives a brief pause so a slightly late follow-up
        // still counts as the same combo, then forgets itself.
        if (this.chain > 0 && this.resetTimer > 0) {
          this.resetTimer -= dt;
          if (this.resetTimer <= 0) {
            this.resetTimer = 0;
            this.chain = 0;
            out.chainReset = true;
          }
        }
        break;
    }
    return out;
  }

  serialize() {
    return {
      kind: this.kind, phase: this.phase, t: this.t, chain: this.chain,
      comboTimer: this.comboTimer, resetTimer: this.resetTimer,
      hitConsumed: this.hitConsumed, hitsLanded: this.hitsLanded,
    };
  }

  restore(data) {
    if (!data || typeof data !== 'object') return this;
    this.setKind(data.kind);
    this.phase = Object.values(SwingPhase).includes(data.phase) ? data.phase : SwingPhase.IDLE;
    this.t = Number.isFinite(data.t) ? Math.max(0, data.t) : 0;
    this.chain = clamp(Number.isFinite(data.chain) ? data.chain : 0, 0, COMBAT.COMBO_MAX_CHAIN);
    this.comboTimer = Number.isFinite(data.comboTimer) ? Math.max(0, data.comboTimer) : 0;
    this.resetTimer = Number.isFinite(data.resetTimer) ? Math.max(0, data.resetTimer) : 0;
    this.hitConsumed = data.hitConsumed === true;
    this.hitsLanded = Number.isFinite(data.hitsLanded) ? Math.max(0, data.hitsLanded) : 0;
    return this;
  }
}

/* -------------------------------------------------------------- combatant */

/**
 * An enemy (or any non-player fighter).
 *
 * Satisfies the same duck-typed interface PlayerController does, which is what
 * lets resolveMelee() treat both sides identically. Fields are deliberately
 * named to match the player's - `health`, `stamina`, `iframes`, `yaw`, `pos` -
 * so the shared code reads naturally against either.
 */
export class Combatant {
  constructor(opts = {}) {
    this.id = opts.id ?? 'combatant';
    this.side = opts.side ?? Side.ENEMY;
    this.bus = opts.bus ?? null;
    this.pos = opts.pos instanceof Vec3 ? opts.pos.clone() : new Vec3(0, 0, 0);
    this.yaw = Number.isFinite(opts.yaw) ? opts.yaw : 0;
    this.velocity = new Vec3();

    this.maxHealth = opts.maxHealth ?? COMBAT.ENEMY_MAX_HEALTH;
    this.health = clamp(opts.health ?? this.maxHealth, 0, this.maxHealth);
    this.maxStamina = opts.maxStamina ?? MOVE.STAMINA_MAX;
    this.stamina = clamp(opts.stamina ?? this.maxStamina, 0, this.maxStamina);

    this.swing = new Swing(opts.attackKind ?? 'light');
    this.blocking = false;
    this.parryTimer = 0;
    this.iframes = 0;
    this.hitIframes = 0;
    this.getupInvuln = 0;
    this.staggerLevel = StaggerLevel.NONE;
    this.staggerTimer = 0;
    this.guardBroken = false;
    this.dead = false;
    this.speedPlanar = 0;

    /** Telemetry, so fairness claims are measurable rather than asserted. */
    this.telemetry = {
      attacks: 0, hits: 0, blocked: 0, parried: 0, misses: 0,
      damageDealt: 0, damageTaken: 0, guardBreaks: 0, staggers: 0, deaths: 0,
    };
  }

  get alive() { return !this.dead && this.health > 0; }
  get isDead() { return this.dead || this.health <= 0; }
  get healthFraction() { return this.maxHealth > 0 ? this.health / this.maxHealth : 0; }
  get exhausted() { return this.stamina <= 0; }

  /** Any reason this combatant cannot be hit right now, or null. */
  get invulnerableReason() {
    if (this.isDead) return 'dead';
    if (this.iframes > 0) return 'dodge-iframes';
    if (this.hitIframes > 0) return 'hit-iframes';
    if (this.getupInvuln > 0) return 'getup-invuln';
    return null;
  }

  get invulnerable() { return this.invulnerableReason !== null; }

  /** Staggered combatants cannot act - that is the entire point of a stagger. */
  get staggered() { return this.staggerTimer > 0; }

  get canAct() { return this.alive && !this.staggered && !this.guardBroken; }

  startBlock() {
    if (!this.canAct) return false;
    this.blocking = true;
    this.swing.cancel();
    return true;
  }

  stopBlock() { this.blocking = false; return this; }

  /**
   * Open a parry window. Costs nothing to attempt but leaves the guard
   * committed: if the window closes without a parry, the block resumes.
   */
  startParry() {
    if (!this.canAct) return false;
    this.parryTimer = COMBAT.PARRY_WINDOW;
    this.blocking = true;
    return true;
  }

  /**
   * Begin an attack. Refused while staggered, guard-broken, dead, or already
   * committed - the same refusals the player gets.
   */
  startAttack(kind) {
    if (!this.canAct) return false;
    if (kind) this.swing.setKind(kind);
    const cost = this.swing.profile.staminaCost;
    if (this.stamina < cost) return false;
    if (!this.swing.start()) return false;
    this.stamina = clamp(this.stamina - cost, 0, this.maxStamina);
    this.blocking = false;
    this.telemetry.attacks++;
    return true;
  }

  applyStagger(level) {
    const dur = STAGGER_DURATION[level] ?? 0;
    if (dur <= 0) return false;
    // A heavier stagger always wins; an equal one refreshes rather than stacks,
    // so a crowd cannot lock a fighter in permanent stagger.
    if (STAGGER_DURATION[this.staggerLevel] > dur && this.staggerTimer > 0) return false;
    this.staggerLevel = level;
    this.staggerTimer = dur;
    this.blocking = false;
    this.parryTimer = 0;
    this.swing.cancel();
    if (level === StaggerLevel.GUARD_BREAK) { this.guardBroken = true; this.telemetry.guardBreaks++; }
    if (level === StaggerLevel.KNOCKDOWN) {
      this.getupInvuln = COMBAT.GETUP_INVULN;
      this._emit(Events.COMBAT_KNOCKDOWN, { id: this.id, level });
    }
    this.telemetry.staggers++;
    this._emit(Events.COMBAT_STAGGER, { id: this.id, level, duration: dur });
    return true;
  }

  /**
   * Apply damage. Mirrors PlayerController.damage() exactly - clamp to zero,
   * honour i-frames, count the death - because two implementations of "take
   * damage" is how the player and enemies end up with different rules.
   */
  damage(amount, source = null) {
    if (!this.alive || this.hitIframes > 0) return { applied: 0, died: false };
    const applied = Math.max(0, Number.isFinite(amount) ? amount : 0);
    this.health = clamp(this.health - applied, 0, this.maxHealth);
    this.hitIframes = COMBAT.IFRAME_AFTER_DAMAGE;
    this.telemetry.damageTaken += applied;
    const died = this.health <= 0;
    if (died) this.die(source);
    return { applied, died, health: this.health };
  }

  heal(amount) {
    if (!this.alive) return 0;
    const before = this.health;
    this.health = clamp(this.health + Math.max(0, amount), 0, this.maxHealth);
    return this.health - before;
  }

  die(source = null) {
    if (this.dead) return;
    this.dead = true;
    this.health = 0;
    this.blocking = false;
    this.parryTimer = 0;
    this.swing.reset();
    this.velocity.set(0, 0, 0);
    this.telemetry.deaths++;
    this._emit(Events.COMBAT_KILL, { id: this.id, source });
  }

  update(dt) {
    if (!(dt > 0)) return this;
    this.parryTimer = Math.max(0, this.parryTimer - dt);
    this.iframes = Math.max(0, this.iframes - dt);
    this.hitIframes = Math.max(0, this.hitIframes - dt);
    this.getupInvuln = Math.max(0, this.getupInvuln - dt);
    // Combatants recover stamina at the same rate the player does. Two regen
    // rates would mean the AI can block and attack more often than the player,
    // which is exactly the kind of invisible cheat S11 forbids.
    this.stamina = clamp(this.stamina + MOVE.SPRINT_STAMINA_REGEN * dt, 0, this.maxStamina);
    if (this.staggerTimer > 0) {
      this.staggerTimer = Math.max(0, this.staggerTimer - dt);
      if (this.staggerTimer === 0) {
        this.staggerLevel = StaggerLevel.NONE;
        this.guardBroken = false;
      }
    }
    if (!this.isDead) this.swing.update(dt);
    this.speedPlanar = Math.hypot(this.velocity.x, this.velocity.z);
    return this;
  }

  serialize() {
    return {
      id: this.id, side: this.side,
      pos: this.pos.toArray(), yaw: this.yaw,
      health: this.health, maxHealth: this.maxHealth,
      stamina: this.stamina, maxStamina: this.maxStamina,
      blocking: this.blocking, parryTimer: this.parryTimer,
      staggerLevel: this.staggerLevel, staggerTimer: this.staggerTimer,
      guardBroken: this.guardBroken, dead: this.dead,
      swing: this.swing.serialize(),
    };
  }

  /**
   * Restore into THIS instance.
   *
   * An instance method, not only the static below, because a live encounter holds
   * references to the body - the squad's agent list, a lock-on target, whatever
   * the renderer is following. Swapping the object out from under those
   * references to load a save would leave them pointing at a stale fighter.
   * Swing already restored in place; Combatant did not, so an enemy save quietly
   * dropped its position AND its stamina on load.
   */
  restore(data) {
    if (!data || typeof data !== 'object') return this;
    if (typeof data.id === 'string') this.id = data.id;
    if (typeof data.side === 'string') this.side = data.side;
    if (Array.isArray(data.pos) && data.pos.every(Number.isFinite)) {
      const p = Vec3.fromArray(data.pos);
      if (p.isFiniteVec()) this.pos = p;
    }
    if (Number.isFinite(data.yaw)) this.yaw = data.yaw;
    if (Number.isFinite(data.maxHealth) && data.maxHealth > 0) this.maxHealth = data.maxHealth;
    this.health = clamp(Number.isFinite(data.health) ? data.health : this.maxHealth, 0, this.maxHealth);
    if (Number.isFinite(data.maxStamina) && data.maxStamina > 0) this.maxStamina = data.maxStamina;
    this.stamina = clamp(Number.isFinite(data.stamina) ? data.stamina : this.maxStamina,
      0, this.maxStamina);
    // A corrupt save must never restore a dead fighter mid-encounter, nor one
    // frozen inside a stagger: both soft-lock the encounter (§19 P0 prevention).
    // `dead` is the stored flag; `isDead` is derived from it and health.
    this.dead = false;
    this.staggerLevel = StaggerLevel.NONE;
    this.staggerTimer = 0;
    this.guardBroken = false;
    this.blocking = false;
    this.parryTimer = Number.isFinite(data.parryTimer)
      ? clamp(data.parryTimer, 0, COMBAT.PARRY_WINDOW) : 0;
    this.iframes = 0;
    this.hitIframes = 0;
    this.getupInvuln = 0;
    this.speedPlanar = 0;
    // The swing restores in place so a save taken mid-windup resumes mid-windup
    // rather than handing the fighter a free reset.
    if (typeof this.swing.restore === 'function') this.swing.restore(data.swing);
    else this.swing.reset();
    return this;
  }

  static deserialize(data, opts = {}) {
    return new Combatant(opts).restore(data);
  }

  _emit(type, payload) {
    if (this.bus) this.bus.emit(type, payload);
  }
}

/* ------------------------------------------------------------ resolution */

/**
 * Resolve one melee attempt against one defender.
 *
 * This is the only place in the game where a melee hit is decided. Both the
 * player's swings and every enemy's swings arrive here, which is what makes
 * "AI must not cheat" a property of the architecture instead of a promise.
 *
 * @param {object} attacker  anything satisfying the combat interface
 * @param {object} defender  anything satisfying the combat interface
 * @param {Swing}  swing     the attacker's swing (must be in its ACTIVE phase)
 * @param {object} opts      { bus, source, damage }
 * @returns {object} a full description of what happened, including the feedback
 *                   payload (hitstop, rumble, damage number) the presentation
 *                   layer consumes. Never throws; a malformed call is a MISS.
 */
export function resolveMelee(attacker, defender, swing, opts = {}) {
  const bus = opts.bus ?? attacker?.bus ?? defender?.bus ?? null;
  const result = {
    outcome: HitOutcome.MISS,
    reason: null,
    damage: 0,
    applied: 0,
    crit: false,
    backstab: false,
    blocked: false,
    parried: false,
    guardBroken: false,
    killed: false,
    stagger: StaggerLevel.NONE,
    hitstop: 0,
    rumble: 0,
    distance: 0,
    angleDeg: 0,
    feedback: null,
  };
  if (!attacker || !defender || !attacker.pos || !defender.pos) {
    result.reason = 'malformed';
    return result;
  }

  const profile = swing?.profile ?? ATTACKS.light;

  // --- 1. the swing must be live, and must not already have connected --------
  if (!swing || swing.phase !== SwingPhase.ACTIVE) {
    result.reason = 'not-active';
    return result;
  }
  if (swing.hitConsumed) {
    // One hit per swing. Without this, a single active window lasting 0.11 s
    // would apply its damage on every frame it overlaps - roughly seven hits
    // from one sword swing at 60 fps.
    result.reason = 'already-consumed';
    return result;
  }

  // --- 2. the attacker must be able to act ----------------------------------
  if (attacker.isDead || attacker.dead) { result.reason = 'attacker-dead'; return result; }

  // --- 3. geometry: reach, vertical tolerance, and the swing arc -------------
  const reach = withinMeleeReach(attacker, defender, profile);
  result.distance = reach.distance;
  result.angleDeg = reach.angleDeg ?? 0;
  if (!reach.ok) {
    result.reason = reach.reason;
    if (attacker.telemetry) attacker.telemetry.misses++;
    return result;
  }

  // --- 4. invulnerability: dodges, post-damage i-frames, get-up grace --------
  //    Checked BEFORE block and parry so that a dodge reliably beats a hit,
  //    which is the contract the dodge i-frames make with the player.
  const invuln = defender.invulnerableReason
    ?? (defender.isDead || defender.dead ? 'dead' : null);
  if (invuln) {
    result.outcome = invuln === 'dead' ? HitOutcome.MISS : HitOutcome.DODGED;
    result.reason = invuln;
    if (invuln !== 'dead') {
      swing.hitConsumed = true;   // the swing is spent even though it was dodged
      if (bus) bus.emit(Events.COMBAT_DODGED, { attacker: attacker.id, defender: defender.id });
    }
    return result;
  }

  // --- 5. parry: the defender's window is open AND the blow is in front -----
  if ((defender.parryTimer ?? 0) > 0 && blockCovers(defender.pos, defender.yaw ?? 0, attacker.pos)) {
    result.outcome = HitOutcome.PARRIED;
    result.parried = true;
    result.reason = 'parried';
    result.hitstop = COMBAT.HITSTOP_PARRY;
    swing.hitConsumed = true;
    // The punishment lands on the ATTACKER: a parry is a reversal, not a block
    // that merely reduces numbers.
    applyStaggerTo(attacker, StaggerLevel.LIGHT, COMBAT.PARRY_STAGGER_TIME, bus);
    if (defender.telemetry) defender.telemetry.parried++;
    if (bus) bus.emit(Events.COMBAT_PARRIED, { attacker: attacker.id, defender: defender.id });
    result.feedback = feedbackFor(result, profile);
    return result;
  }

  // --- 6. block: guard up, and covering the direction the blow comes from ---
  const covering = defender.blocking === true
    && blockCovers(defender.pos, defender.yaw ?? 0, attacker.pos);
  if (covering) {
    result.outcome = HitOutcome.BLOCKED;
    result.blocked = true;
    result.reason = 'blocked';
    swing.hitConsumed = true;
    const raw = resolveDamage(attacker, defender, profile, opts, result);
    result.damage = raw;
    result.applied = raw * (1 - COMBAT.BLOCK_DAMAGE_REDUCTION);
    // Blocking costs the defender stamina, not health. Running out is a guard
    // break, which is the real threat that makes blocking a resource rather than
    // a hold-this-button-and-win answer.
    const stamCost = profile.blockStamina;
    defender.stamina = clamp((defender.stamina ?? 0) - stamCost, 0, defender.maxStamina ?? MOVE.STAMINA_MAX);
    if (defender.stamina <= 0) {
      result.guardBroken = true;
      result.stagger = StaggerLevel.GUARD_BREAK;
      applyStaggerTo(defender, StaggerLevel.GUARD_BREAK, COMBAT.GUARD_BREAK_TIME, bus);
    }
    if (defender.telemetry) defender.telemetry.blocked++;
    result.hitstop = profile.hitstop * 0.6;
    result.rumble = profile.rumble * 0.5;
    if (bus) {
      bus.emit(Events.COMBAT_BLOCKED, {
        attacker: attacker.id, defender: defender.id,
        damage: result.applied, guardBroken: result.guardBroken,
      });
    }
    result.feedback = feedbackFor(result, profile);
    return result;
  }

  // --- 7. clean hit ---------------------------------------------------------
  result.outcome = HitOutcome.HIT;
  result.reason = 'hit';
  swing.hitConsumed = true;
  swing.hitsLanded++;

  const raw = resolveDamage(attacker, defender, profile, opts, result);
  result.damage = raw;

  // Backstab: the defender was facing away. Costs nothing extra to compute and
  // is what makes circling an opponent worth doing.
  result.backstab = isBackstab(defender, attacker.pos);
  let total = raw;
  if (result.backstab) total *= COMBAT.BACKSTAB_MULTIPLIER;
  // A critical is the final link of a full combo chain, never a dice roll: it is
  // earned by committing to four hits without being interrupted, and it can be
  // reproduced exactly in a test or a replay.
  result.crit = swing.isFinisherBlow === true;
  if (result.crit) total *= COMBAT.CRIT_MULTIPLIER;
  total = Math.round(total * 100) / 100;

  const applied = applyDamage(defender, total, opts.source ?? attacker.id ?? 'melee');
  result.applied = applied.applied;
  result.killed = applied.died === true;

  if (attacker.telemetry) {
    attacker.telemetry.hits++;
    attacker.telemetry.damageDealt += result.applied;
  }

  // Stagger severity: a heavy, a crit or a killing blow knocks down; otherwise
  // the attack's own severity applies. A staggered fighter cannot act, which is
  // what makes landing the first hit matter.
  let level = profile.stagger;
  if (result.killed || result.crit || profile.kind === 'heavy') level = StaggerLevel.HEAVY;
  if (result.killed) level = StaggerLevel.KNOCKDOWN;
  if (!result.killed) {
    result.stagger = level;
    applyStaggerTo(defender, level, STAGGER_DURATION[level], bus);
  } else {
    result.stagger = StaggerLevel.KNOCKDOWN;
  }

  result.hitstop = result.killed ? COMBAT.HITSTOP_KILL : profile.hitstop;
  result.rumble = profile.rumble;
  if (bus) {
    bus.emit(Events.COMBAT_HIT, {
      attacker: attacker.id, defender: defender.id, damage: result.applied,
      crit: result.crit, backstab: result.backstab, killed: result.killed,
      kind: profile.kind, distance: result.distance,
    });
    if (result.hitstop > 0) {
      bus.emit(Events.COMBAT_HITSTOP, { duration: result.hitstop, kind: profile.kind });
    }
    // COMBAT_KILL is deliberately NOT emitted here. applyDamage() above has already
    // killed the defender, and Combatant.die() emits it with the attacker as `source` -
    // one death, one event, whichever way it happened. Emitting a second one from the
    // resolver would give a sword kill two COMBAT_KILLs and a takedown none, and the
    // COMBAT_HIT above already carries attacker, defender and kind with `killed: true`
    // for anything that wanted the detail.
  }
  result.feedback = feedbackFor(result, profile);
  return result;
}

/** Damage before multipliers, allowing an explicit override for special moves. */
function resolveDamage(attacker, defender, profile, opts, result) {
  let base = Number.isFinite(opts.damage) ? opts.damage : profile.damage;
  // Each side strikes with its OWN declared numbers. Without this the enemy
  // damage constants would sit unused and every enemy would hit for exactly what
  // the player hits for - which is unfair in whichever direction the numbers
  // happen to point, and impossible to balance. It lives here, in the single
  // damage function both sides already pass through, rather than in the AI: an
  // AI that had to remember to declare its own damage would eventually forget,
  // and forgetting would silently make enemies stronger or weaker.
  if (!Number.isFinite(opts.damage) && attacker?.side === Side.ENEMY) {
    base = profile.kind === 'heavy' ? COMBAT.ENEMY_HEAVY_DAMAGE : COMBAT.ENEMY_LIGHT_DAMAGE;
  }
  // Injured Raynor hits softer from Chapter 5 (§7). The injury must cost
  // something in combat as well as in movement, or it is cosmetic.
  const injuryScale = attacker.injured === true ? COMBAT.INJURED_DAMAGE_SCALE : 1;
  void defender; void result;
  return base * injuryScale;
}

/** Apply a stagger with an explicit duration override (used by the parry). */
function applyStaggerTo(target, level, duration, bus) {
  if (!target) return;
  if (typeof target.applyStagger === 'function' && duration === STAGGER_DURATION[level]) {
    target.applyStagger(level);
    return;
  }
  target.staggerLevel = level;
  target.staggerTimer = Math.max(target.staggerTimer ?? 0, duration);
  target.blocking = false;
  target.parryTimer = 0;
  if (target.swing && typeof target.swing.cancel === 'function') target.swing.cancel();
  if (bus) bus.emit(Events.COMBAT_STAGGER, { id: target.id, level, duration });
}

/** Apply damage through the defender's own method when it has one. */
function applyDamage(defender, amount, source) {
  if (typeof defender.damage === 'function') {
    const r = defender.damage(amount, source) ?? {};
    return { applied: r.applied ?? 0, died: r.died === true };
  }
  defender.health = clamp((defender.health ?? 0) - amount, 0, defender.maxHealth ?? amount);
  const died = defender.health <= 0;
  if (died) { defender.dead = true; defender.isDead = true; }
  return { applied: amount, died };
}

/**
 * The presentation payload for one resolved hit. Kept as data so the renderer,
 * audio and gamepad layers never re-derive timing from combat state.
 */
export function feedbackFor(result, profile = ATTACKS.light) {
  return {
    hitstop: result.hitstop ?? 0,
    rumble: result.rumble ?? 0,
    rumbleDuration: COMBAT.RUMBLE_DURATION,
    damageNumber: result.applied > 0
      ? {
        value: Math.round(result.applied),
        crit: result.crit === true,
        blocked: result.blocked === true,
        lifetime: COMBAT.DAMAGE_NUMBER_LIFETIME,
        rise: COMBAT.DAMAGE_NUMBER_RISE,
      }
      : null,
    shake: result.killed ? COMBAT.HITSTOP_KILL : (result.hitstop ?? 0) * 0.5,
    kind: profile.kind,
  };
}

/* ---------------------------------------------------------------- lock-on */

/**
 * Choose a lock-on target.
 *
 * Scoring prefers a small angle over a short distance, because a target dead
 * ahead but further away reads as "the one I am looking at", while a nearer
 * target off to the side reads as a mistake. The current target gets a
 * stickiness bonus so the lock does not flicker between two equally valid
 * enemies as the player turns - flicker is the single most complained-about
 * lock-on failure.
 *
 * Pure: it takes `canSwitch` from the caller, which owns LOCK_ON_SWITCH_COOLDOWN.
 */
export function pickLockTarget(candidates, origin, yaw, opts = {}) {
  const current = opts.current ?? null;
  const canSwitch = opts.canSwitch !== false;
  const maxRange = opts.range ?? COMBAT.LOCK_ON_RANGE;
  const maxAngle = opts.angleDeg ?? COMBAT.LOCK_ON_ANGLE_DEG;
  if (!origin || !Array.isArray(candidates)) return null;

  let best = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    if (!c || !c.pos) continue;
    if (c.dead === true || c.isDead === true || (c.health ?? 1) <= 0) continue;
    if (c.side === Side.PLAYER && opts.excludePlayerSide === false) { /* allowed */ }
    const dist = Math.hypot(c.pos.x - origin.x, c.pos.z - origin.z);
    if (dist > maxRange) continue;
    const angle = angleOffFacing(origin, yaw ?? 0, c.pos);
    if (angle > maxAngle) continue;
    // Angle dominates; distance breaks ties. Stickiness for the current target.
    let score = angle * 2.0 + dist * 0.6;
    if (current && c === current) score -= 18;
    if (score < bestScore) { bestScore = score; best = c; }
  }
  if (current && !canSwitch) {
    // Inside the switch cooldown: keep the current target if it is still legal,
    // even when a better one exists.
    const stillLegal = best !== null && current !== null
      && (best === current || Math.hypot(current.pos.x - origin.x, current.pos.z - origin.z) <= maxRange);
    if (stillLegal && current !== null && (current.dead !== true && current.isDead !== true)) return current;
  }
  // Break the lock if the current target has gone out of range entirely.
  if (!best && current) {
    const d = Math.hypot(current.pos.x - origin.x, current.pos.z - origin.z);
    if (d > COMBAT.LOCK_ON_BREAK_RANGE) return null;
  }
  return best;
}

/* ------------------------------------------------- finisher and takedown */

/**
 * May the player execute this defender?
 *
 * All three gates are declared constants: health below the threshold, inside
 * range, and inside the approach angle. Returning a reason makes a refused
 * prompt explainable in the UI and in a failing test.
 */
export function canFinisher(attacker, defender) {
  if (!attacker || !defender || !attacker.pos || !defender.pos) return { ok: false, reason: 'malformed' };
  if (attacker.isDead || attacker.dead) return { ok: false, reason: 'attacker-dead' };
  if (defender.isDead || defender.dead) return { ok: false, reason: 'target-dead' };
  const frac = (defender.maxHealth ?? 0) > 0
    ? (defender.health ?? 0) / defender.maxHealth : 1;
  if (frac > COMBAT.FINISHER_HEALTH_THRESHOLD) {
    return { ok: false, reason: 'target-healthy', healthFraction: frac };
  }
  const dist = attacker.pos.distanceXZ(defender.pos);
  if (dist > COMBAT.FINISHER_RANGE) return { ok: false, reason: 'out-of-range', distance: dist };
  const angle = angleOffFacing(attacker.pos, attacker.yaw ?? 0, defender.pos);
  if (angle > COMBAT.FINISHER_ANGLE_DEG * 0.5) {
    return { ok: false, reason: 'outside-angle', angleDeg: angle };
  }
  return { ok: true, reason: null, distance: dist, angleDeg: angle, healthFraction: frac };
}

/**
 * May the player take this target down silently?
 *
 * TAKEDOWN_REQUIRES_UNDETECTED is honoured here rather than left to the caller,
 * because a takedown that works while detected removes the entire stealth layer.
 */
export function canTakedown(attacker, defender, opts = {}) {
  if (!attacker || !defender || !attacker.pos || !defender.pos) return { ok: false, reason: 'malformed' };
  if (attacker.isDead || attacker.dead) return { ok: false, reason: 'attacker-dead' };
  if (defender.isDead || defender.dead) return { ok: false, reason: 'target-dead' };
  // Honoured HERE rather than left to the caller: a takedown that works while
  // the player is detected removes the entire stealth layer, and a rule that
  // depends on every call site remembering it is a rule that will be forgotten.
  if (STEALTH.TAKEDOWN_REQUIRES_UNDETECTED !== false && opts.detected === true) {
    return { ok: false, reason: 'detected' };
  }
  const dist = attacker.pos.distanceXZ(defender.pos);
  if (dist > STEALTH.TAKEDOWN_RANGE) return { ok: false, reason: 'out-of-range', distance: dist };
  // The player must be BEHIND the target. angleOffFacing measured from the
  // DEFENDER returns 0 when the player is dead ahead and 180 when directly
  // behind, so "within TAKEDOWN_ANGLE_DEG of behind" is angle >= 180 - half.
  const angle = angleOffFacing(defender.pos, defender.yaw ?? 0, attacker.pos);
  if (angle < 180 - STEALTH.TAKEDOWN_ANGLE_DEG * 0.5) {
    return { ok: false, reason: 'not-behind', angleDeg: angle };
  }
  return { ok: true, reason: null, distance: dist, angleDeg: angle };
}

/* ------------------------------------------------------- damage feedback */

/**
 * Advance a hitstop timer. Hitstop freezes the simulation for a few frames on
 * impact; it is the single largest contributor to "hits feel good", and it must
 * be applied by both sides or the player's hits will feel weaker than enemies'.
 */
export function advanceHitstop(state, dt) {
  if (!state) return 0;
  // Both inputs are validated. A NaN here is not cosmetic: hitstop scales the
  // simulation clock, so a poisoned timer silently switches impact feedback off
  // for the rest of the session, and NaN serializes to `null` in JSON - which
  // deserializes straight back into a NaN clock on load. A bad frame must cost
  // one frame of freeze, never the save file.
  const current = Number.isFinite(state.hitstop) ? state.hitstop : 0;
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  state.hitstop = Math.max(0, current - step);
  return state.hitstop;
}

/** True while the simulation should be frozen for impact feedback. */
export function hitstopActive(state) { return (state?.hitstop ?? 0) > 0; }

/** The scale on which hitstop freezes the world: not zero, or it looks like a crash. */
export const HITSTOP_TIME_SCALE = 0.06;
