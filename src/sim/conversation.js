/**
 * THE BETRAYED WILL — conversation.js
 *
 * The runtime driver for a conversation: what line is on screen right now, when it
 * gives way to the next, what the player may choose, and what the mission system is
 * told when the scene ends.
 *
 * ── Why this exists between the walker and the UI ────────────────────────────
 * DialogueWalker owns the graph: which node, which choices are open, which effects
 * apply. It has no concept of time, because a graph does not need one. But a scene
 * is read at a speed, and something has to decide when line two appears. Putting
 * that in the UI would mean the DOM owns story pacing, and putting it in the walker
 * would mean the graph owns a clock it has no business knowing about. So it lives
 * here, pure and testable, driving the walker and emitting subtitles.
 *
 * ── Skipping is a player right, not a shortcut ───────────────────────────────
 * Pressing through a scene advances one line at a time rather than dumping the
 * player at the choice list. A scene that can be skipped instantly is a scene whose
 * writing was never read, and the writing is the product here.
 *
 * ── The mission system is told exactly once ──────────────────────────────────
 * On a clean finish this notifies EventKind.DIALOGUE with the tree id, which is what
 * completes a DIALOGUE objective. Walking away mid-scene does not notify: the
 * objective asked for the conversation, and the player declined it. They can start
 * it again, so nothing is lost by being honest about the difference.
 */

import { Events, globalBus } from '../core/bus.js';
import { EventKind } from './mission.js';
import { DIALOGUE_TREES, DIALOGUE_MAP } from '../content/dialogue.js';

/** landmark id -> tree, so an interactable can find its conversation. */
export const TREE_BY_LANDMARK = Object.freeze(DIALOGUE_TREES.reduce((acc, t) => {
  if (t.landmark) acc[t.landmark] = t.id;
  return acc;
}, {}));

/** Pause between the last line of a node and the choices becoming live, in seconds. */
const BEAT_AFTER_LINES = 0.18;

export class Conversation {
  constructor({ walker, bus = globalBus, missions = null, state = null, language = 'ar' } = {}) {
    if (!walker) throw new Error('Conversation requires a DialogueWalker');
    this.walker = walker;
    this.bus = bus;
    this.missions = missions;
    this.state = state;
    this.language = language === 'en' ? 'en' : 'ar';

    this.treeId = null;
    this.lines = [];
    this.lineIndex = -1;
    this.lineElapsed = 0;
    this.linesDone = false;
    this.beat = 0;
    this.finishedReason = null;
    this.notified = false;

    this.stats = { started: 0, refused: 0, linesShown: 0, skips: 0, choices: 0, completed: 0, left: 0 };
    /** Guards DIALOGUE_CHOICES so a node publishes its options once, not per frame. */
    this.choicesPublished = false;
  }

  get active() { return this.treeId !== null && this.finishedReason === null; }

  setLanguage(language) {
    this.language = language === 'en' ? 'en' : 'ar';
    this.walker.setLanguage?.(this.language);
    if (!this.active || this.lineIndex < 0) return;
    // The lines on screen were captured in the old language, so re-showing the same
    // index would redraw identical text. Rebuild from the walker first, then hold the
    // reader's position instead of sending them back to the top of the node.
    this.lines = this.walker.view(this.state)?.lines ?? [];
    if (this.lineIndex >= this.lines.length) this.lineIndex = Math.max(0, this.lines.length - 1);
    this._showLine(this.lineIndex);
  }

  /** The tree attached to an interactable, if it has one. */
  static treeForInteractable(interactable) {
    if (!interactable) return null;
    if (interactable.kind !== 'dialogue') return null;
    return TREE_BY_LANDMARK[interactable.id] ?? null;
  }

  /**
   * Open a scene.
   *
   * Refusals come back as reasons rather than exceptions, because the two ways this
   * fails are both normal play: the landmark has no conversation, or the player
   * cannot finish this one yet with what they are carrying. The second is the engine
   * of an investigation game - the UI shows it as "not yet", and the player goes
   * looking for what unlocks it.
   */
  start(treeId) {
    if (this.active) return { ok: false, reason: 'busy' };
    if (!DIALOGUE_MAP[treeId]) {
      this.stats.refused++;
      return { ok: false, reason: 'unknown-tree' };
    }
    const res = this.walker.begin(treeId, this.state);
    if (!res.ok) {
      this.stats.refused++;
      this.bus.emit(Events.DIALOGUE_END, { treeId, reason: res.reason, started: false });
      return { ok: false, reason: res.reason };
    }
    this.treeId = treeId;
    this.finishedReason = null;
    this.notified = false;
    this.stats.started++;
    this._enterNode();
    return { ok: true, reason: null };
  }

