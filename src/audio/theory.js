/**
 * THE BETRAYED WILL — audio/theory.js
 *
 * The musical material: tuning, modes, rhythm cycles, the cue catalogue and the
 * ambience map. Pure - no WebAudio, no DOM, no clock. Everything here is data and
 * arithmetic, so every claim about the music is testable headlessly, which is the
 * only reason a procedural score can be held to the same standard as the simulation.
 *
 * ── Why Iraqi maqam, and said plainly ───────────────────────────────────────
 * Nobody knows what Babylonian music sounded like. The Hurrian hymns are the oldest
 * deciphered notation in the world and they are not Babylonian, and a lyre tuned to
 * a guess is still a guess. What is not a guess is that the game is set in
 * Mesopotamia, in the land where the Iraqi maqam tradition is still played, and that
 * this tradition carries quarter tones - the half-flat `sikah` - which no equal
 * tempered scale contains. So the score is built from six maqamat with their
 * intervals in semitones and cents, rather than from a "middle eastern" scale picked
 * off a preset list. It is an honest relationship to the setting: a documented living
 * tradition of the same ground, credited as such, not a costume.
 *
 * ── One number, two consumers ───────────────────────────────────────────────
 * A footstep's loudness is derived from the same `noiseRadius` the AI hears. If the
 * player hears a quieter step than the guard does, the game is lying to one of them,
 * and the lie is invisible in either system tested alone.
 */

import { AUDIO, STEALTH } from '../core/constants.js';
import { clamp, clamp01, remap } from '../core/math.js';
import { RNG } from '../core/rng.js';

/* ------------------------------------------------------------------ tuning */

/**
 * A frequency from a root, a number of semitones, and a cents offset.
 *
 * Cents are carried separately rather than folded into semitones because a
 * half-flat is not a semitone and rounding it to one is what turns a maqam into a
 * major scale with a flattened third.
 */
export function frequencyFrom(rootHz, semitones, cents = 0) {
  const st = Number.isFinite(semitones) ? semitones : 0;
  const c = Number.isFinite(cents) ? cents : 0;
  return rootHz * Math.pow(2, (st + c / 100) / 12);
}

/**
 * The six modes the score uses.
 *
 * `degrees` are semitones above the tonic and may be fractional: 3.5 is a
 * half-flat third, the interval equal temperament cannot play and the one that
 * makes this sound like the region rather than like a preset. `rootHz` sits low
 * enough to drone under everything without competing with a footstep.
 */
export const MAQAMAT = Object.freeze({
  rast: Object.freeze({
    id: 'rast', ar: 'مقام راست', en: 'Rast',
    rootHz: 130.81,                       // C3
    degrees: Object.freeze([0, 2, 3.5, 5, 7, 9, 10.5]),
    character: 'stately',
    tension: Object.freeze(['calm']),
    note: 'The mode of declamation. Used for the house at peace, because the will is being dictated in it.',
  }),
  bayati: Object.freeze({
    id: 'bayati', ar: 'مقام بيات', en: 'Bayati',
    rootHz: 146.83,                       // D3
    degrees: Object.freeze([0, 1.5, 3, 5, 7, 8.5, 10]),
    character: 'longing',
    tension: Object.freeze(['calm', 'suspicious']),
    note: 'The most common Iraqi mode and the one most associated with grief. Used where the story is mourning.',
  }),
  hijaz: Object.freeze({
    id: 'hijaz', ar: 'مقام حجاز', en: 'Hijaz',
    rootHz: 123.47,                       // B2
    degrees: Object.freeze([0, 1, 4, 5, 7, 8, 10]),
    character: 'desert',
    tension: Object.freeze(['suspicious', 'alerted']),
    note: 'An augmented second between the second and third degrees. The wide interval is what reads as open ground.',
  }),
  saba: Object.freeze({
    id: 'saba', ar: 'مقام صبا', en: 'Saba',
    rootHz: 138.59,                       // C#3
    degrees: Object.freeze([0, 1.5, 3, 4, 7, 8, 10]),
    character: 'anguished',
    tension: Object.freeze(['alerted', 'combat']),
    note: 'A compressed second tetrachord. Saba is the mode Iraqi listeners associate with pain, so it is the mode for being hunted.',
  }),
  nahawand: Object.freeze({
    id: 'nahawand', ar: 'مقام نهاوند', en: 'Nahawand',
    rootHz: 110.0,                        // A2
    degrees: Object.freeze([0, 2, 3, 5, 7, 8, 10]),
    character: 'spare',
    tension: Object.freeze(['calm', 'suspicious']),
    note: 'The only mode here without a quarter tone. Used for interiors, where the writing carries it and the score should not.',
  }),
  kurd: Object.freeze({
    id: 'kurd', ar: 'مقام كرد', en: 'Kurd',
    rootHz: 116.54,                       // Bb2
    degrees: Object.freeze([0, 1, 3, 5, 7, 8, 10]),
    character: 'spare',
    tension: Object.freeze(['suspicious', 'alerted']),
    note: 'A flattened second against a major third. Unsettling without announcing itself, which is what searching a room should feel like.',
  }),
});

