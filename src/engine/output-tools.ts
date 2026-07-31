/**
 * The output-tool contract (spec §9.2/§10.1): the two tools a step may call to submit its result, and
 * the pure helpers for reading one back out of a turn.
 *
 * Which tool was called IS the discriminator between a result and a question batch, replacing the
 * `{result} | {questions}` union the text path has to sniff (`agent-output.ts`). Providers pick between
 * tools far more reliably than between branches of a union inside one payload.
 *
 * No host/PI deps — the host imports these names to register the tools, the engine to read them back.
 */
import { type TSchema, Type } from "typebox"
import { SUBMIT_QUESTIONS_TOOL, SUBMIT_RESULT_TOOL } from "../flow/output-tool-names.ts"
import { QuestionnaireSchema } from "../flow/questionnaire.ts"
import type { SubmittedOutput } from "./types.ts"

export { SUBMIT_QUESTIONS_TOOL, SUBMIT_RESULT_TOOL }

/** Every tool name the engine will read a payload from. A host registers exactly these. */
export const OUTPUT_TOOL_NAMES: readonly string[] = [SUBMIT_RESULT_TOOL, SUBMIT_QUESTIONS_TOOL]

/**
 * The `submit_result` parameter schema for a step whose contract is `outputSchema`.
 *
 * The result is WRAPPED in an object because tool parameters must be one — `outputSchema` itself may be
 * any schema, including a bare string or array.
 */
export function submitResultParameters(outputSchema: TSchema): TSchema {
	return Type.Object({ result: outputSchema })
}

/** The `submit_questions` parameter schema — framework-owned and identical for every step. */
export function submitQuestionsParameters(): TSchema {
	return QuestionnaireSchema
}

/** What a submitted tool call carried, with the tool identity resolved to a kind. */
export type SubmittedPayload =
	| { readonly kind: "result"; readonly value: unknown }
	| { readonly kind: "questions"; readonly value: unknown }
	/** The tool was called, but its arguments cannot be read as a payload at all. */
	| { readonly kind: "malformed"; readonly tool: string; readonly reason: string }

/**
 * Read a submitted call's payload. Returns undefined for a call this contract does not own, so an
 * unrelated tool the model happened to use last can never be mistaken for the step's output.
 */
export function readSubmittedPayload(submitted: SubmittedOutput | undefined): SubmittedPayload | undefined {
	if (!submitted) return undefined
	if (submitted.tool === SUBMIT_RESULT_TOOL) {
		// A missing `result` key is NOT the same as `result: undefined`. Reporting the latter lets a
		// permissive contract (`Type.Any()`, `Type.Unknown()`, a union containing `Type.Undefined()`)
		// VALIDATE an empty call and record `undefined` as the step's output — indistinguishable from a
		// step that produced nothing. Reported as malformed so the violation names what actually happened.
		if (!("result" in submitted.arguments)) {
			return { kind: "malformed", tool: SUBMIT_RESULT_TOOL, reason: "called without a `result` argument" }
		}
		return { kind: "result", value: submitted.arguments.result }
	}
	if (submitted.tool === SUBMIT_QUESTIONS_TOOL) {
		return { kind: "questions", value: submitted.arguments }
	}
	return undefined
}

/** True when `name` is one of the output tools — used by hosts scanning a transcript. */
export function isOutputToolName(name: string): boolean {
	return OUTPUT_TOOL_NAMES.includes(name)
}
