// THE BETRAYED WILL — A* pathfinding
// PURE MODULE. Binary-heap A* over a NavGrid with height-aware costs,
// path smoothing (string pulling) and a hard node budget (§24 "pathfinding time").

import { clamp } from '../core/math.js';
import { AI } from '../core/constants.js';

/** Minimal binary min-heap keyed on a parallel priority array. */
class BinaryHeap {
  constructor(capacity = 1024) {
    this.nodes = new Int32Array(capacity);
    this.priorities = new Float64Array(capacity);
    this.size = 0;
  }

  ensure(capacity) {
    if (capacity <= this.nodes.length) return;
    let n = this.nodes.length;
    while (n < capacity) n *= 2;
    const nodes = new Int32Array(n);
    const prio = new Float64Array(n);
    nodes.set(this.nodes.subarray(0, this.size));
    prio.set(this.priorities.subarray(0, this.size));
    this.nodes = nodes;
    this.priorities = prio;
  }

  push(node, priority) {
    this.ensure(this.size + 1);
    let i = this.size++;
    this.nodes[i] = node;
    this.priorities[i] = priority;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.priorities[parent] <= this.priorities[i]) break;
      this._swap(i, parent);
      i = parent;
    }
  }

  pop() {
    if (this.size === 0) return -1;
    const top = this.nodes[0];
    this.size--;
    if (this.size > 0) {
      this.nodes[0] = this.nodes[this.size];
      this.priorities[0] = this.priorities[this.size];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let smallest = i;
        if (l < this.size && this.priorities[l] < this.priorities[smallest]) smallest = l;
        if (r < this.size && this.priorities[r] < this.priorities[smallest]) smallest = r;
        if (smallest === i) break;
        this._swap(i, smallest);
        i = smallest;
      }
    }
    return top;
  }

  _swap(a, b) {
    const n = this.nodes[a]; this.nodes[a] = this.nodes[b]; this.nodes[b] = n;
    const p = this.priorities[a]; this.priorities[a] = this.priorities[b]; this.priorities[b] = p;
  }

  clear() { this.size = 0; }
  get empty() { return this.size === 0; }
}

/**
 * Reusable scratch buffers. A* runs many times per second for every AI agent,
 * so it must not allocate (Agent 15 requirement).
 */
class PathfinderScratch {
  constructor(grid) {
    this.allocate(grid);
  }
  allocate(grid) {
    const n = grid.cells.length;
    this.gScore = new Float64Array(n);
    this.cameFrom = new Int32Array(n);
    this.state = new Uint8Array(n); // 0 unseen, 1 open, 2 closed
    this.heap = new BinaryHeap(2048);
    /** Flat neighbour scratch for NavGrid.neighboursFlat — never reallocated. */
    this.nb = new Float64Array(24);
    this.timestamp = new Int32Array(n);
    this.epoch = 0;
  }
  reset(grid) {
    if (this.gScore.length !== grid.cells.length) { this.allocate(grid); return; }
    this.epoch++;
    // Epoch tagging avoids an O(n) clear per query — the real hot-path win.
    this.heap.clear();
  }
  isFresh(grid, i) { return this.timestamp[i] === this.epoch; }
  touch(grid, i) { this.timestamp[i] = this.epoch; }
}

export class Pathfinder {
  constructor(grid, opts = {}) {
    this.grid = grid;
    // Frame-safe tier by default: see the AI constants for the measured
    // distribution these numbers come from. Long-range callers (mission
    // blocking, escort routing) opt in explicitly with { longRange: true }.
    this.longRange = opts.longRange === true;
    this.maxNodes = opts.maxNodes ?? this._defaultMaxNodes(grid);
    // Per-query wall-clock ceiling. The node budget bounds worst-case work but
    // says nothing about how long that work takes on a given machine; the frame
    // budget (PERF.AI_BUDGET_MS) is the constraint that actually matters.
    this.timeBudgetMs = opts.timeBudgetMs
      ?? (this.longRange ? AI.PATH_TIME_BUDGET_MS : AI.PATH_TIME_BUDGET_MS_TACTICAL);
    this.scratch = new PathfinderScratch(grid);
    // Telemetry for the §24 performance ledger.
    this.queries = 0;
    this.nodesExpandedTotal = 0;
    this.totalTimeMs = 0;
    this.failures = 0;
    this.longestPath = 0;
  }

