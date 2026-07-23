import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import helloWorkflow from "../examples/hello.workflow.ts";
import { runWorkflow } from "../src/engine/run-workflow.ts";
import type { RunEvent } from "../src/engine/types.ts";
import { createStep, createWorkflow } from "../src/flow/index.ts";
import { createFsRunStore } from "../src/host/fs-run-store.ts";
import { createHostPort } from "../src/host/host-port.ts";

describe("filesystem run store (spec §8.7)", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(path.join(tmpdir(), "pi-workflows-"));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("persists an append-only JSONL event log under .pi/workflows/<run-id>.jsonl", async () => {
    const store = createFsRunStore(projectRoot);
    const host = createHostPort(store);

    const result = await runWorkflow(helloWorkflow, undefined, host);
    expect(result.status).toBe("completed");

    const workflowsDir = path.join(projectRoot, ".pi", "workflows");
    const files = await readdir(workflowsDir);
    expect(files).toEqual([`${result.runId}.jsonl`]);

    const content = await readFile(path.join(workflowsDir, files[0] ?? ""), "utf8");
    const lines = content.trim().split("\n");
    const parsedTypes = lines.map((line) => (JSON.parse(line) as { type: string }).type);
    expect(parsedTypes).toEqual(["run-started", "step-started", "step-completed", "run-completed"]);
  });

  it("list() reconstructs run summaries from disk, independent of the writing process", async () => {
    const writerStore = createFsRunStore(projectRoot);
    const writerHost = createHostPort(writerStore);
    const result = await runWorkflow(helloWorkflow, undefined, writerHost);

    // A fresh store instance over the same directory — simulates a new process reading the log.
    const readerStore = createFsRunStore(projectRoot);
    const runs = await readerStore.list();

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ runId: result.runId, workflowName: "hello", status: "completed" });
  });

  it("list() returns an empty array when no runs have been recorded", async () => {
    const store = createFsRunStore(projectRoot);
    expect(await store.list()).toEqual([]);
  });

  it("preserves on-disk event order even for a fire-and-forget logger.info write", async () => {
    // The engine emits `step-log` fire-and-forget (`void host.emit(...)`). This asserts the fs
    // store's FIFO append queue keeps it strictly ordered between step-started and step-completed,
    // and that it is flushed to disk by the time the awaited terminal event resolves.
    const logging = createStep({
      name: "logging-step",
      run: ({ logger }) => {
        logger.info("mid-step log line", { marker: true });
        return { ok: true };
      },
    });
    const workflow = createWorkflow({ name: "logging" }).then(logging).commit();

    const store = createFsRunStore(projectRoot);
    const result = await runWorkflow(workflow, undefined, createHostPort(store));
    expect(result.status).toBe("completed");

    const workflowsDir = path.join(projectRoot, ".pi", "workflows");
    const types = await readEventTypes(workflowsDir, result.runId);
    expect(types).toEqual(["run-started", "step-started", "step-log", "step-completed", "run-completed"]);
  });

  it("serializes concurrent fire-and-forget appends into call order (FIFO queue)", async () => {
    // Directly exercises the store's append queue under contention: many un-awaited appends
    // followed by a single awaited one. Without the queue, concurrent `appendFile` calls to the
    // same file interleave and land out of order (verified); the queue guarantees FIFO, and
    // awaiting the final append flushes all prior writes.
    const store = createFsRunStore(projectRoot);
    const runId = "concurrent-run";
    const count = 30;

    let lastAppend: Promise<void> = Promise.resolve();
    for (let i = 0; i < count; i++) {
      lastAppend = store.appendEvent({
        type: "step-log",
        runId,
        stepName: "s",
        level: "info",
        message: `m${i}`,
        time: "t",
      });
    }
    await lastAppend;

    const content = await readFile(path.join(projectRoot, ".pi", "workflows", `${runId}.jsonl`), "utf8");
    const messages = content
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { message: string }).message);

    expect(messages).toEqual(Array.from({ length: count }, (_, i) => `m${i}`));
  });
});

async function readEventTypes(workflowsDir: string, runId: string): Promise<string[]> {
  const content = await readFile(path.join(workflowsDir, `${runId}.jsonl`), "utf8");
  return content
    .trim()
    .split("\n")
    .map((line) => (JSON.parse(line) as RunEvent).type);
}
