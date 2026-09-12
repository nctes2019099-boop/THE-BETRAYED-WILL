// THE BETRAYED WILL — player controller
// PURE MODULE. Movement, stance, stamina, jumping, dodging, ledge traversal and
// health. This is Agent 03's domain and the target of movement-test.mjs.
//
// Design bar (§11 Agent 03): no input lag, no unwanted sliding, natural
// acceleration, clean stopping, reliable transitions. Every one of those is a
// named, asserted property in the test suite — not an aspiration.

import { Vec3, clamp, lerp, wrapAngle, smoothstep, moveTowardsAngle } from '../core/math.js';
import { MOVE, COMBAT, CAM, STEALTH } from '../core/constants.js';
import { Events } from '../core/bus.js';
import { computeFallDamage, probeLedge, mantlePosition, ledgeGrabIsAllowed, hangUpdate } from './traversal.js';
import { Swing, SwingPhase, StaggerLevel, STAGGER_DURATION } from './combat.js';

export const PlayerState = Object.freeze({
  IDLE: 'idle',
  LOCOMOTION: 'locomotion',
  AIRBORNE: 'airborne',
  DODGE: 'dodge',
  LEDGE_HANG: 'ledge-hang',
  LEDGE_CLIMB: 'ledge-climb',
  FINISHER: 'finisher',
  INTERACT: 'interact',
  INCAPACITATED: 'incapacitated',
  DEAD: 'dead',
  SCRIPTED: 'scripted',   // cinematic control
});

export const Stance = Object.freeze({ STAND: 'stand', CROUCH: 'crouch' });

/**
 * Canonical input intent. The input layer (keyboard/mouse/gamepad) produces
 * exactly this shape, so the controller is device-agnostic and fully testable.
 */
export function emptyIntent() {
  return {
    moveX: 0,          // -1 .. 1, strafe (right positive)
    moveZ: 0,          // -1 .. 1, forward positive
    lookX: 0,          // radians this frame (mouse) or -1..1 (gamepad)
    lookY: 0,
    lookIsDeltaRadians: false,
    sprint: false,
    crouch: false,     // toggle request edge
    crouchHeld: false,
    jump: false,       // edge
    jumpHeld: false,
    dodge: false,      // edge
    interact: false,   // edge
    attackLight: false,
    attackHeavy: false,
    block: false,
    blockHeld: false,
    parry: false,
    aim: false,
    aimHeld: false,
    fire: false,
    drawHeld: false,
    lockOn: false,
    ledge: false,      // hold to seek a ledge grab
    shoulderSwap: false,
    useItem: false,
    cameraReset: false,
  };
}

export class PlayerController {
  constructor(opts = {}) {
    this.collision = opts.collision ?? null;
    this.bus = opts.bus ?? null;
    this.pos = opts.pos ? opts.pos.clone() : new Vec3(0, 0, 0);
    /** Body facing (yaw). Camera yaw is separate — the body follows movement. */
    this.yaw = opts.yaw ?? 0;
    this.cameraYaw = opts.cameraYaw ?? this.yaw;
    this.cameraPitch = opts.cameraPitch ?? 0.16;
    this.shoulderRight = true;

    this.velocity = new Vec3();
    this.verticalVelocity = 0;
    this.grounded = true;
    this.groundCollider = null;

    this.state = PlayerState.IDLE;
    this.stance = Stance.STAND;
    this.crouchBlend = 0;       // 0 standing, 1 crouched — drives capsule height
    this.speedPlanar = 0;

    this.health = opts.health ?? COMBAT.PLAYER_MAX_HEALTH;
    this.maxHealth = opts.maxHealth ?? COMBAT.PLAYER_MAX_HEALTH;
    this.stamina = MOVE.STAMINA_MAX;
    this.exhausted = false;
    this.sinceSprint = 99;

    this.injured = opts.injured === true;   // Chapter 5+: weakened Raynor (§7)
    this.ragdollFree = true;

    // Timing accumulators
    this.coyote = 0;
    this.jumpBuffer = 0;
    this.landRecovery = 0;
    this.dodgeTime = 0;
    this.dodgeCooldown = 0;
    this.dodgeDir = new Vec3();
    this.iframes = 0;
    this.hitIframes = 0;
    this.regenDelay = 0;
    this.attackLock = 0;         // combat may lock locomotion
    this.lockTarget = null;

    // Combat. The intent fields (attackLight/attackHeavy/block/blockHeld/parry)
    // were declared in emptyIntent() from the start but nothing consumed them,
    // so the whole melee layer was unreachable from a gamepad. The state itself
    // lives in combat.js and is shared with every enemy; see _updateCombat.
    this.swing = new Swing('light');
    this.blocking = false;
    this.parryTimer = 0;
    this.staggerLevel = StaggerLevel.NONE;
    this.staggerTimer = 0;
    this.guardBroken = false;
    this.hitstop = 0;
    this.attackCooldown = 0;
    this.interactLock = 0;

    // Fall tracking
    this.fallStartY = this.pos.y;
    this.fallPeakY = this.pos.y;
    this.airTime = 0;
    this.lastFallDamage = null;

    // Ledge
    this.ledge = null;
    this.hang = null;
    this.mantleElapsed = 0;
    this.mantleFrom = null;

    // Scripted / cinematic override
    this.scripted = null;

    // Telemetry — read directly by movement-test and the perf ledger.
    this.telemetry = {
      frames: 0,
      distance: 0,
      topSpeed: 0,
      jumps: 0,
      dodges: 0,
      ledgeGrabs: 0,
      mantles: 0,
      fallDamageEvents: 0,
      slidingFrames: 0,     // frames where speed decayed too slowly after input release
      inputLagFrames: 0,    // frames where an input edge produced no state change
      maxAccel: 0,
      stopDistance: 0,
      nanEvents: 0,
    };
    this._prevSpeed = 0;
  }

  /* ------------------------------------------------------------- accessors */

  get alive() { return this.health > 0 && this.state !== PlayerState.DEAD; }
  get isDead() { return this.state === PlayerState.DEAD; }
  get capsuleHeight() {
    return lerp(MOVE.CAPSULE_HEIGHT, MOVE.CROUCH_CAPSULE_HEIGHT, this.crouchBlend);
  }
  get capsuleRadius() { return MOVE.CAPSULE_RADIUS; }
  get healthFraction() { return clamp(this.health / this.maxHealth, 0, 1); }

  /** Stamina ceiling. Named to match Combatant so shared code reads either. */
  get maxStamina() { return MOVE.STAMINA_MAX; }

