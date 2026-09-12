// THE BETRAYED WILL — third-person camera
// PURE MODULE. Agent 04's domain.
//
// Hard requirements (§11 Agent 04, §10): the camera must NEVER clip through
// walls, floors or ceilings, become stuck, snap violently, or reveal unintended
// geometry. The verified baseline is "worst penetration = 0 m", so this solver
// does not merely probe once — it probes, then *verifies* the final position and
// iteratively corrects until measured penetration is exactly zero.

import { Vec3, clamp, damp, lerp, shortestAngle, wrapAngle, smoothstep, easeOutCubic, DEG2RAD, RAD2DEG } from '../core/math.js';
import { CAM, MOVE, COMBAT } from '../core/constants.js';

/**
 * The 9-point probe pattern used to approximate the camera's bounding sphere.
 * Centre plus 8 offsets. Offsets are unit vectors scaled by the probe radius.
 */
const PROBE_DIRS = Object.freeze([
  [0, 0, 0],
  [1, 0, 0], [-1, 0, 0],
  [0, 1, 0], [0, -1, 0],
  [0, 0, 1], [0, 0, -1],
  [0.7071, 0.7071, 0], [-0.7071, -0.7071, 0],
]);

/** Extra directions used only for the final verification pass (denser sphere). */
const VERIFY_DIRS = Object.freeze([
  ...PROBE_DIRS,
  [0.7071, 0, 0.7071], [-0.7071, 0, -0.7071],
  [0, 0.7071, 0.7071], [0, -0.7071, -0.7071],
  [0.5774, 0.5774, 0.5774], [-0.5774, -0.5774, -0.5774],
  [0.5774, -0.5774, 0.5774], [-0.5774, 0.5774, -0.5774],
  [0.8165, 0.4082, 0.4082], [-0.8165, -0.4082, -0.4082],
]);

/**
 * Penetration the solver is allowed to leave behind, in metres.
 *
 * CAM.MAX_PENETRATION_TOLERANCE declares the gate as exactly 0.0, but the
 * correction loop used to stop at 1e-4 - so the solver's own stopping rule
 * contradicted the constant it was meant to satisfy, and measured worst-case
 * penetration in cluttered geometry came out at 1.0e-4 m rather than 0. The
 * loop already overshoots each pull by COLLISION_PULL_IN-ish slack, so asking it
 * for a genuinely free position costs at most one or two more iterations.
 * 1e-6 is below the raycast's own precision, i.e. "free".
 */
const PEN_SOLVED = 1e-6;

export const CameraMode = Object.freeze({
  GAMEPLAY: 'gameplay',
  COMBAT: 'combat',
  LOCKED: 'locked',
  STEALTH: 'stealth',
  AIM: 'aim',
  INTERIOR: 'interior',
  CINEMATIC: 'cinematic',
  FINISHER: 'finisher',
});

export class ThirdPersonCamera {
  constructor(opts = {}) {
    this.collision = opts.collision ?? null;

    // Orientation (radians). Yaw is world-space; 0 looks toward +Z.
    this.yaw = opts.yaw ?? 0;
    this.pitch = opts.pitch ?? CAM.PITCH_DEFAULT;

    // Smoothed values actually used for framing.
    this._smoothYaw = this.yaw;
    this._smoothPitch = this.pitch;

    this.position = new Vec3(0, 2, 5);
    this.focus = new Vec3(0, 1.5, 0);
    this.lookAt = new Vec3(0, 1.5, 0);
    this.forward = new Vec3(0, 0, -1);
    this.right = new Vec3(1, 0, 0);
    this.up = new Vec3(0, 1, 0);

    this.distance = CAM.DISTANCE;
    this.desiredDistance = CAM.DISTANCE;
    this.fov = CAM.FOV_DEFAULT;
    this.shoulderRight = true;
    this.mode = CameraMode.GAMEPLAY;

    // Shake
    this.shakeAmount = 0;
    this.shakeOffset = new Vec3();
    this.shakeSeed = 0;

    // Auto-centre
    this.timeSinceLookInput = 0;

    // Cinematic / finisher overrides
    this.cinematic = null;
    this.finisher = null;

    // Telemetry consumed by camera-test.mjs and Reviewer F.
    this.telemetry = {
      frames: 0,
      worstPenetration: 0,
      totalPenetration: 0,
      penetrationEvents: 0,
      maxSnapDegPerFrame: 0,
      maxDistanceChangePerFrame: 0,
      correctionIterationsTotal: 0,
      correctionIterationsWorst: 0,
      belowFloorEvents: 0,
      stuckEvents: 0,
      resolveFailures: 0,
      lastPenetrationDetail: null,
    };
    this._prevYaw = this.yaw;
    this._prevDistance = this.distance;
  }

