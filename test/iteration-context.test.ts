import { Type } from "typebox"
import { describe, expect, it } from "vitest"
import { resumeWithAnswer } from "../src/engine/resume-workflow.ts"
import { runWorkflow } from "../src/engine/run-workflow.ts"
import type { AgentRequest } from "../src/engine/types.ts"
import type { ScopeFrame } from "../src/flow/index.ts"
import { createAgentStep, createQuestionnaireStep, createStep, createWorkflow } from "../src/flow/index.ts"
import { createTestHost } from "./helpers.ts"
import { scriptedAgent } from "./scripted-agent.ts"

const numberOutput = Type.Object({ n: Type.Integer() })

describe("iteration context (Feature 1): ctx.path", () => {
	it("a top-level step sees its own bare name as its path", async () => {
		let seen: string | undefined
		const workflow = createWorkflow({ name: "top" })
			.then(
				createStep({
					name: "solo",
					output: numberOutput,
					run: ({ ctx }) => {
						seen = ctx.path
						return { n: 1 }
					},
				}),
			)
			.commit()
		await runWorkflow(workflow, undefined, createTestHost().host)
		expect(seen).toBe("solo")
	})

	it("a step nested in workflow → foreach → loop sees the full dynamic path the event log records", async () => {
		const paths: string[] = []
		const rounds = createWorkflow({ name: "attempts" })
			.then(
				createStep({
					name: "turn",
					output: numberOutput,
					run: ({ ctx }) => {
						paths.push(ctx.path)
						return { n: 1 }
					},
				}),
			)
			.commit()
		const perItem = createWorkflow({ name: "item-body" })
			.dountil(rounds, (_ctx, last) => (last as { n: number }).n >= 1, { name: "spins", maxIterations: 3 })
			.commit()
		const inner = createWorkflow({ name: "phase" })
			.foreach(perItem, () => ["a", "b"], { name: "steps" })
			.commit()
		const workflow = createWorkflow({ name: "outer" }).workflow(inner).commit()

		const { host, events } = await runToCompletion(workflow)
		expect(paths).toEqual(["phase/steps@0/spins#1/turn", "phase/steps@1/spins#1/turn"])
		// The same strings the event log records for the step (spec 1.1).
		const logged = events
			.filter((event) => event.type === "step-completed" && event.path.endsWith("/turn"))
			.map((event) => ("path" in event ? event.path : ""))
		expect(logged).toEqual(paths)
		void host
	})

	it("a branch predicate and a foreach selector see the construct's own path", async () => {
		let branchPath: string | undefined
		let foreachPath: string | undefined
		const armBody = createWorkflow({ name: "yes" })
			.then(createStep({ name: "inside", output: numberOutput, run: () => ({ n: 1 }) }))
			.commit()
		const itemBody = createWorkflow({ name: "per-item" })
			.then(createStep({ name: "eat", output: numberOutput, run: () => ({ n: 2 }) }))
			.commit()
		const workflow = createWorkflow({ name: "construct-paths" })
			.branch(
				[
					[
						(ctx) => {
							branchPath = ctx.path
							return true
						},
						armBody,
					],
				],
				{ name: "decide" },
			)
			.foreach(
				itemBody,
				(ctx) => {
					foreachPath = ctx.path
					return [1]
				},
				{ name: "batch" },
			)
			.commit()
		await runWorkflow(workflow, undefined, createTestHost().host)
		expect(branchPath).toBe("decide")
		expect(foreachPath).toBe("batch")
	})

	it("a loop predicate sees the ITERATION's path — the same string the loop-iteration event records", async () => {
		// Deliberate asymmetry with the branch/foreach construct paths above: the predicate evaluates a
		// specific iteration, so its path IS the iteration path (`rounds#2`) — what the `loop-iteration`
		// event logs, and what `ctx.scope(name).iteration` corresponds to (spec 1.2).
		const predicatePaths: string[] = []
		const iterationEventPaths: string[] = []
		const body = createWorkflow({ name: "round" })
			.then(
				createStep({
					name: "work",
					input: Type.Any(),
					output: numberOutput,
					run: ({ input }) => ({ n: ((input as { n?: number } | undefined)?.n ?? 0) + 1 }),
				}),
			)
			.commit()
		const workflow = createWorkflow({ name: "iterating" })
			.dountil(
				body,
				(ctx, last) => {
					predicatePaths.push(ctx.path)
					return (last as { n: number }).n >= 3
				},
				{ name: "rounds", maxIterations: 5 },
			)
			.commit()

		const { host, events } = createTestHost()
		const result = await runWorkflow(workflow, undefined, host)
		expect(result.status).toBe("completed")

		expect(predicatePaths).toEqual(["rounds#1", "rounds#2", "rounds#3"])
		for (const event of events) {
			if (event.type === "loop-iteration" && "path" in event) iterationEventPaths.push(event.path)
		}
		// Each predicate call followed its iteration's event — the path is identity, not decoration.
		expect(iterationEventPaths).toEqual(predicatePaths)
	})
})

