/**
 * THE BETRAYED WILL — cinematic-test.mjs
 *
 * The nine authored cinematics: what the director does with them, what the mission
 * system is told and when, and what the runtime actually puts on screen.
 *
 * ── Why this suite exists ───────────────────────────────────────────────────
 * Before it, every cinematic in the game was accounted for and invisible.
 * MissionManager.playCinematic() fired at mission start and mission end, set the
 * flags a cinematic promises, and completed CINEMATIC objectives - emitting
 * CUTSCENE_START and CUTSCENE_END in the same synchronous call, so the sequence had
 * zero duration. The authored shot lists (subject, seconds, framing) were read by
 * nothing at all: `grep -rn "\.shots" src/` outside content returned no hits, and the
 * camera's cinematic solver, twoShot() and orbitShot() were exercised only by
 * camera-test. run-deep.mjs asserted "one start per cinematic" and passed, because
 * one start is exactly what was emitted.
 *
 * That is the same failure the dialogue system had, one level down, and it is why
 * group B matters as much as group A. A is about whether the pictures are right. B
 * is about whether the story waits for them: an objective that completes before the
 * cutscene plays is a lie the save file will carry forward.
 *
 * Run: node tests/cinematic-test.mjs
 */

import { describe, test, assert, runAndExit } from './harness.mjs';
import { bootGame, step } from './game-harness.mjs';
import { EventBus, Events } from '../src/core/bus.js';
import { CAM, COMBAT } from '../src/core/constants.js';
import { Vec3 } from '../src/core/math.js';
import {
  CinematicDirector, CINEMATIC_IDS, PLAYER_CHARACTER, FRAMING,
} from '../src/sim/cinematic.js';
import { CameraMode } from '../src/sim/camera.js';
import { MissionManager, EventKind } from '../src/sim/mission.js';
import { StoryState } from '../src/sim/story-state.js';
import { CINEMATICS, CINEMATIC_MAP, CHARACTERS } from '../src/content/story.js';
import { LANDMARK_MAP } from '../src/content/world-data.js';

/* ------------------------------------------------------------------------- */

/** A director wired to a bus that records its cutscene events. */
function rig(opts = {}) {
  const bus = new EventBus();
  const starts = [];
  const ends = [];
  bus.on(Events.CUTSCENE_START, (p) => starts.push(p));
  bus.on(Events.CUTSCENE_END, (p) => ends.push(p));
  const player = opts.player ?? new Vec3(3, 0, 4);
  const director = new CinematicDirector({
    bus,
    language: opts.language ?? 'ar',
    resolveSubject: opts.resolveSubject ?? ((id) => (id === PLAYER_CHARACTER ? player : null)),
    heightAt: opts.heightAt ?? null,
  });
  return { bus, director, starts, ends, player };
}

/** Run a cinematic to its natural end at 60fps. Returns the frames it took. */
function watch(director, fps = 60) {
  let frames = 0;
  while (director.active && frames < fps * 300) { director.update(1 / fps); frames++; }
  return frames;
}

/* ------------------------------------------------------------------------- */