/**
 * The mode for a tension level, deterministically.
 *
 * The first match in a fixed order rather than a random pick: the score should
 * respond to danger the same way every time, because a player learns what a mode
 * change means, and learning is the point.
 */
export function maqamForTension(tension, preferred = null) {
  if (preferred && MAQAMAT[preferred]) return MAQAMAT[preferred];
  const order = ['rast', 'bayati', 'nahawand', 'hijaz', 'kurd', 'saba'];
  for (const id of order) {
    if (MAQAMAT[id].tension.includes(tension)) return MAQAMAT[id];
  }
  return MAQAMAT.bayati;
}

/** A scale degree, wrapped into range and usable at any octave. */
export function degreeAt(maqam, index) {
  const degrees = maqam.degrees;
  const n = degrees.length;
  const wrapped = ((index % n) + n) % n;
  const octave = Math.floor(index / n);
  return degrees[wrapped] + octave * 12;
}

/** The frequency of a scale degree at an octave displacement. */
export function degreeFrequency(maqam, index, octave = 0) {
  return frequencyFrom(maqam.rootHz, degreeAt(maqam, index) + octave * 12);
}

/* ----------------------------------------------------------------- rhythm */

/**
 * Rhythm cycles (iqa'at) for the frame drum.
 *
 * Each entry is one cycle: `beats` of it, and strikes at fractional positions with
 * a kind and a velocity. `dum` is the low centre strike, `tak` the high rim, and a
 * gap is simply no entry - the silence is part of the pattern and removing it is
 * what makes a rhythm feel machine-made.
 */
