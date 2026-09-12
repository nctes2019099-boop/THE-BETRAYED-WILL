/**
 * THE BETRAYED WILL — run-deep.mjs
 *
 * Level 2 integration (charter §21). The unit suites prove each system is correct
 * on its own; this one proves the systems agree with each other, which is where a
 * game actually breaks.
 *
 * The seams under test are the ones that exist:
 *   Content  <-> World      every objective target is a place that was really built
 *   Dialogue <-> Mission    walking a conversation completes the objective for it
 *   Mission  <-> Save       progress survives a serialize/deserialize round trip
 *   Story    <-> Nav graph  chapter transitions are regions that really connect
 *   Mission  <-> AI/Nav     a mission's region is one a guard can actually path in
 *
 * Combat and camera have their own suites (98 and 40 tests) and are not re-litigated
 * here beyond the contract the mission system exposes to them. Weather and lighting
 * are not built yet; rather than assert on stubs, they are absent from this file and
 * named as a gap in the run summary.
 *
 * Run: node tests/run-deep.mjs
 */

import { describe, test, assert, runAndExit, measure } from './harness.mjs';
import { EventBus, Events } from '../src/core/bus.js';
import { AI, DIALOGUE, MISSION, PERF, SAVE } from '../src/core/constants.js';
import { RNG } from '../src/core/rng.js';

import {
  CHAPTERS, CHAPTER_MAP, CHARACTERS, CINEMATIC_MAP, CINEMATICS, CLUES, CLUE_MAP,
  MISSIONS, MISSION_MAP, ObjectiveType, validateStoryData,
} from '../src/content/story.js';
import {
  DIALOGUE_MAP, DIALOGUE_TREES, EVERYTHING, Flags, MINOR_ROLES, MISSION_OWNED_FLAGS,
  NOTHING, canFinish, canFinishFrom, reachableNodes, validateDialogueData,
} from '../src/content/dialogue.js';
import {
  LANDMARK_MAP, REGIONS, REGION_MAP, validateWorldData,
} from '../src/content/world-data.js';

import { StoryState, fnv1a, stableStringify } from '../src/sim/story-state.js';
import {
  AUTOSAVE_TRIGGERS, MemoryStorage, SaveStatus, SaveSystem,
} from '../src/sim/save.js';
import {
  DialogueWalker, autoWalk, explorationWalk, lineMs, localized,
  speakerName, unresolvedSpeakers,
} from '../src/sim/dialogue.js';
import {
  EventKind, MissionManager, MissionStatus, StoryDirector, objectiveSoftLocks,
  searchablePlaces,
} from '../src/sim/mission.js';
import { World } from '../src/sim/world.js';
import { makeRng } from '../src/sim/ai.js';

/* ------------------------------------------------------------ shared fixtures */

const world = new World({ seed: 'mesopotamia' });
world.buildAll();

/**
 * A path query with the clock disabled and a large node budget.
 *
 * Integration tests ask "is this world navigable", not "is this machine fast enough
 * right now". Under the default tactical budget the same query passes or fails
 * depending on JIT warmth and load - measured on palace-hall as 348 nodes median but
 * 3932 on one unlucky far-apart pair - so a budget-bound assertion here would be
 * flaky by construction. Budget behaviour is asserted separately, on its own terms.
 */
const GENEROUS = Object.freeze({ timeBudgetMs: 0, maxNodes: 60000 });

const allObjectives = () => MISSIONS.flatMap((m) => m.objectives.map((o) => ({ m, o })));

/** A fresh manager at the very start of the game. */
function fresh(language = 'ar') {
  return new MissionManager({ bus: new EventBus(), state: new StoryState({ language }), language });
}

/**
 * A manager standing at the start of a chapter, with every earlier chapter and
 * mission already complete.
 *
 * Chapters unlock in order, so a test that wants to look at chapter 4 either plays
 * the first four chapters or states plainly that they are finished. Playing them in
 * every test would make the suite slow and would couple each test to content it is
 * not about - a failure in chapter 2 would then report as a failure in chapter 4.
 */
function managerAtChapter(chapterId, language = 'ar') {
  const manager = fresh(language);
  for (const c of [...CHAPTERS].sort((a, b) => a.index - b.index)) {
    if (c.id === chapterId) break;
    for (const m of manager.missionsOf(c.id)) {
      for (const o of m.objectives) manager.state.markObjectiveDone(m.id, o.id);
      manager.state.markMissionComplete(m.id);
    }
    manager.state.markChapterComplete(c.id);
  }
  const started = manager.startChapter(chapterId);
  assert.ok(started.ok, `could not open ${chapterId}: ${started.reason}`);
  return manager;
}

