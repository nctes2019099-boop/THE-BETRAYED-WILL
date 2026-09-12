// THE BETRAYED WILL — world assembly
// PURE MODULE. Builds each region into a CollisionWorld + NavGrid + Pathfinder.
// Regions are discrete spaces linked by doorways (§8 world design): this keeps
// nav grids small and A* fast, and it is what makes cross-region reachability a
// provable property rather than a hope.

import { Vec3, AABB, clamp, smoothstep } from '../core/math.js';
import { RNG, hashCombine, hashString, fbm2 } from '../core/rng.js';
import { CollisionWorld, boxCollider, wallCollider, Collider } from './collision.js';
import { NavGrid, CELL } from './navgrid.js';
import { Pathfinder } from './astar.js';
import { REGIONS, REGION_MAP, LANDMARKS, LANDMARKS_BY_REGION, MATERIALS } from '../content/world-data.js';
import { WORLD, MOVE } from '../core/constants.js';

/**
 * Per-region terrain amplitude and noise scale, in metres.
 * Deliberately small for built and water-adjacent spaces: a canal bank is flat
 * alluvial silt, and a large swell would put fixed-height structures such as
 * bridges and jetties out of the agent's step range.
 */
const TERRAIN_AMPLITUDE = Object.freeze({
  'desert-edge': 2.4,
  ruins: 0.85,
  'canal-bank': 0.1,
  market: 0.16,
  'poor-quarter': 0.2,
  'palace-exterior': 0.22,
  'gate-road': 0.12,
  'temple-precinct': 0.14,
  'ziggurat-terrace': 0.08,
  'palace-court': 0.1,
});
const TERRAIN_SCALE = Object.freeze({
  'desert-edge': 0.035,
  ruins: 0.06,
  'canal-bank': 0.09,
});

/** Wall thickness for exterior and interior masonry. */
const WALL_T = 0.6;
const WALL_H_EXTERIOR = 4.2;
const WALL_H_INTERIOR = 3.4;
const CEILING_H = 3.4;
/** Doorway width. Must exceed 2× agent radius + margin or navigation is unfair. */
const DOOR_W = 1.9;
const DOOR_H = 2.5;

/**
 * One built region.
 */
/**
 * Snap EVERY spawn point onto the nav grid, not just the arrival point.
 *
 * The 'default' centroid spawn is pushed while the region is still being built,
 * with `y` hardcoded to 0 because no ground height exists yet. On a raised
 * region that leaves it metres BELOW the floor: the ziggurat terrace sits at
 * elevation 7.5, so its centroid spawn was 7.5 m underground, inside solid
 * ground. The arrival point is computed correctly from the grid, which is why
 * `spawnPoints[0]` looked fine - but anything consuming a later entry (mission
 * and enemy placement, fast travel, the camera suite) started an actor buried,
 * and a camera placed from it is inside geometry by construction.
 *
 * Runs after doorway carving and after reachability repair, so the grid is
 * final. Uses the same source of truth as the arrival point: nearest walkable
 * cell, height read from the grid rather than assumed.
 */
function reprojectSpawnsOntoNav(space) {
  if (!space?.nav || !Array.isArray(space.spawnPoints)) return;
  for (let i = 0; i < space.spawnPoints.length; i++) {
    const sp = space.spawnPoints[i];
    if (!sp || !Number.isFinite(sp.x) || !Number.isFinite(sp.z)) continue;
    const cell = space.nav.nearestWalkable(sp.x, sp.z, 24);
    if (!cell) continue;
    const wp = space.nav.cellToWorld(cell.col, cell.row);
    const navY = space.nav.heightAt(cell.col, cell.row);
    // The nav height is the height of the CELL, which is not always the surface
    // an actor stands on. A cell covered by climbable furniture is walkable - a
    // feast table is 0.40 m tall with a walkable top, under STEP_HEIGHT, so the
    // grid rightly treats it as somewhere you can stand - but it records the
    // floor beneath. Spawning at that height put the actor 0.40 m inside the
    // table (feast-hall's centroid spawn). Ask the collision world for the real
    // standable surface and take the higher of the two, so a spawn is always ON
    // something rather than inside it.
    const ground = space.collision
      ? space.collision.groundAt(wp.x, wp.z, navY + 0.05, MOVE.STEP_HEIGHT, MOVE.CAPSULE_RADIUS)
      : null;
    space.spawnPoints[i] = {
      id: sp.id, x: wp.x, z: wp.z, y: ground ? Math.max(ground.y, navY) : navY,
    };
  }
}

export class RegionSpace {
  constructor(region) {
    this.region = region;
    this.id = region.id;
    this.collision = new CollisionWorld(4);
    this.nav = null;
    this.pathfinder = null;
    /** Doorways: { id, toRegion, world:{x,y,z}, spawn:{x,y,z}, landmarkId } */
    this.doors = [];
    this.landmarks = [];
    this.props = [];
    this.coverSpots = [];
    this.hidingSpots = [];
    this.spawnPoints = [];
    this.interactables = [];
    this.elevation = region.elevation ?? 0;
    this.buildTimeMs = 0;
    this.built = false;
  }

  get isIndoor() { return this.region.indoor === true; }

  get bounds() { return this.region.bounds; }

  groundAt(x, z) { return this.collision.groundAt(x, z, 0, MOVE.STEP_HEIGHT); }

  heightAt(x, z) { return this.collision.heightAt(x, z); }

  /** Door leading to a specific region, if this region has one. */
  doorTo(regionId) { return this.doors.find((d) => d.toRegion === regionId) ?? null; }

  nearestDoor(x, z, maxDist = Infinity) {
    let best = null, bestD = maxDist;
    for (const d of this.doors) {
      const dist = Math.hypot(d.world.x - x, d.world.z - z);
      if (dist < bestD) { bestD = dist; best = d; }
    }
    return best;
  }

  landmark(id) { return this.landmarks.find((l) => l.id === id) ?? null; }

  /**
   * Random walkable point — used for AI patrol targets and search points.
   *
   * Accepts the core RNG, the bare sampling function src/sim/ai.js hands out, or
   * nothing at all. Two RNG shapes exist in this codebase and the AI layer's is a
   * closure with no methods on it, so a caller passing `makeRng(seed)` used to throw
   * a TypeError from inside patrol-target selection - a crash whose cause is
   * invisible at the call site. Normalizing here costs two branches.
   *
   * With no argument it falls back to a per-space RNG seeded from the space, not to
   * Math.random: patrol targets feed into AI decisions, and an AI that is not
   * reproducible cannot be tested or replayed from a save.
   */
  randomWalkablePoint(rng = null, near = null, radius = Infinity) {
    if (!rng) { this._fallbackRng = this._fallbackRng ?? new RNG(hashCombine(0x51ed7, hashString(this.id))); rng = this._fallbackRng; }
    const next = typeof rng === 'function' ? rng : () => rng.next();
    const range = typeof rng.range === 'function'
      ? (min, max) => rng.range(min, max)
      : (min, max) => min + (max - min) * next();
    for (let attempt = 0; attempt < 64; attempt++) {
      let x, z;
      if (near && Number.isFinite(radius)) {
        const a = range(0, Math.PI * 2);
        const r = radius * Math.sqrt(next());
        x = near.x + Math.cos(a) * r;
        z = near.z + Math.sin(a) * r;
      } else {
        x = range(this.bounds.x[0] + 2, this.bounds.x[1] - 2);
        z = range(this.bounds.z[0] + 2, this.bounds.z[1] - 2);
      }
      x = clamp(x, this.bounds.x[0] + 1, this.bounds.x[1] - 1);
      z = clamp(z, this.bounds.z[0] + 1, this.bounds.z[1] - 1);
      if (this.nav?.isWalkableAt(x, z)) {
        return { x, z, y: this.nav.heightAtWorld(x, z) };
      }
    }
    return null;
  }
}

/**
 * The world. Regions are built lazily on first entry so boot stays inside the
 * §24 budget, but `buildAll()` exists for tests and for preloading.
 */
export class World {
  constructor(opts = {}) {
    this.seed = opts.seed ?? 'mesopotamia';
    this.regionSpaces = new Map();
    this.currentRegionId = opts.startRegion ?? 'palace-court';
    this.buildTimes = {};
    this.totalBuildTimeMs = 0;
    /** Cross-region door graph, filled as regions are built. */
    this.transitions = [];
    this.diagnostics = { regionsBuilt: 0, colliders: 0, navCells: 0, walkableCells: 0 };
  }

  /** Build (or fetch) a region space. */
  region(id) {
    const existing = this.regionSpaces.get(id);
    if (existing) return existing;
    const def = REGION_MAP[id];
    if (!def) throw new Error(`World.region: unknown region "${id}"`);
    const space = this._buildRegion(def);
    this.regionSpaces.set(id, space);
    return space;
  }

  get current() { return this.region(this.currentRegionId); }

  has(id) { return this.regionSpaces.has(id); }

  buildAll() {
    const t0 = nowMs();
    for (const r of REGIONS) this.region(r.id);
    this.totalBuildTimeMs = nowMs() - t0;
    return this.diagnostics;
  }

  /* ------------------------------------------------------------ generation */

