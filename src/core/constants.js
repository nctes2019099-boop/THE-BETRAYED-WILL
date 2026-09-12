// THE BETRAYED WILL — tuning constants
// PURE MODULE. Single source of truth for every gameplay number.
// Rationale: designers tune one file; tests assert against the same values the
// game uses, so a tuning change can never silently diverge from its tests.

/* ---------------------------------------------------------------- movement */
export const MOVE = Object.freeze({
  // Speeds in metres/second. A Babylonian palace courtyard reads at ~4 m walk.
  WALK_SPEED: 2.05,
  RUN_SPEED: 4.15,
  SPRINT_SPEED: 6.35,
  CROUCH_SPEED: 1.25,
  // Chapter 5+: Raynor is weakened. The injury has to cost something real, so
  // injured sprint is held strictly BELOW healthy run (4.15): from Chapter 5 the
  // player can never move as fast as they could jog in Chapter 1, which is what
  // makes escape routes and guard spacing read differently in the last act.
  // 4.6 was faster than a healthy jog and made the injury cosmetic.
  INJURED_RUN_SPEED: 3.05,
  INJURED_SPRINT_SPEED: 3.9,
  // The injury has to be consistent across EVERY band or it reads as a sprint
  // debuff rather than a wounded body: an injured Raynor who still strolls at
  // full healthy walking speed while his run is crippled looks like a bug.
  INJURED_WALK_SPEED: 1.55,
  INJURED_CROUCH_SPEED: 0.95,
  LEDGE_SHIMMY_SPEED: 1.1,

  // Stick deflection at which the walk band hands over to the run band.
  // Below it the player walks (stealth pacing, precise positioning); above it
  // they run. The two bands are mapped so they MEET at WALK_SPEED - see
  // PlayerController._updateLocomotion - so crossing this point is smooth
  // rather than a lurch. 0.55 leaves over half the stick's travel to walking,
  // which is what makes a slow approach on a guard readable on a gamepad.
  RUN_THRESHOLD: 0.55,

  // Stick deflection below which input is ignored, so a worn gamepad or a
  // thumb resting on a stick does not drift the player across a room. The
  // surviving range is RESCALED onto [0,1] rather than used raw: gating at the
  // deadzone and then reading speed straight off the raw deflection gives 0 m/s
  // at 0.08 and 0.30 m/s at 0.09, i.e. the player lurches forward the instant
  // the stick leaves centre — precisely the twitch a deadzone exists to
  // remove. Rescaling keeps the drift rejection and still ramps from a
  // standstill. 0.08 is inside the tolerance of every common pad.
  INPUT_DEADZONE: 0.08,

  // Acceleration/deceleration in m/s². High decel gives the "clean stop" the
  // controller brief demands (no sliding, no ice-skating).
  GROUND_ACCEL: 34,
  GROUND_DECEL: 46,
  AIR_ACCEL: 7,
  AIR_DRAG: 0.35,
  TURN_RATE_GROUND: 15.0,      // rad/s — body rotation toward move direction
  TURN_RATE_AIR: 5.0,
  TURN_RATE_LOCKED: 22.0,      // snappier when locked on to a target

  // Sprint
  SPRINT_ACCEL_BONUS: 1.35,
  SPRINT_STAMINA_DRAIN: 15.5,  // per second
  SPRINT_STAMINA_REGEN: 11.0,
  SPRINT_START_COST: 4.0,
  STAMINA_MAX: 100,
  STAMINA_EXHAUSTED_THRESHOLD: 4,   // below this, sprint locks out
  STAMINA_RECOVER_THRESHOLD: 22,    // must regain this much to sprint again
  STAMINA_REGEN_DELAY: 0.55,        // seconds after sprinting before regen

  // Jump / gravity
  JUMP_VELOCITY: 6.15,
  GRAVITY: 21.5,
  FALL_GRAVITY_SCALE: 1.32,         // heavier falling reads better than floaty
  MAX_FALL_SPEED: 34,
  JUMP_CUT_MULTIPLIER: 0.42,        // releasing jump early shortens the arc
  COYOTE_TIME: 0.13,                // seconds of forgiveness after leaving ground
  JUMP_BUFFER: 0.15,                // seconds a pre-pressed jump is remembered
  LAND_RECOVERY: 0.16,

  // Dodge / roll
  DODGE_SPEED: 9.4,
  DODGE_DURATION: 0.46,
  DODGE_IFRAME_START: 0.07,
  DODGE_IFRAME_END: 0.34,
  DODGE_COOLDOWN: 0.28,
  DODGE_STAMINA_COST: 14,

  // Crouch
  CROUCH_HEIGHT_SCALE: 0.62,
  CROUCH_TRANSITION_TIME: 0.18,

  // Fall damage (§30 backlog item — implemented in traversal.js)
  FALL_DAMAGE_SAFE_HEIGHT: 3.2,     // metres, no damage below this
  FALL_DAMAGE_LETHAL_HEIGHT: 16.5,
  FALL_DAMAGE_PER_METRE: 6.5,
  FALL_LAND_ROLL_HEIGHT: 6.0,       // rolling on landing mitigates above this

  // Ledge grab (§30 backlog item — implemented in traversal.js)
  LEDGE_REACH_UP: 2.35,             // max ledge height above feet
  LEDGE_REACH_DOWN: 0.55,
  LEDGE_PROBE_FORWARD: 0.85,
  LEDGE_CLEARANCE: 0.42,            // body space required in front of the ledge
  LEDGE_CLIMB_TIME: 0.72,
  LEDGE_DROP_TIME: 0.3,
  LEDGE_GRAB_STAMINA_COST: 8,
  LEDGE_HANG_STAMINA_DRAIN: 6.0,
  LEDGE_MAX_HANG: 12.0,

  // Physics
  CAPSULE_RADIUS: 0.34,
  CAPSULE_HEIGHT: 1.78,
  CROUCH_CAPSULE_HEIGHT: 1.12,
  GROUND_SNAP_DISTANCE: 0.28,
  STEP_HEIGHT: 0.45,                // walk up low obstacles without jumping
  SLOPE_LIMIT_DEG: 52,              // steeper than this is not walkable ground
});

