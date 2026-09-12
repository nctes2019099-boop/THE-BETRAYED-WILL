// THE BETRAYED WILL — reach-test.mjs
// §22 required suite. Target score: 22/22.
//
// Purpose: prove that no part of the game world is orphaned. A mission that
// cannot be completed because a room, doorway or objective is unreachable is a
// P0 under §19 ("mission impossible to complete", "player permanently stuck").
// This suite is the structural guard against that entire class of defect.

import { describe, test, assert, runAndExit } from './harness.mjs';
import { World, regionReachability, doorwayWidthReport, setColliderEnabled } from '../src/sim/world.js';
import { REGIONS, REGION_MAP, LANDMARKS, validateWorldData } from '../src/content/world-data.js';
import { WORLD, PERF } from '../src/core/constants.js';
import { Vec3 } from '../src/core/math.js';

const world = new World({ seed: 'mesopotamia' });
const validation = validateWorldData();
world.buildAll();

/** Every region, built. */
const spaces = REGIONS.map((r) => world.region(r.id));

/**
 * Walkable cells within `radiusMetres` of a landmark position.
 * The radius is expressed in METRES and converted per region, because interiors
 * and exteriors deliberately use different nav resolutions. Expressing it in
 * cells would silently shrink the search area whenever resolution changes.
 */
function walkableNear(space, x, z, radiusMetres = 1.5) {
  const nav = space.nav;
  const centre = nav.worldToCell(x, z);
  const radiusCells = Math.ceil(radiusMetres / nav.cellSize);
  const found = [];
  for (let dr = -radiusCells; dr <= radiusCells; dr++) {
    for (let dc = -radiusCells; dc <= radiusCells; dc++) {
      const cc = centre.col + dc, rr = centre.row + dr;
      if (!nav.inBounds(cc, rr)) continue;
      if (!nav.isWalkable(cc, rr)) continue;
      found.push({ col: cc, row: rr, dist: Math.hypot(dc, dr) * nav.cellSize });
    }
  }
  found.sort((a, b) => a.dist - b.dist);
  return found;
}

/** Distance in metres to the nearest walkable cell that the fill reached. */
function nearestReachable(space, fill, x, z) {
  const nav = space.nav;
  const c = nav.worldToCell(x, z);
  const rmax = Math.ceil(24 / nav.cellSize);
  for (let r = 0; r <= rmax; r++) {
    for (let dr = -r; dr <= r; dr++) {
      for (let dc = -r; dc <= r; dc++) {
        if (Math.max(Math.abs(dc), Math.abs(dr)) !== r) continue;
        const cc = c.col + dc, rr = c.row + dr;
        if (!nav.inBounds(cc, rr) || !nav.isWalkable(cc, rr)) continue;
        if (fill.reached.has(nav.index(cc, rr))) return r * nav.cellSize;
      }
    }
  }
  return null;
}

/**
 * Density metrics that predict playable space (§8). Samples walkable cells on a
 * metre grid and measures how far each is from the nearest blocked cell.
 */
function densityMetrics(space, sampleStepMetres = 3.0, maxSearchMetres = 16) {
  const nav = space.nav;
  const stride = Math.max(1, Math.round(sampleStepMetres / nav.cellSize));
  const rmax = Math.ceil(maxSearchMetres / nav.cellSize);
  let sampled = 0, covered = 0, sum = 0, max = 0;
  for (let row = 0; row < nav.rows; row += stride) {
    for (let col = 0; col < nav.cols; col += stride) {
      if (!nav.isWalkable(col, row)) continue;
      sampled++;
      let found = -1;
      outer: for (let r = 1; r <= rmax; r++) {
        for (let dr = -r; dr <= r; dr++) {
          for (let dc = -r; dc <= r; dc++) {
            if (Math.max(Math.abs(dc), Math.abs(dr)) !== r) continue;
            const cc = col + dc, rr = row + dr;
            if (!nav.inBounds(cc, rr) || nav.get(cc, rr) === 0) { found = r * nav.cellSize; break outer; }
          }
        }
      }
      const d = found < 0 ? maxSearchMetres : found;
      sum += d;
      if (d > max) max = d;
      if (d <= 4) covered++;
    }
  }
  return {
    sampled,
    coverWithin4: sampled ? covered / sampled : 0,
    meanNearest: sampled ? sum / sampled : 0,
    maxNearest: max,
  };
}

