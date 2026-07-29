/**
 * The projection (progress §1, §3): a run's outline joined with its event log, producing per-node
 * counters, timings, badges and token sums.
 *
 * **Step state is `deriveStepStates`' answer, copied — never recomputed here (progress §3.1).** That is
 * the single rule this module exists to obey. The event log already has one interpreter (spec §5.1) and
 * `/workflow run list`, resume routing, and this panel all read it; a second interpretation living here
 * would mean a step could be `completed` in a listing and `in_progress` in the tree, from the same
 * bytes, with no way to tell which was lying. So the fold below records only what a TREE needs and the
 * state map does not carry: when things started and stopped, how many iterations/items/tokens, which
 * attempt is running, how many questions are pending.
 *
 * A construct — a loop, a foreach, a branch, a parallel, a nested workflow — has no step state to look
 * up, because it is not a step and `deriveStepStates` correctly declines to invent one for it. Its state
 * is a ROLL-UP of its subtree ({@link rollup}), closed by its own `node-completed` when it has one. That
 * is aggregation, not a second derivation: every leaf state in the roll-up came from the state map.
 *
 * Re-projected from scratch on every event rather than mutated in place (progress §2.4), which is what
 * makes the live widget, a resumed run, and the terminal card literally the same function of the same
 * input. `now` is a parameter (progress §2.1) — nothing in this layer reads a clock.
 */
import { formatPath, parsePath, staticKeyOf, staticPathOf } from "../engine/node-path.ts";
import { deriveRunStatus } from "../engine/run-status.ts";
import { deriveStepStates, type StepState, type StepStateKey } from "../engine/step-state.ts";
import type { RetryReason, RunEvent } from "../engine/types.ts";
import { foreachItemChildren, foreachItemPath } from "./outline.ts";
import type { Outline, OutlineNode, ProgressNode, ProgressView } from "./types.ts";

/** Everything the fold learns about one static node path that step state does not already say. */
interface NodeStats {
  /** The LATEST start (spec §5.4's "latest execution wins"): iteration 7's clock, not iteration 1's. */
  startedAt?: number;
  /** The matching end, absent while the node is still open. */
  endedAt?: number;
  /**
   * Tokens summed across EVERY execution of this key, deliberately not reset per loop iteration. A
   * loop's collapsed summary reports its whole subtree's cost (progress §4.9), and a subtree sum built
   * from per-iteration figures would report only the last iteration — turning the one number that
   * exists to make spend visible (progress §5.4) into an undercount that grows with the loop.
   */
  tokens: number;
  retry?: { attempt: number; reason: RetryReason };
  repairs?: number;
  questions?: number;
  failureReason?: string;
  /** Whether any event has ever named this path — how a construct with no children yet is told from one never entered. */
  touched: boolean;
}

/** The fold's accumulated view of the log, before it is joined with the outline. */
interface Fold {
  readonly stats: Map<string, NodeStats>;
  /** Paths closed by their own `node-completed` / `foreach-item-completed` — a construct's only direct evidence of completion. */
  readonly closed: Set<string>;
  readonly loopIterations: Map<string, number>;
  readonly foreachCounts: Map<string, number>;
  readonly foreachDone: Map<string, Set<number>>;
  /** Item indices in first-seen order, so live item rows appear in the order the run reached them. */
  readonly foreachSeen: Map<string, number[]>;
  /** A live item's label stub (progress §3.6), keyed by item path. */
  readonly itemStubs: Map<string, string>;
  /**
   * Static keys that have settled at least ONCE in this log — which is not the same as being settled
   * now, and the difference is a loop.
   *
   * A loop body's rows are keyed by static path (spec §5.4), so iteration 2's `step-started` flips a
   * step that iteration 1 completed back to `in_progress`. That is right for the ROW (§3.3: iteration 7
   * overwrites iteration 6 in place) and wrong for the FOOTER, which would count down by the whole body
   * on every single iteration — a bar retreating rhythmically for the entire life of a repair loop,
   * which is the construct this framework exists for. This set is a fold over the log like everything
   * else here, so it is a pure function of the prefix and can only grow as the prefix does.
   */
  readonly settledOnce: Set<string>;
  runStartedAt?: number;
  runEndedAt?: number;
  /**
   * The state a run-level terminal event leaves an UNCLOSED construct in. Without it a run cancelled
   * between two loop iterations would leave the loop reading `in_progress` forever — a spinner on a
   * panel describing a run that has stopped.
   */
  runTerminal?: StepState;
  runTokens: number;
  runId?: string;
  failureReason?: string;
}

