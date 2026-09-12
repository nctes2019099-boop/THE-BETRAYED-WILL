// THE BETRAYED WILL — collision
// PURE MODULE. Static-world collision: spatial hash of AABBs, capsule movement
// resolution with step-up and slope handling, and the ray queries the camera
// solver and perception both depend on.
// §10 requirement this must satisfy: camera worst penetration = 0 m.

import { AABB, Vec3, clamp, EPSILON, rayAABB, resolveCircleAABBXZ } from '../core/math.js';
import { MOVE } from '../core/constants.js';

/** Uniform spatial hash — broad phase for collider queries. */
/**
 * Contact skin, in metres.
 *
 * The horizontal resolver parks an agent at exactly `radius` from a face, so at
 * rest the capsule and the collider are mathematically TOUCHING. Two comparisons
 * then go the wrong way on floating-point dust, and they conspire:
 *
 *   - resolveCircleAABBXZ() reports a penetration of ~1e-16 m, which sets
 *     hitWall and produces a push-out of nothing;
 *   - AABB.intersects() uses <=, so a zero-gap touch counts as overlap and
 *     isSpaceFree() calls the resting agent "occupied".
 *
 * Feed that into the containment net at the end of moveCapsule() and the frame's
 * motion is reverted every single frame: the agent's velocity is composed along
 * the wall, but its position never advances. Every wall in the game becomes a
 * trap the player sticks to. A contact shallower than this skin is therefore
 * resting contact, not penetration. Half a millimetre is three orders of
 * magnitude below anything a player can perceive and far below the nav grid's
 * cell size, so it cannot smuggle the agent through real geometry.
 */
const CONTACT_SKIN = 0.0005;

export class SpatialHash {
  constructor(cellSize = 4) {
    this.cellSize = cellSize;
    this.cells = new Map();
    this.items = [];
  }

  _key(cx, cy) { return cx * 73856093 ^ cy * 19349663; }

  insert(item) {
    const box = item.box;
    const cs = this.cellSize;
    const x0 = Math.floor(box.min.x / cs), x1 = Math.floor(box.max.x / cs);
    const z0 = Math.floor(box.min.z / cs), z1 = Math.floor(box.max.z / cs);
    const touched = [];
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = this._key(cx, cz);
        let arr = this.cells.get(k);
        if (!arr) { arr = []; this.cells.set(k, arr); }
        arr.push(item);
        touched.push(k);
      }
    }
    item._cells = touched;
    this.items.push(item);
    return item;
  }

  /** All colliders whose cell overlaps the query box (may contain false positives). */
  query(box, out = []) {
    out.length = 0;
    const cs = this.cellSize;
    const x0 = Math.floor(box.min.x / cs), x1 = Math.floor(box.max.x / cs);
    const z0 = Math.floor(box.min.z / cs), z1 = Math.floor(box.max.z / cs);
    const seen = new Set();
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const arr = this.cells.get(this._key(cx, cz));
        if (!arr) continue;
        for (const item of arr) {
          if (seen.has(item)) continue;
          seen.add(item);
          if (item.box.intersects(box)) out.push(item);
        }
      }
    }
    return out;
  }

  get count() { return this.items.length; }
  clear() { this.cells.clear(); this.items.length = 0; }
}

/**
 * A static collider.
 * `kind` informs both the nav grid (what is walkable) and the asset pipeline
 * (what to render). `blocksMovement`/`blocksSight` let a reed screen hide the
 * player without being a wall, and a low bench be walked over.
 */
export class Collider {
  constructor(box, opts = {}) {
    this.box = box instanceof AABB ? box : AABB.fromCenterExtents(box.center, box.extents);
    this.kind = opts.kind ?? 'wall';
    this.id = opts.id ?? null;
    this.blocksMovement = opts.blocksMovement !== false;
    this.blocksSight = opts.blocksSight !== false;
    this.blocksCamera = opts.blocksCamera !== false;
    this.walkableTop = opts.walkableTop === true;   // can stand on top (roof, bench)
    this.stepHeight = opts.stepHeight ?? MOVE.STEP_HEIGHT;
    this.material = opts.material ?? 'mudBrick';
    this.region = opts.region ?? null;
    this.dynamic = opts.dynamic === true;
    this.enabled = opts.enabled !== false;
  }