  /**
   * Why this fighter cannot be hit right now, or null.
   *
   * Named and shaped exactly as Combatant.invulnerableReason, because
   * resolveMelee() reads this property off whichever side is defending. If the
   * player lacked it, the shared resolver would fall through to a dead-check
   * only and the player's own dodge i-frames would be ignored - the player would
   * be MORE hittable than an enemy, which is cheating in reverse.
   */
  get invulnerableReason() {
    if (this.isDead) return 'dead';
    if (this.iframes > 0) return 'dodge-iframes';
    if (this.hitIframes > 0) return 'hit-iframes';
    if (this.state === PlayerState.FINISHER && COMBAT.FINISHER_INVULN) return 'finisher-invuln';
    return null;
  }

  get invulnerable() { return this.invulnerableReason !== null; }

  /** A staggered fighter cannot act - that is the entire point of a stagger. */
  get staggered() { return this.staggerTimer > 0; }

  get canAct() { return this.alive && !this.staggered && !this.guardBroken; }
  get staminaFraction() { return clamp(this.stamina / MOVE.STAMINA_MAX, 0, 1); }
  get eyeHeight() { return this.pos.y + this.capsuleHeight * 0.9; }

  /** Current maximum planar speed for the active stance and condition. */
  /** Speed CAP of the band the player is currently in, injury-aware. */
  get maxSpeed() {
    const inj = this.injured;
    if (this.stance === Stance.CROUCH) return inj ? MOVE.INJURED_CROUCH_SPEED : MOVE.CROUCH_SPEED;
    if (this.sprinting) return inj ? MOVE.INJURED_SPRINT_SPEED : MOVE.SPRINT_SPEED;
    if (this.running) return inj ? MOVE.INJURED_RUN_SPEED : MOVE.RUN_SPEED;
    return inj ? MOVE.INJURED_WALK_SPEED : MOVE.WALK_SPEED;
  }

  /**
   * Speed reached at exactly RUN_THRESHOLD deflection - the point where the walk
   * band hands over to the run band. Both bands are anchored here, which is what
   * makes the deflection-to-speed mapping continuous (see _updateLocomotion).
   */
  get walkSpeed() {
    return this.injured ? MOVE.INJURED_WALK_SPEED : MOVE.WALK_SPEED;
  }

  /** Facing vector on the XZ plane. */
  get forward() { return new Vec3(Math.sin(this.yaw), 0, Math.cos(this.yaw)); }
  get right() { return new Vec3(Math.cos(this.yaw), 0, -Math.sin(this.yaw)); }

  /* -------------------------------------------------------------- mutation */

  setPosition(x, y, z) {
    this.pos.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this.verticalVelocity = 0;
    this.fallStartY = y;
    this.fallPeakY = y;
    this.grounded = true;
    return this;
  }

  setInjured(on) {
    this.injured = !!on;
    return this;
  }

  damage(amount, source = null) {
    if (!this.alive || this.hitIframes > 0) return { applied: 0, died: false };
    const applied = Math.max(0, amount);
    this.health = clamp(this.health - applied, 0, this.maxHealth);
    this.hitIframes = COMBAT.IFRAME_AFTER_DAMAGE;
    this.regenDelay = COMBAT.REGEN_DELAY;
    this._emit('PLAYER_DAMAGED', { amount: applied, health: this.health, source });
    const died = this.health <= 0;
    if (died) this.die(source);
    return { applied, died, health: this.health };
  }

  heal(amount) {
    if (!this.alive) return 0;
    const before = this.health;
    this.health = clamp(this.health + amount, 0, this.maxHealth);
    const gained = this.health - before;
    if (gained > 0) this._emit('PLAYER_HEALED', { amount: gained, health: this.health });
    return gained;
  }

  die(source = null) {
    if (this.state === PlayerState.DEAD) return;
    this.health = 0;
    this.state = PlayerState.DEAD;
    this.velocity.set(0, 0, 0);
    this.verticalVelocity = 0;
    this._emit('PLAYER_DIED', { source, pos: this.pos.clone() });
  }

  /** Cinematic/scripted takeover. `null` returns control to the player. */
  setScripted(controller) {
    this.scripted = controller;
    if (controller) {
      this.state = PlayerState.SCRIPTED;
      this.velocity.set(0, 0, 0);
      this.verticalVelocity = 0;
    } else if (this.state === PlayerState.SCRIPTED) {
      this.state = PlayerState.IDLE;
    }
  }

  /* ---------------------------------------------------------------- update */

  /**
   * Advance one simulation step.
   * @param {number} dt seconds (clamped by the caller's fixed-step loop)
   * @param {object} intent see emptyIntent()
   * @param {object} ctx { region, timeOfDay, weather, hidden, inCombat, interactable }
   */
  update(dt, intent = emptyIntent(), ctx = {}) {
    this.telemetry.frames++;
    if (!Number.isFinite(dt) || dt <= 0) dt = 1 / 60;
    dt = Math.min(dt, 0.1);   // never let a tab-switch spike teleport the player

    const before = { state: this.state, pos: this.pos.clone(), stance: this.stance };

    // NaN guard — a corrupted position is a P0; recover rather than fall through.
    if (!this.pos.isFiniteVec() || !Number.isFinite(this.verticalVelocity)) {
      this.telemetry.nanEvents++;
      this.recoverToSafeGround(ctx);
    }

    if (this.state === PlayerState.DEAD) {
      this._applyGravity(dt);
      this._integrate(dt);
      return this._snapshot(before, intent);
    }

    if (this.scripted) {
      this.scripted(dt, this, intent);
      return this._snapshot(before, intent);
    }

    this._updateTimers(dt);
    this._updateLook(dt, intent, ctx);
    this._updateStance(dt, intent, ctx);
    this._updateStamina(dt, intent);
    this._updateCombat(dt, intent, ctx);

    switch (this.state) {
      case PlayerState.LEDGE_CLIMB: this._updateMantle(dt, intent); break;
      case PlayerState.LEDGE_HANG: this._updateHang(dt, intent); break;
      case PlayerState.DODGE: this._updateDodge(dt, intent); break;
      case PlayerState.FINISHER: this._updateFinisher(dt, intent); break;
      default: this._updateLocomotion(dt, intent, ctx); break;
    }

    this._updateHealthRegen(dt);
    return this._snapshot(before, intent);
  }