/**
 * Join a workflow's outline with a run's events (progress §3). `now` supplies the live half of every
 * unfinished duration and is the ONLY non-deterministic input — pass the same `now` twice and this
 * returns the same view twice.
 */
export function project(outline: Outline, events: readonly RunEvent[], now: Date): ProgressView {
  const states = deriveStepStates(events);
  const fold = foldEvents(events);
  const nowMs = now.getTime();

  const nodes = outline.nodes.map((node) => projectNode(node, states, fold, nowMs, false));
  const counted = tally(nodes, fold.settledOnce);

  return {
    workflowName: outline.workflowName,
    runId: fold.runId,
    status: deriveRunStatus(events),
    elapsedMs: fold.runStartedAt === undefined ? undefined : (fold.runEndedAt ?? nowMs) - fold.runStartedAt,
    live: fold.runStartedAt !== undefined && fold.runEndedAt === undefined,
    tokens: fold.runTokens,
    stepsSettled: counted.settled,
    stepsTotal: counted.total,
    failureReason: fold.failureReason,
    nodes,
  };
}

/** A leaf step that will never move again — the footer bar's numerator counts these, not just `completed`. */
const SETTLED: ReadonlySet<StepState> = new Set<StepState>(["completed", "skipped", "crashed", "cancelled"]);

/**
 * The footer's tally (progress §4.6, §6.4.1): settled leaves over total leaves.
 *
 * **A foreach counts every item its `foreach-started` declared, not only the ones with rows.** Items
 * with no events get no ROW (§3.8) — the log has nothing to label them with — but they are certainly
 * work, and leaving them out of the denominator is what made the bar run BACKWARDS: with items
 * materialising one at a time, a healthy run went `1 of 2` → `1 of 3` → `1 of 4` as the fan-out opened,
 * retreating on every single item of every single foreach. A bar that goes backwards while nothing is
 * wrong destroys trust in everything else on the panel, so the count is taken from the event that
 * declares it and multiplied by the body's own leaf count, which the outline knows exactly.
 */
function tally(nodes: readonly ProgressNode[], settledOnce: ReadonlySet<string>): { settled: number; total: number } {
  let settled = 0;
  let total = 0;
  for (const node of nodes) {
    if (isCountedLeaf(node)) {
      total += 1;
      // "Has settled" rather than "is settled": a loop body step that iteration 2 has re-entered is
      // running again, and counting down for it would walk the bar backwards once per iteration.
      if (SETTLED.has(node.state) || settledOnce.has(node.path)) settled += 1;
      continue;
    }
    const inner = tally(node.children, settledOnce);
    settled += inner.settled;
    total += inner.total;
    // Declared but not yet begun: certainly outstanding, and known exactly (progress §3.8).
    total += (node.pendingItems ?? 0) * (node.perItemSteps ?? 1);
  }
  return { settled, total };
}

/** A unit of work in the tally: a step, or a foreach item whose single-step body IS its row (§3.6). */
function isCountedLeaf(node: ProgressNode): boolean {
  return node.kind === "step" || (node.kind === "foreach-item" && node.children.length === 0);
}

// -- The fold (progress §3.2) -------------------------------------------------------------------------

/**
 * One pass over the log, contributing exactly what progress §3.2's table says and nothing else.
 * `run-meta` and `step-log` are listed there as "not rendered in the tree" and are genuinely inert here.
 */
