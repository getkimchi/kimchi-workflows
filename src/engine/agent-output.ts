/**
 * Pure helpers for validating an agent's free-form reply against a step's output schema and, when
 * it fails, building the in-session correction message used for output steering (spec §9.2).
 *
 * No host/network/PI deps — used by the engine's agent path (`execute.ts`) and unit-tested directly.
 */
import { type TSchema, Type } from "typebox";
import { QuestionnaireSchema } from "../flow/questionnaire.ts";
import { describeSchemaViolations } from "../flow/validation.ts";
import { extractJson } from "./extract-json.ts";

/** Result of checking an agent reply: the parsed value, or a human-readable violation to steer on. */
export type AgentOutputCheck = { ok: true; value: unknown } | { ok: false; violation: string };

/** Result of checking a Q&A reply (spec §10.1): a validated result, a validated questions batch, or a violation. */
export type QaOutputCheck = { ok: true; kind: "result"; value: unknown } | { ok: true; kind: "questions"; questions: unknown } | { ok: false; violation: string };

/** Extract JSON from `text` (tolerantly) and validate it against `schema`. */
export function validateAgentOutput(schema: TSchema, text: string): AgentOutputCheck {
  const extracted = extractJson(text);
  if (!extracted.ok) {
    return { ok: false, violation: `the reply was not valid JSON (received: ${preview(text)})` };
  }
  const violation = describeSchemaViolations(schema, extracted.value);
  if (violation) {
    return { ok: false, violation };
  }
  return { ok: true, value: extracted.value };
}

/**
 * Validate a Q&A reply against the discriminated union `{ result } | { questions }` (spec §10.1).
 * The framework owns the questionnaire schema; the payload is a batch, hence the plural key. The
 * branch is chosen by which key is present; a `questions` key takes precedence, then `result`.
 */
export function validateQaOutput(outputSchema: TSchema, text: string): QaOutputCheck {
  const extracted = extractJson(text);
  if (!extracted.ok) {
    return { ok: false, violation: `the reply was not valid JSON (received: ${preview(text)})` };
  }
  const value = extracted.value;
  if (!isRecord(value)) {
    return { ok: false, violation: 'expected a JSON object of the form {"result": ...} or {"questions": ...}' };
  }
  if ("questions" in value) {
    const violation = describeSchemaViolations(QuestionnaireSchema, value.questions);
    return violation ? { ok: false, violation: `questions: ${violation}` } : { ok: true, kind: "questions", questions: value.questions };
  }
  if ("result" in value) {
    const violation = describeSchemaViolations(outputSchema, value.result);
    return violation ? { ok: false, violation: `result: ${violation}` } : { ok: true, kind: "result", value: value.result };
  }
  return { ok: false, violation: 'expected a JSON object with a "result" or "questions" key' };
}

/** The JSON Schema shown in a Q&A step's steering correction: the `{result}|{questions}` union. */
export function buildQaSchema(outputSchema: TSchema): TSchema {
  return Type.Union([Type.Object({ result: outputSchema }), Type.Object({ questions: QuestionnaireSchema })]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Build the steering correction message (spec §9.2): the concrete violation plus the expected shape
 * as JSON Schema (TypeBox schemas *are* JSON Schema) plus an instruction to reply with ONLY JSON.
 */
export function buildCorrectionMessage(schema: TSchema, violation: string): string {
  return [
    "Your previous reply did not match the required output format.",
    `Problem: ${violation}`,
    "Reply with ONLY a JSON value matching this JSON Schema — no prose, no code fences:",
    JSON.stringify(schema, null, 2),
  ].join("\n");
}

/** One-line, length-capped view of arbitrary text for inclusion in diagnostics. */
export function preview(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine;
}
