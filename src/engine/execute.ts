/**
 * Node walker for the deterministic engine (spec §4). A workflow is an ordered sequence of nodes
 * (step / branch / loop / foreach / nested workflow); this walks them with linear hand-off at the
 * node level. Branch arms and loop/foreach bodies are sub-workflows executed by the *same* walker
 * recursively (§3.2–4), each contributing one path segment to its children's addressing (spec §8.5).
 *
 * Used by both a fresh run (`run-workflow.ts`) and a resume (`resume-workflow.ts`) via `execute`.
 * Zero imports from PI, `node:fs`, or any network lib — see src/engine/types.ts.
 */
import { answersToOutput, questionnaireFromSchema, validateAnswers } from "../flow/questionnaire.ts";
import type { BranchNode, ForeachNode, LoopNode, NestedWorkflowNode, QuestionnaireStep, StepDefinition, WorkflowDefinition, WorkflowNode } from "../flow/types.ts";
import { nodeName } from "../flow/types.ts";
import { describeSchemaViolations } from "../flow/validation.ts";
import { createRunContext, type ExecOutcome, iso, type RunState, type StepOutcome } from "./context.ts";
import { appendSegment, formatPath, type NodePath, staticChildKey } from "./node-path.ts";
import { runAgentStep, runFunctionStep } from "./step-runner.ts";
import type { HostPort, RunResult } from "./types.ts";

/**
 * Answer-resume hint for a blocked Q&A step (spec §8.4/§8.5): reconstruct the step's session from
 * `conversation` and replay `answer` — continuing the SAME agent loop rather than re-running the step.
 */
export interface AnswerResume {
  readonly answers: Record<string, unknown>;
  readonly conversation: readonly unknown[];
}

/**
 * Deep re-entry (spec §8.5, the heart of P2): `path` is the REMAINING node-path segments from "here"
 * down to the blocked step, each construct popping its own leading segment before recursing into its
 * body/arm/iteration. When `path` is fully consumed (length 0) the current node IS the target: a step
 * applies `answer` (continuing its conversation) if present, or — for `resumeWorkflow`'s node-atomic
 * restart (spec §8.2/§8.3), which never carries an `answer` — simply runs fresh. A construct node
 * (branch/loop/foreach/workflow) with an EXHAUSTED path always restarts fresh (only a step can be the
 * final blocked target); one still descending (`path.length > 0`) skips re-emitting its own "started"
 * event, since it was already recorded before the run blocked.
 */
export interface Reentry {
  readonly path: NodePath;
  readonly answer?: AnswerResume;
}

/**
 * Where execution begins plus the state recovered before it. A fresh run starts at the top with empty
 * `stepOutputs` and `previousOutput === initialInput`; a resume seeds these from the log (see
 * `resume-workflow.ts`). `startIndex` is a *top-level node* index (spec §8.2/§8.3's node-atomic
 * restart); `reentry`, when present, takes priority and navigates to an exact blocked position
 * (spec §8.4/§8.5) instead.
 */
export interface ExecutionCursor {
  readonly runId: string;
  readonly initialInput: unknown;
  readonly stepOutputs: Map<string, unknown>;
  readonly previousOutput: unknown;
  readonly startIndex: number;
  readonly foreachItemHistory?: ReadonlyMap<string, ReadonlyMap<number, unknown>>;
  readonly reentry?: Reentry;
}

/**
 * Top-level driver: walk `workflow.nodes` from `cursor.startIndex` (or `cursor.reentry`), then emit
 * the terminal event. The caller has already emitted the opening event (`run-started` / `run-resumed`).
 */
