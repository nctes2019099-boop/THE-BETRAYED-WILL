/**
 * THE BETRAYED WILL — battle-test.mjs
 *
 * Combat as the player actually reaches it: driven through the real Game, the real
 * input manager, the real frame loop and the real squad.
 *
 * ── Why this suite exists ───────────────────────────────────────────────────
 * Everything it tests already worked, and none of it happened.
 *
 * `resolveMelee()` gates reach, arc, vertical tolerance, i-frames, block, parry,
 * stagger, guard break, damage and death. `AISquad.resolveAttacks()` collects a
 * frame's agent swings in one deterministic order. `combat-test.mjs` exercised both
 * and passed. `ai-test.mjs` called `resolveAttacks()` directly and passed. And in the
 * game, `main.js` never called either one: nothing resolved the player's swings,
 * nothing resolved the guards', and the only damage path that ran was falling.
 *
 * So guards swung, animated, emitted COMBAT_ATTACK and rolled their cooldowns, and
 * dealt nothing. The player swung and dealt nothing. Three missions - m06, m10 and
 * m11, the last one in the game - carry a non-optional COMBAT objective, so the story
 * could not be finished, and every suite said it could.
 *
 * That is the failure mode this suite is built against, and it is why group E drives a
 * booted Game rather than calling the resolver. A test that calls `resolveMelee()`
 * proves the function works. Only a test that boots the game and presses a button
 * proves the game uses it.
 *
 * Group J generalises the lesson. It asks, of every function the combat system exports
 * and every event kind the mission system accepts, whether anything in `src/` actually
 * calls it - and requires anything that does not to be named in a pending list with a
 * reason. A system that is written, tested in isolation and never wired up now fails a
 * suite instead of shipping.
 *
 * Run: node tests/battle-test.mjs
 */

import { readFileSync, readdirSync } from 'node:fs';
import { describe, test, assert, runAndExit } from './harness.mjs';
import { bootGame, step } from './game-harness.mjs';
import { Events } from '../src/core/bus.js';
import { COMBAT, MOVE, STEALTH } from '../src/core/constants.js';
import { EventKind, MissionManager, StoryDirector } from '../src/sim/mission.js';
import { HITSTOP_TIME_SCALE, SwingPhase } from '../src/sim/combat.js';
import { MISSIONS, CLUE_MAP } from '../src/content/story.js';
import { LANDMARKS, REGIONS } from '../src/content/world-data.js';

/* ------------------------------------------------------------------ helpers */

/**
 * Stand an agent `metres` from the player, along the player's own facing.
 *
 * Placed relative to the yaw rather than at a fixed world offset, because
 * withinMeleeReach() tests the swing arc as well as the distance: an agent put at +x
 * from a player facing +z is out of the arc, and a test that "worked" would have been
 * measuring a miss.
 */
function place(game, agent, metres, { yawOffset = Math.PI } = {}) {
  const p = game.player.pos;
  const y = game.player.yaw;
  agent.body.pos.set(p.x + Math.sin(y) * metres, p.y, p.z + Math.cos(y) * metres);
  agent.body.yaw = y + yawOffset;
  return agent;
}

/**
 * Hold one or more agents at a fixed distance from the player, every frame.
 *
 * The frame loop runs the squad before it resolves combat, so an agent that is placed
 * once and left alone has already walked somewhere else by the time the swing is
 * judged - usually out of the arc. A resolution test has to control the geometry or it
 * is testing the AI's stride length. This wraps squad.update, which is the last thing
 * that moves anyone before the blows are counted.
 */
function pin(game, metres, agents = game.squad.agents) {
  const list = Array.isArray(agents) ? agents : [agents];
  const update = game.squad.update.bind(game.squad);
  game.squad.update = (dt) => {
    update(dt);
    for (const a of list) if (!a.body.isDead) place(game, a, metres);
  };
  return list;
}

/** Turn an agent hostile the way the game does: by telling it where the player is. */
function alarm(game, agent, frames = 20) {
  const p = game.player.pos;
  for (let i = 0; i < frames; i++) {
    agent.notify('alarm', { pos: { x: p.x, y: p.y, z: p.z } });
    step(game, 1);
  }
  return agent;
}

/** Press the attack button. It is an edge action, so one press is one swing. */
function swing(game) { assert.ok(game.input.pressAction('attackLight'), 'the attack press was refused'); }

/** Lock on. Also an edge action, so it is pressed rather than held. */
function lock(game) { assert.ok(game.input.pressAction('lockOn'), 'the lock press was refused'); }

/** The bus a booted game publishes on. */
function busOf(game) { return game.bus; }

/** A bus recorder for one event name. */
function record(bus, name) {
  const log = [];
  bus.on(name, (p) => log.push(p));
  return log;
}

/**
 * Put a blow in the agent's hand right now, at the moment of connection.
 *
 * resolveMelee() only tests a swing in ACTIVE phase, and waiting for the AI to choose
 * that moment makes a test about timing rather than about resolution. This sets the
 * phase the resolver reads and leaves the geometry - reach, arc, i-frames, block - to
 * the resolver, which is what is under test.
 */
function land(agent) {
  agent.body.swing.phase = SwingPhase.ACTIVE;
  agent.body.swing.hitConsumed = false;
  return agent;
}

/**
 * Hunt down an agent until it dies. Returns true if it died.
 *
 * `survive` tops the player up each frame. Whether a guard can kill the player is E8's
 * subject; a test about the player's damage output should not fail because the guard
 * happened to win the fight it was also having.
 */
function killWithTheSword(game, agent, { maxFrames = 900, survive = false } = {}) {
  for (let i = 0; i < maxFrames && !agent.body.isDead; i++) {
    if (survive) game.player.health = 100;
    if (i % 22 === 0) swing(game);
    step(game, 1);
  }
  return agent.body.isDead;
}

/**
 * ══════════════════════════════════════════════════════════════════════════
 * E — THE RUNTIME RESOLVES COMBAT
 * ══════════════════════════════════════════════════════════════════════════
 */
