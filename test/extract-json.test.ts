import { describe, expect, it } from "vitest"
import { extractJson } from "../src/engine/extract-json.ts"

describe("extractJson (tolerant agent-output parsing)", () => {
	it("parses bare JSON", () => {
		expect(extractJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } })
	})

	it("parses JSON inside a ```json fence with surrounding prose", () => {
		const text = ["Here you go:", "```json", '{"a": 1, "b": [2, 3]}', "```", "Done."].join("\n")
		expect(extractJson(text)).toEqual({ ok: true, value: { a: 1, b: [2, 3] } })
	})

	it("parses JSON inside a bare ``` fence", () => {
		const text = ["```", '{"ok": true}', "```"].join("\n")
		expect(extractJson(text)).toEqual({ ok: true, value: { ok: true } })
	})

	it("parses an object embedded in prose without fences", () => {
		expect(extractJson('The answer is {"x": "y"} — enjoy!')).toEqual({ ok: true, value: { x: "y" } })
	})

	it("parses a top-level array", () => {
		expect(extractJson("prefix [1,2,3] suffix")).toEqual({ ok: true, value: [1, 2, 3] })
	})

	it("returns not-ok for text with no JSON", () => {
		expect(extractJson("I cannot help with that.")).toEqual({ ok: false })
	})
})
