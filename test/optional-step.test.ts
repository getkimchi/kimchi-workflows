import { Type } from "typebox"
import { describe, expect, it } from "vitest"
import { deriveRunStatus } from "../src/engine/run-status.ts"
import { runWorkflow } from "../src/engine/run-workflow.ts"
import { deriveStepStates, stepState } from "../src/engine/step-state.ts"
import { createStep, createWorkflow } from "../src/flow/index.ts"
import { createTestHost } from "./helpers.ts"

const countSchema = Type.Object({ n: Type.Integer() })

/**
 * `optional` (spec §9.1): a step whose final failure the run is allowed to survive. It exists for a
 * step whose job is to make progress rather than to produce a value — a time-boxed worker inside a
 * repair loop, where losing the whole run to one overrun is strictly worse than checking what landed
 * and going round again. Everything downstream still sees `undefined`, so a step whose output is
 * consumed should NOT be optional; that is why it is off by default.
 */
describe("optional steps", () => {
	it("records the failure and carries on with an undefined output", async () => {
		const workflow = createWorkflow({ name: "optional-continue" })
			.then(
				createStep({
					name: "flaky",
					output: countSchema,
					optional: true,
					run: () => {
						throw new Error("boom")
					},
				}),
			)
			.then(
				createStep({
					name: "after",
					output: Type.Object({ saw: Type.Boolean() }),
					run: ({ ctx }) => ({ saw: ctx.getStepResult("flaky") === undefined }),
				}),
			)
			.commit()

		const { host, store } = createTestHost()
		const result = await runWorkflow(workflow, undefined, host)

		expect(result.status).toBe("completed")
		expect(result.output).toEqual({ saw: true }) // the next step ran, and reads `undefined` for the failure

		const events = await store.loadEvents(result.runId)
		expect(events.filter((e) => e.type === "step-failed")).toEqual([
			expect.objectContaining({ path: "flaky", error: expect.stringContaining("boom") }),
		])
		expect(events.some((e) => e.type === "step-completed" && e.path === "flaky")).toBe(false) // never claims success
	})

	it("still reports the step itself as crashed, so the loss is visible in a listing", async () => {
		const workflow = createWorkflow({ name: "optional-state" })
			.then(
				createStep({
					name: "flaky",
					optional: true,
					run: () => {
						throw new Error("boom")
					},
				}),
			)
			.then(createStep({ name: "after", run: () => ({}) }))
			.commit()

		const { host, store } = createTestHost()
		const result = await runWorkflow(workflow, undefined, host)
		const events = await store.loadEvents(result.runId)

		expect(deriveRunStatus(events)).toBe("completed") // the RUN survived…
		expect(stepState(deriveStepStates(events), "flaky")).toBe("crashed") // …and the step did not
		expect(stepState(deriveStepStates(events), "after")).toBe("completed")
	})

	it("exhausts the retry policy first — optional is a last resort, not a way to skip retries", async () => {
		let attempts = 0
		const workflow = createWorkflow({ name: "optional-retry" })
			.then(
				createStep({
					name: "flaky",
					optional: true,
					retry: { maxRetry: 2 },
					run: () => {
						attempts += 1
						throw new Error("boom")
					},
				}),
			)
			.commit()

		const { host, store } = createTestHost()
		const result = await runWorkflow(workflow, undefined, host)

		expect(result.status).toBe("completed")
		expect(attempts).toBe(3) // first attempt + two retries
		const events = await store.loadEvents(result.runId)
		expect(events.filter((e) => e.type === "step-retry")).toHaveLength(2)
		expect(events.filter((e) => e.type === "step-failed")).toHaveLength(1)
	})

	it("does not swallow a cancel: a cancelled run still stops", async () => {
		const controller = new AbortController()
		const workflow = createWorkflow({ name: "optional-cancel" })
			.then(
				createStep({
					name: "slow",
					optional: true,
					run: () => {
						controller.abort()
						throw new Error("cooperatively stopping")
					},
				}),
			)
			.then(createStep({ name: "after", run: () => ({ ran: true }) }))
			.commit()

		const { host, store } = createTestHost()
		const result = await runWorkflow(workflow, undefined, host, { signal: controller.signal })

		// `optional` covers failure, not cancellation — the run was asked to stop, so it stops.
		expect(result.status).toBe("cancelled")
		const events = await store.loadEvents(result.runId)
		expect(events.some((e) => e.type === "step-completed" && e.path === "after")).toBe(false)
	})

	it("is off by default: an ordinary step's failure still crashes the run", async () => {
		const workflow = createWorkflow({ name: "not-optional" })
			.then(
				createStep({
					name: "flaky",
					run: () => {
						throw new Error("boom")
					},
				}),
			)
			.then(createStep({ name: "after", run: () => ({}) }))
			.commit()

		const { host, store } = createTestHost()
		const result = await runWorkflow(workflow, undefined, host)

		expect(result.status).toBe("crashed")
		const events = await store.loadEvents(result.runId)
		expect(events.some((e) => e.type === "step-failed")).toBe(false)
	})
})
