import type { Static, TSchema } from "typebox"
import type { AgentPromptArgs, AgentStep, RetryPolicy, RunContext } from "./types.ts"

/** Static type the `prompt` builder receives as `input`: the input schema's Static type, or `undefined` when none. */
type InferInput<TInputSchema extends TSchema | undefined> = TInputSchema extends TSchema
	? Static<TInputSchema>
	: undefined

/**
 * Agent-step configuration, including model selection, output repair, budgets, isolation, and resumability.
 *
 * @remarks
 * An acting agent omits `output`. A reporting agent declares `output`; an asking agent additionally sets
 * `asks: true`. Asking cannot be combined with `background`. Static resumable keys cannot be shared by
 * executions that may overlap.
 *
 * @workflowCapability steps
 * @workflowCapability advanced-agent
 */
export interface CreateAgentStepOptions<TInputSchema extends TSchema | undefined, TOutputSchema extends TSchema> {
	/** Unique step name — used for data-flow addressing and event-log matching (spec §3). */
	name: string
	description?: string
	/** TypeBox schema for the step's input. Omit if the prompt ignores upstream output (spec §3.6). */
	input?: TInputSchema
	/**
	 * TypeBox schema the agent's submitted result is validated against. The step reports by calling
	 * `workflow_submit_result`; assistant text is never read as output.
	 *
	 * Omit it for a step that ACTS rather than REPORTS: no contract is injected, no tool is offered, and
	 * the raw final text becomes the output. Use that when the step's product is its side effects and
	 * something else establishes whether they happened — requiring a structured reply there only adds a
	 * way to fail at work that already succeeded. Required when `asks` is set (the questionnaire is
	 * derived from it).
	 */
	output?: TOutputSchema
	/** Model override in `provider/modelId` form. Falls back to the workflow default, then the session (spec §9.5). */
	model?: string
	/** Build the user message from the validated input and run context. Task-only when `asks` is set —
	 * the framework auto-injects the asking protocol. */
	prompt: (args: AgentPromptArgs<InferInput<TInputSchema>>) => string
	/** Enable Q&A (spec §10.1): the agent may block with a `{questions}` batch before its `{result}`. */
	asks?: boolean
	/** Unified repeat policy (spec §9.1): a transport/thrown error restarts a fresh agent session. */
	retry?: RetryPolicy
	/** In-session output-steering budget (spec §9.2): corrections to attempt on invalid output. Default 2. */
	maxOutputRepairs?: number
	/** Per-step wall-time budget in ms (spec §9.3): exceeding it aborts the step → `budget-exceeded`.
	 * A function is resolved once per execution, letting a step in a loop size itself from remaining time. */
	maxDurationMs?: number | ((args: { ctx: RunContext }) => number)
	/** Let the run continue when this step fails for good (spec §9.1): records `step-failed`, output is `undefined`. */
	optional?: boolean
	/** Per-step token budget (spec §9.3): summed turn usage over this → `budget-exceeded`. */
	maxTokens?: number
	/**
	 * Run as an isolated PI subagent (spec §2.2): own context window and tool loop, no access to the
	 * parent session's history. Never combine with `asks: true` — `.commit()` rejects it (spec §10.1).
	 */
	background?: boolean
	/**
	 * Continue this step's conversation across executions instead of starting cold (spec §2.2).
	 *
	 * `true` keys it by the step's own name. A string names a conversation shared with every other step
	 * declaring the same key — one orchestrator session taking turns across several steps. Steps sharing
	 * a key may not overlap; `.commit()` rejects a shared key on an isolated step.
	 *
	 * A function computes the key per execution, which is how each ITEM of a `.foreach` continues its own
	 * conversation — `true` cannot say that, since it keys by the step's name and every item runs the
	 * same named step. Checked at runtime rather than at `.commit()`; see `AgentStep.resumable`.
	 */
	resumable?: boolean | string | ((args: { ctx: RunContext }) => string)
}

/**
 * Creates an agent step that acts, reports structured output, or interactively asks for information.
 *
 * @remarks
 * Omit `output` for an acting step whose result is its side effects. Declare `output` for a reporting
 * step; the agent must call `workflow_submit_result` with a matching value. Add `asks: true` when it may submit
 * questionnaire batches before its result. Never combine `asks: true` with `background: true`.
 *
 * @example
 * ```ts
 * const review = createAgentStep({
 *   name: "review",
 *   input: changeSchema,
 *   output: reviewSchema,
 *   prompt: ({ input }) => `Review ${input.path}`,
 * })
 * ```
 *
 * @workflowCapability steps
 */
export function createAgentStep<
	TInputSchema extends TSchema | undefined = undefined,
	TOutputSchema extends TSchema = TSchema,
>(options: CreateAgentStepOptions<TInputSchema, TOutputSchema>): AgentStep {
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
	}
}