  get height() { return this.box.max.y - this.box.min.y; }
  get top() { return this.box.max.y; }
  get bottom() { return this.box.min.y; }

  /** Can an agent standing at `feetY` step up onto this collider? */
  isStep(feetY) {
    return this.walkableTop && (this.top - feetY) <= this.stepHeight + EPSILON;
  }

  /** Can an agent stand on top of this collider at all? */
  isStandable(feetY) {
    return this.walkableTop && this.top >= feetY - 0.35 && this.top <= feetY + MOVE.STEP_HEIGHT + 0.6;
  }

  toJSON() {
    return {
      min: this.box.min.toArray(), max: this.box.max.toArray(), kind: this.kind, id: this.id,
      blocksMovement: this.blocksMovement, blocksSight: this.blocksSight,
      blocksCamera: this.blocksCamera, walkableTop: this.walkableTop,
      stepHeight: this.stepHeight, material: this.material, region: this.region,
    };
  }
}

/** Convenience builders for the world generator. */
export function boxCollider(cx, cy, cz, sx, sy, sz, opts) {
  return new Collider(
    AABB.fromCenterExtents(new Vec3(cx, cy, cz), new Vec3(sx / 2, sy / 2, sz / 2)),
    opts,
  );
}

export function wallCollider(x0, z0, x1, z1, baseY, height, thickness, opts) {
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const dx = Math.abs(x1 - x0), dz = Math.abs(z1 - z0);
  const horizontal = dx >= dz;
  const sx = horizontal ? dx + thickness : thickness;
  const sz = horizontal ? thickness : dz + thickness;
  return boxCollider(cx, baseY + height / 2, cz, sx, height, sz, opts);
}

/**
 * The collision world for a single region.
 */
export class CollisionWorld {
  constructor(cellSize = 4) {
    this.hash = new SpatialHash(cellSize);
    /** Reused by the step-up headroom probe so movement never allocates. */
    this._probePos = new Vec3();
    this.colliders = [];
    this.groundHeight = 0;
    this.heightFn = null;   // optional procedural terrain height (x,z) => y
    this.bounds = null;
    this._queryBox = new AABB();
    this._scratch = [];
    this.rayHits = 0;
  }

  add(collider) {
    this.colliders.push(collider);
    this.hash.insert(collider);
    return collider;
  }

  addAll(list) { for (const c of list) this.add(c); return this; }

  setBounds(min, max) {
    this.bounds = new AABB(min, max);
    return this;
  }

  /** Terrain height under a point: procedural surface plus the flat floor. */
  heightAt(x, z) {
    const base = this.heightFn ? this.heightFn(x, z) : this.groundHeight;
    return base;
  }

  /**
   * Highest standable surface at (x,z) for an agent whose feet are near `feetY`.
   * Returns {y, collider}. Falls back to terrain when nothing is underfoot.
   */
  groundAt(x, z, feetY = 0, maxStep = MOVE.STEP_HEIGHT, radius = 0) {
    const terrain = this.heightAt(x, z);
    let best = terrain;
    let bestCollider = null;

    // The agent is supported by any surface lying under its base DISC, not only
    // under its exact centre point. Point-sampling reports "no floor" the instant
    // the capsule centre slides off a tread even though most of the disc still
    // rests on it: the agent then falls, re-enters the geometry it just climbed
    // from above, and can be pushed clean through it. Querying the whole disc
    // removes that class of failure at the root.
    const r = radius > 0 ? radius : 0.05;
    // Two-tier support radius. A surface that is ALREADY carrying the agent
    // (its top is level with, or below, the feet) genuinely supports them
    // anywhere under the base disc - that is what stops a capsule from being
    // reported as airborne the moment its centre slides off a tread it is
    // standing on. A surface ABOVE the feet is a kerb the agent would have to
    // climb, and climbing is the step-up resolver's decision to make, complete
    // with its height gate and headroom probe. Letting the wide disc snap the
    // agent up onto a kerb it is merely brushing would smuggle them over
    // geometry the resolver would have refused, so kerbs are matched against a
    // tight centre sample instead.
    const supportTol = 0.12;
    const tight = 0.05;
    const box = this._queryBox;
    box.min.set(x - r, feetY - 2.5, z - r);
    box.max.set(x + r, feetY + 4.0, z + r);
    const hits = this.hash.query(box, this._scratch);

    for (const c of hits) {
      if (!c.enabled || !c.walkableTop) continue;
      const top = c.top;
      const sr = top <= feetY + supportTol ? r : tight;
      if (x + sr < c.box.min.x || x - sr > c.box.max.x) continue;
      if (z + sr < c.box.min.z || z - sr > c.box.max.z) continue;
      // Only accept surfaces at or below the agent's feet plus a step tolerance,
      // or above when falling (we are looking for what we would land on).
      if (top <= feetY + maxStep + EPSILON && top > best) {
        best = top;
        bestCollider = c;
      } else if (top < feetY - 0.05 && top > best) {
        best = top;
        bestCollider = c;
      }
    }
    return { y: best, collider: bestCollider };
  }

