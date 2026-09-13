/**
 * THE BETRAYED WILL — sim/mission.js
 *
 * The mission system, and the director that drives it.
 *
 * ── MissionManager ───────────────────────────────────────────────────────────
 * Holds what is in progress, decides what is available, and turns world events
 * into objective progress. It never reaches into rendering or input: the game tells
 * it what happened (`notify`), and it tells the game what changed (events on the
 * bus). That direction of dependency is what makes the whole story testable without
 * a browser.
 *
 * ── StoryDirector ────────────────────────────────────────────────────────────
 * Walks the eleven missions in order, satisfying each objective through the same
 * public `notify` path the shipped game uses. It is not a cheat and it is not a
 * shortcut around the content: to finish a dialogue objective it really walks the
 * dialogue tree through DialogueWalker, and to finish a search objective it really
 * searches distinct landmarks in the named region. If a mission cannot be finished
 * this way, the director reports it rather than marking it complete - which is the
 * difference between "the story is completable" as a claim and as a measurement.
 *
 * ── Soft-lock detection ──────────────────────────────────────────────────────
 * `softLockReport()` asks, of every objective the player is currently required to
 * finish, whether it can still be finished from where they stand. A dialogue
 * objective whose tree cannot be exited with what the player holds is reported
 * here; so is a search objective whose region holds fewer searchable places than
 * the count demands. These are the failures that ship as "the game stopped
 * progressing" and are otherwise found by a player, several hours in.
 */

import { Events, globalBus } from '../core/bus.js';
import { MISSION } from '../core/constants.js';
import {
  CHAPTERS, CHAPTER_MAP, CINEMATIC_MAP, CLUE_MAP, MISSIONS, MISSION_MAP, ObjectiveType,
} from '../content/story.js';
import { DIALOGUE_MAP, MISSION_OWNED_FLAGS, canFinish } from '../content/dialogue.js';
import { LANDMARKS_BY_REGION, LANDMARK_MAP, REGION_MAP } from '../content/world-data.js';
import { StoryState } from './story-state.js';
import { autoWalk } from './dialogue.js';

export const MissionStatus = Object.freeze({
  LOCKED: 'locked',
  AVAILABLE: 'available',
  ACTIVE: 'active',
  COMPLETE: 'complete',
  FAILED: 'failed',
});

/** The world events `notify` accepts. Unknown kinds are reported, not ignored. */
export const EventKind = Object.freeze({
  REGION: 'region',
  LANDMARK: 'landmark',
  EXAMINE: 'examine',
  INTERACT: 'interact',
  SEARCH: 'search',
  CLUE: 'clue',
  DIALOGUE: 'dialogue',
  TAKEDOWN: 'takedown',
  KILL: 'kill',
  CINEMATIC: 'cinematic',
  RETURN: 'return',
  ESCAPE: 'escape',
});

/**
 * Does this world event satisfy this objective?
 *
 * One table, keyed by objective type, rather than a chain of conditionals spread
 * through the update loop. A type with no matcher is time-driven and handled in
 * `update()` instead - `SURVIVE` is the only one, and giving it a null entry here
 * documents that fact where a reader will look for it.
 */
const MATCHERS = Object.freeze({
  [ObjectiveType.GOTO]: (o, e) =>
    (e.kind === EventKind.REGION || e.kind === EventKind.LANDMARK) && o.target === e.id,
  [ObjectiveType.EXAMINE]: (o, e) => e.kind === EventKind.EXAMINE && o.target === e.id,
  [ObjectiveType.INTERACT]: (o, e) => e.kind === EventKind.INTERACT && o.target === e.id,
  [ObjectiveType.CLUE]: (o, e) => e.kind === EventKind.CLUE && o.target === e.id,
  [ObjectiveType.DIALOGUE]: (o, e) => e.kind === EventKind.DIALOGUE && o.target === e.id,
  [ObjectiveType.CINEMATIC]: (o, e) => e.kind === EventKind.CINEMATIC && o.target === e.id,
  [ObjectiveType.RETURN]: (o, e) => e.kind === EventKind.RETURN && o.target === e.id,
  [ObjectiveType.ESCAPE]: (o, e) => e.kind === EventKind.ESCAPE && e.pursued === true && o.target === e.id,
  [ObjectiveType.TAKEDOWN]: (o, e) => e.kind === EventKind.TAKEDOWN,
  [ObjectiveType.COMBAT]: (o, e) => e.kind === EventKind.KILL,
  // Search targets a REGION and counts distinct searchable places inside it, so the
  // event carries a landmark and the match is on that landmark's region.
  [ObjectiveType.SEARCH]: (o, e) => e.kind === EventKind.SEARCH
    && !!LANDMARK_MAP[e.id] && LANDMARK_MAP[e.id].region === o.target,
  [ObjectiveType.SURVIVE]: null,
});

const KNOWN_KINDS = new Set(Object.values(EventKind));

