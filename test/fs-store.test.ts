import { existsSync } from "node:fs"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import helloWorkflow from "../examples/hello.workflow.ts"
import { runWorkflow } from "../src/engine/run-workflow.ts"
import type { RunEvent } from "../src/engine/types.ts"
import { createStep, createWorkflow } from "../src/flow/index.ts"
import { createFsStore } from "../src/host/fs-store.ts"
import { createHostPort } from "../src/host/host-port.ts"

describe("filesystem run store (spec §8.9)", () => {
	// The already-resolved run-artifacts directory (project-dir.ts decides where it is; this file only
	// owns the format), which in a real run also holds the step session files this store must ignore.
	let runDir: string

	beforeEach(async () => {
		runDir = await mkdtemp(path.join(tmpdir(), "pi-workflows-"))
	})

	afterEach(async () => {
		await rm(runDir, { recursive: true, force: true })
	})

	it("persists an append-only JSONL event log as <run-id>.events.jsonl", async () => {
		const store = createFsStore(runDir)
		const host = createHostPort(store)

		const result = await runWorkflow(helloWorkflow, undefined, host)
		expect(result.status).toBe("completed")

		const files = await readdir(runDir)
		expect(files).toEqual([`${result.runId}.events.jsonl`])

		const content = await readFile(path.join(runDir, files[0] ?? ""), "utf8")
		const lines = content.trim().split("\n")
		const parsedTypes = lines.map((line) => (JSON.parse(line) as { type: string }).type)
		expect(parsedTypes).toEqual(["run-started", "step-started", "step-completed", "run-completed"])
	})

	it("list() reconstructs run summaries from disk, independent of the writing process", async () => {
		const writerStore = createFsStore(runDir)
		const writerHost = createHostPort(writerStore)
		const result = await runWorkflow(helloWorkflow, undefined, writerHost)

		// A fresh store instance over the same directory — simulates a new process reading the log.
		const readerStore = createFsStore(runDir)
		const runs = await readerStore.list()

		expect(runs).toHaveLength(1)
		expect(runs[0]).toMatchObject({ runId: result.runId, workflowName: "hello", status: "completed" })
	})

	it("list() returns an empty array when no runs have been recorded, creating nothing (spec §14.6)", async () => {
		expect(await createFsStore(runDir).list()).toEqual([])

		// Completion lists runs on a keystroke, so `list()` is a pure read: an invocation whose artifacts
		// directory does not exist yet is told "no runs" rather than handed a freshly created directory.
		const absent = path.join(runDir, "never-used")
		expect(await createFsStore(absent).list()).toEqual([])
		expect(existsSync(absent)).toBe(false)
	})

	// Run logs and step session files share one directory now (project-dir.ts), so the `.events.jsonl`
	// suffix is what tells them apart. A bare `.jsonl` scan would parse every step session as a run log.
	it("list() ignores the step session files sitting in the same directory", async () => {
		const store = createFsStore(runDir)
		const result = await runWorkflow(helloWorkflow, undefined, createHostPort(store))

		await writeFile(
			path.join(runDir, "workflow-hello-run-1a2b3c4d-verify-a1.jsonl"),
			'{"type":"session","id":"s1"}\n',
			"utf8",
		)
		await writeFile(path.join(runDir, "workflow-hello-key-worker.jsonl"), '{"type":"session","id":"s2"}\n', "utf8")

		expect((await store.list()).map((run) => run.runId)).toEqual([result.runId])
	})

	it("delete() removes the run's log and nothing else in the directory", async () => {
		const store = createFsStore(runDir)
		const result = await runWorkflow(helloWorkflow, undefined, createHostPort(store))
		await writeFile(path.join(runDir, "workflow-hello-key-worker.jsonl"), '{"type":"session","id":"s2"}\n', "utf8")

		await store.delete(result.runId)

		expect(await store.loadEvents(result.runId)).toEqual([])
		expect(await readdir(runDir)).toEqual(["workflow-hello-key-worker.jsonl"])
	})

	it("preserves on-disk event order even for a fire-and-forget logger.info write", async () => {
		// The engine emits `step-log` fire-and-forget (`void host.emit(...)`). This asserts the fs
		// store's FIFO append queue keeps it strictly ordered between step-started and step-completed,
		// and that it is flushed to disk by the time the awaited terminal event resolves.
		const logging = createStep({
			name: "logging-step",
			run: ({ logger }) => {
				logger.info("mid-step log line", { marker: true })
				return { ok: true }
			},
		})
		const workflow = createWorkflow({ name: "logging" }).then(logging).commit()

		const store = createFsStore(runDir)
		const result = await runWorkflow(workflow, undefined, createHostPort(store))
		expect(result.status).toBe("completed")

		const types = await readEventTypes(runDir, result.runId)
		expect(types).toEqual(["run-started", "step-started", "step-log", "step-completed", "run-completed"])
	})

	it("serializes concurrent fire-and-forget appends into call order (FIFO queue)", async () => {
		// Directly exercises the store's append queue under contention: many un-awaited appends
		// followed by a single awaited one. Without the queue, concurrent `appendFile` calls to the
		// same file interleave and land out of order (verified); the queue guarantees FIFO, and
		// awaiting the final append flushes all prior writes.
		const store = createFsStore(runDir)
		const runId = "concurrent-run"
		const count = 30

		let lastAppend: Promise<void> = Promise.resolve()
		for (let i = 0; i < count; i++) {
			lastAppend = store.appendEvent({
				type: "step-log",
				runId,
				path: "s",
				level: "info",
				message: `m${i}`,
				at: "t",
			})
		}
		await lastAppend

		const content = await readFile(path.join(runDir, `${runId}.events.jsonl`), "utf8")
		const messages = content
			.trim()
			.split("\n")
			.map((line) => (JSON.parse(line) as { message: string }).message)

		expect(messages).toEqual(Array.from({ length: count }, (_, i) => `m${i}`))
	})

	// A process killed mid-append (spec §7.3's stale-lock case) leaves a half-written last line. That
	// append never completed, so the run must still load — and `run list`, which reads every log, must
	// not be taken down by one of them.
	it("loads a log whose last line was truncated by a killed process", async () => {
		const store = createFsStore(runDir)
		const result = await runWorkflow(helloWorkflow, undefined, createHostPort(store))
		const logPath = path.join(runDir, `${result.runId}.events.jsonl`)

		const intact = await readFile(logPath, "utf8")
		await writeFile(logPath, `${intact}{"type":"step-star`, "utf8")

		const events = await store.loadEvents(result.runId)
		expect(events.map((event) => event.type)).toEqual([
			"run-started",
			"step-started",
			"step-completed",
			"run-completed",
		])
		expect(await store.list()).toHaveLength(1)
	})

	it("refuses a log corrupted in the middle rather than silently dropping the event", async () => {
		const store = createFsStore(runDir)
		const result = await runWorkflow(helloWorkflow, undefined, createHostPort(store))
		const logPath = path.join(runDir, `${result.runId}.events.jsonl`)

		const lines = (await readFile(logPath, "utf8")).trim().split("\n")
		lines.splice(1, 0, "{ truncated mid-file")
		await writeFile(logPath, `${lines.join("\n")}\n`, "utf8")

		await expect(store.loadEvents(result.runId)).rejects.toThrow(/corrupt run log .* at line 2/)
	})
})

async function readEventTypes(dir: string, runId: string): Promise<string[]> {
	const content = await readFile(path.join(dir, `${runId}.events.jsonl`), "utf8")
	return content
		.trim()
		.split("\n")
		.map((line) => (JSON.parse(line) as RunEvent).type)
}
