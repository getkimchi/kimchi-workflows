/**
 * Node walker for the deterministic engine (spec §4). A workflow is an ordered sequence of nodes
 * (step / branch / loop / foreach); this walks them with linear hand-off at the node level. Branch
 * arms and loop/foreach bodies are sub-workflows executed by the *same* walker recursively (§3.2–4).
 *
 * Used by both a fresh run (`run-workflow.ts`) and a resume (`resume-workflow.ts`) via `execute`.
 * Zero imports from PI, `node:fs`, or any network lib — see src/engine/types.ts.
 */
import { answersToOutput, questionnaireFromSchema, validateAnswers } from "../flow/questionnaire.ts";
import type { BranchNode, ForeachNode, InputStep, LoopNode, NestedWorkflowNode, StepDefinition, WorkflowDefinition, WorkflowNode } from "../flow/types.ts";
import { nodeName } from "../flow/types.ts";
import { describeSchemaViolations } from "../flow/validation.ts";
import { createRunContext, type ExecOutcome, iso, type RunState, type StepOutcome } from "./context.ts";
import { runAgentStep, runFunctionStep } from "./step-runner.ts";
import type { HostPort, RunResult } from "./types.ts";

/**
 * Per-item resume hint for a top-level foreach (spec §3.4/§8): the already-completed item outputs by
 * index. `runForeachNode` reuses these (skipping their bodies) and runs only the unprocessed items.
 */
export interface ForeachResume {
  readonly nodeName: string;
  readonly items: ReadonlyMap<number, unknown>;
}

/**
 * Answer-resume hint for a parked top-level Q&A step (spec §8.4): reconstruct the step's session from
 * `conversation` and replay `answer` — continuing the SAME agent loop rather than re-running the step.
 */
export interface AnswerResume {
  readonly stepName: string;
  readonly answers: Record<string, unknown>;
  readonly conversation: readonly unknown[];
}

/**
 * Where execution begins plus the state recovered before it. A fresh run starts at node 0 with
 * empty `stepOutputs` and `previousOutput === initialInput`; a resume seeds these from the log
 * (see `resume-workflow.ts`). `startIndex` is a *top-level node* index.
 */
export interface ExecutionCursor {
  readonly runId: string;
  readonly initialInput: unknown;
  readonly stepOutputs: Map<string, unknown>;
  readonly previousOutput: unknown;
  readonly startIndex: number;
  /** Per-item resume for the top-level foreach at `startIndex`, if that node is an interrupted foreach. */
  readonly foreachResume?: ForeachResume;
  /** Answer-resume for the top-level Q&A step at `startIndex`, if that step is parked (spec §8.4). */
  readonly answerResume?: AnswerResume;
}

/**
 * Top-level driver: walk `workflow.nodes` from `cursor.startIndex`, then emit the terminal event.
 * The caller has already emitted the opening event (`run-started` / `run-resumed`).
 */
export async function execute(workflow: WorkflowDefinition, host: HostPort, cursor: ExecutionCursor, signal?: AbortSignal): Promise<RunResult> {
  const stepSignal = signal ?? new AbortController().signal; // stable, never-aborting sentinel
  const state: RunState = {
    runId: cursor.runId,
    workflowName: workflow.name,
    initialInput: cursor.initialInput,
    stepOutputs: cursor.stepOutputs,
    defaultModel: workflow.defaultModel,
  };

  const outcome = await runNodeSequence(workflow.nodes, host, state, cursor.previousOutput, cursor.startIndex, stepSignal, cursor.foreachResume, cursor.answerResume);

  if (outcome.kind === "ok") {
    await host.emit({ type: "run-completed", runId: state.runId, output: outcome.output, at: iso(host) });
    return { runId: state.runId, status: "completed", output: outcome.output };
  }
  if (outcome.kind === "crashed") {
    await host.emit({ type: "run-crashed", runId: state.runId, stepName: outcome.stepName, error: outcome.error, at: iso(host) });
    return { runId: state.runId, status: "crashed", error: outcome.error };
  }
  if (outcome.kind === "parked") {
    await host.emit({ type: "questionnaire-asked", runId: state.runId, stepName: outcome.stepName, questionnaire: outcome.questionnaire, conversation: outcome.conversation, at: iso(host) });
    return { runId: state.runId, status: "parked", stepName: outcome.stepName, questionnaire: outcome.questionnaire };
  }
  await host.emit({ type: "run-cancelled", runId: state.runId, stepName: outcome.stepName, at: iso(host) });
  return { runId: state.runId, status: "cancelled" };
}