export async function execute(workflow: WorkflowDefinition, host: HostPort, cursor: ExecutionCursor, signal?: AbortSignal): Promise<RunResult> {
  const stepSignal = signal ?? new AbortController().signal; // stable, never-aborting sentinel
  const state: RunState = {
    runId: cursor.runId,
    workflowName: workflow.name,
    initialInput: cursor.initialInput,
    stepOutputs: cursor.stepOutputs,
    defaultModel: workflow.defaultModel,
    foreachItemHistory: cursor.foreachItemHistory,
  };

  const outcome = await runNodeSequence(workflow.nodes, host, state, cursor.previousOutput, stepSignal, [], cursor.startIndex, cursor.reentry);

  if (outcome.kind === "ok") {
    await host.emit({ type: "run-completed", runId: state.runId, output: outcome.output, at: iso(host) });
    return { runId: state.runId, status: "completed", output: outcome.output };
  }
  if (outcome.kind === "crashed") {
    await host.emit({ type: "run-crashed", runId: state.runId, path: outcome.path, error: outcome.error, at: iso(host) });
    return { runId: state.runId, status: "crashed", error: outcome.error };
  }
  if (outcome.kind === "blocked") {
    await host.emit({
      type: "questionnaire-asked",
      runId: state.runId,
      path: outcome.path,
      questionnaire: outcome.questionnaire,
      conversation: outcome.conversation,
      violation: outcome.violation,
      at: iso(host),
    });
    return { runId: state.runId, status: "blocked", path: outcome.path, questionnaire: outcome.questionnaire, violation: outcome.violation };
  }
  await host.emit({ type: "run-cancelled", runId: state.runId, path: outcome.path, at: iso(host) });
  return { runId: state.runId, status: "cancelled" };
}

/**
 * Walk a node sequence with linear hand-off (spec §3.6): each node's output feeds the next. Used at
 * the top level (with `startIndex`/`reentry` from resume) and recursively for branch arms /
 * loop-iteration / foreach-item / nested-workflow bodies (always `startIndex` 0, `reentry` popped one
 * segment per level by the caller). A node's output is recorded under its own STATIC path (spec §5.4)
 * for `ctx.getStepResult`.
 */
async function runNodeSequence(
  nodes: readonly WorkflowNode[],
  host: HostPort,
  state: RunState,
  previousOutput: unknown,
  signal: AbortSignal,
  parentPath: NodePath,
  startIndex = 0,
  reentry?: Reentry,
): Promise<ExecOutcome> {
  let output = previousOutput;
  let effectiveStart = startIndex;
  let activeReentry = reentry;

  if (activeReentry) {
    const targetName = leafNameOf(activeReentry);
    const idx = nodes.findIndex((node) => matchesReentryTarget(node, targetName));
    if (idx === -1) {
      // The blocked step's own position no longer exists in the reloaded definition — a drift case
      // the explicit output-schema check (resume-workflow.ts's `checkDrift`) does not cover, since it
      // only re-validates COMPLETED steps (spec §8.7). Crash gracefully rather than throw: a resume
      // reaching a since-renamed/removed node is an ordinary runtime condition, not a bug.
      return { kind: "crashed", error: `cannot resume: previously-blocked step "${targetName}" no longer exists in this workflow (definition drift, spec §8.7)` };
    }
    effectiveStart = idx;
    if (idx > 0) {
      const previous = nodes[idx - 1];
      if (previous) output = state.stepOutputs.get(staticChildKey(parentPath, nodeName(previous)));
    }
  }

  for (let i = effectiveStart; i < nodes.length; i++) {
    const node = nodes[i];
    if (!node) continue; // unreachable; satisfies noUncheckedIndexedAccess

    // Cooperative cancel at the node boundary (spec §8.6): stop before starting the next node.
    if (signal.aborted) return { kind: "cancelled" };

    const nodeReentry = activeReentry && i === effectiveStart ? activeReentry : undefined;
    const outcome = await runNode(node, output, host, state, signal, parentPath, nodeReentry);
    if (outcome.kind !== "ok") return outcome;

    output = outcome.output;
    state.stepOutputs.set(staticChildKey(parentPath, nodeName(node)), output);
    activeReentry = undefined;
  }

  return { kind: "ok", output };
}