describe('reach-test — world data integrity', () => {
  test('01 · world-data self-validation reports no errors', () => {
    assert.equal(validation.ok, true, `validation errors: ${validation.errors.join(' | ')}`);
    assert.equal(validation.errors.length, 0);
  });

  test('02 · region count matches the specification (20 spaces)', () => {
    assert.equal(REGIONS.length, 20, `expected 20 regions, got ${REGIONS.length}`);
    for (const r of REGIONS) {
      assert.ok(r.en && r.ar, `region ${r.id} missing bilingual name`);
    }
  });

  test('03 · landmark count meets the ~50 target (§9)', () => {
    assert.gte(LANDMARKS.length, 50,
      `expected at least 50 landmarks, got ${LANDMARKS.length}`);
  });

  test('04 · every region is reachable from the palace courtyard', () => {
    const reach = regionReachability('palace-court');
    assert.equal(reach.missing.length, 0,
      `unreachable regions: ${reach.missing.join(', ')}`);
    assert.equal(reach.reachable.size, REGIONS.length);
  });

  test('05 · every region connection is bidirectional (no one-way traps)', () => {
    const oneWay = [];
    for (const r of REGIONS) {
      for (const c of r.connects ?? []) {
        if (!(REGION_MAP[c].connects ?? []).includes(r.id)) oneWay.push(`${r.id}->${c}`);
      }
    }
    assert.equal(oneWay.length, 0, `one-way links: ${oneWay.join(', ')}`);
  });
});

describe('reach-test — geometry generation', () => {
  test('06 · all 20 regions build without throwing', () => {
    for (const s of spaces) {
      assert.equal(s.built, true, `region ${s.id} did not finish building`);
      assert.gt(s.collision.colliders.length, 0, `region ${s.id} generated no colliders`);
      assert.ok(s.nav?.built, `region ${s.id} has no built nav grid`);
    }
  });

  test('07 · every region contains walkable navigation cells', () => {
    const empty = spaces.filter((s) => s.nav.stats.walkable === 0).map((s) => s.id);
    assert.equal(empty.length, 0, `regions with zero walkable cells: ${empty.join(', ')}`);
  });

  test('08 · space density is playable — cover availability and sight-line length', () => {
    // "Walkable %" is a poor proxy for §8's "dense, purposeful and believable":
    // a large courtyard crossed by thin walls is 97% walkable yet perfectly
    // dense, while an empty field is 100% walkable and useless. The metrics that
    // actually predict playable density are:
    //   * lower bound on walkable ratio  — the space is not sealed
    //   * cover within 4 m               — can the player break a sight line?
    //   * mean distance to nearest obstacle — how long the empty spans are
    // Classes differ because a desert edge SHOULD feel exposed and a cellar
    // stair SHOULD feel tight; asserting one number for both would be wrong.
    const CLASSES = {
      interior: { coverMin: 0.70, meanMax: 3.6, walkMinPct: 45 },
      // A great hall is legitimately open: it is a ceremonial volume, not a
      // warren. Holding it to bedroom-warren cover density would be wrong, so
      // it gets its own class rather than a loosened global number.
      hall:     { coverMin: 0.62, meanMax: 4.2, walkMinPct: 45 },
      urban:    { coverMin: 0.55, meanMax: 5.2, walkMinPct: 45 },
      open:     { coverMin: 0.40, meanMax: 6.2, walkMinPct: 60 },
      desert:   { coverMin: 0.30, meanMax: 8.0, walkMinPct: 60 },
    };
    const HALLS = new Set(['palace-hall', 'feast-hall']);
    const classify = (id, indoor) => {
      if (HALLS.has(id)) return 'hall';
      if (indoor) return 'interior';
      if (id === 'desert-edge') return 'desert';
      if (id === 'palace-court' || id === 'temple-precinct') return 'open';
      return 'urban';
    };

    const offenders = [];
    for (const sp of spaces) {
      const nav = sp.nav;
      const walkPct = (nav.stats.walkable / nav.stats.total) * 100;
      assert.gt(walkPct, 8, `region ${sp.id} is sealed (${walkPct.toFixed(1)}% walkable)`);

      // Sample step adapts to region area. A fixed 3 m stride gives an 8 m wide
      // stairwell only 18 candidate points, so the density statistics would be
      // computed from whatever handful happened to land on walkable cells —
      // that measures the stride, not the space. Holding the sample count in a
      // useful band makes the metric comparable across a 144 m2 stairwell and a
      // 8100 m2 courtyard alike.
      const area = (nav.cols * nav.cellSize) * (nav.rows * nav.cellSize);
      const step = Math.min(3.0, Math.max(1.0, Math.sqrt(area / 250)));
      const metrics = densityMetrics(sp, step, 16);
      const cls = classify(sp.id, sp.isIndoor);
      const lim = CLASSES[cls];
      if (metrics.coverWithin4 < lim.coverMin || metrics.meanNearest > lim.meanMax
        || walkPct < lim.walkMinPct) {
        offenders.push(`${sp.id}[${cls}] cover4m=${(metrics.coverWithin4 * 100).toFixed(0)}%`
          + `(>=${(lim.coverMin * 100).toFixed(0)}) meanObst=${metrics.meanNearest.toFixed(2)}m`
          + `(<=${lim.meanMax}) walk=${walkPct.toFixed(0)}%`);
      }
      assert.gt(metrics.sampled, 24, `region ${sp.id} has too few walkable samples`);
    }
    assert.equal(offenders.length, 0, `density outside class limits: ${offenders.join(' | ')}`);
  });

  test('09 · every doorway is open in the navigation grid', () => {
    const sealed = [];
    for (const s of spaces) {
      for (const report of doorwayWidthReport(s)) {
        if (!report.navOpen) sealed.push(`${s.id}/${report.id}`);
      }
    }
    assert.equal(sealed.length, 0,
      `doorways sealed by nav erosion (player would be trapped): ${sealed.join(', ')}`);
  });

  test('10 · every doorway has a reciprocal doorway in its target region', () => {
    const missing = [];
    for (const s of spaces) {
      for (const d of s.doors) {
        if (!d.toRegion) continue;
        const target = world.region(d.toRegion);
        if (!target.doorTo(s.id)) missing.push(`${s.id}->${d.toRegion}`);
      }
    }
    assert.equal(missing.length, 0, `links with no return door: ${missing.join(', ')}`);
  });

  test('11 · travelling through every door lands on a walkable cell', () => {
    const bad = [];
    for (const s of spaces) {
      for (const d of s.doors) {
        if (!d.toRegion) continue;
        const result = world.travelThroughDoor(s.id, d.id);
        if (!result.ok) { bad.push(`${s.id}/${d.id}: ${result.reason}`); continue; }
        const target = world.region(result.regionId);
        if (!target.nav.isWalkableAt(result.spawn.x, result.spawn.z)) {
          bad.push(`${s.id}->${result.regionId} spawn (${result.spawn.x.toFixed(2)},`
            + `${result.spawn.z.toFixed(2)}) is not walkable`);
        }
      }
    }
    assert.equal(bad.length, 0, `bad door transitions: ${bad.slice(0, 6).join(' | ')}`);
  });
});

