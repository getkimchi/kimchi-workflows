import type { Static, TSchema } from "typebox";
import type { AgentPromptArgs, AgentStep, RetryPolicy, RunContext } from "./types.ts";

/** Static type the `prompt` builder receives as `input`: the input schema's Static type, or `undefined` when none. */
type InferInput<TInputSchema extends TSchema | undefined> = TInputSchema extends TSchema ? Static<TInputSchema> : undefined;

export interface CreateAgentStepOptions<TInputSchema extends TSchema | undefined, TOutputSchema extends TSchema> {
  /** Unique step name — used for data-flow addressing and event-log matching (spec §3). */
  name: string;
  description?: string;
  /** TypeBox schema for the step's input. Omit if the prompt ignores upstream output (spec §3.6). */
  input?: TInputSchema;
  /** REQUIRED TypeBox schema: the agent's final text is parsed to JSON and validated against it. */
  output: TOutputSchema;
  /** Model override in `provider/modelId` form. Falls back to the workflow default, then the session (spec §9.5). */
  model?: string;
  /** Build the user message from the validated input and run context. Task-only when `asks` is set —
   * the framework auto-injects the asking protocol. */
  prompt: (args: AgentPromptArgs<InferInput<TInputSchema>>) => string;
  /** Enable Q&A (spec §10.1): the agent may block with a `{questions}` batch before its `{result}`. */
  asks?: boolean;
  /** Unified repeat policy (spec §9.1): a transport/thrown error restarts a fresh agent session. */
  retry?: RetryPolicy;
  /** In-session output-steering budget (spec §9.2): corrections to attempt on invalid output. Default 2. */
  maxOutputRepairs?: number;
  /** Per-step wall-time budget in ms (spec §9.3): exceeding it aborts the step → `budget-exceeded`.
   * A function is resolved once per execution, letting a step in a loop size itself from remaining time. */
  maxDurationMs?: number | ((args: { ctx: RunContext }) => number);
  /** Let the run continue when this step fails for good (spec §9.1): records `step-failed`, output is `undefined`. */
  optional?: boolean;
  /** Per-step token budget (spec §9.3): summed turn usage over this → `budget-exceeded`. */
  maxTokens?: number;
  /**
   * Run as an isolated PI subagent (spec §2.2): own context window and tool loop, no access to the
   * parent session's history. Never combine with `asks: true` — `.commit()` rejects it (spec §10.1).
   */
  background?: boolean;
  /** Continue this step's conversation across executions instead of starting cold (spec §2.2). */
  resumable?: boolean;
}

/** Agent step (spec §2.2). Runs the agent loop via the host and validates its structured output. */
export function createAgentStep<TInputSchema extends TSchema | undefined = undefined, TOutputSchema extends TSchema = TSchema>(
  options: CreateAgentStepOptions<TInputSchema, TOutputSchema>,
): AgentStep {
  return {
    kind: "agent",
    name: options.name,
    description: options.description,
    inputSchema: options.input,
    outputSchema: options.output,
    model: options.model,
    asks: options.asks,
    retry: options.retry,
    maxOutputRepairs: options.maxOutputRepairs,
    maxDurationMs: options.maxDurationMs,
    optional: options.optional,
    maxTokens: options.maxTokens,
    background: options.background,
    resumable: options.resumable,
    // Single, narrow type-erasure boundary: the author's `prompt` is precisely typed against the
    // declared input schema; the engine calls it with a runtime-validated `unknown` input.
    buildPrompt: (args) => options.prompt(args as AgentPromptArgs<InferInput<TInputSchema>>),
  };
}
