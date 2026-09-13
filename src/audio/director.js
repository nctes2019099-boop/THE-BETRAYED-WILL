/**
 * THE BETRAYED WILL — audio/director.js
 *
 * Decides what should be heard, and when.
 *
 * The engine can build any sound in the catalogue; it has no idea what the game is
 * doing. The director is the only place that knows both. It subscribes to the event
 * bus, turns events into cues, and drives three things that are levels rather than
 * events - footsteps, the score, and the ambience - from the frame update.
 *
 * ── The event map is data, not a switch ─────────────────────────────────────
 * Every cue is bound to its trigger in one table at the top of this file. A test can
 * read that table and assert every cue in the catalogue is accounted for: bound to a
 * live event, bound to a public method, or explicitly marked as awaiting the system
 * that would fire it. Without the table that question can only be answered by
 * playing the game and listening, which is how a quarter of a sound design ends up
 * never being heard by anyone.
 *
 * ── Cooldowns are a floor on repetition, not a rate limit on the game ────────
 * One stuck event, or one frame in which four guards are hit at once, must not become
 * a machine gun. The cooldown comes from theory.js next to the cue it protects, so a
 * balance change to a sound and a change to how often it may fire happen in the same
 * file.
 *
 * ── Footsteps are derived, not scheduled ────────────────────────────────────
 * Cadence comes from the movement system's own speeds through one stride length, and
 * loudness comes from the same noise radius the AI's hearing model uses. A footstep
 * the player hears quieter than the guard does would be the game lying to one of
 * them, and the only way to guarantee that cannot happen is to have one number.
 */

import { AUDIO } from '../core/constants.js';
import { Events } from '../core/bus.js';
import { clamp, clamp01 } from '../core/math.js';
import { RNG } from '../core/rng.js';
import {
  CUES,
  cooldownFor,
  footstepGain,
  iqaForTension,
  maqamForTension,
  stepIsDue,
  tempoForTension,
} from './theory.js';
import { createAudioEngine } from './engine.js';

/**
 * Which event plays which cue.
 *
 * `map` turns the event payload into play options; where it is absent the cue plays
 * as authored. `pending` marks a cue whose triggering system is not built yet, so the
 * entry is a tracked gap rather than dead data that quietly never fires.
 */
export const EVENT_CUES = Object.freeze({
  [Events.PLAYER_JUMPED]: Object.freeze({ cue: 'jump' }),
  [Events.PLAYER_DODGED]: Object.freeze({ cue: 'dodge' }),
  [Events.PLAYER_LEDGE_GRAB]: Object.freeze({ cue: 'ledge' }),
  [Events.PLAYER_DAMAGED]: Object.freeze({ cue: 'hurt' }),
  [Events.PLAYER_DIED]: Object.freeze({ cue: 'death' }),
  [Events.COMBAT_ATTACK]: Object.freeze({ cue: 'attack-swing' }),
  [Events.COMBAT_HIT]: Object.freeze({ cue: 'hit-flesh' }),
  [Events.COMBAT_BLOCKED]: Object.freeze({ cue: 'hit-blocked' }),
  [Events.COMBAT_PARRIED]: Object.freeze({ cue: 'parry' }),
  [Events.COMBAT_STAGGER]: Object.freeze({ cue: 'stagger' }),
  [Events.COMBAT_KNOCKDOWN]: Object.freeze({ cue: 'body-fall' }),
  [Events.COMBAT_KILL]: Object.freeze({ cue: 'kill' }),
  // NOISE_EMITTED carries `source: 'land-heavy' | 'land-light'`, which is already the
  // cue id, and `radius`, which is the number the AI heard. Driving the landing sound
  // from this event rather than from PLAYER_LANDED means the player hears the same
  // magnitude the guard perceived, scaled by it, from one authored value.
  [Events.NOISE_EMITTED]: Object.freeze({
    cue: (p) => (CUES[p?.source] ? p.source : 'land-light'),
    map: (p) => ({ gain: clamp01((Number(p?.radius) || 0) / AUDIO.FOOTSTEP_LOUDNESS_REF) }),
  }),
  [Events.SPOTTED]: Object.freeze({ cue: 'spotted-stinger' }),
  [Events.AI_ALERTED]: Object.freeze({ cue: 'alerted-stinger' }),
  [Events.CLUE_FOUND]: Object.freeze({ cue: 'clue-found' }),
  [Events.CHAPTER_START]: Object.freeze({ cue: 'chapter-sting' }),
  [Events.MISSION_COMPLETE]: Object.freeze({ cue: 'mission-complete' }),
  [Events.MISSION_FAILED]: Object.freeze({ cue: 'mission-failed' }),
  [Events.MISSION_OBJECTIVE]: Object.freeze({ cue: 'objective-update' }),
  [Events.CUTSCENE_START]: Object.freeze({ cue: 'cinematic-in' }),
  [Events.CUTSCENE_END]: Object.freeze({ cue: 'cinematic-out' }),
  [Events.DIALOGUE_LINE]: Object.freeze({ cue: 'dialogue-blip' }),
  [Events.TOAST]: Object.freeze({ cue: 'objective-update' }),
});

