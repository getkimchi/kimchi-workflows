import { fileURLToPath } from "node:url"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { runWorkflow } from "../src/engine/run-workflow.ts"
import createWorkflowWorkflow from "../src/host/builtin/create.workflow.ts"
import type { CommandCtx, StartAgent } from "../src/host/commands/index.ts"
import { handleResume } from "../src/host/commands/index.ts"
import { createHostPort } from "../src/host/host-port.ts"
import { createMemoryStore } from "../src/host/memory-store.ts"
import { BUILTIN_CREATE_WORKFLOW } from "../src/host/recorded-workflow.ts"
import { createFakeActiveRuns } from "./helpers.ts"
import { scriptedAgent } from "./scripted-agent.ts"

const { loadValidatedWorkflow } = vi.hoisted(() => ({
	loadValidatedWorkflow: vi.fn(async () => ({
		ok: false as const,
		cause: "TypeScript validation failed: installed harness has no physical typebox package",
	})),
}))

vi.mock("../src/host/workflow-preflight.ts", () => ({ loadValidatedWorkflow }))

const RUN_ID = "workflow-create-workflow-a0e99eae"
const CREATE_WORKFLOW_FILE = fileURLToPath(new URL("../src/host/builtin/create.workflow.ts", import.meta.url))

const noAgent: StartAgent = () => {
	throw new Error("no agent expected")
}

describe("built-in create workflow resume", () => {
	beforeEach(() => loadValidatedWorkflow.mockClear())

	it("answers the built-in goal and continues without project-workflow validation", async () => {
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

		const notify = vi.fn()
		const inputs = ["Build a release-notes workflow", undefined]
		const agent = scriptedAgent([
			[
				JSON.stringify({
					questions: {
						title: "Clarify delivery",
						questions: [
							{
								key: "delivery",
								header: "Delivery",
								question: "How should the release notes be delivered?",
								kind: "text",
							},
						],
					},
				}),
			],
		])
		const ctx = {
			cwd: "/tmp",
			mode: "print",
			hasUI: false,
			modelRegistry: {},
			ui: {
				notify,
				input: vi.fn(async () => inputs.shift()),
				select: vi.fn(async () => undefined),
				confirm: vi.fn(async () => false),
			},
		} as unknown as CommandCtx

		await handleResume(ctx, store, createFakeActiveRuns(), agent.startAgent as StartAgent, RUN_ID)

		expect(loadValidatedWorkflow).not.toHaveBeenCalled()
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("is still blocked"), "info")
		expect((await store.list())[0]?.status).toBe("blocked")
		const events = await store.loadEvents(RUN_ID)
		expect(events).toContainEqual(expect.objectContaining({ type: "step-completed", path: "goal" }))
		expect(events.filter((event) => event.type === "questionnaire-asked")).toHaveLength(2)
		expect(agent.opened).toBe(1)
	})

	it("recognizes legacy package-path provenance without project-workflow validation", async () => {
		const store = createMemoryStore()
		await store.appendEvent({
			type: "run-meta",
			runId: RUN_ID,
			workflowFilePath: CREATE_WORKFLOW_FILE,
			at: new Date().toISOString(),
		})
		const result = await runWorkflow(
			createWorkflowWorkflow,
			{ projectRoot: "/tmp", workflowsDir: "/tmp/.kimchi/workflows" },
			createHostPort(store, { generateRunId: () => RUN_ID }),
		)
		expect(result.status).toBe("blocked")

		const notify = vi.fn()
		const ctx = {
			cwd: "/tmp",
			mode: "print",
			hasUI: false,
			modelRegistry: {},
			ui: {
				notify,
				input: vi.fn(async () => undefined),
				select: vi.fn(async () => undefined),
				confirm: vi.fn(async () => false),
			},
		} as unknown as CommandCtx

		await handleResume(ctx, store, createFakeActiveRuns(), noAgent, RUN_ID)

		expect(loadValidatedWorkflow).not.toHaveBeenCalled()
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("is still blocked"), "info")
	})
})
