// THE BETRAYED WILL — core maths
// PURE MODULE: no DOM, no Three.js. Importable from Node for headless testing.
// Every simulation system shares these primitives so that browser behaviour and
// test behaviour are numerically identical (charter C-1: evidence is authority).

export const EPSILON = 1e-6;
export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
export const TAU = Math.PI * 2;

/* ------------------------------------------------------------------ scalars */

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const sign = (v) => (v < 0 ? -1 : v > 0 ? 1 : 0);
export const signOr = (v, fallback = 1) => (v === 0 ? fallback : v < 0 ? -1 : 1);

/** Inverse-lerp: where does v sit between a and b, as 0..1. */
export const inverseLerp = (a, b, v) => (Math.abs(b - a) < EPSILON ? 0 : clamp01((v - a) / (b - a)));

/** Remap v from [a1,b1] into [a2,b2]. */
export const remap = (v, a1, b1, a2, b2) => lerp(a2, b2, inverseLerp(a1, b1, v));

/**
 * Frame-rate independent exponential smoothing.
 * `halfLife` is the time (seconds) for the residual gap to halve.
 * This is the single smoothing primitive used by camera, AI turn rates and UI so
 * that behaviour is identical at 30, 60 or 144 fps (no dt-sensitivity bug).
 */
export function damp(current, target, halfLife, dt) {
  if (halfLife <= EPSILON) return target;
  if (dt <= 0) return current;
  const t = 1 - Math.pow(2, -dt / halfLife);
  return current + (target - current) * t;
}

/** Same as damp but for angles, taking the shortest rotational path. */
export function dampAngle(current, target, halfLife, dt) {
  return current + shortestAngle(target - current) * (halfLife <= EPSILON || dt <= 0
    ? (halfLife <= EPSILON ? 1 : 0)
    : 1 - Math.pow(2, -dt / halfLife));
}

/** Wrap an angle into [-PI, PI]. */
export function wrapAngle(a) {
  let x = a % TAU;
  if (x > Math.PI) x -= TAU;
  else if (x < -Math.PI) x += TAU;
  return x;
}

/** Signed smallest difference from a to b, in [-PI, PI]. */
export const shortestAngle = (b, a = 0) => wrapAngle(b - a);

/** Move `current` toward `target` by at most `maxDelta` (radians). */
export function moveTowardsAngle(current, target, maxDelta) {
  const d = shortestAngle(target, current);
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

export const moveTowards = (current, target, maxDelta) => {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
};

/** Move toward target by a rate expressed in units-per-second. */
export const approach = (current, target, rate, dt) => moveTowards(current, target, rate * dt);

export const smoothstep = (t) => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};
export const smootherstep = (t) => {
  const x = clamp01(t);
  return x * x * x * (x * (x * 6 - 15) + 10);
};
export const easeOutCubic = (t) => 1 - Math.pow(1 - clamp01(t), 3);
export const easeInCubic = (t) => Math.pow(clamp01(t), 3);
export const easeInOutCubic = (t) => {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};
export const easeOutBack = (t, s = 1.70158) => {
  const x = clamp01(t) - 1;
  return 1 + (s + 1) * x * x * x + s * x * x;
};

/** Hermite blend used for surface/height transitions. */
export const hermite = (a, b, t) => {
  const x = clamp01(t);
  const h = x * x * (3 - 2 * x);
  return lerp(a, b, h);
};

export const approxEqual = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps;

/* ------------------------------------------------------------------- Vec2 */

export class Vec2 {
  constructor(x = 0, y = 0) { this.x = x; this.y = y; }
  set(x, y) { this.x = x; this.y = y; return this; }
  copy(v) { this.x = v.x; this.y = v.y; return this; }
  clone() { return new Vec2(this.x, this.y); }
  add(v) { this.x += v.x; this.y += v.y; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; return this; }
  scale(s) { this.x *= s; this.y *= s; return this; }
  get lengthSq() { return this.x * this.x + this.y * this.y; }
  get length() { return Math.hypot(this.x, this.y); }
  normalize() {
    const l = this.length;
    if (l > EPSILON) { this.x /= l; this.y /= l; } else { this.x = 0; this.y = 0; }
    return this;
  }
  dot(v) { return this.x * v.x + this.y * v.y; }
  /** Signed 2D cross (z component of the 3D cross). */
  cross(v) { return this.x * v.y - this.y * v.x; }
  lerpTo(v, t) { this.x = lerp(this.x, v.x, t); this.y = lerp(this.y, v.y, t); return this; }
  distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y); }
  angle() { return Math.atan2(this.y, this.x); }
  static fromAngle(a, len = 1) { return new Vec2(Math.cos(a) * len, Math.sin(a) * len); }
  static add(a, b) { return new Vec2(a.x + b.x, a.y + b.y); }
  static sub(a, b) { return new Vec2(a.x - b.x, a.y - b.y); }
  static scale(a, s) { return new Vec2(a.x * s, a.y * s); }
  static dot(a, b) { return a.x * b.x + a.y * b.y; }
  static dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
}

