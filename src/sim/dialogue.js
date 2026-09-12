/**
 * THE BETRAYED WILL — sim/dialogue.js
 *
 * The runtime half of the dialogue system: it walks a tree, applies what a node
 * does, and shows the player the lines and the choices they are actually allowed
 * to take.
 *
 * ── Why the path is planned before it is walked ───────────────────────────────
 * `bestPath()` enumerates the ways through a tree and picks the longest one that
 * still ends. A dialogue scene is content the player should see as much of as
 * possible in one visit, so "longest" is the right objective and "ends" is the hard
 * constraint: a walk that visits more of the scene but cannot leave it is worse
 * than useless. The enumeration is exact because the trees are small (four to six
 * nodes), which is a deliberate authoring limit and not an accident of the data.
 *
 * ── Why effects are applied here and not by the caller ────────────────────────
 * A node that sets a flag and a caller that forgets to apply it produce a game that
 * looks correct until a branch four conversations later is silently unavailable.
 * Applying effects inside the one function that advances the walk makes that
 * omission impossible rather than unlikely.
 */

import { Events, globalBus } from '../core/bus.js';
import { DIALOGUE } from '../core/constants.js';
import { CHARACTERS } from '../content/story.js';
import { DIALOGUE_MAP, EVERYTHING, MINOR_ROLES, allows, canFinish } from '../content/dialogue.js';

/** The text a line or choice shows, in the active language. */
export function localized(bilingual, language) {
  if (!bilingual) return '';
  return language === 'en' ? bilingual.en : bilingual.ar;
}

/**
 * Subtitle duration for one line.
 *
 * Derived from the text length rather than stored per line, so an author cannot
 * forget it and a translation that runs longer automatically gets more time.
 * Clamped, because a three-word line should not flash off the screen and a long
 * one should not outstay the moment.
 */
export function lineMs(text) {
  const raw = (String(text).length / DIALOGUE.CHARS_PER_SECOND) * 1000;
  return Math.round(Math.max(DIALOGUE.MIN_LINE_MS, Math.min(DIALOGUE.MAX_LINE_MS, raw)));
}

const isTerminal = (n) => n.end === true
  || (typeof n.next !== 'string' && !(Array.isArray(n.choices) && n.choices.length > 0));

/**
 * Every simple path from `entry` to a terminal node that `has` permits.
 *
 * Simple - no node twice - so a conversation that loops between two nodes yields
 * one path, not infinitely many. `limit` bounds the work; the trees are small
 * enough that it is never reached, and if an author ever writes one that does,
 * returning fewer paths is the correct failure mode for a game frame.
 */
export function finishingPaths(tree, has = EVERYTHING, limit = 512) {
  const nodes = tree.nodes ?? {};
  const out = [];
  const stack = [{ id: tree.entry, visited: [tree.entry], steps: [] }];
  while (stack.length && out.length < limit) {
    const cur = stack.pop();
    const node = nodes[cur.id];
    if (!node) continue;
    if (isTerminal(node)) { out.push(cur); continue; }
    const edges = [];
    if (typeof node.next === 'string') edges.push({ to: node.next, choiceIndex: null });
    for (let i = 0; i < (node.choices?.length ?? 0); i++) {
      const c = node.choices[i];
      if (allows(c.requires, has)) edges.push({ to: c.next, choiceIndex: i });
    }
    for (const e of edges) {
      if (cur.visited.includes(e.to)) continue;
      stack.push({
        id: e.to,
        visited: [...cur.visited, e.to],
        steps: [...cur.steps, { from: cur.id, choiceIndex: e.choiceIndex, to: e.to }],
      });
    }
  }
  return out;
}

/**
 * The longest finishing path, chosen deterministically.
 *
 * Ties break on the lexicographically smallest step sequence so two runs of the
 * same content produce the same playthrough. Without that, a test asserting on a
 * walk would pass and fail depending on nothing the author changed.
 */