export const IQAAT = Object.freeze({
  maqsoum: Object.freeze({
    id: 'maqsoum', ar: 'مقسوم', en: 'Maqsoum', beats: 4,
    strikes: Object.freeze([
      Object.freeze({ t: 0, kind: 'dum', vel: 1.0 }),
      Object.freeze({ t: 1, kind: 'tak', vel: 0.62 }),
      Object.freeze({ t: 2.5, kind: 'dum', vel: 0.84 }),
      Object.freeze({ t: 3, kind: 'tak', vel: 0.58 }),
    ]),
    forTension: Object.freeze(['calm', 'suspicious']),
  }),
  ayyub: Object.freeze({
    id: 'ayyub', ar: 'أيوب', en: 'Ayyub', beats: 2,
    strikes: Object.freeze([
      Object.freeze({ t: 0, kind: 'dum', vel: 1.0 }),
      Object.freeze({ t: 0.75, kind: 'tak', vel: 0.5 }),
      Object.freeze({ t: 1, kind: 'dum', vel: 0.9 }),
      Object.freeze({ t: 1.5, kind: 'tak', vel: 0.55 }),
    ]),
    forTension: Object.freeze(['alerted', 'combat']),
  }),
  samaiThaqil: Object.freeze({
    id: 'samaiThaqil', ar: 'سماعي ثقيل', en: 'Samai Thaqil', beats: 10,
    strikes: Object.freeze([
      Object.freeze({ t: 0, kind: 'dum', vel: 1.0 }),
      Object.freeze({ t: 1.5, kind: 'tak', vel: 0.5 }),
      Object.freeze({ t: 3, kind: 'dum', vel: 0.8 }),
      Object.freeze({ t: 4.5, kind: 'tak', vel: 0.46 }),
      Object.freeze({ t: 6, kind: 'dum', vel: 0.74 }),
      Object.freeze({ t: 8, kind: 'tak', vel: 0.5 }),
    ]),
    forTension: Object.freeze(['calm']),
    note: 'Ten beats, so the cycle lops. Used sparingly: a metre the player cannot tap along to reads as unease rather than as a mistake, but only if it is not the default.',
  }),
});

/** The cycle for a tension level. */
export function iqaForTension(tension) {
  for (const id of ['ayyub', 'maqsoum', 'samaiThaqil']) {
    if (IQAAT[id].forTension.includes(tension)) return IQAAT[id];
  }
  return IQAAT.maqsoum;
}

/** Tempo for a tension level, interpolated across the authored endpoints. */
export function tempoForTension(tension) {
  const order = ['calm', 'suspicious', 'alerted', 'combat'];
  const i = Math.max(0, order.indexOf(tension));
  const f = i / (order.length - 1);
  return AUDIO.MUSIC_TEMPO_CALM + (AUDIO.MUSIC_TEMPO_COMBAT - AUDIO.MUSIC_TEMPO_CALM) * f;
}

/* -------------------------------------------------------------- loudness */

/**
 * How loud a footstep is, from the noise radius the AI hears.
 *
 * Normalised against the loudest authored gait, so a sprint is full gain and a
 * crouch-walk is a fraction of it - the same fraction the guard's hearing model
 * uses. A floor keeps a very quiet step from vanishing entirely: the player must
 * hear that they are being quiet, because that is the feedback loop the crouch
 * button exists to create.
 */
export function footstepGain(noiseRadius) {
  if (!Number.isFinite(noiseRadius) || noiseRadius <= 0) return 0;
  const normalised = clamp01(noiseRadius / AUDIO.FOOTSTEP_LOUDNESS_REF);
  if (normalised <= 0) return 0;
  return clamp(
    AUDIO.MIN_FOOTSTEP_GAIN + normalised * (1 - AUDIO.MIN_FOOTSTEP_GAIN),
    AUDIO.MIN_FOOTSTEP_GAIN, 1,
  );
}

/**
 * Seconds between footfalls for a planar speed.
 *
 * Derived from a stride length rather than authored per gait: one stride length and
 * the movement system's own speeds cannot disagree with each other, whereas two
 * independently tuned cadence numbers eventually do, and the result is footsteps
 * that do not match the character's feet.
 */
export function stepInterval(speed) {
  if (!Number.isFinite(speed) || speed <= 0.05) return Infinity;
  return AUDIO.STRIDE_LENGTH_M / speed;
}

/** True when a step is due, given the time since the last one. */
export function stepIsDue(speed, sinceLast) {
  const interval = stepInterval(speed);
  return Number.isFinite(interval) && sinceLast >= interval;
}

/* ------------------------------------------------------------ ambience */

/**
 * What a region sounds like.
 *
 * world-data.js carries `indoor` and `timeOfDay` but nothing about air, water or
 * people, and inventing a field there would put a mixing decision in the world's
 * data. So the map lives with the other mixing decisions. Every entry is a list of
 * beds; the engine loops them and the director crossfades between regions.
 */
