import { currentStepName, deriveRunStatus, pendingQuestionCount, type RunStatus } from "../engine/run-status.ts"
import { deriveStepStates } from "../engine/step-state.ts"
import type { RunEvent } from "../engine/types.ts"
import type { RunSummary } from "./types.ts"

const TERMINAL: ReadonlySet<RunStatus> = new Set(["completed", "cancelled", "crashed"])

/**
 * Fold one run's ordered events into a `RunSummary` (spec §6.3), entirely via the pure engine
 * derivation (spec §5.1/§5.3) — this file holds no state logic of its own, only the `at` lookup for
 * `completedAt` and the shaping into `RunSummary`. Shared by every `RunStore` implementation (memory,
 * filesystem) so listing logic is defined exactly once.
 */
export function summarizeRun(events: readonly RunEvent[]): RunSummary | undefined {
	const started = events.find(
		(event): event is Extract<RunEvent, { type: "run-started" }> => event.type === "run-started",
	)
	if (!started) {
		return undefined
	}

	const status = deriveRunStatus(events)
	if (!status) {
		return undefined // unreachable once `started` is found, but keeps this function total
	}

	const states = deriveStepStates(events)

	return {
		runId: started.runId,
		workflowName: started.workflowName,
		startedAt: started.at,
		completedAt: TERMINAL.has(status) ? terminalAt(events) : undefined,
		status,
		currentStep: currentStepName(status, states),
		pendingQuestions: pendingQuestionCount(states),
	}
}

/** The `at` of the latest run-level terminal event — the one that produced the current (terminal) status. */
function terminalAt(events: readonly RunEvent[]): string | undefined {
	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i]
		if (event && (event.type === "run-completed" || event.type === "run-cancelled" || event.type === "run-crashed")) {
			return event.at
		}
	}
	return undefined
}
