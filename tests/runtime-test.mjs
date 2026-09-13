/**
 * THE BETRAYED WILL — runtime-test.mjs
 *
 * The integration suite for the browser layer: boot, the frame loop, region
 * transitions, and the seam between what is drawn and what is perceived.
 *
 * Everything else in this repository tests the simulation, which is pure and runs
 * anywhere. This suite tests the part that normally only runs in a browser, by
 * injecting a stub renderer and driving the real loop. The WebGL submission is the
 * only thing not covered, and it is the only thing that cannot be.
 *
 * The most important group here is III. A stealth game has one unforgivable failure:
 * a guard who sees the player in what is visibly shadow. That happens when the
 * brightness of the picture and the brightness the AI is told come from different
 * places, and it is invisible in a screenshot and invisible in a unit test. So this
 * suite asserts the seam itself - that the lightLevel handed to the perception system
 * is the one the lighting rig chose for that exact position - and then asserts the
 * behaviour that follows from it.
 *
 * Run: node tests/runtime-test.mjs
 */

import { describe, test, assert, runAndExit, measure } from './harness.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { EventBus, Events } from '../src/core/bus.js';
import { CAM, MOVE, PERF, SAVE, STEALTH } from '../src/core/constants.js';
import { Vec3 } from '../src/core/math.js';
import { Game, FIXED_DT, MAX_FRAME_DT } from '../src/main.js';
import { stubRenderer, bootGame, step } from './game-harness.mjs';
import { LightingRig, TIME_OF_DAY, INTERIOR_DIMMING } from '../src/render/lighting.js';
import { RegionMesh } from '../src/render/region-mesh.js';
import { MaterialLibrary } from '../src/render/materials.js';
import { World } from '../src/sim/world.js';
import { StoryState } from '../src/sim/story-state.js';
import { CLUE_MAP } from '../src/content/story.js';

const CLUE = Object.keys(CLUE_MAP)[0];
import { AIState, effectiveDetectRange, exposureFor, perceptionProbe, noiseAudibility } from '../src/sim/ai.js';
import { REGIONS, REGION_MAP } from '../src/content/world-data.js';
import { MemoryStorage } from '../src/sim/save.js';
import { Conversation, TREE_BY_LANDMARK, muteEvents } from '../src/sim/conversation.js';
import { DialogueWalker } from '../src/sim/dialogue.js';
import { DIALOGUE_TREES, Flags } from '../src/content/dialogue.js';
import { CLUES, MISSIONS } from '../src/content/story.js';

/** The four detection levels index.html has a localized string and a colour for. */
const STRINGS_LEVELS = ['calm', 'suspicious', 'alerted', 'combat'];
import { LANDMARKS } from '../src/content/world-data.js';
import * as THREE from '../vendor/three/three.module.js';

describe('runtime — boot', () => {
  test('I1 · the game boots headlessly inside the declared boot budget', () => {
    const { report } = bootGame();
    assert.ok(report.ok, 'boot must report success');
    assert.lt(report.timings.bootMs, PERF.BOOT_BUDGET_MS,
      `boot took ${report.timings.bootMs.toFixed(0)}ms against ${PERF.BOOT_BUDGET_MS}ms`);
  });

  test('I2 · boot leaves no unresolved problem on a normal start', () => {
    // storage:null is an explicit "no backend", which is a headless caller asking for
    // memory-only saves, so it must not be reported as a problem.
    const { report } = bootGame();
    assert.deepEqual(report.problems, [], `unexpected problems: ${report.problems.join('; ')}`);
  });

  test('I3 · every system the loop depends on exists after boot', () => {
    const { game } = bootGame();
    for (const name of ['world', 'mats', 'scene', 'lighting', 'renderer', 'camera3d',
      'state', 'missions', 'save', 'input', 'playerRig', 'player', 'camera',
      'squad', 'regionMesh', 'space']) {
      assert.ok(game[name], `${name} was not created by boot`);
    }
    assert.ok(game.player.pos instanceof Vec3, 'the player position must be a Vec3');
    assert.ok(game.camera3d.isPerspectiveCamera, 'a Three.js camera must exist');
  });

  test('I4 · the scene holds the region geometry and the player rig', () => {
    const { game } = bootGame();
    const names = [];
    game.scene.traverse((o) => { if (o.name) names.push(o.name); });
    assert.ok(names.some((n) => n.startsWith('region:')), 'the region group must be in the scene');
    assert.ok(names.some((n) => n.startsWith('ground:')), 'the ground must be in the scene');
    assert.ok(names.some((n) => n === 'char:player'), 'the player rig must be in the scene');
    assert.ok(names.some((n) => n.startsWith('solids:')), 'merged solids must be in the scene');
  });

  test('I5 · guards actually spawn in a region with walkable floor', () => {
    // NavGrid reports counts under `stats`, not as a top-level property. Reading the
    // wrong name yields 0, which yields no guards anywhere in the game - a build that
    // boots cleanly, renders correctly, and has no enemies in it at all.
    const { game } = bootGame();
    assert.gt(game.space.nav.stats.walkable, 40, 'the starting region must have walkable floor');
    assert.gt(game.squad.agents.length, 0, 'guards must spawn');
    assert.equal(game.npcRigs.size, game.squad.agents.length, 'every agent needs a rig');
    for (const a of game.squad.agents) {
      assert.ok(Number.isFinite(a.body.pos.x) && Number.isFinite(a.body.pos.z),
        `${a.id} spawned at a non-finite position`);
      assert.ok(game.space.nav.isWalkableAt(a.body.pos.x, a.body.pos.z),
        `${a.id} spawned inside non-walkable geometry`);
    }
  });

  test('I6 · booting is not so slow that a player would notice', () => {
    const ms = measure(() => {
      const g = new Game({ bus: new EventBus(), storage: null, rendererFactory: stubRenderer });
      g.boot();
      g.dispose();
    }, 3, 1);
    assert.lt(ms, PERF.BOOT_BUDGET_MS, `a cold boot averaged ${ms.toFixed(0)}ms`);
  });
});

describe('runtime — the frame loop', () => {
  test('II1 · one rendered frame at 60Hz runs exactly one fixed step', () => {
    const { game } = bootGame();
    const before = game.steps;
    step(game, 1);
    assert.equal(game.steps - before, 1, 'a 17ms frame is one step');
  });

  test('II1b · the very first frame has no previous timestamp and assumes one step', () => {
    // lastNow starts at zero, so frame one cannot compute a delta. Assuming a single
    // fixed step is the safe answer; assuming zero would freeze the opening frame and
    // assuming the wall clock would teleport the player.
    const { game } = bootGame();
    assert.equal(game.lastNow, 0, 'the clock starts unset');
    step(game, 1, 5000);
    assert.equal(game.steps, 1, 'a five-second first frame still simulates one step');
  });

  test('II2 · a long frame runs several steps and catches up', () => {
    const { game } = bootGame();
    const before = game.steps;
    step(game, 1);                       // prime the clock: the first frame has no delta
    const primed = game.steps;
    step(game, 1, 51);
    assert.equal(game.steps - primed, 3, 'three frames of time is three steps');
  });

  test('II3 · a stalled frame cannot spiral into a freeze', () => {
    // Ten seconds in the background must not produce six hundred steps on return.
    const { game } = bootGame();
    const before = game.steps;
    const t0 = game.lastNow || 0;
    game._frame(t0 + 10_000);
    const steps = game.steps - before;
    assert.lte(steps, 5, `a 10s stall ran ${steps} steps; the accumulator must be capped`);
    assert.equal(game.accumulator, 0, 'and the leftover time must be dropped, not carried');
  });

  test('II4 · positions stay finite over a sustained run', () => {
    const { game } = bootGame();
    game.input.handleEvent('keydown', { code: 'KeyW' });
    for (let i = 0; i < 600; i++) {
      step(game, 1);
      const p = game.player.pos;
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z),
        `player position went non-finite at step ${i}`);
      assert.ok(game.player.pos.isFiniteVec(), 'and the vector reports itself finite');
    }
    for (const a of game.squad.agents) {
      assert.ok(a.body.pos.isFiniteVec(), `${a.id} position went non-finite`);
    }
  });

  test('II5 · holding forward moves the player through the real loop', () => {
    const { game } = bootGame();
    const start = { x: game.player.pos.x, z: game.player.pos.z };
    game.input.handleEvent('keydown', { code: 'KeyW' });
    for (let i = 0; i < 90; i++) step(game, 1);
    const moved = Math.hypot(game.player.pos.x - start.x, game.player.pos.z - start.z);
    assert.gt(moved, 0.2, `the player moved ${moved.toFixed(3)}m while holding forward`);
    game.input.handleEvent('keyup', { code: 'KeyW' });
  });

  test('II6 · pausing stops the simulation but keeps the object alive', () => {
    const { game, bus } = bootGame();
    bus.emit(Events.PAUSE, {});
    const before = game.steps;
    step(game, 10);
    assert.equal(game.steps, before, 'a paused game must not simulate');
    bus.emit(Events.RESUME, {});
    step(game, 2);
    assert.equal(game.steps, before + 2, 'and must resume exactly where it left off');
  });

  test('II7 · the Escape binding pauses through the input layer', () => {
    const { game } = bootGame();
    assert.equal(game.paused, false, 'not paused to begin with');
    game.input.handleEvent('keydown', { code: 'Escape' });
    game.input.handleEvent('keyup', { code: 'Escape' });
    step(game, 1);
    assert.equal(game.paused, true, 'Escape must pause');
  });

  test('II8 · the rendered camera is a copy of the simulation camera', () => {
    // The simulation camera resolves collisions, penetration and framing, and has 40
    // tests of its own. The Three.js camera must be exactly where it says, or all of
    // that work is describing a viewpoint the player is not looking from.
    const { game } = bootGame();
    for (let i = 0; i < 20; i++) step(game, 1);
    const c = game.camera;
    const r = game.camera3d;
    assert.close(r.position.x, c.position.x, 1e-9, 'camera X must match');
    assert.close(r.position.y, c.position.y, 1e-9, 'camera Y must match');
    assert.close(r.position.z, c.position.z, 1e-9, 'camera Z must match');
    assert.close(r.fov, c.fov, 1e-6, 'the field of view must match');
    assert.equal(game.renderer.renders, 20, 'one submission per frame');
    assert.ok(game.renderer.lastCamera === game.camera3d, 'the game camera is the one submitted');
  });

  test('II9 · a frame stays inside the render budget for the built geometry', () => {
    const { game } = bootGame();
    const ms = measure(() => step(game, 1), 300, 30);
    assert.lt(ms, PERF.FRAME_BUDGET_MS,
      `a full frame averaged ${ms.toFixed(3)}ms against a ${PERF.FRAME_BUDGET_MS}ms budget`);
  });

  test('II10 · noise from the simulation reaches perception, and decays', () => {
    // The perception truth must carry the noise the movement system reported. Two
    // sources for one fact is how guards end up hearing footsteps nobody made.
    const { game, bus } = bootGame();
    bus.emit(Events.NOISE_EMITTED, { radius: 9.5 });
    step(game, 1);
    assert.close(game.lastTruth.noiseRadius, 9.5, 1e-9, 'the emitted radius must be the one perceived');
    for (let i = 0; i < 60; i++) step(game, 1);
    assert.equal(game.lastTruth.noiseRadius, 0,
      'noise must decay rather than alert the region forever');
  });

  test('II11 · a smaller noise does not overwrite a louder one still sounding', () => {
    const { game, bus } = bootGame();
    bus.emit(Events.NOISE_EMITTED, { radius: 12 });
    bus.emit(Events.NOISE_EMITTED, { radius: 3 });
    step(game, 1);
    assert.close(game.lastTruth.noiseRadius, 12, 1e-9,
      'the peak within the window is what a guard would hear');
  });
});