/** The name a re-entry's next hop must match: its own leading segment's name. */
function leafNameOf(reentry: Reentry): string {
  const first = reentry.path[0];
  if (!first) throw new Error("resume: re-entry path is empty at a node boundary (definition drift?)");
  return first.name;
}

/** Whether `node` is addressable by `targetName` at this scope — a branch also exposes its own arms (spec §8.5). */
function matchesReentryTarget(node: WorkflowNode, targetName: string): boolean {
  if (node.kind === "branch") {
    return node.name === targetName || node.arms.some((arm) => arm.name === targetName);
  }
  return nodeName(node) === targetName;
}

function runNode(node: WorkflowNode, input: unknown, host: HostPort, state: RunState, signal: AbortSignal, parentPath: NodePath, reentry?: Reentry): Promise<ExecOutcome> {
  switch (node.kind) {
    case "step":
      return runStepNode(node.step, input, host, state, signal, parentPath, reentry);
    case "branch":
      return runBranchNode(node, input, host, state, signal, parentPath, reentry);
    case "loop":
      return runLoopNode(node, input, host, state, signal, parentPath, reentry);
    case "foreach":
      return runForeachNode(node, host, state, signal, parentPath, reentry);
    case "workflow":
      return runNestedWorkflowNode(node, input, host, state, signal, parentPath, reentry);
  }
}

async function runStepNode(
  step: StepDefinition,
  input: unknown,
  host: HostPort,
  state: RunState,
  signal: AbortSignal,
  parentPath: NodePath,
  reentry?: Reentry,
): Promise<ExecOutcome> {
  const path = appendSegment(parentPath, step.name);
  const formattedPath = formatPath(path);

  // Answer continuation (spec §8.4/§8.5): resume a blocked step with the user's structured answers — no
  // input re-validation and no new `step-started`. Branch on step kind:
  //  - agent → continue the SAME agent loop (the prompt builder is NOT re-invoked);
  //  - questionnaire (form) → reassemble the answers into `output` and validate (no `startAgent`).
  if (reentry?.answer) {
    if (step.kind === "agent") {
      const outcome = await runAgentStep(step, undefined, host, state, signal, parentPath, formattedPath, {
        kind: "answer",
        answers: reentry.answer.answers,
        conversation: reentry.answer.conversation,
      });
      return finishStep(formattedPath, host, state, outcome);
    }
    if (step.kind === "questionnaire") {
      return finishStep(formattedPath, host, state, answerQuestionnaireStep(step, reentry.answer.answers));
    }
  }

  // Questionnaire step, form mode (spec §2.4): does no other work — block immediately with its batch.
  if (step.kind === "questionnaire") {
    await host.emit({ type: "step-started", runId: state.runId, path: formattedPath, input: undefined, at: iso(host) });
    return { kind: "blocked", path: formattedPath, questionnaire: questionnaireFor(step), conversation: [] };
  }

  // Linear hand-off (spec §3.6): a step with an input schema receives the previous node's output;
  // a step with no input schema ignores it and receives `undefined`.
  const stepInput = step.inputSchema ? input : undefined;

  // Input-schema violation is a deterministic wiring failure — crash immediately, never retry.
  if (step.inputSchema) {
    const violation = describeSchemaViolations(step.inputSchema, stepInput);
    if (violation) {
      return { kind: "crashed", error: `step "${step.name}" input: ${violation}`, path: formattedPath };
    }
  }

  await host.emit({ type: "step-started", runId: state.runId, path: formattedPath, input: stepInput, at: iso(host) });

  const outcome =
    step.kind === "agent"
      ? await runAgentStep(step, stepInput, host, state, signal, parentPath, formattedPath, { kind: "fresh" })
      : await runFunctionStep(step, stepInput, host, state, signal, parentPath, formattedPath);
  return finishStep(formattedPath, host, state, outcome);
}