  /**
   * Touch the scratch arrays and run one throwaway query, so the first REAL query
   * is not cold.
   *
   * The AI budgets are documented as measured WARM. A cold first query on a
   * 25k-cell grid costs 2.16 ms against 0.38 ms warm for the identical route -
   * enough to blow a per-query budget and return `time-budget` on the frame a
   * level starts, when every guard asks for a path at once. Telemetry is reset
   * afterwards: a warm-up is not part of the performance ledger.
   */
  warm() {
    const g = this.grid;
    if (!g || !g.built) return this;
    const scratch = this.scratch;
    if (scratch) {
      // Touching every page is the actual cold cost; a short query would only
      // touch part of the arrays and leave the rest cold.
      for (const arr of [scratch.timestamp, scratch.gScore, scratch.fScore, scratch.cameFrom]) {
        if (arr && arr.length) { arr[0] = arr[0]; arr[arr.length - 1] = arr[arr.length - 1]; }
      }
      if (scratch.gScore) scratch.gScore.fill(0);
      if (scratch.fScore) scratch.fScore.fill(0);
    }
    const cx = (g.minX + g.maxX) / 2, cz = (g.minZ + g.maxZ) / 2;
    const a = g.nearestWalkable(cx, cz, 64);
    if (a) {
      const p = g.cellToWorld(a.col, a.row);
      const b = g.nearestWalkable(p.x + 1.5, p.z + 1.5, 64);
      if (b) {
        const q = g.cellToWorld(b.col, b.row);
        this.findPath(p.x, p.z, q.x, q.z, { maxNodes: 256, timeBudgetMs: 25 });
      }
    }
    this.queries = 0; this.failures = 0;
    this.totalTimeMs = 0; this.nodesExpandedTotal = 0; this.longestPath = 0;
    return this;
  }

  /**
   * Node budget for this pathfinder's tier.
   *
   * The long-range tier is sized from the grid so that it is COMPLETE within a
   * region: the worst case for A* is exploring every walkable cell, and regions
   * here range from ~4k cells (Layla's house) to ~55k (desert edge). A single
   * fixed number would either be too small for the big regions — silently
   * turning reachable targets into "unreachable" — or needlessly huge for the
   * small ones. AI.PATH_MAX_NODES is the floor for a grid whose stats have not
   * been counted yet.
   */
  _defaultMaxNodes(grid) {
    if (!this.longRange) return AI.PATH_MAX_NODES_TACTICAL;
    const walkable = grid?.stats?.walkable ?? 0;
    return Math.max(AI.PATH_MAX_NODES, walkable + (AI.PATH_MAX_NODES_MARGIN ?? 64));
  }

  /** Heuristic: octile distance, admissible for 8-way movement. */
  _heuristic(col, row, goalCol, goalRow) {
    const dx = Math.abs(col - goalCol);
    const dz = Math.abs(row - goalRow);
    const cs = this.grid.cellSize;
    return (dx + dz) * cs + (Math.SQRT2 - 2) * cs * Math.min(dx, dz);
  }

  /**
   * Height-aware step cost. Climbing costs more than descending, which makes
   * AI prefer stairs and ramps over rubble — visibly smarter routing.
   */
  _stepCost(fromIdx, toIdx, base) {
    const dh = this.grid.heights[toIdx] - this.grid.heights[fromIdx];
    if (dh > 0.05) return base * (1 + Math.min(2.2, dh * 1.35));
    if (dh < -0.05) return base * (1 + Math.min(0.9, -dh * 0.45));
    return base;
  }

