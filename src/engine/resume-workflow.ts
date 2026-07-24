/**
 * Resume entry points for the deterministic engine (spec §8). Rebuild run state purely from the
 * recorded event log — no filesystem, no PI, no network.
 *
 * Two distinct resume paths (spec §8.4):
 *  - `resumeWorkflow` — for `crashed`/`cancelled` runs: node-atomic re-run (spec §8.2/§8.3). Skip
 *    completed top-level nodes and re-run the first incomplete node wholesale (a foreach among them
 *    still skips its own completed items, spec §8.2).
 *  - `resumeWithAnswer` — for a `blocked` run: the §8.4/§8.5 same-loop path. A block is legal anywhere
 *    in the node tree — inside a loop, foreach, branch arm, or nested workflow — so this navigates
 *    straight to that exact position (re-entry, spec §8.5) and continues the SAME agent loop with the
 *    answers appended, rather than restarting the enclosing node and re-asking.
 */
import { nodeName, type StepDefinition, type WorkflowDefinition, type WorkflowNode } from "../flow/types.ts";
import { describeSchemaViolations } from "../flow/validation.ts";
import { iso } from "./context.ts";
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
 */
export async function resumeWithAnswer(
  workflow: WorkflowDefinition,
  priorEvents: readonly RunEvent[],
  answers: Record<string, unknown>,
  host: HostPort,
  options: RunOptions = {},
): Promise<RunResult> {
  const started = requireRunStarted(priorEvents);
  const { runId, input: initialInput } = started;

  const pending = lastQuestionnaireAsked(priorEvents);
  if (!pending) {
    throw new Error("cannot answer: the run is not blocked (no pending questionnaire in the log)");
  }

  // The block must still be the run's latest word. A questionnaire in the log is not proof the run is
  // *currently* blocked: it may have been cancelled, or reached a terminal state, after asking — and a
  // caller holding a questionnaire captured before that (an open prompt, another session) would
  // otherwise resume a run the user already stopped, silently overwriting the cancellation.
  const settled = settledAfter(priorEvents, pending);
  if (settled) {
    throw new Error(`cannot answer run ${runId}: it was ${settled} after blocking; answering would undo that`);
  }

  const stepOutputs = rebuildStepOutputs(priorEvents);
  const drift = await checkDrift(workflow, priorEvents, stepOutputs, runId, host);
  if (drift) return drift;

  const foreachItemHistory = buildForeachItemHistory(priorEvents);
  await host.emit({ type: "answers-provided", runId, path: pending.path, answers, at: iso(host) });

  const reentry: Reentry = { path: parsePath(pending.path), answer: { answers, conversation: pending.conversation } };

  return execute(workflow, host, { runId, initialInput, stepOutputs, previousOutput: initialInput, startIndex: 0, foreachItemHistory, reentry }, options.signal);
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
    const last = segments[segments.length - 1];
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
  const states = deriveStepStates(priorEvents);
  for (const [staticKey, state] of states) {
    if (state !== "completed") continue;

    const step = resolveStepAtStaticPath(workflow.nodes, staticKey.split("/"));
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

/** Resolve the step definition at a STATIC path (e.g. `["until-valid", "design"]`) in the current tree, or undefined. */
function resolveStepAtStaticPath(nodes: readonly WorkflowNode[], segments: readonly string[]): StepDefinition | undefined {
  const [head, ...rest] = segments;
  if (head === undefined) return undefined;

  for (const node of nodes) {
    if (node.kind === "step") {
      if (node.step.name === head) return rest.length === 0 ? node.step : undefined;
      continue;
    }
    if (node.kind === "branch") {
      for (const arm of node.arms) {
        if (arm.name === head) return resolveStepAtStaticPath(arm.body.nodes, rest);
      }
      continue;
    }
    if ((node.kind === "loop" || node.kind === "foreach") && node.name === head) {
      return resolveStepAtStaticPath(node.body.nodes, rest);
    }
    if (node.kind === "workflow" && node.name === head) {
      return resolveStepAtStaticPath(node.workflow.nodes, rest);
    }
  }
  return undefined;
}

/**
 * Whether the run reached a terminal state *after* it blocked — i.e. the pending questionnaire is
 * stale. Returns the status that settled it, or `undefined` while the block still stands.
 */
function settledAfter(priorEvents: readonly RunEvent[], pending: QuestionnaireAskedEvent): "cancelled" | "completed" | "crashed" | undefined {
  const blockedAt = priorEvents.lastIndexOf(pending);
  for (const event of priorEvents.slice(blockedAt + 1)) {
    if (event.type === "run-cancelled") return "cancelled";
    if (event.type === "run-completed") return "completed";
    if (event.type === "run-crashed") return "crashed";
  }
  return undefined;
}

function lastQuestionnaireAsked(priorEvents: readonly RunEvent[]): QuestionnaireAskedEvent | undefined {
  let pending: QuestionnaireAskedEvent | undefined;
  for (const event of priorEvents) {
    if (event.type === "questionnaire-asked") pending = event;
  }
  return pending;
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