  _buildRegion(def) {
    const t0 = nowMs();
    const space = new RegionSpace(def);
    const rng = new RNG(hashCombine(this.seed, def.id));
    const [x0, x1] = def.bounds.x;
    const [z0, z1] = def.bounds.z;
    const w = x1 - x0;
    const d = z1 - z0;

    // --- terrain / floor ---------------------------------------------------
    if (def.indoor) {
      if (def.descent) {
        // A descending stairwell: the floor itself is the staircase, so the
        // height field carries the vertical connection and the nav grid routes
        // down it. Quantised into treads rather than smoothed, because a smooth
        // slope is a ramp and this is a stair — and because a quantised floor
        // gives the nav grid a step rise (0.172 m) far inside its per-cell limit.
        const { fromZ, toZ, depth, steps } = def.descent;
        const base = space.elevation;
        const n = Math.max(1, Math.round(steps ?? depth / 0.18));
        const riser = depth / n;
        space.collision.heightFn = (x, z) => {
          const t = clamp((fromZ - z) / Math.max(0.001, fromZ - toZ), 0, 1);
          const k = clamp(Math.floor(t * n + 1e-9), 0, n);
          return base - k * riser;
        };
      } else {
        space.collision.heightFn = null;
      }
      space.collision.groundHeight = space.elevation;
    } else {
      // Outdoor regions get gentle alluvial undulation; the desert edge is
      // dune-shaped. Deterministic so a save file restores identical geometry.
      const amp = TERRAIN_AMPLITUDE[def.id] ?? 0.34;
      const scale = TERRAIN_SCALE[def.id] ?? 0.07;
      const seedN = hashCombine(this.seed, def.id, 'terrain');
      space.collision.heightFn = (x, z) => space.elevation + fbm2(x * scale, z * scale, seedN, 3) * amp;
    }

    space.collision.setBounds(
      new Vec3(x0 - 2, -12, z0 - 2),
      new Vec3(x1 + 2, 60, z1 + 2),
    );

    // --- doorways ----------------------------------------------------------
    // Connections are distributed around the perimeter so that each neighbour
    // gets a distinct, non-overlapping opening.
    const connects = def.connects ?? [];
    const doorPlan = planDoors(def, connects);

    // --- perimeter walls with openings -------------------------------------
    const wallH = def.indoor ? WALL_H_INTERIOR : WALL_H_EXTERIOR;
    const wallMat = def.indoor ? 'plaster' : (def.ground === 'bakedBrick' ? 'bakedBrick' : 'mudBrick');
    buildPerimeter(space, def, doorPlan, wallH, wallMat);

    // --- ceiling for interiors --------------------------------------------
    if (def.indoor) {
      // Sliced along Z so a descending stairwell gets a vault that follows the
      // flight instead of one slab leaving 6.5 m of dead air at the bottom.
      const slices = Math.max(1, Math.ceil(d / 2.0));
      for (let si = 0; si < slices; si++) {
        const sz0 = z0 + (d * si) / slices;
        const sz1 = z0 + (d * (si + 1)) / slices;
        const fy = space.collision.heightFn
          ? space.collision.heightAt((x0 + x1) / 2, (sz0 + sz1) / 2)
          : space.elevation;
        space.collision.add(boxCollider(
          (x0 + x1) / 2, CEILING_H + fy + 0.25, (sz0 + sz1) / 2,
          w, 0.5, sz1 - sz0 + 0.5,
          { kind: 'ceiling', blocksMovement: true, blocksSight: true, blocksCamera: true,
            walkableTop: false, material: 'palmWood', region: def.id },
        ));
      }
    }

    // --- interior structures from landmarks --------------------------------
    const landmarkDefs = LANDMARKS_BY_REGION[def.id] ?? [];
    for (const lid of landmarkDefs) {
      const lm = LANDMARKS.find((l) => l.id === lid);
      if (!lm) continue;
      const built = buildLandmark(space, lm, def, rng);
      space.landmarks.push(built);
      if (built.interact) {
        space.interactables.push({
          id: lm.id, kind: lm.interact, x: lm.pos[0], y: lm.pos[1], z: lm.pos[2],
          en: lm.en, ar: lm.ar, item: lm.item ?? null, sidequest: lm.sidequest ?? null,
        });
      }
      if (lm.interact === 'hide') {
        space.hidingSpots.push({ id: lm.id, x: lm.pos[0], y: lm.pos[1], z: lm.pos[2], capacity: 2 });
      }
    }

    // --- regional architecture (density and legibility) --------------------
    buildRegionStructure(space, def, rng);

    // --- scatter props (dressing, non-blocking or low-blocking) ------------
    scatterProps(space, def, rng);

    // --- spawn points ------------------------------------------------------
    space.spawnPoints.push({
      id: 'default',
      x: (x0 + x1) / 2,
      z: (z0 + z1) / 2,
      y: 0,
    });

    // --- nav grid ----------------------------------------------------------
    space.nav = new NavGrid({
      bounds: { minX: x0, maxX: x1, minZ: z0, maxZ: z1 },
      cellSize: def.indoor ? WORLD.NAV_CELL_SIZE_INTERIOR : WORLD.NAV_CELL_SIZE,
      agentRadius: WORLD.NAV_AGENT_RADIUS,
      slopeLimitDeg: WORLD.NAV_MAX_SLOPE_DEG,
      minHeadroom: WORLD.NAV_MIN_HEADROOM,
    });

    const marks = [];
    for (const door of space.doors) {
      marks.push({ x: door.world.x, z: door.world.z, type: CELL.DOORWAY, tag: 1 });
      // Carve a short throat so the doorway is never sealed by erosion.
      const navCell = def.indoor ? WORLD.NAV_CELL_SIZE_INTERIOR : WORLD.NAV_CELL_SIZE;
      for (let i = 1; i <= 3; i++) {
        marks.push({ x: door.world.x + door.inward.x * i * navCell,
                     z: door.world.z + door.inward.z * i * navCell,
                     type: CELL.DOORWAY, tag: 1 });
      }
    }
    for (const h of space.hidingSpots) marks.push({ x: h.x, z: h.z, type: CELL.HIDE, tag: 2 });
    for (const s of space.coverSpots) marks.push({ x: s.x, z: s.z, type: CELL.WALKABLE, tag: 3 });

    // Sample feet height at the region's dominant elevation so interiors with
    // raised floors (the ziggurat terrace) rasterise correctly.
    space.navOptions = { marks, agentHeight: MOVE.CAPSULE_HEIGHT, sampleFeetY: space.elevation };
    space.nav.build(space.collision, space.navOptions);
    space.pathfinder = new Pathfinder(space.nav);

    // The arrival point is the first doorway, not the geometric centroid. A
    // centroid spawn can land inside a massif, a pool or a wall — which is what
    // made the ziggurat terrace unreachable from its own spawn.
    if (space.doors.length) {
      const d = space.doors[0];
      const ax = d.world.x + d.inward.x * 1.6;
      const az = d.world.z + d.inward.z * 1.6;
      const cell = space.nav.nearestWalkable(ax, az, 24);
      if (cell) {
        const wp = space.nav.cellToWorld(cell.col, cell.row);
        space.spawnPoints.unshift({
          id: 'arrival', x: wp.x, z: wp.z,
          y: space.nav.heightAt(cell.col, cell.row),
        });
      }
    }

    // Force-open every doorway in the grid. A sealed exit is a P0 (§19) — the
    // player must never be permanently stuck — so we guarantee it structurally.
    for (const door of space.doors) {
      space.nav.carve(door.world.x, door.world.z, CELL.DOORWAY, 1);
      const inner = { x: door.world.x + door.inward.x * 1.0, z: door.world.z + door.inward.z * 1.0 };
      space.nav.carve(inner.x, inner.z, CELL.WALKABLE, 1);
      door.spawn = {
        x: inner.x,
        z: inner.z,
        y: space.nav.heightAtWorld(inner.x, inner.z),
      };
    }

    // Guarantee, not hope: retract generated structure until every landmark is
    // reachable from the arrival point.
    this._repairReachability(space);

    reprojectSpawnsOntoNav(space);

    space.built = true;
    space.buildTimeMs = nowMs() - t0;
    this.buildTimes[def.id] = space.buildTimeMs;
    this.diagnostics.regionsBuilt++;
    this.diagnostics.colliders += space.collision.colliders.length;
    this.diagnostics.navCells += space.nav.stats.total;
    this.diagnostics.walkableCells += space.nav.stats.walkable;
    return space;
  }

  /**
   * Move the player through a doorway.
   * @returns {{ok:boolean, regionId?:string, spawn?:{x,y,z}, reason?:string}}
   */
  travelThroughDoor(fromRegionId, doorId) {
    const from = this.region(fromRegionId);
    const door = from.doors.find((d) => d.id === doorId);
    if (!door) return { ok: false, reason: 'unknown-door' };
    const target = this.region(door.toRegion);
    // Arrive at the reciprocal door so the player never materialises in a wall.
    const back = target.doorTo(fromRegionId);
    const spawn = back?.spawn ?? target.spawnPoints[0];
    this.currentRegionId = target.id;
    this.transitions.push({ from: fromRegionId, to: target.id, doorId, at: nowMs() });
    return { ok: true, regionId: target.id, spawn: { ...spawn } };
  }

  /**
   * Automatic transition when the player steps onto a doorway cell.
   * @returns {object|null} transition result, or null if the player stays put.
   */
  updatePlayerRegion(pos, regionId = this.currentRegionId, radius = 0.9) {
    const space = this.region(regionId);
    for (const door of space.doors) {
      const dist = Math.hypot(door.world.x - pos.x, door.world.z - pos.z);
      if (dist <= radius) {
        return this.travelThroughDoor(regionId, door.id);
      }
    }
    return null;
  }

  /**
   * Validate-and-repair reachability.
   *
   * Procedural structure scatter can seal a landmark even with generous
   * clearance, because sealing is an emergent property of several placements
   * together, not of any single one. Rather than tune padding constants until
   * the tests happen to pass, this pass *proves* the invariant: it flood-fills
   * from the arrival point, and while any landmark is unreachable it retracts
   * the newest generated structure near that landmark and rebuilds the nav grid.
   *
   * Only colliders tagged `structure: true` are ever retracted, so authored
   * architecture (walls, doorways, landmarks) is never removed. Landmarks the
   * story deliberately seals declare `enclosed: true` and are judged on outside
   * approachability instead.
   */
  _repairReachability(space) {
    const structures = space.collision.colliders.filter((c) => c.structure === true);
    space.repair = { iterations: 0, retracted: 0, unresolved: [] };
    if (!structures.length) return space.repair;

    const maxIterations = 30;
    for (let i = 0; i < maxIterations; i++) {
      const spawn = space.spawnPoints[0];
      const fill = space.nav.floodFill(spawn.x, spawn.z);
      if (!fill.ok) break;
      const blocked = space.landmarks.filter((lm) => !landmarkReachable(space, fill, lm));
      if (!blocked.length) break;

      space.repair.iterations = i + 1;
      const culprit = nearestEnabledStructure(structures, blocked, 18);
      if (!culprit) {
        space.repair.unresolved = blocked.map((b) => b.id);
        break;
      }
      culprit.enabled = false;
      space.repair.retracted++;
      space.nav.build(space.collision, space.navOptions);
      // The arrival spawn may itself have been standing on retracted geometry.
      if (!space.nav.isWalkableAt(spawn.x, spawn.z)) {
        const cell = space.nav.nearestWalkable(spawn.x, spawn.z, 24);
        if (cell) {
          const wp = space.nav.cellToWorld(cell.col, cell.row);
          space.spawnPoints[0] = { id: spawn.id, x: wp.x, z: wp.z, y: space.nav.heightAt(cell.col, cell.row) };
        }
      }
    }
    return space.repair;
  }