  _snapshot(before, intent) {
    // Sliding detector: input released but speed decayed by less than 55% of
    // what GROUND_DECEL should produce this frame. Feeds the "no unwanted
    // sliding" assertion in movement-test.
    const inputMagnitude = Math.hypot(intent.moveX ?? 0, intent.moveZ ?? 0);
    if (this.grounded && inputMagnitude < 0.05 && this.speedPlanar > 0.35) {
      const expectedDecay = MOVE.GROUND_DECEL * (1 / 60);
      const actualDecay = this._prevSpeed - this.speedPlanar;
      if (actualDecay < expectedDecay * 0.55 && this.state !== PlayerState.DODGE) {
        this.telemetry.slidingFrames++;
      }
    }
    this._prevSpeed = this.speedPlanar;

    if (before.state !== this.state) {
      this._emit('player:state', { from: before.state, to: this.state });
    }
    this.telemetry.distance += this.pos.distanceXZ(before.pos);
    if (this.speedPlanar > this.telemetry.topSpeed) this.telemetry.topSpeed = this.speedPlanar;
    return {
      state: this.state,
      pos: this.pos.clone(),
      velocity: this.velocity.clone(),
      grounded: this.grounded,
      speed: this.speedPlanar,
      stance: this.stance,
      health: this.health,
      stamina: this.stamina,
    };
  }

  /* --------------------------------------------------------------- timers */

  _updateTimers(dt) {
    this.iframes = Math.max(0, this.iframes - dt);
    this.hitIframes = Math.max(0, this.hitIframes - dt);
    this.dodgeCooldown = Math.max(0, this.dodgeCooldown - dt);
    this.attackLock = Math.max(0, this.attackLock - dt);
    this.landRecovery = Math.max(0, this.landRecovery - dt);
    this.interactLock = Math.max(0, this.interactLock - dt);
    this.sinceSprint += dt;
    this.regenDelay = Math.max(0, this.regenDelay - dt);
    if (this.grounded) {
      this.coyote = MOVE.COYOTE_TIME;
      this.airTime = 0;
      this.fallStartY = this.pos.y;
      this.fallPeakY = this.pos.y;
    } else {
      this.coyote = Math.max(0, this.coyote - dt);
      this.airTime += dt;
      if (this.pos.y > this.fallPeakY) this.fallPeakY = this.pos.y;
    }
    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    this.parryTimer = Math.max(0, this.parryTimer - dt);
    this.attackCooldown = Math.max(0, this.attackCooldown - dt);
    this.hitstop = Math.max(0, this.hitstop - dt);
    if (this.staggerTimer > 0) {
      this.staggerTimer = Math.max(0, this.staggerTimer - dt);
      if (this.staggerTimer === 0) {
        this.staggerLevel = StaggerLevel.NONE;
        this.guardBroken = false;
      }
    }
  }

  /* ----------------------------------------------------------------- look */

  _updateLook(dt, intent, ctx) {
    if (ctx?.cinematic) return;

    if (intent.lookIsDeltaRadians) {
      // Mouse: absolute delta radians, already scaled by sensitivity upstream.
      this.cameraYaw = wrapAngle(this.cameraYaw + (intent.lookX ?? 0));
      this.cameraPitch = clamp(
        this.cameraPitch - (intent.lookY ?? 0), CAM.PITCH_MIN, CAM.PITCH_MAX,
      );
    } else {
      // Gamepad: normalised stick, eased so fine framing is possible near centre.
      const lx = applyStickResponse(intent.lookX ?? 0);
      const ly = applyStickResponse(intent.lookY ?? 0);
      this.cameraYaw = wrapAngle(this.cameraYaw + lx * CAM.GAMEPAD_LOOK_SPEED * dt);
      this.cameraPitch = clamp(
        this.cameraPitch - ly * CAM.GAMEPAD_LOOK_SPEED * 0.82 * dt,
        CAM.PITCH_MIN, CAM.PITCH_MAX,
      );
    }

    if (intent.shoulderSwap && !this._shoulderLatch) this.shoulderRight = !this.shoulderRight;
    this._shoulderLatch = !!intent.shoulderSwap;

    // Manual re-centre behind the player.
    if (intent.cameraReset) this.cameraYaw = this.yaw;
  }

  /* --------------------------------------------------------------- stance */

  _updateStance(dt, intent, ctx) {
    // Two supported models, chosen in settings (§11 Agent 13, accessibility):
    //   'toggle' — one press flips crouch (default, keyboard-friendly)
    //   'hold'   — crouch only while the key/button is held (gamepad-friendly)
    const holdMode = (ctx?.crouchMode ?? this.crouchMode) === 'hold';
    let target = this.stance;

    if (holdMode) {
      target = intent.crouchHeld ? Stance.CROUCH : Stance.STAND;
    } else {
      // Rising edge only, so holding the key does not machine-gun the toggle.
      if (intent.crouch && !this._crouchLatch) {
        target = this.stance === Stance.CROUCH ? Stance.STAND : Stance.CROUCH;
      }
      this._crouchLatch = !!intent.crouch;
    }

    // Cannot stand up under a low ceiling — verified against real geometry so
    // the player never ends up embedded in a beam (a P0 stuck condition).
    if (target === Stance.STAND && this.collision) {
      const free = this.collision.isSpaceFree(this.pos, MOVE.CAPSULE_RADIUS, MOVE.CAPSULE_HEIGHT);
      if (!free) target = Stance.CROUCH;
    }

    if (target !== this.stance) {
      this.stance = target;
      this._emit('PLAYER_CROUCHED', { crouched: this.stance === Stance.CROUCH });
    }

    // Blend the capsule height over CROUCH_TRANSITION_TIME rather than snapping,
    // so the camera and hitboxes do not jump.
    const targetBlend = this.stance === Stance.CROUCH ? 1 : 0;
    const rate = dt / Math.max(MOVE.CROUCH_TRANSITION_TIME, 1e-4);
    const delta = targetBlend - this.crouchBlend;
    this.crouchBlend = clamp(this.crouchBlend + Math.sign(delta) * Math.min(Math.abs(delta), rate), 0, 1);
  }

  /* ------------------------------------------------------------- stamina */

  _updateStamina(dt, intent) {
    const drain = this.sprinting && this.grounded && this.speedPlanar > MOVE.WALK_SPEED * 0.6;
    if (drain) {
      this.stamina = clamp(this.stamina - MOVE.SPRINT_STAMINA_DRAIN * dt, 0, MOVE.STAMINA_MAX);
      this.sinceSprint = 0;
      if (this.stamina <= MOVE.STAMINA_EXHAUSTED_THRESHOLD) this.exhausted = true;
    } else if (this.sinceSprint >= MOVE.STAMINA_REGEN_DELAY) {
      this.stamina = clamp(this.stamina + MOVE.SPRINT_STAMINA_REGEN * dt, 0, MOVE.STAMINA_MAX);
      if (this.exhausted && this.stamina >= MOVE.STAMINA_RECOVER_THRESHOLD) this.exhausted = false;
    }
    void intent;
  }

