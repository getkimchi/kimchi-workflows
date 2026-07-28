import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { parsePath, staticKeyOf } from "../src/engine/node-path.ts";
import { resumeWithAnswer } from "../src/engine/resume-workflow.ts";
import { runWorkflow } from "../src/engine/run-workflow.ts";
import type { RunResult } from "../src/engine/types.ts";
import type { Question, Questionnaire } from "../src/flow/questionnaire.ts";
import type { WorkflowDefinition } from "../src/flow/types.ts";
import { forEachNode } from "../src/flow/types.ts";
import createWorkflowWorkflow from "../src/host/builtin/create.workflow.ts";
import { loadWorkflowFile } from "../src/host/load-workflow.ts";
import { workflowsDir } from "../src/host/project-dir.ts";
import { createTestRun, raw, reply } from "../src/testing/index.ts";
import { createTestHost } from "./helpers.ts";
import { createKimiAgentStarter, resolveKimiApiKey } from "./kimi-agent.ts";

/**
 * Real E2E for `/workflow create`: the meta-workflow driven end to end against live open-weight
 * models, with the interview answered programmatically.
 *
 * This is the one test where the generated file must be genuinely loadable, so it writes into THIS
 * repo's own workflows directory — the same place the command writes in a real project — proving that the
 * `@pmateusz/pi-workflows` import the generator is told to emit actually resolves.
 */
const apiKey = resolveKimiApiKey();

/** Models under test: the gateway's open-weight options. */
const MODELS = ["kimchi-dev/kimi-k2.7", "kimchi-dev/minimax-m3"] as const;

/** Hard cap on interview rounds, so a model that never stops asking fails the test instead of hanging. */
const MAX_ROUNDS = 10;

const GOAL = [
  "A workflow that reviews a git diff.",
  "Step 1: an agent step that reads a diff string and returns a list of review comments.",
  "Step 2: a function step that counts the comments and returns a one-line verdict.",
  "No user input beyond the diff. Keep it to exactly two steps.",
].join(" ");

/** Does this option mean "yes, go ahead"? Used to approve the plan whatever wording the model chose. */
const APPROVES = /approv|accept|yes|proceed|looks good|ok\b/i;

/**
 * Answer one questionnaire without a human. Single-choice questions take the approving option when
 * one exists (so the plan gets approved rather than endlessly revised); everything else gets a
 * neutral, non-committal answer that lets the model use its judgment.
 */
function autoAnswer(questionnaire: Questionnaire): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const question of questionnaire.questions) {
    answers[question.key] = answerOne(question);
  }
  return answers;
}

function answerOne(question: Question): unknown {
  const options = question.options ?? [];
  switch (question.kind) {
    case "single": {
      const approving = options.find((option) => APPROVES.test(option.label) || APPROVES.test(option.value));
      return (approving ?? options[0])?.value ?? "";
    }
    case "multi":
      return options.length > 0 ? [options[0]?.value ?? ""] : [];
    case "text":
    case "chat":
      return "Use your best judgment; no further constraints.";
  }
}

/** Run the meta-workflow to completion, answering every block along the way. */
async function createWorkflowE2E(model: string, fileName: string, projectRoot: string): Promise<{ result: RunResult; rounds: number }> {
  const { host, store } = createTestHost({ startAgent: createKimiAgentStarter(apiKey ?? "") });

  // Pin every agent step in the meta-workflow to the model under test.
  const underTest = { ...createWorkflowWorkflow, defaultModel: model };

  let result = await runWorkflow(underTest, { projectRoot }, host);
  let rounds = 0;

  while (result.status === "blocked" && rounds < MAX_ROUNDS) {
    rounds += 1;
    const questionnaire = result.questionnaire;
    if (!questionnaire) throw new Error("blocked with no questionnaire");

    // The opening form is the only step whose answers must be exact; the rest are auto-answered.
    const answers = result.path === "brief" ? { goal: GOAL, fileName } : autoAnswer(questionnaire);

    console.log(`[create-e2e ${model}] round ${rounds} @ ${result.path}:`, questionnaire.questions.map((q) => q.key).join(", "));
    const started = Date.now();
    result = await resumeWithAnswer(underTest, await store.loadEvents(result.runId), answers, host);
    console.log(`[create-e2e ${model}]   round ${rounds} took ${Math.round((Date.now() - started) / 1000)}s → ${result.status}`);
  }

  // Surface why generation failed, if it did — the check step records the loader's complaint.
  // `check` lives inside the `until-valid` loop (spec §6.6), so match by STATIC path (spec §5.4),
  // not the bare name — its dynamic path carries the iteration index.
  for (const event of await store.loadEvents(result.runId)) {
    if (event.type === "step-completed" && staticKeyOf(parsePath(event.path)) === "until-valid/check") {
      const output = event.output as { ok: boolean; error?: string; source: string };
      if (!output.ok) {
        console.log(`[create-e2e ${model}] check REJECTED: ${output.error}`);
        console.log(`[create-e2e ${model}] source was:\n${output.source.slice(0, 1200)}`);
      }
    }
  }

  return { result, rounds };
}

