import type { TSchema } from "typebox";
import { createMapStep } from "./create-map-step.ts";
import { resolveIsolation } from "./isolation.ts";
import type { BranchCondition, ForeachSelector, LoopCondition, MapFn, ParallelNode, StepDefinition, WorkflowDefinition, WorkflowNode } from "./types.ts";
import { forEachNode, nodeName } from "./types.ts";

/**
 * `/`, `#`, and `@` are node-path syntax (spec §8.5, engine/node-path.ts): a name carrying any of them
 * would make a path built from it unparseable. Duplicated here (rather than importing engine/node-path.ts)
 * to keep `src/flow` free of a dependency on `src/engine` — flow is the pure authoring layer the
 * engine depends on, not the reverse.
 */
function isValidNodeName(name: string): boolean {
  return name.length > 0 && !name.includes("/") && !name.includes("#") && !name.includes("@");
}

/** Default loop guard: a loop that neither satisfies its condition nor errors within this many iterations crashes. */
export const DEFAULT_MAX_ITERATIONS = 100;

/** Default concurrency ceiling (spec §3.6): the max steps executing at once across the whole run. */
export const DEFAULT_MAX_CONCURRENCY = 4;

/** Default foreach concurrency (spec §3.4): sequential unless the author opts in. */
export const DEFAULT_FOREACH_CONCURRENCY = 1;

export interface CreateWorkflowOptions<TInputSchema extends TSchema | undefined = undefined> {
  /** Unique workflow name/id — used by `/workflow list` and the run store (spec §1.5, §8.9). */
  name: string;
  description?: string;
  /** Optional top-level input schema (spec §3.9). Phase 1 does not wire CLI input; reserved for later phases. */
  input?: TInputSchema;
  /** Default model (`provider/modelId`) for agent steps that declare none (spec §9.5). */
  defaultModel?: string;
  /**
   * The concurrency ceiling (spec §3.6): bounds the total steps executing at once across every
   * construct in the run, including nested workflows (which inherit the ROOT run's ceiling). Default
   * {@link DEFAULT_MAX_CONCURRENCY}. A per-construct `concurrency` above this is rejected at `.commit()`.
   */
  maxConcurrency?: number;
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
  /**
   * How many items run at once (spec §3.4). Default {@link DEFAULT_FOREACH_CONCURRENCY} (sequential).
   * Rejected at `.commit()` if it exceeds the workflow's `maxConcurrency` ceiling (spec §3.6).
   */
  concurrency?: number;
}