export const AMBIENCE_BY_REGION = Object.freeze({
  'palace-court': Object.freeze([{ kind: 'wind', gain: AUDIO.WIND_SPEED_GAIN }, { kind: 'insects', gain: 0.16 }]),
  'palace-hall': Object.freeze([{ kind: 'roomTone', gain: 0.3 }, { kind: 'fire', gain: 0.2 }]),
  'feast-hall': Object.freeze([{ kind: 'roomTone', gain: 0.3 }, { kind: 'fire', gain: 0.26 }, { kind: 'crowd', gain: 0.14 }]),
  'brothers-wing': Object.freeze([{ kind: 'roomTone', gain: 0.26 }]),
  kitchen: Object.freeze([{ kind: 'roomTone', gain: 0.26 }, { kind: 'fire', gain: 0.34 }]),
  storage: Object.freeze([{ kind: 'roomTone', gain: 0.24 }]),
  'cellar-stair': Object.freeze([{ kind: 'roomTone', gain: 0.3 }, { kind: 'drip', gain: 0.2 }]),
  cellar: Object.freeze([{ kind: 'roomTone', gain: 0.36 }, { kind: 'drip', gain: 0.28 }]),
  'servant-passage': Object.freeze([{ kind: 'roomTone', gain: 0.3 }, { kind: 'drip', gain: 0.16 }]),
  tunnel: Object.freeze([{ kind: 'roomTone', gain: 0.34 }, { kind: 'water', gain: 0.16 }]),
  'palace-exterior': Object.freeze([{ kind: 'wind', gain: AUDIO.WIND_SPEED_GAIN }, { kind: 'insects', gain: 0.2 }]),
  'gate-road': Object.freeze([{ kind: 'wind', gain: 0.34 }, { kind: 'crowd', gain: 0.16 }]),
  'poor-quarter': Object.freeze([{ kind: 'wind', gain: 0.3 }, { kind: 'crowd', gain: 0.22 }]),
  market: Object.freeze([{ kind: 'crowd', gain: AUDIO.CROWD_GAIN }, { kind: 'wind', gain: 0.16 }]),
  'temple-precinct': Object.freeze([{ kind: 'wind', gain: 0.4 }, { kind: 'chant', gain: 0.14 }]),
  'ziggurat-terrace': Object.freeze([{ kind: 'wind', gain: 0.56 }]),
  'canal-bank': Object.freeze([{ kind: 'water', gain: AUDIO.WATER_GAIN }, { kind: 'wind', gain: 0.24 }, { kind: 'insects', gain: 0.14 }]),
  ruins: Object.freeze([{ kind: 'wind', gain: 0.5 }, { kind: 'insects', gain: 0.1 }]),
  'desert-edge': Object.freeze([{ kind: 'wind', gain: 0.62 }]),
  'layla-house': Object.freeze([{ kind: 'roomTone', gain: 0.24 }, { kind: 'fire', gain: 0.18 }]),
});

/** The beds for a region, with a documented default for anything unlisted. */
export function ambienceFor(regionId) {
  return AMBIENCE_BY_REGION[regionId] ?? Object.freeze([{ kind: 'wind', gain: 0.3 }]);
}

/** Weather adds a bed and masks the others, matching the AI's masking factors. */
export function weatherBed(weather) {
  if (weather === 'rain') return { kind: 'rain', gain: AUDIO.RAIN_GAIN, mask: STEALTH.AMBIENT_MASK_RAIN };
  if (weather === 'storm') return { kind: 'storm', gain: AUDIO.STORM_GAIN, mask: STEALTH.AMBIENT_MASK_STORM };
  return null;
}

/* ------------------------------------------------------------------ cues */

