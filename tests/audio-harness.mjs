/**
 * THE BETRAYED WILL — tests/audio-harness.mjs
 *
 * A WebAudio-shaped recorder.
 *
 * Named `-harness` because that is what run.sh skips: it is imported by the audio
 * suite and must not be discovered as one.
 *
 * The audio engine builds graphs out of nodes the test environment does not have.
 * Rather than skip the audio suites, or worse, assert only that the engine did not
 * throw, this implements enough of the AudioContext surface that a real graph can be
 * built against it and then read back: which nodes were created, how they were wired,
 * and what automation was scheduled on each parameter.
 *
 * That makes audio testable the same way the simulation is. A suite can assert that a
 * parry uses more inharmonic partials than a blocked hit, that a footstep's gain
 * tracks the noise radius the AI hears, and that muting ramps the master bus instead
 * of snapping it - none of which requires anyone to listen to anything.
 *
 * The clock is manual. `advance(seconds)` moves `currentTime` without waiting, so a
 * suite can schedule four bars of music and inspect every note synchronously.
 */

let nodeSerial = 0;

class FakeAudioParam {
  constructor(value = 0, name = 'param') {
    this.value = value;
    this.name = name;
    /** Every automation event, in the order it was scheduled. */
    this.events = [];
  }

  setValueAtTime(value, when) {
    this.events.push({ type: 'set', value, when });
    this.value = value;
    return this;
  }

  linearRampToValueAtTime(value, when) {
    this.events.push({ type: 'linear', value, when });
    this.value = value;
    return this;
  }

  exponentialRampToValueAtTime(value, when) {
    // A real context throws on a ramp to zero, which is the single most common way to
    // break an envelope. Faking the throw is the only way a test would catch it.
    if (!(value > 0)) throw new RangeError('exponentialRampToValueAtTime: target must be > 0');
    if (!(this.value > 0)) throw new RangeError('exponentialRampToValueAtTime: current value must be > 0');
    this.events.push({ type: 'exponential', value, when });
    this.value = value;
    return this;
  }

  cancelScheduledValues(when) {
    this.events.push({ type: 'cancel', when });
    this.events = this.events.filter((e) => e.type === 'cancel' || e.when < when);
    return this;
  }

  setTargetAtTime(value, when, timeConstant) {
    this.events.push({ type: 'target', value, when, timeConstant });
    this.value = value;
    return this;
  }
}

class FakeNode {
  /**
   * @param {string} kind the node's classification, used by ofType().
   *
   * `kind` and `type` are deliberately different properties. In real WebAudio,
   * `type` on an oscillator is its waveform and on a filter its shape, while the node's
   * classification is only available as a constructor name - which a fake cannot
   * reproduce. Overloading one property for both would mean `ofType('oscillator')`
   * stops matching the moment the code under test sets `osc.type = 'sine'`.
   */
  constructor(ctx, kind) {
    this.ctx = ctx;
    this.kind = kind;
    this.id = `n${++nodeSerial}`;
    this.outputs = [];
    this.disconnected = false;
    ctx._nodes.push(this);
  }

  connect(dest) {
    if (this.disconnected) throw new Error(`${this.kind} used after disconnect()`);
    this.outputs.push(dest);
    if (dest instanceof FakeNode) dest.inputs = (dest.inputs ?? 0) + 1;
    return dest;
  }

  disconnect() { this.disconnected = true; this.outputs = []; }

  /** Everything downstream of this node, for wiring assertions. */
  downstream(depth = 0, seen = new Set()) {
    if (depth > 12 || seen.has(this.id)) return [];
    seen.add(this.id);
    const out = [];
    for (const d of this.outputs) {
      if (!(d instanceof FakeNode)) continue;
      out.push(d);
      out.push(...d.downstream(depth + 1, seen));
    }
    return out;
  }
}

class FakeSourceNode extends FakeNode {
  constructor(ctx, kind) {
    super(ctx, kind);
    this.startedAt = null;
    this.stoppedAt = null;
    ctx._sources.push(this);
  }

  start(when = 0) {
    if (this.startedAt !== null) throw new Error(`${this.kind}.start() called twice`);
    this.startedAt = when;
    this.ctx._starts++;
  }

  stop(when = 0) {
    if (this.startedAt === null) throw new Error(`${this.kind}.stop() before start()`);
    this.stoppedAt = when;
    this.ctx._stops++;
  }
}

