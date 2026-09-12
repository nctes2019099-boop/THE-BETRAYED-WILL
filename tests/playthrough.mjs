/**
 * THE BETRAYED WILL — playthrough.mjs
 *
 * Level 3 (charter §21): play the game. Start, prologue, chapters one through six,
 * epilogue.
 *
 * run-deep asks whether the systems agree with each other. This asks the only
 * question a player can ask: does it finish? A story game can pass every unit and
 * integration test in the world and still strand someone in chapter four, and the
 * only way to know is to walk it end to end and look at what came out the other
 * side.
 *
 * Everything here is driven through StoryDirector, which uses the same public
 * `notify()` path the shipped game uses and really walks each conversation through
 * DialogueWalker. Nothing is marked complete by assertion.
 *
 * Run: node tests/playthrough.mjs
 */

import { describe, test, assert, runAndExit } from './harness.mjs';
import { EventBus, Events } from '../src/core/bus.js';
import {
  CHAPTERS, CHARACTERS, CINEMATICS, CLUES, CLUE_MAP, MISSIONS, MISSION_MAP,
} from '../src/content/story.js';
import { DIALOGUE_MAP, DIALOGUE_TREES, Flags } from '../src/content/dialogue.js';
import { MissionManager, StoryDirector } from '../src/sim/mission.js';
import { StoryState } from '../src/sim/story-state.js';

const ARABIC = /[\u0600-\u06FF]/;
const LATIN_RUN = /[A-Za-z]{2,}/;

const chaptersInOrder = [...CHAPTERS].sort((a, b) => a.index - b.index);
const missionsInOrder = [...MISSIONS].sort((a, b) => a.index - b.index);

/**
 * Play the whole game with a recorder on the bus.
 *
 * The recorder is what makes the ordering assertions possible: the director's own
 * beat log records only what the director chose to do, while the bus records what
 * the game actually announced, which is the thing a player experiences.
 */
function play({ language = 'ar', maxSteps = 600, stopWhen = null, seedState = null } = {}) {
  const bus = new EventBus();
  const rec = {
    chapters: [], missionsCompleted: [], cluesFound: [], treesSpoken: [],
    cinematics: [], subtitles: [], lines: [], objectiveTexts: [],
  };
  let currentChapter = null;

  bus.on(Events.CHAPTER_START, (p) => { currentChapter = p.chapterId; rec.chapters.push(p.chapterId); });
  bus.on(Events.MISSION_COMPLETE, (p) => rec.missionsCompleted.push(p.missionId));
  bus.on(Events.CLUE_FOUND, (p) => rec.cluesFound.push({ id: p.clueId, chapter: currentChapter }));
  bus.on(Events.DIALOGUE_START, (p) => rec.treesSpoken.push({ id: p.treeId, chapter: currentChapter }));
  bus.on(Events.CUTSCENE_START, (p) => rec.cinematics.push({ id: p.cinematicId, chapter: currentChapter }));
  bus.on(Events.DIALOGUE_LINE, (p) => rec.lines.push(p.text));
  bus.on(Events.SUBTITLE, (p) => rec.subtitles.push(p.text));

  const manager = new MissionManager({ bus, language });
  if (seedState) manager.restore(seedState);
  const director = new StoryDirector({ bus, manager, language });
  director.begin();
  for (let i = 0; i < maxSteps && !director.done; i++) {
    director.step();
    if (stopWhen && stopWhen(manager, director)) break;
  }
  if (!stopWhen) director.run({ maxSteps });
  return { bus, rec, manager, director, report: director.report(), state: manager.state };
}

/* ================================================ 1. the story can be finished */

