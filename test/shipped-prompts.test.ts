/**
 * No prompt this package ships may teach the deleted text protocol.
 *
 * A step under an output contract reports ONLY through `submit_result`/`submit_questions`, and the
 * engine appends that protocol to every such prompt. An author prompt that also says "reply with ONLY
 * JSON" therefore contradicts the framework's own instruction three lines later — and a model that
 * obeys the author submits nothing, so the step fails blaming the model.
 *
 * This existed twice before it was caught: once in a builtin, once in two examples. It is a rule about
 * shipped text, so it is asserted over the files rather than over any one prompt.
 */
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const ROOT = path.resolve(import.meta.dirname, "..")

/** Every prompt-bearing source file this package ships: the builtin workflows and the examples. */
function shippedPromptFiles(): string[] {
	const dirs = [path.join(ROOT, "src", "host", "builtin"), path.join(ROOT, "examples")]
	return dirs.flatMap((dir) =>
		readdirSync(dir)
			.filter((name) => name.endsWith(".ts"))
			.map((name) => path.join(dir, name)),
	)
}

/** Phrasings that tell a model its TEXT is the output — the contract this package no longer has. */
const TEXT_PROTOCOL = /reply with only|respond with only|answer with only|final message as json|parses the model/i

describe("shipped prompts", () => {
	it("never instruct a model to reply in text", () => {
		const offenders = shippedPromptFiles().flatMap((file) =>
			readFileSync(file, "utf8")
				.split("\n")
				.map((line, index) => ({ file: path.relative(ROOT, file), line: index + 1, text: line }))
				.filter((entry) => TEXT_PROTOCOL.test(entry.text)),
		)

		expect(offenders).toEqual([])
	})

	it("checks a non-empty set of files, so the rule cannot pass by finding nothing", () => {
		expect(shippedPromptFiles().length).toBeGreaterThan(5)
	})
})