describe('reach-test — intra-region navigation', () => {
  test('12 · every landmark is approachable from its region spawn', () => {
    // A landmark counts as reachable when some walkable cell within 1.5 m of it
    // is in the same connected component as the region's default spawn.
    const orphaned = [];
    for (const s of spaces) {
      const spawn = s.spawnPoints[0];
      const spawnY = s.nav.heightAtWorld(spawn.x, spawn.z);
      const fill = s.nav.floodFill(spawn.x, spawn.z);
      assert.ok(fill.ok, `region ${s.id}: flood fill found no seed at spawn`);

      for (const lm of s.landmarks) {
        // A landmark the story deliberately seals (Raynor's holding cage) is
        // judged on whether the player can reach it from OUTSIDE, and on whether
        // the seal is a single named collider the story can open — not on
        // whether its interior is walkable from the spawn.
        const radius = lm.enclosed ? 3.6 : 1.6;
        const near = walkableNear(s, lm.x, lm.z, radius);
        if (near.length === 0) {
          orphaned.push(`${s.id}/${lm.id}: no walkable cell within ${radius} m`);
          continue;
        }
        const anyReached = near.some((n) => fill.reached.has(s.nav.index(n.col, n.row)));
        if (!anyReached) {
          orphaned.push(`${s.id}/${lm.id}: walled off from spawn (nearest reachable ${
            nearestReachable(s, fill, lm.x, lm.z)?.toFixed(2) ?? 'none'} m)`);
          continue;
        }
        if (lm.enclosed) {
          assert.ok(lm.gateId, `${lm.id} is enclosed but declares no gateId to open it`);
          const gate = s.collision.colliders.find((c) => c.id === lm.gateId);
          assert.ok(gate, `${lm.id}: gate collider "${lm.gateId}" does not exist`);
          assert.equal(gate.enabled, true, `${lm.id}: gate should start closed/enabled`);
          // Opening the gate must physically clear the entrance — proving the
          // seal is the gate and nothing else, so Chapter 4 can always proceed.
          setColliderEnabled(s, lm.gateId, false);
          const mouth = { x: lm.x, y: lm.y + 0.05, z: lm.z + 1.7 };
          assert.ok(s.collision.isSpaceFree(mouth, 0.34, 1.78),
            `${lm.id}: entrance still blocked with the gate open`);
          setColliderEnabled(s, lm.gateId, true);
        }
      }
      void spawnY;
    }
    assert.equal(orphaned.length, 0,
      `unapproachable landmarks: ${orphaned.slice(0, 8).join(' | ')}`);
  });

  test('13 · A* finds a path between distant landmarks in the palace courtyard', () => {
    const space = world.region('palace-court');
    const a = space.landmark('lm-court-fountain');
    const b = space.landmark('lm-gate-main');
    assert.ok(a && b, 'test landmarks missing');
    const result = space.pathfinder.findPath(a.x, a.z, b.x, b.z);
    assert.equal(result.ok, true, `path failed: ${result.reason}`);
    assert.gte(result.path.length, 2);
    // The path must stay on walkable cells.
    for (const p of result.path) {
      assert.ok(space.nav.isWalkableAt(p.x, p.z),
        `path point (${p.x.toFixed(2)}, ${p.z.toFixed(2)}) is not walkable`);
    }
  });

  test('14 · the cellar is reachable from the palace courtyard by door chain', () => {
    // Prologue -> Ch1 -> Ch3 -> Ch4 traversal: court -> hall -> wing -> storage
    // -> cellar-stair -> cellar.
    const chain = ['palace-court', 'palace-hall', 'brothers-wing', 'storage', 'cellar-stair', 'cellar'];
    for (let i = 0; i < chain.length - 1; i++) {
      const from = world.region(chain[i]);
      const door = from.doorTo(chain[i + 1]);
      assert.ok(door, `no door from ${chain[i]} to ${chain[i + 1]}`);
      const result = world.travelThroughDoor(chain[i], door.id);
      assert.equal(result.ok, true, `transition ${chain[i]}->${chain[i + 1]} failed`);
      assert.equal(result.regionId, chain[i + 1]);
    }
  });

  test('15 · the escape route is complete: cellar -> tunnel -> palace exterior', () => {
    // §7 Chapter 5: servant passage -> tunnel -> palace exterior.
    const cellar = world.region('cellar');
    const d1 = cellar.doorTo('tunnel');
    assert.ok(d1, 'cellar has no door to the tunnel — Chapter 5 would be uncompletable');
    const r1 = world.travelThroughDoor('cellar', d1.id);
    assert.equal(r1.regionId, 'tunnel');

    const tunnel = world.region('tunnel');
    const d2 = tunnel.doorTo('palace-exterior');
    assert.ok(d2, 'tunnel has no door to the palace exterior');
    const r2 = world.travelThroughDoor('tunnel', d2.id);
    assert.equal(r2.regionId, 'palace-exterior');
  });

  test('16 · all Chapter 6 outskirts locations are reachable from the palace exterior', () => {
    const ch6 = ['gate-road', 'poor-quarter', 'market', 'temple-precinct',
                 'ziggurat-terrace', 'canal-bank', 'ruins', 'desert-edge', 'layla-house'];
    const reach = regionReachability('palace-exterior');
    const missing = ch6.filter((id) => !reach.reachable.has(id));
    assert.equal(missing.length, 0, `Chapter 6 spaces unreachable: ${missing.join(', ')}`);
  });

  test("17 · Layla's house is reachable and is an interior", () => {
    const space = world.region('layla-house');
    assert.equal(space.isIndoor, true, "Layla's house should be an interior");
    assert.gt(space.nav.stats.walkable, 0);
    const table = space.landmark('lm-ll-table');
    assert.ok(table, 'artifact mission table missing from Layla\'s house');
    const fill = space.nav.floodFill(space.spawnPoints[0].x, space.spawnPoints[0].z);
    const near = walkableNear(space, table.x, table.z, 1.6);
    assert.ok(near.some((n) => fill.reached.has(space.nav.index(n.col, n.row))),
      'the artifact mission objective is not approachable');
  });

  test('18 · the ruins vault (artifact objective) is reachable inside the ruins', () => {
    const space = world.region('ruins');
    const vault = space.landmark('lm-ru-vault');
    assert.ok(vault, 'sunken vault landmark missing');
    const fill = space.nav.floodFill(space.spawnPoints[0].x, space.spawnPoints[0].z);
    const near = walkableNear(space, vault.x, vault.z, 3.0);
    assert.ok(near.some((n) => fill.reached.has(space.nav.index(n.col, n.row))),
      'the artifact objective inside the vault cannot be reached');
  });

  test('19 · the ziggurat terrace is elevated above the temple precinct', () => {
    const terrace = world.region('ziggurat-terrace');
    const precinct = world.region('temple-precinct');
    assert.gt(terrace.elevation, 0, 'terrace should be raised');
    assert.gte(terrace.elevation, 5, 'terrace elevation too small to read as a ziggurat');
    // Vertical connectivity: a door links the two spaces.
    assert.ok(precinct.doorTo('ziggurat-terrace'), 'no stair link to the terrace');
  });

  test('20 · interior rooms are not sealed by nav erosion (§30 tight navigation)', () => {
    // Each brother's room in Ch3 must be enterable — the investigation chapter
    // searches all of them, so a sealed bedroom breaks the mission.
    const wing = world.region('brothers-wing');
    const rooms = ['lm-wing-novan', 'lm-wing-zafir', 'lm-wing-kyle',
                   'lm-wing-eleric', 'lm-wing-evan', 'lm-wing-raynor'];
    const fill = wing.nav.floodFill(wing.spawnPoints[0].x, wing.spawnPoints[0].z);
    const sealed = [];
    for (const id of rooms) {
      const lm = wing.landmark(id);
      assert.ok(lm, `room landmark ${id} missing`);
      const near = walkableNear(wing, lm.x, lm.z, 2.2);
      if (!near.some((n) => fill.reached.has(wing.nav.index(n.col, n.row)))) sealed.push(id);
    }
    assert.equal(sealed.length, 0, `bedrooms walled off from the corridor: ${sealed.join(', ')}`);
  });
});