/**
 * The searchable landmarks in a region.
 *
 * LANDMARKS_BY_REGION holds landmark *ids*, not landmark objects. Filtering those
 * ids for an `interact` field matches nothing and returns an empty list, which
 * reads as "this region has no searchable places" and turns a search objective into
 * an unsatisfiable one. Resolving through LANDMARK_MAP is the only correct read, so
 * it happens once here rather than at each call site.
 */
export function searchablePlaces(regionId) {
  return (LANDMARKS_BY_REGION[regionId] ?? [])
    .map((id) => LANDMARK_MAP[id])
    .filter((l) => l && l.interact === 'search');
}

/**
 * Can this mission's required objectives still be finished?
 *
 * Pure on purpose. The content tables are frozen, so the only way to test the
 * detector against a broken mission is to hand it one that does not exist in the
 * data - which is also the only way to be sure it detects anything at all rather
 * than passing because nothing was ever wrong.
 *
 * Each case is a claim about the world as built. A dialogue objective is checked
 * against the tree's own graph with the player's actual holdings, so a scene whose
 * only exit sits behind a clue the player has not found is reported as a trap
 * rather than discovered as a hang. A search objective is checked against how many
 * searchable places its region actually contains - the check that caught palace-hall
 * offering one place to a mission demanding three.
 *
 * @param {object} mission  a mission-shaped object: {id, chapter, region, objectives}
 * @param {(kind:string,id:string)=>boolean} has  what the player holds
 * @param {(mid:string,oid:string)=>boolean} isDone  already-satisfied objectives
 */
export function objectiveSoftLocks(mission, has = () => true, isDone = () => false) {
  const out = [];
  const chapter = CHAPTER_MAP[mission.chapter];
  if (!chapter) {
    out.push({ where: mission.id, problem: `chapter "${mission.chapter}" does not exist` });
    return out;
  }
  const regions = new Set(chapter.regions ?? []);
  const inChapter = (regionId) => regions.has(regionId) || regionId === mission.region;

  for (const o of mission.objectives ?? []) {
    if (o.optional) continue;
    if (isDone(mission.id, o.id)) continue;
    const where = `${mission.id}/${o.id}`;
    switch (o.type) {
      case ObjectiveType.DIALOGUE: {
        const tree = DIALOGUE_MAP[o.target];
        if (!tree) out.push({ where, problem: `dialogue tree "${o.target}" does not exist` });
        else if (!canFinish(tree, has)) {
          out.push({ where, problem: `conversation "${o.target}" cannot be exited with what the player holds` });
        } else if (tree.chapter !== mission.chapter) {
          out.push({ where, problem: `tree "${o.target}" belongs to ${tree.chapter}, not ${mission.chapter}` });
        }
        break;
      }
      case ObjectiveType.CLUE: {
        const clue = CLUE_MAP[o.target];
        if (!clue) out.push({ where, problem: `clue "${o.target}" does not exist` });
        else if (!inChapter(LANDMARK_MAP[clue.landmark]?.region)) {
          out.push({
            where,
            problem: `clue "${o.target}" sits in ${LANDMARK_MAP[clue.landmark]?.region}, outside chapter ${mission.chapter}`,
          });
        }
        break;
      }
      case ObjectiveType.GOTO:
      case ObjectiveType.EXAMINE:
      case ObjectiveType.INTERACT: {
        const lm = LANDMARK_MAP[o.target];
        const rg = REGION_MAP[o.target];
        if (!lm && !rg) out.push({ where, problem: `target "${o.target}" is neither a landmark nor a region` });
        else if (lm && !inChapter(lm.region)) {
          out.push({ where, problem: `landmark "${o.target}" sits in ${lm.region}, outside chapter ${mission.chapter}` });
        }
        break;
      }
      case ObjectiveType.SEARCH: {
        if (!REGION_MAP[o.target]) out.push({ where, problem: `region "${o.target}" does not exist` });
        else {
          const places = searchablePlaces(o.target);
          if (places.length < (o.count ?? 1)) {
            out.push({
              where,
              problem: `needs ${o.count} searchable places in "${o.target}", which has ${places.length}`,
            });
          }
        }
        break;
      }
      case ObjectiveType.ESCAPE: {
        if (!REGION_MAP[o.target]) out.push({ where, problem: `escape region "${o.target}" does not exist` });
        else if (!inChapter(o.target)) {
          out.push({ where, problem: `escape region "${o.target}" is outside chapter ${mission.chapter}` });
        }
        break;
      }
      case ObjectiveType.RETURN: {
        if (!CLUE_MAP[o.target]) out.push({ where, problem: `return item "${o.target}" does not exist` });
        break;
      }
      case ObjectiveType.CINEMATIC: {
        if (!CINEMATIC_MAP[o.target]) out.push({ where, problem: `cinematic "${o.target}" does not exist` });
        break;
      }
      default:
        // SURVIVE, TAKEDOWN and COMBAT are satisfiable by play alone.
        break;
    }
  }
  return out;
}

