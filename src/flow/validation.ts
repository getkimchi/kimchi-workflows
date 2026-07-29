import type { TSchema } from "typebox"
import { Value } from "typebox/value"

/**
 * Validate `value` against `schema`. Returns `undefined` when valid, or a descriptive,
 * human-readable error string (first few violations) when invalid.
 */
export function describeSchemaViolations(schema: TSchema, value: unknown): string | undefined {
	if (Value.Check(schema, value)) {
		return undefined
	}
	const errors = [...Value.Errors(schema, value)].slice(0, 5)
	if (errors.length === 0) {
		// Value.Check failed but Value.Errors found nothing structured — fall back to a generic message.
		return "value does not match the declared schema"
	}
	return errors.map((error) => `${error.instancePath || "<root>"}: ${error.message}`).join("; ")
}