describe('playthrough — start to epilogue', () => {
  const game = play();

  test('P1 · the game is completable from a cold start to the epilogue', () => {
    assert.ok(game.report.ok, `the playthrough got stuck: ${game.report.stuckReason}`);
    assert.ok(game.report.storyComplete, 'the story did not report itself complete');
    assert.equal(game.report.chapters, CHAPTERS.length,
      `${game.report.chapters} of ${CHAPTERS.length} chapters finished`);
    assert.equal(game.report.missions, MISSIONS.length,
      `${game.report.missions} of ${MISSIONS.length} missions finished`);
    assert.equal(game.state.completedMissions.size, MISSIONS.length, 'a mission was reported but not recorded');
    for (const c of CHAPTERS) {
      assert.ok(game.state.isChapterComplete(c.id), `chapter ${c.id} never closed`);
    }
  });

  test('P2 · the chapters arrive in the authored order, prologue to epilogue', () => {
    const expected = chaptersInOrder.map((c) => c.id);
    assert.deepEqual(game.rec.chapters, expected,
      `chapter order was ${game.rec.chapters.join(' -> ')}`);
    assert.equal(game.rec.chapters[0], 'prologue', 'the game does not open on the prologue');
    assert.equal(game.rec.chapters[game.rec.chapters.length - 1], 'epilogue', 'the game does not end on the epilogue');
  });

  test('P3 · the missions complete in the authored order', () => {
    const expected = missionsInOrder.map((m) => m.id);
    assert.deepEqual(game.rec.missionsCompleted, expected,
      `mission order was ${game.rec.missionsCompleted.join(' -> ')}`);
    // A mission must never complete before the chapter that owns it opened.
    for (let i = 0; i < game.rec.missionsCompleted.length; i++) {
      const mission = MISSION_MAP[game.rec.missionsCompleted[i]];
      const chapterAt = game.rec.chapters.indexOf(mission.chapter);
      assert.gte(chapterAt, 0, `${mission.id} completed but its chapter never opened`);
    }
  });

  test('P4 · all ten clues are found, each in or after the chapter that hides it', () => {
    const found = new Set(game.rec.cluesFound.map((c) => c.id));
    const missing = CLUES.filter((c) => !found.has(c.id)).map((c) => c.id);
    assert.deepEqual(missing, [], `clues never found: ${missing.join(', ')}`);
    assert.equal(found.size, CLUES.length, 'a clue was found twice and another not at all');

    const order = chaptersInOrder.map((c) => c.id);
    const early = [];
    for (const f of game.rec.cluesFound) {
      const clue = CLUE_MAP[f.id];
      if (order.indexOf(f.chapter) < order.indexOf(clue.chapter)) {
        early.push(`${f.id} found in ${f.chapter}, authored for ${clue.chapter}`);
      }
    }
    assert.deepEqual(early, [], `clues found before their chapter: ${early.join(' | ')}`);
  });

  test('P5 · all fourteen conversations happen, each in its own chapter', () => {
    const spoken = new Set(game.rec.treesSpoken.map((t) => t.id));
    const missing = DIALOGUE_TREES.filter((t) => !spoken.has(t.id)).map((t) => t.id);
    assert.deepEqual(missing, [], `conversations that never happened: ${missing.join(', ')}`);
    assert.equal(spoken.size, 14, 'expected all fourteen trees spoken once');

    const order = chaptersInOrder.map((c) => c.id);
    const misplaced = game.rec.treesSpoken.filter((t) => {
      const tree = DIALOGUE_MAP[t.id];
      return tree && order.indexOf(t.chapter) !== order.indexOf(tree.chapter);
    }).map((t) => `${t.id} in ${t.chapter}`);
    assert.deepEqual(misplaced, [], `conversations out of chapter: ${misplaced.join(', ')}`);
  });

  test('P6 · all nine cinematics play, each in its own chapter', () => {
    const seen = new Set(game.rec.cinematics.map((c) => c.id));
    const missing = CINEMATICS.filter((c) => !seen.has(c.id)).map((c) => c.id);
    assert.deepEqual(missing, [], `cinematics that never played: ${missing.join(', ')}`);
    assert.equal(seen.size, CINEMATICS.length, 'a cinematic played twice and another never');

    const order = chaptersInOrder.map((c) => c.id);
    const misplaced = game.rec.cinematics.filter((c) => {
      const cin = CINEMATICS.find((x) => x.id === c.id);
      return cin && order.indexOf(c.chapter) < order.indexOf(cin.chapter);
    }).map((c) => `${c.id} in ${c.chapter}`);
    assert.deepEqual(misplaced, [], `cinematics played early: ${misplaced.join(', ')}`);
  });

  test('P7 · the player is never left unable to continue, and nothing misbehaves', () => {
    assert.deepEqual(game.report.violations, [],
      `state violations: ${JSON.stringify(game.report.violations)}`);
    assert.deepEqual(game.report.problems, [],
      `manager problems: ${JSON.stringify(game.report.problems)}`);
    assert.equal(game.report.stuckReason, null, 'the director reported a stuck reason');
    for (const b of game.director.beats) {
      assert.notEqual(b.type, 'stuck', `beat ${b.index} got stuck: ${b.reason}`);
    }
    // Every region the story names was actually entered.
    assert.equal(game.report.regions, 20, `only ${game.report.regions} of 20 regions were visited`);
    assert.equal(game.report.treesSeen, 14, 'a conversation was walked but not recorded as seen');
  });

  test('P8 · the mystery is solvable from the evidence the player collects', () => {
    const traitor = Object.values(CHARACTERS).find((c) => c.traitor === true);
    assert.ok(traitor, 'no character is marked as the traitor');
    assert.equal(traitor.id, 'evan', 'the traitor is not Evan');

    const weight = new Map();
    const accused = new Set();
    for (const c of game.state.clues) {
      const clue = CLUE_MAP[c];
      if (!clue || !clue.incriminates) continue;
      accused.add(clue.incriminates);
      weight.set(clue.incriminates, (weight.get(clue.incriminates) ?? 0) + (clue.weight ?? 1));
    }
    // More than one suspect, or there is no mystery to solve - only a confession.
    assert.gte(accused.size, 2, `only ${accused.size} suspect is ever implicated`);
    assert.gte(weight.get(traitor.id) ?? 0, 3,
      `fewer than three clues point at ${traitor.id}: ${weight.get(traitor.id) ?? 0}`);

    // And the evidence must actually point hardest at the guilty brother. A mystery
    // whose weight lands on an innocent suspect is not hard, it is unfair.
    for (const [id, w] of weight) {
      if (id === traitor.id) continue;
      assert.lt(w, weight.get(traitor.id),
        `${id} carries ${w} of suspicion against ${traitor.id}'s ${weight.get(traitor.id)} - the evidence frames an innocent brother`);
    }
    // Someone innocent must be implicated at all, or the player has nothing to weigh.
    const innocents = [...accused].filter((id) => id !== traitor.id);
    assert.gte(innocents.length, 1, 'no innocent brother is ever suspected');
  });

  test('P9 · the ending is the one the story promises', () => {
    assert.ok(game.state.hasFlag(Flags.EVAN_CORNERED), 'Evan was never cornered');
    assert.ok(game.state.hasFlag(Flags.WILL_READ_ALOUD), 'the true will was never read aloud');
    assert.ok(game.state.hasFlag(Flags.LAYLA_TRUSTS), 'the epilogue never reached Layla');
    assert.ok(game.state.hasClue('clue-temple-archive'), 'the temple’s copy was never recovered');
    assert.equal(game.state.chapterId, 'epilogue', `the game ended in ${game.state.chapterId}`);
    assert.equal(game.state.missionId, null, 'a mission was still open at the end');
    assert.equal(game.state.activeMissions.size, 0, 'missions were still active at the end');
    assert.gt(game.state.playtimeMs, 0, 'the playthrough took no time at all');
  });
});

