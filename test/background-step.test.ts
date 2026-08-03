import { Type } from "typebox"
import { describe, expect, it } from "vitest"
import { runWorkflow } from "../src/engine/run-workflow.ts"
import type { RunEvent } from "../src/engine/types.ts"
import { createAgentStep, createWorkflow } from "../src/flow/index.ts"
import { createTestHost } from "./helpers.ts"
import { scriptedAgent } from "./scripted-agent.ts"

const outputSchema = Type.Object({ summary: Type.String() })
const valid = '{"summary":"ok"}'

function steerEvents(events: RunEvent[]): Extract<RunEvent, { type: "agent-steer" }>[] {
	return events.filter((event): event is Extract<RunEvent, { type: "agent-steer" }> => event.type === "agent-steer")
}

function retryEvents(events: RunEvent[]): Extract<RunEvent, { type: "step-retry" }>[] {
	return events.filter((event): event is Extract<RunEvent, { type: "step-retry" }> => event.type === "step-retry")
}

describe(".commit() rejects background + asks (spec §10.1)", () => {
	it("rejects a top-level agent step declaring both", () => {
		expect(() =>
			createWorkflow({ name: "w" })
				.then(createAgentStep({ name: "s", output: outputSchema, background: true, asks: true, prompt: () => "go" }))
				.commit(),
		).toThrow(/background.*asks|asks.*background/i)
	})

	it("rejects the combination when it is one of several `.parallel()` arms, not just a lone top-level step", () => {
		// A parallel's arms are plain steps checked within the SAME commit() call (spec §3.5), unlike a
		// branch arm/loop body (each pre-committed separately) — this proves the recursive walk finds the
		// violation buried among otherwise-valid siblings, not just when it is the workflow's only node.
		expect(() =>
			createWorkflow({ name: "w" })
				.parallel([
					createAgentStep({ name: "ok", output: outputSchema, prompt: () => "go" }),
					createAgentStep({ name: "bad", output: outputSchema, background: true, asks: true, prompt: () => "go" }),
				])
				.commit(),
		).toThrow(/spec §10\.1|background.*asks/i)
	})

	it("accepts background alone and asks alone, just not together", () => {
		expect(() =>
			createWorkflow({ name: "w1" })
				.then(createAgentStep({ name: "bg", output: outputSchema, background: true, prompt: () => "go" }))
				.commit(),
		).not.toThrow()
		expect(() =>
			createWorkflow({ name: "w2" })
				.then(createAgentStep({ name: "qa", output: outputSchema, asks: true, prompt: () => "go" }))
				.commit(),
		).not.toThrow()
	})
})

