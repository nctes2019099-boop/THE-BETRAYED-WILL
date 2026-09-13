/**
 * THE BETRAYED WILL — audio/engine.js
 *
 * The WebAudio layer: builds every sound from oscillators, noise buffers and
 * filters at runtime. Nothing is loaded, fetched or decoded, because the brief
 * requires every asset be generated procedurally and the game must run offline with
 * no external runtime dependency. A "sample" in this codebase is a set of numbers
 * describing how to build one.
 *
 * ── Two engines, one interface ──────────────────────────────────────────────
 * NullAudioEngine implements the same API and does nothing. It is what runs when
 * there is no AudioContext - every headless suite, and a browser that refuses one -
 * so no caller anywhere in the game has to ask whether audio exists before using it.
 * A game that throws when it cannot make a sound is a game that does not start.
 *
 * ── The context is created on a gesture, never at boot ───────────────────────
 * Browsers suspend an AudioContext that was not started by a user gesture, and a
 * suspended context is silent without being an error. So the engine is constructed
 * at boot, and `unlock()` is called from the Begin button. Constructing the context
 * eagerly would produce a game that boots into permanent silence and reports nothing
 * wrong, which is the worst available outcome: it looks like the audio was never
 * written.
 *
 * ── The scheduler is driven, not timed ──────────────────────────────────────
 * Music is scheduled from `update(now)` rather than from setInterval. A timer keeps
 * running when the tab is hidden and drifts against the audio clock; a driven
 * scheduler stops when the game stops, which is both correct and testable - a suite
 * can advance `now` and assert which notes were placed, without waiting in real
 * time for them.
 */

import { AUDIO } from '../core/constants.js';
import { clamp, clamp01 } from '../core/math.js';
import { CUES, ambienceFor, degreeFrequency, droneFrequencies, phrase, weatherBed } from './theory.js';

/**
 * Where in the mode's register each kind of note sits, in octaves above the root.
 *
 * The drone takes the root itself, so the melody is placed an octave clear of it and
 * stingers two: without that separation every layer lands in the same 130 Hz band and
 * the score turns into one thick sound rather than four that can be heard apart.
 */
const MELODY_OCTAVE = 1;
const STINGER_OCTAVE = 2;

/** What the engine does when there is no audio. Also what every suite runs against. */
export class NullAudioEngine {
  constructor() {
    this.kind = 'null';
    this.muted = false;
    this.volumes = { master: AUDIO.MASTER_DEFAULT, music: AUDIO.MUSIC_DEFAULT, sfx: AUDIO.SFX_DEFAULT, ambience: AUDIO.AMBIENCE_DEFAULT };
    /** Every cue requested, so a test can assert on what the game tried to play. */
    this.played = [];
    this.beds = [];
    this.music = null;
    this.stats = { cues: 0, stolen: 0, refused: 0, notes: 0 };
  }

  get available() { return false; }
  get voices() { return 0; }
  get unlocked() { return false; }

  unlock() { return false; }
  suspend() { return false; }
  resume() { return false; }

  setMuted(muted) { this.muted = muted === true; return true; }

  setVolume(bus, value) {
    if (!(bus in this.volumes)) return false;
    this.volumes[bus] = clamp01(Number(value) || 0);
    return true;
  }

  play(cueId, opts = {}) {
    this.stats.cues++;
    this.played.push({ cueId, gain: opts.gain ?? 1, pan: opts.pan ?? 0, rate: opts.rate ?? 1 });
    if (this.played.length > 512) this.played.splice(0, this.played.length - 512);
    return true;
  }

  setBeds(regionId, weather = null) { this.beds = [{ regionId, weather }]; return true; }
  setMusic(state) { this.music = state ?? null; return true; }
  update() { return 0; }
  describe() {
    return {
      kind: 'null', available: false, muted: this.muted, voices: 0,
      volumes: { ...this.volumes }, stats: { ...this.stats },
      beds: this.beds.length, music: this.music ? { ...this.music } : null,
    };
  }
  dispose() { return true; }
}

/**
 * Build an engine for the environment it is running in.
 *
 * @param {object} [opts]
 * @param {Function} [opts.contextFactory] returns an AudioContext-shaped object.
 *   Injected by tests; in a browser it defaults to constructing a real one.
 */
export function createAudioEngine(opts = {}) {
  const factory = opts.contextFactory
    ?? (typeof AudioContext !== 'undefined' ? () => new AudioContext()
      : (typeof webkitAudioContext !== 'undefined' ? () => new webkitAudioContext() : null));
  if (!factory) return new NullAudioEngine();
  return new AudioEngine({ ...opts, contextFactory: factory });
}

export class AudioEngine {
  constructor({ contextFactory, rng = Math.random, volumes = {} } = {}) {
    this.kind = 'webaudio';
    this._factory = contextFactory;
    this._rng = rng;
    this.ctx = null;
    this.muted = false;
    this.volumes = {
      master: AUDIO.MASTER_DEFAULT,
      music: AUDIO.MUSIC_DEFAULT,
      sfx: AUDIO.SFX_DEFAULT,
      ambience: AUDIO.AMBIENCE_DEFAULT,
      ...volumes,
    };

    this._nodes = null;
    this._voices = [];
    /**
     * The last few cues that were actually allocated a voice.
     *
     * Kept by the real engine as well as the null one, and for the same reason: a
     * question about what the game just tried to play should be answerable from the
     * engine rather than only from a test double. It is also what makes the audio
     * system assertable - a suite can check that a crouched step used the soft recipe
     * at the gain the hearing model would have used, without anyone listening.
     */
    this.played = [];
    this._noiseCache = new Map();
    this._beds = new Map();       // kind -> { source, gain, target }
    this._bedTargets = new Map(); // kind -> gain, for crossfading
    this._drone = null;
    this._music = null;
    this._queue = [];
    this._cycleStart = null;
    this._phraseIndex = 0;
    this._lastT = null;
    this._bedRequest = null;

    this.stats = { cues: 0, stolen: 0, refused: 0, notes: 0, unlocks: 0 };
  }

