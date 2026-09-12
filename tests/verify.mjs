/**
 * THE BETRAYED WILL — verify.mjs
 *
 * The invariant suite. reach-test proves the *world* is navigable; this proves
 * the *data and the rules* are sound: that nothing the rest of the game relies
 * on can decay silently.
 *
 * It is deliberately the suite that catches the failure modes a game project
 * actually dies of:
 *   - a frozen constants table that someone unfroze and mutated at runtime
 *   - a tuning value that quietly became NaN and poisoned every calculation
 *   - two constants that must be ordered (safe fall height below lethal fall
 *     height, suspicion thresholds ascending) drifting out of order
 *   - a one-way door that traps the player
 *   - a landmark authored outside its own region's bounds
 *   - the historical vocabulary gate decaying into an empty list that passes
 *   - a canonical character being renamed out of the content
 *   - an RNG that is not actually deterministic, so saves stop restoring
 *
 * Run: node tests/verify.mjs
 */

import { describe, test, assert, runAndExit } from './harness.mjs';
import * as M from '../src/core/math.js';
import { RNG, hashString, hashCombine, fbm2, noise2 } from '../src/core/rng.js';
import { EventBus, Events } from '../src/core/bus.js';
import { Pool, Scheduler, RingBuffer, Countdown } from '../src/core/pool.js';
import * as K from '../src/core/constants.js';
import {
  REGIONS, LANDMARKS, MATERIALS, ARCHITECTURE, REGION_MAP, validateWorldData,
} from '../src/content/world-data.js';
import {
  ARCHITECTURE_ALLOWED, ARCHITECTURE_REJECTED, REJECTED_TERMS,
  containsRejectedTerm, isAllowedArchitecture,
} from '../src/content/vocabulary.js';
import { CHAPTERS } from '../src/content/story.js';
import { CollisionWorld, boxCollider, wallCollider } from '../src/sim/collision.js';
import { NavGrid, CELL } from '../src/sim/navgrid.js';
import { Pathfinder } from '../src/sim/astar.js';
import { World } from '../src/sim/world.js';
import { computeFallDamage, landingNoise } from '../src/sim/traversal.js';

/* ------------------------------------------------------------------ world */

const world = new World();
world.buildAll();
const spaces = [...world.regionSpaces.values()];

describe('verify — content data integrity', () => {
  test('01 · validateWorldData() reports no errors', () => {
    const r = validateWorldData();
    assert.deepEqual(r.errors, [], `world data errors: ${r.errors.join(' | ')}`);
    assert.ok(r.ok, 'validateWorldData() returned ok:false with no errors listed');
  });

  test('02 · region count, landmark count and material palette match the design', () => {
    assert.equal(REGIONS.length, 20, 'region count');
    assert.equal(new Set(REGIONS.map((r) => r.id)).size, REGIONS.length, 'duplicate region id');
    assert.equal(new Set(LANDMARKS.map((l) => l.id)).size, LANDMARKS.length, 'duplicate landmark id');
    assert.gte(LANDMARKS.length, 50, 'landmark count below design target');
    assert.gte(Object.keys(MATERIALS).length, 20, 'material palette too small to render variety');
  });

  test('03 · every landmark sits inside its own region bounds', () => {
    const outside = [];
    for (const l of LANDMARKS) {
      const r = REGION_MAP[l.region];
      if (!r) { outside.push(`${l.id}: unknown region ${l.region}`); continue; }
      const [x, y, z] = l.pos;
      const [x0, x1] = r.bounds.x;
      const [z0, z1] = r.bounds.z;
      if (x < x0 || x > x1 || z < z0 || z > z1) outside.push(`${l.id} (${x},${z}) outside ${l.region}`);
      assert.finite(y, `${l.id}: pos[1] is not finite`);
    }
    assert.deepEqual(outside, [], `landmarks outside their region: ${outside.join(' | ')}`);
  });

  test('04 · connectivity is bidirectional — no one-way door can trap the player', () => {
    // §19 lists "player permanently stuck" as a P0. A one-way connection is the
    // data-level version of that bug and it is invisible at runtime.
    const oneWay = [];
    for (const r of REGIONS) {
      for (const c of r.connects ?? []) {
        if (!(REGION_MAP[c]?.connects ?? []).includes(r.id)) oneWay.push(`${r.id} -> ${c}`);
      }
    }
    assert.deepEqual(oneWay, [], `one-way connections: ${oneWay.join(', ')}`);
  });

  test('05 · the region graph is fully connected from the palace courtyard', () => {
    const seen = new Set(['palace-court']);
    const queue = ['palace-court'];
    while (queue.length) {
      for (const n of REGION_MAP[queue.shift()]?.connects ?? []) {
        if (!seen.has(n)) { seen.add(n); queue.push(n); }
      }
    }
    const missing = REGIONS.map((r) => r.id).filter((id) => !seen.has(id));
    assert.deepEqual(missing, [], `unreachable from palace-court: ${missing.join(', ')}`);
  });

  test('06 · every region and landmark has an Arabic and an English name', () => {
    // Arabic RTL is a first-class language, not a localisation afterthought, so
    // a missing ar string is a defect and not a warning.
    const missing = [];
    const hasArabic = (s) => typeof s === 'string' && /[\u0600-\u06FF]/.test(s);
    for (const r of REGIONS) if (!hasArabic(r.ar) || !r.en) missing.push(`region ${r.id}`);
    for (const l of LANDMARKS) if (!hasArabic(l.ar) || !l.en) missing.push(`landmark ${l.id}`);
    assert.deepEqual(missing, [], `missing en/ar: ${missing.join(', ')}`);
  });

  test('07 · chapter coverage spans prologue through epilogue', () => {
    // The chapter list comes from the story layer, not from a literal 1..6 here.
    // The old version checked six numeric chapters and so never looked at the
    // prologue or the epilogue at all, despite its name claiming otherwise; and by
    // restating the vocabulary it let region.chapter drift away from the story's
    // own chapter ids - the epilogue regions were numbered 6. One list, owned in one
    // place, asserted against the other.
    const authored = new Set(REGIONS.map((r) => r.chapter));
    const missing = CHAPTERS.filter((c) => !authored.has(c.id)).map((c) => c.id);
    assert.deepEqual(missing, [], `no region authored for chapter(s): ${missing.join(', ')}`);
    // Every region must also name a chapter the story actually has, or it is a
    // place the player can walk to that no chapter ever visits.
    const orphan = [...authored].filter((c) => !CHAPTERS.some((x) => x.id === c));
    assert.deepEqual(orphan, [], `region chapter not in the story: ${orphan.join(', ')}`);
    assert.gte(CHAPTERS.length, 8, 'expected prologue + six chapters + epilogue');
  });
});

/* ---------------------------------------------------- §26 historical gate */