  spendStamina(amount) {
    if (this.stamina < amount) return false;
    this.stamina = clamp(this.stamina - amount, 0, MOVE.STAMINA_MAX);
    this.sinceSprint = 0;
    if (this.stamina <= MOVE.STAMINA_EXHAUSTED_THRESHOLD) this.exhausted = true;
    return true;
  }

  /* ----------------------------------------------------------- locomotion */

  /* ---------------------------------------------------------------- combat */

  /**
   * Drive the melee layer.
   *
   * Every rule here is the SAME rule combat.js applies to enemies: attacks cost
   * stamina, cannot cancel their own recovery, and are refused while staggered
   * or guard-broken. The player gets no private shortcut, which is what makes
   * "AI must not cheat" symmetric rather than merely a restriction on the AI.
   */
  _updateCombat(dt, intent, ctx) {
    if (this.isDead || this.scripted || ctx?.cinematic) return;

    // States that own the body for their own reasons. The swing still advances
    // so a committed attack finishes its timeline, but no NEW commitment can be
    // made: starting a swing mid-dodge or hanging off a ledge would set
    // attackLock and freeze the state machine that is currently in charge.
    if (this.state === PlayerState.LEDGE_HANG || this.state === PlayerState.LEDGE_CLIMB
      || this.state === PlayerState.DODGE || this.state === PlayerState.INCAPACITATED
      || this.state === PlayerState.FINISHER || this.state === PlayerState.INTERACT) {
      this.swing.update(dt);
      return;
    }

    // A stagger owns the body: input is dropped, not buffered. Buffering a
    // stagger would let the player queue an attack and come out swinging the
    // instant the stun ends, which removes the cost of being hit.
    if (!this.canAct) {
      this.blocking = false;
      this.parryTimer = 0;
      return;
    }

    // Guard: hold model, matching the crouch hold model for consistency.
    if (intent.block || intent.blockHeld) {
      if (!this.blocking) this.startBlock();
    } else if (this.blocking && this.parryTimer <= 0) {
      this.stopBlock();
    }

    // A parry is a press, not a hold: it opens PARRY_WINDOW and then expires.
    if (intent.parry && this.parryTimer <= 0) this.startParry();

    // Attacks. Heavy takes precedence so a simultaneous press does the
    // committal thing the player was reaching for rather than the safe one.
    if (intent.attackHeavy) this.startAttack('heavy');
    else if (intent.attackLight) this.startAttack('light');

    const ev = this.swing.update(dt);
    if (ev.activated) {
      this._emit('COMBAT_ATTACK', {
        kind: this.swing.kind, chain: this.swing.chain, pos: this.pos.clone(),
      });
    }
  }

  /**
   * Begin an attack. Refused while staggered, guard-broken, dead, already
   * committed, or short of stamina - the identical refusals an enemy gets from
   * Combatant.startAttack().
   */
  startAttack(kind) {
    if (!this.canAct || this.attackLock > 0) return false;
    const swing = kind ? this.swing.setKind(kind) : this.swing;
    const cost = swing.profile.staminaCost;
    if (this.stamina < cost) return false;
    if (!swing.start()) return false;
    this.stamina = clamp(this.stamina - cost, 0, this.maxStamina);
    this.blocking = false;
    this.parryTimer = 0;
    this.attackLock = swing.lockTime;
    this.telemetry.attacks = (this.telemetry.attacks ?? 0) + 1;
    return true;
  }

  startBlock() {
    if (!this.canAct || this.attackLock > 0) return false;
    this.blocking = true;
    this.swing.cancel();
    return true;
  }

  stopBlock() { this.blocking = false; return this; }

  /** Open the parry window. Costs nothing to try; missing it is the cost. */
  startParry() {
    if (!this.canAct || this.attackLock > 0) return false;
    this.parryTimer = COMBAT.PARRY_WINDOW;
    this.blocking = true;
    return true;
  }

  /**
   * Take a stagger. Locks locomotion for its duration via attackLock, so the
   * existing movement code path - which already refuses input while
   * attackLock > 0 - enforces the stun without a new player state.
   */
  applyStagger(level) {
    const dur = STAGGER_DURATION[level] ?? 0;
    if (dur <= 0) return false;
    if (STAGGER_DURATION[this.staggerLevel] > dur && this.staggerTimer > 0) return false;
    this.staggerLevel = level;
    this.staggerTimer = dur;
    this.blocking = false;
    this.parryTimer = 0;
    this.swing.cancel();
    this.attackLock = Math.max(this.attackLock, dur);
    if (level === StaggerLevel.GUARD_BREAK) this.guardBroken = true;
    this.telemetry.staggers = (this.telemetry.staggers ?? 0) + 1;
    this._emit('COMBAT_STAGGER', { level, duration: dur });
    return true;
  }

  /** True while the melee swing can connect, for the resolver and the UI. */
  get swingActive() { return this.swing.phase === SwingPhase.ACTIVE && !this.swing.hitConsumed; }