describe('runtime — what is drawn is what is perceived', () => {
  test('III1 · the lightLevel the AI receives is the one the rig chose', () => {
    const { game } = bootGame();
    for (let i = 0; i < 10; i++) step(game, 1);
    const truth = game.lastTruth;
    assert.ok(truth, 'a perception truth must have been built');
    const p = game.player.pos;
    const expected = game.lighting.lightLevelAt(p.x, p.z).level;
    assert.close(truth.lightLevel, expected, 1e-12,
      'perception and rendering must read the same light at the same position');
  });

  test('III2 · night is darker than day by the declared amounts', () => {
    assert.close(TIME_OF_DAY.night.lightLevel, STEALTH.LIGHT_EXPOSURE_NIGHT, 1e-12,
      'the night preset must use the declared stealth value');
    assert.close(TIME_OF_DAY.day.lightLevel, STEALTH.LIGHT_EXPOSURE_DAY, 1e-12,
      'and so must day');
    assert.lt(TIME_OF_DAY.night.lightLevel, TIME_OF_DAY.day.lightLevel,
      'night must actually be darker');
  });

  test('III3 · every region has a lighting preset, so none falls back silently', () => {
    for (const r of REGIONS) {
      assert.ok(TIME_OF_DAY[r.timeOfDay],
        `${r.id} declares timeOfDay "${r.timeOfDay}", which has no preset`);
    }
  });

  test('III4 · a night region really is harder to be seen in than a day region', () => {
    // The behavioural consequence of III1. If the numbers are right but nothing
    // follows from them, stealth is decoration.
    const night = bootGame({});
    night.game.setRegion(REGIONS.find((r) => r.timeOfDay === 'night').id);
    const day = bootGame({});
    day.game.setRegion(REGIONS.find((r) => r.timeOfDay === 'day').id);

    const levelOf = (g) => {
      step(g, 2);
      assert.ok(g.lastTruth, 'the loop must have built a perception truth');
      return g.lastTruth;
    };
    const n = levelOf(night.game);
    const d = levelOf(day.game);
    assert.lt(n.lightLevel, d.lightLevel, 'night exposure must be lower');

    const rangeN = effectiveDetectRange(exposureFor({
      lightLevel: n.lightLevel, stance: 'stand', speed: 0, isNight: n.isNight,
    }), n.isNight);
    const rangeD = effectiveDetectRange(exposureFor({
      lightLevel: d.lightLevel, stance: 'stand', speed: 0, isNight: d.isNight,
    }), d.isNight);
    assert.lt(rangeN, rangeD,
      `a guard sees ${rangeN.toFixed(1)}m at night and ${rangeD.toFixed(1)}m by day`);
    assert.gt(rangeN, STEALTH.DETECT_RANGE_MIN * 0.5, 'and night must not mean blind');
  });

  test('III5 · standing in firelight raises exposure toward the torch value', () => {
    const { game } = bootGame();
    // Find a region with a hearth or torch and stand in it.
    let target = null;
    for (const r of REGIONS) {
      const space = game.world.region(r.id);
      const fire = (space.props ?? []).find((p) => p.kind === 'fire' || p.kind === 'flame');
      if (fire) { target = { region: r.id, fire }; break; }
    }
    assert.ok(target, 'some region must contain a fire to test against');
    game.setRegion(target.region);
    const fires = LightingRig.firesFrom(game.regionMesh);
    assert.gt(fires.length, 0, 'fires must be collected for the exposure model');

    const open = game.lighting.lightLevelAt(0, 0).level;
    const atFire = game.lighting.lightLevelAt(target.fire.x, target.fire.z);
    assert.gt(atFire.level, open, 'firelight must make the player more visible');
    assert.ok(atFire.nearFire, 'and must report that the player is in the light');
    assert.lte(atFire.level, STEALTH.LIGHT_EXPOSURE_TORCH + 1e-9,
      'never brighter than the declared torch value');
  });

  test('III6 · an interior is dimmer than the same hour outdoors', () => {
    const indoor = REGION_MAP['palace-hall'];
    const rig = new LightingRig(new THREE.Scene(), { shadows: false });
    rig.apply(indoor, { weather: 'clear', fires: [] });
    const inside = rig.lightLevelAt(0, 0).level;
    const outside = indoor.timeOfDay === 'night'
      ? TIME_OF_DAY.night.lightLevel
      : TIME_OF_DAY[indoor.timeOfDay].lightLevel;
    assert.close(inside, outside * INTERIOR_DIMMING, 1e-9,
      'interior dimming must be the declared fraction');
    assert.lt(inside, outside, 'and an interior must be darker');
  });

  test('III7 · weather multiplies exposure by the declared factor', () => {
    const rig = new LightingRig(new THREE.Scene(), { shadows: false });
    const region = REGION_MAP['palace-court'];
    rig.apply(region, { weather: 'clear', fires: [] });
    const clear = rig.lightLevelAt(0, 0).level;
    for (const [weather, factor] of Object.entries(STEALTH.WEATHER_EXPOSURE)) {
      rig.apply(region, { weather: weather, fires: [] });
      const got = rig.lightLevelAt(0, 0).level;
      assert.close(got, clear * factor, 1e-9,
        `${weather} must scale exposure by the declared ${factor}`);
    }
  });

  test('III8 · an unknown weather name cannot corrupt exposure', () => {
    const { game } = bootGame();
    assert.equal(game.setWeather('apocalypse'), false, 'an undeclared weather must be refused');
    assert.equal(game.weather, 'clear', 'and must leave the current weather alone');
    assert.ok(game.setWeather('storm'), 'a declared one is accepted');
  });

  test('III9 · a guard cannot see a player who is out of range, and can when close', () => {
    // The fairness invariant end to end: with the game's own truth, perception must
    // fail at distance and succeed nearby, rather than being omnipresent.
    const { game } = bootGame();
    game.setRegion(REGIONS.find((r) => r.timeOfDay === 'night').id);
    const agent = game.squad.agents[0];
    assert.ok(agent, 'a guard is needed to test perception');

    step(game, 2);
    const truth = game.lastTruth;
    const ap = agent.body.pos;

    const far = { ...truth, playerPos: new Vec3(ap.x + 60, ap.y, ap.z + 60) };
    const near = { ...truth, playerPos: new Vec3(ap.x + 1.5, ap.y, ap.z) };
    // Facing the agent, so the cone is not what makes the difference.
    const probeFar = perceptionProbe(agent, far, { losFallback: true });
    const probeNear = perceptionProbe(agent, near, { losFallback: true });
    assert.equal(probeFar.inRange, false, 'a player 60m away at night must not be seen');
    assert.ok(probeNear.inRange || probeNear.cone === 0,
      'a player at 1.5m is in range unless genuinely outside the view cone');
  });

  test('III10 · crouching in the dark is meaningfully harder to see than sprinting in day', () => {
    const crouched = exposureFor({
      lightLevel: TIME_OF_DAY.night.lightLevel, stance: 'crouch', speed: 0, isNight: true,
    });
    const sprinting = exposureFor({
      lightLevel: TIME_OF_DAY.day.lightLevel, stance: 'stand', speed: MOVE.SPRINT_SPEED, isNight: false,
    });
    assert.lt(crouched, sprinting * 0.5,
      `crouched at night ${crouched.toFixed(3)} vs sprinting by day ${sprinting.toFixed(3)}`);
    assert.gt(crouched, 0, 'but never literally invisible');
  });
});