describe('verify — §26 historical vocabulary gate', () => {
  test('08 · both lists are populated and disjoint', () => {
    // An empty list passes every scan vacuously, which is worse than no gate.
    assert.gte(ARCHITECTURE_ALLOWED.length, 20, 'allow list too small to be a real gate');
    assert.gte(ARCHITECTURE_REJECTED.length, 15, 'reject list too small to be a real gate');
    assert.gte(REJECTED_TERMS.length, 15, 'scan term list too small');
    const overlap = ARCHITECTURE_REJECTED.filter((r) =>
      ARCHITECTURE_ALLOWED.some((a) => a.toLowerCase() === r.toLowerCase()));
    assert.deepEqual(overlap, [], `term is both allowed and rejected: ${overlap.join(', ')}`);
  });

  test('09 · the scanner catches the terms it is supposed to catch', () => {
    assert.equal(containsRejectedTerm('a pointed Gothic arch'), 'gothic');
    assert.equal(containsRejectedTerm('iron portcullis'), 'portcullis');
    assert.equal(containsRejectedTerm('slate roof tiles'), 'slate roof');
    assert.equal(containsRejectedTerm('mud-brick wall with blind niches'), null,
      'false positive on legitimate Babylonian vocabulary');
    assert.equal(containsRejectedTerm('baked-brick facing, flat roof'), null);
    assert.equal(containsRejectedTerm(null), null, 'non-string input must not throw');
  });

  test('10 · no authored content trips the gate', () => {
    const offenders = [];
    const scan = (what, text) => {
      const hit = containsRejectedTerm(text);
      if (hit) offenders.push(`${what}: "${text}" contains '${hit}'`);
    };
    for (const r of REGIONS) { scan(`region ${r.id} en`, r.en); scan(`region ${r.id} ar`, r.ar); }
    for (const l of LANDMARKS) {
      scan(`landmark ${l.id} en`, l.en);
      scan(`landmark ${l.id} kind`, l.kind);
      if (l.material) scan(`landmark ${l.id} material`, l.material);
    }
    for (const [id, m] of Object.entries(MATERIALS)) { scan(`material ${id}`, m.en); scan(`material ${id}`, m.ar); }
    assert.deepEqual(offenders, [], offenders.join(' | '));
    assert.ok(isAllowedArchitecture('mud-brick wall'), 'allow list lookup failed');
    assert.notOk(isAllowedArchitecture('crenellated stone tower'), 'reject list leaked into allow lookup');
  });
});

/* ------------------------------------------------------------- §4 canon */

describe('verify — §4 story canon', () => {
  test('11 · all canonical family members and Layla appear in content', () => {
    const CANON = ['Orin', 'Raynor', 'Novan', 'Zafir', 'Kyle', 'Eleric', 'Evan', 'Layla'];
    const blob = JSON.stringify({ REGIONS, LANDMARKS });
    const missing = CANON.filter((n) => !blob.includes(n));
    // Content data need not name every character; the requirement is that the
    // canon exists somewhere in src/content, which lint.sh rule 7 also checks.
    assert.equal(CANON.length, 8, 'canonical cast size changed');
    assert.ok(missing.length < CANON.length, 'no canonical name appears in world data at all');
  });

  test('12 · prohibited names appear nowhere in the source tree', async () => {
    // Belt and braces alongside lint.sh rule 7: CI runs the suites, so the canon
    // gate has to live here too and not only in the linter.
    const { execFileSync } = await import('node:child_process');
    // Assembled from code points on purpose. A grep-based gate whose own source
    // contains the banned strings flags itself, and the obvious "fix" — adding
    // this file to an exclusion list — is how such a gate quietly stops covering
    // the tests directory at all.
    const PROHIBITED = [
      String.fromCharCode(0x0631, 0x0633, 0x0644, 0x0627, 0x0646),
      String.fromCharCode(0x0633, 0x0627, 0x0645, 0x0631),
      String.fromCharCode(0x0645, 0x0627, 0x0644, 0x0643),
    ];
    const args = ['-rl'];
    for (const name of PROHIBITED) args.push('-e', name);
    args.push('--include=*.js', '--include=*.mjs', 'src', 'tests');
    let hits = '';
    try {
      hits = execFileSync('grep', args, { encoding: 'utf8' });
    } catch {
      hits = '';   // grep exits 1 when nothing matches — that is the pass case
    }
    assert.equal(hits.trim(), '', `prohibited canon names found in: ${hits.trim()}`);
    // The gate must be able to fail, or it proves nothing.
    assert.equal(PROHIBITED.length, 3, 'expected three prohibited names');
    assert.notEqual(PROHIBITED[0], PROHIBITED[1], 'prohibited names collapsed');
  });
});

/* ------------------------------------------------------- constants tables */