  _updateLocomotion(dt, intent, ctx) {
    const locked = this.attackLock > 0 || ctx?.inDialogue === true;

    // Desired movement in camera space (third-person convention).
    let ix = locked ? 0 : (intent.moveX ?? 0);
    let iz = locked ? 0 : (intent.moveZ ?? 0);
    let mag = Math.hypot(ix, iz);
    if (mag > 1) { ix /= mag; iz /= mag; mag = 1; }

    const camYaw = this.cameraYaw;
    const sin = Math.sin(camYaw), cos = Math.cos(camYaw);
    // Camera-relative basis: forward is where the camera looks, projected flat.
    const wishX = ix * cos - iz * sin;
    const wishZ = -ix * sin - iz * cos;

    const hasInput = mag > MOVE.INPUT_DEADZONE;

    // --- stance-dependent speed targets -----------------------------------
    this.running = hasInput && mag > MOVE.RUN_THRESHOLD && this.stance === Stance.STAND;
    // Sprint is a BAND, not a modifier: it only exists inside the run band.
    // Letting it apply at a walk deflection meant holding sprint while creeping
    // still earned the sprint acceleration bonus and burned stamina at a crawl.
    const wantsSprint = intent.sprint && this.running
      && !this.exhausted && this.stamina > MOVE.STAMINA_EXHAUSTED_THRESHOLD
      && this.attackLock <= 0;
    if (wantsSprint && !this.sprinting) this._emit('PLAYER_SPRINTED', { on: true });
    if (!wantsSprint && this.sprinting) this._emit('PLAYER_SPRINTED', { on: false });
    this.sprinting = wantsSprint;

    // Deflection -> speed, mapped CONTINUOUSLY and MONOTONICALLY across the
    // whole stick. The walk band ramps 0 -> walkSpeed over [0, RUN_THRESHOLD]
    // and the run band continues walkSpeed -> cap over [RUN_THRESHOLD, 1], so
    // the two bands meet at walkSpeed and nothing lurches as the stick crosses
    // the threshold.
    //
    // The previous form was `maxSpeed * clamp(mag, 0.25, 1)` with maxSpeed
    // selected by that same threshold. That had two defects a player feels
    // immediately:
    //   - a +1.36 m/s (2.2x) DISCONTINUITY at 55% deflection - 1.13 m/s one
    //     instant, 2.49 m/s the next - so a slow stealth approach snapped into
    //     a jog partway through the stick's travel;
    //   - MOVE.WALK_SPEED was UNREACHABLE. The walk band topped out at
    //     0.55 * WALK_SPEED = 1.13 m/s, so the declared walking speed could not
    //     be produced by any input, and the bottom 25% of travel was a flat
    //     deadzone that then jumped straight to 0.51 m/s on first touch.
    // Every declared speed constant is now exactly attainable: WALK_SPEED at
    // RUN_THRESHOLD, RUN_SPEED and SPRINT_SPEED at full deflection.
    let targetSpeed = 0;
    if (hasInput) {
      const cap = this.maxSpeed;
      // Deflection normalised within the walk band: 0 at the deadzone edge, 1 at
      // RUN_THRESHOLD. Rescaling past the deadzone is what makes speed leave zero
      // continuously instead of lurching (see MOVE.INPUT_DEADZONE).
      const walkLocal = clamp(
        (mag - MOVE.INPUT_DEADZONE) / (MOVE.RUN_THRESHOLD - MOVE.INPUT_DEADZONE), 0, 1);
      if (this.stance === Stance.CROUCH) {
        // Crouching has no run band to hand over to, so the whole usable stick
        // maps to the crouch cap and creeping keeps its full precision range.
        targetSpeed = cap * clamp(
          (mag - MOVE.INPUT_DEADZONE) / (1 - MOVE.INPUT_DEADZONE), 0, 1);
      } else if (mag <= MOVE.RUN_THRESHOLD) {
        targetSpeed = this.walkSpeed * walkLocal;
      } else {
        const local = (mag - MOVE.RUN_THRESHOLD) / (1 - MOVE.RUN_THRESHOLD);
        targetSpeed = lerp(this.walkSpeed, cap, clamp(local, 0, 1));
      }
    }

    // --- acceleration / deceleration --------------------------------------
    // Grounded uses high accel + very high decel so starts feel immediate and
    // stops feel planted. Airborne uses low accel for air control.
    const accelRate = this.grounded
      ? (targetSpeed > this.speedPlanar
        ? MOVE.GROUND_ACCEL * (this.sprinting ? MOVE.SPRINT_ACCEL_BONUS : 1)
        : MOVE.GROUND_DECEL)
      : MOVE.AIR_ACCEL;

    const prevSpeed = this.speedPlanar;
    this.speedPlanar = this.grounded
      ? approachSpeed(this.speedPlanar, targetSpeed, accelRate, dt)
      : approachSpeed(this.speedPlanar, targetSpeed, accelRate, dt);

    const accelMeasured = Math.abs(this.speedPlanar - prevSpeed) / Math.max(dt, 1e-4);
    if (accelMeasured > this.telemetry.maxAccel) this.telemetry.maxAccel = accelMeasured;

    // Air drag bleeds speed slowly when there is no input.
    if (!this.grounded && !hasInput) {
      this.speedPlanar *= (1 - MOVE.AIR_DRAG * dt);
    }

    // --- body rotation ----------------------------------------------------
    if (hasInput) {
      const desiredYaw = Math.atan2(wishX, wishZ);
      const turnRate = this.lockTarget ? MOVE.TURN_RATE_LOCKED
        : (this.grounded ? MOVE.TURN_RATE_GROUND : MOVE.TURN_RATE_AIR);
      this.yaw = moveTowardsAngle(this.yaw, desiredYaw, turnRate * dt);
    } else if (this.grounded) {
      // Idle: body eases toward the camera so the silhouette reads correctly.
      this.yaw = moveTowardsAngle(this.yaw, this.cameraYaw, MOVE.TURN_RATE_GROUND * 0.35 * dt);
    }

    // --- velocity composition ---------------------------------------------
    const dirX = hasInput ? Math.sin(this.yaw) : (this.speedPlanar > 0.01 ? Math.sin(this.yaw) : 0);
    const dirZ = hasInput ? Math.cos(this.yaw) : (this.speedPlanar > 0.01 ? Math.cos(this.yaw) : 0);

    if (this.grounded) {
      // Grounded velocity follows the body direction exactly — no residual
      // lateral component, which is what causes the "ice skating" feel.
      this.velocity.set(dirX * this.speedPlanar, 0, dirZ * this.speedPlanar);
    } else {
      // Airborne: preserve existing momentum direction, steer toward wish dir.
      const cur = Math.hypot(this.velocity.x, this.velocity.z);
      if (hasInput) {
        const wishDirX = wishX / (Math.hypot(wishX, wishZ) || 1);
        const wishDirZ = wishZ / (Math.hypot(wishX, wishZ) || 1);
        const blend = clamp((MOVE.AIR_ACCEL * dt) / Math.max(cur, 0.001), 0, 1);
        const nx = cur > 0.001 ? lerp(this.velocity.x / cur, wishDirX, blend) : wishDirX;
        const nz = cur > 0.001 ? lerp(this.velocity.z / cur, wishDirZ, blend) : wishDirZ;
        const nl = Math.hypot(nx, nz) || 1;
        const sp = Math.max(cur, this.speedPlanar);
        this.velocity.x = (nx / nl) * sp;
        this.velocity.z = (nz / nl) * sp;
      }
      this.speedPlanar = Math.hypot(this.velocity.x, this.velocity.z);
    }

    // --- jump -------------------------------------------------------------
    if (intent.jump) this.jumpBuffer = MOVE.JUMP_BUFFER;
    const canJump = (this.grounded || this.coyote > 0) && this.stance === Stance.STAND
      && this.attackLock <= 0 && this.state !== PlayerState.DODGE;
    if (this.jumpBuffer > 0 && canJump) {
      this.jumpBuffer = 0;
      this.coyote = 0;
      this.verticalVelocity = MOVE.JUMP_VELOCITY;
      this.grounded = false;
      this.state = PlayerState.AIRBORNE;
      this.telemetry.jumps++;
      this._emit('PLAYER_JUMPED', { vy: this.verticalVelocity, pos: this.pos.clone() });
    }
    // Variable jump height: releasing early cuts the rise.
    if (!intent.jumpHeld && this.verticalVelocity > 0 && !this.grounded) {
      this.verticalVelocity *= MOVE.JUMP_CUT_MULTIPLIER;
    }

    // --- dodge ------------------------------------------------------------
    if (intent.dodge && this.dodgeCooldown <= 0 && this.attackLock <= 0
      && this.state !== PlayerState.DODGE
      && this.spendStamina(MOVE.DODGE_STAMINA_COST)) {
      this._startDodge(ix, iz, hasInput);
    }

    // --- ledge grab -------------------------------------------------------
    if (intent.ledge && ledgeGrabIsAllowed(this)) {
      this._tryLedgeGrab();
    }

    // --- gravity + integration --------------------------------------------
    this._applyGravity(dt);
    const wasGrounded = this.grounded;
    this._integrate(dt);

    // --- landing ----------------------------------------------------------
    if (!wasGrounded && this.grounded) this._onLand(ctx);

    // --- state bookkeeping -------------------------------------------------
    if (this.grounded) {
      if (this.state === PlayerState.AIRBORNE || this.state === PlayerState.IDLE || this.state === PlayerState.LOCOMOTION) {
        this.state = this.speedPlanar > 0.12 ? PlayerState.LOCOMOTION : PlayerState.IDLE;
      }
    } else if (this.state !== PlayerState.DODGE) {
      this.state = PlayerState.AIRBORNE;
    }

    // --- region transition -------------------------------------------------
    if (ctx?.world && this.grounded) {
      const result = ctx.world.updatePlayerRegion(this.pos, ctx.regionId);
      if (result?.ok) {
        this.setPosition(result.spawn.x, result.spawn.y, result.spawn.z);
        this._emit('PLAYER_ENTERED_REGION', { region: result.regionId, from: ctx.regionId });
      }
    }

    this._emit('PLAYER_MOVED', {
      pos: this.pos.clone(), speed: this.speedPlanar,
      grounded: this.grounded, sprinting: this.sprinting, stance: this.stance,
    });
  }