/* ------------------------------------------------------------------ camera */
export const CAM = Object.freeze({
  // Third-person over-the-shoulder framing.
  DISTANCE: 3.55,
  MIN_DISTANCE: 0.85,
  DISTANCE_CROUCH: 3.15,
  DISTANCE_COMBAT: 4.25,
  DISTANCE_STEALTH: 3.9,
  DISTANCE_INTERIOR: 2.75,
  HEIGHT_OFFSET: 1.52,              // focus point above the feet
  HEIGHT_OFFSET_CROUCH: 1.05,
  SHOULDER_OFFSET: 0.46,            // right-shoulder bias
  SHOULDER_OFFSET_FLIP: -0.46,      // mirrored when shoulder is swapped
  PITCH_MIN: -1.15,                 // ~-66° — prevents seeing under the floor
  PITCH_MAX: 1.25,                  // ~+72°
  PITCH_DEFAULT: 0.16,

  // Mouse / gamepad look
  SENSITIVITY_X: 0.0026,
  SENSITIVITY_Y: 0.0022,
  GAMEPAD_LOOK_SPEED: 2.55,         // rad/s at full stick deflection
  GAMEPAD_DEADZONE: 0.17,
  GAMEPAD_RESPONSE_EXPONENT: 1.85,  // fine aim near centre
  YAW_SMOOTH_HALF_LIFE: 0.045,
  PITCH_SMOOTH_HALF_LIFE: 0.05,

  // Collision (the "worst penetration = 0 m" requirement, §10)
  COLLISION_RADIUS: 0.32,           // camera probe sphere radius
  COLLISION_PULL_IN: 0.06,          // extra safety margin beyond the hit point
  COLLISION_PUSH_OUT_HALF_LIFE: 0.22,  // slow recovery avoids a violent snap
  COLLISION_SNAP_IN: true,          // instant retraction, gradual recovery
  MAX_PENETRATION_TOLERANCE: 0.0,   // test gate: must be exactly 0
  PROBE_RAYS: 9,                    // sphere-approximated probe pattern
  FLOOR_PROBE: true,                // never let the camera go under geometry
  CEILING_PROBE: true,

  // Framing behaviour
  FOV_DEFAULT: 62,
  FOV_SPRINT: 68,
  FOV_COMBAT: 60,
  FOV_LOCKED: 56,
  FOV_AIM: 48,
  FOV_CINEMATIC: 42,
  FOV_SMOOTH_HALF_LIFE: 0.28,
  POSITION_SMOOTH_HALF_LIFE: 0.075,
  LOOK_TARGET_LEAD: 0.18,           // anticipate player motion slightly
  COMBAT_STRAFE_DISTANCE: 3.1,
  AUTO_CENTER_DELAY: 3.6,           // seconds before the camera re-centres
  AUTO_CENTER_HALF_LIFE: 0.5,
  SHOULDER_SWAP: true,

  // Shake / impact (Stage 4 combat feel, §11 Agent 05)
  SHAKE_DECAY: 6.5,
  SHAKE_MAX: 0.42,
  HIT_SHAKE: 0.11,
  HEAVY_HIT_SHAKE: 0.24,
  DAMAGE_SHAKE: 0.19,
  FALL_SHAKE: 0.3,
  REDUCED_MOTION_SHAKE_SCALE: 0.15, // accessibility (§11 Agent 13)
});