/* ================================================== 2. surviving an interruption */

describe('playthrough — interruption and resumption', () => {
  test('P10 · saving in chapter four and reloading still reaches the same ending', () => {
    const first = play({ stopWhen: (m) => m.state.chapterId === 'ch4' });
    assert.equal(first.state.chapterId, 'ch4', 'the checkpoint was not taken in chapter 4');
    assert.notOk(first.manager.isStoryComplete(), 'the story was already over at the checkpoint');
    const doneBefore = first.state.completedMissions.size;
    assert.gt(doneBefore, 0, 'nothing had happened by chapter 4');

    const payload = first.manager.serialize();
    const resumed = play({ seedState: payload });
    assert.ok(resumed.report.ok, `the resumed game got stuck: ${resumed.report.stuckReason}`);
    assert.ok(resumed.report.storyComplete, 'the resumed game did not finish');
    assert.equal(resumed.report.missions, MISSIONS.length, 'not every mission finished after a reload');
    assert.ok(resumed.state.hasFlag(Flags.WILL_READ_ALOUD), 'the ending changed after a reload');
    assert.equal(resumed.state.completedChapters.size, CHAPTERS.length, 'a chapter was lost across the save');
  });

  test('P11 · two identical playthroughs produce identical stories', () => {
    const a = play();
    const b = play();
    assert.deepEqual(a.rec.chapters, b.rec.chapters, 'chapter order differed between runs');
    assert.deepEqual(a.rec.missionsCompleted, b.rec.missionsCompleted, 'mission order differed between runs');
    assert.deepEqual(a.rec.cluesFound.map((c) => c.id), b.rec.cluesFound.map((c) => c.id),
      'clue order differed between runs');
    assert.deepEqual(a.rec.treesSpoken.map((t) => t.id), b.rec.treesSpoken.map((t) => t.id),
      'conversation order differed between runs');
    assert.deepEqual([...a.state.flags].sort(), [...b.state.flags].sort(), 'the ending flags differed');
    assert.deepEqual([...a.state.clues].sort(), [...b.state.clues].sort(), 'the collected clues differed');
    assert.equal(a.director.beats.length, b.director.beats.length,
      `runs took ${a.director.beats.length} and ${b.director.beats.length} beats`);
    assert.deepEqual(a.director.beats.map((x) => x.type), b.director.beats.map((x) => x.type),
      'the beat sequence differed between runs');
  });
});