/**
 * Walk a node sequence with linear hand-off (spec §3.6): each node's output feeds the next. Used at
 * the top level (with `startIndex` from resume) and recursively for branch arms / loop bodies
 * (always `startIndex` 0). A node's output is recorded under its name for `ctx.getStepResult`.
 */
async function runNodeSequence(
  nodes: readonly WorkflowNode[],
  host: HostPort,
  state: RunState,
  previousOutput: unknown,
  startIndex: number,
  signal: AbortSignal,
  foreachResume?: ForeachResume,
  answerResume?: AnswerResume,
): Promise<ExecOutcome> {
  let output = previousOutput;

  for (let i = startIndex; i < nodes.length; i++) {
    const node = nodes[i];
    if (!node) continue; // unreachable; satisfies noUncheckedIndexedAccess

    // Cooperative cancel at the node boundary (spec §8.6): stop before starting the next node.
    if (signal.aborted) return { kind: "cancelled" };

    // A resume hint applies only to the (single, top-level) node it names; global name uniqueness
    // means at most this node consumes it. Bodies recurse without hints.
    const foreachHint = foreachResume && nodeName(node) === foreachResume.nodeName ? foreachResume : undefined;
    const answerHint = answerResume && node.kind === "step" && node.step.name === answerResume.stepName ? answerResume : undefined;
    const outcome = await runNode(node, i, output, host, state, signal, foreachHint, answerHint);
    if (outcome.kind !== "ok") return outcome;

    output = outcome.output;
    state.stepOutputs.set(nodeName(node), output);
  }

  return { kind: "ok", output };
}

function runNode(node: WorkflowNode, index: number, input: unknown, host: HostPort, state: RunState, signal: AbortSignal, foreachResume?: ForeachResume, answerResume?: AnswerResume): Promise<ExecOutcome> {
  switch (node.kind) {
    case "step":
      return runStepNode(node.step, index, input, host, state, signal, answerResume);
    case "branch":
      return runBranchNode(node, input, host, state, signal);
    case "loop":
      return runLoopNode(node, input, host, state, signal);
    case "foreach":
      return runForeachNode(node, input, host, state, signal, foreachResume);
    case "workflow":
      return runNestedWorkflowNode(node, input, host, state, signal);
  }
}

async function runStepNode(step: StepDefinition, index: number, input: unknown, host: HostPort, state: RunState, signal: AbortSignal, answerResume?: AnswerResume): Promise<ExecOutcome> {
  // Answer continuation (spec §8.4): resume a parked step with the user's structured answers — no
  // input re-validation and no new `step-started`. Branch on step kind:
  //  - agent → continue the SAME agent loop (the prompt builder is NOT re-invoked);
  //  - input (form) → reassemble the answers into `output` and validate (no `startAgent`).
  if (answerResume?.stepName === step.name) {
    if (step.kind === "agent") {
      const outcome = await runAgentStep(step, undefined, host, state, signal, { kind: "answer", answers: answerResume.answers, conversation: answerResume.conversation });
      return finishStep(step, index, host, state, outcome);
    }
    if (step.kind === "input") {
      return finishStep(step, index, host, state, answerInputStep(step, answerResume.answers));
    }
  }

  // Input step, form mode (spec §2.4): does no other work — park immediately with its questionnaire batch.
  if (step.kind === "input") {
    await host.emit({ type: "step-started", runId: state.runId, stepIndex: index, stepName: step.name, input: undefined, at: iso(host) });
    return { kind: "parked", stepName: step.name, questionnaire: inputQuestionnaire(step), conversation: [] };
  }

  // Linear hand-off (spec §3.6): a step with an input schema receives the previous node's output;
  // a step with no input schema ignores it and receives `undefined`.
  const stepInput = step.inputSchema ? input : undefined;

  // Input-schema violation is a deterministic wiring failure — crash immediately, never retry.
  if (step.inputSchema) {
    const violation = describeSchemaViolations(step.inputSchema, stepInput);
    if (violation) {
      return { kind: "crashed", error: `step "${step.name}" input: ${violation}`, stepName: step.name };
    }
  }

  await host.emit({ type: "step-started", runId: state.runId, stepIndex: index, stepName: step.name, input: stepInput, at: iso(host) });

  const outcome = step.kind === "agent" ? await runAgentStep(step, stepInput, host, state, signal, { kind: "fresh" }) : await runFunctionStep(step, stepInput, host, state, signal);
  return finishStep(step, index, host, state, outcome);
}

