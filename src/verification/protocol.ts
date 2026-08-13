export interface WorkflowVerificationSuccess {
	readonly ok: true
	readonly testPath: string
	readonly files: number
	readonly tests: number
	readonly passedTests: number
	readonly summary: string
}

export interface WorkflowVerificationFailure {
	readonly ok: false
	readonly kind: "verification" | "infrastructure"
	readonly summary: string
	readonly errors: readonly string[]
}

export type WorkflowVerificationResult = WorkflowVerificationSuccess | WorkflowVerificationFailure

export function isWorkflowVerificationResult(value: unknown): value is WorkflowVerificationResult {
	if (!value || typeof value !== "object") return false
	const result = value as Record<string, unknown>
	if (typeof result.ok !== "boolean" || typeof result.summary !== "string") return false
	if (result.ok) {
		return (
			typeof result.testPath === "string" &&
			typeof result.files === "number" &&
			typeof result.tests === "number" &&
			typeof result.passedTests === "number"
		)
	}
	return (
		(result.kind === "verification" || result.kind === "infrastructure") &&
		Array.isArray(result.errors) &&
		result.errors.every((error: unknown) => typeof error === "string")
	)
}