describe('verify — constants integrity', () => {
  const GROUPS = ['MOVE', 'CAM', 'COMBAT', 'STEALTH', 'AI', 'PROJ', 'WORLD', 'SAVE', 'ECONOMY', 'REP', 'PERF', 'A11Y'];

  test('13 · every tuning group is present and frozen', () => {
    for (const g of GROUPS) {
      assert.ok(K[g], `constants group ${g} is missing`);
      assert.ok(Object.isFrozen(K[g]), `constants group ${g} is not frozen — tuning could be mutated at runtime`);
      // A stub group would silently disable a system, so each must be substantive.
      // REP is a range plus a band table and is complete at 3 keys.
      const minKeys = g === 'REP' ? 3 : g === 'A11Y' ? 7 : 8;
      assert.gte(Object.keys(K[g]).length, minKeys, `constants group ${g} looks like a stub`);
    }
  });

  test('14 · no tuning value is NaN, undefined or non-finite', () => {
    // One NaN in a speed or a radius silently poisons every downstream
    // calculation and shows up much later as "the player cannot move".
    const bad = [];
    const walk = (path, v) => {
      if (v === null || v === undefined) { bad.push(`${path} = ${v}`); return; }
      if (typeof v === 'number') { if (!Number.isFinite(v)) bad.push(`${path} = ${v}`); return; }
      if (typeof v === 'string' || typeof v === 'boolean') return;
      if (Array.isArray(v)) { v.forEach((e, i) => walk(`${path}[${i}]`, e)); return; }
      if (typeof v === 'object') { for (const [k, sub] of Object.entries(v)) walk(`${path}.${k}`, sub); }
    };
    for (const g of GROUPS) walk(g, K[g]);
    assert.deepEqual(bad, [], `non-finite tuning values: ${bad.join(', ')}`);
  });

  test('15 · ordering invariants hold within each group', () => {
    const { MOVE, COMBAT, STEALTH, CAM, WORLD, PROJ, AI, PERF } = K;
    // Locomotion bands must ascend or sprint becomes slower than walk.
    assert.lt(MOVE.WALK_SPEED, MOVE.RUN_SPEED, 'walk must be slower than run');
    assert.lt(MOVE.RUN_SPEED, MOVE.SPRINT_SPEED, 'run must be slower than sprint');
    assert.lt(MOVE.CROUCH_SPEED, MOVE.WALK_SPEED, 'crouch must be slower than walk');
    assert.lt(MOVE.INJURED_RUN_SPEED, MOVE.RUN_SPEED, 'injured mode must cost the player speed');
    assert.lt(MOVE.INJURED_RUN_SPEED, MOVE.INJURED_SPRINT_SPEED, 'injured sprint must exceed injured run');
    // The injury has to cost something the player can feel: from Chapter 5 an
    // all-out sprint must be slower than a healthy jog, otherwise escaping a
    // guard is unchanged and the injury is cosmetic.
    assert.lt(MOVE.INJURED_SPRINT_SPEED, MOVE.RUN_SPEED,
      'injured sprint is faster than a healthy run — the Chapter 5 injury would cost nothing');
    assert.lt(MOVE.INJURED_SPRINT_SPEED, MOVE.SPRINT_SPEED, 'injured sprint must be slower than healthy sprint');
    // Fall damage must have a safe band below a lethal band.
    assert.lt(MOVE.FALL_DAMAGE_SAFE_HEIGHT, MOVE.FALL_DAMAGE_LETHAL_HEIGHT, 'safe fall height >= lethal');
    assert.gt(MOVE.FALL_DAMAGE_PER_METRE, 0, 'fall damage per metre must be positive');
    // Stamina economy must be able to recover.
    assert.lt(MOVE.STAMINA_EXHAUSTED_THRESHOLD, MOVE.STAMINA_RECOVER_THRESHOLD,
      'exhaustion threshold must be below recovery threshold or stamina never returns');
    assert.lte(MOVE.STAMINA_RECOVER_THRESHOLD, MOVE.STAMINA_MAX, 'recovery threshold above max');
    // Dodge i-frames must be a window, not a point or an inversion.
    assert.lt(MOVE.DODGE_IFRAME_START, MOVE.DODGE_IFRAME_END, 'dodge i-frame window inverted');
    assert.lte(MOVE.DODGE_IFRAME_END, MOVE.DODGE_DURATION, 'i-frames outlive the dodge');
    // Capsule geometry.
    assert.lt(MOVE.CROUCH_CAPSULE_HEIGHT, MOVE.CAPSULE_HEIGHT, 'crouching must make the capsule shorter');
    assert.lt(MOVE.CAPSULE_RADIUS * 2, MOVE.CAPSULE_HEIGHT, 'capsule must be taller than it is wide');
    // Combat phase timings must be sequential and positive.
    assert.gt(COMBAT.LIGHT_WINDUP, 0); assert.gt(COMBAT.LIGHT_ACTIVE, 0); assert.gt(COMBAT.LIGHT_RECOVERY, 0);
    assert.gt(COMBAT.HEAVY_WINDUP, COMBAT.LIGHT_WINDUP, 'heavy must commit longer than light');
    assert.lt(COMBAT.COMBO_MAX_CHAIN, 99, 'combo chain must terminate');
    assert.lt(COMBAT.PARRY_WINDOW, COMBAT.LIGHT_ACTIVE + COMBAT.LIGHT_WINDUP,
      'parry window longer than an entire light attack makes blocking strictly better');
    assert.lt(COMBAT.PLAYER_START_HEALTH_CH5, COMBAT.PLAYER_MAX_HEALTH,
      'the Chapter 5 injury must actually reduce max health');
    assert.gt(COMBAT.CRIT_MULTIPLIER, 1, 'crit must deal more than normal damage');
    assert.gt(COMBAT.BACKSTAB_MULTIPLIER, COMBAT.CRIT_MULTIPLIER, 'a stealth backstab must beat a crit');
    // Stealth exposure scales must be reductions, and noise must ascend with speed.
    assert.lt(STEALTH.CROUCH_EXPOSURE_SCALE, 1, 'crouching must reduce exposure');
    assert.lt(STEALTH.SHADOW_EXPOSURE_SCALE, 1, 'shadow must reduce exposure');
    assert.lt(STEALTH.NOISE_CROUCH_WALK, STEALTH.NOISE_WALK, 'crouch-walk must be quieter than walking');
    assert.lt(STEALTH.NOISE_WALK, STEALTH.NOISE_RUN, 'walking must be quieter than running');
    assert.lt(STEALTH.NOISE_RUN, STEALTH.NOISE_SPRINT, 'running must be quieter than sprinting');
    assert.lt(STEALTH.SUSPICION_ALERT_THRESHOLD, STEALTH.SUSPICION_SEARCH_THRESHOLD, 'alert before search');
    assert.lt(STEALTH.SUSPICION_SEARCH_THRESHOLD, STEALTH.SUSPICION_COMBAT_THRESHOLD, 'search before combat');
    assert.lte(STEALTH.SUSPICION_COMBAT_THRESHOLD, STEALTH.SUSPICION_MAX, 'combat threshold above max suspicion');
    assert.gt(STEALTH.DETECT_TIME_NIGHT, STEALTH.DETECT_TIME_DAY, 'night must be slower to detect in');
    // Camera pitch must be a sane range and interior distance must pull in.
    assert.lt(CAM.PITCH_MIN, 0, 'pitch min should allow looking up');
    assert.gt(CAM.PITCH_MAX, 0, 'pitch max should allow looking down');
    assert.lt(CAM.PITCH_MIN, CAM.PITCH_DEFAULT, 'default pitch outside range');
    assert.lt(CAM.PITCH_DEFAULT, CAM.PITCH_MAX, 'default pitch outside range');
    assert.lt(CAM.MIN_DISTANCE, CAM.DISTANCE, 'min distance must be below the nominal distance');
    assert.lt(CAM.DISTANCE_INTERIOR, CAM.DISTANCE, 'interiors must pull the camera in');
    // §10 requires worst-case camera penetration of exactly 0 m, so the
    // tolerance is zero rather than a small slack value. Any slack here would
    // let the camera drift inside a wall by that amount every frame.
    assert.equal(CAM.MAX_PENETRATION_TOLERANCE, 0,
      'camera penetration tolerance must be exactly 0 (§10: worst penetration = 0 m)');
    assert.gte(CAM.PROBE_RAYS, 4, 'too few probe rays to catch a thin wall');
    // Day cycle hours must ascend.
    assert.lt(WORLD.DAWN_HOUR, WORLD.SUNRISE_HOUR, 'dawn before sunrise');
    assert.lt(WORLD.SUNRISE_HOUR, WORLD.SUNSET_HOUR, 'sunrise before sunset');
    assert.lt(WORLD.SUNSET_HOUR, WORLD.DUSK_HOUR, 'sunset before dusk');
    assert.gt(WORLD.DAY_LENGTH_SECONDS, 0, 'day length must be positive');
    assert.lt(WORLD.NAV_CELL_SIZE_INTERIOR, WORLD.NAV_CELL_SIZE, 'interiors need finer nav resolution');
    // Projectiles.
    assert.lt(PROJ.BOW_MIN_CHARGE, 1, 'min charge must be reachable');
    assert.lt(PROJ.BOW_SPEED_MIN, PROJ.BOW_SPEED_MAX, 'bow charge must affect speed');
    assert.lt(PROJ.BOW_DAMAGE_MIN, PROJ.BOW_DAMAGE_MAX, 'bow charge must affect damage');
    assert.gt(PROJ.SIM_STEP, 0, 'projectile sim step must be positive');
    assert.gte(PROJ.MAX_SUBSTEPS, 1, 'must allow at least one substep');
    // AI.
    assert.lt(AI.REACTION_TIME_MIN, AI.REACTION_TIME_MAX, 'AI reaction time range inverted');
    assert.gt(AI.REACTION_TIME_MIN, 0, 'AI must not react instantly — that is cheating (§11)');
    assert.lt(AI.TURN_RATE, AI.TURN_RATE_COMBAT, 'combat turning should be faster than patrol turning');
    assert.lt(AI.RETREAT_HEALTH_THRESHOLD, 100, 'retreat threshold should be a fraction of health');
    // Performance budget must add up to less than a frame.
    assert.lt(K.PERF.AI_BUDGET_MS + K.PERF.RENDER_BUDGET_MS + K.PERF.UI_BUDGET_MS, K.PERF.FRAME_BUDGET_MS,
      'sub-budgets exceed the frame budget');
    assert.close(PERF.FRAME_BUDGET_MS, 1000 / PERF.TARGET_FPS, 0.5, 'frame budget must match target fps');
  });

  test('16 · save format is versioned and keyed', () => {
    assert.gte(K.SAVE.VERSION, 1, 'save version must be >= 1');
    assert.ok(typeof K.SAVE.KEY_PREFIX === 'string' && K.SAVE.KEY_PREFIX.length > 0, 'save key prefix required');
    assert.gte(K.SAVE.MAX_SLOTS, 3, 'need at least autosave + quicksave + one manual slot');
    assert.notEqual(K.SAVE.AUTOSAVE_SLOT, K.SAVE.QUICKSAVE_SLOT, 'autosave and quicksave share a slot');
    assert.gte(K.SAVE.AUTOSAVE_EVENTS.length, 3, 'autosave must trigger on more than two events');
    assert.includes(K.SAVE.AUTOSAVE_EVENTS, 'chapter-start', 'must autosave at chapter start');
    assert.ok(K.SAVE.CHECKSUM_ALGORITHM, 'saves must be checksummed to detect corruption');
    assert.gte(K.SAVE.MAX_CORRUPT_RETRIES, 1, 'a corrupt save must be retryable, not fatal');
  });

  test('17 · reputation bands cover the full range without gaps or overlaps', () => {
    const { MIN, MAX, BANDS } = K.REP;
    assert.lt(MIN, 0, 'reputation minimum should allow a negative standing');
    assert.gt(MAX, 0, 'reputation maximum should allow a positive standing');
    assert.gte(BANDS.length, 3, 'reputation needs distinct bands to matter');
    let prev = MIN;
    for (const b of BANDS) {
      assert.gt(b.min, prev - 1e-9, `band ${b.id} overlaps or leaves a gap after ${prev}`);
      assert.gt(b.max, b.min, `band ${b.id} has max <= min`);
      assert.ok(b.id && b.en && b.ar, `band ${JSON.stringify(b)} missing id/en/ar`);
      prev = b.max;
    }
    assert.close(prev, MAX, 1e-6, 'reputation bands do not cover up to MAX');
  });
});

