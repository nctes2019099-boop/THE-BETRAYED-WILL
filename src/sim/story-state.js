/**
 * THE BETRAYED WILL — story-state.js
 *
 * Everything the story layer needs to remember, in one place, with one
 * serialization boundary.
 *
 * This file exists so that mission.js and dialogue.js can both read and write the
 * player's progress without importing each other. A cycle between them would be
 * easy to create and miserable to debug, and more importantly it would leave two
 * answers to "what does a save contain?" - which is how save files acquire fields
 * nothing reads and lose fields something does.
 *
 * Ownership of a flag is enforced here rather than by convention: a flag declared
 * mission-owned cannot be written by the dialogue layer, and the refusal is
 * recorded rather than thrown, so a content mistake surfaces as a report a test can
 * assert on instead of a crash in a shipped build.
 */

import { SAVE } from '../core/constants.js';
import { CHARACTERS, CHAPTER_MAP, CLUE_MAP, MISSION_MAP } from '../content/story.js';
import { Flags, MISSION_OWNED_FLAGS } from '../content/dialogue.js';
import { REGION_MAP } from '../content/world-data.js';

/**
 * FNV-1a, 32-bit.
 *
 * SAVE.CHECKSUM_ALGORITHM names it, so it is implemented here rather than pulled
 * from a library: the brief allows no external runtime dependency, and a checksum
 * is nine lines.
 */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** `mid/oid` - the key under which one objective's progress is stored. */
export function objKey(missionId, objectiveId) { return `${missionId}/${objectiveId}`; }

const sorted = (iterable) => [...iterable].sort();

