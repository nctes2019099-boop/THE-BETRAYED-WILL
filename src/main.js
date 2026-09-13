/**
 * THE BETRAYED WILL — main.js
 *
 * Boot and the frame loop: the only place where the simulation, the renderer, input
 * and storage are all in the same room.
 *
 * ── Fixed simulation step, variable render ───────────────────────────────────
 * The simulation advances in fixed 1/60 s steps from an accumulator, and the
 * renderer draws once per animation frame. This is not ceremony. Every constant in
 * this codebase - jump height, dodge distance, detection time, stagger duration -
 * was tuned and tested against a fixed step, and 445 of the regression tests assert
 * behaviour produced that way. Stepping the simulation by raw frame time would make
 * a 30fps phone and a 144fps desktop play different games, and would invalidate the
 * determinism the save system and the playthrough suite both rely on.
 *
 * The accumulator is capped. A tab restored after ten seconds in the background must
 * not try to simulate six hundred steps to catch up, which is the spiral that turns a
 * hiccup into a freeze.
 *
 * ── The simulation leads, the renderer follows ───────────────────────────────
 * Positions, yaws, speeds and stances all come out of the controllers and are copied
 * onto the visual rigs. Nothing here decides where a character is. The one value that
 * flows the other way is `lightLevel`, and it flows from the lighting rig into the
 * perception system so that what the player sees is what the AI is allowed to see.
 *
 * ── Noise is the simulation's number, not a guess ────────────────────────────
 * The perception truth carries `noiseRadius`, and it comes in two kinds. Locomotion
 * is a LEVEL owned by the movement system and read straight off the controller each
 * step. Transients - a landing - arrive as NOISE_EMITTED events, are latched at their
 * peak and allowed to decay. Nothing here derives loudness from speed: two sources
 * for one fact is how an AI ends up hearing footsteps the player never made.
 */

import * as THREE from '../vendor/three/three.module.js';

import { EventBus, Events } from './core/bus.js';
import { CAM, COMBAT, MOVE, PERF, STEALTH } from './core/constants.js';
import { RNG, hashString } from './core/rng.js';
import { Vec3 } from './core/math.js';
import { InputManager } from './core/input.js';

import { World } from './sim/world.js';
import { PlayerController, Stance } from './sim/player.js';
import { ThirdPersonCamera } from './sim/camera.js';
import { MissionManager, EventKind } from './sim/mission.js';
import { DialogueWalker } from './sim/dialogue.js';
import { Conversation, TREE_BY_LANDMARK, muteEvents } from './sim/conversation.js';
import { CinematicDirector, PLAYER_CHARACTER, CINEMATIC_IDS } from './sim/cinematic.js';
import { StoryState } from './sim/story-state.js';
import { AISquad, AIState, makeGuard } from './sim/ai.js';
import { AudioDirector } from './audio/director.js';
import { createAudioEngine } from './audio/engine.js';
import { SaveSystem } from './sim/save.js';
import {
  SwingPhase, attackProfile, resolveMelee, pickLockTarget, HitOutcome,
  advanceHitstop, hitstopActive, HITSTOP_TIME_SCALE, canTakedown, canFinisher,
} from './sim/combat.js';
import { PlayerState } from './sim/player.js';

import { CLUES } from './content/story.js';
import { detectStorage, gamepadPoller } from './platform/browser.js';
import { MaterialLibrary } from './render/materials.js';
import { RegionMesh } from './render/region-mesh.js';
import { LightingRig, TIME_OF_DAY } from './render/lighting.js';
import { CharacterRig } from './render/characters.js';
import { Renderer } from './render/renderer.js';

/** The simulation step. Every tuned constant in the codebase assumes it. */
const FIXED_DT = 1 / 60;
/** Longest single frame the loop will accept, before it assumes a stall. */
const MAX_FRAME_DT = 0.25;
/** Fixed steps per rendered frame before the accumulator is dumped. */
const MAX_STEPS = 5;
/** Seconds a noise event stays audible to the perception system. */
const NOISE_DECAY_S = 0.6;
/** Metres from a doorway at which the interact prompt appears. */
const DOOR_PROMPT_M = 2.2;
/** Metres from a landmark at which its prompt appears. */
const LANDMARK_PROMPT_M = 2.6;

/** landmark id -> clue id, so examining a landmark can grant the right clue. */
const CLUE_BY_LANDMARK = new Map(CLUES.map((c) => [c.landmark, c.id]));

/**
 * The verb a landmark's interact kind shows the player.
 *
 * Localized here rather than in the DOM layer, because the prompt text is built
 * where the prompt is decided and the UI only draws what it is given. A verb table
 * in two places is two tables that drift.
 */
/** What the takedown prompt calls its target. Agents carry an id and no display name. */
const TAKEDOWN_LABEL = Object.freeze({ ar: 'الحارس', en: 'Guard' });

const INTERACT_VERBS = Object.freeze({
  examine: { ar: 'افحص', en: 'Examine' },
  clue: { ar: 'افحص', en: 'Examine' },
  search: { ar: 'فتّش', en: 'Search' },
  dialogue: { ar: 'حاور', en: 'Talk' },
  door: { ar: 'ادخل', en: 'Enter' },
  hide: { ar: 'اختبئ', en: 'Hide' },
  pray: { ar: 'صلِّ', en: 'Pray' },
  light: { ar: 'أشعل', en: 'Light' },
  pickup: { ar: 'خذ', en: 'Take' },
  shop: { ar: 'ساوم', en: 'Barter' },
  climb: { ar: 'تسلّق', en: 'Climb' },
  sit: { ar: 'اجلس', en: 'Sit' },
  // Offered instead of the landmark's own verb when the player is standing at the place
  // the story sent them to and carrying what they were sent to read. Without it the
  // hearth keeps saying "Talk" after the conversation has ended.
  present: { ar: 'اقرأ جهارًا', en: 'Read aloud' },
  // Offered when the player is behind a guard who has not seen them. Same key as every
  // other interaction, because a takedown is something you do to the world in front of
  // you and the player should not have to learn a second vocabulary for it.
  takedown: { ar: 'حيّد', en: 'Subdue' },
});

export class Game {
  constructor({
    canvas = null,
    bus = new EventBus(),
    language = 'ar',
    quality = null,
    seed = 'mesopotamia',
    weather = 'clear',
    storage = undefined,
    rendererFactory = null,
    inputTarget = undefined,
    audioFactory = undefined,
  } = {}) {
    this.bus = bus;
    this.canvas = canvas;
    this.language = language === 'en' ? 'en' : 'ar';
    this.seed = seed;
    this.weather = weather;
    this.quality = quality;

    this.running = false;
    this.rafId = 0;
    this.lastNow = 0;
    this.accumulator = 0;
    this.elapsed = 0;
    this.steps = 0;
    this.regionId = null;

    this.noiseRadius = 0;
    this.noiseAge = Infinity;
    /**
     * Impact freeze, in seconds of real time remaining.
     *
     * `advanceHitstop` and `hitstopActive` are written against any object with a
     * `hitstop` field, and the game is the right owner: hitstop scales the simulation
     * clock, which is the game's clock and not the player's. Putting it on the player
     * would freeze only the player and leave the guards moving through the impact,
     * which is the opposite of what the technique is for.
     */
    this.hitstop = 0;
    /** The agent being executed, for the camera. Cleared the frame the act ends. */
    this._finisherVictim = null;
    this._lockSwitchCooldown = 0;
    this.aiming = false;
    this.drawing = false;
    /** The last perception truth handed to the AI. See _fixedUpdate. */
    this.lastTruth = null;
    this.prompt = null;
    this.paused = false;
    /** Last published detection level and suspicion bucket. See _publishDetection. */
    this._detectionLevel = null;
    this._detectionBucket = -1;

    this.telemetry = {
      bootMs: 0, fps: 0, frameMs: 0, steps: 0, drawCalls: 0,
      triangles: 0, agents: 0, regionBuildMs: 0, worstFrameMs: 0,
    };

    this._storageOpt = storage;
    /**
     * The audio engine factory.
     *
     * `undefined` means "build one for this environment", which yields a NullAudioEngine
     * outside a browser so every headless suite exercises the real director against an
     * engine that cannot make a sound. Injecting a fake WebAudio context instead lets a
     * suite assert what the game actually tried to play.
     */
    this._audioFactory = audioFactory;
    this.audio = null;
    /**
     * What the InputManager attaches to. `undefined` means "choose correctly": a
     * global window in a browser, the canvas headlessly. An explicit `null` means
     * "attach to nothing", which is what a caller driving handleEvent() by hand wants.
     */
    this._inputTarget = inputTarget;
    this._noiseSub = null;
    /**
     * Injected so the loop can be run headless.
     *
     * A WebGL context does not exist outside a browser, and without this seam the
     * only way to test boot and the frame loop would be to test them in a browser -
     * which means not testing them in CI at all. Everything except the final
     * submission is pure arithmetic and object wiring, and that is worth asserting.
     */
    this._rendererFactory = typeof rendererFactory === 'function'
      ? rendererFactory
      : (opts) => new Renderer(opts);
  }

