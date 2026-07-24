/**
 * Node walker for the deterministic engine (spec §4). A workflow is an ordered sequence of nodes
 * (step / branch / loop / foreach / parallel / nested workflow); this walks them with linear hand-off
 * at the node level. Branch arms, loop/foreach bodies, and parallel arms are sub-workflows (or, for
 * parallel, bare steps) executed by the SAME walker, each contributing one path segment to its
 * children's addressing (spec §8.5).
 *
 * `.parallel` and `.foreach(concurrency > 1)` (spec §3.4/§3.5/§3.6, P3) live in concurrent-nodes.ts.
 * That file needs to recurse back into this one (a foreach item's/parallel arm's body is walked by
 * `runNodeSequence`; a parallel arm itself by `runStepNode`) — passed in as a small `NodeWalker` object
 * (context.ts) rather than imported, so the dependency stays one-directional (this file →
 * concurrent-nodes.ts) instead of an import cycle.
 *
 * Used by both a fresh run (`run-workflow.ts`) and a resume (`resume-workflow.ts`) via `execute`.
 * Zero imports from PI, `node:fs`, or any network lib — see src/engine/types.ts.
 */
import { answersToOutput, questionnaireFromSchema, validateAnswers } from "../flow/questionnaire.ts";
import type { BranchNode, LoopNode, NestedWorkflowNode, QuestionnaireStep, StepDefinition, WorkflowDefinition, WorkflowNode } from "../flow/types.ts";
import { nodeName } from "../flow/types.ts";
import { describeSchemaViolations } from "../flow/validation.ts";
import { runForeachNode, runParallelNode } from "./concurrent-nodes.ts";
import { createRunContext, type ExecOutcome, iso, type NodeWalker, type PendingBlock, type Reentry, type RunState, type StepOutcome } from "./context.ts";
import { appendLoopIteration, appendSegment, formatPath, type NodePath, staticChildKey, staticKeyOf } from "./node-path.ts";
import { createConcurrencyGate } from "./scheduler.ts";
import { runAgentStep, runFunctionStep } from "./step-runner.ts";
import type { HostPort, RunResult } from "./types.ts";

// Re-exported for the engine's public surface (src/engine/index.ts) and for tests — the types
// themselves live in context.ts (see the header comment above for why).
export type { AnswerResume, Reentry } from "./context.ts";

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
  /**
   * Resume-only (spec §8.6): every step currently `blocked` elsewhere in the log at the moment this
   * resume began, keyed by static key. Lets a concurrent construct's re-entry recognize a sibling of
   * the re-entry target that is ALSO still pending — left untouched rather than restarted or dropped.
   */
  readonly pendingBlocks?: ReadonlyMap<string, PendingBlock>;
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
    inFlight: new Set(),
    // Run-wide ceiling (spec §3.6): one gate for the whole call, shared by every construct at any
    // depth — including nested workflows, which simply reuse `state` and so inherit this verbatim.
    concurrencyGate: createConcurrencyGate(workflow.maxConcurrency),
    defaultModel: workflow.defaultModel,
    foreachItemHistory: cursor.foreachItemHistory,
    pendingBlocks: cursor.pendingBlocks,
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
    // `questionnaire-asked` was already emitted at the point this step (or, for a concurrent
    // construct, whichever arm is being surfaced here) actually blocked — see `finishStep` — so this
    // is just reporting, not recording.
    return { runId: state.runId, status: "blocked", path: outcome.path, questionnaire: outcome.questionnaire, violation: outcome.violation };
  }
  await host.emit({ type: "run-cancelled", runId: state.runId, path: outcome.path, at: iso(host) });
  return { runId: state.runId, status: "cancelled" };
}

/**
 * Walk a node sequence with linear hand-off (spec §3.6): each node's output feeds the next. Used at
 * the top level (with `startIndex`/`reentry` from resume) and recursively for branch arms /
 * loop-iteration / foreach-item / parallel-arm / nested-workflow bodies (always `startIndex` 0,
 * `reentry` popped one segment per level by the caller). A node's output is recorded under its own
 * STATIC path (spec §5.4) for `ctx.getStepResult`. Exported for concurrent-nodes.ts, which recurses
 * back into this for each arm's/item's own body.
 */