/**
 * Execute a generated workflow offline. Agent steps are scripted with a value derived from their own
 * declared output schema (`Value.Create`), and questions are answered generically — so this asserts
 * the generated workflow's wiring, not the model's prose.
 */
async function smokeRun(workflow: WorkflowDefinition, model: string): Promise<RunResult> {
  const agents: Record<string, ReturnType<typeof reply>[]> = {};
  forEachNode(workflow.nodes, (node) => {
    if (node.kind === "step" && node.step.kind === "agent") {
      // A step with no declared schema acts rather than reports: any text is a valid reply.
      const schema = node.step.outputSchema;
      agents[node.step.name] = [schema ? reply(Value.Create(schema)) : raw("done")];
    }
  });

  // Supply top-level input when the workflow declares a schema for it (spec §3.9).
  const input = workflow.inputSchema ? Value.Create(workflow.inputSchema) : undefined;
  let run = await createTestRun(workflow, { agents, input });
  for (let round = 0; run.status === "blocked" && round < MAX_ROUNDS; round++) {
    const questionnaire = run.questionnaire;
    if (!questionnaire) break;
    console.log(`[create-e2e ${model}] smoke answering: ${questionnaire.questions.map((q) => q.key).join(", ")}`);
    run = await run.answer(smokeAnswers(questionnaire));
  }
  return { runId: run.runId, status: run.status, output: run.output, error: run.error };
}

/** Generic answers that satisfy an unknown schema: a non-empty string, a first option, an empty list. */
function smokeAnswers(questionnaire: Questionnaire): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const question of questionnaire.questions) {
    const options = question.options ?? [];
    if (question.kind === "single") answers[question.key] = options[0]?.value ?? "sample";
    else if (question.kind === "multi") answers[question.key] = [];
    else answers[question.key] = "sample input for the smoke run";
  }
  return answers;
}

describe.skipIf(!apiKey)("/workflow create E2E (open-weight models)", () => {
  for (const model of MODELS) {
    it(`interviews, plans, generates, and writes a loadable workflow with ${model}`, async () => {
      if (!apiKey) throw new Error("unreachable: skipIf guards this");

      const projectRoot = path.resolve(import.meta.dirname, "..");
      const fileName = `e2e-${model.split("/")[1]}.workflow.ts`;
      const target = path.join(workflowsDir(projectRoot), fileName);
      await mkdir(workflowsDir(projectRoot), { recursive: true });
      await rm(target, { force: true });

      try {
        const { result, rounds } = await createWorkflowE2E(model, fileName, projectRoot);

        console.log(`[create-e2e ${model}] status=${result.status} rounds=${rounds}`, result.error ?? "");
        expect(result.status).toBe("completed");
        expect(result.output).toEqual({ path: target });

        // The real payoff: the file it wrote is a genuine, loadable workflow.
        const source = await readFile(target, "utf8");
        console.log(`[create-e2e ${model}] generated ${source.split("\n").length} lines`);
        const loaded = await loadWorkflowFile(target);

        console.log(`[create-e2e ${model}] loaded workflow "${loaded.name}" with ${loaded.nodes.length} node(s)`);
        expect(loaded.name.length).toBeGreaterThan(0);
        expect(loaded.nodes.length).toBeGreaterThan(0);

        // The real proof: execute what it generated, offline. Agent steps are scripted with a
        // schema-derived stub, so this exercises the generated workflow's own wiring — that its
        // steps are well-formed and their input/output schemas actually hand off.
        const smoke = await smokeRun(loaded, model);
        console.log(`[create-e2e ${model}] smoke run: ${smoke.status}`, smoke.error ?? "");
        expect(smoke.status).toBe("completed");
      } finally {
        // KEEP_GENERATED=1 leaves the generated file behind for inspection.
        if (!process.env.KEEP_GENERATED) await rm(target, { force: true });
      }
      // Generous: an interview plus up to three whole-file generations, all against a live model.
    }, 600_000);
  }
});
