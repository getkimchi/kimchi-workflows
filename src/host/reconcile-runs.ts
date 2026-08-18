import type { RunEvent } from "../engine/types.ts"
import type { ActiveRuns } from "./active-runs.ts"
import type { RunStore } from "./types.ts"

export interface ReconciledRun {
	readonly runId: string
	readonly executionId?: string
}

/**
 * Turn unverifiable `in_progress` history into an explicit crash.
 *
 * Only a locally provable dead owner is reclaimed. A live PID and every foreign-host lease remain
 * authoritative; cross-host liveness is intentionally outside this package's contract. Logs written
 * before execution leases existed are reconciled when no execution in this process owns their run id.
 */
export async function reconcileAbandonedRuns(store: RunStore, activeRuns: ActiveRuns): Promise<ReconciledRun[]> {
	const executions = store.executions
	if (!executions) return []

	const summaries = await store.list()
	const leases = new Map((await executions.list()).map((execution) => [execution.lease.runId, execution]))
	const reconciled: ReconciledRun[] = []

	for (const summary of summaries) {
		if (activeRuns.find(summary.runId).length > 0) continue
		const inspected = leases.get(summary.runId)

		if (summary.status === "in_progress") {
			if (inspected && inspected.state !== "dead") continue
			const events = await store.loadEvents(summary.runId)
			const executionId = inspected?.lease.executionId ?? latestExecutionId(events)
			const owner = inspected?.lease.owner
			const recordCrash = () =>
				store.appendEvent({
					type: "run-crashed",
					runId: summary.runId,
					executionId,
					error: owner
						? `workflow executor PID ${owner.pid} on ${owner.host} exited without recording a terminal event`
						: "workflow executor disappeared without an execution lease or terminal event",
					at: new Date().toISOString(),
				})
			let recorded = true
			if (inspected) recorded = await executions.retire(inspected.lease, recordCrash)
			else await recordCrash()
			if (recorded) reconciled.push({ runId: summary.runId, executionId })
			continue
		}

		// A process may die after its terminal event was flushed but before the finally block removed the
		// lease. The terminal history already says what happened; only the stale coordination state goes.
		if (inspected?.state === "dead") await executions.release(inspected.lease)
	}

	// Clean dead leases whose owner failed before `run-started` made the partial log listable.
	const known = new Set(summaries.map((summary) => summary.runId))
	for (const inspected of leases.values()) {
		if (!known.has(inspected.lease.runId) && inspected.state === "dead") await executions.release(inspected.lease)
	}

	return reconciled
}

export function latestExecutionId(events: readonly RunEvent[]): string | undefined {
	let executionId: string | undefined
	for (const event of events) if (event.type === "run-execution-started") executionId = event.executionId
	return executionId
}