/** The questionnaire a questionnaire step blocks with: the explicit override, or one derived from its target. */
function questionnaireFor(step: QuestionnaireStep) {
  return step.questionnaire ?? questionnaireFromSchema(step.outputSchema);
}

/**
 * Apply answers to a blocked questionnaire step (spec §2.4): reassemble the flat answers into the
 * target shape and validate. Valid → that becomes the step output. Invalid → re-block with the batch.
 */
function answerQuestionnaireStep(step: QuestionnaireStep, answers: Record<string, unknown>): StepOutcome {
  const output = answersToOutput(step.outputSchema, answers);
  const check = validateAnswers(step.outputSchema, output);
  return check.ok ? { kind: "ok", output } : { kind: "blocked", questionnaire: questionnaireFor(step), conversation: [], violation: check.violation };
}

/** Turn a step's `StepOutcome` into an `ExecOutcome`: emit `step-completed` on success; attach identity otherwise. */
async function finishStep(path: string, host: HostPort, state: RunState, outcome: StepOutcome): Promise<ExecOutcome> {
  switch (outcome.kind) {
    case "ok":
      await host.emit({ type: "step-completed", runId: state.runId, path, output: outcome.output, at: iso(host) });
      return { kind: "ok", output: outcome.output };
    case "blocked":
      return { kind: "blocked", path, questionnaire: outcome.questionnaire, conversation: outcome.conversation, violation: outcome.violation };
    case "crashed":
      return { kind: "crashed", error: outcome.error, path };
    case "cancelled":
      return { kind: "cancelled", path };
  }
}

/**
 * Multi-match branch (spec §3.2/§8.5): evaluate all conditions up front, run every true arm
 * sequentially. Each taken arm is its own addressing scope — its own path segment, a PEER of the
 * branch's own path, not nested under it (spec §8.5) — so a step inside it addresses as
 * `armName/stepName`, not `branchName/armName/stepName`. Each taken arm gets its own `node-completed`
 * checkpoint (its own path) in addition to the branch's own final one, so re-entry (spec §8.5) can
 * recover a preceding arm's output without re-running it.
 */
async function runBranchNode(
  node: BranchNode,
  input: unknown,
  host: HostPort,
  state: RunState,
  signal: AbortSignal,
  parentPath: NodePath,
  reentry?: Reentry,
): Promise<ExecOutcome> {
  const branchPath = appendSegment(parentPath, node.name);
  if (!reentry) {
    await host.emit({ type: "node-started", runId: state.runId, path: formatPath(branchPath), nodeKind: "branch", at: iso(host) });
  }

  const ctx = createRunContext(state, parentPath);
  const decisions = node.arms.map((arm) => ({ arm, taken: arm.condition(ctx) })); // pure, side-effect-free (spec §3.2)
  if (!reentry) {
    for (const { arm, taken } of decisions) {
      await host.emit({ type: "branch-arm", runId: state.runId, path: formatPath(appendSegment(parentPath, arm.name)), taken, at: iso(host) });
    }
  }

  const result: Record<string, unknown> = {};
  let activeReentry = reentry;

  for (const { arm, taken } of decisions) {
    if (!taken) continue;
    const armPath = appendSegment(parentPath, arm.name);
    const isTarget = activeReentry !== undefined && leafNameOf(activeReentry) === arm.name;

    if (activeReentry && !isTarget) {
      // A taken arm ordered before the re-entry target: already completed before the block —
      // recover its recorded output rather than re-running it.
      result[arm.name] = state.stepOutputs.get(staticChildKey(parentPath, arm.name));
      continue;
    }

    if (signal.aborted) return { kind: "cancelled" };
    const armReentry: Reentry | undefined = isTarget && activeReentry ? { path: activeReentry.path.slice(1), answer: activeReentry.answer } : undefined;
    const outcome = await runNodeSequence(arm.body.nodes, host, state, input, signal, armPath, 0, armReentry);
    if (outcome.kind !== "ok") return outcome;

    result[arm.name] = outcome.output;
    await host.emit({ type: "node-completed", runId: state.runId, path: formatPath(armPath), output: outcome.output, at: iso(host) });
    if (isTarget) activeReentry = undefined;
  }

  await host.emit({ type: "node-completed", runId: state.runId, path: formatPath(branchPath), output: result, at: iso(host) });
  return { kind: "ok", output: result };
}