/** The questionnaire an input (form) step parks with: the explicit override, or one derived from its target. */
function inputQuestionnaire(step: InputStep) {
  return step.questionnaire ?? questionnaireFromSchema(step.outputSchema);
}

/**
 * Apply answers to a parked input (form) step (spec §2.4): reassemble the flat answers into the
 * target shape and validate. Valid → that becomes the step output. Invalid → re-park with the batch.
 */
function answerInputStep(step: InputStep, answers: Record<string, unknown>): StepOutcome {
  const output = answersToOutput(step.outputSchema, answers);
  const check = validateAnswers(step.outputSchema, output);
  return check.ok ? { kind: "ok", output } : { kind: "parked", questionnaire: inputQuestionnaire(step), conversation: [] };
}

/** Turn a step's `StepOutcome` into an `ExecOutcome`: emit `step-completed` on success; attach identity otherwise. */
async function finishStep(step: StepDefinition, index: number, host: HostPort, state: RunState, outcome: StepOutcome): Promise<ExecOutcome> {
  switch (outcome.kind) {
    case "ok":
      await host.emit({ type: "step-completed", runId: state.runId, stepIndex: index, stepName: step.name, output: outcome.output, at: iso(host) });
      return { kind: "ok", output: outcome.output };
    case "parked":
      return { kind: "parked", stepName: step.name, questionnaire: outcome.questionnaire, conversation: outcome.conversation };
    case "crashed":
      return { kind: "crashed", error: outcome.error, stepName: step.name };
    case "cancelled":
      return { kind: "cancelled", stepName: step.name };
  }
}

/** Multi-match branch (spec §3.2): evaluate all conditions up front, run every true arm sequentially. */
async function runBranchNode(node: BranchNode, input: unknown, host: HostPort, state: RunState, signal: AbortSignal): Promise<ExecOutcome> {
  await host.emit({ type: "node-started", runId: state.runId, nodeName: node.name, nodeKind: "branch", at: iso(host) });

  const ctx = createRunContext(state);
  const decisions = node.arms.map((arm) => ({ arm, taken: arm.condition(ctx) })); // pure, side-effect-free (spec §3.2)
  for (const { arm, taken } of decisions) {
    await host.emit({ type: "branch-arm", runId: state.runId, nodeName: node.name, armName: arm.name, taken, at: iso(host) });
  }

  const result: Record<string, unknown> = {};
  for (const { arm, taken } of decisions) {
    if (!taken) continue;
    if (signal.aborted) return { kind: "cancelled" };
    const outcome = await runNodeSequence(arm.body.nodes, host, state, input, 0, signal);
    if (outcome.kind !== "ok") return outcome;
    result[arm.name] = outcome.output;
  }

  await host.emit({ type: "node-completed", runId: state.runId, nodeName: node.name, output: result, at: iso(host) });
  return { kind: "ok", output: result };
}