export function bestPath(tree, has = EVERYTHING) {
  const paths = finishingPaths(tree, has);
  if (!paths.length) return null;
  let best = paths[0];
  for (const p of paths) {
    if (p.visited.length > best.visited.length) { best = p; continue; }
    if (p.visited.length === best.visited.length) {
      const a = JSON.stringify(p.steps);
      const b = JSON.stringify(best.steps);
      if (a < b) best = p;
    }
  }
  return best;
}

/**
 * Shortest route from one node to any terminal, revisiting nodes if needed.
 *
 * Unlike `finishingPaths` this is not restricted to simple paths, because a
 * conversation is allowed to return to its hub - that is what a hub-and-spoke scene
 * is. Returns null when no terminal is reachable, which `canFinish` already rules
 * out for content that passes validation.
 */
export function shortestToTerminal(tree, has = EVERYTHING, from = tree.entry) {
  const nodes = tree.nodes ?? {};
  if (!nodes[from]) return null;
  const queue = [{ id: from, steps: [] }];
  const seen = new Set([from]);
  while (queue.length) {
    const cur = queue.shift();
    if (isTerminal(nodes[cur.id])) return cur.steps;
    for (const e of exitsOf(nodes[cur.id], has)) {
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      queue.push({ id: e.to, steps: [...cur.steps, { from: cur.id, choiceIndex: e.ci, to: e.to }] });
    }
  }
  return null;
}

/** The edges a node offers a player holding `has`. */
function exitsOf(node, has) {
  const edges = [];
  if (!node) return edges;
  if (typeof node.next === 'string') edges.push({ to: node.next, ci: null });
  for (let i = 0; i < (node.choices?.length ?? 0); i++) {
    if (allows(node.choices[i].requires, has)) edges.push({ to: node.choices[i].next, ci: i });
  }
  return edges;
}

/**
 * A walk that takes every permitted edge once and then leaves.
 *
 * This is what a thorough player does with a conversation: ask everything the
 * scene offers, then go. It is the walk `autoWalk` uses by default, and the reason
 * it exists is that the simple-path enumeration above cannot represent it. A hub
 * scene whose spokes return to the hub - `order` answering and handing back to
 * `open` - has no simple path through the spokes at all, so planning only simple
 * paths skipped every node that sets a flag, and the mystery lost its evidence.
 *
 * Terminates because each edge is consumed at most once and the tail is a shortest
 * path, with DIALOGUE.MAX_STEPS as a hard stop rather than a hope.
 */
export function explorationWalk(tree, has = EVERYTHING) {
  const nodes = tree.nodes ?? {};
  const used = new Set();
  const steps = [];
  let id = tree.entry;
  for (let guard = 0; guard < DIALOGUE.MAX_STEPS; guard++) {
    const edges = exitsOf(nodes[id], has);
    if (!edges.length) return { ok: true, reason: null, steps };   // terminal
    const fresh = edges.filter((e) => !used.has(`${id}#${e.ci}`));
    if (!fresh.length) {
      const tail = shortestToTerminal(tree, has, id);
      if (!tail) return { ok: false, reason: 'no-exit', steps };
      return { ok: true, reason: null, steps: [...steps, ...tail] };
    }
    const pick = fresh[0];
    used.add(`${id}#${pick.ci}`);
    steps.push({ from: id, choiceIndex: pick.ci, to: pick.to });
    id = pick.to;
  }
  return { ok: false, reason: 'over-budget', steps };
}

export class DialogueWalker {
  constructor({ bus = globalBus, language = 'ar' } = {}) {
    this.bus = bus;
    this.language = language === 'en' ? 'en' : 'ar';
    this.treeId = null;
    this.nodeId = null;
    this.steps = 0;
    this.finished = false;
    /** Why a walk ended early, if it did: 'trapped', 'over-budget', 'left'. */
    this.stopReason = null;
  }

  get active() { return this.treeId !== null && !this.finished; }

