import { fileURLToPath } from "node:url"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { runWorkflow } from "../src/engine/run-workflow.ts"
import createWorkflowWorkflow from "../src/host/builtin/create.workflow.ts"
import type { CommandCtx } from "../src/host/commands/context.ts"
import { handleStatus } from "../src/host/commands/status.ts"
import { createHostPort } from "../src/host/host-port.ts"
import { createMemoryStore } from "../src/host/memory-store.ts"
import type { ProgressCtx } from "../src/host/progress-sink.ts"
import { BUILTIN_CREATE_WORKFLOW } from "../src/host/recorded-workflow.ts"

const { loadValidatedWorkflow } = vi.hoisted(() => ({
	loadValidatedWorkflow: vi.fn(async () => ({
		ok: false as const,
		cause: "TypeScript validation failed: installed harness has no physical typebox package",
	})),
}))

vi.mock("../src/host/workflow-preflight.ts", () => ({ loadValidatedWorkflow }))

const RUN_ID = "workflow-create-workflow-a0e99eae"
const CREATE_WORKFLOW_FILE = fileURLToPath(new URL("../src/host/builtin/create.workflow.ts", import.meta.url))
const COMPILED_CREATE_WORKFLOW_FILE = fileURLToPath(new URL("../dist/host/builtin/create.workflow.ts", import.meta.url))
const PROJECT_CREATE_WORKFLOW_FILE = "/tmp/.kimchi/workflows/create-workflow.workflow.ts"

describe("built-in create workflow status", () => {
	beforeEach(() => loadValidatedWorkflow.mockClear())

	it("uses the package-owned definition without project-workflow validation", async () => {
		const store = createMemoryStore()
		await store.appendEvent({
			type: "run-meta",
			runId: RUN_ID,
			workflowSource: BUILTIN_CREATE_WORKFLOW.source,
			at: new Date().toISOString(),
		})
		const result = await runWorkflow(
			createWorkflowWorkflow,
			{ projectRoot: "/tmp", workflowsDir: "/tmp/.kimchi/workflows" },
			createHostPort(store, { generateRunId: () => RUN_ID }),
		)
		expect(result.status).toBe("blocked")

		const notes: [string, string | undefined][] = []
		const ctx = {
			mode: "tui",
			cwd: "/tmp",
			hasUI: true,
			ui: {
				notify: (message: string, type?: "info" | "warning" | "error") => void notes.push([message, type]),
				setWidget: () => {},
				setWorkingMessage: () => {},
			},
			sessionManager: { getSessionDir: () => "/tmp/session" },
		} as unknown as CommandCtx & ProgressCtx

		await handleStatus(ctx, store, { activeRunIds: () => [], width: 76 }, RUN_ID)

		expect(loadValidatedWorkflow).not.toHaveBeenCalled()
		expect(notes).toHaveLength(1)
		expect(notes[0]?.[0]).toContain("builtin:create")
		expect(notes[0]?.[0]).toContain("create-workflow")
		expect(notes[0]?.[1]).toBe("info")
	})

	it.each([CREATE_WORKFLOW_FILE, COMPILED_CREATE_WORKFLOW_FILE])(
		"recognizes the exact legacy package path %s as the create built-in",
		async (legacyPath) => {
			const store = createMemoryStore()
			await store.appendEvent({
				type: "run-meta",
				runId: RUN_ID,
				workflowFilePath: legacyPath,
				at: new Date().toISOString(),
			})
			await runWorkflow(
				createWorkflowWorkflow,
				{ projectRoot: "/tmp", workflowsDir: "/tmp/.kimchi/workflows" },
				createHostPort(store, { generateRunId: () => RUN_ID }),
			)
			const notes: [string, string | undefined][] = []
			const ctx = {
				mode: "tui",
				cwd: "/tmp",
				hasUI: true,
				ui: {
					notify: (message: string, type?: "info" | "warning" | "error") => void notes.push([message, type]),
					setWidget: () => {},
					setWorkingMessage: () => {},
				},
				sessionManager: { getSessionDir: () => "/tmp/session" },
			} as unknown as CommandCtx & ProgressCtx

			await handleStatus(ctx, store, { activeRunIds: () => [], width: 76 }, RUN_ID)

			expect(loadValidatedWorkflow).not.toHaveBeenCalled()
			expect(notes[0]?.[0]).toContain("builtin:create")
			expect(notes[0]?.[1]).toBe("info")
		},
	)

	it("does not reserve the create-workflow name for package-owned workflows", async () => {
		const store = createMemoryStore()
		await store.appendEvent({
			type: "run-meta",
			runId: RUN_ID,
			workflowSource: { kind: "file", path: PROJECT_CREATE_WORKFLOW_FILE },
			at: new Date().toISOString(),
		})
		await store.appendEvent({
			type: "run-started",
			runId: RUN_ID,
			workflowName: "create-workflow",
			input: undefined,
			at: new Date().toISOString(),
		})

		const notes: [string, string | undefined][] = []
		const ctx = {
			mode: "tui",
			cwd: "/tmp",
			hasUI: true,
			ui: {
				notify: (message: string, type?: "info" | "warning" | "error") => void notes.push([message, type]),
				setWidget: () => {},
				setWorkingMessage: () => {},
			},
			sessionManager: { getSessionDir: () => "/tmp/session" },
		} as unknown as CommandCtx & ProgressCtx

		await handleStatus(ctx, store, { activeRunIds: () => [], width: 76 }, RUN_ID)

		expect(loadValidatedWorkflow).toHaveBeenCalledWith({
			filePath: PROJECT_CREATE_WORKFLOW_FILE,
			projectRoot: "/tmp",
		})
		expect(notes[0]?.[1]).toBe("error")
	})

	it("rejects an unknown built-in ID without treating it as a project file", async () => {
		const store = createMemoryStore()
		await store.appendEvent({
			type: "run-meta",
			runId: RUN_ID,
			workflowSource: { kind: "builtin", id: "missing" },
			at: new Date().toISOString(),
		})
		await store.appendEvent({
			type: "run-started",
			runId: RUN_ID,
			workflowName: "missing",
			input: undefined,
			at: new Date().toISOString(),
		})
		const notes: [string, string | undefined][] = []
		const ctx = {
			mode: "tui",
			cwd: "/tmp",
			hasUI: true,
			ui: {
				notify: (message: string, type?: "info" | "warning" | "error") => void notes.push([message, type]),
				setWidget: () => {},
				setWorkingMessage: () => {},
			},
			sessionManager: { getSessionDir: () => "/tmp/session" },
		} as unknown as CommandCtx & ProgressCtx

		await handleStatus(ctx, store, { activeRunIds: () => [], width: 76 }, RUN_ID)

		expect(loadValidatedWorkflow).not.toHaveBeenCalled()
		expect(notes[0]?.[0]).toContain("Built-in: builtin:missing")
		expect(notes[0]?.[0]).toContain('package-owned workflow "missing" is not registered')
		expect(notes[0]?.[1]).toBe("error")
	})
})
