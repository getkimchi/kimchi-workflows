/**
 * Flow layer (workflow-definition API) — pure data shapes for workflows and steps.
 *
 * No host, filesystem, or network dependencies. Everything here is plain
 * data + function signatures that the engine (src/engine) interprets.
 */
import type { TSchema } from "typebox";
import type { Questionnaire } from "./questionnaire.ts";

/** Prior step outputs, workflow init data, and run identity, exposed to a step's body. */
export interface RunContext {
  /** The run's generated id. */
  readonly runId: string;
  /** The workflow's declared name. */
  readonly workflowName: string;
  /** Look up a prior step's output by step name (undefined if not yet run). */
  getStepResult<T = unknown>(stepName: string): T | undefined;
  /** The workflow's initial input, if any (undefined for workflows with no input schema). */
  getInitData<T = unknown>(): T | undefined;
}

/** Structured logger writing to the run's event log (see engine "step-log" events). */
export interface StepLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

/** Arguments passed to a step's `run` function (spec §2.5). */
export interface StepRunArgs<TInput> {
  readonly input: TInput;
  readonly ctx: RunContext;
  readonly abortSignal: AbortSignal;
  readonly logger: StepLogger;
}

export type StepRunFn<TInput, TOutput> = (args: StepRunArgs<TInput>) => TOutput | Promise<TOutput>;

/**
 * A `.map()` transform (spec §3.7): derives the next step's input purely from the run context —
 * prior step outputs (`getStepResult`) and workflow init data (`getInitData`). Pure and
 * deterministic; it has no host, network, or LLM access beyond `ctx`. The returned value is
 * validated by the downstream step's input schema, so a map declares no schema of its own.
 */
export type MapFn<TOutput = unknown> = (ctx: RunContext) => TOutput;

/** Arguments passed to an agent step's `prompt` builder — pure string construction from input + context. */
export interface AgentPromptArgs<TInput> {
  readonly input: TInput;
  readonly ctx: RunContext;
}

/**
 * Unified repeat policy for a step (spec §9.1). Covers thrown errors and invalid output uniformly;
 * an input-schema violation is a deterministic wiring failure and is never retried.
 */
export interface RetryPolicy {
  /** Attempts after the first (default 0 = run once, no retry). */
  readonly maxRetry: number;
  /** Delay between attempts, awaited via `host.sleep` (default 0 = no wait). */
  readonly backoffMs?: number;
}

/**
 * Fields common to every step kind. Deliberately non-generic: a workflow holds a chain of steps
 * with differing I/O types, and the engine only ever knows a step's I/O shape via its TypeBox
 * schemas at runtime (validated there, per spec §8.5). The `create*` helpers give the *author*
 * precise, schema-derived types; these interfaces are the type-erased shapes the engine executes.
 */
interface StepBase {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: TSchema;
  readonly retry?: RetryPolicy;
  /**
   * Per-step wall-time budget in milliseconds (spec §9.3). If the step runs longer, its abort signal
   * fires and the attempt fails with `budget-exceeded` — counted against the retry policy (§9.1).
   */
  readonly maxDurationMs?: number;
}

/** Function step (spec §2.1): a TypeScript function the engine calls directly. */
export interface FunctionStep extends StepBase {
  readonly kind: "function";
  readonly outputSchema?: TSchema;
  readonly run: (args: StepRunArgs<unknown>) => unknown | Promise<unknown>;
}

/**
 * Agent step (spec §2.2): the engine runs it through the `HostPort.startAgent` seam. `outputSchema`
 * is required — the agent's final text is parsed to JSON and validated against it. `model` overrides
 * the workflow/session default (resolution: step → workflow default → session, spec §9.5).
 */
export interface AgentStep extends StepBase {
  readonly kind: "agent";
  readonly outputSchema: TSchema;
  readonly model?: string;
  readonly buildPrompt: (args: AgentPromptArgs<unknown>) => string;
  /**
   * In-session output-steering budget (spec §9.2): how many corrections to send after the first
   * reply when the output is invalid, before the step fails. Distinct from `retry.maxRetry`,
   * which restarts a fresh session on a transport error. Default 2.
   */
  readonly maxOutputRepairs?: number;
  /**
   * Q&A capability (spec §10.1), framework-set. When true, the agent's final message is the union
   * `{ result: <output> } | { questions: <Questionnaire> }` (the framework owns the questionnaire
   * schema and auto-injects the asking protocol). A `{questions}` blocks the run; the collected
   * answers resume the **same** agent loop (spec §8.4). When false/absent, the reply is the bare
   * `output` and the step can never block. Enabled via `createAgentStep({ asks: true })`.
   */
  readonly asks?: boolean;
  /**
   * Per-step token budget (spec §9.3): the summed usage across this step's turns (prompt + steering +
   * answer). Exceeding it fails the attempt with `budget-exceeded` — counted against the retry policy.
   */
  readonly maxTokens?: number;
}

/**
 * Questionnaire step (spec §2.4): a first-class, LLM-free step that only collects structured
 * input. It blocks with a questionnaire (derived from `outputSchema` or the explicit `questionnaire`
 * override); on answers, they are reassembled into the target shape and validated against
 * `outputSchema` to become the step's output. Invalid answers → re-block. Elicitation — an agent that
 * composes the questions — is an {@link AgentStep} with `asks: true`, not this kind.
 */