  get tree() { return this.treeId ? DIALOGUE_MAP[this.treeId] : null; }

  get node() {
    const t = this.tree;
    return t && this.nodeId ? t.nodes[this.nodeId] ?? null : null;
  }

  setLanguage(language) { this.language = language === 'en' ? 'en' : 'ar'; }

  /**
   * Open a conversation.
   *
   * Refuses a tree that cannot be finished given what the player holds, and says
   * why. Opening a conversation the player cannot leave is how a game hangs, and
   * the refusal costs the player a prompt rather than a session.
   */
  begin(treeId, state) {
    const tree = DIALOGUE_MAP[treeId];
    if (!tree) return { ok: false, reason: 'unknown-tree' };
    const has = state ? state.has : EVERYTHING;
    if (!canFinish(tree, has)) return { ok: false, reason: 'trapped' };

    this.treeId = treeId;
    this.nodeId = tree.entry;
    this.steps = 0;
    this.finished = false;
    this.stopReason = null;
    this.#applyNodeEffects(tree.nodes[tree.entry], state);
    this.bus.emit(Events.DIALOGUE_START, { treeId, nodeId: this.nodeId, landmark: tree.landmark });
    this.#emitLines(state);
    return { ok: true, reason: null };
  }

  /**
   * What the UI should draw right now.
   *
   * Locked choices are included with `available:false` rather than hidden: a
   * player who can see that something was possible and does not yet have it has a
   * reason to go looking, which is the engine of an investigation game. Hidden
   * branches are simply content nobody knows exists.
   */
  view(state) {
    const tree = this.tree;
    const node = this.node;
    if (!tree || !node) return null;
    const has = state ? state.has : EVERYTHING;
    const choices = (node.choices ?? []).map((c, index) => {
      const available = allows(c.requires, has);
      return {
        index,
        text: localized(c.text, this.language),
        available,
        lockedReason: available ? null
          : (c.requires?.clues ?? []).find((k) => !has('clue', k)) ?? (c.requires?.flags ?? []).find((k) => !has('flag', k)) ?? null,
      };
    });
    return {
      treeId: tree.id,
      nodeId: this.nodeId,
      landmark: tree.landmark,
      speaker: this.#speakerName(node),
      lines: (node.lines ?? []).map((l) => ({
        text: localized(l, this.language),
        ms: lineMs(localized(l, this.language)),
      })),
      choices,
      canAdvance: typeof node.next === 'string',
      atEnd: isTerminal(node),
      finished: this.finished,
    };
  }

