import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { RunEvent } from "../src/engine/types.ts"
import type { CommandCtx, StartAgent } from "../src/host/commands/index.ts"
import { handleCancel, handleDelete, handleResume, handleRun } from "../src/host/commands/index.ts"
import { createFsStore } from "../src/host/fs-store.ts"
import { createMemoryStore } from "../src/host/memory-store.ts"
import { workflowsDir } from "../src/host/project-dir.ts"
import type { RunStore } from "../src/host/types.ts"
import { createFakeRunLock } from "./helpers.ts"

type NoteType = "info" | "warning" | "error" | undefined

function notifySpy() {
	const notes: [string, NoteType][] = []
	return { notes, notify: (message: string, type?: Exclude<NoteType, undefined>) => void notes.push([message, type]) }
}

/** The slice of the command context these handlers use, with a notification spy in place of a UI. */
function fakeCtx(cwd: string, notify: ReturnType<typeof notifySpy>["notify"]): CommandCtx {
	return {
		cwd,
		ui: { notify } as CommandCtx["ui"],
		mode: "print",
		hasUI: false,
		modelRegistry: {} as CommandCtx["modelRegistry"],
	}
}

/** No agent steps in these workflows: opening a session at all would be the bug. */
const noAgent: StartAgent = () => {
	throw new Error("no agent expected")
}

const flowImport = path.resolve(import.meta.dirname, "../src/flow/index.ts")

/**
 * A workflow whose only step fails the FIRST time it runs and succeeds afterwards, deciding by a marker
 * file on disk. That is what makes a genuine crash-then-resume observable through the command handlers:
 * the resume reloads the definition from the path recorded in the log and re-runs the step for real.
 */
function flakyWorkflowSource(marker: string): string {
	return [
		`import { existsSync, writeFileSync } from "node:fs";`,
		`import { createStep, createWorkflow } from "${flowImport}";`,
		`const flaky = createStep({ name: "flaky", run: () => {`,
		`  if (!existsSync(${JSON.stringify(marker)})) { writeFileSync(${JSON.stringify(marker)}, "x"); throw new Error("first attempt fails"); }`,
		"  return { ok: true };",
		"} });",
		`export default createWorkflow({ name: "flaky-demo" }).then(flaky).commit();`,
	].join("\n")
}

/**
 * Run identity end to end (spec §8.9): the id is a slug the user can read and retype, provenance travels
 * in the log rather than a sidecar, and `resume`/`delete` accept any unambiguous reference to it.
 */