/**
 * Cues that no event reaches.
 *
 * Each is playable through `director.cue()` and is listed here so the audio suite can
 * fail if a cue becomes unreachable without anyone deciding that it should be. The
 * reason is recorded because "not wired yet" and "deliberately manual" are different
 * facts and a reader cannot tell them apart from the code alone.
 */
export const MANUAL_CUES = Object.freeze({
  'ui-click': Object.freeze({ via: 'dom', reason: 'Fired from the DOM by index.html, which has no bus event.' }),
  'ui-hover': Object.freeze({ via: 'dom', reason: 'Fired from the DOM by index.html.' }),
  'ui-back': Object.freeze({ via: 'dom', reason: 'Fired from the DOM by index.html.' }),
  'step-soft': Object.freeze({ via: 'frame', reason: 'Driven per frame by the footstep loop, not by an event.' }),
  'step-hard': Object.freeze({ via: 'frame', reason: 'Driven per frame by the footstep loop, not by an event.' }),
  'bow-draw': Object.freeze({ via: 'pending', reason: 'No bow or projectile system is built yet.' }),
  'bow-release': Object.freeze({ via: 'pending', reason: 'No bow or projectile system is built yet.' }),
  'arrow-hit': Object.freeze({ via: 'pending', reason: 'No bow or projectile system is built yet.' }),
  'evidence-linked': Object.freeze({ via: 'pending', reason: 'The investigation board is not built yet.' }),
  conclusion: Object.freeze({ via: 'pending', reason: 'The investigation board is not built yet.' }),
  takedown: Object.freeze({ via: 'pending', reason: 'Stealth takedowns are authored in constants but never emitted.' }),
  shout: Object.freeze({ via: 'pending', reason: 'No AI vocalisation events are emitted yet.' }),
});

/**
 * How many music layers each tension level gets.
 *
 * AUDIO.TENSION_LAYERS counts the four states the score can be in - drone alone, then
 * drum, then melody, then the octave doubling - so the highest layer index is one less
 * than that count. Deriving it rather than writing 3 twice keeps the constant and the
 * table from disagreeing when a fifth state is added.
 */
const TOP_LAYER = AUDIO.TENSION_LAYERS - 1;
const LAYERS_BY_TENSION = Object.freeze({
  calm: 2, suspicious: 2, alerted: TOP_LAYER, combat: TOP_LAYER,
});

/** Tempo scaling while a cutscene plays: the score leads, the player does not act. */
const CINEMATIC_TEMPO_SCALE = 0.82;

export class AudioDirector {
  /**
   * @param {object} opts
   * @param {object} opts.bus       the event bus
   * @param {object} [opts.engine]  an engine; built from the environment if absent
   * @param {object} [opts.rng]     seeded RNG, so tests are reproducible
   */
  constructor({ bus = null, engine = null, rng = null, volumes = null } = {}) {
    this.bus = bus;
    this.engine = engine ?? createAudioEngine({});
    this.rng = rng ?? new RNG('audio-director');
    this.volumes = volumes ?? { ...this.engine.volumes };

    /** Seconds since attach. Monotonic and driven, so cooldowns are testable. */
    this._t = 0;
    this._cooldowns = new Map();
    this._handlers = new Map();
    this._attached = false;

    this._stepSince = Infinity;
    this._stepSide = 1;
    this._listener = null;
    this._musicState = null;
    this._musicPlaying = false;

    this._detection = 'calm';
    this._region = null;
    this._weather = null;
    this._cinematic = false;
    this._paused = false;
    this._hidden = false;

    this.stats = { events: 0, cues: 0, cooled: 0, steps: 0, musicChanges: 0, bedChanges: 0 };
  }