describe('runtime — regions and transitions', () => {
  test('IV1 · travelling to a region rebuilds it and disposes the old one', () => {
    const { game } = bootGame();
    const oldMesh = game.regionMesh;
    let disposed = false;
    oldMesh.dispose = () => { disposed = true; };
    const target = game.space.doors[0]?.toRegion;
    assert.ok(target, 'the starting region must have a door to travel through');
    game.travelTo(target);
    assert.equal(game.regionId, target, 'the region changed');
    assert.ok(disposed, 'the previous region mesh must be disposed, not leaked');
    assert.notEqual(game.regionMesh, oldMesh, 'and a new one built');
    assert.ok(game.scene.children.includes(game.regionMesh.group), 'in the scene');
    assert.ok(!game.scene.children.includes(oldMesh.group), 'with the old one removed');
  });

  test('IV2 · arriving through a door puts the player at the door back', () => {
    const { game } = bootGame();
    const from = game.regionId;
    const target = game.space.doors[0].toRegion;
    game.travelTo(target);
    const back = game.world.region(target).doorTo(from);
    assert.ok(back, 'the destination must have a door leading back');
    const p = game.player.pos;
    const d = Math.hypot(p.x - back.spawn.x, p.z - back.spawn.z);
    assert.lt(d, 1.0,
      `the player arrived ${d.toFixed(2)}m from the return door; they must be able to turn around and leave`);
  });

  test('IV3 · lighting follows the region', () => {
    const { game } = bootGame();
    const night = REGIONS.find((r) => r.timeOfDay === 'night');
    game.setRegion(night.id);
    assert.equal(game.lighting.applied.timeOfDay, 'night', 'the preset must follow the region');
    assert.equal(game.lighting.isNight, true, 'and report night');
    const day = REGIONS.find((r) => r.timeOfDay === 'day');
    game.setRegion(day.id);
    assert.equal(game.lighting.isNight, false, 'and day');
  });

  test('IV4 · every region can be entered and meshed without error', () => {
    const { game } = bootGame();
    for (const r of REGIONS) {
      let err = null;
      try { game.setRegion(r.id); step(game, 2); } catch (e) { err = e; }
      assert.ok(!err, `${r.id} failed to enter: ${err?.message ?? err}`);
      assert.ok(game.player.pos.isFiniteVec(), `${r.id} put the player at a non-finite position`);
      assert.equal(game.regionId, r.id, `${r.id} is now current`);
    }
  });

  test('IV5 · no region exceeds the declared draw-call budget', () => {
    const mats = new MaterialLibrary({ textures: false });
    const world = new World({ seed: 'mesopotamia' });
    let worst = 0;
    let worstId = null;
    for (const r of REGIONS) {
      const mesh = new RegionMesh(world.region(r.id), mats);
      let calls = 0;
      mesh.group.traverse((o) => { if (o.isMesh) calls++; });
      if (calls > worst) { worst = calls; worstId = r.id; }
      mesh.dispose();
    }
    assert.lte(worst, PERF.MAX_DRAW_CALLS,
      `${worstId} needs ${worst} draw calls against a budget of ${PERF.MAX_DRAW_CALLS}`);
  });

  test('IV6 · a prompt is published when the player stands at a doorway', () => {
    const { game, bus } = bootGame();
    const prompts = [];
    bus.on(Events.PROMPT, (p) => prompts.push(p));
    const door = game.space.doors[0];
    assert.ok(door, 'a door is needed');
    game.player.setPosition(door.world.x, game.space.heightAt(door.world.x, door.world.z), door.world.z);
    step(game, 2);
    assert.gt(prompts.length, 0, 'standing at a door must produce a prompt');
    const last = prompts[prompts.length - 1];
    assert.equal(last.kind, 'door', 'and must be a door prompt');
    assert.ok(last.label, 'with a label the player can read');
  });

  test('IV7 · the prompt is not re-emitted every frame', () => {
    // A HUD that rewrites its text sixty times a second for text that has not
    // changed is a stutter caused entirely by the interface.
    const { game, bus } = bootGame();
    let count = 0;
    bus.on(Events.PROMPT, () => count++);
    const door = game.space.doors[0];
    game.player.setPosition(door.world.x, game.space.heightAt(door.world.x, door.world.z), door.world.z);
    step(game, 1);
    const afterFirst = count;
    step(game, 60);
    assert.equal(count, afterFirst, 'an unchanged prompt must not be re-emitted');
  });
});

describe('runtime — saves, language and teardown', () => {
  test('V1 · the game saves and loads through its own save system', () => {
    const { game } = bootGame();
    step(game, 30);
    game.missions.state.playtimeMs = 4242;
    game.missions.state.clues.add(CLUE);
    const res = game.saveTo(0);
    assert.ok(res.ok, `save failed: ${res.reason}`);
    game.missions.state.playtimeMs = 1;
    const loaded = game.loadFrom(0);
    assert.ok(loaded.ok, `load failed: ${loaded.reason}`);
    assert.equal(game.missions.state.playtimeMs, 4242, 'progress must come back');
  });

  test('V2 · autosave is wired to the game’s own state', () => {
    const { game, bus } = bootGame();
    bus.emit(Events.CHAPTER_START, {});
    assert.ok(game.save.has(SAVE.AUTOSAVE_SLOT), 'a chapter start must autosave');
    const loaded = game.save.load(SAVE.AUTOSAVE_SLOT);
    assert.ok(loaded.ok, 'and the autosave must be readable');
  });

  test('V3 · language switching reaches the state and the bus', () => {
    const { game, bus } = bootGame();
    const seen = [];
    bus.on(Events.LANGUAGE_CHANGED, (p) => seen.push(p.language));
    game.setLanguage('en');
    assert.equal(game.language, 'en');
    assert.equal(game.state.language, 'en', 'the story state must follow');
    game.setLanguage('ar');
    assert.deepEqual(seen, ['en', 'ar'], 'both changes must be announced');
    game.setLanguage('klingon');
    assert.equal(game.language, 'ar', 'an unsupported language must not be accepted');
  });

  test('V4 · teardown releases everything it created', () => {
    const { game } = bootGame();
    const meshDispose = [];
    game.regionMesh.dispose = () => meshDispose.push('region');
    const rigDispose = [];
    game.playerRig.dispose = () => rigDispose.push('player');
    game.lighting.dispose = () => rigDispose.push('lighting');
    game.mats.dispose = () => rigDispose.push('materials');
    game.dispose();
    assert.equal(game.running, false, 'the loop must stop');
    assert.ok(game.renderer.disposed, 'the renderer must be disposed');
    assert.deepEqual(meshDispose, ['region'], 'the region mesh must be disposed');
    assert.includes(rigDispose, 'player', 'the player rig');
    assert.includes(rigDispose, 'lighting', 'the lighting rig');
    assert.includes(rigDispose, 'materials', 'the material library');
  });

  test('V5 · a boot with no storage says so instead of failing later', () => {
    const game = new Game({ bus: new EventBus(), storage: null, rendererFactory: stubRenderer });
    const report = game.boot();
    assert.ok(report.problems.some((p) => /storage/i.test(p)),
      'the player must be told progress will not survive the session');
    assert.equal(game.save.volatile, true, 'and the save system must agree');
    assert.ok(game.saveTo(0).ok, 'saving must still work in memory');
    game.dispose();
  });

  test('V6 · diagnostics describe a live game without throwing', () => {
    const { game } = bootGame();
    step(game, 5);
    let d = null;
    assert.doesNotThrow(() => { d = game.diagnostics(); });
    assert.equal(d.region, 'palace-court', 'the region is named');
    assert.ok(d.lighting.lightLevel >= 0 && d.lighting.lightLevel <= 1, 'exposure is in range');
    assert.ok(Number.isFinite(d.player.x), 'the player position is reported');
    assert.ok(d.render.maxDrawCalls === PERF.MAX_DRAW_CALLS, 'the budget is reported');
  });
});

/* -------------------------------------------------------------------------
 * VI — conversation and interaction.
 *
 * This group exists because the dialogue system was complete, tested and
 * unreachable: DialogueWalker had its own coverage, index.html listened for
 * subtitles, and nothing in the runtime ever created a walker. Fourteen trees
 * nobody could open and every DIALOGUE objective impossible to complete, in a
 * build that boots cleanly and renders correctly. The gap was invisible to every
 * existing suite because each of them tested a layer that worked.
 * ---------------------------------------------------------------------- */
