/**
 * Dynamic wall-time budgets (spec §9.3): `maxDurationMs` as a function of run state.
 *
 * The case this exists for is a step inside a loop. A constant is the same on every iteration, so the
 * author must either pick a slice sized for the worst case — fragmenting the work and leaving the tail
 * of the budget unspent — or one big enough to be useful, which overruns on the last iteration. A
 * function can read what is actually left and hand each round a share of it.
 */
import { Type } from "typebox"
import { describe, expect, it } from "vitest"
import { runWorkflow } from "../src/engine/run-workflow.ts"
import { createStep, createWorkflow } from "../src/flow/index.ts"
import { createTestHost } from "./helpers.ts"
import { createManualClock } from "./manual-clock.ts"

const okSchema = Type.Object({ ok: Type.Boolean() })

describe("dynamic maxDurationMs (spec §9.3)", () => {
	it("resolves a function budget against run context and enforces it", async () => {
		const clock = createManualClock()
		const { host, store } = createTestHost({ sleep: clock.sleep })

		const remaining = createStep({
			name: "remaining",
			output: Type.Object({ ms: Type.Number() }),
			run: () => ({ ms: 4000 }),
		})
		// Takes a quarter of what the previous step reported was left.
		const slow = createStep({
			name: "slow",
			output: okSchema,
			maxDurationMs: ({ ctx }) => (ctx.getStepResult<{ ms: number }>("remaining")?.ms ?? 0) / 4,
			run: ({ abortSignal }) =>
				new Promise<{ ok: boolean }>((_resolve, reject) => {
					abortSignal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
				}),
		})

		const workflow = createWorkflow({ name: "dyn" }).then(remaining).then(slow).commit()
		const promise = runWorkflow(workflow, undefined, host)
		await clock.waitForTimer()
		clock.fireAll()
		const result = await promise

		expect(result.status).toBe("crashed")
		// 4000 / 4 — proves the function ran, saw `remaining`, and its value became the enforced budget.
		expect(result.error).toMatch(/1000ms time budget/)
		expect(result.error).toMatch(/slow/)
		const events = await store.loadEvents(result.runId)
		expect(events.filter((e) => e.type === "step-retry")).toHaveLength(0) // no retry configured
	})

	it("gives each loop iteration a share of the time actually left, so rounds shrink", async () => {
		const { host } = createTestHost()
		const budgets: number[] = []
		let left = 8000

		const round = createStep({
			name: "round",
			output: Type.Object({ n: Type.Number() }),
			// Half of what remains, recorded so the test can assert the schedule rather than the wall clock.
			maxDurationMs: () => {
				const share = left / 2
				budgets.push(share)
				return share
			},
			run: () => {
				left -= left / 2 // the round "spent" its slice
				return { n: budgets.length }
			},
		})

		const workflow = createWorkflow({ name: "shrinking" })
			.dountil(createWorkflow({ name: "body" }).then(round).commit(), (_ctx, last) => (last as { n: number }).n >= 3, {
				name: "loop",
				maxIterations: 5,
			})
			.commit()

		const result = await runWorkflow(workflow, undefined, host)
		expect(result.status).toBe("completed")
		// Resolved once per execution, and each execution saw less time than the one before it.
		expect(budgets).toEqual([4000, 2000, 1000])
	})

	it("treats a non-positive budget as no time left — fails the step without starting it", async () => {
		const { host } = createTestHost()
		let started = false

		const starved = createStep({
			name: "starved",
			output: okSchema,
			maxDurationMs: () => 0,
			optional: true, // the loop case: out of time costs the step, not the run
			run: () => {
				started = true
				return { ok: true }
			},
		})

		const after = createStep({ name: "after", output: okSchema, run: () => ({ ok: true }) })
		const workflow = createWorkflow({ name: "starved-run" }).then(starved).then(after).commit()

		const result = await runWorkflow(workflow, undefined, host)
		expect(result.status).toBe("completed")
		expect(started).toBe(false) // never even attempted
	})

	it("does not re-resolve the budget per retry — a retry is a second try, not fresh time", async () => {
		const clock = createManualClock()
		const { host } = createTestHost({ sleep: clock.sleep })
		let resolutions = 0

		const flaky = createStep({
			name: "flaky",
			output: okSchema,
			retry: { maxRetry: 2 },
			maxDurationMs: () => {
				resolutions++
				return 5000
			},
			run: () => {
				throw new Error("boom")
			},
		})

		const workflow = createWorkflow({ name: "retry-budget" }).then(flaky).commit()
		const result = await runWorkflow(workflow, undefined, host)

		expect(result.status).toBe("crashed")
		expect(resolutions).toBe(1) // three attempts, one budget
	})
})