describe("iteration context (Feature 1): ctx.scope()", () => {
	it("returns undefined at the top level, the nearest frame otherwise, and outer frames by name", async () => {
		let topScope: ScopeFrame | undefined | null = null
		const captured: Record<string, ScopeFrame | undefined> = {}

		const rounds = createWorkflow({ name: "attempts" })
			.then(
				createStep({
					name: "turn",
					output: numberOutput,
					run: ({ ctx }) => {
						captured.nearest = ctx.scope()
						captured.byLoopName = ctx.scope("spins")
						captured.byForeachName = ctx.scope("steps")
						captured.unknown = ctx.scope("nope")
						return { n: 1 }
					},
				}),
			)
			.commit()
		const perItem = createWorkflow({ name: "item-body" })
			.dountil(rounds, (_ctx, last) => (last as { n: number }).n >= 1, { name: "spins", maxIterations: 3 })
			.commit()
		const workflow = createWorkflow({ name: "scoped" })
			.then(
				createStep({
					name: "first",
					output: numberOutput,
					run: ({ ctx }) => {
						topScope = ctx.scope()
						return { n: 0 }
					},
				}),
			)
			.foreach(perItem, () => ["only"], { name: "steps" })
			.commit()

		await runWorkflow(workflow, undefined, createTestHost().host)

		expect(topScope).toBeUndefined()
		expect(captured.nearest).toMatchObject({ kind: "loop", name: "spins", iteration: 1 })
		expect(captured.byLoopName).toBe(captured.nearest)
		expect(captured.byForeachName).toMatchObject({
			kind: "foreach",
			name: "steps",
			itemIndex: 0,
			itemCount: 1,
			input: "only",
		})
		expect(captured.unknown).toBeUndefined()
	})

	it("the loop frame carries the 1-based iteration and the fed-back input (spec 1.6)", async () => {
		const frames: (ScopeFrame | undefined)[] = []
		const body = createWorkflow({ name: "round" })
			.then(
				createStep({
					name: "work",
					input: Type.Any(),
					output: numberOutput,
					run: ({ ctx, input }) => {
						frames.push(ctx.scope())
						const previous = (input as { n?: number } | undefined)?.n ?? 0
						return { n: previous + 1 }
					},
				}),
			)
			.commit()
		const workflow = createWorkflow({ name: "counting" })
			.dountil(body, (_ctx, last) => (last as { n: number }).n >= 3, { name: "rounds", maxIterations: 5 })
			.commit()

		await runWorkflow(workflow, undefined, createTestHost().host)

		expect(frames.map((frame) => frame?.iteration)).toEqual([1, 2, 3])
		// Iteration 1 receives the loop's upstream input (none here); 2 and 3 the previous body output.
		expect(frames[0]?.input).toBeUndefined()
		expect(frames[1]?.input).toEqual({ n: 1 })
		expect(frames[2]?.input).toEqual({ n: 2 })
	})

	it("the foreach frame carries item index/count/value at concurrency 1 and above", async () => {
		for (const concurrency of [1, 2]) {
			const seen: (ScopeFrame | undefined)[] = []
			const body = createWorkflow({ name: "per-item" })
				.then(
					createStep({
						name: "eat",
						output: numberOutput,
						run: ({ ctx }) => {
							seen.push(ctx.scope())
							return { n: 0 }
						},
					}),
				)
				.commit()
			const workflow = createWorkflow({ name: `fan-${concurrency}`, maxConcurrency: 4 })
				.foreach(body, () => ["x", "y", "z"], { name: "batch", concurrency })
				.commit()

			await runWorkflow(workflow, undefined, createTestHost().host)

			const sorted = [...seen].sort((a, b) => (a?.itemIndex ?? 0) - (b?.itemIndex ?? 0))
			expect(sorted).toEqual([
				{ kind: "foreach", name: "batch", itemIndex: 0, itemCount: 3, input: "x" },
				{ kind: "foreach", name: "batch", itemIndex: 1, itemCount: 3, input: "y" },
				{ kind: "foreach", name: "batch", itemIndex: 2, itemCount: 3, input: "z" },
			])
		}
	})

	it("a branch-arm frame names the taken ARM and carries the branch's upstream input", async () => {
		let seen: ScopeFrame | undefined
		const armBody = createWorkflow({ name: "hot" })
			.then(
				createStep({
					name: "inside",
					output: numberOutput,
					run: ({ ctx }) => {
						seen = ctx.scope()
						return { n: 1 }
					},
				}),
			)
			.commit()
		const workflow = createWorkflow({ name: "branching" })
			.then(createStep({ name: "feed", output: numberOutput, run: () => ({ n: 7 }) }))
			.branch([[() => true, armBody]], { name: "decide" })
			.commit()

		await runWorkflow(workflow, undefined, createTestHost().host)
		expect(seen).toEqual({ kind: "branch-arm", name: "hot", input: { n: 7 } })
	})

	it("a branch predicate INSIDE a loop reads the loop frame — the fed value, before any body step ran (spec 1.6)", async () => {
		const predicateSaw: unknown[] = []
		const armBody = createWorkflow({ name: "rework" })
			.then(createStep({ name: "fix", output: numberOutput, run: () => ({ n: 0 }) }))
			.commit()
		const body = createWorkflow({ name: "round" })
			.branch(
				[
					[
						(ctx) => {
							predicateSaw.push(ctx.scope("cycle")?.input)
							return false
						},
						armBody,
					],
				],
				{ name: "gate" },
			)
			.then(
				createStep({
					name: "close",
					input: Type.Any(),
					output: numberOutput,
					// The counter pattern the spec motivates: the previous round arrives as the loop frame's input.
					run: ({ ctx }) => ({ n: ((ctx.scope("cycle")?.input as { n?: number } | undefined)?.n ?? 0) + 1 }),
				}),
			)
			.commit()
		const workflow = createWorkflow({ name: "predicated" })
			.dountil(body, (_ctx, last) => (last as { n: number }).n >= 2, { name: "cycle", maxIterations: 4 })
			.commit()

		await runWorkflow(workflow, undefined, createTestHost().host)
		// Round 1's predicate sees the upstream input (undefined); round 2's sees round 1's body output.
		expect(predicateSaw).toEqual([undefined, { n: 1 }])
	})

	it("a parallel arm sees the parallel frame with the construct's input", async () => {
		const seen: (ScopeFrame | undefined)[] = []
		const arm = (name: string) =>
			createStep({
				name,
				input: Type.Any(),
				output: numberOutput,
				run: ({ ctx }) => {
					seen.push(ctx.scope())
					return { n: 0 }
				},
			})
		const workflow = createWorkflow({ name: "fanning" })
			.then(createStep({ name: "feed", output: numberOutput, run: () => ({ n: 9 }) }))
			.parallel([arm("a"), arm("b")], { name: "fan" })
			.commit()

		await runWorkflow(workflow, undefined, createTestHost().host)
		expect(seen).toHaveLength(2)
		for (const frame of seen) {
			expect(frame).toEqual({ kind: "parallel", name: "fan", input: { n: 9 } })
		}
	})

	it("a nested workflow contributes a frame with its input", async () => {
		let seen: ScopeFrame | undefined
		const inner = createWorkflow({ name: "audit" })
			.then(
				createStep({
					name: "lint",
					input: Type.Any(),
					output: numberOutput,
					run: ({ ctx }) => {
						seen = ctx.scope()
						return { n: 0 }
					},
				}),
			)
			.commit()
		const workflow = createWorkflow({ name: "outer" })
			.then(createStep({ name: "feed", output: numberOutput, run: () => ({ n: 3 }) }))
			.workflow(inner)
			.commit()

		await runWorkflow(workflow, undefined, createTestHost().host)
		expect(seen).toEqual({ kind: "workflow", name: "audit", input: { n: 3 } })
	})
})

