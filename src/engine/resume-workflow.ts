/**
 * Resume entry points for the deterministic engine (spec §8). Rebuild run state purely from the
 * recorded event log — no filesystem, no PI, no network.
 *
 * Two distinct resume paths (spec §8.4):
 *  - `resumeWorkflow` — for `crashed`/`cancelled` runs: node-atomic re-run (spec §8.2/§8.3). Skip
 *    completed top-level nodes and re-run the first incomplete node wholesale (a foreach among them
 *    still skips its own completed items, spec §8.2).
 *  - `resumeWithAnswer` — for a `blocked` run: the §8.4/§8.5 same-loop path. A block is legal anywhere
 *    in the node tree — inside a loop, foreach, branch arm, parallel, or nested workflow — so this
 *    navigates straight to that exact position (re-entry, spec §8.5) and continues the SAME agent loop
 *    with the answers appended, rather than restarting the enclosing node and re-asking. Under
 *    concurrency several steps may be blocked at once (spec §8.6): an explicit `path` (or, by default,
 *    the FIFO-first currently-pending one) selects WHICH; every other pending block is left untouched
 *    and, if still pending afterward, reported back instead of the construct's final output.
 */
import { nodeName, type StepDefinition, type WorkflowDefinition, type WorkflowNode } from "../flow/types.ts";
import { describeSchemaViolations } from "../flow/validation.ts";
import { iso, type PendingBlock } from "./context.ts";
import { execute, type Reentry } from "./execute.ts";
import { formatPath, parsePath, staticKeyOf } from "./node-path.ts";
import { deriveStepStates } from "./step-state.ts";
import type { HostPort, RunEvent, RunOptions, RunResult } from "./types.ts";

type RunStartedEvent = Extract<RunEvent, { type: "run-started" }>;
type QuestionnaireAskedEvent = Extract<RunEvent, { type: "questionnaire-asked" }>;

export async function resumeWorkflow(workflow: WorkflowDefinition, priorEvents: readonly RunEvent[], host: HostPort, options: RunOptions = {}): Promise<RunResult> {
  const started = requireRunStarted(priorEvents);
  const { runId, input: initialInput } = started;

  const fullStepOutputs = rebuildStepOutputs(priorEvents);
  const drift = await checkDrift(workflow, priorEvents, fullStepOutputs, runId, host);
  if (drift) return drift;

  // Node-atomic checkpoint (spec §8.2/§8.3): skip completed top-level nodes; re-run the first
  // incomplete node onward. A top-level node's own completion is recorded under its bare name (no
  // path prefix at the root), so presence in `fullStepOutputs` (rebuilt from every step-/node-completed
  // event, static-keyed) is exactly "this node finished".
  const startIndex = firstIncompleteTopLevelIndex(workflow.nodes, fullStepOutputs);
  const startNode = workflow.nodes[startIndex];

  // The node at `startIndex` restarts WHOLESALE (spec §8.2/§8.3) — so anything previously recorded
  // INSIDE it (a partial loop iteration, a branch arm's steps, a nested workflow's progress) must NOT
  // leak into the fresh attempt: seed only the completed PREFIX's own subtree outputs. Without this, a
  // bare-name read inside the restarted node could see a stale value from the discarded attempt
  // instead of `undefined`, exactly as a genuinely fresh run would see it.
  const prefixNames = new Set(workflow.nodes.slice(0, startIndex).map((node) => nodeName(node)));
  const stepOutputs = new Map<string, unknown>();
  for (const [key, value] of fullStepOutputs) {
    if (prefixNames.has(key.split("/")[0] ?? key)) stepOutputs.set(key, value);
  }

  let previousOutput: unknown = initialInput;
  if (startIndex > 0) {
    const previous = workflow.nodes[startIndex - 1];
    if (previous) previousOutput = stepOutputs.get(nodeName(previous));
  }

  await host.emit({ type: "run-resumed", runId, fromPath: startNode ? nodeName(startNode) : undefined, at: iso(host) });

  // Foreach item history (spec §8.2) is deliberately NOT filtered to the prefix: a foreach's own
  // per-item checkpoints survive a wholesale restart of whatever encloses it — the one granularity
  // finer than "node-atomic" the spec carves out.
  const foreachItemHistory = buildForeachItemHistory(priorEvents);
  return execute(workflow, host, { runId, initialInput, stepOutputs, previousOutput, startIndex, foreachItemHistory }, options.signal);
}

