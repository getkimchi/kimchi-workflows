import { describe, expect, it } from "vitest"
import { createActiveRuns } from "../src/host/active-runs.ts"

describe("active run registry", () => {
	it("tracks different run ids concurrently and rejects a duplicate run id", () => {
		const activeRuns = createActiveRuns()
		const first = activeRuns.start("run-a")
		const second = activeRuns.start("run-b")

		expect(() => activeRuns.start("run-a")).toThrow(/already has an execution/)
		expect(activeRuns.active).toEqual([first, second])
		expect(activeRuns.find("run-a")).toEqual([first])
	})

	it("finishes one execution without disturbing a different run", () => {
		const activeRuns = createActiveRuns()
		const first = activeRuns.start("run-a")
		const second = activeRuns.start("run-b")

		activeRuns.finish(first)

		expect(activeRuns.find("run-a")).toEqual([])
		expect(activeRuns.find("run-b")).toEqual([second])
		expect(first.controller.signal.aborted).toBe(false)
	})
})