describe("iteration context (Feature 1): purity and resume (spec 1.4/1.5)", () => {
	it("a resumable key built from scope() is identical across a retry — attempt is NOT part of the surface", async () => {
		const requests: AgentRequest[] = []
		let failures = 0
		const inner = scriptedAgent([[JSON.stringify({ n: 1 })], [JSON.stringify({ n: 1 })], [JSON.stringify({ n: 1 })]])
		const startAgent = (request: AgentRequest) => {
			requests.push(request)
			const session = inner.startAgent(request)
			if (failures === 0) {
				failures += 1
				return {
					...session,
					sendAndAwaitEnd: async () => {
						throw new Error("transient transport failure")
					},
				}
			}
			return session
		}

		const body = createWorkflow({ name: "round" })
			.then(
				createAgentStep({
					name: "worker",
					output: numberOutput,
					background: true,
					resumable: ({ ctx }) => `worker-round-${ctx.scope("rounds")?.iteration ?? 0}`,
					retry: { maxRetry: 2 },
					prompt: () => "work",
				}),
			)
			.commit()
		const workflow = createWorkflow({ name: "keyed" })
			.dountil(body, (_ctx, last) => (last as { n: number }).n >= 1, { name: "rounds", maxIterations: 2 })
			.commit()

		const { host } = createTestHost({ startAgent })
		const result = await runWorkflow(workflow, undefined, host)

		expect(result.status).toBe("completed")
		// First attempt failed in transit, second succeeded — both carry the SAME per-iteration key.
		expect(requests.length).toBeGreaterThanOrEqual(2)
		expect(new Set(requests.map((request) => request.resumeKey))).toEqual(new Set(["worker-round-1"]))
	})

	it("scope() inside a deep re-entered iteration matches the fresh-run value (frames rebuilt on resume)", async () => {
		const seen: { path: string; frame: ScopeFrame | undefined }[] = []
		const confirmSchema = Type.Object({ go: Type.Boolean() })
		const body = createWorkflow({ name: "round" })
			.then(createQuestionnaireStep({ name: "confirm", output: confirmSchema }))
			.then(
				createStep({
					name: "work",
					input: Type.Any(),
					output: numberOutput,
					run: ({ ctx }) => {
						seen.push({ path: ctx.path, frame: ctx.scope() })
						return { n: seen.length }
					},
				}),
			)
			.commit()
		const workflow = createWorkflow({ name: "reblocking" })
			.dountil(body, (_ctx, last) => (last as { n: number }).n >= 2, { name: "rounds", maxIterations: 3 })
			.commit()

		const { host, store } = createTestHost()
		const first = await runWorkflow(workflow, undefined, host)
		expect(first.status).toBe("blocked") // iteration 1's questionnaire

		const afterOne = await resumeWithAnswer(workflow, await store.loadEvents(first.runId), { go: true }, host)
		expect(afterOne.status).toBe("blocked") // iteration 2's questionnaire, same run

		const done = await resumeWithAnswer(workflow, await store.loadEvents(first.runId), { go: true }, host)
		expect(done.status).toBe("completed")

		expect(seen.map((entry) => entry.path)).toEqual(["rounds#1/work", "rounds#2/work"])
		expect(seen[0]?.frame).toMatchObject({ kind: "loop", name: "rounds", iteration: 1 })
		// Iteration 2 was reached through a DEEP RE-ENTRY (the second answer) — its frame must carry the
		// same fed-back input a continuous run would have: iteration 1's body output, reseeded from the log.
		expect(seen[1]?.frame).toMatchObject({ kind: "loop", name: "rounds", iteration: 2, input: { n: 1 } })
	})
})

async function runToCompletion(workflow: ReturnType<ReturnType<typeof createWorkflow>["commit"]>) {
	const { host, events } = createTestHost()
	const result = await runWorkflow(workflow, undefined, host)
	expect(result.status).toBe("completed")
	return { host, events }
}