/**
 * The cue catalogue.
 *
 * Each cue is a recipe, not a sample: `voice` says which synthesizer builds it and
 * `params` says with what. Keeping the recipes as data means a test can assert that
 * a parry and a hit do not sound the same without anyone having to listen, and a
 * balance change is an edit to a number rather than a re-recording.
 *
 * `bus` is which mix group it belongs to, so the music, effects and ambience can be
 * levelled independently - a player who turns the score down to hear footsteps is
 * making a reasonable request and should be able to.
 */
export const CUES = Object.freeze({
  /* footsteps: loudness is not in the recipe, it comes from footstepGain() */
  'step-soft': Object.freeze({ voice: 'footfall', bus: 'sfx', params: Object.freeze({ body: 0.5, grain: 0.5 }) }),
  'step-hard': Object.freeze({ voice: 'footfall', bus: 'sfx', params: Object.freeze({ body: 0.9, grain: 0.8 }) }),

  /* traversal */
  'land-light': Object.freeze({ voice: 'thud', bus: 'sfx', params: Object.freeze({ gain: 0.34, pitch: 92, decay: 0.16 }) }),
  'land-heavy': Object.freeze({ voice: 'thud', bus: 'sfx', params: Object.freeze({ gain: 0.82, pitch: 58, decay: 0.34 }) }),
  jump: Object.freeze({ voice: 'noiseSweep', bus: 'sfx', params: Object.freeze({ gain: 0.16, from: 900, to: 320, dur: 0.14 }) }),
  dodge: Object.freeze({ voice: 'noiseSweep', bus: 'sfx', params: Object.freeze({ gain: 0.3, from: 380, to: 1500, dur: 0.2 }) }),
  ledge: Object.freeze({ voice: 'noiseSweep', bus: 'sfx', params: Object.freeze({ gain: 0.2, from: 240, to: 700, dur: 0.18 }) }),

  /* combat */
  'attack-swing': Object.freeze({ voice: 'whoosh', bus: 'sfx', params: Object.freeze({ gain: 0.3, dur: 0.22, band: 1400 }) }),
  'hit-flesh': Object.freeze({ voice: 'thud', bus: 'sfx', params: Object.freeze({ gain: 0.7, pitch: 74, decay: 0.2 }) }),
  'hit-blocked': Object.freeze({ voice: 'metal', bus: 'sfx', params: Object.freeze({ gain: 0.5, pitch: 420, decay: 0.18, partials: 3 }) }),
  parry: Object.freeze({ voice: 'metal', bus: 'sfx', params: Object.freeze({ gain: 0.78, pitch: 660, decay: 0.42, partials: 5 }) }),
  stagger: Object.freeze({ voice: 'thud', bus: 'sfx', params: Object.freeze({ gain: 0.5, pitch: 110, decay: 0.26 }) }),
  kill: Object.freeze({ voice: 'thud', bus: 'sfx', params: Object.freeze({ gain: 0.9, pitch: 48, decay: 0.5 }) }),
  takedown: Object.freeze({ voice: 'noiseSweep', bus: 'sfx', params: Object.freeze({ gain: 0.44, from: 700, to: 160, dur: 0.26 }) }),
  'body-fall': Object.freeze({ voice: 'thud', bus: 'sfx', params: Object.freeze({ gain: 0.6, pitch: 62, decay: 0.36 }) }),
  hurt: Object.freeze({ voice: 'breath', bus: 'sfx', params: Object.freeze({ gain: 0.5, pitch: 180, dur: 0.3 }) }),
  death: Object.freeze({ voice: 'breath', bus: 'sfx', params: Object.freeze({ gain: 0.7, pitch: 120, dur: 0.8 }) }),
  shout: Object.freeze({ voice: 'breath', bus: 'sfx', params: Object.freeze({ gain: 0.62, pitch: 240, dur: 0.42 }) }),

  /* bow */
  'bow-draw': Object.freeze({ voice: 'noiseSweep', bus: 'sfx', params: Object.freeze({ gain: 0.14, from: 2200, to: 900, dur: 0.5 }) }),
  'bow-release': Object.freeze({ voice: 'whoosh', bus: 'sfx', params: Object.freeze({ gain: 0.42, dur: 0.14, band: 2600 }) }),
  'arrow-hit': Object.freeze({ voice: 'thud', bus: 'sfx', params: Object.freeze({ gain: 0.5, pitch: 150, decay: 0.14 }) }),

  /* story and interface */
  'clue-found': Object.freeze({ voice: 'bell', bus: 'sfx', params: Object.freeze({ gain: 0.5, pitch: 784, decay: 1.8 }) }),
  'evidence-linked': Object.freeze({ voice: 'bellPair', bus: 'sfx', params: Object.freeze({ gain: 0.5, pitch: 784, ratio: 1.5, decay: 2.2 }) }),
  conclusion: Object.freeze({ voice: 'chord', bus: 'music', params: Object.freeze({ gain: 0.42, degrees: Object.freeze([0, 2, 4]), decay: 3.0 }) }),
  'dialogue-blip': Object.freeze({ voice: 'pluck', bus: 'sfx', params: Object.freeze({ gain: 0.16, degree: 4, decay: 0.5 }) }),
  'ui-click': Object.freeze({ voice: 'click', bus: 'sfx', params: Object.freeze({ gain: 0.28, pitch: 1800 }) }),
  'ui-hover': Object.freeze({ voice: 'click', bus: 'sfx', params: Object.freeze({ gain: 0.1, pitch: 2400 }) }),
  'ui-back': Object.freeze({ voice: 'click', bus: 'sfx', params: Object.freeze({ gain: 0.24, pitch: 1200 }) }),
  'objective-update': Object.freeze({ voice: 'pluck', bus: 'sfx', params: Object.freeze({ gain: 0.26, degree: 0, decay: 0.9 }) }),
  'mission-complete': Object.freeze({ voice: 'chord', bus: 'music', params: Object.freeze({ gain: 0.5, degrees: Object.freeze([0, 2, 4, 6]), decay: 3.4 }) }),
  'mission-failed': Object.freeze({ voice: 'chord', bus: 'music', params: Object.freeze({ gain: 0.46, degrees: Object.freeze([0, 1, 3]), decay: 3.6 }) }),
  'spotted-stinger': Object.freeze({ voice: 'stinger', bus: 'music', params: Object.freeze({ gain: 0.56, degree: 5, decay: 1.4 }) }),
  'alerted-stinger': Object.freeze({ voice: 'stinger', bus: 'music', params: Object.freeze({ gain: 0.34, degree: 3, decay: 1.1 }) }),
  'cinematic-in': Object.freeze({ voice: 'swell', bus: 'music', params: Object.freeze({ gain: 0.4, dur: 2.2 }) }),
  'cinematic-out': Object.freeze({ voice: 'swell', bus: 'music', params: Object.freeze({ gain: 0.3, dur: 1.6, inverted: true }) }),
  'chapter-sting': Object.freeze({ voice: 'chord', bus: 'music', params: Object.freeze({ gain: 0.54, degrees: Object.freeze([0, 4]), decay: 4.0 }) }),
});