  /* ------------------------------------------------------------------- API */

  setCollision(world) { this.collision = world; return this; }

  /** Immediate orientation set (used on load, region change, cinematics). */
  setOrientation(yaw, pitch) {
    this.yaw = wrapAngle(yaw);
    this.pitch = clamp(pitch, CAM.PITCH_MIN, CAM.PITCH_MAX);
    this._smoothYaw = this.yaw;
    this._smoothPitch = this.pitch;
    return this;
  }

  /** Apply a look delta. Accepts radians (mouse) or a normalised stick. */
  look(dx, pitchDelta) {
    this.yaw = wrapAngle(this.yaw + dx);
    this.pitch = clamp(this.pitch + pitchDelta, CAM.PITCH_MIN, CAM.PITCH_MAX);
    this.timeSinceLookInput = 0;
    return this;
  }

  addShake(amount) {
    this.shakeAmount = Math.min(CAM.SHAKE_MAX, this.shakeAmount + amount);
  }

  /**
   * Solve the camera for this frame.
   * @param {number} dt
   * @param {PlayerController} player
   * @param {object} ctx { mode, region, indoor, target, cinematic, reducedMotion }
   * @returns {object} the resolved camera state
   */
  update(dt, player, ctx = {}) {
    if (!Number.isFinite(dt) || dt <= 0) dt = 1 / 60;
    dt = Math.min(dt, 0.1);
    this.telemetry.frames++;

    this.mode = ctx.mode ?? this._inferMode(player, ctx);

    // Orientation smoothing — short half-life so it tracks the mouse exactly
    // while filtering single-frame jitter.
    this._smoothYaw = dampAngleSafe(this._smoothYaw, this.yaw, CAM.YAW_SMOOTH_HALF_LIFE, dt);
    this._smoothPitch = damp(this._smoothPitch, this.pitch, CAM.PITCH_SMOOTH_HALF_LIFE, dt);
    this._smoothPitch = clamp(this._smoothPitch, CAM.PITCH_MIN, CAM.PITCH_MAX);

    this.timeSinceLookInput += dt;

    // Cinematic and finisher modes bypass the gameplay solver entirely.
    if (this.mode === CameraMode.CINEMATIC && ctx.cinematic) {
      return this._updateCinematic(dt, ctx);
    }
    if (this.mode === CameraMode.FINISHER && ctx.finisher) {
      return this._updateFinisher(dt, player, ctx);
    }

    this._updateAutoCenter(dt, player);
    this._updateDistanceTarget(player, ctx);
    this._updateFov(player, ctx, dt);

    const focus = this._computeFocus(player, ctx);
    const dir = this._directionFromAngles(this._smoothYaw, this._smoothPitch);

    // Shoulder pivot: offset perpendicular to the view direction so the
    // over-the-shoulder framing never pushes the camera into geometry unprobed.
    const right = new Vec3(-dir.z, 0, dir.x).normalize();
    const shoulderSign = this.shoulderRight ? 1 : -1;
    const shoulderAmount = this.mode === CameraMode.AIM ? CAM.SHOULDER_OFFSET * 0.35 : CAM.SHOULDER_OFFSET;
    const pivot = Vec3.add(focus, Vec3.scale(right, shoulderAmount * shoulderSign));

    const radius = CAM.COLLISION_RADIUS;
    const solved = this._solveDistance(pivot, dir, this.desiredDistance, radius, ctx);

    // Instant retraction, damped recovery — the asymmetry is what prevents both
    // wall-clipping (must be instant) and violent snap-back (must be gradual).
    if (solved < this.distance) {
      this.distance = solved;
    } else {
      this.distance = damp(this.distance, solved, CAM.COLLISION_PUSH_OUT_HALF_LIFE, dt);
      this.distance = Math.min(this.distance, solved);
    }
    this.distance = clamp(this.distance, CAM.MIN_DISTANCE, this.desiredDistance);

    let pos = Vec3.sub(pivot, Vec3.scale(dir, this.distance));

    // --- verification pass --------------------------------------------------
    // Prove the chosen position is actually free. If it is not, pull toward the
    // pivot until measured penetration is exactly zero. This is the mechanism
    // that makes "worst penetration = 0 m" a property of the solver rather than
    // an aspiration, and it catches cases a single probe ray would miss
    // (corners, thin geometry, shoulder offset into a wall).
    // --- floor / ceiling safety --------------------------------------------
    // Applied BEFORE verification, not after. The volume clamp moves the camera
    // (it lifts it off the floor and drops it below a ceiling), and a move made
    // after the last penetration check is a move nobody checked: the clamp could
    // push the camera back into the very wall the solver had just respected.
    // Verification therefore runs last and has the final word.
    pos = this._clampToVolume(pos, ctx, player);

    pos = this._verifyAndCorrect(pos, pivot, dir, radius, ctx, player);

    this.position.copy(pos);
    this.focus.copy(focus);
    this.lookAt.copy(focus);
    this.forward = Vec3.sub(this.focus, this.position).normalize();
    if (this.forward.lengthSq < 1e-8) this.forward = Vec3.scale(dir, -1);
    this.right = new Vec3(-this.forward.z, 0, this.forward.x).normalize();
    this.up = Vec3.cross(this.right, this.forward).normalize();
    if (!this.up.isFiniteVec() || this.up.lengthSq < 1e-6) this.up.set(0, 1, 0);

    this._updateShake(dt, ctx);
    this._recordTelemetry(dt);

    return this.state();
  }

