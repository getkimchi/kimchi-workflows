/**
 * Resume entry points for the deterministic engine (spec §8). Rebuild run state purely from the
 * recorded event log — no filesystem, no PI, no network.
 *
 * Two distinct resume paths:
 *  - `resumeWorkflow` — for `crashed`/`cancelled` runs: node-atomic re-run (spec §8.2/§8.3). Skip
 *    completed top-level nodes and re-run the first incomplete node wholesale (with per-item resume
 *    for a top-level foreach, spec §3.4).
 *  - `resumeWithAnswer` — for a `parked` run: the §8.4 same-loop path. Reconstruct the parked Q&A
 *    step's session from the recorded conversation and replay the answer — continuing the SAME agent
 *    loop, NOT re-running the step from scratch.
 */
import type { WorkflowDefinition, WorkflowNode } from "../flow/types.ts";
import { collectNodeNames, nodeName } from "../flow/types.ts";
import { iso } from "./context.ts";
import { execute, type ForeachResume } from "./execute.ts";
import type { HostPort, RunEvent, RunOptions, RunResult } from "./types.ts";

type RunStartedEvent = Extract<RunEvent, { type: "run-started" }>;
type QuestionnaireAskedEvent = Extract<RunEvent, { type: "questionnaire-asked" }>;

export async function resumeWorkflow(workflow: WorkflowDefinition, priorEvents: readonly RunEvent[], host: HostPort, options: RunOptions = {}): Promise<RunResult> {
  const started = requireRunStarted(priorEvents);
  const { runId, input: initialInput } = started;

  const completedByName = recoverCompleted(priorEvents);
  const drift = await checkDrift(workflow, completedByName, runId, host);
  if (drift) return drift;

  // Node-atomic checkpoint: skip completed top-level nodes; re-run the first incomplete node onward.
  const startIndex = firstIncompleteIndex(workflow.nodes, completedByName);
  const { stepOutputs, previousOutput } = seedPrefix(workflow, completedByName, startIndex, initialInput);

  const startNode = workflow.nodes[startIndex];
  await host.emit({ type: "run-resumed", runId, fromStepName: startNode ? nodeName(startNode) : undefined, at: iso(host) });

  // Per-item resume (spec §3.4): a top-level foreach resumes at the first unprocessed item.
  const foreachResume = startNode?.kind === "foreach" ? buildForeachResume(startNode.name, priorEvents) : undefined;

  return execute(workflow, host, { runId, initialInput, stepOutputs, previousOutput, startIndex, foreachResume }, options.signal);
}

/**
 * Resume a `parked` run by delivering the user's structured `answers` (spec §8.4). Continues the
 * parked step's SAME loop: an agent step re-batches or emits `{result}`; a form input step
 * reassembles + validates the answers into its output. On another `{questionnaire}` the run re-parks.
 * Supported for a **top-level** parked step.
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
    throw new Error("cannot answer: the run is not parked (no pending questionnaire in the log)");
  }

  // The park must still be the run's latest word. A questionnaire in the log is not proof the run is
  // *currently* parked: it may have been cancelled, or reached a terminal state, after asking — and a
  // caller holding a questionnaire captured before that (an open prompt, another session) would
  // otherwise resume a run the user already stopped, silently overwriting the cancellation.
  const settled = settledAfter(priorEvents, pending);
  if (settled) {
    throw new Error(`cannot answer run ${runId}: it was ${settled} after parking; answering would undo that`);
  }

  const parkedIndex = topLevelStepIndex(workflow, pending.stepName);
  if (parkedIndex === -1) {
    const error = `cannot answer run ${runId}: parked step "${pending.stepName}" is not a top-level step (nested Q&A resume is out of scope)`;
    await host.emit({ type: "run-crashed", runId, stepName: pending.stepName, error, at: iso(host) });
    return { runId, status: "crashed", error, stepName: pending.stepName };
  }

  const completedByName = recoverCompleted(priorEvents);
  const drift = await checkDrift(workflow, completedByName, runId, host);
  if (drift) return drift;

  // Seed the prefix before the parked step; the parked step continues via the answer hint (not re-run).
  const { stepOutputs, previousOutput } = seedPrefix(workflow, completedByName, parkedIndex, initialInput);

  await host.emit({ type: "answers-provided", runId, stepName: pending.stepName, answers, at: iso(host) });

  return execute(
    workflow,
    host,
    {
      runId,
      initialInput,
      stepOutputs,
      previousOutput,
      startIndex: parkedIndex,
      answerResume: { stepName: pending.stepName, answers, conversation: pending.conversation },
    },
    options.signal,
  );
}

function requireRunStarted(priorEvents: readonly RunEvent[]): RunStartedEvent {
  const started = priorEvents.find((event): event is RunStartedEvent => event.type === "run-started");
  if (!started) {
    throw new Error("cannot resume: the prior event log has no run-started event");
  }
  return started;
}

/** Recover every completed step/node output (spec §8.2: a checkpoint is a completed step or node). */
function recoverCompleted(priorEvents: readonly RunEvent[]): Map<string, unknown> {
  const completedByName = new Map<string, unknown>();
  for (const event of priorEvents) {
    if (event.type === "step-completed") completedByName.set(event.stepName, event.output);
    else if (event.type === "node-completed") completedByName.set(event.nodeName, event.output);
  }
  return completedByName;
}

