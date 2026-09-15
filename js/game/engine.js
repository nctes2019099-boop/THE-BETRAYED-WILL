import { CAST } from "../content/cast.js";
import { emptyFlags, fragmentCount } from "../content/flags.js";
import { SCENES, ENDINGS, npcSceneId } from "../content/story.js";
import { entitiesIn } from "./world.js";
import { walkableAt } from "./terrain.js";
import { createCamera, cameraFollow, cameraUpdate, applyPlaceCamera, cinematic } from "./camera.js";

export function createGame(world, audio) {
  const camera = createCamera();
  const state = {
    world,
    cast: CAST,
    flags: emptyFlags(),
    placeId: "harbor",
    place: world.places.harbor,
    map: world.maps.harbor,
    placeEntities: [],
    player: { x: 10.5, y: 22.5, vx: 0, vy: 0, facing: 1 },
    camera,
    mode: "play", // play | dialogue | combat | map | ending | paused
    scene: null,
    beat: 0,
    choice: 0,
    ending: null,
    prompt: null,
    combat: null,
    time: 0,
    steps: 0,
  };

  function loadPlace(id, x, y) {
    const p = world.places[id];
    if (!p) return;
    state.placeId = id;
    state.place = p;
    state.map = world.maps[id];
    state.placeEntities = entitiesIn(world, id).map((e) => ({ ...e }));
    state.player.x = x ?? p.spawn.x + 0.5;
    state.player.y = y ?? p.spawn.y + 0.5;
    applyPlaceCamera(camera, p);
    camera.x = state.player.x;
    camera.y = state.player.y;
    camera.tx = camera.x;
    camera.ty = camera.y;
    audio.setPlace(p.ambient);
  }

  loadPlace("harbor");

  function startScene(id) {
    const sc = SCENES[id];
    if (!sc) return;
    state.scene = sc;
    state.sceneId = id;
    state.beat = 0;
    state.choice = 0;
    state.mode = sc.combat ? "combat" : "dialogue";
    cinematic(camera, true);
    audio.talk();
    if (sc.combat) startCombat(sc);
    if (sc.set) applySet(sc.set);
  }

  function applySet(set) {
    for (const [k, v] of Object.entries(set)) state.flags[k] = v;
  }

  function currentBeat() {
    return state.scene?.beats[state.beat] || null;
  }

  function advanceDialogue(choiceIndex) {
    const beat = currentBeat();
    if (!beat) return;
    if (beat.choices && choiceIndex == null) return;
    if (beat.choices) {
      const c = beat.choices[choiceIndex];
      if (!c) return;
      if (c.set) applySet(c.set);
      if (c.ending) {
        finish(c.ending);
        return;
      }
    }
    state.beat++;
    audio.talk();
    if (state.beat >= state.scene.beats.length) closeScene();
  }

  function closeScene() {
    state.scene = null;
    state.mode = "play";
    cinematic(camera, false);
    applyPlaceCamera(camera, state.place);
  }

  function finish(id) {
    state.ending = ENDINGS[id];
    state.endingId = id;
    state.mode = "ending";
    cinematic(camera, true);
    audio.win();
  }

  function startCombat(sc) {
    state.combat = {
      hp: 3,
      foe: 3,
      t: 0,
      window: 0,
      hit: 0,
      over: false,
      scene: sc,
    };
    audio.danger();
  }

  function combatUpdate(dt, input) {
    const c = state.combat;
    if (!c || c.over) return;
    c.t += dt;
    if (c.window <= 0 && Math.random() < dt * 1.4) {
      c.window = 0.7;
      c.hit = 0;
    }
    if (c.window > 0) {
      c.window -= dt;
      if (input.pressed("use") || input.pressed("c1")) {
        if (c.window > 0.12) {
          c.foe--;
          c.hit = 1;
          audio.hit();
          camera.shake = 10;
        } else {
          c.hp--;
          audio.hit();
          camera.shake = 14;
        }
        c.window = 0;
      }
      if (c.window <= 0 && c.hit === 0) {
        c.hp--;
        camera.shake = 8;
      }
    }
    if (c.foe <= 0) {
      c.over = true;
      if (c.scene.set) applySet(c.scene.set);
      audio.win();
      state.mode = "dialogue";
      if (state.beat >= (state.scene?.beats.length || 1) - 1) closeScene();
    }
    if (c.hp <= 0) {
      c.hp = 3;
      c.foe = 3;
      state.player.x = state.place.spawn.x + 0.5;
      state.player.y = state.place.spawn.y + 0.5;
      audio.hit();
    }
  }

  function near(e, r = 1.05) {
    const dx = (e.wx ?? e.x) - state.player.x;
    const dy = (e.wy ?? e.y) - state.player.y;
    return dx * dx + dy * dy <= r * r;
  }

  function interact() {
    const list = state.placeEntities;
    for (const e of list) {
      if (!near(e)) continue;
      if (e.type === "npc") {
        const id = npcSceneId(e.who, state.flags);
        if (id) startScene(id);
        return;
      }
      if (e.type === "inspect" && e.scene) {
        startScene(e.scene);
        return;
      }
      if (e.type === "item" && !state.flags[e.flag]) {
        if (e.need && !state.flags[e.need]) continue;
        startScene(e.scene);
        return;
      }
      if (e.type === "combat" && !state.flags[e.flag]) {
        if (e.need && !state.flags[e.need]) continue;
        startScene(e.scene);
        return;
      }
      if (e.type === "exit") {
        if (e.need && !state.flags[e.need]) {
          state.prompt = { ar: "الطريق مغلق بعد.", en: "The way is still sealed.", t: 2.2 };
          return;
        }
        loadPlace(e.to, e.tx, e.ty);
        audio.ui();
        return;
      }
    }
  }

  function move(dt, axis) {
    const sp = CAST.lyen.speed;
    let nx = state.player.x + axis.x * sp * dt * 3.15;
    let ny = state.player.y + axis.y * sp * dt * 3.15;
    const tryX = { x: nx, y: state.player.y };
    const tryY = { x: state.player.x, y: ny };
    if (canStand(tryX.x, tryX.y)) state.player.x = tryX.x;
    if (canStand(tryY.x, tryY.y)) state.player.y = tryY.y;
    if (axis.x || axis.y) {
      state.steps += dt;
      if (state.steps > 0.32) {
        state.steps = 0;
        audio.step();
      }
    }
  }

  function canStand(x, y) {
    const pts = [
      [x - 0.22, y - 0.12],
      [x + 0.22, y - 0.12],
      [x - 0.22, y + 0.22],
      [x + 0.22, y + 0.22],
    ];
    return pts.every(([px, py]) => walkableAt(state.map, Math.floor(px), Math.floor(py)));
  }

  function wander(dt) {
    for (const e of state.placeEntities) {
      if (e.type !== "npc" || !e.wander) continue;
      e._t = (e._t || 0) + dt;
      e.wx = e.x + 0.5 + Math.sin(e._t * 0.6) * e.wander * 0.15;
      e.wy = e.y + 0.5 + Math.cos(e._t * 0.45) * e.wander * 0.1;
    }
  }

  function updatePrompt(dt) {
    if (state.prompt) {
      state.prompt.t -= dt;
      if (state.prompt.t <= 0) state.prompt = null;
    }
    const hit = state.placeEntities.find((e) => near(e, 1.1) && visible(e));
    state.hover = hit || null;
  }

  function visible(e) {
    if (e.type === "item" && state.flags[e.flag]) return false;
    if (e.type === "combat" && state.flags[e.flag]) return false;
    return true;
  }

  function update(dt, input) {
    state.time += dt;
    if (state.mode === "ending" || state.mode === "paused") {
      cameraUpdate(camera, dt);
      return;
    }
    if (state.mode === "dialogue") {
      const beat = currentBeat();
      if (beat?.choices) {
        if (input.pressed("up")) state.choice = Math.max(0, state.choice - 1);
        if (input.pressed("down")) state.choice = Math.min(beat.choices.length - 1, state.choice + 1);
        if (input.pressed("c1")) advanceDialogue(0);
        if (input.pressed("c2")) advanceDialogue(1);
        if (input.pressed("c3")) advanceDialogue(2);
        if (input.pressed("c4")) advanceDialogue(3);
        if (input.pressed("use")) advanceDialogue(state.choice);
      } else if (input.pressed("use")) advanceDialogue();
      cameraFollow(camera, state.player.x, state.player.y, 0, -0.4);
      cameraUpdate(camera, dt);
      return;
    }
    if (state.mode === "combat") {
      combatUpdate(dt, input);
      cameraFollow(camera, state.player.x, state.player.y, 0, 0);
      cameraUpdate(camera, dt);
      return;
    }
    if (state.mode === "map") {
      if (input.pressed("map") || input.pressed("use") || input.pressed("menu")) state.mode = "play";
      return;
    }
    if (input.pressed("map")) state.mode = "map";
    move(dt, input.axis());
    if (input.pressed("use")) interact();
    wander(dt);
    updatePrompt(dt);
    cameraFollow(camera, state.player.x, state.player.y, input.axis().x, input.axis().y);
    cameraUpdate(camera, dt);
  }

  function fragments() {
    return fragmentCount(state.flags);
  }

  function choose(i) {
    if (state.mode === "dialogue") advanceDialogue(i);
  }

  function next() {
    if (state.mode === "dialogue") {
      const beat = currentBeat();
      if (beat?.choices) advanceDialogue(state.choice);
      else advanceDialogue();
    }
  }

  return { state, update, loadPlace, startScene, fragments, finish, choose, next };
}