  /** Full world report for reviewer and CEO documents. */
  report() {
    const rows = [];
    for (const [id, space] of this.regionSpaces) {
      rows.push({
        id,
        indoor: space.isIndoor,
        colliders: space.collision.colliders.length,
        landmarks: space.landmarks.length,
        doors: space.doors.length,
        navCells: space.nav.stats.total,
        walkable: space.nav.stats.walkable,
        walkablePct: space.nav.stats.total
          ? Math.round((space.nav.stats.walkable / space.nav.stats.total) * 1000) / 10
          : 0,
        buildMs: Math.round(space.buildTimeMs * 100) / 100,
      });
    }
    return { regions: rows, ...this.diagnostics, totalBuildTimeMs: this.totalBuildTimeMs };
  }
}

/** Smooth ramp profile so a descent has no discontinuous lip. */
function smoothstepRamp(t) { return smoothstep(clamp(t, 0, 1)); }

/* ------------------------------------------------------------- doorway plan */

/**
 * Distribute doorways around a region's perimeter, one per connection, and
 * record the inward normal for each so spawns and nav carving point inside.
 */
function planDoors(def, connects) {
  const [x0, x1] = def.bounds.x;
  const [z0, z1] = def.bounds.z;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const w = x1 - x0;
  const d = z1 - z0;

  // Sides ordered so that doors spread out rather than clustering.
  const sides = [
    { name: 'north', axis: 'z', at: z0, span: [x0, x1], inward: { x: 0, z: 1 } },
    { name: 'south', axis: 'z', at: z1, span: [x0, x1], inward: { x: 0, z: -1 } },
    { name: 'west',  axis: 'x', at: x0, span: [z0, z1], inward: { x: 1, z: 0 } },
    { name: 'east',  axis: 'x', at: x1, span: [z0, z1], inward: { x: -1, z: 0 } },
  ];

  const plan = [];
  const used = new Map(); // side name -> count

  connects.forEach((targetId, i) => {
    const side = sides[i % sides.length];
    const n = used.get(side.name) ?? 0;
    used.set(side.name, n + 1);

    // Nominal position along the side: centred, then offset symmetrically.
    const spanLen = side.span[1] - side.span[0];
    const slots = Math.max(1, Math.ceil(connects.length / 4));
    const nominalT = clamp(slots === 1 ? 0.5 : (0.5 + (n - (slots - 1) / 2) * (0.62 / slots)), 0.16, 0.84);

    // A doorway placed purely geometrically can land directly behind an authored
    // landmark. In the brothers' wing the south door was centred at x=0 and Evan's
    // room is centred at (0, 10), so the room's back wall stood 1.7 m inside the
    // threshold — the player arrived from the kitchen facing a plaster wall. The
    // door is therefore placed at the position nearest the nominal slot that
    // keeps its throat clear of every landmark in the region.
    // LANDMARKS_BY_REGION holds ids, so resolve them to the landmark records.
    const lms = (LANDMARKS_BY_REGION[def.id] ?? [])
      .map((id) => LANDMARKS.find((l) => l.id === id))
      .filter(Boolean);
    const throatClearance = (wx, wz) => {
      if (!lms.length) return Infinity;
      // Score both the threshold and a point 1.6 m inside it: the arrival spot
      // has to be usable, not just the door cell itself.
      const tx = wx + side.inward.x * 1.6, tz = wz + side.inward.z * 1.6;
      let worst = Infinity;
      for (const l of lms) {
        const d = Math.min(
          Math.hypot(l.pos[0] - wx, l.pos[2] - wz),
          Math.hypot(l.pos[0] - tx, l.pos[2] - tz),
        );
        if (d < worst) worst = d;
      }
      return worst;
    };

    let t = nominalT;
    if (lms.length) {
      let bestScore = -Infinity;
      for (let k = 0; k <= 32; k++) {
        const cand = clamp(0.16 + (0.68 * k) / 32, 0.16, 0.84);
        const ax = side.axis === 'z' ? side.span[0] + spanLen * cand : side.at;
        const az = side.axis === 'z' ? side.at : side.span[0] + spanLen * cand;
        const clr = throatClearance(ax, az);
        // Clearance matters up to 6 m; beyond that it is already comfortable, so
        // extra distance stops buying anything and the nominal slot wins back.
        const score = Math.min(clr, 6.0) * 3.0 - Math.abs(cand - nominalT) * spanLen;
        if (score > bestScore) { bestScore = score; t = cand; }
      }
    }
    const along = side.span[0] + spanLen * t;

    let wx, wz;
    if (side.axis === 'z') { wx = along; wz = side.at; }
    else { wx = side.at; wz = along; }

    plan.push({
      id: `door-${def.id}-${targetId}`,
      toRegion: targetId,
      side: side.name,
      axis: side.axis,
      x: wx,
      z: wz,
      inward: side.inward,
      span: spanLen,
    });
  });

  // Vertical links (cellar stair, terrace) sit at the centre of the floor.
  if (def.vertical && plan.length === 0) {
    plan.push({
      id: `door-${def.id}-vertical`, toRegion: null, side: 'centre', axis: 'y',
      x: cx, z: cz, inward: { x: 0, z: 1 }, span: Math.min(w, d),
    });
  }
  void w; void d;
  return plan;
}

/**
 * Build the four perimeter walls, leaving an opening at each planned doorway.
 * Each wall is split into segments so the opening is a real gap in the
 * collision data — not a thin wall the camera can see through.
 */
function buildPerimeter(space, def, doorPlan, wallH, wallMat) {
  const [x0, x1] = def.bounds.x;
  const [z0, z1] = def.bounds.z;
  // Every wall, lintel and door sill sits on the LOCAL floor. In a flat region
  // that is just the elevation; in a descending stairwell the side walls run
  // down with the flight instead of floating 3.1 m above the bottom landing —
  // which would let the player walk straight through them.
  const floorAt = (x, z) => (space.collision.heightFn
    ? space.collision.heightAt(x, z)
    : space.elevation);
  const baseY = space.elevation;

  const doorsBySide = { north: [], south: [], west: [], east: [] };
  for (const dp of doorPlan) {
    if (doorsBySide[dp.side]) doorsBySide[dp.side].push(dp);
  }
  for (const key of Object.keys(doorsBySide)) doorsBySide[key].sort((a, b) => (a.axis === 'z' ? a.x - b.x : a.z - b.z));

  // Long runs are cut into <= 2 m chunks so each can follow the floor. The
  // chunk ends overlap by WALL_T (wallCollider extends a run by its thickness),
  // so subdividing never opens a seam. In a flat region every chunk resolves to
  // the same height and the result is identical to one uncut wall.
  const addWallSegment = (ax, az, bx, bz, tag) => {
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.02) return;
    const chunks = Math.max(1, Math.ceil(len / 2.0));
    for (let c = 0; c < chunks; c++) {
      const t0 = c / chunks, t1 = (c + 1) / chunks;
      const sx = ax + (bx - ax) * t0, sz = az + (bz - az) * t0;
      const ex = ax + (bx - ax) * t1, ez = az + (bz - az) * t1;
      const fy = floorAt((sx + ex) / 2, (sz + ez) / 2);
      space.collision.add(wallCollider(sx, sz, ex, ez, fy - 0.6, wallH + 0.6, WALL_T, {
        kind: 'wall', blocksMovement: true, blocksSight: true, blocksCamera: true,
        walkableTop: def.indoor ? false : true, material: wallMat, region: def.id, id: tag,
      }));
    }
  };

  const halfDoor = DOOR_W / 2;

  // North and south walls run along X.
  for (const side of ['north', 'south']) {
    const zc = side === 'north' ? z0 : z1;
    const doors = doorsBySide[side];
    let cursor = x0;
    for (const dp of doors) {
      addWallSegment(cursor, zc, dp.x - halfDoor, zc, `wall-${side}`);
      // Lintel above the opening keeps the wall visually continuous and stops
      // the camera floating over the doorway.
      space.collision.add(boxCollider(
        dp.x, floorAt(dp.x, zc) + DOOR_H + (wallH - DOOR_H) / 2, zc,
        DOOR_W, wallH - DOOR_H, WALL_T,
        { kind: 'lintel', blocksMovement: true, blocksSight: true, blocksCamera: true,
          material: wallMat, region: def.id },
      ));
      cursor = dp.x + halfDoor;
      _registerDoor(space, dp, def, floorAt(dp.x, zc));
    }
    addWallSegment(cursor, zc, x1, zc, `wall-${side}`);
  }

  // West and east walls run along Z.
  for (const side of ['west', 'east']) {
    const xc = side === 'west' ? x0 : x1;
    const doors = doorsBySide[side];
    let cursor = z0;
    for (const dp of doors) {
      addWallSegment(xc, cursor, xc, dp.z - halfDoor, `wall-${side}`);
      space.collision.add(boxCollider(
        xc, floorAt(xc, dp.z) + DOOR_H + (wallH - DOOR_H) / 2, dp.z,
        WALL_T, wallH - DOOR_H, DOOR_W,
        { kind: 'lintel', blocksMovement: true, blocksSight: true, blocksCamera: true,
          material: wallMat, region: def.id },
      ));
      cursor = dp.z + halfDoor;
      _registerDoor(space, dp, def, floorAt(xc, dp.z));
    }
    addWallSegment(xc, cursor, xc, z1, `wall-${side}`);
  }
}

function _registerDoor(space, dp, def, baseY) {
  space.doors.push({
    id: dp.id,
    toRegion: dp.toRegion,
    side: dp.side,
    world: { x: dp.x, y: baseY, z: dp.z },
    inward: dp.inward,
    spawn: { x: dp.x + dp.inward.x, y: baseY, z: dp.z + dp.inward.z },
    width: DOOR_W,
    height: DOOR_H,
  });
}

/* ------------------------------------------------------------- landmarks */

/**
 * Build collision + dressing for a landmark, keyed on its architectural `kind`.
 * Everything here obeys §26: mud brick, baked brick, plaster, timber, reed.
 * No kind produces a tower, a pointed arch or any modern silhouette.
 */