describe('cinematic — the director', () => {
  test('A1 · all nine cinematics play from first frame to last', () => {
    const { director, starts, ends } = rig();
    let endCalls = 0;
    const played = [];
    for (const id of CINEMATIC_IDS) {
      const res = director.play(id, { onEnd: () => { endCalls++; } });
      assert.ok(res.ok, `${id} must be playable: ${res.reason}`);
      const frames = watch(director);
      assert.equal(director.active, false, `${id} must have ended`);
      assert.gt(frames, 0, `${id} must have taken at least one frame`);
      played.push({ id, frames, seconds: frames / 60 });
    }
    assert.equal(played.length, CINEMATICS.length, 'every cinematic is playable');
    assert.equal(starts.length, CINEMATICS.length, 'one START each');
    assert.equal(ends.length, CINEMATICS.length, 'one END each');
    assert.equal(endCalls, CINEMATICS.length, 'and onEnd exactly once each');
    // The runtime length must match the authored length. A cinematic that runs long
    // is sampling past its shot list; one that runs short is dropping shots.
    for (const p of played) {
      const authored = CINEMATIC_MAP[p.id].seconds;
      assert.close(p.seconds, authored, 0.25,
        `${p.id} ran ${p.seconds.toFixed(2)}s against ${authored}s authored`);
    }
  });

  test('A2 · every sample of every cinematic is a finite frame', () => {
    // The camera copies position and target straight out of sample(). One NaN in one
    // shot of one cinematic is a black screen or a camera inside the world, and it
    // would only ever be seen by the player who reached that scene.
    const { director } = rig();
    let samples = 0;
    for (const id of CINEMATIC_IDS) {
      director.play(id);
      const duration = CINEMATIC_MAP[id].seconds;
      const steps = Math.ceil(duration * 30);   // 30 samples per second
      for (let i = 0; i <= steps; i++) {
        const f = director.sample(i / steps);
        samples++;
        assert.ok(f, `${id} t=${(i / steps).toFixed(3)} returned no frame`);
        assert.ok(f.position.isFiniteVec(), `${id} t=${(i / steps).toFixed(3)} position is not finite`);
        assert.ok(f.target.isFiniteVec(), `${id} t=${(i / steps).toFixed(3)} target is not finite`);
        assert.ok(Number.isFinite(f.fov) && f.fov > 5 && f.fov < 120,
          `${id} t=${(i / steps).toFixed(3)} fov ${f.fov} is not a lens`);
        // The camera must not be underground or orbiting in the stratosphere.
        assert.gt(f.position.y, -2, `${id}: camera below the world`);
        assert.lt(f.position.y, 60, `${id}: camera implausibly high`);
      }
      director.skip();
    }
    assert.gt(samples, 5000, `expected a dense sweep, sampled ${samples}`);
  });

  test('A3 · the authored shot list sums to the authored runtime', () => {
    // The director samples the shot list but honours `seconds` for the total. If the
    // content ever disagreed, the last shot would be truncated or the sequence would
    // hold on a dead frame, and neither shows up in a single playthrough.
    for (const cin of CINEMATICS) {
      const sum = cin.shots.reduce((a, s) => a + s.seconds, 0);
      assert.equal(sum, cin.seconds, `${cin.id}: shots sum to ${sum}s but the runtime is ${cin.seconds}s`);
      for (const s of cin.shots) {
        assert.gt(s.seconds, 0, `${cin.id}: a shot of ${s.seconds}s cannot be seen`);
        assert.ok(['close', 'wide', 'twoShot', 'orbit'].includes(s.framing),
          `${cin.id}: unknown framing "${s.framing}"`);
        assert.ok(CHARACTERS[s.subject] || LANDMARK_MAP[s.subject],
          `${cin.id}: subject "${s.subject}" is neither a character nor a landmark`);
      }
    }
  });

  test('A4 · a shot is live for exactly its authored span', () => {
    const { director } = rig();
    const cin = CINEMATIC_MAP['cin-dictation'];
    director.play('cin-dictation');
    let acc = 0;
    for (const shot of cin.shots) {
      // Just inside the shot.
      const tIn = (acc + shot.seconds * 0.5) / cin.seconds;
      const liveIn = director._shotAt(tIn * cin.seconds);
      assert.equal(liveIn.shot.subject, shot.subject,
        `at t=${tIn.toFixed(3)} the live shot should be ${shot.subject}`);
      // Just before the next boundary.
      const tEdge = (acc + shot.seconds - 0.01) / cin.seconds;
      assert.equal(director._shotAt(tEdge * cin.seconds).shot.subject, shot.subject,
        `${shot.subject} must hold until its own boundary`);
      acc += shot.seconds;
    }
  });

  test('A5 · skipping ends the scene early and still closes it properly', () => {
    const { director, ends } = rig();
    let endCalls = 0;
    director.play('cin-confrontation', { onEnd: () => { endCalls++; } });
    director.update(1);
    const res = director.skip();
    assert.ok(res.ok, 'a running cinematic must be skippable');
    assert.equal(res.reason, 'skipped');
    assert.equal(director.active, false, 'and it must be over');
    assert.equal(ends.length, 1, 'with exactly one END');
    assert.equal(ends[0].skipped, true, 'marked as skipped, so a save can tell the difference');
    assert.equal(endCalls, 1, 'and the mission hook still fires once');
    assert.equal(director.stats.skipped, 1);
    assert.equal(director.stats.completed, 0, 'a skip is not a completion of the watch');
  });

  test('A6 · play refuses a second scene and an unknown id', () => {
    const { director } = rig();
    assert.ok(director.play('cin-dictation').ok);
    const busy = director.play('cin-orin-death');
    assert.equal(busy.ok, false, 'two cinematics at once must be refused');
    assert.equal(busy.reason, 'busy');
    assert.equal(director.current.id, 'cin-dictation', 'and the first is untouched');
    director.skip();
    const unknown = director.play('cin-not-a-real-cutscene');
    assert.equal(unknown.ok, false);
    assert.equal(unknown.reason, 'unknown');
    assert.equal(director.active, false, 'a refusal must not leave a scene half-open');
    assert.equal(director.stats.refused, 2);
  });

  test('A7 · the title card is localized, and follows a language change mid-scene', () => {
    const { director, starts } = rig({ language: 'ar' });
    director.play('cin-dictation');
    assert.equal(starts[0].title, CINEMATIC_MAP['cin-dictation'].ar.title, 'Arabic first');
    assert.equal(starts[0].text, CINEMATIC_MAP['cin-dictation'].ar.text);
    assert.equal(starts[0].resumed, false, 'a fresh scene is not a resume');
    director.setLanguage('en');
    assert.equal(starts.length, 2, 'the card must be republished');
    assert.equal(starts[1].title, CINEMATIC_MAP['cin-dictation'].en.title, 'now in English');
    assert.equal(starts[1].resumed, true, 'and marked as a resume, not a restart');
  });

  test('A8 · the camera payload exists only while a scene is running', () => {
    const { director } = rig();
    assert.equal(director.cameraPayload(), null, 'nothing to frame before a scene');
    director.play('cin-dictation');
    const payload = director.cameraPayload();
    assert.ok(payload, 'a running scene must hand the camera something');
    assert.equal(typeof payload.sample, 'function', 'with a sampler');
    assert.gt(payload.duration, 0, 'a duration');
    assert.equal(payload.elapsed, 0, 'starting at zero');
    director.update(1.5);
    assert.close(director.cameraPayload().elapsed, 1.5, 1e-9, 'that advances with the clock');
    director.skip();
    assert.equal(director.cameraPayload(), null, 'and nothing once the scene is over');
  });

  test('A9 · a two-shot with both actors in the same place falls back instead of degenerating', () => {
    // twoShot() builds a side vector from the two subjects. Coincident subjects make
    // that vector zero-length, and normalizing zero is how a camera ends up at NaN.
    const here = new Vec3(5, 0, 5);
    const { director } = rig({ resolveSubject: () => here.clone() });
    const tree = CINEMATICS.find((c) => c.shots.some((s) => s.framing === 'twoShot'));
    director.play(tree.id);
    const twoShotTime = (() => {
      let acc = 0;
      for (const s of tree.shots) {
        if (s.framing === 'twoShot') return (acc + s.seconds * 0.5) / tree.seconds;
        acc += s.seconds;
      }
      return 0;
    })();
    const f = director.sample(twoShotTime);
    assert.ok(f, 'the shot must still produce a frame');
    assert.ok(f.position.isFiniteVec(), 'and it must be finite');
    assert.gt(f.position.distanceXZ(f.target), 0.5, 'with the camera actually off the subject');
  });

  test('A10 · a FINISHER-authored shot is framed with the finisher camera numbers', () => {
    // cin-confrontation authors Evan's shot as mode:'FINISHER'. The camera keys
    // CINEMATIC off ctx.cinematic before it checks FINISHER, so the sequence stays in
    // cinematic mode; what the mode field buys is the framing, not a ctx switch.
    const { director } = rig();
    const cin = CINEMATICS.find((c) => c.shots.some((s) => s.mode === 'FINISHER'));
    assert.ok(cin, 'a cinematic with a finisher-authored shot is needed');
    director.play(cin.id);
    let acc = 0;
    let finisherFrame = null;
    let closeFrame = null;
    for (const s of cin.shots) {
      const t = (acc + s.seconds * 0.5) / cin.seconds;
      const f = director.sample(t);
      if (s.mode === 'FINISHER') finisherFrame = { f, s };
      else if (s.framing === 'close') closeFrame = { f, s };
      acc += s.seconds;
    }
    assert.ok(finisherFrame, 'the finisher shot must be sampled');
    const dist = finisherFrame.f.position.distanceXZ(finisherFrame.f.target);
    // A push means the distance sweeps either side of the authored constant.
    // COMBAT holds the finisher's camera numbers, not CAM - the same trap the
    // director fell into first, where reading them off CAM gave undefined and the
    // frame came out NaN.
    assert.lt(Math.abs(dist - COMBAT.FINISHER_CAMERA_DISTANCE), 1.2,
      `finisher shot sat ${dist.toFixed(2)}m from the subject against ${COMBAT.FINISHER_CAMERA_DISTANCE}m`);
    if (closeFrame) {
      const closeDist = closeFrame.f.position.distanceXZ(closeFrame.f.target);
      assert.notEqual(closeDist.toFixed(1), dist.toFixed(1),
        'a finisher shot must not be framed identically to an ordinary close');
    }
  });

  test('A11 · a character the world has no body for is anchored and counted', () => {
    // CHARACTERS is narrative data; the world spawns guards, not cast. Guessing where
    // Orin stands is unavoidable, so the guess is counted rather than silent: a
    // counted guess is a work order, a silent one looks correct in a test and wrong on
    // screen.
    const { director } = rig({ resolveSubject: () => null });
    director.play('cin-dictation');
    // Sample inside the shot that names him. t=0.5 is the orbit of the boundary
    // stone, which never resolves Orin at all, so it cannot report him.
    director.sample(0.1);
    assert.ok(director.fallbacks.includes('orin'),
      'Orin has no body, so he must be reported as an anchor');
    const first = [...director.fallbacks];
    // Deterministic: the same scene must anchor the same character in the same place
    // on a second playthrough, or a player revisiting a cutscene sees a different room.
    const second = rig({ resolveSubject: () => null });
    second.director.play('cin-dictation');
    const f1 = director.sample(0.1);
    const f2 = second.director.sample(0.1);
    assert.close(f1.position.x, f2.position.x, 1e-9, 'anchoring must be reproducible');
    assert.close(f1.position.z, f2.position.z, 1e-9, 'in every axis that matters');
    assert.deepEqual(second.director.fallbacks, first, 'and reported the same way');
  });

  test('A12 · a landmark subject resolves from content with no resolver at all', () => {
    const bus = new EventBus();
    const director = new CinematicDirector({ bus, resolveSubject: null });
    director.play('cin-orin-death');   // both shots are landmarks
    const f = director.sample(0.25);
    assert.ok(f, 'the shot must be framed');
    const lm = LANDMARK_MAP['lm-hall-beds'];
    assert.ok(lm, 'the content must have that landmark');
    // The camera looks at the landmark, not at some unrelated corner of the region.
    assert.lt(Math.hypot(f.target.x - lm.pos[0], f.target.z - lm.pos[2]), 0.01,
      'the shot must be aimed at the landmark it names');
    assert.deepEqual(director.fallbacks, [], 'and no character anchoring was needed');
  });

  test('A13 · the camera moves within a shot rather than holding a still', () => {
    // A procedurally generated locked-off frame is indistinguishable from a loading
    // screen. The push and the drift exist so the player can tell this is a shot.
    const { director } = rig();
    for (const id of CINEMATIC_IDS) {
      director.play(id);
      const cin = CINEMATIC_MAP[id];
      let acc = 0;
      for (const shot of cin.shots) {
        const a = director.sample((acc + shot.seconds * 0.2) / cin.seconds);
        const b = director.sample((acc + shot.seconds * 0.8) / cin.seconds);
        const moved = a.position.distanceXZ(b.position);
        const turned = Math.abs(
          Math.atan2(a.target.x - a.position.x, a.target.z - a.position.z)
          - Math.atan2(b.target.x - b.position.x, b.target.z - b.position.z),
        );
        assert.ok(moved > 0.02 || turned > 0.01,
          `${id}/${shot.subject} (${shot.framing}) is a still: moved ${moved.toFixed(4)}m`);
        acc += shot.seconds;
      }
      director.skip();
    }
  });

  test('A14 · a cut between shots actually moves the camera', () => {
    // If consecutive shots produced the same frame the sequence would be one long
    // static shot with a title card, and nothing in the shot list would matter.
    const { director } = rig();
    director.play('cin-dictation');
    const cin = CINEMATIC_MAP['cin-dictation'];
    const boundaries = [];
    let acc = 0;
    for (const shot of cin.shots) { acc += shot.seconds; boundaries.push(acc); }
    for (const b of boundaries.slice(0, -1)) {
      const before = director.sample((b - 0.05) / cin.seconds);
      const after = director.sample((b + 0.05) / cin.seconds);
      const delta = before.position.distanceXZ(after.position)
        + Math.abs(before.position.y - after.position.y);
      assert.gt(delta, 0.25, `the cut at ${b}s moved the camera only ${delta.toFixed(3)}m`);
    }
  });

  test('A15 · a resolver returning garbage cannot poison a frame', () => {
    // The host resolver is live game state. A half-constructed player or a torn-down
    // region could hand back NaN, and the camera copies whatever it is given.
    const { director } = rig({ resolveSubject: () => new Vec3(NaN, NaN, NaN) });
    director.play('cin-confrontation');
    for (let i = 0; i <= 100; i++) {
      const f = director.sample(i / 100);
      assert.ok(f, `t=${i / 100} returned nothing`);
      assert.ok(f.position.isFiniteVec(), `t=${i / 100} position went non-finite`);
      assert.ok(f.target.isFiniteVec(), `t=${i / 100} target went non-finite`);
    }
  });

  test('A16 · a resolver returning a plain object is accepted', () => {
    const { director } = rig({ resolveSubject: (id) => (id === PLAYER_CHARACTER ? { x: 1, y: 2, z: 3 } : null) });
    director.play('cin-dictation');
    const f = director.sample(0.5);
    assert.ok(f && f.position.isFiniteVec(), 'a {x,y,z} literal must work as well as a Vec3');
  });

  test('A17 · update() on an idle director is inert', () => {
    const { director, starts, ends } = rig();
    assert.equal(director.update(1), false, 'nothing is playing');
    assert.equal(director.skip().ok, false, 'and nothing can be skipped');
    assert.deepEqual(starts, []);
    assert.deepEqual(ends, []);
    assert.equal(director.stats.played, 0);
  });
});