/* ------------------------------------------------------------------- Vec3 */

export class Vec3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new Vec3(this.x, this.y, this.z); }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  addScaled(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  scale(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  negate() { return this.scale(-1); }
  get lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  get length() { return Math.sqrt(this.lengthSq); }
  normalize() {
    const l = this.length;
    if (l > EPSILON) { this.x /= l; this.y /= l; this.z /= l; } else { this.x = 0; this.y = 0; this.z = 0; }
    return this;
  }
  normalized() { return this.clone().normalize(); }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  cross(v) {
    const x = this.y * v.z - this.z * v.y;
    const y = this.z * v.x - this.x * v.z;
    const z = this.x * v.y - this.y * v.x;
    return this.set(x, y, z);
  }
  crossed(v) { return this.clone().cross(v); }
  lerpTo(v, t) {
    this.x = lerp(this.x, v.x, t);
    this.y = lerp(this.y, v.y, t);
    this.z = lerp(this.z, v.z, t);
    return this;
  }
  distanceTo(v) { return Math.sqrt(this.distanceSqTo(v)); }
  distanceSqTo(v) {
    const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z;
    return dx * dx + dy * dy + dz * dz;
  }
  /** Horizontal (XZ) distance — used for ground-relative gameplay queries. */
  distanceXZ(v) { return Math.hypot(this.x - v.x, this.z - v.z); }
  maxComponent() { return Math.max(Math.abs(this.x), Math.abs(this.y), Math.abs(this.z)); }
  isFiniteVec() { return Number.isFinite(this.x) && Number.isFinite(this.y) && Number.isFinite(this.z); }
  /** Guard against NaN propagation — returns a safe fallback instead. */
  sanitize(fallback = Vec3.ZERO) {
    return this.isFiniteVec() ? this : this.copy(fallback);
  }
  toArray() { return [this.x, this.y, this.z]; }
  static fromArray(a) { return new Vec3(a[0] || 0, a[1] || 0, a[2] || 0); }
  static add(a, b) { return new Vec3(a.x + b.x, a.y + b.y, a.z + b.z); }
  static sub(a, b) { return new Vec3(a.x - b.x, a.y - b.y, a.z - b.z); }
  static scale(a, s) { return new Vec3(a.x * s, a.y * s, a.z * s); }
  static lerp(a, b, t) { return new Vec3(lerp(a.x, b.x, t), lerp(a.y, b.y, t), lerp(a.z, b.z, t)); }
  static dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
  static cross(a, b) { return new Vec3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x); }
  static dist(a, b) { return a.distanceTo(b); }
  static distXZ(a, b) { return a.distanceXZ(b); }
  static up() { return new Vec3(0, 1, 0); }
  static zero() { return new Vec3(0, 0, 0); }
}
Vec3.ZERO = Object.freeze(new Vec3(0, 0, 0));
Vec3.UP = Object.freeze(new Vec3(0, 1, 0));
Vec3.FORWARD = Object.freeze(new Vec3(0, 0, -1));
Vec3.RIGHT = Object.freeze(new Vec3(1, 0, 0));

/* --------------------------------------------------------------- geometry */

