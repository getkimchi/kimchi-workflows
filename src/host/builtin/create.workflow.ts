/**
 * The `/workflow create` meta-workflow: a workflow that writes workflows.
 *
 * It is an ordinary `WorkflowDefinition` — same authoring API, same engine, same event log — which
 * means it blocks, resumes, retries, and is testable exactly like any workflow a user writes.
 *
 * Shape (five top-level nodes):
 *
 *   brief          questionnaire step — what to build, and what to call the file
 *   target         function            — settle the destination, failing fast on a bad or taken name
 *   design         Q&A agent           — interview → propose plan → approve, all by re-batching
 *   until-valid    loop                — generate the source, load it back, retry on failure
 *   write          function            — write the validated source into .pi/workflows/
 *
 * `design` deliberately owns the entire interview *inside one step*. A blocked step can only be
 * answered when it is top-level (see resume-workflow.ts: "nested Q&A resume is out of scope"), so an
 * approval loop built from `.dountil` + a questionnaire step could never be resumed. A Q&A agent already
 * re-batches until it is satisfied, so the loop lives in the agent's own turn-taking and every block
 * stays top-level. The `until-valid` loop contains no Q&A, so nesting is legal there.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Static, Type } from "typebox";
import { createAgentStep, createQuestionnaireStep, createStep, createWorkflow } from "../../flow/index.ts";
import type { RunContext } from "../../flow/types.ts";
import { loadWorkflowFile } from "../load-workflow.ts";
import { WORKFLOW_SUFFIX, workflowsDir } from "../workflow-catalog.ts";

/** Initial input: the extension supplies the project root so steps can resolve paths without a cwd assumption. */
export const createInputSchema = Type.Object({ projectRoot: Type.String() });

/** What the interview must establish before any code is generated. */
export const specSchema = Type.Object({
  name: Type.String({ description: "The workflow's name (kebab-case)." }),
  description: Type.String({ description: "One line describing what the workflow does." }),
  summary: Type.String({ description: "The agreed plan, in prose, as approved by the user." }),
  steps: Type.Array(
    Type.Object({
      name: Type.String(),
      kind: Type.Union([Type.Literal("function"), Type.Literal("agent"), Type.Literal("questionnaire")]),
      purpose: Type.String(),
    }),
    { description: "The steps to generate, in order." },
  ),
});

const briefSchema = Type.Object({
  goal: Type.String({ title: "Goal", description: "What should this workflow do?", chat: true }),
  fileName: Type.String({ title: "File name", description: "File to write, e.g. `deploy.workflow.ts` (saved under .pi/workflows/)." }),
});

/**
 * A worked example of the authoring API, given to the generator verbatim.
 *
 * Naming the helper functions is not enough: models reliably hallucinate a fluent, Mastra-style API
 * (`.then(w => w.addStep(...))`, positional `createStep("name", {...})`) that type-checks in their
 * heads and imports cleanly, so only a shape check at `commit()` catches it. Showing the real shape
 * is what actually prevents it.
 */
const API_EXAMPLE = `import { Type } from "typebox";
import { createStep, createAgentStep, createQuestionnaireStep, createWorkflow } from "pi-workflows/src/flow";

const askSchema = Type.Object({
  topic: Type.String({ description: "What should we write about?" }),
});
const draftSchema = Type.Object({ draft: Type.String() });

const ask = createQuestionnaireStep({ name: "ask", output: askSchema });

const write = createAgentStep({
  name: "write",
  input: askSchema,
  output: draftSchema,
  prompt: ({ input }) => \`Write a short paragraph about \${input.topic}.\`,
});

const count = createStep({
  name: "count",
  input: draftSchema,
  output: Type.Object({ words: Type.Number() }),
  run: ({ input }) => ({ words: input.draft.split(/\\s+/).length }),
});

export default createWorkflow({ name: "writer", description: "Draft a paragraph and count its words" })
  .then(ask)
  .then(write)
  .then(count)
  .commit();`;

const sourceSchema = Type.Object({
  source: Type.String(),
  /**
   * What the agent did to check its own work. In the real harness an agent step runs the PI tool
   * loop (see host/pi-agent.ts), so it can actually run the project's `tsc`/`biome`; offline it
   * cannot, and is told to say so here rather than claim a check it never ran.
   */
  verification: Type.String({ description: "Which checks you ran and their result, or why you could not run any." }),
});
const checkSchema = Type.Object({ ok: Type.Boolean(), source: Type.String(), error: Type.Optional(Type.String()) });

/** Step 1 — the opening form. Deterministic, no LLM: two questions derived from the schema. */
const brief = createQuestionnaireStep({
  name: "brief",
  description: "What to build, and where to put it",
  output: briefSchema,
});

