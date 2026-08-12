import type { Static, TSchema } from "typebox"
import type { InteractionRenderArgs, InteractionRequestArgs, InteractiveStep } from "./types.ts"

type InferInput<TInputSchema extends TSchema | undefined> = TInputSchema extends TSchema
	? Static<TInputSchema>
	: undefined

/**
 * Configuration for a workflow-defined interaction rendered by the attended PI host.
 * @workflowCapability interactive
 */
export interface CreateInteractiveStepOptions<
	TInputSchema extends TSchema | undefined,
	TRequestSchema extends TSchema,
	TOutputSchema extends TSchema,
> {
	name: string
	description?: string
	/** Optional linear hand-off contract. Omit when the request uses only `ctx`. */
	input?: TInputSchema
	/** Contract for the exact request persisted in the run log. */
	request: TRequestSchema
	/** Contract for the response that becomes this step's output. */
	output: TOutputSchema
	/** Pure, deterministic request construction. The engine invokes this once on a fresh execution. */
	buildRequest: (args: InteractionRequestArgs<InferInput<TInputSchema>>) => Static<TRequestSchema>
	/** PI-host renderer. Returning `undefined` dismisses without resolving the blocked step. */
	render: (
		args: InteractionRenderArgs<Static<TRequestSchema>>,
	) => Static<TOutputSchema> | undefined | Promise<Static<TOutputSchema> | undefined>
}

/**
 * Create a resumable interactive step whose request and response types are inferred from TypeBox.
 *
 * The engine remains UI-free: it persists the request and returns `blocked`. Only an attended host
 * invokes `render`, after the engine call has ended. Offline callers can inspect the pending request
 * and submit a response directly without loading PI UI.
 *
 * @workflowCapability interactive
 */
export function createInteractiveStep<
	TInputSchema extends TSchema | undefined = undefined,
	TRequestSchema extends TSchema = TSchema,
	TOutputSchema extends TSchema = TSchema,
>(options: CreateInteractiveStepOptions<TInputSchema, TRequestSchema, TOutputSchema>): InteractiveStep {
	return {
		kind: "interactive",
		name: options.name,
		description: options.description,
		inputSchema: options.input,
		requestSchema: options.request,
		outputSchema: options.output,
		buildRequest: (args) => options.buildRequest(args as InteractionRequestArgs<InferInput<TInputSchema>>),
		render: (args) => options.render(args as InteractionRenderArgs<Static<TRequestSchema>>),
	}
}