describe("run identity through the command handlers", () => {
	let projectRoot: string
	let runDir: string
	let store: RunStore

	beforeEach(async () => {
		projectRoot = await mkdtemp(path.join(tmpdir(), "pi-workflows-identity-"))
		runDir = path.join(projectRoot, "sessions", "workflow")
		await mkdir(runDir, { recursive: true })
		store = createFsStore(runDir)
	})

	afterEach(async () => {
		await rm(projectRoot, { recursive: true, force: true })
	})

	async function writeFlaky(): Promise<string> {
		const marker = path.join(projectRoot, "marker.txt")
		const file = path.join(workflowsDir(projectRoot), "flaky.workflow.ts")
		await mkdir(path.dirname(file), { recursive: true })
		await writeFile(file, flakyWorkflowSource(marker), "utf8")
		return file
	}

	it("mints a readable slug and records provenance in the log itself, before anything else", async () => {
		const file = await writeFlaky()
		const spy = notifySpy()

		await handleRun(fakeCtx(projectRoot, spy.notify), store, createFakeRunLock(), noAgent, file)

		const runs = await store.list()
		expect(runs).toHaveLength(1)
		const runId = runs[0]?.runId ?? ""
		expect(runId).toMatch(/^workflow-flaky-demo-[0-9a-f]{8}$/)

		// `run-meta` is the adapter's own event and comes FIRST — a crash mid-run still leaves a log that
		// knows which file it came from (spec §8.5's reload-to-resume).
		const events = await store.loadEvents(runId)
		expect(events[0]).toMatchObject({ type: "run-meta", runId, workflowFilePath: file })
		expect(events[1]?.type).toBe("run-started")
		expect(existsSync(path.join(runDir, `${runId}.events.jsonl`))).toBe(true)
		const failure = spy.notes.find(([, type]) => type === "error")?.[0] ?? ""
		expect(failure).toContain(`workflow "flaky-demo" crashed at "flaky" (run ${runId})`)
		expect(failure).toContain("first attempt fails")
		expect(failure).toContain(`Resume: /workflow resume ${runId}`)
		expect(failure).toContain(`Details: /workflow status ${runId}`)
	})

	it("resumes by the run's short hash, reloading the workflow from the recorded path", async () => {
		const file = await writeFlaky()
		const spy = notifySpy()
		const ctx = fakeCtx(projectRoot, spy.notify)

		await handleRun(ctx, store, createFakeRunLock(), noAgent, file)
		const runId = (await store.list())[0]?.runId ?? ""
		expect((await store.list())[0]?.status).toBe("crashed")

		// Typed the way a user would after reading `/workflow run list`: just the tail.
		await handleResume(ctx, store, createFakeRunLock(), noAgent, runId.slice(-8))

		expect((await store.list())[0]).toMatchObject({ runId, status: "completed" })
	})

	it("explains a deleted workflow file and preserves the crashed run", async () => {
		const file = await writeFlaky()
		const spy = notifySpy()
		const ctx = fakeCtx(projectRoot, spy.notify)

		await handleRun(ctx, store, createFakeRunLock(), noAgent, file)
		const run = (await store.list())[0]
		expect(run?.status).toBe("crashed")
		spy.notes.length = 0
		await rm(file)

		await handleResume(ctx, store, createFakeRunLock(), noAgent, run?.runId ?? "")

		expect(spy.notes).toHaveLength(1)
		expect(spy.notes[0]?.[0]).toContain(`workflow "flaky-demo" cannot resume (run ${run?.runId})`)
		expect(spy.notes[0]?.[0]).toContain(`File: ${file}`)
		expect(spy.notes[0]?.[0]).toContain("The workflow file no longer exists")
		expect(spy.notes[0]?.[0]).toContain("The recorded run has been preserved")
		expect((await store.list())[0]).toMatchObject({ runId: run?.runId, status: "crashed" })
	})

	it("shows the loader cause when the workflow became invalid before resume", async () => {
		const file = await writeFlaky()
		const spy = notifySpy()
		const ctx = fakeCtx(projectRoot, spy.notify)

		await handleRun(ctx, store, createFakeRunLock(), noAgent, file)
		const run = (await store.list())[0]
		spy.notes.length = 0
		await writeFile(file, "export default const invalid = ;", "utf8")

		await handleResume(ctx, store, createFakeRunLock(), noAgent, run?.runId ?? "")

		expect(spy.notes).toHaveLength(1)
		expect(spy.notes[0]?.[0]).toContain(`workflow "flaky-demo" cannot resume (run ${run?.runId})`)
		expect(spy.notes[0]?.[0]).toContain(`File: ${file}`)
		expect(spy.notes[0]?.[0]).toContain("TS1109")
		expect(spy.notes[0]?.[0]).toContain("The recorded run has been preserved")
	})

	it("rejects a new semantic TypeScript error before resuming the recorded run", async () => {
		const file = await writeFlaky()
		const evaluated = path.join(projectRoot, "semantic-workflow-evaluated.txt")
		const spy = notifySpy()
		const ctx = fakeCtx(projectRoot, spy.notify)

		await handleRun(ctx, store, createFakeRunLock(), noAgent, file)
		const run = (await store.list())[0]
		spy.notes.length = 0
		await writeFile(
			file,
			[
				`import { writeFileSync } from "node:fs";`,
				`import { createStep, createWorkflow } from "${flowImport}";`,
				`writeFileSync(${JSON.stringify(evaluated)}, "evaluated");`,
				`const invalid: number = "not a number";`,
				`const flaky = createStep({ name: "flaky", run: () => invalid });`,
				`export default createWorkflow({ name: "flaky-demo" }).then(flaky).commit();`,
			].join("\n"),
			"utf8",
		)

		await handleResume(ctx, store, createFakeRunLock(), noAgent, run?.runId ?? "")

		expect(spy.notes).toHaveLength(1)
		expect(spy.notes[0]?.[0]).toContain(`workflow "flaky-demo" cannot resume (run ${run?.runId})`)
		expect(spy.notes[0]?.[0]).toContain("TS2322")
		expect(spy.notes[0]?.[0]).toContain("The recorded run has been preserved")
		expect(existsSync(evaluated)).toBe(false)
		expect((await store.list())[0]).toMatchObject({ runId: run?.runId, status: "crashed" })
	})

	it("refuses to resume a log that records no provenance (a pre-slug run — inert by design)", async () => {
		const spy = notifySpy()
		const legacy: RunEvent[] = [
			{ type: "run-started", runId: "3f2a1c4b-old", workflowName: "legacy", input: undefined, at: "T0" },
			{ type: "run-crashed", runId: "3f2a1c4b-old", error: "boom", at: "T1" },
		]
		for (const event of legacy) await store.appendEvent(event)

		await handleResume(fakeCtx(projectRoot, spy.notify), store, createFakeRunLock(), noAgent, "3f2a1c4b-old")

		expect(spy.notes[0]?.[0]).toContain("workflow run 3f2a1c4b-old cannot be resumed")
		expect(spy.notes[0]?.[0]).toContain("does not record the workflow file it came from")
		expect(spy.notes[0]?.[0]).toContain("The recorded run has been preserved")
		expect(spy.notes[0]?.[1]).toBe("error")
	})
})

