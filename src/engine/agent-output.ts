/**
 * The in-session correction message used for output steering (spec §9.2).
 *
 * A step under a contract reports through `submit_result`/`submit_questions` (output-tools.ts) — never
 * through assistant text, which a later message can always displace. So there is nothing here to parse:
 * a violation is a schema-invalid submission, a call the arguments of which cannot be read, or a turn
 * that submitted nothing — all answered by restating the channel and the shape.
 *
 * No host/network/PI deps — used by the engine's agent path (`step-runner.ts`) and unit-tested directly.
 */
import type { TSchema } from "typebox"
import { QuestionnaireSchema } from "../flow/questionnaire.ts"
import { SUBMIT_QUESTIONS_TOOL, SUBMIT_RESULT_TOOL } from "./output-tools.ts"

/**
 * Build the steering correction message (spec §9.2): the concrete violation plus the expected shape as
 * JSON Schema (TypeBox schemas *are* JSON Schema) plus an instruction naming the tool to call.
 *
 * `asks` decides whether asking is still on the table. Offering only `submit_result` to a step that may
 * legitimately need information tells a model that was trying to ask a question to invent the answer
 * instead — a fabricated result is worse than the failure it replaced, so both tools are restated.
 */
export function buildCorrectionMessage(schema: TSchema, violation: string, asks = false): string {
	const lines = [
		"Your previous turn did not submit a valid result.",
		`Problem: ${violation}`,
		"",
		`Call ${SUBMIT_RESULT_TOOL} with a \`result\` argument matching this JSON Schema:`,
		JSON.stringify(schema, null, 2),
	]
	if (asks) {
		lines.push(
			"",
			`If you still need information from the user, call ${SUBMIT_QUESTIONS_TOOL} instead — do NOT invent`,
			"an answer. Its arguments must match this JSON Schema:",
			JSON.stringify(QuestionnaireSchema, null, 2),
		)
	}
	return lines.join("\n")
}
