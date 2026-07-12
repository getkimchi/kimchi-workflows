import type { TSchema } from "typebox";
import { createMapStep } from "./create-map-step.ts";
import type {
  BranchCondition,
  ForeachSelector,
  LoopCondition,
  MapFn,
  StepDefinition,
  WorkflowDefinition,
  WorkflowNode,
} from "./types.ts";
import { forEachNode, nodeName } from "./types.ts";

/** Default loop guard: a loop that neither satisfies its condition nor errors within this many iterations crashes. */
export const DEFAULT_MAX_ITERATIONS = 100;

export interface CreateWorkflowOptions<TInputSchema extends TSchema | undefined = undefined> {
  /** Unique workflow name/id — used by `/workflow list` and the run store (spec §1.5, §8.7). */
  name: string;
  description?: string;
  /** Optional top-level input schema (spec §3.9). Phase 1 does not wire CLI input; reserved for later phases. */
  input?: TInputSchema;
  /** Default model (`provider/modelId`) for agent steps that declare none (spec §9.5). */
  defaultModel?: string;
}

/** Options for a `.map()` construct. */
export interface MapOptions {
  /** Override the auto-generated step name (`map-1`, `map-2`, ...) used in the event log / run context. */
  name?: string;
}

/** Options for a `.branch()` construct. */
export interface BranchOptions {
  /** Override the auto-generated node name (`branch-1`, ...). */
  name?: string;
}

/** Options for a loop construct. */
export interface LoopOptions {
  /** Override the auto-generated node name (`loop-1`, ...). */
  name?: string;
  /** Max iterations before the loop crashes (default {@link DEFAULT_MAX_ITERATIONS}). */
  maxIterations?: number;
}

/** Options for a `.foreach()` construct. */
export interface ForeachOptions {
  /** Override the auto-generated node name (`foreach-1`, ...). */
  name?: string;
}

/** Options for a `.workflow()` (nested-workflow) construct. */
export interface NestedWorkflowOptions {
  /** Override the node name (defaults to the sub-workflow's name). */
  name?: string;
}

/** One `.branch()` arm: a pure condition paired with the sub-workflow to run when it holds. */
export type BranchArmSpec = readonly [BranchCondition, WorkflowDefinition];

/**
 * Builder finalized with `.commit()` (Mastra-inspired, spec §1.2/§3). Nodes: `.then()` / `.map()`
 * (steps), `.branch()` (multi-match), `.dowhile()` / `.dountil()` (loops). Branch arms and loop
 * bodies are committed sub-workflows executed recursively by the same engine.
 */
export interface WorkflowBuilder {
  /** Append a step node to run next in sequence (spec §3.1). */
  then(step: StepDefinition): WorkflowBuilder;
  /**
   * Insert a pure transform whose result becomes the next node's input via the linear hand-off
   * (spec §3.7). Reads earlier, non-adjacent outputs via `ctx.getStepResult` / `ctx.getInitData`.
   */
  map(transform: MapFn, options?: MapOptions): WorkflowBuilder;
  /**
   * Multi-match branch (spec §3.2): every arm whose condition holds runs sequentially; the node's
   * output is an object keyed by the executed arm names (each arm name is its body's workflow name).
   */
  branch(arms: readonly BranchArmSpec[], options?: BranchOptions): WorkflowBuilder;
  /** Loop (spec §3.3): run `body`, then repeat while `condition` holds; output is the last body output. */
  dowhile(body: WorkflowDefinition, condition: LoopCondition, options?: LoopOptions): WorkflowBuilder;
  /** Loop (spec §3.3): run `body`, then repeat until `condition` holds; output is the last body output. */
  dountil(body: WorkflowDefinition, condition: LoopCondition, options?: LoopOptions): WorkflowBuilder;
  /**
   * Foreach (spec §3.4): run `body` once per item selected by `selector` (pure), sequentially, with
   * the item as the body's input. Output is the array of per-item outputs, in order.
   */
  foreach(body: WorkflowDefinition, selector: ForeachSelector, options?: ForeachOptions): WorkflowBuilder;
  /**
   * Nested workflow (spec §2.3/§11): run a committed sub-workflow's nodes here, transparently folding
   * into the parent run/log. Output is the sub-workflow's final output. Every step/node name must be
   * unique across the flattened tree, so nesting the *same* sub-workflow twice is a `commit()` error.
   */
  workflow(subWorkflow: WorkflowDefinition, options?: NestedWorkflowOptions): WorkflowBuilder;
  /** Finalize the workflow definition. */
  commit(): WorkflowDefinition;
}

export function createWorkflow<TInputSchema extends TSchema | undefined = undefined>(
  options: CreateWorkflowOptions<TInputSchema>,
): WorkflowBuilder {
  const nodes: WorkflowNode[] = [];
  let mapCount = 0;
  let branchCount = 0;
  let loopCount = 0;
  let foreachCount = 0;

  const builder: WorkflowBuilder = {
    then(step) {
      nodes.push({ kind: "step", step });
      return builder;
    },
    map(transform, mapOptions) {
      mapCount += 1;
      nodes.push({ kind: "step", step: createMapStep(mapOptions?.name ?? `map-${mapCount}`, transform) });
      return builder;
    },
    branch(arms, branchOptions) {
      branchCount += 1;
      nodes.push({
        kind: "branch",
        name: branchOptions?.name ?? `branch-${branchCount}`,
        arms: arms.map(([condition, body]) => ({ name: body.name, condition, body })),
      });
      return builder;
    },
    dowhile(body, condition, loopOptions) {
      nodes.push(makeLoop("dowhile", body, condition, loopOptions));
      return builder;
    },
    dountil(body, condition, loopOptions) {
      nodes.push(makeLoop("dountil", body, condition, loopOptions));
      return builder;
    },
    foreach(body, selector, foreachOptions) {
      foreachCount += 1;
      nodes.push({ kind: "foreach", name: foreachOptions?.name ?? `foreach-${foreachCount}`, body, selector });
      return builder;
    },
    workflow(subWorkflow, nestedOptions) {
      nodes.push({ kind: "workflow", name: nestedOptions?.name ?? subWorkflow.name, workflow: subWorkflow });
      return builder;
    },
    commit() {
      if (nodes.length === 0) {
        throw new Error(`workflow "${options.name}" must declare at least one node before commit()`);
      }
      assertUniqueNames(options.name, nodes);
      return {
        name: options.name,
        description: options.description,
        inputSchema: options.input,
        defaultModel: options.defaultModel,
        nodes: [...nodes],
      };
    },
  };

  function makeLoop(mode: "dowhile" | "dountil", body: WorkflowDefinition, condition: LoopCondition, loopOptions?: LoopOptions): WorkflowNode {
    loopCount += 1;
    return {
      kind: "loop",
      name: loopOptions?.name ?? `loop-${loopCount}`,
      mode,
      body,
      condition,
      maxIterations: loopOptions?.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    };
  }

  return builder;
}

/**
 * Names address data flow and match the event log (spec §3), so every step/branch/loop name must
 * be unique across the whole workflow tree (including branch-arm and loop bodies). Global
 * uniqueness lets node-atomic resume identify a completed node from the log unambiguously.
 */
function assertUniqueNames(workflowName: string, nodes: readonly WorkflowNode[]): void {
  const seen = new Set<string>();
  forEachNode(nodes, (node) => {
    const name = nodeName(node);
    if (seen.has(name)) {
      throw new Error(`workflow "${workflowName}" has a duplicate node/step name "${name}"; names must be unique across the whole workflow`);
    }
    seen.add(name);
  });
}