  /**
   * Enumerate every standable surface in the vertical column at (x,z).
   *
   * This is what makes multi-level spaces work. A single "ground height" query
   * cannot represent a bridge over a canal, a stair flight, a sunken vault or a
   * raised terrace: from feet height 0 the top of a 1.3 m ramp step is invisible,
   * so the ramp rasterises as a wall instead of a climbable slope. Returning all
   * candidate levels lets the nav grid pick the right one by continuity.
   *
   * @returns {Array<{y:number, collider:Collider|null}>} sorted ascending by y
   */
  standableSurfaces(x, z, yMin = -6, yMax = 30, out = []) {
    out.length = 0;
    const box = this._queryBox;
    box.min.set(x - 0.02, yMin, z - 0.02);
    box.max.set(x + 0.02, yMax, z + 0.02);
    const hits = this.hash.query(box, this._scratch);

    const terrain = this.heightAt(x, z);
    if (terrain >= yMin && terrain <= yMax) out.push({ y: terrain, collider: null });

    for (const c of hits) {
      if (!c.enabled || !c.walkableTop || !c.blocksMovement) continue;
      if (x < c.box.min.x || x > c.box.max.x) continue;
      if (z < c.box.min.z || z > c.box.max.z) continue;
      if (c.top < yMin || c.top > yMax) continue;
      out.push({ y: c.top, collider: c });
    }

    out.sort((a, b) => a.y - b.y);
    // De-duplicate surfaces closer than 5 cm (co-planar dressing geometry).
    for (let i = out.length - 1; i > 0; i--) {
      if (Math.abs(out[i].y - out[i - 1].y) < 0.05) out.splice(i, 1);
    }
    return out;
  }

  /**
   * Cast a ray against blocking colliders.
   * @param {Vec3} origin
   * @param {Vec3} dir must be normalised
   * @param {number} maxDist
   * @param {object} opts { ignore:Set, blocksSight:boolean, blocksCamera:boolean }
   * @returns {{dist:number, collider:Collider, point:Vec3, normal:Vec3}|null}
   */
  raycast(origin, dir, maxDist = 100, opts = {}) {
    this.rayHits++;
    const ignore = opts.ignore ?? null;
    const sightOnly = opts.blocksSight === true;
    const cameraOnly = opts.blocksCamera === true;

    // Broad phase: walk the ray through the spatial hash cell by cell.
    let best = null;
    const step = this.hash.cellSize * 0.5;
    const steps = Math.min(4000, Math.ceil(maxDist / step) + 1);
    const candidates = new Set();

    for (let i = 0; i <= steps; i++) {
      const t = Math.min(maxDist, i * step);
      const px = origin.x + dir.x * t;
      const pz = origin.z + dir.z * t;
      const box = this._queryBox;
      box.min.set(px - step, -Infinity, pz - step);
      box.max.set(px + step, Infinity, pz + step);
      const hits = this.hash.query(box, this._scratch);
      for (const c of hits) candidates.add(c);
      if (t >= maxDist) break;
    }

    for (const c of candidates) {
      if (!c.enabled) continue;
      if (ignore && ignore.has(c)) continue;
      if (sightOnly && !c.blocksSight) continue;
      if (cameraOnly && !c.blocksCamera) continue;
      const t = rayAABB(origin, dir, c.box, maxDist);
      if (t == null) continue;
      if (best == null || t < best.dist) {
        best = { dist: t, collider: c, point: null, normal: null };
      }
    }

    if (!best) return null;
    best.point = new Vec3(
      origin.x + dir.x * best.dist,
      origin.y + dir.y * best.dist,
      origin.z + dir.z * best.dist,
    );
    best.normal = faceNormal(best.collider.box, best.point, dir);
    return best;
  }