/**
 * Loop (spec §3.3/§8.5): run the body, evaluate the pure condition, repeat; guard against infinite
 * loops. Re-entry (spec §8.5) jumps directly to the blocked iteration — earlier iterations are trusted
 * complete (the engine never starts iteration N+1 until iteration N's body and condition are done) —
 * seeding that iteration's hand-off input from the previous iteration's recorded body output.
 */
async function runLoopNode(node: LoopNode, input: unknown, host: HostPort, state: RunState, signal: AbortSignal, parentPath: NodePath, reentry?: Reentry): Promise<ExecOutcome> {
  const loopPath = appendSegment(parentPath, node.name);
  const startIteration = reentry ? reentry.path[0]?.index : undefined;
  if (reentry && startIteration === undefined) {
    throw new Error(`resume: loop "${node.name}" re-entry path is missing its iteration index (definition drift?)`);
  }
  if (!reentry) {
    await host.emit({ type: "node-started", runId: state.runId, path: formatPath(loopPath), nodeKind: "loop", at: iso(host) });
  }

  let iteration = startIteration ?? 1;
  let iterationInput = input;
  if (reentry && iteration > 1) {
    const lastBodyNode = node.body.nodes[node.body.nodes.length - 1];
    iterationInput = lastBodyNode ? state.stepOutputs.get(staticChildKey(parentPath, node.name, nodeName(lastBodyNode))) : input;
  }

  let lastOutput: unknown;
  let innerReentry: Reentry | undefined = reentry ? { path: reentry.path.slice(1), answer: reentry.answer } : undefined;

  for (; iteration <= node.maxIterations; iteration++) {
    if (signal.aborted) return { kind: "cancelled" };
    const iterPath = appendSegment(parentPath, node.name, iteration);
    const thisIterationReentry = innerReentry;
    if (!thisIterationReentry) {
      await host.emit({ type: "loop-iteration", runId: state.runId, path: formatPath(iterPath), iteration, at: iso(host) });
    }

    const outcome = await runNodeSequence(node.body.nodes, host, state, iterationInput, signal, iterPath, 0, thisIterationReentry);
    if (outcome.kind !== "ok") return outcome;
    lastOutput = outcome.output;
    innerReentry = undefined;

    const ctx = createRunContext(state, iterPath); // live view; reflects this iteration's updates
    const conditionMet = node.condition(ctx, lastOutput);
    const stop = node.mode === "dowhile" ? !conditionMet : conditionMet;
    if (stop) {
      await host.emit({ type: "node-completed", runId: state.runId, path: formatPath(loopPath), output: lastOutput, at: iso(host) });
      return { kind: "ok", output: lastOutput };
    }
    iterationInput = lastOutput;
  }

  return { kind: "crashed", error: `loop "${node.name}" exceeded its max of ${node.maxIterations} iterations without its condition being met`, path: formatPath(loopPath) };
}

/**
 * Foreach (spec §3.4/§8.5): run the body once per selected item, sequentially, with the item as input.
 * Output is the per-item outputs in order. Per-item checkpoint (spec §8.2): `state.foreachItemHistory`
 * (built once at resume start from `foreach-item-completed` events, spec §8.2) lets THIS foreach —
 * wherever it sits in the tree — skip every item already recorded, whether resuming node-atomically
 * (no `reentry`, spec §8.2/§8.3) or re-entering a deeper block inside a still-in-flight item (spec §8.5).
 */