  _startDodge(ix, iz, hasInput) {
    this.state = PlayerState.DODGE;
    this.dodgeTime = 0;
    this.dodgeCooldown = MOVE.DODGE_DURATION + MOVE.DODGE_COOLDOWN;
    this.telemetry.dodges++;

    // Dodge in the input direction if given, else backwards relative to facing.
    let dx = ix, dz = iz;
    if (!hasInput) {
      dx = -Math.sin(this.yaw);
      dz = -Math.cos(this.yaw);
    } else {
      // Convert camera-space input into world space.
      const sin = Math.sin(this.cameraYaw), cos = Math.cos(this.cameraYaw);
      const wx = ix * cos - iz * sin;
      const wz = -ix * sin - iz * cos;
      dx = wx; dz = wz;
      const l = Math.hypot(dx, dz) || 1;
      dx /= l; dz /= l;
      this.yaw = Math.atan2(dx, dz);
    }
    this.dodgeDir.set(dx, 0, dz);
    this.iframes = 0;   // i-frames open after DODGE_IFRAME_START
    this._emit('PLAYER_DODGED', { dir: this.dodgeDir.clone(), pos: this.pos.clone() });
  }

  _updateDodge(dt, intent) {
    this.dodgeTime += dt;

    // Invulnerability window inside the dodge.
    if (this.dodgeTime >= MOVE.DODGE_IFRAME_START && this.dodgeTime <= MOVE.DODGE_IFRAME_END) {
      this.iframes = Math.max(this.iframes, 0.02);
    } else {
      this.iframes = Math.max(0, this.iframes - dt);
    }

    // Speed envelope: fast launch, ease out — reads as a committed lunge.
    const t = clamp(this.dodgeTime / MOVE.DODGE_DURATION, 0, 1);
    const envelope = t < 0.32 ? smoothstep(t / 0.32) : 1 - smoothstep((t - 0.32) / 0.68) * 0.82;
    const speed = MOVE.DODGE_SPEED * envelope;
    this.velocity.set(this.dodgeDir.x * speed, this.velocity.y, this.dodgeDir.z * speed);
    this.speedPlanar = speed;

    this._applyGravity(dt);
    this._integrate(dt);

    if (this.dodgeTime >= MOVE.DODGE_DURATION) {
      this.state = this.grounded ? PlayerState.IDLE : PlayerState.AIRBORNE;
      this.speedPlanar = Math.hypot(this.velocity.x, this.velocity.z) * 0.45;
      this.velocity.scale(0.45);
    }
    void intent;
  }

  /* ---------------------------------------------------------------- ledge */

  _tryLedgeGrab() {
    if (this.state === PlayerState.LEDGE_HANG || this.state === PlayerState.LEDGE_CLIMB) return;
    const facing = new Vec3(Math.sin(this.cameraYaw), 0, Math.cos(this.cameraYaw)).normalize();
    const probe = probeLedge({
      pos: this.pos, facing, collision: this.collision,
      radius: this.capsuleRadius, height: MOVE.CAPSULE_HEIGHT,
      grounded: this.grounded, verticalVelocity: this.verticalVelocity,
      stamina: this.stamina,
    });
    if (!probe.grabbed) return;

    if (!this.spendStamina(MOVE.LEDGE_GRAB_STAMINA_COST)) return;

    this.state = PlayerState.LEDGE_HANG;
    this.ledge = probe.ledge;
    this.hang = { time: 0, stamina: this.stamina, expired: false };
    this.verticalVelocity = 0;
    this.velocity.set(0, 0, 0);
    this.speedPlanar = 0;
    this.grounded = false;
    // Snap to the ledge face so the pose reads correctly.
    this.pos.set(probe.ledge.x, probe.ledge.top - MOVE.CAPSULE_HEIGHT * 0.62, probe.ledge.z);
    this.yaw = Math.atan2(probe.ledge.nx, probe.ledge.nz);
    this.telemetry.ledgeGrabs++;
    this._emit('PLAYER_LEDGE_GRAB', { ledge: { ...probe.ledge, collider: undefined } });
  }