export async function runNodeSequence(
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

/** The name a re-entry's next hop must match: its own leading segment's name. Exported for concurrent-nodes.ts. */
export function leafNameOf(reentry: Reentry): string {
  const first = reentry.path[0];
  if (!first) throw new Error("resume: re-entry path is empty at a node boundary (definition drift?)");
  return first.name;
}

/**
 * Whether `node` is addressable by `targetName` at this scope. A branch's arms are PEERS of the
 * branch's own path (spec §8.5: `armName/stepName`, not `branchName/armName/stepName`), so a re-entry
 * path may name an arm DIRECTLY without the branch's own name ever appearing — hence the extra check.
 * A parallel's arms, by contrast, nest UNDER its own name (`parallelName/armName`, like a loop/foreach
 * body) — the re-entry path always leads with the parallel's own name, exactly like every other
 * construct, so no extra check is needed there.
 */
function matchesReentryTarget(node: WorkflowNode, targetName: string): boolean {
  if (node.kind === "branch") {
    return node.name === targetName || node.arms.some((arm) => arm.name === targetName);
  }
  return nodeName(node) === targetName;
}

// The recursion points concurrent-nodes.ts needs back into this file (see the header comment) —
// `runNodeSequence`/`runStepNode`/`leafNameOf` are stable `function` declarations (hoisted), so this
// object can be built once, referencing them before their textual definition below.
const walker: NodeWalker = { runNodeSequence, runStepNode, leafNameOf };

function runNode(node: WorkflowNode, input: unknown, host: HostPort, state: RunState, signal: AbortSignal, parentPath: NodePath, reentry?: Reentry): Promise<ExecOutcome> {
  switch (node.kind) {
    case "step":
      return runStepNode(node.step, input, host, state, signal, parentPath, reentry);
    case "branch":
      return runBranchNode(node, input, host, state, signal, parentPath, reentry);
    case "loop":
      return runLoopNode(node, input, host, state, signal, parentPath, reentry);
    case "foreach":
      return runForeachNode(walker, node, host, state, signal, parentPath, reentry);
    case "parallel":
      return runParallelNode(walker, node, input, host, state, signal, parentPath, reentry);
    case "workflow":
      return runNestedWorkflowNode(node, input, host, state, signal, parentPath, reentry);
  }
}

/** Run one step to a settled outcome, tracking it in-flight for the full duration (spec §3.9). Exported for concurrent-nodes.ts (parallel arms). */
export async function runStepNode(
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
  const inFlightKey = staticKeyOf(path);

  // Reads never race (spec §3.9): mark this step in-flight for the FULL duration of its execution
  // (fresh, answer-continuation, or a questionnaire's immediate block) so a concurrent sibling's
  // `getStepResult` throws rather than observing a torn/undefined value. Cleared on every exit path.
  state.inFlight.add(inFlightKey);
  try {
    return await runStepNodeBody(step, input, host, state, signal, parentPath, formattedPath, reentry);
  } finally {
    state.inFlight.delete(inFlightKey);
  }
}

async function runStepNodeBody(
  step: StepDefinition,
  input: unknown,
  host: HostPort,
  state: RunState,
  signal: AbortSignal,
  parentPath: NodePath,
  formattedPath: string,
  reentry?: Reentry,
): Promise<ExecOutcome> {
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
  // `questionnaire-asked` is emitted HERE, at the point of blocking, not deferred to execute()'s top
  // level (spec §8.6): under concurrency several steps can block in the SAME round, and each needs its
  // OWN recorded event regardless of which one the caller ultimately reports as "the" blocked outcome —
  // deferring to the top would silently drop every blocked sibling but one.
  if (step.kind === "questionnaire") {
    await host.emit({ type: "step-started", runId: state.runId, path: formattedPath, input: undefined, at: iso(host) });
    const questionnaire = questionnaireFor(step);
    await host.emit({ type: "questionnaire-asked", runId: state.runId, path: formattedPath, questionnaire, conversation: [], at: iso(host) });
    return { kind: "blocked", path: formattedPath, questionnaire, conversation: [] };
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

/**
 * Turn a step's `StepOutcome` into an `ExecOutcome`: emit `step-completed` on success. On `blocked`,
 * emit `questionnaire-asked` right here — at the point this step actually blocked — rather than
 * leaving it to whoever eventually reports the outcome (spec §8.6: under concurrency several steps can
 * block in the SAME round, and each needs its own recorded event, independent of which one a
 * concurrent construct's settlement picks to surface as "the" result of this call).
 */
async function finishStep(path: string, host: HostPort, state: RunState, outcome: StepOutcome): Promise<ExecOutcome> {
  switch (outcome.kind) {
    case "ok":
      await host.emit({ type: "step-completed", runId: state.runId, path, output: outcome.output, at: iso(host) });
      return { kind: "ok", output: outcome.output };
    case "blocked":
      await host.emit({
        type: "questionnaire-asked",
        runId: state.runId,
        path,
        questionnaire: outcome.questionnaire,
        conversation: outcome.conversation,
        violation: outcome.violation,
        at: iso(host),
      });
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
 * seeding that iteration's hand-off input from the previous iteration's recorded body output. A loop
 * is inherently sequential (never concurrent — only ONE iteration is ever live), so this is unchanged
 * by P3 beyond the `appendLoopIteration` rename.
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
    const iterPath = appendLoopIteration(parentPath, node.name, iteration);
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
 * Nested workflow (spec §2.3/§11): run the sub-workflow's nodes under the SAME parent run state and
 * signal — transparently folding into the parent event log (one run), addressed under this node's own
 * path segment (spec §8.5/§11.1: `audit/lint`). Re-entry (spec §8.5) descends straight into its body.
 * Sharing `state` is also what makes nested workflows inherit the root run's concurrency ceiling (spec
 * §3.6): `state.concurrencyGate` is created once, at the root, and never recreated here.
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
