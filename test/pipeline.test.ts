import { describe, expect, it } from "vitest";
import pipelineWorkflow from "../examples/pipeline.workflow.ts";
import { runWorkflow } from "../src/engine/run-workflow.ts";
import { createTestHost } from "./helpers.ts";

describe("pipeline workflow (Phase 2: linear hand-off + .map non-adjacent data flow)", () => {
  it("runs the 3-step pipeline to completed with the combined final output", async () => {
    const { host } = createTestHost();
    const result = await runWorkflow(pipelineWorkflow, undefined, host);

    expect(result.status).toBe("completed");
    // count=3 comes from the adjacent hand-off (parse -> count); firstWord="hello" comes from the
    // .map reaching back to parse non-adjacently. Both feed summarize's input.
    expect(result.output).toEqual({ summary: '3 words, starting with "hello"' });
  });

  it("feeds parse's output into count adjacently (linear hand-off)", async () => {
    const { host, events } = createTestHost();

    await runWorkflow(pipelineWorkflow, undefined, host);

    const countStarted = events.find((event) => event.type === "step-started" && event.stepName === "count");
    expect(countStarted).toMatchObject({ type: "step-started", input: { words: ["hello", "workflow", "pipeline"] } });
  });

  it("builds summarize's input from a non-adjacent step via .map", async () => {
    const { host, events } = createTestHost();

    await runWorkflow(pipelineWorkflow, undefined, host);

    // summarize's input is the map's output: parse's firstWord (non-adjacent) + count's count.
    const summarizeStarted = events.find((event) => event.type === "step-started" && event.stepName === "summarize");
    expect(summarizeStarted).toMatchObject({ type: "step-started", input: { count: 3, firstWord: "hello" } });
  });

  it("records the map's execution in the event log", async () => {
    const { host, events } = createTestHost();

    await runWorkflow(pipelineWorkflow, undefined, host);

    const mapEvents = events.filter((event) => "stepName" in event && event.stepName === "combine").map((event) => event.type);
    expect(mapEvents).toEqual(["step-started", "step-completed"]);

    const mapCompleted = events.find((event) => event.type === "step-completed" && event.stepName === "combine");
    expect(mapCompleted).toMatchObject({ type: "step-completed", output: { count: 3, firstWord: "hello" } });
  });

  it("emits the full ordered step sequence including the map step", async () => {
    const { host, events } = createTestHost();

    await runWorkflow(pipelineWorkflow, undefined, host);

    const stepStarts = events.filter((event) => event.type === "step-started").map((event) => event.stepName);
    expect(stepStarts).toEqual(["parse", "count", "combine", "summarize"]);
  });
});