  /** Cheap boolean line-of-sight test used by perception at a high tick rate. */
  hasLineOfSight(a, b, opts = {}) {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < EPSILON) return true;
    const inv = 1 / dist;
    return this.raycast(a, new Vec3(dx * inv, dy * inv, dz * inv), dist - 0.02, {
      ...opts, blocksSight: true,
    }) == null;
  }

  /**
   * Move a capsule through the world, resolving penetration.
   * Handles: horizontal push-out, step-up onto low walkable tops, ground
   * snapping, slope limiting and hard bounds.
   *
   * @param {Vec3} pos feet position (bottom-centre of the capsule)
   * @param {Vec3} delta requested movement this frame
   * @param {object} agent { radius, height, grounded, crouching, allowStep }
   * @returns {{pos:Vec3, grounded:boolean, groundY:number, hitWall:boolean,
   *            groundCollider:Collider|null, steppedUp:boolean, actualDelta:Vec3}}
   */
  moveCapsule(pos, delta, agent = {}) {
    const radius = agent.radius ?? MOVE.CAPSULE_RADIUS;
    const height = agent.height ?? MOVE.CAPSULE_HEIGHT;
    const allowStep = agent.allowStep !== false;
    const slopeLimit = agent.slopeLimitRad ?? (MOVE.SLOPE_LIMIT_DEG * Math.PI / 180);
    const maxStep = agent.maxStep ?? MOVE.STEP_HEIGHT;

    const result = {
      pos: pos.clone(),
      grounded: false,
      groundY: this.heightAt(pos.x, pos.z),
      hitWall: false,
      groundCollider: null,
      steppedUp: false,
      actualDelta: new Vec3(),
      slidAlong: null,
    };

    const p = result.pos;

    // --- horizontal resolution, split into substeps for thin walls -----------
    const horizontalDist = Math.hypot(delta.x, delta.z);
    const substeps = clamp(Math.ceil(horizontalDist / (radius * 0.6)), 1, 8);
    const sx = delta.x / substeps;
    const sz = delta.z / substeps;

    let steppedTop = 0;
    for (let s = 0; s < substeps; s++) {
      p.x += sx;
      p.z += sz;
      const feetY = p.y;
      const hit = this._resolveHorizontal(p, radius, height, feetY, allowStep, slopeLimit, maxStep);
      if (hit.blocked) result.hitWall = true;
      if (hit.steppedUp) { result.steppedUp = true; steppedTop = Math.max(steppedTop, hit.stepTop); }
      if (hit.slide) result.slidAlong = hit.slide;
    }

    // --- vertical ------------------------------------------------------------
    p.y += delta.y;

    const ground = this.groundAt(p.x, p.z, agent.grounded ? p.y + 0.05 : p.y, maxStep, radius);
    if (steppedTop > 0 && ground.y < steppedTop) {
      // A committed step-up is authoritative. groundAt() samples a single point,
      // so at the instant of contact — when the capsule's centre is still just
      // outside the tread's footprint but its base disc already overlaps the
      // tread — it reports the floor BELOW, and the snap would drop the agent
      // back inside the collider it just climbed. Being inside is worse than
      // being one frame early onto the tread: the raised feet then filter that
      // collider out of the next horizontal query and the agent walks through.
      ground.y = steppedTop;
    }
    result.groundY = ground.y;
    result.groundCollider = ground.collider;

    if (p.y <= ground.y + EPSILON) {
      p.y = ground.y;
      if (delta.y < 0) {
        result.grounded = true;
      } else {
        result.grounded = agent.grounded === true;
      }
    } else if (p.y - ground.y <= MOVE.GROUND_SNAP_DISTANCE && delta.y <= 0) {
      // Snap down so walking off a tiny kerb does not become a hop.
      p.y = ground.y;
      result.grounded = true;
    } else {
      result.grounded = false;
    }

    // Ceiling: never allow the capsule to be pushed up through geometry.
    const ceiling = this._ceilingAt(p.x, p.z, p.y, radius, height);
    if (ceiling != null && ceiling < p.y + height) {
      if (delta.y > 0) p.y = Math.max(p.y, ceiling - height);
    }

    // Hard world bounds — the player can never leave the region (P0 prevention).
    if (this.bounds) {
      p.x = clamp(p.x, this.bounds.min.x + radius, this.bounds.max.x - radius);
      p.z = clamp(p.z, this.bounds.min.z + radius, this.bounds.max.z - radius);
      p.y = Math.max(p.y, this.bounds.min.y);
    }

    // Final containment check. Every rule above is local, so a combination of
    // step-up, ground snap, ceiling clamp and bounds clamp could in principle
    // still leave the capsule overlapping something. The invariant "the player
    // never ends a frame inside geometry" is what makes collision authoritative,
    // so it is enforced rather than assumed. This does work only when something
    // upstream was already wrong.
    if (!this.isSpaceFree(p, radius, height)) {
      const hit = this._resolveHorizontal(p, radius, height, p.y, false, slopeLimit, maxStep);
      result.hitWall = result.hitWall || hit.blocked;
      if (hit.slide) result.slidAlong = hit.slide;
      if (!this.isSpaceFree(p, radius, height)) {
        // Still trapped: give up this frame's motion rather than keep the
        // penetrating position, which would let the agent sink deeper over
        // successive frames and eventually fall out of the world.
        p.copy(pos);
        result.recovered = true;
      }
    }

    // Final NaN guard (charter C-12: never produce a broken state).
    p.sanitize(new Vec3(pos.x, pos.y, pos.z));

    result.actualDelta = Vec3.sub(p, pos);
    return result;
  }

  _resolveHorizontal(p, radius, height, feetYStart, allowStep, slopeLimit, maxStep) {
    let feetY = feetYStart;
    const out = { blocked: false, steppedUp: false, slide: null, stepTop: 0 };
    const box = this._queryBox;
    box.min.set(p.x - radius - 0.01, feetY + 0.08, p.z - radius - 0.01);
    box.max.set(p.x + radius + 0.01, feetY + height - 0.08, p.z + radius + 0.01);
    const hits = this.hash.query(box, this._scratch);
    void slopeLimit;

    for (let iter = 0; iter < 4; iter++) {
      let deepest = null;
      for (const c of hits) {
        if (!c.enabled || !c.blocksMovement) continue;
        // Ignore colliders entirely below or above the body.
        if (c.box.max.y <= feetY + 0.08) continue;
        if (c.box.min.y >= feetY + height - 0.08) continue;

        const pen = resolveCircleAABBXZ(p, radius, c.box);
        if (!pen) continue;
        // Resting contact, not penetration: the resolver parks the agent at
        // exactly `radius` from the face, where the reported depth is
        // floating-point dust (~1e-16). Treating that as a hit marks the agent
        // blocked and produces a push-out of nothing. See CONTACT_SKIN.
        if (pen.depth <= CONTACT_SKIN) continue;

        // --- step-up -------------------------------------------------------
        // The gate is the AGENT's capability (MOVE.STEP_HEIGHT), not whatever the
        // collider happens to declare. A collider may opt out of being steppable
        // by declaring a smaller stepHeight, but it must never grant a rise the
        // agent cannot perform. The old code additionally applied a slope test
        // here, which silently capped the climbable rise at
        // radius * tan(SLOPE_LIMIT_DEG) = 0.435 m — below the documented
        // STEP_HEIGHT of 0.45 m, so geometry authored at exactly the stated limit
        // blocked the player. A step is a vertical rise, not a slope; the slope
        // limit belongs to terrain and is enforced by the nav grid.
        const rise = c.top - feetY;
        if (allowStep && c.walkableTop && rise > 0
          && rise <= Math.min(maxStep, c.stepHeight ?? maxStep) + EPSILON) {
          // Verify the raised capsule actually fits before committing. Without
          // this the agent can be stepped up into a ceiling or into a second
          // collider, and — worse — into a height the vertical pass cannot
          // support. An unsupported raise is what allowed tunnelling: once the
          // feet are above a collider's top, that collider is filtered out of
          // the very query that was supposed to keep the agent out of it, so the
          // agent advances through it unopposed.
          this._probePos.set(p.x, c.top + 0.05, p.z);
          if (this.isSpaceFree(this._probePos, radius, height)) {
            p.y = c.top;
            feetY = c.top;
            out.steppedUp = true;
            if (c.top > out.stepTop) out.stepTop = c.top;
            continue;
          }
        }

        if (!deepest || pen.depth > deepest.depth) {
          deepest = { ...pen, collider: c };
        }
      }
      if (!deepest) break;
      p.x += deepest.nx * deepest.depth;
      p.z += deepest.nz * deepest.depth;
      out.blocked = true;
      out.slide = new Vec3(-deepest.nz, 0, deepest.nx); // tangent direction
    }
    return out;
  }

  /** Lowest blocking surface above the capsule head, or null. */
  _ceilingAt(x, z, feetY, radius, height) {
    const box = this._queryBox;
    box.min.set(x - radius, feetY + height, z - radius);
    box.max.set(x + radius, feetY + height + 3.0, z + radius);
    const hits = this.hash.query(box, this._scratch);
    let lowest = null;
    for (const c of hits) {
      if (!c.enabled || !c.blocksMovement) continue;
      if (x < c.box.min.x || x > c.box.max.x) continue;
      if (z < c.box.min.z || z > c.box.max.z) continue;
      if (c.box.min.y < feetY + height) continue;
      if (lowest == null || c.box.min.y < lowest) lowest = c.box.min.y;
    }
    return lowest;
  }

  /**
   * Is a capsule-sized volume free at this position? Used by AI spawn checks,
   * ledge-grab clearance and the camera's "is this framing legal" test.
   *
   * @param {object} opts
   *   ignoreTopBelowY {number|null} — when set, colliders that are standable and
   *   whose top is at or below this height are ignored. This expresses "the agent
   *   can simply step up onto that", which is essential for the nav grid: without
   *   it, every low platform generates a ring of blocked cells around itself and
   *   its own top becomes an island disconnected from the floor.
   */
  isSpaceFree(pos, radius = MOVE.CAPSULE_RADIUS, height = MOVE.CAPSULE_HEIGHT, opts = {}) {
    const ignoreTopBelowY = opts.ignoreTopBelowY ?? null;
    // Shrunk by the contact skin: an agent resting flush against a surface is
    // not inside it. See CONTACT_SKIN.
    const skin = opts.skin ?? CONTACT_SKIN;
    const box = this._queryBox;
    box.min.set(pos.x - radius + skin, pos.y + 0.1 + skin, pos.z - radius + skin);
    box.max.set(pos.x + radius - skin, pos.y + height - skin, pos.z + radius - skin);
    const hits = this.hash.query(box, this._scratch);
    for (const c of hits) {
      if (!c.enabled || !c.blocksMovement) continue;
      if (ignoreTopBelowY != null && c.walkableTop && c.top <= ignoreTopBelowY) continue;
      return false;
    }
    return true;
  }

  stats() {
    return {
      colliders: this.colliders.length,
      cells: this.hash.cells.size,
      rayHits: this.rayHits,
    };
  }
}

/** Determine which face of a box a point lies on, to derive a surface normal. */
function faceNormal(box, point, dir) {
  const cx = (box.min.x + box.max.x) / 2;
  const cy = (box.min.y + box.max.y) / 2;
  const cz = (box.min.z + box.max.z) / 2;
  const ex = (box.max.x - box.min.x) / 2;
  const ey = (box.max.y - box.min.y) / 2;
  const ez = (box.max.z - box.min.z) / 2;

  const dx = (point.x - cx) / (ex || 1);
  const dy = (point.y - cy) / (ey || 1);
  const dz = (point.z - cz) / (ez || 1);
  const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);

  // A ray travelling downward that hits a top face gets normal +Y.
  if (ax >= ay && ax >= az) return new Vec3(-Math.sign(dir.x) || 1, 0, 0);
  if (ay >= ax && ay >= az) return new Vec3(0, -Math.sign(dir.y) || 1, 0);
  return new Vec3(0, 0, -Math.sign(dir.z) || 1);
}