/* ------------------------------------------------------------------ combat */
export const COMBAT = Object.freeze({
  // Timing windows in seconds. These define readability (§27).
  LIGHT_WINDUP: 0.19,
  LIGHT_ACTIVE: 0.11,
  LIGHT_RECOVERY: 0.24,
  HEAVY_WINDUP: 0.42,
  HEAVY_ACTIVE: 0.14,
  HEAVY_RECOVERY: 0.46,
  COMBO_WINDOW: 0.42,               // time after recovery to chain the next hit
  COMBO_MAX_CHAIN: 4,
  COMBO_RESET_TIME: 1.15,

  PARRY_WINDOW: 0.26,               // generous enough to be fair, tight enough to matter
  BLOCK_DAMAGE_REDUCTION: 0.72,
  BLOCK_STAMINA_PER_HIT: 12,
  BLOCK_HEAVY_STAMINA: 26,
  PARRY_STAGGER_TIME: 1.35,
  GUARD_BREAK_TIME: 2.1,

  STAGGER_TIME: 0.62,
  HEAVY_STAGGER_TIME: 1.05,
  KNOCKDOWN_TIME: 2.35,
  GETUP_INVULN: 0.55,

  // Hit feedback (Stage 4 — must be preserved, §11 Agent 05)
  HITSTOP_LIGHT: 0.055,
  HITSTOP_HEAVY: 0.115,
  HITSTOP_PARRY: 0.14,
  HITSTOP_KILL: 0.26,
  RUMBLE_LIGHT: 0.18,
  RUMBLE_HEAVY: 0.42,
  RUMBLE_DAMAGE_TAKEN: 0.55,
  RUMBLE_DURATION: 0.16,
  DAMAGE_NUMBER_LIFETIME: 0.95,
  DAMAGE_NUMBER_RISE: 0.85,
  CRIT_MULTIPLIER: 1.85,
  BACKSTAB_MULTIPLIER: 2.3,

  // Reach
  MELEE_REACH_MIN: 0.9,
  MELEE_REACH_MAX: 2.35,
  MELEE_ARC_DEG: 118,               // horizontal swing cone
  MELEE_VERTICAL_TOLERANCE: 1.15,
  LOCK_ON_RANGE: 16.0,
  LOCK_ON_ANGLE_DEG: 58,
  LOCK_ON_SWITCH_COOLDOWN: 0.22,
  LOCK_ON_BREAK_RANGE: 22.0,

  // Finisher / execution
  FINISHER_HEALTH_THRESHOLD: 0.16,  // enemy below 16% HP is executable
  FINISHER_RANGE: 1.85,
  FINISHER_ANGLE_DEG: 78,
  FINISHER_DURATION: 2.6,
  FINISHER_INVULN: true,
  FINISHER_CAMERA_DISTANCE: 2.05,
  FINISHER_CAMERA_HEIGHT: 1.35,

  // Base melee damage, and the stamina each commitment costs.
  //
  // COMBAT declared every timing window, every reach, and both damage
  // MULTIPLIERS - but no base damage for them to multiply, and no enemy health
  // to apply it to. Numbers are set against PLAYER_MAX_HEALTH (100) and
  // ENEMY_MAX_HEALTH so the intended pacing is explicit rather than emergent:
  //   - a guard dies to a committed four-hit light combo plus one heavy
  //     (9*4 + 22 = 58 of 60), so a fight is two or three exchanges, not a
  //     war of attrition;
  //   - the player survives roughly four to nine clean enemy hits, and about
  //     three times that while blocking (BLOCK_DAMAGE_REDUCTION 0.72), which is
  //     what makes guarding worth the stamina it costs;
  //   - a heavy costs 18 stamina of 100, so five heavies exhaust a player who
  //     never blocks. Attacking and guarding draw from one pool on purpose:
  //     that shared budget is the actual decision space of the melee.
  LIGHT_DAMAGE: 9,
  HEAVY_DAMAGE: 22,
  ENEMY_LIGHT_DAMAGE: 11,
  ENEMY_HEAVY_DAMAGE: 24,
  ENEMY_MAX_HEALTH: 60,
  ATTACK_STAMINA_LIGHT: 8,
  ATTACK_STAMINA_HEAVY: 18,

  // A guard only covers what you are facing. Full cone, so +/-57.5 deg: wide
  // enough that a block does not demand frame-perfect facing, narrow enough
  // that circling an opponent who has committed to a shield is a real tactic.
  BLOCK_ARC_DEG: 115,
  // The defender must be facing this far AWAY from the blow for it to count as
  // a backstab. 100 deg sits just past perpendicular, so a glancing side hit is
  // not rewarded with BACKSTAB_MULTIPLIER - only genuinely getting behind someone.
  BACKSTAB_ANGLE_DEG: 100,

  // Injured Raynor hits softer from Chapter 5 (S7). The injury already costs
  // movement speed in every band; if it cost nothing in combat it would be a
  // cosmetic flag. 0.72 matches the ratio used for INJURED_RUN_SPEED
  // (3.05 / 4.15 = 0.735), so one consistent idea - "about three quarters as
  // effective" - runs through both systems.
  INJURED_DAMAGE_SCALE: 0.72,

  // Damage
  PLAYER_MAX_HEALTH: 100,
  PLAYER_START_HEALTH_CH5: 40,      // §7 Chapter 5: Raynor begins injured
  REGEN_DELAY: 7.0,
  REGEN_RATE: 1.6,
  IFRAME_AFTER_DAMAGE: 0.18,
});

