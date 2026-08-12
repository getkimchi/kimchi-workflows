import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Type } from "typebox"
import { describe, expect, it } from "vitest"
import { resumeWithAnswer, resumeWorkflow } from "../src/engine/resume-workflow.ts"
import { runWorkflow } from "../src/engine/run-workflow.ts"
import type { RunResult } from "../src/engine/types.ts"
import { createQuestionnaireStep, createStep, createWorkflow } from "../src/flow/index.ts"
import {
	handleCancel,
	handleDelete,
	handleListRuns,
	handleListWorkflows,
	runGuarded,
} from "../src/host/commands/index.ts"
import { workflowsDir } from "../src/host/project-dir.ts"
import { summarizeRun } from "../src/host/summarize-run.ts"
import type { RunStore, RunSummary } from "../src/host/types.ts"
import { createFakeRunLock, createTestHost } from "./helpers.ts"

type NoteType = "info" | "warning" | "error" | undefined
function notifySpy() {
	const notes: [string, NoteType][] = []
	return { notes, notify: (message: string, type?: Exclude<NoteType, undefined>) => void notes.push([message, type]) }
}

// -- runGuarded (extracted guard lifecycle, spec §7) ------------------------------------------------

describe("runGuarded", () => {
	const completed: RunResult = { runId: "r1", status: "completed" }
	const fakeStore = { appendEvent: async () => {} }

	it("runs with the run's abort signal and releases the guard on success", async () => {
		const guard = createFakeRunLock()
		const spy = notifySpy()
		let sawSignal: AbortSignal | undefined
		const result = await runGuarded(guard, "r1", "/fake/project", fakeStore, spy.notify, (signal) => {
			sawSignal = signal
			expect(guard.active?.runId).toBe("r1") // held during the run
			return Promise.resolve(completed)
		})
		expect(result).toBe(completed)
		expect(sawSignal).toBeInstanceOf(AbortSignal)
		expect(guard.active).toBeUndefined() // released
		expect(spy.notes).toEqual([])
	})

	it("releases the guard even when the run throws", async () => {
		const guard = createFakeRunLock()
		const spy = notifySpy()
		await expect(
			runGuarded(guard, "r1", "/fake/project", fakeStore, spy.notify, () => Promise.reject(new Error("boom"))),
		).rejects.toThrow("boom")
		expect(guard.active).toBeUndefined()
	})

	it("notifies naming the holder and skips the run when the guard is busy", async () => {
		const guard = createFakeRunLock()
		await guard.begin("other", "/fake/project", fakeStore) // occupy the guard
		const spy = notifySpy()
		let ran = false
		const result = await runGuarded(guard, "r1", "/fake/project", fakeStore, spy.notify, () => {
			ran = true
			return Promise.resolve(completed)
		})
		expect(result).toBeUndefined()
		expect(ran).toBe(false)
		expect(spy.notes).toEqual([
			[
				"workflow: run other is already executing (pid -1 on fake-host); cancel it or wait before starting/resuming another.",
				"warning",
			],
		])
		expect(guard.active?.runId).toBe("other") // the busy run is untouched
	})
})

// -- handleListRuns (formatting via a narrowed context) ------------------------------------------------

describe("handleListRuns", () => {
	it("reports when there are no runs", async () => {
		const spy = notifySpy()
		await handleListRuns({ ui: { notify: spy.notify } }, { list: () => Promise.resolve([]) })
		expect(spy.notes).toEqual([["No workflow runs recorded.", "info"]])
	})

	it("formats one line per run, using a dash for a missing completedAt/currentStep", async () => {
		const spy = notifySpy()
		const runs: RunSummary[] = [
			{
				runId: "a1",
				workflowName: "survey",
				status: "completed",
				startedAt: "T0",
				completedAt: "T1",
				pendingQuestions: 0,
			},
			{
				runId: "b2",
				workflowName: "plan",
				status: "blocked",
				startedAt: "T2",
				currentStep: "ask",
				pendingQuestions: 1,
			},
		]
		await handleListRuns({ ui: { notify: spy.notify } }, { list: () => Promise.resolve(runs) })
		expect(spy.notes).toEqual([
			[
				"a1  survey  completed  step=-  started=T0  completed=T1\nb2  plan  blocked  step=ask  started=T2  completed=-  waiting=1",
				"info",
			],
		])
	})
})

// -- handleListWorkflows (catalog formatting) -------------------------------------------------------

const flowImport = path.resolve(import.meta.dirname, "../src/flow/index.ts")

/** A valid workflow module; imports are absolute because the temp project has no node_modules. */
function workflowSource(name: string, description?: string): string {
	const options =
		description === undefined ? `{ name: "${name}" }` : `{ name: "${name}", description: "${description}" }`
	return [
		`import { createStep, createWorkflow } from "${flowImport}";`,
		`const step = createStep({ name: "${name}-step", run: () => ({ ok: true }) });`,
		`export default createWorkflow(${options}).then(step).commit();`,
	].join("\n")
}

