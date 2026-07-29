import type { TSchema } from "typebox"
import type { Questionnaire } from "./questionnaire.ts"
import type { QuestionnaireStep } from "./types.ts"

export interface CreateQuestionnaireStepOptions<TOutputSchema extends TSchema> {
	/** Unique step name — used for data-flow addressing and event-log matching (spec §3). */
	name: string
	description?: string
	/** The annotated TypeBox target — the single source of truth for asking, rendering, and validating. */
	output: TOutputSchema
	/** Explicit questionnaire batch to ask; when absent it is derived from `output`. */
	questionnaire?: Questionnaire
}

/**
 * Questionnaire step (spec §2.4): collect structured input to satisfy an annotated target `output`
 * schema. Deterministic and LLM-free — the framework derives a questionnaire from `output` (or uses
 * the `questionnaire` override), blocks with it, and on answers reassembles + validates them into
 * `output`.
 *
 * For elicitation — an agent that composes and re-batches questions until it can satisfy `output` —
 * use `createAgentStep({ asks: true })` instead.
 */
export function createQuestionnaireStep<TOutputSchema extends TSchema>(
	options: CreateQuestionnaireStepOptions<TOutputSchema>,
): QuestionnaireStep {
	return {
		kind: "questionnaire",
		name: options.name,
		description: options.description,
		outputSchema: options.output,
		questionnaire: options.questionnaire,
	}
}