/**
 * JSON with sorted array members and sorted object keys.
 *
 * Determinism is the point: the same progress must produce the same bytes, or the
 * checksum on a save is comparing noise and a corrupted file can pass. It also
 * makes two saves diffable, which is the difference between debugging a save bug by
 * reading it and debugging it by guessing.
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

const FLAG_VALUES = new Set(Object.values(Flags));

export class StoryState {
  constructor(opts = {}) {
    this.version = SAVE.VERSION;
    this.language = opts.language === 'en' ? 'en' : 'ar';

    this.chapterId = opts.chapterId ?? null;
    this.missionId = opts.missionId ?? null;

    this.flags = new Set(opts.flags ?? []);
    this.clues = new Set(opts.clues ?? []);

    /**
     * Missions in progress. A set rather than a single slot because the story is
     * linear but the world is not: side quests run alongside a chapter mission, and
     * MISSION.MAX_ACTIVE caps how many. An active mission that does not survive a
     * save is a mission the player restarts for no reason they can see.
     */
    this.activeMissions = new Set(opts.activeMissions ?? []);
    this.completedMissions = new Set(opts.completedMissions ?? []);
    this.failedMissions = new Set(opts.failedMissions ?? []);
    this.completedChapters = new Set(opts.completedChapters ?? []);

    /** mid/oid -> contributing ids, for objectives that count distinct places. */
    this.objectiveHits = new Map();
    /** mid/oid -> anonymous counter, for kills, takedowns and seconds survived. */
    this.objectiveCounts = new Map();
    /** mid/oid -> true once an objective is satisfied. */
    this.doneObjectives = new Set(opts.doneObjectives ?? []);

    this.suspicion = new Map();
    this.treesSeen = new Set(opts.treesSeen ?? []);
    this.choicesTaken = new Set(opts.choicesTaken ?? []);
    this.regionsVisited = new Set(opts.regionsVisited ?? []);
    this.cinematicsSeen = new Set(opts.cinematicsSeen ?? []);
    this.playtimeMs = opts.playtimeMs ?? 0;

    /** Refused writes, kept so a test can assert on them instead of missing them. */
    this.violations = [];
  }

  /* ------------------------------------------------------------------ flags */

  hasFlag(flag) { return this.flags.has(flag); }

  /**
   * Set a flag. `writer` is 'mission' or 'dialogue'.
   *
   * Returns false and records a violation when a writer crosses into another
   * layer's flag. One writer per flag is what keeps "who set this?" answerable.
   */
  setFlag(flag, writer = 'mission') {
    if (!FLAG_VALUES.has(flag)) {
      this.violations.push({ kind: 'unknown-flag', flag, writer });
      return false;
    }
    if (MISSION_OWNED_FLAGS.has(flag) && writer !== 'mission') {
      this.violations.push({ kind: 'flag-ownership', flag, writer });
      return false;
    }
    const had = this.flags.has(flag);
    this.flags.add(flag);
    return !had;
  }

  /* ------------------------------------------------------------------ clues */

  hasClue(clueId) { return this.clues.has(clueId); }

  /** Grants a clue. Returns true only on the first grant, so events fire once. */
  grantClue(clueId) {
    if (!CLUE_MAP[clueId]) {
      this.violations.push({ kind: 'unknown-clue', clueId });
      return false;
    }
    const had = this.clues.has(clueId);
    this.clues.add(clueId);
    return !had;
  }

  /* -------------------------------------------------------------- predicate */

  /**
   * The `(kind, id) => boolean` predicate the dialogue layer's reachability
   * functions take. Keeping the shape this small is what lets content/dialogue.js
   * ask "can the player leave this conversation?" without importing this file.
   */
  has = (kind, id) => {
    if (kind === 'flag') return this.flags.has(id);
    if (kind === 'clue') return this.clues.has(id);
    return false;
  };

  /* ------------------------------------------------------------ objectives */

  markObjectiveDone(missionId, objectiveId) {
    const k = objKey(missionId, objectiveId);
    const had = this.doneObjectives.has(k);
    this.doneObjectives.add(k);
    return !had;
  }

  isObjectiveDone(missionId, objectiveId) {
    return this.doneObjectives.has(objKey(missionId, objectiveId));
  }

  /** Progress toward a counting objective: distinct ids beat repeat events. */
  objectiveProgress(missionId, objectiveId) {
    const k = objKey(missionId, objectiveId);
    const hits = this.objectiveHits.get(k);
    const count = this.objectiveCounts.get(k) ?? 0;
    return Math.max(hits ? hits.length : 0, count);
  }

  recordHit(missionId, objectiveId, id) {
    const k = objKey(missionId, objectiveId);
    let hits = this.objectiveHits.get(k);
    if (!hits) { hits = []; this.objectiveHits.set(k, hits); }
    if (id === undefined || id === null) {
      this.objectiveCounts.set(k, (this.objectiveCounts.get(k) ?? 0) + 1);
      return this.objectiveProgress(missionId, objectiveId);
    }
    if (hits.includes(id)) return this.objectiveProgress(missionId, objectiveId);
    hits.push(id);
    return this.objectiveProgress(missionId, objectiveId);
  }

  addSeconds(missionId, objectiveId, seconds) {
    const k = objKey(missionId, objectiveId);
    const next = (this.objectiveCounts.get(k) ?? 0) + seconds;
    this.objectiveCounts.set(k, next);
    return next;
  }

  /* ------------------------------------------------- missions and chapters */

  isMissionComplete(missionId) { return this.completedMissions.has(missionId); }
  isMissionFailed(missionId) { return this.failedMissions.has(missionId); }
  isChapterComplete(chapterId) { return this.completedChapters.has(chapterId); }

  addActiveMission(missionId) {
    const had = this.activeMissions.has(missionId);
    this.activeMissions.add(missionId);
    if (!this.missionId) this.missionId = missionId;
    return !had;
  }

  removeActiveMission(missionId) {
    this.activeMissions.delete(missionId);
    if (this.missionId === missionId) {
      this.missionId = this.activeMissions.size ? [...this.activeMissions][0] : null;
    }
  }

  markMissionComplete(missionId) {
    const had = this.completedMissions.has(missionId);
    this.completedMissions.add(missionId);
    this.removeActiveMission(missionId);
    return !had;
  }

  markMissionFailed(missionId) {
    const had = this.failedMissions.has(missionId);
    this.failedMissions.add(missionId);
    this.removeActiveMission(missionId);
    return !had;
  }

  markChapterComplete(chapterId) {
    const had = this.completedChapters.has(chapterId);
    this.completedChapters.add(chapterId);
    return !had;
  }

  /* --------------------------------------------------------------- dialogue */

  markTreeSeen(treeId) {
    const had = this.treesSeen.has(treeId);
    this.treesSeen.add(treeId);
    return !had;
  }

  hasSeenTree(treeId) { return this.treesSeen.has(treeId); }

  recordChoice(treeId, nodeId, index) {
    const had = this.choicesTaken.has(`${treeId}/${nodeId}/${index}`);
    this.choicesTaken.add(`${treeId}/${nodeId}/${index}`);
    return !had;
  }

  /* ------------------------------------------------------------- suspicion */

  suspicionOf(characterId) { return this.suspicion.get(characterId) ?? 0; }

  addSuspicion(characterId, amount) {
    if (!CHARACTERS[characterId]) {
      this.violations.push({ kind: 'unknown-character', characterId });
      return 0;
    }
    const next = Math.max(0, Math.min(100, this.suspicionOf(characterId) + amount));
    this.suspicion.set(characterId, next);
    return next;
  }

  /* ------------------------------------------------------------------ world */

  visitRegion(regionId) {
    if (!REGION_MAP[regionId]) {
      this.violations.push({ kind: 'unknown-region', regionId });
      return false;
    }
    const had = this.regionsVisited.has(regionId);
    this.regionsVisited.add(regionId);
    return !had;
  }

  seeCinematic(cinematicId) {
    const had = this.cinematicsSeen.has(cinematicId);
    this.cinematicsSeen.add(cinematicId);
    return !had;
  }

  /* ---------------------------------------------------------- serialization */

  /**
   * A plain, checksummed, byte-deterministic object.
   *
   * Sets become sorted arrays: a save that serializes iteration order is a save
   * whose checksum changes when nothing about the player's progress changed.
   */
  serialize() {
    const payload = {
      version: SAVE.VERSION,
      language: this.language,
      chapterId: this.chapterId,
      missionId: this.missionId,
      flags: sorted(this.flags),
      clues: sorted(this.clues),
      activeMissions: sorted(this.activeMissions),
      completedMissions: sorted(this.completedMissions),
      failedMissions: sorted(this.failedMissions),
      completedChapters: sorted(this.completedChapters),
      doneObjectives: sorted(this.doneObjectives),
      objectiveHits: sorted(this.objectiveHits.keys()).map((k) => [k, sorted(this.objectiveHits.get(k))]),
      objectiveCounts: sorted(this.objectiveCounts.keys()).map((k) => [k, this.objectiveCounts.get(k)]),
      suspicion: sorted(this.suspicion.keys()).map((k) => [k, this.suspicion.get(k)]),
      treesSeen: sorted(this.treesSeen),
      choicesTaken: sorted(this.choicesTaken),
      regionsVisited: sorted(this.regionsVisited),
      cinematicsSeen: sorted(this.cinematicsSeen),
      playtimeMs: Math.round(this.playtimeMs),
    };
    payload.checksum = fnv1a(stableStringify(payload));
    return payload;
  }

  /**
   * Rebuild a state from a serialized payload.
   *
   * Never throws. A save is written by an older build, edited by a curious player,
   * or truncated by a full disk, and in all three cases the game should load what
   * it can and report what it could not - `problems` is that report. Unknown ids
   * are dropped rather than kept, because a flag or clue nothing in the content
   * recognizes can only produce a branch that reads as broken.
   */
  static deserialize(payload) {
    const problems = [];
    if (!payload || typeof payload !== 'object') {
      return { ok: false, state: null, problems: ['payload is not an object'] };
    }

    const { checksum, ...rest } = payload;
    if (typeof checksum !== 'number') {
      problems.push('missing checksum');
    } else if (fnv1a(stableStringify(rest)) !== checksum) {
      problems.push('checksum mismatch - the file was altered or truncated');
    }
    if (payload.version !== SAVE.VERSION) {
      problems.push(`save version ${payload.version}, expected ${SAVE.VERSION}`);
    }

    const state = new StoryState({
      language: payload.language,
      chapterId: payload.chapterId ?? null,
      missionId: payload.missionId ?? null,
      playtimeMs: typeof payload.playtimeMs === 'number' ? payload.playtimeMs : 0,
    });

    const keep = (arr, test, what) => {
      if (!Array.isArray(arr)) { if (arr !== undefined) problems.push(`${what} is not an array`); return []; }
      const out = [];
      for (const v of arr) {
        if (test(v)) out.push(v);
        else problems.push(`${what}: dropped unrecognized "${v}"`);
      }
      return out;
    };

    for (const f of keep(payload.flags, (v) => FLAG_VALUES.has(v), 'flag')) state.flags.add(f);
    for (const c of keep(payload.clues, (v) => !!CLUE_MAP[v], 'clue')) state.clues.add(c);
    for (const m of keep(payload.activeMissions, (v) => !!MISSION_MAP[v], 'active mission')) state.activeMissions.add(m);
    for (const m of keep(payload.completedMissions, (v) => !!MISSION_MAP[v], 'mission')) state.completedMissions.add(m);
    for (const m of keep(payload.failedMissions, (v) => !!MISSION_MAP[v], 'failed mission')) state.failedMissions.add(m);
    for (const ch of keep(payload.completedChapters, (v) => !!CHAPTER_MAP[v], 'chapter')) state.completedChapters.add(ch);
    for (const t of keep(payload.treesSeen, (v) => typeof v === 'string', 'tree')) state.treesSeen.add(t);
    for (const r of keep(payload.regionsVisited, (v) => !!REGION_MAP[v], 'region')) state.regionsVisited.add(r);
    for (const c of keep(payload.cinematicsSeen, (v) => typeof v === 'string', 'cinematic')) state.cinematicsSeen.add(c);

    // Objectives are keyed "mid/oid"; a key whose mission no longer exists is from
    // a build whose content changed, and is dropped with a report.
    const keyOk = (k) => typeof k === 'string' && !!MISSION_MAP[k.split('/')[0]];
    for (const k of keep(payload.doneObjectives, keyOk, 'objective')) state.doneObjectives.add(k);
    if (Array.isArray(payload.objectiveHits)) {
      for (const pair of payload.objectiveHits) {
        if (!Array.isArray(pair) || !keyOk(pair[0])) { problems.push(`objectiveHits: dropped "${pair?.[0]}"`); continue; }
        state.objectiveHits.set(pair[0], Array.isArray(pair[1]) ? pair[1].filter((v) => typeof v === 'string') : []);
      }
    }
    if (Array.isArray(payload.objectiveCounts)) {
      for (const pair of payload.objectiveCounts) {
        if (!Array.isArray(pair) || !keyOk(pair[0])) { problems.push(`objectiveCounts: dropped "${pair?.[0]}"`); continue; }
        if (typeof pair[1] === 'number' && Number.isFinite(pair[1])) state.objectiveCounts.set(pair[0], pair[1]);
      }
    }
    if (Array.isArray(payload.suspicion)) {
      for (const pair of payload.suspicion) {
        if (!Array.isArray(pair) || !CHARACTERS[pair[0]]) { problems.push(`suspicion: dropped "${pair?.[0]}"`); continue; }
        state.suspicion.set(pair[0], Math.max(0, Math.min(100, pair[1] | 0)));
      }
    }
    if (Array.isArray(payload.choicesTaken)) {
      for (const k of payload.choicesTaken) if (typeof k === 'string') state.choicesTaken.add(k);
    }
    if (payload.chapterId && !CHAPTER_MAP[payload.chapterId]) {
      problems.push(`chapterId "${payload.chapterId}" unrecognized`);
      state.chapterId = null;
    }
    if (payload.missionId && !MISSION_MAP[payload.missionId]) {
      problems.push(`missionId "${payload.missionId}" unrecognized`);
      state.missionId = null;
    }

    return { ok: problems.length === 0, state, problems };
  }
}
