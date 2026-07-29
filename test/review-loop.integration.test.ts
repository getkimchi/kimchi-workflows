import { Value } from "typebox/value"
import { describe, expect, it } from "vitest"
import reviewLoopWorkflow, { reviewSchema } from "../examples/review-loop.workflow.ts"
import { runWorkflow } from "../src/engine/run-workflow.ts"
import { createTestHost } from "./helpers.ts"
import { createKimiAgentStarter, resolveKimiApiKey } from "./kimi-agent.ts"

/**
 * Real E2E for control flow (Phase 5a): the `review-loop` example (agent proposes a slug → function
 * check → `.dountil` it passes) converges and completes within the max-iteration guard on real
 * kimi-k2.7. Gated on KIMCHI_API_KEY; runs only via `npm run test:integration`.
 */
const apiKey = resolveKimiApiKey()

describe.skipIf(!apiKey)("review-loop E2E (kimchi-dev/kimi-k2.7)", () => {
	it("loops propose/check until the slug passes review, within the guard", async () => {
		if (!apiKey) throw new Error("unreachable: skipIf guards this")

		const { host, store } = createTestHost({ startAgent: createKimiAgentStarter(apiKey) })
		const result = await runWorkflow(reviewLoopWorkflow, undefined, host)

		const iterations = (await store.loadEvents(result.runId)).filter((e) => e.type === "loop-iteration").length
		console.log("[integration] review-loop status:", result.status, "| iterations:", iterations)
		console.log("[integration] review-loop output:", JSON.stringify(result.output))

		expect(result.status).toBe("completed")
		expect(Value.Check(reviewSchema, result.output)).toBe(true)
		const output = result.output as { slug: string; passed: boolean }
		expect(output.passed).toBe(true) // converged to a valid slug
		expect(iterations).toBeGreaterThanOrEqual(1)
	})
})
