/**
 * THE BETRAYED WILL — world measurement report
 *
 * Emits the numbers the studio documents quote, so no figure in a review or a
 * CEO verdict is asserted without a reproducible command behind it:
 *
 *   node tools/world-report.mjs            human-readable tables
 *   node tools/world-report.mjs --json     machine-readable, for diffing runs
 *
 * Every metric here is measured on the actual generated world, not estimated.
 * This is also the BEFORE/AFTER instrument the brief's optimisation rule asks
 * for: run it before a change, run it after, diff the JSON.
 */

import { World } from '../src/sim/world.js';
import { Pathfinder } from '../src/sim/astar.js';

const asJson = process.argv.includes('--json');

const world = new World();
const t0 = Date.now();
world.buildAll();
const buildMs = Date.now() - t0;

/**
 * Cover and sight-line statistics.
 *
 * "Walkable %" alone is a misleading density proxy: a courtyard crossed by thin
 * walls is 97% walkable and perfectly dense, an empty field is 100% walkable
 * and useless. What predicts playable density is how quickly the player can
 * break a sight line, and how long the unbroken empty spans are.
 */
function densityMetrics(space, stepMetres, maxSearchMetres = 16) {
  const nav = space.nav;
  const stride = Math.max(1, Math.round(stepMetres / nav.cellSize));
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
    coverWithin4m: sampled ? +(covered / sampled * 100).toFixed(1) : 0,
    meanNearestObstacleM: sampled ? +(sum / sampled).toFixed(2) : 0,
    maxNearestObstacleM: +max.toFixed(2),
  };
}

/** Longest successful A* route in the region, in metres and expanded nodes. */
function worstCasePath(space) {
  const nav = space.nav;
  const pf = new Pathfinder(nav);
  const pts = space.spawnPoints.concat(space.landmarks.map((l) => ({ x: l.x, z: l.z })));
  let worst = { metres: 0, nodes: 0, from: '', to: '' };
  for (let a = 0; a < pts.length && a < 6; a++) {
    for (let b = a + 1; b < pts.length && b < 8; b++) {
      const r = pf.findPath(pts[a].x, pts[a].z, pts[b].x, pts[b].z);
      if (!r.ok || !r.path || r.path.length < 2) continue;
      let metres = 0;
      for (let i = 1; i < r.path.length; i++) {
        metres += Math.hypot(r.path[i].x - r.path[i - 1].x, r.path[i].z - r.path[i - 1].z);
      }
      if (metres > worst.metres) {
        worst = {
          metres: +metres.toFixed(2),
          nodes: r.nodesExpanded,
          from: pts[a].id ?? 'spawn',
          to: pts[b].id ?? 'lm',
        };
      }
    }
  }
  return worst;
}

const rows = [];
for (const [id, space] of world.regionSpaces) {
  const nav = space.nav;
  const area = (nav.cols * nav.cellSize) * (nav.rows * nav.cellSize);
  const step = Math.min(3.0, Math.max(1.0, Math.sqrt(area / 250)));
  rows.push({
    region: id,
    indoor: !!space.isIndoor,
    cellSizeM: nav.cellSize,
    cells: nav.cols * nav.rows,
    walkablePct: +(nav.stats.walkable / nav.stats.total * 100).toFixed(1),
    elevation: space.elevation,
    landmarks: space.landmarks.length,
    doors: space.doors.length,
    colliders: space.collision.colliders.length,
    ...densityMetrics(space, step),
    structureRetracted: space.repair?.retracted ?? 0,
    repairUnresolved: space.repair?.unresolved ?? [],
    worstPath: worstCasePath(space),
    buildMs: +space.buildTimeMs.toFixed(1),
  });
}

// Cross-region connectivity: the door graph must be a single connected component
// except for spaces the story deliberately leaves terminal.
const adj = new Map();
for (const [id, space] of world.regionSpaces) {
  adj.set(id, new Set(space.doors.map((d) => d.toRegion)));
}
const seen = new Set(['palace-court']);
const queue = ['palace-court'];
while (queue.length) {
  const cur = queue.shift();
  for (const next of adj.get(cur) ?? []) {
    if (!seen.has(next)) { seen.add(next); queue.push(next); }
  }
}
const unreachable = [...adj.keys()].filter((id) => !seen.has(id));

if (asJson) {
  process.stdout.write(JSON.stringify({
    generatedAt: new Date().toISOString(),
    buildMs,
    regionCount: rows.length,
    totalColliders: rows.reduce((a, r) => a + r.colliders, 0),
    totalCells: rows.reduce((a, r) => a + r.cells, 0),
    connectedFromPalaceCourt: seen.size,
    unreachableRegions: unreachable,
    regions: rows,
  }, null, 2) + '\n');
} else {
  const pad = (v, n) => String(v).padEnd(n);
  const rpad = (v, n) => String(v).padStart(n);
  console.log(`world build: ${buildMs} ms across ${rows.length} regions, `
    + `${rows.reduce((a, r) => a + r.colliders, 0)} colliders, `
    + `${rows.reduce((a, r) => a + r.cells, 0).toLocaleString()} nav cells`);
  console.log(`connectivity: ${seen.size}/${rows.length} regions reachable from palace-court`
    + (unreachable.length ? `  UNREACHABLE: ${unreachable.join(', ')}` : '  (fully connected)'));
  console.log('');
  console.log(pad('region', 18) + rpad('cell', 6) + rpad('walk%', 7) + rpad('cover4m%', 10)
    + rpad('meanObs', 9) + rpad('maxObs', 8) + rpad('lm', 4) + rpad('door', 6)
    + rpad('collid', 8) + rpad('retr', 6) + rpad('pathM', 8) + rpad('nodes', 7) + rpad('ms', 7));
  console.log('-'.repeat(104));
  for (const r of rows) {
    console.log(pad(r.region, 18) + rpad(r.cellSizeM, 6) + rpad(r.walkablePct, 7)
      + rpad(r.coverWithin4m, 10) + rpad(r.meanNearestObstacleM, 9) + rpad(r.maxNearestObstacleM, 8)
      + rpad(r.landmarks, 4) + rpad(r.doors, 6) + rpad(r.colliders, 8)
      + rpad(r.structureRetracted, 6) + rpad(r.worstPath.metres, 8) + rpad(r.worstPath.nodes, 7)
      + rpad(r.buildMs, 7));
  }
  const unresolved = rows.filter((r) => r.repairUnresolved.length);
  if (unresolved.length) {
    console.log('');
    console.log('REPAIR COULD NOT RESOLVE:');
    for (const r of unresolved) console.log(`  ${r.region}: ${r.repairUnresolved.join(', ')}`);
  }
}