describe("background agent step (spec §2.2/§9.2, faked subagent seam offline)", () => {
	it("runs as a background request (no history, background flag threaded) and completes on a valid reply", async () => {
		const step = createAgentStep({ name: "bg", output: outputSchema, background: true, prompt: () => "go" })
		const workflow = createWorkflow({ name: "bg-ok" }).then(step).commit()
		const agent = scriptedAgent([[valid]])
		const { host, store } = createTestHost({ startAgent: agent.startAgent })

		const result = await runWorkflow(workflow, undefined, host)

		expect(result.status).toBe("completed")
		expect(result.output).toEqual({ summary: "ok" })
		expect(agent.backgrounds).toEqual([true])
		expect(agent.histories).toEqual([undefined])
		expect(agent.opened).toBe(1)

		const events = await store.loadEvents(result.runId)
		expect(steerEvents(events)).toHaveLength(0) // valid reply — no steering needed
	})

	it("steers invalid output in-session — background steps get repairs like any contracted step", async () => {
		const step = createAgentStep({
			name: "bg",
			output: outputSchema,
			background: true,
			maxOutputRepairs: 2,
			prompt: () => "go",
		})
		const workflow = createWorkflow({ name: "bg-steer" }).then(step).commit()
		// One session: invalid → correction → invalid → correction → invalid → repairs exhausted → crash
		const agent = scriptedAgent([['{"summary":123}', '{"summary":456}', '{"summary":789}']])
		const { host, store } = createTestHost({ startAgent: agent.startAgent })

		const result = await runWorkflow(workflow, undefined, host)

		expect(result.status).toBe("crashed")
		expect(agent.opened).toBe(1) // one session, steered in-session, never a fresh one
		expect(agent.messages).toHaveLength(3) // prompt + 2 corrections
		const events = await store.loadEvents(result.runId)
		expect(steerEvents(events)).toHaveLength(2) // two corrections sent
		expect(retryEvents(events)).toHaveLength(0) // no outer retry — default maxRetry is 0
	})

	it("completes after a steering repair in the same session", async () => {
		const step = createAgentStep({ name: "bg", output: outputSchema, background: true, prompt: () => "go" })
		const workflow = createWorkflow({ name: "bg-steer-ok" }).then(step).commit()
		// Session 1: invalid → correction → valid
		const agent = scriptedAgent([['{"summary":123}', valid]])
		const { host, store } = createTestHost({ startAgent: agent.startAgent })

		const result = await runWorkflow(workflow, undefined, host)

		expect(result.status).toBe("completed")
		expect(result.output).toEqual({ summary: "ok" })
		expect(agent.opened).toBe(1) // same session, repaired in-conversation
		const events = await store.loadEvents(result.runId)
		expect(steerEvents(events)).toHaveLength(1)
		expect(retryEvents(events)).toHaveLength(0) // no outer retry needed
	})

	it("falls back to the repeat policy after repairs are exhausted, and a fresh session succeeds", async () => {
		const step = createAgentStep({
			name: "bg",
			output: outputSchema,
			background: true,
			retry: { maxRetry: 1 },
			maxOutputRepairs: 1, // exhaust quickly: 1 repair, then retry
			prompt: () => "go",
		})
		const workflow = createWorkflow({ name: "bg-retry" }).then(step).commit()
		// Session 1: invalid → correction → invalid → repairs exhausted → outer retry
		// Session 2: valid
		const agent = scriptedAgent([['{"summary":123}', '{"summary":456}'], [valid]])
		const { host, store } = createTestHost({ startAgent: agent.startAgent })

		const result = await runWorkflow(workflow, undefined, host)

		expect(result.status).toBe("completed")
		expect(agent.opened).toBe(2) // exhausted repairs → fresh session
		expect(agent.backgrounds).toEqual([true, true])
		const events = await store.loadEvents(result.runId)
		expect(steerEvents(events)).toHaveLength(1) // one steer in session 1
		const retries = retryEvents(events)
		expect(retries).toHaveLength(1)
		expect(retries[0]).toMatchObject({ path: "bg", attempt: 1, reason: "invalid-output" })
	})

	it("crashes once repairs AND the repeat policy are exhausted", async () => {
		const step = createAgentStep({
			name: "bg",
			output: outputSchema,
			background: true,
			retry: { maxRetry: 1 },
			maxOutputRepairs: 1,
			prompt: () => "go",
		})
		const workflow = createWorkflow({ name: "bg-retry-exhaust" }).then(step).commit()
		// Session 1: invalid → correction → invalid → repairs exhausted → retry
		// Session 2: invalid → correction → invalid → repairs exhausted → crash
		const agent = scriptedAgent([
			['{"summary":123}', '{"summary":456}'],
			['{"summary":789}', '{"summary":false}'],
		])
		const { host, store } = createTestHost({ startAgent: agent.startAgent })

		const result = await runWorkflow(workflow, undefined, host)

		expect(result.status).toBe("crashed")
		expect(agent.opened).toBe(2)
		const events = await store.loadEvents(result.runId)
		expect(steerEvents(events)).toHaveLength(2) // 1 per session
		expect(retryEvents(events)).toHaveLength(1) // 2 attempts -> 1 retry
	})

	it("still retries a thrown transport error exactly like a non-background step", async () => {
		const step = createAgentStep({
			name: "bg",
			output: outputSchema,
			background: true,
			retry: { maxRetry: 1 },
			prompt: () => "go",
		})
		const workflow = createWorkflow({ name: "bg-transport" }).then(step).commit()
		const agent = scriptedAgent([[new Error("blip")], [valid]])
		const { host, store } = createTestHost({ startAgent: agent.startAgent })

		const result = await runWorkflow(workflow, undefined, host)

		expect(result.status).toBe("completed")
		const events = await store.loadEvents(result.runId)
		expect(retryEvents(events)).toMatchObject([{ reason: "thrown-error" }])
	})
})