/**
 * Step 2 — settle the destination before spending anything on it.
 *
 * `resolveTarget` rejects a name that escapes the project or is already taken, and both are knowable
 * the moment the form is answered. Checking here costs milliseconds; checking at the write (where the
 * guard also runs, against a filesystem that may have changed since) would burn the whole interview
 * and a generation round first — and could not be recovered, since `brief` is already complete and a
 * resume would re-run the write with the same name.
 */
const settleTarget = createStep({
  name: "target",
  description: "Settle where the workflow will be written",
  output: Type.Object({ path: Type.String() }),
  run: ({ ctx }) => ({ path: resolveTarget(ctx) }),
});

/**
 * Step 3 — the interview. The framework injects the asking protocol, so this prompt is task-only; it
 * describes *when* to ask, *what* to propose, and the bar for emitting a result.
 */
const design = createAgentStep({
  name: "design",
  description: "Interview the user, propose a plan, and get approval",
  // No input schema (spec §3.6): the preceding node is `target`, so the brief is read from run
  // context rather than the linear hand-off.
  output: specSchema,
  asks: true,
  prompt: ({ ctx }) =>
    [
      "You are designing a PI workflow on the user's behalf.",
      "",
      `Their goal: ${ctx.getStepResult<Static<typeof briefSchema>>("brief")?.goal ?? "(not stated)"}`,
      "",
      "Work in two phases, using questionnaires for both:",
      "1. CLARIFY — ask batched questions until you genuinely know what to build: the steps, their order,",
      "   which need an LLM, which need input from the user, and how the workflow decides it is finished.",
      "   Do not guess at anything that would change the generated code. Do not ask what you can infer.",
      "2. APPROVE — once confident, present the plan for approval. Ask a single-choice question",
      '   ("Approve this plan?" with options "Approve" and "Revise") plus a free-text question for changes.',
      "   State the plan in the question text: the workflow name, and each step with its kind and purpose.",
      "",
      "If the user chooses Revise, incorporate the feedback and present the revised plan for approval again.",
      "Emit your result ONLY after the user has explicitly approved. The result's `summary` must be the",
      "plan exactly as approved.",
    ].join("\n"),
});

/**
 * Step 4a — generate the file's TypeScript. On a retry the previous validation error is in run
 * context, so the agent sees precisely why its last attempt failed to load.
 */
const generate = createAgentStep({
  name: "generate",
  description: "Write the workflow file's TypeScript source",
  // Deliberately no input schema (spec §3.6): on a retry the loop hands this step the previous
  // iteration's `check` output, not the spec — so the spec is read from run context instead.
  output: sourceSchema,
  prompt: ({ ctx }) => {
    const input = ctx.getStepResult<Static<typeof specSchema>>("design");
    if (!input) throw new Error("generate: the design step produced no spec");
    const previous = ctx.getStepResult<{ ok: boolean; error?: string }>("check");
    const retry = previous?.error ? ["", "Your previous attempt FAILED to load with:", previous.error, "Fix it."] : [];
    return [
      "Write a complete PI workflow TypeScript module implementing this approved plan.",
      "",
      `Name: ${input.name}`,
      `Description: ${input.description}`,
      `Plan: ${input.summary}`,
      "Steps:",
      ...input.steps.map((step) => `  - ${step.name} (${step.kind}): ${step.purpose}`),
      "",
      "The API is EXACTLY as shown below. Every helper takes ONE options object — there are no",
      "positional arguments, no `.addStep()`, and `.then()` takes a step value, never a callback.",
      "Follow this shape precisely:",
      "",
      API_EXAMPLE,
      "",
      "Requirements:",
      "  - use only the imports shown above; the package is `typebox`, not `@sinclair/typebox`",
      "  - every step needs a unique `name`; declare TypeBox `input`/`output` so steps hand off",
      "  - a function step's `run` receives ONE argument: `{ input, ctx, abortSignal, logger }`",
      "  - an agent step needs `output` and `prompt`; `prompt` is a function returning a string",
      "  - a questionnaire step needs only `name` and `output` — the questions come from the schema",
      "  - no side effects at import time — the module must only define and export the workflow",
      "  - EVERY step's input must come from somewhere: the previous step's output, or — for the FIRST",
      "    step — either a `createQuestionnaireStep` ahead of it or `input:` declared on `createWorkflow({...})`.",
      "    A first step with an `input` schema and no source can never run.",
      "",
      "CHECK YOUR OWN WORK. If the project has TypeScript or Biome available, run them over what you",
      "wrote (`tsc --noEmit`, `biome check`) and fix anything they report before replying. If neither",
      "tool is available, do not pretend otherwise — say so plainly in `verification`.",
      "",
      'Reply with ONLY JSON of the form {"source": "<the full file contents>", "verification": "<what you ran and what it said>"}.',
      ...retry,
    ].join("\n");
  },
});