/** Options for a `.parallel()` construct. */
export interface ParallelOptions {
  /** Override the auto-generated node name (`parallel-1`, ...). */
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
 * (steps), `.branch()` (multi-match), `.dowhile()` / `.dountil()` (loops), `.foreach()`,
 * `.parallel()` (structural fan-out). Branch arms and loop/foreach bodies are committed sub-workflows
 * executed recursively by the same engine.
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
   * Foreach (spec §3.4): run `body` once per item selected by `selector` (pure), with the item as the
   * body's input. `options.concurrency` (default 1) bounds how many items run at once. Output is the
   * array of per-item outputs, in item order — independent of completion order.
   *
   * **Author contract (spec §8.3, "non-overlapping side effects"):** at `concurrency > 1`, items run
   * genuinely concurrently — the engine does not, and cannot, know what a step or its subagent will
   * touch, so it enforces nothing here. Give each item's body its own files/branches/external
   * resources; anything shared across items (two agents editing the same file, say) must be sequenced
   * — either keep `concurrency` at 1, or restructure so the shared resource is touched outside the
   * fan-out.
   */
  foreach(body: WorkflowDefinition, selector: ForeachSelector, options?: ForeachOptions): WorkflowBuilder;
  /**
   * Parallel (spec §3.5): structural fan-out over independent STEPS — every arm runs concurrently
   * against the same input, bounded only by the workflow ceiling (spec §3.6). Output is an object
   * keyed by each arm's own step name, independent of completion order.
   *
   * **Author contract (spec §8.3, "non-overlapping side effects"):** every arm runs genuinely
   * concurrently — the same rule as `.foreach`'s doc above applies per arm here: no two arms may touch
   * the same file, branch, or external resource, since the engine has no way to detect or prevent two
   * concurrent agents rewriting the same working-tree state. Sequence anything that shares state with
   * `.then()` instead of putting it in the same `.parallel([...])`.
   */
  parallel(arms: readonly StepDefinition[], options?: ParallelOptions): WorkflowBuilder;
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
  let parallelCount = 0;
  const maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;

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
      nodes.push({
        kind: "foreach",
        name: foreachOptions?.name ?? `foreach-${foreachCount}`,
        body,
        selector,
        concurrency: foreachOptions?.concurrency ?? DEFAULT_FOREACH_CONCURRENCY,
      });
      return builder;
    },
    parallel(arms, parallelOptions) {
      parallelCount += 1;
      nodes.push({ kind: "parallel", name: parallelOptions?.name ?? `parallel-${parallelCount}`, arms: [...arms] });
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
      assertConcurrencyWithinCeiling(options.name, nodes, maxConcurrency);
      assertNoBackgroundAsks(options.name, nodes);
      return {
        name: options.name,
        description: options.description,
        inputSchema: options.input,
        defaultModel: options.defaultModel,
        maxConcurrency,
        // Static isolation (spec §2.2) tagged onto the committed tree here, once — see isolation.ts.
        // Also enforces spec §10.1 (asks may not overlap), the same walk's other half.
        nodes: resolveIsolation(options.name, nodes),
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

/** The three things `.then()` (and a `.parallel()` arm) accepts — anything else is not a step (spec §2). */
const STEP_KINDS = new Set(["function", "agent", "questionnaire"]);

/**
 * Reject nodes that are not real steps, so `commit()` fails at authoring time rather than at run
 * time. `.then()` takes a `StepDefinition` from `createStep`/`createAgentStep`/`createQuestionnaireStep`;
 * passing anything else — a bare function, a plain object, the result of a hallucinated builder API —
 * used to commit successfully and only fail once the engine tried to execute it. `forEachNode` visits a
 * `.parallel()` arm as a synthetic step node, so this same check covers arms for free.
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
 * A parallel node, by contrast, is NOT a peer scope like branch: its arms are plain steps nested UNDER
 * its own name (`parallelName/armName`, like a loop/foreach body), so only the parallel's own name
 * needs to be unique in THIS scope — its arms form their OWN separate, local scope, checked by
 * {@link assertUniqueParallelArmNames}.
 *
 * This also enforces the `/`/`#`/`@` ban (spec §3): all three are node-path syntax, and a name
 * carrying any of them would make a path built from it unparseable.
 */
function assertScopeNames(workflowName: string, nodes: readonly WorkflowNode[]): void {
  const seen = new Set<string>();
  const check = (name: string): void => {
    if (!isValidNodeName(name)) {
      throw new Error(
        `workflow "${workflowName}": name "${name}" is invalid — step/node names may not be empty or contain "/", "#", or "@" (all three are node-path syntax, spec §3)`,
      );
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
      if (node.kind === "parallel") assertUniqueParallelArmNames(workflowName, node);
    }
  }
}

/** A parallel's own arm-name scope (spec §3.5/§3.9): unique among ITS arms, separate from the enclosing scope. */
function assertUniqueParallelArmNames(workflowName: string, node: ParallelNode): void {
  if (node.arms.length === 0) {
    throw new Error(`workflow "${workflowName}": parallel "${node.name}" must declare at least one arm`);
  }
  const seen = new Set<string>();
  for (const step of node.arms) {
    const name = step.name;
    if (!isValidNodeName(name)) {
      throw new Error(
        `workflow "${workflowName}": parallel "${node.name}" arm name "${name}" is invalid — step names may not be empty or contain "/", "#", or "@" (all three are node-path syntax, spec §3)`,
      );
    }
    if (seen.has(name)) {
      throw new Error(`workflow "${workflowName}": parallel "${node.name}" has two arms named "${name}"; arm names must be unique within their parallel (spec §3.5/§3.9)`);
    }
    seen.add(name);
  }
}

/**
 * `background` + `asks` is rejected at `.commit()` (spec §10.1): a `background` agent step runs as an
 * isolated, unwatched PI subagent (spec §2.2) — it must not be able to interrupt the parent session
 * with a question whose reasoning the user never saw. Walks the full recursive tree (`forEachNode`), so
 * the combination is caught wherever the step sits (top level, branch arm, loop/foreach body, parallel
 * arm, or nested workflow).
 */
function assertNoBackgroundAsks(workflowName: string, nodes: readonly WorkflowNode[]): void {
  forEachNode(nodes, (node) => {
    if (node.kind !== "step" || node.step.kind !== "agent") return;
    const step = node.step;
    if (step.background && step.asks) {
      throw new Error(
        `workflow "${workflowName}": agent step "${step.name}" declares both background and asks — a background step runs isolated and unwatched, so it cannot block the run to ask a question (spec §10.1)`,
      );
    }
    // An asking step's questionnaire IS its output schema (spec §10.1) — the questions are derived from
    // it. Without one there is nothing to ask, and the step would silently degrade into a plain
    // acting step that can never block, which is a wiring bug worth catching at commit rather than
    // discovering as a run that never paused.
    if (step.asks && step.outputSchema === undefined) {
      throw new Error(
        `workflow "${workflowName}": agent step "${step.name}" declares asks but no output schema — an asking step's questions are derived from its schema (spec §10.1); declare \`output\`, or drop \`asks\` if the step only acts`,
      );
    }
  });
}

/**
 * A per-construct `concurrency` above the workflow's ceiling is rejected at `.commit()` rather than
 * silently capped (spec §3.6) — an author who writes `8` should learn that the workflow says `4`, not
 * discover it from timing. Walks the full recursive tree (`forEachNode`), so a foreach nested inside a
 * branch arm, loop, or nested workflow is caught too, checked against THIS commit's own ceiling.
 */
function assertConcurrencyWithinCeiling(workflowName: string, nodes: readonly WorkflowNode[], maxConcurrency: number): void {
  forEachNode(nodes, (node) => {
    if (node.kind === "foreach" && node.concurrency > maxConcurrency) {
      throw new Error(
        `workflow "${workflowName}": foreach "${node.name}" declares concurrency ${node.concurrency}, above the workflow's ceiling of ${maxConcurrency} (spec §3.6) — raise maxConcurrency or lower this construct's concurrency`,
      );
    }
  });
}
