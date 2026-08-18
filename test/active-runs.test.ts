import { describe, expect, it } from "vitest"
import { createActiveRuns } from "../src/host/active-runs.ts"

describe("active run registry", () => {
	it("tracks multiple executions without rejecting any of them", () => {
		const activeRuns = createActiveRuns()
		const first = activeRuns.start("run-a")
		const second = activeRuns.start("run-b")
		const duplicate = activeRuns.start("run-a")

		expect(activeRuns.active).toEqual([first, second, duplicate])
		expect(activeRuns.find("run-a")).toEqual([first, duplicate])
	})

	it("finishes an exact execution without disturbing concurrent siblings", () => {
		const activeRuns = createActiveRuns()
		const first = activeRuns.start("same-run")
		const second = activeRuns.start("same-run")

		activeRuns.finish(first)

		expect(activeRuns.find("same-run")).toEqual([second])
		expect(first.controller.signal.aborted).toBe(false)
	})
})