/** Axis-aligned bounding box. */
export class AABB {
  constructor(min = new Vec3(), max = new Vec3()) { this.min = min; this.max = max; }
  static fromCenterExtents(center, extents) {
    return new AABB(Vec3.sub(center, extents), Vec3.add(center, extents));
  }
  static fromPoints(points) {
    const min = new Vec3(Infinity, Infinity, Infinity);
    const max = new Vec3(-Infinity, -Infinity, -Infinity);
    for (const p of points) {
      min.x = Math.min(min.x, p.x); min.y = Math.min(min.y, p.y); min.z = Math.min(min.z, p.z);
      max.x = Math.max(max.x, p.x); max.y = Math.max(max.y, p.y); max.z = Math.max(max.z, p.z);
    }
    return new AABB(min, max);
  }
  get center() { return Vec3.scale(Vec3.add(this.min, this.max), 0.5); }
  get size() { return Vec3.sub(this.max, this.min); }
  get extents() { return Vec3.scale(Vec3.sub(this.max, this.min), 0.5); }
  containsPoint(p) {
    return p.x >= this.min.x && p.x <= this.max.x
      && p.y >= this.min.y && p.y <= this.max.y
      && p.z >= this.min.z && p.z <= this.max.z;
  }
  intersects(o) {
    return this.min.x <= o.max.x && this.max.x >= o.min.x
      && this.min.y <= o.max.y && this.max.y >= o.min.y
      && this.min.z <= o.max.z && this.max.z >= o.min.z;
  }
  expand(m) {
    return new AABB(
      new Vec3(this.min.x - m, this.min.y - m, this.min.z - m),
      new Vec3(this.max.x + m, this.max.y + m, this.max.z + m),
    );
  }
  /** Closest point inside the box to p — used for penetration depth. */
  closestPoint(p) {
    return new Vec3(clamp(p.x, this.min.x, this.max.x), clamp(p.y, this.min.y, this.max.y), clamp(p.z, this.min.z, this.max.z));
  }
}

/**
 * Slab-method ray/AABB intersection.
 * @returns {number|null} entry distance t along the ray, or null if no hit.
 */
export function rayAABB(origin, dir, box, maxDist = Infinity) {
  let tmin = 0;
  let tmax = maxDist;
  const o = [origin.x, origin.y, origin.z];
  const d = [dir.x, dir.y, dir.z];
  const lo = [box.min.x, box.min.y, box.min.z];
  const hi = [box.max.x, box.max.y, box.max.z];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < EPSILON) {
      if (o[i] < lo[i] || o[i] > hi[i]) return null;
      continue;
    }
    const inv = 1 / d[i];
    let t1 = (lo[i] - o[i]) * inv;
    let t2 = (hi[i] - o[i]) * inv;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmin;
}

/** Ray vs horizontal ground plane y = height. Returns distance t or null. */
export function rayPlaneY(origin, dir, height = 0) {
  if (Math.abs(dir.y) < EPSILON) return null;
  const t = (height - origin.y) / dir.y;
  return t >= 0 ? t : null;
}

/**
 * Ray vs infinite vertical cylinder (used for character capsule proxies).
 * Returns nearest non-negative t or null.
 */
export function rayCylinderXZ(origin, dir, center, radius, yMin, yMax) {
  const ox = origin.x - center.x;
  const oz = origin.z - center.z;
  const a = dir.x * dir.x + dir.z * dir.z;
  if (a < EPSILON) return null;
  const b = 2 * (ox * dir.x + oz * dir.z);
  const c = ox * ox + oz * oz - radius * radius;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / (2 * a);
  const t2 = (-b + sq) / (2 * a);
  for (const t of [t1, t2]) {
    if (t < 0) continue;
    const y = origin.y + dir.y * t;
    if (y >= yMin && y <= yMax) return t;
  }
  return null;
}

/** Distance from point p to segment ab. */
export function distancePointSegment(p, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const len2 = abx * abx + aby * aby + abz * abz;
  let t = len2 > EPSILON ? ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / len2 : 0;
  t = clamp01(t);
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t), p.z - (a.z + abz * t));
}

/** Swept horizontal capsule vs AABB penetration resolution on the XZ plane. */
export function resolveCircleAABBXZ(pos, radius, box) {
  const cx = clamp(pos.x, box.min.x, box.max.x);
  const cz = clamp(pos.z, box.min.z, box.max.z);
  const dx = pos.x - cx;
  const dz = pos.z - cz;
  const d2 = dx * dx + dz * dz;
  if (d2 >= radius * radius) return null;
  if (d2 > EPSILON) {
    const d = Math.sqrt(d2);
    const push = radius - d;
    return { nx: dx / d, nz: dz / d, depth: push };
  }
  // Centre is inside the box: push out along the shallowest axis.
  const left = pos.x - box.min.x, right = box.max.x - pos.x;
  const front = pos.z - box.min.z, back = box.max.z - pos.z;
  const m = Math.min(left, right, front, back);
  if (m === left) return { nx: -1, nz: 0, depth: left + radius };
  if (m === right) return { nx: 1, nz: 0, depth: right + radius };
  if (m === front) return { nx: 0, nz: -1, depth: front + radius };
  return { nx: 0, nz: 1, depth: back + radius };
}

/* --------------------------------------------------------------- quaternion */