function buildLandmark(space, lm, def, rng) {
  const [x, y, z] = lm.pos;
  // In a descending region pos[1] is an offset above the LOCAL floor; elsewhere
  // it stays an offset above the region's nominal elevation, exactly as authored.
  const floorY = def.descent && space.collision.heightFn
    ? space.collision.heightAt(x, z)
    : (space.elevation ?? 0);
  const baseY = floorY + (y ?? 0);
  const add = (c) => space.collision.add(c);
  const solid = (cx, cy, cz, sx, sy, sz, kind, material, extra = {}) =>
    add(boxCollider(cx, cy, cz, sx, sy, sz, {
      kind, material, region: def.id, blocksMovement: true, blocksSight: true,
      blocksCamera: true, walkableTop: false, ...extra,
    }));

  switch (lm.kind) {
    case 'gatehouse': {
      solid(x - 3.4, baseY + 2.6, z, 1.4, 5.2, 3.2, 'gatehouse', 'bakedBrick');
      solid(x + 3.4, baseY + 2.6, z, 1.4, 5.2, 3.2, 'gatehouse', 'bakedBrick');
      solid(x, baseY + 5.4, z, 8.2, 1.0, 3.2, 'lintel', 'bakedBrick');
      space.coverSpots.push({ x: x - 3.4, z: z + 2.4, height: 1.6 });
      space.coverSpots.push({ x: x + 3.4, z: z + 2.4, height: 1.6 });
      break;
    }
    case 'basin':
      solid(x, baseY + 0.35, z, 2.6, 0.7, 2.6, 'basin', 'limestone', { walkableTop: false });
      break;
    case 'palmGrove': {
      // Palm trunks are thin blocking columns; the crown is dressing only.
      for (let i = 0; i < 6; i++) {
        const a = rng.range(0, Math.PI * 2);
        const r = rng.range(1.2, 4.6);
        solid(x + Math.cos(a) * r, baseY + 2.4, z + Math.sin(a) * r,
          0.42, 4.8, 0.42, 'palm', 'palmWood');
      }
      space.props.push({ kind: 'palmCanopy', x, y: baseY + 4.6, z, radius: 6, material: 'reed' });
      break;
    }
    case 'stele':
      solid(x, baseY + 1.15, z, 0.9, 2.3, 0.5, 'stele', 'basalt');
      break;
    case 'bench':
      solid(x, baseY + 0.225, z, 3.0, 0.45, 0.9, 'bench', 'mudBrick',
        { walkableTop: true, stepHeight: 0.5 });
      break;
    case 'brazier':
      solid(x, baseY + 0.55, z, 0.7, 1.1, 0.7, 'brazier', 'bronze');
      space.props.push({ kind: 'flame', x, y: baseY + 1.25, z, radius: 0.4, light: 'torch' });
      break;
    case 'stair': {
      if (def.descent) {
        // The floor already IS the flight (see the stepped heightFn). Adding
        // treads here would float them above the ground at one end and bury
        // them at the other, which is what sealed this stairwell. What a real
        // mud-brick stair has that a bare ramp does not is a pair of stringer
        // cheeks holding the treads, so that is what gets built.
        const { fromZ, toZ, depth } = def.descent;
        const run = Math.abs(fromZ - toZ);
        const midZ = (fromZ + toZ) / 2;
        const midY = space.elevation - depth / 2;
        for (const side of [-1, 1]) {
          solid(x + side * 1.7, midY + 0.45, midZ, 0.4, depth + 1.5, run,
            'stairStringer', 'bakedBrick');
        }
        break;
      }
      // Freestanding stepped mud-brick stair: real walkable tops, so vertical
      // traversal works and the nav grid records rising heights. The first tread
      // starts AT the landmark position, making the landmark itself the low
      // (approachable) end of the flight.
      const steps = 8;
      const rise = 0.32;
      const run = 0.46;
      for (let i = 0; i < steps; i++) {
        solid(x, baseY + rise * (i + 0.5), z + run * i,
          3.0, rise, run, 'stair', 'bakedBrick', { walkableTop: true, stepHeight: rise + 0.05 });
      }
      break;
    }
    case 'jarRow': {
      for (let i = 0; i < 5; i++) {
        solid(x + (i - 2) * 1.15, baseY + 0.62, z, 0.92, 1.24, 0.92, 'jar', 'terracotta');
      }
      space.coverSpots.push({ x, z: z + 1.2, height: 1.2 });
      break;
    }
    case 'relief':
      solid(x, baseY + 1.5, z, 5.4, 3.0, 0.45, 'relief', 'bakedBrickGl');
      break;
    case 'guardPost':
      solid(x, baseY + 0.25, z, 1.8, 0.50, 1.8, 'guardPost', 'mudBrick',
        { walkableTop: true, stepHeight: 0.55 });
      break;
    case 'well':
      solid(x, baseY + 0.5, z, 1.9, 1.0, 1.9, 'well', 'bakedBrick');
      break;
    case 'offeringTable':
      solid(x, baseY + 0.25, z, 2.4, 0.50, 1.4, 'offeringTable', 'limestone',
        { walkableTop: true, stepHeight: 0.55 });
      break;
    case 'dais':
      buildPlatform(space, def, x, space.elevation, z, 5.0, 3.4, 0.54, 'dais', 'bakedBrick');
      break;
    case 'bed':
      // A low pallet on a palm-wood frame.
      solid(x, baseY + 0.21, z, 2.0, 0.42, 3.0, 'bed', 'palmWood',
        { walkableTop: true, stepHeight: 0.47, blocksSight: false });
      break;
    case 'table':
      solid(x, baseY + 0.225, z, 3.2, 0.45, 1.5, 'table', 'poplarWood',
        { walkableTop: true, stepHeight: 0.5 });
      break;
    case 'houseShrine':
      solid(x, baseY + 0.9, z, 1.6, 1.8, 1.0, 'shrine', 'plaster');
      space.props.push({ kind: 'shrineLamp', x, y: baseY + 1.9, z, light: 'torch' });
      break;
    case 'chest':
      solid(x, baseY + 0.25, z, 1.3, 0.50, 0.8, 'chest', 'poplarWood',
        { walkableTop: true, stepHeight: 0.55 });
      break;
    case 'oilLamp':
      solid(x, baseY + 0.75, z, 0.3, 1.5, 0.3, 'lampStand', 'bronze');
      space.props.push({ kind: 'flame', x, y: baseY + 1.55, z, radius: 0.18, light: 'lamp' });
      break;
    case 'rug':
      space.props.push({ kind: 'rug', x, y: baseY + 0.02, z, w: 4.2, d: 3.0, material: 'wool' });
      break;
    case 'tabletShelf':
      solid(x, baseY + 0.95, z, 2.2, 1.9, 0.6, 'shelf', 'poplarWood');
      break;
    case 'door':
      // A closed interior door: blocking until unlocked by the story.
      solid(x, baseY + 1.2, z, DOOR_W, DOOR_H, 0.22, 'door', 'palmWood',
        { id: lm.id, enabled: lm.locked !== true });
      if (lm.locked) {
        space.props.push({ kind: 'lockedDoor', x, y: baseY, z, id: lm.id, key: lm.key ?? null });
      }
      break;
    case 'feastTable': {
      // Low feast tables: diners sat on the floor or on reed mats, so the table
      // top stays within step range and never walls off the hall floor.
      for (let i = 0; i < 3; i++) {
        solid(x, baseY + 0.20, z + (i - 1) * 5.2, 6.4, 0.40, 1.7, 'feastTable', 'poplarWood',
          { walkableTop: true, stepHeight: 0.45 });
      }
      break;
    }
    case 'hearth':
      solid(x, baseY + 0.3, z, 2.6, 0.6, 2.6, 'hearth', 'bakedBrick', { walkableTop: false });
      space.props.push({ kind: 'fire', x, y: baseY + 0.6, z, radius: 1.1, light: 'hearth' });
      break;
    case 'wineJars': {
      for (let i = 0; i < 4; i++) {
        solid(x + (i % 2) * 1.2 - 0.6, baseY + 0.7, z + Math.floor(i / 2) * 1.3 - 0.65,
          1.0, 1.4, 1.0, 'jar', 'terracotta');
      }
      space.coverSpots.push({ x, z: z + 1.6, height: 1.4 });
      break;
    }
    case 'cupTable':
      solid(x, baseY + 0.21, z, 1.8, 0.42, 1.2, 'table', 'poplarWood',
        { walkableTop: true, stepHeight: 0.47 });
      break;
    case 'lyreStand':
      solid(x, baseY + 0.55, z, 0.9, 1.1, 0.7, 'lyre', 'poplarWood');
      break;
    case 'reedScreen':
      // Reed screens hide without blocking movement — critical for stealth
      // readability in the feast hall.
      add(boxCollider(x, baseY + 1.1, z, 3.0, 2.2, 0.25, {
        kind: 'reedScreen', material: 'reed', region: def.id,
        blocksMovement: false, blocksSight: true, blocksCamera: false,
        walkableTop: false, id: lm.id,
      }));
      space.hidingSpots.push({ id: lm.id, x, y: baseY, z, capacity: 2, cover: 'screen' });
      break;
    case 'bedroom': {
      // A brothers' room: three solid walls plus one wall carrying a 1.9 m
      // opening. The opening faces the region centre so the room always opens
      // onto the corridor — a doorway facing away would seal the room and make
      // the Chapter 3 search of that bedroom impossible (P0, §19).
      const rw = 4.6, rd = 4.6;
      const centreZ = (def.bounds.z[0] + def.bounds.z[1]) / 2;
      const openSouth = z <= centreZ;          // room north of centre -> open +Z
      const sign = openSouth ? 1 : -1;

      // Back wall (opposite the opening) and both side walls.
      solid(x, baseY + 1.7, z - sign * rd / 2, rw, WALL_H_INTERIOR, WALL_T, 'wall', 'plaster');
      solid(x - rw / 2, baseY + 1.7, z, WALL_T, WALL_H_INTERIOR, rd, 'wall', 'plaster');
      solid(x + rw / 2, baseY + 1.7, z, WALL_T, WALL_H_INTERIOR, rd, 'wall', 'plaster');
      // Opening wall, split around the doorway, with a lintel above it.
      const ow = z + sign * rd / 2;
      solid(x - (rw / 4 + DOOR_W / 4), baseY + 1.7, ow, rw / 2 - DOOR_W / 2, WALL_H_INTERIOR, WALL_T, 'wall', 'plaster');
      solid(x + (rw / 4 + DOOR_W / 4), baseY + 1.7, ow, rw / 2 - DOOR_W / 2, WALL_H_INTERIOR, WALL_T, 'wall', 'plaster');
      solid(x, baseY + DOOR_H + (WALL_H_INTERIOR - DOOR_H) / 2, ow, DOOR_W, WALL_H_INTERIOR - DOOR_H, WALL_T, 'lintel', 'plaster');

      // Furniture is pushed against the side walls so the room centre stays
      // clear: the centre is where the player stands to search the room.
      // Furniture is held tight to the side walls so a clear central lane of at
      // least 1.5 m remains. That lane is where the player stands to search the
      // room, and it must survive agent-radius erosion.
      solid(x - rw / 2 + 0.88, baseY + 0.21, z - sign * 0.9, 1.7, 0.42, 2.6, 'bed', 'palmWood',
        { walkableTop: true, stepHeight: 0.47 });
      solid(x + rw / 2 - 0.78, baseY + 0.25, z + sign * 0.7, 0.9, 0.50, 1.4, 'chest', 'poplarWood',
        { walkableTop: true, stepHeight: 0.55 });
      space.props.push({ kind: 'rug', x, y: baseY + 0.02, z: z + sign * 0.4, w: 2.4, d: 1.9, material: 'wool' });
      break;
    }
    case 'corridor':
      space.props.push({ kind: 'floorInlay', x, y: baseY + 0.015, z, w: 6, d: 6, material: 'bakedBrick' });
      break;
    case 'writingDesk':
      // A scribe's low desk; writing was done seated on the floor.
      solid(x, baseY + 0.225, z, 1.6, 0.45, 0.9, 'desk', 'poplarWood',
        { walkableTop: true, stepHeight: 0.5 });
      break;
    case 'oven':
      solid(x, baseY + 0.85, z, 2.2, 1.7, 2.0, 'oven', 'clay');
      space.props.push({ kind: 'fire', x, y: baseY + 0.5, z: z + 1.0, radius: 0.6, light: 'hearth' });
      break;
    case 'prepBench':
      solid(x, baseY + 0.25, z, 3.0, 0.50, 1.2, 'bench', 'poplarWood',
        { walkableTop: true, stepHeight: 0.55 });
      break;
    case 'herbShelf':
      solid(x, baseY + 1.0, z, 3.0, 2.0, 0.5, 'shelf', 'palmWood');
      break;
    case 'crateStack': {
      for (let i = 0; i < 4; i++) {
        solid(x + (i % 2) * 1.3 - 0.65, baseY + 0.55 + Math.floor(i / 2) * 1.1, z,
          1.2, 1.1, 1.2, 'crate', 'palmWood', { walkableTop: true });
      }
      space.coverSpots.push({ x, z: z + 1.4, height: 1.1 });
      break;
    }
    case 'sackRow': {
      for (let i = 0; i < 3; i++) {
        add(boxCollider(x + (i - 1) * 1.4, baseY + 0.5, z, 1.2, 1.0, 1.0, {
          kind: 'sack', material: 'wool', region: def.id,
          blocksMovement: false, blocksSight: true, blocksCamera: false, walkableTop: false,
        }));
      }
      space.hidingSpots.push({ id: lm.id, x, y: baseY, z, capacity: 2, cover: 'sacks' });
      break;
    }
    case 'shelfRack':
      solid(x, baseY + 1.1, z, 3.4, 2.2, 0.7, 'shelf', 'palmWood');
      break;
    case 'hatch':
      solid(x, baseY + 0.1, z, 1.6, 0.2, 1.6, 'hatch', 'palmWood', { walkableTop: true });
      break;
    case 'doorRing':
      space.props.push({ kind: 'doorRing', x, y: baseY + 1.3, z, material: 'bronze' });
      break;
    case 'cage': {
      // The holding cage: bars block sight and movement, but the front is a
      // gate the story opens.
      const cw = 3.4, cd = 3.4;
      solid(x, baseY + 1.1, z - cd / 2, cw, 2.2, 0.18, 'cageWall', 'iron');
      solid(x - cw / 2, baseY + 1.1, z, 0.18, 2.2, cd, 'cageWall', 'iron');
      solid(x + cw / 2, baseY + 1.1, z, 0.18, 2.2, cd, 'cageWall', 'iron');
      // The gate is a named, toggleable collider: the story opens it in
      // Chapter 4. It stays solid until then, which is why the cage interior is
      // unreachable from the cellar floor — canonical, not a defect.
      add(boxCollider(x, baseY + 1.1, z + cd / 2, cw, 2.2, 0.18, {
        kind: 'cageGate', material: 'iron', region: def.id,
        id: lm.gateId ?? `${lm.id}-gate`,
        blocksMovement: true, blocksSight: true, blocksCamera: false, enabled: true,
      }));
      break;
    }
    case 'pillar':
      solid(x, baseY + 1.7, z, 1.1, 3.4, 1.1, 'pillar', 'bakedBrick');
      space.coverSpots.push({ x, z, height: 1.1 });
      break;
    case 'barrelRow': {
      for (let i = 0; i < 4; i++) {
        solid(x, baseY + 0.6, z + (i - 1.5) * 1.5, 1.0, 1.2, 1.0, 'jar', 'terracotta');
      }
      break;
    }
    case 'chain':
      space.props.push({ kind: 'chain', x, y: baseY + 1.4, z, material: 'iron' });
      break;
    case 'drain':
      add(boxCollider(x, baseY + 0.05, z, 2.6, 0.1, 1.6, {
        kind: 'drain', material: 'bitumen', region: def.id,
        blocksMovement: false, blocksSight: false, blocksCamera: false, walkableTop: true,
      }));
      break;
    case 'stain':
      space.props.push({ kind: 'stain', x, y: baseY + 0.02, z, radius: 0.9, material: 'blood' });
      break;
    case 'archway': {
      // A mud-brick arch: two piers plus a lintel. NOT a pointed Gothic arch.
      solid(x - 1.8, baseY + 1.6, z, 1.0, 3.2, 1.4, 'pier', 'bakedBrick');
      solid(x + 1.8, baseY + 1.6, z, 1.0, 3.2, 1.4, 'pier', 'bakedBrick');
      solid(x, baseY + 3.5, z, 4.6, 0.7, 1.4, 'lintel', 'bakedBrick');
      break;
    }
    case 'alcove': {
      solid(x - 1.3, baseY + 1.2, z, 0.5, 2.4, 2.4, 'alcoveWall', 'mudBrick');
      solid(x + 1.3, baseY + 1.2, z, 0.5, 2.4, 2.4, 'alcoveWall', 'mudBrick');
      space.hidingSpots.push({ id: lm.id, x, y: baseY, z, capacity: 1, cover: 'alcove' });
      break;
    }
    case 'propTable':
      solid(x, baseY + 0.4, z, 1.5, 0.8, 1.0, 'table', 'palmWood', { walkableTop: true });
      break;
    case 'channel':
      add(boxCollider(x, baseY - 0.1, z, 3.4, 0.2, 40, {
        kind: 'water', material: 'water', region: def.id,
        blocksMovement: false, blocksSight: false, blocksCamera: false, walkableTop: true,
      }));
      break;
    case 'rubble': {
      for (let i = 0; i < 5; i++) {
        const a = rng.range(0, Math.PI * 2);
        const r = rng.range(0.4, 2.4);
        const h = rng.range(0.4, 1.3);
        solid(x + Math.cos(a) * r, baseY + h / 2, z + Math.sin(a) * r,
          rng.range(0.7, 1.6), h, rng.range(0.7, 1.6), 'rubble', 'mudBrick',
          { walkableTop: h <= 0.5, stepHeight: h });
      }
      break;
    }
    case 'grate':
      solid(x, baseY + 1.1, z, 2.0, 2.2, 0.2, 'grate', 'bronze');
      break;
    case 'ramp': {
      // Centred on the landmark so the rise sits where the map says it does.
      const steps = 6;
      const run = 2.4;
      for (let i = 0; i < steps; i++) {
        solid(x, baseY + 0.22 * (i + 0.5), z + (i - (steps - 1) / 2) * run,
          6.0, 0.22, run, 'ramp', 'silt', { walkableTop: true, stepHeight: 0.3 });
      }
      break;
    }
    case 'cityWall':
      solid(x, baseY + 3.0, z, 60, 6.0, 2.6, 'cityWall', 'bakedBrick');
      break;
    case 'stable': {
      solid(x - 2.6, baseY + 1.0, z, 0.35, 2.0, 5.0, 'stableWall', 'reed');
      solid(x + 2.6, baseY + 1.0, z, 0.35, 2.0, 5.0, 'stableWall', 'reed');
      solid(x, baseY + 2.2, z, 5.6, 0.35, 5.2, 'stableRoof', 'reed', { walkableTop: false });
      break;
    }
    case 'watchPost':
      solid(x, baseY + 1.1, z, 2.4, 2.2, 2.4, 'watchPost', 'mudBrick', { walkableTop: true, stepHeight: 2.2 });
      break;
    case 'kiln':
      solid(x, baseY + 1.1, z, 2.8, 2.2, 2.8, 'kiln', 'clay');
      space.props.push({ kind: 'fire', x, y: baseY + 0.8, z: z + 1.4, radius: 0.8, light: 'hearth' });
      break;
    case 'buttressRow': {
      for (let i = 0; i < 5; i++) {
        solid(x, baseY + 1.9, z + (i - 2) * 5.0, 1.6, 3.8, 1.2, 'buttress', 'mudBrick');
        space.coverSpots.push({ x: x - 1.4, z: z + (i - 2) * 5.0, height: 1.6 });
      }
      break;
    }
    case 'lamassu':
      solid(x, baseY + 1.7, z, 2.2, 3.4, 4.0, 'lamassu', 'limestone');
      break;
    case 'marketStall': {
      // Four posts plus a reed awning. Low counter is standable cover.
      for (const [ox, oz] of [[-1.6, -1.2], [1.6, -1.2], [-1.6, 1.2], [1.6, 1.2]]) {
        solid(x + ox, baseY + 1.15, z + oz, 0.16, 2.3, 0.16, 'stallPost', 'palmWood');
      }
      solid(x, baseY + 0.25, z, 3.6, 0.50, 1.4, 'stallCounter', 'poplarWood',
        { walkableTop: true, stepHeight: 0.55 });
      add(boxCollider(x, baseY + 2.5, z, 4.2, 0.18, 3.0, {
        kind: 'awning', material: 'reed', region: def.id,
        blocksMovement: false, blocksSight: true, blocksCamera: false, walkableTop: false,
      }));
      space.coverSpots.push({ x, z: z + 1.8, height: 1.0 });
      break;
    }
    case 'awningRow': {
      for (let i = 0; i < 3; i++) {
        add(boxCollider(x + (i - 1) * 5.0, baseY + 2.4, z, 4.4, 0.18, 3.2, {
          kind: 'awning', material: 'reed', region: def.id,
          blocksMovement: false, blocksSight: true, blocksCamera: false,
        }));
        solid(x + (i - 1) * 5.0 - 2.0, baseY + 1.2, z + 1.4, 0.16, 2.4, 0.16, 'stallPost', 'palmWood');
        solid(x + (i - 1) * 5.0 + 2.0, baseY + 1.2, z + 1.4, 0.16, 2.4, 0.16, 'stallPost', 'palmWood');
      }
      space.hidingSpots.push({ id: lm.id, x, y: baseY, z, capacity: 2, cover: 'awning' });
      break;
    }
    case 'platform':
      buildPlatform(space, def, x, space.elevation, z, 4.6, 3.4, 0.5, 'platform', 'bakedBrick');
      break;
    case 'alley': {
      // Narrow alley: two parallel walls with a 2.4 m gap. Wider than 2×agent
      // radius + erosion, so the nav grid keeps it open (§30 tight-navigation fix).
      solid(x - 1.5, baseY + 1.7, z, 0.6, 3.4, 10, 'alleyWall', 'mudBrick');
      solid(x + 1.5, baseY + 1.7, z, 0.6, 3.4, 10, 'alleyWall', 'mudBrick');
      space.hidingSpots.push({ id: lm.id, x, y: baseY, z, capacity: 1, cover: 'alley' });
      break;
    }
    case 'hut': {
      const hw = 4.4, hd = 4.4;
      solid(x, baseY + 1.4, z - hd / 2, hw, 2.8, WALL_T, 'hutWall', 'reed');
      solid(x - hw / 2, baseY + 1.4, z, WALL_T, 2.8, hd, 'hutWall', 'reed');
      solid(x + hw / 2, baseY + 1.4, z, WALL_T, 2.8, hd, 'hutWall', 'reed');
      solid(x - (hw / 4 + DOOR_W / 4), baseY + 1.4, z + hd / 2, hw / 2 - DOOR_W / 2, 2.8, WALL_T, 'hutWall', 'mudBrick');
      solid(x + (hw / 4 + DOOR_W / 4), baseY + 1.4, z + hd / 2, hw / 2 - DOOR_W / 2, 2.8, WALL_T, 'mudBrick');
      solid(x, baseY + 2.9, z, hw + 0.6, 0.35, hd + 0.6, 'flatRoof', 'reed', { walkableTop: true });
      break;
    }
    case 'courtyard':
      space.props.push({ kind: 'floorInlay', x, y: baseY + 0.015, z, w: 14, d: 14, material: 'bakedBrick' });
      break;
    case 'cella': {
      solid(x - 3.2, baseY + 2.0, z, 0.7, 4.0, 7.0, 'cellaWall', 'bakedBrickGl');
      solid(x + 3.2, baseY + 2.0, z, 0.7, 4.0, 7.0, 'cellaWall', 'bakedBrickGl');
      solid(x, baseY + 4.2, z, 7.1, 0.6, 7.2, 'cellaRoof', 'palmWood');
      solid(x, baseY + 0.9, z - 2.4, 2.2, 1.8, 1.4, 'cultStatue', 'gold');
      break;
    }
    case 'parapet':
      solid(x, baseY + 0.55, z, 12, 1.1, 0.7, 'parapet', 'bakedBrick', { walkableTop: true });
      break;
    case 'bridge': {
      // Low timber bridge over the canal. Deck top sits within agent step range
      // and both ends carry a single approach step, so the crossing is walkable
      // rather than a ledge the nav grid correctly refuses.
      const deckTop = 0.30;
      solid(x, baseY + deckTop / 2, z, 5.0, deckTop, 8.0, 'bridgeDeck', 'poplarWood',
        { walkableTop: true, stepHeight: deckTop + 0.12 });
      for (const sz of [-4.6, 4.6]) {
        solid(x, baseY + deckTop * 0.28, z + sz, 5.0, deckTop * 0.56, 1.2, 'bridgeStep', 'poplarWood',
          { walkableTop: true, stepHeight: deckTop });
      }
      solid(x - 2.6, baseY + deckTop + 0.45, z, 0.2, 0.9, 8.0, 'rail', 'palmWood');
      solid(x + 2.6, baseY + deckTop + 0.45, z, 0.2, 0.9, 8.0, 'rail', 'palmWood');
      break;
    }
    case 'mooring':
      solid(x, baseY + 0.14, z, 3.4, 0.28, 1.6, 'jetty', 'palmWood',
        { walkableTop: true, stepHeight: 0.4 });
      space.props.push({ kind: 'reedBoat', x: x + 2.6, y: baseY + 0.2, z, material: 'reed' });
      break;
    case 'reedBed': {
      for (let i = 0; i < 10; i++) {
        const a = rng.range(0, Math.PI * 2);
        const r = rng.range(0.5, 4.0);
        add(boxCollider(x + Math.cos(a) * r, baseY + 0.9, z + Math.sin(a) * r, 0.5, 1.8, 0.5, {
          kind: 'reed', material: 'reed', region: def.id,
          blocksMovement: false, blocksSight: true, blocksCamera: false,
        }));
      }
      space.hidingSpots.push({ id: lm.id, x, y: baseY, z, capacity: 2, cover: 'reeds' });
      break;
    }
    case 'vault': {
      // Sunken vault reached by a short descent — vertical connectivity test.
      const vy = baseY;
      solid(x - 3.0, vy + 1.3, z, 0.6, 2.6, 6.0, 'vaultWall', 'bakedBrick');
      solid(x + 3.0, vy + 1.3, z, 0.6, 2.6, 6.0, 'vaultWall', 'bakedBrick');
      solid(x, vy + 1.3, z - 3.0, 6.6, 2.6, 0.6, 'vaultWall', 'bakedBrick');
      solid(x, vy + 2.8, z, 6.6, 0.5, 6.6, 'vaultRoof', 'bakedBrick');
      for (let i = 0; i < 6; i++) {
        solid(x, vy + 0.21 * (i + 0.5), z + 3.0 + i * 0.55, 3.0, 0.21, 0.55, 'stair', 'bakedBrick',
          { walkableTop: true, stepHeight: 0.3 });
      }
      break;
    }
    case 'foundation': {
      for (let i = 0; i < 3; i++) {
        solid(x + (i - 1) * 4.2, baseY + 0.25, z, 3.6, 0.50, 2.2, 'foundation', 'mudBrick',
          { walkableTop: true, stepHeight: 0.55 });
      }
      break;
    }
    case 'dune': {
      // Dunes are terrain, not colliders; the height function already shapes
      // them. Add a crest marker so the nav grid records the rise.
      space.props.push({ kind: 'duneCrest', x, y: baseY, z, radius: 14 });
      break;
    }
    case 'camp': {
      solid(x, baseY + 0.35, z, 2.6, 0.7, 2.6, 'tentBase', 'wool');
      space.props.push({ kind: 'tent', x, y: baseY, z, radius: 3.2, material: 'wool' });
      space.hidingSpots.push({ id: lm.id, x, y: baseY, z, capacity: 1, cover: 'tent' });
      break;
    }
    case 'loom':
      solid(x, baseY + 0.9, z, 1.8, 1.8, 1.0, 'loom', 'palmWood');
      break;
    case 'cart':
      solid(x, baseY + 0.5, z, 2.6, 1.0, 1.5, 'cart', 'palmWood', { walkableTop: true });
      break;
    default:
      // Unknown kinds still get a low footprint so they are visible to nav and
      // never silently become a hole in the world.
      solid(x, baseY + 0.3, z, 1.2, 0.6, 1.2, lm.kind, 'mudBrick', { walkableTop: true });
      break;
  }

  return {
    id: lm.id, kind: lm.kind, en: lm.en, ar: lm.ar,
    x, y: baseY, z, interact: lm.interact ?? null,
    item: lm.item ?? null, sidequest: lm.sidequest ?? null,
    artifact: lm.artifact === true, locked: lm.locked === true,
    enclosed: lm.enclosed === true, gateId: lm.gateId ?? null,
  };
}