  get available() { return this.engine.available; }
  get muted() { return this.engine.muted; }

  /* ------------------------------------------------------------- lifecycle */

  attach() {
    if (this._attached || !this.bus) return false;
    for (const [type, binding] of Object.entries(EVENT_CUES)) {
      this._subscribe(type, (payload) => this._onEvent(type, binding, payload));
    }
    this._subscribe(Events.WEATHER_CHANGED, (p) => this.setWeather(p?.weather ?? null));
    this._subscribe(Events.PAUSE, () => this.setPaused(true));
    this._subscribe(Events.RESUME, () => this.setPaused(false));
    this._attached = true;
    return true;
  }

  /**
   * Subscribe and remember the handler.
   *
   * Multiple handlers may share one event type, so the record is a list: storing one
   * per type would silently drop the earlier subscription and leave a listener the
   * director could no longer remove, which is a leak that only shows up when the
   * director is rebuilt - exactly when a suite does it.
   */
  _subscribe(type, handler) {
    this.bus.on(type, handler);
    const list = this._handlers.get(type) ?? [];
    list.push(handler);
    this._handlers.set(type, list);
  }

  detach() {
    if (!this._attached || !this.bus) return false;
    for (const [type, handlers] of this._handlers) {
      for (const handler of handlers) this.bus.off(type, handler);
    }
    this._handlers.clear();
    this._attached = false;
    return true;
  }

  /** Create the AudioContext. Must be called from a user gesture. */
  unlock() { return this.engine.unlock(); }

  /* ---------------------------------------------------------------- mixing */

  /**
   * Mute. Ramps the master bus to zero rather than suspending the context.
   *
   * Suspending would stop the audio clock, and a stopped clock stalls the note
   * scheduler: unmuting would then release every note that had piled up at the same
   * instant. Silencing the bus leaves the clock running, so unmuting resumes exactly
   * where the score left off.
   */
  setMuted(muted) {
    this.engine.setMuted(muted);
    return this.engine.muted;
  }

  toggleMute() { return this.setMuted(!this.engine.muted); }

  setVolume(busName, value) {
    if (!this.engine.setVolume(busName, value)) return false;
    this.volumes[busName] = this.engine.volumes[busName];
    return true;
  }

  setPaused(paused) {
    this._paused = paused === true;
    if (this._paused || this._hidden) this.engine.suspend();
    else this.engine.resume();
    return this._paused;
  }

  setHidden(hidden) {
    this._hidden = hidden === true;
    if (this._paused || this._hidden) this.engine.suspend();
    else this.engine.resume();
    return this._hidden;
  }

  /* ------------------------------------------------------------------ cues */

  /**
   * Play a cue, honouring its cooldown.
   *
   * @returns {boolean} whether a voice was actually allocated
   */
  cue(cueId, opts = {}) {
    if (!CUES[cueId]) return false;
    const limit = cooldownFor(cueId);
    if (limit > 0) {
      const until = this._cooldowns.get(cueId) ?? -Infinity;
      if (this._t < until) { this.stats.cooled++; return false; }
      this._cooldowns.set(cueId, this._t + limit);
    }
    this.stats.cues++;
    return this.engine.play(cueId, opts);
  }

  _onEvent(type, binding, payload) {
    this.stats.events++;
    if (this._paused || this._hidden) return;
    const cueId = typeof binding.cue === 'function' ? binding.cue(payload) : binding.cue;
    if (!cueId) return;
    let opts = binding.map ? binding.map(payload) ?? {} : {};
    // A sound with a world position is panned; one without is centred. Panning a
    // footstep is what tells the player which side a guard is on without them looking.
    const pan = this._panFor(payload);
    if (pan !== 0) opts = { ...opts, pan };
    this.cue(cueId, opts);
  }