  /* ------------------------------------------------------------------ boot */

  /**
   * Build everything. Returns a report rather than throwing where it can help: a
   * boot that fails on a phone should say what failed, not show a black screen.
   */
  boot() {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const report = { ok: true, problems: [], timings: {} };

    this.world = new World({ seed: this.seed, startRegion: 'palace-court' });
    this.mats = new MaterialLibrary({ anisotropy: 4 });
    this.scene = new THREE.Scene();
    this.lighting = new LightingRig(this.scene, { shadows: true });

    this.renderer = this._rendererFactory({
      canvas: this.canvas, bus: this.bus, quality: this.quality, scene: this.scene,
    });

    this.camera3d = new THREE.PerspectiveCamera(CAM.FOV_DEFAULT, this.renderer.aspect, 0.1, PERF.CULL_DISTANCE * 1.6);
    this.camera3d.rotation.order = 'YXZ';

    this.state = new StoryState({ language: this.language });
    // The director has to exist before the mission manager, which is what calls it:
    // playCinematic() hands the sequence over and defers the objective notification
    // until the player has watched. Without it, all nine cinematics fire, set their
    // flags and complete their objectives in a single synchronous call - accounted
    // for, and invisible.
    this.cinematics = new CinematicDirector({
      bus: this.bus,
      language: this.language,
      resolveSubject: (id) => this._resolveCinematicSubject(id),
      heightAt: (x, z) => (this.space ? this.space.heightAt(x, z) : null),
    });
    this.missions = new MissionManager({
      bus: this.bus, state: this.state, language: this.language, cinematics: this.cinematics,
    });
    // The walker owns the dialogue graph; the Conversation owns its pacing and is
    // what tells the mission system a scene was actually sat through. Without both,
    // all fourteen trees are unreachable and every DIALOGUE objective is impossible.
    // The walker publishes a whole node's lines the moment it enters it; the
    // Conversation below publishes them one at a time, timed to reading speed.
    // Mute the batch, or the HUD is handed the entire scene before the player has
    // read the first line and then the same scene again, line by line.
    this.walker = new DialogueWalker({
      bus: muteEvents(this.bus, [Events.SUBTITLE, Events.DIALOGUE_LINE]),
      language: this.language,
    });
    this.conversation = new Conversation({
      walker: this.walker, bus: this.bus, missions: this.missions,
      state: this.missions.state, language: this.language,
    });
    this.save = new SaveSystem({
      // undefined means "detect it"; an explicit null means "no storage, stay in
      // memory", which is what a headless caller wants and a browser never does.
      storage: this._storageOpt === undefined ? (detectStorage() ?? null) : this._storageOpt,
      bus: this.bus,
      getState: () => this.missions.state,
    });
    if (this.save.volatile) {
      report.problems.push('no persistent storage: progress will not survive this session');
    }
    this.save.attachAutosave();

    // Keyboard events are delivered to whatever has focus, and a <canvas> is not
    // focusable unless it carries a tabindex and something calls focus() on it. This
    // file attached to the canvas and index.html does neither, so the game rendered,
    // the mouse still turned the camera - mouse events target the element under the
    // cursor, not the focused one - and not one key ever arrived. The character could
    // not walk. Every suite passed regardless, because they all call handleEvent()
    // directly instead of dispatching at a target, which tests the InputManager and
    // never tests where it was attached.
    const globalTarget = typeof window !== 'undefined' && typeof window?.addEventListener === 'function'
      ? window : null;
    const inputTarget = this._inputTarget === undefined
      ? (globalTarget ?? this.canvas)
      : this._inputTarget;
    this.input = new InputManager({
      target: inputTarget,
      bus: this.bus,
      gamepad: true,
      gamepadProvider: gamepadPoller(),
    });

    this.playerRig = new CharacterRig(this.mats, 'player');
    this.scene.add(this.playerRig.root);
    this.npcRigs = new Map();

    // Transients only. The movement system reports its own continuous loudness and
    // the truth below takes the louder of the two, so a landing rings out over the
    // footsteps and then decays back down to them instead of replacing them.
    this._noiseSub = (p) => {
      // `local: false` marks a noise that happened somewhere in the world rather than
      // at the player - a guard being struck ten metres away, an arrow hitting a wall.
      // Those are sent to the agents by position through squad.notifyAll(), and folding
      // them into the player's own radius as well would make every agent in the region
      // hear the same event twice and raise suspicion twice as fast as authored. One
      // fact, one path.
      if (p?.local === false) return;
      const r = Number(p?.radius ?? p?.noiseRadius ?? 0);
      if (Number.isFinite(r) && r > this.noiseRadius) this.noiseRadius = r;
      this.noiseAge = 0;
    };
    this.bus.on(Events.NOISE_EMITTED, this._noiseSub);

    this.bus.on(Events.CUTSCENE_START, (payload) => {
      // A cinematic is authored for a place, and its shots resolve subjects against
      // that place's geometry. Playing it from the wrong region would verify the
      // camera against colliders that are not there and frame shots of a room the
      // player is not standing in. `resumed` is a language refresh, not a new scene.
      if (payload?.resumed) return;
      if (payload?.region && payload.region !== this.regionId) this.travelTo(payload.region);
    });
    this.bus.on(Events.PAUSE, () => { this.paused = true; });
    this.bus.on(Events.RESUME, () => { this.paused = false; });

    // Audio is built last and inside a guard. A game that will not boot because it
    // could not make a sound is a worse outcome than a silent game, and a browser that
    // refuses an AudioContext is not an error the player caused or can fix. The
    // director still exists either way, so nothing downstream has to check.
    try {
      const engine = typeof this._audioFactory === 'function'
        ? this._audioFactory()
        : createAudioEngine({});
      this.audio = new AudioDirector({
        bus: this.bus,
        engine,
        rng: new RNG(hashString(`${this.seed}:audio`)),
      });
      this.audio.attach();
      report.timings.audioMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
      // A missing AudioContext is recorded, not reported as a problem. Headless is a
      // supported configuration and so is a browser that refuses to make a sound; a
      // problem is something the operator has to act on, and there is nothing to do
      // here. The state is still visible in diagnostics().audio.engine.kind, which is
      // where anyone investigating a silent game would look.
      report.audio = engine.available ? 'webaudio' : engine.kind;
    } catch (err) {
      // Failing to construct the director at all IS a problem: something downstream
      // would then call this.audio.update on a null, and the boot report is the only
      // place that would say so.
      this.audio = null;
      report.problems.push(`audio: ${err?.message ?? err}`);
    }

    this.setRegion('palace-court', null);

    const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    report.timings.bootMs = t1 - t0;
    this.telemetry.bootMs = report.timings.bootMs;
    report.timings.regionBuildMs = this.world.totalBuildTimeMs;
    if (report.timings.bootMs > PERF.BOOT_BUDGET_MS) {
      report.problems.push(`boot took ${report.timings.bootMs.toFixed(0)}ms against a ${PERF.BOOT_BUDGET_MS}ms budget`);
    }
    this.bootReport = report;
    return report;
  }

