// THE BETRAYED WILL — deterministic random number generation
// PURE MODULE. Seeded, reproducible, and serialisable so that:
//   * procedural assets are identical across runs and across save/load
//   * tests can assert exact outcomes (charter C-1)
//   * a save file can restore world state without storing every generated detail

/** FNV-1a 32-bit string hash — stable across platforms and JS engines. */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mix several integers into one 32-bit seed (for composite keys). */
export function hashCombine(...values) {
  let h = 0x9e3779b9;
  for (const v of values) {
    h = Math.imul(h ^ (typeof v === 'string' ? hashString(v) : (v | 0)), 0x85ebca6b);
    h ^= h >>> 13;
  }
  return h >>> 0;
}

/**
 * mulberry32 — small, fast, good-quality 32-bit PRNG.
 * Period 2^32; entirely sufficient for procedural variation and never
 * security-sensitive (no crypto use anywhere in this project).
 */
export class RNG {
  constructor(seed = 1) {
    this.setSeed(seed);
  }

  setSeed(seed) {
    this.seed = (typeof seed === 'string' ? hashString(seed) : (seed >>> 0)) || 1;
    this._state = this.seed;
    return this;
  }

  /** Restore an exact stream position (used by save/load). */
  setState(state) {
    this._state = (state >>> 0) || 1;
    return this;
  }

  getState() { return this._state >>> 0; }

  /** Uniform float in [0,1). */
  next() {
    this._state = (this._state + 0x6d2b79f5) >>> 0;
    let t = this._state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [min,max). */
  range(min, max) { return min + (max - min) * this.next(); }

  /** Uniform integer in [min,max] inclusive. */
  int(min, max) { return Math.floor(this.range(min, max + 1 - Number.EPSILON)); }

  /** True with probability p. */
  chance(p) { return this.next() < p; }

  pick(array) {
    if (!array || array.length === 0) return undefined;
    return array[this.int(0, array.length - 1)];
  }

  /** Fisher–Yates shuffle, in place, deterministic. */
  shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const tmp = array[i];
      array[i] = array[j];
      array[j] = tmp;
    }
    return array;
  }

  /** Weighted pick: entries are [value, weight]. */
  weighted(entries) {
    let total = 0;
    for (const e of entries) total += e[1];
    if (total <= 0) return entries.length ? entries[0][0] : undefined;
    let r = this.next() * total;
    for (const e of entries) {
      r -= e[1];
      if (r <= 0) return e[0];
    }
    return entries[entries.length - 1][0];
  }

  /** Normal-ish distribution via sum of uniforms (Irwin–Hall, n=3). */
  bell(min, max) {
    const v = (this.next() + this.next() + this.next()) / 3;
    return min + (max - min) * v;
  }

  sign() { return this.next() < 0.5 ? -1 : 1; }

  /** Fork a child stream that does not disturb this one (for parallel generation). */
  fork(label = '') {
    return new RNG(hashCombine(this.getState(), label));
  }

  /** Snapshot for save files. */
  serialize() { return { seed: this.seed, state: this.getState() }; }

  static deserialize(data) {
    const rng = new RNG(data?.seed ?? 1);
    if (data?.state != null) rng.setState(data.state);
    return rng;
  }
}

/** Shared default stream — gameplay systems should prefer injected RNGs. */
export const defaultRNG = new RNG(0xbe77ed);

/**
 * Deterministic value noise on a 1-D integer lattice, smoothstep-interpolated.
 * Used for terrain undulation, wall irregularity and prop scatter.
 */
export function noise1(x, seed = 0) {
  const i = Math.floor(x);
  const f = x - i;
  const a = (hashCombine(i, seed) >>> 8) / 16777216;
  const b = (hashCombine(i + 1, seed) >>> 8) / 16777216;
  const t = f * f * (3 - 2 * f);
  return a + (b - a) * t;
}

/** Two-octave 1-D fractal noise in [-1,1]. */
export function fbm1(x, seed = 0, octaves = 2) {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += (noise1(x * freq, seed + o * 1013) * 2 - 1) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return norm > 0 ? sum / norm : 0;
}

/**
 * Deterministic 2-D value noise in [0,1) — the basis of every procedural
 * texture and surface-variation pattern in the asset pipeline.
 */
export function noise2(x, y, seed = 0) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const h = (a, b) => (hashCombine(a, b, seed) >>> 8) / 16777216;
  const v00 = h(ix, iy), v10 = h(ix + 1, iy), v01 = h(ix, iy + 1), v11 = h(ix + 1, iy + 1);
  const tx = fx * fx * (3 - 2 * fx);
  const ty = fy * fy * (3 - 2 * fy);
  const top = v00 + (v10 - v00) * tx;
  const bot = v01 + (v11 - v01) * tx;
  return top + (bot - top) * ty;
}

/** 2-D fractal noise in [0,1). */
export function fbm2(x, y, seed = 0, octaves = 4) {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += noise2(x * freq, y * freq, seed + o * 7919) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return norm > 0 ? sum / norm : 0;
}