function foldEvents(events: readonly RunEvent[]): Fold {
  const fold: Fold = {
    stats: new Map(),
    closed: new Set(),
    loopIterations: new Map(),
    foreachCounts: new Map(),
    foreachDone: new Map(),
    foreachSeen: new Map(),
    itemStubs: new Map(),
    settledOnce: new Set(),
    runTokens: 0,
  };

  for (const event of events) {
    if (fold.runId === undefined && "runId" in event) fold.runId = event.runId;

    switch (event.type) {
      case "run-started":
      case "run-resumed":
        // The clock restarts on a resume: a run parked overnight has been WORKING for seconds, and a
        // header reading 14:02:11 would describe the wait rather than the run (progress §3.2).
        fold.runStartedAt = at(event.at);
        fold.runEndedAt = undefined;
        fold.runTerminal = undefined; // a resume supersedes whatever terminal event preceded it (spec §5.5)
        break;
      case "step-started": {
        // A fresh execution clears the previous one's badges — this is progress §3.2's "body rows reset",
        // which a loop reaches through its body's step-started events rather than through the loop's own
        // `loop-iteration`. Tokens deliberately survive (see {@link NodeStats.tokens}).
        const stats = statsFor(fold, event.path);
        stats.startedAt = at(event.at);
        stats.endedAt = undefined;
        stats.retry = undefined;
        stats.repairs = undefined;
        stats.questions = undefined;
        stats.failureReason = undefined;
        recordItemStub(fold, event.path, event.input);
        break;
      }
      case "step-completed":
        statsFor(fold, event.path).endedAt = at(event.at);
        fold.settledOnce.add(key(event.path));
        break;
      case "step-failed": {
        const stats = statsFor(fold, event.path);
        stats.endedAt = at(event.at);
        stats.failureReason = event.error;
        fold.settledOnce.add(key(event.path));
        break;
      }
      case "step-cancelled":
        statsFor(fold, event.path).endedAt = at(event.at);
        fold.settledOnce.add(key(event.path));
        break;
      case "step-retry":
        statsFor(fold, event.path).retry = { attempt: event.attempt, reason: event.reason };
        break;
      case "agent-steer":
        statsFor(fold, event.path).repairs = event.attempt;
        break;
      case "agent-usage":
        statsFor(fold, event.path).tokens += event.totalTokens;
        fold.runTokens += event.totalTokens;
        break;
      case "questionnaire-asked": {
        // Freeze the clock at the moment of blocking: a step waiting on a human is not working, and a
        // duration that kept climbing overnight would say it was (spec §5.1 — `blocked` means, and only
        // ever means, waiting on a human).
        const stats = statsFor(fold, event.path);
        stats.endedAt = at(event.at);
        stats.questions = event.questionnaire.questions.length;
        break;
      }
      case "answers-provided": {
        // The same agent loop continues (spec §8.4), so the visible clock restarts here rather than
        // counting the wait that has just ended.
        const stats = statsFor(fold, event.path);
        stats.startedAt = at(event.at);
        stats.endedAt = undefined;
        stats.questions = undefined;
        break;
      }
      case "node-started": {
        const stats = statsFor(fold, event.path);
        stats.startedAt = at(event.at);
        stats.endedAt = undefined;
        break;
      }
      case "node-completed": {
        statsFor(fold, event.path).endedAt = at(event.at);
        fold.closed.add(key(event.path));
        break;
      }
      case "branch-arm": {
        // A taken arm opens like any other unit of work and is closed by its own `node-completed`
        // (spec §5.1), so its clock starts here. Whether it was taken at all is `deriveStepStates`'
        // call, not ours — this only records when the arm was reached.
        const stats = statsFor(fold, event.path);
        if (event.taken) stats.startedAt ??= at(event.at);
        break;
      }
      case "loop-iteration": {
        // The iteration path (`until-green#2`) reduces to the loop's own static key, which is exactly
        // the key the loop's outline node carries (spec §5.4).
        const stats = statsFor(fold, event.path);
        stats.startedAt ??= at(event.at);
        fold.loopIterations.set(key(event.path), event.iteration);
        break;
      }
      case "foreach-started": {
        const stats = statsFor(fold, event.path);
        stats.startedAt ??= at(event.at);
        fold.foreachCounts.set(key(event.path), event.count);
        break;
      }
      case "foreach-item-started": {
        const item = splitItemPath(event.path);
        seeItem(fold, item.foreachKey, item.index);
        const stats = statsFor(fold, event.path);
        stats.startedAt = at(event.at);
        stats.endedAt = undefined;
        break;
      }
      case "foreach-item-completed": {
        const item = splitItemPath(event.path);
        seeItem(fold, item.foreachKey, item.index);
        statsFor(fold, event.path).endedAt = at(event.at);
        fold.closed.add(item.itemKey);
        done(fold, item.foreachKey).add(item.index);
        break;
      }
      case "run-completed":
        fold.runEndedAt = at(event.at);
        fold.runTerminal = "completed";
        closeOpen(fold, at(event.at));
        break;
      case "run-crashed":
        fold.runEndedAt = at(event.at);
        fold.runTerminal = "crashed";
        fold.failureReason = event.error;
        closeOpen(fold, at(event.at));
        break;
      case "run-cancelled":
        fold.runEndedAt = at(event.at);
        fold.runTerminal = "cancelled";
        closeOpen(fold, at(event.at));
        break;
      default:
        break; // run-meta, step-log — inert in the tree (progress §3.2)
    }
  }

  return fold;
}