/* --------------------------------------------------------------- stealth */
export const STEALTH = Object.freeze({
  // Visibility model. Exposure is 0 (invisible) .. 1 (fully lit, in plain sight).
  DETECT_TIME_DAY: 1.05,            // seconds of full exposure to be spotted
  DETECT_TIME_NIGHT: 2.35,
  DETECT_RANGE_MAX: 26,
  DETECT_RANGE_MIN: 3.2,
  VIEW_CONE_DEG: 118,
  PERIPHERAL_CONE_DEG: 172,         // weaker awareness outside the main cone
  PERIPHERAL_MULTIPLIER: 0.34,
  VERTICAL_TOLERANCE: 1.6,

  // Light contribution
  LIGHT_EXPOSURE_DAY: 0.82,
  LIGHT_EXPOSURE_NIGHT: 0.28,
  LIGHT_EXPOSURE_TORCH: 0.66,
  SHADOW_EXPOSURE_SCALE: 0.34,
  CROUCH_EXPOSURE_SCALE: 0.58,
  PRONE_EXPOSURE_SCALE: 0.32,
  MOVEMENT_EXPOSURE_SCALE: 1.22,    // moving makes you more visible
  WEATHER_EXPOSURE: { clear: 1.0, overcast: 0.9, dust: 0.62, rain: 0.72, storm: 0.5 },

  // Noise model — radius in metres at which the sound is audible.
  NOISE_SILENT: 0,
  NOISE_CROUCH_WALK: 2.4,
  NOISE_WALK: 5.2,
  NOISE_RUN: 11.5,
  NOISE_SPRINT: 17.5,
  NOISE_LAND_LIGHT: 4.0,
  NOISE_LAND_HEAVY: 13.0,
  NOISE_COMBAT_HIT: 22.0,
  NOISE_BODY_FALL: 9.5,
  NOISE_TAKEDOWN: 6.5,
  NOISE_GLASS_BREAK: 26.0,
  NOISE_SHOUT: 34.0,
  NOISE_BOW_SHOT: 8.0,
  NOISE_DECAY_EXPONENT: 1.6,        // how fast loudness falls off with distance
  AMBIENT_MASK_CLEAR: 1.0,
  AMBIENT_MASK_RAIN: 0.72,          // rain masks footsteps — a real stealth tool
  AMBIENT_MASK_STORM: 0.52,

  // Suspicion state machine
  SUSPICION_MAX: 100,
  SUSPICION_DECAY_PER_SEC: 7.5,
  SUSPICION_DECAY_DELAY: 2.6,
  SUSPICION_ALERT_THRESHOLD: 42,    // becomes "alerted", investigates
  SUSPICION_SEARCH_THRESHOLD: 68,   // actively searches the last-known position
  SUSPICION_COMBAT_THRESHOLD: 92,   // fully hostile
  SUSPICION_NOISE_GAIN: 0.62,       // per second while hearing an unexplained noise
  SUSPICION_GLIMPSE_GAIN: 24,
  SUSPICION_CORPSE_GAIN: 78,        // discovering a body is a huge escalation
  INVESTIGATE_SEARCH_TIME: 14,
  SEARCH_RADIUS: 7.5,
  MEMORY_DURATION: 26,              // how long an AI remembers last-known position
  ALARM_PROPAGATION_RADIUS: 34,
  ALARM_DURATION: 40,

  // Takedown
  TAKEDOWN_RANGE: 1.55,
  TAKEDOWN_ANGLE_DEG: 108,          // must approach from behind
  TAKEDOWN_DURATION: 1.15,
  TAKEDOWN_NOISE: 6.5,
  TAKEDOWN_REQUIRES_UNDETECTED: true,
  HIDING_CAPACITY: 2,               // how many can share a hiding spot
});

