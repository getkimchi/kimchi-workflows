import { mkdtemp, rm } from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { RunResult } from "../src/engine/types.ts"
import { createActiveRuns } from "../src/host/active-runs.ts"
import { handleCancel, handleDelete, runTracked } from "../src/host/commands/index.ts"
import { createFsStore, RunExecutionAlreadyOwnedError } from "../src/host/fs-store.ts"
import { createHostPort } from "../src/host/host-port.ts"
import { projectRunEvents, projectRunSummaries, reconcileAbandonedRun } from "../src/host/reconcile-runs.ts"
import type { RunExecutionOwner } from "../src/host/types.ts"

const AT = "2026-08-18T12:00:00.000Z"

function owner(ownerId: string, host = hostname(), pid = 100): RunExecutionOwner {
	return { ownerId, host, pid, processStartedAt: AT }
}

function notifySpy() {
	const notes: string[] = []
	return { notes, ctx: { ui: { notify: (message: string) => void notes.push(message) } } }
}

describe("durable workflow execution leases", () => {
	const dirs: string[] = []

	afterEach(async () => {
		await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
	})

	async function tempDir(): Promise<string> {
		const dir = await mkdtemp(path.join(tmpdir(), "workflow-lease-"))
		dirs.push(dir)
		return dir
	}

	it("atomically excludes a second owner of the same run id", async () => {
		const dir = await tempDir()
		const first = createFsStore(dir, { executionOwner: owner("owner-a"), isProcessAlive: () => true })
		const second = createFsStore(dir, { executionOwner: owner("owner-b", hostname(), 200), isProcessAlive: () => true })

		const lease = await first.executions?.acquire("run-1")
		expect(lease).toBeDefined()
		await expect(second.executions?.acquire("run-1")).rejects.toMatchObject({
			name: RunExecutionAlreadyOwnedError.name,
			execution: { state: "live", lease: { executionId: lease?.executionId } },
		})

		expect(await first.executions?.release(lease!)).toBe(true)
		await expect(second.executions?.acquire("run-1")).resolves.toMatchObject({ runId: "run-1" })
	})

	it("never guesses whether a foreign-host owner is alive", async () => {
		const dir = await tempDir()
		const remote = createFsStore(dir, { executionOwner: owner("remote", "worker-2", 300) })
		await remote.executions?.acquire("run-1")
		let livenessChecks = 0
		const local = createFsStore(dir, {
			executionOwner: owner("local"),
			isProcessAlive: () => {
				livenessChecks += 1
				return false
			},
		})

		expect(await local.executions?.inspect("run-1")).toMatchObject({ state: "foreign" })
		expect(livenessChecks).toBe(0)
	})

	it("reconciles a provably dead local executor as crashed, never cancelled", async () => {
		const dir = await tempDir()
		const writer = createFsStore(dir, { executionOwner: owner("dead-owner", hostname(), 404) })
		const lease = await writer.executions?.acquire("run-1")
		await writer.appendEvent({
			type: "run-execution-started",
			runId: "run-1",
			executionId: lease!.executionId,
			owner: { host: hostname(), pid: 404, processStartedAt: AT },
			at: AT,
		})
		await writer.appendEvent({ type: "run-started", runId: "run-1", workflowName: "demo", input: null, at: AT })
		await writer.appendEvent({ type: "step-started", runId: "run-1", path: "work", input: null, at: AT })

		const reader = createFsStore(dir, {
			executionOwner: owner("new-owner"),
			isProcessAlive: () => false,
		})
		const reconciled = await reconcileAbandonedRun(reader, "run-1")

		expect(reconciled).toEqual({ runId: "run-1", executionId: lease?.executionId })
		expect((await reader.list())[0]?.status).toBe("crashed")
		expect((await reader.loadEvents("run-1")).at(-1)).toMatchObject({
			type: "run-crashed",
			executionId: lease?.executionId,
		})
		expect(await reader.executions?.inspect("run-1")).toBeUndefined()
	})

	it("projects an abandoned run as crashed for reads without repairing its JSONL or lease", async () => {
		const dir = await tempDir()
		const writer = createFsStore(dir, { executionOwner: owner("dead-owner", hostname(), 405) })
		const lease = await writer.executions?.acquire("run-1")
		await writer.appendEvent({
			type: "run-execution-started",
			runId: "run-1",
			executionId: lease!.executionId,
			owner: { host: hostname(), pid: 405, processStartedAt: AT },
			at: AT,
		})
		await writer.appendEvent({ type: "run-started", runId: "run-1", workflowName: "demo", input: null, at: AT })
		await writer.appendEvent({ type: "step-started", runId: "run-1", path: "work", input: null, at: AT })

		const reader = createFsStore(dir, {
			executionOwner: owner("new-owner"),
			isProcessAlive: () => false,
		})
		const before = await reader.loadEvents("run-1")
		const projectedEvents = await projectRunEvents(reader, "run-1", { now: () => new Date(AT) })
		const projectedSummaries = await projectRunSummaries(reader, { now: () => new Date(AT) })

		expect(projectedEvents.at(-1)).toMatchObject({
			type: "run-crashed",
			executionId: lease?.executionId,
		})
		expect(projectedSummaries[0]?.status).toBe("crashed")
		expect(await reader.loadEvents("run-1")).toEqual(before)
		expect(await reader.executions?.inspect("run-1")).toMatchObject({ state: "dead" })
	})

	it("refuses cancellation from a different live runner and identifies its owner", async () => {
		const dir = await tempDir()
		const runner = createFsStore(dir, { executionOwner: owner("runner", hostname(), 515) })
		const lease = await runner.executions?.acquire("run-1")
		await runner.appendEvent({
			type: "run-execution-started",
			runId: "run-1",
			executionId: lease!.executionId,
			owner: { host: hostname(), pid: 515, processStartedAt: AT },
			at: AT,
		})
		await runner.appendEvent({ type: "run-started", runId: "run-1", workflowName: "demo", input: null, at: AT })
		await runner.appendEvent({ type: "step-started", runId: "run-1", path: "work", input: null, at: AT })
		const other = createFsStore(dir, {
			executionOwner: owner("other", hostname(), 616),
			isProcessAlive: () => true,
		})
		const spy = notifySpy()

		await handleCancel(spy.ctx, createActiveRuns(), other, "run-1")

		expect(spy.notes).toEqual([`workflow: run run-1 is owned by PID 515 on ${hostname()}; cancel it from that runner.`])
		expect((await other.loadEvents("run-1")).filter((event) => event.type === "run-cancelled")).toHaveLength(0)
	})

	it("flushes one cancellation before abort, suppresses late completion, and holds the lease until settle", async () => {
		const dir = await tempDir()
		const executionOwner = owner("runner", hostname(), 717)
		const runStore = createFsStore(dir, { executionOwner })
		const commandStore = createFsStore(dir, { executionOwner })
		const activeRuns = createActiveRuns()
		let entered!: () => void
		const started = new Promise<void>((resolve) => {
			entered = resolve
		})
		let eventsSeenAtAbort: string[] = []

		const running = runTracked(activeRuns, "run-1", runStore, async (signal, execution): Promise<RunResult> => {
			const host = createHostPort(runStore, {
				executionId: execution.lease.executionId,
				acceptEvent: () => execution.acceptsEvents(),
			})
			await host.emit({ type: "run-started", runId: "run-1", workflowName: "demo", input: null, at: AT })
			await host.emit({ type: "step-started", runId: "run-1", path: "work", input: null, at: AT })
			entered()
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
			eventsSeenAtAbort = (await commandStore.loadEvents("run-1")).map((event) => event.type)
			await host.emit({ type: "step-completed", runId: "run-1", path: "work", output: "late", at: AT })
			await host.emit({ type: "run-completed", runId: "run-1", output: "late", at: AT })
			return { runId: "run-1", status: "completed", output: "late" }
		})
		await started
		const first = notifySpy()
		const second = notifySpy()

		await Promise.all([
			handleCancel(first.ctx, activeRuns, commandStore, "run-1"),
			handleCancel(second.ctx, activeRuns, commandStore, "run-1"),
		])
		expect(await commandStore.executions?.inspect("run-1")).toBeDefined()
		const result = await running

		expect(result.status).toBe("cancelled")
		expect(eventsSeenAtAbort.at(-1)).toBe("run-cancelled")
		const events = await commandStore.loadEvents("run-1")
		expect(events.filter((event) => event.type === "run-cancelled")).toHaveLength(1)
		expect(events.some((event) => event.type === "run-completed")).toBe(false)
		expect(await commandStore.executions?.inspect("run-1")).toBeUndefined()
	})

	it("prevents deletion while a cancelled execution is still settling", async () => {
		const dir = await tempDir()
		const store = createFsStore(dir, { executionOwner: owner("runner", hostname(), 818) })
		const lease = await store.executions?.acquire("run-1")
		await store.appendEvent({ type: "run-started", runId: "run-1", workflowName: "demo", input: null, at: AT })
		await store.appendEvent({
			type: "run-cancelled",
			runId: "run-1",
			executionId: lease?.executionId,
			source: "command",
			at: AT,
		})
		const spy = notifySpy()

		await handleDelete(spy.ctx, store, "run-1")

		expect(spy.notes[0]).toContain(`still settling under PID 818 on ${hostname()}`)
		expect(await store.loadEvents("run-1")).not.toEqual([])
	})
})
