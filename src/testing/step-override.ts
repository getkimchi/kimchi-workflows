/**
 * Step overrides (spec §13.2/§13.3): replace any step, by name, with a stub — including one nested
 * inside a branch arm, loop/foreach body, parallel arm, or nested workflow. An override naming a step
 * the workflow does not contain fails immediately, at construction, rather than surfacing later as a
 * confusing mid-run failure or (worse) silently doing nothing.
 *
 * Implementation: an override is spliced into the node tree as an ordinary FUNCTION step, preserving the
 * REAL step's name/description/inputSchema/outputSchema/retry/maxDurationMs. Two things fall out of that
 * for free, with no engine changes at all:
 *  - the stub's return value is validated against the real step's declared `outputSchema`, by the SAME
 *    function-step validation every workflow already goes through (step-runner.ts) — a stub that has
 *    drifted from the contract it stands in for fails the test, not a silent divergence;
 *  - a stub that throws drives the real step's retry/crash/resume machinery (spec §13.3), because it now
 *    IS a function step under that policy — the otherwise-unreachable failure path becomes reachable
 *    without hand-rolling code that fails on purpose.
 *
 * `src/testing` stays a pure consumer of `src/flow` — no engine internals are touched, keeping the
 * override mechanism entirely a testing-layer concern (spec §13.1).
 */
import type { FunctionStep, StepDefinition, StepRunArgs, WorkflowDefinition, WorkflowNode } from "../flow/types.ts";
import { forEachNode } from "../flow/types.ts";

/** A step stub (spec §13.2): same shape as a function step's `run`, so a thrown error drives retry/crash/resume. */
export type StepOverride = (args: StepRunArgs<unknown>) => unknown | Promise<unknown>;

/** Per-step stubs, keyed by step name — any step, of any kind, anywhere in the tree. */
export type StepOverrides = Readonly<Record<string, StepOverride>>;

/**
 * Splice `overrides` into `workflow`'s node tree, returning a new `WorkflowDefinition`. Returns
 * `workflow` unchanged when there is nothing to override. Throws immediately when an override names a
 * step the workflow does not contain (spec §13.3).
 */
export function applyStepOverrides(workflow: WorkflowDefinition, overrides: StepOverrides | undefined): WorkflowDefinition {
  const names = overrides ? Object.keys(overrides) : [];
  if (names.length === 0) return workflow;

  const consumed = new Set<string>();
  const nodes = rewriteNodes(workflow.nodes, overrides as StepOverrides, consumed);

  const unknown = names.filter((name) => !consumed.has(name));
  if (unknown.length > 0) {
    const known = [...collectStepNames(workflow.nodes)].sort();
    throw new Error(
      `step override(s) ${unknown.map((name) => `"${name}"`).join(", ")}: workflow "${workflow.name}" has no step with that name (steps: ${known.join(", ") || "none"})`,
    );
  }

  return { ...workflow, nodes };
}

function rewriteNodes(nodes: readonly WorkflowNode[], overrides: StepOverrides, consumed: Set<string>): WorkflowNode[] {
  return nodes.map((node) => rewriteNode(node, overrides, consumed));
}

function rewriteNode(node: WorkflowNode, overrides: StepOverrides, consumed: Set<string>): WorkflowNode {
  switch (node.kind) {
    case "step":
      return { kind: "step", step: rewriteStep(node.step, overrides, consumed) };
    case "branch":
      return { ...node, arms: node.arms.map((arm) => ({ ...arm, body: rewriteWorkflow(arm.body, overrides, consumed) })) };
    case "loop":
    case "foreach":
      return { ...node, body: rewriteWorkflow(node.body, overrides, consumed) };
    case "parallel":
      return { ...node, arms: node.arms.map((step) => rewriteStep(step, overrides, consumed)) };
    case "workflow":
      return { ...node, workflow: rewriteWorkflow(node.workflow, overrides, consumed) };
  }
}

function rewriteWorkflow(workflow: WorkflowDefinition, overrides: StepOverrides, consumed: Set<string>): WorkflowDefinition {
  return { ...workflow, nodes: rewriteNodes(workflow.nodes, overrides, consumed) };
}

function rewriteStep(step: StepDefinition, overrides: StepOverrides, consumed: Set<string>): StepDefinition {
  const override = overrides[step.name];
  if (!override) return step;
  consumed.add(step.name);
  return asFunctionStep(step, override);
}

/** Replace `step` with a plain function step running `override`, preserving everything the engine keys its policies on. */
function asFunctionStep(step: StepDefinition, run: StepOverride): FunctionStep {
  return {
    kind: "function",
    name: step.name,
    description: step.description,
    inputSchema: step.inputSchema,
    outputSchema: step.outputSchema,
    retry: step.retry,
    maxDurationMs: step.maxDurationMs,
    run,
  };
}

/** Every step (of any kind) in the tree, by name — mirrors testing/agent-double.ts's collectAgentSteps. */
function collectStepNames(nodes: readonly WorkflowNode[]): Set<string> {
  const names = new Set<string>();
  forEachNode(nodes, (node) => {
    if (node.kind === "step") names.add(node.step.name);
  });
  return names;
}
