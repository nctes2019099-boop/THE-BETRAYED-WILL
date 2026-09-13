/**
 * THE BETRAYED WILL — audio-test.mjs
 *
 * The whole audio system: the musical material, the synthesizer that builds it, the
 * director that decides when, and the wiring that carries it into the real game.
 *
 * ── Why this suite can exist at all ─────────────────────────────────────────
 * Every sound in this game is a recipe, not a recording. That is a constraint the
 * brief imposes - all assets procedurally generated, no external runtime dependency -
 * and it turns out to be the reason the audio is testable. A sample can only be
 * checked by listening to it. A graph of oscillators, filters and envelopes can be
 * built against a recorder and read back: how many partials a parry has, what
 * frequency the drone settles on, whether an envelope ramps to zero and would throw
 * in a real browser, whether a footstep's gain is the same number a guard's ear uses.
 *
 * So nothing here asks anyone to listen. Every assertion is about a structure or a
 * number, and the group that matters most is the one that would be impossible with
 * samples: group A, which checks the music theory is internally consistent.
 *
 * ── Group A: the material ───────────────────────────────────────────────────
 * Maqamat, iqa'at, tempo curves, footstep loudness, the cue catalogue. Pure
 * functions over frozen data. If a mode's degrees are wrong, every melody built on
 * it is wrong, and no amount of engine correctness hides that.
 *
 * ── Group B: the engine ─────────────────────────────────────────────────────
 * Graphs built against tests/audio-harness.mjs. The interesting failures here are
 * silent ones in the real thing: a voice that never stops, a ramp to zero that
 * throws inside a callback nobody catches, a scheduler that drops three of four
 * drum strikes because its lookahead is shorter than its cycle.
 *
 * ── Group C: the director ───────────────────────────────────────────────────
 * Event to cue, and the three levels that are driven per frame rather than by an
 * event: footsteps, score, ambience. This is where the game's facts are checked
 * against the sound's facts - one noise radius, two consumers.
 *
 * ── Group D: the wiring ─────────────────────────────────────────────────────
 * Booted through the real Game, so a director that is constructed and never updated
 * fails here rather than shipping as a silent game that reports nothing wrong.
 *
 * Run: node tests/audio-test.mjs
 */

import { describe, test, assert, runAndExit } from './harness.mjs';
import { bootGame, step } from './game-harness.mjs';
import { FakeAudioContext } from './audio-harness.mjs';
import { EventBus, Events } from '../src/core/bus.js';
import { AUDIO, MOVE, STEALTH } from '../src/core/constants.js';
import { RNG } from '../src/core/rng.js';
import { REGIONS } from '../src/content/world-data.js';

import {
  AMBIENCE_BY_REGION, CUES, CUE_COOLDOWNS, IQAAT, MAQAMAT,
  ambienceFor, cooldownFor, degreeAt, degreeFrequency, droneFrequencies,
  footstepGain, frequencyFrom, iqaForTension, maqamForTension, phrase,
  stepInterval, tempoForTension, weatherBed,
} from '../src/audio/theory.js';
import { AudioEngine, NullAudioEngine, createAudioEngine } from '../src/audio/engine.js';
import { AudioDirector, EVENT_CUES, MANUAL_CUES, cueReachability } from '../src/audio/director.js';

/* Voices the engine can actually build. A cue naming one that is not here would be
   a sound that silently falls through to a default thump. */
const ENGINE_VOICES = new Set([
  'footfall', 'thud', 'whoosh', 'noiseSweep', 'metal', 'bell', 'bellPair',
  'chord', 'pluck', 'click', 'breath', 'stinger', 'swell',
]);
const TENSIONS = ['calm', 'suspicious', 'alerted', 'combat'];

/** An engine on a fresh recorder, seeded so nothing depends on Math.random. */
function live({ rng = () => 0.42 } = {}) {
  const ctx = new FakeAudioContext();
  const engine = createAudioEngine({ contextFactory: () => ctx, rng });
  engine.unlock();
  return { ctx, engine };
}

/** A director on a real bus and a recorder-backed engine. */
function directed(opts = {}) {
  const { ctx, engine } = live(opts);
  const bus = new EventBus();
  const director = new AudioDirector({ bus, engine, rng: new RNG('audio-suite') });
  director.attach();
  director.unlock();
  return { ctx, engine, bus, director };
}

/** Advance the recorder's clock and the director's together, as a frame would. */
/**
 * Advance the recorder's clock and the director's together, as a frame would.
 *
 * `ctx` may be null: the null-engine case has no recorder, and the director must run
 * identically either way. A helper that required one would mean the silent path is
 * the one path this suite cannot drive.
 */
function frames(director, ctx, n, dt = 1 / 60, frameCtx = {}) {
  let notes = 0;
  for (let i = 0; i < n; i++) {
    if (ctx) ctx.advance(dt);
    notes += director.update(dt, frameCtx);
  }
  return notes;
}

/**
 * ══════════════════════════════════════════════════════════════════════════
 * A — THE MATERIAL
 * ══════════════════════════════════════════════════════════════════════════
 */
