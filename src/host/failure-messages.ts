/** Shared user-facing diagnostics for execution failures and recorded-workflow recovery. */

export interface WorkflowCrashIdentity {
	readonly workflowName: string
	readonly runId: string
	readonly path?: string
}

export interface WorkflowCrashDetails extends WorkflowCrashIdentity {
	readonly cause: string
}

export function workflowCrashHeading(details: WorkflowCrashIdentity): string {
	return `workflow "${details.workflowName}" crashed${details.path ? ` at "${details.path}"` : ""} (run ${details.runId})`
}

export function workflowCrashRecovery(runId: string): readonly [string, string] {
	return [`Resume: /workflow resume ${runId}`, `Details: /workflow status ${runId}`]
}

export function workflowCrashMessage(details: WorkflowCrashDetails): string {
	return [
		workflowCrashHeading(details),
		`  ${details.cause}`,
		...workflowCrashRecovery(details.runId).map((line) => `  ${line}`),
	].join("\n")
}

export function workflowFailureLine(details: Pick<WorkflowCrashDetails, "path" | "cause">): string {
	return `Failure${details.path ? ` at "${details.path}"` : ""}: ${details.cause}`
}

export function recordedWorkflowLoadFailure(options: {
	readonly workflowName: string
	readonly runId: string
	readonly workflowFilePath: string
	readonly action: "resume" | "show status"
	readonly cause?: string
}): string {
	return [
		`workflow "${options.workflowName}" cannot ${options.action} (run ${options.runId})`,
		`  File: ${options.workflowFilePath}`,
		`  ${options.cause ?? "The workflow file no longer exists."}`,
		"  The recorded run has been preserved.",
	].join("\n")
}

export function missingWorkflowProvenance(runId: string, action: "resumed" | "shown"): string {
	return [
		`workflow run ${runId} cannot be ${action}`,
		"  Its history does not record the workflow file it came from.",
		"  The recorded run has been preserved.",
	].join("\n")
}