  /* ---------------------------------------------------------------- region */

  /**
   * Enter a region: build it, mesh it, light it, and populate it.
   *
   * The previous region's meshes are disposed. Keeping every visited region alive is
   * how a browser tab grows to a gigabyte over an hour of play, and there is no
   * open world here to justify it - regions are interiors and courtyards, and the
   * player is in exactly one of them.
   */
  setRegion(id, spawn = null) {
    // Leaving a region with something still hunting you is what an ESCAPE objective
    // asks for, and it has to be decided here: _populateAgents() below replaces the
    // squad, so this is the last frame in which the pursuers are the ones who were
    // actually chasing. The event carries the region being escaped and `pursued`,
    // and the matcher requires both, so "cross the tunnel" cannot be completed from
    // anywhere but the tunnel or without a chase behind you.
    if (this.regionId && this.regionId !== id && this._inCombat()) {
      this.missions.notify({ kind: EventKind.ESCAPE, id: this.regionId, pursued: true });
    }

    const space = this.world.region(id);
    if (this.regionMesh) {
      this.scene.remove(this.regionMesh.group);
      this.regionMesh.dispose();
    }
    this.regionMesh = new RegionMesh(space, this.mats);
    this.scene.add(this.regionMesh.group);

    this.regionId = id;
    this.space = space;
    this.regionDef = space.region;

    // Arriving somewhere is the fact a GOTO objective is written against, and three of
    // them name a region rather than a landmark - m07 "reach the palace exterior",
    // m11 "go to Layla's house". The matcher accepts a REGION event or a LANDMARK one,
    // so a region change that notifies nothing leaves those objectives permanently
    // incomplete no matter where the player walks. notify() also records the visit in
    // the story state, which is what the save file carries forward.
    this.missions.notify({ kind: EventKind.REGION, id });

    this.lighting.apply(this.regionDef, {
      weather: this.weather,
      fires: LightingRig.firesFrom(this.regionMesh),
    });

    // Player controller is rebuilt per region so it resolves against the right
    // collision world; the camera keeps its orientation, because being teleported
    // between rooms should not also spin the player around.
    const start = spawn ?? space.spawnPoints[0] ?? { x: 0, y: 0, z: 0 };
    const prevYaw = this.player ? this.player.yaw : 0;
    const prevCamYaw = this.camera ? this.camera.yaw : prevYaw;
    this.player = new PlayerController({
      id: PLAYER_CHARACTER ?? 'player',
      collision: space.collision,
      bus: this.bus,
      pos: new Vec3(start.x, space.heightAt(start.x, start.z), start.z),
      yaw: prevYaw,
      health: this.player ? this.player.health : undefined,
      injured: this.player ? this.player.injured : false,
    });
    this.camera = new ThirdPersonCamera({ collision: space.collision, yaw: prevCamYaw });

    this._populateAgents(space);
    this.bus.emit(Events.PLAYER_ENTERED_REGION, { region: id, spawn: start });
    return space;
  }

  /** Guards for a region, placed on the nav grid the AI will actually route on. */
  _populateAgents(space) {
    this.squad = new AISquad({
      nav: space.nav,
      collision: space.collision,
      bus: this.bus,
      pathfinder: space.pathfinder,
      rng: new RNG(hashString(`${this.seed}:${space.id}`)),
      budgetMs: PERF.AI_BUDGET_MS,
    });
    for (const [id, rig] of this.npcRigs) {
      this.scene.remove(rig.root);
      rig.dispose();
      this.npcRigs.delete(id);
    }

    // A region with no landmarks and no walkable space gets no guards rather than
    // guards stuck inside geometry, which is worse than an empty room.
    // NavGrid reports its counts under `stats`, not as a top-level property. A
    // region with too little walkable floor gets no guards at all rather than guards
    // spawned inside geometry, which is the worse failure of the two.
    const walkable = space.nav?.stats?.walkable ?? 0;
    const count = walkable > 40 ? 3 : 0;
    const placed = [];
    for (let i = 0; i < count; i++) {
      const home = space.randomWalkablePoint(this.squad.rng);
      if (!home) continue;
      const patrol = [home];
      for (let p = 0; p < 2; p++) {
        const pt = space.randomWalkablePoint(this.squad.rng, home, 14);
        if (pt) patrol.push(pt);
      }
      const id = `guard-${space.id}-${i}`;
      const agent = makeGuard(
        { id, pos: new Vec3(home.x, home.y, home.z), patrol },
        {
          bus: this.bus, nav: space.nav, collision: space.collision,
          pathfinder: space.pathfinder, group: this.squad.coordinator, rng: this.squad.rng,
        },
      );
      this.squad.add(agent);
      const rig = new CharacterRig(this.mats, 'guard', { showAlert: true });
      this.scene.add(rig.root);
      this.npcRigs.set(id, rig);
      placed.push(id);
    }
    this.telemetry.agents = placed.length;
    return placed;
  }

  /* ------------------------------------------------------------------ loop */