/**
 * Open or close a named dynamic collider (the cage gate, a locked door).
 * Returns false when the id is unknown so callers cannot silently no-op.
 */
export function setColliderEnabled(space, id, enabled) {
  const c = space.collision.colliders.find((x) => x.id === id);
  if (!c) return false;
  c.enabled = !!enabled;
  return true;
}

/**
 * Build a raised platform with a stepped perimeter approach.
 *
 * A bare platform taller than the nav grid's maximum climbable rise rasterises
 * as an obstacle you cannot get onto — the throne dais and the market labour
 * platform both failed that way. Adding a half-height step all round makes the
 * ascent two climbable increments, so the platform top becomes a genuine,
 * reachable level. Historically correct too: Mesopotamian daises and podiums are
 * approached by low mud-brick or baked-brick steps.
 */
function buildPlatform(space, def, x, floorY, z, w, d, rise, kind, material) {
  const stepRise = rise * 0.5;
  // Perimeter step.
  space.collision.add(boxCollider(x, floorY + stepRise * 0.5, z, w + 1.0, stepRise, d + 1.0, {
    kind: `${kind}Step`, material, region: def.id,
    blocksMovement: true, blocksSight: false, blocksCamera: true,
    walkableTop: true, stepHeight: stepRise + 0.08,
  }));
  // Platform top.
  space.collision.add(boxCollider(x, floorY + stepRise + (rise - stepRise) * 0.5, z, w, rise - stepRise, d, {
    kind, material, region: def.id,
    blocksMovement: true, blocksSight: true, blocksCamera: true,
    walkableTop: true, stepHeight: (rise - stepRise) + 0.08,
  }));
  space.coverSpots.push({ x, z: z + d * 0.5 + 0.6, height: stepRise, low: true });
}