  /**
   * Find a path between two world points.
   * @param {number} fromX world X of the agent
   * @param {number} fromZ world Z of the agent
   * @param {number} toX world X of the goal
   * @param {number} toZ world Z of the goal
   * @param {object} [opts] `maxNodes`, `timeBudgetMs` (0 disables the clock),
   *   `smooth:false` to skip string pulling, `startSearchRadius`/`goalSearchRadius`
   * @returns {{ok:boolean, path:Array<{x,z,y}>, nodesExpanded:number, cost:number,
   *            reason?:string, retryable?:boolean, timeMs:number,
   *            standAt:{start:{x,z}|null, goal:{x,z}|null}}}
   */
  findPath(fromX, fromZ, toX, toZ, opts = {}) {
    const t0 = nowMs();
    const grid = this.grid;
    this.queries++;

    // Reject endpoints outside the grid BEFORE snapping. worldToCell() clamps,
    // so an out-of-region goal would otherwise resolve to the corner cell and
    // return a perfectly valid-looking route to nowhere the caller asked for —
    // an escort would walk to a random corner of the courtyard and stand there.
    if (!Number.isFinite(fromX) || !Number.isFinite(fromZ)
      || !Number.isFinite(toX) || !Number.isFinite(toZ)) {
      this.failures++;
      return this._fail('endpoint-not-finite', t0);
    }
    if (!grid.containsWorld(fromX, fromZ) || !grid.containsWorld(toX, toZ)) {
      this.failures++;
      return this._fail('endpoint-out-of-bounds', t0);
    }

    const start = grid.nearestWalkable(fromX, fromZ, opts.startSearchRadius ?? 12);
    const goal = grid.nearestWalkable(toX, toZ, opts.goalSearchRadius ?? 12);
    if (!start || !goal) {
      this.failures++;
      return this._fail('no-walkable-endpoint', t0);
    }

    const startIdx = grid.index(start.col, start.row);
    const goalIdx = grid.index(goal.col, goal.row);
    if (startIdx === goalIdx) {
      const p = grid.cellToWorld(start.col, start.row);
      const gy = grid.heightAt(start.col, start.row);
      return {
        ok: true, nodesExpanded: 0, cost: 0, timeMs: nowMs() - t0,
        path: [{ x: p.x, z: p.z, y: gy }, { x: toX, z: toZ, y: gy }],
        startPinned: grid.isWalkableAt(fromX, fromZ),
        goalPinned: grid.isWalkableAt(toX, toZ),
        standAt: { start: { x: p.x, z: p.z }, goal: { x: toX, z: toZ } },
      };
    }

    const s = this.scratch;
    s.reset(grid);
    const { gScore, cameFrom, state, heap } = s;

    const goalCol = goal.col, goalRow = goal.row;
    heap.push(startIdx, this._heuristic(start.col, start.row, goalCol, goalRow));
    gScore[startIdx] = 0;
    state[startIdx] = 1;
    cameFrom[startIdx] = -1;
    s.touch(grid, startIdx);

    let expanded = 0;
    let found = false;
    // Flat scratch reused across every query: 8 neighbours x [col,row,weight].
    const nb = s.nb;

    // Time budget, checked only every so often so the clock is not read on
    // every expansion. Hitting it is reported distinctly from `unreachable`:
    // a caller that sees `time-budget` should defer and retry next frame, while
    // `unreachable` is a fact about the world and must not be retried blindly.
    const timeBudgetMs = opts.timeBudgetMs ?? this.timeBudgetMs;
    const deadline = timeBudgetMs > 0 ? t0 + timeBudgetMs : Infinity;
    const maxNodes = opts.maxNodes ?? this.maxNodes;

    while (!heap.empty) {
      const current = heap.pop();
      // Every read of `state` must be epoch-guarded. The scratch buffers are
      // deliberately NOT cleared between queries — that is what makes an A*
      // query allocation-free — so a cell closed by the PREVIOUS query still
      // reads state === 2. Unguarded, that made every cell the last path
      // touched permanently impassable: an AI agent repathing on its 0.35 s
      // interval found its first route and then could never path through it
      // again, so guards stopped chasing the player. This is the single most
      // damaging bug a pathfinder can have and it is invisible in a test that
      // only ever queries a fresh Pathfinder once.
      if (s.isFresh(grid, current) && state[current] === 2) continue;
      s.touch(grid, current);
      state[current] = 2;
      expanded++;

      if (current === goalIdx) { found = true; break; }
      if (expanded > maxNodes) {
        this.failures++;
        return this._fail('node-budget', t0, expanded);
      }
      if ((expanded & 0xFF) === 0 && nowMs() > deadline) {
        this.failures++;
        return this._fail('time-budget', t0, expanded);
      }

      const col = current % grid.cols;
      const row = (current / grid.cols) | 0;
      const nbCount = grid.neighboursFlat(col, row, nb);

      for (let k = 0; k < nbCount; k++) {
        const nc = nb[k * 3];
        const nr = nb[k * 3 + 1];
        const weight = nb[k * 3 + 2];
        const ni = grid.index(nc, nr);
        const fresh = s.isFresh(grid, ni);
        if (fresh && state[ni] === 2) continue;

        const tentative = gScore[current]
          + this._stepCost(current, ni, weight * grid.cellSize);

        if (!fresh || state[ni] === 0 || tentative < gScore[ni]) {
          gScore[ni] = tentative;
          cameFrom[ni] = current;
          state[ni] = 1;
          s.touch(grid, ni);
          heap.push(ni, tentative + this._heuristic(nc, nr, goalCol, goalRow));
        }
      }
    }

    this.nodesExpandedTotal += expanded;
    const timeMs = nowMs() - t0;
    this.totalTimeMs += timeMs;

    if (!found) {
      this.failures++;
      return this._fail('unreachable', t0, expanded);
    }

    // Reconstruct in cell space, then smooth.
    const cells = [];
    let cur = goalIdx;
    let guard = 0;
    while (cur !== -1 && guard++ < grid.cells.length) {
      const col = cur % grid.cols;
      const row = (cur / grid.cols) | 0;
      cells.push({ col, row, idx: cur });
      cur = cameFrom[cur];
      if (cur === startIdx) {
        const sc = startIdx % grid.cols;
        const sr = (startIdx / grid.cols) | 0;
        cells.push({ col: sc, row: sr, idx: startIdx });
        break;
      }
    }
    cells.reverse();

    const raw = cells.map((c) => {
      const w = grid.cellToWorld(c.col, c.row);
      return { x: w.x, z: w.z, y: grid.heightAt(c.col, c.row) };
    });

    // Pin endpoints to the exact requested position ONLY when that position is
    // itself walkable. Many interactables (a stone basin, a kiln, a wall relief)
    // stand inside their own footprint, so pinning blindly would emit a path
    // whose first point is inside solid geometry — which then fails collision
    // for the agent following it. Instead we keep the snapped cell and report it,
    // so callers know where the agent should actually stand.
    const startPinned = grid.isWalkableAt(fromX, fromZ);
    const goalPinned = grid.isWalkableAt(toX, toZ);
    if (raw.length) {
      if (startPinned) { raw[0].x = fromX; raw[0].z = fromZ; }
      if (goalPinned) { raw[raw.length - 1].x = toX; raw[raw.length - 1].z = toZ; }
    }

    const path = opts.smooth === false ? raw : this._smooth(raw, opts);
    if (path.length > this.longestPath) this.longestPath = path.length;

    return {
      ok: true, path, nodesExpanded: expanded, cost: gScore[goalIdx], timeMs,
      startPinned, goalPinned,
      // Where the agent should stand to reach each endpoint.
      standAt: {
        start: { x: raw[0]?.x ?? fromX, z: raw[0]?.z ?? fromZ },
        goal: { x: raw[raw.length - 1]?.x ?? toX, z: raw[raw.length - 1]?.z ?? toZ },
      },
    };
  }