/** Loop (spec §3.3): run the body, evaluate the pure condition, repeat; guard against infinite loops. */
async function runLoopNode(node: LoopNode, input: unknown, host: HostPort, state: RunState, signal: AbortSignal): Promise<ExecOutcome> {
  await host.emit({ type: "node-started", runId: state.runId, nodeName: node.name, nodeKind: "loop", at: iso(host) });

  const ctx = createRunContext(state); // live view of stepOutputs; reflects each iteration's updates
  let iterationInput = input;
  let lastOutput: unknown;

  for (let iteration = 1; iteration <= node.maxIterations; iteration++) {
    if (signal.aborted) return { kind: "cancelled" };
    await host.emit({ type: "loop-iteration", runId: state.runId, nodeName: node.name, iteration, at: iso(host) });

    const outcome = await runNodeSequence(node.body.nodes, host, state, iterationInput, 0, signal);
    if (outcome.kind !== "ok") return outcome;
    lastOutput = outcome.output;

    const conditionMet = node.condition(ctx, lastOutput);
    const stop = node.mode === "dowhile" ? !conditionMet : conditionMet;
    if (stop) {
      await host.emit({ type: "node-completed", runId: state.runId, nodeName: node.name, output: lastOutput, at: iso(host) });
      return { kind: "ok", output: lastOutput };
    }
    iterationInput = lastOutput;
  }

  return { kind: "crashed", error: `loop "${node.name}" exceeded its max of ${node.maxIterations} iterations without its condition being met` };
}

/**
 * Foreach (spec §3.4): run the body once per selected item, sequentially, with the item as input.
 * Output is the per-item outputs in order. Per-item checkpoint (spec §8): with a `resumeHint`, items
 * already recorded are reused (their bodies are NOT re-run); the rest run from the first unprocessed
 * item. An item interrupted mid-body (no recorded output) re-runs wholesale.
 */
async function runForeachNode(
  node: ForeachNode,
  input: unknown,
  host: HostPort,
  state: RunState,
  signal: AbortSignal,
  resumeHint?: ForeachResume,
): Promise<ExecOutcome> {
  void input; // a foreach derives its work from the pure selector, not the linear hand-off value
  const ctx = createRunContext(state);
  const items = node.selector(ctx); // pure, deterministic — a resume re-runs it to the same array (spec §3.4)

  await host.emit({ type: "foreach-started", runId: state.runId, nodeName: node.name, count: items.length, at: iso(host) });

  const results: unknown[] = new Array(items.length);
  for (let index = 0; index < items.length; index++) {
    const recorded = resumeHint?.items;
    if (recorded?.has(index)) {
      results[index] = recorded.get(index); // completed item — reuse its output, do not re-run
      continue;
    }

    if (signal.aborted) return { kind: "cancelled" };
    await host.emit({ type: "foreach-item-started", runId: state.runId, nodeName: node.name, index, at: iso(host) });

    const outcome = await runNodeSequence(node.body.nodes, host, state, items[index], 0, signal);
    if (outcome.kind !== "ok") return outcome;

    results[index] = outcome.output;
    await host.emit({ type: "foreach-item-completed", runId: state.runId, nodeName: node.name, index, output: outcome.output, at: iso(host) });
  }

  await host.emit({ type: "node-completed", runId: state.runId, nodeName: node.name, output: results, at: iso(host) });
  return { kind: "ok", output: results };
}

/**
 * Nested workflow (spec §2.3/§11): run the sub-workflow's nodes under the SAME parent run state and
 * signal — transparently folding into the parent event log (one run). Input hand-off feeds the
 * sub-workflow's first node; output is its final output. Node-atomic resume: an interrupted nested
 * workflow (no `node-completed`) re-runs wholesale like any control-flow node.
 */
async function runNestedWorkflowNode(node: NestedWorkflowNode, input: unknown, host: HostPort, state: RunState, signal: AbortSignal): Promise<ExecOutcome> {
  await host.emit({ type: "node-started", runId: state.runId, nodeName: node.name, nodeKind: "workflow", at: iso(host) });

  const outcome = await runNodeSequence(node.workflow.nodes, host, state, input, 0, signal);
  if (outcome.kind !== "ok") return outcome;

  await host.emit({ type: "node-completed", runId: state.runId, nodeName: node.name, output: outcome.output, at: iso(host) });
  return { kind: "ok", output: outcome.output };
}