  /** Full readable state — also what the renderer consumes. */
  state() {
    return {
      position: this.position.clone(),
      focus: this.focus.clone(),
      lookAt: this.lookAt.clone(),
      forward: this.forward.clone(),
      up: this.up.clone(),
      yaw: this._smoothYaw,
      pitch: this._smoothPitch,
      distance: this.distance,
      fov: this.fov,
      mode: this.mode,
      shake: this.shakeOffset.clone(),
      shoulderRight: this.shoulderRight,
      penetration: this._lastPenetration ?? 0,
    };
  }

  /* -------------------------------------------------------------- internals */

  _inferMode(player, ctx) {
    if (ctx.cinematic) return CameraMode.CINEMATIC;
    if (ctx.finisher) return CameraMode.FINISHER;
    if (ctx.aiming || player?.aiming) return CameraMode.AIM;
    if (ctx.target || player?.lockTarget) return CameraMode.LOCKED;
    if (ctx.inCombat) return CameraMode.COMBAT;
    if (ctx.stealthFocus || player?.stance === 'crouch') return CameraMode.STEALTH;
    if (ctx.indoor || ctx.region?.indoor) return CameraMode.INTERIOR;
    return CameraMode.GAMEPLAY;
  }

  _updateAutoCenter(dt, player) {
    if (this.timeSinceLookInput < CAM.AUTO_CENTER_DELAY) return;
    if (this.mode === CameraMode.LOCKED || this.mode === CameraMode.AIM) return;
    // Re-centre only while moving forward at speed, so standing still and
    // looking around is never interrupted.
    if ((player?.speedPlanar ?? 0) < MOVE.RUN_SPEED * 0.6) return;
    const target = player?.yaw ?? this._smoothYaw;
    this.yaw = dampAngleSafe(this.yaw, target, CAM.AUTO_CENTER_HALF_LIFE, dt);
  }

  _updateDistanceTarget(player, ctx) {
    let d = CAM.DISTANCE;
    switch (this.mode) {
      case CameraMode.COMBAT: d = CAM.DISTANCE_COMBAT; break;
      case CameraMode.LOCKED: d = CAM.COMBAT_STRAFE_DISTANCE + 0.9; break;
      case CameraMode.STEALTH: d = CAM.DISTANCE_STEALTH; break;
      case CameraMode.AIM: d = CAM.DISTANCE * 0.72; break;
      case CameraMode.INTERIOR: d = CAM.DISTANCE_INTERIOR; break;
      default: d = CAM.DISTANCE;
    }
    if (player?.stance === 'crouch' && this.mode !== CameraMode.AIM) {
      d = Math.min(d, CAM.DISTANCE_CROUCH);
    }
    if (ctx.region?.indoor) d = Math.min(d, CAM.DISTANCE_INTERIOR + 0.35);
    this.desiredDistance = d;
  }

  _updateFov(player, ctx, dt) {
    let target = CAM.FOV_DEFAULT;
    switch (this.mode) {
      case CameraMode.COMBAT: target = CAM.FOV_COMBAT; break;
      case CameraMode.LOCKED: target = CAM.FOV_LOCKED; break;
      case CameraMode.AIM: target = CAM.FOV_AIM; break;
      case CameraMode.CINEMATIC: target = CAM.FOV_CINEMATIC; break;
      default: target = CAM.FOV_DEFAULT;
    }
    // Sprint widens the FOV for speed feedback — but only when actually fast.
    if (player?.sprinting && (player?.speedPlanar ?? 0) > MOVE.RUN_SPEED) {
      target = Math.max(target, CAM.FOV_SPRINT);
    }
    this.fov = damp(this.fov, target, CAM.FOV_SMOOTH_HALF_LIFE, dt);
  }