  /** Start the conversation belonging to an interactable the player is facing. */
  startForInteractable(interactable) {
    const treeId = Conversation.treeForInteractable(interactable);
    if (!treeId) return { ok: false, reason: 'no-tree' };
    return this.start(treeId);
  }

  /** Load the current node's lines and show the first. */
  _enterNode() {
    const view = this.walker.view(this.state);
    this.lines = view?.lines ?? [];
    this.lineIndex = -1;
    this.lineElapsed = 0;
    this.linesDone = this.lines.length === 0;
    this.beat = 0;
    this.choicesPublished = false;
    if (this.lines.length) this._showLine(0);
    this._publishChoices();
    return view;
  }

  _showLine(index) {
    if (index < 0 || index >= this.lines.length) return null;
    this.lineIndex = index;
    this.lineElapsed = 0;
    const line = this.lines[index];
    this.stats.linesShown++;
    this.bus.emit(Events.SUBTITLE, {
      treeId: this.treeId,
      nodeId: this.walker.nodeId,
      speaker: this.view()?.speaker ?? null,
      text: line.text,
      ms: line.ms,
      index,
      total: this.lines.length,
      source: 'dialogue',
    });
    return line;
  }

  /**
   * Advance the scene clock.
   *
   * Lines run for their own reading time, then the node waits. Waiting rather than
   * auto-advancing is deliberate: a scene that moves on by itself can leave a player
   * reading a choice they did not get to finish, and the only fix for that is a
   * backlog buffer, which is more machinery than simply letting the player decide.
   */
  update(dt) {
    if (!this.active) return false;
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;

    if (!this.linesDone) {
      this.lineElapsed += step * 1000;
      const line = this.lines[this.lineIndex];
      if (line && this.lineElapsed >= line.ms) {
        if (this.lineIndex + 1 < this.lines.length) this._showLine(this.lineIndex + 1);
        else this.linesDone = true;
      }
      this._publishChoices();
      return true;
    }
    // A short beat before choices go live, so a player mashing through lines does
    // not select the first choice without seeing it.
    if (this.beat < BEAT_AFTER_LINES) {
      this.beat += step;
    }
    this._publishChoices();
    return true;
  }

  /**
   * Tell the UI that the node's choices may now be taken.
   *
   * The HUD could poll view() every frame, but then the DOM would be re-reading the
   * story graph 60 times a second to notice a change that happens a handful of times
   * per scene. Publishing once on the transition means the panel is built when the
   * beat ends and left alone until the node changes. A node with no choices still
   * publishes an empty list, because the UI has to know to take the buttons away.
   */
  _publishChoices() {
    if (!this.active || this.choicesPublished || !this.readyForInput) return false;
    const view = this.walker.view(this.state);
    if (!view) return false;
    this.choicesPublished = true;
    this.bus.emit(Events.DIALOGUE_CHOICES, {
      treeId: this.treeId,
      nodeId: this.walker.nodeId,
      speaker: view.speaker ?? null,
      choices: view.choices ?? [],
      canAdvance: view.canAdvance === true,
      atEnd: view.atEnd === true,
    });
    return true;
  }

  /** True once the node's lines have run and choices may be taken. */
  get readyForInput() { return this.active && this.linesDone && this.beat >= BEAT_AFTER_LINES; }

  /** What the UI should draw, including presentation state. */
  view() {
    if (!this.active) return null;
    const v = this.walker.view(this.state);
    if (!v) return null;
    return {
      ...v,
      lineIndex: this.lineIndex,
      lineCount: this.lines.length,
      linesDone: this.linesDone,
      readyForInput: this.readyForInput,
      currentLine: this.lines[this.lineIndex]?.text ?? null,
    };
  }

