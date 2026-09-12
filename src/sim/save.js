/**
 * THE BETRAYED WILL — save.js
 *
 * Slots, backups, autosave and quota. This is the storage layer only: what a save
 * *contains* is owned by StoryState.serialize(), and this file deliberately does not
 * restate a single field of it.
 *
 * ── Why an envelope around an already-checksummed payload ─────────────────────
 * StoryState checksums the player's progress. The envelope adds the things storage
 * needs and progress does not - which slot, when, and enough metadata to draw a save
 * list without deserializing story state - and checksums those too. Two checksums is
 * not redundancy: they answer different questions, and only the inner one can say
 * whether the *progress* is intact.
 *
 * ── When leniency is unacceptable ────────────────────────────────────────────
 * StoryState.deserialize is deliberately forgiving: it loads what it recognizes and
 * reports the rest, because a save from a build whose content changed should still
 * play. The storage layer has to decide where forgiveness stops. A dropped unknown
 * clue id is a content difference and is fine. A checksum mismatch means we do not
 * know *what* was altered, so the payload is not trusted and the next backup is
 * tried instead. That distinction is the whole reason MAX_CORRUPT_RETRIES exists.
 *
 * ── Writes are not atomic ─────────────────────────────────────────────────────
 * A tab closed mid-write leaves a truncated primary. Each save therefore rotates
 * through backups first, so the previous good write is still on disk, and a load
 * walks primary then backups. Backup depth is MAX_CORRUPT_RETRIES, not a literal:
 * changing the constant changes how far back the game will reach.
 *
 * Headless by construction. Storage is injected, the clock is injected, and
 * MemoryStorage can be given a byte limit that throws a quota error - so the full
 * disk path is tested rather than hoped for.
 */

import { Events, globalBus } from '../core/bus.js';
import { SAVE } from '../core/constants.js';
import { StoryState, fnv1a, stableStringify } from './story-state.js';

export const SaveStatus = Object.freeze({
  OK: 'ok',
  NOT_FOUND: 'not-found',
  CORRUPT: 'corrupt',
  QUOTA: 'quota-exceeded',
  BACKEND_FAILURE: 'backend-failure',
  BAD_SLOT: 'bad-slot',
  NO_STATE: 'no-state',
  DEBOUNCED: 'debounced',
});

const MAGIC = 'TBW1';

/**
 * Autosave trigger names (SAVE.AUTOSAVE_EVENTS) to the bus events that fire them.
 *
 * The names are not event strings and are not meant to become ones, so the mapping
 * lives here where it can be read. 'pre-danger' is the one that needs a reason: it
 * maps to DETECTION and deliberately not SPOTTED. Saving once the player is already
 * seen writes a failure into the save, and reloading then hands it straight back -
 * a checkpoint you cannot use to avoid the thing you loaded it to avoid. Detection
 * is the moment suspicion starts rising, which is the last point a reload helps.
 */
export const AUTOSAVE_TRIGGERS = Object.freeze({
  'chapter-start': Object.freeze([Events.CHAPTER_START]),
  'mission-complete': Object.freeze([Events.MISSION_COMPLETE, Events.SIDEQUEST_COMPLETE]),
  'region-enter': Object.freeze([Events.PLAYER_ENTERED_REGION]),
  'pre-danger': Object.freeze([Events.DETECTION]),
});

/** In-memory storage, with an optional byte ceiling that behaves like a full disk. */
export class MemoryStorage {
  constructor({ limit = Infinity } = {}) {
    this.map = new Map();
    this.limit = limit;
    this.writes = 0;
    this.rejections = 0;
  }

  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  removeItem(k) { this.map.delete(k); }

  setItem(k, v) {
    const str = String(v);
    let total = str.length;
    for (const [key, val] of this.map) if (key !== k) total += val.length;
    if (total > this.limit) {
      this.rejections++;
      const err = new Error('exceeded quota');
      err.name = 'QuotaExceededError';
      throw err;
    }
    this.map.set(k, str);
    this.writes++;
  }

  /** Bytes currently held, for asserting that pruning actually freed something. */
  get bytes() { let n = 0; for (const v of this.map.values()) n += v.length; return n; }
}

function isQuotaError(err) {
  if (!err) return false;
  const name = err.name || '';
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
  // Some browsers report a full store as a plain write failure with code 22/1014.
  return err.code === 22 || err.code === 1014;
}