  #speakerName(node) {
    return speakerName(node.speaker ?? this.tree?.speaker, this.language);
  }

  /**
   * Follow a linear `next`, or leave if the node is terminal.
   * Returns {ok, reason} where reason is 'ended' on a clean finish.
   */
  advance(state) {
    if (!this.active) return { ok: false, reason: this.stopReason ?? 'not-active' };
    const node = this.node;
    if (isTerminal(node)) return this.#finish(state, 'ended');
    if (typeof node.next !== 'string') return this.#finish(state, 'ended');
    return this.#goto(node.next, state);
  }

  /**
   * Take a choice by index.
   *
   * A locked choice is refused with 'locked' rather than silently ignored: the UI
   * shows it as available, the player clicks, and nothing happens is the worst of
   * the three possible behaviours.
   */
  choose(index, state) {
    if (!this.active) return { ok: false, reason: this.stopReason ?? 'not-active' };
    const node = this.node;
    const choices = node.choices ?? [];
    if (!Number.isInteger(index) || index < 0 || index >= choices.length) {
      return { ok: false, reason: 'bad-index' };
    }
    const has = state ? state.has : EVERYTHING;
    if (!allows(choices[index].requires, has)) return { ok: false, reason: 'locked' };

    this.#applyChoiceEffects(choices[index], state);
    if (state) state.recordChoice(this.treeId, this.nodeId, index);
    this.bus.emit(Events.DIALOGUE_CHOICE, {
      treeId: this.treeId, nodeId: this.nodeId, index,
      text: localized(choices[index].text, this.language),
    });
    return this.#goto(choices[index].next, state);
  }

  /** The player walks away mid-conversation. Not a failure, and recorded as such. */
  leave(state) {
    if (!this.active) return { ok: false, reason: this.stopReason ?? 'not-active' };
    return this.#finish(state, 'left');
  }

  #goto(nodeId, state) {
    const tree = this.tree;
    const node = tree.nodes[nodeId];
    if (!node) {
      // Content validated against this, so reaching it means the data and the
      // walker disagree - stop loudly rather than showing an empty node forever.
      this.stopReason = 'missing-node';
      this.finished = true;
      this.bus.emit(Events.DIALOGUE_END, { treeId: this.treeId, nodeId: this.nodeId, reason: 'missing-node' });
      return { ok: false, reason: 'missing-node' };
    }
    this.nodeId = nodeId;
    this.steps++;
    if (this.steps > DIALOGUE.MAX_STEPS) return this.#finish(state, 'over-budget');

    this.#applyNodeEffects(node, state);
    this.#emitLines(state);
    if (isTerminal(node)) return this.#finish(state, 'ended');
    return { ok: true, reason: null };
  }

  #finish(state, reason) {
    this.finished = true;
    this.stopReason = reason === 'ended' ? null : reason;
    if (state) state.markTreeSeen(this.treeId);
    this.bus.emit(Events.DIALOGUE_END, {
      treeId: this.treeId, nodeId: this.nodeId, reason, steps: this.steps,
    });
    return { ok: true, reason };
  }

  #emitLines(state) {
    const node = this.node;
    for (const line of node.lines ?? []) {
      const text = localized(line, this.language);
      this.bus.emit(Events.DIALOGUE_LINE, { treeId: this.treeId, nodeId: this.nodeId, text, ms: lineMs(text) });
      this.bus.emit(Events.SUBTITLE, { text, ms: lineMs(text), source: 'dialogue' });
    }
  }

  #applyNodeEffects(node, state) {
    if (!node || !node.effects || !state) return;
    for (const f of node.effects.flags ?? []) state.setFlag(f, 'dialogue');
    for (const c of node.effects.clues ?? []) {
      if (state.grantClue(c)) this.bus.emit(Events.CLUE_FOUND, { clueId: c, source: 'dialogue' });
    }
    for (const [id, amount] of Object.entries(node.effects.suspicion ?? {})) state.addSuspicion(id, amount);
  }

  #applyChoiceEffects(choice, state) {
    if (!choice || !choice.effects || !state) return;
    for (const f of choice.effects.flags ?? []) state.setFlag(f, 'dialogue');
    for (const c of choice.effects.clues ?? []) {
      if (state.grantClue(c)) this.bus.emit(Events.CLUE_FOUND, { clueId: c, source: 'dialogue' });
    }
    for (const [id, amount] of Object.entries(choice.effects.suspicion ?? {})) state.addSuspicion(id, amount);
  }

  serialize() {
    return {
      treeId: this.treeId, nodeId: this.nodeId, steps: this.steps,
      finished: this.finished, stopReason: this.stopReason, language: this.language,
    };
  }

  restore(data) {
    if (!data) return false;
    this.treeId = data.treeId ?? null;
    this.nodeId = data.nodeId ?? null;
    this.steps = data.steps ?? 0;
    this.finished = !!data.finished;
    this.stopReason = data.stopReason ?? null;
    if (data.language) this.language = data.language === 'en' ? 'en' : 'ar';
    return this.treeId === null || !!DIALOGUE_MAP[this.treeId];
  }
}

