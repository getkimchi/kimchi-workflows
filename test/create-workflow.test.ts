import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import createWorkflowWorkflow from "../src/host/builtin/create.workflow.ts";
import { loadWorkflowFile } from "../src/host/load-workflow.ts";
import { workflowsDir } from "../src/host/workflow-catalog.ts";
import { ask, createTestRun, reply } from "../src/testing/index.ts";

/**
 * The `/workflow create` meta-workflow, driven end-to-end offline: its `design` agent is scripted,
 * so the whole interview → approve → generate → validate → write path runs with no model.
 */

const flowImport = path.resolve(import.meta.dirname, "../src/flow/index.ts");

/** A valid generated module. Absolute import: the file is written to a temp dir with no node_modules. */
const validSource = [
  `import { createStep, createWorkflow } from "${flowImport}";`,
  `const greet = createStep({ name: "greet", run: () => ({ message: "hi" }) });`,
  `export default createWorkflow({ name: "greeter", description: "says hi" }).then(greet).commit();`,
].join("\n");

const spec = {
  name: "greeter",
  description: "says hi",
  summary: "One function step that returns a greeting.",
  steps: [{ name: "greet", kind: "function" as const, purpose: "return a greeting" }],
};

const clarify = ask({ questions: [{ key: "detail", header: "Detail", question: "What should it greet?", kind: "text" }] });
const approval = ask({
  questions: [
    {
      key: "approve",
      header: "Approve",
      question: "Approve this plan?",
      kind: "single",
      options: [
        { value: "yes", label: "Approve" },
        { value: "no", label: "Revise" },
      ],
    },
    { key: "feedback", header: "Changes", question: "Anything to change?", kind: "text" },
  ],
});

const projectRoot = () => mkdtemp(path.join(tmpdir(), "pi-create-"));

describe("/workflow create meta-workflow", () => {
  it("interviews, proposes a plan, and writes the approved workflow into .pi/workflows/", async () => {
    const root = await projectRoot();

    // 1. The opening form (deterministic, no LLM).
    const brief = await createTestRun(createWorkflowWorkflow, {
      input: { projectRoot: root },
      agents: {
        design: [clarify, approval, reply(spec)],
        generate: [reply({ source: validSource, verification: "ran tsc --noEmit: clean" })],
      },
    });

    expect(brief.status).toBe("blocked");
    expect(brief.stepName).toBe("brief");
    expect(brief.questionKeys()).toEqual(["goal", "fileName"]);

    // 2. The design agent clarifies, then proposes the plan for approval — both inside ONE step,
    //    so every block stays top-level and therefore resumable.
    const clarifying = await brief.answer({ goal: "greet the user", fileName: "greeter.workflow.ts" });
    expect(clarifying.status).toBe("blocked");
    expect(clarifying.stepName).toBe("design");
    expect(clarifying.questionKeys()).toEqual(["detail"]);

    const approving = await clarifying.answer({ detail: "the world" });
    expect(approving.status).toBe("blocked");
    expect(approving.questionKeys()).toEqual(["approve", "feedback"]);

    // 3. Approval releases the result; generate → check → write follow with no further questions.
    const done = await approving.answer({ approve: "yes", feedback: "" });
    expect(done.status).toBe("completed");

    const written = path.join(workflowsDir(root), "greeter.workflow.ts");
    expect(done.output).toEqual({ path: written });
    expect(await readFile(written, "utf8")).toBe(validSource);

    // The file it wrote is a real, loadable workflow.
    const loaded = await loadWorkflowFile(written);
    expect(loaded.name).toBe("greeter");
    expect(loaded.description).toBe("says hi");
  });

  it("retries generation when the produced source does not load, and reports the error to the agent", async () => {
    const root = await projectRoot();

    const run = await createTestRun(createWorkflowWorkflow, {
      input: { projectRoot: root },
      agents: {
        design: [reply(spec)], // approves immediately
        generate: [
          reply({ source: "export default { not: 'a workflow' };", verification: "no tooling available" }),
          reply({ source: validSource, verification: "ran tsc --noEmit: clean" }),
        ],
      },
    });

    const done = await run.answer({ goal: "greet the user", fileName: "greeter.workflow.ts" });

    expect(done.status).toBe("completed");
    expect(done.eventsOf("loop-iteration")).toHaveLength(2); // first generation rejected, second accepted
    // The retry prompt carried the loader's complaint, so the agent could see what was wrong.
    expect(done.agent("generate").messages[1]).toMatch(/previous attempt FAILED/);
    expect(done.agent("generate").messages[1]).toMatch(/does not export a workflow/);
    expect(await readFile(path.join(workflowsDir(root), "greeter.workflow.ts"), "utf8")).toBe(validSource);
  });

  it("crashes rather than writing a broken workflow when generation never validates", async () => {
    const root = await projectRoot();
    const bad = reply({ source: "export default { not: 'a workflow' };", verification: "no tooling available" });

    const run = await createTestRun(createWorkflowWorkflow, {
      input: { projectRoot: root },
      agents: { design: [reply(spec)], generate: [bad, bad, bad] },
    });

    const crashed = await run.answer({ goal: "greet", fileName: "greeter.workflow.ts" });

    expect(crashed.status).toBe("crashed");
    expect(crashed.error).toMatch(/exceeded its max of 3 iterations/);
    expect(crashed.eventsOf("step-completed").some((event) => event.stepName === "write")).toBe(false);
  });

  it("appends the .workflow.ts suffix when the user gives a bare name", async () => {
    const root = await projectRoot();

    const run = await createTestRun(createWorkflowWorkflow, {
      input: { projectRoot: root },
      agents: { design: [reply(spec)], generate: [reply({ source: validSource, verification: "ran tsc --noEmit: clean" })] },
    });

    const done = await run.answer({ goal: "greet", fileName: "greeter" });

    expect(done.status).toBe("completed");
    expect(done.output).toEqual({ path: path.join(workflowsDir(root), "greeter.workflow.ts") });
  });

  it("treats a name containing a separator as a path relative to the project root", async () => {
    const root = await projectRoot();

    const run = await createTestRun(createWorkflowWorkflow, {
      input: { projectRoot: root },
      agents: { design: [reply(spec)], generate: [reply({ source: validSource, verification: "ran tsc --noEmit: clean" })] },
    });

    const done = await run.answer({ goal: "greet", fileName: "flows/greeter.workflow.ts" });

    expect(done.status).toBe("completed");
    expect(done.output).toEqual({ path: path.join(root, "flows", "greeter.workflow.ts") });
  });
});