export class SaveSystem {
  constructor({
    storage = null,
    bus = globalBus,
    prefix = SAVE.KEY_PREFIX,
    getState = null,
    now = () => Date.now(),
    autosaveEvents = SAVE.AUTOSAVE_EVENTS,
    debounceMs = SAVE.AUTOSAVE_DEBOUNCE_MS,
  } = {}) {
    // Storage is injected, never discovered. Reaching for a host global from here
    // would break the purity of src/sim, which is what lets every test in this
    // repository run headless. The browser layer calls detectStorage() in
    // src/platform/browser.js and hands the result in.
    this.storage = storage ?? new MemoryStorage();
    /** True when nothing was injected, so writes will not outlive the session. */
    this.volatile = storage == null;
    this.bus = bus;
    this.prefix = prefix;
    this.getState = getState;
    this.now = now;
    this.debounceMs = Number.isFinite(debounceMs) && debounceMs >= 0 ? debounceMs : 0;

    this.backups = Math.max(0, SAVE.MAX_CORRUPT_RETRIES | 0);
    this.lastAutosaveAt = new Map();
    this.subscriptions = [];

    this.stats = {
      writes: 0, loads: 0, autosaves: 0, corruptReads: 0, backupsUsed: 0,
      quotaHits: 0, pruned: 0, failures: 0, debounced: 0,
    };

    const declared = [...autosaveEvents];
    for (const name of declared) {
      if (!AUTOSAVE_TRIGGERS[name]) this.bus.emit(Events.ERROR, { where: 'save', message: `unknown autosave event "${name}"` });
    }
    this.autosaveEvents = declared.filter((n) => AUTOSAVE_TRIGGERS[n]);
  }

  /* ---------------------------------------------------------------- slots */

  /** Manual slots are 0..MAX_SLOTS-3; autosave and quicksave take the last two. */
  manualSlots() {
    const n = Math.max(0, (SAVE.MAX_SLOTS | 0) - 2);
    return Array.from({ length: n }, (_, i) => i);
  }

  allSlots() { return [SAVE.AUTOSAVE_SLOT, SAVE.QUICKSAVE_SLOT, ...this.manualSlots()]; }

  validateSlot(slot) {
    if (slot === SAVE.AUTOSAVE_SLOT || slot === SAVE.QUICKSAVE_SLOT) return { ok: true, reason: null };
    if (typeof slot === 'number' && Number.isInteger(slot) && this.manualSlots().includes(slot)) {
      return { ok: true, reason: null };
    }
    return { ok: false, reason: `not a valid slot: ${JSON.stringify(slot)}` };
  }

  keyFor(slot, backup = 0) {
    const base = `${this.prefix}${slot}`;
    return backup > 0 ? `${base}.b${backup}` : base;
  }

  /* ------------------------------------------------------------- envelope */

  static wrap(payload, { slot, savedAt, meta }) {
    const envelope = {
      magic: MAGIC,
      schema: SAVE.VERSION,
      slot,
      savedAt,
      meta: meta ?? null,
      payload,
    };
    envelope.checksum = fnv1a(stableStringify(envelope));
    return envelope;
  }

  /**
   * Parse one stored string. Returns problems rather than throwing: a save list has
   * to survive one bad slot to show the others.
   */
  static unwrap(raw) {
    const problems = [];
    if (typeof raw !== 'string' || !raw.length) return { ok: false, envelope: null, problems: ['empty'] };

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Truncated mid-write. JSON.parse gives no useful detail here, and the caller
      // only needs to know this candidate is unusable.
      return { ok: false, envelope: null, problems: ['not valid JSON - truncated or overwritten mid-write'] };
    }
    if (!parsed || typeof parsed !== 'object') return { ok: false, envelope: null, problems: ['not an object'] };
    if (parsed.magic !== MAGIC) problems.push(`magic "${parsed.magic}", expected "${MAGIC}"`);
    if (parsed.schema !== SAVE.VERSION) problems.push(`schema ${parsed.schema}, expected ${SAVE.VERSION}`);

    const { checksum, ...rest } = parsed;
    if (typeof checksum !== 'number') problems.push('missing envelope checksum');
    else if (fnv1a(stableStringify(rest)) !== checksum) problems.push('envelope checksum mismatch');