/* ------------------------------------------------------- region structure */

/**
 * Regional architecture pass (Agent 08, §8: "dense, purposeful and believable").
 *
 * Landmark placement alone left exteriors 95–100% walkable — effectively empty
 * fields with a few props. This pass adds the structural fabric that makes each
 * space read as a real place: compound walls and alleys in the poor quarter,
 * buttressed facades and a pylon at the temple, embankments along the canal,
 * fallen masonry in the ruins, rock outcrops at the desert edge.
 *
 * Everything is drawn from the §26 allowed vocabulary — mud brick, baked brick,
 * plaster, timber, reed, blind niches, buttresses, flat roofs. No towers, no
 * pointed arches, no European medieval silhouettes.
 *
 * Placement rejects any spot that would crowd a landmark or seal a doorway, so
 * density can never cost reachability (that invariant is enforced by reach-test).
 */
function buildRegionStructure(space, def, rng) {
  const [x0, x1] = def.bounds.x;
  const [z0, z1] = def.bounds.z;
  const margin = 3.0;
  const add = (c) => space.collision.add(c);

  /**
   * Is a candidate point far enough from everything that must stay accessible?
   * Euclidean, not axis-wise: an axis-AND test let a long wall pass whenever it
   * was distant on one axis and adjacent on the other, which is how the poor
   * quarter's huts ended up with their doorways walled shut.
   */
  const clearPoint = (x, z, pad) => {
    for (const lm of space.landmarks) {
      if (Math.hypot(lm.x - x, lm.z - z) < pad) return false;
    }
    for (const d of space.doors) {
      if (Math.hypot(d.world.x - x, d.world.z - z) < pad + 2.2) return false;
    }
    for (const sp of space.spawnPoints) {
      if (Math.hypot(sp.x - x, sp.z - z) < pad + 1.5) return false;
    }
    return true;
  };

  /** Whole-footprint clearance for linear structures: sample along the run. */
  const clearSegment = (ax, az, bx, bz, pad) => {
    const len = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(2, Math.ceil(len / 1.0));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      if (!clearPoint(ax + (bx - ax) * t, az + (bz - az) * t, pad)) return false;
    }
    return true;
  };

  /** A mud-brick wall segment with the given run and thickness. */
  const wall = (ax, az, bx, bz, height, thickness, material, kind = 'compoundWall') => {
    const seg = wallCollider(ax, az, bx, bz, space.elevation, height, thickness, {
      kind, material, region: def.id,
      blocksMovement: true, blocksSight: height > 1.2, blocksCamera: true,
      walkableTop: height <= 0.6, stepHeight: height,
      structure: true,
    });
    add(seg);
    if (height > 1.2) space.coverSpots.push({ x: (ax + bx) / 2, z: (az + bz) / 2, height });
    return seg;
  };

  /** A square mud-brick pier — the Mesopotamian equivalent of a column. */
  const pier = (x, z, size, height, material = 'mudBrick') => {
    add(boxCollider(x, space.elevation + height / 2, z, size, height, size, {
      kind: 'pier', material, region: def.id,
      blocksMovement: true, blocksSight: true, blocksCamera: true, walkableTop: false,
      structure: true,
    }));
    space.coverSpots.push({ x, z, height: size });
  };

  /**
   * Try to place `count` items, rejecting crowded spots.
   * `place` returns false if the structure it intended to build is not clear,
   * in which case the attempt does not count against the placement budget.
   */
  const scatter = (count, pad, place) => {
    let placed = 0;
    for (let attempt = 0; attempt < count * 14 && placed < count; attempt++) {
      const x = rng.range(x0 + margin, x1 - margin);
      const z = rng.range(z0 + margin, z1 - margin);
      if (!clearPoint(x, z, pad)) continue;
      if (place(x, z) === false) continue;
      placed++;
    }
    return placed;
  };
  void clearSegment;

  switch (def.id) {
    case 'palace-court': {
      // Buttressed facade along the north wall and a pier colonnade framing the
      // approach to the hall stairs — the classic Babylonian palace front.
      for (let i = -3; i <= 3; i++) {
        if (i === 0) continue;                     // keep the stair axis clear
        pier(i * 6.2, 18, 1.5, 3.6, 'bakedBrick');
      }
      for (let i = -4; i <= 4; i++) {
        wall(-40 + i * 9, -42.4, -35.5 + i * 9, -42.4, 3.0, 1.4, 'mudBrick', 'buttress');
      }
      scatter(9, 5.5, (x, z) => (clearSegment(x - 3, z, x + 3, z, 4.5)
        ? wall(x - 3, z, x + 3, z, rng.range(1.6, 2.4), 0.7, 'mudBrick') : false));
      scatter(7, 4.5, (x, z) => pier(x, z, rng.range(1.0, 1.4), rng.range(2.2, 3.0)));
      break;
    }
    case 'palace-hall': {
      // Interior piers carrying the palm-beam roof.
      for (const px of [-8, 8]) {
        for (const pz of [-14, -8, 0, 8, 14]) {
          if (!clearPoint(px, pz, 2.6)) continue;
          pier(px, pz, 1.1, WALL_H_INTERIOR, 'plaster');
        }
      }
      break;
    }
    case 'feast-hall': {
      // Two rows of plastered piers carrying the palm-beam roof. A 26 m clear
      // span is not achievable with palm timber, so intermediate supports are
      // structurally necessary, not merely decorative (§26 authenticity).
      for (const px of [-9, 9]) {
        for (const pz of [-11, -6, 0, 6, 11]) {
          if (!clearPoint(px, pz, 2.6)) continue;
          pier(px, pz, 0.9, WALL_H_INTERIOR, 'plaster');
        }
      }
      break;
    }
    case 'poor-quarter': {
      // The warren: irregular compound walls forming alleys and small yards.
      // This is what makes the poor quarter feel lived-in and gives stealth
      // real sight-line breaks (§11 Agent 07).
      scatter(16, 6.5, (x, z) => {
        const len = rng.range(4.5, 11.0);
        const horizontal = rng.chance(0.5);
        const h = rng.range(2.0, 3.0);
        const ax = horizontal ? x - len / 2 : x;
        const az = horizontal ? z : z - len / 2;
        const bx = horizontal ? x + len / 2 : x;
        const bz = horizontal ? z : z + len / 2;
        if (!clearSegment(ax, az, bx, bz, 5.0)) return false;
        wall(ax, az, bx, bz, h, 0.55, 'mudBrick');
        return true;
      });
      // A few enclosed yards with a single gap, plus low rubble banks.
      scatter(4, 10.0, (x, z) => {
        const r = rng.range(3.0, 4.4);
        if (!clearSegment(x - r, z - r, x + r, z - r, 5.5)) return false;
        if (!clearSegment(x - r, z + r, x + r, z + r, 5.5)) return false;
        if (!clearSegment(x - r, z - r, x - r, z + r, 5.5)) return false;
        wall(x - r, z - r, x + r, z - r, 2.2, 0.5, 'mudBrick');
        wall(x - r, z + r, x + r, z + r, 2.2, 0.5, 'mudBrick');
        wall(x - r, z - r, x - r, z + r, 2.2, 0.5, 'mudBrick');
        // East side left open as the yard entrance.
        return true;
      });
      scatter(8, 4.0, (x, z) => pier(x, z, rng.range(0.8, 1.2), rng.range(1.4, 2.2), 'mudBrickDark'));
      break;
    }
    case 'market': {
      // Stall rows with back walls and aisle barriers; a crowded market must
      // break sight lines constantly.
      for (let i = -2; i <= 2; i++) {
        const z = i * 9;
        if (Math.abs(z) < 4) continue;
        for (const x of [-16, 8, 20]) {
          if (!clearSegment(x - 2.4, z - 1.6, x + 2.4, z - 1.6, 4.2)) continue;
          wall(x - 2.4, z - 1.6, x + 2.4, z - 1.6, 1.5, 0.4, 'reed', 'stallBack');
        }
      }
      scatter(10, 5.0, (x, z) => (clearSegment(x - 2.2, z, x + 2.2, z, 4.0)
        ? wall(x - 2.2, z, x + 2.2, z, rng.range(0.9, 1.4), 0.5, 'palmWood', 'aisleBarrier') : false));
      scatter(6, 4.5, (x, z) => pier(x, z, rng.range(0.7, 1.0), rng.range(2.0, 2.6), 'palmWood'));
      break;
    }
    case 'temple-precinct': {
      // A buttressed enclosure wall with a pylon at the gate axis.
      for (const zz of [-34, 20]) {
        for (let i = -3; i <= 3; i++) {
          if (zz === 20 && Math.abs(i) <= 1) continue;   // keep the gate clear
          wall(i * 7 - 2.6, zz, i * 7 + 2.6, zz, 3.4, 1.2, 'bakedBrick', 'enclosureWall');
        }
      }
      for (const xx of [-22, 22]) wall(xx, -30, xx, 16, 3.4, 1.2, 'bakedBrick', 'enclosureWall');
      // Blind niches read as rhythmic recesses along the enclosure.
      for (let i = -2; i <= 2; i++) {
        if (i === 0) continue;
        pier(i * 8, -30, 1.8, 4.4, 'bakedBrick');
      }
      break;
    }
    case 'gate-road': {
      // Flanking walls turn the processional way into a corridor rather than a
      // strip of open ground.
      for (let i = -5; i <= 5; i++) {
        const z = i * 12;
        if (Math.abs(z) < 14) continue;
        wall(-10.4, z - 5, -10.4, z + 5, 3.2, 1.0, 'bakedBrick', 'wayWall');
        wall(10.4, z - 5, 10.4, z + 5, 3.2, 1.0, 'bakedBrick', 'wayWall');
      }
      break;
    }
    case 'canal-bank': {
      // Stone-lined embankments on both sides of the canal channel.
      wall(-30, 4, 14, 4, 1.0, 0.9, 'limestone', 'embankment');
      wall(-30, 20, 14, 20, 1.0, 0.9, 'limestone', 'embankment');
      scatter(6, 5.0, (x, z) => pier(x, z, rng.range(0.5, 0.8), rng.range(1.2, 1.8), 'palmWood'));
      scatter(5, 6.0, (x, z) => (clearSegment(x - 2.5, z, x + 2.5, z, 4.5)
        ? wall(x - 2.5, z, x + 2.5, z, rng.range(0.8, 1.2), 0.6, 'mudBrick') : false));
      break;
    }
    case 'ruins': {
      // Fallen masonry: broken wall stubs at random orientations, plus a few
      // collapsed rooms whose walls survive to waist height.
      scatter(18, 6.0, (x, z) => {
        const len = rng.range(3.0, 9.0);
        const a = rng.range(0, Math.PI);
        const h = rng.range(0.8, 2.8);
        const ax = x - Math.cos(a) * len / 2, az = z - Math.sin(a) * len / 2;
        const bx = x + Math.cos(a) * len / 2, bz = z + Math.sin(a) * len / 2;
        if (!clearSegment(ax, az, bx, bz, 4.5)) return false;
        wall(ax, az, bx, bz, h, 0.8, rng.chance(0.6) ? 'mudBrick' : 'bakedBrick', 'ruinedWall');
        return true;
      });
      scatter(7, 4.0, (x, z) => pier(x, z, rng.range(0.9, 1.5), rng.range(0.6, 1.8), 'mudBrickDark'));
      break;
    }
    case 'desert-edge': {
      // Rock outcrops and boulder fields. Dunes themselves come from the height
      // field; these give the eye and the stealth system something to work with.
      // Outcrop clusters plus windward dune banks. The desert edge is meant to
      // feel exposed — Raynor is hunted and has no cover — but exposure must
      // stay readable and usable, so sight lines are broken often enough that
      // stealth remains possible rather than hopeless.
      scatter(30, 6.5, (x, z) => {
        const n = rng.int(2, 4);
        for (let i = 0; i < n; i++) {
          const ox = x + rng.range(-2.2, 2.2);
          const oz = z + rng.range(-2.2, 2.2);
          const h = rng.range(0.9, 2.6);
          add(boxCollider(ox, space.elevation + h / 2, oz, rng.range(1.0, 2.6), h, rng.range(1.0, 2.6), {
            kind: 'outcrop', material: 'basalt', region: def.id,
            blocksMovement: true, blocksSight: h > 1.3, blocksCamera: true,
            walkableTop: h <= 0.6, stepHeight: h, structure: true,
          }));
        }
      });
      // Low dune banks: waist-high, climbable, and they break a long flat sight
      // line without contradicting the open character of the space.
      scatter(18, 8.0, (x, z) => {
        const len = rng.range(8.0, 18.0);
        const a = rng.range(0, Math.PI);
        const ax = x - Math.cos(a) * len / 2, az = z - Math.sin(a) * len / 2;
        const bx = x + Math.cos(a) * len / 2, bz = z + Math.sin(a) * len / 2;
        if (!clearSegment(ax, az, bx, bz, 6.0)) return false;
        wall(ax, az, bx, bz, 0.55, rng.range(1.6, 3.0), 'sand', 'duneBank');
        return true;
      });
      // A dry watercourse (wadi). On the alluvial desert edge west of Babylon a
      // wadi is the one feature you can count on: a shallow cut with spoil
      // banks on both lips, running to the river. It gives the space a legible
      // spine and the only reliable cover for a long stretch, so stealth here
      // reads as "move along the cut" rather than "there is nothing".
      scatter(3, 16.0, (x, z) => {
        const len = rng.range(26.0, 40.0);
        const a = rng.range(-0.5, 0.5) + Math.PI / 2;      // roughly north-south
        const cx = Math.cos(a), cz = Math.sin(a);
        const ax = x - cx * len / 2, az = z - cz * len / 2;
        const bx = x + cx * len / 2, bz = z + cz * len / 2;
        const nx = -cz, nz = cx;                             // bank offset normal
        for (const side of [-1, 1]) {
          const off = side * 2.1;
          if (!clearSegment(ax + nx * off, az + nz * off, bx + nx * off, bz + nz * off, 5.0)) return false;
        }
        for (const side of [-1, 1]) {
          const off = side * 2.1;
          wall(ax + nx * off, az + nz * off, bx + nx * off, bz + nz * off,
            0.7, rng.range(1.4, 2.4), 'silt', 'wadiBank');
        }
        return true;
      });
      break;
    }
    case 'palace-exterior': {
      // Service compound: yard walls, a storage rank and the outer ramp flank.
      scatter(9, 6.5, (x, z) => {
        const len = rng.range(5.0, 12.0);
        const horizontal = rng.chance(0.5);
        const ax = horizontal ? x - len / 2 : x, az = horizontal ? z : z - len / 2;
        const bx = horizontal ? x + len / 2 : x, bz = horizontal ? z : z + len / 2;
        if (!clearSegment(ax, az, bx, bz, 5.0)) return false;
        wall(ax, az, bx, bz, rng.range(2.0, 3.0), 0.7, 'mudBrick');
        return true;
      });
      scatter(5, 4.5, (x, z) => pier(x, z, rng.range(0.9, 1.3), rng.range(1.6, 2.4), 'mudBrickDark'));
      break;
    }
    case 'ziggurat-terrace': {
      // The massif of the ziggurat rises behind the terrace; the walkable
      // terrace is the ring in front of it, with the summit shrine standing on
      // the terrace itself. Offset south so the shrine, parapet, brazier and
      // stair all keep clear ground — a core centred on the terrace buried the
      // shrine entirely.
      add(boxCollider(0, space.elevation + 1.4, 5.5, 11, 2.8, 9, {
        kind: 'zigguratCore', material: 'bakedBrick', region: def.id,
        blocksMovement: true, blocksSight: true, blocksCamera: true, walkableTop: false,
        structure: true,
      }));
      // Baked-brick facing steps up the massif face.
      add(boxCollider(0, space.elevation + 0.55, -0.2, 8, 1.1, 1.6, {
        kind: 'zigguratStep', material: 'bakedBrick', region: def.id,
        blocksMovement: true, blocksSight: false, blocksCamera: true,
        walkableTop: true, stepHeight: 0.6, structure: true,
      }));
      break;
    }
    default:
      break;
  }
}