async function runForeachNode(node: ForeachNode, host: HostPort, state: RunState, signal: AbortSignal, parentPath: NodePath, reentry?: Reentry): Promise<ExecOutcome> {
  const foreachPath = appendSegment(parentPath, node.name);
  const ctx = createRunContext(state, parentPath);
  const items = node.selector(ctx); // pure, deterministic — a resume re-runs it to the same array (spec §3.4)

  if (!reentry) {
    await host.emit({ type: "foreach-started", runId: state.runId, path: formatPath(foreachPath), count: items.length, at: iso(host) });
  }

  const history = state.foreachItemHistory?.get(formatPath(foreachPath));
  const targetIndex = reentry ? reentry.path[0]?.index : undefined;
  if (reentry && targetIndex === undefined) {
    throw new Error(`resume: foreach "${node.name}" re-entry path is missing its item index (definition drift?)`);
  }
  const startIndex = targetIndex ?? firstMissingIndex(history, items.length);

  const results: unknown[] = new Array(items.length);
  for (let index = 0; index < startIndex; index++) {
    results[index] = history?.get(index);
  }

  let innerReentry: Reentry | undefined = reentry ? { path: reentry.path.slice(1), answer: reentry.answer } : undefined;

  for (let index = startIndex; index < items.length; index++) {
    if (signal.aborted) return { kind: "cancelled" };
    const itemPath = appendSegment(parentPath, node.name, index);
    const thisItemReentry = innerReentry;
    if (!thisItemReentry) {
      await host.emit({ type: "foreach-item-started", runId: state.runId, path: formatPath(itemPath), index, at: iso(host) });
    }

    const outcome = await runNodeSequence(node.body.nodes, host, state, items[index], signal, itemPath, 0, thisItemReentry);
    if (outcome.kind !== "ok") return outcome;

    results[index] = outcome.output;
    await host.emit({ type: "foreach-item-completed", runId: state.runId, path: formatPath(itemPath), index, output: outcome.output, at: iso(host) });
    innerReentry = undefined;
  }

  await host.emit({ type: "node-completed", runId: state.runId, path: formatPath(foreachPath), output: results, at: iso(host) });
  return { kind: "ok", output: results };
}

/** The first item index with no recorded `foreach-item-completed` (0 if none recorded at all). */
function firstMissingIndex(history: ReadonlyMap<number, unknown> | undefined, length: number): number {
  if (!history) return 0;
  for (let i = 0; i < length; i++) {
    if (!history.has(i)) return i;
  }
  return length;
}

/**
 * Nested workflow (spec §2.3/§11): run the sub-workflow's nodes under the SAME parent run state and
 * signal — transparently folding into the parent event log (one run), addressed under this node's own
 * path segment (spec §8.5/§11.1: `audit/lint`). Re-entry (spec §8.5) descends straight into its body.
 */
async function runNestedWorkflowNode(
  node: NestedWorkflowNode,
  input: unknown,
  host: HostPort,
  state: RunState,
  signal: AbortSignal,
  parentPath: NodePath,
  reentry?: Reentry,
): Promise<ExecOutcome> {
  const nestedPath = appendSegment(parentPath, node.name);
  if (!reentry) {
    await host.emit({ type: "node-started", runId: state.runId, path: formatPath(nestedPath), nodeKind: "workflow", at: iso(host) });
  }

  const innerReentry: Reentry | undefined = reentry ? { path: reentry.path.slice(1), answer: reentry.answer } : undefined;
  const outcome = await runNodeSequence(node.workflow.nodes, host, state, input, signal, nestedPath, 0, innerReentry);
  if (outcome.kind !== "ok") return outcome;

  await host.emit({ type: "node-completed", runId: state.runId, path: formatPath(nestedPath), output: outcome.output, at: iso(host) });
  return { kind: "ok", output: outcome.output };
}