/** Cooldown floors per cue family, so one stuck event cannot become a machine gun. */
export const CUE_COOLDOWNS = Object.freeze({
  /* interface: a hover sweep can fire dozens of times in a second */
  'ui-click': AUDIO.COOLDOWN_UI_S,
  'ui-hover': AUDIO.COOLDOWN_UI_S,
  'ui-back': AUDIO.COOLDOWN_UI_S,

  /* impacts. Four guards can be struck in one frame, and four identical clangs in one
     instant do not sum to four clangs - they sum to one louder clang with a click on
     it. A floor of one frame-and-a-bit keeps a real exchange audible while making a
     same-instant pile-up impossible. */
  'hit-flesh': AUDIO.COOLDOWN_IMPACT_S,
  'hit-blocked': AUDIO.COOLDOWN_IMPACT_S,
  'attack-swing': AUDIO.COOLDOWN_IMPACT_S,
  parry: AUDIO.COOLDOWN_IMPACT_S,
  stagger: AUDIO.COOLDOWN_IMPACT_S,
  kill: AUDIO.COOLDOWN_IMPACT_S,
  'body-fall': AUDIO.COOLDOWN_IMPACT_S,
  takedown: AUDIO.COOLDOWN_IMPACT_S,
  'arrow-hit': AUDIO.COOLDOWN_IMPACT_S,
  'bow-release': AUDIO.COOLDOWN_IMPACT_S,
  'land-light': AUDIO.COOLDOWN_IMPACT_S,
  'land-heavy': AUDIO.COOLDOWN_IMPACT_S,

  /* voices: two people cannot shout in the same 100ms, and one person cannot twice */
  shout: AUDIO.COOLDOWN_VOICE_S,
  hurt: AUDIO.COOLDOWN_VOICE_S,
  death: AUDIO.COOLDOWN_VOICE_S,

  /* story stings: a sting that can repeat stops being a sting and becomes a fault */
  'clue-found': AUDIO.COOLDOWN_STINGER_S,
  'spotted-stinger': AUDIO.COOLDOWN_STINGER_S,
  'alerted-stinger': AUDIO.COOLDOWN_STINGER_S,
  'chapter-sting': AUDIO.COOLDOWN_STINGER_S,
});

