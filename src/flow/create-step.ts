import type { Static, TSchema } from "typebox"
import type { FunctionStep, RetryPolicy, RunContext, StepRunArgs, StepRunFn } from "./types.ts"

/** Static type a step's `run` receives as `input`: the schema's Static type, or `undefined` when no input schema is declared. */
type InferInput<TInputSchema extends TSchema | undefined> = TInputSchema extends TSchema
	? Static<TInputSchema>
	: undefined

/** Static type a step's `run` must return: the schema's Static type, or `unknown` when no output schema is declared. */
type InferOutput<TOutputSchema extends TSchema | undefined> = TOutputSchema extends TSchema
	? Static<TOutputSchema>
	: unknown

/**
 * Configuration shared by a function step, including retry, duration, and optional-failure controls.
 *
 * @remarks
 * `retry.maxRetry` counts attempts after the first. `optional` should only be used when downstream
 * nodes do not require this step's output, because a final failure produces `undefined`.
 *
 * @workflowCapability steps
 * @workflowCapability advanced-agent
 */
export interface CreateStepOptions<
	TInputSchema extends TSchema | undefined = undefined,
	TOutputSchema extends TSchema | undefined = undefined,
> {
	/** Unique step name — used for data-flow addressing and event-log matching (spec §3). */
	name: string
	description?: string
	/** TypeBox schema for the step's input. Omit if the step ignores upstream output (spec §3.6). */
	input?: TInputSchema
	/** TypeBox schema for the step's output. */
	output?: TOutputSchema
	/** Unified repeat policy (spec §9.1): retry thrown errors / invalid output up to `maxRetry` times. */
	retry?: RetryPolicy
	/** Per-step wall-time budget in ms (spec §9.3): exceeding it aborts the step → `budget-exceeded`.
	 * A function is resolved once per execution, letting a step in a loop size itself from remaining time. */
	maxDurationMs?: number | ((args: { ctx: RunContext }) => number)
	/** Let the run continue when this step fails for good (spec §9.1): records `step-failed`, output is `undefined`. */
	optional?: boolean
	run: StepRunFn<InferInput<TInputSchema>, InferOutput<TOutputSchema>>
}

/**
 * Creates a TypeScript function step whose input and output types are inferred from its TypeBox schemas.
 *
 * @remarks
 * The engine validates `input` before calling `run` and validates the returned value against `output`.
 * The callback may use `ctx` for earlier results, `abortSignal` for cancellation, and `logger` for
 * structured run-log messages.
 *
 * @example
 * ```ts
 * const summarize = createStep({
 *   name: "summarize",
 *   input: Type.Array(Type.String()),
 *   output: Type.String(),
 *   run: ({ input }) => input.join("\n"),
 * })
 * ```
 *
 * @workflowCapability steps
 */
export function createStep<
	TInputSchema extends TSchema | undefined = undefined,
	TOutputSchema extends TSchema | undefined = undefined,
>(options: CreateStepOptions<TInputSchema, TOutputSchema>): FunctionStep {
	return {
		kind: "function",
		name: options.name,
		description: options.description,
		inputSchema: options.input,
		outputSchema: options.output,
		retry: options.retry,
		maxDurationMs: options.maxDurationMs,
		optional: options.optional,
		// Single, narrow type-erasure boundary: the author's `run` is precisely typed against
		// the declared schemas; the engine calls steps with a runtime-determined `unknown` input
		// and validates it against `inputSchema` before this cast is ever exercised.
		run: (args: StepRunArgs<unknown>) => options.run(args as StepRunArgs<InferInput<TInputSchema>>),
	}
}