describe('audio — the material', () => {
  test('A1 · every maqam is tuned, ordered, and claims at least one tension', () => {
    const ids = Object.keys(MAQAMAT);
    assert.gte(ids.length, 6, 'six modes are documented; fewer means one was lost');
    for (const id of ids) {
      const m = MAQAMAT[id];
      assert.equal(m.id, id, `${id}: id must match its key`);
      assert.ok(m.ar && m.en, `${id}: named in both languages, since the game ships both`);
      assert.within(m.rootHz, 80, 400, `${id}: root must be a playable register, got ${m.rootHz}`);
      assert.gte(m.degrees.length, 7, `${id}: a maqam is a seven-note mode, not a fragment`);
      assert.equal(m.degrees[0], 0, `${id}: the tonic is the tonic`);
      assert.gt(m.tension.length, 0, `${id}: a mode nothing ever selects is dead material`);
      for (const t of m.tension) assert.includes(TENSIONS, t, `${id}: unknown tension "${t}"`);
      // Degrees must rise, or degreeAt() indexes a scale that goes backwards.
      for (let i = 1; i < m.degrees.length; i++) {
        assert.gt(m.degrees[i], m.degrees[i - 1], `${id}: degrees must ascend at ${i}`);
      }
      assert.lte(m.degrees[m.degrees.length - 1], 12, `${id}: degrees live inside one octave`);
    }
  });

  test('A2 · the modes carry quarter tones, which is the point of using them', () => {
    // A neutral second is 1.5 semitones. A synthesizer that could only reach integer
    // semitones would render every maqam as a western scale and the whole system
    // would be decoration. This is the assertion that it is not.
    let quarterToned = 0;
    for (const id of Object.keys(MAQAMAT)) {
      const fractional = MAQAMAT[id].degrees.some((d) => Math.abs(d - Math.round(d)) > 1e-9);
      if (fractional) quarterToned++;
    }
    assert.gte(quarterToned, 3, `only ${quarterToned} of 6 modes use quarter tones`);
    // Bayati's second degree is the canonical neutral second: 146.83 Hz up 1.5 semitones.
    const second = degreeFrequency(MAQAMAT.bayati, 1);
    assert.close(second, 146.83 * Math.pow(2, 1.5 / 12), 0.01, 'bayati neutral second');
    assert.notEqual(second, frequencyFrom(146.83, 2), 'a neutral second must not equal a major second');
  });

  test('A3 · every tension level selects a mode, and danger does not soften it', () => {
    for (const t of TENSIONS) {
      const m = maqamForTension(t);
      assert.ok(m && MAQAMAT[m.id] === m, `${t}: maqamForTension returned something not in MAQAMAT`);
      assert.includes(m.tension, t, `${t}: selected ${m.id}, which does not claim that tension`);
    }
    // Calm and combat must not be the same mode, or the score cannot express danger.
    assert.notEqual(maqamForTension('calm').id, maqamForTension('combat').id,
      'calm and combat must differ');
    // An explicit preference wins, which is what lets a cutscene override the danger.
    assert.equal(maqamForTension('combat', 'bayati').id, 'bayati', 'a preferred mode must win');
    assert.equal(maqamForTension('combat', 'not-a-maqam').id, maqamForTension('combat').id,
      'an unknown preference must fall back, not crash');
  });

  test('A4 · tempo rises with danger, between the authored endpoints', () => {
    const tempos = TENSIONS.map((t) => tempoForTension(t));
    for (let i = 1; i < tempos.length; i++) {
      assert.gte(tempos[i], tempos[i - 1], `tempo must not fall from ${TENSIONS[i - 1]} to ${TENSIONS[i]}`);
    }
    assert.close(tempos[0], AUDIO.MUSIC_TEMPO_CALM, 0.5, 'calm sits at the authored floor');
    assert.close(tempos[3], AUDIO.MUSIC_TEMPO_COMBAT, 0.5, 'combat sits at the authored ceiling');
    assert.gt(tempos[3] - tempos[0], 30, 'the range must be wide enough to be felt');
    assert.equal(tempoForTension('nonsense'), tempos[0], 'an unknown tension takes the calm tempo');
  });

  test('A5 · every rhythm cycle keeps its strikes inside itself, and leaves a gap', () => {
    for (const id of Object.keys(IQAAT)) {
      const iqa = IQAAT[id];
      assert.equal(iqa.id, id);
      assert.gt(iqa.beats, 1, `${id}: a one-beat cycle is not a metre`);
      assert.gt(iqa.strikes.length, 2, `${id}: too few strikes to be a pattern`);
      assert.includes(iqa.strikes.map((s) => s.kind), 'dum', `${id}: no low strike`);
      assert.includes(iqa.strikes.map((s) => s.kind), 'tak', `${id}: no rim strike`);
      for (const s of iqa.strikes) {
        assert.gte(s.t, 0, `${id}: a strike before the cycle starts`);
        assert.lt(s.t, iqa.beats, `${id}: strike at ${s.t} falls outside a ${iqa.beats}-beat cycle`);
        assert.within(s.vel, 0.05, 1, `${id}: velocity ${s.vel} is out of range`);
      }
      // Sorted, because the scheduler queues them and an unsorted pattern would have
      // to be re-sorted every cycle to place notes in time order.
      for (let k = 1; k < iqa.strikes.length; k++) {
        assert.gte(iqa.strikes[k].t, iqa.strikes[k - 1].t, `${id}: strikes must be in order`);
      }
      // Silence is part of the pattern: a cycle with a strike on every subdivision is
      // a metronome, and removing the gaps is what makes a rhythm feel machine-made.
      // Measured on the eighth grid, because maqsoum strikes beats 0, 1, 2.5 and 3 -
      // every whole beat is covered while beat 2 is still empty where it counts.
      const slots = iqa.beats * 2;
      const filled = new Set(iqa.strikes.map((s) => Math.round(s.t * 2))).size;
      assert.lt(filled, slots, `${id}: all ${slots} subdivisions are struck, so there is no rest`);
    }
    // Every tension must resolve to a real cycle.
    for (const t of TENSIONS) {
      const iqa = iqaForTension(t);
      assert.ok(IQAAT[iqa.id] === iqa, `${t}: iqaForTension returned an unknown cycle`);
      assert.includes(iqa.forTension, t, `${t}: got ${iqa.id}, which does not claim it`);
    }
  });

  test('A6 · a phrase is reproducible, bounded, arches, and ends on the tonic', () => {
    const m = MAQAMAT.bayati;
    const a = phrase(m, 'market#1', 8, 1);
    const b = phrase(m, 'market#1', 8, 1);
    const c = phrase(m, 'market#2', 8, 1);
    assert.deepEqual(a, b, 'the same seed must produce the same melody, or a place has no tune');
    assert.notEqual(JSON.stringify(a), JSON.stringify(c), 'different seeds must differ');
    assert.equal(a.length, 8, 'a phrase is as long as it was asked for');

    let rests = 0;
    let outOfRange = 0;
    let notEndingHome = 0;
    for (let seed = 0; seed < 60; seed++) {
      const p = phrase(m, `s${seed}`, 8, 1);
      for (const n of p) {
        if (n.dur === 0) rests++;
        // degreeAt wraps anything, so an out-of-range degree is not an error - but a
        // phrase that spends its life wrapped below the tonic is the drift bug this
        // asserts against.
        if (n.degree < -1 || n.degree > 7) outOfRange++;
      }
      if (p[p.length - 1].degree !== 0) notEndingHome++;
    }
    assert.equal(outOfRange, 0, 'degrees wandered outside the authored range');
    assert.equal(notEndingHome, 0, 'a phrase that does not end on the tonic sounds unfinished');
    assert.gt(rests, 0, 'sixty phrases with no rest in any of them is a metronome, not a melody');
    assert.lt(rests, 60 * 8 * 0.6, 'too many rests and the phrase has holes in it');
  });

  test('A7 · the drone is the tonic and the fifth, detuned so it is not one voice', () => {
    for (const id of Object.keys(MAQAMAT)) {
      const freqs = droneFrequencies(MAQAMAT[id]);
      assert.equal(freqs.length, 3, `${id}: a drone is the tonic plus a detuned pair`);
      assert.close(freqs[0], MAQAMAT[id].rootHz, 0.01, `${id}: the drone root is the mode root`);
      // The pair straddles the fifth symmetrically.
      assert.close((freqs[1] + freqs[2]) / 2, degreeFrequency(MAQAMAT[id], 4), 0.6,
        `${id}: the detuned pair must centre on the fifth`);
      assert.gt(freqs[2] - freqs[1], 0.05, `${id}: a perfectly tuned pair sounds like one voice`);
      assert.lt(freqs[2] - freqs[1], 6, `${id}: so far apart it is an interval, not a beat`);
    }
  });

  test('A8 · footstep loudness is the noise radius, normalised, with a floor', () => {
    assert.equal(footstepGain(0), 0, 'standing still makes no footstep at all');
    assert.equal(footstepGain(-5), 0, 'a negative radius is not a sound');
    assert.equal(footstepGain(NaN), 0, 'a missing radius is not a sound');
    assert.close(footstepGain(STEALTH.NOISE_SPRINT), 1, 1e-9, 'a sprint is full gain');
    assert.gt(footstepGain(STEALTH.NOISE_SPRINT), footstepGain(STEALTH.NOISE_RUN),
      'sprinting is louder than running');
    assert.gt(footstepGain(STEALTH.NOISE_RUN), footstepGain(STEALTH.NOISE_WALK),
      'running is louder than walking');
    assert.gt(footstepGain(STEALTH.NOISE_WALK), footstepGain(STEALTH.NOISE_CROUCH_WALK),
      'walking is louder than crouching');
    // The floor is the point of crouch feedback: a silent crouch tells the player
    // nothing about whether the crouch button worked.
    assert.gte(footstepGain(STEALTH.NOISE_CROUCH_WALK), AUDIO.MIN_FOOTSTEP_GAIN,
      'a crouched step must still be audible to the player');
    assert.lt(footstepGain(STEALTH.NOISE_CROUCH_WALK), 0.5, 'and still clearly quieter');
    // Monotonic across the whole range, so no radius produces a quieter step than a
    // smaller one.
    let prev = -1;
    for (let r = 0; r <= 20; r += 0.5) {
      const g = footstepGain(r);
      assert.gte(g, prev, `gain fell between radius ${r - 0.5} and ${r}`);
      assert.within(g, 0, 1, `gain ${g} out of range at radius ${r}`);
      prev = g;
    }
  });

  test('A9 · cadence comes from the gait speeds, not from a second authored number', () => {
    const sprint = stepInterval(MOVE.SPRINT_SPEED);
    const run = stepInterval(MOVE.RUN_SPEED);
    const walk = stepInterval(MOVE.WALK_SPEED);
    assert.lt(sprint, run, 'a sprint takes steps closer together than a run');
    assert.lt(run, walk, 'a run takes steps closer together than a walk');
    // One stride length, so the interval is exactly the stride divided by the speed.
    assert.close(sprint, AUDIO.STRIDE_LENGTH_M / MOVE.SPRINT_SPEED, 1e-9);
    assert.close(walk, AUDIO.STRIDE_LENGTH_M / MOVE.WALK_SPEED, 1e-9);
    assert.equal(stepInterval(0), Infinity, 'standing still never takes another step');
    assert.equal(stepInterval(NaN), Infinity, 'a missing speed never takes another step');
    assert.within(sprint, 0.12, 0.4, `a sprint cadence of ${sprint.toFixed(3)}s is not a human run`);
    assert.within(walk, 0.4, 1.2, `a walk cadence of ${walk.toFixed(3)}s is not a human walk`);
  });

  test('A10 · every cue names a voice the engine builds and a bus that exists', () => {
    assert.gte(Object.keys(CUES).length, 30, 'the catalogue shrank');
    for (const [id, cue] of Object.entries(CUES)) {
      assert.ok(ENGINE_VOICES.has(cue.voice), `${id}: voice "${cue.voice}" is not implemented`);
      assert.includes(['music', 'sfx', 'ambience'], cue.bus, `${id}: bus "${cue.bus}" does not exist`);
      assert.ok(cue.params && typeof cue.params === 'object', `${id}: no params`);
      if (cue.params.gain !== undefined) {
        assert.within(cue.params.gain, 0, 1, `${id}: gain ${cue.params.gain} out of range`);
      }
    }
    // A catalogue where every impact is one recipe is a catalogue nobody can tell
    // apart. These pairs are the ones a player hears most often.
    assert.notEqual(CUES.parry.voice, CUES['hit-flesh'].voice, 'a parry must not sound like a hit');
    assert.notEqual(CUES['hit-blocked'].params.pitch, CUES['hit-flesh'].params.pitch,
      'steel and flesh must differ');
    assert.gt(CUES['land-heavy'].params.gain, CUES['land-light'].params.gain,
      'a heavy landing must be louder than a light one');
    assert.gt(CUES.kill.params.gain, CUES['hit-flesh'].params.gain,
      'a killing blow must be louder than a hit');
  });

  test('A11 · every cooldown names a real cue and is a floor, not a target', () => {
    for (const [id, seconds] of Object.entries(CUE_COOLDOWNS)) {
      assert.ok(CUES[id], `cooldown on unknown cue "${id}"`);
      assert.gt(seconds, 0, `${id}: a non-positive cooldown is no cooldown`);
      assert.lt(seconds, 10, `${id}: ${seconds}s is long enough to lose a sound the player needs`);
    }
    assert.equal(cooldownFor('not-a-cue'), 0, 'an unknown cue has no cooldown');
    assert.gte(cooldownFor('spotted-stinger'), AUDIO.COOLDOWN_STINGER_S,
      'a story sting that can repeat instantly stops being a sting');
    assert.lte(cooldownFor('hit-flesh'), 0.2,
      'an impact cooldown must be short enough for a fast exchange to be heard');
    // Most cues are unthrottled: a cooldown on everything would swallow real events.
    assert.lt(Object.keys(CUE_COOLDOWNS).length, Object.keys(CUES).length,
      'every cue is rate limited, which means real events are being dropped');
  });

  test('A12 · every region in the world has an ambience, and weather matches the AI', () => {
    for (const region of REGIONS) {
      const beds = AMBIENCE_BY_REGION[region.id];
      assert.ok(beds, `region "${region.id}" has no ambience entry`);
      assert.gt(beds.length, 0, `region "${region.id}" has an empty bed list`);
      for (const b of beds) {
        assert.ok(b.kind, `${region.id}: a bed with no kind`);
        assert.within(b.gain, 0.01, 1, `${region.id}/${b.kind}: gain ${b.gain} out of range`);
      }
      // ambienceFor must agree with the map, and must not invent a third answer for
      // an unknown region.
      assert.deepEqual([...ambienceFor(region.id)], [...beds], `ambienceFor disagrees for ${region.id}`);
    }
    assert.gt(ambienceFor('no-such-region').length, 0, 'an unknown region must still have air');

    // The masking factors are the AI's own constants. If the rain bed is quieter than
    // the rain that hides the player, the picture and the perception disagree.
    const rain = weatherBed('rain');
    const storm = weatherBed('storm');
    assert.equal(rain.kind, 'rain');
    assert.close(rain.mask, STEALTH.AMBIENT_MASK_RAIN, 1e-9, 'rain must mask by the authored factor');
    assert.close(storm.mask, STEALTH.AMBIENT_MASK_STORM, 1e-9, 'storm must mask by the authored factor');
    assert.lt(storm.mask, rain.mask, 'a storm hides more than rain does');
    assert.lt(rain.mask, 1, 'a mask of 1 masks nothing');
    assert.equal(weatherBed('clear'), null, 'clear weather adds no bed');
    assert.equal(weatherBed(null), null, 'no weather adds no bed');
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════
 * B — THE ENGINE
 * ══════════════════════════════════════════════════════════════════════════
 */
describe('audio — the engine', () => {
  test('B1 · with no AudioContext the game still runs, silently and without asking', () => {
    const engine = createAudioEngine({ contextFactory: null });
    assert.ok(engine instanceof NullAudioEngine, 'no factory must yield the null engine');
    assert.equal(engine.available, false);
    assert.equal(engine.unlock(), false, 'a null engine cannot be unlocked');
    // The whole interface, exercised. A caller anywhere in the game must be able to
    // use audio without checking whether audio exists.
    assert.doesNotThrow(() => {
      engine.play('parry', { gain: 0.5, pan: -0.3 });
      engine.setBeds('market', 'rain');
      engine.setMusic({ maqam: MAQAMAT.rast, iqa: IQAAT.maqsoum, tempo: 62, layers: 2, playing: true });
      engine.update(1.5);
      engine.setMuted(true);
      engine.setVolume('music', 0.3);
      engine.suspend();
      engine.resume();
      engine.dispose();
    }, 'the null engine must implement the whole interface');
    assert.equal(engine.played.length, 1, 'the null engine still records what was asked of it');
    assert.equal(engine.setVolume('nope', 1), false, 'an unknown bus is refused');
    assert.equal(engine.describe().kind, 'null');
  });

  test('B2 · unlocking builds the mix graph, and only on a gesture', () => {
    const ctx = new FakeAudioContext();
    const engine = createAudioEngine({ contextFactory: () => ctx });
    assert.equal(engine.available, false, 'no context exists before the gesture');
    assert.equal(engine.play('parry'), false, 'and nothing can be played into it');

    // A real gesture-created context starts suspended. Building it at boot and never
    // resuming is a game that boots silent and reports nothing wrong.
    assert.equal(ctx.state, 'suspended');
    assert.equal(engine.unlock(), true);
    assert.equal(ctx.resumes, 1, 'unlock must resume the context it created');

    const desc = engine.describe();
    assert.equal(desc.kind, 'webaudio');
    assert.deepEqual(Object.keys(desc.volumes), ['master', 'music', 'sfx', 'ambience']);
    assert.close(ctx.ofType('gain')[0].gain.value, AUDIO.MASTER_DEFAULT, 1e-9, 'master starts at its default');
    // Every bus reaches the destination through the master, so one fader controls all.
    for (const bus of ['music', 'sfx', 'ambience']) {
      const g = ctx.ofType('gain').find((n) => n.gain.value === engine.volumes[bus] && n.outputs.length);
      assert.ok(g, `${bus}: no bus gain node`);
    }
    assert.ok(ctx.connectedTo(ctx.destination).length >= 1, 'nothing reaches the destination');
    // Unlocking twice must not build a second graph.
    const before = ctx.ofType('gain').length;
    engine.unlock();
    assert.equal(ctx.ofType('gain').length, before, 'a second unlock rebuilt the mix graph');
    assert.equal(engine.stats.unlocks, 2, 'but it is still counted, so a retry is visible');
  });

  test('B3 · every cue in the catalogue builds a graph and stops what it starts', () => {
    const { ctx, engine } = live();
    const failures = [];
    for (const id of Object.keys(CUES)) {
      ctx.advance(3);                 // let the previous voice expire out of the budget
      const before = ctx._nodes.length;
      const sourcesBefore = ctx._sources.length;
      const ok = engine.play(id);
      const built = ctx._nodes.length - before;
      const started = ctx._sources.slice(sourcesBefore);
      if (!ok || built === 0) { failures.push(`${id}: built ${built} nodes, ok=${ok}`); continue; }
      for (const s of started) {
        if (s.startedAt === null) failures.push(`${id}: created a source and never started it`);
        else if (s.stoppedAt === null) failures.push(`${id}: started a source that never stops`);
        else if (s.stoppedAt < s.startedAt) failures.push(`${id}: stopped before it started`);
      }
    }
    assert.deepEqual(failures, [], failures.join('\n'));
    assert.equal(engine.stats.refused, 0, 'a cue was refused for no reason the catalogue explains');
  });

  test('B4 · no envelope ramps exponentially to zero, which a real context rejects', () => {
    // exponentialRampToValueAtTime(0) throws in a browser. The fake throws too, so
    // this is the assertion that catches it - and it runs inside the cue build, which
    // in the real game is inside a frame callback nobody would see the error from.
    const { ctx, engine } = live();
    assert.doesNotThrow(() => {
      for (const id of Object.keys(CUES)) { ctx.advance(3); engine.play(id); }
    }, 'an envelope ramped to zero');
    assert.gt(ctx.automationCount, 200, 'the catalogue should schedule a great deal of automation');
    // Every exponential ramp that was scheduled went to a positive value.
    let checked = 0;
    for (const node of ctx.ofType('gain')) {
      for (const e of node.gain.events) {
        if (e.type === 'exponential') { assert.gt(e.value, 0, 'ramped to zero'); checked++; }
      }
    }
    assert.gt(checked, 50, 'too few exponential ramps were checked for this to mean anything');
  });

  test('B5 · cues that should sound different build different graphs', () => {
    const build = (id) => {
      const { ctx, engine } = live();
      engine.play(id);
      return {
        nodes: ctx._nodes.length,
        oscillators: ctx.ofType('oscillator').length,
        buffers: ctx.ofType('bufferSource').length,
        delays: ctx.ofType('delay').length,
        filters: ctx.ofType('biquad').length,
        freqs: ctx.oscillatorFrequencies,
      };
    };
    const parry = build('parry');
    const blocked = build('hit-blocked');
    assert.gt(parry.oscillators, blocked.oscillators,
      'a parry is a bigger clang than a blocked hit; if they build the same graph they sound the same');
    assert.gte(parry.filters, blocked.filters);

    const bell = build('clue-found');
    const pair = build('evidence-linked');
    assert.gt(pair.oscillators, bell.oscillators, 'a linked pair of clues is two bells, not one');

    // A struck string uses a delay line; nothing else in the catalogue does. If the
    // pluck ever stops being Karplus-Strong it becomes an organ, and this notices.
    const pluck = build('dialogue-blip');
    assert.equal(pluck.delays, 1, 'a plucked string needs exactly one delay line');
    assert.equal(build('hit-flesh').delays, 0, 'a body blow is not a string');

    const heavy = build('land-heavy');
    const light = build('land-light');
    assert.lt(Math.min(...heavy.freqs), Math.min(...light.freqs),
      'a heavy landing starts lower than a light one');
  });

  test('B6 · the voice budget is a budget: it steals the quietest rather than clipping', () => {
    const { ctx, engine } = live();
    // Fill the budget with loud voices, all inside one instant so none can expire.
    for (let i = 0; i < AUDIO.MAX_VOICES; i++) engine.play('kill', { gain: 1 });
    assert.equal(engine.voices, AUDIO.MAX_VOICES, 'the budget was not filled');

    // A quiet request into a full budget of loud voices is refused, not queued: it is
    // the quietest thing in the mix and stealing a louder voice for it would be worse.
    // step-soft has no authored gain of its own, so the request level is the voice level.
    const refusedBefore = engine.stats.refused;
    assert.equal(engine.play('step-soft', { gain: 0.001 }), false, 'a whisper should not steal a shout');
    assert.equal(engine.stats.refused, refusedBefore + 1, 'the refusal was not counted');
    assert.equal(engine.voices, AUDIO.MAX_VOICES, 'the budget grew past its limit');

    // Now empty it and ask again: a full budget must not become a permanent refusal.
    ctx.advance(10);
    engine.update();
    assert.equal(engine.voices, 0, 'voices did not expire');
    assert.equal(engine.play('step-soft', { gain: 0.5 }), true,
      'an audible request was still refused after the budget emptied');

    // And stealing does happen, when the new voice is louder than the quietest held.
    const { engine: e2 } = live();
    for (let i = 0; i < AUDIO.MAX_VOICES; i++) e2.play('step-soft', { gain: 0.02 });
    assert.equal(e2.voices, AUDIO.MAX_VOICES, 'the quiet budget was not filled');
    assert.equal(e2.play('kill', { gain: 1 }), true, 'a loud sound must take the slot from a quiet one');
    assert.equal(e2.stats.stolen, 1, 'the steal was not recorded');
    assert.equal(e2.voices, AUDIO.MAX_VOICES, 'stealing must not grow the budget');
    assert.equal(e2.played.at(-1).cueId, 'kill', 'the stolen slot went to the wrong cue');
  });

  test('B7 · a voice is held for as long as its longest tail, not its shortest', () => {
    const { ctx, engine } = live();
    // A stinger is a pluck and a thump on one gain node. The thump dies in a third of
    // a second and the string rings for over one; if the shorter tail wins, the slot
    // frees while the string is still sounding and the next cue lands on top of it.
    engine.play('spotted-stinger');
    const voice = engine._voices[0];
    assert.ok(voice, 'no voice was allocated');
    assert.gt(voice.endAt - ctx.currentTime, 0.5,
      `the stinger's slot frees after ${(voice.endAt - ctx.currentTime).toFixed(2)}s, before its string has stopped`);
  });

  test('B8 · inaudible requests are refused rather than spending a voice', () => {
    const { engine } = live();
    assert.equal(engine.play('ui-hover', { gain: 0 }), false, 'a zero-gain cue spent a voice');
    assert.equal(engine.play('ui-hover', { gain: AUDIO.MIN_AUDIBLE_GAIN / 10 }), false,
      'a cue below the audible floor spent a voice');
    assert.equal(engine.play('no-such-cue'), false, 'an unknown cue was accepted');
    assert.equal(engine.voices, 0, 'refused requests left voices behind');
    assert.equal(engine.stats.refused, 3);
  });

  test('B9 · muting silences the master without stopping the clock', () => {
    const { ctx, engine } = live();
    const master = ctx.connectedTo(ctx.destination)[0];
    assert.ok(master, 'no master bus');
    engine.setMuted(true);
    assert.close(master.gain.value, 0, 1e-9, 'muting did not silence the master');
    assert.equal(ctx.state, 'running', 'muting suspended the context, which stalls the scheduler');
    // It ramps, because a hard cut on a loud transient is itself a click.
    const ramps = master.gain.events.filter((e) => e.type === 'linear' || e.type === 'exponential');
    assert.gt(ramps.length, 0, 'muting snapped the gain instead of ramping it');
    engine.setMuted(false);
    assert.close(master.gain.value, AUDIO.MASTER_DEFAULT, 1e-9, 'unmuting did not restore the level');
    assert.equal(engine.muted, false);
  });

  test('B10 · each bus can be levelled on its own, which is a request players make', () => {
    const { ctx, engine } = live();
    assert.equal(engine.setVolume('music', 0.2), true);
    assert.close(engine.volumes.music, 0.2, 1e-9);
    assert.equal(engine.setVolume('master', 0.5), true);
    assert.close(engine.volumes.master, 0.5, 1e-9);
    assert.equal(engine.setVolume('sfx', 4), true, 'an out-of-range volume should clamp, not fail');
    assert.equal(engine.volumes.sfx, 1, 'a volume above 1 clips the master bus');
    assert.equal(engine.setVolume('sfx', -2), true);
    assert.equal(engine.volumes.sfx, 0);
    assert.equal(engine.setVolume('reverb', 0.5), false, 'an invented bus was accepted');
    assert.equal(engine.setVolume('music', NaN) && engine.volumes.music, 0, 'NaN must not poison the mix');
    // A player who turns the score down to hear footsteps is making a reasonable
    // request; the two must be independently settable.
    engine.setVolume('music', 0.05);
    engine.setVolume('sfx', 1);
    assert.lt(engine.volumes.music, engine.volumes.sfx);
    assert.ok(ctx.ofType('gain').length >= 4, 'the buses were not built');
  });

  test('B11 · a region sets its beds, and weather ducks them by the AI masking factor', () => {
    const { ctx, engine } = live();
    engine.setBeds('market', 'clear');
    for (let i = 0; i < 200; i++) engine.update(ctx.advance(1 / 60));
    assert.deepEqual(engine.describe().beds.sort(), ['crowd', 'wind'],
      'the market did not get its crowd and its wind');
    const crowdClear = engine.describe().bedTargets.crowd;
    assert.close(crowdClear, AUDIO.CROWD_GAIN, 0.02, 'the crowd bed is not at its authored level');

    // Rain adds a bed and masks the rest by exactly the factor the hearing model uses.
    engine.setBeds('market', 'rain');
    for (let i = 0; i < 200; i++) engine.update(ctx.advance(1 / 60));
    const targets = engine.describe().bedTargets;
    assert.ok('rain' in targets, 'rain added no bed');
    assert.close(targets.rain, AUDIO.RAIN_GAIN, 0.02);
    assert.close(targets.crowd, AUDIO.CROWD_GAIN * STEALTH.AMBIENT_MASK_RAIN, 0.02,
      'the crowd was not masked by the factor the guards hear through');
    assert.lt(targets.crowd, crowdClear, 'rain made the market louder');

    // Leaving for a room with no crowd fades the crowd out and stops its sources.
    const crowdSources = ctx._sources.length;
    engine.setBeds('cellar', 'clear');
    for (let i = 0; i < 400; i++) engine.update(ctx.advance(1 / 60));
    const after = engine.describe();
    assert.excludes(after.beds, 'crowd', 'a bed that is no longer wanted kept playing');
    assert.excludes(after.beds, 'rain', 'weather left with the region');
    assert.includes(after.beds, 'drip', 'the cellar has no drip');
    assert.lt(ctx._sources.length - crowdSources, 60, 'the old beds leaked their sources');
  });

  test('B12 · beds crossfade over the authored time rather than swapping', () => {
    const { ctx, engine } = live();
    engine.setBeds('market', 'clear');
    for (let i = 0; i < 200; i++) engine.update(ctx.advance(1 / 60));
    const crowdGain = ctx.ofType('gain').find((g) => g.gain.value > 0.2 && g.outputs.length === 1);
    assert.ok(crowdGain, 'no crowd bed gain');

    engine.setBeds('cellar', 'clear');
    engine.update(ctx.advance(1 / 60));
    const afterOneFrame = engine.describe().bedTargets;
    assert.ok('crowd' in afterOneFrame || ctx.ofType('gain').length > 0,
      'the departing bed vanished in a single frame');
    // Half way through the crossfade, neither bed is fully at its target.
    const half = Math.round(AUDIO.AMBIENCE_CROSSFADE_S * 60 / 2);
    for (let i = 0; i < half; i++) engine.update(ctx.advance(1 / 60));
    const mid = engine.describe();
    assert.includes(mid.beds, 'crowd', 'the crowd cut out before the crossfade finished');
    assert.includes(mid.beds, 'drip', 'the cellar had not arrived by half way');
    for (let i = 0; i < half * 2; i++) engine.update(ctx.advance(1 / 60));
    assert.excludes(engine.describe().beds, 'crowd', 'the crowd never finished leaving');
  });

  test('B13 · the scheduler places every strike of a cycle, not just the first', () => {
    // A maqsoum cycle at 62bpm is nearly four seconds long and the lookahead is a
    // third of one. A scheduler that only placed notes inside the lookahead window
    // would drop three of every four strikes, and the result is a drum that keeps a
    // metre nobody wrote - the failure is musical, not an error, so nothing reports it.
    for (const tension of TENSIONS) {
      const { ctx, engine } = live();
      const maqam = maqamForTension(tension);
      const iqa = iqaForTension(tension);
      const tempo = tempoForTension(tension);
      engine.setMusic({ maqam, iqa, tempo, layers: 1, playing: true, regionId: 'market' });

      const seconds = 20;
      let placed = 0;
      for (let i = 0; i < seconds * 60; i++) { placed += engine.update(ctx.advance(1 / 60)); }

      const cycles = seconds / (iqa.beats * 60 / tempo);
      const expected = cycles * iqa.strikes.length;
      // The lower bound is the assertion that matters: it is what fails when the
      // scheduler drops strikes. The upper bound allows the one extra cycle a lookahead
      // reaches into past the window, and no more - a scheduler that over-places is
      // playing notes twice.
      assert.gte(placed, expected * 0.9,
        `${tension}: placed ${placed} notes against ~${expected.toFixed(1)} expected for ${iqa.id} at ${tempo.toFixed(0)}bpm - strikes are being dropped`);
      assert.lte(placed, expected + iqa.strikes.length + 1,
        `${tension}: placed ${placed} notes against ~${expected.toFixed(1)} expected - notes are being duplicated`);
      assert.equal(engine.stats.refused, 0, `${tension}: notes were refused`);
      engine.dispose();
    }
  });

  test('B14 · no melody note falls outside the cycle it belongs to', () => {
    for (const tension of TENSIONS) {
      const { ctx, engine } = live();
      const iqa = iqaForTension(tension);
      const tempo = tempoForTension(tension);
      engine.setMusic({
        maqam: maqamForTension(tension), iqa, tempo, layers: 2, playing: true, regionId: 'market',
      });
      // Read the queue straight after one expansion, before it is drained.
      engine._queue = [];
      engine._cycleStart = 0;
      engine._expandCycle(0, 60 / tempo, engine._music);
      const beat = 60 / tempo;
      for (const event of engine._queue) {
        const beats = event.at / beat;
        assert.lt(beats, iqa.beats + 1e-9,
          `${tension}: a note at beat ${beats.toFixed(2)} overruns a ${iqa.beats}-beat cycle`);
        assert.gte(beats, 0, `${tension}: a note before the cycle starts`);
      }
      assert.gt(engine._queue.length, 1, `${tension}: an empty cycle`);
      engine.dispose();
      assert.ok(ctx);
    }
  });

  test('B15 · layers stack: more layers is more music, and zero layers is only the drone', () => {
    const seen = {};
    for (let layers = 0; layers <= 3; layers++) {
      const { ctx, engine } = live();
      engine.setMusic({
        maqam: maqamForTension('alerted'), iqa: iqaForTension('alerted'),
        tempo: tempoForTension('alerted'), layers, playing: true, regionId: 'market',
      });
      let placed = 0;
      for (let i = 0; i < 60 * 12; i++) placed += engine.update(ctx.advance(1 / 60));
      // A Karplus-Strong pluck is the only voice in the catalogue that uses a delay
      // line, so counting them counts melody notes exactly - and counts the octave
      // doubling that layer three adds, which placing the same event twice would not.
      seen[layers] = { placed, strings: ctx.ofType('delay').length };
      assert.ok(engine.describe().drone, `layers=${layers}: the drone stopped`);
      engine.dispose();
    }
    assert.equal(seen[0].placed, 0, 'layer zero is the drone alone and must place no notes');
    assert.equal(seen[0].strings, 0, 'layer zero must not pluck a string');
    assert.gt(seen[1].placed, 0, 'layer one adds the drum');
    assert.equal(seen[1].strings, 0, 'layer one is drum only, but it plucked strings');
    assert.gt(seen[2].placed, seen[1].placed, 'layer two adds the melody');
    assert.gt(seen[2].strings, 0, 'layer two placed melody events but built no strings');
    assert.gt(seen[3].strings, seen[2].strings * 1.5,
      `layer three built ${seen[3].strings} strings against ${seen[2].strings} at layer two: the octave doubling is not happening, so the score only gets faster under danger, never thicker`);
  });

  test('B16 · a change of danger restarts the cycle, and a repeated frame does not', () => {
    const { ctx, engine } = live();
    const state = (t) => ({
      maqam: maqamForTension(t), iqa: iqaForTension(t), tempo: tempoForTension(t),
      layers: 3, playing: true, regionId: 'market',
    });
    engine.setMusic(state('calm'));
    const firstDrone = engine.describe().drone;
    assert.ok(firstDrone);
    for (let i = 0; i < 120; i++) engine.update(ctx.advance(1 / 60));

    // The same state again must not restart anything: setMusic clears the queue, and
    // doing that sixty times a second would leave a drum that never gets past beat one.
    const oscBefore = ctx.ofType('oscillator').length;
    engine.setMusic(state('calm'));
    assert.equal(ctx.ofType('oscillator').length, oscBefore, 'an unchanged state rebuilt the drone');

    engine.setMusic(state('combat'));
    assert.gt(ctx.ofType('oscillator').length, oscBefore, 'a real change did not rebuild the drone');
    const desc = engine.describe();
    assert.equal(desc.music.maqam, 'saba');
    assert.equal(desc.music.iqa, 'ayyub');
    // The old drone must have been stopped, not left ringing under the new one.
    assert.equal(ctx.dangling.filter((s) => s.kind === 'oscillator').length, 3,
      'the drone is three oscillators; more than three running means the old one survived');
    engine.dispose();
    assert.equal(ctx.dangling.length, 0, 'dispose left sources running');
    assert.equal(ctx.closes, 1, 'dispose did not close the context');
  });

  test('B17 · stopping the score clears the queue and stops the drone', () => {
    const { ctx, engine } = live();
    engine.setMusic({
      maqam: MAQAMAT.rast, iqa: IQAAT.maqsoum, tempo: 62, layers: 3, playing: true, regionId: 'market',
    });
    for (let i = 0; i < 60; i++) engine.update(ctx.advance(1 / 60));
    assert.gt(engine.describe().queued, 0, 'nothing was queued while playing');
    engine.setMusic({
      maqam: MAQAMAT.rast, iqa: IQAAT.maqsoum, tempo: 62, layers: 3, playing: false, regionId: 'market',
    });
    assert.equal(engine.describe().queued, 0, 'a stopped score kept notes pending');
    const placed = engine.update(ctx.advance(1 / 60));
    assert.equal(placed, 0, 'a stopped score kept placing notes');
    assert.equal(engine.describe().drone, false, 'the drone outlived the score');
  });

  test('B18 · a broken tempo places nothing rather than spinning', () => {
    for (const tempo of [0, -40, NaN, Infinity, null]) {
      const { ctx, engine } = live();
      engine.setMusic({ maqam: MAQAMAT.rast, iqa: IQAAT.maqsoum, tempo, layers: 3, playing: true });
      let placed = 0;
      assert.doesNotThrow(() => {
        for (let i = 0; i < 60; i++) placed += engine.update(ctx.advance(1 / 60));
      }, `tempo ${tempo} threw`);
      assert.equal(placed, 0, `tempo ${tempo} placed ${placed} notes`);
      engine.dispose();
    }
    // And a missing maqam or cycle, which is what a partially built state looks like.
    const { ctx, engine } = live();
    engine.setMusic({ maqam: null, iqa: null, tempo: 60, layers: 3, playing: true });
    let placed = 0;
    for (let i = 0; i < 60; i++) placed += engine.update(ctx.advance(1 / 60));
    assert.equal(placed, 0, 'an incomplete music state placed notes');
    engine.dispose();
  });

  test('B19 · the pending queue is bounded over a long run', () => {
    const { ctx, engine } = live();
    engine.setMusic({
      maqam: maqamForTension('calm'), iqa: iqaForTension('calm'), tempo: 62,
      layers: 3, playing: true, regionId: 'market',
    });
    // Ten minutes of frames. A queue that grew without bound would be a slow leak
    // that only shows up in a long session, which is exactly when nobody is watching.
    for (let i = 0; i < 60 * 600; i++) engine.update(ctx.advance(1 / 60));
    assert.lte(engine.describe().queued, AUDIO.MUSIC_MAX_QUEUE, 'the queue grew past its bound');
    assert.lt(engine.describe().queued, 64, 'the queue drifted upward over ten minutes');
    assert.gt(engine.stats.notes, 500, 'ten minutes of score placed almost nothing');
    // The clock moved on, so this is not a frozen-context false pass.
    assert.close(ctx.currentTime, 600, 0.01);
    engine.dispose();
  });

  test('B20 · a suspended clock does not release every queued note at once', () => {
    const { ctx, engine } = live();
    engine.setMusic({
      maqam: maqamForTension('alerted'), iqa: iqaForTension('alerted'), tempo: 109,
      layers: 3, playing: true, regionId: 'market',
    });
    for (let i = 0; i < 60; i++) engine.update(ctx.advance(1 / 60));
    // A hidden tab: many frames of update with the audio clock frozen.
    let placedWhileFrozen = 0;
    for (let i = 0; i < 600; i++) placedWhileFrozen += engine.update();
    assert.lt(placedWhileFrozen, 40,
      `a frozen clock placed ${placedWhileFrozen} notes, which all sound at once on resume`);
    // And time jumping forward by a minute must not play the missing minute.
    const jump = engine.update(ctx.advance(60));
    assert.lt(jump, 40, `a ${jump}-note burst after a clock jump is a machine gun`);
    engine.dispose();
  });

  test('B21 · every noise buffer is built once and reused', () => {
    const { ctx, engine } = live();
    for (let i = 0; i < 40; i++) { ctx.advance(3); engine.play('step-hard'); }
    // Filling a four-second buffer per footstep would be an allocation storm on the
    // audio thread, which is heard as a stutter exactly when the player is sneaking.
    assert.lte(ctx._buffers.length, 4, `${ctx._buffers.length} buffers built for 40 footsteps`);
    for (const b of ctx._buffers) {
      assert.gt(b.length, 0, 'an empty buffer');
      assert.equal(b.numberOfChannels, 1, 'ambience and grit are mono; the bus positions them');
      // The buffer must actually contain signal, or every noise voice is silence.
      const data = b.getChannelData(0);
      let peak = 0;
      for (let i = 0; i < data.length; i += 37) peak = Math.max(peak, Math.abs(data[i]));
      assert.gt(peak, 0.01, 'a noise buffer was generated silent');
      assert.lt(peak, 1.0, 'a noise buffer clipped');
    }
  });

  test('B22 · stereo position comes from an explicit pan, and only where it can be built', () => {
    const { ctx, engine } = live();
    engine.play('shout', { pan: -0.8 });
    assert.equal(ctx.ofType('panner').length, 1, 'a panned cue built no panner');
    assert.close(ctx.ofType('panner')[0].pan.value, -0.8, 1e-9);
    engine.play('shout', { pan: 0 });
    assert.equal(ctx.ofType('panner').length, 1, 'a centred cue built a panner for nothing');
    engine.play('shout', { pan: 5 });
    assert.close(ctx.ofType('panner')[1].pan.value, 1, 1e-9, 'a pan beyond the field was not clamped');
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════
 * C — THE DIRECTOR
 * ══════════════════════════════════════════════════════════════════════════
 */
describe('audio — the director', () => {
  test('C1 · every event the director listens for is a real event', () => {
    // An invented event name is a subscription that never fires. It looks wired, it
    // passes a smoke test, and the sound is simply never heard.
    const real = new Set(Object.values(Events));
    const invented = [];
    for (const type of Object.keys(EVENT_CUES)) {
      if (!real.has(type)) invented.push(type);
    }
    assert.deepEqual(invented, [], `director listens for events that do not exist: ${invented.join(', ')}`);
    for (const binding of Object.values(EVENT_CUES)) {
      if (typeof binding.cue === 'function') continue;
      assert.ok(CUES[binding.cue], `binding plays unknown cue "${binding.cue}"`);
    }
  });

  test('C2 · every cue in the catalogue is reachable, and the gaps are declared', () => {
    const reach = cueReachability();
    assert.equal(reach.length, Object.keys(CUES).length, 'the reachability list does not match the catalogue');
    const unreachable = reach.filter((r) => r.via === 'unreachable');
    assert.deepEqual(unreachable.map((u) => u.cue), [],
      'cues nothing can play');
    // Every entry says how it is reached, so a future cue cannot arrive unlabelled.
    for (const r of reach) {
      assert.includes(['bus', 'dom', 'frame', 'pending'], r.via, `${r.cue}: unknown route "${r.via}"`);
      assert.ok(r.reason && r.reason.length > 8, `${r.cue}: no reason recorded`);
      assert.gt(r.triggers.length, 0, `${r.cue}: reachable by nothing`);
      // A bus route names a real event; a manual or pending route names the entry point
      // a caller would use, so the gap is actionable rather than merely noted.
      if (r.via === 'bus') {
        for (const t of r.triggers) {
          assert.includes(Object.values(Events), t, `${r.cue}: bound to unknown event "${t}"`);
        }
      } else {
        assert.includes(['director.cue()', 'director.update()'], r.triggers[0],
          `${r.cue}: trigger "${r.triggers[0]}" is not a real entry point`);
      }
    }
    assert.gt(reach.filter((r) => r.triggers.length > 1).length, 0,
      'no cue has more than one trigger, which suggests the table is not being read');
    // The pending set is the honest list of what is not built yet. It must be a
    // minority: a catalogue that is mostly pending is a design document, not audio.
    const pending = reach.filter((r) => r.via === 'pending');
    assert.lt(pending.length, Object.keys(CUES).length / 3,
      `${pending.length} of ${reach.length} cues await a system that does not exist`);
    for (const id of Object.keys(MANUAL_CUES)) assert.ok(CUES[id], `MANUAL_CUES lists unknown cue "${id}"`);
  });

  test('C3 · a cooldown stops one event becoming a machine gun', () => {
    const { director, engine } = directed();
    // Four guards hit in one frame is a real situation. Four identical parry clangs
    // in one instant is not a sound, it is a louder sound.
    for (let i = 0; i < 8; i++) director.bus.emit(Events.COMBAT_PARRIED, {});
    assert.equal(engine.stats.cues, 1, `${engine.stats.cues} parries fired from one frame`);
    assert.gt(director.stats.cooled, 0, 'the refusals were not counted');

    // After the cooldown the same event plays again, so this is a floor and not a latch.
    director._t += cooldownFor('parry') + 0.01;
    director.bus.emit(Events.COMBAT_PARRIED, {});
    assert.equal(engine.stats.cues, 2, 'the cue never came back after its cooldown');
  });

  test('C4 · a story sting cannot repeat inside its own cooldown', () => {
    const { director, engine } = directed();
    director.bus.emit(Events.SPOTTED, { by: 'g1' });
    assert.equal(engine.stats.cues, 1);
    // Being spotted twice in a second is possible in play. Stinging twice is not
    // dramatic, it is a fault.
    for (let i = 0; i < 10; i++) director.bus.emit(Events.SPOTTED, { by: 'g2' });
    assert.equal(engine.stats.cues, 1, 'the stinger repeated');
    director._t += AUDIO.COOLDOWN_STINGER_S + 0.01;
    director.bus.emit(Events.SPOTTED, {});
    assert.equal(engine.stats.cues, 2, 'the stinger never came back');
  });

  test('C5 · footsteps are counted from the stride, at every gait', () => {
    const gaits = [
      ['sprint', MOVE.SPRINT_SPEED, STEALTH.NOISE_SPRINT],
      ['run', MOVE.RUN_SPEED, STEALTH.NOISE_RUN],
      ['walk', MOVE.WALK_SPEED, STEALTH.NOISE_WALK],
      ['crouch', MOVE.CROUCH_SPEED, STEALTH.NOISE_CROUCH_WALK],
    ];
    for (const [name, speed, radius] of gaits) {
      const { ctx, director } = directed();
      const player = { speed, stance: name === 'crouch' ? 'crouch' : 'stand', onGround: true, noiseRadius: radius };
      const seconds = 6;
      frames(director, ctx, seconds * 60, 1 / 60, { player });
      const expected = seconds * speed / AUDIO.STRIDE_LENGTH_M;
      assert.within(director.stats.steps, expected - 1.5, expected + 1.5,
        `${name}: ${director.stats.steps} steps in ${seconds}s against ~${expected.toFixed(1)} from the stride length`);
    }
  });

  test('C6 · a footstep is as loud as the noise the guard hears, from the same number', () => {
    // One authored radius, two consumers. If the player hears a quieter step than the
    // AI perceives, the game is lying to one of them, and the lie is invisible.
    for (const [radius, label] of [
      [STEALTH.NOISE_CROUCH_WALK, 'crouch'], [STEALTH.NOISE_WALK, 'walk'],
      [STEALTH.NOISE_RUN, 'run'], [STEALTH.NOISE_SPRINT, 'sprint'],
    ]) {
      const { ctx, director, engine } = directed();
      const player = { speed: MOVE.WALK_SPEED, stance: 'stand', onGround: true, noiseRadius: radius };
      frames(director, ctx, 40, 1 / 60, { player });
      const step = engine.played.at(-1);
      assert.ok(step, `${label}: no footstep was played`);
      assert.close(step.gain, footstepGain(radius), 1e-9,
        `${label}: the step's gain is not footstepGain(${radius})`);
    }
  });

  test('C7 · crouching changes the timbre, not only the level', () => {
    const { ctx, director, engine } = directed();
    frames(director, ctx, 40, 1 / 60, {
      player: { speed: MOVE.WALK_SPEED, stance: 'stand', onGround: true, noiseRadius: STEALTH.NOISE_WALK },
    });
    const standing = engine.played.at(-1);
    frames(director, ctx, 40, 1 / 60, {
      player: { speed: MOVE.CROUCH_SPEED, stance: 'crouch', onGround: true, noiseRadius: STEALTH.NOISE_CROUCH_WALK },
    });
    const crouched = engine.played.at(-1);
    assert.equal(standing.cueId, 'step-hard');
    assert.equal(crouched.cueId, 'step-soft', 'a crouched step used the standing recipe');
    assert.lt(crouched.gain, standing.gain, 'crouching is not quieter');
    assert.notEqual(CUES['step-soft'].params.grain, CUES['step-hard'].params.grain,
      'the two steps differ only in volume, so crouching sounds like a quiet stomp');
  });

  test('C8 · the feet alternate, so a walk is not one leg hopping', () => {
    const { ctx, director, engine } = directed();
    frames(director, ctx, 120, 1 / 60, {
      player: { speed: MOVE.RUN_SPEED, stance: 'stand', onGround: true, noiseRadius: STEALTH.NOISE_RUN },
    });
    const pans = engine.played.map((p) => p.pan);
    assert.gt(pans.length, 4, 'too few steps to judge');
    let alternations = 0;
    for (let i = 1; i < pans.length; i++) {
      if (Math.sign(pans[i]) !== Math.sign(pans[i - 1])) alternations++;
    }
    assert.gt(alternations, pans.length * 0.8,
      `${alternations} of ${pans.length} steps changed side`);
    for (const p of pans) assert.within(p, -AUDIO.FOOTSTEP_PAN - 1e-9, AUDIO.FOOTSTEP_PAN + 1e-9,
      'a footstep panned wider than its own feet');
  });

  test('C9 · standing still, and being in the air, make no footsteps', () => {
    const { ctx, director } = directed();
    frames(director, ctx, 180, 1 / 60, {
      player: { speed: 0, stance: 'stand', onGround: true, noiseRadius: 0 },
    });
    assert.equal(director.stats.steps, 0, 'a standing character took steps');

    const { ctx: c2, director: d2 } = directed();
    frames(d2, c2, 180, 1 / 60, {
      player: { speed: MOVE.SPRINT_SPEED, stance: 'stand', onGround: false, noiseRadius: STEALTH.NOISE_SPRINT },
    });
    assert.equal(d2.stats.steps, 0, 'a character in mid-air took steps');

    // And stopping resets the cadence, so the first step after a halt is not early.
    const { ctx: c3, director: d3 } = directed();
    const running = { speed: MOVE.SPRINT_SPEED, stance: 'stand', onGround: true, noiseRadius: STEALTH.NOISE_SPRINT };
    frames(d3, c3, 30, 1 / 60, { player: running });
    const before = d3.stats.steps;
    frames(d3, c3, 10, 1 / 60, { player: { ...running, speed: 0 } });
    assert.equal(d3.stats.steps, before, 'steps kept firing after the character stopped');
    frames(d3, c3, 30, 1 / 60, { player: running });
    assert.gt(d3.stats.steps, before, 'steps never resumed');
  });

  test('C10 · the score follows the detection level the meter draws', () => {
    for (const tension of TENSIONS) {
      const { ctx, director } = directed();
      frames(director, ctx, 30, 1 / 60, { detection: tension, region: 'market' });
      const music = director.describe().music;
      assert.ok(music?.playing, `${tension}: the score is not playing`);
      assert.equal(music.maqam, maqamForTension(tension).id, `${tension}: wrong mode`);
      assert.equal(music.iqa, iqaForTension(tension).id, `${tension}: wrong rhythm`);
      assert.close(music.tempo, tempoForTension(tension), 0.05, `${tension}: wrong tempo`);
      director.dispose();
    }
    // Danger must add layers, not only speed the same music up.
    const { ctx: c1, director: calm } = directed();
    frames(calm, c1, 30, 1 / 60, { detection: 'calm' });
    const { ctx: c2, director: combat } = directed();
    frames(combat, c2, 30, 1 / 60, { detection: 'combat' });
    assert.gt(combat.describe().music.layers, calm.describe().music.layers,
      'combat is the same arrangement as calm, only faster');
  });

  test('C11 · the score is not rebuilt every frame', () => {
    const { ctx, director } = directed();
    frames(director, ctx, 60 * 10, 1 / 60, { detection: 'calm', region: 'market' });
    // setMusic clears the pending queue. Called sixty times a second it would leave
    // the drum permanently on beat one, and the symptom is a score that will not move.
    assert.equal(director.stats.musicChanges, 1,
      `${director.stats.musicChanges} music restarts in ten steady seconds`);
    director.bus.emit(Events.DETECTION, { level: 'combat', suspicion: 95, hostile: true });
    frames(director, ctx, 60, 1 / 60, { detection: 'combat', region: 'market' });
    assert.equal(director.stats.musicChanges, 2, 'a real change in danger did not restart the score');
    frames(director, ctx, 60 * 5, 1 / 60, { detection: 'combat', region: 'market' });
    assert.equal(director.stats.musicChanges, 2, 'the score kept restarting at a steady danger level');
  });

  test('C12 · a region change moves the ambience, and only once', () => {
    const { ctx, director, engine } = directed();
    frames(director, ctx, 120, 1 / 60, { region: 'market' });
    assert.deepEqual(engine.describe().beds.sort(), ['crowd', 'wind']);
    const changes = director.stats.bedChanges;
    frames(director, ctx, 120, 1 / 60, { region: 'market' });
    assert.equal(director.stats.bedChanges, changes, 'the same region reset the beds every frame');

    frames(director, ctx, 400, 1 / 60, { region: 'cellar' });
    assert.deepEqual(engine.describe().beds.sort(), ['drip', 'roomTone'],
      'the cellar did not get its own air');
    assert.gt(director.stats.bedChanges, changes, 'a real region change did not move the beds');
  });

  test('C13 · weather reaches the beds from the world event, not from a poll', () => {
    const { director, engine, bus } = directed();
    director.setRegion('palace-court');
    bus.emit(Events.WEATHER_CHANGED, { weather: 'rain' });
    assert.equal(engine.describe().bedTargets.rain, AUDIO.RAIN_GAIN, 'the rain bed was not added');
    assert.lt(engine.describe().bedTargets.wind, AUDIO.WIND_SPEED_GAIN,
      'the wind was not ducked under the rain');
    bus.emit(Events.WEATHER_CHANGED, { weather: 'rain' });
    assert.equal(director.stats.bedChanges, 2, 'an unchanged weather reset the beds');
    bus.emit(Events.WEATHER_CHANGED, { weather: 'storm' });
    assert.close(engine.describe().bedTargets.storm, AUDIO.STORM_GAIN, 0.02);
    bus.emit(Events.WEATHER_CHANGED, { weather: 'clear' });
    assert.notOk('storm' in engine.describe().bedTargets && engine.describe().bedTargets.storm > 0,
      'the storm kept raining');
  });

  test('C14 · a cutscene owns the score and stops the footsteps', () => {
    const { ctx, director } = directed();
    const running = { speed: MOVE.SPRINT_SPEED, stance: 'stand', onGround: true, noiseRadius: STEALTH.NOISE_SPRINT };
    frames(director, ctx, 60, 1 / 60, { player: running, detection: 'combat' });
    const stepsBefore = director.stats.steps;

    frames(director, ctx, 60, 1 / 60, { player: running, detection: 'combat', cinematic: true });
    assert.equal(director.stats.steps, stepsBefore, 'footsteps kept playing through a cutscene');
    const music = director.describe().music;
    assert.equal(music.maqam, AUDIO.CINEMATIC_MAQAM,
      'a cutscene kept the combat mode instead of the authored one');
    assert.lt(music.tempo, tempoForTension('combat'),
      'a cutscene ran at combat tempo while the player was not in control');
    assert.equal(music.layers, AUDIO.TENSION_LAYERS - 1, 'a cutscene thinned the score');

    frames(director, ctx, 60, 1 / 60, { player: running, detection: 'combat', cinematic: false });
    assert.gt(director.stats.steps, stepsBefore, 'footsteps never came back after the cutscene');
  });

  test('C15 · pausing stops the sound, the clock and the events, and resuming restores all three', () => {
    const { ctx, director, engine, bus } = directed();
    const running = { speed: MOVE.RUN_SPEED, stance: 'stand', onGround: true, noiseRadius: STEALTH.NOISE_RUN };
    frames(director, ctx, 60, 1 / 60, { player: running, region: 'market' });
    assert.gt(director.stats.steps, 0);
    const steps = director.stats.steps;
    const clock = director.describe().clock;

    bus.emit(Events.PAUSE, {});
    const placed = frames(director, ctx, 300, 1 / 60, { player: running, region: 'market', paused: true });
    assert.equal(placed, 0, 'notes were scheduled into a paused game');
    assert.equal(director.stats.steps, steps, 'footsteps kept going while paused');
    assert.close(director.describe().clock, clock, 1e-9,
      'the cooldown clock ran while paused, so sounds came off cooldown the player could not hear');
    assert.equal(engine.describe().music.playing, false, 'the score kept playing while paused');
    assert.equal(ctx.state, 'suspended', 'the context was left running behind a pause menu');

    // Events during a pause must be dropped, not queued up for the resume.
    const cues = engine.stats.cues;
    bus.emit(Events.COMBAT_HIT, {});
    assert.equal(engine.stats.cues, cues, 'a combat sound fired through a pause');

    bus.emit(Events.RESUME, {});
    frames(director, ctx, 120, 1 / 60, { player: running, region: 'market', paused: false });
    assert.equal(ctx.state, 'running', 'the context did not come back');
    assert.gt(director.stats.steps, steps, 'footsteps did not resume');
    assert.equal(engine.describe().music.playing, true, 'the score did not resume');
    bus.emit(Events.COMBAT_HIT, {});
    assert.gt(engine.stats.cues, cues, 'events stopped reaching the director after a resume');
  });

  test('C16 · muting survives a round trip and does not disturb the score', () => {
    const { ctx, director, engine } = directed();
    frames(director, ctx, 60, 1 / 60, { detection: 'alerted', region: 'market' });
    const before = director.describe().music;
    assert.equal(director.toggleMute(), true);
    assert.equal(engine.muted, true);
    assert.equal(ctx.state, 'running', 'muting suspended the context, stalling the scheduler');
    frames(director, ctx, 60, 1 / 60, { detection: 'alerted', region: 'market' });
    assert.equal(director.toggleMute(), false);
    assert.equal(engine.muted, false);
    const after = director.describe().music;
    assert.equal(after.maqam, before.maqam, 'a mute round trip changed the mode');
    assert.equal(after.playing, true, 'a mute round trip stopped the score');
  });

  test('C17 · a sound is panned by where it is, not by which side of the map it is on', () => {
    const { director } = directed();
    const at = (x, z) => ({ pos: { x, y: 0, z } });
    // Facing north (-z): the listener's right is +x.
    director._listener = { pos: { x: 0, y: 0, z: 0 }, right: { x: 1, z: 0 } };
    assert.gt(director._panFor(at(3, 0)), 0.3, 'a sound to the right did not pan right');
    assert.lt(director._panFor(at(-3, 0)), -0.3, 'a sound to the left did not pan left');
    assert.close(director._panFor(at(0, -5)), 0, 1e-9, 'a sound dead ahead panned off centre');
    assert.close(director._panFor(at(0, 5)), 0, 1e-9, 'a sound dead behind panned off centre');

    // Turn the camera and the same world point must move in the image. If it does not,
    // the soundstage is welded to the map and turning around feels wrong in a way no
    // player can name but every player notices.
    director._listener = { pos: { x: 0, y: 0, z: 0 }, right: { x: 0, z: 1 } };
    assert.close(director._panFor(at(3, 0)), 0, 1e-9,
      'a point directly ahead after a ninety degree turn was still panned off centre');
    director._listener = { pos: { x: 0, y: 0, z: 0 }, right: { x: -1, z: 0 } };
    assert.lt(director._panFor(at(3, 0)), -0.3, 'turning around did not move the soundstage');

    // Distance narrows the image: something far away cannot be placed precisely.
    director._listener = { pos: { x: 0, y: 0, z: 0 }, right: { x: 1, z: 0 } };
    const near = director._panFor(at(2, 0));
    const far = director._panFor(at(40, 0));
    assert.gt(Math.abs(near), Math.abs(far), 'a distant sound was placed as precisely as a near one');
    assert.close(director._panFor({}), 0, 1e-9, 'a sound with no position must be centred');
    assert.close(director._panFor(null), 0, 1e-9, 'a missing payload must be centred');
    director._listener = null;
    assert.close(director._panFor(at(3, 0)), 0, 1e-9, 'with no listener everything must be centred');
  });

  test('C18 · a landing plays from the noise event, at the radius the AI heard', () => {
    const { director, engine, bus } = directed();
    bus.emit(Events.NOISE_EMITTED, { radius: STEALTH.NOISE_LAND_HEAVY, source: 'land-heavy', pos: { x: 0, y: 0, z: 2 } });
    const played = engine.played.at(-1);
    assert.equal(played.cueId, 'land-heavy', 'a heavy landing did not play the heavy cue');
    // Two multipliers, both intended: the director scales by the radius the hearing
    // model used, and the engine by the cue's own authored weight. Asserting the
    // product is what pins both down.
    assert.close(played.gain,
      (STEALTH.NOISE_LAND_HEAVY / AUDIO.FOOTSTEP_LOUDNESS_REF) * CUES['land-heavy'].params.gain, 1e-9,
      'the landing was not scaled by the radius the hearing model used');

    director._t += 1;
    bus.emit(Events.NOISE_EMITTED, { radius: STEALTH.NOISE_LAND_LIGHT, source: 'land-light', pos: { x: 0, y: 0, z: 2 } });
    assert.equal(engine.played.at(-1).cueId, 'land-light');
    assert.lt(engine.played.at(-1).gain, played.gain, 'a light landing was as loud as a heavy one');
    assert.close(engine.played.at(-1).gain,
      (STEALTH.NOISE_LAND_LIGHT / AUDIO.FOOTSTEP_LOUDNESS_REF) * CUES['land-light'].params.gain, 1e-9);

    // A noise source with no matching cue must fall back, not throw.
    director._t += 1;
    assert.doesNotThrow(() => bus.emit(Events.NOISE_EMITTED, { radius: 5, source: 'invented', pos: null }));
    assert.ok(CUES[engine.played.at(-1).cueId], 'the fallback was not a real cue');
  });

  test('C19 · detaching removes every listener, including the ones with no cue', () => {
    const { director, engine, bus } = directed();
    bus.emit(Events.COMBAT_HIT, {});
    const before = engine.stats.cues;
    assert.gt(before, 0);

    assert.equal(director.detach(), true);
    director._t += AUDIO.COOLDOWN_STINGER_S + 1;   // so a refusal cannot look like a detach
    bus.emit(Events.COMBAT_HIT, {});
    bus.emit(Events.SPOTTED, {});
    bus.emit(Events.CLUE_FOUND, { clueId: 'c' });
    bus.emit(Events.WEATHER_CHANGED, { weather: 'storm' });
    bus.emit(Events.PAUSE, {});
    assert.equal(engine.stats.cues, before, 'a detached director still played cues');
    assert.equal(director.stats.bedChanges, 0, 'a detached director still moved the beds');
    assert.equal(director.detach(), false, 'detaching twice reported success');
    assert.equal(director.attach(), true, 'and could not be re-attached');
    director._t += AUDIO.COOLDOWN_STINGER_S + 1;
    bus.emit(Events.COMBAT_HIT, {});
    assert.gt(engine.stats.cues, before, 'a re-attached director stayed deaf');
    // Re-attaching must not double every subscription.
    director.detach();
    director.attach();
    const twice = engine.stats.cues;
    director._t += AUDIO.COOLDOWN_STINGER_S + 0.01;
    bus.emit(Events.CLUE_FOUND, { clueId: 'c2' });
    assert.equal(engine.stats.cues - twice, 1, 'a re-attached director plays every cue twice');
    director.dispose();
  });

  test('C20 · a director with no audio at all still runs the frame', () => {
    const bus = new EventBus();
    const director = new AudioDirector({ bus, engine: new NullAudioEngine(), rng: new RNG('null') });
    director.attach();
    assert.equal(director.available, false);
    assert.doesNotThrow(() => {
      bus.emit(Events.COMBAT_PARRIED, {});
      bus.emit(Events.NOISE_EMITTED, { radius: 20, source: 'land-heavy', pos: { x: 0, y: 0, z: 0 } });
      frames(director, null, 120, 1 / 60, {
        player: { speed: MOVE.RUN_SPEED, stance: 'stand', onGround: true, noiseRadius: STEALTH.NOISE_RUN },
        region: 'market', detection: 'alerted', weather: 'rain',
      });
    }, 'the silent path threw');
    assert.gt(director.stats.steps, 0, 'the director stopped counting steps just because nothing could play them');
    assert.ok(director.describe().music?.playing, 'the score state was not tracked while silent');
    assert.equal(director.describe().engine.kind, 'null');
    director.dispose();
  });

  test('C21 · a frame with nothing in it is not an error', () => {
    const { ctx, director } = directed();
    assert.doesNotThrow(() => {
      director.update(1 / 60);
      director.update(NaN, {});
      director.update(-5, { player: null, detection: null, region: null });
      director.update(1 / 60, { player: { speed: NaN, stance: undefined, noiseRadius: undefined } });
      frames(director, ctx, 30, 1 / 60, { player: { speed: 0 }, detection: 'nope' });
    }, 'a partial context threw');
    const desc = director.describe();
    for (const key of ['clock', 'detection', 'region', 'paused']) {
      assert.ok(key in desc, `describe() is missing ${key}`);
    }
    assert.finite(desc.clock);
    assert.finite(desc.stats.steps);
    director.dispose();
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════
 * D — THE WIRING
 * ══════════════════════════════════════════════════════════════════════════
 */
describe('audio — the wiring', () => {
  test('D1 · a headless boot is silent, and says so without calling it a problem', () => {
    const { game, report } = bootGame();
    assert.deepEqual(report.problems, [],
      'a missing AudioContext was reported as a boot problem, and headless is supported');
    assert.equal(report.audio, 'null', 'the boot report does not say which engine was built');
    assert.ok(game.audio, 'no director was built at all');
    assert.equal(game.audio.available, false);
    const audio = game.diagnostics().audio;
    assert.ok(audio, 'diagnostics has no audio section');
    assert.equal(audio.engine.kind, 'null');
    assert.equal(audio.attached, true, 'the director was built and never attached');
    game.stop();
  });

  test('D2 · an injected AudioContext is used, and the director drives it from the frame', () => {
    const ctx = new FakeAudioContext();
    const { game, report } = bootGame({ audioFactory: () => createAudioEngine({ contextFactory: () => ctx, rng: () => 0.4 }) });
    assert.deepEqual(report.problems, [], report.problems.join('; '));
    assert.equal(report.audio, 'webaudio');
    assert.ok(game.audio.engine instanceof AudioEngine);

    // The engine exists but the context does not. Boot must not create one: a context
    // built outside a user gesture starts suspended in every browser, so doing it
    // early produces a game that boots into permanent silence and reports nothing
    // wrong, which is the worst available outcome.
    assert.equal(game.audio.engine.unlocked, false, 'boot created the AudioContext before any gesture');
    assert.equal(ctx.ofType('gain').length, 0, 'boot built a mix graph nobody asked for');

    // A gesture-created context starts suspended in every current browser. Unlocking
    // must resume it: one that is never resumed is silent without being an error - no
    // throw, no rejected promise, no sound - which is the worst way for this to fail.
    assert.equal(ctx.state, 'suspended', 'the recorder should model a real gesture-created context');
    assert.equal(game.audio.unlock(), true, 'the gesture did not unlock the audio');
    assert.equal(ctx.state, 'running', 'unlocking did not resume the context, so the game would boot silent');
    assert.equal(ctx.resumes, 1, 'unlock did not ask the context to resume');
    step(game, 120, 17);
    const audio = game.diagnostics().audio;
    assert.gt(audio.clock, 0, 'the director clock never advanced from the frame loop');
    assert.ok(audio.music, 'the frame loop never told the director what the score should be');
    assert.includes(TENSIONS, audio.detection, `the game handed the director detection "${audio.detection}"`);
    assert.equal(audio.region, game.regionId, 'the director is looking at a different region than the game');
    assert.equal(audio.weather, game.weather, 'the director is looking at different weather than the game');
    assert.ok(ctx._nodes.length > 20, `the frame loop built only ${ctx._nodes.length} nodes`);
    game.stop();
  });

  test('D3 · running the player in the real game produces footsteps the guards also hear', () => {
    const ctx = new FakeAudioContext();
    const { game } = bootGame({ audioFactory: () => createAudioEngine({ contextFactory: () => ctx, rng: () => 0.4 }) });
    game.audio.unlock();

    // Sprint for two seconds through the real input and the real controller. KeyD
    // rather than KeyW: the palace-court spawn faces a wall, and a test that measured
    // audio against a character standing still would pass by proving nothing.
    game.input.handleEvent('keydown', { code: 'KeyD' });
    game.input.handleEvent('keydown', { code: 'ShiftLeft' });
    step(game, 120, 17);
    // Read both facts at the same instant, while the character is still moving: after
    // a keyup the radius decays to zero and the comparison would be against nothing.
    const heardByAI = game.lastTruth.noiseRadius;
    const played = game.audio.engine.played.filter((p) => p.cueId.startsWith('step-'));
    game.input.handleEvent('keyup', { code: 'KeyD' });
    game.input.handleEvent('keyup', { code: 'ShiftLeft' });

    const steps = game.audio.stats.steps;
    assert.gt(steps, 4, `two seconds of sprinting produced ${steps} footsteps`);
    assert.gt(heardByAI, 0, 'the AI heard nothing while the player heard footsteps');

    // The two consumers of one number. The step the player hears and the radius the
    // guard perceives come from the same authored value, or the game is lying to one
    // of them - and the lie is invisible, because both numbers look plausible.
    assert.gt(played.length, 0, 'no step cue reached the engine');
    const loudest = Math.max(...played.map((p) => p.gain));
    assert.close(loudest, footstepGain(heardByAI), 0.2,
      `the loudest footstep (${loudest.toFixed(3)}) does not match the radius the AI is using (${heardByAI.toFixed(2)} -> ${footstepGain(heardByAI).toFixed(3)})`);
    assert.close(loudest, 1, 0.05, 'a sprint is the loudest authored gait and should be full gain');
    game.stop();
  });

  test('D4 · travelling between regions in the real game moves the ambience', () => {
    const ctx = new FakeAudioContext();
    const { game } = bootGame({ audioFactory: () => createAudioEngine({ contextFactory: () => ctx, rng: () => 0.4 }) });
    game.audio.unlock();
    step(game, 30, 17);
    const first = game.regionId;
    step(game, 200, 17);
    assert.deepEqual(game.audio.engine.describe().beds.sort(), [...ambienceFor(first)].map((b) => b.kind).sort(),
      `the beds do not match the region the game is in (${first})`);

    const next = game.world.region(first).region.connects[0];
    game.travelTo(next);
    step(game, 400, 17);
    const beds = game.audio.engine.describe().beds;
    const wanted = ambienceFor(next).map((b) => b.kind);
    for (const kind of wanted) assert.includes(beds, kind, `${next}: the "${kind}" bed never arrived`);
    game.stop();
  });

  test('D5 · a long session leaks no voices and no sources', () => {
    const ctx = new FakeAudioContext();
    const { game } = bootGame({ audioFactory: () => createAudioEngine({ contextFactory: () => ctx, rng: () => 0.4 }) });
    game.audio.unlock();
    game.input.handleEvent('keydown', { code: 'KeyD' });
    step(game, 60 * 20, 17);       // twenty seconds of play
    game.input.handleEvent('keyup', { code: 'KeyD' });

    const engine = game.audio.engine;
    assert.lte(engine.voices, AUDIO.MAX_VOICES, 'the voice budget grew past its limit');
    assert.lt(engine.stats.refused, engine.stats.cues * 0.5,
      'half the requested sounds were refused, which means the budget is too small for the game');
    // Beds are meant to run; everything else must have been stopped.
    const beds = engine.describe().beds.length * 3;
    assert.lt(ctx.dangling.length, beds + 8,
      `${ctx.dangling.length} sources still running against ${beds} expected from beds and the drone`);
    assert.lt(engine._queue.length, AUDIO.MUSIC_MAX_QUEUE, 'the note queue grew without bound');

    game.stop();
    game.audio.dispose();
    assert.equal(ctx.dangling.length, 0, 'disposing the director left sources running');
    assert.equal(ctx.closes, 1, 'disposing did not close the AudioContext');
  });

  test('D6 · stopping the game stops the director listening', () => {
    const { game, bus } = bootGame();
    bus.emit(Events.CLUE_FOUND, { clueId: 'c1', source: 'world' });
    const heard = game.audio.stats.cues;
    assert.equal(heard, 1, 'the director was not listening after boot');

    game.stop();
    // The cooldown clock is moved well past every floor first. Without that, a
    // refusal and a detached listener look identical and the test would pass on a game
    // that never unsubscribed.
    game.audio._t += AUDIO.COOLDOWN_STINGER_S * 4;
    bus.emit(Events.CLUE_FOUND, { clueId: 'c2', source: 'world' });
    bus.emit(Events.COMBAT_HIT, {});
    bus.emit(Events.SPOTTED, {});
    assert.equal(game.audio.stats.cues, heard,
      'a stopped game kept building sounds for events, so every boot leaks listeners onto the bus');
    assert.equal(game.audio.stats.events, 1, 'events still reached a detached director');
  });

  test('D7 · the frame loop costs what it costs, and audio is inside the budget', () => {
    const ctx = new FakeAudioContext();
    const { game } = bootGame({ audioFactory: () => createAudioEngine({ contextFactory: () => ctx, rng: () => 0.4 }) });
    game.audio.unlock();
    step(game, 60, 17);

    // Measure the audio update on its own, against the rest of the frame. The brief
    // asks for a number with a budget, not an impression.
    const audioCtx = {
      player: { speed: MOVE.RUN_SPEED, stance: 'stand', onGround: true, noiseRadius: STEALTH.NOISE_RUN },
      listener: game.camera, detection: 'alerted', region: game.regionId, weather: game.weather,
      cinematic: false, paused: false,
    };
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 600; i++) game._updateAudio(1 / 60);
    const audioMs = Number(process.hrtime.bigint() - t0) / 1e6 / 600;

    const t1 = process.hrtime.bigint();
    for (let i = 0; i < 60; i++) game._fixedUpdate(1 / 60);
    const simMs = Number(process.hrtime.bigint() - t1) / 1e6 / 60;

    assert.lt(audioMs, 1.0, `the audio update costs ${audioMs.toFixed(3)}ms per frame`);
    assert.lt(audioMs, simMs, 'audio costs more per frame than the whole simulation');
    assert.ok(audioCtx.listener, 'the camera is not a usable listener');
    game.stop();
  });
});

runAndExit();