  /**
   * Stereo position of a world point, in [-1, 1].
   *
   * Projected onto the listener's right vector rather than taken from world x, so
   * turning the camera turns the soundstage with it. A guard who is always "left"
   * because he happens to stand at a low world x is a bug the player cannot name but
   * will notice.
   */
  _panFor(payload) {
    const pos = payload?.pos;
    const listener = this._listener;
    if (!pos || !listener?.right || !listener?.pos) return 0;
    const dx = pos.x - listener.pos.x;
    const dz = pos.z - listener.pos.z;
    const along = dx * listener.right.x + dz * listener.right.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.001) return 0;
    // Full width at one metre, narrowing with distance: something far away is far
    // away in every respect, including how precisely you can place it.
    return clamp(along / Math.max(1, dist) * clamp(2 / dist, 0.15, 1), -1, 1);
  }

  /* ------------------------------------------------------------ ambience */

  setRegion(regionId) {
    if (regionId === this._region) return false;
    this._region = regionId ?? null;
    this.stats.bedChanges++;
    return this.engine.setBeds(this._region, this._weather);
  }

  setWeather(weather) {
    if (weather === this._weather) return false;
    this._weather = weather ?? null;
    this.stats.bedChanges++;
    return this.engine.setBeds(this._region, this._weather);
  }

  /* ---------------------------------------------------------------- frame */

  /**
   * Advance the director by one frame.
   *
   * @param {number} dt seconds
   * @param {object} [ctx] {player, listener, detection, region, weather, cinematic, paused}
   * @returns {number} notes the engine placed
   */
  update(dt, ctx = {}) {
    const step = Number.isFinite(dt) ? clamp(dt, 0, 0.25) : 0;

    if (ctx.listener) this._listener = ctx.listener;
    if (ctx.region !== undefined && ctx.region !== null) this.setRegion(ctx.region);
    if (ctx.weather !== undefined) this.setWeather(ctx.weather);
    if (ctx.detection) this._detection = ctx.detection;
    if (ctx.cinematic !== undefined) this._cinematic = ctx.cinematic === true;
    if (ctx.paused !== undefined) this.setPaused(ctx.paused === true);

    if (this._paused || this._hidden) {
      // Say so once, then stop. Advancing the cooldown clock while the game is paused
      // would let a sound be ready before the player can hear it, and scheduling notes
      // into a suspended context would release them all at once on resume.
      this._updateMusic(ctx);
      return 0;
    }

    this._t += step;
    this._updateFootsteps(step, ctx);
    this._updateMusic(ctx);
    return this.engine.update();
  }

  /**
   * Footfalls for this frame.
   *
   * A level, sampled every frame, not an event: the movement system already knows how
   * fast the character is going and how loud that is, and both numbers are used here
   * without being re-derived.
   */
  _updateFootsteps(dt, ctx) {
    const p = ctx.player;
    if (!p || this._cinematic || this._paused || this._hidden) { this._stepSince = Infinity; return; }

    const speed = Number(p.speed) || 0;
    const moving = p.onGround !== false && speed > AUDIO.FOOTSTEP_MIN_SPEED;
    if (!moving) { this._stepSince = Infinity; return; }

    this._stepSince += dt;
    if (!stepIsDue(speed, this._stepSince)) return;
    this._stepSince = 0;
    this.stats.steps++;

    const gain = footstepGain(Number(p.noiseRadius) || 0);
    if (gain <= 0) return;

    // Crouching is quieter in timbre as well as in level: a soft step is a lighter
    // body on the same foot, so the grain is reduced, not just the volume.
    const cueId = p.stance === 'crouch' ? 'step-soft' : 'step-hard';
    const rate = 1 + this.rng.range(-AUDIO.FOOTSTEP_PITCH_SPREAD, AUDIO.FOOTSTEP_PITCH_SPREAD);
    // Alternating feet. Without it every footfall arrives from dead centre and the
    // walk sounds like one leg hopping.
    this._stepSide = -this._stepSide;
    this.cue(cueId, { gain, rate, pan: this._stepSide * AUDIO.FOOTSTEP_PAN });
  }

  /**
   * The score for this frame.
   *
   * Recomputed every frame but only handed to the engine when it differs, because
   * `setMusic` restarts the cycle: doing that sixty times a second would produce a
   * drum that never gets past its first beat.
   */
  _updateMusic(ctx) {
    if (this._paused || this._hidden) {
      if (this._musicPlaying !== false) {
        this._musicPlaying = false;
        // Recorded in _musicState as well as handed to the engine. Without that, the
        // comparison on resume sees an unchanged state and never tells the engine to
        // start again - the pause works, and the score never comes back.
        this._musicState = { ...(this._musicState ?? {}), playing: false };
        this.engine.setMusic(this._musicState);
        this.stats.musicChanges++;
      }
      return;
    }

    const tension = ctx.detection ?? this._detection ?? 'calm';
    const cinematic = this._cinematic === true;
    const maqam = maqamForTension(tension, cinematic ? AUDIO.CINEMATIC_MAQAM : null);
    const iqa = cinematic ? iqaForTension('calm') : iqaForTension(tension);
    let tempo = tempoForTension(tension);
    if (cinematic) tempo *= CINEMATIC_TEMPO_SCALE;

    const layers = cinematic ? TOP_LAYER : (LAYERS_BY_TENSION[tension] ?? 2);
    const state = {
      maqam, iqa, tempo, layers, playing: true,
      regionId: this._region ?? 'score',
    };

    if (this._sameMusic(state)) { this._musicPlaying = true; return; }
    this._musicState = state;
    this._musicPlaying = true;
    this.stats.musicChanges++;
    this.engine.setMusic(state);
  }

  _sameMusic(next) {
    const cur = this._musicState;
    if (!cur) return false;
    return cur.maqam?.id === next.maqam?.id
      && cur.iqa?.id === next.iqa?.id
      && Math.abs((cur.tempo ?? 0) - next.tempo) < 0.01
      && (cur.layers ?? 0) === next.layers
      && (cur.regionId ?? null) === next.regionId
      && cur.playing === next.playing;
  }

  /* ---------------------------------------------------------- diagnostics */

  describe() {
    return {
      attached: this._attached,
      clock: Number(this._t.toFixed(3)),
      detection: this._detection,
      region: this._region,
      weather: this._weather,
      cinematic: this._cinematic,
      paused: this._paused,
      hidden: this._hidden,
      music: this._musicState ? {
        maqam: this._musicState.maqam?.id ?? null,
        iqa: this._musicState.iqa?.id ?? null,
        tempo: Number((this._musicState.tempo ?? 0).toFixed(2)),
        layers: this._musicState.layers ?? 0,
        playing: this._musicPlaying === true,
      } : null,
      cooldowns: this._cooldowns.size,
      stats: { ...this.stats },
      engine: this.engine.describe(),
    };
  }

  dispose() {
    this.detach();
    this.engine.dispose();
    return true;
  }
}