/** Reference resolution as the destructive commands see it (spec §6.5): a wrong guess must not delete a run. */
describe("resolving a run reference in delete", () => {
	async function storeWith(...runIds: readonly string[]): Promise<RunStore> {
		const store = createMemoryStore()
		for (const runId of runIds) {
			await store.appendEvent({ type: "run-started", runId, workflowName: "deploy", input: undefined, at: "T0" })
			await store.appendEvent({ type: "run-completed", runId, output: undefined, at: "T1" })
		}
		return store
	}

	it("deletes the run named by its short hash", async () => {
		const store = await storeWith("workflow-deploy-1a2b3c4d", "workflow-audit-ffffffff")
		const spy = notifySpy()

		await handleDelete({ ui: { notify: spy.notify } }, store, "1a2b3c4d")

		expect((await store.list()).map((run) => run.runId)).toEqual(["workflow-audit-ffffffff"])
		expect(spy.notes[0]?.[0]).toMatch(/deleted completed run workflow-deploy-1a2b3c4d/)
	})

	it("lists the candidates and deletes nothing when the reference is ambiguous", async () => {
		const store = await storeWith("workflow-deploy-1a2b3c4d", "workflow-deploy-1a2b9999")
		const spy = notifySpy()

		await handleDelete({ ui: { notify: spy.notify } }, store, "workflow-deploy")

		expect(await store.list()).toHaveLength(2) // untouched
		expect(spy.notes[0]?.[1]).toBe("warning")
		expect(spy.notes[0]?.[0]).toMatch(/matches 2 runs \(workflow-deploy-1a2b3c4d, workflow-deploy-1a2b9999\)/)
	})

	it("reports an unknown reference", async () => {
		const store = await storeWith("workflow-deploy-1a2b3c4d")
		const spy = notifySpy()

		await handleDelete({ ui: { notify: spy.notify } }, store, "nope")

		expect(spy.notes[0]?.[0]).toMatch(/no run "nope" to delete/)
		expect(await store.list()).toHaveLength(1)
	})

	// Cancel resolves the same way, and a reference that lands on the run THIS process is executing
	// aborts it rather than trying to cold-cancel a run that is very much alive (spec §6.4).
	it("cancel aborts the executing run when a prefix resolves to it", async () => {
		const store = await storeWith("workflow-deploy-1a2b3c4d")
		const guard = createFakeRunLock()
		const begun = await guard.begin("workflow-deploy-1a2b3c4d", "/fake/project", store)
		const spy = notifySpy()

		await handleCancel({ ui: { notify: spy.notify } }, guard, store, "workflow-dep")

		expect(begun.ok && begun.controller.signal.aborted).toBe(true)
		expect(spy.notes[0]?.[0]).toMatch(/cancelling run workflow-deploy-1a2b3c4d at the next step boundary/)
	})
})
