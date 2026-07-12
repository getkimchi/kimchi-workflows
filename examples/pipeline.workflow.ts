/**
 * Phase 2 example: a multi-step pipeline demonstrating both data-flow rules.
 *
 *   parse ──(linear hand-off)──▶ count
 *     │                            │
 *     └──────────┐        ┌────────┘
 *                ▼        ▼
 *              .map "combine"  (reads parse's output NON-adjacently via ctx.getStepResult,
 *                               plus count's output)  ──(linear hand-off)──▶ summarize
 *
 * - `count` consumes `parse`'s output directly (adjacent linear hand-off, spec §3.6).
 * - the `.map` reaches back to `parse` — which is no longer the previous step — and combines it
 *   with `count` to build `summarize`'s input (non-adjacent data flow, spec §3.7).
 */
import { Type } from "typebox";
import { createStep, createWorkflow } from "../src/flow/index.ts";

const wordsSchema = Type.Object({ words: Type.Array(Type.String()) });
const countSchema = Type.Object({ count: Type.Integer({ minimum: 0 }) });
const combinedSchema = Type.Object({ count: Type.Integer({ minimum: 0 }), firstWord: Type.String() });
export const summarySchema = Type.Object({ summary: Type.String() });

const parse = createStep({
  name: "parse",
  output: wordsSchema,
  run: () => ({ words: ["hello", "workflow", "pipeline"] }),
});

const count = createStep({
  name: "count",
  input: wordsSchema, // adjacent hand-off: receives `parse`'s output
  output: countSchema,
  run: ({ input }) => ({ count: input.words.length }),
});

const summarize = createStep({
  name: "summarize",
  input: combinedSchema, // receives the `.map` output
  output: summarySchema,
  run: ({ input }) => ({ summary: `${input.count} words, starting with "${input.firstWord}"` }),
});

const pipelineWorkflow = createWorkflow({ name: "pipeline", description: "Parse, count, and summarize (Phase 2)" })
  .then(parse)
  .then(count)
  .map(
    (ctx) => ({
      // `count` is the previous step (adjacent), but `parse` is two steps back (non-adjacent):
      count: ctx.getStepResult<{ count: number }>("count")?.count ?? 0,
      firstWord: ctx.getStepResult<{ words: string[] }>("parse")?.words[0] ?? "",
    }),
    { name: "combine" },
  )
  .then(summarize)
  .commit();

export default pipelineWorkflow;