  /**
   * The player pressed the advance button.
   *
   * If a line is still running it completes immediately; if the node's lines are
   * done the scene moves on. One button, two meanings, resolved by what is on
   * screen - which is what a player expects from every visual novel they have played.
   */
  skipOrAdvance() {
    if (!this.active) return { ok: false, reason: 'not-active' };

    if (!this.linesDone) {
      const line = this.lines[this.lineIndex];
      if (line && this.lineElapsed < line.ms) {
        // Skip to the end of the current line, then let the next one play. Skipping
        // the whole node would throw away lines the player has not seen.
        this.lineElapsed = line.ms;
        this.stats.skips++;
        if (this.lineIndex + 1 < this.lines.length) this._showLine(this.lineIndex + 1);
        else this.linesDone = true;
        return { ok: true, reason: 'skipped' };
      }
      if (this.lineIndex + 1 < this.lines.length) {
        this._showLine(this.lineIndex + 1);
        this.stats.skips++;
        return { ok: true, reason: 'skipped' };
      }
      this.linesDone = true;
      return { ok: true, reason: 'lines-done' };
    }

    if (this.beat < BEAT_AFTER_LINES) return { ok: false, reason: 'beat' };
    this._publishChoices();

    // A node with choices must not be advanced past by mashing: the choice IS the
    // interaction, and skipping it would silently pick nothing.
    const v = this.walker.view(this.state);
    if (v?.choices?.length) return { ok: false, reason: 'awaiting-choice' };

    const res = this.walker.advance(this.state);
    return this._afterMove(res);
  }

  /** Take a numbered choice. */
  choose(index) {
    if (!this.active) return { ok: false, reason: 'not-active' };
    if (!this.readyForInput) return { ok: false, reason: 'not-ready' };
    const res = this.walker.choose(index, this.state);
    if (!res.ok) return res;
    this.stats.choices++;
    return this._afterMove(res);
  }

  /** Walk away. Recorded, notified to nobody, and always available. */
  leave() {
    if (!this.active) return { ok: false, reason: 'not-active' };
    const res = this.walker.leave(this.state);
    return this._afterMove(res, 'left');
  }

  _afterMove(res, forcedReason = null) {
    const view = this.walker.view(this.state);
    // The walker reports completion through `finished`; a successful move that ended
    // the tree returns ok:false with reason 'ended'.
    const ended = this.walker.finished === true || res.reason === 'ended' || view === null;
    if (!ended) {
      this._enterNode();
      return { ok: true, reason: 'moved', ...res };
    }
    const reason = forcedReason ?? this.walker.stopReason ?? res.reason ?? 'ended';
    return this._finish(reason);
  }

  _finish(reason) {
    this.finishedReason = reason;
    const treeId = this.treeId;
    this.lines = [];
    this.lineIndex = -1;
    this.linesDone = true;

    if (reason === 'left') {
      this.stats.left++;
    } else {
      this.stats.completed++;
      // Exactly once, and only on a real finish. Notifying twice would double-count
      // a SEARCH-style objective and complete a dialogue objective the player never
      // actually sat through.
      if (!this.notified && this.missions && treeId) {
        this.notified = true;
        this.missions.notify({ kind: EventKind.DIALOGUE, id: treeId });
      }
    }
    const out = { ok: true, reason, treeId, completed: reason !== 'left' };
    this.treeId = null;
    return out;
  }

  /** Snapshot for the diagnostics overlay. */
  describe() {
    return {
      active: this.active,
      treeId: this.treeId,
      line: this.lineIndex + 1,
      lines: this.lines.length,
      readyForInput: this.readyForInput,
      choicesPublished: this.choicesPublished,
      finishedReason: this.finishedReason,
      stats: { ...this.stats },
    };
  }
}

export { BEAT_AFTER_LINES };
/**
 * A bus that swallows the named events and forwards everything else.
 *
 * DialogueWalker publishes every line of a node at once when it enters it, which
 * suits a log or a headless run. A timed reveal needs the opposite: one line, held
 * for its reading time, then the next. The driver supplies that, so the walker's
 * batch emission is muted here rather than the HUD being asked to ignore duplicates
 * it cannot tell apart. DIALOGUE_START, DIALOGUE_CHOICE, DIALOGUE_END, CLUE_FOUND
 * and FLAG_SET all still pass through untouched.
 *
 * @param {EventBus} bus
 * @param {string[]} events
 */
export function muteEvents(bus, events) {
  const muted = new Set(events);
  return {
    emit(type, payload) { return muted.has(type) ? true : bus.emit(type, payload); },
    on: (type, fn) => bus.on(type, fn),
    off: (type, fn) => bus.off(type, fn),
    clear: (type) => bus.clear?.(type),
    /** The bus underneath, for callers that need the unfiltered stream. */
    get raw() { return bus; },
  };
}