describe('battle — combat reaches the player', () => {
  test('E1 · a guard who swings at the player actually hurts him', () => {
    const { game, bus } = bootGame();
    const agent = game.squad.agents[0];
    const hits = record(bus, Events.COMBAT_HIT);
    const before = game.player.health;

    alarm(game, agent, 12);
    pin(game, 1.5, agent);
    for (let i = 0; i < 300; i++) step(game, 1);

    const dealt = before - game.player.health;
    assert.gt(dealt, 0,
      `a guard attacked for five seconds and the player took no damage (health ${before} -> ${game.player.health})`);
    assert.gt(hits.length, 0, 'no COMBAT_HIT was ever emitted from play');
    assert.gt(agent.body.telemetry.attacks, 0, 'the guard never committed a swing');
    assert.equal(agent.body.telemetry.hits, hits.length,
      'the guard counts hits the bus never carried, or the bus carries hits he does not count');
    assert.gt(agent.body.telemetry.damageDealt, 0, 'hits landed with no damage behind them');
    assert.ok(hits.every((h) => h.defender === game.player.id),
      'a blow aimed at the player named someone else');
  });

  test('E2 · the player who swings at a guard actually hurts him', () => {
    const { game, bus } = bootGame();
    const agent = game.squad.agents[0];
    const hits = record(bus, Events.COMBAT_HIT);
    const before = agent.body.health;

    pin(game, 1.6, agent);
    for (let i = 0; i < 240; i++) {
      if (i % 25 === 0) swing(game);      // one press per swing, as a player would
      step(game, 1);
      if (agent.body.isDead) break;
    }

    assert.lt(agent.body.health, before,
      `the player attacked for four seconds and the guard took no damage (${before} -> ${agent.body.health})`);
    const mine = hits.filter((h) => h.attacker === game.player.id);
    assert.gt(mine.length, 0, 'no COMBAT_HIT was emitted for a blow the player landed');
    assert.ok(mine.every((h) => h.defender === agent.id), 'the player\'s blow named the wrong defender');
  });

  test('E3 · killing a guard is an event the mission system is told about', () => {
    // This is the assertion the story depends on. A COMBAT objective counts
    // EventKind.KILL, and three required objectives across m06, m10 and m11 are of that
    // type. A guard who dies without notifying anything leaves a counter that never
    // moves and a game that cannot be finished.
    const { game, bus } = bootGame();
    const agent = game.squad.agents[0];
    const kills = record(bus, Events.COMBAT_KILL);
    const notified = [];
    const forward = game.missions.notify.bind(game.missions);
    game.missions.notify = (e) => {
      if (e?.kind === EventKind.KILL) notified.push(e);
      return forward(e);
    };

    pin(game, 1.6, agent);
    assert.ok(killWithTheSword(game, agent), 'the guard could not be killed by the player at all');

    assert.equal(kills.length, 1, `a death emitted ${kills.length} COMBAT_KILL events`);
    assert.equal(notified.length, 1, `a death reached the mission system ${notified.length} times`);
    assert.equal(notified[0].id, agent.id, 'the kill named the wrong guard');
    assert.ok(Number.isFinite(game.hitstop) && game.hitstop >= 0, 'hitstop was left in a broken state');
  });

  test('E4 · a required COMBAT objective completes from play alone', () => {
    // The end-to-end claim, at the level the story is actually blocked at. m06 needs two
    // kills; this drives a mission manager through real deaths and asks whether the
    // objective moved.
    const { game, bus } = bootGame();
    const mission = MISSIONS.find((m) => m.objectives.some((o) => o.type === 'combat' && !o.optional));
    assert.ok(mission, 'no mission has a required combat objective, so this proves nothing');
    const objective = mission.objectives.find((o) => o.type === 'combat' && !o.optional);

    const need = objective.count ?? 1;
    const prior = mission.objectives.slice(0, mission.objectives.indexOf(objective));
    assert.equal(game.missions.objectiveProgress(mission.id, objective.id), 0,
      'the objective started part-complete');

    // Walk the story to the mission with the director, stopping the moment its combat
    // objective is the one pending. The director can synthesise a kill itself, so the
    // handover has to happen before it gets the chance: everything up to here is the
    // driver, everything after is the player, and only the second half was ever broken.
    const director = new StoryDirector({ bus, manager: game.missions });
    const ready = () => game.missions.currentMission()?.id === mission.id
      && prior.every((o) => game.missions.state.isObjectiveDone(mission.id, o.id));
    director.begin();
    let guard = 0;
    while (!ready() && guard++ < 400) {
      const beat = director.step();
      if (beat.type === 'finished' || beat.type === 'stuck') break;
    }
    assert.ok(ready(),
      `the story could not reach ${mission.id} with its combat objective still pending `
      + `(${director.stuckReason ?? `ran out of steps at ${guard}`})`);
    assert.equal(game.missions.objectiveProgress(mission.id, objective.id), 0,
      'the director satisfied the combat objective on the way, so play is not what is being measured');

    // Starting the mission can hand the screen to a cinematic, and a cinematic stops the
    // player updating at all - the attack would be queued and never thrown, and the test
    // would report a resolver that does not resolve. Clear it the way the player would.
    if (game.cinematics?.active) {
      game.cinematics.skip();
      for (let i = 0; i < 10; i++) step(game, 1);
    }
    assert.notOk(game.cinematics?.active, 'a cinematic is still holding the player');
    assert.notOk(game.paused, 'the game is paused, so nothing can be measured');

    // The director drives the mission system only; the world is wherever boot left it.
    // What is under test is that real kills move a real objective, so the guards on
    // hand are the guards used.
    assert.gte(game.squad.agents.filter((a) => !a.body.isDead).length, need,
      `fewer than the ${need} living guards the objective requires`);

    // One victim at a time, with the rest of the region sent well away. Pinning the whole
    // squad at sword range stacks three guards on the player, and the stagger from being
    // hit cancels his own swings - he lands two blows in fifteen seconds and never kills
    // anybody. That is a fair result for a 3v1 and no answer at all to the question here,
    // which is whether a kill that really happened moves an objective that really exists.
    let victim = null;
    const update = game.squad.update.bind(game.squad);
    game.squad.update = (dt) => {
      update(dt);
      for (const a of game.squad.agents) {
        if (!a.body.isDead) place(game, a, a === victim ? 1.6 : 60);
      }
    };
    for (let k = 0; k < need; k++) {
      victim = game.squad.agents.find((a) => !a.body.isDead);
      assert.ok(victim, `ran out of guards before the ${need} kills the objective asks for`);
      assert.ok(killWithTheSword(game, victim, { survive: true }),
        `kill ${k + 1} of ${need} did not happen`);
    }
    assert.gte(game.missions.objectiveProgress(mission.id, objective.id), need,
      `${need} guards died in play and the objective still reads `
      + `${game.missions.objectiveProgress(mission.id, objective.id)}`);
  });

  test('E5 · one swing lands one hit, however many frames it overlaps', () => {
    // The most common melee bug in existence: an active window lasting a tenth of a
    // second applying its damage on every frame it overlaps, so one swing is seven hits
    // at 60fps. resolveMelee() prevents it with swing.hitConsumed; this proves the
    // runtime does not resolve around that by calling it once per agent per frame.
    const { game, bus } = bootGame();
    const agent = game.squad.agents[0];
    const hits = record(bus, Events.COMBAT_HIT);
    pin(game, 1.6, agent);
    const before = agent.body.health;

    swing(game);
    // Step through the whole swing and well past it, without pressing again.
    for (let i = 0; i < 90; i++) step(game, 1);

    const landed = hits.filter((h) => h.attacker === game.player.id);
    assert.equal(landed.length, 1, `${landed.length} hits came out of one swing`);
    assert.close(before - agent.body.health, landed[0].damage, 0.01,
      'the health that disappeared is not the damage the one hit reported');
  });

  test('E6 · holding block turns a hit into a block, and blocking costs stamina', () => {
    const { game, bus } = bootGame();
    const agent = game.squad.agents[0];
    const blocked = record(bus, Events.COMBAT_BLOCKED);
    alarm(game, agent, 12);
    pin(game, 1.5, agent);

    game.input.setTouchAction('block', true);      // block is a level action, held not pressed
    const healthBefore = game.player.health;
    const staminaBefore = game.player.stamina;
    for (let i = 0; i < 300; i++) {
      // Face the guard: blockCovers() tests the block arc, and a player facing away is
      // not blocking, he is being stabbed in the back.
      game.player.yaw = Math.atan2(
        agent.body.pos.x - game.player.pos.x,
        agent.body.pos.z - game.player.pos.z,
      );
      step(game, 1);
    }
    game.input.setTouchAction('block', false);

    assert.gt(blocked.length, 0, 'five seconds of blocking against an attacking guard blocked nothing');
    assert.ok(blocked.every((b) => b.defender === game.player.id), 'a block was credited to someone else');
    assert.lt(game.player.health, healthBefore + 1, 'blocking reduced nothing');
    assert.finite(game.player.stamina, 'blocking left stamina in a broken state');
    assert.lte(game.player.stamina, staminaBefore + 0.01, 'blocking a blow restored stamina');
  });

  test('E7 · a blow landing inside a dodge is refused', () => {
    // resolveMelee() checks invulnerability before block and parry, because a dodge
    // reliably beating a hit is the contract the i-frames make with the player. The
    // runtime must not resolve around that by testing the swing a frame early or late.
    const { game, bus } = bootGame();
    const agent = game.squad.agents[0];
    const dodged = record(bus, Events.PLAYER_DODGED);
    const hits = record(bus, Events.COMBAT_HIT);
    alarm(game, agent, 12);
    pin(game, 1.5, agent);

    // Dodge first, on a player who has not been hit yet: a stagger or the post-hit
    // i-frames would both refuse the dodge, and this test is about the dodge.
    game.input.pressAction('dodge');
    const frames = Math.ceil((MOVE.DODGE_IFRAME_START + 0.02) / (17 / 1000));
    for (let i = 0; i < frames; i++) step(game, 1);
    assert.equal(game.player.invulnerableReason, 'dodge-iframes',
      `the dodge window did not grant i-frames (dodgeTime ${game.player.dodgeTime?.toFixed(3)})`);
    assert.gt(dodged.length, 0, 'dodging emitted nothing for the camera or the audio to react to');

    const during = game.player.health;
    land(agent);
    step(game, 1);
    const dodgedHits = hits.filter((h) => h.defender === game.player.id).length;
    assert.equal(game.player.health, during,
      'a blow landed on a player inside the dodge i-frame window');

    // Control: the identical blow, once the dodge is over, hurts. Without this the test
    // would also pass if the agent simply never connected.
    for (let i = 0; i < 60; i++) step(game, 1);
    game.player.iframes = 0;
    game.player.hitIframes = 0;
    assert.equal(game.player.invulnerableReason, null, 'the player was still invulnerable after the dodge');
    const before = game.player.health;
    land(agent);
    step(game, 1);
    assert.lt(game.player.health, before,
      'the control blow did not land either, so the dodge case above proved nothing');
    assert.gt(hits.filter((h) => h.defender === game.player.id).length, dodgedHits,
      'the control blow was not counted');
  });

  test('E8 · the player can be killed by a guard, and the game says so', () => {
    const { game, bus } = bootGame();
    const agent = game.squad.agents[0];
    const deaths = record(bus, Events.PLAYER_DIED);
    alarm(game, agent, 12);
    pin(game, 1.5, agent);
    game.player.health = 6;      // a wounded player, which is how this happens in play

    for (let i = 0; i < 600 && !game.player.isDead; i++) step(game, 1);

    assert.ok(game.player.isDead,
      `a guard attacked a player on 6 health for ten seconds and did not kill him (${game.player.health} left)`);
    assert.equal(deaths.length, 1, `a death emitted ${deaths.length} PLAYER_DIED events`);

    // And combat stops being resolved against a corpse, or the body keeps taking hits.
    const health = game.player.health;
    for (let i = 0; i < 60; i++) step(game, 1);
    assert.equal(game.player.health, health, 'a dead player kept being damaged');
  });

  test('E9 · a dead guard stops fighting back', () => {
    const { game } = bootGame();
    const agent = game.squad.agents[0];
    pin(game, 1.6, agent);
    assert.ok(killWithTheSword(game, agent), 'the guard did not die, so this cannot test what follows');

    const attacks = agent.body.telemetry.attacks;
    const health = game.player.health;
    pin(game, 1.5, game.squad.agents.filter((a) => a !== agent && !a.body.isDead));
    for (let i = 0; i < 120; i++) step(game, 1);
    assert.equal(agent.body.telemetry.attacks, attacks, 'a corpse kept swinging');
    assert.equal(game.player.health, health, 'a corpse kept hurting the player');
    assert.ok(game.squad.alive.every((a) => a !== agent), 'the dead guard is still listed as alive');
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════
 * F — THE FIGHT IS HEARD
 * ══════════════════════════════════════════════════════════════════════════
 */
describe('battle — a fight is not silent', () => {
  test('F1 · a landed blow makes noise, at the radius the constants author', () => {
    const { game, bus } = bootGame();
    const agent = game.squad.agents[0];
    const noises = record(bus, Events.NOISE_EMITTED);
    pin(game, 1.6, agent);
    for (let i = 0; i < 240; i++) {
      if (i % 25 === 0) swing(game);
      step(game, 1);
      if (noises.some((n) => n.source === 'combat-hit')) break;
    }
    const hit = noises.find((n) => n.source === 'combat-hit');
    assert.ok(hit, 'a sword connecting with a person made no sound at all');
    assert.equal(hit.radius, STEALTH.NOISE_COMBAT_HIT,
      'the noise was not the authored combat radius, so the hearing model and the fight disagree');
    assert.equal(hit.local, false, 'a blow landing on a guard was reported as the player being loud');
    assert.ok(hit.pos && Number.isFinite(hit.pos.x),
      'the noise had no position, so nobody can be told where it was');
  });

  test('F2 · that noise is not folded into the player\'s own loudness', () => {
    // One fact, one path. Agents near the blow are told by position; the player's own
    // noise radius is how loud the player is. Feeding both would make every agent in
    // the region hear the same sword hit twice and raise suspicion twice as fast as
    // authored - the AI cheating by double-counting.
    const { game } = bootGame();
    const agent = game.squad.agents[0];
    pin(game, 1.6, agent);
    const guardHealth = agent.body.health;
    game.noiseRadius = 0;
    game.noiseAge = Infinity;
    for (let i = 0; i < 240; i++) {
      if (i % 25 === 0) swing(game);
      step(game, 1);
      if (agent.body.health < guardHealth) break;
    }
    assert.lt(agent.body.health, guardHealth, 'no blow landed, so there was nothing to be loud');
    assert.equal(game.noiseRadius, 0,
      `a blow landing on a guard set the player's own noise radius to ${game.noiseRadius}`);
  });

  test('F3 · a killing blow alarms the guards within earshot and only them', () => {
    const { game } = bootGame();
    const agents = game.squad.agents;
    assert.gte(agents.length, 2, 'the region needs more than one guard for this to mean anything');
    const victim = agents[0];
    const near = agents[1];
    const far = agents.length > 2 ? agents[2] : null;
    const beyond = STEALTH.NOISE_COMBAT_HIT * 4;

    // Pin the victim in reach of the sword, the witness beside him, and the third guard
    // outside the authored radius. Re-pinned every frame because they all move.
    const update = game.squad.update.bind(game.squad);
    game.squad.update = (dt) => {
      update(dt);
      if (!victim.body.isDead) place(game, victim, 1.6);
      place(game, near, 3.0, { yawOffset: 0 });
      if (far) {
        far.body.pos.set(
          victim.body.pos.x + beyond, victim.body.pos.y, victim.body.pos.z,
        );
      }
    };

    assert.ok(killWithTheSword(game, victim), 'the victim did not die, so there was no alarm to raise');
    for (let i = 0; i < 30; i++) step(game, 1);      // let the alarm propagate
    assert.gte(near.suspicion, STEALTH.SUSPICION_COMBAT_THRESHOLD,
      'a guard three metres from a killing carried on as though nothing happened');
    if (far) {
      assert.lt(far.suspicion, STEALTH.SUSPICION_COMBAT_THRESHOLD,
        `a guard ${beyond}m away was alarmed by a death beyond the authored radius`);
    }
  });

  test('F4 · every world noise a fight makes carries a usable source and position', () => {
    // The noise source string is the cue id, which is how one authored value drives both
    // the hearing model and what the player hears. A source the catalogue does not know
    // is a silent event, and a noise with no position cannot be panned or investigated.
    const { game, bus } = bootGame();
    const agent = game.squad.agents[0];
    const noises = record(bus, Events.NOISE_EMITTED);
    pin(game, 1.6, agent);
    killWithTheSword(game, agent);

    const world = noises.filter((n) => n.local === false);
    assert.gt(world.length, 0, 'a whole fight and a death produced no world noise');
    const sources = new Set(world.map((n) => n.source));
    assert.ok(sources.has('combat-hit'), 'a blow connecting never made its noise');
    assert.ok(sources.has('body-fall'), 'a body hitting the floor was silent');
    for (const n of world) {
      assert.ok(n.source && n.source.length > 2, `a noise had no usable source: "${n.source}"`);
      assert.ok(n.pos && Number.isFinite(n.pos.x) && Number.isFinite(n.pos.z),
        `${n.source} had no position`);
      assert.ok(Number.isFinite(n.radius) && n.radius > 0, `${n.source} had no radius`);
    }
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════
 * G — IMPACT FREEZE
 * ══════════════════════════════════════════════════════════════════════════
 */
describe('battle — hitstop', () => {
  test('G1 · a landed blow freezes the world for the authored time', () => {
    const { game } = bootGame();
    const agent = game.squad.agents[0];
    assert.equal(game.hitstop, 0, 'the game started frozen');
    pin(game, 1.6, agent);
    let saw = 0;
    for (let i = 0; i < 240; i++) {
      if (i % 25 === 0) swing(game);
      step(game, 1);
      if (game.hitstop > 0) { saw = game.hitstop; break; }
    }
    assert.gt(saw, 0, 'a blow landed and nothing froze');
    assert.within(saw, COMBAT.HITSTOP_LIGHT - 1e-6, COMBAT.HITSTOP_KILL,
      `hitstop ${saw} is outside the authored band ${COMBAT.HITSTOP_LIGHT}..${COMBAT.HITSTOP_KILL}`);
  });

  test('G2 · hitstop expires in real time, and the world resumes', () => {
    const { game } = bootGame();
    game.hitstop = COMBAT.HITSTOP_KILL;
    // One frame at a time on the real dt. The freeze must end after that much real time,
    // not after that much scaled time: scaling the timer by the same factor it scales
    // the world is how an impact freeze becomes permanent, because the clock that ends
    // the freeze is the clock the freeze slows.
    const frames = Math.ceil(COMBAT.HITSTOP_KILL / (17 / 1000)) + 3;
    for (let i = 0; i < frames; i++) step(game, 1);
    assert.equal(game.hitstop, 0,
      `hitstop still reads ${game.hitstop} after ${COMBAT.HITSTOP_KILL}s of real time`);

    // And the player can still move afterwards, which is how a stuck freeze shows up.
    game.input.handleEvent('keydown', { code: 'KeyD' });
    step(game, 20);
    assert.gt(Math.hypot(game.player.velocity.x, game.player.velocity.z), 0.5,
      'the world never resumed after the freeze');
    game.input.handleEvent('keyup', { code: 'KeyD' });
  });

  test('G3 · while frozen the world advances slowly, not not at all', () => {
    assert.within(HITSTOP_TIME_SCALE, 0.01, 0.5,
      'a freeze scale of zero looks like a crash and a scale near one looks like nothing happened');
    const { game } = bootGame();
    game.hitstop = 0.5;
    const before = game.elapsed;
    step(game, 1);
    assert.gt(game.elapsed, before, 'a frame was dropped entirely rather than slowed');
    assert.ok(game.hitstop > 0, 'one frame cleared a half-second freeze');
    // The player's clock must have been scaled, or the freeze is decorative.
    game.input.pressAction('attackLight');
    step(game, 1);
    const t = game.player.swing.t;
    assert.finite(t, 'the scaled clock produced a non-finite swing time');
    assert.lt(t, 17 / 1000, `the swing advanced by a whole frame (${t}) during a freeze`);
  });

  test('G4 · a poisoned hitstop cannot survive into the next frame', () => {
    // advanceHitstop() validates its input because hitstop scales the simulation clock:
    // a NaN timer silently switches impact feedback off for the rest of the session, and
    // NaN serializes to null and deserializes straight back to NaN.
    const { game } = bootGame();
    for (const bad of [NaN, Infinity, -Infinity, -1, null, undefined, 'x', {}]) {
      game.hitstop = bad;
      step(game, 4);
      assert.ok(Number.isFinite(game.hitstop) && game.hitstop >= 0,
        `hitstop ${String(bad)} left the clock at ${game.hitstop}`);
    }
    game.hitstop = NaN;
    step(game, 2);
    assert.doesNotThrow(() => game.diagnostics(), 'a poisoned clock broke diagnostics');
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════
 * H — LOCK-ON
 * ══════════════════════════════════════════════════════════════════════════
 */
describe('battle — lock-on', () => {
  test('H1 · the lock key takes a target, and the camera frames it', () => {
    const { game } = bootGame();
    const agent = place(game, game.squad.agents[0], 6, { yawOffset: 0 });
    pin(game, 6, agent);
    assert.equal(game.player.lockTarget, null, 'the game started locked on');
    lock(game);
    step(game, 1);
    assert.equal(game.player.lockTarget?.id, agent.id, 'the lock key took no target');
    assert.equal(game.camera.mode, 'locked',
      'player.lockTarget was set and the camera kept its gameplay framing');
  });

  test('H2 · nothing is locked beyond the authored range or outside the cone', () => {
    const { game } = bootGame();
    const agent = game.squad.agents[0];
    place(game, agent, COMBAT.LOCK_ON_RANGE + 4, { yawOffset: 0 });
    lock(game);
    step(game, 1);
    assert.equal(game.player.lockTarget, null,
      `a guard ${COMBAT.LOCK_ON_RANGE + 4}m away was locked at a ${COMBAT.LOCK_ON_RANGE}m range`);

    // In range but directly behind: the cone is the point of a lock, because it is what
    // makes turning to face a threat a decision rather than a free action.
    const p = game.player.pos;
    const y = game.player.yaw;
    agent.body.pos.set(p.x - Math.sin(y) * 5, p.y, p.z - Math.cos(y) * 5);
    lock(game);
    step(game, 1);
    assert.equal(game.player.lockTarget, null, 'a guard directly behind the player was locked');
  });

  test('H3 · the lock lets go past the break range, and does not snap back', () => {
    const { game } = bootGame();
    const agent = game.squad.agents[0];
    place(game, agent, 6, { yawOffset: 0 });
    lock(game);
    step(game, 1);
    assert.equal(game.player.lockTarget?.id, agent.id, 'the lock did not take');

    // Unpin, then put the guard well outside the break range and leave him there.
    place(game, agent, COMBAT.LOCK_ON_BREAK_RANGE + 6, { yawOffset: 0 });
    const update = game.squad.update.bind(game.squad);
    game.squad.update = (dt) => { update(dt); place(game, agent, COMBAT.LOCK_ON_BREAK_RANGE + 6, { yawOffset: 0 }); };
    step(game, 4);
    assert.equal(game.player.lockTarget, null, 'the lock was held on a guard the player has run away from');
    assert.notEqual(game.camera.mode, 'locked', 'the camera is still framing a target that is gone');
  });

  test('H4 · a target that dies releases the lock', () => {
    const { game } = bootGame();
    const agent = place(game, game.squad.agents[0], 6, { yawOffset: 0 });
    pin(game, 6, agent);
    lock(game);
    step(game, 1);
    assert.equal(game.player.lockTarget?.id, agent.id, 'the lock did not take');
    agent.onDeath('test');
    step(game, 3);
    assert.equal(game.player.lockTarget, null, 'the player stayed locked onto a corpse');
    assert.notEqual(game.camera.mode, 'locked', 'the camera kept framing the corpse');
  });

  test('H5 · the switch cooldown stops the lock flickering between targets', () => {
    const { game } = bootGame();
    const [a, b] = game.squad.agents;
    assert.ok(b, 'this needs two guards');
    place(game, a, 5, { yawOffset: 0 });
    place(game, b, 7, { yawOffset: 0 });
    const update = game.squad.update.bind(game.squad);
    game.squad.update = (dt) => {
      update(dt);
      place(game, a, 5, { yawOffset: 0 });
      place(game, b, 7, { yawOffset: 0 });
    };

    lock(game);
    step(game, 1);
    const first = game.player.lockTarget;
    assert.ok(first, 'the first press took no target');

    // Immediately press again. Inside the cooldown the current target is kept even if a
    // better one exists, which is what stops the lock jittering under a thumb.
    game._lockSwitchCooldown = COMBAT.LOCK_ON_SWITCH_COOLDOWN;
    lock(game);
    step(game, 1);
    assert.equal(game.player.lockTarget?.id, first.id, 'the lock switched target inside its own cooldown');
    assert.gt(game._lockSwitchCooldown, 0, 'pressing the lock key did not start a cooldown');
  });

  test('H6 · a locked player turns at the locked rate, which is the reason to lock', () => {
    assert.notEqual(MOVE.TURN_RATE_LOCKED, MOVE.TURN_RATE_GROUND,
      'TURN_RATE_LOCKED equals TURN_RATE_GROUND, so locking on changes nothing about handling');
    assert.gt(MOVE.TURN_RATE_LOCKED, MOVE.TURN_RATE_GROUND,
      'locking on turns the player more slowly than not locking on');

    const { game } = bootGame();
    const agent = game.squad.agents[0];
    place(game, agent, 6, { yawOffset: 0 });
    pin(game, 6, agent);
    // Point the body somewhere other than at the guard, then lock and hold strafe.
    game.player.yaw = agent.body.pos.x > game.player.pos.x ? 0 : Math.PI;
    game.input.handleEvent('keydown', { code: 'KeyD' });
    step(game, 1);
    lock(game);
    step(game, 1);
    assert.ok(game.player.lockTarget, 'the lock did not take');
    const lockedYaw = game.player.yaw;
    for (let i = 0; i < 30; i++) step(game, 1);
    assert.notEqual(game.player.yaw, lockedYaw, 'a locked player never turned');
    game.input.handleEvent('keyup', { code: 'KeyD' });
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════
 * I — ESCAPE UNDER PURSUIT
 * ══════════════════════════════════════════════════════════════════════════
 */
describe('battle — escaping a region while hunted', () => {
  /** Every notify the mission system receives, recorded without disturbing it. */
  function spy(game) {
    const log = [];
    const forward = game.missions.notify.bind(game.missions);
    game.missions.notify = (e) => { log.push(e); return forward(e); };
    return log;
  }
  const escapes = (log) => log.filter((e) => e.kind === EventKind.ESCAPE);

  test('I1 · leaving a region with a guard in pursuit is an escape', () => {
    // m07 has two required ESCAPE objectives - out of the servants' passage and across
    // the tunnel - and the matcher needs both the region and `pursued`. Neither was ever
    // notified from play, so the mission could not be finished.
    const { game } = bootGame();
    const log = spy(game);
    game.travelTo('palace-hall');
    assert.equal(escapes(log).length, 0, 'an unpursued region change reported an escape');

    const agent = game.squad.agents[0];
    alarm(game, agent, 16);
    assert.ok(game._inCombat(), 'the guard was not in pursuit, so this cannot test the escape');

    game.travelTo('palace-court');
    assert.equal(escapes(log).length, 1, 'leaving a region while hunted reported nothing');
    assert.equal(escapes(log)[0].id, 'palace-hall',
      'the escape named the region arrived at rather than the one escaped from');
    assert.equal(escapes(log)[0].pursued, true, 'the matcher requires pursued and it was not set');
  });

  test('I2 · the pursuit is judged before the squad is replaced', () => {
    // setRegion() repopulates the agents, so "was I being chased" has to be answered from
    // the squad that was doing the chasing. Asking afterwards reads a fresh, idle squad
    // and reports no pursuit however hard the player was hunted.
    const { game } = bootGame();
    const log = spy(game);
    alarm(game, game.squad.agents[0], 16);
    assert.ok(game._inCombat());
    game.travelTo('palace-hall');
    assert.equal(escapes(log).length, 1,
      "the pursuit was judged against the new region's guards");
    assert.notOk(game._inCombat(), 'the new region started with the old pursuit still active');
  });

  test('I3 · walking out of a quiet region is not an escape', () => {
    const { game } = bootGame();
    const log = spy(game);
    for (const to of ['palace-hall', 'palace-court', 'palace-hall']) {
      step(game, 10);
      game.travelTo(to);
    }
    assert.equal(escapes(log).length, 0,
      'an ordinary region change reported an escape, which would complete m07 without a chase');
  });

  test('I4 · booting does not report an escape from a region never entered', () => {
    const { game } = bootGame();
    const log = spy(game);
    assert.equal(game.regionId, 'palace-court', 'boot did not place the player');
    step(game, 30);
    assert.equal(escapes(log).length, 0, 'the first frames reported an escape from nowhere');
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════
 * J — IS IT WIRED?
 * ══════════════════════════════════════════════════════════════════════════
 */

/**
 * Combat API that is not called from anywhere in src/ outside its own module.
 *
 * Each entry is a system that is authored, unit-tested, and unreachable in play. They
 * are listed here rather than left to be discovered, and the test below fails if one of
 * them becomes reachable without being struck from this list - so the list cannot
 * quietly go stale in the other direction either.
 */
const PENDING_WIRING = Object.freeze({
  canTakedown: 'Stealth takedowns: the gates are authored and STEALTH.NOISE_TAKEDOWN exists, but nothing binds an input to them. m04 o5 (optional) waits on it, so it does not block the story.',
  canFinisher: 'Finishers: the gates are authored and the camera already has a FINISHER mode nothing can reach, because the only way to get a guard into that state is a takedown.',
});

/**
 * Mission event kinds nothing in play ever notifies.
 *
 * The story driver inside mission.js synthesises these to prove the story is solvable,
 * which is a real and useful proof - and is exactly what let three required COMBAT
 * objectives look satisfiable while the game could not kill anybody.
 */
const PENDING_EVENTS = Object.freeze({
  [EventKind.TAKEDOWN]: 'Waits on canTakedown above. m04 o5 is optional, so it does not block the story.',
});

/** Strip comments, so prose mentioning a function is not counted as calling it. */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

/** Every .js file under src/, read once. */
function readSrc() {
  const root = new URL('../src/', import.meta.url);
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) { walk(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const text = stripComments(readFileSync(new URL(entry.name, dir), 'utf8'));
      out.push({ path: `${prefix}${entry.name}`, text });
      // mission.js holds two different things in one file: the MissionManager API the
      // game calls, and StoryDirector's #satisfy(), an autopilot that synthesises events
      // to prove the story is solvable. Treating them as one file is exactly what let a
      // required objective look reachable while nothing in play could produce its event,
      // so they are split at the autopilot's entry point and audited separately.
      if (`${prefix}${entry.name}` === 'sim/mission.js') {
        const cut = text.indexOf('#satisfy(mission, o) {');
        assert.gt(cut, 0, 'mission.js no longer has a #satisfy(), so the split point moved');
        out.push({ path: 'sim/mission.js#manager', text: text.slice(0, cut) });
        out.push({ path: 'sim/mission.js#driver', text: text.slice(cut) });
      }
    }
  };
  walk(root, '');
  return out;
}

describe('battle — is any of it wired up?', () => {
  const SRC = readSrc();
  assert.gt(SRC.length, 30, 'the src/ scan found almost nothing, so this group proves nothing');
  const MAIN = SRC.find((f) => f.path === 'main.js');
  assert.ok(MAIN, 'main.js was not found by the scan');
  // callSites() must not read the split mission.js fragments as separate files, or a
  // call in the manager half would be counted twice.
  const FILES = SRC.filter((f) => !f.path.includes('#'));

  /**
   * Real call sites of `name(` anywhere in src/, including inside its own module.
   *
   * Counting method calls (`this.squad.resolveAttacks(`) matters: that is exactly how the
   * runtime reaches the squad, and a scan that only accepted bare calls reported the one
   * function that IS wired as dead. Declarations and re-exports are excluded, comments
   * have already been stripped.
   */
  function callSites(name) {
    const decl = new RegExp(`(function|const|let|var|class)\\s+${name}\\b`);
    const call = new RegExp(`(^|[^\\w$])${name}\\s*\\(`);
    const hits = [];
    for (const file of FILES) {
      for (const line of file.text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || decl.test(trimmed)) continue;
        if (trimmed.startsWith('import') || trimmed.startsWith('export {')) continue;
        if (call.test(line)) hits.push(`${file.path}: ${trimmed.slice(0, 60)}`);
      }
    }
    return hits;
  }

  test('J1 · every combat resolver the runtime needs is called by the runtime', () => {
    const required = ['resolveMelee', 'resolveAttacks', 'pickLockTarget', 'advanceHitstop', 'hitstopActive'];
    const dead = required.filter((name) => callSites(name).length === 0);
    assert.deepEqual(dead, [],
      `combat API nothing in src/ calls, so it is written, tested and never happens: ${dead.join(', ')}`);

    // And the frame loop is among the callers, not just another library module. This is
    // the assertion that was missing when resolveAttacks() existed, was tested, and ran
    // only from ai-test.mjs.
    for (const name of required) {
      assert.ok(MAIN.text.includes(`${name}(`),
        `main.js does not call ${name}, so the frame loop is not the thing resolving combat`);
    }
  });

  test('J2 · combat API that is not wired is named, with a reason, and nothing else is missing', () => {
    const audited = ['canTakedown', 'canFinisher', 'feedbackFor', 'isBackstab', 'blockCovers', 'withinMeleeReach'];
    const unaccounted = [];
    const stillPending = [];
    for (const name of audited) {
      const sites = callSites(name);
      if (sites.length === 0) {
        if (!PENDING_WIRING[name]) unaccounted.push(`${name}: unreachable and not declared pending`);
        else stillPending.push(name);
      } else if (PENDING_WIRING[name]) {
        unaccounted.push(`${name}: listed as pending but now called from ${sites[0]}`);
      }
    }
    assert.deepEqual(unaccounted, [], 'combat API that is neither wired nor declared pending');
    // feedbackFor, isBackstab, blockCovers and withinMeleeReach are all used inside
    // combat.js by resolveMelee itself, so they are reachable through it.
    assert.deepEqual(stillPending.sort(), Object.keys(PENDING_WIRING).sort(),
      'the pending list and the audit disagree about what is still unwired');
    for (const [name, reason] of Object.entries(PENDING_WIRING)) {
      assert.gt(reason.length, 40, `${name}: a reason too short to act on`);
    }
  });

  test('J3 · every mission event kind is either notified in play or declared pending', () => {
    const kinds = Object.values(EventKind);
    assert.gt(kinds.length, 8, 'the event vocabulary shrank');
    // Play-reachable means the game itself can produce the event: it notifies one
    // directly, or it calls a MissionManager method that does. Driver-only means the
    // autopilot is the sole producer, which proves the story is solvable and proves
    // nothing about whether the player can solve it.
    const PLAY = ['main.js', 'sim/conversation.js', 'sim/mission.js#manager'];
    const DRIVER = 'sim/mission.js#driver';
    const unaccounted = [];
    // The source writes EventKind.KILL, so the KEY is what to look for; the value is what
    // the pending tables and the matchers are keyed by.
    for (const [key, value] of Object.entries(EventKind)) {
      // A notification is constructed as `{ kind: EventKind.X, ... }`. The MATCHERS table
      // compares against every kind there is and produces none of them, so counting a
      // mere mention would report the whole vocabulary as wired.
      const constructed = new RegExp(`kind:\\s*EventKind\\.${key}\\b`);
      const fromPlay = PLAY.some((p) => constructed.test(SRC.find((f) => f.path === p)?.text ?? ''));
      const fromDriver = constructed.test(SRC.find((f) => f.path === DRIVER)?.text ?? '');
      if (fromPlay && PENDING_EVENTS[value]) {
        unaccounted.push(`${key}: notified from play but still listed as pending`);
      } else if (!fromPlay && !fromDriver) {
        unaccounted.push(`${key}: nothing anywhere notifies it`);
      } else if (!fromPlay && !PENDING_EVENTS[value]) {
        unaccounted.push(`${key}: only the autopilot notifies it, and it is not declared pending`);
      }
    }
    assert.deepEqual(unaccounted, [], 'mission event kinds whose reachability is not accounted for');
  });

  test('J4 · every required objective in the story is satisfiable from play', () => {
    // The claim the whole game rests on, checked against the reachability tables above
    // rather than against the story driver. A required objective whose event kind only
    // the driver can produce is a story that cannot be finished - and the driver's own
    // playthrough suite passes while that is true.
    const KIND_FOR_TYPE = {
      combat: EventKind.KILL, takedown: EventKind.TAKEDOWN,
      escape: EventKind.ESCAPE, return: EventKind.RETURN,
    };
    const blocked = [];
    for (const mission of MISSIONS) {
      for (const o of mission.objectives) {
        if (o.optional) continue;
        const kind = KIND_FOR_TYPE[o.type];
        if (!kind) continue;                    // goto/examine/clue/... are landmark driven
        // Keyed by the event VALUE, which is what the mission matcher table uses.
        if (PENDING_EVENTS[kind]) blocked.push(`${mission.id}/${o.id} (${o.type})`);
      }
    }
    // Nothing. This assertion used to read `blocked.length === 1` and name m11/o5, the
    // last objective of the last mission, as a known gap. It is empty now, and an empty
    // list is the only acceptable answer: every required objective in the story is
    // satisfiable by playing it.
    assert.deepEqual(blocked, [],
      `required objectives play cannot satisfy: ${blocked.join(' | ')}`);
    // And the check still has something to check, or it passes by finding no objectives.
    let eventDriven = 0;
    for (const mission of MISSIONS) {
      for (const o of mission.objectives) {
        if (!o.optional && KIND_FOR_TYPE[o.type]) eventDriven++;
      }
    }
    // Six, counted from the content: three COMBAT (m06/o5, m10/o3, m11/o2), two ESCAPE
    // (m07/o1, m07/o3) and one RETURN (m11/o5). Exactly the six that were unsatisfiable
    // when nothing in play produced their events.
    assert.equal(eventDriven, 6,
      `the story has ${eventDriven} required event-driven objectives, expected 6`);
  });

  test('J5 · every combat event the page listens for has an emitter', () => {
    // The mirror of the audio suite's reachability check: a listener on an event nothing
    // emits is a HUD element or a sound that never appears, and nothing throws.
    const names = [
      Events.COMBAT_HIT, Events.COMBAT_BLOCKED, Events.COMBAT_PARRIED, Events.COMBAT_KILL,
      Events.COMBAT_STAGGER, Events.COMBAT_KNOCKDOWN, Events.PLAYER_DIED, Events.PLAYER_DODGED,
    ];
    const joined = FILES.map((f) => f.text).join('\n');
    const silent = [];
    for (const name of names) {
      const key = Object.keys(Events).find((k) => Events[k] === name);
      assert.ok(key, `${name} is not in the Events table`);
      // Emitted as Events.X, or as the string key through player.js/ai.js's _emit().
      if (!joined.includes(`Events.${key}`) && !joined.includes(`_emit('${key}'`)) silent.push(name);
    }
    assert.deepEqual(silent, [], `combat events with no emitter anywhere in src/: ${silent.join(', ')}`);
  });

  test('J6 · every objective target names a landmark or region that exists', () => {
    // Same class of failure as an unwired resolver, one level down: an objective whose
    // target is a typo can never be matched, and nothing throws - the counter simply
    // never moves. GOTO accepts either a landmark or a region, so both tables are in
    // play, and three required objectives name a region rather than a landmark.
    const lm = new Set(LANDMARKS.map((l) => l.id));
    const rg = new Set(REGIONS.map((r) => r.id));
    assert.gt(lm.size, 20, 'the landmark table came back nearly empty, so this proves nothing');
    assert.gt(rg.size, 5, 'the region table came back nearly empty, so this proves nothing');

    const broken = [];
    let regionTargets = 0;
    for (const mission of MISSIONS) {
      for (const o of mission.objectives) {
        if (!o.target) continue;                       // survive/combat/takedown carry none
        if (o.type === 'goto') {
          if (lm.has(o.target)) continue;
          if (rg.has(o.target)) { regionTargets++; continue; }
          broken.push(`${mission.id}/${o.id}: goto "${o.target}" is neither a landmark nor a region`);
          continue;
        }
        if (o.type === 'search' || o.type === 'escape') {
          if (!rg.has(o.target)) broken.push(`${mission.id}/${o.id}: ${o.type} "${o.target}" is not a region`);
          continue;
        }
        if (o.type === 'clue' && !CLUE_MAP[o.target]) {
          broken.push(`${mission.id}/${o.id}: clue "${o.target}" does not exist`);
        }
      }
    }
    assert.deepEqual(broken, [], 'objectives that can never be matched because their target does not exist');
    assert.gte(regionTargets, 3,
      'no GOTO objective targets a region any more, so the REGION notification is untested by content');
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════
 * K — THE FIGHT DOES NOT BREAK THE REST OF THE GAME
 * ══════════════════════════════════════════════════════════════════════════
 */
describe('battle — the fight does not break anything else', () => {
  test('K1 · a long fight leaves the frame loop, the audio and the diagnostics intact', () => {
    const { game, bus } = bootGame();
    const errors = record(bus, Events.ERROR);
    const agent = game.squad.agents[0];
    alarm(game, agent, 12);
    pin(game, 1.6);
    for (let i = 0; i < 60 * 20; i++) {
      if (i % 22 === 0) swing(game);
      if (i % 40 === 0 && game.player.health < 60) {
        game.player.health = Math.min(100, game.player.health + 40);
      }
      step(game, 1);
    }
    assert.deepEqual(errors.map((e) => e.message ?? String(e)), [],
      'a twenty second fight raised errors on the bus');
    assert.finite(game.elapsed, 'the game clock went non-finite during a fight');
    assert.ok(game.hitstop >= 0 && Number.isFinite(game.hitstop), 'hitstop was left poisoned');
    assert.finite(game.player.health, 'player health went non-finite');
    for (const a of game.squad.agents) {
      assert.finite(a.body.health, `${a.id} health went non-finite`);
      assert.finite(a.suspicion, `${a.id} suspicion went non-finite`);
    }
    assert.ok(game.audio, 'the audio director was lost during a fight');
    const diag = game.diagnostics();
    assert.ok(diag.audio && diag.perception, 'diagnostics lost a section after a fight');
  });

  test('K2 · the audio director hears the fight', () => {
    // The blow is emitted with a position and `local: false`, so the director can pan it
    // and place it. A fight that always arrives from dead centre is a fight happening
    // nowhere.
    const { game } = bootGame();
    const agent = game.squad.agents[0];
    pin(game, 1.6, agent);
    const eventsBefore = game.audio?.stats?.events ?? 0;
    killWithTheSword(game, agent);
    if (game.audio?.available) {
      assert.gt(game.audio.stats.events, eventsBefore,
        'a fight and a death passed the audio director without an event');
    } else {
      // No AudioContext in this environment: the director must still not throw.
      assert.ok(game.audio, 'the audio director went missing');
    }
  });

  test('K3 · a paused game resolves no combat', () => {
    // Pause stops the world. If combat still resolved through it, a guard would kill the
    // player mid-menu, which no amount of writing survives.
    const { game } = bootGame();
    const agent = game.squad.agents[0];
    alarm(game, agent, 12);
    pin(game, 1.5, agent);
    const health = game.player.health;

    game.paused = true;
    for (let i = 0; i < 60; i++) step(game, 1);
    assert.equal(game.player.health, health, 'a paused game kept resolving combat');
    game.paused = false;
    for (let i = 0; i < 300 && game.player.health === health; i++) step(game, 1);
    assert.lt(game.player.health, health, 'unpausing did not resume combat, so the pause is permanent');
  });

  test('K4 · the combat resolver survives a region with nobody to fight', () => {
    // A region with no guards is a normal state, not an error - Layla's house has none.
    // The resolver and the lock-on are the new code and must not be what falls over.
    const { game } = bootGame();
    const squad = game.squad;
    game.squad = null;
    assert.doesNotThrow(() => game._resolveCombat(), 'the combat resolver threw with no squad');
    assert.doesNotThrow(() => game._updateLockOn({ lockOn: true }, 1 / 60),
      'lock-on threw with no squad');
    game.squad = squad;
    assert.equal(game.player.lockTarget, null, 'a missing squad locked the player onto nothing');
  });

  test('K5 · the mission manager still rejects an event it does not know', () => {
    // Wiring more notifications into the mission system must not loosen what it accepts:
    // an invented kind silently completing nothing is how an objective ends up looking
    // reachable and never moving.
    const { game } = bootGame();
    const problemsBefore = game.missions.problems.length;
    game.missions.notify({ kind: 'not-a-kind', id: 'x' });
    assert.gt(game.missions.problems.length, problemsBefore,
      'an unknown event kind was accepted without being recorded');
    assert.doesNotThrow(() => game.missions.notify(null));
    assert.doesNotThrow(() => game.missions.notify({}));
    assert.ok(game.missions instanceof MissionManager);
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════
 * L — READING THE WILL ALOUD
 * ══════════════════════════════════════════════════════════════════════════
 *
 * m11/o5 is the last required objective of the last mission, and it is the one place in
 * the story where the player has to present something they are carrying rather than go
 * somewhere or kill someone. RETURN targets a clue id, so the place has to come from
 * somewhere else - and the temptation is to hardcode "at Layla's hearth".
 *
 * It does not. `#presentationPlace()` walks back through the mission's own objectives to
 * the nearest preceding required beat that names a landmark, and DIALOGUE_MAP already
 * records which landmark each tree is staged at. For m11 that is o4, the hearth
 * conversation, so the place resolves to lm-ll-hearth from authored data. Nothing in the
 * code knows m11 exists.
 */
describe('battle — presenting what you carry', () => {
  const M11 = 'm11-betrayed-will';
  const HEARTH = 'lm-ll-hearth';
  const WILL = 'clue-temple-archive';

  /**
   * Walk the whole story to m11 with everything before o5 done and o5 itself untouched.
   *
   * The director can satisfy o5 on its own, so the walk has to stop the moment o5 is the
   * pending objective rather than run to the end. `#nextObjective()` takes them in order,
   * so "every objective before it is complete" is exactly that moment.
   */
  function reachTheHearth() {
    const { game, bus } = bootGame();
    const mission = MISSIONS.find((m) => m.id === M11);
    const objective = mission.objectives.find((o) => o.id === 'o5');
    const prior = mission.objectives.slice(0, mission.objectives.indexOf(objective));
    const director = new StoryDirector({ bus, manager: game.missions });
    const ready = () => game.missions.currentMission()?.id === M11
      && prior.every((o) => game.missions.state.isObjectiveDone(M11, o.id));
    director.begin();
    let guard = 0;
    while (!ready() && guard++ < 600) {
      const beat = director.step();
      if (beat.type === 'finished' || beat.type === 'stuck') break;
    }
    assert.ok(ready(),
      `the story never reached its last objective (${director.stuckReason ?? `${guard} steps`})`);
    assert.notOk(game.missions.state.isObjectiveDone(M11, objective.id),
      'the director satisfied the last objective on the way, so play is not what is measured');
    return { game, bus, mission, objective, director };
  }

  /** m11 active, the will held, and one named objective left undone. */
  function stageTheHearth({ conversationDone }) {
    const { game } = bootGame();
    const mission = MISSIONS.find((m) => m.id === M11);
    game.missions.state.chapterId = mission.chapter;
    game.missions.state.addActiveMission(M11);
    game.missions.state.grantClue(WILL);
    if (conversationDone) game.missions.notify({ kind: EventKind.DIALOGUE, id: 'dt-ll-hearth' });
    return { game, mission, objective: mission.objectives.find((o) => o.id === 'o5') };
  }

  test('L1 · the story arrives at its last objective with the will in the player\'s hands', () => {
    const { game, objective } = reachTheHearth();
    assert.ok(game.missions.state.hasClue(WILL),
      'the story reached the reading without ever giving the player the document to read');
    assert.notOk(game.missions.state.isObjectiveDone(M11, objective.id),
      'the last objective was already complete on arrival, so the player has nothing to do');
    assert.deepEqual(game.missions.presentationAt(HEARTH),
      { missionId: M11, objectiveId: objective.id, item: WILL },
      'the hearth does not offer the reading');
  });

  test('L2 · reading aloud at the hearth completes the last mission', () => {
    const { game, objective } = reachTheHearth();
    const completed = game.missions.presentAt(HEARTH);
    assert.equal(completed.length, 1, `presenting at the hearth completed ${completed.length} objectives`);
    assert.ok(game.missions.state.isObjectiveDone(M11, objective.id),
      'the reading did not complete the objective it exists to complete');
    assert.equal(game.missions.objectiveProgress(M11, objective.id), 1);
    const left = game.missions.currentMission()?.objectives
      .filter((o) => !o.optional && !game.missions.state.isObjectiveDone(M11, o.id)) ?? [];
    assert.equal(left.length, 0,
      `required objectives still open in the last mission: ${left.map((o) => o.id).join(', ')}`);
  });

  test('L3 · the place is derived from the story, not hardcoded to m11', () => {
    // The same mission, the same document, three other pieces of furniture in the same
    // room. If the place were a guess about Layla's house rather than a reading of the
    // mission's own beats, one of these would also work.
    const { game } = reachTheHearth();
    for (const elsewhere of ['lm-ll-loom', 'lm-ll-table', 'lm-ll-chest']) {
      assert.equal(game.missions.presentationAt(elsewhere), null,
        `${elsewhere} offers the reading, so the place is not the hearth the story named`);
      assert.deepEqual(game.missions.presentAt(elsewhere), [],
        `presenting at ${elsewhere} completed something`);
    }
    assert.equal(game.missions.presentationAt('lm-does-not-exist'), null,
      'an invented landmark id was accepted');
    assert.doesNotThrow(() => game.missions.presentAt(null));
    assert.doesNotThrow(() => game.missions.presentationAt(undefined));
  });

  test('L4 · the reading follows the conversation, it does not happen during it', () => {
    // o4 is the hearth dialogue and o5 is the reading at the same hearth. Both are one
    // interact key on one landmark, so the order has to come from the rules: the beat the
    // place was derived from must be complete before it can host the next one.
    const { game, objective } = stageTheHearth({ conversationDone: false });
    {
      assert.equal(game.missions.presentationAt(HEARTH), null,
        'the will can be read aloud before the conversation it follows has happened');
      assert.deepEqual(game.missions.presentAt(HEARTH), [],
        'presenting early completed the last objective of the game');
      assert.notOk(game.missions.state.isObjectiveDone(M11, objective.id));

      // Finish the conversation the way play does, and the same landmark now offers it.
      game.missions.notify({ kind: EventKind.DIALOGUE, id: 'dt-ll-hearth' });
      assert.ok(game.missions.state.isObjectiveDone(M11, 'o4'), 'the conversation did not complete');
      assert.ok(game.missions.presentationAt(HEARTH),
        'the hearth stopped offering the reading once the conversation was over');
    }
  });

  test('L5 · there is nothing to read without the document', () => {
    const { game, objective } = stageTheHearth({ conversationDone: true });
    game.missions.state.clues.delete(WILL);
    assert.notOk(game.missions.state.hasClue(WILL), 'the player still holds the will');
    assert.equal(game.missions.presentationAt(HEARTH), null,
      'the hearth offered a reading of a document the player does not have');
    assert.deepEqual(game.missions.presentAt(HEARTH), []);
    assert.notOk(game.missions.state.isObjectiveDone(M11, objective.id),
      'the last objective completed with nothing presented');
  });

  test('L6 · the prompt says "read aloud", so the player knows to try', () => {
    // The whole feature is one interact key on a landmark that already had a verb. A
    // hearth that keeps saying "Talk" after the conversation is over is a hearth nobody
    // reads at, and the game ends with its last objective quietly incomplete.
    const { game, bus } = reachTheHearth();
    // m11 opens on a cinematic, and a cinematic holds the interaction prompt - clear it
    // the way the player would before asking what the hearth offers.
    if (game.cinematics?.active) { game.cinematics.skip(); for (let i = 0; i < 20; i++) step(game, 1); }
    assert.notOk(game.cinematics?.active, 'a cinematic is still holding the prompt');

    game.setRegion('layla-house');
    const hearth = game.world.region('layla-house').landmarks.find((l) => l.id === HEARTH);
    assert.ok(hearth, 'the hearth is not in the room it is supposed to be in');

    // Held there rather than placed once: the player slides a little on the first frames
    // and a prompt test that measured the wrong landmark would still look like a pass.
    const update = game.squad.update.bind(game.squad);
    game.squad.update = (dt) => { update(dt); game.player.pos.set(hearth.x, hearth.y, hearth.z); };
    for (let i = 0; i < 4; i++) step(game, 1);

    const prompt = game.prompt;
    assert.ok(prompt, 'standing at the hearth published no prompt at all');
    assert.equal(prompt.id, HEARTH, `the prompt is for ${prompt.id}, not the hearth`);
    assert.equal(prompt.action, 'اقرأ جهارًا',
      `the prompt offers "${prompt.action}" where the story wants the will read aloud`);

    // And a verb change at the same landmark has to reach the screen: _publishPrompt()
    // compared only id and kind, so the new text would have been swallowed.
    const seen = record(bus, Events.PROMPT);
    game._publishPrompt({ ...prompt, action: 'حاور' });
    assert.equal(seen.length, 1,
      'the prompt did not republish when only its verb changed, so the HUD would keep the old text');
    // Reading aloud then completes it, through the same key the prompt is offering.
    assert.equal(game.missions.presentAt(HEARTH).length, 1, 'the offered reading did not complete');
  });

  test('L7 · the mission manager exposes the reading without a mission running', () => {
    // A fresh game has no active mission. presentationAt() is called from every landmark
    // interaction in the game, so it has to be cheap and inert rather than throwing in
    // the prologue.
    const { game } = bootGame();
    assert.deepEqual(game.missions.activeMissions(), [], 'boot started with a mission running');
    assert.equal(game.missions.presentationAt(HEARTH), null);
    assert.deepEqual(game.missions.presentAt(HEARTH), []);
    assert.equal(game.missions.problems.length, 0,
      'an ordinary interaction with nothing to present was recorded as a problem');
  });
});

runAndExit();
