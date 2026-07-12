/**
 * Phase 4a example: a single agent step that summarizes text into a structured object.
 *
 * Run it: `/workflow run examples/summarize.workflow.ts` inside the kimchi harness (the agent step
 * runs on the session model, or `kimchi-dev/kimi-k2.7` when set as the default). The engine parses
 * the model's final message as JSON and validates it against `output`.
 */
import { Type } from "typebox";
import { createAgentStep, createStep, createWorkflow } from "../src/flow/index.ts";

export const summarySchema = Type.Object({
  summary: Type.String(),
  keywords: Type.Array(Type.String()),
});

const sampleText = createStep({
  name: "sample-text",
  output: Type.Object({ text: Type.String() }),
  run: () => ({
    text: "TypeBox is a runtime type system for TypeScript. It builds JSON Schema objects whose static types are inferred, so the same schema validates data at runtime and types it at compile time.",
  }),
});

const summarize = createAgentStep({
  name: "summarize",
  input: Type.Object({ text: Type.String() }),
  output: summarySchema,
  model: "kimchi-dev/kimi-k2.7",
  prompt: ({ input }) =>
    [
      "Summarize the text below.",
      'Reply with ONLY a JSON object of the form {"summary": string, "keywords": string[]} and nothing else.',
      "",
      input.text,
    ].join("\n"),
});

const summarizeWorkflow = createWorkflow({
  name: "summarize",
  description: "Summarize text into a structured object (Phase 4a agent step)",
})
  .then(sampleText)
  .then(summarize)
  .commit();

export default summarizeWorkflow;
