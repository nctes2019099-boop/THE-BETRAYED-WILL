// THE BETRAYED WILL — navigation grid
// PURE MODULE. Walkability rasterisation over a CollisionWorld.
// §30 notes "some outskirts interiors have tight navigation" — the nav grid
// exposes exact cell counts and doorway widths so that claim is measurable
// rather than anecdotal (charter C-1).

import { Vec3, clamp, DEG2RAD } from '../core/math.js';
import { WORLD, MOVE } from '../core/constants.js';

export const CELL = Object.freeze({
  BLOCKED: 0,
  WALKABLE: 1,
  DOORWAY: 2,
  STEP: 3,       // walkable but requires a step-up (stairs, rubble)
  HIDE: 4,       // walkable and provides concealment
  INTERACT: 5,   // walkable and adjacent to an interactable
});

export class NavGrid {
  /**
   * @param {object} opts
   *  bounds {minX,maxX,minZ,maxZ} world-space extent
   *  cellSize metres per cell
   *  agentRadius capsule radius used for clearance erosion
   */
  constructor(opts) {
    this.cellSize = opts.cellSize ?? WORLD.NAV_CELL_SIZE;
    this.minX = opts.bounds.minX;
    this.maxX = opts.bounds.maxX;
    this.minZ = opts.bounds.minZ;
    this.maxZ = opts.bounds.maxZ;
    this.agentRadius = opts.agentRadius ?? WORLD.NAV_AGENT_RADIUS;
    this.slopeLimit = (opts.slopeLimitDeg ?? WORLD.NAV_MAX_SLOPE_DEG) * DEG2RAD;
    this.minHeadroom = opts.minHeadroom ?? WORLD.NAV_MIN_HEADROOM;
    // Maximum height an agent may step between adjacent cells. Without this the
    // nav graph treats a 1.1 m parapet top and the ground beside it as
    // connected, and enemy AI would happily route straight up a wall (§11
    // Agent 06: "enemy AI must not cheat"). Ramps and stairs stay connected
    // because their per-cell rise is far below this limit.
    this.stepLimit = opts.stepLimit ?? 0.55;

    this.cols = Math.max(1, Math.ceil((this.maxX - this.minX) / this.cellSize));
    this.rows = Math.max(1, Math.ceil((this.maxZ - this.minZ) / this.cellSize));
    this.cells = new Uint8Array(this.cols * this.rows);
    /** Float32 ground height per cell — lets paths follow vertical levels. */
    this.heights = new Float32Array(this.cols * this.rows);
    /** Region tag per cell, for multi-level spaces such as the cellar stair. */
    this.tags = new Uint8Array(this.cols * this.rows);
    /** Reused by neighboursFlat / the neighbours() wrapper. 8 neighbours x 3. */
    this._flatNb = new Float64Array(24);

    this.built = false;
    this.buildTimeMs = 0;
    this.stats = { total: this.cells.length, walkable: 0, blocked: 0, doorways: 0 };
  }

  index(col, row) { return row * this.cols + col; }

  inBounds(col, row) {
    return col >= 0 && col < this.cols && row >= 0 && row < this.rows;
  }

  /**
   * Is a WORLD position inside this grid?
   *
   * worldToCell() clamps, which is convenient for lookups but dangerous for
   * queries: a goal 100 km outside the region would clamp to the corner cell and
   * A* would happily return a route to that corner. Callers that accept a target
   * from another system (a shout heard through a wall, an alarm propagated from
   * a neighbouring region, a save file restored against a changed world) must be
   * able to ask this question before snapping.
   */
  containsWorld(x, z) {
    return x >= this.minX && x <= this.maxX && z >= this.minZ && z <= this.maxZ;
  }

  worldToCell(x, z) {
    const col = Math.floor((x - this.minX) / this.cellSize);
    const row = Math.floor((z - this.minZ) / this.cellSize);
    return { col: clamp(col, 0, this.cols - 1), row: clamp(row, 0, this.rows - 1) };
  }

  cellToWorld(col, row) {
    return {
      x: this.minX + (col + 0.5) * this.cellSize,
      z: this.minZ + (row + 0.5) * this.cellSize,
    };
  }