  get available() { return this.ctx !== null; }
  get unlocked() { return this.ctx !== null; }
  get voices() { return this._voices.length; }

  /* ------------------------------------------------------------------ graph */

  /**
   * Create the context and the mix graph. Called from a user gesture.
   * @returns {boolean} whether audio is now live
   */
  unlock() {
    if (this.ctx) {
      this.stats.unlocks++;
      if (this.ctx.state === 'suspended') this.ctx.resume?.();
      return true;
    }
    let ctx;
    try { ctx = this._factory(); } catch { return false; }
    if (!ctx || typeof ctx.createGain !== 'function') return false;
    this.ctx = ctx;
    this.stats.unlocks++;

    // Resume immediately, not lazily. A context constructed inside a gesture handler
    // still starts suspended in every current browser, and one that is never resumed
    // is silent without being an error: no throw, no rejected promise, no sound. This
    // is the single line whose absence would ship a game with an audio system that
    // passes every test and is heard by nobody.
    try { ctx.resume?.(); } catch { /* a refused resume is survivable; a throw is not */ }

    const master = ctx.createGain();
    master.gain.value = this.muted ? 0 : this.volumes.master;
    master.connect(ctx.destination);

    const buses = {};
    for (const name of ['music', 'sfx', 'ambience']) {
      const g = ctx.createGain();
      g.gain.value = this.volumes[name];
      g.connect(master);
      buses[name] = g;
    }
    this._nodes = { master, buses };

    // Muting ramps rather than snapping: a hard cut on a loud transient is itself a
    // click, louder than the sound it was asked to stop.
    // Anything the director asked for before the gesture is honoured now, so a game
    // that sets its beds during loading does not start in silence.
    if (this._music?.playing) this._startDrone();
    if (this._bedRequest) this.setBeds(this._bedRequest.regionId, this._bedRequest.weather);
    this._lastT = null;
    return true;
  }

  suspend() {
    if (!this.ctx) return false;
    this.ctx.suspend?.();
    return true;
  }

  resume() {
    if (!this.ctx) return false;
    this.ctx.resume?.();
    return true;
  }

  setMuted(muted) {
    this.muted = muted === true;
    if (!this._nodes) return true;
    this._ramp(this._nodes.master.gain, this.muted ? 0 : this.volumes.master, AUDIO.MUTE_FADE_S);
    return true;
  }

  setVolume(bus, value) {
    const v = clamp01(Number(value) || 0);
    if (bus === 'master') {
      this.volumes.master = v;
      if (this._nodes && !this.muted) this._ramp(this._nodes.master.gain, v, AUDIO.MUTE_FADE_S);
      return true;
    }
    if (!(bus in this.volumes)) return false;
    this.volumes[bus] = v;
    if (this._nodes?.buses[bus]) this._ramp(this._nodes.buses[bus].gain, v, AUDIO.MUTE_FADE_S);
    return true;
  }

  _ramp(param, value, seconds) {
    if (!param) return;
    const now = this.ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(value, now + Math.max(0.005, seconds));
  }

  /* --------------------------------------------------------------- voices */

  /**
   * Play a cue from the catalogue.
   *
   * @param {string} cueId
   * @param {object} [opts] {gain, pan, rate}
   * @returns {boolean} whether a voice was allocated
   */
  play(cueId, opts = {}) {
    this.stats.cues++;
    const cue = CUES[cueId];
    if (!cue) { this.stats.refused++; return false; }
    if (!this.ctx) { this.stats.refused++; return false; }

    const gain = clamp01((opts.gain ?? 1) * (cue.params.gain ?? 1));
    if (gain < AUDIO.MIN_AUDIBLE_GAIN) { this.stats.refused++; return false; }

    const bus = this._nodes.buses[cue.bus] ?? this._nodes.buses.sfx;
    const now = this.ctx.currentTime;
    const out = this._makeVoiceChain(bus, gain, opts.pan ?? 0);

    if (!this._allocate(out.gain, now)) return false;
    this._record(cueId, gain, opts.pan ?? 0, opts.rate ?? 1);
    this._buildVoice(cue.voice, cue.params, out.input, now, opts.rate ?? 1);
    return true;
  }

  _record(cueId, gain, pan, rate) {
    this.played.push({ cueId, gain, pan, rate });
    if (this.played.length > AUDIO.PLAY_LOG) this.played.splice(0, this.played.length - AUDIO.PLAY_LOG);
  }

  /** A gain node plus an optional stereo position, wired into a mix bus. */
  _makeVoiceChain(bus, gain, pan) {
    const g = this.ctx.createGain();
    g.gain.value = gain;
    if (pan && typeof this.ctx.createStereoPanner === 'function') {
      const p = this.ctx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      g.connect(p);
      p.connect(bus);
    } else {
      g.connect(bus);
    }
    return { gain: g, input: g };
  }

