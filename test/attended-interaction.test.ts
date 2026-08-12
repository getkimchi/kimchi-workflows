import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { CommandCtx, StartAgent } from "../src/host/commands/index.ts"
import { handleRun } from "../src/host/commands/index.ts"
import { createMemoryStore } from "../src/host/memory-store.ts"
import { createFakeRunLock } from "./helpers.ts"

const flowImport = path.resolve(import.meta.dirname, "../src/flow/index.ts")
const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const noAgent: StartAgent = () => {
	throw new Error("no agent expected")
}

function workflowSource(renderBody: string): string {
	return [
		'import { Type } from "typebox";',
		`import { createInteractiveStep, createStep, createWorkflow } from ${JSON.stringify(flowImport)};`,
		"const response = Type.Object({ approved: Type.Boolean() });",
		"const review = createInteractiveStep({",
		'  name: "review",',
		"  request: Type.Object({ markdown: Type.String() }),",
		"  output: response,",
		'  buildRequest: () => ({ markdown: "# Exact persisted plan" }),',
		`  render: async ({ request, ui }) => { ${renderBody} },`,
		"});",
		'const finish = createStep({ name: "finish", input: response, output: Type.String(), run: ({ input }) => input.approved ? "yes" : "no" });',
		'export default createWorkflow({ name: "attended-interaction" }).then(review).then(finish).commit();',
	].join("\n")
}

describe("attended workflow-defined interactions", () => {
	it("renders after the project lock is released, then resumes the exact blocked path", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "workflow-attended-interaction-"))
		roots.push(root)
		const file = path.join(root, "demo.workflow.ts")
		await writeFile(
			file,
			workflowSource(
				'const choice = await ui.select(request.markdown, ["Approve", "Revise"]); return choice === "Approve" ? { approved: true } : undefined;',
			),
			"utf8",
		)

		const guard = createFakeRunLock()
		const select = vi.fn(async () => {
			expect(guard.active).toBeUndefined()
			return "Approve"
		})
		const notify = vi.fn()
		const ctx = {
			cwd: root,
			mode: "tui",
			hasUI: true,
			modelRegistry: {},
			ui: { select, notify },
		} as unknown as CommandCtx
		const store = createMemoryStore()

		await handleRun(ctx, store, guard, noAgent, file)

		const summary = (await store.list())[0]
		expect(summary?.status).toBe("completed")
		const events = await store.loadEvents(summary?.runId ?? "")
		expect(events.filter((event) => event.type === "interaction-requested")).toHaveLength(1)
		expect(events.filter((event) => event.type === "interaction-provided")).toHaveLength(1)
		expect(events.find((event) => event.type === "step-completed" && event.path === "finish")).toMatchObject({
			output: "yes",
		})
		expect(select).toHaveBeenCalledWith("# Exact persisted plan", ["Approve", "Revise"])
		expect(guard.active).toBeUndefined()
	})

	it("leaves the run blocked when the renderer is dismissed", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "workflow-attended-dismiss-"))
		roots.push(root)
		const file = path.join(root, "demo.workflow.ts")
		await writeFile(file, workflowSource('await ui.select(request.markdown, ["Approve"]); return undefined;'), "utf8")
		const guard = createFakeRunLock()
		const notify = vi.fn()
		const ctx = {
			cwd: root,
			mode: "tui",
			hasUI: true,
			modelRegistry: {},
			ui: { select: vi.fn(async () => undefined), notify },
		} as unknown as CommandCtx
		const store = createMemoryStore()

		await handleRun(ctx, store, guard, noAgent, file)

		const summary = (await store.list())[0]
		expect(summary?.status).toBe("blocked")
		const events = await store.loadEvents(summary?.runId ?? "")
		expect(events.some((event) => event.type === "interaction-provided")).toBe(false)
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("is still blocked"), "info")
		expect(guard.active).toBeUndefined()
	})

	it("reports renderer failure without writing a response or taking the lock again", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "workflow-attended-failure-"))
		roots.push(root)
		const file = path.join(root, "demo.workflow.ts")
		await writeFile(file, workflowSource('throw new Error("renderer exploded");'), "utf8")
		const guard = createFakeRunLock()
		const notify = vi.fn()
		const ctx = {
			cwd: root,
			mode: "tui",
			hasUI: true,
			modelRegistry: {},
			ui: { notify },
		} as unknown as CommandCtx
		const store = createMemoryStore()

		await handleRun(ctx, store, guard, noAgent, file)

		const summary = (await store.list())[0]
		expect(summary?.status).toBe("blocked")
		const events = await store.loadEvents(summary?.runId ?? "")
		expect(events.some((event) => event.type === "interaction-provided")).toBe(false)
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("renderer exploded"), "warning")
		expect(guard.active).toBeUndefined()
	})
})
