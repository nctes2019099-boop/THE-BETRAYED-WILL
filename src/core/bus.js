// THE BETRAYED WILL — event bus
// PURE MODULE. Decouples simulation systems from UI, audio and rendering so
// that gameplay logic never imports a DOM or Three.js symbol.
// Every observable gameplay event (hits, clues, dialogue, mission steps,
// suspicion changes, cinematics) flows through here.

export class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._handlers = new Map();
    /** @type {Map<string, Set<Function>>} one-shot handlers */
    this._once = new Map();
    this._queue = [];
    this._flushing = false;
    this.history = [];
    this.maxHistory = 512;
    this.recordHistory = false;
    this.dispatchCount = 0;
  }

  /** Subscribe. Returns an unsubscribe function. */
  on(type, handler) {
    if (typeof handler !== 'function') throw new TypeError('EventBus.on requires a function handler');
    let set = this._handlers.get(type);
    if (!set) { set = new Set(); this._handlers.set(type, set); }
    set.add(handler);
    return () => this.off(type, handler);
  }

  /** Subscribe for a single emission. */
  once(type, handler) {
    if (typeof handler !== 'function') throw new TypeError('EventBus.once requires a function handler');
    let set = this._once.get(type);
    if (!set) { set = new Set(); this._once.set(type, set); }
    set.add(handler);
    return () => { set.delete(handler); };
  }

  off(type, handler) {
    this._handlers.get(type)?.delete(handler);
    this._once.get(type)?.delete(handler);
  }

  removeAll(type) {
    if (type === undefined) { this._handlers.clear(); this._once.clear(); }
    else { this._handlers.delete(type); this._once.delete(type); }
  }

  listenerCount(type) {
    return (this._handlers.get(type)?.size ?? 0) + (this._once.get(type)?.size ?? 0);
  }

  /**
   * Emit immediately and synchronously.
   * Handler exceptions are isolated: one throwing listener must never break the
   * simulation step (charter C-12, §25 fail gracefully).
   */
  emit(type, payload) {
    this.dispatchCount++;
    if (this.recordHistory) {
      this.history.push({ type, payload });
      if (this.history.length > this.maxHistory) this.history.shift();
    }
    const errors = [];

    const persistent = this._handlers.get(type);
    if (persistent) {
      for (const h of Array.from(persistent)) {
        try { h(payload, type); } catch (err) { errors.push(err); }
      }
    }

    const oneShot = this._once.get(type);
    if (oneShot && oneShot.size) {
      for (const h of Array.from(oneShot)) {
        oneShot.delete(h);
        try { h(payload, type); } catch (err) { errors.push(err); }
      }
    }

    // Wildcard listeners receive everything — used by diagnostics and tests.
    const wild = this._handlers.get('*');
    if (wild && type !== '*') {
      for (const h of Array.from(wild)) {
        try { h(payload, type); } catch (err) { errors.push(err); }
      }
    }

    if (errors.length) this._reportErrors(type, errors);
    return errors.length === 0;
  }

  /**
   * Queue an emission for the next flush. Prevents re-entrant mutation while a
   * system is mid-iteration (e.g. an AI reaction firing during the AI update).
   */
  defer(type, payload) {
    this._queue.push({ type, payload });
  }

  /** Drain the deferred queue. Safe to call re-entrantly. */
  flush(limit = 1000) {
    if (this._flushing) return 0;
    this._flushing = true;
    let processed = 0;
    try {
      while (this._queue.length && processed < limit) {
        const { type, payload } = this._queue.shift();
        this.emit(type, payload);
        processed++;
      }
    } finally {
      this._flushing = false;
    }
    return processed;
  }

  get pending() { return this._queue.length; }

  _reportErrors(type, errors) {
    // Never let a listener failure black-screen the game (§25).
    for (const err of errors) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn(`[EventBus] listener for "${type}" threw:`, err?.message ?? err);
      }
    }
  }
}