describe('runtime — conversation and interaction', () => {
  /** A state holding everything, so gated branches are open. */
  function enrich(state) {
    for (const c of CLUES) state.grantClue(c.id);
    for (const f of Object.values(Flags)) state.setFlag(f, 'mission');
    return state;
  }

  /** Drive a conversation to its end the way a player would. */
  function playThrough(game, maxTurns = 400) {
    let turns = 0;
    while (game.conversation.active && turns < maxTurns) {
      game.conversation.update(0.4);          // let each line finish
      const view = game.conversation.view();
      if (!view) break;
      if (!view.readyForInput) { game.conversation.update(0.4); continue; }
      const open = view.choices.filter((c) => c.available);
      if (open.length) game.conversation.choose(open[0].index);
      else game.conversation.skipOrAdvance();
      turns++;
    }
    return turns;
  }

  test('VI1 · boot creates the walker and the conversation driver', () => {
    const { game } = bootGame();
    assert.ok(game.walker instanceof DialogueWalker, 'a DialogueWalker must exist');
    assert.ok(game.conversation instanceof Conversation, 'a Conversation driver must exist');
    assert.equal(game.conversation.active, false, 'no scene is open at boot');
    assert.equal(game.conversation.state, game.missions.state,
      'the driver must share the mission state, not a copy of it');
  });

  test('VI2 · every dialogue landmark resolves to a real tree', () => {
    // Fourteen landmarks declare interact:"dialogue" and there are fourteen trees.
    // A landmark with no tree is a face the player can talk to that says nothing.
    const dialogueLandmarks = LANDMARKS.filter((l) => l.interact === 'dialogue');
    assert.equal(dialogueLandmarks.length, DIALOGUE_TREES.length,
      'the dialogue landmarks and the trees should be the same count');
    for (const lm of dialogueLandmarks) {
      const treeId = TREE_BY_LANDMARK[lm.id];
      assert.ok(treeId, `landmark "${lm.id}" offers dialogue but no tree is bound to it`);
      assert.ok(DIALOGUE_TREES.some((t) => t.id === treeId), `"${treeId}" is not a real tree`);
    }
    for (const tree of DIALOGUE_TREES) {
      assert.ok(TREE_BY_LANDMARK[tree.landmark],
        `tree "${tree.id}" names landmark "${tree.landmark}", which does not point back`);
    }
  });

  test('VI3 · walking up to a speaker and pressing interact opens the scene', () => {
    const { game } = bootGame();
    const lm = LANDMARKS.find((l) => l.interact === 'dialogue' && l.region === game.regionId);
    const target = lm ?? LANDMARKS.find((l) => l.interact === 'dialogue');
    if (lm) {
      assert.ok(game.space.interactables.some((i) => i.id === lm.id),
        'a dialogue landmark in this region must be interactable');
    } else {
      game.setRegion(target.region);
    }
    const it = game.space.interactables.find((i) => i.kind === 'dialogue');
    assert.ok(it, 'the region must contain a dialogue interactable');
    enrich(game.missions.state);
    game.player.setPosition(it.x, game.space.heightAt(it.x, it.z), it.z);
    game.input.handleEvent('keydown', { code: 'KeyE' });
    step(game, 1);
    assert.equal(game.conversation.active, true, 'interact must open the conversation');
    assert.equal(game.conversation.treeId, TREE_BY_LANDMARK[it.id], 'and it must be that landmark’s tree');
    game.input.handleEvent('keyup', { code: 'KeyE' });
  });

  test('VI4 · an open conversation stops the world but not the scene clock', () => {
    const { game } = bootGame();
    enrich(game.missions.state);
    const treeId = DIALOGUE_TREES[0].id;
    assert.ok(game.conversation.start(treeId).ok, 'the scene must open');
    const stepsBefore = game.steps;
    const playerBefore = { ...game.player.pos };
    game.input.handleEvent('keydown', { code: 'KeyW' });
    step(game, 30);
    assert.equal(game.steps, stepsBefore, 'the simulation must not advance during a scene');
    assert.close(game.player.pos.x, playerBefore.x, 1e-9, 'and the player must not walk off mid-line');
    assert.close(game.player.pos.z, playerBefore.z, 1e-9, 'in any direction');
    assert.gt(game.conversation.stats.linesShown, 0, 'but the scene itself must keep running');
    game.input.handleEvent('keyup', { code: 'KeyW' });
  });

  test('VI5 · each line is published as a subtitle with a reading time', () => {
    const { game, bus } = bootGame();
    const subs = [];
    bus.on(Events.SUBTITLE, (p) => subs.push(p));
    enrich(game.missions.state);
    game.conversation.start(DIALOGUE_TREES[0].id);
    assert.gt(subs.length, 0, 'opening a scene must publish its first line');
    const first = subs[0];
    assert.ok(first.text && first.text.length > 0, 'the line must have text');
    assert.gt(first.ms, 0, 'and a reading time');
    assert.equal(first.index, 0, 'numbered from the first line');
    assert.equal(first.total, subs[0].total, 'with the total announced');
    assert.ok(first.speaker !== undefined, 'and a speaker, so the HUD can name them');
  });

  test('VI6 · pressing through advances one line at a time', () => {
    // A scene that can be skipped instantly is a scene whose writing was never read.
    const { game, bus } = bootGame();
    const subs = [];
    bus.on(Events.SUBTITLE, (p) => subs.push(p));
    enrich(game.missions.state);
    game.conversation.start(DIALOGUE_TREES[0].id);
    const view = game.conversation.view();
    if (view.lineCount > 1) {
      const shown = subs.length;
      game.conversation.skipOrAdvance();
      assert.equal(subs.length, shown + 1, 'one press shows exactly one more line');
      assert.equal(game.conversation.active, true, 'and the scene is still open');
    }
    assert.ok(view.linesDone === false || view.lineCount === 1, 'lines are not all shown at once');
  });

  test('VI7 · a node offering choices cannot be advanced past by mashing', () => {
    const { game } = bootGame();
    enrich(game.missions.state);
    // Find a tree whose entry node has choices, which most of them do.
    const tree = DIALOGUE_TREES.find((t) => (t.nodes[t.entry].choices ?? []).length > 0);
    assert.ok(tree, 'a tree with a choice at its entry is needed');
    game.conversation.start(tree.id);
    for (let i = 0; i < 20; i++) {
      game.conversation.update(0.5);
      if (game.conversation.readyForInput) break;
    }
    const res = game.conversation.skipOrAdvance();
    assert.equal(res.ok, false, 'mashing must not skip the choice');
    assert.equal(res.reason, 'awaiting-choice', 'and must say why');
    assert.equal(game.conversation.active, true, 'the scene stays open');
  });

  test('VI8 · an available choice moves the scene and is recorded', () => {
    const { game } = bootGame();
    const state = enrich(game.missions.state);
    const tree = DIALOGUE_TREES.find((t) => (t.nodes[t.entry].choices ?? []).length > 0);
    game.conversation.start(tree.id);
    for (let i = 0; i < 20; i++) { game.conversation.update(0.5); if (game.conversation.readyForInput) break; }
    const before = state.choicesTaken.size;
    const res = game.conversation.choose(0);
    assert.ok(res.ok, `the first choice must be takeable: ${res.reason}`);
    assert.gt(state.choicesTaken.size, before, 'and must be recorded in the story state');
    assert.equal(game.conversation.stats.choices, 1, 'and counted');
  });

  test('VI9 · a choice taken before its beat is refused, not swallowed', () => {
    const { game } = bootGame();
    enrich(game.missions.state);
    const tree = DIALOGUE_TREES.find((t) => (t.nodes[t.entry].choices ?? []).length > 0);
    game.conversation.start(tree.id);
    // No update() calls: the lines have not run and the beat has not elapsed.
    const res = game.conversation.choose(0);
    assert.equal(res.ok, false, 'a choice taken before the node is ready must be refused');
    assert.equal(res.reason, 'not-ready', 'with a reason the UI can act on');
  });

  test('VI10 · a locked choice is refused and applies nothing', () => {
    const { game } = bootGame();
    // A bare state this time: the gated branch must actually be gated.
    const tree = DIALOGUE_TREES.find((t) =>
      (t.nodes[t.entry].choices ?? []).some((c) => c.requires?.clues?.length));
    assert.ok(tree, 'a tree with a clue-gated entry choice is needed');
    const gate = tree.nodes[tree.entry].choices.findIndex((c) => c.requires?.clues?.length);
    const started = game.conversation.start(tree.id);
    assert.ok(started.ok, `the scene must open even with a gated choice: ${started.reason}`);
    for (let i = 0; i < 20; i++) { game.conversation.update(0.5); if (game.conversation.readyForInput) break; }
    const view = game.conversation.view();
    assert.equal(view.choices[gate].available, false, 'the gated choice must show as locked');
    assert.ok(view.choices[gate].lockedReason, 'and must say what unlocks it');
    const res = game.conversation.choose(gate);
    assert.equal(res.ok, false, 'a locked choice must be refused');
    assert.equal(res.reason, 'locked');
  });

  test('VI11 · finishing a scene tells the mission system exactly once', () => {
    const { game } = bootGame();
    enrich(game.missions.state);
    const notified = [];
    const real = game.missions.notify.bind(game.missions);
    game.missions.notify = (e) => { if (e?.kind === 'dialogue') notified.push(e.id); return real(e); };
    const treeId = DIALOGUE_TREES[0].id;
    game.conversation.start(treeId);
    playThrough(game);
    assert.equal(game.conversation.active, false, 'the scene must have ended');
    assert.deepEqual(notified, [treeId], `expected exactly one notification, got ${notified.length}`);
    assert.equal(game.conversation.stats.completed, 1, 'and counted as completed');
  });

  test('VI12 · walking away mid-scene does not complete the objective', () => {
    const { game } = bootGame();
    enrich(game.missions.state);
    const notified = [];
    const real = game.missions.notify.bind(game.missions);
    game.missions.notify = (e) => { if (e?.kind === 'dialogue') notified.push(e.id); return real(e); };
    game.conversation.start(DIALOGUE_TREES[0].id);
    const res = game.conversation.leave();
    assert.ok(res.ok, 'leaving must always be allowed');
    assert.equal(res.reason, 'left');
    assert.equal(notified.length, 0, 'an abandoned scene must not count as finished');
    assert.equal(game.conversation.stats.left, 1, 'and is recorded as left');
    assert.equal(game.conversation.active, false, 'the scene is closed');
  });

  test('VI13 · all fourteen trees can be opened and finished through the runtime', () => {
    // The strongest available claim: not that the trees are valid - run-deep proves
    // that - but that a player driving the real Conversation driver can complete
    // every one of them. This is the test that would have caught the unwired walker.
    const { game } = bootGame();
    enrich(game.missions.state);
    const completed = [];
    const refused = [];
    for (const tree of DIALOGUE_TREES) {
      const res = game.conversation.start(tree.id);
      if (!res.ok) { refused.push(`${tree.id}:${res.reason}`); continue; }
      const turns = playThrough(game, 600);
      if (game.conversation.active) refused.push(`${tree.id}:stuck-after-${turns}`);
      else completed.push(tree.id);
    }
    assert.deepEqual(refused, [], `trees that could not be completed: ${refused.join(', ')}`);
    assert.equal(completed.length, DIALOGUE_TREES.length, 'every tree must be completable');
    assert.equal(game.conversation.stats.completed, DIALOGUE_TREES.length, 'and each counted once');
  });

  test('VI14 · a scene the player cannot finish is refused before it opens', () => {
    const { game } = bootGame();
    // Bare state: no clues, no flags. A tree gated on a clue cannot be finished, so
    // opening it would trap the player in a conversation with no exit.
    const gated = DIALOGUE_TREES.find((t) => {
      const w = new DialogueWalker({ bus: new EventBus() });
      return w.begin(t.id, game.missions.state).reason === 'trapped';
    });
    if (!gated) return;   // no tree is currently gated from a cold start
    const res = game.conversation.start(gated.id);
    assert.equal(res.ok, false, 'a trapped scene must be refused');
    assert.equal(res.reason, 'trapped', 'and must say it is trapped, not unknown');
    assert.equal(game.conversation.active, false, 'and must not open');
  });

  test('VI15 · examining a landmark completes the objective that asked for it', () => {
    const { game } = bootGame();
    const mission = MISSIONS.find((m) =>
      m.objectives.some((o) => o.type === 'examine'));
    assert.ok(mission, 'a mission with an examine objective is needed');
    const objective = mission.objectives.find((o) => o.type === 'examine');
    game.missions.startChapter(mission.chapter);
    game.missions.startMission(mission.id);
    game._actOn({ id: objective.target, kind: 'examine' });
    assert.ok(game.missions.state.isObjectiveDone(mission.id, objective.id),
      `examining ${objective.target} must complete ${mission.id}/${objective.id}`);
  });

  test('VI16 · a clue landmark grants the clue bound to it in the content', () => {
    const { game } = bootGame();
    const clue = CLUES[0];
    game._actOn({ id: clue.landmark, kind: 'clue' });
    assert.ok(game.missions.state.hasClue(clue.id),
      `${clue.landmark} must grant ${clue.id}`);
    // And it must not grant a different clue for the same landmark.
    const others = CLUES.filter((c) => c.id !== clue.id);
    const wronglyGranted = others.filter((c) => game.missions.state.hasClue(c.id));
    assert.equal(wronglyGranted.length, 0,
      `a clue landmark granted unrelated clues: ${wronglyGranted.map((c) => c.id).join(', ')}`);
  });

  test('VI17 · a clue-flavored landmark with no clue behind it is answered, not raised', () => {
    // Sixteen landmarks offer a clue interaction; ten clues exist. My first version of
    // this test demanded one clue per landmark and failed, and the failure was worth
    // keeping: the runtime was emitting an ERROR event for each of the six unbound
    // landmarks, so a player inspecting a hearth or a roadside stele would have seen a
    // developer error on screen. The content was fine. The handler was not. Now an
    // unbound landmark is examined: the player asks, the game says nothing is there.
    const bound = new Set(CLUES.map((c) => c.landmark));
    const unbound = LANDMARKS.filter((l) => l.interact === 'clue' && !bound.has(l.id));
    assert.equal(unbound.length, 6, 'the content has six clue-flavored landmarks with no clue');

    const { game, bus } = bootGame();
    const errors = [];
    const notified = [];
    bus.on(Events.ERROR, (e) => errors.push(e));
    const real = game.missions.notify.bind(game.missions);
    game.missions.notify = (e) => { notified.push(e); return real(e); };

    for (const lm of unbound) {
      const cluesBefore = game.missions.state.clues.length;
      game._actOn({ id: lm.id, kind: lm.interact });
      assert.equal(game.missions.state.clues.length, cluesBefore,
        `${lm.id} must not invent a clue`);
      assert.ok(notified.some((e) => e.kind === 'examine' && e.id === lm.id),
        `${lm.id} must still notify an examine, so an objective can count it`);
    }
    assert.deepEqual(errors.map((e) => e.message), [],
      'inspecting an ordinary landmark must never surface an error to the player');
  });

  test('VI17b · the walker’s batch subtitles are muted while the driver times them', () => {
    // The walker publishes every line of a node the moment it enters it. The driver
    // publishes them one at a time. Left alone the HUD would be handed the whole
    // scene instantly and then the same scene again, line by line.
    const { game, bus } = bootGame();
    const subs = [];
    bus.on(Events.SUBTITLE, (p) => subs.push(p));
    enrich(game.missions.state);
    const tree = DIALOGUE_TREES[0];
    const node = tree.nodes[tree.entry];
    const lineCount = (node.lines ?? []).length;
    game.conversation.start(tree.id);
    assert.equal(subs.length, Math.min(1, lineCount),
      'opening a scene publishes the first line only, never the whole node');
    for (const s of subs) {
      assert.equal(s.index !== undefined, true, 'every subtitle must be positioned');
      assert.equal(s.source, 'dialogue', 'and attributed');
    }
    // Scene events that are not subtitles must still reach the HUD.
    assert.ok(game.conversation.stats.started >= 1, 'the scene opened');
  });

  test('VI18 · a search landmark notifies a search, which is what the objective counts', () => {
    const { game } = bootGame();
    const notified = [];
    const real = game.missions.notify.bind(game.missions);
    game.missions.notify = (e) => { notified.push(e); return real(e); };
    const lm = LANDMARKS.find((l) => l.interact === 'search');
    game._actOn({ id: lm.id, kind: 'search' });
    assert.ok(notified.some((e) => e.kind === 'search' && e.id === lm.id),
      'a search event must be sent for the landmark');
    assert.ok(notified.some((e) => e.kind === 'landmark' && e.id === lm.id),
      'and a landmark event, so GOTO objectives also see the arrival');
  });

  test('VI19 · the prompt names the right verb for each interact kind', () => {
    const { game, bus } = bootGame();
    const prompts = [];
    bus.on(Events.PROMPT, (p) => prompts.push(p));
    const lm = LANDMARKS.find((l) => l.interact === 'dialogue' && l.region === game.regionId)
      ?? LANDMARKS.find((l) => l.interact === 'examine');
    if (lm.region !== game.regionId) game.setRegion(lm.region);
    const it = game.space.interactables.find((i) => i.id === lm.id);
    if (!it) return;
    game.player.setPosition(it.x, game.space.heightAt(it.x, it.z), it.z);
    step(game, 2);
    const last = prompts[prompts.length - 1];
    assert.ok(last, 'a prompt must be published at the landmark');
    assert.ok(last.action && last.action.length > 0, 'with an action verb');
    assert.ok(last.label && last.label.length > 0, 'and the landmark’s name');
    game.setLanguage('en');
    game.prompt = null;
    step(game, 2);
    const en = prompts[prompts.length - 1];
    assert.ok(en, 'the prompt must be republished after a language change');
    assert.notEqual(en.action, last.action, 'and the verb must actually change');
  });

  test('VI20 · Escape leaves a conversation instead of opening the pause menu', () => {
    const { game } = bootGame();
    enrich(game.missions.state);
    game.conversation.start(DIALOGUE_TREES[0].id);
    assert.equal(game.conversation.active, true);
    game.input.handleEvent('keydown', { code: 'Escape' });
    game.input.handleEvent('keyup', { code: 'Escape' });
    step(game, 1);
    assert.equal(game.conversation.active, false, 'the scene must close');
    assert.equal(game.paused, false, 'and the pause menu must not open over it');
  });

  test('VI21 · the driver is reusable: a second scene opens after the first ends', () => {
    const { game } = bootGame();
    enrich(game.missions.state);
    game.conversation.start(DIALOGUE_TREES[0].id);
    playThrough(game);
    assert.equal(game.conversation.active, false, 'the first scene ended');
    const res = game.conversation.start(DIALOGUE_TREES[1].id);
    assert.ok(res.ok, `a second scene must open: ${res.reason}`);
    assert.equal(game.conversation.treeId, DIALOGUE_TREES[1].id);
  });

  test('VI22 · opening a scene while one is open is refused, not nested', () => {
    const { game } = bootGame();
    enrich(game.missions.state);
    game.conversation.start(DIALOGUE_TREES[0].id);
    const res = game.conversation.start(DIALOGUE_TREES[1].id);
    assert.equal(res.ok, false, 'two scenes at once must be refused');
    assert.equal(res.reason, 'busy');
    assert.equal(game.conversation.treeId, DIALOGUE_TREES[0].id, 'and the first is untouched');
  });

  test('VI22b · muteEvents forwards everything it was not asked to swallow', () => {
    const bus = new EventBus();
    const seen = [];
    bus.on(Events.SUBTITLE, () => seen.push('subtitle'));
    bus.on(Events.DIALOGUE_START, () => seen.push('start'));
    const muted = muteEvents(bus, [Events.SUBTITLE]);
    muted.emit(Events.SUBTITLE, { text: 'x' });
    muted.emit(Events.DIALOGUE_START, { treeId: 't' });
    assert.deepEqual(seen, ['start'], 'only the named events are dropped');
    assert.equal(muted.raw, bus, 'and the underlying bus stays reachable');
  });

  test('VI22c · choices are published once, after the beat, with their locks intact', () => {
    // The HUD draws from this event and never polls the graph, so the event has to
    // be right: once per node, not once per frame, and not before the beat ends or a
    // player mashing through lines selects the first reply without seeing it.
    const { game, bus } = bootGame();
    const published = [];
    bus.on(Events.DIALOGUE_CHOICES, (p) => published.push(p));
    enrich(game.missions.state);
    const tree = DIALOGUE_TREES.find((t2) => (t2.nodes[t2.entry].choices ?? []).length > 1);
    assert.ok(tree, 'a tree with several entry choices is needed');
    game.conversation.start(tree.id);
    assert.equal(published.length, 0, 'nothing is offered while the lines are still running');
    for (let i = 0; i < 40 && published.length === 0; i++) game.conversation.update(0.2);
    assert.equal(published.length, 1, 'and exactly one offer once the beat has elapsed');
    for (let i = 0; i < 10; i++) game.conversation.update(0.2);
    assert.equal(published.length, 1, 'further frames must not republish the same node');
    const payload = published[0];
    assert.equal(payload.treeId, tree.id);
    assert.ok(payload.speaker, 'the speaker is named, so the panel can show who is talking');
    assert.equal(payload.choices.length, (tree.nodes[tree.entry].choices ?? []).length,
      'every choice on the node is offered');
    for (const c of payload.choices) {
      assert.ok(c.text && c.text.length > 0, 'each choice has readable text');
      assert.equal(typeof c.available, 'boolean', 'and says whether it can be taken');
      assert.equal(Number.isInteger(c.index), true, 'and is numbered');
    }
  });

  test('VI22d · a node with no choices still publishes, so the buttons come away', () => {
    // If only nodes with choices published, a panel of buttons would survive into the
    // next node and the player would be answering a question nobody asked.
    const { game, bus } = bootGame();
    const published = [];
    bus.on(Events.DIALOGUE_CHOICES, (p) => published.push(p));
    enrich(game.missions.state);
    const tree = DIALOGUE_TREES.find((t2) => (t2.nodes[t2.entry].choices ?? []).length === 0);
    if (!tree) return;
    game.conversation.start(tree.id);
    for (let i = 0; i < 40 && published.length === 0; i++) game.conversation.update(0.2);
    assert.equal(published.length, 1, 'the node must publish');
    assert.deepEqual(published[0].choices, [], 'with an empty list');
  });

  test('VI22e · every tree publishes choices the player can actually take', () => {
    // Across all fourteen trees, walking each to the end: no node may offer only
    // locked choices, which would strand the player mid-conversation with nothing
    // to press and no way out but walking away.
    const { game } = bootGame();
    enrich(game.missions.state);
    const stranded = [];
    for (const tree of DIALOGUE_TREES) {
      if (!game.conversation.start(tree.id).ok) continue;
      let guard = 0;
      while (game.conversation.active && guard++ < 600) {
        game.conversation.update(0.4);
        if (!game.conversation.readyForInput) continue;
        const v = game.conversation.view();
        const choices = v?.choices ?? [];
        if (choices.length && !choices.some((c) => c.available)) {
          stranded.push(`${tree.id}@${v.nodeId}`);
          break;
        }
        if (choices.length) game.conversation.choose(choices.find((c) => c.available).index);
        else game.conversation.skipOrAdvance();
      }
    }
    assert.deepEqual(stranded, [], `nodes offering only locked choices: ${stranded.join(', ')}`);
  });

  test('VI23 · a language change re-localizes the line on screen', () => {
    const { game, bus } = bootGame();
    const subs = [];
    bus.on(Events.SUBTITLE, (p) => subs.push(p));
    enrich(game.missions.state);
    game.conversation.start(DIALOGUE_TREES[0].id);
    const arLine = subs[subs.length - 1].text;
    game.setLanguage('en');
    const enLine = subs[subs.length - 1].text;
    assert.notEqual(enLine, arLine, 'the same line must be re-published in the new language');
    assert.equal(game.walker.language, 'en', 'and the walker must follow');
  });
});

