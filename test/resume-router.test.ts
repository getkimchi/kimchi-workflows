import { describe, expect, it } from "vitest"
import { resumeAction } from "../src/host/resume-router.ts"

describe("resumeAction routing (pure, spec §5.2)", () => {
	it("routes a blocked run to the answer path", () => {
		expect(resumeAction("blocked")).toEqual({ kind: "answer" })
	})

	it("routes crashed and cancelled runs to the node-atomic re-run path", () => {
		expect(resumeAction("crashed")).toEqual({ kind: "rerun" })
		expect(resumeAction("cancelled")).toEqual({ kind: "rerun" })
	})

	it("routes completed and in_progress runs to an error", () => {
		expect(resumeAction("completed").kind).toBe("error")
		expect(resumeAction("in_progress").kind).toBe("error")
	})
})