  _updateHang(dt, intent) {
    this.hang = hangUpdate(this.hang, dt);
    this.stamina = this.hang.stamina;
    this.velocity.set(0, 0, 0);
    this.verticalVelocity = 0;
    this.speedPlanar = 0;

    // Shimmy along the ledge with strafe input.
    const strafe = intent.moveX ?? 0;
    if (Math.abs(strafe) > 0.1 && this.ledge) {
      const tx = -this.ledge.nz, tz = this.ledge.nx;
      const dx = tx * strafe * MOVE.LEDGE_SHIMMY_SPEED * dt;
      const dz = tz * strafe * MOVE.LEDGE_SHIMMY_SPEED * dt;
      const candidate = new Vec3(this.pos.x + dx, this.pos.y, this.pos.z + dz);
      if (this.collision?.isSpaceFree(candidate, this.capsuleRadius * 0.9, MOVE.CAPSULE_HEIGHT * 0.7)) {
        this.pos.copy(candidate);
        this.ledge.x = candidate.x;
        this.ledge.z = candidate.z;
      }
    }

    // Climb up on forward input or jump.
    if ((intent.moveZ ?? 0) > 0.5 || intent.jump) {
      this._beginMantle();
      return;
    }
    // Drop on back input or dodge.
    if ((intent.moveZ ?? 0) < -0.5 || intent.dodge) {
      this._releaseLedge();
      return;
    }
    if (this.hang.expired) this._releaseLedge();
  }

  _beginMantle() {
    this.state = PlayerState.LEDGE_CLIMB;
    this.mantleElapsed = 0;
    this.mantleFrom = this.pos.clone();
  }

  _updateMantle(dt) {
    this.mantleElapsed += dt;
    const p = mantlePosition(this.ledge, this.mantleFrom, this.mantleElapsed);
    this.pos.copy(p);
    this.velocity.set(0, 0, 0);
    this.verticalVelocity = 0;

    if (this.mantleElapsed >= MOVE.LEDGE_CLIMB_TIME) {
      this.pos.set(this.ledge.mantle.x, this.ledge.mantle.y, this.ledge.mantle.z);
      this.state = PlayerState.IDLE;
      this.grounded = true;
      this.ledge = null;
      this.hang = null;
      this.telemetry.mantles++;
      this.landRecovery = 0.1;
      this._emit('PLAYER_LEDGE_RELEASE', { mantled: true, pos: this.pos.clone() });
    }
  }

  _releaseLedge() {
    const wasHang = this.state === PlayerState.LEDGE_HANG;
    this.state = PlayerState.AIRBORNE;
    this.ledge = null;
    this.hang = null;
    this.grounded = false;
    this.verticalVelocity = -0.6;
    if (wasHang) {
      // Step away from the wall so we do not immediately re-grab.
      this.pos.x -= Math.sin(this.yaw) * 0.22;
      this.pos.z -= Math.cos(this.yaw) * 0.22;
    }
    this._emit('PLAYER_LEDGE_RELEASE', { mantled: false, pos: this.pos.clone() });
  }

  /* -------------------------------------------------------------- physics */

  _applyGravity(dt) {
    if (this.grounded && this.verticalVelocity <= 0) {
      // Keep a small downward bias so ground snapping stays authoritative.
      this.verticalVelocity = -0.5;
      return;
    }
    const scale = this.verticalVelocity < 0 ? MOVE.FALL_GRAVITY_SCALE : 1;
    this.verticalVelocity = Math.max(
      -MOVE.MAX_FALL_SPEED,
      this.verticalVelocity - MOVE.GRAVITY * scale * dt,
    );
  }

  _integrate(dt) {
    if (!this.collision) {
      // No collision world (unit tests on bare logic): integrate analytically.
      this.pos.x += this.velocity.x * dt;
      this.pos.z += this.velocity.z * dt;
      this.pos.y += this.verticalVelocity * dt;
      if (this.pos.y <= 0) { this.pos.y = 0; this.verticalVelocity = 0; this.grounded = true; }
      return;
    }

    const delta = new Vec3(this.velocity.x * dt, this.verticalVelocity * dt, this.velocity.z * dt);
    const result = this.collision.moveCapsule(this.pos, delta, {
      radius: this.capsuleRadius,
      height: this.capsuleHeight,
      grounded: this.grounded,
      allowStep: this.state !== PlayerState.DODGE,
    });

    this.pos.copy(result.pos);
    const wasGrounded = this.grounded;
    this.grounded = result.grounded;
    this.groundCollider = result.groundCollider;

    if (result.hitWall) {
      // Cancel the blocked component but keep sliding along the surface.
      if (result.slidAlong) {
        const dot = this.velocity.x * result.slidAlong.x + this.velocity.z * result.slidAlong.z;
        this.velocity.x = result.slidAlong.x * dot;
        this.velocity.z = result.slidAlong.z * dot;
        this.speedPlanar = Math.hypot(this.velocity.x, this.velocity.z);
      } else {
        this.velocity.x = 0; this.velocity.z = 0;
        this.speedPlanar = 0;
      }
    }

    if (this.grounded && !wasGrounded) {
      this.verticalVelocity = 0;
    } else if (this.grounded) {
      this.verticalVelocity = Math.min(this.verticalVelocity, 0);
    }
  }

  _onLand(ctx) {
    const dropHeight = Math.max(0, this.fallPeakY - this.pos.y);
    const result = computeFallDamage(dropHeight, {
      rolling: ctx?.rolling === true || (this.speedPlanar > MOVE.WALK_SPEED && this.stamina > MOVE.DODGE_STAMINA_COST),
      stamina: this.stamina,
      groundedSpeed: this.speedPlanar,
    });

    this.landRecovery = MOVE.LAND_RECOVERY;
    this.verticalVelocity = 0;

    this._emit('PLAYER_LANDED', {
      height: dropHeight,
      damage: result.damage === Infinity ? this.health : result.damage,
      severity: result.severity,
      mitigated: result.mitigated,
    });

    if (result.damage > 0) {
      this.telemetry.fallDamageEvents++;
      this.lastFallDamage = { height: dropHeight, ...result };
      this._emit('PLAYER_FALL_DAMAGE', this.lastFallDamage);
      if (result.lethal) {
        this.health = 0;
        this.die('fall');
      } else {
        this.damage(result.damage, 'fall');
      }
    }
    void ctx;
  }

  /* ----------------------------------------------------------------- misc */

  _updateHealthRegen(dt) {
    if (!this.alive) return;
    if (this.regenDelay > 0) return;
    if (this.health >= this.maxHealth) return;
    this.health = clamp(this.health + COMBAT.REGEN_RATE * dt, 0, this.maxHealth);
  }