export class MissionManager {
  constructor({ bus = globalBus, state = new StoryState(), language, cinematics = null } = {}) {
    this.bus = bus;
    this.state = state;
    /**
     * An optional CinematicDirector. When one is supplied, playCinematic() hands the
     * sequence over and defers CUTSCENE_END and the objective notification until the
     * player has actually watched it. When it is absent - every headless suite - the
     * immediate path below is unchanged, so this injection cannot regress a test that
     * never asked for a picture.
     */
    this.cinematics = cinematics;
    /** The language this manager was asked for, kept so a load cannot override it. */
    this.language = language ? (language === 'en' ? 'en' : 'ar') : null;
    if (this.language) this.state.language = this.language;
    /** Refusals and unknown events, kept for tests to assert on. */
    this.problems = [];
  }

  /* ------------------------------------------------------------ availability */

  #previousChapter(chapterId) {
    const ch = CHAPTER_MAP[chapterId];
    if (!ch) return null;
    return CHAPTERS.find((c) => c.index === ch.index - 1) ?? null;
  }

  /** Chapters in story order. */
  chaptersInOrder() { return [...CHAPTERS].sort((a, b) => a.index - b.index); }

  chapterStatus(chapterId) {
    const ch = CHAPTER_MAP[chapterId];
    if (!ch) return MissionStatus.LOCKED;
    if (this.state.isChapterComplete(chapterId)) return MissionStatus.COMPLETE;
    if (this.state.chapterId === chapterId) return MissionStatus.ACTIVE;
    const prev = this.#previousChapter(chapterId);
    if (!prev) return MissionStatus.AVAILABLE;              // the prologue
    return this.state.isChapterComplete(prev.id) ? MissionStatus.AVAILABLE : MissionStatus.LOCKED;
  }

  /**
   * Missions of a chapter in order. A mission is available once its chapter is
   * open and every earlier mission in the chapter is finished.
   */
  missionsOf(chapterId) {
    return MISSIONS.filter((m) => m.chapter === chapterId).sort((a, b) => a.index - b.index);
  }

  missionStatus(missionId) {
    const m = MISSION_MAP[missionId];
    if (!m) return MissionStatus.LOCKED;
    if (this.state.isMissionComplete(missionId)) return MissionStatus.COMPLETE;
    if (this.state.isMissionFailed(missionId)) return MissionStatus.FAILED;
    if (this.state.activeMissions.has(missionId)) return MissionStatus.ACTIVE;

    const chapterOpen = this.chapterStatus(m.chapter) !== MissionStatus.LOCKED;
    if (!chapterOpen) return MissionStatus.LOCKED;
    const earlier = this.missionsOf(m.chapter).filter((x) => x.index < m.index);
    return earlier.every((x) => this.state.isMissionComplete(x.id))
      ? MissionStatus.AVAILABLE
      : MissionStatus.LOCKED;
  }

  activeMissions() {
    return [...this.state.activeMissions].map((id) => MISSION_MAP[id]).filter(Boolean);
  }

  /**
   * The mission the tracker should show. The story is linear, so this is normally
   * the one active mission; with side quests running it is the lowest-indexed one,
   * which is the mission the player is most likely to be in the middle of.
   */
  currentMission() {
    const active = this.activeMissions();
    if (!active.length) return null;
    return active.sort((a, b) => a.index - b.index)[0];
  }

  /* ---------------------------------------------------------------- starting */

  startChapter(chapterId) {
    const ch = CHAPTER_MAP[chapterId];
    if (!ch) return { ok: false, reason: 'unknown-chapter' };
    if (this.chapterStatus(chapterId) === MissionStatus.LOCKED) {
      return { ok: false, reason: 'locked' };
    }
    this.state.chapterId = chapterId;
    for (const r of ch.regions) this.state.regionsVisited.add(r);
    this.bus.emit(Events.CHAPTER_START, { chapterId, index: ch.index, regions: [...ch.regions] });
    const first = this.missionsOf(chapterId).find((m) => this.missionStatus(m.id) === MissionStatus.AVAILABLE);
    if (first) this.startMission(first.id);
    return { ok: true, reason: null, mission: first?.id ?? null };
  }

  startMission(missionId) {
    const m = MISSION_MAP[missionId];
    if (!m) return { ok: false, reason: 'unknown-mission' };
    const status = this.missionStatus(missionId);
    if (status === MissionStatus.COMPLETE) return { ok: false, reason: 'already-complete' };
    if (status === MissionStatus.LOCKED) return { ok: false, reason: 'locked' };
    if (this.state.activeMissions.size >= MISSION.MAX_ACTIVE) {
      return { ok: false, reason: 'too-many-active' };
    }
    if (this.state.chapterId !== m.chapter) this.state.chapterId = m.chapter;
    this.state.addActiveMission(missionId);
    this.bus.emit(Events.MISSION_START, {
      missionId, chapter: m.chapter, region: m.region,
      title: this.state.language === 'en' ? m.en.title : m.ar.title,
    });
    if (m.cinematicStart) this.playCinematic(m.cinematicStart);
    return { ok: true, reason: null };
  }

  /* -------------------------------------------------------------- objectives */

  #requiredObjectives(mission) {
    return mission.objectives.filter((o) => !o.optional);
  }

  isObjectiveComplete(missionId, objectiveId) {
    return this.state.isObjectiveDone(missionId, objectiveId);
  }

  objectiveProgress(missionId, objectiveId) {
    return this.state.objectiveProgress(missionId, objectiveId);
  }

  /* ------------------------------------------------------- presenting an item */

  /**
   * Where a RETURN objective is meant to happen.
   *
   * RETURN is the one objective type whose target is a thing the player carries rather
   * than a place, so the place has to come from somewhere else - and inventing one per
   * mission is how content and code drift apart. It comes from the story instead: the
   * nearest preceding required objective that names a landmark is the beat the player
   * was just sent to, and reading a document aloud happens there.
   *
   * For m11/o5 that is o4, the dialogue at Layla's hearth, and DIALOGUE_MAP carries the
   * landmark the tree is staged at - so "read the true will aloud" resolves to
   * lm-ll-hearth from authored data, with nothing about m11 written here.
   *
   * Requiring that beat to be complete is what puts the reading after the conversation
   * rather than during it. Optional objectives are skipped: a player who walked past one
   * must not find the story locked behind a scene they were never asked to see.
   *
   * @returns {string|null} landmark id, or null when no place can be derived
   */
  #presentationPlace(mission, objective) {
    const index = mission.objectives.indexOf(objective);
    let fallback = null;
    for (let i = index - 1; i >= 0; i--) {
      const o = mission.objectives[i];
      if (!o.target) continue;
      const landmark = o.type === ObjectiveType.DIALOGUE
        ? DIALOGUE_MAP[o.target]?.landmark ?? null
        : (LANDMARK_MAP[o.target] ? o.target : null);
      if (!landmark) continue;
      if (!fallback) fallback = landmark;
      if (o.optional) continue;
      return this.state.isObjectiveDone(mission.id, o.id) ? landmark : null;
    }
    return fallback;
  }

  /**
   * The RETURN objective the player could complete by presenting at this landmark, or
   * null. Public because the interaction prompt has to offer the right verb: without it
   * the hearth keeps saying "Talk" after the conversation is over, and reading the will
   * aloud is something no player would think to try.
   */
  presentationAt(landmarkId) {
    if (!landmarkId || !LANDMARK_MAP[landmarkId]) return null;
    for (const mission of this.activeMissions()) {
      for (const o of mission.objectives) {
        if (o.type !== ObjectiveType.RETURN) continue;
        if (this.state.isObjectiveDone(mission.id, o.id)) continue;
        if (!this.state.hasClue(o.target)) continue;
        if (this.#presentationPlace(mission, o) === landmarkId) {
          return { missionId: mission.id, objectiveId: o.id, item: o.target };
        }
      }
    }
    return null;
  }

  /**
   * Present what the player is carrying at the landmark they are standing at.
   *
   * Called on every landmark interaction; it decides whether any of them is a RETURN.
   * The notification goes through notify() like every other event, so the matcher, the
   * progress counter and the completion beat are all the ordinary ones.
   */
  presentAt(landmarkId) {
    const pending = this.presentationAt(landmarkId);
    if (!pending) return [];
    return this.notify({ kind: EventKind.RETURN, id: pending.item });
  }

  /** Localized text for one objective, for the tracker UI. */
  objectiveView(missionId, objectiveId) {
    const m = MISSION_MAP[missionId];
    const o = m?.objectives.find((x) => x.id === objectiveId);
    if (!o) return null;
    const ar = this.state.language !== 'en';
    return {
      missionId, objectiveId: o.id, type: o.type, target: o.target ?? null,
      text: ar ? o.ar : o.en,
      optional: !!o.optional,
      count: o.count ?? null,
      progress: this.objectiveProgress(missionId, o.id),
      complete: this.isObjectiveComplete(missionId, o.id),
    };
  }

  /** { done, total, required, requiredDone, optionalDone } for one mission. */
  missionProgress(missionId) {
    const m = MISSION_MAP[missionId];
    if (!m) return null;
    const required = this.#requiredObjectives(m);
    const optional = m.objectives.filter((o) => o.optional);
    const done = m.objectives.filter((o) => this.isObjectiveComplete(missionId, o.id));
    return {
      missionId,
      total: m.objectives.length,
      done: done.length,
      required: required.length,
      requiredDone: required.filter((o) => this.isObjectiveComplete(missionId, o.id)).length,
      optionalDone: optional.filter((o) => this.isObjectiveComplete(missionId, o.id)).length,
      complete: this.state.isMissionComplete(missionId),
    };
  }

  /**
   * Tell the mission system that something happened in the world.
   *
   * Returns the objectives this event completed, so a caller can react to the
   * change it just caused. Only active missions are considered: an event in a
   * chapter the player has finished must not silently tick a box they can no
   * longer see, and an event in a locked chapter must not pre-complete content the
   * player has not earned.
   */
  notify(event) {
    if (!event || !KNOWN_KINDS.has(event.kind)) {
      this.problems.push({ kind: 'unknown-event', event });
      return [];
    }
    const completed = [];

    if (event.kind === EventKind.REGION) this.state.visitRegion(event.id);
    if (event.kind === EventKind.CLUE) {
      if (this.state.grantClue(event.id)) {
        this.bus.emit(Events.CLUE_FOUND, { clueId: event.id, source: 'world' });
      }
    }

    for (const mission of this.activeMissions()) {
      for (const o of mission.objectives) {
        if (this.state.isObjectiveDone(mission.id, o.id)) continue;
        const matcher = MATCHERS[o.type];
        if (!matcher || !matcher(o, event)) continue;

        // Distinct ids count once; anonymous events (a kill, a takedown) count
        // every time. Which one applies is a property of the event, not of the
        // objective, so a search objective cannot be completed by searching the
        // same jar six times.
        const progress = this.state.recordHit(mission.id, o.id, event.id);
        const need = o.count ?? 1;
        if (progress >= need) this.#completeObjective(mission, o, completed);
        else {
          this.bus.emit(Events.MISSION_OBJECTIVE, {
            missionId: mission.id, objectiveId: o.id, progress, count: need, complete: false,
          });
        }
      }
    }
    this.#settle(completed);
    return completed;
  }

  #completeObjective(mission, o, completed) {
    this.state.markObjectiveDone(mission.id, o.id);
    // An objective may declare story flags it sets. Applied here, at the one place
    // objectives complete, so a flag cannot be declared in content and silently
    // forgotten by the system that was supposed to write it.
    for (const f of o.setsFlags ?? []) this.setFlag(f);
    completed.push({ missionId: mission.id, objectiveId: o.id });
    this.bus.emit(Events.MISSION_OBJECTIVE, {
      missionId: mission.id, objectiveId: o.id,
      progress: o.count ?? 1, count: o.count ?? 1, complete: true,
      text: this.state.language === 'en' ? o.en : o.ar,
    });
  }

  /**
   * Per-frame update. Only SURVIVE objectives need it: they are satisfied by time
   * passing rather than by an event, so nothing in the world will ever notify them.
   *
   * Bounded work by construction - it iterates the active missions' objectives, not
   * all fifty-two - and run-deep measures it against MISSION.OBJECTIVE_BUDGET_MS.
   */
  update(dtMs) {
    const completed = [];
    if (!(dtMs > 0)) return completed;
    this.state.playtimeMs += dtMs;
    const dtSeconds = dtMs / 1000;
    for (const mission of this.activeMissions()) {
      for (const o of mission.objectives) {
        if (o.type !== ObjectiveType.SURVIVE) continue;
        if (this.state.isObjectiveDone(mission.id, o.id)) continue;
        const total = this.state.addSeconds(mission.id, o.id, dtSeconds);
        if (total >= (o.count ?? 0)) this.#completeObjective(mission, o, completed);
      }
    }
    this.#settle(completed);
    return completed;
  }

  /** Complete any mission whose required objectives are all done, then cascade. */
  #settle(completed) {
    if (!completed.length) return;
    for (const mission of this.activeMissions()) {
      if (this.#requiredObjectives(mission)
        .every((o) => this.state.isObjectiveDone(mission.id, o.id))) {
        this.completeMission(mission.id);
      }
    }
  }

  completeMission(missionId) {
    const m = MISSION_MAP[missionId];
    if (!m) return false;
    if (this.state.isMissionComplete(missionId)) return false;
    this.state.markMissionComplete(missionId);
    for (const f of m.setsFlags ?? []) this.setFlag(f);
    this.bus.emit(Events.MISSION_COMPLETE, {
      missionId, chapter: m.chapter,
      title: this.state.language === 'en' ? m.en.title : m.ar.title,
    });
    if (m.cinematicEnd) this.playCinematic(m.cinematicEnd);
    this.bus.emit(Events.AUTOSAVE, { reason: 'mission-complete', missionId });
    this.#advance(m.chapter);
    return true;
  }

  failMission(missionId, reason = 'unspecified') {
    const m = MISSION_MAP[missionId];
    if (!m) return false;
    this.state.markMissionFailed(missionId);
    this.bus.emit(Events.MISSION_FAILED, { missionId, reason });
    return true;
  }

  /**
   * Keep the story moving after a mission completes.
   *
   * Two cases, and the first was missing. If the chapter still has missions, start
   * the next available one; only when the chapter's last mission lands does the
   * chapter close and the next open. Completing a mid-chapter mission used to leave
   * the player with nothing active and nothing startable - chapter 3 has two
   * missions, and finishing the first stranded the story there. No error is raised
   * by that kind of dead end, which is why it is handled here and asserted on in
   * run-deep rather than left to a playtester to find.
   */
  #advance(chapterId) {
    const missions = this.missionsOf(chapterId);
    if (!missions.every((m) => this.state.isMissionComplete(m.id))) {
      const next = missions.find((m) => this.missionStatus(m.id) === MissionStatus.AVAILABLE);
      if (next) this.startMission(next.id);
      else {
        this.problems.push({
          kind: 'chapter-stalled', chapterId,
          reason: 'no mission is available and the chapter is not complete',
        });
      }
      return;
    }
    this.state.markChapterComplete(chapterId);
    this.bus.emit(Events.CHAPTER_END, { chapterId });
    const next = this.chaptersInOrder().find((c) => c.index === CHAPTER_MAP[chapterId].index + 1);
    if (next) this.startChapter(next.id);
  }

  /* ------------------------------------------------------- clues, cinematics */

  /**
   * Grant a clue directly. `notify({kind:'clue'})` is the normal path; this exists
   * for the investigation board and for loading a save, where the clue is already
   * known and no world event happened.
   */
  grantClue(clueId) {
    if (this.state.grantClue(clueId)) {
      this.bus.emit(Events.CLUE_FOUND, { clueId, source: 'granted' });
      return this.notify({ kind: EventKind.CLUE, id: clueId }).length > 0;
    }
    return false;
  }

  /** A flag written by the mission layer - the only layer allowed to write these. */
  setFlag(flag) {
    const changed = this.state.setFlag(flag, 'mission');
    return changed;
  }

  playCinematic(cinematicId) {
    const cin = CINEMATIC_MAP[cinematicId];
    if (!cin) { this.problems.push({ kind: 'unknown-cinematic', cinematicId }); return false; }
    const first = this.state.seeCinematic(cinematicId);
    // Story consequences are applied whether or not anything is drawn: the injury and
    // the flags are what later systems read, and withholding them behind a cutscene
    // the player skipped would change the simulation on the strength of presentation.
    if (cin.setsInjured) this.setFlag('wounded');
    for (const f of cin.setsFlags ?? []) this.setFlag(f);

    if (this.cinematics?.play) {
      const res = this.cinematics.play(cinematicId, {
        onEnd: () => {
          if (first) this.notify({ kind: EventKind.CINEMATIC, id: cinematicId });
        },
      });
      // A refusal - a second cinematic asked for while one is running - falls through
      // to the immediate path rather than dropping the objective on the floor. A
      // cutscene that cannot be shown must still not be a cutscene that blocks story.
      if (res?.ok) return true;
      this.problems.push({ kind: 'cinematic-refused', cinematicId, reason: res?.reason ?? 'refused' });
    }

    this.bus.emit(Events.CUTSCENE_START, { cinematicId, seconds: cin.seconds, region: cin.region });
    this.bus.emit(Events.CUTSCENE_END, { cinematicId, seconds: cin.seconds });
    if (first) this.notify({ kind: EventKind.CINEMATIC, id: cinematicId });
    return true;
  }

  /* ------------------------------------------------------------ soft locks */

  /**
   * Every objective the player is currently required to finish, and whether it can
   * still be finished.
   *
   * Each check is a claim about the world as built: a dialogue objective is checked
   * against the tree's own graph with the player's actual holdings, so a scene whose
   * only exit sits behind a clue the player has not found is reported as a trap
   * rather than discovered as a hang. A search objective is checked against how many
   * searchable places its region actually contains.
   */
  /**
   * Every objective the player is currently required to finish, and whether it can
   * still be finished. Delegates to `objectiveSoftLocks`, which is pure so a test
   * can point it at a mission that does not exist in the content.
   */
  softLockReport() {
    const out = [];
    for (const mission of this.activeMissions()) {
      out.push(...objectiveSoftLocks(
        mission,
        this.state.has,
        (mid, oid) => this.state.isObjectiveDone(mid, oid),
      ));
    }
    return out;
  }

  /** True once every chapter is complete. */
  isStoryComplete() {
    return CHAPTERS.every((c) => this.state.isChapterComplete(c.id));
  }

  /* ---------------------------------------------------------- serialization */

  serialize() { return this.state.serialize(); }

  /**
   * Restore from a payload. Returns the deserialize report so a caller can tell a
   * clean load from a repaired one; the manager is usable either way.
   */
  restore(payload) {
    const report = StoryState.deserialize(payload);
    if (report.state) {
      this.state = report.state;
      // Language is a setting, not progress. A save records the language it was
      // written in so a bare StoryState can round-trip, but loading one must not
      // silently switch the language the player is reading in - which is what
      // happens if the manager was constructed with an explicit language and the
      // payload then overwrites it.
      if (this.language) this.state.language = this.language;
    }
    return report;
  }
}