export interface QuestionnaireStep extends StepBase {
  readonly kind: "questionnaire";
  /** The annotated TypeBox target — the single source of truth for asking, rendering, and validating. */
  readonly outputSchema: TSchema;
  /** Explicit questionnaire override; when absent it is derived from `outputSchema` at run time. */
  readonly questionnaire?: Questionnaire;
}

/** A step at rest is one of the step kinds; the engine branches on `kind`. */
export type StepDefinition = FunctionStep | AgentStep | QuestionnaireStep;

/** A pure branch predicate over the run context (spec §3.2) — side-effect-free, keeps transitions deterministic. */
export type BranchCondition = (ctx: RunContext) => boolean;

/** A pure loop predicate (spec §3.3) over the run context and the body's most recent output. */
export type LoopCondition = (ctx: RunContext, lastOutput: unknown) => boolean;

/**
 * A pure item selector for a foreach (spec §3.4): derives the collection to iterate from the run
 * context. Must be side-effect-free and deterministic — a resume re-runs it and relies on it
 * yielding the same array so recorded per-item outputs line up by index.
 */
export type ForeachSelector = (ctx: RunContext) => readonly unknown[];

/**
 * A workflow is an ordered sequence of NODES (spec §3). A node is a step, a branch, a loop, a
 * foreach, or a nested workflow. The engine walks nodes with linear hand-off at the node level (a
 * node's output feeds the next). Branch arms, loop/foreach bodies, and nested workflows are
 * themselves sub-workflows, executed by the same engine recursively.
 */
export type WorkflowNode = StepNode | BranchNode | LoopNode | ForeachNode | NestedWorkflowNode;

/** Wraps a single step (function/agent/map) as a node. Behavior is identical to the pre-node model. */
export interface StepNode {
  readonly kind: "step";
  readonly step: StepDefinition;
}

/** One arm of a branch: a condition and the sub-workflow to run when it holds. `name` keys the branch output. */
export interface BranchArm {
  readonly name: string;
  readonly condition: BranchCondition;
  readonly body: WorkflowDefinition;
}

/** Branch node (spec §3.2): multi-match — every arm whose condition holds runs sequentially. */
export interface BranchNode {
  readonly kind: "branch";
  readonly name: string;
  readonly arms: readonly BranchArm[];
}

/** Loop node (spec §3.3): run `body`, evaluate `condition`, repeat; output is the last iteration's output. */
export interface LoopNode {
  readonly kind: "loop";
  readonly name: string;
  readonly mode: "dowhile" | "dountil";
  readonly body: WorkflowDefinition;
  readonly condition: LoopCondition;
  /** Mandatory guard: exceeding this many iterations crashes the run (prevents infinite loops). */
  readonly maxIterations: number;
}

/**
 * Foreach node (spec §3.4): run `body` once per selected item, sequentially, with the item as the
 * body's input. Output is the array of per-item body outputs, in order. Each item checkpoints, so a
 * top-level foreach resumes at the first unprocessed item (spec §8).
 */
export interface ForeachNode {
  readonly kind: "foreach";
  readonly name: string;
  readonly body: WorkflowDefinition;
  readonly selector: ForeachSelector;
}

/**
 * Nested-workflow node (spec §2.3/§11): runs a committed sub-workflow's nodes recursively under the
 * parent run-id and run context — transparent, so its steps fold into the parent event log and
 * `/workflow list` still shows one run. Output is the sub-workflow's final output. Resume is
 * node-atomic: an interrupted nested workflow re-runs wholesale.
 */
export interface NestedWorkflowNode {
  readonly kind: "workflow";
  readonly name: string;
  readonly workflow: WorkflowDefinition;
}

/** A workflow's shape at rest: a name plus an ordered sequence of nodes. */
export interface WorkflowDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: TSchema;
  /** Default model for agent steps that declare none (spec §9.5). */
  readonly defaultModel?: string;
  readonly nodes: readonly WorkflowNode[];
}

/** The addressing name of a node (step name for step nodes; declared name for branch/loop nodes). */
export function nodeName(node: WorkflowNode): string {
  return node.kind === "step" ? node.step.name : node.name;
}

/**
 * Depth-first, pre-order traversal of a node tree (spec §3): visits every node exactly once — each
 * top-level node, then recursively those inside its branch arms, loop/foreach body, and nested
 * workflow. The single place that knows the recursive tree shape; both name-uniqueness (flow) and
 * resume drift/prefix-seeding (engine) build on it.
 */
export function forEachNode(nodes: readonly WorkflowNode[], visit: (node: WorkflowNode) => void): void {
  for (const node of nodes) {
    visit(node);
    if (node.kind === "branch") {
      for (const arm of node.arms) forEachNode(arm.body.nodes, visit);
    } else if (node.kind === "loop" || node.kind === "foreach") {
      forEachNode(node.body.nodes, visit);
    } else if (node.kind === "workflow") {
      forEachNode(node.workflow.nodes, visit);
    }
  }
}

/** The set of every node name in the tree (recursively), built on {@link forEachNode}. */
export function collectNodeNames(nodes: readonly WorkflowNode[]): Set<string> {
  const names = new Set<string>();
  forEachNode(nodes, (node) => names.add(nodeName(node)));
  return names;
}