/* ---------------------------------------------------------------- AI */
export const AI = Object.freeze({
  TICK_INTERVAL: 0.1,               // perception/decision cadence (Agent 15 budget)
  PATH_RECALC_INTERVAL: 0.35,

  // --- pathfinding budgets, set from measurement not guesswork -------------
  // Measured over EVERY spawn/landmark pair in all 20 regions (1574 queries,
  // 1522 resolved), warm, on the reference sandbox:
  //   nodes expanded  p50 = 217   p90 = 1808   p99 = 6387   max = 12675
  //   cost per expansion ~0.68 us   mean query 0.35 ms
  //
  // One budget cannot serve both callers. A guard repathing every 0.35 s shares
  // PERF.AI_BUDGET_MS (2.5 ms) with every other agent in the frame, so its query
  // must cost well under a millisecond; a mission planner routing an escort
  // across a courtyard needs the long tail and runs off the hot path. Two tiers,
  // and the frame-safe one is the DEFAULT so a caller who forgets to opt in gets
  // a deferred repath (visible, handled) rather than a 6.7 ms hitch (silent).
  //
  // TACTICAL: 1500 nodes ~ 1.0 ms, above p50 and near p90 — comfortably covers
  // a guard chasing a player inside a room, hall or courtyard. Exceeding it is
  // NOT "unreachable": the agent keeps its current path and retries next tick.
  PATH_MAX_NODES_TACTICAL: 1500,
  // BEFORE 1.5 ms. Re-measured on a 25,548-walkable-cell grid with a 3.4 m wall
  // across it (a guard routing around an obstacle, the common tactical case):
  //   nodes expanded  p50 = 271     (the node budget was never the binding limit)
  //   warm query      p50 = 0.38 ms  p95 = 1.78 ms  worst = 2.90 ms
  //   COLD first query         = 2.16 ms
  // 1.5 ms therefore failed the FIRST query after a grid was built (2.16 ms) and
  // ~5% of warm ones (p95 1.78 ms). A failure here is `retryable`, so the agent
  // keeps whatever path it has - and an agent with no path steers directly, i.e.
  // perpendicular into the wall, on exactly the frame a level starts and every
  // guard needs a route at once.
  //
  // AFTER 2.0 ms  (CHANGE +33%). verify.mjs 31d holds the invariant that one
  // tactical query must fit STRICTLY inside the whole frame AI budget
  // (PERF.AI_BUDGET_MS = 2.5), and that invariant is correct: a per-query ceiling
  // at or above the frame ceiling means a single query can consume the entire AI
  // budget and starve every other agent in the frame. So the budget rises only to
  // 2.0 - above the measured warm p95 of 1.78 ms, with 0.5 ms left for the rest
  // of the squad - and the cold-start case, which was the actual defect, is fixed
  // at its source by Pathfinder.warm(): it touches the scratch pages at
  // construction so the first real query costs the warm 0.38 ms, not 2.16 ms.
  // AISquad also recovers when a query is refused: a stuck agent sidesteps along
  // the obstacle instead of grinding perpendicular into it.
  // QUALITY IMPACT: guard routing around obstacles went from "fails the first
  // query after a level loads and grinds into the wall forever" to 20/20 route
  // successes, with the frame-budget invariant still held.
  PATH_TIME_BUDGET_MS_TACTICAL: 2.0,
  // LONG RANGE: used for mission blocking, escort routing and cinematic staging,
  // computed on region entry or mission start rather than per frame.
  //
  // Within a single region this tier must be COMPLETE: reporting "unreachable"
  // for a target that is reachable is a correctness bug, not a perf win — it is
  // how an escort stalls in a doorway or a guard gives up on a player it can
  // plainly see. Completeness cannot be expressed as a fixed node count, because
  // the worst case is "explored the whole region", and regions range from 4k to
  // 55k walkable cells. So astar.js sizes this budget from the grid itself and
  // uses PATH_MAX_NODES only as a floor for grids that have not been counted.
  // Measured worst case was 12675 nodes in a 32027-cell region; the scaled
  // bound admits that with room to spare and stays correct if a region grows.
  PATH_MAX_NODES: 16000,
  PATH_MAX_NODES_MARGIN: 64,
  // Safety net, not the primary limit: 60 ms is above the measured worst query
  // (~24 ms cold, 5 ms warm) and this tier runs off the hot path.
  PATH_TIME_BUDGET_MS: 60.0,
  TURN_RATE: 7.5,                   // rad/s
  TURN_RATE_COMBAT: 11.0,
  REACTION_TIME_MIN: 0.18,          // humans are not instant — AI must not cheat (§11)
  REACTION_TIME_MAX: 0.42,
  ACCURACY_SPREAD_DEG: 6.5,
  AIM_DELAY_ON_FIRST_SIGHT: 0.34,
  ATTACK_COOLDOWN: 1.15,
  ATTACK_RANGE: 1.95,
  ATTACK_WINDUP: 0.42,
  GROUP_ATTACK_SLOTS: 2,            // max simultaneous attackers — fairness
  GROUP_SLOT_RELEASE_TIME: 1.6,
  CIRCLE_STRAFE_TIME: 1.9,
  FLANK_MIN_DISTANCE: 4.0,
  FLANK_ANGLE_DEG: 62,
  RETREAT_HEALTH_THRESHOLD: 0.22,
  RETREAT_DISTANCE: 9.0,
  REINFORCEMENT_RADIUS: 30,
  REINFORCEMENT_MAX: 3,
  STUCK_TIME_LIMIT: 1.2,            // re-path if no progress for this long
  STUCK_PROGRESS_THRESHOLD: 0.25,
  SEPARATION_RADIUS: 0.72,
  SEPARATION_WEIGHT: 2.4,
  COHESION_WEIGHT: 0.35,
  LOS_UPDATE_INTERVAL: 0.12,
});