/**
 * Resume a `blocked` run by delivering the user's structured `answers` (spec §8.4/§8.5). Re-enters
 * the blocked step's exact position — however deeply nested — and continues its SAME loop: an agent
 * step re-batches or emits `{result}`; a questionnaire step reassembles + validates the answers into
 * its output. On another `{questions}` the run re-blocks at that same position.
 *
 * `options.path` selects WHICH pending block to answer when several are open at once (spec §8.6);
 * omitted, it defaults to the FIFO-first (earliest-asked) currently-pending one. Every OTHER pending
 * block is left exactly as it was — not re-asked, not silently dropped — and if still pending once the
 * target settles, IT is what this call reports back (rather than the construct's assembled output).
 */
export async function resumeWithAnswer(
  workflow: WorkflowDefinition,
  priorEvents: readonly RunEvent[],
  answers: Record<string, unknown>,
  host: HostPort,
  options: RunOptions & { path?: string } = {},
): Promise<RunResult> {
  const started = requireRunStarted(priorEvents);
  const { runId, input: initialInput } = started;

  const allPending = pendingQuestionnaires(priorEvents);
  const pending = options.path === undefined ? (allPending[0] ?? lastQuestionnaireAsked(priorEvents)) : findAskedAt(priorEvents, options.path);
  if (!pending) {
    throw new Error(
      options.path === undefined
        ? "cannot answer: the run is not blocked (no pending questionnaire in the log)"
        : `cannot answer: "${options.path}" was never asked in this run's log`,
    );
  }

  // The block must still be the run's latest word for ITS OWN path. A questionnaire in the log is not
  // proof that step is *currently* blocked: it may have been cancelled (run-level, or — under
  // concurrency — a per-step drain, spec §9.5) or reached a terminal state after asking, and a caller
  // holding a questionnaire captured before that (an open prompt, another session) would otherwise
  // resume a run the user already stopped, silently overwriting the cancellation.
  const settled = settledAfter(priorEvents, pending);
  if (settled) {
    throw new Error(`cannot answer run ${runId}: it was ${settled} after blocking; answering would undo that`);
  }

  const stepOutputs = rebuildStepOutputs(priorEvents);
  const drift = await checkDrift(workflow, priorEvents, stepOutputs, runId, host);
  if (drift) return drift;

  const foreachItemHistory = buildForeachItemHistory(priorEvents);

  // Every OTHER step currently blocked (spec §8.6): a concurrent construct's re-entry leaves these
  // untouched rather than restarting or dropping them, and reports the next one if still pending once
  // the target settles. Keyed by static key, matching how execute.ts looks them up.
  const pendingBlocks = new Map<string, PendingBlock>();
  for (const entry of allPending) {
    if (entry.path === pending.path) continue;
    pendingBlocks.set(staticKeyOf(parsePath(entry.path)), { path: entry.path, questionnaire: entry.questionnaire, conversation: entry.conversation });
  }

  await host.emit({ type: "answers-provided", runId, path: pending.path, answers, at: iso(host) });

  // Budget carry (spec §9.4): the totals recorded on the block being answered, so the continuation's
  // wall-time/token budgets pick up where the interrupted attempt left off (execute.ts/step-runner.ts).
  const reentry: Reentry = {
    path: parsePath(pending.path),
    answer: { answers, conversation: pending.conversation, elapsedMs: pending.elapsedMs, tokensUsed: pending.tokensUsed },
  };

  return execute(workflow, host, { runId, initialInput, stepOutputs, previousOutput: initialInput, startIndex: 0, foreachItemHistory, reentry, pendingBlocks }, options.signal);
}

function requireRunStarted(priorEvents: readonly RunEvent[]): RunStartedEvent {
  const started = priorEvents.find((event): event is RunStartedEvent => event.type === "run-started");
  if (!started) {
    throw new Error("cannot resume: the prior event log has no run-started event");
  }
  return started;
}

/**
 * Rebuild `RunState.stepOutputs` (spec §5.4: static-keyed, latest execution wins) from every
 * recorded `step-completed`/`node-completed` event, at every depth — not just a top-level prefix.
 * This is what lets a resume (either path) reconstruct bare-name reads and linear hand-off anywhere
 * in the tree, and what makes a node/step's presence here exactly mean "recorded complete".
 */
function rebuildStepOutputs(priorEvents: readonly RunEvent[]): Map<string, unknown> {
  const outputs = new Map<string, unknown>();
  for (const event of priorEvents) {
    if (event.type === "step-completed" || event.type === "node-completed") {
      outputs.set(staticKeyOf(parsePath(event.path)), event.output);
    }
  }
  return outputs;
}

