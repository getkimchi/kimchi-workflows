import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import helloWorkflow from "../examples/hello.workflow.ts"
import { resumeWorkflow } from "../src/engine/resume-workflow.ts"
import { runWorkflow } from "../src/engine/run-workflow.ts"
import { createFsStore } from "../src/host/fs-store.ts"
import { createHostPort } from "../src/host/host-port.ts"
import { buildToggleWorkflow } from "./toggle-workflow.ts"

describe("resume across a fresh store instance (fs, spec §8.9)", () => {
	let runDir: string

	beforeEach(async () => {
		runDir = await mkdtemp(path.join(tmpdir(), "pi-workflows-resume-"))
	})

	afterEach(async () => {
		await rm(runDir, { recursive: true, force: true })
	})

	it("writes a partial run, then resumes it via a brand-new store instance to completed on disk", async () => {
		const { workflow, fixStep2 } = buildToggleWorkflow()

		// Process 1: run partially; crashes in s2 after s1 completes. Persisted to disk.
		const writerStore = createFsStore(runDir)
		const first = await runWorkflow(workflow, undefined, createHostPort(writerStore))
		expect(first.status).toBe("crashed")

		// Process 2: a fresh store instance over the same directory reads the persisted log and resumes.
		fixStep2()
		const readerStore = createFsStore(runDir)
		const priorEvents = await readerStore.loadEvents(first.runId)
		expect(priorEvents.some((event) => event.type === "step-completed" && event.path === "s1")).toBe(true)

		const resumed = await resumeWorkflow(workflow, priorEvents, createHostPort(readerStore))
		expect(resumed.status).toBe("completed")
		expect(resumed.runId).toBe(first.runId)

		// A third store instance confirms the completion is durable on disk.
		const runs = await createFsStore(runDir).list()
		expect(runs).toHaveLength(1)
		expect(runs[0]).toMatchObject({ runId: first.runId, workflowName: "toggle", status: "completed" })
	})

	// Provenance travels IN the log now (a `run-meta` event, spec §8.9) rather than in a metadata
	// sidecar: it survives a fresh store instance, and deleting the run takes it with it.
	it("round-trips run provenance through the log itself and honors delete", async () => {
		const store = createFsStore(runDir)
		const result = await runWorkflow(helloWorkflow, undefined, createHostPort(store))
		await store.appendEvent({
			type: "run-meta",
			runId: result.runId,
			workflowFilePath: "/abs/path/hello.workflow.ts",
			at: "2026-01-01T00:00:00.000Z",
		})

		const reloaded = await createFsStore(runDir).loadEvents(result.runId)
		expect(reloaded.find((event) => event.type === "run-meta")).toMatchObject({
			workflowFilePath: "/abs/path/hello.workflow.ts",
		})
		expect(await store.list()).toHaveLength(1)

		await store.delete(result.runId)

		expect(await store.loadEvents(result.runId)).toEqual([])
		expect(await store.list()).toEqual([])
	})
})