export class FakeAudioContext {
  constructor({ sampleRate = 44100 } = {}) {
    this.sampleRate = sampleRate;
    this.state = 'suspended';          // a real gesture-created context starts here
    this.currentTime = 0;

    // The registries exist before the destination node, which registers itself.
    this._nodes = [];
    this._sources = [];
    this._buffers = [];
    this._starts = 0;
    this._stops = 0;
    this._mark = { nodes: 0, sources: 0, starts: 0, stops: 0 };

    this.destination = new FakeNode(this, 'destination');

    this.resumes = 0;
    this.suspends = 0;
    this.closes = 0;
  }

  /* ------------------------------------------------------------- factories */

  createGain() {
    const g = new FakeNode(this, 'gain');
    g.gain = new FakeAudioParam(1, 'gain');
    return g;
  }

  createOscillator() {
    const o = new FakeSourceNode(this, 'oscillator');
    o.frequency = new FakeAudioParam(440, 'frequency');
    o.detune = new FakeAudioParam(0, 'detune');
    o.type = 'sine';
    return o;
  }

  createBufferSource() {
    const s = new FakeSourceNode(this, 'bufferSource');
    s.buffer = null;
    s.loop = false;
    s.playbackRate = new FakeAudioParam(1, 'playbackRate');
    return s;
  }

  createBiquadFilter() {
    const f = new FakeNode(this, 'biquad');
    f.frequency = new FakeAudioParam(350, 'frequency');
    f.Q = new FakeAudioParam(1, 'Q');
    f.gain = new FakeAudioParam(0, 'gain');
    f.detune = new FakeAudioParam(0, 'detune');
    f.type = 'lowpass';
    return f;
  }

  createStereoPanner() {
    const p = new FakeNode(this, 'panner');
    p.pan = new FakeAudioParam(0, 'pan');
    return p;
  }

  createDelay(maxDelay = 1) {
    const d = new FakeNode(this, 'delay');
    d.delayTime = new FakeAudioParam(0, 'delayTime');
    d.maxDelay = maxDelay;
    return d;
  }

  createBuffer(channels, length, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    const buf = { numberOfChannels: channels, length, sampleRate, duration: length / sampleRate, getChannelData: (i) => data[i] };
    this._buffers.push(buf);
    return buf;
  }

  resume() { this.resumes++; this.state = 'running'; return Promise.resolve(); }
  suspend() { this.suspends++; this.state = 'suspended'; return Promise.resolve(); }
  close() { this.closes++; this.state = 'closed'; return Promise.resolve(); }

  /* -------------------------------------------------------------- the clock */

  /** Move time forward. Nothing plays; this only advances currentTime. */
  advance(seconds) {
    this.currentTime += seconds;
    return this.currentTime;
  }

  /* ---------------------------------------------------------- introspection */

  /** Every node of a given kind, newest last. */
  ofType(kind) { return this._nodes.filter((n) => n.kind === kind); }

  /** Nodes whose outputs reach `target`, one hop. */
  connectedTo(target) { return this._nodes.filter((n) => n.outputs.includes(target)); }

  /** Sources that were started but never stopped - a leak check. */
  get dangling() { return this._sources.filter((s) => s.startedAt !== null && s.stoppedAt === null); }

  /** Total automation events scheduled, as a rough measure of graph complexity. */
  get automationCount() {
    let n = 0;
    for (const node of this._nodes) {
      for (const key of Object.keys(node)) {
        if (node[key] instanceof FakeAudioParam) n += node[key].events.length;
      }
    }
    return n;
  }

  /** Frequency values handed to oscillators, for tuning assertions. */
  get oscillatorFrequencies() {
    return this.ofType('oscillator').map((o) => o.frequency.events.length
      ? o.frequency.events[0].value ?? o.frequency.value
      : o.frequency.value);
  }

  /** Reset counters without discarding the graph. */
  mark() {
    const snapshot = { nodes: this._nodes.length, sources: this._sources.length, starts: this._starts, stops: this._stops };
    this._mark = snapshot;
    return snapshot;
  }

  since(mark = this._mark) {
    return {
      nodes: this._nodes.length - mark.nodes,
      sources: this._sources.length - mark.sources,
      starts: this._starts - mark.starts,
      stops: this._stops - mark.stops,
    };
  }
}

export { FakeAudioParam, FakeNode, FakeSourceNode };