/**
 * A run-level terminal event stops every clock still running, mirroring `deriveStepStates`' own
 * force-close (spec §5.1): a step left open by a crash is not still working, and without this its row
 * would tick forever against `now` — which would also make a FINISHED run's render depend on the clock,
 * quietly breaking progress §4.8's byte-identity for the card that outlives it.
 */
function closeOpen(fold: Fold, when: number): void {
  for (const stats of fold.stats.values()) {
    if (stats.startedAt !== undefined && stats.endedAt === undefined) stats.endedAt = when;
  }
}

function statsFor(fold: Fold, path: string): NodeStats {
  const k = key(path);
  const existing = fold.stats.get(k);
  if (existing) {
    existing.touched = true;
    return existing;
  }
  const fresh: NodeStats = { tokens: 0, touched: true };
  fold.stats.set(k, fresh);
  return fresh;
}

/** An event's dynamic path reduced to the static key every projection and the state map agree on (spec §5.4). */
function key(path: string): StepStateKey {
  return staticKeyOf(parsePath(path));
}

/** Parse an ISO timestamp, refusing anything unparseable rather than propagating a silent `NaN` duration. */
function at(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`progress: event timestamp "${iso}" is not a parseable ISO date`);
  return ms;
}

// -- Foreach items (progress §3.3, §3.6) --------------------------------------------------------------

/** A foreach item's path split into the parts the projection keys by: the foreach, the item, the index. */
function splitItemPath(path: string): { foreachKey: string; itemKey: string; index: number } {
  const segments = staticPathOf(parsePath(path));
  const leaf = segments.at(-1);
  if (!leaf || leaf.index === undefined) {
    throw new Error(`progress: foreach item path "${path}" has no item index (spec §8.5 requires one on foreach item events)`);
  }
  return {
    foreachKey: formatPath([...segments.slice(0, -1), { name: leaf.name }]),
    itemKey: formatPath(segments),
    index: leaf.index,
  };
}

function seeItem(fold: Fold, foreachKey: string, index: number): void {
  const seen = fold.foreachSeen.get(foreachKey) ?? [];
  if (!seen.includes(index)) seen.push(index);
  fold.foreachSeen.set(foreachKey, seen);
}

function done(fold: Fold, foreachKey: string): Set<number> {
  const existing = fold.foreachDone.get(foreachKey);
  if (existing) return existing;
  const fresh = new Set<number>();
  fold.foreachDone.set(foreachKey, fresh);
  return fresh;
}

/**
 * Record a live item's label stub from the first step to start inside it (progress §3.6).
 *
 * The item VALUES are not in the log — `foreach-item-started` carries only an index — but a foreach
 * hands each item to its body as that body's input (spec §3.4), so the first `step-started` inside an
 * item carries the item itself. First one wins, which is the body's first step. Cheap where it works
 * (a step with no input schema receives `undefined` and the row falls back to its index), and silent
 * where it does not; nothing here inspects an item deeply enough to become a second guessing game.
 */