/**
 * Rebuild every foreach's recorded per-item outputs (spec §8.2), keyed by the foreach's own DYNAMIC
 * path (ancestor indices preserved, its own trailing index dropped — e.g. `until-valid#3/batch`).
 * Generalizes the old top-level-only foreach resume to any foreach in the tree, at any depth.
 */
function buildForeachItemHistory(priorEvents: readonly RunEvent[]): Map<string, Map<number, unknown>> {
  const history = new Map<string, Map<number, unknown>>();
  for (const event of priorEvents) {
    if (event.type !== "foreach-item-completed") continue;
    const segments = parsePath(event.path);
    const last = segments.at(-1);
    if (!last || last.index === undefined) continue; // defensive: an item's own path segment always carries an index
    const foreachKey = formatPath([...segments.slice(0, -1), { name: last.name }]);
    const perItem = history.get(foreachKey) ?? new Map<number, unknown>();
    perItem.set(event.index, event.output);
    history.set(foreachKey, perItem);
  }
  return history;
}

/**
 * Definition drift (spec §8.7): re-validate each currently-completed step's recorded output against
 * that step's CURRENT output schema, resolved in the just-reloaded `workflow` by its static path. A
 * step no longer reachable at that path, or whose recorded output no longer satisfies its schema,
 * refuses the resume naming the step and the violation. Cosmetic edits (renamed description, a
 * reordered branch, an appended step) never trip this — only a change that would feed stale data
 * downstream does.
 */
async function checkDrift(
  workflow: WorkflowDefinition,
  priorEvents: readonly RunEvent[],
  stepOutputs: ReadonlyMap<string, unknown>,
  runId: string,
  host: HostPort,
): Promise<RunResult | undefined> {
  // Driven by `step-completed` events, NOT by derived step states: the state map is keyed by node path
  // and legitimately holds entries for things that are not steps (a taken branch arm, spec §5.1), which
  // would resolve to no step here and be misreported as drift. A `step-completed` event, by contrast,
  // names a step by construction — and carries the very output this check re-validates.
  for (const staticKey of completedStepKeys(priorEvents)) {
    const step = resolveStepAtStaticPath(
      workflow.nodes,
      parsePath(staticKey).map((segment) => segment.name),
    );
    if (!step) {
      const error = `cannot resume run ${runId}: previously-completed step "${staticKey}" no longer exists in workflow "${workflow.name}" (definition drift, spec §8.7)`;
      await host.emit({ type: "run-crashed", runId, path: staticKey, error, at: iso(host) });
      return { runId, status: "crashed", error, path: staticKey };
    }

    if (step.outputSchema) {
      const violation = describeSchemaViolations(step.outputSchema, stepOutputs.get(staticKey));
      if (violation) {
        const error = `cannot resume run ${runId}: previously-completed step "${staticKey}" no longer satisfies its current output schema (definition drift, spec §8.7): ${violation}`;
        await host.emit({ type: "run-crashed", runId, path: staticKey, error, at: iso(host) });
        return { runId, status: "crashed", error, path: staticKey };
      }
    }
  }
  return undefined;
}

/**
 * Static keys of steps that completed and were not subsequently re-opened (a later iteration re-running
 * the same step, a retry, an answer continuation). Order follows first completion, so a drift refusal
 * names the earliest offending step rather than an arbitrary one.
 */
function completedStepKeys(priorEvents: readonly RunEvent[]): string[] {
  const completed = new Set<string>();
  const ordered: string[] = [];
  for (const event of priorEvents) {
    if (event.type === "step-completed") {
      const key = staticKeyOf(parsePath(event.path));
      if (!completed.has(key)) ordered.push(key);
      completed.add(key);
    } else if (event.type === "step-started" || event.type === "questionnaire-asked") {
      completed.delete(staticKeyOf(parsePath(event.path)));
    }
  }
  return ordered.filter((key) => completed.has(key));
}

