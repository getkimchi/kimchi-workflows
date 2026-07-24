import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import pipelineWorkflow, { summarySchema } from "../examples/pipeline.workflow.ts";
import { resumeWorkflow } from "../src/engine/resume-workflow.ts";
import { runWorkflow } from "../src/engine/run-workflow.ts";
import { createStep, createWorkflow } from "../src/flow/index.ts";
import { createTestHost } from "./helpers.ts";

describe("nested-workflow node (Phase 7a, spec §2.3/§11)", () => {
  it("runs a sub-workflow's nodes under the parent run-id and hands its output to the next node", async () => {
    // Parent = [nested pipeline] -> wrap(pipeline output).
    const wrap = createStep({
      name: "wrap",
      input: summarySchema,
      output: Type.Object({ wrapped: Type.String() }),
      run: ({ input }) => ({ wrapped: `[${input.summary}]` }),
    });
    const parent = createWorkflow({ name: "parent-pipeline" }).workflow(pipelineWorkflow).then(wrap).commit();

    const { host, store } = createTestHost();
    const result = await runWorkflow(parent, undefined, host);

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ wrapped: '[3 words, starting with "hello"]' });

    const events = await store.loadEvents(result.runId);
    // Child steps folded under the PARENT run-id (transparent), addressed under the nested workflow's
    // own path segment (spec §8.5/§11.1: `audit/lint`) — here `pipeline/<step>`.
    for (const child of ["pipeline/parse", "pipeline/count", "pipeline/summarize"]) {
      const completed = events.find((e) => e.type === "step-completed" && e.path === child);
      expect(completed, `child step "${child}" folded into parent log`).toBeDefined();
      expect(completed?.runId).toBe(result.runId);
    }
    // The nested-workflow node has its own node lifecycle.
    expect(events.some((e) => e.type === "node-started" && e.path === "pipeline" && e.nodeKind === "workflow")).toBe(true);
    expect(events.some((e) => e.type === "node-completed" && e.path === "pipeline")).toBe(true);

    // `list` shows exactly ONE run (§11: a nested workflow is transparent).
    expect(await store.list()).toHaveLength(1);
  });

  it("re-runs an interrupted nested workflow wholesale on resume", async () => {
    const calls = { inner: 0 };
    let failInner = true;
    const inner = createWorkflow({ name: "inner" })
      .then(
        createStep({
          name: "inner-step",
          output: Type.Object({ v: Type.Integer() }),
          run: () => {
            calls.inner += 1;
            if (failInner) throw new Error("boom in nested");
            return { v: 1 };
          },
        }),
      )
      .commit();
    const before = createStep({ name: "before", output: Type.Object({ ok: Type.Boolean() }), run: () => ({ ok: true }) });
    const parent = createWorkflow({ name: "parent-resume" }).then(before).workflow(inner, { name: "nested" }).commit();

    const { host, store } = createTestHost();
    const first = await runWorkflow(parent, undefined, host);
    expect(first.status).toBe("crashed");
    expect(calls.inner).toBe(1);

    const priorEvents = await store.loadEvents(first.runId);
    expect(priorEvents.some((e) => e.type === "node-completed" && e.path === "nested")).toBe(false); // nested interrupted

    failInner = false;
    const resumed = await resumeWorkflow(parent, priorEvents, host);

    expect(resumed.status).toBe("completed");
    expect(resumed.output).toEqual({ v: 1 });
    // `before` (completed prefix) NOT re-run; the nested workflow re-ran wholesale.
    const beforeReruns = (await store.loadEvents(first.runId)).filter((e) => e.type === "step-started" && e.path === "before").length;
    expect(beforeReruns).toBe(1);
    expect(calls.inner).toBe(2); // nested inner step re-ran from scratch
  });

  it("rejects nesting the same sub-workflow twice (duplicate names) at commit()", () => {
    const sub = createWorkflow({ name: "sub" })
      .then(createStep({ name: "sub-step", run: () => 1 }))
      .commit();
    expect(() => createWorkflow({ name: "dupe-nest" }).workflow(sub).workflow(sub).commit()).toThrow(/duplicate node\/step name/);
  });

  it("keeps a nested step's output addressable via getStepResult from a later parent node, using an explicit path", async () => {
    // A bare "parse" would NOT resolve here (spec §3.9): `reader` is a sibling of the nested
    // workflow, not a descendant of it, so "parse" is outside its lexical scope — the nested
    // workflow's own path segment (spec §8.5/§11.1) disambiguates it explicitly.
    const reader = createStep({
      name: "reader",
      output: Type.Object({ firstWord: Type.String() }),
      run: ({ ctx }) => ({ firstWord: ctx.getStepResult<{ words: string[] }>("pipeline/parse")?.words[0] ?? "" }),
    });
    const parent = createWorkflow({ name: "reader-parent" }).workflow(pipelineWorkflow).then(reader).commit();

    const { host } = createTestHost();
    const result = await runWorkflow(parent, undefined, host);
    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ firstWord: "hello" });
  });
});