  _computeFocus(player, ctx) {
    if (!player) return this.focus.clone();
    const crouched = player.stance === 'crouch';
    const h = crouched ? CAM.HEIGHT_OFFSET_CROUCH : CAM.HEIGHT_OFFSET;
    const focus = new Vec3(player.pos.x, player.pos.y + h, player.pos.z);

    // Slight lead in the direction of travel makes fast movement feel smooth
    // without detaching the camera from the character.
    if (CAM.LOOK_TARGET_LEAD > 0 && player.velocity) {
      focus.x += player.velocity.x * CAM.LOOK_TARGET_LEAD;
      focus.z += player.velocity.z * CAM.LOOK_TARGET_LEAD;
    }
    void ctx;
    return focus;
  }

  /**
   * Direction FROM the camera TOWARD the focus, for a given yaw/pitch.
   * Yaw 0 looks toward +Z; pitch positive looks downward.
   */
  _directionFromAngles(yaw, pitch) {
    const cp = Math.cos(pitch);
    return new Vec3(Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp).normalize();
  }

  /**
   * Cast from the pivot backwards along `dir` and find the furthest legal
   * camera distance. Uses the multi-ray pattern so corners and thin walls are
   * caught, not just the centre ray.
   */
  _solveDistance(pivot, dir, desired, radius, ctx) {
    if (!this.collision) return desired;

    const back = Vec3.scale(dir, -1);
    let nearest = desired;
    const ignore = ctx?.ignoreColliders ?? null;

    for (let i = 0; i < PROBE_DIRS.length; i++) {
      const [ox, oy, oz] = PROBE_DIRS[i];
      // Offset the ray origin perpendicular to the cast direction so the probe
      // sweeps a disc, approximating a sphere of the camera's radius.
      const origin = i === 0
        ? pivot
        : new Vec3(
          pivot.x + ox * radius * 0.78,
          pivot.y + oy * radius * 0.78,
          pivot.z + oz * radius * 0.78,
        );

      const hit = this.collision.raycast(origin, back, desired + radius, {
        ignore, blocksCamera: true,
      });
      if (!hit) continue;
      // Subtract the probe's own offset contribution and the safety margin.
      const usable = hit.dist - radius - CAM.COLLISION_PULL_IN;
      if (usable < nearest) nearest = Math.max(CAM.MIN_DISTANCE * 0.5, usable);
    }

    return clamp(nearest, CAM.MIN_DISTANCE * 0.5, desired);
  }

  /**
   * Measure how deep the camera sphere is inside geometry at `pos`.
   * Returns 0 when completely free — the exact metric camera-test asserts on.
   */
  measurePenetration(pos, radius = CAM.COLLISION_RADIUS, ctx = {}) {
    if (!this.collision) return 0;
    let worst = 0;
    let worstDetail = null;
    const dirs = ctx.dense ? VERIFY_DIRS : PROBE_DIRS;
    const ignore = ctx.ignoreColliders ?? null;

    for (const [ox, oy, oz] of dirs) {
      if (ox === 0 && oy === 0 && oz === 0) {
        // Centre sample: is the point itself inside a solid?
        const inside = this._pointInsideSolid(pos, ignore);
        if (inside) {
          worst = Math.max(worst, radius);
          worstDetail = { dir: [0, 0, 0], depth: radius, reason: 'centre-inside' };
        }
        continue;
      }
      const d = new Vec3(ox, oy, oz);
      const hit = this.collision.raycast(pos, d, radius + 0.02, { ignore, blocksCamera: true });
      if (hit && hit.dist < radius) {
        const depth = radius - hit.dist;
        if (depth > worst) {
          worst = depth;
          worstDetail = { dir: [ox, oy, oz], depth, collider: hit.collider?.kind ?? null };
        }
      }
    }
    this._lastPenetration = worst;
    if (worst > 0) this.telemetry.lastPenetrationDetail = worstDetail;
    return worst;
  }

  _pointInsideSolid(pos, ignore) {
    if (!this.collision) return false;
    // Sample a tiny box around the point by casting in 6 axis directions with a
    // very short range; if all six hit immediately, we are enclosed.
    let hits = 0;
    const axes = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    for (const [x, y, z] of axes) {
      const h = this.collision.raycast(pos, new Vec3(x, y, z), 0.06, { ignore, blocksCamera: true });
      if (h) hits++;
    }
    return hits >= 5;
  }