/**
 * Minimal quaternion (x,y,z,w) — enough for the camera and character facing.
 * Kept hand-rolled so the simulation layer stays Three.js-free.
 */
export class Quat {
  constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
  static fromAxisAngle(ax, ay, az, angle) {
    const h = angle * 0.5;
    const s = Math.sin(h);
    const l = Math.hypot(ax, ay, az) || 1;
    return new Quat((ax / l) * s, (ay / l) * s, (az / l) * s, Math.cos(h));
  }
  static fromYawPitch(yaw, pitch) {
    const qy = Quat.fromAxisAngle(0, 1, 0, yaw);
    const qx = Quat.fromAxisAngle(1, 0, 0, pitch);
    return qy.multiply(qx);
  }
  static identity() { return new Quat(0, 0, 0, 1); }
  clone() { return new Quat(this.x, this.y, this.z, this.w); }
  normalize() {
    const l = Math.hypot(this.x, this.y, this.z, this.w) || 1;
    this.x /= l; this.y /= l; this.z /= l; this.w /= l;
    return this;
  }
  multiply(q) {
    const { x: ax, y: ay, z: az, w: aw } = this;
    const { x: bx, y: by, z: bz, w: bw } = q;
    return new Quat(
      aw * bx + ax * bw + ay * bz - az * by,
      aw * by - ax * bz + ay * bw + az * bx,
      aw * bz + ax * by - ay * bx + az * bw,
      aw * bw - ax * bx - ay * by - az * bz,
    );
  }
  rotateVec3(v) {
    const { x, y, z, w } = this;
    const tx = 2 * (y * v.z - z * v.y);
    const ty = 2 * (z * v.x - x * v.z);
    const tz = 2 * (x * v.y - y * v.x);
    return new Vec3(
      v.x + w * tx + (y * tz - z * ty),
      v.y + w * ty + (z * tx - x * tz),
      v.z + w * tz + (x * ty - y * tx),
    );
  }
  /** Forward is -Z by convention (matches Three.js and our world space). */
  forward() { return this.rotateVec3(Vec3.FORWARD).normalize(); }
  right() { return this.rotateVec3(Vec3.RIGHT).normalize(); }
  static slerp(a, b, t) {
    let dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
    let bx = b.x, by = b.y, bz = b.z, bw = b.w;
    if (dot < 0) { dot = -dot; bx = -bx; by = -by; bz = -bz; bw = -bw; }
    if (dot > 0.9995) {
      return new Quat(
        lerp(a.x, bx, t), lerp(a.y, by, t), lerp(a.z, bz, t), lerp(a.w, bw, t),
      ).normalize();
    }
    const theta = Math.acos(clamp(dot, -1, 1));
    const sinTheta = Math.sin(theta);
    const wa = Math.sin((1 - t) * theta) / sinTheta;
    const wb = Math.sin(t * theta) / sinTheta;
    return new Quat(
      a.x * wa + bx * wb, a.y * wa + by * wb, a.z * wa + bz * wb, a.w * wa + bw * wb,
    ).normalize();
  }
}

/* ------------------------------------------------------------------ colours */

/** Convert hex 0xRRGGBB to normalised [r,g,b]. */
export function hexToRGB(hex) {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}
export function rgbToHex(r, g, b) {
  const c = (v) => clamp(Math.round(v * 255), 0, 255);
  return (c(r) << 16) | (c(g) << 8) | c(b);
}
/** Linear interpolation between two hex colours, returned as hex. */
export function lerpHex(a, b, t) {
  const [ar, ag, ab] = hexToRGB(a);
  const [br, bg, bb] = hexToRGB(b);
  return rgbToHex(lerp(ar, br, t), lerp(ag, bg, t), lerp(ab, bb, t));
}

/* ------------------------------------------------------------------- curves */

/**
 * Piecewise-linear curve over [x,y] control points, sorted by x.
 * Used for damage falloff, suspicion response, fog density, audio intensity.
 */
export class Curve {
  constructor(points) {
    this.points = points.slice().sort((a, b) => a[0] - b[0]);
  }
  evaluate(x) {
    const pts = this.points;
    if (pts.length === 0) return 0;
    if (x <= pts[0][0]) return pts[0][1];
    if (x >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
    for (let i = 0; i < pts.length - 1; i++) {
      if (x >= pts[i][0] && x <= pts[i + 1][0]) {
        return lerp(pts[i][1], pts[i + 1][1], inverseLerp(pts[i][0], pts[i + 1][0], x));
      }
    }
    return pts[pts.length - 1][1];
  }
}