/* ------------------------------------------------------------------ props */

/**
 * Non-interactive dressing that still affects stealth: low walls, potsherds,
 * refuse. Deliberately low density — §8 asks for "dense, purposeful and
 * believable", not clutter, and Agent 15 owns the object-count budget.
 */
function scatterProps(space, def, rng) {
  const [x0, x1] = def.bounds.x;
  const [z0, z1] = def.bounds.z;
  const area = (x1 - x0) * (z1 - z0);
  const density = def.indoor ? 0.006 : 0.012;
  const count = clamp(Math.round(area * density), 0, def.indoor ? 14 : 40);

  for (let i = 0; i < count; i++) {
    const x = rng.range(x0 + 2, x1 - 2);
    const z = rng.range(z0 + 2, z1 - 2);
    const gy = space.collision.heightAt(x, z);
    const roll = rng.next();
    if (roll < 0.34) {
      // Low mud-brick kerb — walkable top, provides crouch cover.
      space.collision.add(boxCollider(x, gy + 0.225, z, rng.range(1.2, 2.6), 0.45, rng.range(0.5, 0.9), {
        kind: 'kerb', material: 'mudBrick', region: def.id,
        walkableTop: true, stepHeight: 0.5, blocksSight: false, blocksCamera: false,
      }));
      space.coverSpots.push({ x, z, height: 0.45, low: true });
    } else if (roll < 0.62) {
      space.props.push({ kind: 'potsherd', x, y: gy + 0.02, z, r: rng.range(0.2, 0.5), material: 'terracotta' });
    } else if (roll < 0.82 && !def.indoor) {
      space.props.push({ kind: 'scrub', x, y: gy, z, r: rng.range(0.5, 1.1), material: 'reed' });
    } else {
      space.props.push({ kind: 'pebbleScatter', x, y: gy + 0.01, z, r: rng.range(0.8, 2.0), material: 'silt' });
    }
  }
}