  /**
   * Enforce the voice budget, stealing the quietest voice when it is exceeded.
   *
   * A combat frame can legitimately ask for a hit, a block, a shout and three
   * footsteps. Refusing the request would drop whichever sound happened to come
   * last, which is usually the one the player is listening for; stealing the
   * quietest is inaudible by construction.
   */
  _allocate(gainNode, now) {
    this._pruneVoices(now);
    if (this._voices.length < AUDIO.MAX_VOICES) {
      this._voices.push({ gain: gainNode, endAt: now + 4, level: gainNode.gain.value });
      return true;
    }
    if (!AUDIO.VOICE_STEAL_QUIETEST) { this.stats.refused++; return false; }
    let quietest = 0;
    for (let i = 1; i < this._voices.length; i++) {
      if (this._voices[i].level < this._voices[quietest].level) quietest = i;
    }
    if (this._voices[quietest].level >= gainNode.gain.value) {
      // The new voice is the quietest thing playing, so it is the one that goes.
      this.stats.refused++;
      return false;
    }
    this._stopVoice(this._voices[quietest]);
    this._voices.splice(quietest, 1);
    this.stats.stolen++;
    this._voices.push({ gain: gainNode, endAt: now + 4, level: gainNode.gain.value });
    return true;
  }

  _pruneVoices(now) {
    for (let i = this._voices.length - 1; i >= 0; i--) {
      if (this._voices[i].endAt <= now) this._voices.splice(i, 1);
    }
  }

  _stopVoice(voice) {
    // Disconnecting rather than ramping: the voice is being stolen because something
    // louder needs the headroom, and a fade-out would spend the budget it was
    // stolen to free.
    try { voice.gain.disconnect(); } catch { /* already gone */ }
  }

  /**
   * Track a started source so the budget knows when its voice frees up.
   *
   * Takes the maximum end time, not the latest one. A stinger is a pluck and a thump
   * on one gain node; letting the thump's shorter tail overwrite the pluck's longer
   * one would free the slot while the string was still ringing, and the next sound
   * would be layered onto a voice that had not finished.
   */
  _register(source, gainNode, endAt) {
    for (const v of this._voices) {
      if (v.gain === gainNode) {
        v.endAt = Math.max(v.endAt, endAt);
        v.source = source;
        return;
      }
    }
  }

  /* ----------------------------------------------------------- synthesis */

  _buildVoice(voice, params, out, when, rate = 1) {
    switch (voice) {
      case 'footfall': return this._footfall(params, out, when, rate);
      case 'thud': return this._thud(params, out, when, rate);
      case 'whoosh': return this._whoosh(params, out, when, rate);
      case 'noiseSweep': return this._noiseSweep(params, out, when, rate);
      case 'metal': return this._metal(params, out, when, rate);
      case 'bell': return this._bell(params, out, when, rate);
      case 'bellPair': return this._bellPair(params, out, when, rate);
      case 'chord': return this._chord(params, out, when, rate);
      case 'pluck': return this._pluckVoice(params, out, when, rate);
      case 'click': return this._click(params, out, when, rate);
      case 'breath': return this._breath(params, out, when, rate);
      case 'stinger': return this._stinger(params, out, when, rate);
      case 'swell': return this._swell(params, out, when, rate);
      default: return this._thud({ ...params, pitch: params.pitch ?? 120, decay: 0.2 }, out, when, rate);
    }
  }

