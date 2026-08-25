import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { CommandCtx, StartAgent } from "../src/host/commands/index.ts"
import { handleResume, handleRun, handleStatus } from "../src/host/commands/index.ts"
import { createMemoryStore } from "../src/host/memory-store.ts"
import type { ProgressCtx } from "../src/host/progress-sink.ts"
import { loadRecordedWorkflow, reloadRecordedWorkflow } from "../src/host/recorded-workflow.ts"
import { createFakeActiveRuns } from "./helpers.ts"

const flowImport = path.resolve(import.meta.dirname, "../src/flow/index.ts")

const noAgent: StartAgent = () => {
	throw new Error("no agent expected")
}

function projectWorkflowSource(): string {
	return [
		'import { Type } from "typebox";',
		`import { createQuestionnaireStep, createStep, createWorkflow } from ${JSON.stringify(flowImport)};`,
		"const answer = Type.Object({ name: Type.String({ title: 'Name', description: 'Who should be greeted?' }) });",
		"const ask = createQuestionnaireStep({ name: 'ask', output: answer });",
		"const finish = createStep({ name: 'finish', input: answer, run: ({ input, ctx }) => 'Hello ' + input.name + ' from ' + ctx.workflowName });",
		"export default createWorkflow({ name: 'definition-greeting' }).then(ask).then(finish).commit();",
	].join("\n")
}

describe("project-authored recorded workflow lifecycle", () => {
	const roots: string[] = []

	afterEach(async () => {
		await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
	})

	it("runs, answers a real resume, and renders status from the recorded project file", async () => {
		const projectRoot = await mkdtemp(path.join(tmpdir(), "kimchi-recorded-project-workflow-"))
		roots.push(projectRoot)
		const workflowFile = path.join(projectRoot, "installed-greeting.workflow.ts")
		await writeFile(workflowFile, projectWorkflowSource(), "utf8")

		const store = createMemoryStore()
		const activeRuns = createFakeActiveRuns()
		const notify = vi.fn()
		const inputs: (string | undefined)[] = [undefined]
		const ctx = {
			cwd: projectRoot,
			mode: "print",
			hasUI: false,
			modelRegistry: {},
			sessionManager: { getSessionDir: () => path.join(projectRoot, "sessions") },
			ui: {
				notify,
				input: vi.fn(async () => inputs.shift()),
				select: vi.fn(async () => undefined),
				confirm: vi.fn(async () => false),
				setWidget: () => {},
				setWorkingMessage: () => {},
			},
		} as unknown as CommandCtx & ProgressCtx

		await handleRun(ctx, store, activeRuns, noAgent, workflowFile)
		const runId = (await store.list())[0]?.runId ?? ""
		expect(runId).toMatch(/^workflow-installed-greeting-/)
		expect((await store.list())[0]).toMatchObject({
			runId,
			workflowName: "installed-greeting",
			status: "blocked",
			currentStep: "ask",
		})

		inputs.push("Ada")
		await handleResume(ctx, store, activeRuns, noAgent, runId)
		expect((await store.list())[0]).toMatchObject({ runId, status: "completed" })
		const events = await store.loadEvents(runId)
		expect(events[0]).toMatchObject({ type: "run-execution-started" })
		expect(events[1]).toMatchObject({
			type: "run-meta",
			workflowSource: { kind: "file", path: workflowFile },
		})
		expect(events).toContainEqual(expect.objectContaining({ type: "run-started", workflowName: "installed-greeting" }))
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "step-completed",
				path: "finish",
				output: "Hello Ada from installed-greeting",
			}),
		)

		notify.mockClear()
		await handleStatus(ctx, store, { activeRunIds: () => [], width: 76 }, runId)
		expect(notify).toHaveBeenCalledTimes(1)
		const [message, type] = notify.mock.calls[0] as [string, string]
		expect(message).toContain(workflowFile)
		expect(message).toContain("installed-greeting")
		expect(message).toContain("✓ ask")
		expect(message).toContain("✓ finish")
		expect(type).toBe("info")
	}, 20_000)

	it("rebinds a reloaded file to an existing run's recorded identity", async () => {
		const projectRoot = await mkdtemp(path.join(tmpdir(), "kimchi-recorded-project-workflow-"))
		roots.push(projectRoot)
		const workflowFile = path.join(projectRoot, "current-file.workflow.ts")
		await writeFile(workflowFile, projectWorkflowSource(), "utf8")
		const source = { kind: "file", path: workflowFile } as const

		const loaded = await loadRecordedWorkflow({ source, projectRoot, identity: "legacy-run-name" })
		expect(loaded.ok).toBe(true)
		if (loaded.ok) expect(loaded.workflow.name).toBe("legacy-run-name")
		expect((await reloadRecordedWorkflow(source, "legacy-run-name")).name).toBe("legacy-run-name")
	}, 20_000)
})
