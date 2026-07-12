import type { TSchema } from "typebox";
import type { Questionnaire } from "./questionnaire.ts";
import type { AgentStep, InputStep } from "./types.ts";

/** Elicitation (agent) options for `createInputStep`. Presence of `agent` enables agent mode. */
export interface InputAgentOptions {
  /** Model override in `provider/modelId` form (spec §9.5). */
  model?: string;
  /** Task-only instructions for the agent; the framework auto-injects the asking protocol. */
  instructions?: string;
  /** In-session output-steering budget (spec §9.2). Default 2. */
  maxOutputRepairs?: number;
  /** Per-step token budget (spec §9.3). */
  maxTokens?: number;
}

export interface CreateInputStepOptions<TOutputSchema extends TSchema> {
  /** Unique step name — used for data-flow addressing and event-log matching (spec §3). */
  name: string;
  description?: string;
  /** The annotated TypeBox target — the single source of truth for asking, rendering, and validating. */
  output: TOutputSchema;
  /** Explicit questionnaire (form mode: the batch to ask; agent mode: a seed). Else derived from `output`. */
  questionnaire?: Questionnaire;
  /** Enable elicitation mode: an agent composes/vets the questionnaire until it can satisfy `output`. */
  agent?: InputAgentOptions | true;
}

/**
 * Input step (spec §2.4): collect structured input to satisfy an annotated target `output` schema.
 *
 * - **Form mode** (no `agent`): the framework derives a questionnaire from `output` (or uses the
 *   `questionnaire` override), parks with it, and on answers reassembles + validates them into
 *   `output`. Deterministic, no LLM. Returns an {@link InputStep}.
 * - **Agent (elicitation) mode** (`agent` present): a Q&A-capable agent composes the questionnaire,
 *   parks, receives answers, and re-batches until it emits a `{result}` satisfying `output`. Returns
 *   an {@link AgentStep} with `asks: true`; the framework owns the questionnaire schema + asking
 *   protocol, so `instructions` are task-only.
 */
export function createInputStep<TOutputSchema extends TSchema>(options: CreateInputStepOptions<TOutputSchema>): InputStep | AgentStep {
  if (options.agent) {
    const agent = options.agent === true ? {} : options.agent;
    const seed = options.questionnaire ? `\n\nSuggested starting questions:\n${JSON.stringify(options.questionnaire, null, 2)}` : "";
    const instructions = agent.instructions ?? "Collect the information required to produce the target output.";
    return {
      kind: "agent",
      name: options.name,
      description: options.description,
      outputSchema: options.output,
      model: agent.model,
      asks: true,
      maxOutputRepairs: agent.maxOutputRepairs,
      maxTokens: agent.maxTokens,
      buildPrompt: () => `${instructions}${seed}`,
    };
  }

  return {
    kind: "input",
    name: options.name,
    description: options.description,
    outputSchema: options.output,
    questionnaire: options.questionnaire,
  };
}
