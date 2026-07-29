import { Type } from "typebox"
import { describe, expect, it } from "vitest"
import { createRunContext, type RunState } from "../src/engine/context.ts"
import { runWorkflow } from "../src/engine/run-workflow.ts"
import { createConcurrencyGate } from "../src/engine/scheduler.ts"
import { createStep, createWorkflow } from "../src/flow/index.ts"
import { createTestHost } from "./helpers.ts"
import { createStepBarrier } from "./step-barrier.ts"

function baseState(overrides: Partial<RunState> = {}): RunState {
	return {
		runId: "r1",
		workflowName: "w",
		initialInput: undefined,
		stepOutputs: new Map(),
		inFlight: new Set(),
		concurrencyGate: createConcurrencyGate(4),
		...overrides,
	}
}

describe("getStepResult never observes an in-flight step (spec §3.9)", () => {
	it("throws for a bare name that is currently executing (nearest enclosing scope)", () => {
		const state = baseState({ inFlight: new Set(["par/b"]) })
		const ctx = createRunContext(state, [{ name: "par" }]) // caller's own scope is "par"
		expect(() => ctx.getStepResult("b")).toThrow(/currently executing/)
	})

	it("throws for an explicit path that is currently executing", () => {
		const state = baseState({ inFlight: new Set(["each@3/process"]) })
		const ctx = createRunContext(state, [])
		expect(() => ctx.getStepResult("each@3/process")).toThrow(/currently executing/)
	})

	it("does NOT throw for a DIFFERENT item's in-flight step — per-item keying keeps them independent (spec §5.4)", () => {
		const state = baseState({ inFlight: new Set(["each@3/process"]) })
		const ctx = createRunContext(state, [])
		expect(() => ctx.getStepResult("each@4/process")).not.toThrow()
		expect(ctx.getStepResult("each@4/process")).toBeUndefined() // not reached (not completed either)
	})

	it("a step not yet reached still reads undefined — todo is a structural fact, not a race", () => {
		const state = baseState()
		const ctx = createRunContext(state, [])
		expect(ctx.getStepResult("never-touched")).toBeUndefined()
	})

	it("a step recorded complete (not in-flight) reads its value normally", () => {
		const state = baseState({ stepOutputs: new Map([["a", { n: 1 }]]) })
		const ctx = createRunContext(state, [])
		expect(ctx.getStepResult("a")).toEqual({ n: 1 })
	})

	it("prefers the NEAREST enclosing scope's in-flight match over a further-out completed one", () => {
		// "b" exists both as a sibling in the caller's own scope (in-flight) and, coincidentally, as a
		// top-level completed step — lexical resolution must throw on the NEAR match, not silently fall
		// through to the far one.
		const state = baseState({
			stepOutputs: new Map([["b", { far: true }]]),
			inFlight: new Set(["par/b"]),
		})
		const ctx = createRunContext(state, [{ name: "par" }])
		expect(() => ctx.getStepResult("b")).toThrow(/currently executing/)
	})
})

describe("in-flight throw, wired end-to-end through .parallel (spec §3.9/§3.5)", () => {
	const numberOutput = Type.Object({ n: Type.Integer() })

	it("an arm reading a concurrently-executing sibling by bare name throws, crashing that arm", async () => {
		const barrier = createStepBarrier<string>()
		let threwWhileInFlight = false

		// "slow" starts, signals it has started, and blocks until released — staying in-flight the whole time.
		const slow = createStep({
			name: "slow",
			output: numberOutput,
			run: async () => {
				await barrier.enter("slow")
				return { n: 1 }
			},
		})
		// "reader" waits until "slow" has started, reads it by bare name (sibling scope, spec §3.9) — which
		// must throw since "slow" is still executing — then rendezvous on "checked" so the test can inspect
		// the result BEFORE releasing "slow". This is what makes the ordering deterministic rather than a
		// guess about microtask depth: the test does not release "slow" until "checked" has been entered,
		// so the read is PROVABLY performed while "slow" is still blocked, every time this runs.
		const reader = createStep({
			name: "reader",
			output: numberOutput,
			run: async ({ ctx }) => {
				await barrier.waitFor("slow")
				try {
					ctx.getStepResult("slow")
				} catch {
					threwWhileInFlight = true
				}
				await barrier.enter("checked")
				return { n: 2 }
			},
		})
		const workflow = createWorkflow({ name: "racy-read" }).parallel([slow, reader]).commit()

		const { host } = createTestHost()
		const resultPromise = runWorkflow(workflow, undefined, host)

		await Promise.all([barrier.waitFor("slow"), barrier.waitFor("checked")])
		expect(threwWhileInFlight).toBe(true) // deterministic — "slow" has not been released yet

		barrier.release("slow")
		barrier.release("checked")

		const result = await resultPromise
		expect(result.status).toBe("completed") // the throw was caught inside the step body, not left to crash it
	})

	it("an UNCAUGHT in-flight read crashes the reading step (and, with no retry policy, the run)", async () => {
		const barrier = createStepBarrier<string>()
		const slow = createStep({
			name: "slow",
			output: numberOutput,
			run: async () => {
				await barrier.enter("slow") // signal started; suspend until the test releases it
				// Rendezvous, not a guess: "slow" must not settle (and so leave `inFlight`) until "reader" has
				// actually performed its read — "reader" releases this gate itself, in a `finally`, right after
				// that read (see below), so this is an explicit handshake rather than a hop-count margin.
				await barrier.enter("read-done")
				return { n: 1 }
			},
		})
		const reader = createStep({
			name: "reader",
			output: numberOutput,
			run: async ({ ctx }) => {
				await barrier.waitFor("slow") // resolves as soon as "slow" has STARTED, independent of release
				try {
					return ctx.getStepResult("slow") as { n: number } // uncaught — must crash this attempt
				} finally {
					barrier.release("read-done") // let "slow" proceed now that the read has happened, throw or not
				}
			},
		})
		const workflow = createWorkflow({ name: "racy-read-uncaught" }).parallel([slow, reader]).commit()

		const { host } = createTestHost()
		const resultPromise = runWorkflow(workflow, undefined, host)
		await barrier.waitFor("slow")
		barrier.release("slow")

		const result = await resultPromise
		expect(result.status).toBe("crashed")
		expect(result.error).toMatch(/currently executing/)
	})
})
