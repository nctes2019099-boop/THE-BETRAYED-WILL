// THE BETRAYED WILL — pooling and scheduling primitives
// PURE MODULE. Performance-critical infrastructure (Agent 15 / §24).
// Every hot path allocates from a pool instead of the GC, and every non-critical
// system updates on a throttled schedule rather than each frame.

/**
 * Generic object pool with a factory and an optional reset.
 * Avoids per-frame allocation in combat, particles, projectiles and AI queries.
 */
export class Pool {
  constructor(factory, reset = null, initialSize = 0, maxSize = 4096) {
    if (typeof factory !== 'function') throw new TypeError('Pool requires a factory function');
    this.factory = factory;
    this.reset = reset;
    this.maxSize = maxSize;
    this._free = [];
    this.created = 0;
    this.acquired = 0;
    this.reused = 0;
    this.peakLive = 0;
    this._live = 0;
    for (let i = 0; i < initialSize; i++) this._free.push(this._create());
  }

  _create() {
    this.created++;
    return this.factory();
  }

  acquire() {
    this._live++;
    if (this._live > this.peakLive) this.peakLive = this._live;
    const obj = this._free.length ? this._free.pop() : this._create();
    if (this._free.length || this.created > this.acquired) this.reused++;
    this.acquired++;
    return obj;
  }

  release(obj) {
    if (obj == null) return;
    this._live = Math.max(0, this._live - 1);
    if (this.reset) this.reset(obj);
    if (this._free.length < this.maxSize) this._free.push(obj);
  }

  /** Release a whole array back into the pool. */
  releaseAll(list) {
    for (let i = 0; i < list.length; i++) this.release(list[i]);
    list.length = 0;
  }

  prewarm(n) {
    for (let i = 0; i < n; i++) {
      if (this._free.length >= this.maxSize) break;
      this._free.push(this._create());
    }
    return this;
  }

  get available() { return this._free.length; }
  get live() { return this._live; }

  stats() {
    return {
      created: this.created,
      acquired: this.acquired,
      reused: this.reused,
      available: this._free.length,
      live: this._live,
      peakLive: this.peakLive,
      // Reuse ratio: how much of the demand was served without allocation.
      reuseRatio: this.acquired > 0 ? this.reused / this.acquired : 0,
    };
  }
}

/**
 * Throttled scheduler. Systems register with an interval; the scheduler decides
 * each frame which are due. This is the primary CPU-cost control for AI,
 * perception, NPC schedules and ambient systems (§24 "AI time" budget).
 */
export class Scheduler {
  constructor() {
    /** @type {Array<{id:string, fn:Function, interval:number, accumulator:number, enabled:boolean, lastRun:number, runs:number, totalTime:number}>} */
    this.tasks = [];
    this.elapsed = 0;
  }

  /**
   * @param {string} id unique task id
   * @param {Function} fn receives (dt, elapsed)
   * @param {number} interval seconds between runs; 0 = every frame
   */
  add(id, fn, interval = 0) {
    if (this.get(id)) throw new Error(`Scheduler: duplicate task id "${id}"`);
    const task = {
      id, fn, interval: Math.max(0, interval),
      accumulator: 0, enabled: true, lastRun: -Infinity, runs: 0, totalTime: 0,
    };
    this.tasks.push(task);
    return task;
  }

  get(id) { return this.tasks.find((t) => t.id === id) ?? null; }
  remove(id) { const i = this.tasks.findIndex((t) => t.id === id); if (i >= 0) this.tasks.splice(i, 1); }
  enable(id, on = true) { const t = this.get(id); if (t) t.enabled = on; }

  /**
   * Advance. Staggered phase offsets are applied by registration order so that
   * not every throttled system lands on the same frame (spike smoothing).
   */
  update(dt) {
    this.elapsed += dt;
    let ran = 0;
    for (let i = 0; i < this.tasks.length; i++) {
      const t = this.tasks[i];
      if (!t.enabled) continue;
      if (t.interval <= 0) {
        this._run(t, dt);
        ran++;
        continue;
      }
      // Phase offset spreads load evenly across the interval.
      t.accumulator += dt;
      const offset = (i / Math.max(1, this.tasks.length)) * t.interval;
      if (t.accumulator + offset >= t.interval) {
        const step = t.accumulator > 0 ? t.accumulator : dt;
        this._run(t, step);
        t.accumulator = 0;
        ran++;
      }
    }
    return ran;
  }

  _run(t, dt) {
    const start = nowMs();
    try {
      t.fn(dt, this.elapsed);
    } catch (err) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn(`[Scheduler] task "${t.id}" threw:`, err?.message ?? err);
      }
      t.enabled = false; // quarantine a broken task rather than crash the frame
    }
    t.runs++;
    t.totalTime += nowMs() - start;
    t.lastRun = this.elapsed;
  }

  stats() {
    return this.tasks.map((t) => ({
      id: t.id,
      interval: t.interval,
      enabled: t.enabled,
      runs: t.runs,
      avgMs: t.runs ? t.totalTime / t.runs : 0,
      totalMs: t.totalTime,
    }));
  }
}

function nowMs() {
  if (typeof performance !== 'undefined' && performance.now) return performance.now();
  return Date.now();
}

/**
 * Ring buffer of recent samples — used for FPS/frame-time/AI-cost telemetry
 * without unbounded memory growth.
 */
export class RingBuffer {
  constructor(capacity = 120) {
    this.capacity = Math.max(1, capacity | 0);
    this.data = new Float64Array(this.capacity);
    this.index = 0;
    this.count = 0;
  }
  push(v) {
    this.data[this.index] = v;
    this.index = (this.index + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    return this;
  }
  get last() { return this.count ? this.data[(this.index - 1 + this.capacity) % this.capacity] : 0; }
  sum() { let s = 0; for (let i = 0; i < this.count; i++) s += this.data[i]; return s; }
  mean() { return this.count ? this.sum() / this.count : 0; }
  min() {
    if (!this.count) return 0;
    let m = Infinity;
    for (let i = 0; i < this.count; i++) if (this.data[i] < m) m = this.data[i];
    return m;
  }
  max() {
    if (!this.count) return 0;
    let m = -Infinity;
    for (let i = 0; i < this.count; i++) if (this.data[i] > m) m = this.data[i];
    return m;
  }
  /** Percentile over the retained window (p in 0..1). */
  percentile(p) {
    if (!this.count) return 0;
    const sorted = Array.from(this.data.subarray(0, this.count)).sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
    return sorted[idx];
  }
  toArray() {
    if (this.count < this.capacity) return Array.from(this.data.subarray(0, this.count));
    const out = [];
    for (let i = 0; i < this.capacity; i++) out.push(this.data[(this.index + i) % this.capacity]);
    return out;
  }
  clear() { this.index = 0; this.count = 0; this.data.fill(0); }
}

/** Reusable scratch vectors — avoids allocation in per-frame geometry queries. */
export const scratch = {
  a: null, b: null, c: null, d: null,
};

/** One-shot timer helper for gameplay beats (hit-stop, shake, prompts). */
export class Countdown {
  constructor(duration = 0) { this.duration = duration; this.remaining = 0; }
  start(duration = this.duration) { this.duration = duration; this.remaining = duration; return this; }
  tick(dt) {
    if (this.remaining <= 0) return false;
    this.remaining = Math.max(0, this.remaining - dt);
    return this.remaining === 0; // true exactly on the frame it expires
  }
  get active() { return this.remaining > 0; }
  get progress() { return this.duration > 0 ? 1 - this.remaining / this.duration : 0; }
  cancel() { this.remaining = 0; }
}