/* -------------------------------------------------------------- utilities */

/** Total doorway width available in a region — the tight-navigation metric. */
export function doorwayWidthReport(space) {
  return space.doors.map((d) => ({
    id: d.id, to: d.toRegion, width: d.width,
    // Effective width after nav erosion, measured from the grid itself.
    navOpen: space.nav.isWalkableAt(d.world.x, d.world.z),
  }));
}

/**
 * Cross-region reachability over the door graph.
 * Returns the set of regions reachable from a start region — used by
 * reach-test to prove no chapter space can be orphaned (P0 guard).
 */
export function regionReachability(startId = 'palace-court') {
  const seen = new Set([startId]);
  const queue = [startId];
  const edges = [];
  while (queue.length) {
    const cur = queue.shift();
    for (const next of REGION_MAP[cur]?.connects ?? []) {
      edges.push([cur, next]);
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  return { reachable: seen, edges, total: REGIONS.length, missing: REGIONS.filter((r) => !seen.has(r.id)).map((r) => r.id) };
}

function nowMs() {
  if (typeof performance !== 'undefined' && performance.now) return performance.now();
  return Date.now();
}

/**
 * Can the player get to this landmark? A landmark counts as reachable when some
 * walkable cell the flood fill reached lies within its approach radius.
 * Enclosed landmarks (the holding cage) are judged from outside their footprint.
 */
function landmarkReachable(space, fill, lm) {
  const nav = space.nav;
  const centre = nav.worldToCell(lm.x, lm.z);
  const radiusMetres = lm.enclosed ? 4.0 : 1.6;
  const rmax = Math.ceil(radiusMetres / nav.cellSize);
  for (let dr = -rmax; dr <= rmax; dr++) {
    for (let dc = -rmax; dc <= rmax; dc++) {
      const cc = centre.col + dc, rr = centre.row + dr;
      if (!nav.inBounds(cc, rr) || !nav.isWalkable(cc, rr)) continue;
      if (Math.hypot(dc, dr) * nav.cellSize > radiusMetres) continue;
      if (fill.reached.has(nav.index(cc, rr))) return true;
    }
  }
  return false;
}

/** Newest enabled structure collider near any blocked landmark. */
function nearestEnabledStructure(structures, blocked, maxDist) {
  for (let i = structures.length - 1; i >= 0; i--) {
    const c = structures[i];
    if (!c.enabled) continue;
    const cx = (c.box.min.x + c.box.max.x) / 2;
    const cz = (c.box.min.z + c.box.max.z) / 2;
    for (const lm of blocked) {
      if (Math.hypot(lm.x - cx, lm.z - cz) <= maxDist) return c;
    }
  }
  return null;
}