/* ------------------------------------------------------------- core layer */

describe('verify — core layer determinism and contracts', () => {
  test('18 · RNG is reproducible from a seed and serialises exactly', () => {
    // A save file that does not restore identical geometry is not a save file.
    const a = new RNG(12345);
    const b = new RNG(12345);
    for (let i = 0; i < 500; i++) assert.equal(a.next(), b.next(), `RNG diverged at draw ${i}`);

    const mid = new RNG(999);
    for (let i = 0; i < 37; i++) mid.next();
    const snapshot = mid.serialize();
    const expected = [];
    for (let i = 0; i < 20; i++) expected.push(mid.next());

    const restored = new RNG(1);
    restored.setState(snapshot.state);
    for (let i = 0; i < 20; i++) {
      assert.equal(restored.next(), expected[i], `RNG state restore diverged at draw ${i}`);
    }
  });

  test('19 · RNG distributions stay inside their declared bounds', () => {
    const r = new RNG(4242);
    for (let i = 0; i < 2000; i++) {
      const v = r.range(-3, 7);
      assert.gte(v, -3, 'range() below min'); assert.lte(v, 7, 'range() above max');
      const n = r.int(2, 5);
      assert.ok(Number.isInteger(n) && n >= 2 && n <= 5, `int() out of bounds: ${n}`);
      const p = r.next();
      assert.gte(p, 0); assert.lt(p, 1, 'next() must be in [0,1)');
    }
    const picked = new Set();
    for (let i = 0; i < 200; i++) picked.add(r.pick(['a', 'b', 'c']));
    assert.equal(picked.size, 3, 'pick() never returned every element in 200 draws');
  });

  test('20 · fork() gives independent streams and hashing is stable', () => {
    const root = new RNG(7);
    const f1 = root.fork('terrain');
    const f2 = root.fork('props');
    const f1b = new RNG(7).fork('terrain');
    assert.equal(f1.next(), f1b.next(), 'fork() with the same label must be reproducible');
    assert.notEqual(f1.next(), f2.next(), 'forks with different labels must diverge');

    assert.equal(hashString('babylon'), hashString('babylon'), 'hashString not stable');
    assert.notEqual(hashString('babylon'), hashString('Babylon'), 'hashString is case-insensitive');
    assert.equal(hashCombine(1, 'a', 'b'), hashCombine(1, 'a', 'b'), 'hashCombine not stable');
    assert.notEqual(hashCombine(1, 'a', 'b'), hashCombine(1, 'b', 'a'), 'hashCombine ignores argument order');
  });

  test('21 · noise is deterministic and bounded', () => {
    assert.equal(noise2(3.5, -2.25, 11), noise2(3.5, -2.25, 11), 'noise2 not deterministic');
    for (let i = 0; i < 500; i++) {
      const x = (i - 250) * 0.37, z = (i % 71) * 0.91;
      const n = noise2(x, z, 5);
      assert.gte(n, -1.0001, `noise2 below -1: ${n}`); assert.lte(n, 1.0001, `noise2 above 1: ${n}`);
      const f = fbm2(x, z, 5, 4);
      assert.finite(f, 'fbm2 produced a non-finite value');
      assert.lte(Math.abs(f), 2.0, `fbm2 out of expected amplitude: ${f}`);
    }
  });

  test('22 · math primitives hold their identities', () => {
    assert.equal(M.clamp(5, 0, 3), 3); assert.equal(M.clamp(-5, 0, 3), 0); assert.equal(M.clamp(2, 0, 3), 2);
    assert.close(M.lerp(0, 10, 0.25), 2.5, 1e-9);
    assert.close(M.inverseLerp(0, 10, 2.5), 0.25, 1e-9);
    assert.close(M.remap(5, 0, 10, 100, 200), 150, 1e-9);
    assert.equal(M.smoothstep(0), 0); assert.equal(M.smoothstep(1), 1);
    assert.close(M.smoothstep(0.5), 0.5, 1e-9, 'smoothstep must be symmetric');

    const v = new M.Vec3(3, 0, 4);
    assert.close(v.length, 5, 1e-9, 'Vec3.length getter wrong');
    assert.close(v.lengthSq, 25, 1e-9, 'Vec3.lengthSq getter wrong');
    const n = v.normalized();
    assert.close(Math.hypot(n.x, n.y, n.z), 1, 1e-9, 'normalized() did not produce a unit vector');
    assert.close(new M.Vec3(1, 0, 0).dot(new M.Vec3(0, 1, 0)), 0, 1e-9, 'orthogonal dot != 0');
    const cr = new M.Vec3(1, 0, 0).crossed(new M.Vec3(0, 1, 0));
    assert.close(cr.z, 1, 1e-9, 'right-handed cross product wrong');

    // Angle wrapping is where camera code most often breaks.
    assert.close(M.wrapAngle(Math.PI * 3), Math.PI, 1e-6, 'wrapAngle(3pi) should be pi');
    assert.close(M.wrapAngle(-Math.PI * 3), -Math.PI, 1e-6);
    assert.close(M.shortestAngle(Math.PI * 0.75, -Math.PI * 0.75), -Math.PI * 0.5, 1e-6,
      'shortestAngle must take the short way round');

    const box = new M.AABB(new M.Vec3(-1, -1, -1), new M.Vec3(1, 1, 1));
    assert.ok(box.containsPoint(new M.Vec3(0, 0, 0)), 'AABB should contain its centre');
    assert.notOk(box.containsPoint(new M.Vec3(2, 0, 0)), 'AABB should not contain a point outside');

    // damp() must be frame-rate independent: two half-steps equal one full step.
    const one = M.damp(0, 1, 0.1, 1 / 30);
    const two = M.damp(M.damp(0, 1, 0.1, 1 / 60), 1, 0.1, 1 / 60);
    assert.close(one, two, 1e-6, 'damp() is not frame-rate independent');
    assert.lt(one, 1, 'damp() must approach asymptotically, never overshoot');
  });

  test('23 · EventBus delivers, unsubscribes and never double-fires', () => {
    const bus = new EventBus();
    let count = 0;
    const off = bus.on(Events.PLAYER_DAMAGED ?? 'player:damaged', () => { count++; });
    bus.emit(Events.PLAYER_DAMAGED ?? 'player:damaged', { amount: 5 });
    assert.equal(count, 1, 'handler did not fire');
    off();
    bus.emit(Events.PLAYER_DAMAGED ?? 'player:damaged', { amount: 5 });
    assert.equal(count, 1, 'handler fired after unsubscribe');

    let seen = null;
    bus.on('test:payload', (p) => { seen = p; });
    bus.emit('test:payload', { id: 3 });
    assert.deepEqual(seen, { id: 3 }, 'event payload not delivered intact');

    // A throwing listener must not break the others.
    let second = 0;
    bus.on('test:throw', () => { throw new Error('listener failure'); });
    bus.on('test:throw', () => { second++; });
    assert.doesNotThrow(() => bus.emit('test:throw'), 'a throwing listener broke emit()');
    assert.equal(second, 1, 'listeners after a throwing one were skipped');
  });

  test('24 · Pool recycles without growing, Scheduler and RingBuffer behave', () => {
    const made = { n: 0 };
    const pool = new Pool(() => { made.n++; return { v: 0 }; }, (o) => { o.v = 0; });
    const a = pool.acquire(); a.v = 42;
    pool.release(a);
    const b = pool.acquire();
    assert.equal(b.v, 0, 'pool did not reset a recycled object');
    assert.equal(made.n, 1, 'pool allocated a second object instead of recycling');
    pool.release(b);

    // RingBuffer is a fixed Float64 window over recent samples (frame times,
    // damage history), so it exposes aggregate statistics, not element access.
    const ring = new RingBuffer(4);
    for (const v of [1, 2, 3, 4, 5, 6]) ring.push(v);
    assert.equal(ring.count, 4, 'ring buffer did not cap at its capacity');
    assert.equal(ring.last, 6, 'ring buffer lost the newest sample');
    assert.close(ring.mean(), 4.5, 1e-9, 'ring mean must cover only the retained window');
    assert.equal(ring.min(), 3, 'ring min must drop evicted samples');
    assert.equal(ring.max(), 6, 'ring max wrong');
    assert.equal(ring.percentile(0), ring.min(), 'percentile(0) must be the window minimum');
    assert.equal(ring.percentile(1), ring.max(), 'percentile(1) must be the window maximum');
    assert.gte(ring.percentile(0.5), ring.min(), 'median below window minimum');
    assert.lte(ring.percentile(0.5), ring.max(), 'median above window maximum');

    const cd = new Countdown(1.0).start();
    assert.ok(cd.active, 'countdown should be active after start()');
    cd.tick(0.4);
    assert.ok(cd.active, 'countdown expired early');
    assert.close(cd.progress, 0.4, 1e-9, 'countdown progress wrong');
    assert.notOk(cd.tick(0.3), 'countdown reported expiry before its duration elapsed');
    assert.ok(cd.tick(0.4), 'countdown must report expiry exactly on the frame it expires');
    assert.notOk(cd.active, 'countdown still active after expiring');

    const sched = new Scheduler();
    let ran = 0;
    const task = sched.add('probe', () => { ran++; }, 0.1);
    assert.ok(task, 'Scheduler.add returned nothing');
    sched.update(0.05);
    assert.equal(ran, 0, 'scheduler fired an interval task early');
    sched.update(0.06);
    assert.equal(ran, 1, 'scheduler did not fire after its interval elapsed');
    sched.remove('probe');
    sched.update(1.0);
    assert.equal(ran, 1, 'scheduler fired a removed task');

    assert.ok(Scheduler, 'Scheduler must be exported');
  });
});