  get(col, row) {
    if (!this.inBounds(col, row)) return CELL.BLOCKED;
    return this.cells[this.index(col, row)];
  }

  set(col, row, value, height = 0, tag = 0) {
    if (!this.inBounds(col, row)) return;
    const i = this.index(col, row);
    this.cells[i] = value;
    this.heights[i] = height;
    this.tags[i] = tag;
  }

  isWalkable(col, row) {
    const c = this.get(col, row);
    return c !== CELL.BLOCKED;
  }

  isWalkableAt(x, z) {
    const { col, row } = this.worldToCell(x, z);
    return this.isWalkable(col, row);
  }

  heightAt(col, row) {
    if (!this.inBounds(col, row)) return 0;
    return this.heights[this.index(col, row)];
  }

  heightAtWorld(x, z) {
    const { col, row } = this.worldToCell(x, z);
    return this.heightAt(col, row);
  }

  /**
   * Build from a CollisionWorld.
   *
   * The height field is *multi-level*: a column can hold ground, a bridge deck
   * and a roof at once. Which level a cell belongs to is decided by a breadth
   * first walk outward from ground level, never by scan order.
   *
   * Why BFS and not a row-major continuity scan: a scan has to guess a cell's
   * level from neighbours that are only half settled, and the guess propagates.
   * A reed hut's wall cell has exactly one viable surface — its roof, because at
   * ground level the capsule intersects the wall — so a scan resolved that cell
   * at roof height and then handed roof height to every cell behind it. The
   * whole interior became navigable only on top of its own roof, unreachable
   * from the street. A BFS seeded at ground level cannot do this: a roof is
   * never within one step of the ground, so it is never seeded and never reached.
   */
  build(collisionWorld, opts = {}) {
    const t0 = nowMs();
    const cs = this.cellSize;
    const radius = this.agentRadius;
    const height = opts.agentHeight ?? MOVE.CAPSULE_HEIGHT;
    const baseFeet = opts.sampleFeetY ?? 0;
    const scanBelow = opts.scanBelow ?? 4.0;
    const scanAbove = opts.scanAbove ?? 8.0;
    // Maximum rise the level walk will follow between neighbouring cells. Above
    // this a surface is a separate level, not a slope — which is what lets a
    // bridge deck and the ground beneath it coexist. Clamped by the slope limit
    // so a 0.5 m cell cannot accept a 51 degree ramp the player would slide on.
    const maxRise = Math.min(
      opts.maxRise ?? 0.62,
      Math.max(0.40, Math.tan(this.slopeLimit) * cs),
    );

    const heights = this.heights;
    const total = this.cells.length;
    const candidates = [];
    const probe = new Vec3();

    // --- Pass 1: enumerate viable surfaces per cell -------------------------
    // A surface is viable when the agent capsule, placed AT THE CELL CENTRE with
    // its feet on that surface, fits — headroom included. Testing the capsule
    // directly is what makes this resolution-independent: it encodes "can the
    // player stand here" with no inflate-then-erode step (that approach cost a
    // 1.9 m doorway 0.45 m to rasterisation and 0.34 m per side to erosion, and
    // sealed it — a P0 under §19, "player permanently stuck").
    const MAXC = 4;
    const candY = new Float32Array(total * MAXC);
    const candN = new Uint8Array(total);
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const i = this.index(col, row);
        const x = this.minX + (col + 0.5) * cs;
        const z = this.minZ + (row + 0.5) * cs;
        this.cells[i] = CELL.BLOCKED;
        heights[i] = baseFeet;

        collisionWorld.standableSurfaces(x, z, baseFeet - scanBelow, baseFeet + scanAbove, candidates);
        let n = 0;
        for (let k = 0; k < candidates.length && n < MAXC; k++) {
          const y = candidates[k].y;
          probe.set(x, y + 0.05, z);
          // Ignore surfaces the agent could step up onto from this level, so a
          // low platform does not wall itself off from the surrounding floor.
          if (!collisionWorld.isSpaceFree(probe, radius, height, { ignoreTopBelowY: y + maxRise })) continue;
          // Keep the list sorted ascending; standableSurfaces already is.
          candY[i * MAXC + n++] = y;
        }
        candN[i] = n;
      }
    }

    // --- Pass 2: assign levels by breadth-first walk from ground level -------
    const assigned = new Uint8Array(total);
    const queue = new Int32Array(total);
    let qh = 0, qt = 0;

    // Returns the INDEX of the best candidate within maxRise of `ref`, or -1.
    // Returning the height itself would be a trap: -1 is a perfectly ordinary
    // floor height in a cellar stairwell, and every descending cell would read
    // as "no level found" and be discarded.
    const pick = (i, ref) => {
      const n = candN[i];
      const base = i * MAXC;
      let best = -1, bestDelta = Infinity;
      for (let k = 0; k < n; k++) {
        const delta = Math.abs(candY[base + k] - ref);
        if (delta <= maxRise && delta < bestDelta) { bestDelta = delta; best = k; }
      }
      return best;
    };

    for (let i = 0; i < total; i++) {
      if (!candN[i]) continue;
      const ci = pick(i, baseFeet);
      if (ci < 0) continue;
      heights[i] = candY[i * MAXC + ci];
      this.cells[i] = CELL.WALKABLE;
      assigned[i] = 1;
      queue[qt++] = i;
    }

    // Degenerate safety net: a region whose floor is nowhere near its declared
    // elevation would seed nothing and come out entirely blocked. Rather than
    // silently emit an empty grid (which would strand the player — §19 P0), fall
    // back to the surface nearest the base elevation everywhere.
    if (qt === 0) {
      for (let i = 0; i < total; i++) {
        if (!candN[i]) continue;
        let best = candY[i * MAXC], bestDelta = Math.abs(best - baseFeet);
        for (let k = 1; k < candN[i]; k++) {
          const y = candY[i * MAXC + k];
          const d = Math.abs(y - baseFeet);
          if (d < bestDelta) { bestDelta = d; best = y; }
        }
        heights[i] = best;
        this.cells[i] = CELL.WALKABLE;
        assigned[i] = 1;
        queue[qt++] = i;
      }
    }

    const nb = [-1, 1, -this.cols, this.cols];
    while (qh < qt) {
      const i = queue[qh++];
      const h = heights[i];
      const col = i % this.cols;
      for (let k = 0; k < 4; k++) {
        const ni = i + nb[k];
        if (ni < 0 || ni >= total) continue;
        // Guard the row wrap: -1/+1 must not cross a row boundary.
        if (k === 0 && col === 0) continue;
        if (k === 1 && col === this.cols - 1) continue;
        if (assigned[ni] || !candN[ni]) continue;
        const ci = pick(ni, h);
        if (ci < 0) continue;
        heights[ni] = candY[ni * MAXC + ci];
        this.cells[ni] = CELL.WALKABLE;
        assigned[ni] = 1;
        queue[qt++] = ni;
      }
    }
    // Any cell still unassigned has viable surfaces the agent cannot walk to
    // from ground level — a roof, a wall top, a floating slab. It stays BLOCKED
    // so enemy AI can never path onto it (§11 Agent 06: AI must not cheat).

    // --- Pass 3: semantic tags ---------------------------------------------
    // Supplied by the world builder for doorways, hiding spots and cover. A mark
    // may reclassify a walkable cell but must never open one the capsule test
    // rejected, otherwise the nav grid would promise space the player cannot
    // occupy and A* would route them into a wall.
    for (const mark of opts.marks ?? []) {
      const { col, row } = this.worldToCell(mark.x, mark.z);
      if (!this.inBounds(col, row)) continue;
      const i = this.index(col, row);
      if (this.cells[i] !== CELL.BLOCKED) {
        this.cells[i] = mark.type;
        this.tags[i] = mark.tag ?? 0;
      }
    }

    this.built = true;
    this.buildTimeMs = nowMs() - t0;
    this.recount();
    return this;
  }

  /** Force a cell walkable — used for region doorways, which must never seal. */
  carve(x, z, type = CELL.DOORWAY, tag = 0) {
    const { col, row } = this.worldToCell(x, z);
    if (!this.inBounds(col, row)) return false;
    const i = this.index(col, row);
    this.cells[i] = type;
    this.tags[i] = tag;
    return true;
  }

  recount() {
    let walkable = 0, blocked = 0, doorways = 0;
    for (let i = 0; i < this.cells.length; i++) {
      const c = this.cells[i];
      if (c === CELL.BLOCKED) blocked++;
      else {
        walkable++;
        if (c === CELL.DOORWAY) doorways++;
      }
    }
    this.stats = { total: this.cells.length, walkable, blocked, doorways };
    return this.stats;
  }

  /**
   * Can the agent move from cell (col,row) to (nc,nr)?
   * Both cells must be walkable AND the height difference must be within the
   * step limit — this is what makes the nav graph height-aware.
   */
  canStep(col, row, nc, nr) {
    if (!this.inBounds(nc, nr)) return false;
    if (this.get(nc, nr) === CELL.BLOCKED) return false;
    if (this.get(col, row) === CELL.BLOCKED) return false;
    const dh = Math.abs(this.heights[this.index(nc, nr)] - this.heights[this.index(col, row)]);
    return dh <= this.stepLimit;
  }

  /**
   * Neighbours allowing 8-way movement. Corner cutting is forbidden: a diagonal
   * is only offered when both orthogonal cells it passes between are traversable,
   * so agents never slice through a doorway jamb.
   */
  /**
   * Allocation-free neighbour enumeration for hot paths (A*, flood fill).
   *
   * Writes [col, row, weight] triples into `out` and returns the neighbour
   * count. `out` must hold at least 24 numbers. Diagonals are offered only when
   * both orthogonal neighbours are passable, so the agent never cuts a corner.
   *
   * The array-of-triples form allocates up to 8 small arrays per expansion. A
   * long cross-region route expands ~10k nodes, so that is ~80k short-lived
   * objects per query — exactly the GC pressure the no-allocation requirement
   * for the AI hot path exists to prevent.
   */
  neighboursFlat(col, row, out) {
    // The source cell's index, occupancy and height are looked up ONCE and then
    // reused for all eight directions. Delegating to canStep() here re-derived
    // the source index and re-tested the source cell eight times per expansion,
    // which at ~10k expansions per long route is 80k redundant lookups.
    const cols = this.cols, rows = this.rows;
    if (col < 0 || row < 0 || col >= cols || row >= rows) return 0;
    const cells = this.cells, heights = this.heights;
    const srcIdx = row * cols + col;
    if (cells[srcIdx] === CELL.BLOCKED) return 0;
    const srcH = heights[srcIdx];
    const stepLimit = this.stepLimit;

    // Returns the neighbour index, or -1 when the agent cannot step there.
    const step = (nc, nr) => {
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) return -1;
      const i = nr * cols + nc;
      if (cells[i] === CELL.BLOCKED) return -1;
      const dh = heights[i] - srcH;
      return (dh < 0 ? -dh : dh) <= stepLimit ? i : -1;
    };

    let n = 0;
    const ni = step(col, row - 1);
    const si = step(col, row + 1);
    const wi = step(col - 1, row);
    const ei = step(col + 1, row);
    if (ni >= 0) { out[n] = col; out[n + 1] = row - 1; out[n + 2] = 1; n += 3; }
    if (si >= 0) { out[n] = col; out[n + 1] = row + 1; out[n + 2] = 1; n += 3; }
    if (wi >= 0) { out[n] = col - 1; out[n + 1] = row; out[n + 2] = 1; n += 3; }
    if (ei >= 0) { out[n] = col + 1; out[n + 1] = row; out[n + 2] = 1; n += 3; }
    // Diagonals require both orthogonal neighbours, so the agent never slices
    // through a corner it could not physically fit around.
    if (ni >= 0 && wi >= 0 && step(col - 1, row - 1) >= 0) {
      out[n] = col - 1; out[n + 1] = row - 1; out[n + 2] = Math.SQRT2; n += 3;
    }
    if (ni >= 0 && ei >= 0 && step(col + 1, row - 1) >= 0) {
      out[n] = col + 1; out[n + 1] = row - 1; out[n + 2] = Math.SQRT2; n += 3;
    }
    if (si >= 0 && wi >= 0 && step(col - 1, row + 1) >= 0) {
      out[n] = col - 1; out[n + 1] = row + 1; out[n + 2] = Math.SQRT2; n += 3;
    }
    if (si >= 0 && ei >= 0 && step(col + 1, row + 1) >= 0) {
      out[n] = col + 1; out[n + 1] = row + 1; out[n + 2] = Math.SQRT2; n += 3;
    }
    return n / 3;
  }

  /** Convenience wrapper returning [col, row, weight] triples. Not for hot paths. */
  neighbours(col, row, out = []) {
    out.length = 0;
    const flat = this._flatNb;
    const count = this.neighboursFlat(col, row, flat);
    for (let i = 0; i < count; i++) {
      out.push([flat[i * 3], flat[i * 3 + 1], flat[i * 3 + 2]]);
    }
    return out;
  }

  /**
   * Nearest walkable cell to a world point — the recovery path when an agent
   * ends up slightly inside geometry. Returns null only if the whole grid is
   * sealed, which the world validation test forbids.
   */
  nearestWalkable(x, z, maxRadiusCells = 24) {
    const start = this.worldToCell(x, z);
    if (this.isWalkable(start.col, start.row)) return start;
    for (let r = 1; r <= maxRadiusCells; r++) {
      let best = null, bestD = Infinity;
      for (let dr = -r; dr <= r; dr++) {
        for (let dc = -r; dc <= r; dc++) {
          if (Math.max(Math.abs(dc), Math.abs(dr)) !== r) continue;
          const cc = start.col + dc, rr = start.row + dr;
          if (!this.isWalkable(cc, rr)) continue;
          const d = dc * dc + dr * dr;
          if (d < bestD) { bestD = d; best = { col: cc, row: rr }; }
        }
      }
      if (best) return best;
    }
    return null;
  }

  /**
   * Flood-fill connectivity from a seed. Used by reach-test to prove every
   * objective, exit and landmark is actually reachable — the single most
   * important guard against a P0 "mission impossible to complete".
   */
  floodFill(seedX, seedZ) {
    const seed = this.nearestWalkable(seedX, seedZ);
    if (!seed) return { reached: new Set(), cells: 0, ok: false };
    const visited = new Uint8Array(this.cells.length);
    const queue = [this.index(seed.col, seed.row)];
    visited[queue[0]] = 1;
    const reached = new Set();
    let head = 0;
    while (head < queue.length) {
      const i = queue[head++];
      reached.add(i);
      const col = i % this.cols;
      const row = (i / this.cols) | 0;
      const nbCount = this.neighboursFlat(col, row, this._flatNb);
      for (let k = 0; k < nbCount; k++) {
        const ni = this.index(this._flatNb[k * 3], this._flatNb[k * 3 + 1]);
        if (visited[ni]) continue;
        visited[ni] = 1;
        queue.push(ni);
      }
    }
    return { reached, cells: reached.size, ok: true, seed };
  }

  /** ASCII render for debugging and for reviewer reports. */
  toASCII(maxCols = 80, maxRows = 40) {
    const chars = { 0: '#', 1: '.', 2: '+', 3: '^', 4: 'h', 5: 'i' };
    const stepC = Math.max(1, Math.floor(this.cols / maxCols));
    const stepR = Math.max(1, Math.floor(this.rows / maxRows));
    const lines = [];
    for (let row = 0; row < this.rows; row += stepR) {
      let line = '';
      for (let col = 0; col < this.cols; col += stepC) {
        line += chars[this.cells[this.index(col, row)]] ?? '?';
      }
      lines.push(line);
    }
    return lines.join('\n');
  }
}

function nowMs() {
  if (typeof performance !== 'undefined' && performance.now) return performance.now();
  return Date.now();
}

/**
 * Nearest candidate surface to a reference height.
 * `count` bounds the scan because the candidate array is a reused buffer and its
 * tail may still hold entries from the previous cell.
 */
function nearestTo(candidates, ref, count = candidates.length) {
  let best = candidates[0];
  let bestDelta = Math.abs(best.y - ref);
  for (let i = 1; i < count; i++) {
    const d = Math.abs(candidates[i].y - ref);
    if (d < bestDelta) { bestDelta = d; best = candidates[i]; }
  }
  return best;
}
