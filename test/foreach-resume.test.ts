import { Type } from "typebox"
import { describe, expect, it } from "vitest"
import { resumeWorkflow } from "../src/engine/resume-workflow.ts"
import { runWorkflow } from "../src/engine/run-workflow.ts"
import type { RunEvent } from "../src/engine/types.ts"
import { createStep, createWorkflow } from "../src/flow/index.ts"
import { createTestHost } from "./helpers.ts"

const itemSchema = Type.Object({ n: Type.Integer() })
const resultSchema = Type.Object({ n: Type.Integer(), ok: Type.Boolean() })
const ITEMS = [0, 1, 2, 3, 4]

/**
 * A top-level foreach over `ITEMS`; `body` records each item it processes into `processed`. With
 * `failItem2`, the body throws on item n=2 (mid-body interruption). `onItem` fires per item (used to
 * drive an external cancel).
 */
function buildForeachResumeWorkflow(opts: { failItem2?: boolean; onItem?: (n: number) => void } = {}) {
	const processed: number[] = []
	const body = createWorkflow({ name: "handle-body" })
		.then(
			createStep({
				name: "handle",
				input: itemSchema,
				output: resultSchema,
				run: ({ input }) => {
					processed.push(input.n)
					opts.onItem?.(input.n)
					if (opts.failItem2 && input.n === 2) throw new Error("boom on item 2")
					return { n: input.n, ok: true }
				},
			}),
		)
		.commit()

	const workflow = createWorkflow({ name: "foreach-resume" })
		.foreach(body, () => ITEMS.map((n) => ({ n })), { name: "each" })
		.commit()

	return { workflow, processed }
}

function completedItemIndices(events: RunEvent[]): number[] {
	return events
		.filter((e): e is Extract<RunEvent, { type: "foreach-item-completed" }> => e.type === "foreach-item-completed")
		.map((e) => e.index)
}

const FRESH_OUTPUT = ITEMS.map((n) => ({ n, ok: true }))

describe("foreach per-item resume (spec §3.4/§8)", () => {
	it("skips completed items and re-runs the interrupted item wholesale, matching a fresh run", async () => {
		// Baseline fresh run.
		const fresh = buildForeachResumeWorkflow()
		const freshResult = await runWorkflow(fresh.workflow, undefined, createTestHost().host)
		expect(freshResult.output).toEqual(FRESH_OUTPUT)
		expect(fresh.processed).toEqual(ITEMS)

		// Interrupted run: item 2's body throws → items 0,1 checkpointed, item 2 interrupted mid-body.
		const run = buildForeachResumeWorkflow({ failItem2: true })
		const { host, store } = createTestHost()
		const first = await runWorkflow(run.workflow, undefined, host)
		expect(first.status).toBe("crashed")
		expect(run.processed).toEqual([0, 1, 2]) // 0,1 completed; 2 ran and threw

		const priorEvents = await store.loadEvents(first.runId)
		expect(completedItemIndices(priorEvents)).toEqual([0, 1]) // only 0,1 checkpointed
		expect(priorEvents.some((e) => e.type === "node-completed" && e.path === "each")).toBe(false)

		// Resume with the body fixed.
		const resumeRun = buildForeachResumeWorkflow()
		const resumed = await resumeWorkflow(resumeRun.workflow, priorEvents, host)

		expect(resumed.status).toBe("completed")
		expect(resumed.runId).toBe(first.runId)
		expect(resumed.output).toEqual(FRESH_OUTPUT) // identical to a fresh run
		// Items 0,1 are NOT re-run; item 2 re-runs wholesale; 3,4 processed for the first time.
		expect(resumeRun.processed).toEqual([2, 3, 4])
		expect((await store.list())[0]).toMatchObject({ status: "completed" })
	})

	it("resumes at the first unstarted item after a clean cancel between items", async () => {
		// Cancel fires while processing item 1; item 2 never starts (clean per-item boundary).
		const controller = new AbortController()
		const run = buildForeachResumeWorkflow({ onItem: (n) => n === 1 && controller.abort() })
		const { host, store } = createTestHost()

		const first = await runWorkflow(run.workflow, undefined, host, { signal: controller.signal })
		expect(first.status).toBe("cancelled")
		expect(run.processed).toEqual([0, 1]) // item 2 never started

		const priorEvents = await store.loadEvents(first.runId)
		expect(completedItemIndices(priorEvents)).toEqual([0, 1])

		// Resume (no signal): items 0,1 skipped; 2,3,4 processed.
		const resumeRun = buildForeachResumeWorkflow()
		const resumed = await resumeWorkflow(resumeRun.workflow, priorEvents, host)

		expect(resumed.status).toBe("completed")
		expect(resumed.output).toEqual(FRESH_OUTPUT)
		expect(resumeRun.processed).toEqual([2, 3, 4])
	})
})