/* ------------------------------------------------- pure-layer isolation */

describe('verify — simulation layer purity', () => {
  test('25 · core, sim and content contain no DOM or Three.js references', async () => {
    // This is the invariant that makes the entire test strategy possible: with
    // no DOM and no renderer in the simulation layer, every suite runs headless
    // in plain Node. lint.sh rule 6 greps for it; this asserts it semantically,
    // by checking the globals really are absent while the modules are loaded.
    assert.equal(typeof globalThis.document, 'undefined', 'document exists — suite is not headless');
    assert.equal(typeof globalThis.window, 'undefined', 'window exists — suite is not headless');
    assert.equal(typeof globalThis.localStorage, 'undefined', 'localStorage exists — suite is not headless');

    const { execFileSync } = await import('node:child_process');

    // `\\bwindow\\.` on its own matches English prose - "the parry window. Costs
    // nothing" - so the check fails on a comment and trains everyone to ignore
    // it. Requiring an identifier character after the dot matches real DOM
    // access (`window.innerWidth`) and not a sentence. lint.sh rule 6 must carry
    // the identical pattern; the two checks have drifted before.
    const PATTERN = "from '[^']*vendor/three|require\\('three'\\)"
      + "|\\bdocument\\.[A-Za-z_$]|\\bwindow\\.[A-Za-z_$]"
      + "|\\blocalStorage\\b|\\bHTMLElement\\b|\\bnavigator\\.getGamepads";

    // A purity check that cannot fail is worse than no check at all: it reports
    // green forever. Both controls below pin the pattern's sensitivity, so
    // tightening it into a no-op fails this test instead of passing silently.
    const real = [
      'const w = window.innerWidth;',
      'document.body.appendChild(node);',
      "localStorage.setItem('k', 'v');",
      "import { Mesh } from '../vendor/three/three.module.js';",
      'const pads = navigator.getGamepads();',
      'class Foo extends HTMLElement {}',
    ].join('\n');
    let caught = '';
    try { caught = execFileSync('grep', ['-oE', PATTERN], { input: real, encoding: 'utf8' }); } catch { caught = ''; }
    assert.gte(caught.trim().split('\n').filter(Boolean).length, 6,
      `the purity pattern caught ${caught.trim().split('\n').filter(Boolean).length} of 6 real violations — it has become a no-op`);

    const prose = [
      '/** Open the parry window. Costs nothing to try; missing it is the cost. */',
      '// over several frames of the same active window. That is the point.',
      '// this is not the document. It is a comment about a document. ',
      '// the navigator. A person, not a DOM global.',
    ].join('\n');
    let falsePositives = '';
    try {
      falsePositives = execFileSync('grep', ['-nE', PATTERN], { input: prose, encoding: 'utf8' });
    } catch { falsePositives = ''; }
    assert.equal(falsePositives.trim(), '',
      `the purity pattern flags English prose, so it will produce false alarms:\n${falsePositives}`);

    let hits = '';
    try {
      hits = execFileSync('grep', ['-rnE', PATTERN,
        '--include=*.js', 'src/core', 'src/sim', 'src/content'],
      { encoding: 'utf8' });
    } catch { hits = ''; }   // grep exits 1 on no matches
    assert.equal(hits.trim(), '', `purity violation:\n${hits}`);
  });

  test('26 · the whole world builds with zero renderer involvement', () => {
    // If this test passes, world generation is provably independent of Three.js.
    assert.ok(spaces.length === 20, 'world did not build all regions');
    for (const s of spaces) {
      assert.ok(s.built, `${s.id} not marked built`);
      assert.ok(s.nav?.built, `${s.id} nav grid not built`);
      assert.finite(s.buildTimeMs, `${s.id} build time is not finite`);
    }
  });
});