/**
 * Where the generated workflow will land. A bare name goes to `.pi/workflows/` so the new workflow is
 * immediately discoverable by `/workflow list` and runnable by name; anything containing a separator
 * is a path relative to the project root.
 */
function resolveTarget(ctx: RunContext): string {
  const { projectRoot } = ctx.getInitData<{ projectRoot: string }>() ?? { projectRoot: process.cwd() };
  const { fileName } = ctx.getStepResult<{ fileName: string }>("brief") ?? { fileName: "untitled.workflow.ts" };
  const named = fileName.endsWith(".ts") ? fileName : `${fileName}${WORKFLOW_SUFFIX}`;
  const target = named.includes(path.sep) || named.includes("/") ? path.resolve(projectRoot, named) : path.join(workflowsDir(projectRoot), named);

  // Containment: `/workflow create` writes into the project, never outside it. `fileName` is free
  // text from the opening form, so `../../elsewhere.ts` would otherwise resolve anywhere on disk.
  const root = path.resolve(projectRoot);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`"${fileName}" resolves outside the project (${target}); choose a name inside ${root}`);
  }

  assertAvailable(target, fileName);
  return target;
}

/**
 * Refuse to write over an existing file. Generating a workflow must never destroy one, and quietly
 * choosing a different name would be worse than failing: the run would report success while the file
 * the user asked for still holds something else.
 *
 * Enforced from {@link resolveTarget}, so the clash surfaces at validation — before anything is
 * written — rather than at the final write.
 */
function assertAvailable(target: string, fileName: string): void {
  if (existsSync(target)) {
    throw new Error(`"${fileName}" already exists at ${target}; delete or rename it, or re-run with a different name`);
  }
}

/**
 * Step 4b — validate by actually loading it, in the directory the file will really live in.
 *
 * The probe MUST sit next to its final destination: module resolution is relative to the importing
 * file, so a generated `import { Type } from "typebox"` resolves only from inside the project. An
 * earlier version validated in `os.tmpdir()` — which has no `node_modules` — and so rejected every
 * generated workflow, however good, with "Cannot find module 'typebox'".
 *
 * The probe is named so discovery ignores it (no `.workflow.ts` suffix) and is always cleaned up.
 */
const check = createStep({
  name: "check",
  description: "Load the generated source to prove it is a valid workflow",
  input: sourceSchema,
  output: checkSchema,
  run: async ({ input, ctx }) => {
    const dir = path.dirname(resolveTarget(ctx));
    const probe = path.join(dir, `.pi-create-candidate-${randomUUID()}.ts`);
    await mkdir(dir, { recursive: true });
    await writeFile(probe, input.source, "utf8");
    try {
      // Imports must resolve and `commit()` must accept every step — the commit-time shape check
      // (src/flow/create-workflow.ts) is what rejects a hallucinated builder API here.
      await loadWorkflowFile(probe);
      return { ok: true, source: input.source };
    } catch (err) {
      return { ok: false, source: input.source, error: err instanceof Error ? err.message : String(err) };
    } finally {
      await rm(probe, { force: true });
    }
  },
});

const generateAndCheck = createWorkflow({ name: "generate-and-check" }).then(generate).then(check).commit();

/** Step 5 — write the validated source to the destination {@link resolveTarget} picked. */
const write = createStep({
  name: "write",
  description: "Write the validated workflow into the project",
  input: checkSchema,
  output: Type.Object({ path: Type.String() }),
  run: async ({ input, ctx, logger }) => {
    // Re-resolved here (not carried from `check`) so the availability guard is re-applied against the
    // filesystem as it is now, immediately before the write.
    const target = resolveTarget(ctx);
    const verification = ctx.getStepResult<{ verification?: string }>("generate")?.verification;
    if (verification) logger.info(`generator's own checks: ${verification}`);

    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, input.source, "utf8");
    return { path: target };
  },
});

const createWorkflowWorkflow = createWorkflow({
  name: "create-workflow",
  description: "Interview the user and generate a new workflow file",
  input: createInputSchema,
})
  .then(brief)
  .then(settleTarget)
  .then(design)
  .dountil(generateAndCheck, (ctx) => ctx.getStepResult<{ ok: boolean }>("check")?.ok === true, { name: "until-valid", maxIterations: 3 })
  .then(write)
  .commit();

export default createWorkflowWorkflow;