  /**
   * A failed query. `retryable` is the field callers must branch on:
   *
   *   'node-budget' / 'time-budget'  retryable: true
   *       The route may well exist; the query ran out of budget. An AI agent
   *       must keep following its current path (or close on the last known
   *       position) and retry on its next interval. Treating this as
   *       "target unreachable" is how a guard ends up standing still while the
   *       player walks past — and it would only ever happen under load, which
   *       makes it the worst kind of bug to diagnose in the field.
   *
   *   'unreachable'                  retryable: false
   *       The open set was exhausted. This is a fact about the world: the goal
   *       is on another level, behind a locked gate, or inside geometry.
   *       Retrying identically will produce the same answer.
   *
   *   'no-walkable-endpoint'         retryable: false
   *       Neither endpoint could be snapped to a walkable cell at all.
   *
   *   'endpoint-out-of-bounds'       retryable: false
   *       A requested position lies outside this region's grid. Rejected rather
   *       than clamped: clamping turns "path to the next region" into "path to
   *       my own corner", which is silently wrong.
   *
   *   'endpoint-not-finite'          retryable: false
   *       NaN or Infinity reached the pathfinder. Always an upstream bug.
   */
  _fail(reason, t0, expanded = 0) {
    this.nodesExpandedTotal += expanded;
    const timeMs = nowMs() - t0;
    this.totalTimeMs += timeMs;
    return {
      ok: false, path: [], nodesExpanded: expanded, cost: 0, reason, timeMs,
      retryable: reason === 'node-budget' || reason === 'time-budget',
      startPinned: false, goalPinned: false,
      standAt: { start: null, goal: null },
    };
  }