  _updateFinisher(dt) {
    this.velocity.set(0, 0, 0);
    this.verticalVelocity = 0;
    this.speedPlanar = 0;
    this.iframes = Math.max(this.iframes, dt + 0.01);
    this.finisherTime = (this.finisherTime ?? 0) + dt;
    if (this.finisherTime >= COMBAT.FINISHER_DURATION) {
      this.finisherTime = 0;
      this.state = PlayerState.IDLE;
    }
  }

  startFinisher() {
    this.state = PlayerState.FINISHER;
    this.finisherTime = 0;
    this.velocity.set(0, 0, 0);
    this.verticalVelocity = 0;
  }

  /**
   * Recovery used when state becomes non-finite or the player ends up inside
   * geometry. Guarantees the player can never be permanently stuck (§19 P0).
   */
  recoverToSafeGround(ctx) {
    const region = ctx?.region;
    const nav = region?.nav;
    if (nav) {
      const cell = nav.nearestWalkable(this.pos.x, this.pos.z, 40);
      if (cell) {
        const w = nav.cellToWorld(cell.col, cell.row);
        this.pos.set(w.x, nav.heightAt(cell.col, cell.row), w.z);
        this.velocity.set(0, 0, 0);
        this.verticalVelocity = 0;
        this.grounded = true;
        this.state = PlayerState.IDLE;
        return true;
      }
    }
    this.pos.set(0, 0, 0);
    this.velocity.set(0, 0, 0);
    this.verticalVelocity = 0;
    this.grounded = true;
    this.state = PlayerState.IDLE;
    return false;
  }

  /* ------------------------------------------------------------ serialise */

  serialize() {
    return {
      pos: this.pos.toArray(),
      yaw: this.yaw,
      cameraYaw: this.cameraYaw,
      cameraPitch: this.cameraPitch,
      shoulderRight: this.shoulderRight,
      velocity: this.velocity.toArray(),
      verticalVelocity: this.verticalVelocity,
      grounded: this.grounded,
      state: this.state,
      stance: this.stance,
      crouchBlend: this.crouchBlend,
      speedPlanar: this.speedPlanar,
      health: this.health,
      maxHealth: this.maxHealth,
      stamina: this.stamina,
      exhausted: this.exhausted,
      injured: this.injured,
      sprinting: !!this.sprinting,
    };
  }

  static deserialize(data, opts = {}) {
    const p = new PlayerController(opts);
    if (!data || typeof data !== 'object') return p;
    if (Array.isArray(data.pos)) p.pos = Vec3.fromArray(data.pos);
    if (Array.isArray(data.velocity)) p.velocity = Vec3.fromArray(data.velocity);
    p.yaw = Number.isFinite(data.yaw) ? data.yaw : 0;
    p.cameraYaw = Number.isFinite(data.cameraYaw) ? data.cameraYaw : p.yaw;
    p.cameraPitch = clamp(Number.isFinite(data.cameraPitch) ? data.cameraPitch : 0.16, -1.15, 1.25);
    p.shoulderRight = data.shoulderRight !== false;
    p.verticalVelocity = Number.isFinite(data.verticalVelocity) ? data.verticalVelocity : 0;
    p.grounded = data.grounded !== false;
    p.stance = data.stance === Stance.CROUCH ? Stance.CROUCH : Stance.STAND;
    p.crouchBlend = clamp01Safe(data.crouchBlend);
    p.speedPlanar = Number.isFinite(data.speedPlanar) ? data.speedPlanar : 0;
    p.health = clamp(Number.isFinite(data.health) ? data.health : COMBAT.PLAYER_MAX_HEALTH, 0, p.maxHealth);
    p.stamina = clamp(Number.isFinite(data.stamina) ? data.stamina : MOVE.STAMINA_MAX, 0, MOVE.STAMINA_MAX);
    p.exhausted = data.exhausted === true;
    p.injured = data.injured === true;
    p.sprinting = data.sprinting === true;
    // Never restore into DEAD/LEDGE states — those are transient and restoring
    // them could soft-lock the player on load (§19 P0 prevention).
    p.state = [PlayerState.DEAD].includes(data.state) ? PlayerState.IDLE : (data.state ?? PlayerState.IDLE);
    if (p.state === PlayerState.LEDGE_HANG || p.state === PlayerState.LEDGE_CLIMB) {
      p.state = PlayerState.IDLE;
    }
    if (!p.pos.isFiniteVec()) p.pos.set(0, 0, 0);
    return p;
  }

  _emit(type, payload) {
    if (this.bus) this.bus.emit(resolveEventName(type), payload);
  }
}

/* ---------------------------------------------------------------- helpers */

function approachSpeed(current, target, rate, dt) {
  if (target > current) return Math.min(target, current + rate * dt);
  return Math.max(target, current - rate * dt);
}

function clamp01Safe(v) { return Number.isFinite(v) ? clamp(v, 0, 1) : 0; }

function applyStickResponse(v) {
  const dz = CAM.GAMEPAD_DEADZONE;
  const a = Math.abs(v);
  if (a <= dz) return 0;
  const norm = (a - dz) / (1 - dz);
  return Math.sign(v) * Math.pow(norm, CAM.GAMEPAD_RESPONSE_EXPONENT);
}

/** Map local shorthand names onto the canonical event table. */
const EVENT_ALIAS = {
  PLAYER_DAMAGED: Events.PLAYER_DAMAGED,
  PLAYER_HEALED: Events.PLAYER_HEALED,
  PLAYER_DIED: Events.PLAYER_DIED,
  PLAYER_MOVED: Events.PLAYER_MOVED,
  PLAYER_JUMPED: Events.PLAYER_JUMPED,
  PLAYER_LANDED: Events.PLAYER_LANDED,
  PLAYER_DODGED: Events.PLAYER_DODGED,
  PLAYER_CROUCHED: Events.PLAYER_CROUCHED,
  PLAYER_SPRINTED: Events.PLAYER_SPRINTED,
  PLAYER_FALL_DAMAGE: Events.PLAYER_FALL_DAMAGE,
  PLAYER_LEDGE_GRAB: Events.PLAYER_LEDGE_GRAB,
  PLAYER_LEDGE_RELEASE: Events.PLAYER_LEDGE_RELEASE,
  PLAYER_ENTERED_REGION: Events.PLAYER_ENTERED_REGION,
  'player:state': 'player:state',
};
function resolveEventName(name) { return EVENT_ALIAS[name] ?? name; }

export { STEALTH as _STEALTH_FOR_TESTS };