/* -------------------------------------------------------------------------
 * VII — input attachment.
 *
 * The character did not move in the browser. Not a movement bug: the movement
 * system, the input manager and the frame loop were each correct and each covered.
 * main.js attached the InputManager to the <canvas>, a canvas receives no key events
 * unless it is focusable and focused, and index.html gives it no tabindex and never
 * calls focus(). The game rendered, the mouse still turned the camera - mouse events
 * go to the element under the cursor, not the focused one - and not one key arrived.
 *
 * Every suite passed anyway, because every suite calls input.handleEvent() directly.
 * That tests what the InputManager does with an event and never tests whether an
 * event can reach it. This group dispatches at the attached target instead, which is
 * the only form of this test that can fail for the right reason.
 * ---------------------------------------------------------------------- */

/** An event target that records listeners and can dispatch at them, like a DOM node. */
class FakeEventTarget {
  constructor(name = 'target', doc = null) {
    this.name = name;
    this.document = doc;
    this.listeners = new Map();
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  has(type) { return (this.listeners.get(type) ?? []).length > 0; }
  /** Returns how many listeners ran, so a test can tell "no listener" from "no effect". */
  dispatch(type, ev = {}) {
    const list = this.listeners.get(type) ?? [];
    for (const fn of list) fn(ev);
    return list.length;
  }
}

function windowLike() {
  const doc = new FakeEventTarget('document');
  return { win: new FakeEventTarget('window', doc), doc };
}

describe('runtime — input attachment', () => {
  test('VII1 · a key dispatched at the attached target walks the character', () => {
    const { win } = windowLike();
    const { game } = bootGame({ inputTarget: win });
    assert.equal(game.input.attached, true, 'input must be attached');
    assert.equal(game.input.target, win, 'to the target it was given');
    assert.ok(win.has('keydown'), 'with a keydown listener registered on it');
    assert.ok(win.has('keyup'), 'and a keyup listener');

    const before = { ...game.player.pos };
    assert.equal(win.dispatch('keydown', { code: 'KeyW' }), 1, 'the dispatch must reach a listener');
    step(game, 60);
    const moved = Math.hypot(game.player.pos.x - before.x, game.player.pos.z - before.z);
    assert.gt(moved, 0.5, `holding W for one second moved the character ${moved.toFixed(3)}m`);

    const atRelease = { ...game.player.pos };
    win.dispatch('keyup', { code: 'KeyW' });
    step(game, 30);
    const drift = Math.hypot(game.player.pos.x - atRelease.x, game.player.pos.z - atRelease.z);
    assert.lt(drift, 0.4, `releasing the key must stop them, drifted ${drift.toFixed(3)}m`);
  });

  test('VII2 · every movement direction is reachable through the attached target', () => {
    // One direction working would not have caught this either: the reported symptom is
    // "the character does not move", and a suite that only checks W cannot tell a
    // broken binding for A from a broken attachment.
    const { win } = windowLike();
    const { game } = bootGame({ inputTarget: win });
    const dirs = [
      ['KeyW', 'forward'], ['KeyS', 'back'], ['KeyA', 'left'], ['KeyD', 'right'],
    ];
    for (const [code, name] of dirs) {
      const before = { ...game.player.pos };
      win.dispatch('keydown', { code });
      step(game, 30);
      win.dispatch('keyup', { code });
      const moved = Math.hypot(game.player.pos.x - before.x, game.player.pos.z - before.z);
      assert.gt(moved, 0.15, `${name} (${code}) moved ${moved.toFixed(3)}m in half a second`);
      step(game, 10);
    }
  });

  test('VII3 · a hidden tab releases held keys through the document listener', () => {
    const { win, doc } = windowLike();
    const { game } = bootGame({ inputTarget: win });
    assert.ok(doc.has('visibilitychange'),
      'visibilitychange fires on a document, never on a window, so it must be registered there');
    win.dispatch('keydown', { code: 'KeyW' });
    assert.equal(game.input.isDown('KeyW'), true, 'the key is held');
    doc.dispatch('visibilitychange', { hidden: true });
    assert.equal(game.input.isDown('KeyW'), false,
      'a player who alt-tabs out holding W must not return to a character still running');
  });

  test('VII4 · with a browser global present, input attaches to it and not to the canvas', () => {
    // This is the regression guard for the actual defect. The canvas fallback is right
    // headlessly and wrong in a browser, and only a test that knows both exist can say
    // which one was chosen.
    const { win } = windowLike();
    const canvas = new FakeEventTarget('canvas');
    const previous = globalThis.window;
    try {
      globalThis.window = win;
      const game = new Game({
        canvas, bus: new EventBus(), seed: 'mesopotamia', language: 'ar',
        storage: new MemoryStorage(), rendererFactory: stubRenderer,
      });
      game.boot();
      assert.equal(game.input.target, win, 'keyboard must attach to the window');
      assert.equal(canvas.has('keydown'), false,
        'a canvas receives no key events unless it is focusable and focused, and index.html does neither');
    } finally {
      if (previous === undefined) delete globalThis.window;
      else globalThis.window = previous;
    }
  });

  test('VII5 · headlessly, with no window, it falls back to the canvas', () => {
    // The fallback is what lets every other suite keep working, so it has to be
    // asserted rather than assumed: removing it would silently detach input in node.
    assert.equal(typeof globalThis.window, 'undefined', 'node has no window');
    const canvas = new FakeEventTarget('canvas');
    const game = new Game({
      canvas, bus: new EventBus(), seed: 'mesopotamia',
      storage: new MemoryStorage(), rendererFactory: stubRenderer,
    });
    game.boot();
    assert.equal(game.input.target, canvas, 'the canvas is the headless target');
    assert.equal(game.input.attached, true);
  });

  test('VII6 · an explicit null target attaches nothing and stays drivable by hand', () => {
    const { game } = bootGame({ inputTarget: null });
    assert.equal(game.input.attached, false, 'nothing is attached');
    const before = { ...game.player.pos };
    game.input.handleEvent('keydown', { code: 'KeyW' });
    step(game, 30);
    const moved = Math.hypot(game.player.pos.x - before.x, game.player.pos.z - before.z);
    assert.gt(moved, 0.15, 'handleEvent must still work for a caller driving it directly');
  });

  test('VII7 · detaching removes every listener, including the document one', () => {
    const { win, doc } = windowLike();
    const { game } = bootGame({ inputTarget: win });
    assert.ok(win.has('keydown') && doc.has('visibilitychange'));
    assert.ok(game.input.detach(), 'detach must report success');
    assert.equal(win.has('keydown'), false, 'the window listeners are gone');
    assert.equal(doc.has('visibilitychange'), false, 'and so is the document one');
    assert.equal(game.input.attached, false);
  });

  test('VII8 · the sprint and crouch keys reach the character through the target', () => {
    // Interaction is not only walking. If the attachment were fixed but a binding were
    // missing, the player would move and still report the game as unresponsive.
    const { win } = windowLike();
    const { game } = bootGame({ inputTarget: win });
    win.dispatch('keydown', { code: 'ShiftLeft' });
    win.dispatch('keydown', { code: 'KeyW' });
    step(game, 20);
    const intent = game.input.sample(1 / 60);
    assert.equal(intent.sprint, true, 'shift must read as sprint');
    win.dispatch('keyup', { code: 'ShiftLeft' });
    win.dispatch('keydown', { code: 'KeyC' });
    const crouched = game.input.sample(1 / 60);
    assert.equal(crouched.crouch, true, 'C must read as crouch');
    win.dispatch('keyup', { code: 'KeyW' });
    win.dispatch('keyup', { code: 'KeyC' });
  });
});

/* -------------------------------------------------------------------------
 * VIII — the page and the runtime agree.
 *
 * Three defects in this build were the same shape: a layer that worked, tested in
 * isolation, and a seam to the browser that did not exist. Dialogue was never
 * wired. Cinematics emitted start and end in the same call. Input was attached to a
 * canvas that receives no key events, and index.html called input.pressAction(), a
 * method InputManager never had - so every tap of Attack, Jump, Interact and Dodge
 * on a phone threw a TypeError while the suites that test InputManager passed.
 *
 * A unit test cannot see this, because a unit test calls the method it means to
 * call. So this group reads index.html as text, extracts every method it invokes on
 * the game, and checks each one against a booted runtime. It is a contract test
 * between two files that are never imported together.
 * ---------------------------------------------------------------------- */

const PAGE_URL = new URL('../index.html', import.meta.url);
const PAGE = readFileSync(PAGE_URL, 'utf8');

/** Every `game.x.y(` and `game.x(` call in the page, optional chaining included. */
function pageCallsOnGame(source) {
  const nested = new Set();
  const direct = new Set();
  const reNested = /game\??\.([A-Za-z_$][\w$]*)\??\.([A-Za-z_$][\w$]*)\s*\(/g;
  const reDirect = /game\??\.([A-Za-z_$][\w$]*)\s*\(/g;
  for (const m of source.matchAll(reNested)) nested.add(`${m[1]}.${m[2]}`);
  for (const m of source.matchAll(reDirect)) {
    // Skip anything already captured as the first half of a nested call.
    if (![...nested].some((n) => n.startsWith(`${m[1]}.`))) direct.add(m[1]);
  }
  return { nested: [...nested], direct: [...direct] };
}

describe('runtime — the page/runtime contract', () => {
  test('VIII1 · every method index.html calls on the game exists on a booted game', () => {
    const { nested, direct } = pageCallsOnGame(PAGE);
    assert.gt(nested.length + direct.length, 10,
      'the page must actually call into the runtime, or this test proves nothing');

    const { game } = bootGame();
    const missing = [];
    for (const path of nested) {
      const [owner, method] = path.split('.');
      if (game[owner] == null) { missing.push(`${path} — game.${owner} is ${game[owner]}`); continue; }
      if (typeof game[owner][method] !== 'function') {
        missing.push(`${path} — game.${owner}.${method} is ${typeof game[owner][method]}`);
      }
    }
    for (const method of direct) {
      if (typeof game[method] !== 'function') {
        missing.push(`${method} — game.${method} is ${typeof game[method]}`);
      }
    }
    assert.deepEqual(missing, [],
      `index.html calls methods the runtime does not have:\n  ${missing.join('\n  ')}`);
  });

  test('VIII2 · the touch buttons only press actions the input manager accepts', () => {
    // The page declares its touch buttons in markup and dispatches them by name. A
    // name the InputManager does not know is a button that silently does nothing, and
    // it is invisible on desktop where the buttons are not rendered at all.
    const acts = [...PAGE.matchAll(/data-act="([A-Za-z]+)"/g)].map((m) => m[1]);
    assert.gt(acts.length, 4, 'the touch layer must declare its buttons');
    const { game } = bootGame();
    const held = new Set(['block', 'sprint', 'crouch']);
    const bad = [];
    for (const act of acts) {
      if (act === 'pause') {
        // Handled in the page, never reaching the input manager.
        continue;
      }
      const ok = held.has(act)
        ? game.input.setTouchAction(act, true)
        : game.input.pressAction(act);
      if (!ok) bad.push(act);
    }
    assert.deepEqual(bad, [], `touch buttons the input manager refused: ${bad.join(', ')}`);
  });

  test('VIII3 · a tapped touch button produces one press, and only one', () => {
    // A tap that queues two edges double-fires: one tap swings twice, or skips two
    // lines of dialogue. A tap that queues none is the button doing nothing.
    const { game } = bootGame();
    assert.equal(game.input.pressAction('interact'), true, 'the press must be accepted');
    assert.equal(game.input.takeAction('interact'), true, 'and consumed by the loop');
    assert.equal(game.input.takeAction('interact'), false, 'exactly once');

    assert.equal(game.input.pressAction('attackLight'), true);
    const intent = game.input.sample(1 / 60);
    assert.equal(intent.attackLight, true, 'the intent must carry it');
    assert.equal(game.input.sample(1 / 60).attackLight, false, 'and not carry it again next frame');
  });

  test('VIII4 · pressAction refuses a level action rather than latching it', () => {
    // A level action pressed with nothing to release it is a stuck key: the character
    // sprints until the page is reloaded, and no keyup is ever coming.
    const { game } = bootGame();
    assert.equal(game.input.pressAction('sprint'), false, 'sprint is a level action');
    assert.equal(game.input.pressAction('block'), false, 'so is block');
    assert.equal(game.input.isActionDown('sprint'), false, 'and nothing was latched');
    assert.equal(game.input.pressAction('not-an-action'), false, 'unknown actions are refused');
    // The held path still works, because that is what the page uses for these.
    assert.equal(game.input.setTouchAction('sprint', true), true);
    assert.equal(game.input.isActionDown('sprint'), true);
    game.input.setTouchAction('sprint', false);
    assert.equal(game.input.isActionDown('sprint'), false, 'and releases');
  });

  test('VIII5 · every Events name the page listens for is a real event', () => {
    // The mirror image of VIII1: a typo in an event name is a listener that never
    // fires, and nothing throws to say so.
    const used = new Set([...PAGE.matchAll(/Events\.([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1]));
    assert.gt(used.size, 8, 'the page must subscribe to events');
    const missing = [...used].filter((name) => !(name in Events));
    assert.deepEqual(missing, [], `index.html listens for events that do not exist: ${missing.join(', ')}`);
  });

  test('VIII6 · every element the page looks up exists in its own markup', () => {
    // A $("name") that finds nothing returns null, and the null is not noticed until
    // something assigns to .textContent - inside boot()'s try block, where it becomes a
    // line of orange text on the boot screen and a game that never starts. Checked as
    // text because there is no DOM here to ask.
    const ids = new Set([...PAGE.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    const wanted = new Set([...PAGE.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
    assert.gt(wanted.size, 20, 'the page must look its elements up');
    const missing = [...wanted].filter((w) => !ids.has(w));
    assert.deepEqual(missing, [], `$('...') targets absent from the markup: ${missing.join(', ')}`);
  });

  test('VIII7 · every querySelector the page uses addresses something real', () => {
    // Half a selector is as broken as a whole one: #dialogue .lst finds nothing and
    // returns null just as surely as a misspelled id, and it is the easier typo to make
    // when a panel is being edited.
    const ids = new Set([...PAGE.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    const classes = new Set([...PAGE.matchAll(/\bclass="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)));
    const bad = [];
    const selectors = [...PAGE.matchAll(/querySelector\('([^']+)'\)/g)].map((m) => m[1]);
    assert.gt(selectors.length, 8, 'the page must query into its panels');
    for (const sel of selectors) {
      // Split on whitespace for descendant steps, then on the sigils within a step:
      // ".bar.health" is one element carrying two classes, not an element inside an
      // element, and treating it as the latter asks for a class literally named
      // "bar.health" and reports a selector that works perfectly.
      for (const part of sel.split(/\s+/)) {
        for (const token of part.match(/[#.][\w-]+/g) ?? []) {
          const name = token.slice(1);
          if (token[0] === '#' && !ids.has(name)) bad.push(`${sel} — no id "${name}"`);
          else if (token[0] === '.' && !classes.has(name)) bad.push(`${sel} — no class "${name}"`);
        }
      }
    }
    assert.deepEqual(bad, [], `selectors that address nothing:\n  ${bad.join('\n  ')}`);
  });

  test('VIII8 · every module the page imports exists', () => {
    // A bad import path is a blank page with one line in the console, and there is no
    // browser here to read it.
    const imports = [...PAGE.matchAll(/from '(\.[^']+)'/g)].map((m) => m[1]);
    assert.gt(imports.length, 0, 'the page must import the runtime');
    const missing = imports.filter((spec) => !existsSync(new URL(spec, PAGE_URL)));
    assert.deepEqual(missing, [], `imports that resolve to nothing: ${missing.join(', ')}`);
  });

  test('VIII9 · no module-scope binding is read before it is declared', () => {
    /**
     * A `const` read before its declaration is not undefined, it is a ReferenceError -
     * and in this page it happens during module evaluation, before boot() is ever
     * called. The result is a title, a progress bar that never moves, and nothing in
     * the way of a report, because the only thing that would have printed one is the
     * script that just died.
     *
     * This found a real one: the audio wiring read `isTouch` at module scope, several
     * hundred lines above where the touch handlers declared it. Every other check in
     * this group passed, because the page is structurally fine and merely cannot run.
     *
     * The heuristic is indentation. This file writes its module-scope statements at
     * column zero and everything nested inside something else is indented, so a
     * column-zero line is a statement that runs at evaluation time and an indented one
     * is a function body that runs later, when every binding already exists. That is a
     * style assumption, but it is this file's own style, and the alternative - parsing
     * JavaScript - is not available to a suite with no dependencies.
     */
    const body = PAGE.slice(PAGE.indexOf('<script type="module">'), PAGE.lastIndexOf('</script>'));

    /** Strip what cannot contain a binding reference, so strings and comments do not lie. */
    const code = (line) => line
      .replace(/\/\/.*$/, ' ')
      .replace(/'[^']*'/g, "''")
      .replace(/"[^"]*"/g, '""')
      .replace(/`[^`]*`/g, '``');
    /** `$` and friends are regex metacharacters; an unescaped name matches everything. */
    const quoted = (name) => name.replace(/[^\w]/g, (ch) => `\\${ch}`);

    const declared = new Map();       // name -> first line index declaring it
    const topLevel = [];              // {i, text} statements that run at evaluation time
    let inBlockComment = false;
    const lines = body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      // A block comment may open at column zero and run for twenty lines. Reading it as
      // code is how a prose word becomes a phantom binding reference.
      if (inBlockComment) {
        if (raw.includes('*/')) inBlockComment = false;
        continue;
      }
      if (/^\s*\/\*/.test(raw)) {
        if (!raw.includes('*/')) inBlockComment = true;
        continue;
      }
      if (/^\s/.test(raw) || raw.trim() === '' || raw.trim().startsWith('*')) continue;
      if (raw.startsWith('</') || raw.startsWith('<script')) continue;
      const text = code(raw);
      topLevel.push({ i, text });
      const m = text.match(/^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/);
      if (m && !declared.has(m[1])) declared.set(m[1], i);
    }
    assert.gt(declared.size, 10, 'the page must declare module-scope bindings, or this proves nothing');
    assert.gt(topLevel.length, 40, 'the page must run statements at module scope');

    const early = [];
    for (const { i, text } of topLevel) {
      for (const [name, at] of declared) {
        if (i >= at) continue;
        // A whole-word reference that is not a property of something else.
        if (new RegExp(`(^|[^.\\w$])${quoted(name)}([^\\w$]|$)`).test(text)) {
          early.push(`${name} read on line ${i} ("${text.trim().slice(0, 60)}"), declared on line ${at}`);
        }
      }
    }
    assert.deepEqual(early, [],
      `bindings used before declaration, which is a ReferenceError at module scope:\n  ${early.join('\n  ')}`);
  });

  test('VIII10 · every localized string the page asks for exists in both languages', () => {
    /**
     * Arabic is the first-class language and English is not an afterthought, so a key
     * present in one dictionary and missing from the other renders as the raw key on
     * screen in exactly one of them - which is how it survives a playthrough in the
     * language its author was reading.
     */
    const dict = (lang) => {
      const start = PAGE.indexOf(`${lang}: {`, PAGE.indexOf('const STRINGS'));
      assert.gt(start, 0, `no ${lang} dictionary`);
      let depth = 0;
      let end = start;
      for (let i = PAGE.indexOf('{', start); i < PAGE.length; i++) {
        if (PAGE[i] === '{') depth++;
        else if (PAGE[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      const block = PAGE.slice(start, end);
      return new Set([...block.matchAll(/(?:^|[,{\s])'?([\w-]+)'?\s*:/g)].map((m) => m[1]));
    };
    const ar = dict('ar');
    const en = dict('en');
    assert.gt(ar.size, 40, 'the Arabic dictionary looks empty');
    assert.gt(en.size, 40, 'the English dictionary looks empty');

    // Keys the markup asks for, and keys the script asks for through t().
    const wanted = new Set([
      ...[...PAGE.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]),
      ...[...PAGE.matchAll(/data-i18n-short="([^"]+)"/g)].map((m) => m[1]),
      ...[...PAGE.matchAll(/\bt\('([\w-]+)'\)/g)].map((m) => m[1]),
      ...[...PAGE.matchAll(/setAttribute\('data-i18n',\s*'([\w-]+)'\)/g)].map((m) => m[1]),
    ]);
    assert.gt(wanted.size, 30, 'the page must localize a great deal');

    const missingAr = [...wanted].filter((k) => !ar.has(k));
    const missingEn = [...wanted].filter((k) => !en.has(k));
    assert.deepEqual(missingAr, [], `keys with no Arabic string: ${missingAr.join(', ')}`);
    assert.deepEqual(missingEn, [], `keys with no English string: ${missingEn.join(', ')}`);
  });
});

/* -------------------------------------------------------------------------
 * IX — noise and detection reach the runtime.
 *
 * A stealth game has exactly one unforgivable failure in each direction: a guard who
 * sees the player in visible shadow, and a guard who cannot hear the player
 * sprinting six metres behind him. Group III covers the first. This covers the
 * second, and it was broken the whole time.
 *
 * ai.js has a complete hearing model - noiseAudibility() with an authored falloff
 * exponent, weather masking, suspicion gain, last-known-position memory - and the
 * perception truth it was handed carried noiseRadius 0 on every frame of every
 * playthrough. The runtime waited for a NOISE_EMITTED event to tell it the level;
 * nothing in the repository emitted one; player.js did not contain the word "noise".
 * Measured: walking 3.97 m and sprinting 6.02 m both reported 0.00 against authored
 * radii of 5.2 and 17.5, and three guards accumulated exactly zero suspicion.
 *
 * Separately, index.html has always listened for DETECTION to draw the detection
 * meter. Nothing emitted DETECTION either: the AI publishes SUSPICION_CHANGED, and
 * only on a threshold crossing, so the meter never moved at all.
 * ---------------------------------------------------------------------- */

/** Pin an agent at a distance from the player, holding it there across steps. */
function placeAgentAt(game, agent, metres) {
  const p = game.player.pos;
  agent.body.pos.set(p.x + metres, p.y, p.z);
}

describe('runtime — noise and detection', () => {
  test('IX1 · each gait reports the radius the constants author for it', () => {
    // The number the AI hears and the number the level design wrote down must be the
    // same number. A gait that reports anything else silently retunes the whole
    // stealth layer, and nothing about it looks like a bug from inside the game.
    const gaits = [
      ['crouch', 'KeyC', null, STEALTH.NOISE_CROUCH_WALK],
      ['walk', null, null, STEALTH.NOISE_RUN],     // an unmodified key is a run
      ['sprint', null, 'ShiftLeft', STEALTH.NOISE_SPRINT],
    ];
    for (const [name, crouchKey, sprintKey, expected] of gaits) {
      const { game } = bootGame();
      if (crouchKey) { game.input.handleEvent('keydown', { code: crouchKey }); step(game, 4); }
      if (sprintKey) game.input.handleEvent('keydown', { code: sprintKey });
      game.input.handleEvent('keydown', { code: 'KeyD' });
      let peak = 0;
      for (let i = 0; i < 40; i++) { step(game, 1); peak = Math.max(peak, game.lastTruth.noiseRadius); }
      assert.close(peak, expected, 0.05, `${name} reported ${peak.toFixed(2)}m, authored ${expected}m`);
      game.input.handleEvent('keyup', { code: 'KeyD' });
    }
  });

  test('IX2 · standing still is silent, and stays silent', () => {
    const { game } = bootGame();
    game.input.handleEvent('keydown', { code: 'KeyD' });
    step(game, 30);
    assert.gt(game.lastTruth.noiseRadius, 1, 'moving is loud');
    game.input.handleEvent('keyup', { code: 'KeyD' });
    step(game, 30);
    assert.equal(game.lastTruth.noiseRadius, 0,
      'and letting go of the key must stop the noise - a residual radius is a footstep nobody took');
  });

  test('IX3 · crouching is quieter than walking, which is the whole point of crouching', () => {
    const { game } = bootGame();
    game.input.handleEvent('keydown', { code: 'KeyC' });
    step(game, 4);
    game.input.handleEvent('keydown', { code: 'KeyD' });
    let crouchPeak = 0;
    for (let i = 0; i < 40; i++) { step(game, 1); crouchPeak = Math.max(crouchPeak, game.lastTruth.noiseRadius); }
    // crouch is a toggle, not a hold: releasing the key leaves the character on the
    // ground and the comparison would measure crouching against crouching.
    game.input.handleEvent('keydown', { code: 'KeyC' });
    game.input.handleEvent('keyup', { code: 'KeyC' });
    step(game, 20);
    assert.equal(game.player.stance, 'stand', 'the character must be standing again');
    let standPeak = 0;
    for (let i = 0; i < 40; i++) { step(game, 1); standPeak = Math.max(standPeak, game.lastTruth.noiseRadius); }
    assert.lt(crouchPeak, standPeak,
      `crouch ${crouchPeak.toFixed(2)}m must be quieter than standing ${standPeak.toFixed(2)}m`);
  });

  test('IX4 · a landing is an authored transient, split at the height that starts to hurt', () => {
    const { game, bus } = bootGame();
    const noises = [];
    bus.on(Events.NOISE_EMITTED, (p) => noises.push(p));
    // Drop the player from above the height at which falling costs health.
    const p = game.player.pos;
    game.player.setPosition(p.x, p.y + MOVE.FALL_DAMAGE_SAFE_HEIGHT + 4, p.z);
    game.player.grounded = false;
    game.player.verticalVelocity = 0;
    for (let i = 0; i < 240 && noises.length === 0; i++) step(game, 1);
    assert.gt(noises.length, 0, 'a heavy drop must be heard');
    const heavy = noises[noises.length - 1];
    assert.equal(heavy.radius, STEALTH.NOISE_LAND_HEAVY,
      `a drop that costs health must report ${STEALTH.NOISE_LAND_HEAVY}m, reported ${heavy.radius}m`);
    assert.ok(heavy.source && heavy.source.startsWith('land'), 'and say what made it');
  });

  test('IX5 · the truth carries the louder of the transient and the footsteps', () => {
    // A landing rings out over the walk and then decays back down to it. Taking only
    // the latch would leave a footstep audible for 0.6s after the player stopped;
    // taking only the level would drop the landing entirely.
    const { game } = bootGame();
    game.noiseRadius = 20;      // a latched transient
    game.noiseAge = 0;
    game.player.noiseRadius = 5.2;
    const truth = game._buildTruth();
    assert.equal(truth.noiseRadius, 20, 'the louder of the two wins');
    game.noiseRadius = 2;
    const softer = game._buildTruth();
    assert.equal(softer.noiseRadius, 5.2, 'and the footsteps still carry when the transient is quieter');
  });

  test('IX6 · a guard hears the player sprinting past him', () => {
    // The end-to-end claim, and the one that was false before this fix. hearings is
    // incremented only by the hearing branch of the AI, so it cannot be confounded by
    // the agent also happening to see the player.
    const { game } = bootGame();
    const agent = game.squad.agents[0];
    assert.ok(agent, 'the region must have a guard');
    const before = agent.telemetry.hearings;
    game.input.handleEvent('keydown', { code: 'ShiftLeft' });
    game.input.handleEvent('keydown', { code: 'KeyD' });
    for (let i = 0; i < 30; i++) { placeAgentAt(game, agent, 6); step(game, 1); }
    assert.gt(agent.telemetry.hearings, before,
      'a sprint 6m from a guard must be audible - the authored sprint radius is 17.5m');
    assert.gt(agent.suspicion, 0, 'and it must raise his suspicion');
  });

  test('IX7 · the same guard does not hear the player crouch-walking past him', () => {
    // The other half of the design: at 4m a sprint is heard and a crouch-walk is not,
    // because 2.4m < 4m < 17.5m. If both were silent the stealth layer would be
    // decoration; if both were heard, crouching would be pointless.
    const { game } = bootGame();
    const agent = game.squad.agents[0];
    const before = agent.telemetry.hearings;
    game.input.handleEvent('keydown', { code: 'KeyC' });
    step(game, 4);
    game.input.handleEvent('keydown', { code: 'KeyD' });
    for (let i = 0; i < 30; i++) { placeAgentAt(game, agent, 4); step(game, 1); }
    assert.equal(agent.telemetry.hearings, before,
      `crouch-walking 4m away must be silent (radius ${STEALTH.NOISE_CROUCH_WALK}m)`);
  });

  test('IX8 · rain masks footsteps, because the constants say it does', () => {
    // AMBIENT_MASK_RAIN is authored at 0.72 and documented in the constants as a real
    // stealth tool. A masking factor nothing applies is a number in a file.
    const clear = noiseAudibility(STEALTH.NOISE_WALK, 4, 'clear');
    const rain = noiseAudibility(STEALTH.NOISE_WALK, 4, 'rain');
    const storm = noiseAudibility(STEALTH.NOISE_WALK, 4, 'storm');
    assert.gt(clear, 0, 'audible in the clear at 4m of a 5.2m radius');
    assert.lt(rain, clear, 'rain must reduce it');
    assert.lt(storm, rain, 'and a storm more');
  });

  test('IX9 · the detection meter is published with a level the page can draw', () => {
    const { game, bus } = bootGame();
    const seen = [];
    bus.on(Events.DETECTION, (p) => seen.push(p));
    step(game, 6);
    assert.gt(seen.length, 0, 'the page has always listened for this and nothing ever sent it');
    assert.equal(seen[0].level, 'calm', 'an empty courtyard is calm');
    // Escalate through the authored thresholds.
    const agent = game.squad.agents[0];
    const levels = [];
    for (const s of [10, STEALTH.SUSPICION_ALERT_THRESHOLD + 1, STEALTH.SUSPICION_COMBAT_THRESHOLD + 1]) {
      agent.suspicion = s;
      step(game, 2);
      levels.push(seen[seen.length - 1].level);
    }
    assert.deepEqual(levels, ['suspicious', 'alerted', 'combat'],
      `the meter must escalate through every level the HUD has a colour for, got ${levels.join(' → ')}`);
    for (const l of levels.concat('calm')) {
      assert.ok(STRINGS_LEVELS.includes(l), `the page cannot localize the level "${l}"`);
    }
  });

  test('IX10 · the detection meter is not published sixty times a second', () => {
    // A meter emits when it changes. Publishing every frame would put an event on the
    // bus 60 times a second for a value that moves a handful of times per encounter.
    const { game, bus } = bootGame();
    let count = 0;
    bus.on(Events.DETECTION, () => { count++; });
    step(game, 120);
    assert.lt(count, 12, `2 seconds of a calm courtyard produced ${count} detection events`);
    assert.gt(count, 0, 'but the first state must be published');
  });

  test('IX11 · a hostile guard reads as combat regardless of the suspicion number', () => {
    const { game, bus } = bootGame();
    const seen = [];
    bus.on(Events.DETECTION, (p) => seen.push(p));
    const agent = game.squad.agents[0];
    agent.state = AIState.CHASE;
    agent.suspicion = 0;
    step(game, 4);
    assert.equal(seen[seen.length - 1].level, 'combat',
      'a guard already swinging is combat even if his suspicion meter was reset');
    assert.equal(seen[seen.length - 1].hostile, true);
  });
});

runAndExit();