  /**
   * String pulling: remove waypoints whose shortcut is unobstructed.
   * Line-of-sight is tested on the grid itself, so it costs nothing extra.
   */
  _smooth(path) {
    if (path.length <= 2) return path;
    const out = [path[0]];
    let anchor = 0;
    while (anchor < path.length - 1) {
      let furthest = anchor + 1;
      for (let j = path.length - 1; j > anchor + 1; j--) {
        if (this._lineWalkable(path[anchor], path[j])) { furthest = j; break; }
      }
      out.push(path[furthest]);
      anchor = furthest;
    }
    return out;
  }

  /** Bresenham-style walkability test between two world points. */
  _lineWalkable(a, b) {
    const grid = this.grid;
    const ca = grid.worldToCell(a.x, a.z);
    const cb = grid.worldToCell(b.x, b.z);
    let c0 = ca.col, r0 = ca.row;
    const c1 = cb.col, r1 = cb.row;
    const dc = Math.abs(c1 - c0), dr = Math.abs(r1 - r0);
    const sc = c0 < c1 ? 1 : -1, sr = r0 < r1 ? 1 : -1;
    let err = dc - dr;
    let guard = 0;
    const limit = (dc + dr) * 2 + 8;
    while (guard++ < limit) {
      if (!grid.isWalkable(c0, r0)) return false;
      if (c0 === c1 && r0 === r1) return true;
      const e2 = err * 2;
      if (e2 > -dr) { err -= dr; c0 += sc; }
      if (e2 < dc) { err += dc; r0 += sr; }
    }
    return false;
  }

  /** Total path length in metres. */
  static pathLength(path) {
    let d = 0;
    for (let i = 1; i < path.length; i++) {
      d += Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
    }
    return d;
  }

  stats() {
    return {
      queries: this.queries,
      failures: this.failures,
      successRate: this.queries ? (this.queries - this.failures) / this.queries : 1,
      avgNodesExpanded: this.queries ? this.nodesExpandedTotal / this.queries : 0,
      avgTimeMs: this.queries ? this.totalTimeMs / this.queries : 0,
      totalTimeMs: this.totalTimeMs,
      longestPath: this.longestPath,
    };
  }
}

function nowMs() {
  if (typeof performance !== 'undefined' && performance.now) return performance.now();
  return Date.now();
}
