import { Type } from "typebox"
import { describe, expect, it } from "vitest"
import { resumeWorkflow } from "../src/engine/resume-workflow.ts"
import { runWorkflow } from "../src/engine/run-workflow.ts"
import { createStep, createWorkflow } from "../src/flow/index.ts"
import { createTestHost } from "./helpers.ts"
import { createStepBarrier } from "./step-barrier.ts"

const itemSchema = Type.Object({ n: Type.Integer() })
const resultSchema = Type.Object({ n: Type.Integer() })

/**
 * spec §8.3: "With concurrency, several steps may be interrupted at once; each re-runs by the same
 * rule, so the idempotency exposure scales with the fan-out." This exercises exactly that: THREE items
 * genuinely in flight (none completed, none checkpointed) at the moment of interruption, then a
 * node-atomic resume that must re-run all three — not recover a partial history — while still
 * producing the SAME item-ordered output a fresh, uninterrupted run would.
 */
describe("resume correctness when several concurrent steps were in flight (spec §8.3)", () => {
	it(".foreach(concurrency=3): cancelling while all 3 items are in flight interrupts every one; resume re-runs all three, in item order", async () => {
		const barrier = createStepBarrier<number>()
		const runsPerItem = new Map<number, number>() // proves each item's body ran again on resume, not recovered

		const body = createWorkflow({ name: "cancellable-body" })
			.then(
				createStep({
					name: "process",
					input: itemSchema,
					output: resultSchema,
					run: async ({ input, abortSignal }) => {
						runsPerItem.set(input.n, (runsPerItem.get(input.n) ?? 0) + 1)
						await barrier.enter(input.n) // suspend here — genuinely in flight
						if (abortSignal.aborted) throw new Error("cooperatively stopping: cancelled")
						return { n: input.n }
					},
				}),
			)
			.commit()
		const workflow = createWorkflow({ name: "cancel-several-in-flight" })
			.foreach(body, () => [{ n: 0 }, { n: 1 }, { n: 2 }], { name: "each", concurrency: 3 })
			.commit()

		const { host, store } = createTestHost()
		const controller = new AbortController()
		const firstRun = runWorkflow(workflow, undefined, host, { signal: controller.signal })

		// All three items are genuinely concurrent: none can proceed until all three have started.
		await Promise.all([barrier.waitFor(0), barrier.waitFor(1), barrier.waitFor(2)])

		controller.abort() // the cancel signal fires while all three are still suspended, in flight
		// Release them in a DIFFERENT order than they started, to prove the interruption/resume story
		// does not depend on completion order either.
		barrier.release(2)
		barrier.release(0)
		barrier.release(1)

		const first = await firstRun
		expect(first.status).toBe("cancelled")
		expect(runsPerItem).toEqual(
			new Map([
				[0, 1],
				[1, 1],
				[2, 1],
			]),
		) // each body ran exactly once so far

		const priorEvents = await store.loadEvents(first.runId)
		// None of the three items checkpointed — they were interrupted, not completed.
		expect(priorEvents.some((e) => e.type === "foreach-item-completed")).toBe(false)

		// Resume: node-atomic restart re-runs the WHOLE foreach (nothing was checkpointed to skip).
		const resumed = await resumeWorkflow(workflow, priorEvents, host)
		expect(resumed.status).toBe("completed")
		// Every item's body ran a SECOND time — genuinely re-run, not recovered from a partial log.
		expect(runsPerItem).toEqual(
			new Map([
				[0, 2],
				[1, 2],
				[2, 2],
			]),
		)
		// Item order preserved in the final output regardless of any interleaving on either attempt.
		expect(resumed.output).toEqual([{ n: 0 }, { n: 1 }, { n: 2 }])
	})

	it(".foreach: a resume that mixes CHECKPOINTED items with an interrupted one re-runs only the interrupted item", async () => {
		const barrier = createStepBarrier<number>()
		const runsPerItem = new Map<number, number>()

		const body = createWorkflow({ name: "mixed-cancel-body" })
			.then(
				createStep({
					name: "process",
					input: itemSchema,
					output: resultSchema,
					run: async ({ input, abortSignal }) => {
						runsPerItem.set(input.n, (runsPerItem.get(input.n) ?? 0) + 1)
						if (input.n === 1) {
							await barrier.enter(1) // only item 1 suspends — the one that gets interrupted
							if (abortSignal.aborted) throw new Error("cooperatively stopping: cancelled")
						}
						return { n: input.n }
					},
				}),
			)
			.commit()
		const workflow = createWorkflow({ name: "mixed-cancel" })
			.foreach(body, () => [{ n: 0 }, { n: 1 }, { n: 2 }], { name: "each", concurrency: 3 })
			.commit()

		const { host, store } = createTestHost()
		const controller = new AbortController()
		const firstRun = runWorkflow(workflow, undefined, host, { signal: controller.signal })

		await barrier.waitFor(1) // items 0 and 2 (no gating) have already completed by construction
		controller.abort()
		barrier.release(1)

		const first = await firstRun
		expect(first.status).toBe("cancelled")

		const priorEvents = await store.loadEvents(first.runId)
		const completedIndices = priorEvents.filter((e) => e.type === "foreach-item-completed").map((e) => e.index)
		expect(completedIndices.toSorted((a, b) => a - b)).toEqual([0, 2]) // items 0,2 checkpointed; item 1 did not

		const resumed = await resumeWorkflow(workflow, priorEvents, host)
		expect(resumed.status).toBe("completed")
		expect(resumed.output).toEqual([{ n: 0 }, { n: 1 }, { n: 2 }])
		// Items 0 and 2 were NOT re-run (recovered from checkpoint); only item 1 ran a second time.
		expect(runsPerItem.get(0)).toBe(1)
		expect(runsPerItem.get(2)).toBe(1)
		expect(runsPerItem.get(1)).toBe(2)
	})
})