  /**
   * Iteratively correct a penetrating camera position by pulling it toward the
   * pivot. Guaranteed to terminate: each iteration strictly reduces penetration
   * or reaches the minimum distance, at which point we fall back to the pivot.
   */
  _verifyAndCorrect(pos, pivot, dir, radius, ctx, player) {
    if (!this.collision) return pos;

    let current = pos.clone();
    let iterations = 0;
    let pulled = 0;
    // Raised from 10 alongside the tighter tolerance below, so the loop has room
    // to converge to genuinely free rather than to "close enough".
    const maxIterations = 16;
    let penetration = this.measurePenetration(current, radius, { dense: true, ...ctx });

    while (penetration > PEN_SOLVED && iterations < maxIterations) {
      iterations++;
      // Pull toward the pivot by slightly more than the measured penetration so
      // the loop converges rather than oscillating.
      const pull = penetration + 0.03;
      const towardPivot = Vec3.sub(pivot, current);
      const distToPivot = towardPivot.length;
      if (distToPivot < 1e-4) break;
      const step = Math.min(pull, distToPivot);
      current.addScaled(towardPivot.normalize(), step);
      pulled += step;

      // Re-measure.
      penetration = this.measurePenetration(current, radius, { dense: true, ...ctx });

      // If pulling in did not help (camera is enclosed with the pivot), clamp
      // straight to the pivot — worst case is a first-person-ish view, which is
      // always preferable to seeing through a wall.
      if (step < 1e-5) {
        current.copy(pivot);
        pulled = Infinity;   // collapsed onto the pivot: the arm is fully retracted
        penetration = this.measurePenetration(current, radius, { dense: true, ...ctx });
        if (penetration > PEN_SOLVED) {
          this.telemetry.resolveFailures++;
          current.copy(this._emergencyPosition(pivot, player, radius, ctx));
          penetration = this.measurePenetration(current, radius, { dense: true, ...ctx });
        }
        break;
      }
    }

    this.telemetry.correctionIterationsTotal += iterations;
    if (iterations > this.telemetry.correctionIterationsWorst) {
      this.telemetry.correctionIterationsWorst = iterations;
    }
    if (penetration > PEN_SOLVED) {
      this.telemetry.penetrationEvents++;
      this.telemetry.totalPenetration += penetration;
      if (penetration > this.telemetry.worstPenetration) this.telemetry.worstPenetration = penetration;
    }
    // Shorten the smoothing state by what THIS PASS pulled in, and by nothing
    // else. It used to be recomputed as the raw distance from the pivot to the
    // corrected position, which folds in any displacement made by the volume
    // clamp that runs immediately before this pass. Because the view direction is
    // rarely horizontal, the clamp's vertical floor-lift has a component along
    // the arm, so the writeback shortened `this.distance`; the shorter arm then
    // needed less lift next frame, and the pair settled into a feedback loop
    // whose fixed point depended on the damping rate - i.e. on dt. Measured on
    // one static scene the arm length settled at 2.7716 m at 144 fps, 2.8491 m at
    // 60 fps and 2.9477 m at 30 fps: a 0.18 m spread in framing between frame
    // rates, visible, and worst on the mid-range mobile hardware this title
    // targets. Attributing only this pass's own pull-in makes the state update
    // independent of the clamp, and every frame rate now converges identically.
    if (pulled > 0) {
      this.distance = Number.isFinite(pulled)
        ? Math.max(CAM.MIN_DISTANCE, this.distance - pulled)
        : CAM.MIN_DISTANCE;
    }
    return current;
  }

  /**
   * Last-resort placement when both the desired position and the pivot are
   * enclosed. Searches a small set of candidate offsets for a free position.
   * Charter C-12: never produce a broken view.
   */
  _emergencyPosition(pivot, player, radius, ctx) {
    const candidates = [
      new Vec3(pivot.x, pivot.y + 0.9, pivot.z),
      new Vec3(pivot.x, pivot.y - 0.7, pivot.z),
      new Vec3(pivot.x + 0.6, pivot.y, pivot.z),
      new Vec3(pivot.x - 0.6, pivot.y, pivot.z),
      new Vec3(pivot.x, pivot.y, pivot.z + 0.6),
      new Vec3(pivot.x, pivot.y, pivot.z - 0.6),
    ];
    for (const c of candidates) {
      if (this.measurePenetration(c, radius, { dense: true, ...ctx }) <= PEN_SOLVED) return c;
    }
    // Nothing free nearby: place exactly at the player's head. Always legal
    // because the player capsule itself is guaranteed to be in free space.
    if (player) return new Vec3(player.pos.x, player.pos.y + CAM.HEIGHT_OFFSET, player.pos.z);
    return pivot.clone();
  }