/* ---------------------------------------------------------------- director */

/**
 * Drives the whole story through the public API, one beat at a time.
 *
 * `step()` performs exactly one atomic action and describes it, so a test can walk
 * the game forward and assert on the state between beats. `run()` calls step()
 * until the story is finished or stuck, and reports which.
 *
 * A step never invents progress. To satisfy a dialogue objective it walks the tree
 * through DialogueWalker, which applies the tree's effects - so flags and clues a
 * later mission depends on are really acquired here, in the order the story intends.
 */
export class StoryDirector {
  constructor({ bus = globalBus, manager, language = 'ar' } = {}) {
    this.bus = bus;
    this.manager = manager ?? new MissionManager({ bus, language });
    this.language = language;
    this.beats = [];
    this.done = false;
    this.stuckReason = null;
    this.stepCount = 0;
  }

  get state() { return this.manager.state; }

  begin() {
    const first = this.manager.chaptersInOrder()[0];
    const r = this.manager.startChapter(first.id);
    return this.#beat('chapter', { chapterId: first.id, ok: r.ok });
  }

  #beat(type, detail) {
    const beat = { index: this.stepCount++, type, ...detail };
    this.beats.push(beat);
    return beat;
  }

  /**
   * The next objective that needs work, or null when nothing does.
   *
   * Optional objectives are taken while required ones remain. Objectives inside a
   * mission are not sequentially gated - a player may take them in any order - but
   * the mission closes the instant its last required objective lands. A
   * required-first order therefore skips every optional objective listed after the
   * last required one, which is how dt-ll-table went unspoken in an otherwise
   * complete playthrough. Doing the bonus beat while still in the scene is what a
   * thorough player does, and it is what makes "all fourteen trees are completable"
   * true of a single run rather than of the content in the abstract.
   */
  #nextObjective() {
    const mission = this.manager.currentMission();
    if (!mission) return null;
    const incomplete = mission.objectives.filter((o) => !this.state.isObjectiveDone(mission.id, o.id));
    if (!incomplete.length) return null;
    const required = incomplete.filter((o) => !o.optional);
    if (required.length > 0) {
      const optional = incomplete.filter((o) => o.optional);
      if (optional.length > 0) return { mission, objective: optional[0] };
    }
    return { mission, objective: incomplete[0] };
  }

  /**
   * One beat of the story.
   *
   * Returns the beat it performed, or `{type:'finished'}` / `{type:'stuck'}` when
   * there is nothing left to do or nothing that can be done.
   */
  step() {
    if (this.done) return { type: 'finished' };
    if (!this.manager.activeMissions().length) {
      if (this.manager.isStoryComplete()) { this.done = true; return this.#beat('finished', {}); }
      // The open chapter may still have a mission to start - after a completion, or
      // after a failure the player is allowed to retry.
      const openChapter = this.state.chapterId;
      if (openChapter) {
        const pending = this.manager.missionsOf(openChapter)
          .find((m) => this.manager.missionStatus(m.id) === MissionStatus.AVAILABLE);
        if (pending) {
          return this.#beat('mission', { missionId: pending.id, chapterId: openChapter, ...this.manager.startMission(pending.id) });
        }
      }
      const next = this.manager.chaptersInOrder()
        .find((c) => this.manager.chapterStatus(c.id) === MissionStatus.AVAILABLE);
      if (!next) {
        this.done = true;
        this.stuckReason = 'no available chapter and the story is not complete';
        return this.#beat('stuck', { reason: this.stuckReason });
      }
      return this.#beat('chapter', { chapterId: next.id, ...this.manager.startChapter(next.id) });
    }

    // Before doing anything, confirm the mission can still be finished. Checking
    // only at the end would let the director complete a mission it should have
    // refused, and the report is the whole point of running it.
    const locks = this.manager.softLockReport();
    if (locks.length) {
      this.done = true;
      this.stuckReason = locks.map((l) => `${l.where}: ${l.problem}`).join('; ');
      return this.#beat('stuck', { reason: this.stuckReason, locks });
    }

    const pending = this.#nextObjective();
    if (!pending) {
      // Nothing left to do but the mission is still active: complete it. This can
      // happen when the last objective was optional.
      const mission = this.manager.currentMission();
      return this.#beat('mission-complete', { missionId: mission.id, ok: this.manager.completeMission(mission.id) });
    }

    const { mission, objective: o } = pending;
    return this.#satisfy(mission, o);
  }

  #satisfy(mission, o) {
    const n = this.manager.notify.bind(this.manager);
    switch (o.type) {
      case ObjectiveType.GOTO: {
        const lm = LANDMARK_MAP[o.target];
        if (lm) {
          n({ kind: EventKind.REGION, id: lm.region });
          return this.#beat('goto', { missionId: mission.id, objectiveId: o.id, landmark: o.target, region: lm.region, completed: n({ kind: EventKind.LANDMARK, id: o.target }) });
        }
        return this.#beat('goto', { missionId: mission.id, objectiveId: o.id, region: o.target, completed: n({ kind: EventKind.REGION, id: o.target }) });
      }
      case ObjectiveType.EXAMINE:
        return this.#beat('examine', { missionId: mission.id, objectiveId: o.id, target: o.target, completed: n({ kind: EventKind.EXAMINE, id: o.target }) });
      case ObjectiveType.INTERACT: {
        const lm = LANDMARK_MAP[o.target];
        return this.#beat('interact', { missionId: mission.id, objectiveId: o.id, target: o.target, verb: lm?.interact ?? null, completed: n({ kind: EventKind.INTERACT, id: o.target, verb: lm?.interact ?? null }) });
      }
      case ObjectiveType.CLUE:
        return this.#beat('clue', { missionId: mission.id, objectiveId: o.id, clue: o.target, completed: n({ kind: EventKind.CLUE, id: o.target }) });
      case ObjectiveType.RETURN:
        return this.#beat('return', { missionId: mission.id, objectiveId: o.id, item: o.target, completed: n({ kind: EventKind.RETURN, id: o.target }) });
      case ObjectiveType.SEARCH: {
        // Search distinct places in the named region until the count is met. One
        // beat searches one place, so the count is visible in the beat log.
        const places = searchablePlaces(o.target);
        const progress = this.manager.objectiveProgress(mission.id, o.id);
        const place = places[progress];
        if (!place) {
          this.done = true;
          this.stuckReason = `${mission.id}/${o.id}: region "${o.target}" ran out of searchable places at ${progress}/${o.count}`;
          return this.#beat('stuck', { reason: this.stuckReason });
        }
        return this.#beat('search', { missionId: mission.id, objectiveId: o.id, region: o.target, landmark: place.id, progress: progress + 1, count: o.count, completed: n({ kind: EventKind.SEARCH, id: place.id }) });
      }
      case ObjectiveType.DIALOGUE: {
        const tree = DIALOGUE_MAP[o.target];
        if (!tree) {
          this.done = true;
          this.stuckReason = `${mission.id}/${o.id}: dialogue tree "${o.target}" does not exist`;
          return this.#beat('stuck', { reason: this.stuckReason });
        }
        // Really walk it, through the walker the game uses, so its effects land.
        const walk = autoWalk(tree, this.state, { bus: this.bus, language: this.language });
        if (!walk.ok) {
          this.done = true;
          this.stuckReason = `${mission.id}/${o.id}: conversation "${o.target}" could not be finished (${walk.reason})`;
          return this.#beat('stuck', { reason: this.stuckReason });
        }
        return this.#beat('dialogue', {
          missionId: mission.id, objectiveId: o.id, tree: o.target,
          nodes: walk.nodes.length, choices: walk.choices.length, steps: walk.steps,
          completed: n({ kind: EventKind.DIALOGUE, id: o.target }),
        });
      }
      case ObjectiveType.SURVIVE: {
        // Survive in real slices rather than jumping the clock: the manager adds
        // seconds per update, and a test that teleports time would not exercise the
        // same path the game does.
        const slice = 1000;
        let guard = 0;
        while (!this.state.isObjectiveDone(mission.id, o.id) && guard < (o.count ?? 0) + 4) {
          this.manager.update(slice);
          guard++;
        }
        return this.#beat('survive', { missionId: mission.id, objectiveId: o.id, seconds: guard, count: o.count, complete: this.state.isObjectiveDone(mission.id, o.id) });
      }
      case ObjectiveType.TAKEDOWN: {
        const need = o.count ?? 1;
        const have = this.manager.objectiveProgress(mission.id, o.id);
        return this.#beat('takedown', { missionId: mission.id, objectiveId: o.id, progress: have + 1, count: need, completed: n({ kind: EventKind.TAKEDOWN }) });
      }
      case ObjectiveType.COMBAT: {
        const need = o.count ?? 1;
        const have = this.manager.objectiveProgress(mission.id, o.id);
        return this.#beat('combat', { missionId: mission.id, objectiveId: o.id, progress: have + 1, count: need, completed: n({ kind: EventKind.KILL }) });
      }
      case ObjectiveType.ESCAPE:
        return this.#beat('escape', { missionId: mission.id, objectiveId: o.id, region: o.target, completed: n({ kind: EventKind.ESCAPE, id: o.target, pursued: true }) });
      case ObjectiveType.CINEMATIC:
        return this.#beat('cinematic', { missionId: mission.id, objectiveId: o.id, cinematic: o.target, played: this.manager.playCinematic(o.target) });
      default:
        this.done = true;
        this.stuckReason = `${mission.id}/${o.id}: unhandled objective type "${o.type}"`;
        return this.#beat('stuck', { reason: this.stuckReason });
    }
  }

  /**
   * Run the whole story to the end.
   *
   * `maxSteps` is a hard stop, not a guess about length: a director that can always
   * make progress needs roughly one beat per objective plus one per chapter, and a
   * bound well above that turns an infinite loop into a report.
   */
  run({ maxSteps = 400 } = {}) {
    if (!this.beats.length) this.begin();
    let steps = 0;
    while (!this.done && steps < maxSteps) { this.step(); steps++; }
    if (!this.done) {
      this.stuckReason = this.stuckReason ?? `exceeded ${maxSteps} steps without finishing`;
      this.beats.push(this.#beat('stuck', { reason: this.stuckReason }));
    }
    return this.report();
  }

  report() {
    const types = {};
    for (const b of this.beats) types[b.type] = (types[b.type] ?? 0) + 1;
    return {
      ok: this.done && !this.stuckReason,
      done: this.done,
      stuckReason: this.stuckReason,
      steps: this.beats.length,
      beatTypes: types,
      storyComplete: this.manager.isStoryComplete(),
      chapters: [...this.state.completedChapters].length,
      missions: [...this.state.completedMissions].length,
      clues: [...this.state.clues].length,
      flags: [...this.state.flags].length,
      treesSeen: [...this.state.treesSeen].length,
      cinematics: [...this.state.cinematicsSeen].length,
      regions: [...this.state.regionsVisited].length,
      violations: [...this.state.violations],
      problems: [...this.manager.problems],
    };
  }
}

/** The flags the mission layer owns, re-exported so callers need one import. */
export { MISSION_OWNED_FLAGS };
