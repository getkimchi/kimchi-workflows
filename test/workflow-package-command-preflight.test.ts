import { beforeEach, describe, expect, it, vi } from "vitest"
import type { RunEvent } from "../src/engine/types.ts"
import type { CommandCtx, StartAgent } from "../src/host/commands/context.ts"
import { handleResume } from "../src/host/commands/resume.ts"
import { handleRun } from "../src/host/commands/run.ts"
import { createMemoryStore } from "../src/host/memory-store.ts"
import { createFakeActiveRuns } from "./helpers.ts"

const dependencies = vi.hoisted(() => ({
	loadRecordedWorkflow: vi.fn(),
	prepareProjectWorkflowPackage: vi.fn(),
	resolveWorkflow: vi.fn(),
}))

vi.mock("../src/host/project-workflow-package.ts", () => ({
	prepareProjectWorkflowPackage: dependencies.prepareProjectWorkflowPackage,
}))

vi.mock("../src/host/workflow-catalog.ts", () => ({ resolveWorkflow: dependencies.resolveWorkflow }))

vi.mock("../src/host/recorded-workflow.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/host/recorded-workflow.ts")>()),
	loadRecordedWorkflow: dependencies.loadRecordedWorkflow,
}))

const noAgent: StartAgent = () => {
	throw new Error("no agent expected")
}

function context(): CommandCtx & { readonly notes: string[] } {
	const notes: string[] = []
	return {
		cwd: "/project",
		mode: "print",
		hasUI: false,
		modelRegistry: {} as CommandCtx["modelRegistry"],
		ui: { notify: (message: string) => void notes.push(message) } as CommandCtx["ui"],
		notes,
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	dependencies.prepareProjectWorkflowPackage.mockResolvedValue({ directory: "/project/.kimchi/workflows" })
	dependencies.resolveWorkflow.mockResolvedValue({ ok: false, error: "stop after resolution" })
	dependencies.loadRecordedWorkflow.mockResolvedValue({ ok: false, cause: "stop after recorded load" })
})

describe("project workflow package command preflight", () => {
	it("prepares the central package before run validation", async () => {
		const ctx = context()

		await handleRun(ctx, createMemoryStore(), createFakeActiveRuns(), noAgent, "external.workflow.ts")

		expect(dependencies.prepareProjectWorkflowPackage).toHaveBeenCalledWith({ projectRoot: "/project" })
		expect(dependencies.resolveWorkflow).toHaveBeenCalledWith("/project", "external.workflow.ts")
		expect(dependencies.prepareProjectWorkflowPackage.mock.invocationCallOrder[0]).toBeLessThan(
			dependencies.resolveWorkflow.mock.invocationCallOrder[0] ?? 0,
		)
	})

	it("prepares the central package before a recorded file is validated for resume", async () => {
		const store = createMemoryStore()
		const events: RunEvent[] = [
			{
				type: "run-meta",
				runId: "workflow-demo-deadbeef",
				workflowSource: { kind: "file", path: "/project/external.workflow.ts" },
				at: "T0",
			},
			{ type: "run-started", runId: "workflow-demo-deadbeef", workflowName: "demo", input: undefined, at: "T1" },
			{ type: "run-crashed", runId: "workflow-demo-deadbeef", error: "boom", at: "T2" },
		]
		for (const event of events) await store.appendEvent(event)

		await handleResume(context(), store, createFakeActiveRuns(), noAgent, "deadbeef")

		expect(dependencies.prepareProjectWorkflowPackage).toHaveBeenCalledWith({ projectRoot: "/project" })
		expect(dependencies.loadRecordedWorkflow).toHaveBeenCalledWith({
			source: { kind: "file", path: "/project/external.workflow.ts" },
			projectRoot: "/project",
		})
		expect(dependencies.prepareProjectWorkflowPackage.mock.invocationCallOrder[0]).toBeLessThan(
			dependencies.loadRecordedWorkflow.mock.invocationCallOrder[0] ?? 0,
		)
	})

	it("does not prepare the project package to resume a package-owned built-in", async () => {
		const store = createMemoryStore()
		await store.appendEvent({
			type: "run-meta",
			runId: "workflow-create-deadbeef",
			workflowSource: { kind: "builtin", id: "create" },
			at: "T0",
		})
		await store.appendEvent({
			type: "run-started",
			runId: "workflow-create-deadbeef",
			workflowName: "create-workflow",
			input: undefined,
			at: "T1",
		})
		await store.appendEvent({
			type: "run-crashed",
			runId: "workflow-create-deadbeef",
			error: "boom",
			at: "T2",
		})

		await handleResume(context(), store, createFakeActiveRuns(), noAgent, "deadbeef")

		expect(dependencies.prepareProjectWorkflowPackage).not.toHaveBeenCalled()
		expect(dependencies.loadRecordedWorkflow).toHaveBeenCalled()
	})
})
