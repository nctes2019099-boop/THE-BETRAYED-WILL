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
 * The perception truth carries `noiseRadius`. It is taken from the NOISE_EMITTED
 * events the movement system already produces and allowed to decay, rather than
 * derived here from speed. Two sources for one fact is how an AI ends up hearing
 * footsteps the player never made.
 */

import * as THREE from '../vendor/three/three.module.js';

import { EventBus, Events } from './core/bus.js';
import { CAM, MOVE, PERF, STEALTH } from './core/constants.js';
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
import { SaveSystem } from './sim/save.js';
import { SwingPhase, attackProfile } from './sim/combat.js';

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
    this.aiming = false;
    this.drawing = false;
    /** The last perception truth handed to the AI. See _fixedUpdate. */
    this.lastTruth = null;
    this.prompt = null;
    this.paused = false;

    this.telemetry = {
      bootMs: 0, fps: 0, frameMs: 0, steps: 0, drawCalls: 0,
      triangles: 0, agents: 0, regionBuildMs: 0, worstFrameMs: 0,
    };

    this._storageOpt = storage;
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

    // The movement system already reports how loud it is; the perception system is
    // given that number rather than a second opinion computed here.
    this._noiseSub = (p) => {
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
    };

    this.player.update(dt, intent, ctx);
    this.camera.update(dt, this.player, ctx);

    // Noise decays. The value came from the movement system; keeping it forever
    // would mean one footstep alerting every guard in the region permanently.
    this.noiseAge += dt;
    if (this.noiseAge > NOISE_DECAY_S) { this.noiseRadius = 0; this.noiseAge = Infinity; }

    this.missions.update(dt * 1000);   // MissionManager works in milliseconds

    // Recorded on the game, not only passed down. It is the value that decides
    // whether a guard can see the player, so it belongs in diagnostics, and a
    // consumer that has to wrap squad.update to observe it loses the wrapper the
    // moment a region change replaces the squad.
    this.lastTruth = this._buildTruth();
    this.squad.update(dt, this.lastTruth);
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
      noiseRadius: this.noiseRadius,
    };
  }

  _inHidingSpot() {
    const p = this.player.pos;
    for (const h of this.space?.hidingSpots ?? []) {
      if (Math.hypot(h.x - p.x, h.z - p.z) < 1.1) return true;
    }
    return false;
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
    const target = this._nearestInteractable();
    const door = target ? null : this.space?.nearestDoor(p.x, p.z, DOOR_PROMPT_M);

    let next = null;
    if (target) {
      const verb = INTERACT_VERBS[target.kind] ?? INTERACT_VERBS.examine;
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
    const same = (!next && !this.prompt)
      || (next && this.prompt && next.id === this.prompt.id && next.kind === this.prompt.kind);
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
