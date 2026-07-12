import { describe, expect, it } from "vitest";
import batchWorkflow from "../examples/batch.workflow.ts";
import helloWorkflow from "../examples/hello.workflow.ts";
import pipelineWorkflow from "../examples/pipeline.workflow.ts";
import surveyWorkflow from "../examples/survey.workflow.ts";
import { resumeWithAnswer } from "../src/engine/resume-workflow.ts";
import { runWorkflow } from "../src/engine/run-workflow.ts";
import { createTestHost } from "./helpers.ts";

/**
 * Consolidated end-to-end run of every LLM-free example through the engine with the fake host
 * (offline, deterministic). Agent-bearing examples (summarize, review-loop, planning) run live in
 * the gated `*.integration.test.ts` suite against kimchi-dev/kimi-k2.7.
 */
describe("example suite (offline, function-only + questionnaire)", () => {
  it("hello: a single function step", async () => {
    const { host, store } = createTestHost();
    const result = await runWorkflow(helloWorkflow, undefined, host);
    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ message: "Hello, PI workflows!" });
    expect((await store.list())[0]).toMatchObject({ workflowName: "hello", status: "completed" });
  });

  it("pipeline: linear hand-off + non-adjacent .map()", async () => {
    const { host } = createTestHost();
    const result = await runWorkflow(pipelineWorkflow, undefined, host);
    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ summary: '3 words, starting with "hello"' });
  });

  it("batch: sequential foreach over a list", async () => {
    const { host } = createTestHost();
    const result = await runWorkflow(batchWorkflow, undefined, host);
    expect(result.status).toBe("completed");
    expect(result.output).toEqual([{ doubled: 2 }, { doubled: 4 }, { doubled: 6 }, { doubled: 8 }]);
  });

  it("survey: an input form gathers structured input, then a later step consumes it", async () => {
    const { host, store } = createTestHost();
    const parked = await runWorkflow(surveyWorkflow, undefined, host);
    expect(parked.status).toBe("parked");

    const done = await resumeWithAnswer(surveyWorkflow, await store.loadEvents(parked.runId), { name: "Ada", environment: "prod" }, host);
    expect(done.status).toBe("completed");
    expect(done.output).toEqual({ message: "Hello Ada, deploying to prod." });
  });
});