/**
 * Every cue in the catalogue, and how each one is reached.
 *
 * Exposed for the suite rather than for the game: a cue that nothing can trigger is a
 * sound that was written and will never be heard, and the only cheap way to notice is
 * to ask the question automatically.
 *
 * @returns {Array<{cue: string, trigger: string, via: string}>}
 */
export function cueReachability() {
  const byCue = new Map();
  const add = (cue, trigger, via, reason) => {
    if (!cue) return;
    const entry = byCue.get(cue) ?? { cue, triggers: [], via, reason };
    entry.triggers.push(trigger);
    byCue.set(cue, entry);
  };

  for (const [event, binding] of Object.entries(EVENT_CUES)) {
    // A binding whose cue is a function is resolved from the payload, so its cue ids
    // are listed explicitly rather than guessed at here.
    if (typeof binding.cue === 'function') continue;
    add(binding.cue, event, 'bus', 'Event binding.');
  }
  add('land-light', Events.NOISE_EMITTED, 'bus', 'Chosen from the noise source field.');
  add('land-heavy', Events.NOISE_EMITTED, 'bus', 'Chosen from the noise source field.');

  for (const [cue, meta] of Object.entries(MANUAL_CUES)) {
    add(cue, meta.via === 'frame' ? 'director.update()' : 'director.cue()', meta.via, meta.reason);
  }
  for (const cue of Object.keys(CUES)) {
    if (!byCue.has(cue)) add(cue, null, 'unreachable', 'Nothing can play this cue.');
  }
  // One entry per cue, in catalogue order, so the list can be diffed against CUES.
  return Object.keys(CUES).map((cue) => byCue.get(cue));
}