describe("/workflow create never destroys existing work (adversarial regression)", () => {
  const scripted = {
    design: [reply(spec)],
    generate: [reply({ source: validSource, verification: "ran tsc --noEmit: clean" })],
  };

  it("rejects a taken name before the interview, so nothing is spent on it", async () => {
    const root = await projectRoot();
    await mkdir(workflowsDir(root), { recursive: true });
    await writeFile(path.join(workflowsDir(root), "greeter.workflow.ts"), "// taken\n", "utf8");

    // No agent scripts at all: if the interview were reached, the double would throw for the
    // unscripted `design` step. Crashing cleanly proves the name is settled before any model runs.
    const run = await createTestRun(createWorkflowWorkflow, { input: { projectRoot: root } });
    const clash = await run.answer({ goal: "greet", fileName: "greeter.workflow.ts" });

    expect(clash.status).toBe("crashed");
    expect(clash.error).toMatch(/already exists/);
    expect(clash.eventsOf("step-started").map((event) => event.stepName)).toEqual(["brief", "target"]);
  });

  it("rejects an escaping name before the interview too", async () => {
    const root = await projectRoot();

    const run = await createTestRun(createWorkflowWorkflow, { input: { projectRoot: root } });
    const escaped = await run.answer({ goal: "greet", fileName: "../escaped.workflow.ts" });

    expect(escaped.status).toBe("crashed");
    expect(escaped.error).toMatch(/resolves outside the project/);
    expect(escaped.eventsOf("step-started").map((event) => event.stepName)).toEqual(["brief", "target"]);
  });

  it("fails rather than overwriting an existing file, and leaves it untouched", async () => {
    const root = await projectRoot();
    const taken = path.join(workflowsDir(root), "greeter.workflow.ts");
    await mkdir(workflowsDir(root), { recursive: true });
    await writeFile(taken, "// hand-written, precious\n", "utf8");

    const run = await createTestRun(createWorkflowWorkflow, { input: { projectRoot: root }, agents: scripted });
    const clash = await run.answer({ goal: "greet", fileName: "greeter.workflow.ts" });

    expect(clash.status).toBe("crashed");
    expect(clash.error).toMatch(/already exists/);
    expect(clash.error).toMatch(/re-run with a different name/);
    expect(await readFile(taken, "utf8")).toBe("// hand-written, precious\n"); // untouched
    expect(clash.eventsOf("step-completed").some((event) => event.stepName === "write")).toBe(false);
  });

  it("refuses a file name that escapes the project root", async () => {
    const root = await projectRoot();

    const run = await createTestRun(createWorkflowWorkflow, { input: { projectRoot: root }, agents: scripted });
    const escaped = await run.answer({ goal: "greet", fileName: "../escaped.workflow.ts" });

    expect(escaped.status).toBe("crashed");
    expect(escaped.error).toMatch(/resolves outside the project/);
  });
});