/** Drift check (spec §8.5): a recorded completion must still exist by name somewhere in the tree. */
async function checkDrift(workflow: WorkflowDefinition, completedByName: ReadonlyMap<string, unknown>, runId: string, host: HostPort): Promise<RunResult | undefined> {
  const currentNames = collectNodeNames(workflow.nodes);
  for (const name of completedByName.keys()) {
    if (!currentNames.has(name)) {
      const error = `cannot resume run ${runId}: previously-completed "${name}" no longer exists in workflow "${workflow.name}" (definition drift, spec §8.5)`;
      await host.emit({ type: "run-crashed", runId, error, at: iso(host) });
      return { runId, status: "crashed", error };
    }
  }
  return undefined;
}

/**
 * Seed the run context ONLY from the completed prefix nodes `[0, startIndex)` and their descendants —
 * exactly the state a fresh run would hold when the node at `startIndex` is about to start (fresh ≡
 * resume). `previousOutput` is the last completed top-level node's output (or the initial input).
 */
function seedPrefix(
  workflow: WorkflowDefinition,
  completedByName: ReadonlyMap<string, unknown>,
  startIndex: number,
  initialInput: unknown,
): { stepOutputs: Map<string, unknown>; previousOutput: unknown } {
  const priorNames = collectNodeNames(workflow.nodes.slice(0, startIndex));
  const stepOutputs = new Map<string, unknown>();
  for (const name of priorNames) {
    if (completedByName.has(name)) stepOutputs.set(name, completedByName.get(name));
  }

  let previousOutput: unknown = initialInput;
  if (startIndex > 0) {
    const previous = workflow.nodes[startIndex - 1];
    if (previous) previousOutput = completedByName.get(nodeName(previous));
  }
  return { stepOutputs, previousOutput };
}

/**
 * Whether the run reached a terminal state *after* it parked — i.e. the pending questionnaire is
 * stale. Returns the status that settled it, or `undefined` while the park still stands.
 */
function settledAfter(priorEvents: readonly RunEvent[], pending: QuestionnaireAskedEvent): "cancelled" | "completed" | "crashed" | undefined {
  const parkedAt = priorEvents.lastIndexOf(pending);
  for (const event of priorEvents.slice(parkedAt + 1)) {
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

/** Index of the top-level step node with `name`, or -1 (nested / not a step). */
function topLevelStepIndex(workflow: WorkflowDefinition, name: string): number {
  return workflow.nodes.findIndex((node) => node.kind === "step" && node.step.name === name);
}

function buildForeachResume(targetNodeName: string, priorEvents: readonly RunEvent[]): ForeachResume | undefined {
  const items = new Map<number, unknown>();
  for (const event of priorEvents) {
    if (event.type === "foreach-item-completed" && event.nodeName === targetNodeName) {
      items.set(event.index, event.output);
    }
  }
  return items.size > 0 ? { nodeName: targetNodeName, items } : undefined;
}

function firstIncompleteIndex(nodes: readonly WorkflowNode[], completedByName: ReadonlyMap<string, unknown>): number {
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (node && !completedByName.has(nodeName(node))) {
      return index;
    }
  }
  return nodes.length;
}