function recordItemStub(fold: Fold, path: string, input: unknown): void {
  const segments = staticPathOf(parsePath(path));
  // The INNERMOST enclosing item: under nested foreaches only that one's body sees this input.
  const depth = segments.findLastIndex((segment) => segment.index !== undefined);
  if (depth === -1 || depth === segments.length - 1) return;

  const itemKey = formatPath(segments.slice(0, depth + 1));
  if (fold.itemStubs.has(itemKey)) return;
  const stub = itemStub(input);
  if (stub !== undefined) fold.itemStubs.set(itemKey, stub);
}

/**
 * A one-line stub of an item (progress §3.6): the item itself if it is a string, else its `name`, `id`,
 * or `path` field, giving `review · src/engine` rather than `review · item 3`. Anything less obvious —
 * a nested object, a number — has no stub and the row falls back to its index.
 */
function itemStub(item: unknown): string | undefined {
  if (typeof item === "string") return item.length > 0 ? item : undefined;
  if (item === null || typeof item !== "object") return undefined;
  for (const field of ["name", "id", "path"] as const) {
    const value = (item as Record<string, unknown>)[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

// -- Joining the outline with the fold ----------------------------------------------------------------

/**
 * Project one outline node against the log.
 *
 * `skipped` propagates a branch arm's skip DOWN its whole subtree, and it is not decoration.
 * `deriveStepStates` records the skip on the ARM and deliberately does not walk into it (spec §5.1 —
 * enumerating a skipped body would need the workflow tree, which a pure fold over the log does not
 * have). This projection DOES have the tree, so it finishes the job: without it every step inside an
 * untaken arm reads `todo` forever, and a cleanly completed run renders a footer stuck at `2 of 3` with
 * a bar that never fills — the panel reporting outstanding work on a run that is over.
 */
function projectNode(outline: OutlineNode, states: ReadonlyMap<StepStateKey, StepState>, fold: Fold, nowMs: number, skipped: boolean): ProgressNode {
  if (outline.kind === "foreach") return projectForeach(outline, states, fold, nowMs, skipped);

  // A step and a branch arm both have a state of their own in the map (spec §5.1 covers arms
  // explicitly); every other kind is a construct and rolls its subtree up, so its state is decided
  // AFTER its children. An inherited skip settles every kind outright.
  const own = skipped ? "skipped" : outline.kind === "step" || outline.kind === "branch-arm" ? (states.get(outline.path) ?? "todo") : undefined;
  const children = outline.children.map((child) => projectNode(child, states, fold, nowMs, skipped || own === "skipped"));
  const stats = fold.stats.get(outline.path);
  const state = own ?? constructState(outline.path, children, fold, stats);

  return {
    ...timing(stats, nowMs),
    kind: outline.kind,
    name: outline.name,
    path: outline.path,
    state,
    children,
    tokens: (stats?.tokens ?? 0) + sum(children, (child) => child.tokens),
    optional: outline.optional === true,
    retry: stats?.retry ? { ...stats.retry, of: outline.maxAttempts } : undefined,
    repairs: stats?.repairs,
    questions: questionsOf(stats, children),
    failureReason: stats?.failureReason,
    loop: outline.kind === "loop" ? loopCounter(outline, fold) : undefined,
    arms: outline.kind === "branch" || outline.kind === "parallel" ? outline.children.length : undefined,
    // Only a BRANCH can leave an arm unrun (spec §3.2's multi-match), so this is what stops a finished
    // branch from claiming both arms ran when one was never eligible (progress §6.1's summary).
    armsTaken: outline.kind === "branch" || outline.kind === "parallel" ? children.filter((child) => child.state !== "skipped").length : undefined,
    // The kinds whose body is a sub-workflow, and whose collapsed summary therefore counts steps
    // (progress §6.1's `▸ audit  ✓ 4 steps · 51.0s`) rather than arms or iterations.
    steps: outline.kind === "workflow" || outline.kind === "branch-arm" ? children.flatMap(leafSteps).length : undefined,
  };
}

/**
 * A foreach (progress §3.3/§3.4): the template body is not projected as it stands — one row per LIVE
 * item is instantiated from the item indices the log actually mentions, each carrying its own index in
 * its path (spec §5.4's exception, since with `concurrency > 1` several items are genuinely live).
 *
 * Items with no events yet get no row even once `foreach-started` has declared the count: the count is
 * on the foreach's own row (`4/7 items`), and materialising several hundred `todo` rows for a foreach
 * over a long list would bury the active path progress §6.2 exists to keep visible.
 */
function projectForeach(outline: OutlineNode, states: ReadonlyMap<StepStateKey, StepState>, fold: Fold, nowMs: number, skipped: boolean): ProgressNode {
  const seen = [...(fold.foreachSeen.get(outline.path) ?? [])].sort((a, b) => a - b);
  const items = seen.map((index) => projectForeachItem(outline, index, states, fold, nowMs, skipped));
  const stats = fold.stats.get(outline.path);
  const count = fold.foreachCounts.get(outline.path);

  return {
    ...timing(stats, nowMs),
    kind: "foreach",
    name: outline.name,
    path: outline.path,
    state: skipped ? "skipped" : constructState(outline.path, items, fold, stats),
    children: items,
    tokens: sum(items, (item) => item.tokens),
    optional: false,
    questions: questionsOf(undefined, items),
    // Absent until `foreach-started` says how many there are — nothing is invented (progress §3.4).
    foreach: count === undefined ? undefined : { done: fold.foreachDone.get(outline.path)?.size ?? 0, count },
    // What the footer needs to stop retreating: how much work this fan-out will be, from the moment
    // the run knows it, without materialising a row for any of it (progress §3.8, §6.4.1).
    perItemSteps: templateLeafCount(outline.children),
    pendingItems: count === undefined ? undefined : Math.max(0, count - items.length),
  };
}

/**
 * Leaf steps in ONE item's body, counted from the static template rather than from a materialised item
 * — which is the whole point: it is known before any item has started, and it does not change.
 *
 * A nested foreach inside the body is counted as a single item's worth, because its own length is
 * genuinely unknown until it runs (progress §3.4). That makes a doubly-nested fan-out's total a lower
 * bound that refines as the inner foreaches start, which is the honest answer to a question the log
 * cannot yet answer — and it is the only case where the total still moves.
 */
function templateLeafCount(nodes: readonly OutlineNode[]): number {
  let count = 0;
  for (const node of nodes) count += node.kind === "step" ? 1 : templateLeafCount(node.children);
  return count;
}

function projectForeachItem(outline: OutlineNode, index: number, states: ReadonlyMap<StepStateKey, StepState>, fold: Fold, nowMs: number, skipped: boolean): ProgressNode {
  const itemPath = foreachItemPath(outline, index);
  const body = foreachItemChildren(outline, itemPath).map((child) => projectNode(child, states, fold, nowMs, skipped));
  const stats = fold.stats.get(itemPath);

  return {
    ...timing(stats, nowMs),
    kind: "foreach-item",
    name: itemLabel(outline, itemPath, index, fold),
    path: itemPath,
    state: skipped ? "skipped" : constructState(itemPath, body, fold, stats),
    // The body is kept WHOLE even when it is a single step that the panel will draw as the item row
    // itself (progress §3.6's `review · src/engine`). Dropping it here instead would leave
    // `review-each@0/review` — a path the engine really emits — with no node at all, so nothing
    // downstream could answer "what is that step doing?", and a live-engine check that every emitted
    // path has a row would have to be weakened to a check that most of them do. Which rows are worth
    // DRAWING is collapse.ts's decision, not this one (progress §6).
    children: body,
    tokens: sum(body, (child) => child.tokens),
    optional: false,
    questions: questionsOf(undefined, body),
    steps: body.length > 1 ? body.flatMap(leafSteps).length : undefined,
  };
}

/** `review · src/engine` — the body's first step name, plus the item's stub or its index (progress §3.6). */
function itemLabel(outline: OutlineNode, itemPath: string, index: number, fold: Fold): string {
  const stem = outline.children[0]?.name ?? outline.name;
  return `${stem} · ${fold.itemStubs.get(itemPath) ?? `item ${index}`}`;
}

// -- Construct state (an aggregation of step state, never a second derivation) -------------------------

/**
 * A construct's state.
 *
 * **Only its own `node-completed` can make a construct `completed`** — not a subtree that happens to
 * look finished. That distinction is the whole rule, and getting it wrong is not cosmetic: a loop
 * between iterations has a body whose every step is `completed` from the iteration that just ended
 * (spec §5.4's latest-execution-wins), so a roll-up alone reports a live loop as finished, collapses it
 * (progress §6.1), and prints `↻ 2 iterations · 7s` — the *past tense* — over a run that is still
 * going. The checkpoint the engine writes exactly when a construct finishes (spec §8.2) is the only
 * evidence that is never ambiguous, so it is the only evidence accepted.
 *
 * A run-level terminal event is the one exception, and it mirrors `deriveStepStates`' own force-close
 * (spec §5.1): a construct left open by a crash or a cancel is not still working.
 */
function constructState(path: string, children: readonly ProgressNode[], fold: Fold, stats: NodeStats | undefined): StepState {
  if (fold.closed.has(path)) return "completed";
  const rolled = rollup(children);
  if (rolled !== "settled" && rolled !== "untouched") return rolled;
  if (rolled === "untouched" && !stats?.touched) return "todo";
  return fold.runTerminal ?? "in_progress";
}

/** What a subtree says about its parent. `settled` is deliberately NOT `completed` — see {@link constructState}. */
type Rollup = "in_progress" | "blocked" | "crashed" | "cancelled" | "settled" | "untouched";

/**
 * Roll a subtree's states into one, in the same precedence spec §5.3 uses for a run: work in flight
 * outranks a waiting question, which outranks a failure. `untouched` means nothing in the subtree has
 * run at all — the caller decides whether that is `todo` or a construct that has started but has no
 * children yet (an entered foreach whose first item has not begun).
 */
function rollup(children: readonly ProgressNode[]): Rollup {
  if (children.length === 0) return "untouched";
  if (children.some((child) => child.state === "in_progress")) return "in_progress";
  if (children.some((child) => child.state === "blocked")) return "blocked";
  if (children.some((child) => child.state === "crashed")) return "crashed";
  if (children.some((child) => child.state === "cancelled")) return "cancelled";
  if (children.every((child) => child.state === "completed" || child.state === "skipped")) return "settled";
  if (children.some((child) => child.state !== "todo")) return "in_progress";
  return "untouched";
}

// -- Small shared shapings -----------------------------------------------------------------------------

/**
 * A node's clock. A recorded end freezes the duration for good (and keeps its tenths, since it can
 * never change again); an open node measures against `now` and is flagged `live`, which is the renderer's
 * cue to format it to whole seconds (progress §4.8).
 */
function timing(stats: NodeStats | undefined, nowMs: number): { elapsedMs?: number; live: boolean } {
  if (!stats || stats.startedAt === undefined) return { live: false };
  if (stats.endedAt !== undefined) return { elapsedMs: stats.endedAt - stats.startedAt, live: false };
  return { elapsedMs: Math.max(0, nowMs - stats.startedAt), live: true };
}

/** A node's own pending questions, or — for a construct, which asks none itself — its subtree's total. */
function questionsOf(stats: NodeStats | undefined, children: readonly ProgressNode[]): number | undefined {
  const own = stats?.questions ?? 0;
  const total = own + sum(children, (child) => child.questions ?? 0);
  return total > 0 ? total : undefined;
}

/** Every leaf step under a node — an item row with a single-step body counts, since it IS that step. */
function leafSteps(node: ProgressNode): ProgressNode[] {
  if (node.kind === "step") return [node];
  if (node.children.length === 0) return node.kind === "foreach-item" ? [node] : [];
  return node.children.flatMap(leafSteps);
}

function loopCounter(outline: OutlineNode, fold: Fold): { iteration: number; max: number } | undefined {
  const iteration = fold.loopIterations.get(outline.path);
  // Unknown until the loop runs (progress §3.4): an unentered loop shows its shape and no counter.
  if (iteration === undefined || outline.maxIterations === undefined) return undefined;
  return { iteration, max: outline.maxIterations };
}

function sum<T>(items: readonly T[], of: (item: T) => number): number {
  let total = 0;
  for (const item of items) total += of(item);
  return total;
}