async function projectWith(files: Record<string, string>): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "pi-ext-"))
	await mkdir(workflowsDir(root), { recursive: true })
	for (const [name, content] of Object.entries(files)) {
		await writeFile(path.join(workflowsDir(root), name), content, "utf8")
	}
	return root
}

describe("handleListWorkflows", () => {
	it("points at /workflow create when the project has none", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "pi-ext-empty-"))
		const spy = notifySpy()

		await handleListWorkflows({ ui: { notify: spy.notify }, cwd: root })

		expect(spy.notes).toHaveLength(1)
		expect(spy.notes[0]?.[0]).toMatch(/No workflows found/)
		expect(spy.notes[0]?.[0]).toMatch(/\/workflow create/)
	})

	it("lists name, file, and description, padded, using a dash when undescribed", async () => {
		const root = await projectWith({
			"deploy.workflow.ts": workflowSource("deploy", "ship it"),
			"bare.workflow.ts": workflowSource("bare"),
		})
		const spy = notifySpy()

		await handleListWorkflows({ ui: { notify: spy.notify }, cwd: root })

		expect(spy.notes).toEqual([["bare    bare.workflow.ts  -\ndeploy  deploy.workflow.ts  ship it", "info"]])
	})

	it("flags duplicate workflow names, which `run` would otherwise reject as ambiguous", async () => {
		const root = await projectWith({
			"a.workflow.ts": workflowSource("deploy", "first"),
			"b.workflow.ts": workflowSource("deploy", "second"),
		})
		const spy = notifySpy()

		await handleListWorkflows({ ui: { notify: spy.notify }, cwd: root })

		const listing = spy.notes[0]?.[0] ?? ""
		expect(listing).toContain("a.workflow.ts")
		expect(listing).toContain("b.workflow.ts") // the two rows are distinguishable
		expect(listing.match(/\(duplicate name\)/g)).toHaveLength(2)
	})

	it("still lists the good workflows and warns about the broken ones", async () => {
		const root = await projectWith({
			"good.workflow.ts": workflowSource("good", "fine"),
			"bad.workflow.ts": "export default { not: 'a workflow' };",
		})
		const spy = notifySpy()

		await handleListWorkflows({ ui: { notify: spy.notify }, cwd: root })

		expect(spy.notes[0]).toEqual(["good  good.workflow.ts  fine", "info"])
		expect(spy.notes[1]?.[1]).toBe("warning")
		expect(spy.notes[1]?.[0]).toMatch(/1 file\(s\) failed to load/)
		expect(spy.notes[1]?.[0]).toMatch(/bad\.workflow\.ts/)
	})
})

// -- cancel / delete lifecycle (spec §6.4, §6.5, §10.2) --------------------------------------------

/**
 * A real in-memory store holding one run, driven to a genuine state through the engine — so these
 * assert the actual `blocked`/`completed` semantics rather than a hand-written log.
 */
async function storeWithRun(kind: "blocked" | "completed"): Promise<{ store: RunStore; runId: string }> {
	const form = createQuestionnaireStep({ name: "ask", output: Type.Object({ name: Type.String() }) })
	const done = createStep({ name: "done", run: () => ({ ok: true }) })
	const workflow =
		kind === "blocked"
			? createWorkflow({ name: "blocks" }).then(form).commit()
			: createWorkflow({ name: "runs" }).then(done).commit()

	const { host, store } = createTestHost()
	const result = await runWorkflow(workflow, undefined, host)
	expect(result.status).toBe(kind)
	return { store, runId: result.runId }
}

describe("handleCancel", () => {
	it("aborts the executing run", async () => {
		const guard = createFakeRunLock()
		const begun = await guard.begin("live", "/fake/project", { appendEvent: async () => {} })
		const spy = notifySpy()
		const { store } = await storeWithRun("blocked")

		await handleCancel({ ui: { notify: spy.notify } }, guard, store, undefined)

		expect(begun.ok && begun.controller.signal.aborted).toBe(true)
		expect(spy.notes[0]?.[0]).toMatch(/cancelling run live at the next step boundary/)
	})

	it("cold-cancels a blocked run, which no signal can reach (spec §10.2)", async () => {
		const { store, runId } = await storeWithRun("blocked")
		const spy = notifySpy()

		// No guard entry: a blocked run is not executing (spec §7.1), so there is nothing to abort.
		await handleCancel({ ui: { notify: spy.notify } }, createFakeRunLock(), store, runId)

		expect(summarizeRun(await store.loadEvents(runId))?.status).toBe("cancelled")
		expect(spy.notes[0]?.[0]).toMatch(/cancelled blocked run/)
	})

	it("targets the sole blocked run when given no run-id", async () => {
		const { store, runId } = await storeWithRun("blocked")
		const spy = notifySpy()

		await handleCancel({ ui: { notify: spy.notify } }, createFakeRunLock(), store, undefined)

		expect(summarizeRun(await store.loadEvents(runId))?.status).toBe("cancelled")
	})

	it("refuses to cancel a run that already finished", async () => {
		const { store, runId } = await storeWithRun("completed")
		const spy = notifySpy()

		await handleCancel({ ui: { notify: spy.notify } }, createFakeRunLock(), store, runId)

		expect(spy.notes[0]?.[0]).toMatch(/is completed; only an executing or blocked run can be cancelled/)
		expect(summarizeRun(await store.loadEvents(runId))?.status).toBe("completed") // untouched
	})

	it("reports when there is nothing to cancel", async () => {
		const { store } = await storeWithRun("completed")
		const spy = notifySpy()

		await handleCancel({ ui: { notify: spy.notify } }, createFakeRunLock(), store, undefined)

		expect(spy.notes[0]?.[0]).toMatch(/nothing to cancel/)
	})
})

