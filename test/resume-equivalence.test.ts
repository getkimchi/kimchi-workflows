import { Type } from "typebox"
import { describe, expect, it } from "vitest"
import { resumeWorkflow } from "../src/engine/resume-workflow.ts"
import { runWorkflow } from "../src/engine/run-workflow.ts"
import { createStep, createWorkflow } from "../src/flow/index.ts"
import { createTestHost } from "./helpers.ts"

const counterSchema = Type.Object({ n: Type.Integer() })

/**
 * `before -> dountil(loop body)`. The loop body is `observer -> producer`:
 *  - `observer` reads `ctx.getStepResult("producer")` and records what it saw (per call);
 *  - `producer` increments the counter and, on the *first* run, throws when it would reach n=2.
 *
 * "producer" only exists inside the loop node. After the first (interrupted) run, "producer" has a
 * recorded completion (from iteration 1). On resume, iteration 1's `observer` must see `undefined`
 * for `getStepResult("producer")` — exactly like a fresh run — NOT the stale iteration-1 value.
 */
function buildProbeWorkflow(failProducer: boolean) {
	const observed: unknown[] = []
	const calls = { before: 0 }

	const before = createStep({
		name: "before",
		output: counterSchema,
		run: () => {
			calls.before += 1
			return { n: 0 }
		},
	})

	const observer = createStep({
		name: "observer",
		input: counterSchema,
		output: counterSchema,
		run: ({ input, ctx }) => {
			observed.push(ctx.getStepResult("producer")) // forward reference within the same node
			return input // pass the counter through to `producer`
		},
	})

	const producer = createStep({
		name: "producer",
		input: counterSchema,
		output: counterSchema,
		run: ({ input }) => {
			const next = input.n + 1
			if (failProducer && next === 2) throw new Error("boom in producer")
			return { n: next }
		},
	})

	const body = createWorkflow({ name: "probe-body" }).then(observer).then(producer).commit()
	const workflow = createWorkflow({ name: "probe" })
		.then(before)
		.dountil(body, (_ctx, last) => (last as { n: number }).n >= 2, { name: "probe-loop", maxIterations: 10 })
		.commit()

	return { workflow, observed, calls }
}

describe("fresh ≡ resume invariant (spec §8): resume state matches an interrupted fresh run", () => {
	it("a re-run body step reading a not-yet-completed inner name sees undefined, not a stale prior value", async () => {
		// Baseline: a fully fresh run records what `observer` sees each iteration.
		const fresh = buildProbeWorkflow(false)
		const freshHost = createTestHost()
		const freshResult = await runWorkflow(fresh.workflow, undefined, freshHost.host)
		expect(freshResult.status).toBe("completed")
		expect(freshResult.output).toEqual({ n: 2 })
		// iter1 observer sees undefined (producer not yet run); iter2 sees iter1's producer output.
		expect(fresh.observed).toEqual([undefined, { n: 1 }])

		// Interrupt: producer throws when it would reach n=2 (iteration 2), leaving the loop incomplete.
		const run = buildProbeWorkflow(true)
		const { host, store } = createTestHost()
		const first = await runWorkflow(run.workflow, undefined, host)
		expect(first.status).toBe("crashed")
		// producer completed once (iteration 1) → it IS recorded in the log, under iteration 1's own
		// dynamic path (spec §8.5).
		const priorEvents = await store.loadEvents(first.runId)
		expect(priorEvents.some((e) => e.type === "step-completed" && e.path === "probe-loop#1/producer")).toBe(true)
		expect(priorEvents.some((e) => e.type === "node-completed" && e.path === "probe-loop")).toBe(false)

		// Resume with a fixed producer; `resumeRun` has its own fresh `observed` array (empty at start).
		const resumeRun = buildProbeWorkflow(false)
		const resumed = await resumeWorkflow(resumeRun.workflow, priorEvents, host)

		expect(resumed.status).toBe("completed")
		expect(resumed.output).toEqual({ n: 2 })
		// THE INVARIANT: identical to the fresh run — iter1 sees undefined (not the stale {n:1}).
		expect(resumeRun.observed).toEqual([undefined, { n: 1 }])
		expect(resumeRun.observed[0]).toBeUndefined()
		// `before` (completed prefix) is not re-run.
		expect(resumeRun.calls.before).toBe(0)
	})

	it("a completed-prefix FOREACH's output stays readable by bare name after a resume", async () => {
		// A foreach keeps its item index in the static key (spec §5.4), so its inner steps are recorded as
		// `each@0/inner` — the seeded prefix must recognize those as belonging to the completed `each`
		// node. The reader consumes the foreach's own OUTPUT (its per-item array) by bare name: reaching
		// into sibling items by path was removed with names-only addressing (spec 4.1).
		const build = () => {
			let failAfter = true
			const body = createWorkflow({ name: "each-body" })
				.then(
					createStep({
						name: "inner",
						input: counterSchema,
						output: counterSchema,
						run: ({ input }) => ({ n: input.n * 10 }),
					}),
				)
				.commit()
			const seen: unknown[] = []
			const workflow = createWorkflow({ name: "foreach-prefix" })
				.foreach(body, () => [{ n: 1 }, { n: 2 }], { name: "each" })
				.then(
					createStep({
						name: "after",
						output: counterSchema,
						run: ({ ctx }) => {
							if (failAfter) {
								failAfter = false
								throw new Error("boom in after")
							}
							seen.push(...(ctx.getStepResult<unknown[]>("each") ?? []))
							return { n: 0 }
						},
					}),
				)
				.commit()
			return { workflow, seen }
		}

		const fresh = build()
		const freshHost = createTestHost()
		expect((await runWorkflow(fresh.workflow, undefined, freshHost.host)).status).toBe("crashed")
		// The retry-free crash leaves `after` incomplete; a second fresh run of the SAME definition (its
		// `failAfter` latch now spent) is the baseline for what the reader should see.
		const freshAgain = await runWorkflow(fresh.workflow, undefined, freshHost.host)
		expect(freshAgain.status).toBe("completed")
		expect(fresh.seen).toEqual([{ n: 10 }, { n: 20 }])

		const interrupted = build()
		const { host, store } = createTestHost()
		const first = await runWorkflow(interrupted.workflow, undefined, host)
		expect(first.status).toBe("crashed")

		const resumed = await resumeWorkflow(interrupted.workflow, await store.loadEvents(first.runId), host)
		expect(resumed.status).toBe("completed")
		// THE INVARIANT: the resumed `after` reads the completed foreach's per-item step outputs, exactly
		// as a fresh run does — the foreach itself is NOT re-run for them to be there.
		expect(interrupted.seen).toEqual([{ n: 10 }, { n: 20 }])
	})
})
