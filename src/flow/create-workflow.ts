import type { TSchema } from "typebox";
import { createMapStep } from "./create-map-step.ts";
import type { BranchCondition, ForeachSelector, LoopCondition, MapFn, StepDefinition, WorkflowDefinition, WorkflowNode } from "./types.ts";
import { forEachNode, nodeName } from "./types.ts";

/**
 * `/` and `#` are node-path syntax (spec §8.5, engine/node-path.ts): a name carrying either would
 * make a path built from it unparseable. Duplicated here (rather than importing engine/node-path.ts)
 * to keep `src/flow` free of a dependency on `src/engine` — flow is the pure authoring layer the
 * engine depends on, not the reverse.
 */
function isValidNodeName(name: string): boolean {
  return name.length > 0 && !name.includes("/") && !name.includes("#");
}

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

export function createWorkflow<TInputSchema extends TSchema | undefined = undefined>(options: CreateWorkflowOptions<TInputSchema>): WorkflowBuilder {
  const nodes: WorkflowNode[] = [];
  let mapCount = 0;
  let branchCount = 0;
  let loopCount = 0;
  let foreachCount = 0;

  const builder: WorkflowBuilder = {
    // `.then()` is the builder's sequencing verb (spec §3.1, Mastra-inspired §1.2), not a thenable:
    // the builder is never awaited, and `.commit()` terminates it into a plain definition object.
    // biome-ignore lint/suspicious/noThenProperty: intentional builder API, never awaited
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
      assertWellFormed(options.name, nodes);
      assertScopeNames(options.name, nodes);
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

/** The three things `.then()` accepts — anything else is not a step (spec §2). */
const STEP_KINDS = new Set(["function", "agent", "questionnaire"]);

/**
 * Reject nodes that are not real steps, so `commit()` fails at authoring time rather than at run
 * time. `.then()` takes a `StepDefinition` from `createStep`/`createAgentStep`/`createQuestionnaireStep`;
 * passing anything else — a bare function, a plain object, the result of a hallucinated builder API —
 * used to commit successfully and only fail once the engine tried to execute it.
 */
function assertWellFormed(workflowName: string, nodes: readonly WorkflowNode[]): void {
  forEachNode(nodes, (node) => {
    if (node.kind !== "step") return;
    const step: unknown = node.step;
    const kind = (step as { kind?: unknown } | null)?.kind;
    if (typeof step !== "object" || step === null || typeof kind !== "string" || !STEP_KINDS.has(kind)) {
      throw new Error(`workflow "${workflowName}": .then() expects a step from createStep/createAgentStep/createQuestionnaireStep, but received ${describeValue(step)}`);
    }
    if (typeof (step as { name?: unknown }).name !== "string" || (step as { name: string }).name.length === 0) {
      throw new Error(`workflow "${workflowName}": a ${kind} step is missing its required "name"`);
    }
  });
}

function describeValue(value: unknown): string {
  if (typeof value === "function") return `a function${value.name ? ` (${value.name})` : ""}`;
  if (value === null) return "null";
  if (typeof value !== "object") return typeof value;
  const kind = (value as { kind?: unknown }).kind;
  return kind === undefined ? "an object with no `kind`" : `an object with kind "${String(kind)}"`;
}

/**
 * Names need only be unique WITHIN their enclosing scope (spec §3.9/§11.2), not across the whole
 * tree: a branch arm, loop body, foreach body, and nested workflow are each pre-committed as their
 * OWN `WorkflowDefinition` (this same check already ran on them at their own `.commit()`), so this
 * scope is exactly `nodes` — the list being committed right now. No recursion is needed, which is
 * precisely what lets the SAME sub-workflow be composed twice in one parent (§11.2 — the node path,
 * not the name, disambiguates the two instances at run time).
 *
 * A branch node contributes MORE than one addressable name to this scope: its own construct name
 * (used for its `node-started`/`node-completed` lifecycle) AND each arm's name (an arm is a PEER
 * scope of the branch's own name for addressing purposes, spec §8.5 — a step inside it is
 * `armName/stepName`, not `branchName/armName/stepName`). Both pools are checked together, since a
 * bare-name context read (spec §3.9) of either would be ambiguous if duplicated.
 *
 * This also enforces the `/`/`#` ban (spec §3): both are node-path syntax, and a name carrying either
 * would make a path built from it unparseable.
 */
function assertScopeNames(workflowName: string, nodes: readonly WorkflowNode[]): void {
  const seen = new Set<string>();
  const check = (name: string): void => {
    if (!isValidNodeName(name)) {
      throw new Error(`workflow "${workflowName}": name "${name}" is invalid — step/node names may not be empty or contain "/" or "#" (both are node-path syntax, spec §3)`);
    }
    if (seen.has(name)) {
      throw new Error(
        `workflow "${workflowName}" has a duplicate node/step name "${name}"; names must be unique within their enclosing scope (spec §3.9/§11.2) — a duplicate here would make a bare context read of "${name}" ambiguous`,
      );
    }
    seen.add(name);
  };

  for (const node of nodes) {
    if (node.kind === "branch") {
      check(node.name);
      for (const arm of node.arms) check(arm.name);
    } else {
      check(nodeName(node));
    }
  }
}