/* ------------------------------------------------------------ projectiles */
export const PROJ = Object.freeze({
  // Real bow system (§31 Phase C). The bow must NOT behave as long-reach melee.
  BOW_DRAW_TIME: 0.72,
  BOW_MIN_CHARGE: 0.18,
  BOW_SPEED_MIN: 16.0,
  BOW_SPEED_MAX: 46.5,
  BOW_GRAVITY: 15.2,                // arrows drop — leading a target matters
  BOW_DRAG: 0.055,
  BOW_DAMAGE_MIN: 16,
  BOW_DAMAGE_MAX: 48,
  BOW_MAX_RANGE: 78,
  BOW_LIFETIME: 4.2,
  BOW_ARM_TIME: 0.06,               // cannot hit the shooter on frame 1
  BOW_PENETRATION: 1,
  BOW_STICK_TIME: 12,               // arrows remain in surfaces/bodies
  ARROW_SPREAD_DEG_FULL_DRAW: 0.5,
  ARROW_SPREAD_DEG_MIN_DRAW: 5.5,
  AIM_ASSIST_ANGLE_DEG: 3.2,
  SLING_SPEED: 22,
  SLING_GRAVITY: 17.5,
  THROWN_SPEED: 17,
  THROWN_GRAVITY: 19.0,
  SIM_STEP: 1 / 120,                // fixed substep for stable ballistics
  MAX_SUBSTEPS: 8,
  HIT_RADIUS_CHARACTER: 0.42,
});