/** Canonical event names. Centralised so typos become obvious in review. */
export const Events = Object.freeze({
  // lifecycle
  BOOT: 'boot',
  READY: 'ready',
  SHUTDOWN: 'shutdown',
  PAUSE: 'pause',
  RESUME: 'resume',
  CONTEXT_LOST: 'webgl:context-lost',
  CONTEXT_RESTORED: 'webgl:context-restored',
  VISIBILITY: 'app:visibility',
  ERROR: 'app:error',

  // player
  PLAYER_MOVED: 'player:moved',
  PLAYER_JUMPED: 'player:jumped',
  PLAYER_LANDED: 'player:landed',
  PLAYER_DODGED: 'player:dodged',
  PLAYER_CROUCHED: 'player:crouched',
  PLAYER_SPRINTED: 'player:sprinted',
  PLAYER_DAMAGED: 'player:damaged',
  PLAYER_HEALED: 'player:healed',
  PLAYER_DIED: 'player:died',
  PLAYER_FALL_DAMAGE: 'player:fall-damage',
  PLAYER_LEDGE_GRAB: 'player:ledge-grab',
  PLAYER_LEDGE_RELEASE: 'player:ledge-release',
  PLAYER_ENTERED_REGION: 'player:region-enter',
  PLAYER_INTERACT: 'player:interact',

  // combat
  COMBAT_ATTACK: 'combat:attack',
  COMBAT_HIT: 'combat:hit',
  COMBAT_BLOCKED: 'combat:blocked',
  COMBAT_PARRIED: 'combat:parried',
  COMBAT_DODGED: 'combat:dodged',
  COMBAT_STAGGER: 'combat:stagger',
  COMBAT_KNOCKDOWN: 'combat:knockdown',
  COMBAT_KILL: 'combat:kill',
  COMBAT_FINISHER: 'combat:finisher',
  COMBAT_LOCKON: 'combat:lockon',
  COMBAT_HITSTOP: 'combat:hitstop',
  DAMAGE_NUMBER: 'combat:damage-number',
  PROJECTILE_FIRED: 'projectile:fired',
  PROJECTILE_HIT: 'projectile:hit',

  // stealth / perception
  NOISE_EMITTED: 'stealth:noise',
  SUSPICION_CHANGED: 'stealth:suspicion',
  DETECTION: 'stealth:detection',
  SPOTTED: 'stealth:spotted',
  LOST_TRACK: 'stealth:lost',
  TAKEDOWN: 'stealth:takedown',
  HIDING_CHANGED: 'stealth:hiding',

  // AI
  AI_STATE_CHANGED: 'ai:state',
  AI_ALERTED: 'ai:alerted',
  AI_SEARCHING: 'ai:searching',
  AI_REINFORCEMENT: 'ai:reinforcement',

  // investigation
  CLUE_FOUND: 'investigation:clue',
  EVIDENCE_LINKED: 'investigation:link',
  CONCLUSION_REACHED: 'investigation:conclusion',
  BOARD_UPDATED: 'investigation:board',

  // story
  CHAPTER_START: 'story:chapter-start',
  CHAPTER_END: 'story:chapter-end',
  MISSION_START: 'story:mission-start',
  MISSION_OBJECTIVE: 'story:objective',
  MISSION_COMPLETE: 'story:mission-complete',
  MISSION_FAILED: 'story:mission-failed',
  CUTSCENE_START: 'cinematic:start',
  CUTSCENE_END: 'cinematic:end',
  FLASHBACK: 'story:flashback',
  SIDEQUEST_START: 'sidequest:start',
  SIDEQUEST_COMPLETE: 'sidequest:complete',
  CHARACTER_DEATH: 'story:character-death',

  // dialogue
  DIALOGUE_START: 'dialogue:start',
  DIALOGUE_LINE: 'dialogue:line',
  DIALOGUE_CHOICE: 'dialogue:choice',
  /** The node's choices have gone live and the player may pick one. */
  DIALOGUE_CHOICES: 'dialogue:choices',
  DIALOGUE_END: 'dialogue:end',

  // progression
  ITEM_ACQUIRED: 'inventory:acquired',
  ITEM_REMOVED: 'inventory:removed',
  ITEM_USED: 'inventory:used',
  WEAPON_EQUIPPED: 'inventory:weapon-equipped',
  CURRENCY_CHANGED: 'economy:currency',
  SKILL_UNLOCKED: 'skill:unlocked',
  SKILL_USED: 'skill:used',
  RELATIONSHIP_CHANGED: 'relationship:changed',
  REPUTATION_CHANGED: 'reputation:changed',
  MEMORY_RECORDED: 'memory:recorded',

  // world
  TIME_CHANGED: 'world:time',
  DAY_CHANGED: 'world:day',
  WEATHER_CHANGED: 'world:weather',

  // systems
  SAVE_WRITTEN: 'save:written',
  SAVE_LOADED: 'save:loaded',
  SAVE_FAILED: 'save:failed',
  AUTOSAVE: 'save:auto',
  LANGUAGE_CHANGED: 'i18n:language',
  SETTINGS_CHANGED: 'settings:changed',

  // ui
  UI_OPEN: 'ui:open',
  UI_CLOSE: 'ui:close',
  SUBTITLE: 'ui:subtitle',
  TOAST: 'ui:toast',
  PROMPT: 'ui:prompt',
});

export const globalBus = new EventBus();