  start() {
    if (this.running) return false;
    if (typeof requestAnimationFrame !== 'function') {
      // No rAF means no browser. Rather than throwing, refuse to start: a headless
      // caller can still drive _fixedUpdate() and _frame() directly, which is what
      // the runtime suite does.
      return false;
    }
    this.running = true;
    this.lastNow = 0;
    const step = (now) => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(step);
      this._frame(now);
    };
    this.rafId = requestAnimationFrame(step);
    return true;
  }

  stop() {
    this.running = false;
    if (this.rafId && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    // Detaching on stop, not only on dispose: a stopped game whose director is still
    // subscribed keeps building graphs for events nobody will hear, and a test that
    // boots and stops a dozen games would leak a dozen listeners onto one bus.
    this.audio?.detach();
  }

  _frame(now) {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (!this.lastNow) this.lastNow = now;
    let frameDt = (now - this.lastNow) / 1000;
    this.lastNow = now;
    if (!Number.isFinite(frameDt) || frameDt <= 0) frameDt = FIXED_DT;
    if (frameDt > MAX_FRAME_DT) {
      // A stall, not a slow frame. Simulating the missing time would move the player
      // through walls and drain their stamina for a period they were not playing.
      frameDt = MAX_FRAME_DT;
      this.accumulator = 0;
    }

    // Declared outside the pause branch on purpose: the telemetry below reports how
    // many steps ran, and a paused frame reports zero. Scoped inside the branch this
    // is a ReferenceError on every frame, which is the kind of bug that never reaches
    // a browser when the loop is covered by a test.
    let steps = 0;
    if (this.cinematics?.active) {
      // A cutscene stops the world for the same reason a conversation does, and it
      // also has to drive the camera itself: the camera is normally updated from
      // _fixedUpdate, and no fixed steps run while the world is frozen. Without this
      // the shot would be sampled and then never drawn.
      this._cinematicFrame(frameDt);
    } else if (this.conversation?.active) {
      // A conversation stops the world. Guards keep patrolling through a scene and
      // the player is killed mid-sentence, which no amount of writing survives. The
      // scene clock still runs, because pacing is the one thing that must not freeze.
      this._conversationFrame(frameDt);
    } else if (!this.paused) {
      this.accumulator += frameDt;
      while (this.accumulator >= FIXED_DT && steps < MAX_STEPS) {
        this._fixedUpdate(FIXED_DT);
        this.accumulator -= FIXED_DT;
        steps++;
        this.steps++;
      }
      if (steps >= MAX_STEPS) this.accumulator = 0;
      this.elapsed += frameDt;
    }

    this._syncVisuals();
    this.renderer.render(this.camera3d);
    // Once per rendered frame, not once per fixed step. Audio is continuous and follows
    // the wall clock; running it inside the accumulator would tie the music's tempo and
    // the footstep cadence to how many simulation steps happened to fit this frame, so
    // a dropped frame would slow the score down.
    this._updateAudio(frameDt);

    const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.telemetry.frameMs = t1 - t0;
    if (this.telemetry.frameMs > this.telemetry.worstFrameMs) this.telemetry.worstFrameMs = this.telemetry.frameMs;
    this.telemetry.fps = frameDt > 0 ? 1 / frameDt : 0;
    this.telemetry.steps = steps;
    this.telemetry.drawCalls = this.renderer.info.drawCalls;
    this.telemetry.triangles = this.renderer.info.triangles;
    this._updateInteraction();
  }

  /**
   * Drive an open conversation.
   *
   * The intent is still sampled every frame even though the world is frozen, because
   * edges queue up: skipping the sample would leave the player holding a dozen
   * buffered presses that all fire the instant the scene ends.
   */
  _conversationFrame(dt) {
    const intent = this.input.sample(dt);
    if (this.input.takeAction('pause')) {
      // Escape leaves the conversation rather than opening a menu on top of it. Both
      // are defensible; a menu that covers the face of the person you were talking to
      // is not.
      this.conversation.leave();
      this._publishPrompt(null);
      return;
    }
    if (intent.interact) this.conversation.skipOrAdvance();
    this.conversation.update(dt);
    if (!this.conversation.active) this._publishPrompt(null);
  }

  /**
   * Drive a running cinematic.
   *
   * Skippable from either the pause key or the interact key. A cinematic that cannot
   * be skipped is a tax on replaying the game, and the flags and objectives it sets
   * are applied by the mission layer either way, so nothing is lost by letting the
   * player through early.
   */
  _cinematicFrame(dt) {
    const intent = this.input.sample(dt);
    if (this.input.takeAction('pause') || intent.interact) this.cinematics.skip();
    this.cinematics.update(dt);
    this._updateCinematicCamera(dt);
    if (!this.cinematics.active) this._publishPrompt(null);
  }

  /**
   * Feed the authored shot to the camera.
   *
   * ctx.cinematic is what ThirdPersonCamera._inferMode() keys on, and setting it
   * routes the whole update through _updateCinematic - including the shot authored
   * as mode:'FINISHER', which is framed with the finisher's own camera constants
   * rather than by switching ctx mid-scene and snapping the player's view.
   */
  _updateCinematicCamera(dt) {
    const payload = this.cinematics.cameraPayload();
    if (!payload) return;
    this.camera.update(dt, this.player, {
      region: this.regionDef,
      timeOfDay: this.regionDef?.timeOfDay ?? 'dusk',
      weather: this.weather,
      indoor: this.regionDef?.indoor === true,
      reducedMotion: this.reducedMotion === true,
      cinematic: payload,
    });
  }

  /**
   * A live position for a cinematic subject.
   *
   * Only the player has one: CHARACTERS is narrative data and the world spawns
   * guards, not cast, so landmarks are resolved by the director from content and a
   * named character with no body is anchored and counted there. This hook is where a
   * cast-body system would plug in later without the director changing.
   */
  _resolveCinematicSubject(id) {
    if (id !== PLAYER_CHARACTER) return null;
    return this.player?.pos ? this.player.pos.clone() : null;
  }

  _fixedUpdate(dt) {
    const intent = this.input.sample(dt);
    /**
     * Hitstop scales the world rather than stopping it.
     *
     * The timers are advanced on the real dt so a freeze always expires in real time,
     * while everything simulated runs on the scaled dt. Getting that the other way
     * round - scaling the timers too - is how an impact freeze becomes permanent: the
     * clock that would end it is the one being slowed by it.
     */
    const frozen = hitstopActive(this);
    const worldDt = frozen ? dt * HITSTOP_TIME_SCALE : dt;
    advanceHitstop(this, dt);
    // PlayerController has no bow state to read, so the intent is the authority on
    // whether the player is drawing. Taking it from anywhere else would let the arms
    // and the projectile system disagree about whether a shot was loosed.
    this.aiming = intent.aimHeld === true;
    this.drawing = intent.drawHeld === true;

    if (this.input.takeAction('pause')) {
      this.bus.emit(this.paused ? Events.RESUME : Events.PAUSE, {});
    }

    const ctx = {
      region: this.regionDef,
      timeOfDay: this.regionDef?.timeOfDay ?? 'dusk',
      weather: this.weather,
      hidden: this._inHidingSpot(),
      inCombat: this._inCombat(),
      interactable: this._nearestInteractable(),
      reducedMotion: this.reducedMotion === true,
      // Null while nothing is playing, which is what keeps the gameplay solver in
      // charge. A cinematic normally runs through _cinematicFrame instead, but a
      // caller driving _fixedUpdate directly still gets a correct camera.
      cinematic: this.cinematics?.active ? this.cinematics.cameraPayload() : null,
      // The camera's FINISHER mode is written and unreachable without this: _inferMode()
      // keys on ctx.finisher, and _updateFinisher() frames the pair with COMBAT's own
      // finisher constants. Null while nothing is executing, which leaves the gameplay
      // solver in charge.
      finisher: this.player.state === PlayerState.FINISHER ? this._finisherShot() : null,
    };

    this._updateLockOn(intent, worldDt);
    this.player.update(worldDt, intent, ctx);
    // Cleared after the player updates, not before: the act ends inside player.update, on
    // the frame its own clock passes FINISHER_DURATION, and clearing earlier would leave
    // the camera holding a victim for one frame after the execution was over. ctx was
    // already built from the state as it stood at the top of the frame, so this frame's
    // shot is still framed and the next one is not.
    if (this.player.state !== PlayerState.FINISHER) this._finisherVictim = null;
    this.camera.update(worldDt, this.player, ctx);

    // Noise decays. The value came from the movement system; keeping it forever
    // would mean one footstep alerting every guard in the region permanently.
    this.noiseAge += dt;
    if (this.noiseAge > NOISE_DECAY_S) { this.noiseRadius = 0; this.noiseAge = Infinity; }

    this._publishDetection();

    this.missions.update(dt * 1000);   // MissionManager works in milliseconds

    // Recorded on the game, not only passed down. It is the value that decides
    // whether a guard can see the player, so it belongs in diagnostics, and a
    // consumer that has to wrap squad.update to observe it loses the wrapper the
    // moment a region change replaces the squad.
    this.lastTruth = this._buildTruth();
    this.squad.update(worldDt, this.lastTruth);

    // Last, and after both sides have moved. Resolving before the squad updates would
    // test this frame's swings against last frame's positions, so a blow the player
    // visibly landed would miss and a blow they visibly dodged would connect.
    this._resolveCombat();
  }

  /* ------------------------------------------------------------------ combat */

  /**
   * Make the blows that were authored actually land.
   *
   * The whole of melee resolution existed and was unit-tested: resolveMelee() gates
   * reach, arc, i-frames, block, parry, stagger, guard break, damage and death, and
   * AISquad.resolveAttacks() collects a frame's agent swings in one deterministic
   * order. ai-test called resolveAttacks() directly and passed. Nothing in the runtime
   * ever called it, and nothing resolved the player's swings at all, so in the shipped
   * game guards swung and dealt no damage, the player swung and dealt no damage, the
   * only way to lose health was to fall, and the only way to kill a guard was not to
   * exist. Three missions carry a non-optional COMBAT objective, so the story could
   * not be finished.
   *
   * Both directions go through the same resolveMelee(), which is the point: one
   * implementation of a hit, so the player and the guards cannot end up with different
   * rules.
   */
  _resolveCombat() {
    const player = this.player;
    if (!player || player.isDead || !this.squad) return;

    // --- the player's swing, against the agent it is most likely aimed at ----
    const swing = player.swing;
    if (swing && swing.phase === SwingPhase.ACTIVE && !swing.hitConsumed) {
      const target = this._pickStrikeTarget();
      if (target) {
        // A guard nearly dead, in reach and in front is an execution rather than another
        // hit. Judged before resolveMelee() because the finisher replaces the blow: it
        // has its own duration, its own invulnerability and its own camera, and running
        // the ordinary resolver first would spend the swing on 9 damage and a stagger
        // before the moment arrived.
        if (player.state !== PlayerState.FINISHER && canFinisher(player, target.body).ok) {
          this._performFinisher(target);
        } else {
          const result = resolveMelee(player, target.body, swing, {
            bus: this.bus, source: player.id,
          });
          if (result.outcome !== HitOutcome.MISS) {
            this._afterBlow(result, target, false);
          }
        }
      }
    }

    // --- every agent's live swing, against the player ------------------------
    for (const hit of this.squad.resolveAttacks(player, { bus: this.bus })) {
      if (hit.result.outcome === HitOutcome.MISS) continue;
      const agent = this.squad.agents.find((a) => a.id === hit.id) ?? null;
      if (agent) this._afterBlow(hit.result, agent, true);
    }
  }

  /**
   * Which agent the player's swing is aimed at.
   *
   * A selection, not a second reach test: resolveMelee() does the geometry itself and
   * refuses what it should. Picking first is what stops a swing from spending itself on
   * the wrong body - resolveMelee() marks a swing consumed on the first defender it
   * touches, so iterating the crowd in array order would hit whoever happened to be
   * first rather than whoever the player faced.
   *
   * Any living agent is a legal target, hostile or not. A neutral servant who cannot be
   * struck is an invisible immunity, and m04 asks the player to silence a watching
   * servant.
   */
  _pickStrikeTarget() {
    const swing = this.player.swing;
    const profile = swing?.profile ?? attackProfile(swing?.kind ?? 'light') ?? attackProfile('light');
    const bodies = [];
    for (const a of this.squad.agents) {
      if (!a.body || a.body.isDead) continue;
      bodies.push(a.body);
    }
    if (bodies.length === 0) return null;
    const best = pickLockTarget(bodies, this.player.pos, this.player.yaw, {
      range: profile.reachMax ?? COMBAT.MELEE_REACH_MAX,
      angleDeg: COMBAT.MELEE_ARC_DEG * 0.5,
      current: this.player.lockTarget?.body ?? null,
    });
    if (!best) return null;
    return this.squad.agents.find((a) => a.body === best) ?? null;
  }

  /**
   * What a connected blow does to the world beyond the two bodies in it.
   *
   * @param {object} result        resolveMelee()'s return
   * @param {object} agent         the agent involved, whichever side it was on
   * @param {boolean} onPlayer     true when the player was the defender
   */
  _afterBlow(result, agent, onPlayer) {
    if (result.hitstop > 0) this.hitstop = Math.max(this.hitstop, result.hitstop);

    const pos = onPlayer ? this.player.pos : (agent?.body?.pos ?? this.player.pos);
    if (result.applied <= 0 && !result.killed && !result.parried) return;

    // A sword connecting with a person is loud, and the guards' own hearing model says
    // how loud: NOISE_COMBAT_HIT is authored at 22m, further than a sprint. Sent by
    // position rather than through the player's own noise latch, so agents near the blow
    // hear it once and only once.
    if (result.applied > 0 || result.killed) {
      this._worldNoise(STEALTH.NOISE_COMBAT_HIT, pos, 'hit-flesh');
    }
    if (result.parried) {
      // A parry is steel on steel and carries further than flesh, but it is the sound
      // of a fight that has not landed yet.
      this._worldNoise(STEALTH.NOISE_COMBAT_HIT * 0.7, pos, 'parry');
    }

    if (!result.killed) return;

    // A body falling is a second, lower sound, and then an alarm: nobody within earshot
    // of a killing keeps patrolling.
    this._worldNoise(STEALTH.NOISE_BODY_FALL, pos, 'body-fall');
    this.squad.notifyAll('alarm', { pos, radius: STEALTH.NOISE_COMBAT_HIT });

    if (!onPlayer) {
      // The objective is completed by an event, not by a variable being set somewhere.
      // Without this notification a guard dies, the counter does not move, and m06,
      // m10 and m11 can never be finished.
      this.missions.notify({ kind: EventKind.KILL, id: agent?.id ?? null });
    }
  }

  /**
   * A noise that happened at a place, not at the player.
   *
   * `local: false` is what keeps it out of the player's own loudness latch; see
   * _noiseSub. Agents receive it by position with a distance cutoff, which is the same
   * model the hearing system already uses for the player's footsteps.
   */
  /* ------------------------------------------------- takedowns and finishers */

  /**
   * Whether the guards can currently see the player.
   *
   * Read off the level the HUD already draws rather than recomputed here, so the meter
   * and the stealth layer cannot disagree about the one fact that decides whether a
   * takedown is allowed. 'combat' is the level that means somebody is openly hostile or
   * suspicion has reached SUSPICION_COMBAT_THRESHOLD; below it the player has not been
   * seen, whatever the guards suspect.
   */
  _isDetected() {
    return this._detectionLevel === 'combat';
  }

  /**
   * The guard the player could take down right now, or null.
   *
   * Nearest of the ones that qualify, because canTakedown() is a gate and not a choice:
   * two guards standing one behind the other both pass it, and taking the first in array
   * order would silence whichever the squad happened to build first.
   */
  _takedownCandidate() {
    const player = this.player;
    if (!player || player.isDead || !this.squad) return null;
    if (player.state === PlayerState.FINISHER) return null;
    const detected = this._isDetected();
    let best = null;
    let bestDist = Infinity;
    for (const agent of this.squad.agents) {
      if (agent.body.isDead) continue;
      const gate = canTakedown(player, agent.body, { detected });
      if (!gate.ok) continue;
      if (gate.distance < bestDist) { bestDist = gate.distance; best = agent; }
    }
    return best;
  }

  /**
   * Silence the guard the player crept up behind.
   *
   * Lethal, and deliberately not a kill for the mission system's purposes: the content
   * asks for takedowns and for kills as different things - m04/o5 wants a watching
   * servant silenced, m06/o5 wants guards faced - and counting one as the other would
   * let a player who never drew a sword complete a mission written about a fight.
   * Combatant.die() still emits COMBAT_KILL with source 'takedown', so anything drawing
   * a body or playing a death knows one happened; it is the objective that distinguishes.
   *
   * @returns {boolean} whether the takedown happened
   */
  _performTakedown(agent) {
    const player = this.player;
    if (!agent || agent.body.isDead || !player || player.isDead) return false;
    // Re-checked at the moment of the act rather than trusted from the frame the prompt
    // was published: the guard may have turned in between, and a takedown that works
    // from the front is not a takedown, it is a free kill.
    if (!canTakedown(player, agent.body, { detected: this._isDetected() }).ok) return false;

    const pos = agent.body.pos;
    agent.onDeath('takedown');

    // The commitment. TAKEDOWN_DURATION is the authored length of the act, and spending
    // it through the attack lock means the player cannot swing or dodge out of it - which
    // is what makes choosing to creep up behind a guard a decision with a cost.
    player.attackLock = Math.max(player.attackLock, STEALTH.TAKEDOWN_DURATION);
    this.hitstop = Math.max(this.hitstop, COMBAT.HITSTOP_LIGHT);

    // Quiet, and quiet by exactly the authored amount: NOISE_TAKEDOWN is 6.5m against
    // NOISE_COMBAT_HIT's 22m. _worldNoise already tells the squad by position and radius,
    // so a killing that nobody within earshot is deaf to is still a killing that carries
    // 6.5m and no further. A silent removal that rang out like a sword fight would take
    // away the only reason to use one.
    this._worldNoise(STEALTH.NOISE_TAKEDOWN, pos, 'takedown');
    this.missions.notify({ kind: EventKind.TAKEDOWN, id: agent.id });
    return true;
  }

  /**
   * Execute a guard who is nearly dead, in reach and in front.
   *
   * The gates were authored in combat.js and the camera's FINISHER mode was written and
   * tested; neither could be reached, because nothing ever called startFinisher() and
   * nothing ever put a victim in the camera context. Both are wired here.
   */
  _performFinisher(agent) {
    const player = this.player;
    const swing = player.swing;
    // One finisher per swing, for the reason resolveMelee() marks a swing consumed: the
    // active window lasts several frames and an execution must not happen three times.
    if (swing) swing.hitConsumed = true;

    const pos = agent.body.pos;
    this._finisherVictim = agent;
    player.startFinisher();
    agent.onDeath('finisher');

    this.hitstop = Math.max(this.hitstop, COMBAT.HITSTOP_KILL);
    // _worldNoise() alarms the squad at the radius it is given, so NOISE_COMBAT_HIT here
    // is already "everybody within 22m stops what they are doing". Calling notifyAll as
    // well would tell them twice about one execution.
    this._worldNoise(STEALTH.NOISE_COMBAT_HIT, pos, 'hit-flesh');
    this._worldNoise(STEALTH.NOISE_BODY_FALL, pos, 'body-fall');
    this.missions.notify({ kind: EventKind.KILL, id: agent.id });
    return true;
  }

  /**
   * What the camera needs to frame an execution: the victim, and how far through the
   * authored duration the act is. COMBAT.FINISHER_DURATION is the same number
   * player._updateFinisher() ends the state on, so the shot cannot outlive the act.
   */
  _finisherShot() {
    const victim = this._finisherVictim;
    if (!victim?.body) return null;
    return {
      victim: victim.body,
      elapsed: this.player.finisherTime ?? 0,
      duration: COMBAT.FINISHER_DURATION,
      orbitSpeed: 0.42,
    };
  }

  _worldNoise(radius, pos, source) {
    this.bus.emit(Events.NOISE_EMITTED, {
      radius, source, local: false,
      pos: { x: pos.x, y: pos.y, z: pos.z },
    });
    this.squad.notifyAll('alarm', { pos, radius });
  }

  /**
   * Lock-on: pick, cycle, and let go.
   *
   * player.lockTarget was read by the camera (CameraMode.LOCKED) and by the movement
   * system (MOVE.TURN_RATE_LOCKED) and written by nothing, so the authored lock-on
   * behaviour - a framed target and a faster turn - was unreachable. The switch
   * cooldown is honoured through pickLockTarget's own stickiness rather than
   * reimplemented here.
   */
  _updateLockOn(intent, dt) {
    this._lockSwitchCooldown = Math.max(0, this._lockSwitchCooldown - dt);
    const player = this.player;
    if (!player || player.isDead) { if (player) player.lockTarget = null; return; }

    if (intent.lockOn) {
      const current = player.lockTarget?.body ?? null;
      const next = pickLockTarget(this._lockCandidates(), player.pos, player.yaw, {
        current,
        canSwitch: this._lockSwitchCooldown <= 0,
        range: COMBAT.LOCK_ON_RANGE,
        angleDeg: COMBAT.LOCK_ON_ANGLE_DEG,
      });
      if (next && next !== current) this._lockSwitchCooldown = COMBAT.LOCK_ON_SWITCH_COOLDOWN;
      player.lockTarget = next ? this.squad.agents.find((a) => a.body === next) ?? null : null;
      return;
    }
    // Released, or the target died or walked out of range: let go. pickLockTarget breaks
    // the lock past LOCK_ON_BREAK_RANGE, so a chase does not stay locked to a guard the
    // player has run past.
    if (!player.lockTarget) return;
    const still = pickLockTarget([player.lockTarget.body], player.pos, player.yaw, {
      current: player.lockTarget.body, canSwitch: false,
      range: COMBAT.LOCK_ON_BREAK_RANGE, angleDeg: 180,
    });
    if (!still || player.lockTarget.body.isDead) player.lockTarget = null;
  }

  /** Living agents, as the bodies pickLockTarget wants. */
  _lockCandidates() {
    const out = [];
    for (const a of this.squad?.agents ?? []) {
      if (a.body && !a.body.isDead) out.push(a.body);
    }
    return out;
  }

  /**
   * What the AI is permitted to know.
   *
   * `lightLevel` comes from the lighting rig, which is also what decided how bright
   * this frame looks. That is the whole point: one number, two consumers, no way for
   * the picture and the perception to disagree.
   */
  _buildTruth() {
    const p = this.player.pos;
    const lit = this.lighting.lightLevelAt(p.x, p.z);
    const speed = Math.hypot(this.player.velocity.x, this.player.velocity.z);
    return {
      playerPos: p,
      stance: this.player.stance === Stance.CROUCH ? 'crouch' : 'stand',
      speed,
      lightLevel: lit.level,
      inShadow: this._inHidingSpot(),
      weather: this.weather,
      isNight: this.lighting.isNight,
      // The louder of the latched transient and the live locomotion level. Reading
      // only the latch is what left the AI deaf: nothing emitted the event, so the
      // truth carried 0 forever and no guard ever heard a sprint six metres away.
      noiseRadius: Math.max(this.noiseRadius, this.player.noiseRadius ?? 0),
    };
  }

  /**
   * What the audio is permitted to know.
   *
   * Built here rather than read out of the systems it describes, for the same reason
   * _buildTruth exists: the director should see the same facts the AI and the renderer
   * see, taken from the same place at the same moment. A director that reached into
   * the player controller for its own copy of the noise radius would eventually be
   * hearing something the guards are not.
   *
   * The listener is the camera, which already carries `position`, `right` and
   * `forward` from its own update earlier this frame.
   */
  _updateAudio(dt) {
    if (!this.audio) return;
    this.audio.update(dt, {
      player: {
        speed: Math.hypot(this.player.velocity.x, this.player.velocity.z),
        stance: this.player.stance === Stance.CROUCH ? 'crouch' : 'stand',
        onGround: this.player.grounded !== false,
        noiseRadius: this.player.noiseRadius ?? 0,
      },
      listener: this.camera,
      detection: this._detectionLevel ?? 'calm',
      region: this.regionId,
      weather: this.weather,
      // A cutscene owns the picture, so it owns the score too: the footsteps stop and
      // the mode and tempo are chosen for the scene rather than for the danger.
      cinematic: this.cinematics?.active === true,
      paused: this.paused === true,
    });
  }

  _inHidingSpot() {
    const p = this.player.pos;
    for (const h of this.space?.hidingSpots ?? []) {
      if (Math.hypot(h.x - p.x, h.z - p.z) < 1.1) return true;
    }
    return false;
  }

  /**
   * Tell the HUD how close to being caught the player is.
   *
   * The page has always listened for DETECTION and drawn a meter from it. Nothing
   * emitted DETECTION: the AI publishes SUSPICION_CHANGED, and only when a threshold
   * is crossed, which is the right granularity for an AI and the wrong one for a
   * meter - a bar that jumps from empty to "alerted" in one step tells the player
   * nothing about how much of a mistake they just made. So the runtime derives a
   * continuous level from the squad each step and publishes it on change.
   *
   * Aggregation lives here rather than in ai.js because it is a question about the
   * squad as a whole, and the squad is the runtime's.
   */
  _publishDetection() {
    let worst = 0;
    let hostile = false;
    for (const a of this.squad?.agents ?? []) {
      if (a.state === AIState.DEAD) continue;
      const s = Number.isFinite(a.suspicion) ? a.suspicion : 0;
      if (s > worst) worst = s;
      if (a.state === AIState.CHASE || a.state === AIState.ATTACK || a.state === AIState.CIRCLE) hostile = true;
    }
    // Four levels, because that is what the meter can draw: calm, suspicious,
    // alerted, combat. SUSPICION_SEARCH_THRESHOLD (68) sits between alerted and
    // combat and the HUD has no fourth colour or string for it, so it is not a
    // separate level here - inventing one would render as a raw key on screen.
    const level = hostile || worst >= STEALTH.SUSPICION_COMBAT_THRESHOLD ? 'combat'
      : worst >= STEALTH.SUSPICION_ALERT_THRESHOLD ? 'alerted'
        : worst > 0.5 ? 'suspicious' : 'calm';

    // Only on a change worth drawing. A meter emits at most a handful of times per
    // encounter instead of sixty times a second for nothing.
    const bucket = Math.round(worst);
    if (level === this._detectionLevel && bucket === this._detectionBucket) return;
    this._detectionLevel = level;
    this._detectionBucket = bucket;
    this.bus.emit(Events.DETECTION, { level, suspicion: worst, hostile, bucket });
  }

  _inCombat() {
    // The declared hostile states. Inventing strings here would silently report
    // 'not in combat' forever, which changes camera distance and the music bed
    // without ever looking like a bug.
    for (const a of this.squad?.agents ?? []) {
      if (a.state === AIState.CHASE || a.state === AIState.ATTACK || a.state === AIState.CIRCLE) {
        return true;
      }
    }
    return false;
  }

  _nearestInteractable() {
    const p = this.player.pos;
    let best = null;
    let bestD = LANDMARK_PROMPT_M;
    for (const it of this.space?.interactables ?? []) {
      const d = Math.hypot(it.x - p.x, it.z - p.z);
      if (d < bestD) { bestD = d; best = it; }
    }
    return best;
  }

  /**
   * Publish what the player can do right now, and do it when they ask.
   *
   * Emitted only when it changes. A prompt re-sent every frame makes the DOM rewrite
   * itself sixty times a second for text that has not moved, which on a phone is a
   * visible stutter caused entirely by the HUD.
   */
  _updateInteraction() {
    if (this.conversation?.active || this.cinematics?.active) return;
    const p = this.player.pos;
    // Checked before the world, not after it. A guard the player has crept up behind is
    // the most urgent thing on screen, and a prompt that loses to a nearby jar tells the
    // player the stealth layer is not listening.
    const victim = this._takedownCandidate();
    const target = victim ? null : this._nearestInteractable();
    const door = target ? null : this.space?.nearestDoor(p.x, p.z, DOOR_PROMPT_M);

    let next = null;
    if (victim) {
      next = {
        kind: 'takedown', id: victim.id,
        label: TAKEDOWN_LABEL[this.language],
        action: INTERACT_VERBS.takedown[this.language],
        hasTree: false,
      };
    } else if (target) {
      const presenting = this.missions.presentationAt(target.id);
      const verb = presenting
        ? INTERACT_VERBS.present
        : (INTERACT_VERBS[target.kind] ?? INTERACT_VERBS.examine);
      next = {
        kind: target.kind, id: target.id,
        label: this.language === 'ar' ? target.ar : target.en,
        action: verb[this.language],
        hasTree: !!TREE_BY_LANDMARK[target.id],
      };
    } else if (door) {
      const to = this.world.region(door.toRegion).region;
      next = {
        kind: 'door', id: door.toRegion,
        label: this.language === 'ar' ? to.ar : to.en,
        action: INTERACT_VERBS.door[this.language],
        hasTree: false,
      };
    }
    this._publishPrompt(next);

    // The action itself happens on a held interact with a latch, so walking past a
    // landmark does not examine it and holding the key does not examine it twice.
    const pressed = this.input.isActionDown('interact');
    if (!next) { this._interactLatch = false; return; }
    if (!pressed) { this._interactLatch = false; return; }
    if (this._interactLatch) return;
    this._interactLatch = true;
    this._actOn(next);
  }

  _publishPrompt(next) {
    // The verb is part of the identity. Standing at one landmark can offer "Talk" and
    // then "Read aloud" as the story advances, and comparing only id and kind would keep
    // the first text on screen forever - the HUD would be telling the player to do
    // something they have already done, at the exact moment the game wants something
    // else from them.
    const same = (!next && !this.prompt)
      || (next && this.prompt
        && next.id === this.prompt.id
        && next.kind === this.prompt.kind
        && next.action === this.prompt.action);
    if (same) return;
    this.prompt = next;
    this.bus.emit(Events.PROMPT, next);
  }

  /**
   * Do the thing the prompt offered.
   *
   * Every branch ends in a mission notification, because an objective is completed by
   * an event and not by a variable being set somewhere. A landmark the player
   * examines but that notifies nothing is a landmark that looks interactive and does
   * nothing, which is the most common way an investigation game feels broken.
   */
  _actOn(target) {
    if (target.kind === 'takedown') {
      const agent = this.squad?.agents?.find((a) => a.id === target.id) ?? null;
      this._performTakedown(agent);
      this._interactLatch = false;
      return;      // a person is not a landmark: nothing to notify about the place
    }
    if (target.kind === 'door') {
      this.travelTo(target.id);
      this._interactLatch = false;
      return;
    }
    if (target.kind === 'dialogue') {
      const res = this.conversation.startForInteractable({ id: target.id, kind: 'dialogue' });
      if (!res.ok) {
        // 'trapped' means the player cannot finish this scene with what they carry.
        // Saying so is the point: it tells them to go and find something.
        this.bus.emit(Events.TOAST, {
          kind: 'dialogue-refused', reason: res.reason, id: target.id,
        });
      }
    }
    this._notifyLandmark(target.id, target.kind);
  }

  /**
   * Tell the mission system what just happened at a landmark.
   *
   * LANDMARK is always sent, because GOTO objectives target landmarks and a player
   * who walks up and uses one has certainly arrived. The kind-specific event is what
   * completes EXAMINE, SEARCH, INTERACT and CLUE objectives, and for a clue landmark
   * the clue id comes from the content table rather than from a guess.
   */
  _notifyLandmark(landmarkId, kind) {
    this.missions.notify({ kind: EventKind.LANDMARK, id: landmarkId });
    // Presenting what the player carries is checked for every interaction, whatever its
    // kind: the story decides whether this landmark is the place, and it is the last
    // objective of the last mission that waits on the answer.
    this.missions.presentAt(landmarkId);
    switch (kind) {
      case 'examine':
        this.missions.notify({ kind: EventKind.EXAMINE, id: landmarkId });
        break;
      case 'search':
        this.missions.notify({ kind: EventKind.SEARCH, id: landmarkId });
        break;
      case 'clue': {
        // Sixteen landmarks offer a clue-flavored interaction and ten clues exist.
        // The other six - a hearth, an oil jar, a roadside stele - are places worth
        // reading that yield no evidence. They used to raise an ERROR here, so a
        // player inspecting a hearth saw a developer message on screen. The content
        // was right; the handler was not. An unbound landmark is simply examined:
        // the player asked, the game answered "nothing here", which is an answer.
        const clueId = CLUE_BY_LANDMARK.get(landmarkId);
        if (clueId) this.missions.notify({ kind: EventKind.CLUE, id: clueId });
        this.missions.notify({ kind: EventKind.EXAMINE, id: landmarkId });
        break;
      }
      case 'dialogue':
        // The conversation driver notifies EventKind.DIALOGUE when the scene is
        // actually finished, not here: starting a conversation is not completing one.
        break;
      default:
        this.missions.notify({ kind: EventKind.INTERACT, id: landmarkId });
        break;
    }
  }

  /** Move through a doorway, arriving at the matching door on the other side. */
  travelTo(regionId) {
    const target = this.world.region(regionId);
    // Arrive at the door that leads back, so turning around immediately shows the
    // way out. Arriving at the room's centre instead drops the player in the middle
    // of a space they have not seen, with no idea which door they came through.
    const back = target.doorTo(this.regionId);
    const spawn = back
      ? { x: back.spawn?.x ?? back.world.x, y: back.spawn?.y ?? 0, z: back.spawn?.z ?? back.world.z }
      : null;
    this.setRegion(regionId, spawn);
    this._doorLatch = false;
    return regionId;
  }

  /* -------------------------------------------------------------- visuals */

  _syncVisuals() {
    const p = this.player;
    const speed = Math.hypot(p.velocity.x, p.velocity.z);
    const attack = this._attackProgress();

    this.playerRig.update({
      x: p.pos.x, y: p.pos.y, z: p.pos.z, yaw: p.yaw,
      speed, stance: p.stance, attack,
      block: p.blocking === true, aim: this.aiming === true,
      alert: 'calm', dt: FIXED_DT,
    }, this._distanceToCamera(p.pos));

    for (const a of this.squad?.agents ?? []) {
      const rig = this.npcRigs.get(a.id);
      if (!rig) continue;
      const b = a.body ?? a;
      const aSpeed = b.velocity ? Math.hypot(b.velocity.x, b.velocity.z) : 0;
      rig.update({
        x: b.pos.x, y: b.pos.y, z: b.pos.z, yaw: b.yaw,
        speed: aSpeed, stance: b.stance ?? 'stand',
        alert: a.state ?? 'calm', dt: FIXED_DT,
      }, this._distanceToCamera(b.pos));
    }

    this.regionMesh.update(this.elapsed);
    this.lighting.focusShadows(p.pos.x, p.pos.y, p.pos.z);

    // The simulation camera is authoritative; the Three.js camera is a copy of it.
    const c = this.camera;
    this.camera3d.position.set(c.position.x, c.position.y, c.position.z);
    this.camera3d.up.set(0, 1, 0);
    this.camera3d.lookAt(c.lookAt.x, c.lookAt.y, c.lookAt.z);
    if (Math.abs(this.camera3d.fov - c.fov) > 1e-3) {
      this.camera3d.fov = c.fov;
      this.camera3d.updateProjectionMatrix();
    }
  }

  _distanceToCamera(pos) {
    const c = this.camera.position;
    return Math.hypot(c.x - pos.x, c.y - pos.y, c.z - pos.z);
  }

  /**
   * Swing progress in 0..1, derived from the combat system's own phase clock.
   *
   * The band boundaries are not decorative. CharacterRig treats everything below
   * 0.4 as wind-up and everything from 0.4 up as the strike, and 0.4 is exactly
   * where SwingPhase.ACTIVE begins - the frame the blade can actually connect. So
   * the arm accelerates forward on the frame the hit window opens, which is what
   * makes an attack readable and what stops the animation landing before or after
   * the damage. Guessing a duration here would break that alignment invisibly.
   */
  _attackProgress() {
    const swing = this.player?.swing;
    if (!swing || swing.phase === SwingPhase.IDLE) return 0;
    const profile = attackProfile(swing.kind ?? 'light') ?? attackProfile('light');
    const t = Number.isFinite(swing.t) ? swing.t : 0;
    const frac = (dur) => (dur > 0 ? Math.min(1, t / dur) : 1);
    switch (swing.phase) {
      case SwingPhase.WINDUP: return frac(profile.windup) * 0.4;
      case SwingPhase.ACTIVE: return 0.4 + frac(profile.active) * 0.2;
      case SwingPhase.RECOVERY: return 0.6 + frac(profile.recovery) * 0.4;
      case SwingPhase.COMBO: return 1;
      default: return 0;
    }
  }

  /* ---------------------------------------------------------------- saves */

  saveTo(slot) { return this.save.save(slot, this.missions.state); }
  loadFrom(slot) {
    const res = this.save.load(slot);
    if (!res.ok) return res;
    this.missions.restore(res.state.serialize());
    this.language = res.state.language ?? this.language;
    const region = res.state.missionId ? this.regionId : this.regionId;
    if (region) this.setRegion(region, null);
    this.bus.emit(Events.SAVE_LOADED, { slot, ok: true });
    return res;
  }

  setLanguage(language) {
    this.language = language === 'en' ? 'en' : 'ar';
    this.missions.setLanguage?.(this.language);
    this.conversation?.setLanguage(this.language);
    this.cinematics?.setLanguage(this.language);
    this.state.language = this.language;
    this.bus.emit(Events.LANGUAGE_CHANGED, { language: this.language });
    this.prompt = null;   // force the prompt to be republished in the new language
  }

  setWeather(weather) {
    if (!STEALTH.WEATHER_EXPOSURE[weather]) return false;
    this.weather = weather;
    this.lighting.apply(this.regionDef, {
      weather, fires: LightingRig.firesFrom(this.regionMesh),
    });
    this.bus.emit(Events.WEATHER_CHANGED, { weather });
    return true;
  }

  /* -------------------------------------------------------------- teardown */

  dispose() {
    this.stop();
    if (this._noiseSub) this.bus.off(Events.NOISE_EMITTED, this._noiseSub);
    this.save?.detachAutosave();
    this.input?.detach();
    this.regionMesh?.dispose();
    this.playerRig?.dispose();
    for (const rig of this.npcRigs.values()) rig.dispose();
    this.lighting?.dispose();
    this.mats?.dispose();
    this.renderer?.dispose();
  }

  /** Everything worth putting on screen while debugging, in one object. */
  diagnostics() {
    return {
      region: this.regionId,
      timeOfDay: this.regionDef?.timeOfDay ?? null,
      indoor: this.regionDef?.indoor === true,
      lighting: this.lighting.describe(),
      render: this.renderer.info,
      agents: this.telemetry.agents,
      agentStates: (this.squad?.agents ?? []).map((a) => a.state),
      player: {
        x: Number(this.player.pos.x.toFixed(2)),
        y: Number(this.player.pos.y.toFixed(2)),
        z: Number(this.player.pos.z.toFixed(2)),
        yaw: Number(this.player.yaw.toFixed(2)),
        stance: this.player.stance,
        health: this.player.health,
        speed: Number(Math.hypot(this.player.velocity.x, this.player.velocity.z).toFixed(2)),
      },
      prompt: this.prompt,
      conversation: this.conversation?.describe() ?? null,
      dialogueTreesReachable: Object.keys(TREE_BY_LANDMARK).length,
      cinematic: this.cinematics?.describe() ?? null,
      cinematicsPlayable: CINEMATIC_IDS.length,
      audio: this.audio ? this.audio.describe() : null,
      perception: this.lastTruth ? {
        lightLevel: Number(this.lastTruth.lightLevel.toFixed(3)),
        inShadow: this.lastTruth.inShadow,
        noiseRadius: Number(this.lastTruth.noiseRadius.toFixed(2)),
        speed: Number(this.lastTruth.speed.toFixed(2)),
        stance: this.lastTruth.stance,
        isNight: this.lastTruth.isNight,
        weather: this.lastTruth.weather,
      } : null,
      save: this.save.stats,
      input: this.input.stats,
      steps: this.steps,
      elapsed: Number(this.elapsed.toFixed(2)),
      boot: this.bootReport?.timings ?? null,
      timeOfDayPresets: Object.keys(TIME_OF_DAY),
      moveSpeeds: { walk: MOVE.WALK_SPEED, run: MOVE.RUN_SPEED, crouch: MOVE.CROUCH_SPEED },
    };
  }
}

/** Create, boot and start a game against a canvas element. */
export function bootGame(options = {}) {
  const game = new Game(options);
  const report = game.boot();
  game.start();
  return { game, report };
}

export { FIXED_DT, MAX_FRAME_DT, MAX_STEPS, NOISE_DECAY_S };