/* ---------------------------------------------------------------- world */
export const WORLD = Object.freeze({
  // NavGrid resolution. 0.5 m keeps A* cheap across large exteriors while
  // preserving doorways >= 1 m. Interiors use 0.25 m because rasterisation
  // error scales with cell size: at 0.5 m a furnished room loses up to 0.25 m of
  // lane on each side of every obstacle, which is enough to seal a bedroom.
  NAV_CELL_SIZE: 0.5,
  NAV_CELL_SIZE_INTERIOR: 0.25,
  NAV_MAX_SLOPE_DEG: 52,
  NAV_MIN_HEADROOM: 1.9,
  NAV_AGENT_RADIUS: 0.34,
  DAY_LENGTH_SECONDS: 900,          // 15 real minutes = 1 game day
  DAWN_HOUR: 5.4,
  SUNRISE_HOUR: 6.3,
  SUNSET_HOUR: 18.2,
  DUSK_HOUR: 19.1,
  START_HOUR: 7.5,
  INTERIOR_AMBIENT: 0.24,
  TORCH_RADIUS: 7.5,
  TORCH_INTENSITY: 1.35,
  FOG_NEAR: 22,
  FOG_FAR: 190,
  DUST_STORM_FOG_FAR: 58,
});

/* --------------------------------------------------------------- input */
export const INPUT = Object.freeze({
  // Presses queued within one frame before further ones are dropped. A boolean
  // latch would silently swallow the second press of a double-tap dodge; a count
  // does not, and a cap stops a stuck key from queueing forever.
  MAX_EDGE_BUFFER: 4,
  DOUBLE_TAP_DODGE_MS: 260,

  MOUSE_SENSITIVITY_SCALE: 1.0,
  TOUCH_LOOK_SENSITIVITY: 0.0042,
  TOUCH_STICK_DEADZONE: 0.18,
  TOUCH_STICK_RADIUS_PX: 62,
  GAMEPAD_POLL: true,

  /**
   * Default bindings, as data.
   *
   * Physical `code` values, never `e.key`. On an Arabic keyboard layout the
   * characters sitting under WASD are not W/A/S/D, so a game that binds letters
   * becomes unplayable in its own first-class language. Codes are layout-independent.
   *
   * Mouse buttons are encoded as Mouse0/Mouse1/Mouse2 so one binding table covers
   * keyboard and mouse, and so a rebind cannot put a movement key on a button the
   * pointer-lock handler also consumes.
   */
  BINDINGS: Object.freeze({
    moveForward: Object.freeze(['KeyW', 'ArrowUp']),
    moveBack: Object.freeze(['KeyS', 'ArrowDown']),
    moveLeft: Object.freeze(['KeyA', 'ArrowLeft']),
    moveRight: Object.freeze(['KeyD', 'ArrowRight']),
    sprint: Object.freeze(['ShiftLeft']),
    crouch: Object.freeze(['KeyC']),
    jump: Object.freeze(['Space']),
    dodge: Object.freeze(['KeyQ']),
    interact: Object.freeze(['KeyE']),
    attackLight: Object.freeze(['Mouse0']),
    attackHeavy: Object.freeze(['Mouse2']),
    block: Object.freeze(['Mouse1']),
    parry: Object.freeze(['KeyR']),
    // Holding aim draws the bow, and while it is held Mouse0 releases the arrow
    // instead of swinging. Fire therefore has no code of its own: it is what
    // Mouse0 already means, decided by the input layer from whether the bow is up.
    // The action is still listed so a player who wants a dedicated shot key can
    // bind one, and an intentionally unbound default is not treated as corruption
    // when bindings are restored.
    aim: Object.freeze(['KeyV']),
    fire: Object.freeze([]),
    lockOn: Object.freeze(['KeyF']),
    ledge: Object.freeze(['KeyZ']),
    shoulderSwap: Object.freeze(['KeyX']),
    useItem: Object.freeze(['KeyG']),
    cameraReset: Object.freeze(['Mouse3']),
    pause: Object.freeze(['Escape', 'KeyP']),
  }),

  /** Bindings a player may not move, because the UI depends on them absolutely. */
  PROTECTED_BINDINGS: Object.freeze(['pause']),
});

