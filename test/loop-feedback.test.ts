import { type TSchema, Type } from "typebox"
import { describe, expect, it } from "vitest"
import { resumeWithAnswer } from "../src/engine/resume-workflow.ts"
import { runWorkflow } from "../src/engine/run-workflow.ts"
import { createQuestionnaireStep, createStep, createWorkflow } from "../src/flow/index.ts"
import { createTestHost } from "./helpers.ts"

const valueSchema = Type.Object({ best: Type.Integer() })

describe("loop feedback (Feature 2): pass-through and the loop's own output", () => {
	it("a round that produces nothing forwards what it received; the loop completes with the last defined value (spec 2.3/2.5)", async () => {
		const inputsSeen: unknown[] = []
		const rawSeenByPredicate: unknown[] = []
		let downstreamRead: unknown

		const produce = createStep({
			name: "produce",
			input: Type.Any(),
			output: valueSchema,
			optional: true,
			run: ({ input, ctx }) => {
				inputsSeen.push(input)
				const round = ctx.scope("rounds")?.iteration ?? 0
				if (round >= 2) throw new Error(`round ${round} lost`)
				return { best: round }
			},
		})
		const body = createWorkflow({ name: "round" }).then(produce).commit()
		const after = createStep({
			name: "after",
			output: valueSchema,
			run: ({ ctx }) => {
				downstreamRead = ctx.getStepResult("rounds") // the loop by its BARE name (spec 2.5)
				return { best: -1 }
			},
		})
		const workflow = createWorkflow({ name: "carrying" })
			.then(createStep({ name: "seed", output: valueSchema, run: () => ({ best: 0 }) }))
			.dountil(
				body,
				(ctx, last) => {
					rawSeenByPredicate.push(last)
					return (ctx.scope("rounds")?.iteration ?? 0) >= 3
				},
				{ name: "rounds", maxIterations: 5 },
			)
			.then(after)
			.commit()

		const result = await runWorkflow(workflow, undefined, createTestHost().host)
		expect(result.status).toBe("completed")

		// Round 1 receives the upstream seed; rounds 2 and 3 the fed value — round 2's failure did NOT
		// erase round 1's result (spec 2.3): round 3 received exactly what round 2 received.
		expect(inputsSeen).toEqual([{ best: 0 }, { best: 1 }, { best: 1 }])
		// The predicate sees the RAW body output (spec 2.4): undefined on the failed rounds.
		expect(rawSeenByPredicate).toEqual([{ best: 1 }, undefined, undefined])
		// The loop's own output is the final effective value, not the last round's undefined (spec 2.5).
		expect(downstreamRead).toEqual({ best: 1 })
	})

	it("a loop whose body NEVER produces output completes with its upstream input", async () => {
		const doomed = createStep({
			name: "doomed",
			input: Type.Any(),
			output: valueSchema,
			optional: true,
			run: () => {
				throw new Error("always fails")
			},
		})
		const body = createWorkflow({ name: "round" }).then(doomed).commit()
		const workflow = createWorkflow({ name: "all-lost" })
			.then(createStep({ name: "seed", output: valueSchema, run: () => ({ best: 42 }) }))
			.dountil(body, (ctx) => (ctx.scope("rounds")?.iteration ?? 0) >= 2, { name: "rounds", maxIterations: 3 })
			.commit()

		const result = await runWorkflow(workflow, undefined, createTestHost().host)
		expect(result.status).toBe("completed")
		expect(result.output).toEqual({ best: 42 })
	})
})

describe("loop feedback (Feature 2): commit-time schema agreement (spec 2.2)", () => {
	const otherSchema = Type.Object({ different: Type.String() })
	const step = (name: string, input?: TSchema, output?: TSchema) => createStep({ name, input, output, run: () => ({}) })

	it("rejects a body whose first step cannot consume its last step's output", () => {
		const body = createWorkflow({ name: "round" })
			.then(step("head", valueSchema, otherSchema))
			.commit()
		expect(() => createWorkflow({ name: "broken" }).dountil(body, () => true, { name: "rounds" })).toThrow(
			/cannot consume its own output/,
		)
	})

	it("accepts agreement by reference, structural equality, an unconstrained head, and absent schemas", () => {
		// Same reference.
		const sameRef = createWorkflow({ name: "round" })
			.then(step("a", valueSchema, valueSchema))
			.commit()
		// Structurally equal, separately constructed.
		const structural = createWorkflow({ name: "round" })
			.then(step("b", Type.Object({ best: Type.Integer() }), Type.Object({ best: Type.Integer() })))
			.commit()
		// Unconstrained head input consumes anything.
		const anyHead = createWorkflow({ name: "round" })
			.then(step("c", Type.Any(), otherSchema))
			.commit()
		// No schemas declared: nothing to compare — runtime validation is the backstop.
		const bare = createWorkflow({ name: "round" }).then(step("d")).commit()

		for (const body of [sameRef, structural, anyHead, bare]) {
			expect(() => createWorkflow({ name: "fine" }).dountil(body, () => true, { name: "rounds" })).not.toThrow()
		}
	})
})

describe("loop feedback (Feature 2): resume alignment (spec 2.6)", () => {
	it("a deep re-entry reseeds the fed value to the last DEFINED body output — a failed round stays lost, not the value", async () => {
		const fedSeen: unknown[] = []
		const confirmSchema = Type.Object({ go: Type.Boolean() })
		const produce = createStep({
			name: "produce",
			output: valueSchema,
			optional: true,
			run: ({ ctx }) => {
				const round = ctx.scope("rounds")?.iteration ?? 0
				const fed = ctx.scope("rounds")?.input as { best?: number } | undefined
				fedSeen.push(fed)
				if (round === 2) throw new Error("round 2 lost")
				return { best: (fed?.best ?? 0) + 1 }
			},
		})
		const body = createWorkflow({ name: "round" })
			.then(createQuestionnaireStep({ name: "confirm", output: confirmSchema }))
			.then(produce)
			.commit()
		const workflow = createWorkflow({ name: "blocking-rounds" })
			.then(createStep({ name: "seed", output: valueSchema, run: () => ({ best: 10 }) }))
			.dountil(body, (ctx) => (ctx.scope("rounds")?.iteration ?? 0) >= 3, { name: "rounds", maxIterations: 4 })
			.commit()

		const { host, store } = createTestHost()
		let result = await runWorkflow(workflow, undefined, host)
		for (let answers = 0; answers < 3 && result.status === "blocked"; answers++) {
			result = await resumeWithAnswer(workflow, await store.loadEvents(result.runId), { go: true }, host)
		}

		expect(result.status).toBe("completed")
		// Round 1 fed the upstream seed; round 2 fed round 1's output (reseeded across the block); round 3 —
		// reached through ANOTHER deep re-entry after round 2 failed — fed round 1's output again: the
		// reseed found the last recorded `step-completed`, exactly the pass-through value (spec 2.3/2.6).
		expect(fedSeen).toEqual([{ best: 10 }, { best: 11 }, { best: 11 }])
		expect(result.status === "completed" && result.output).toEqual({ best: 12 })
	})
})