/* ------------------------------------------------------------------------- */

describe('cinematic — the mission handoff', () => {
  /** A manager with no director: the headless path every existing suite uses. */
  function bareManager() {
    const bus = new EventBus();
    const events = [];
    bus.on(Events.CUTSCENE_START, () => events.push('start'));
    bus.on(Events.CUTSCENE_END, () => events.push('end'));
    const state = new StoryState();
    const missions = new MissionManager({ bus, state });
    return { bus, missions, state, events };
  }

  test('B1 · without a director the immediate path is unchanged', () => {
    // This is the backward-compatibility claim. Ten suites construct a MissionManager
    // directly, and run-deep counts one CUTSCENE_START per cinematic; the injection
    // must not alter a single one of them.
    const { missions, events } = bareManager();
    assert.ok(missions.playCinematic('cin-dictation'), 'the cinematic must play');
    assert.deepEqual(events, ['start', 'end'], 'START and END in the same call, as before');
  });

  test('B2 · with a director, END is deferred until the scene has run', () => {
    const { director, ends } = rig();
    const bus = director.bus;
    const state = new StoryState();
    const missions = new MissionManager({ bus, state, cinematics: director });
    assert.ok(missions.playCinematic('cin-dictation'), 'the cinematic must play');
    assert.equal(ends.length, 0, 'END must not fire before the player has watched');
    assert.equal(director.active, true, 'the scene is running');
    watch(director);
    assert.equal(ends.length, 1, 'and fires once, afterwards');
  });

  test('B3 · the objective completes after the watch, not before it', () => {
    // The load-bearing assertion of this group. An objective that completes while the
    // cutscene is still playing is recorded in a save made mid-scene, and the player
    // who reloads never sees the scene but the story has moved on without them.
    const { director } = rig();
    const bus = director.bus;
    const state = new StoryState();
    const missions = new MissionManager({ bus, state, cinematics: director });
    const notified = [];
    const real = missions.notify.bind(missions);
    missions.notify = (e) => { if (e?.kind === EventKind.CINEMATIC) notified.push(e.id); return real(e); };

    missions.playCinematic('cin-dictation');
    assert.deepEqual(notified, [], 'nothing is credited while the scene is on screen');
    watch(director);
    assert.deepEqual(notified, ['cin-dictation'], 'and exactly once when it ends');
  });

  test('B4 · a second cinematic while one runs cannot strand the objective', () => {
    // The refusal path has to fall through to the immediate one. Two mission-start
    // cinematics arriving in the same tick is not a scenario the content intends, but
    // if it ever happened the second objective would wait forever for a scene that was
    // refused - a soft lock with no visible cause.
    const { director } = rig();
    const bus = director.bus;
    const state = new StoryState();
    const missions = new MissionManager({ bus, state, cinematics: director });
    const notified = [];
    const real = missions.notify.bind(missions);
    missions.notify = (e) => { if (e?.kind === EventKind.CINEMATIC) notified.push(e.id); return real(e); };

    missions.playCinematic('cin-dictation');
    assert.ok(missions.playCinematic('cin-orin-death'), 'the second request still succeeds');
    assert.deepEqual(notified, ['cin-orin-death'], 'and its objective is credited immediately');
    assert.ok(missions.problems.some((p) => p.kind === 'cinematic-refused'),
      'with the refusal recorded, not swallowed');
    assert.equal(director.current.id, 'cin-dictation', 'and the running scene is untouched');
  });

  test('B5 · the story consequences apply whether or not the scene is watched', () => {
    // Skipping is a player right, and it must not cost them the injury the chapter
    // depends on. Withholding a flag behind presentation would make the simulation
    // depend on whether the player held a button.
    const { director } = rig();
    const bus = director.bus;
    const state = new StoryState();
    const missions = new MissionManager({ bus, state, cinematics: director });
    const cin = CINEMATICS.find((c) => c.setsInjured || (c.setsFlags ?? []).length);
    assert.ok(cin, 'a cinematic that sets a flag is needed');
    missions.playCinematic(cin.id);
    if (cin.setsInjured) assert.equal(state.has('flag', 'wounded'), true, 'injured on request');
    for (const f of cin.setsFlags ?? []) {
      assert.equal(state.has('flag', f), true, `${f} set on request, before the watch`);
    }
    director.skip();
    for (const f of cin.setsFlags ?? []) {
      assert.equal(state.has('flag', f), true, `${f} must survive a skip`);
    }
  });

  test('B6 · a replayed cinematic does not credit its objective twice', () => {
    const { director } = rig();
    const bus = director.bus;
    const state = new StoryState();
    const missions = new MissionManager({ bus, state, cinematics: director });
    const notified = [];
    const real = missions.notify.bind(missions);
    missions.notify = (e) => { if (e?.kind === EventKind.CINEMATIC) notified.push(e.id); return real(e); };
    missions.playCinematic('cin-dictation');
    watch(director);
    missions.playCinematic('cin-dictation');
    watch(director);
    assert.deepEqual(notified, ['cin-dictation'], 'seen once, credited once');
  });

  test('B7 · an unknown cinematic is still refused and recorded', () => {
    const { director } = rig();
    const bus = director.bus;
    const missions = new MissionManager({ bus, state: new StoryState(), cinematics: director });
    assert.equal(missions.playCinematic('cin-nope'), false, 'must fail');
    assert.ok(missions.problems.some((p) => p.kind === 'unknown-cinematic'), 'and be recorded');
    assert.equal(director.stats.played, 0, 'the director is never asked');
  });
});