describe('reach-test — performance and safety', () => {
  test('21 · full world generation completes inside the §24 budget', () => {
    const budget = PERF.WORLD_GEN_BUDGET_MS;
    const total = spaces.reduce((sum, s) => sum + s.buildTimeMs, 0);
    assert.lt(total, budget,
      `world generation took ${total.toFixed(0)}ms, budget is ${budget}ms`);
    // No single region may dominate the budget.
    for (const s of spaces) {
      assert.lt(s.buildTimeMs, budget * 0.6,
        `region ${s.id} alone took ${s.buildTimeMs.toFixed(0)}ms`);
    }
  });

  test('22 · no region traps the player: every space has an exit or is terminal', () => {
    // Terminal regions (desert-edge, ziggurat-terrace, layla-house) may have a
    // single door, but every region must have at least one, and non-terminal
    // regions declared in the connection graph must match that count.
    const trapped = [];
    for (const s of spaces) {
      const expected = (REGION_MAP[s.id].connects ?? []).length;
      assert.equal(s.doors.length, expected,
        `region ${s.id} has ${s.doors.length} doors but ${expected} connections`);
      if (expected === 0) trapped.push(s.id);
    }
    assert.equal(trapped.length, 0, `regions with no exit at all: ${trapped.join(', ')}`);

    // Nav cell size must be the tuned value so erosion assumptions hold.
    assert.close(WORLD.NAV_CELL_SIZE, 0.5, 1e-9);
    // A door wider than two agent radii plus erosion margin is what keeps the
    // threshold fair; assert the invariant directly.
    for (const s of spaces) {
      const cs = s.nav.cellSize;
      for (const d of s.doors) {
        // A door must clear the agent diameter plus rasterisation error on both
        // jambs (up to half a cell each), or erosion seals it.
        assert.gt(d.width, WORLD.NAV_AGENT_RADIUS * 2 + cs * 2,
          `door ${d.id} width ${d.width} m is too narrow for cell size ${cs} m`);
      }
    }
    assert.ok(Vec3.ZERO, 'sanity');
  });
});

await runAndExit({ title: 'reach-test — world reachability (target 22/22)' });