    if (!parsed.payload || typeof parsed.payload !== 'object') {
      return { ok: false, envelope: null, problems: [...problems, 'no payload'] };
    }
    return { ok: problems.length === 0, envelope: parsed, problems };
  }

  /** Metadata cheap enough to read for a save list, without touching story state. */
  static metaFrom(state, extra = {}) {
    return {
      chapterId: state?.chapterId ?? null,
      missionId: state?.missionId ?? null,
      language: state?.language ?? null,
      playtimeMs: Math.round(state?.playtimeMs ?? 0),
      clues: state?.clues?.size ?? 0,
      missionsDone: state?.completedMissions?.size ?? 0,
      ...extra,
    };
  }

  /* ---------------------------------------------------------------- write */

  save(slot, state, { meta = null, label = null } = {}) {
    const valid = this.validateSlot(slot);
    if (!valid.ok) return this._fail(slot, SaveStatus.BAD_SLOT, valid.reason);

    if (!state) return this._fail(slot, SaveStatus.NO_STATE, 'no state supplied');
    const payload = typeof state.serialize === 'function' ? state.serialize() : state;
    const resolvedMeta = meta ?? SaveSystem.metaFrom(state, label ? { label } : {});

    const envelope = SaveSystem.wrap(payload, {
      slot,
      savedAt: this.now(),
      meta: resolvedMeta,
    });
    const str = stableStringify(envelope);

    // Rotate before overwriting: the current primary becomes b1, b1 becomes b2. A
    // rotation that ran after the write would put the new save in the backup too and
    // leave nothing to fall back to.
    this._rotate(slot);

    const written = this._writeKey(this.keyFor(slot), str, slot);
    if (!written.ok) return written.result;

    this.stats.writes++;
    this.bus.emit(Events.SAVE_WRITTEN, {
      slot, bytes: str.length, meta: resolvedMeta,
      pruned: written.pruned,
    });
    return {
      ok: true, status: SaveStatus.OK, slot, bytes: str.length,
      key: this.keyFor(slot), meta: resolvedMeta, pruned: written.pruned,
    };
  }

  _rotate(slot) {
    for (let i = this.backups; i >= 1; i--) {
      const from = this.keyFor(slot, i - 1);
      const to = this.keyFor(slot, i);
      const prev = this._read(from);
      if (prev === null) { this._removeKey(to); continue; }
      try { this.storage.setItem(to, prev); } catch { /* a lost backup is not a lost save */ }
    }
  }

  _read(key) {
    try { return this.storage.getItem(key); } catch { return null; }
  }

  _removeKey(key) {
    try { this.storage.removeItem(key); return true; } catch { return false; }
  }

  _writeKey(key, str, slot) {
    try {
      this.storage.setItem(key, str);
      return { ok: true, pruned: [] };
    } catch (err) {
      if (!isQuotaError(err)) {
        return { ok: false, result: this._fail(slot, SaveStatus.BACKEND_FAILURE, String(err?.message ?? err)) };
      }
    }

    this.stats.quotaHits++;
    // Free space one entry at a time and retry after each removal. Pruning
    // everything at once and then writing is easier to code and much worse for the
    // player: a disk that is one save short of full should cost one old save, not
    // every manual slot they have.
    const pruned = [];
    for (const candidate of this._pruneOrder(key, slot)) {
      if (!this._removeKey(candidate)) continue;
      pruned.push(candidate);
      this.stats.pruned++;
      try {
        this.storage.setItem(key, str);
        this.bus.emit(Events.TOAST, { kind: 'save-pruned', count: pruned.length, keys: pruned });
        return { ok: true, pruned };
      } catch (err) {
        if (!isQuotaError(err)) {
          return { ok: false, result: this._fail(slot, SaveStatus.BACKEND_FAILURE, String(err?.message ?? err), pruned) };
        }
      }
    }
    return {
      ok: false,
      result: this._fail(slot, SaveStatus.QUOTA,
        `storage full after pruning ${pruned.length} entries`, pruned),
    };
  }

  /**
   * Stored keys in the order they may be sacrificed, least valuable first.
   *
   * Backups of other slots, then manual slot primaries oldest first. The slot being
   * written, the autosave and the quicksave are never candidates: the autosave is
   * the only save the player did not have to remember to make, and if giving up
   * everything else still does not fit, the write fails loudly rather than quietly
   * eating the last thing the player did.
   */
  _pruneOrder(protectKey, protectSlot) {
    const keys = [];
    for (let i = 0; i < (this.storage.length ?? 0); i++) {
      const k = this.storage.key(i);
      if (typeof k === 'string' && k.startsWith(this.prefix)) keys.push(k);
    }
    const isBackup = (k) => /\.b\d+$/.test(k);
    const slotOf = (k) => k.slice(this.prefix.length).replace(/\.b\d+$/, '');
    const savedAt = (k) => SaveSystem.unwrap(this._read(k)).envelope?.savedAt ?? 0;

    const eligible = keys.filter((k) => k !== protectKey
      && slotOf(k) !== protectSlot
      && slotOf(k) !== SAVE.AUTOSAVE_SLOT
      && slotOf(k) !== SAVE.QUICKSAVE_SLOT);

    // Highest backup number first: b2 is older and less likely to be the copy a
    // load would actually fall back to than b1.
    const backups = eligible.filter(isBackup).sort((a, b) => b.localeCompare(a));
    const primaries = eligible.filter((k) => !isBackup(k)).sort((x, y) => savedAt(x) - savedAt(y));
    return [...backups, ...primaries];
  }

  /* ----------------------------------------------------------------- read */

  /**
   * Load a slot, walking primary then backups.
   *
   * A checksum mismatch on the story payload demotes that candidate to corrupt and
   * moves to the next one; unrecognized ids do not, because they mean the content
   * changed between builds and the rest of the save is still exactly what the player
   * earned.
   */
  load(slot) {
    const valid = this.validateSlot(slot);
    if (!valid.ok) return this._fail(slot, SaveStatus.BAD_SLOT, valid.reason);

    this.stats.loads++;
    const candidates = [0, ...Array.from({ length: this.backups }, (_, i) => i + 1)];
    const problems = [];
    let sawAny = false;

    for (const depth of candidates) {
      const key = this.keyFor(slot, depth);
      const raw = this._read(key);
      if (raw === null || raw === undefined) continue;
      sawAny = true;

      const unwrapped = SaveSystem.unwrap(raw);
      if (!unwrapped.ok) {
        this.stats.corruptReads++;
        problems.push(...unwrapped.problems.map((p) => `${key}: ${p}`));
        continue;
      }

      const res = StoryState.deserialize(unwrapped.envelope.payload);
      const fatal = (res.problems ?? []).filter((p) => /checksum mismatch/i.test(p));
      if (!res.state || fatal.length) {
        this.stats.corruptReads++;
        problems.push(...fatal.map((p) => `${key}: ${p}`));
        if (res.problems) problems.push(...res.problems.filter((p) => !fatal.includes(p)).map((p) => `${key}: ${p}`));
        continue;
      }

      if (depth > 0) this.stats.backupsUsed++;
      const out = {
        ok: true, status: SaveStatus.OK, slot, key, backup: depth,
        state: res.state, meta: unwrapped.envelope.meta,
        savedAt: unwrapped.envelope.savedAt,
        problems: [...problems, ...(res.problems ?? [])],
        usedBackup: depth > 0,
      };
      this.bus.emit(Events.SAVE_LOADED, {
        slot, backup: depth, problems: out.problems.length, meta: out.meta,
      });
      return out;
    }

    const status = sawAny ? SaveStatus.CORRUPT : SaveStatus.NOT_FOUND;
    const reason = sawAny
      ? `all ${candidates.length} copies unreadable`
      : 'nothing stored in this slot';
    return this._fail(slot, status, reason, [], problems);
  }

  /** Reads the envelope only - enough for a save list, without story validation. */
  peek(slot) {
    if (!this.validateSlot(slot).ok) return null;
    for (let depth = 0; depth <= this.backups; depth++) {
      const raw = this._read(this.keyFor(slot, depth));
      if (raw === null) continue;
      const u = SaveSystem.unwrap(raw);
      if (!u.ok) continue;
      return { slot, meta: u.envelope.meta, savedAt: u.envelope.savedAt, backup: depth };
    }
    return null;
  }

  listSlots() {
    return this.allSlots().map((slot) => {
      const info = this.peek(slot);
      return {
        slot,
        occupied: !!info,
        savedAt: info?.savedAt ?? null,
        meta: info?.meta ?? null,
        isAutosave: slot === SAVE.AUTOSAVE_SLOT,
        isQuicksave: slot === SAVE.QUICKSAVE_SLOT,
      };
    });
  }

  /** The most recent valid save, which is what "Continue" means. */
  newestSlot() {
    let best = null;
    for (const entry of this.listSlots()) {
      if (!entry.occupied) continue;
      if (!best || (entry.savedAt ?? 0) > (best.savedAt ?? 0)) best = entry;
    }
    return best ? best.slot : null;
  }

  has(slot) { return this.peek(slot) !== null; }

  remove(slot) {
    if (!this.validateSlot(slot).ok) return { ok: false, reason: 'bad slot' };
    let removed = 0;
    for (let depth = 0; depth <= this.backups; depth++) {
      const key = this.keyFor(slot, depth);
      // Existence is checked before deleting rather than inferred from the call.
      // The real backend's removeItem returns nothing and does not fail on a key
      // that was never there, so counting its results would report three deletions
      // for a slot that held one save - and a number the UI shows the player has to
      // be a true one.
      if (this._read(key) === null) continue;
      if (this._removeKey(key)) removed++;
    }
    return { ok: true, removed };
  }

  /* ------------------------------------------------------------- autosave */

  /**
   * Subscribe to the declared autosave triggers.
   *
   * The state comes from `getState` at fire time rather than being passed in, because
   * the moment an event fires is the moment worth saving and the caller of autosave
   * is the bus, not the game loop.
   */
  attachAutosave(bus = this.bus) {
    this.detachAutosave();
    if (typeof this.getState !== 'function') {
      bus.emit(Events.ERROR, { where: 'save', message: 'autosave attached with no getState' });
      return false;
    }
    for (const name of this.autosaveEvents) {
      for (const event of AUTOSAVE_TRIGGERS[name]) {
        const fn = () => this.autosave(name);
        bus.on(event, fn);
        this.subscriptions.push([event, fn]);
      }
    }
    return this.subscriptions.length > 0;
  }

  detachAutosave() {
    for (const [event, fn] of this.subscriptions) this.bus.off(event, fn);
    this.subscriptions = [];
  }

  /**
   * True when enough time has passed since this trigger last wrote.
   *
   * The timestamp is deliberately not recorded here. Recording it on the way in
   * would mean a write that failed on a full disk still consumed the debounce
   * window, and the next trigger would be skipped on the strength of a save that
   * never happened.
   */
  _debounceAllows(trigger) {
    const last = this.lastAutosaveAt.get(trigger);
    return last === undefined || this.now() - last >= this.debounceMs;
  }

  autosave(trigger = 'manual') {
    if (typeof this.getState !== 'function') {
      return this._fail(SAVE.AUTOSAVE_SLOT, SaveStatus.NO_STATE, 'autosave has no getState');
    }
    if (!this._debounceAllows(trigger)) {
      this.stats.debounced++;
      return {
        ok: false, status: SaveStatus.DEBOUNCED, debounced: true,
        reason: 'debounced', slot: SAVE.AUTOSAVE_SLOT,
      };
    }
    const state = this.getState(trigger);
    if (!state) return this._fail(SAVE.AUTOSAVE_SLOT, SaveStatus.NO_STATE, 'getState returned nothing');
    const res = this.save(SAVE.AUTOSAVE_SLOT, state, { meta: SaveSystem.metaFrom(state, { trigger }) });
    if (res.ok) {
      this.lastAutosaveAt.set(trigger, this.now());
      this.stats.autosaves++;
      this.bus.emit(Events.AUTOSAVE, { slot: SAVE.AUTOSAVE_SLOT, trigger, bytes: res.bytes });
    }
    return res;
  }

  quicksave(state) {
    const s = state ?? (typeof this.getState === 'function' ? this.getState('quicksave') : null);
    if (!s) return this._fail(SAVE.QUICKSAVE_SLOT, SaveStatus.NO_STATE, 'no state supplied');
    return this.save(SAVE.QUICKSAVE_SLOT, s);
  }

  quickload() { return this.load(SAVE.QUICKSAVE_SLOT); }

  /* ----------------------------------------------------------- diagnostics */

  _fail(slot, status, reason, pruned = [], problems = []) {
    this.stats.failures++;
    this.bus.emit(Events.SAVE_FAILED, { slot, status, reason, pruned });
    return { ok: false, status, slot, reason, pruned, problems };
  }

  /**
   * A report of everything this backend holds under the prefix.
   *
   * Useful in a bug report and in tests: it makes orphaned backups and half-written
   * primaries visible instead of leaving them as bytes nobody accounts for.
   */
  audit() {
    const entries = [];
    for (let i = 0; i < (this.storage.length ?? 0); i++) {
      const key = this.storage.key(i);
      if (typeof key !== 'string' || !key.startsWith(this.prefix)) continue;
      const raw = this._read(key);
      const u = SaveSystem.unwrap(raw);
      entries.push({
        key, bytes: raw?.length ?? 0,
        readable: u.ok, problems: u.problems,
        slot: key.slice(this.prefix.length).replace(/\.b\d+$/, ''),
        backup: /\.b\d+$/.test(key) ? Number(key.slice(key.lastIndexOf('.b') + 2)) : 0,
        savedAt: u.envelope?.savedAt ?? null,
      });
    }
    entries.sort((a, b) => a.key.localeCompare(b.key));
    return { entries, totalBytes: entries.reduce((n, e) => n + e.bytes, 0), stats: { ...this.stats } };
  }
}
