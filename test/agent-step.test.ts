import { Type } from "typebox"
import { describe, expect, it } from "vitest"
import { runWorkflow } from "../src/engine/run-workflow.ts"
import { createAgentStep, createWorkflow } from "../src/flow/index.ts"
import { createTestHost } from "./helpers.ts"
import { scriptedAgent } from "./scripted-agent.ts"

const outputSchema = Type.Object({ summary: Type.String(), keywords: Type.Array(Type.String()) })

const summarizeStep = createAgentStep({
	name: "summarize",
	output: outputSchema,
	model: "kimchi-dev/kimi-k2.7",
	prompt: () => "Summarize and reply with ONLY JSON.",
})
const workflow = createWorkflow({ name: "agent-unit" }).then(summarizeStep).commit()

describe("agent step (Phase 4a, fake host)", () => {
	it("completes with the parsed object when the agent returns valid JSON on the first reply", async () => {
		const agent = scriptedAgent([['{"summary":"a runtime type system","keywords":["typebox","json-schema"]}']])
		const { host } = createTestHost({ startAgent: agent.startAgent })

		const result = await runWorkflow(workflow, undefined, host)

		expect(result.status).toBe("completed")
		expect(result.output).toEqual({ summary: "a runtime type system", keywords: ["typebox", "json-schema"] })
		expect(agent.models).toEqual(["kimchi-dev/kimi-k2.7"]) // step model passed to the host
		expect(agent.opened).toBe(1)
		expect(agent.messages).toHaveLength(1) // one turn, no steering needed
		expect(agent.disposed).toBe(1)
	})

	it("retries a thrown transport error with a fresh session, then succeeds", async () => {
		const flaky = createAgentStep({
			name: "summarize",
			output: outputSchema,
			retry: { maxRetry: 1 },
			prompt: () => "go",
		}) // 1 retry after the first = 2 total attempts
		const flakyWorkflow = createWorkflow({ name: "agent-retry" }).then(flaky).commit()
		// First session throws (transport error); a fresh second session returns valid JSON.
		const agent = scriptedAgent([[new Error("transport blip")], ['{"summary":"ok","keywords":["k"]}']])
		const { host, store, sleepCalls } = createTestHost({ startAgent: agent.startAgent })

		const result = await runWorkflow(flakyWorkflow, undefined, host)

		expect(result.status).toBe("completed")
		expect(agent.opened).toBe(2) // fresh session on the outer retry
		expect(agent.disposed).toBe(2)
		const retries = (await store.loadEvents(result.runId)).filter((event) => event.type === "step-retry")
		expect(retries).toHaveLength(1)
		expect(retries[0]).toMatchObject({ reason: "thrown-error" })
		expect(sleepCalls).toEqual([]) // no backoff configured -> no sleep requested
	})
})