/* ------------------------------------------------------------------------- */

describe('cinematic — the runtime', () => {
  /** A mission whose start triggers a cinematic. */
  function missionWithCinematic(at = 'mission-start') {
    return CINEMATICS.find((c) => c.at === at);
  }

  test('C1 · boot creates a director and hands it to the mission manager', () => {
    const { game } = bootGame();
    assert.ok(game.cinematics instanceof CinematicDirector, 'a director must exist');
    assert.equal(game.missions.cinematics, game.cinematics,
      'and the mission manager must be holding that same director, not another one');
    assert.equal(game.cinematics.active, false, 'nothing is playing at boot');
  });

  test('C2 · starting a mission plays its cinematic and stops the world', () => {
    const { game } = bootGame();
    const cin = missionWithCinematic('mission-start');
    assert.ok(cin, 'a mission-start cinematic is needed');
    const mission = cin.mission;
    game.missions.startChapter(CINEMATIC_MAP[cin.id].chapter);
    const started = game.missions.startMission(mission);
    assert.ok(started, `${mission} must start`);
    assert.equal(game.cinematics.active, true, 'and its cinematic must be running');
    assert.equal(game.cinematics.current.id, cin.id);

    const stepsBefore = game.steps;
    const posBefore = { ...game.player.pos };
    game.input.handleEvent('keydown', { code: 'KeyW' });
    step(game, 20);
    assert.equal(game.steps, stepsBefore, 'the simulation must not advance during a cutscene');
    assert.close(game.player.pos.x, posBefore.x, 1e-9, 'and the player must not walk out of frame');
    assert.close(game.player.pos.z, posBefore.z, 1e-9, 'in any direction');
    game.input.handleEvent('keyup', { code: 'KeyW' });
    assert.gt(game.renderer.renders, 0, 'but the scene must still be drawn');
  });

  test('C3 · the camera enters cinematic mode and hands itself back afterwards', () => {
    // This is the assertion that was impossible to make before: the camera's cinematic
    // solver existed and was tested, and the game never once entered it.
    const { game } = bootGame();
    game.cinematics.play('cin-orin-death');
    step(game, 4);
    assert.equal(game.camera.mode, CameraMode.CINEMATIC,
      `the camera must be in cinematic mode, is "${game.camera.mode}"`);
    const during = { ...game.camera.position };
    assert.ok(Number.isFinite(during.x) && Number.isFinite(during.y) && Number.isFinite(during.z),
      'with a finite position');
    assert.close(game.camera.fov, CAM.FOV_CINEMATIC, 14, 'and a cinematic lens');

    // Drive it to the end and confirm the gameplay solver takes back over.
    for (let i = 0; i < 4000 && game.cinematics.active; i++) step(game, 1);
    assert.equal(game.cinematics.active, false, 'the scene must have ended');
    step(game, 6);
    assert.notEqual(game.camera.mode, CameraMode.CINEMATIC,
      `the camera must return to gameplay, stayed "${game.camera.mode}"`);
  });

  test('C4 · the camera actually travels through the shot list', () => {
    // A mode flag flipping is not a cutscene. This asserts the drawn camera position
    // changes across the sequence, which is the difference between a cinematic and a
    // freeze-frame with a title on it.
    const { game } = bootGame();
    game.cinematics.play('cin-dictation');
    const seen = new Set();
    let distinct = 0;
    for (let i = 0; i < 260 && game.cinematics.active; i++) {
      step(game, 1);
      const p = game.camera.position;
      const key = `${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}`;
      if (!seen.has(key)) { seen.add(key); distinct++; }
    }
    assert.gt(distinct, 20, `the camera held ${distinct} distinct positions across a 34s, 3-shot scene`);
  });

  test('C5 · interact skips the cutscene and returns control', () => {
    const { game } = bootGame();
    game.cinematics.play('cin-confrontation');   // the longest, at 40s
    step(game, 4);
    assert.equal(game.cinematics.active, true);
    game.input.handleEvent('keydown', { code: 'KeyE' });
    step(game, 2);
    game.input.handleEvent('keyup', { code: 'KeyE' });
    assert.equal(game.cinematics.active, false, 'the interact key must skip it');
    const stepsAfterSkip = game.steps;
    step(game, 30);
    assert.gt(game.steps, stepsAfterSkip, 'and the world must resume stepping');
    assert.notEqual(game.camera.mode, CameraMode.CINEMATIC, 'with the gameplay camera back');
  });

  test('C6 · escape skips the cutscene instead of opening the pause menu', () => {
    const { game } = bootGame();
    game.cinematics.play('cin-dictation');
    step(game, 2);
    game.input.handleEvent('keydown', { code: 'Escape' });
    game.input.handleEvent('keyup', { code: 'Escape' });
    step(game, 2);
    assert.equal(game.cinematics.active, false, 'the scene must end');
    assert.equal(game.paused, false, 'and the pause menu must not open over a cutscene');
  });

  test('C7 · the game travels to the region a cinematic was authored for', () => {
    // Shots resolve subjects against a place. Playing palace-hall footage while
    // standing in the court would verify the camera against colliders that are not
    // there and frame a room the player is not in.
    const { game } = bootGame();
    assert.equal(game.regionId, 'palace-court', 'boot region');
    const cin = CINEMATICS.find((c) => c.region !== 'palace-court');
    assert.ok(cin, 'a cinematic in another region is needed');
    game.cinematics.play(cin.id);
    step(game, 2);
    assert.equal(game.regionId, cin.region,
      `must travel to ${cin.region}, stayed in ${game.regionId}`);
    assert.equal(game.cinematics.active, true, 'and the scene survives the move');
    assert.equal(game.camera.mode, CameraMode.CINEMATIC, 'still being filmed');
  });

  test('C8 · a language switch re-publishes the title card mid-scene', () => {
    const { game, bus } = bootGame();
    const cards = [];
    bus.on(Events.CUTSCENE_START, (p) => cards.push(p));
    game.cinematics.play('cin-dictation');
    assert.equal(cards.length, 1);
    assert.equal(cards[0].title, CINEMATIC_MAP['cin-dictation'].ar.title);
    game.setLanguage('en');
    assert.equal(cards.length, 2, 'the card must be republished');
    assert.equal(cards[1].title, CINEMATIC_MAP['cin-dictation'].en.title);
    assert.equal(cards[1].resumed, true, 'as a resume, so the HUD does not restart the scene');
    game.setLanguage('ar');
  });

  test('C9 · no interaction prompt is offered during a cutscene', () => {
    const { game, bus } = bootGame();
    const prompts = [];
    bus.on(Events.PROMPT, (p) => prompts.push(p));
    game.cinematics.play('cin-dictation');
    const before = prompts.length;
    step(game, 20);
    const during = prompts.filter((p, i) => i >= before && p !== null);
    assert.deepEqual(during, [], 'a cutscene must not invite the player to interact');
  });

  test('C10 · diagnostics report the director, including what it had to guess', () => {
    const { game } = bootGame();
    const d = game.diagnostics();
    assert.ok(d.cinematic, 'the director must appear in diagnostics');
    assert.equal(d.cinematic.active, false);
    assert.equal(d.cinematicsPlayable, CINEMATICS.length,
      'and the count of playable cinematics must be the count that exist');
    game.cinematics.play('cin-dictation');
    game.cinematics.sample(0.1);
    const live = game.diagnostics().cinematic;
    assert.equal(live.active, true);
    assert.equal(live.cinematicId, 'cin-dictation');
    assert.gt(live.duration, 0);
    assert.ok(Array.isArray(live.fallbackSubjects),
      'anchored characters must be visible, not buried');
  });

  test('C11 · every cinematic is playable through the runtime, in every region it names', () => {
    // The end-to-end claim, and the one that would have caught the original gap: not
    // that the content is valid, but that the running game can film all nine.
    const { game } = bootGame();
    const filmed = [];
    const failed = [];
    for (const cin of CINEMATICS) {
      const res = game.cinematics.play(cin.id);
      if (!res.ok) { failed.push(`${cin.id}:${res.reason}`); continue; }
      let frames = 0;
      while (game.cinematics.active && frames < 6000) { step(game, 1); frames++; }
      if (game.cinematics.active) { failed.push(`${cin.id}:never-ended`); continue; }
      // The scene ends inside a cinematic frame, which drives the camera itself. The
      // gameplay solver only takes back over on the next fixed step, so give it one
      // before judging - otherwise this asserts on a frame that has not happened yet.
      step(game, 4);
      if (game.camera.mode === CameraMode.CINEMATIC) failed.push(`${cin.id}:camera-stuck`);
      else filmed.push({ id: cin.id, frames });
    }
    assert.deepEqual(failed, [], `cinematics that could not be filmed: ${failed.join(', ')}`);
    assert.equal(filmed.length, CINEMATICS.length, 'all nine must be filmable');
    for (const f of filmed) assert.gt(f.frames, 0, `${f.id} ended without a frame`);
  });
});

runAndExit();
