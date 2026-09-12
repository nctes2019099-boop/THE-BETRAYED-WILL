// THE BETRAYED WILL — vertical traversal
// PURE MODULE. §30 backlog items "no fall damage" and "no ledge grab" are
// implemented here as discrete, individually testable functions rather than
// being tangled into the controller (charter C-6: smallest safe change).

import { Vec3, clamp, smoothstep } from '../core/math.js';
import { MOVE, STEALTH } from '../core/constants.js';

/* ------------------------------------------------------------ fall damage */

/**
 * Damage taken for a fall of `height` metres.
 * Below FALL_DAMAGE_SAFE_HEIGHT: none. Above FALL_DAMAGE_LETHAL_HEIGHT: fatal.
 * Between: linear, rounded, and reduced by a landing roll if the player is
 * moving forward and still has stamina — a skill expression, not a tax.
 *
 * @returns {{damage:number, lethal:boolean, mitigated:boolean, severity:string}}
 */
export function computeFallDamage(height, opts = {}) {
  const rolling = opts.rolling === true;
  const stamina = opts.stamina ?? MOVE.STAMINA_MAX;
  const groundedSpeed = opts.groundedSpeed ?? 0;

  const h = Math.max(0, height);
  if (h <= MOVE.FALL_DAMAGE_SAFE_HEIGHT) {
    return { damage: 0, lethal: false, mitigated: false, severity: 'none' };
  }

  // A roll converts a heavy landing into a light one, but only if the player
  // committed to it: forward momentum and enough stamina to execute.
  const canRoll = rolling
    && groundedSpeed >= MOVE.WALK_SPEED * 0.7
    && stamina >= MOVE.DODGE_STAMINA_COST
    && h <= MOVE.FALL_LAND_ROLL_HEIGHT * 2.2;

  const effectiveHeight = canRoll
    ? Math.max(MOVE.FALL_DAMAGE_SAFE_HEIGHT, h - MOVE.FALL_LAND_ROLL_HEIGHT)
    : h;

  if (effectiveHeight <= MOVE.FALL_DAMAGE_SAFE_HEIGHT) {
    return { damage: 0, lethal: false, mitigated: canRoll, severity: 'none' };
  }

  if (effectiveHeight >= MOVE.FALL_DAMAGE_LETHAL_HEIGHT) {
    return { damage: Infinity, lethal: true, mitigated: canRoll, severity: 'lethal' };
  }

  const over = effectiveHeight - MOVE.FALL_DAMAGE_SAFE_HEIGHT;
  const damage = Math.round(over * MOVE.FALL_DAMAGE_PER_METRE);
  const severity = damage >= 60 ? 'severe' : damage >= 25 ? 'heavy' : damage >= 10 ? 'moderate' : 'light';
  return { damage, lethal: false, mitigated: canRoll, severity };
}

/**
 * Landing noise radius in metres — a heavy landing should cost you a stealth
 * approach, and a light one should not. Reads the single source of truth for
 * noise tuning so stealth and traversal can never disagree.
 */
export function landingNoise(height) {
  if (height <= 1.2) return STEALTH.NOISE_SILENT;
  if (height <= MOVE.FALL_DAMAGE_SAFE_HEIGHT) return STEALTH.NOISE_LAND_LIGHT;
  return STEALTH.NOISE_LAND_HEAVY;
}

/* -------------------------------------------------------------- ledge grab */

/**
 * Probe for a grabbable ledge in front of an airborne or grounded agent.
 *
 * A ledge is legal when ALL of the following hold:
 *   1. a solid surface exists between LEDGE_REACH_DOWN and LEDGE_REACH_UP above
 *      the feet, within LEDGE_PROBE_FORWARD metres ahead;
 *   2. there is walkable headroom ABOVE the ledge top (you can pull yourself up);
 *   3. there is clearance for the body in front of the ledge face;
 *   4. the ledge top is not so steep that standing on it would be impossible.
 *
 * @param {object} ctx
 *   { pos:Vec3, facing:Vec3 (normalised, horizontal), collision, radius, height,
 *     grounded:boolean, verticalVelocity:number, stamina:number }
 * @returns {{grabbed:boolean, reason:string, ledge?:{x,y,z,nx,nz,top,standable}}}
 */