  /**
   * A noise buffer, generated once and cached.
   *
   * Pink noise for air and water, because white noise at the same level hisses; the
   * 1/f shaping is three one-pole filters, which is what makes wind sound like wind
   * rather than like a detuned television.
   */
  _noiseBuffer(seconds, color = 'white') {
    const key = `${seconds.toFixed(2)}:${color}`;
    if (this._noiseCache.has(key)) return this._noiseCache.get(key);
    const sr = this.ctx.sampleRate || 44100;
    const len = Math.max(1, Math.floor(sr * seconds));
    const buf = this.ctx.createBuffer(1, len, sr);
    const data = buf.getChannelData(0);
    let b0 = 0; let b1 = 0; let b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = this._rng() * 2 - 1;
      if (color === 'pink') {
        b0 = 0.99765 * b0 + w * 0.0990460;
        b1 = 0.96300 * b1 + w * 0.2965164;
        b2 = 0.57000 * b2 + w * 1.0526913;
        data[i] = (b0 + b1 + b2 + w * 0.1848) * 0.22;
      } else {
        data[i] = w;
      }
    }
    this._noiseCache.set(key, buf);
    return buf;
  }

  /** A footfall: a short filtered noise burst with a body thump under it. */
  _footfall(params, out, when, rate) {
    const dur = 0.11;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer(dur * 2, 'white');
    src.playbackRate.value = clamp(rate, 0.5, 2);
    const band = this.ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 320 * (params.grain ?? 0.6);
    band.Q.value = 0.9;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, when);
    env.gain.exponentialRampToValueAtTime(1, when + 0.006);
    env.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    src.connect(band); band.connect(env); env.connect(out);
    src.start(when); src.stop(when + dur * 2);

    // The body of the step, so a footfall is not only grit.
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(120 * (params.body ?? 0.7), when);
    osc.frequency.exponentialRampToValueAtTime(58, when + 0.09);
    const oenv = this.ctx.createGain();
    oenv.gain.setValueAtTime(0.0001, when);
    oenv.gain.exponentialRampToValueAtTime(0.5 * (params.body ?? 0.7), when + 0.005);
    oenv.gain.exponentialRampToValueAtTime(0.0001, when + 0.1);
    osc.connect(oenv); oenv.connect(out);
    osc.start(when); osc.stop(when + 0.12);
    this._register(src, out, when + dur * 2);
  }

  /** An impact: a pitched sine dropping fast, which is what a body or a blow does. */
  _thud(params, out, when, rate) {
    const decay = params.decay ?? 0.2;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime((params.pitch ?? 90) * rate, when);
    osc.frequency.exponentialRampToValueAtTime(Math.max(24, (params.pitch ?? 90) * 0.42), when + decay);
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, when);
    env.gain.exponentialRampToValueAtTime(1, when + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, when + decay);
    osc.connect(env); env.connect(out);
    osc.start(when); osc.stop(when + decay + 0.02);

    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer(decay, 'white');
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 900;
    const nenv = this.ctx.createGain();
    nenv.gain.setValueAtTime(0.4, when);
    nenv.gain.exponentialRampToValueAtTime(0.0001, when + decay * 0.6);
    src.connect(lp); lp.connect(nenv); nenv.connect(out);
    src.start(when); src.stop(when + decay);
    this._register(osc, out, when + decay + 0.02);
  }

  /** Air moving: a bandpassed noise burst that swells and dies. */
  _whoosh(params, out, when, rate) {
    const dur = (params.dur ?? 0.2) / clamp(rate, 0.5, 2);
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer(Math.max(0.2, dur * 2), 'pink');
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime((params.band ?? 1200) * 0.5, when);
    bp.frequency.linearRampToValueAtTime(params.band ?? 1200, when + dur * 0.5);
    bp.frequency.linearRampToValueAtTime((params.band ?? 1200) * 0.4, when + dur);
    bp.Q.value = 1.4;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, when);
    env.gain.linearRampToValueAtTime(1, when + dur * 0.35);
    env.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    src.connect(bp); bp.connect(env); env.connect(out);
    src.start(when); src.stop(when + dur + 0.05);
    this._register(src, out, when + dur + 0.05);
  }

  /** A filtered noise sweep, used for jumps, dodges and takedowns. */
  _noiseSweep(params, out, when, rate) {
    const dur = (params.dur ?? 0.2) / clamp(rate, 0.5, 2);
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer(Math.max(0.25, dur * 2), 'pink');
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 2.2;
    bp.frequency.setValueAtTime(params.from ?? 800, when);
    bp.frequency.exponentialRampToValueAtTime(Math.max(60, params.to ?? 300), when + dur);
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, when);
    env.gain.exponentialRampToValueAtTime(1, when + dur * 0.2);
    env.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    src.connect(bp); bp.connect(env); env.connect(out);
    src.start(when); src.stop(when + dur + 0.05);
    this._register(src, out, when + dur + 0.05);
  }

  /**
   * Struck metal: inharmonic partials.
   *
   * A blade on a blade is not a harmonic series, and tuning the partials to integer
   * ratios is what makes a synthesized clang sound like a bell in a church. These
   * ratios are the ones a struck bar produces.
   */
  _metal(params, out, when, rate) {
    const decay = params.decay ?? 0.3;
    const base = (params.pitch ?? 500) * rate;
    const ratios = [1, 2.76, 5.4, 8.93, 13.3];
    const n = Math.min(params.partials ?? 3, ratios.length);
    for (let i = 0; i < n; i++) {
      const osc = this.ctx.createOscillator();
      osc.type = i === 0 ? 'triangle' : 'sine';
      osc.frequency.value = base * ratios[i];
      const env = this.ctx.createGain();
      const peak = 1 / (1 + i * 1.7);
      env.gain.setValueAtTime(0.0001, when);
      env.gain.exponentialRampToValueAtTime(peak, when + 0.002);
      env.gain.exponentialRampToValueAtTime(0.0001, when + decay / (1 + i * 0.6));
      osc.connect(env); env.connect(out);
      osc.start(when); osc.stop(when + decay + 0.05);
      if (i === 0) this._register(osc, out, when + decay + 0.05);
    }
  }

  /** A struck bell: the clue-found sound, so it must read as discovery, not alarm. */
  _bell(params, out, when, rate) {
    const decay = params.decay ?? 1.6;
    const base = (params.pitch ?? 784) * rate;
    for (const [ratio, level] of [[1, 1], [2.0, 0.42], [2.99, 0.24], [4.2, 0.12]]) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = base * ratio;
      const env = this.ctx.createGain();
      env.gain.setValueAtTime(0.0001, when);
      env.gain.exponentialRampToValueAtTime(level, when + 0.006);
      env.gain.exponentialRampToValueAtTime(0.0001, when + decay / (1 + ratio * 0.25));
      osc.connect(env); env.connect(out);
      osc.start(when); osc.stop(when + decay + 0.1);
      if (ratio === 1) this._register(osc, out, when + decay + 0.1);
    }
  }

  /** Two bells a fifth apart: evidence linking, which is a relationship, not a find. */
  _bellPair(params, out, when, rate) {
    this._bell({ ...params, decay: params.decay ?? 2 }, out, when, rate);
    const second = this.ctx.createGain();
    second.gain.value = 0.7;
    second.connect(out);
    this._bell({ ...params, pitch: (params.pitch ?? 784) * (params.ratio ?? 1.5), decay: (params.decay ?? 2) * 0.8 }, second, when + 0.09, rate);
  }

  /** A chord built from the current mode's degrees, so it is always in tune with the score. */
  _chord(params, out, when, rate) {
    const maqam = this._music?.maqam ?? null;
    const decay = params.decay ?? 2.4;
    const root = maqam ? maqam.rootHz : 146.83;
    for (const deg of params.degrees ?? [0]) {
      // One octave above the drone: a resolution chord at the drone's register would
      // sit inside it and read as the drone getting louder rather than as an arrival.
      const freq = maqam ? degreeFrequency(maqam, deg, MELODY_OCTAVE) : root * Math.pow(2, deg / 12);
      this._pluck(freq / clamp(rate, 0.5, 2), decay * 0.7, 1 / (params.degrees?.length ?? 1), out, when);
    }
  }

  /** A stinger: one loud plucked note from the mode, for a change in danger. */
  _stinger(params, out, when, rate) {
    const maqam = this._music?.maqam ?? null;
    // Two octaves up: a stinger announces a change in danger and has to cut through
    // the drone and whatever the player is already hearing.
    const freq = maqam ? degreeFrequency(maqam, params.degree ?? 4, STINGER_OCTAVE) : 293.66;
    this._pluck(freq / clamp(rate, 0.5, 2), params.decay ?? 1.2, 1, out, when);
    this._thud({ pitch: freq / 4, decay: 0.3 }, out, when, 1);
  }

  /** A swell for a cutscene: a filtered noise riser with the drone under it. */
  _swell(params, out, when, rate) {
    const dur = (params.dur ?? 2) / clamp(rate, 0.5, 2);
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer(Math.max(1, dur), 'pink');
    src.loop = true;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(params.inverted ? 2400 : 220, when);
    lp.frequency.linearRampToValueAtTime(params.inverted ? 220 : 2400, when + dur);
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(params.inverted ? 0.8 : 0.0001, when);
    env.gain.linearRampToValueAtTime(params.inverted ? 0.0001 : 0.8, when + dur);
    src.connect(lp); lp.connect(env); env.connect(out);
    src.start(when); src.stop(when + dur + 0.1);
    this._register(src, out, when + dur + 0.1);
  }

  /**
   * A struck string, by Karplus-Strong.
   *
   * A noise burst into a delay line of exactly one period, fed back through a
   * lowpass, decays into a pitched pluck with the right inharmonic grit. This is
   * what makes a lyre sound like a lyre: an oscillator with an envelope sounds like
   * an organ, and there were no organs in Babylon.
   */
  _pluck(freq, dur, level, out, when) {
    const f = clamp(freq, 40, 6000);
    const period = 1 / f;
    const burst = this.ctx.createBufferSource();
    burst.buffer = this._noiseBuffer(Math.min(0.02, period * 2), 'white');
    const delay = this.ctx.createDelay(Math.max(0.02, period * 2));
    delay.delayTime.value = period;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = clamp(f * 6, 400, 9000);
    const fb = this.ctx.createGain();
    // The feedback coefficient is the decay time. 0.996 at 220 Hz gives roughly the
    // two and a half seconds a struck gut string takes to die.
    fb.gain.value = clamp(0.996 - (f / 6000) * 0.02, 0.9, 0.999);
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(level, when);
    env.gain.setValueAtTime(level, when + dur * 0.6);
    env.gain.exponentialRampToValueAtTime(0.0001, when + dur);

    burst.connect(delay);
    delay.connect(lp); lp.connect(fb); fb.connect(delay);
    delay.connect(env); env.connect(out);
    burst.start(when); burst.stop(when + 0.03);
    this._register(burst, out, when + dur + 0.05);
    this.stats.notes++;
  }

  _pluckVoice(params, out, when, rate) {
    const maqam = this._music?.maqam ?? null;
    const freq = maqam ? degreeFrequency(maqam, params.degree ?? 0, STINGER_OCTAVE) : 220;
    this._pluck(freq / clamp(rate, 0.5, 2), params.decay ?? AUDIO.PLUCK_DECAY_S, 1, out, when);
  }

  /** A UI tick: short enough to be felt and too quiet to be listened to. */
  _click(params, out, when, rate) {
    const osc = this.ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = (params.pitch ?? 1800) * rate;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 4200;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, when);
    env.gain.exponentialRampToValueAtTime(1, when + 0.001);
    env.gain.exponentialRampToValueAtTime(0.0001, when + 0.035);
    osc.connect(lp); lp.connect(env); env.connect(out);
    osc.start(when); osc.stop(when + 0.05);
    this._register(osc, out, when + 0.05);
  }

  /** A voice-shaped sound without words: a breath, a grunt, a shout. */
  _breath(params, out, when, rate) {
    const dur = params.dur ?? 0.3;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer(Math.max(0.4, dur * 2), 'pink');
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    const base = (params.pitch ?? 200) * rate;
    bp.frequency.setValueAtTime(base * 0.8, when);
    bp.frequency.linearRampToValueAtTime(base * 1.25, when + dur * 0.4);
    bp.frequency.linearRampToValueAtTime(base * 0.7, when + dur);
    bp.Q.value = 3.2;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, when);
    env.gain.linearRampToValueAtTime(1, when + dur * 0.18);
    env.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    src.connect(bp); bp.connect(env); env.connect(out);
    src.start(when); src.stop(when + dur + 0.05);
    this._register(src, out, when + dur + 0.05);
  }

  /* -------------------------------------------------------------- beds */

  /**
   * Set the ambience for a place, crossfading from whatever was playing.
   *
   * Beds are started once and faded, never restarted: a hard swap on a doorway is
   * audible as a click and reads as a bug rather than as a change of room.
   */
  setBeds(regionId, weather = null) {
    if (!this.ctx) { this._bedRequest = { regionId, weather }; return false; }
    const wanted = new Map();
    for (const bed of this._requestedBeds(regionId, weather)) wanted.set(bed.kind, bed.gain);
    for (const [kind] of this._beds) if (!wanted.has(kind)) wanted.set(kind, 0);
    for (const [kind, gain] of wanted) this._bedTarget(kind, gain);
    this._bedRequest = { regionId, weather };
    return true;
  }

  _requestedBeds(regionId, weather) {
    // Imported lazily so the ambience map stays the single source.
    const beds = ambienceFor(regionId);
    const out = beds.map((b) => ({ ...b }));
    const w = weatherBed(weather);
    if (w) {
      out.push({ kind: w.kind, gain: w.gain });
      // Rain covers the room, so the rest of the bed ducks rather than competing.
      for (const b of out) if (b.kind !== w.kind) b.gain *= w.mask;
    }
    return out;
  }

  _bedTarget(kind, gain) {
    const target = clamp01(gain);
    const current = this._bedTargets.get(kind) ?? 0;
    if (Math.abs(target - current) < 1e-6) return;
    this._bedTargets.set(kind, target);
    const entry = this._beds.get(kind);
    if (entry) {
      // Restart the fade from wherever it actually is, so a second region change
      // mid-crossfade retargets instead of jumping.
      entry.fade = { from: entry.gain.gain.value, to: target, t: 0 };
    } else if (target > 0.001) {
      this._startBed(kind, target);
    }
  }

  _startBed(kind, target) {
    const bus = this._nodes.buses.ambience;
    const g = this.ctx.createGain();
    g.gain.value = 0.0001;
    g.connect(bus);
    const src = this._bedSource(kind, g);
    if (!src) { g.disconnect(); return; }
    this._beds.set(kind, { source: src, gain: g, fade: { from: 0, to: clamp01(target), t: 0 } });
  }

  /** Each bed is a looping noise or oscillator stack shaped by a slow filter. */
  _bedSource(kind, out) {
    const when = this.ctx.currentTime;
    if (kind === 'wind' || kind === 'storm' || kind === 'rain') {
      const src = this.ctx.createBufferSource();
      src.buffer = this._noiseBuffer(4, 'pink');
      src.loop = true;
      const lp = this.ctx.createBiquadFilter();
      lp.type = kind === 'rain' ? 'highpass' : 'lowpass';
      lp.frequency.value = kind === 'rain' ? 700 : kind === 'storm' ? 900 : 420;
      // A slow LFO on the cutoff, because steady wind is a hiss and real wind gusts.
      const lfo = this.ctx.createOscillator();
      lfo.frequency.value = kind === 'storm' ? 0.22 : 0.07;
      const lfoGain = this.ctx.createGain();
      lfoGain.gain.value = kind === 'rain' ? 260 : 180;
      lfo.connect(lfoGain); lfoGain.connect(lp.frequency);
      src.connect(lp); lp.connect(out);
      src.start(when); lfo.start(when);
      return { src, lfo };
    }
    if (kind === 'water') {
      const src = this.ctx.createBufferSource();
      src.buffer = this._noiseBuffer(3, 'pink');
      src.loop = true;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 1100; bp.Q.value = 0.7;
      const lfo = this.ctx.createOscillator();
      lfo.frequency.value = 0.31;
      const lg = this.ctx.createGain(); lg.gain.value = 420;
      lfo.connect(lg); lg.connect(bp.frequency);
      src.connect(bp); bp.connect(out);
      src.start(when); lfo.start(when);
      return { src, lfo };
    }
    if (kind === 'crowd' || kind === 'chant') {
      // A crowd is many detuned voices; a chant is a few. Same instrument, different
      // count and spread, which is the difference between a market and a temple.
      const count = kind === 'crowd' ? 7 : 3;
      const oscs = [];
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = kind === 'crowd' ? 1400 : 700;
      lp.connect(out);
      for (let i = 0; i < count; i++) {
        const osc = this.ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = (kind === 'crowd' ? 130 : 110) * (1 + i * 0.09);
        osc.detune.value = (this._rng() * 2 - 1) * 40;
        const g = this.ctx.createGain();
        g.gain.value = 1 / count;
        // Each voice drifts in level independently, which is what stops it sounding
        // like one synthesizer held on a chord.
        const lfo = this.ctx.createOscillator();
        lfo.frequency.value = 0.05 + this._rng() * 0.18;
        const lg = this.ctx.createGain(); lg.gain.value = 0.5 / count;
        lfo.connect(lg); lg.connect(g.gain);
        osc.connect(g); g.connect(lp);
        osc.start(when); lfo.start(when);
        oscs.push({ osc, lfo });
      }
      return { src: null, oscs };
    }
    if (kind === 'fire') {
      const src = this.ctx.createBufferSource();
      src.buffer = this._noiseBuffer(2, 'white');
      src.loop = true;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 2600; bp.Q.value = 1.6;
      const g = this.ctx.createGain(); g.gain.value = 0.5;
      // Random-ish crackle from a fast LFO on the level.
      const lfo = this.ctx.createOscillator();
      lfo.type = 'square'; lfo.frequency.value = 7.3;
      const lg = this.ctx.createGain(); lg.gain.value = 0.4;
      lfo.connect(lg); lg.connect(g.gain);
      src.connect(bp); bp.connect(g); g.connect(out);
      src.start(when); lfo.start(when);
      return { src, lfo };
    }
    if (kind === 'drip') {
      const src = this.ctx.createBufferSource();
      src.buffer = this._noiseBuffer(3, 'pink');
      src.loop = true;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 1900; bp.Q.value = 6;
      const g = this.ctx.createGain(); g.gain.value = 0.25;
      const lfo = this.ctx.createOscillator();
      lfo.type = 'sine'; lfo.frequency.value = 0.42;
      const lg = this.ctx.createGain(); lg.gain.value = 0.24;
      lfo.connect(lg); lg.connect(g.gain);
      src.connect(bp); bp.connect(g); g.connect(out);
      src.start(when); lfo.start(when);
      return { src, lfo };
    }
    if (kind === 'insects') {
      const osc = this.ctx.createOscillator();
      osc.type = 'sawtooth'; osc.frequency.value = 4200;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 4200; bp.Q.value = 14;
      const trem = this.ctx.createOscillator(); trem.frequency.value = 18;
      const tg = this.ctx.createGain(); tg.gain.value = 0.45;
      const g = this.ctx.createGain(); g.gain.value = 0.5;
      trem.connect(tg); tg.connect(g.gain);
      osc.connect(bp); bp.connect(g); g.connect(out);
      osc.start(when); trem.start(when);
      return { src: null, oscs: [{ osc, lfo: trem }] };
    }
    // roomTone: a very low, very quiet filtered noise floor.
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer(4, 'pink');
    src.loop = true;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 240;
    src.connect(lp); lp.connect(out);
    src.start(when);
    return { src };
  }

  /* -------------------------------------------------------------- music */

  /**
   * Set the score's state. The director decides what the state should be; the engine
   * only plays it.
   *
   * A change here clears the pending notes and restarts the cycle, so a shift in
   * danger reaches the player within one lookahead rather than waiting for whatever
   * was already queued to finish. Music that lags the situation it is describing is
   * worse than no music: it tells the player the combat ended before it did.
   *
   * @param {{maqam: object|null, iqa: object|null, tempo: number, layers: number,
   *          playing: boolean, regionId?: string}} state
   */
  setMusic(state) {
    const next = state ?? null;
    const changed = this._musicChanged(next);
    this._music = next;
    if (!this.ctx) return false;

    if (!this._music?.playing) {
      this._queue = [];
      this._stopDrone();
      return false;
    }
    if (changed) {
      this._queue = [];
      this._cycleStart = null;
      this._phraseIndex = 0;
      this._startDrone();
    } else if (!this._drone) {
      this._startDrone();
    }
    return true;
  }

  /** Whether a new music state is musically different from the current one. */
  _musicChanged(next) {
    const cur = this._music;
    if (!cur || !next) return true;
    return cur.maqam?.id !== next.maqam?.id
      || cur.iqa?.id !== next.iqa?.id
      || Math.abs((cur.tempo ?? 0) - (next.tempo ?? 0)) > 0.01
      || (cur.layers ?? 0) !== (next.layers ?? 0)
      || (cur.regionId ?? null) !== (next.regionId ?? null)
      || cur.playing !== next.playing;
  }

  _startDrone() {
    if (!this.ctx || !this._music?.maqam) return;
    this._stopDrone();
    const bus = this._nodes.buses.music;
    const g = this.ctx.createGain();
    g.gain.value = 0.0001;
    g.connect(bus);
    const when = this.ctx.currentTime;
    // A two and a half second fade in: the drone is the one layer that never stops,
    // so its arrival has to be unfelt or every mode change is a bump.
    g.gain.linearRampToValueAtTime(AUDIO.DRONE_GAIN, when + AUDIO.DRONE_FADE_S);
    const oscs = droneFrequencies(this._music.maqam).map((f, i) => {
      const osc = this.ctx.createOscillator();
      osc.type = i === 0 ? 'sine' : 'triangle';
      osc.frequency.value = f;
      const og = this.ctx.createGain();
      og.gain.value = i === 0 ? 0.5 : 0.22;
      osc.connect(og); og.connect(g);
      osc.start(when);
      return osc;
    });
    this._drone = { gain: g, oscs };
  }

  _stopDrone() {
    if (!this._drone) return;
    const now = this.ctx.currentTime;
    try {
      this._drone.gain.gain.cancelScheduledValues(now);
      this._drone.gain.gain.setValueAtTime(this._drone.gain.gain.value, now);
      this._drone.gain.gain.linearRampToValueAtTime(0.0001, now + AUDIO.DRONE_FADE_S);
      for (const osc of this._drone.oscs) osc.stop(now + AUDIO.DRONE_FADE_S + 0.1);
    } catch { /* already stopped */ }
    this._drone = null;
  }

  /**
   * Advance the score. Called once per frame.
   *
   * Two stages: cycles whose start falls inside the lookahead are expanded into
   * individual notes on a queue, and then every queued note whose time has been
   * reached is built. Expanding a whole cycle at once rather than one note at a time
   * is what stops notes being dropped - a maqsoum cycle is nearly four seconds long,
   * far longer than the 0.35s lookahead, so a scheduler that only placed notes
   * inside the window would skip every strike after the first.
   *
   * @param {number} [now] the audio clock, injected by tests
   * @returns {number} how many notes were placed this frame
   */
  update(now = null) {
    if (!this.ctx) return 0;
    const t = Number.isFinite(now) ? now : this.ctx.currentTime;
    const dt = this._lastT === null ? 0 : clamp(t - this._lastT, 0, 0.25);
    this._lastT = t;

    this._updateBeds(dt);
    this._pruneVoices(t);

    const music = this._music;
    if (!music?.playing || !music.iqa || !(music.tempo > 0) || !music.maqam) return 0;

    const beat = 60 / music.tempo;
    const cycle = music.iqa.beats * beat;
    if (!(cycle > AUDIO.MUSIC_QUANTUM_S)) return 0;   // a degenerate tempo must not spin
    const until = t + AUDIO.MUSIC_LOOKAHEAD_S;

    if (this._cycleStart === null || this._cycleStart < t) this._cycleStart = t;
    while (this._cycleStart < until) {
      this._expandCycle(this._cycleStart, beat, music);
      this._cycleStart += cycle;
    }

    // Drop anything already past, which happens when the tab was hidden and the audio
    // clock ran on without us. Playing it late is worse than not playing it.
    this._queue = this._queue.filter((e) => e.at >= t);
    this._queue.sort((a, b) => a.at - b.at);

    let placed = 0;
    while (this._queue.length && this._queue[0].at < until) {
      const event = this._queue.shift();
      this._playEvent(event, music, beat);
      placed++;
    }
    return placed;
  }

  /** Turn one rhythm cycle into concrete drum strikes and melody notes. */
  _expandCycle(start, beat, music) {
    if (music.layers >= 1) {
      for (const strike of music.iqa.strikes) {
        this._queue.push({ at: start + strike.t * beat, kind: 'drum', strike });
      }
    }
    if (music.layers >= 2) {
      // One phrase per cycle, fitting exactly inside it. A phrase that ran across the
      // bar line could not change when the metre changed, and the metre is the thing
      // that changes under danger. Short cycles get a finer grid instead of fewer
      // notes: ayyub is two beats, and two notes in two beats at 130bpm is a melody
      // with holes in it, where four eighth-notes is the drive the mode is for.
      const beatsPerNote = music.iqa.beats >= AUDIO.MELODY_MIN_CYCLE_BEATS ? 1 : 0.5;
      const length = Math.max(2, Math.round(music.iqa.beats / beatsPerNote));
      const seed = `${music.regionId ?? 'score'}#${music.maqam.id}#${this._phraseIndex}`;
      this._phraseIndex++;
      for (const note of phrase(music.maqam, seed, length, beatsPerNote)) {
        if (note.dur > 0) this._queue.push({ at: start + note.t * beat, kind: 'melody', note });
      }
    }
    this._queueLengthGuard();
  }

  /** Bound the queue, so a paused clock cannot grow it without limit. */
  _queueLengthGuard() {
    if (this._queue.length > AUDIO.MUSIC_MAX_QUEUE) {
      this._queue.sort((a, b) => a.at - b.at);
      this._queue.length = AUDIO.MUSIC_MAX_QUEUE;
    }
  }

  _playEvent(event, music, beat) {
    const bus = this._nodes.buses.music;
    const g = this.ctx.createGain();
    g.connect(bus);
    if (event.kind === 'drum') {
      const { strike } = event;
      g.gain.value = strike.vel * AUDIO.DRUM_GAIN * (strike.kind === 'dum' ? 1 : 0.55);
      // dum is the low centre strike on the frame drum, tak the high rim. Same
      // synthesizer, different pitch and tail, which is the whole difference between
      // them acoustically.
      this._thud(strike.kind === 'dum' ? { pitch: 96, decay: 0.18 } : { pitch: 320, decay: 0.06 },
        g, event.at, 1);
    } else {
      const { note } = event;
      g.gain.value = note.vel * AUDIO.MELODY_GAIN;
      const freq = degreeFrequency(music.maqam, note.degree, MELODY_OCTAVE);
      this._pluck(freq, Math.max(0.15, note.dur * beat * 1.6), 1, g, event.at);
      // The top layer adds the octave, so the score thickens under danger rather than
      // only getting faster.
      if (music.layers >= 3) this._pluck(freq * 2, Math.max(0.12, note.dur * beat), 0.4, g, event.at);
    }
    this.stats.notes++;
  }

  /**
   * Advance every bed's fade.
   *
   * Time-based rather than rate-based, and that distinction is audible. A fixed rate
   * per frame takes a quiet bed to zero in a third of the time it takes a loud one, so
   * walking from the market to the cellar would cut the crowd out before the drip had
   * arrived - a gap in the middle of the crossfade, which is precisely the artefact the
   * crossfade exists to avoid. Every bed here completes in AMBIENCE_CROSSFADE_S
   * whatever level it is travelling between.
   *
   * Driven per frame rather than scheduled on the audio clock so a fade can be
   * retargeted mid-way by another region change and still land exactly on target.
   */
  _updateBeds(dt) {
    const dur = Math.max(0.05, AUDIO.AMBIENCE_CROSSFADE_S);
    for (const [kind, entry] of [...this._beds]) {
      const fade = entry.fade;
      if (!fade) continue;
      fade.t += dt;
      const k = clamp01(fade.t / dur);
      entry.gain.gain.value = clamp01(fade.from + (fade.to - fade.from) * k);
      if (k >= 1) {
        entry.gain.gain.value = clamp01(fade.to);
        if (fade.to <= 0.001) this._stopBed(kind, entry, this.ctx.currentTime);
      }
    }
  }

  _stopBed(kind, entry, t) {
    try {
      if (entry.source?.src) entry.source.src.stop(t + 0.1);
      if (entry.source?.lfo) entry.source.lfo.stop(t + 0.1);
      for (const o of entry.source?.oscs ?? []) {
        o.osc?.stop(t + 0.1);
        o.lfo?.stop(t + 0.1);
      }
      entry.gain.disconnect();
    } catch { /* already stopped */ }
    this._beds.delete(kind);
    this._bedTargets.delete(kind);
  }

  /* -------------------------------------------------------- diagnostics */

  describe() {
    return {
      kind: 'webaudio',
      available: this.available,
      state: this.ctx?.state ?? 'none',
      muted: this.muted,
      voices: this._voices.length,
      maxVoices: AUDIO.MAX_VOICES,
      beds: [...this._beds.keys()],
      bedTargets: Object.fromEntries(this._bedTargets),
      drone: this._drone !== null,
      queued: this._queue.length,
      recent: this.played.slice(-8).map((p) => p.cueId),
      music: this._music ? {
        maqam: this._music.maqam?.id ?? null,
        iqa: this._music.iqa?.id ?? null,
        tempo: this._music.tempo ?? 0,
        layers: this._music.layers ?? 0,
        playing: this._music.playing === true,
      } : null,
      volumes: { ...this.volumes },
      stats: { ...this.stats },
    };
  }

  dispose() {
    this._stopDrone();
    for (const [kind, entry] of [...this._beds]) this._stopBed(kind, entry, this.ctx?.currentTime ?? 0);
    for (const v of this._voices) this._stopVoice(v);
    this._voices = [];
    this.played = [];
    this._noiseCache.clear();
    try { this.ctx?.close?.(); } catch { /* already closed */ }
    this.ctx = null;
    this._nodes = null;
    return true;
  }
}