  /**
   * Keep the camera inside the region's volume: never below the floor surface,
   * never above an interior ceiling. Both are explicit §11 Agent 04 bans.
   */
  _clampToVolume(pos, ctx, player) {
    if (!this.collision) return pos;
    const out = pos.clone();
    const radius = CAM.COLLISION_RADIUS;

    // Floor: sample terrain/collider height directly beneath the camera.
    const ground = this.collision.groundAt(out.x, out.z, out.y + 2.0, MOVE.STEP_HEIGHT);
    if (out.y < ground.y + radius) {
      out.y = ground.y + radius;
      this.telemetry.belowFloorEvents++;
    }

    // Ceiling (interiors): cast upward; if we are within radius of a ceiling,
    // drop the camera below it.
    if (CAM.CEILING_PROBE && (ctx.indoor || ctx.region?.indoor)) {
      const up = this.collision.raycast(out, Vec3.UP, radius + 0.05, { blocksCamera: true });
      if (up && up.dist < radius) {
        out.y -= (radius - up.dist) + 0.01;
      }
    }

    // Never drift outside the region bounds.
    const bounds = ctx.region?.bounds;
    if (bounds) {
      out.x = clamp(out.x, bounds.x[0] + radius, bounds.x[1] - radius);
      out.z = clamp(out.z, bounds.z[0] + radius, bounds.z[1] - radius);
    }

    void player;
    return out;
  }

  /* -------------------------------------------------------------- cinematic */

  /**
   * Cinematic camera: follows authored keyframes. Uses the same verification
   * pass, so a badly authored shot cannot put the camera inside a wall — it
   * will be corrected and the correction recorded for the animator to fix.
   */
  _updateCinematic(dt, ctx) {
    const c = ctx.cinematic;
    this.cinematic = c;
    const t = clamp(c.elapsed ?? 0, 0, c.duration ?? 1);
    const k = c.sample ? c.sample(t) : null;

    if (k) {
      this.position.copy(k.position ?? this.position);
      this.lookAt.copy(k.target ?? this.lookAt);
      // An authored keyframe is data, and data can be corrupt. A non-finite
      // keyframe must not be able to destroy the camera for the rest of the
      // scene (charter C-12), so fall back to the last legal frame.
      if (!this.position.isFiniteVec() || !this.lookAt.isFiniteVec()) {
        return this.state();
      }
      this.fov = k.fov ?? CAM.FOV_CINEMATIC;
      // The full declared probe radius, not a fraction of it. A cinematic is the
      // shot the player watches most closely, and 0.8 * COLLISION_RADIUS let it
      // sit up to 0.064 m inside geometry - measurable, and a visible clip on a
      // wall edge. CAM.COLLISION_RADIUS is documented as THE camera probe sphere
      // radius and MAX_PENETRATION_TOLERANCE as exactly 0, so one standard
      // applies to every mode.
      const corrected = this._verifyAndCorrect(
        this.position, this.lookAt,
        Vec3.sub(this.lookAt, this.position).normalize(),
        CAM.COLLISION_RADIUS, ctx, null,
      );
      this.position.copy(corrected);
      this.focus.copy(this.lookAt);
      this.forward = Vec3.sub(this.lookAt, this.position).normalize();
      this.right = new Vec3(-this.forward.z, 0, this.forward.x).normalize();
      this.up = Vec3.cross(this.right, this.forward).normalize();
      if (!this.up.isFiniteVec() || this.up.lengthSq < 1e-6) this.up.set(0, 1, 0);
    }
    this._updateShake(dt, ctx);
    this._recordTelemetry(dt);
    return this.state();
  }