/**
 * Walk a tree to its end along the longest permitted path, applying every effect.
 *
 * This is what a playthrough does to a conversation, and it is the function that
 * makes "all fourteen dialogue trees are completable" a measured claim rather than
 * an intention. It reports failure honestly: a tree that cannot be finished with
 * what the player holds returns `ok:false` with the reason, instead of quietly
 * stopping at a node and letting the caller assume success.
 */
export function autoWalk(tree, state, { bus = globalBus, language = 'ar', mode = 'explore' } = {}) {
  const walker = new DialogueWalker({ bus, language });
  const has = state ? state.has : EVERYTHING;
  const id = tree.id ?? tree;
  const resolved = typeof tree === 'string' ? DIALOGUE_MAP[tree] : tree;
  if (!resolved) return { ok: false, reason: 'unknown-tree', treeId: id, nodes: [], choices: [] };

  const started = walker.begin(resolved.id, state);
  if (!started.ok) return { ok: false, reason: started.reason, treeId: resolved.id, nodes: [], choices: [] };

  // 'explore' covers the whole scene, 'short' takes one linear route through it.
  const plan = mode === 'short'
    ? (() => { const p = bestPath(resolved, has); return p ? { ok: true, steps: p.steps } : { ok: false, reason: 'no-path', steps: [] }; })()
    : explorationWalk(resolved, has);
  if (!plan.ok) return { ok: false, reason: plan.reason, treeId: resolved.id, nodes: [], choices: [] };

  const nodes = [resolved.entry];
  const choices = [];
  for (const step of plan.steps) {
    const result = step.choiceIndex === null
      ? walker.advance(state)
      : walker.choose(step.choiceIndex, state);
    if (!result.ok) {
      return { ok: false, reason: result.reason, treeId: resolved.id, nodes, choices };
    }
    if (step.choiceIndex !== null) choices.push({ from: step.from, index: step.choiceIndex });
    nodes.push(step.to);
  }
  if (walker.active) walker.leave(state);

  return {
    ok: !walker.stopReason,
    reason: walker.stopReason ?? null,
    treeId: resolved.id,
    landmark: resolved.landmark,
    chapter: resolved.chapter,
    nodes,
    choices,
    steps: walker.steps,
    finished: walker.finished,
  };
}

/* ------------------------------------------------------------ speaker names */

/**
 * A speaker's display name in the active language.
 *
 * Named characters come from the story layer and the unnamed ones - the guard, the
 * cook, the potter - from the role registry in the dialogue content layer. Both are
 * leaf content modules, so resolving them here is a plain import and not a cycle.
 *
 * An unrecognized id falls back to the id itself. That is deliberate: an empty name
 * plate reads as a broken build, while a raw id reads as something a developer left
 * behind, and the second is far easier to spot in a playtest video.
 */
export function speakerName(id, language) {
  if (!id) return '';
  // CHARACTERS and MINOR_ROLES share a shape: `en` and `ar` hold the name itself,
  // and only the longer `title` is a bilingual object. Reaching for `.name` here
  // yields undefined and an empty name plate, which is why the two registries are
  // resolved through one function.
  const c = CHARACTERS[id];
  if (c) return language === 'en' ? c.en : c.ar;
  const r = MINOR_ROLES[id];
  if (r) return language === 'en' ? r.en : r.ar;
  return id;
}

/** The longer bilingual epithet, for a name plate's second line. */
export function speakerTitle(id, language) {
  const c = CHARACTERS[id];
  if (!c || !c.title) return '';
  return language === 'en' ? c.title.en : c.title.ar;
}

/** Every speaker id the fourteen trees actually use, resolved or not. */
export function unresolvedSpeakers() {
  const out = [];
  for (const tree of Object.values(DIALOGUE_MAP)) {
    const ids = new Set(Object.values(tree.nodes ?? {}).map((n) => n.speaker ?? tree.speaker));
    for (const id of ids) {
      if (!CHARACTERS[id] && !MINOR_ROLES[id]) out.push({ treeId: tree.id, speaker: id });
    }
  }
  return out;
}
