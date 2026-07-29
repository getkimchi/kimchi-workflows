import { Value } from "typebox/value"
import { describe, expect, it } from "vitest"
import summarizeWorkflow, { summarySchema } from "../examples/summarize.workflow.ts"
import { runWorkflow } from "../src/engine/run-workflow.ts"
import type { AgentRequest, AgentSession, RunEvent } from "../src/engine/types.ts"
import { createTestHost } from "./helpers.ts"
import { callKimi, createKimiAgentStarter, resolveKimiApiKey, toModelId } from "./kimi-agent.ts"

/**
 * Real E2E for the agent-step seam (Phase 4a/4b): drives agent-step workflows through the engine
 * with real kimi-k2.7 calls. Gated on KIMCHI_API_KEY (env or ../kimchi-dev/.env); self-skips when
 * absent. Runs only via `npm run test:integration`, never the default offline `npm test`.
 */
const apiKey = resolveKimiApiKey()

describe.skipIf(!apiKey)("agent step E2E (kimchi-dev/kimi-k2.7)", () => {
	it("produces schema-valid structured output from one real model call", async () => {
		if (!apiKey) throw new Error("unreachable: skipIf guards this")

		const { host } = createTestHost({ startAgent: createKimiAgentStarter(apiKey) })
		const result = await runWorkflow(summarizeWorkflow, undefined, host)

		console.log("[integration] run status:", result.status)
		console.log("[integration] structured output:", JSON.stringify(result.output))

		expect(result.status).toBe("completed")
		expect(Value.Check(summarySchema, result.output)).toBe(true)
		const output = result.output as { summary: string; keywords: string[] }
		expect(output.summary.length).toBeGreaterThan(0)
		expect(output.keywords.length).toBeGreaterThan(0)
	})

	it("recovers via real in-session steering after an injected invalid reply", async () => {
		if (!apiKey) throw new Error("unreachable: skipIf guards this")

		// Deterministically force one steer: the first reply is garbage; the correction turn (which the
		// engine builds with the schema) goes to the REAL model, proving steering drives a real repair.
		let realCalls = 0
		const startAgent = (request: AgentRequest): AgentSession => {
			const modelId = toModelId(request.model)
			let turn = 0
			return {
				async sendAndAwaitEnd(message: string) {
					if (turn++ === 0) return { text: "sorry, I can't do JSON" }
					realCalls += 1
					return { text: await callKimi(apiKey, modelId, message) }
				},
				getConversation() {
					return []
				},
				dispose() {},
			}
		}

		const { host, store } = createTestHost({ startAgent })
		const result = await runWorkflow(summarizeWorkflow, undefined, host)
		const steers = (await store.loadEvents(result.runId)).filter((event: RunEvent) => event.type === "agent-steer")

		console.log("[integration] steer status:", result.status, "| steers:", steers.length, "| real calls:", realCalls)
		console.log("[integration] steered output:", JSON.stringify(result.output))

		expect(result.status).toBe("completed")
		expect(Value.Check(summarySchema, result.output)).toBe(true)
		expect(steers.length).toBeGreaterThanOrEqual(1)
		expect(realCalls).toBeGreaterThanOrEqual(1)
	})
})