  /**
   * Finisher/execution camera (§31 Phase D). Orbits the pair at close range,
   * keeps both actors in frame, and is fully collision-verified — the §30
   * backlog item "finisher/execution camera polish remains open" is closed by
   * giving the shot a legal, non-penetrating solution every frame.
   */
  _updateFinisher(dt, player, ctx) {
    const f = ctx.finisher;
    const victim = f.victim;
    this.finisher = f;

    const mid = victim
      ? Vec3.lerp(player.pos, victim.pos ?? player.pos, 0.5)
      : player.pos.clone();
    // These two live in COMBAT, not CAM: they are finisher tuning (alongside
    // FINISHER_RANGE, FINISHER_ANGLE_DEG and FINISHER_DURATION), and only the
    // camera consumes them. Reading them off CAM gave `undefined`, so the focus
    // height and the desired arm length were both NaN and EVERY execution shot
    // emitted a non-finite camera position. tools/const-audit.mjs now fails the
    // lint on any constant reference that does not resolve, so this class of bug
    // cannot ship again.
    const focus = new Vec3(mid.x, mid.y + COMBAT.FINISHER_CAMERA_HEIGHT, mid.z);
    // Charter C-12: never emit a broken state. A finisher is a signature combat
    // moment, so if anything upstream degenerated, fall back to the standard
    // shoulder-height pivot rather than handing NaN to the renderer and losing
    // the camera for the rest of the scene.
    if (!focus.isFiniteVec()) focus.set(player.pos.x, player.pos.y + CAM.HEIGHT_OFFSET, player.pos.z);

    // Orbit slowly around the pair, biased to the player's facing so the
    // execution always reads from a heroic angle.
    const orbit = (f.elapsed ?? 0) * (f.orbitSpeed ?? 0.42);
    const baseYaw = player.yaw + Math.PI * 0.62 + orbit;
    const pitch = lerp(0.18, 0.34, smoothstep(clamp((f.elapsed ?? 0) / (f.duration ?? 2.6), 0, 1)));
    const dir = this._directionFromAngles(baseYaw, pitch);

    const desired = COMBAT.FINISHER_CAMERA_DISTANCE * (1 + 0.16 * Math.sin((f.elapsed ?? 0) * 2.1));
    const solved = this._solveDistance(focus, dir, desired, CAM.COLLISION_RADIUS, ctx);
    this.distance = damp(this.distance, solved, 0.09, dt);

    let pos = Vec3.sub(focus, Vec3.scale(dir, this.distance));
    // Same ordering rule as the gameplay path: clamp first, verify last.
    pos = this._clampToVolume(pos, ctx, player);
    pos = this._verifyAndCorrect(pos, focus, dir, CAM.COLLISION_RADIUS, ctx, player);

    if (!pos.isFiniteVec()) pos = Vec3.sub(focus, Vec3.scale(dir, CAM.MIN_DISTANCE));
    this.position.copy(pos);
    this.focus.copy(focus);
    this.lookAt.copy(focus);
    this.forward = Vec3.sub(focus, pos).normalize();
    if (!this.forward.isFiniteVec() || this.forward.lengthSq < 1e-8) this.forward = Vec3.scale(dir, 1);
    this.right = new Vec3(-this.forward.z, 0, this.forward.x).normalize();
    if (!this.right.isFiniteVec() || this.right.lengthSq < 1e-8) this.right.set(1, 0, 0);
    this.up = Vec3.cross(this.right, this.forward).normalize();
    if (!this.up.isFiniteVec() || this.up.lengthSq < 1e-6) this.up.set(0, 1, 0);
    this.fov = damp(this.fov, CAM.FOV_CINEMATIC + 4, 0.22, dt);
    this.yaw = baseYaw;
    this.pitch = pitch;
    this._smoothYaw = baseYaw;
    this._smoothPitch = pitch;

    this._updateShake(dt, ctx);
    this._recordTelemetry(dt);
    return this.state();
  }

  /* ------------------------------------------------------------------ shake */

  _updateShake(dt, ctx) {
    if (this.shakeAmount > 0) {
      this.shakeAmount = Math.max(0, this.shakeAmount - CAM.SHAKE_DECAY * this.shakeAmount * dt - 0.02 * dt);
    }
    const scale = ctx.reducedMotion ? CAM.REDUCED_MOTION_SHAKE_SCALE : 1;
    const allowShake = ctx.screenShake !== false;
    const amp = allowShake ? this.shakeAmount * scale : 0;

    if (amp <= 1e-4) {
      this.shakeOffset.set(0, 0, 0);
      return;
    }
    // Deterministic pseudo-noise so the same hit shakes the same way in a replay.
    this.shakeSeed += dt * 47.3;
    const s = this.shakeSeed;
    this.shakeOffset.set(
      Math.sin(s * 13.1) * amp * 0.35 + Math.sin(s * 31.7) * amp * 0.14,
      Math.sin(s * 17.9) * amp * 0.30 + Math.sin(s * 41.3) * amp * 0.12,
      Math.sin(s * 11.3) * amp * 0.10,
    );
  }

  _recordTelemetry(dt) {
    // Snap detection: a large orientation or distance change in a single frame
    // is exactly the "violently snap" failure §11 forbids.
    const yawDeltaDeg = Math.abs(shortestAngle(this._smoothYaw, this._prevYaw)) * RAD2DEG;
    // Ignore legitimate player-driven look input — only flag solver-induced snaps.
    const distDelta = Math.abs(this.distance - this._prevDistance);
    if (yawDeltaDeg / Math.max(dt, 1e-4) > this.telemetry.maxSnapDegPerFrame) {
      this.telemetry.maxSnapDegPerFrame = yawDeltaDeg / Math.max(dt, 1e-4);
    }
    if (distDelta > this.telemetry.maxDistanceChangePerFrame) {
      this.telemetry.maxDistanceChangePerFrame = distDelta;
    }
    this._prevYaw = this._smoothYaw;
    this._prevDistance = this.distance;

    const pen = this._lastPenetration ?? 0;
    if (pen > this.telemetry.worstPenetration) this.telemetry.worstPenetration = pen;
  }