export function cooldownFor(cueId) { return CUE_COOLDOWNS[cueId] ?? 0; }

/* ---------------------------------------------------------------- phrases */

/**
 * A melodic phrase, generated rather than stored.
 *
 * Seeded from the region and the phrase index, so a place always sounds like itself
 * and a second visit replays the same melody - a score that improvised freely every
 * time would never let a player learn that the market has a tune. The walk is
 * constrained: consecutive steps move by at most a third, and the phrase returns to
 * the tonic, because an unconstrained random walk over a maqam sounds like a scale
 * being tested rather than like music.
 *
 * @returns {Array<{t: number, degree: number, dur: number, vel: number}>}
 */
export function phrase(maqam, seed, length = 8, beatsPerNote = 1) {
  const rng = new RNG(seed);
  const notes = [];
  let degree = 0;
  let t = 0;
  for (let i = 0; i < length; i++) {
    const isLast = i === length - 1;
    // An arch, not a random walk. Biasing the direction by where the phrase already
    // is keeps the melody inside the mode: unconstrained, it drifts below the tonic
    // and stays there, which is a scale being tested rather than a tune. The final
    // note is forced home, because a phrase that ends anywhere else sounds unfinished.
    if (isLast) degree = 0;
    else {
      const up = degree <= 0 ? 0.78 : degree >= 6 ? 0.22 : 0.5;
      const step = rng.chance(up) ? 1 + (rng.chance(0.35) ? 1 : 0)
        : -(1 + (rng.chance(0.25) ? 1 : 0));
      degree = clamp(degree + step, -1, 7);
    }
    const vel = isLast ? 0.9 : rng.range(0.42, 0.86);
    // A rest, sometimes, so the phrase breathes. Never on the first or last note.
    const rest = !isLast && i > 0 && rng.chance(0.16);
    notes.push({ t, degree, dur: rest ? 0 : beatsPerNote * rng.range(0.7, 1.0), vel: rest ? 0 : vel });
    t += beatsPerNote;
  }
  return notes;
}

/** The drone under a phrase: the tonic and the fifth, slightly detuned. */
export function droneFrequencies(maqam) {
  return [
    frequencyFrom(maqam.rootHz, 0),
    frequencyFrom(maqam.rootHz, degreeAt(maqam, 4), -AUDIO.DRONE_DETUNE_CENTS),
    frequencyFrom(maqam.rootHz, degreeAt(maqam, 4), AUDIO.DRONE_DETUNE_CENTS),
  ];
}