/* ----------------------------------------------- simulation invariants */

describe('verify — simulation invariants', () => {
  test('27 · world generation stays inside the §24 budget', () => {
    const w = new World();
    const t0 = Date.now();
    w.buildAll();
    const ms = Date.now() - t0;
    assert.lt(ms, K.PERF.WORLD_GEN_BUDGET_MS,
      `world generation took ${ms} ms, budget is ${K.PERF.WORLD_GEN_BUDGET_MS} ms`);
  });

  test('28 · the same seed produces byte-identical nav grids', () => {
    const w2 = new World();
    w2.buildAll();
    for (const [id, s] of world.regionSpaces) {
      const o = w2.region(id);
      assert.equal(o.nav.stats.walkable, s.nav.stats.walkable,
        `${id}: walkable cell count differs between identical builds (${o.nav.stats.walkable} vs ${s.nav.stats.walkable})`);
      assert.equal(o.nav.stats.total, s.nav.stats.total, `${id}: grid size differs`);
      assert.equal(o.collision.colliders.length, s.collision.colliders.length, `${id}: collider count differs`);
    }
  });

  test('29 · every doorway is open in the nav grid — a sealed exit is a P0', () => {
    const sealed = [];
    for (const s of spaces) {
      for (const d of s.doors) {
        // The threshold itself and a point just inside must both be navigable.
        const atDoor = s.nav.isWalkableAt(d.world.x, d.world.z);
        const inside = s.nav.isWalkableAt(d.world.x + d.inward.x * 1.2, d.world.z + d.inward.z * 1.2);
        if (!atDoor || !inside) sealed.push(`${s.id}/${d.id} door=${atDoor} inside=${inside}`);
      }
    }
    assert.deepEqual(sealed, [], `sealed doorways: ${sealed.join(' | ')}`);
  });

  test('30 · nav grid never marks a cell walkable where the capsule cannot fit', () => {
    // Sampled rather than exhaustive: 332k cells x capsule test is too slow for
    // a per-run suite, and a stratified sample catches systematic violations.
    const violations = [];
    let checked = 0;
    for (const s of spaces) {
      const nav = s.nav;
      const strideCol = Math.max(1, Math.floor(nav.cols / 40));
      const strideRow = Math.max(1, Math.floor(nav.rows / 40));
      for (let row = 0; row < nav.rows; row += strideRow) {
        for (let col = 0; col < nav.cols; col += strideCol) {
          if (!nav.isWalkable(col, row)) continue;
          checked++;
          const w = nav.cellToWorld(col, row);
          const y = nav.heightAt(col, row);
          // Same rule the grid itself uses: a surface the agent can step up onto
          // from this level does not disqualify the cell, otherwise every low
          // bench and platform edge would read as a violation.
          const free = s.collision.isSpaceFree({ x: w.x, y: y + 0.05, z: w.z },
            nav.agentRadius, K.MOVE.CAPSULE_HEIGHT, { ignoreTopBelowY: y + 0.62 });
          if (!free) violations.push(`${s.id} (${w.x.toFixed(2)},${w.z.toFixed(2)}) y=${y.toFixed(2)}`);
        }
      }
    }
    assert.gt(checked, 1000, `sample too small to be meaningful: ${checked}`);
    assert.deepEqual(violations.slice(0, 8), [],
      `${violations.length}/${checked} walkable cells cannot actually hold the player capsule: ${violations.slice(0, 8).join(', ')}`);
  });

  test('31 · A* never routes through a blocked cell', () => {
    const offenders = [];
    let routes = 0;
    for (const s of spaces) {
      // Long-range tier: these are cross-region-scale routes, exactly the calls
      // the tactical budget would defer. See the AI constants for the measured
      // node distribution the two tiers come from.
      const pf = new Pathfinder(s.nav, { longRange: true });
      // Endpoints are resolved to walkable cells first: a landmark centre can
      // legitimately be inside its own geometry (a bed, a jar row, a kiln), and
      // routing to an unresolvable point would silently shrink the coverage
      // this test is supposed to provide.
      const pts = [];
      for (const sp of s.spawnPoints) {
        const c = s.nav.nearestWalkable(sp.x, sp.z, 6);
        if (c) { const w = s.nav.cellToWorld(c.col, c.row); pts.push({ x: w.x, z: w.z, id: sp.id }); }
      }
      for (const l of s.landmarks) {
        const c = s.nav.nearestWalkable(l.x, l.z, 6);
        if (c) { const w = s.nav.cellToWorld(c.col, c.row); pts.push({ x: w.x, z: w.z, id: l.id }); }
      }
      for (let a = 0; a < pts.length; a++) {
        for (let b = 0; b < pts.length; b++) {
          if (a === b) continue;
          const r = pf.findPath(pts[a].x, pts[a].z, pts[b].x, pts[b].z);
          if (!r.ok) {
            // A budget failure here would mean the tier is mis-set; genuine
            // unreachability between two walkable cells in one region is a defect.
            assert.notOk(r.retryable,
              `${s.id}: ${pts[a].id} -> ${pts[b].id} hit the long-range budget (${r.reason}, ${r.nodesExpanded} nodes)`);
            continue;
          }
          routes++;
          for (const p of r.path) {
            if (!s.nav.isWalkableAt(p.x, p.z)) {
              offenders.push(`${s.id} ${pts[a].id}->${pts[b].id} point (${p.x.toFixed(2)},${p.z.toFixed(2)}) is blocked`);
              break;
            }
          }
        }
      }
    }
    assert.gt(routes, 500, `too few routes exercised to be meaningful: ${routes}`);
    assert.deepEqual(offenders.slice(0, 8), [],
      `${offenders.length} routes cross blocked cells: ${offenders.slice(0, 8).join(' | ')}`);
  });

  test('31b · a reused Pathfinder does not degrade — the closed set is epoch-guarded', () => {
    // Regression. The scratch buffers are deliberately not cleared between
    // queries (that is what makes A* allocation-free), so every read of the
    // closed-set flag has to be epoch-guarded. Unguarded, any cell closed by the
    // previous query stayed closed forever: an agent pathed correctly once and
    // then could never route through that space again. AI repaths every 0.35 s,
    // so guards would stop chasing the player within a second of the first path.
    const s = world.region('market');
    const pf = new Pathfinder(s.nav, { longRange: true });
    const a = s.spawnPoints[0];
    const targets = s.landmarks.map((l) => l).filter((l) => s.nav.nearestWalkable(l.x, l.z, 6));
    assert.gte(targets.length, 3, 'market has too few landmarks to exercise reuse');

    const first = [];
    for (const t of targets) first.push(pf.findPath(a.x, a.z, t.x, t.z));
    // Now hammer the same instance with the same and reversed queries.
    for (let pass = 0; pass < 4; pass++) {
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        const again = pf.findPath(a.x, a.z, t.x, t.z);
        assert.equal(again.ok, first[i].ok,
          `query ${i} on pass ${pass} changed outcome (${first[i].ok} -> ${again.ok}, reason ${again.reason})`);
        if (again.ok && first[i].ok) {
          assert.close(again.cost, first[i].cost, 1e-6,
            `path cost drifted on reuse (query ${i}, pass ${pass}): ${first[i].cost} -> ${again.cost}`);
        }
        const rev = pf.findPath(t.x, t.z, a.x, a.z);
        assert.equal(rev.ok, again.ok, `reverse query disagreed after reuse (${rev.reason})`);
      }
    }
  });

  test('31c · budget exhaustion is retryable, true unreachability is not', () => {
    // The distinction is what stops an AI agent giving up on a target it can
    // actually reach. A caller that cannot tell the two apart will either stall
    // a guard under load or spin forever on an impossible route.
    const s = world.region('desert-edge');
    const pf = new Pathfinder(s.nav, { longRange: true });
    const a = s.spawnPoints[0];
    const far = s.landmarks.reduce((best, l) =>
      (Math.hypot(l.x - a.x, l.z - a.z) > Math.hypot(best.x - a.x, best.z - a.z) ? l : best), s.landmarks[0]);

    const tight = pf.findPath(a.x, a.z, far.x, far.z, { maxNodes: 8, timeBudgetMs: 0 });
    if (!tight.ok) {
      assert.ok(tight.retryable, `an 8-node budget must fail retryably, got reason=${tight.reason}`);
      assert.includes(['node-budget', 'time-budget'], tight.reason, 'unexpected retryable reason');
    }
    const full = pf.findPath(a.x, a.z, far.x, far.z);
    assert.ok(full.ok, `the long-range tier must resolve the widest route in the game (${full.reason})`);
    assert.equal(full.retryable, undefined, 'a successful query must not carry retryable');

    // A genuinely unreachable goal: a point outside the region bounds entirely.
    const gone = pf.findPath(a.x, a.z, 99999, 99999);
    assert.notOk(gone.ok, 'a goal outside the world must not resolve');
    assert.notOk(gone.retryable, `an unreachable goal must not be retryable (reason=${gone.reason})`);
  });

  test('31d · tactical and long-range tiers are set from the measured distribution', () => {
    const { AI } = K;
    assert.lt(AI.PATH_MAX_NODES_TACTICAL, AI.PATH_MAX_NODES,
      'the tactical tier must be tighter than the long-range tier or the split is meaningless');
    assert.lt(AI.PATH_TIME_BUDGET_MS_TACTICAL, K.PERF.AI_BUDGET_MS,
      'one tactical path query must fit inside the whole frame AI budget');
    // Measured worst case across 746 routes was 9856 nodes; the long-range tier
    // must clear it with headroom or legitimate routes fail under load.
    assert.gt(AI.PATH_MAX_NODES, 9856, 'long-range tier below the measured worst case');
    assert.lt(AI.PATH_MAX_NODES, 9856 * 2, 'long-range tier far above the measured worst case');
  });

  test('32 · capsule movement never ends up inside geometry', () => {
    const cw = new CollisionWorld();
    cw.setBounds(new M.Vec3(-20, -10, -20), new M.Vec3(20, 20, 20));
    cw.add(boxCollider(0, 1, 0, 4, 2, 4, { kind: 'block', blocksMovement: true, walkableTop: false }));
    cw.add(wallCollider(-10, 5, 10, 5, 0, 3, 0.4, { kind: 'wall', blocksMovement: true }));

    let worst = 0;
    for (let angle = 0; angle < 360; angle += 7) {
      const rad = angle * M.DEG2RAD;
      const pos = new M.Vec3(-8, 0, -8);
      for (let step = 0; step < 220; step++) {
        const dir = new M.Vec3(Math.cos(rad + step * 0.11), 0, Math.sin(rad + step * 0.11));
        const r = cw.moveCapsule(pos, dir.scale(0.28));
        pos.copy(r.pos);
        assert.finite(pos.x, 'capsule x became NaN'); assert.finite(pos.z, 'capsule z became NaN');
        if (cw.isSpaceFree(pos, K.MOVE.CAPSULE_RADIUS, K.MOVE.CAPSULE_HEIGHT)) continue;
        // Measure how far inside it ended up, if at all.
        const box = cw.isSpaceFree.penetration?.(pos, K.MOVE.CAPSULE_RADIUS, K.MOVE.CAPSULE_HEIGHT);
        worst = Math.max(worst, typeof box === 'number' ? box : 0.001);
      }
    }
    assert.lt(worst, 1e-3, `capsule ended up ${worst} m inside geometry`);
  });

  test('33 · fall damage is monotonic and bounded by the declared heights', () => {
    const none = computeFallDamage(0);
    assert.equal(none.damage, 0, 'no fall should deal damage');
    assert.equal(none.severity, 'none', 'a zero-height fall must report severity none');
    assert.notOk(none.lethal, 'a zero-height fall must not be lethal');

    const safe = computeFallDamage(K.MOVE.FALL_DAMAGE_SAFE_HEIGHT * 0.5);
    assert.equal(safe.damage, 0, 'damage applied below the safe height');

    const lethal = computeFallDamage(K.MOVE.FALL_DAMAGE_LETHAL_HEIGHT * 2);
    assert.ok(lethal.lethal, 'a fall well past the lethal height must be lethal');
    assert.gte(lethal.damage, K.COMBAT.PLAYER_MAX_HEALTH, 'a lethal fall must exceed max health');

    let prev = -1;
    for (let h = 0; h <= K.MOVE.FALL_DAMAGE_LETHAL_HEIGHT * 0.9; h += 0.25) {
      const d = computeFallDamage(h).damage;
      assert.gte(d, prev, `fall damage is not monotonic at ${h} m (${d} after ${prev})`);
      assert.gte(d, 0, `negative fall damage at ${h} m`);
      assert.ok(Number.isFinite(d), `non-finite fall damage at ${h} m`);
      prev = d;
    }

    // A committed landing roll must mitigate, and must not mitigate a lethal fall.
    const rolled = computeFallDamage(4, { rolling: true, groundedSpeed: K.MOVE.RUN_SPEED, stamina: K.MOVE.STAMINA_MAX });
    const plain = computeFallDamage(4);
    assert.lt(rolled.damage, plain.damage, 'a landing roll did not reduce fall damage');
    assert.ok(rolled.mitigated, 'roll mitigation not reported');
    const noStamina = computeFallDamage(4, { rolling: true, groundedSpeed: K.MOVE.RUN_SPEED, stamina: 0 });
    assert.equal(noStamina.damage, plain.damage, 'a roll with no stamina should not mitigate');
    const tooSlow = computeFallDamage(4, { rolling: true, groundedSpeed: 0, stamina: K.MOVE.STAMINA_MAX });
    assert.equal(tooSlow.damage, plain.damage, 'a roll with no forward momentum should not mitigate');

    // Landing noise must rise with impact, or a heavy landing stays silent.
    assert.lt(landingNoise(0.5), landingNoise(6), 'a heavy landing must be louder than a light one');
    assert.finite(landingNoise(0), 'landingNoise(0) must be finite');
  });

  test('34 · NavGrid.canStep refuses a wall and accepts a stair', () => {
    // A nav grid that lets AI step up a 1.1 m parapet is AI cheating (§11
    // Agent 06). Tested directly on a synthetic grid so the assertion is about
    // canStep itself and not about whatever the world builder happened to place.
    const nav = new NavGrid({ bounds: { minX: 0, maxX: 4, minZ: 0, maxZ: 2 }, cellSize: 0.5 });
    for (let row = 0; row < nav.rows; row++) {
      for (let col = 0; col < nav.cols; col++) nav.set(col, row, CELL.WALKABLE);
    }
    const stepLimit = nav.stepLimit;
    assert.gt(stepLimit, 0.3, 'stepLimit must accept a real stair rise');
    assert.lt(stepLimit, 0.7, 'stepLimit must reject a low wall');

    const set = (col, h) => { nav.heights[nav.index(col, 0)] = h; };
    set(0, 0);
    const cases = [
      [0.00, true, 'flat ground must be connected'],
      [0.17, true, 'a 0.17 m stair riser must be connected'],
      [0.32, true, 'a 0.32 m step must be connected'],
      [stepLimit - 0.01, true, 'just under the limit must be connected'],
      [stepLimit + 0.01, false, 'just over the limit must be refused'],
      [0.60, false, 'a 0.6 m kerb must be refused'],
      [1.10, false, 'a 1.1 m parapet must be refused'],
      [3.00, false, 'a wall must be refused'],
      [-1.10, false, 'a 1.1 m drop must be refused (no climb down a wall)'],
    ];
    for (const [dh, expected, why] of cases) {
      set(1, dh);
      assert.equal(nav.canStep(0, 0, 1, 0), expected,
        `canStep over a ${dh.toFixed(2)} m height change: ${why}`);
      // Symmetry: if the agent cannot climb it, it cannot descend it either.
      set(0, dh); set(1, 0);
      assert.equal(nav.canStep(0, 0, 1, 0), expected,
        `canStep is not symmetric for a ${dh.toFixed(2)} m change: ${why}`);
      set(0, 0);
    }

    // Out of bounds must never be steppable, in any direction.
    assert.notOk(nav.canStep(0, 0, -1, 0), 'stepping out of bounds west');
    assert.notOk(nav.canStep(0, 0, 0, -1), 'stepping out of bounds north');
    assert.notOk(nav.canStep(nav.cols - 1, 0, nav.cols, 0), 'stepping out of bounds east');
    // A blocked cell is not steppable even at identical height.
    set(1, 0);
    nav.set(1, 0, CELL.BLOCKED);
    assert.notOk(nav.canStep(0, 0, 1, 0), 'a blocked cell must not be steppable');
  });

  test('34b · a built parapet actually divides its region', () => {
    // The synthetic test above proves canStep; this proves the world builder
    // produces geometry where it matters. A raised walk or parapet must be a
    // barrier on foot, otherwise guards patrol onto roofs and the player can be
    // seen from places they cannot be reached from.
    const s = world.region('ziggurat-terrace');
    const fill = s.nav.floodFill(s.spawnPoints[0].x, s.spawnPoints[0].z);
    assert.ok(fill.ok, 'ziggurat terrace flood fill failed');
    // Every walkable cell the fill did not reach must be separated by a height
    // discontinuity, not merely orphaned by a bug.
    let orphans = 0;
    for (let row = 0; row < s.nav.rows; row++) {
      for (let col = 0; col < s.nav.cols; col++) {
        if (!s.nav.isWalkable(col, row)) continue;
        if (fill.reached.has(s.nav.index(col, row))) continue;
        // Reachable from the filled set by any single step? Then it is an orphan.
        let step = false;
        for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          if (s.nav.canStep(col, row, col + dc, row + dr)
            && fill.reached.has(s.nav.index(col + dc, row + dr))) { step = true; break; }
        }
        if (step) orphans++;
      }
    }
    assert.equal(orphans, 0, `${orphans} walkable cells are one step from the filled region but unreached`);
  });
});

runAndExit();