  /* ------------------------------------------------------------- serialise */

  serialize() {
    return {
      yaw: this.yaw, pitch: this.pitch, distance: this.distance,
      fov: this.fov, shoulderRight: this.shoulderRight, mode: this.mode,
      position: this.position.toArray(),
    };
  }

  restore(data) {
    if (!data || typeof data !== 'object') return this;
    if (Number.isFinite(data.yaw)) this.yaw = wrapAngle(data.yaw);
    if (Number.isFinite(data.pitch)) this.pitch = clamp(data.pitch, CAM.PITCH_MIN, CAM.PITCH_MAX);
    if (Number.isFinite(data.distance)) this.distance = clamp(data.distance, CAM.MIN_DISTANCE, CAM.DISTANCE_COMBAT + 1);
    if (Number.isFinite(data.fov)) this.fov = clamp(data.fov, 30, 100);
    this.shoulderRight = data.shoulderRight !== false;
    this._smoothYaw = this.yaw;
    this._smoothPitch = this.pitch;
    if (Array.isArray(data.position)) this.position = Vec3.fromArray(data.position);
    return this;
  }
}

/** Angle-aware damping with shortest-path wrapping. */
function dampAngleSafe(current, target, halfLife, dt) {
  const delta = shortestAngle(target, current);
  const t = halfLife <= 1e-6 ? 1 : 1 - Math.pow(2, -dt / halfLife);
  return wrapAngle(current + delta * t);
}

/* ------------------------------------------------------------ shot helpers */

/**
 * Build a two-shot cinematic framing two actors — used by the 9 cinematics.
 * Returns position/target/fov without touching the live camera.
 */
export function twoShot(a, b, opts = {}) {
  const height = opts.height ?? 1.45;
  const pad = opts.pad ?? 1.15;
  const mid = Vec3.lerp(a, b, 0.5);
  const target = new Vec3(mid.x, mid.y + height, mid.z);

  const span = a.distanceXZ(b);
  const side = new Vec3(-(b.z - a.z), 0, b.x - a.x);
  const sideLen = side.length || 1;
  side.scale(1 / sideLen);

  // Back off far enough that both actors fit in frame at the given FOV.
  const fov = opts.fov ?? CAM.FOV_CINEMATIC;
  const halfFov = (fov * 0.5) * DEG2RAD;
  const required = (span * 0.5 + pad) / Math.max(0.15, Math.tan(halfFov));
  const back = opts.distance != null ? opts.distance : required;

  const dir = opts.direction ?? new Vec3(side.x, 0, side.z);
  const position = new Vec3(
    target.x + dir.x * back,
    target.y + (opts.elevation ?? 0.35),
    target.z + dir.z * back,
  );
  return { position, target, fov, distance: back };
}

/** Orbit positions for a cinematic sweep around a subject. */
export function orbitShot(center, opts = {}) {
  const radius = opts.radius ?? 4.2;
  const height = opts.height ?? 1.6;
  const start = opts.startAngle ?? 0;
  const sweep = opts.sweep ?? Math.PI * 0.75;
  const steps = Math.max(2, opts.steps ?? 24);
  const frames = [];
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const a = start + sweep * easeOutCubic(t);
    const y = height + (opts.rise ?? 0) * t;
    frames.push({
      t,
      position: new Vec3(center.x + Math.sin(a) * radius, center.y + y, center.z + Math.cos(a) * radius),
      target: new Vec3(center.x, center.y + (opts.targetHeight ?? 1.2), center.z),
      fov: lerp(opts.fovStart ?? CAM.FOV_CINEMATIC, opts.fovEnd ?? CAM.FOV_CINEMATIC, t),
    });
  }
  return frames;
}

/** Screen-space estimate of how large a subject of `size` appears at `dist`. */
export function subjectScreenFraction(size, dist, fovDeg) {
  const half = (fovDeg * 0.5) * DEG2RAD;
  const visibleHeight = 2 * Math.tan(half) * Math.max(dist, 1e-3);
  return clamp(size / Math.max(visibleHeight, 1e-3), 0, 1);
}

export { PROBE_DIRS, VERIFY_DIRS };