export function probeLedge(ctx) {
  const { pos, facing, collision } = ctx;
  const radius = ctx.radius ?? MOVE.CAPSULE_RADIUS;
  const height = ctx.height ?? MOVE.CAPSULE_HEIGHT;

  if (!collision) return { grabbed: false, reason: 'no-collision-world' };
  if (!facing || !Number.isFinite(facing.x) || !Number.isFinite(facing.z)) {
    return { grabbed: false, reason: 'bad-facing' };
  }
  if (ctx.stamina != null && ctx.stamina < MOVE.LEDGE_GRAB_STAMINA_COST) {
    return { grabbed: false, reason: 'no-stamina' };
  }

  const fx = facing.x, fz = facing.z;
  const fl = Math.hypot(fx, fz) || 1;
  const nx = fx / fl, nz = fz / fl;

  // Probe distances: just past the capsule surface, and further out.
  const probes = [radius + 0.12, radius + MOVE.LEDGE_PROBE_FORWARD * 0.55, radius + MOVE.LEDGE_PROBE_FORWARD];

  for (const dist of probes) {
    const px = pos.x + nx * dist;
    const pz = pos.z + nz * dist;

    // 1. Is there a solid face here within reach height?
    const faceSample = sampleColumn(collision, px, pz, pos.y, radius * 0.8, height);
    if (!faceSample.solid) continue;

    const top = faceSample.top;
    const relHeight = top - pos.y;
    if (relHeight < MOVE.LEDGE_REACH_DOWN * -1) continue;
    if (relHeight > MOVE.LEDGE_REACH_UP) continue;
    if (relHeight < -MOVE.LEDGE_REACH_DOWN) continue;

    // 2. Headroom above the ledge top — enough to stand.
    const aboveFree = collision.isSpaceFree(
      new Vec3(px, top + 0.06, pz), radius * 0.92, height * 0.98,
    );
    if (!aboveFree) continue;

    // 3. Body clearance in front of the ledge face at grab height.
    const grabPoint = new Vec3(pos.x + nx * (radius + 0.06), top - 0.08, pos.z + nz * (radius + 0.06));
    const frontFree = collision.isSpaceFree(
      new Vec3(grabPoint.x + nx * MOVE.LEDGE_CLEARANCE, grabPoint.y - height + 0.35, grabPoint.z + nz * MOVE.LEDGE_CLEARANCE),
      radius * 0.9, height * 0.7,
    );
    if (!frontFree) continue;

    // 4. Ground under the mantle target must exist (you cannot climb onto air).
    const mantleX = px + nx * (radius + 0.22);
    const mantleZ = pz + nz * (radius + 0.22);
    const mantleGround = collision.groundAt(mantleX, mantleZ, top + 0.2, MOVE.STEP_HEIGHT);
    const standable = Math.abs(mantleGround.y - top) <= 0.55;
    if (!standable) continue;

    return {
      grabbed: true,
      reason: 'ok',
      ledge: {
        x: grabPoint.x, y: grabPoint.y, z: grabPoint.z,
        nx, nz, top,
        mantle: { x: mantleX, y: top, z: mantleZ },
        heightAboveFeet: relHeight,
        collider: faceSample.collider,
      },
    };
  }

  return { grabbed: false, reason: 'no-ledge' };
}

/** Sample a thin vertical column for the nearest solid face and its top. */
function sampleColumn(collision, x, z, feetY, radius, height) {
  // Ask the collision world for a standable surface near the probe height.
  const ground = collision.groundAt(x, z, feetY + MOVE.LEDGE_REACH_UP + 0.5, MOVE.STEP_HEIGHT);
  const solid = ground.collider != null && ground.collider.blocksMovement;
  return { solid, top: ground.y, collider: ground.collider };
}

/**
 * Animate a mantle (pull-up) over time.
 * Returns the interpolated position for a given elapsed time, following a
 * two-stage arc: rise to the ledge, then forward onto the mantle target.
 */
export function mantlePosition(ledge, startPos, elapsed) {
  const t = clamp(elapsed / MOVE.LEDGE_CLIMB_TIME, 0, 1);
  const riseEnd = 0.55;

  if (t <= riseEnd) {
    const k = smoothstep(t / riseEnd);
    return new Vec3(
      startPos.x + (ledge.x - startPos.x) * k,
      startPos.y + (ledge.top - MOVE.CAPSULE_HEIGHT * 0.62 - startPos.y) * k,
      startPos.z + (ledge.z - startPos.z) * k,
    );
  }
  const k = smoothstep((t - riseEnd) / (1 - riseEnd));
  const from = new Vec3(ledge.x, ledge.top - MOVE.CAPSULE_HEIGHT * 0.62, ledge.z);
  return new Vec3(
    from.x + (ledge.mantle.x - from.x) * k,
    from.y + (ledge.mantle.y - from.y) * k,
    from.z + (ledge.mantle.z - from.z) * k,
  );
}

/**
 * Decide whether an airborne agent should be offered a ledge grab.
 * Deliberately conservative: only while rising slowly or falling, and only when
 * the player is holding toward the surface. Auto-grab on jump would feel sticky.
 */
export function ledgeGrabIsAllowed(state) {
  if (state.state === 'dodge' || state.state === 'finisher') return false;
  if (state.state === 'ledge-hang' || state.state === 'ledge-climb') return false;
  if (state.verticalVelocity > 3.2) return false;          // rising fast — let the jump finish
  if (state.verticalVelocity < -MOVE.MAX_FALL_SPEED * 0.8) return false; // terminal, too late
  return true;
}

/** Stamina drain while hanging, and how long the hang can last. */
export function hangUpdate(hang, dt) {
  const next = { ...hang };
  next.time = (hang.time ?? 0) + dt;
  next.stamina = clamp((hang.stamina ?? 0) - MOVE.LEDGE_HANG_STAMINA_DRAIN * dt, 0, MOVE.STAMINA_MAX);
  next.expired = next.time >= MOVE.LEDGE_MAX_HANG || next.stamina <= 0;
  return next;
}
