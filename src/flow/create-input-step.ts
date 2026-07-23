import type { TSchema } from "typebox";
import type { Questionnaire } from "./questionnaire.ts";
import type { InputStep } from "./types.ts";

export interface CreateInputStepOptions<TOutputSchema extends TSchema> {
  /** Unique step name — used for data-flow addressing and event-log matching (spec §3). */
  name: string;
  description?: string;
  /** The annotated TypeBox target — the single source of truth for asking, rendering, and validating. */
  output: TOutputSchema;
  /** Explicit questionnaire batch to ask; when absent it is derived from `output`. */
  questionnaire?: Questionnaire;
}

/**
 * Input step (spec §2.4): collect structured input to satisfy an annotated target `output` schema.
 * Deterministic and LLM-free — the framework derives a questionnaire from `output` (or uses the
 * `questionnaire` override), parks with it, and on answers reassembles + validates them into `output`.
 *
 * For elicitation — an agent that composes and re-batches questions until it can satisfy `output` —
 * use `createAgentStep({ asks: true })` instead.
 */
export function createInputStep<TOutputSchema extends TSchema>(options: CreateInputStepOptions<TOutputSchema>): InputStep {
  return {
    kind: "input",
    name: options.name,
    description: options.description,
    outputSchema: options.output,
    questionnaire: options.questionnaire,
  };
}
