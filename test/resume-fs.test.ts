import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import helloWorkflow from "../examples/hello.workflow.ts";
import { resumeWorkflow } from "../src/engine/resume-workflow.ts";
import { runWorkflow } from "../src/engine/run-workflow.ts";
import { createFsRunStore } from "../src/host/fs-run-store.ts";
import { createHostPort } from "../src/host/host-port.ts";
import type { RunMeta } from "../src/host/types.ts";
import { buildToggleWorkflow } from "./toggle-workflow.ts";

describe("resume across a fresh store instance (fs, spec §8.7)", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(path.join(tmpdir(), "pi-workflows-resume-"));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("writes a partial run, then resumes it via a brand-new store instance to completed on disk", async () => {
    const { workflow, fixStep2 } = buildToggleWorkflow();

    // Process 1: run partially; crashes in s2 after s1 completes. Persisted to disk.
    const writerStore = createFsRunStore(projectRoot);
    const first = await runWorkflow(workflow, undefined, createHostPort(writerStore));
    expect(first.status).toBe("crashed");

    // Process 2: a fresh store instance over the same directory reads the persisted log and resumes.
    fixStep2();
    const readerStore = createFsRunStore(projectRoot);
    const priorEvents = await readerStore.loadEvents(first.runId);
    expect(priorEvents.some((event) => event.type === "step-completed" && event.stepName === "s1")).toBe(true);

    const resumed = await resumeWorkflow(workflow, priorEvents, createHostPort(readerStore));
    expect(resumed.status).toBe("completed");
    expect(resumed.runId).toBe(first.runId);

    // A third store instance confirms the completion is durable on disk.
    const runs = await createFsRunStore(projectRoot).list();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ runId: first.runId, workflowName: "toggle", status: "completed" });
  });

  it("round-trips run metadata and honors delete for both events and meta sidecar", async () => {
    const store = createFsRunStore(projectRoot);
    const result = await runWorkflow(helloWorkflow, undefined, createHostPort(store));

    const meta: RunMeta = { workflowFilePath: "/abs/path/hello.workflow.ts", workflowName: "hello" };
    await store.saveMeta(result.runId, meta);

    expect(await store.loadMeta(result.runId)).toEqual(meta);
    expect(await store.list()).toHaveLength(1);

    await store.delete(result.runId);

    expect(await store.loadMeta(result.runId)).toBeUndefined();
    expect(await store.loadEvents(result.runId)).toEqual([]);
    expect(await store.list()).toEqual([]);
  });
});
