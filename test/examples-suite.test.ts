import { describe, expect, it } from "vitest";
import batchWorkflow from "../examples/batch.workflow.ts";
import helloWorkflow from "../examples/hello.workflow.ts";
import pipelineWorkflow from "../examples/pipeline.workflow.ts";
import planningWorkflow from "../examples/planning.workflow.ts";
import surveyWorkflow from "../examples/survey.workflow.ts";
import { ask, createTestRun, reply } from "../src/testing/index.ts";

/**
 * Consolidated end-to-end run of every example through the engine, offline and deterministic: the
 * LLM-free ones as-is, the agent-bearing `planning` one with its agent scripted. The remaining
 * agent examples (summarize, review-loop) run live in the gated `*.integration.test.ts` suite.
 */
describe("example suite (offline)", () => {
  it("hello: a single function step", async () => {
    const run = await createTestRun(helloWorkflow);
    expect(run.status).toBe("completed");
    expect(run.output).toEqual({ message: "Hello, PI workflows!" });
  });

  it("pipeline: linear hand-off + non-adjacent .map()", async () => {
    const run = await createTestRun(pipelineWorkflow);
    expect(run.status).toBe("completed");
    expect(run.output).toEqual({ summary: '3 words, starting with "hello"' });
  });

  it("batch: sequential foreach over a list", async () => {
    const run = await createTestRun(batchWorkflow);
    expect(run.status).toBe("completed");
    expect(run.output).toEqual([{ doubled: 2 }, { doubled: 4 }, { doubled: 6 }, { doubled: 8 }]);
  });

  it("survey: an input form gathers structured input, then a later step consumes it", async () => {
    const parked = await createTestRun(surveyWorkflow);
    expect(parked.status).toBe("parked");
    expect(parked.questionKeys()).toEqual(["name", "environment"]);

    const done = await parked.answer({ name: "Ada", environment: "prod" });
    expect(done.status).toBe("completed");
    expect(done.output).toEqual({ message: "Hello Ada, deploying to prod." });
  });

  it("planning: a Q&A agent asks before planning, then a function step consumes the plan", async () => {
    const parked = await createTestRun(planningWorkflow, {
      agents: {
        plan: [
          ask({ questions: [{ key: "backend", header: "Backend", question: "Which cache backend?", kind: "text" }] }),
          reply({ steps: ["add a redis client", "wrap the handlers"], summary: "Redis cache" }),
        ],
      },
    });

    expect(parked.status).toBe("parked");
    expect(parked.questionKeys()).toEqual(["backend"]);

    const done = await parked.answer({ backend: "Redis" });
    expect(done.status).toBe("completed");
    expect(done.output).toEqual({ message: "Plan ready with 2 steps: Redis cache" });
  });
});