/* ==================================================== 3. Arabic is first-class */

describe('playthrough — language', () => {
  test('P12 · an Arabic playthrough speaks Arabic from start to epilogue', () => {
    const game = play({ language: 'ar' });
    assert.ok(game.report.ok, `the Arabic run got stuck: ${game.report.stuckReason}`);
    assert.gt(game.rec.lines.length, 40,
      `only ${game.rec.lines.length} lines were spoken - the run cannot have covered the story`);
    assert.gt(game.rec.subtitles.length, 0, 'no subtitles were emitted');

    const notArabic = game.rec.lines.filter((t) => !ARABIC.test(t));
    assert.deepEqual(notArabic, [],
      `${notArabic.length} spoken lines carried no Arabic: ${notArabic.slice(0, 2).join(' | ')}`);
    const latinLeak = game.rec.lines.filter((t) => LATIN_RUN.test(t));
    assert.deepEqual(latinLeak, [],
      `${latinLeak.length} Arabic lines carried Latin script: ${latinLeak.slice(0, 2).join(' | ')}`);
    assert.deepEqual(game.rec.lines, game.rec.subtitles,
      'the subtitle track and the dialogue track disagree');
  });

  test('P13 · an English playthrough speaks English, and the tracker follows the language', () => {
    const game = play({ language: 'en' });
    assert.ok(game.report.ok, `the English run got stuck: ${game.report.stuckReason}`);
    const notEnglish = game.rec.lines.filter((t) => !LATIN_RUN.test(t));
    assert.deepEqual(notEnglish, [],
      `${notEnglish.length} lines carried no Latin script: ${notEnglish.slice(0, 2).join(' | ')}`);
    const arabicLeak = game.rec.lines.filter((t) => ARABIC.test(t));
    assert.deepEqual(arabicLeak, [],
      `${arabicLeak.length} English lines carried Arabic script: ${arabicLeak.slice(0, 2).join(' | ')}`);

    // The same story, told in the other language, must reach the same ending.
    const arabic = play({ language: 'ar' });
    assert.deepEqual([...game.state.clues].sort(), [...arabic.state.clues].sort(),
      'the two languages collect different clues');
    assert.equal(game.rec.lines.length, arabic.rec.lines.length,
      'the two languages speak a different number of lines');

    // And the mission tracker itself is localized, for every objective in the game.
    for (const language of ['ar', 'en']) {
      const m = new MissionManager({ bus: new EventBus(), language });
      m.startChapter('prologue');
      let checked = 0;
      for (const mission of MISSIONS) {
        for (const o of mission.objectives) {
          const view = m.objectiveView(mission.id, o.id);
          assert.ok(view, `${mission.id}/${o.id} has no tracker view in ${language}`);
          assert.ok(view.text && view.text.length > 0, `${mission.id}/${o.id} has empty ${language} text`);
          if (language === 'ar') {
            assert.ok(ARABIC.test(view.text), `${mission.id}/${o.id} Arabic text has no Arabic: "${view.text}"`);
            assert.notOk(LATIN_RUN.test(view.text), `${mission.id}/${o.id} Arabic text carries Latin: "${view.text}"`);
          } else {
            assert.ok(LATIN_RUN.test(view.text), `${mission.id}/${o.id} English text has no Latin: "${view.text}"`);
            assert.notOk(ARABIC.test(view.text), `${mission.id}/${o.id} English text carries Arabic: "${view.text}"`);
          }
          checked++;
        }
      }
      assert.equal(checked, MISSIONS.reduce((n, x) => n + x.objectives.length, 0),
        'not every objective was checked');
    }
  });

  test('P14 · switching language mid-story does not disturb progress', () => {
    const start = play({ language: 'ar', stopWhen: (m) => m.state.chapterId === 'ch3' });
    assert.equal(start.state.chapterId, 'ch3', 'the run did not reach chapter 3');
    const payload = start.manager.serialize();
    assert.equal(payload.language, 'ar', 'the save did not record its language');

    const switched = play({ language: 'en', seedState: payload });
    assert.ok(switched.report.ok, `the switched run got stuck: ${switched.report.stuckReason}`);
    assert.ok(switched.report.storyComplete, 'switching language lost the story');
    assert.equal(switched.state.completedChapters.size, CHAPTERS.length, 'chapters were lost on a language switch');
    assert.deepEqual([...switched.state.clues].sort(), [...play().state.clues].sort(),
      'the language switch changed which clues were collected');
  });
});

runAndExit();