describe("handleDelete", () => {
	it("removes a stopped run", async () => {
		const { store, runId } = await storeWithRun("completed")
		const spy = notifySpy()

		await handleDelete({ ui: { notify: spy.notify } }, store, runId)

		expect(await store.loadEvents(runId)).toEqual([])
		expect(spy.notes[0]?.[0]).toMatch(/deleted completed run/)
	})

	it("refuses a blocked run and points at cancel first (spec §6.5)", async () => {
		const { store, runId } = await storeWithRun("blocked")
		const spy = notifySpy()

		await handleDelete({ ui: { notify: spy.notify } }, store, runId)

		expect(spy.notes[0]?.[1]).toBe("warning")
		expect(spy.notes[0]?.[0]).toMatch(/is blocked; cancel it first/)
		expect((await store.loadEvents(runId)).length).toBeGreaterThan(0) // still there
	})

	it("cancel then delete is the sanctioned way to remove a blocked run", async () => {
		const { store, runId } = await storeWithRun("blocked")
		const spy = notifySpy()

		await handleCancel({ ui: { notify: spy.notify } }, createFakeRunLock(), store, runId)
		await handleDelete({ ui: { notify: spy.notify } }, store, runId)

		expect(await store.loadEvents(runId)).toEqual([])
	})

	it("reports an unknown run", async () => {
		const { store } = await storeWithRun("completed")
		const spy = notifySpy()

		await handleDelete({ ui: { notify: spy.notify } }, store, "nope")

		expect(spy.notes[0]?.[0]).toMatch(/no run "nope" to delete/)
	})
})

describe("a cancelled run cannot be resurrected by a late answer (adversarial regression)", () => {
	it("refuses answers delivered after the run was cancelled", async () => {
		const form = createQuestionnaireStep({ name: "ask", output: Type.Object({ name: Type.String() }) })
		const workflow = createWorkflow({ name: "blocks" }).then(form).commit()
		const { host, store } = createTestHost()

		const blocked = await runWorkflow(workflow, undefined, host)
		await handleCancel({ ui: { notify: notifySpy().notify } }, createFakeRunLock(), store, blocked.runId)

		// An answer captured before the cancel (an open prompt, or another session) must not undo it.
		await expect(
			resumeWithAnswer(workflow, await store.loadEvents(blocked.runId), { name: "Ada" }, host),
		).rejects.toThrow(/was cancelled after blocking/)
		expect(summarizeRun(await store.loadEvents(blocked.runId))?.status).toBe("cancelled") // still cancelled
	})

	it("still accepts answers while the block stands", async () => {
		const form = createQuestionnaireStep({ name: "ask", output: Type.Object({ name: Type.String() }) })
		const workflow = createWorkflow({ name: "blocks" }).then(form).commit()
		const { host, store } = createTestHost()

		const blocked = await runWorkflow(workflow, undefined, host)
		const done = await resumeWithAnswer(workflow, await store.loadEvents(blocked.runId), { name: "Ada" }, host)

		expect(done.status).toBe("completed")
	})
})

describe("a cancelled run is still resumable — only stale answers are refused (spec §5.2, §8.4)", () => {
	it("re-runs a cold-cancelled blocked run and asks again", async () => {
		const form = createQuestionnaireStep({ name: "ask", output: Type.Object({ name: Type.String() }) })
		const greet = createStep({
			name: "greet",
			input: Type.Object({ name: Type.String() }),
			output: Type.Object({ message: Type.String() }),
			run: ({ input }) => ({ message: `hi ${input.name}` }),
		})
		const workflow = createWorkflow({ name: "blocks" }).then(form).then(greet).commit()
		const { host, store } = createTestHost()

		const blocked = await runWorkflow(workflow, undefined, host)
		await handleCancel({ ui: { notify: notifySpy().notify } }, createFakeRunLock(), store, blocked.runId)
		expect(summarizeRun(await store.loadEvents(blocked.runId))?.status).toBe("cancelled")

		// §5.2: cancelled is recoverable. The re-run path (§8.2) re-runs the interrupted step, so the
		// question is asked afresh rather than the stale block being silently continued.
		const revived = await resumeWorkflow(workflow, await store.loadEvents(blocked.runId), host)
		expect(revived.status).toBe("blocked")
		expect(revived.path).toBe("ask")

		// ...and answering THAT block works, because it is now the run's latest state.
		const done = await resumeWithAnswer(workflow, await store.loadEvents(blocked.runId), { name: "Ada" }, host)
		expect(done.status).toBe("completed")
		expect(done.output).toEqual({ message: "hi Ada" })
	})
})