/** Walk the region graph from a set of regions, the way a player on foot would. */
function reachableRegions(fromIds) {
  const seen = new Set(fromIds);
  const queue = [...fromIds];
  while (queue.length) {
    for (const next of REGION_MAP[queue.shift()]?.connects ?? []) {
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  return seen;
}

/** A mission-shaped object that is not in the content, for the soft-lock detector. */
function syntheticMission(over = {}) {
  return {
    id: 'synthetic', chapter: 'ch4', region: 'cellar', objectives: [], ...over,
  };
}

/* =============================== A. content integrity across the three layers */

describe('run-deep — content integrity across layers', () => {
  test('A1 · the three validators pass on the same data at the same time', () => {
    const story = validateStoryData();
    const dialogue = validateDialogueData();
    const w = validateWorldData();
    assert.deepEqual(story.errors, [], `story: ${story.errors.slice(0, 3).join(' | ')}`);
    assert.deepEqual(dialogue.errors, [], `dialogue: ${dialogue.errors.slice(0, 3).join(' | ')}`);
    assert.deepEqual(w.errors, [], `world: ${w.errors.slice(0, 3).join(' | ')}`);
    assert.equal(story.counts.chapters, 8, 'expected prologue + 6 chapters + epilogue');
    assert.equal(story.counts.missions, 11, 'expected 11 missions');
    assert.equal(story.counts.clues, 10, 'expected 10 clues');
    assert.equal(story.counts.cinematics, 9, 'expected 9 cinematics');
    assert.equal(dialogue.counts.trees, 14, 'expected 14 dialogue trees');
  });

  test('A2 · every objective target resolves, by the rules of its own type', () => {
    const bad = [];
    for (const { m, o } of allObjectives()) {
      switch (o.type) {
        case ObjectiveType.CLUE:
        case ObjectiveType.RETURN:
          if (!CLUE_MAP[o.target]) bad.push(`${m.id}/${o.id} clue "${o.target}"`);
          break;
        case ObjectiveType.DIALOGUE:
          if (!DIALOGUE_MAP[o.target]) bad.push(`${m.id}/${o.id} tree "${o.target}"`);
          break;
        case ObjectiveType.CINEMATIC:
          if (!CINEMATIC_MAP[o.target]) bad.push(`${m.id}/${o.id} cinematic "${o.target}"`);
          break;
        case ObjectiveType.SEARCH:
        case ObjectiveType.ESCAPE:
          if (!REGION_MAP[o.target]) bad.push(`${m.id}/${o.id} region "${o.target}"`);
          break;
        case ObjectiveType.GOTO:
        case ObjectiveType.EXAMINE:
        case ObjectiveType.INTERACT:
          if (!LANDMARK_MAP[o.target] && !REGION_MAP[o.target]) bad.push(`${m.id}/${o.id} "${o.target}"`);
          break;
        case ObjectiveType.SURVIVE:
        case ObjectiveType.TAKEDOWN:
        case ObjectiveType.COMBAT:
          if (!(o.count > 0)) bad.push(`${m.id}/${o.id} counting objective with no count`);
          break;
        default:
          bad.push(`${m.id}/${o.id} unhandled type "${o.type}"`);
      }
    }
    assert.deepEqual(bad, [], `unresolved objective targets: ${bad.join(', ')}`);
  });

  test('A3 · every clue sits in a region its own chapter claims', () => {
    // Crosses three files: the clue's declared chapter, the landmark's region, and
    // the region's own chapter field. Two of the three had disagreed before.
    const bad = [];
    for (const c of CLUES) {
      const lm = LANDMARK_MAP[c.landmark];
      if (!lm) { bad.push(`${c.id}: landmark "${c.landmark}" missing`); continue; }
      const region = REGION_MAP[lm.region];
      if (!region) { bad.push(`${c.id}: region "${lm.region}" missing`); continue; }
      if (region.chapter !== c.chapter) bad.push(`${c.id}: clue says ${c.chapter}, region says ${region.chapter}`);
      if (!(CHAPTER_MAP[c.chapter]?.regions ?? []).includes(lm.region)) {
        bad.push(`${c.id}: chapter ${c.chapter} does not list region ${lm.region}`);
      }
    }
    assert.deepEqual(bad, [], bad.join(' | '));
    assert.equal(CLUES.length, 10, 'expected 10 clues');
  });

  test('A4 · every dialogue tree is spoken in a region its chapter claims', () => {
    const bad = [];
    for (const t of DIALOGUE_TREES) {
      const lm = LANDMARK_MAP[t.landmark];
      if (!lm) { bad.push(`${t.id}: landmark missing`); continue; }
      if (REGION_MAP[lm.region]?.chapter !== t.chapter) {
        bad.push(`${t.id}: tree says ${t.chapter}, region says ${REGION_MAP[lm.region]?.chapter}`);
      }
    }
    assert.deepEqual(bad, [], bad.join(' | '));
    // 14 trees over 14 distinct landmarks: no corner of the world speaks twice.
    assert.equal(new Set(DIALOGUE_TREES.map((t) => t.landmark)).size, 14, 'two trees share a landmark');
  });

  test('A5 · every flag is written by some layer, and none is written by two', () => {
    const values = Object.values(Flags);
    assert.equal(new Set(values).size, values.length, 'duplicate flag values');

    const byDialogue = new Set();
    for (const t of DIALOGUE_TREES) {
      for (const n of Object.values(t.nodes)) {
        for (const f of n.effects?.flags ?? []) byDialogue.add(f);
        for (const c of n.choices ?? []) for (const f of c.effects?.flags ?? []) byDialogue.add(f);
      }
    }
    const byStory = new Set();
    for (const m of MISSIONS) {
      for (const f of m.setsFlags ?? []) byStory.add(f);
      for (const o of m.objectives) for (const f of o.setsFlags ?? []) byStory.add(f);
    }
    for (const c of CINEMATICS) for (const f of c.setsFlags ?? []) byStory.add(f);

    const unwritten = values.filter((f) => !byDialogue.has(f) && !byStory.has(f));
    assert.deepEqual(unwritten, [], `flags nothing ever sets: ${unwritten.join(', ')}`);

    // Mission-owned flags must not also be written by dialogue: one writer each.
    const split = [...MISSION_OWNED_FLAGS].filter((f) => byDialogue.has(f));
    assert.deepEqual(split, [], `flags written by both layers: ${split.join(', ')}`);
    assert.gte(values.length, 15, 'flag vocabulary shrank unexpectedly');
  });
});

/* ============================================ B. dialogue <-> mission seam */

describe('run-deep — dialogue and mission', () => {
  test('B1 · all fourteen conversations can be exited holding nothing', () => {
    const trapped = DIALOGUE_TREES.filter((t) => !canFinish(t, NOTHING)).map((t) => t.id);
    assert.deepEqual(trapped, [], `trapped conversations: ${trapped.join(', ')}`);
  });

  test('B2 · all fourteen can still be exited holding everything', () => {
    const trapped = DIALOGUE_TREES.filter((t) => !canFinish(t, EVERYTHING)).map((t) => t.id);
    assert.deepEqual(trapped, [], `unwalkable conversations: ${trapped.join(', ')}`);
  });

  test('B3 · an exploration walk covers a hub scene instead of stopping at the first exit', () => {
    // dt-court-guards is a hub: `order` and `stone` both answer and hand back to
    // `open`. A simple-path planner cannot represent that at all, and skipped both
    // spokes - which is where the scene's only flag lives.
    const tree = DIALOGUE_MAP['dt-court-guards'];
    const walk = explorationWalk(tree, EVERYTHING);
    assert.ok(walk.ok, `exploration walk failed: ${walk.reason}`);
    const visited = new Set([tree.entry]);
    for (const s of walk.steps) visited.add(s.to);
    for (const spoke of ['order', 'stone', 'end_polite']) {
      assert.ok(visited.has(spoke), `hub spoke "${spoke}" never visited`);
    }
    assert.ok(visited.size >= Object.keys(tree.nodes).length,
      `visited ${visited.size} of ${Object.keys(tree.nodes).length} nodes`);
  });

  test('B4 · walking a conversation really applies its effects to story state', () => {
    const state = new StoryState();
    const result = autoWalk(DIALOGUE_MAP['dt-court-guards'], state, { bus: new EventBus() });
    assert.ok(result.ok && result.finished, `walk failed: ${result.reason}`);
    assert.ok(state.hasFlag(Flags.HEARD_DICTATION), 'the guard post never told Raynor who gave the order');
    assert.ok(state.hasSeenTree('dt-court-guards'), 'tree not recorded as seen');
    assert.gt(state.choicesTaken.size, 0, 'no choices recorded');
    assert.deepEqual(state.violations, [], JSON.stringify(state.violations));
  });

  test('B5 · a gated choice is refused with a reason, and opens once the clue is held', () => {
    const tree = DIALOGUE_MAP['dt-cellar-cage'];
    const gateIndex = tree.nodes.open.choices.findIndex((c) => c.requires?.clues?.length);
    assert.gte(gateIndex, 0, 'expected a gated choice in the cage scene');

    const bare = new StoryState();
    const w1 = new DialogueWalker({ bus: new EventBus() });
    assert.ok(w1.begin(tree.id, bare).ok, 'could not open the scene');
    const locked = w1.choose(gateIndex, bare);
    assert.equal(locked.ok, false, 'a gated choice was taken without the clue');
    assert.equal(locked.reason, 'locked', `wrong refusal reason: ${locked.reason}`);
    assert.notOk(bare.hasFlag(Flags.RING_MATCHES_EVAN), 'the gated branch applied its effect anyway');

    const view = w1.view(bare);
    assert.equal(view.choices[gateIndex].available, false, 'view marks a locked choice available');
    assert.equal(view.choices[gateIndex].lockedReason, 'clue-door-ring', 'view does not say what unlocks it');

    const rich = new StoryState();
    rich.grantClue('clue-door-ring');
    const w2 = new DialogueWalker({ bus: new EventBus() });
    w2.begin(tree.id, rich);
    const open = w2.choose(gateIndex, rich);
    assert.ok(open.ok, `the same choice is still refused with the clue held: ${open.reason}`);
    assert.ok(rich.hasFlag(Flags.RING_MATCHES_EVAN), 'the ring was never matched to Evan');
  });

  test('B6 · finishing a conversation completes the objective that asked for it', () => {
    const bus = new EventBus();
    const manager = new MissionManager({ bus, language: 'ar' });
    manager.startChapter('prologue');
    const mission = MISSION_MAP['m01-dictation'];
    const obj = mission.objectives.find((o) => o.type === ObjectiveType.DIALOGUE);
    assert.ok(obj, 'm01 has no dialogue objective');

    const walk = autoWalk(DIALOGUE_MAP[obj.target], manager.state, { bus });
    assert.ok(walk.ok, `walk failed: ${walk.reason}`);
    const completed = manager.notify({ kind: EventKind.DIALOGUE, id: obj.target });

    assert.ok(completed.some((c) => c.objectiveId === obj.id),
      `the dialogue objective did not complete: ${JSON.stringify(completed)}`);
    assert.ok(manager.isObjectiveComplete(mission.id, obj.id), 'objective not marked done');
    assert.ok(manager.state.hasSeenTree(obj.target), 'tree not recorded');
  });

  test('B7 · every speaker resolves to a name in both languages', () => {
    assert.deepEqual(unresolvedSpeakers(), [], 'speakers with no registry entry');
    const ids = new Set([...Object.keys(CHARACTERS), ...Object.keys(MINOR_ROLES)]);
    for (const t of DIALOGUE_TREES) {
      const speakers = new Set(Object.values(t.nodes).map((n) => n.speaker ?? t.speaker));
      for (const id of speakers) {
        assert.ok(ids.has(id), `${t.id}: speaker "${id}" is not a character or a role`);
        for (const lang of ['ar', 'en']) {
          const name = speakerName(id, lang);
          assert.ok(name && name !== id, `${t.id}/${lang}: speaker "${id}" resolved to "${name}"`);
        }
      }
    }
  });

  test('B8 · subtitle timing is derived from the text and clamped, in both languages', () => {
    assert.equal(lineMs('اجلس.'), DIALOGUE.MIN_LINE_MS, 'a short line under-runs the minimum');
    assert.equal(lineMs('x'.repeat(400)), DIALOGUE.MAX_LINE_MS, 'a long line over-runs the maximum');
    for (const t of DIALOGUE_TREES) {
      for (const n of Object.values(t.nodes)) {
        for (const line of n.lines) {
          for (const lang of ['ar', 'en']) {
            const ms = lineMs(localized(line, lang));
            assert.within(ms, DIALOGUE.MIN_LINE_MS, DIALOGUE.MAX_LINE_MS,
              `${t.id}/${n.id}/${lang}: ${ms}ms outside the subtitle clamp`);
          }
        }
      }
    }
  });
});

/* ================================================== C. save <-> mission seam */

describe('run-deep — save and mission', () => {
  test('C1 · a save taken mid-mission restores the mission, not just the flags', () => {
    const manager = fresh();
    manager.startChapter('prologue');
    manager.notify({ kind: EventKind.LANDMARK, id: 'lm-court-stele' });
    manager.notify({ kind: EventKind.CLUE, id: 'clue-boundary-stone' });
    const before = manager.serialize();

    const restored = fresh();
    const report = restored.restore(before);
    assert.ok(report.ok, `clean save reported problems: ${report.problems.join(' | ')}`);
    assert.equal(restored.state.chapterId, 'prologue', 'chapter lost');
    assert.ok(restored.state.activeMissions.has('m01-dictation'), 'the active mission was not saved');
    assert.ok(restored.state.hasClue('clue-boundary-stone'), 'clue lost');
    assert.ok(restored.isObjectiveComplete('m01-dictation', 'o1'), 'objective progress lost');
    assert.equal(restored.missionStatus('m01-dictation'), MissionStatus.ACTIVE, 'status changed across the save');
  });

  test('C2 · a restored manager finishes the story from where the save was taken', () => {
    const first = fresh();
    const director = new StoryDirector({ manager: first });
    director.begin();
    for (let i = 0; i < 12 && !first.isStoryComplete(); i++) director.step();
    const checkpoint = first.serialize();
    const doneAtCheckpoint = first.state.completedMissions.size;
    assert.gt(doneAtCheckpoint, 0, 'the checkpoint was taken before anything happened');
    assert.notOk(first.isStoryComplete(), 'the checkpoint was taken after the story ended');

    const second = fresh();
    second.restore(checkpoint);
    const rest = new StoryDirector({ manager: second });
    const report = rest.run({ maxSteps: 600 });
    assert.ok(report.ok, `resumed run got stuck: ${report.stuckReason}`);
    assert.ok(report.storyComplete, 'the resumed run did not finish the story');
    assert.equal(report.missions, MISSIONS.length, 'not every mission completed after a resume');
  });

  test('C3 · an altered save is detected rather than trusted', () => {
    const manager = fresh();
    manager.startChapter('prologue');
    manager.notify({ kind: EventKind.CLUE, id: 'clue-boundary-stone' });
    const payload = manager.serialize();

    const tampered = JSON.parse(JSON.stringify(payload));
    tampered.clues.push('clue-canal-body');          // a clue from chapter 6
    const report = StoryState.deserialize(tampered);
    assert.equal(report.ok, false, 'a tampered save loaded cleanly');
    assert.ok(report.problems.some((p) => p.includes('checksum')),
      `no checksum complaint: ${report.problems.join(' | ')}`);

    const truncated = JSON.parse(JSON.stringify(payload));
    delete truncated.checksum;
    assert.equal(StoryState.deserialize(truncated).ok, false, 'a save with no checksum was accepted');
    assert.equal(StoryState.deserialize(null).ok, false, 'null was accepted');
    assert.equal(StoryState.deserialize('nonsense').ok, false, 'a string was accepted');
  });

  test('C4 · a save from another version is reported, and still loads what it can', () => {
    const manager = fresh();
    manager.startChapter('prologue');
    manager.notify({ kind: EventKind.CLUE, id: 'clue-boundary-stone' });
    const payload = manager.serialize();
    payload.version = SAVE.VERSION + 1;
    payload.checksum = fnv1a(stableStringify((({ checksum, ...rest }) => rest)(payload)));

    const report = StoryState.deserialize(payload);
    assert.equal(report.ok, false, 'a version mismatch passed silently');
    assert.ok(report.problems.some((p) => p.includes('version')), 'no version complaint');
    assert.ok(report.state, 'the state was discarded instead of repaired');
    assert.ok(report.state.hasClue('clue-boundary-stone'), 'recoverable progress was thrown away');
  });

  test('C5 · ids from content that no longer exists are dropped with a report', () => {
    const manager = fresh();
    manager.startChapter('prologue');
    const payload = manager.serialize();
    payload.flags.push('a-flag-from-an-older-build');
    payload.clues.push('clue-that-was-cut');
    payload.completedMissions.push('m99-the-cut-mission');
    payload.activeMissions.push('m99-the-cut-mission');
    payload.regionsVisited.push('region-that-was-cut');
    payload.checksum = fnv1a(stableStringify((({ checksum, ...rest }) => rest)(payload)));

    const report = StoryState.deserialize(payload);
    assert.equal(report.ok, false, 'unknown ids passed silently');
    assert.gte(report.problems.length, 4, `expected a report per bad id, got ${report.problems.length}`);
    assert.notOk(report.state.hasFlag('a-flag-from-an-older-build'), 'an unknown flag was kept');
    assert.notOk(report.state.hasClue('clue-that-was-cut'), 'an unknown clue was kept');
    assert.notOk(report.state.activeMissions.has('m99-the-cut-mission'), 'an unknown mission stayed active');
    assert.equal(report.state.chapterId, 'prologue', 'valid progress was lost alongside the bad ids');
  });

  test('C6 · the same progress always serializes to the same bytes', () => {
    const build = () => {
      const m = fresh();
      m.startChapter('prologue');
      m.notify({ kind: EventKind.CLUE, id: 'clue-boundary-stone' });
      m.notify({ kind: EventKind.LANDMARK, id: 'lm-court-stele' });
      m.state.addSuspicion('evan', 30);
      m.state.setFlag(Flags.HEARD_DICTATION, 'mission');
      return stableStringify(m.serialize());
    };
    // Insertion order differs between the two builds; the bytes must not.
    assert.equal(build(), build(), 'serialization is not deterministic');
    const a = fresh(); a.state.flags.add(Flags.HEARD_DICTATION); a.state.clues.add('clue-cup-table');
    const b = fresh(); b.state.clues.add('clue-cup-table'); b.state.flags.add(Flags.HEARD_DICTATION);
    assert.equal(stableStringify(a.serialize()), stableStringify(b.serialize()),
      'set iteration order leaked into the save');
  });

  test('C7 · only the mission layer may write a mission-owned flag', () => {
    const state = new StoryState();
    for (const f of MISSION_OWNED_FLAGS) {
      assert.equal(state.setFlag(f, 'dialogue'), false, `dialogue wrote mission-owned "${f}"`);
      assert.notOk(state.hasFlag(f), `"${f}" was set despite the refusal`);
      assert.equal(state.setFlag(f, 'mission'), true, `the mission layer could not write "${f}"`);
    }
    assert.ok(state.violations.every((v) => v.kind === 'flag-ownership'),
      JSON.stringify(state.violations));
    assert.equal(state.setFlag('not-a-flag-at-all', 'mission'), false, 'an unknown flag was accepted');

    // And the refusal is wired, not just declared: a dialogue effect naming a
    // mission-owned flag must not land.
    const manager = fresh();
    autoWalk(DIALOGUE_MAP['dt-court-guards'], manager.state, { bus: new EventBus() });
    assert.deepEqual(manager.state.violations, [], 'a real walk crossed the ownership boundary');
  });
});

/* ================================================== D. mission progression */

describe('run-deep — mission progression', () => {
  test('D1 · chapters unlock strictly in order', () => {
    const manager = fresh();
    assert.equal(manager.chapterStatus('prologue'), MissionStatus.AVAILABLE, 'the prologue starts locked');
    for (const c of CHAPTERS.slice(1)) {
      assert.equal(manager.chapterStatus(c.id), MissionStatus.LOCKED, `${c.id} is open before the prologue ends`);
    }
    assert.equal(manager.startChapter('ch3').ok, false, 'a locked chapter was started');

    manager.startChapter('prologue');
    manager.completeMission('m01-dictation');
    assert.equal(manager.chapterStatus('prologue'), MissionStatus.COMPLETE, 'prologue did not close');
    // Closing a chapter opens the next one and starts its first mission, so ch1 is
    // already active rather than merely available.
    assert.equal(manager.chapterStatus('ch1'), MissionStatus.ACTIVE, 'ch1 did not open');
    assert.ok(manager.state.activeMissions.has('m02-sealed-tablets'),
      'ch1 opened but its first mission did not start');
    assert.equal(manager.chapterStatus('ch2'), MissionStatus.LOCKED, 'ch2 opened two chapters early');
  });

  test('D2 · a mission waits for the one before it in the same chapter', () => {
    const manager = managerAtChapter('ch3');
    // ch3 holds two missions, which is what makes this case exist at all.
    assert.equal(manager.missionsOf('ch3').length, 2, 'expected two missions in chapter 3');
    assert.equal(manager.missionStatus('m04-seven-doors'), MissionStatus.ACTIVE, 'opening the chapter should start m04');
    assert.equal(manager.missionStatus('m05-door-ring'), MissionStatus.LOCKED, 'm05 is open before m04 ends');
    assert.equal(manager.startMission('m05-door-ring').ok, false, 'a locked mission was started');

    // And a chapter that has not been reached cannot be opened at all.
    const cold = fresh();
    assert.equal(cold.startChapter('ch3').ok, false, 'chapter 3 opened from a cold start');
    assert.equal(cold.missionStatus('m04-seven-doors'), MissionStatus.LOCKED, 'm04 available from a cold start');
  });

  test('D3 · finishing a mid-chapter mission starts the next one', () => {
    // This was a dead end: chapter 3 closed only when both missions were done, and
    // nothing started the second, so the story stranded with no active mission.
    const manager = managerAtChapter('ch3');
    assert.ok(manager.state.activeMissions.has('m04-seven-doors'), 'm04 did not start');

    manager.completeMission('m04-seven-doors');
    assert.ok(manager.state.activeMissions.has('m05-door-ring'),
      `m05 was not started; active = ${[...manager.state.activeMissions].join(',') || 'none'}`);
    assert.equal(manager.missionStatus('m05-door-ring'), MissionStatus.ACTIVE, 'm05 is not active');
    assert.equal(manager.chapterStatus('ch3'), MissionStatus.ACTIVE, 'ch3 closed with a mission unfinished');
    assert.deepEqual(manager.problems, [], JSON.stringify(manager.problems));

    manager.completeMission('m05-door-ring');
    assert.equal(manager.chapterStatus('ch3'), MissionStatus.COMPLETE, 'ch3 did not close after its last mission');
    // The cascade opens the next chapter and starts its first mission in the same
    // breath, so ch4 is active rather than waiting to be opened.
    assert.equal(manager.chapterStatus('ch4'), MissionStatus.ACTIVE, 'ch4 did not open');
    assert.ok(manager.state.activeMissions.has('m06-cellar'),
      'ch4 opened but its first mission did not start');
    assert.equal(manager.chapterStatus('ch5'), MissionStatus.LOCKED, 'ch5 opened two chapters early');
  });

  test('D4 · concurrent missions never exceed MISSION.MAX_ACTIVE', () => {
    const manager = fresh();
    const director = new StoryDirector({ manager });
    let peak = 0;
    director.begin();
    for (let i = 0; i < 600 && !director.done; i++) {
      director.step();
      peak = Math.max(peak, manager.state.activeMissions.size);
    }
    assert.ok(director.done, `director never finished: ${director.stuckReason}`);
    assert.lte(peak, MISSION.MAX_ACTIVE, `${peak} missions active at once, cap is ${MISSION.MAX_ACTIVE}`);
    assert.gte(peak, 1, 'no mission was ever active');
  });

  test('D5 · an optional objective never blocks a mission from completing', () => {
    const manager = fresh();
    manager.startChapter('prologue');
    const mission = MISSION_MAP['m01-dictation'];
    const optional = mission.objectives.filter((o) => o.optional);
    assert.gt(optional.length, 0, 'm01 has no optional objective to test with');

    for (const o of mission.objectives.filter((x) => !x.optional)) {
      if (o.type === ObjectiveType.GOTO) manager.notify({ kind: EventKind.LANDMARK, id: o.target });
      else if (o.type === ObjectiveType.EXAMINE) manager.notify({ kind: EventKind.EXAMINE, id: o.target });
      else if (o.type === ObjectiveType.CLUE) manager.notify({ kind: EventKind.CLUE, id: o.target });
      else if (o.type === ObjectiveType.DIALOGUE) {
        autoWalk(DIALOGUE_MAP[o.target], manager.state, { bus: new EventBus() });
        manager.notify({ kind: EventKind.DIALOGUE, id: o.target });
      }
    }
    for (const o of optional) {
      assert.notOk(manager.isObjectiveComplete(mission.id, o.id), 'an optional objective completed itself');
    }
    assert.equal(manager.missionStatus(mission.id), MissionStatus.COMPLETE,
      'the mission waited on an optional objective');
    const progress = manager.missionProgress(mission.id);
    assert.equal(progress.requiredDone, progress.required, 'not every required objective is done');
    assert.equal(progress.optionalDone, 0, 'optional progress was counted');
  });

  test('D6 · a survive objective advances on time, and on nothing else', () => {
    const manager = managerAtChapter('ch2');
    const mission = MISSION_MAP['m03-feast'];
    const survive = mission.objectives.find((o) => o.type === ObjectiveType.SURVIVE);
    assert.ok(survive, 'm03 has no survive objective');
    assert.equal(survive.count, 20, 'unexpected survive duration');
    assert.ok(manager.state.activeMissions.has(mission.id), 'm03 is not active');

    // Events of every other kind must not tick a clock.
    manager.notify({ kind: EventKind.LANDMARK, id: 'lm-feast-tables' });
    manager.notify({ kind: EventKind.EXAMINE, id: 'lm-feast-dais' });
    manager.notify({ kind: EventKind.TAKEDOWN });
    manager.notify({ kind: EventKind.KILL });
    assert.equal(manager.objectiveProgress(mission.id, survive.id), 0,
      'a survive objective advanced without time passing');

    manager.update(1000);
    assert.close(manager.objectiveProgress(mission.id, survive.id), 1, 0.001, 'one second did not register');
    manager.update(19000);
    assert.ok(manager.isObjectiveComplete(mission.id, survive.id), '20 seconds did not complete the objective');
    const before = manager.objectiveProgress(mission.id, survive.id);
    manager.update(5000);
    assert.equal(manager.objectiveProgress(mission.id, survive.id), before, 'a done objective kept counting');
    manager.update(0);
    manager.update(-100);
    assert.equal(manager.objectiveProgress(mission.id, survive.id), before, 'a non-positive dt moved the clock');
  });

  test('D7 · a search objective counts distinct places, not repeated ones', () => {
    const manager = managerAtChapter('ch3');
    const mission = MISSION_MAP['m04-seven-doors'];
    assert.ok(manager.state.activeMissions.has(mission.id), 'm04 is not active');
    const search = mission.objectives.find((o) => o.type === ObjectiveType.SEARCH);
    assert.ok(search, 'm04 has no search objective');
    assert.equal(search.count, 6, 'unexpected search count');

    const places = searchablePlaces(search.target);
    assert.gte(places.length, search.count,
      `"${search.target}" has ${places.length} searchable places but the objective needs ${search.count}`);

    for (let i = 0; i < 10; i++) manager.notify({ kind: EventKind.SEARCH, id: places[0].id });
    assert.equal(manager.objectiveProgress(mission.id, search.id), 1,
      'searching the same place ten times counted as ten');
    assert.notOk(manager.isObjectiveComplete(mission.id, search.id), 'one place completed a six-place search');

    for (const p of places.slice(1, search.count)) manager.notify({ kind: EventKind.SEARCH, id: p.id });
    assert.ok(manager.isObjectiveComplete(mission.id, search.id), 'six distinct places did not complete it');
  });
});

/* ==================================================== E. soft-lock detection */

describe('run-deep — soft-lock detection', () => {
  test('E1 · no beat of a full playthrough leaves the player unable to continue', () => {
    const manager = fresh();
    const director = new StoryDirector({ manager });
    director.begin();
    const locks = [];
    for (let i = 0; i < 600 && !director.done; i++) {
      director.step();
      for (const l of manager.softLockReport()) locks.push(`beat ${i}: ${l.where} ${l.problem}`);
    }
    assert.ok(director.done, `director never finished: ${director.stuckReason}`);
    assert.deepEqual(locks, [], `${locks.length} soft locks: ${locks.slice(0, 3).join(' | ')}`);
    assert.deepEqual(manager.problems, [], JSON.stringify(manager.problems));
  });

  test('E2 · a conversation that cannot be exited is detected', () => {
    // A tree whose only exit is behind a clue: reachable, and a trap.
    const trapped = {
      id: 'synthetic-trap', entry: 'open',
      nodes: {
        open: { choices: [{ text: { en: 'a', ar: 'أ' }, next: 'payoff', requires: { clues: ['clue-cup-table'] } }] },
        payoff: { end: true },
      },
    };
    assert.equal(canFinish(trapped, NOTHING), false, 'the trap was reported as escapable');
    assert.equal(canFinish(trapped, EVERYTHING), true, 'the trap is not escapable even with everything');
    assert.equal(canFinishFrom(trapped, NOTHING, 'payoff'), true, 'canFinishFrom disagrees with the node');
    assert.deepEqual([...reachableNodes(trapped, NOTHING)], ['open'], 'a gated node was reached without the clue');

    const problems = objectiveSoftLocks(syntheticMission({
      objectives: [{ id: 'o1', type: ObjectiveType.DIALOGUE, target: trapped.id }],
    }), NOTHING);
    assert.ok(problems.some((p) => p.problem.includes('does not exist')),
      `an unknown tree was not reported: ${JSON.stringify(problems)}`);

    const real = objectiveSoftLocks(syntheticMission({
      chapter: 'ch4', region: 'cellar',
      objectives: [{ id: 'o1', type: ObjectiveType.DIALOGUE, target: 'dt-cellar-cage' }],
    }), NOTHING);
    assert.deepEqual(real, [], `a healthy objective was reported as locked: ${JSON.stringify(real)}`);
  });

  test('E3 · a search demanding more places than a region has is detected', () => {
    const region = 'palace-court';
    const available = searchablePlaces(region).length;
    assert.gt(available, 0, 'test needs a region with searchable places');

    const problems = objectiveSoftLocks(syntheticMission({
      chapter: CHAPTER_MAP[REGION_MAP[region].chapter].id, region,
      objectives: [{ id: 'o1', type: ObjectiveType.SEARCH, target: region, count: available + 50 }],
    }));
    assert.equal(problems.length, 1, `expected one problem, got ${JSON.stringify(problems)}`);
    assert.includes(problems[0].problem, 'searchable places', problems[0].problem);

    const fine = objectiveSoftLocks(syntheticMission({
      chapter: CHAPTER_MAP[REGION_MAP[region].chapter].id, region,
      objectives: [{ id: 'o1', type: ObjectiveType.SEARCH, target: region, count: available }],
    }));
    assert.deepEqual(fine, [], 'an exactly-satisfiable search was reported as locked');
  });

  test('E4 · an objective pointing outside its own chapter is detected', () => {
    // clue-boundary-stone is a prologue clue; chapter 4 is the cellar.
    const problems = objectiveSoftLocks(syntheticMission({
      chapter: 'ch4', region: 'cellar',
      objectives: [
        { id: 'o1', type: ObjectiveType.CLUE, target: 'clue-boundary-stone' },
        { id: 'o2', type: ObjectiveType.GOTO, target: 'lm-court-stele' },
        { id: 'o3', type: ObjectiveType.ESCAPE, target: 'palace-court' },
      ],
    }));
    assert.equal(problems.length, 3, `expected three problems, got ${JSON.stringify(problems)}`);
    for (const p of problems) assert.includes(p.problem, 'chapter', p.problem);

    // And the same objectives are fine in the chapter that owns them.
    const ok = objectiveSoftLocks(syntheticMission({
      chapter: 'prologue', region: 'palace-court',
      objectives: [
        { id: 'o1', type: ObjectiveType.CLUE, target: 'clue-boundary-stone' },
        { id: 'o2', type: ObjectiveType.GOTO, target: 'lm-court-stele' },
      ],
    }));
    assert.deepEqual(ok, [], JSON.stringify(ok));

    const orphan = objectiveSoftLocks(syntheticMission({ chapter: 'not-a-chapter', objectives: [] }));
    assert.equal(orphan.length, 1, 'a mission in a nonexistent chapter was not reported');

    // Completed objectives are not re-examined: a finished objective cannot lock.
    const done = objectiveSoftLocks(syntheticMission({
      chapter: 'ch4', region: 'cellar',
      objectives: [{ id: 'o1', type: ObjectiveType.CLUE, target: 'clue-boundary-stone' }],
    }), EVERYTHING, (mid, oid) => oid === 'o1');
    assert.deepEqual(done, [], 'a completed objective was reported as a soft lock');
  });
});

/* ================================================ F. story <-> built world */

describe('run-deep — story against the built world and nav graph', () => {
  test('F1 · every region the story uses is really built', () => {
    const missing = [];
    for (const m of MISSIONS) if (!world.regionSpaces.has(m.region)) missing.push(`${m.id}: ${m.region}`);
    for (const c of CINEMATICS) if (!world.regionSpaces.has(c.region)) missing.push(`${c.id}: ${c.region}`);
    for (const ch of CHAPTERS) {
      for (const r of ch.regions) if (!world.regionSpaces.has(r)) missing.push(`${ch.id}: ${r}`);
    }
    assert.deepEqual(missing, [], `unbuilt regions: ${missing.join(', ')}`);
    assert.equal(world.regionSpaces.size, REGIONS.length, 'not every region was built');
  });

  test('F2 · every landmark an objective names exists in the built space', () => {
    const missing = [];
    for (const { m, o } of allObjectives()) {
      if (!o.target) continue;
      const lm = LANDMARK_MAP[o.target];
      if (!lm) continue;
      const space = world.region(lm.region);
      if (!space.landmark(lm.id)) missing.push(`${m.id}/${o.id}: ${lm.id} not built in ${lm.region}`);
    }
    assert.deepEqual(missing, [], missing.join(' | '));
    // The two searchable places added to the hall for m02 are among them.
    const hall = world.region('palace-hall');
    assert.ok(hall.landmark('lm-hall-linen'), 'lm-hall-linen was declared but not built');
    assert.ok(hall.landmark('lm-hall-jars'), 'lm-hall-jars was declared but not built');
  });

  test('F3 · searchable places in the data match the built interactables', () => {
    const bad = [];
    for (const r of REGIONS) {
      const declared = searchablePlaces(r.id).map((l) => l.id).sort();
      const space = world.region(r.id);
      const built = space.interactables
        .filter((i) => i.interact === 'search' || i.kind === 'search')
        .map((i) => i.id).sort();
      // The built list may carry extra entries, but it must contain every declared
      // searchable place, or the player is asked to search something absent.
      for (const id of declared) {
        if (!built.includes(id) && !space.landmark(id)) bad.push(`${r.id}: ${id} declared searchable, not in the space`);
      }
    }
    assert.deepEqual(bad, [], bad.join(' | '));
    assert.gte(searchablePlaces('palace-hall').length, 3,
      'm02 needs three searchable places in the hall');
    assert.gte(searchablePlaces('brothers-wing').length, 6,
      'm04 needs six searchable places in the brothers’ wing');
  });

  test('F4 · every mission region is internally navigable', () => {
    const rng = new RNG(4242);
    const bad = [];
    const regions = [...new Set(MISSIONS.map((m) => m.region))];
    for (const id of regions) {
      const space = world.region(id);
      if (!space.pathfinder) { bad.push(`${id}: no pathfinder`); continue; }
      let ok = 0;
      for (let i = 0; i < 3; i++) {
        const p = space.randomWalkablePoint(rng);
        const q = space.randomWalkablePoint(rng);
        if (!p || !q) continue;
        if (space.pathfinder.findPath(p.x, p.z, q.x, q.z, GENEROUS).ok) ok++;
      }
      if (ok === 0) bad.push(`${id}: no route between any pair of walkable points`);
    }
    assert.deepEqual(bad, [], `unnavigable mission regions: ${bad.join(', ')}`);
  });

  test('F5 · randomWalkablePoint accepts either RNG shape, and neither is Math.random', () => {
    const space = world.region('palace-hall');
    const fromCore = space.randomWalkablePoint(new RNG(7));
    const fromAi = space.randomWalkablePoint(makeRng(7));
    const fromNone = space.randomWalkablePoint();
    for (const [name, p] of [['core RNG', fromCore], ['ai closure RNG', fromAi], ['no argument', fromNone]]) {
      assert.ok(p, `${name} produced no point`);
      assert.finite(p.x, `${name}: x is not finite`);
      assert.finite(p.z, `${name}: z is not finite`);
      assert.ok(space.nav.isWalkableAt(p.x, p.z), `${name}: the point is not walkable`);
    }
    // Determinism: the fallback must be seeded, not wall-clock or Math.random.
    const a = world.region('feast-hall').randomWalkablePoint();
    const w2 = new World({ seed: 'mesopotamia' }); w2.buildAll();
    const b = w2.region('feast-hall').randomWalkablePoint();
    assert.equal(a.x, b.x, 'the no-argument fallback is not reproducible');
    assert.equal(a.z, b.z, 'the no-argument fallback is not reproducible');
  });

  test('F6 · consecutive chapters are joined by regions that really connect', () => {
    const ordered = [...CHAPTERS].sort((a, b) => a.index - b.index);
    const bad = [];
    for (let i = 0; i < ordered.length - 1; i++) {
      // Reachable on foot, not necessarily through one door: the feast hall hangs
      // off the palace hall, so chapter 2 reaches chapter 3 by way of it. Requiring
      // a direct link would be a stricter rule than the world needs and would fail
      // on a layout that is perfectly walkable.
      const reach = reachableRegions(ordered[i].regions);
      const unreachable = ordered[i + 1].regions.filter((r) => !reach.has(r));
      if (unreachable.length) {
        bad.push(`${ordered[i].id} -> ${ordered[i + 1].id}: ${unreachable.join(', ')}`);
      }
    }
    assert.deepEqual(bad, [], `chapters the player cannot walk between: ${bad.join(' | ')}`);

    // The locked cellar door is the hinge between chapter 3 and chapter 4.
    const stair = world.region('cellar-stair');
    const cellar = world.region('cellar');
    assert.ok(stair.doorTo('cellar') || (REGION_MAP['cellar-stair'].connects ?? []).includes('cellar'),
      'the cellar stair does not reach the cellar');
    assert.ok(cellar.doorTo('cellar-stair') || (REGION_MAP['cellar'].connects ?? []).includes('cellar-stair'),
      'the link is one-way, which would trap the player in the cellar');
  });

  test('F7 · a guard can be placed and can path in a mission region', () => {
    const space = world.region('palace-hall');
    const spawn = space.spawnPoints[0];
    assert.ok(spawn, 'palace-hall has no spawn point');
    const target = space.randomWalkablePoint(new RNG(31));
    assert.ok(target, 'no walkable target in palace-hall');
    const route = space.pathfinder.findPath(spawn.x, spawn.z, target.x, target.z, GENEROUS);
    assert.ok(route.ok, `a guard could not path across the hall: ${route.reason}`);
    assert.gte(route.path.length, 2, 'a route with no waypoints');
    assert.gt(route.nodesExpanded, 0, 'the route was not really searched');
    for (const p of route.path) {
      assert.finite(p.x, 'a waypoint x is not finite');
      assert.finite(p.z, 'a waypoint z is not finite');
    }
  });

  test('F8 · the tactical path budget fails soft, not hard', () => {
    // Under the real per-frame budget a long query may not finish. What matters is
    // that it says so and can be retried, rather than hanging or returning a route
    // to nowhere.
    const space = world.region('palace-hall');
    const rng = new RNG(99);
    let sawFailure = null;
    for (let i = 0; i < 40 && !sawFailure; i++) {
      const p = space.randomWalkablePoint(rng);
      const q = space.randomWalkablePoint(rng);
      if (!p || !q) continue;
      const r = space.pathfinder.findPath(p.x, p.z, q.x, q.z);
      if (!r.ok) sawFailure = r;
    }
    if (sawFailure) {
      assert.equal(sawFailure.retryable, true,
        `a budget failure was not retryable: ${sawFailure.reason}`);
      assert.includes(['time-budget', 'node-budget'], sawFailure.reason,
        `unexpected failure reason: ${sawFailure.reason}`);
      assert.deepEqual(sawFailure.path, [], 'a failed query returned waypoints');
    }
    assert.lt(AI.PATH_TIME_BUDGET_MS_TACTICAL, PERF.AI_BUDGET_MS,
      'the tactical path budget must sit inside the frame AI budget');
    assert.ok(Number.isFinite(AI.PATH_TIME_BUDGET_MS_TACTICAL), 'path budget is not finite');
  });
});

/* ======================================================= G. frame budgets */

describe('run-deep — mission cost inside the frame budget', () => {
  test('G1 · update() with an active mission stays inside its budget', () => {
    const manager = fresh();
    manager.startChapter('ch2');
    const ms = measure(() => manager.update(16.67), 2000, 50);
    assert.lt(ms, MISSION.OBJECTIVE_BUDGET_MS,
      `update() took ${ms.toFixed(4)}ms, budget is ${MISSION.OBJECTIVE_BUDGET_MS}ms`);
    assert.finite(ms, 'update() timing is not finite');
  });

  test('G2 · notify() stays inside budget with the maximum active missions', () => {
    const manager = managerAtChapter('ch3');
    // Fill to the cap so the dispatch loop is measured at its worst real width
    // rather than at one mission.
    manager.state.activeMissions.add('m05-door-ring');
    manager.state.activeMissions.add('m06-cellar');
    assert.equal(manager.state.activeMissions.size, MISSION.MAX_ACTIVE, 'fixture did not reach the cap');

    const kinds = Object.values(EventKind);
    let i = 0;
    const ms = measure(() => {
      manager.notify({ kind: kinds[i++ % kinds.length], id: 'lm-hall-chest' });
    }, 2000, 50);
    assert.lt(ms, MISSION.OBJECTIVE_BUDGET_MS,
      `notify() took ${ms.toFixed(4)}ms, budget is ${MISSION.OBJECTIVE_BUDGET_MS}ms`);
  });

  test('G3 · a whole playthrough costs less than one second of wall clock', () => {
    const ms = measure(() => {
      const director = new StoryDirector({ language: 'ar' });
      director.run({ maxSteps: 600 });
    }, 5, 1);
    assert.lt(ms, 1000, `a full playthrough took ${ms.toFixed(1)}ms`);
    assert.finite(ms, 'playthrough timing is not finite');
  });

  test('G4 · the mission system emits the declared events, and only those', () => {
    const bus = new EventBus();
    const seen = new Map();
    const declared = new Set(Object.values(Events));
    const origEmit = bus.emit.bind(bus);
    bus.emit = (type, payload) => {
      assert.ok(declared.has(type), `an undeclared event type was emitted: "${type}"`);
      seen.set(type, (seen.get(type) ?? 0) + 1);
      return origEmit(type, payload);
    };
    const director = new StoryDirector({ bus, language: 'ar' });
    const report = director.run({ maxSteps: 600 });
    assert.ok(report.ok, `run failed: ${report.stuckReason}`);

    for (const type of [Events.CHAPTER_START, Events.CHAPTER_END, Events.MISSION_START,
      Events.MISSION_COMPLETE, Events.MISSION_OBJECTIVE, Events.CLUE_FOUND,
      Events.DIALOGUE_LINE, Events.DIALOGUE_END, Events.CUTSCENE_START]) {
      assert.gt(seen.get(type) ?? 0, 0, `${type} was never emitted during a playthrough`);
    }
    assert.equal(seen.get(Events.CHAPTER_START), CHAPTERS.length, 'one chapter start per chapter');
    assert.equal(seen.get(Events.MISSION_COMPLETE), MISSIONS.length, 'one completion per mission');
    assert.equal(seen.get(Events.CUTSCENE_START), CINEMATICS.length, 'one start per cinematic');
    assert.equal(seen.get(Events.MISSION_FAILED) ?? 0, 0, 'a mission failed during a clean playthrough');
  });
});

/* -------------------------------------------------------------------------
 * H — save STORAGE: slots, backups, autosave and a full disk.
 *
 * Group C above proves a story payload survives a serialize/deserialize round
 * trip. That is the payload. This group is the thing a player actually depends
 * on: that the bytes reach disk, that a torn write does not cost them the
 * session, that a full disk costs one old save rather than all of them, and
 * that autosave fires where the design says it does and not more often.
 *
 * None of this can be tested against a browser, so the backend is injected and
 * MemoryStorage can be given a byte ceiling that throws a quota error. The
 * full-disk path is therefore asserted, not hoped for.
 * ---------------------------------------------------------------------- */
describe('run-deep — save storage, slots and autosave', () => {
  const MID = Object.keys(MISSION_MAP)[0];
  const CLUE = Object.keys(CLUE_MAP)[0];
  const REGION = REGIONS[0].id;

  /** A state with real, recognized content in every field the envelope mirrors. */
  function state(playtimeMs = 5000, language = 'ar') {
    const st = new StoryState({ language, playtimeMs });
    st.missionId = MID;
    st.clues.add(CLUE);
    st.regionsVisited.add(REGION);
    st.completedMissions.add(MID);
    return st;
  }

  let clock = 1_000;
  const now = () => clock;
  const mk = (opts = {}) => new SaveSystem({
    storage: opts.storage ?? new MemoryStorage(),
    bus: opts.bus ?? new EventBus(),
    now,
    getState: opts.getState,
    debounceMs: opts.debounceMs,
  });

  test('H1 · a save round-trips through the storage layer intact', () => {
    const sys = mk();
    const res = sys.save(0, state(5000));
    assert.ok(res.ok, `save failed: ${res.reason}`);
    assert.gt(res.bytes, 0, 'a save must produce bytes');
    const loaded = sys.load(0);
    assert.ok(loaded.ok, `load failed: ${loaded.reason}`);
    assert.equal(loaded.state.missionId, MID, 'mission survived');
    assert.includes([...loaded.state.clues], CLUE, 'clue survived');
    assert.equal(loaded.state.playtimeMs, 5000, 'playtime survived');
    assert.equal(loaded.state.language, 'ar', 'language survived');
    assert.equal(loaded.problems.length, 0, 'a clean save must report no problems');
    assert.equal(loaded.usedBackup, false, 'the primary copy must be the one used');
  });

  test('H2 · the same progress produces the same bytes', () => {
    // Determinism is what makes the checksum meaningful. Without it a save would
    // change hash with nothing about the player's progress changed, and corruption
    // detection would be comparing noise.
    const sys = mk();
    const a = sys.save(0, state(5000));
    const b = sys.save(1, state(5000));
    assert.equal(a.bytes, b.bytes, 'identical progress must be identical in size');
    // The envelope checksum covers the slot it names, so two slots cannot be
    // byte-identical. What must be identical is the progress inside them.
    const payA = JSON.parse(sys.storage.getItem(sys.keyFor(0))).payload;
    const payB = JSON.parse(sys.storage.getItem(sys.keyFor(1))).payload;
    assert.equal(stableStringify(payA), stableStringify(payB),
      'identical progress must serialize to identical bytes');
    assert.equal(payA.checksum, payB.checksum, 'and therefore to an identical checksum');
  });

  test('H3 · a save list can be drawn without deserializing story state', () => {
    const sys = mk();
    sys.save(0, state(1000, 'ar'));
    const peeked = sys.peek(0);
    assert.ok(peeked, 'peek must find the slot');
    assert.equal(peeked.meta.playtimeMs, 1000, 'meta carries playtime');
    assert.equal(peeked.meta.language, 'ar', 'meta carries language');
    assert.equal(peeked.meta.clues, 1, 'meta carries clue count');
    assert.equal(peeked.meta.missionId, MID, 'meta carries the mission');
    assert.equal(peeked.savedAt, clock, 'meta carries the write time');
  });

  test('H4 · slot rules follow SAVE and reject anything else', () => {
    const sys = mk();
    assert.equal(sys.manualSlots().length, SAVE.MAX_SLOTS - 2,
      'autosave and quicksave take two of the declared slots');
    assert.ok(sys.validateSlot(SAVE.AUTOSAVE_SLOT).ok, 'autosave slot valid');
    assert.ok(sys.validateSlot(SAVE.QUICKSAVE_SLOT).ok, 'quicksave slot valid');
    assert.ok(sys.validateSlot(0).ok, 'first manual slot valid');
    assert.ok(!sys.validateSlot(SAVE.MAX_SLOTS).ok, 'one past the last slot invalid');
    for (const bad of [-1, 1.5, 'auto2', null, undefined, {}]) {
      assert.ok(!sys.validateSlot(bad).ok, `${JSON.stringify(bad)} must not be a slot`);
      assert.equal(sys.load(bad).status, SaveStatus.BAD_SLOT, 'load must refuse it');
      assert.equal(sys.save(bad, state()).status, SaveStatus.BAD_SLOT, 'save must refuse it');
    }
    assert.notEqual(SAVE.AUTOSAVE_SLOT, SAVE.QUICKSAVE_SLOT, 'they must not share a slot');
  });

  test('H5 · backup depth is MAX_CORRUPT_RETRIES, not a hardcoded number', () => {
    const sys = mk();
    assert.equal(sys.backups, SAVE.MAX_CORRUPT_RETRIES, 'backup count must follow the constant');
    for (let i = 0; i <= SAVE.MAX_CORRUPT_RETRIES + 2; i++) { clock += 10; sys.save(0, state(1000 + i)); }
    const copies = sys.audit().entries.filter((e) => e.slot === '0');
    assert.equal(copies.length, SAVE.MAX_CORRUPT_RETRIES + 1,
      'primary plus one backup per declared retry, and no more');
    assert.deepEqual(copies.map((c) => c.backup).sort((x, y) => x - y),
      Array.from({ length: SAVE.MAX_CORRUPT_RETRIES + 1 }, (_, i) => i),
      'backups are numbered from the primary outward with no gaps');
  });

  test('H6 · a torn write falls back to the previous good save', () => {
    // A tab closed mid-setItem leaves truncated JSON in the primary. This is the
    // single most likely real-world corruption, and it must not cost the session.
    const sys = mk();
    clock = 100; sys.save(0, state(1000));
    clock = 200; sys.save(0, state(9000));          // primary 9000, backup 1000
    sys.storage.setItem(sys.keyFor(0), '{"magic":"TBW1","trunc');
    const loaded = sys.load(0);
    assert.ok(loaded.ok, 'a backup must rescue a torn primary');
    assert.equal(loaded.usedBackup, true, 'and must say so');
    assert.equal(loaded.backup, 1, 'from the first backup');
    assert.equal(loaded.state.playtimeMs, 1000, 'the older, intact save is what loads');
    assert.equal(sys.stats.backupsUsed, 1, 'the fallback must be counted');
    assert.gt(sys.stats.corruptReads, 0, 'and so must the corrupt read');
  });

  test('H7 · an altered checksum falls back, and reports why', () => {
    const sys = mk();
    clock = 100; sys.save(0, state(1000));
    clock = 200; sys.save(0, state(9000));
    const raw = JSON.parse(sys.storage.getItem(sys.keyFor(0)));
    raw.payload.playtimeMs = 999999;                 // edited, checksum now stale
    sys.storage.setItem(sys.keyFor(0), JSON.stringify(raw));
    const loaded = sys.load(0);
    assert.ok(loaded.ok, 'the backup must still load');
    assert.equal(loaded.usedBackup, true, 'an untrusted primary must not be used');
    assert.equal(loaded.state.playtimeMs, 1000, 'the edited value must not be believed');
    assert.ok(loaded.problems.some((p) => /checksum/i.test(p)), 'the reason must be reported');
  });

  test('H8 · every copy corrupt is a clean failure, never a throw', () => {
    const sys = mk();
    clock = 100; sys.save(0, state(1000));
    clock = 200; sys.save(0, state(2000));
    for (let d = 0; d <= sys.backups; d++) sys.storage.setItem(sys.keyFor(0, d), 'garbage');
    let res = null;
    assert.doesNotThrow(() => { res = sys.load(0); }, 'loading corruption must not throw');
    assert.equal(res.ok, false, 'and must not pretend to succeed');
    assert.equal(res.status, SaveStatus.CORRUPT, 'with the corrupt status');
    assert.gte(res.problems.length, sys.backups + 1, 'one problem per unreadable copy');
  });

  test('H9 · an empty slot is NOT_FOUND, which is not the same as corrupt', () => {
    const sys = mk();
    const res = sys.load(3);
    assert.equal(res.ok, false);
    assert.equal(res.status, SaveStatus.NOT_FOUND, 'a new player has no save, and that is not an error');
    assert.equal(sys.peek(3), null, 'peek agrees');
    assert.equal(sys.has(3), false, 'has agrees');
  });

  test('H10 · unrecognized content loads anyway; a bad checksum does not', () => {
    // This is the leniency boundary, and the whole reason the two checks differ.
    // A save from a build whose content changed should still play. A save whose
    // integrity cannot be vouched for should not be trusted at all.
    const sys = mk();
    clock = 100; sys.save(0, state(1000));
    const raw = JSON.parse(sys.storage.getItem(sys.keyFor(0)));
    raw.payload.clues = [...raw.payload.clues, 'clue-that-never-existed'];
    raw.payload.checksum = fnv1a(stableStringify((({ checksum, ...rest }) => rest)(raw.payload)));
    raw.checksum = fnv1a(stableStringify((({ checksum, ...rest }) => rest)(raw)));
    sys.storage.setItem(sys.keyFor(0), stableStringify(raw));
    const loaded = sys.load(0);
    assert.ok(loaded.ok, 'a content difference must not stop the save loading');
    assert.equal(loaded.usedBackup, false, 'the primary is still trusted');
    assert.ok(loaded.problems.some((p) => /unrecognized/i.test(p)), 'and the drop is reported');
    assert.excludes([...loaded.state.clues], 'clue-that-never-existed', 'the unknown id is dropped');
    assert.includes([...loaded.state.clues], CLUE, 'while the real one survives');
  });

  test('H11 · autosave fires on every declared trigger', () => {
    for (const trigger of SAVE.AUTOSAVE_EVENTS) {
      assert.ok(AUTOSAVE_TRIGGERS[trigger], `"${trigger}" is declared but maps to no bus event`);
    }
    const bus = new EventBus();
    const autosaved = [];
    bus.on(Events.AUTOSAVE, (p) => autosaved.push(p.trigger));
    const st = state(1000);
    const sys = mk({ bus, getState: () => st, debounceMs: 0 });
    assert.ok(sys.attachAutosave(), 'autosave must attach');
    clock = 1000; bus.emit(Events.CHAPTER_START, {});
    clock = 2000; bus.emit(Events.MISSION_COMPLETE, {});
    clock = 3000; bus.emit(Events.SIDEQUEST_COMPLETE, {});
    clock = 4000; bus.emit(Events.PLAYER_ENTERED_REGION, {});
    clock = 5000; bus.emit(Events.DETECTION, {});
    assert.deepEqual(autosaved.sort(),
      ['chapter-start', 'mission-complete', 'mission-complete', 'pre-danger', 'region-enter'].sort(),
      'each declared trigger must write, and only those');
    assert.ok(sys.has(SAVE.AUTOSAVE_SLOT), 'the autosave slot must be occupied');
  });

  test('H12 · pre-danger saves on detection, never on being spotted', () => {
    // Saving once the player is already seen writes a failure into the save and
    // hands it straight back on reload: a checkpoint that cannot be used to avoid
    // the thing it was loaded to avoid.
    assert.deepEqual([...AUTOSAVE_TRIGGERS['pre-danger']], [Events.DETECTION],
      'pre-danger must map to detection only');
    assert.excludes([...AUTOSAVE_TRIGGERS['pre-danger']], Events.SPOTTED,
      'being spotted is too late to checkpoint');
    const bus = new EventBus();
    let count = 0;
    bus.on(Events.AUTOSAVE, () => count++);
    const sys = mk({ bus, getState: () => state(1), debounceMs: 0 });
    sys.attachAutosave();
    bus.emit(Events.SPOTTED, {});
    bus.emit(Events.TAKEDOWN, {});
    bus.emit(Events.PLAYER_DIED, {});
    assert.equal(count, 0, 'no combat or death event may trigger an autosave');
    bus.emit(Events.DETECTION, {});
    assert.equal(count, 1, 'detection does');
  });

  test('H13 · autosave is debounced, so border-hopping cannot thrash storage', () => {
    const bus = new EventBus();
    const sys = mk({ bus, getState: () => state(1), debounceMs: SAVE.AUTOSAVE_DEBOUNCE_MS });
    sys.attachAutosave();
    clock = 10_000; bus.emit(Events.PLAYER_ENTERED_REGION, {});
    assert.equal(sys.stats.autosaves, 1, 'the first transition saves');
    clock = 10_500; bus.emit(Events.PLAYER_ENTERED_REGION, {});
    clock = 11_000; bus.emit(Events.PLAYER_ENTERED_REGION, {});
    assert.equal(sys.stats.autosaves, 1, 'transitions inside the window must not');
    assert.equal(sys.stats.debounced, 2, 'and must be counted, not silently ignored');
    clock = 10_000 + SAVE.AUTOSAVE_DEBOUNCE_MS; bus.emit(Events.PLAYER_ENTERED_REGION, {});
    assert.equal(sys.stats.autosaves, 2, 'once the window passes, it saves again');
  });

  test('H14 · a failed autosave does not consume its debounce window', () => {
    // Recording the timestamp before the write would mean a save that failed on a
    // full disk still blocks the next attempt, so the player loses both.
    const bus = new EventBus();
    const storage = new MemoryStorage({ limit: 10 });
    const sys = mk({ storage, bus, getState: () => state(1), debounceMs: 5000 });
    sys.attachAutosave();
    clock = 1000; bus.emit(Events.CHAPTER_START, {});
    assert.equal(sys.stats.autosaves, 0, 'the write could not have fit');
    assert.equal(sys.stats.debounced, 0, 'and it must not count as debounced');
    storage.limit = Infinity;
    clock = 1100; bus.emit(Events.CHAPTER_START, {});
    assert.equal(sys.stats.autosaves, 1, 'the very next trigger must be allowed to retry');
  });

  test('H15 · autosave without a state supplier reports rather than throws', () => {
    const bus = new EventBus();
    const errors = [];
    bus.on(Events.ERROR, (e) => errors.push(e));
    const sys = mk({ bus });
    assert.equal(sys.attachAutosave(), false, 'attaching with no getState must refuse');
    assert.equal(errors.length, 1, 'and must say why');
    assert.equal(sys.autosave().status, SaveStatus.NO_STATE, 'a manual autosave reports NO_STATE');
  });

  test('H16 · detaching autosave really stops it', () => {
    const bus = new EventBus();
    const sys = mk({ bus, getState: () => state(1), debounceMs: 0 });
    sys.attachAutosave();
    clock = 1000; bus.emit(Events.CHAPTER_START, {});
    assert.equal(sys.stats.autosaves, 1);
    sys.detachAutosave();
    clock = 99_000; bus.emit(Events.CHAPTER_START, {});
    bus.emit(Events.MISSION_COMPLETE, {});
    bus.emit(Events.DETECTION, {});
    assert.equal(sys.stats.autosaves, 1, 'no trigger may fire after detach');
    assert.equal(sys.subscriptions.length, 0, 'and no listener may be left behind');
  });

  test('H17 · a full disk costs one old save, not every manual slot', () => {
    const storage = new MemoryStorage({ limit: 2000 });
    const bus = new EventBus();
    const toasts = [];
    bus.on(Events.TOAST, (t) => toasts.push(t));
    const sys = mk({ storage, bus });
    clock = 10; sys.save(0, state(10));
    clock = 20; sys.save(1, state(20));
    clock = 30; sys.save(2, state(30));
    clock = 40;
    const res = sys.save(3, state(40));
    assert.ok(res.ok, `the write should have succeeded after pruning: ${res.reason}`);
    assert.equal(sys.stats.quotaHits, 1, 'the quota error must have been hit');
    assert.equal(res.pruned.length, 1, 'exactly one entry sacrificed, not a sweep');
    assert.equal(sys.has(0), false, 'the oldest manual slot is the one that goes');
    assert.ok(sys.has(1) && sys.has(2), 'the newer saves must survive');
    assert.equal(toasts.length, 1, 'and the player must be told');
    assert.equal(toasts[0].kind, 'save-pruned', 'with a kind the UI can localize');
  });

  test('H18 · pruning order is backups first, then oldest manual, never autosave', () => {
    const sys = mk();
    clock = 50; sys.save(1, state(50));
    sys.storage.setItem(sys.keyFor(1, 1), sys.storage.getItem(sys.keyFor(1)));
    sys.storage.setItem(sys.keyFor(1, 2), sys.storage.getItem(sys.keyFor(1)));
    clock = 20; sys.save(2, state(20));
    sys.storage.setItem(sys.keyFor(SAVE.AUTOSAVE_SLOT), '{"savedAt":5}');
    sys.storage.setItem(sys.keyFor(SAVE.QUICKSAVE_SLOT), '{"savedAt":90}');
    const order = sys._pruneOrder(sys.keyFor(0), 0).map((k) => k.slice(SAVE.KEY_PREFIX.length));
    assert.deepEqual(order.slice(0, 2), ['1.b2', '1.b1'], 'the oldest backups go first');
    assert.equal(order[2], '2', 'then the oldest manual primary');
    assert.equal(order[3], '1', 'then the newer one');
    assert.excludes(order, SAVE.AUTOSAVE_SLOT, 'autosave is never a candidate');
    assert.excludes(order, SAVE.QUICKSAVE_SLOT, 'quicksave is never a candidate');
    assert.excludes(order, '0', 'nor is the slot being written');
  });

  test('H19 · a disk that cannot fit the save fails loudly', () => {
    const bus = new EventBus();
    const failures = [];
    bus.on(Events.SAVE_FAILED, (f) => failures.push(f));
    const sys = mk({ storage: new MemoryStorage({ limit: 40 }), bus });
    let res = null;
    assert.doesNotThrow(() => { res = sys.save(0, state(1)); }, 'a full disk must not throw');
    assert.equal(res.ok, false);
    assert.equal(res.status, SaveStatus.QUOTA, 'and must be identified as quota');
    assert.includes(res.reason, 'storage full', 'with a reason a log can carry');
    assert.equal(failures.length, 1, 'the failure must reach the bus for the UI');
  });

  test('H20 · listSlots and newestSlot describe what "Continue" means', () => {
    const sys = mk();
    assert.equal(sys.listSlots().length, SAVE.MAX_SLOTS, 'every declared slot is listed');
    assert.deepEqual(sys.listSlots().map((s) => s.occupied),
      new Array(SAVE.MAX_SLOTS).fill(false), 'all empty at first');
    assert.equal(sys.newestSlot(), null, 'with nothing saved there is nothing to continue');
    clock = 100; sys.save(1, state(100));
    clock = 900; sys.save(SAVE.AUTOSAVE_SLOT, state(900));
    clock = 500; sys.save(0, state(500));
    assert.equal(sys.newestSlot(), SAVE.AUTOSAVE_SLOT, 'the newest write is the continue slot');
    const list = sys.listSlots();
    assert.equal(list.find((s) => s.slot === SAVE.AUTOSAVE_SLOT).isAutosave, true, 'flagged as autosave');
    assert.equal(list.find((s) => s.slot === SAVE.QUICKSAVE_SLOT).isQuicksave, true, 'flagged as quicksave');
    assert.equal(list.filter((s) => s.occupied).length, 3, 'occupancy is accurate');
  });

  test('H21 · quicksave and quickload use their own slot and leave manual saves alone', () => {
    const sys = mk({ getState: () => state(4242) });
    clock = 10; sys.save(0, state(10));
    clock = 20;
    assert.ok(sys.quicksave().ok, 'quicksave may pull state from getState');
    assert.equal(sys.quickload().state.playtimeMs, 4242, 'and quickload returns it');
    assert.equal(sys.load(0).state.playtimeMs, 10, 'the manual slot is untouched');
    assert.equal(sys.quicksave().ok, true, 'an explicit state also works');
  });

  test('H22 · remove clears a slot and its backups, and audit accounts for every byte', () => {
    const sys = mk();
    clock = 10; sys.save(0, state(10));
    clock = 20; sys.save(0, state(20));
    clock = 30; sys.save(1, state(30));
    const before = sys.audit();
    assert.equal(before.entries.length, 3, 'primary, backup and another slot');
    assert.gt(before.totalBytes, 0, 'and the bytes are accounted for');
    assert.equal(sys.remove(0).removed, 2, 'both copies of slot 0 go');
    assert.equal(sys.has(0), false, 'the slot is empty');
    assert.ok(sys.has(1), 'and the other slot is untouched');
    const after = sys.audit();
    assert.equal(after.entries.length, 1, 'only slot 1 remains');
    assert.ok(after.entries.every((e) => e.readable), 'everything left is readable');
    assert.equal(sys.remove(0).removed, 0, 'removing an empty slot is a no-op');
  });

  test('H23 · with no storage injected, saves still work and are marked volatile', () => {
    // Private-mode browsers and file:// pages may have no persistent storage. The
    // game must still run, and must be able to tell the player progress will not
    // survive the session rather than failing on the first save.
    const sys = new SaveSystem({ bus: new EventBus(), now });
    assert.equal(sys.volatile, true, 'no injected storage means volatile');
    assert.ok(sys.save(0, state(1)).ok, 'saving must still work in memory');
    assert.ok(sys.load(0).ok, 'and loading');
    const injected = new SaveSystem({ storage: new MemoryStorage(), bus: new EventBus(), now });
    assert.equal(injected.volatile, false, 'an injected backend is not volatile');
  });

  test('H24 · storage work stays inside the frame budget', () => {
    const sys = mk();
    const st = state(1000);
    const saveMs = measure(() => { clock += 1; sys.save(0, st); }, 200, 20);
    const loadMs = measure(() => sys.load(0), 200, 20);
    assert.lt(saveMs, PERF.FRAME_BUDGET_MS,
      `a save took ${saveMs.toFixed(3)}ms against a ${PERF.FRAME_BUDGET_MS}ms frame`);
    assert.lt(loadMs, PERF.FRAME_BUDGET_MS,
      `a load took ${loadMs.toFixed(3)}ms against a ${PERF.FRAME_BUDGET_MS}ms frame`);
  });
});

runAndExit();