/** Resolve the step definition at a STATIC path (bare names only — indices already stripped by the caller) in the current tree, or undefined. */
function resolveStepAtStaticPath(nodes: readonly WorkflowNode[], segments: readonly string[]): StepDefinition | undefined {
  const [head, ...rest] = segments;
  if (head === undefined) return undefined;

  for (const node of nodes) {
    const resolved = resolveAtNode(node, head, rest);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

/** One node's contribution to {@link resolveStepAtStaticPath}: `undefined` means "not this node, keep looking". */
function resolveAtNode(node: WorkflowNode, head: string, rest: readonly string[]): StepDefinition | undefined {
  switch (node.kind) {
    case "step":
      return node.step.name === head && rest.length === 0 ? node.step : undefined;
    case "branch":
      for (const arm of node.arms) {
        if (arm.name === head) return resolveStepAtStaticPath(arm.body.nodes, rest);
      }
      return undefined;
    case "loop":
    case "foreach":
      return node.name === head ? resolveStepAtStaticPath(node.body.nodes, rest) : undefined;
    case "parallel":
      if (node.name !== head || rest.length !== 1) return undefined;
      return node.arms.find((arm) => arm.name === rest[0]);
    case "workflow":
      return node.name === head ? resolveStepAtStaticPath(node.workflow.nodes, rest) : undefined;
  }
}

/**
 * Whether the run reached a terminal state, OR this specific step was abandoned by a drain (spec
 * §9.5's `step-cancelled`), *after* it blocked — i.e. the pending questionnaire is stale. Returns the
 * status that settled it, or `undefined` while the block still stands.
 */
function settledAfter(priorEvents: readonly RunEvent[], pending: QuestionnaireAskedEvent): "cancelled" | "completed" | "crashed" | undefined {
  const blockedAt = priorEvents.lastIndexOf(pending);
  for (const event of priorEvents.slice(blockedAt + 1)) {
    if (event.type === "run-cancelled") return "cancelled";
    if (event.type === "run-completed") return "completed";
    if (event.type === "run-crashed") return "crashed";
    if (event.type === "step-cancelled" && event.path === pending.path) return "cancelled";
  }
  return undefined;
}

/** The single latest `questionnaire-asked` event in the WHOLE log, regardless of path or current state. */
function lastQuestionnaireAsked(priorEvents: readonly RunEvent[]): QuestionnaireAskedEvent | undefined {
  let pending: QuestionnaireAskedEvent | undefined;
  for (const event of priorEvents) {
    if (event.type === "questionnaire-asked") pending = event;
  }
  return pending;
}

/** The latest `questionnaire-asked` event recorded at exactly `path`, regardless of current state (settledAfter diagnoses staleness). */
function findAskedAt(priorEvents: readonly RunEvent[], path: string): QuestionnaireAskedEvent | undefined {
  let found: QuestionnaireAskedEvent | undefined;
  for (const event of priorEvents) {
    if (event.type === "questionnaire-asked" && event.path === path) found = event;
  }
  return found;
}

/**
 * Every step CURRENTLY blocked (spec §8.6), each resolved to its own latest `questionnaire-asked`
 * event, in FIFO order (earliest-asked first — the order these events appear in the log; not
 * completion order, spec §4.2). Empty when nothing is pending. This is what makes "several steps
 * blocked at once" answerable one at a time: the default target when `resumeWithAnswer` is called
 * with no explicit `path`, and the source of `pendingBlocks` (every OTHER pending one, left untouched).
 *
 * Exported so a host's attended loop (spec §10.2) can show the SAME question it will actually deliver
 * an answer to — `pendingQuestionnaire`-singular (the last EVER asked, regardless of current state) is
 * wrong once more than one step can be blocked at once, since it can disagree with which one
 * `resumeWithAnswer`'s own default (`path` omitted) targets.
 */
export function pendingQuestionnaires(priorEvents: readonly RunEvent[]): QuestionnaireAskedEvent[] {
  const states = deriveStepStates(priorEvents);
  const latestByKey = new Map<string, { event: QuestionnaireAskedEvent; index: number }>();
  priorEvents.forEach((event, index) => {
    if (event.type === "questionnaire-asked") {
      latestByKey.set(staticKeyOf(parsePath(event.path)), { event, index });
    }
  });

  const pending: { event: QuestionnaireAskedEvent; index: number }[] = [];
  for (const [key, state] of states) {
    if (state !== "blocked") continue;
    const entry = latestByKey.get(key);
    if (entry) pending.push(entry);
  }
  pending.sort((a, b) => a.index - b.index);
  return pending.map((entry) => entry.event);
}

/** Index of the first top-level node with no recorded completion (its own bare name absent from `stepOutputs`). */
function firstIncompleteTopLevelIndex(nodes: readonly WorkflowNode[], stepOutputs: ReadonlyMap<string, unknown>): number {
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (node && !stepOutputs.has(nodeName(node))) {
      return index;
    }
  }
  return nodes.length;
}