/* ------------------------------------------------------------------ save */
export const SAVE = Object.freeze({
  VERSION: 3,
  KEY_PREFIX: 'betrayed-will:',
  MAX_SLOTS: 6,
  AUTOSAVE_SLOT: 'auto',
  QUICKSAVE_SLOT: 'quick',
  AUTOSAVE_EVENTS: ['chapter-start', 'mission-complete', 'region-enter', 'pre-danger'],
  // Region transitions can fire several times in a few seconds when the player
  // crosses a border back and forth. Without a floor, autosave rewrites the same
  // progress repeatedly and spends the frame budget on storage instead of the game.
  AUTOSAVE_DEBOUNCE_MS: 4000,
  MAX_CORRUPT_RETRIES: 2,
  CHECKSUM_ALGORITHM: 'fnv1a',
});

/* -------------------------------------------------------------- dialogue */
export const DIALOGUE = Object.freeze({
  // A conversation longer than this is a loop, not a scene. The walker stops and
  // reports rather than letting the player spin forever inside one tree.
  MAX_STEPS: 64,
  CHARS_PER_SECOND: 22,     // subtitle pacing, both languages
  MIN_LINE_MS: 900,
  MAX_LINE_MS: 7000,
  CHOICE_ROWS_MAX: 4,       // more than four options is a menu, not a choice
});

/* --------------------------------------------------------------- mission */
export const MISSION = Object.freeze({
  MAX_ACTIVE: 3,
  // Objective evaluation runs on the game thread alongside AI and render, so it
  // gets a ceiling like everything else. It is cheap by construction (a dispatch
  // over active objectives, not a scan of all 52), and run-deep measures it.
  OBJECTIVE_BUDGET_MS: 0.25,
  SOFTLOCK_CHECK_INTERVAL_MS: 5000,
});

/* ------------------------------------------------------------- economy */
export const ECONOMY = Object.freeze({
  CURRENCY: 'shekel',
  CURRENCY_AR: 'شاقل',
  START_FUNDS: 0,
  CH6_START_FUNDS: 6,               // Raynor is poor in the outskirts (§5)
  BREAD_COST: 2,
  BANDAGE_COST: 5,
  OIL_COST: 4,
  BRIBE_COST: 12,
  SELL_MULTIPLIER: 0.45,
  HAGGLE_SKILL_BONUS: 0.18,
  DEBT_AMOUNT: 24,                  // "old debt" side quest
});

/* ------------------------------------------------------------ reputation */
export const REP = Object.freeze({
  MIN: -100,
  MAX: 100,
  BANDS: [
    { min: -100, max: -61, id: 'hunted', en: 'Hunted', ar: 'مُطارَد' },
    { min: -60, max: -21, id: 'feared', en: 'Feared', ar: 'مخيف' },
    { min: -20, max: 19, id: 'unknown', en: 'Unknown', ar: 'مجهول' },
    { min: 20, max: 59, id: 'respected', en: 'Respected', ar: 'محترم' },
    { min: 60, max: 100, id: 'legend', en: 'Legendary', ar: 'أسطورة' },
  ],
});

/* ---------------------------------------------------------- performance */
export const PERF = Object.freeze({
  TARGET_FPS: 60,
  FRAME_BUDGET_MS: 16.67,
  AI_BUDGET_MS: 2.5,
  RENDER_BUDGET_MS: 9.0,
  UI_BUDGET_MS: 1.5,
  MAX_DRAW_CALLS: 420,
  MAX_ACTIVE_NPCS: 64,
  MAX_ACTIVE_PARTICLES: 900,
  MAX_PROJECTILES: 48,
  CULL_DISTANCE: 165,
  LOD_NEAR: 26,
  LOD_FAR: 82,
  WORLD_GEN_BUDGET_MS: 1400,
  BOOT_BUDGET_MS: 2500,
  MEMORY_WARNING_MB: 512,
});

/* ------------------------------------------------------- accessibility */
export const A11Y = Object.freeze({
  SUBTITLE_DEFAULT: true,
  REDUCED_MOTION_DEFAULT: false,
  SCREEN_SHAKE_DEFAULT: true,
  COLORBLIND_MODES: ['off', 'deuteranopia', 'protanopia', 'tritanopia'],
  MIN_FONT_SCALE: 0.85,
  MAX_FONT_SCALE: 1.6,
  HIGH_CONTRAST_DEFAULT: false,
});
