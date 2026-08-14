import { describe, expect, it } from "vitest"
import { collapse } from "../src/progress/collapse.ts"
import { render } from "../src/progress/render.ts"
import { plainTheme, sequenceRun, terminalRun, viewOf } from "./progress-fixtures.ts"

describe("render-time elapsed progress", () => {
	it("applies one monotonic frame delta to live header and row values", () => {
		const view = viewOf(sequenceRun())
		const lines = render(view, collapse(view), {
			width: 76,
			theme: plainTheme,
			elapsedSinceProjectionMs: 7250,
		})

		expect(lines.find((line) => line.includes("3f9a2c1d"))).toContain("00:22")
		expect(lines.find((line) => line.includes("plan"))).toContain("running · 19s")
		expect(lines.find((line) => line.includes("analyze"))).toContain("3.1s")
	})

	it("keeps terminal values fixed and is deterministic for a fixed frame", () => {
		const view = viewOf(terminalRun())
		const options = { width: 76, theme: plainTheme, elapsedSinceProjectionMs: 60_000 }

		const first = render(view, collapse(view), options)
		const second = render(view, collapse(view), options)
		expect(first).toEqual(second)
		expect(first.find((line) => line.includes("3f9a2c1d"))).toContain("00:07")
		expect(first.find((line) => line.includes("changelog"))).toContain("2.4s")
	})
})
