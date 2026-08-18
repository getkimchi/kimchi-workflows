import type { RunEvent } from "../engine/types.ts"
import { summarizeRun } from "./summarize-run.ts"
import type { InspectedRunExecution, RunStore, RunSummary } from "./types.ts"

export interface ReconciledRun {
	readonly runId: string
	readonly executionId?: string
}

type CrashEvent = Extract<RunEvent, { type: "run-crashed" }>
type IsRunActive = (runId: string) => boolean

interface ProjectableRunStore extends Pick<RunStore, "list"> {
	readonly executions?: RunStore["executions"]
	readonly loadEvents?: RunStore["loadEvents"]
}

interface Abandonment {
	readonly crash: CrashEvent
	readonly inspected?: InspectedRunExecution
}

/**
 * Build the read-only view of one run's history.
 *
 * A provably dead/missing local executor is projected as `crashed`, but the synthetic terminal is not
 * appended. `/workflow run list` and `/workflow status` can therefore stop displaying ghost
 * `in_progress` runs without making observation a state-changing operation.
 */
export async function projectRunEvents(
	store: Pick<RunStore, "loadEvents" | "executions">,
	runId: string,
	options: { readonly isActive?: IsRunActive; readonly now?: () => Date } = {},
): Promise<RunEvent[]> {
	const events = await store.loadEvents(runId)
	const abandonment = await inspectAbandonment(store, runId, events, options.isActive, options.now)
	return abandonment ? [...events, abandonment.crash] : events
}

/** Read-only summaries with the same abandoned-run projection used by `/workflow status`. */
export async function projectRunSummaries(
	store: ProjectableRunStore,
	options: { readonly isActive?: IsRunActive; readonly now?: () => Date } = {},
): Promise<RunSummary[]> {
	const summaries = await store.list()
	const { executions, loadEvents } = store
	if (!executions || !loadEvents) return summaries

	return Promise.all(
		summaries.map(async (summary) => {
			if (summary.status !== "in_progress") return summary
			const events = await projectRunEvents({ executions, loadEvents }, summary.runId, options)
			return summarizeRun(events) ?? summary
		}),
	)
}

/**
 * Durably reconcile one run immediately before a lifecycle mutation acts on it.
 *
 * Only a locally provable dead owner is reclaimed. A live PID and every foreign-host lease remain
 * authoritative; cross-host liveness is intentionally outside this package's contract. A legacy
 * `in_progress` log with no lease is also abandoned when this store supports execution inspection.
 */
export async function reconcileAbandonedRun(
	store: RunStore,
	runId: string,
	isActive: IsRunActive = () => false,
): Promise<ReconciledRun | undefined> {
	const executions = store.executions
	if (!executions || isActive(runId)) return undefined

	const events = await store.loadEvents(runId)
	const summary = summarizeRun(events)
	const inspected = await executions.inspect(runId)

	if (summary?.status === "in_progress") {
		const abandonment = await inspectAbandonment(store, runId, events, isActive, () => new Date(), inspected)
		if (!abandonment) return undefined
		const recordCrash = () => store.appendEvent(abandonment.crash)
		let recorded = true
		if (abandonment.inspected) recorded = await executions.retire(abandonment.inspected.lease, recordCrash)
		else await recordCrash()
		return recorded ? { runId, executionId: abandonment.crash.executionId } : undefined
	}

	// A process may die after its terminal event was flushed but before its finally block removed the
	// lease. The terminal history already says what happened; only stale coordination state remains.
	if (inspected?.state === "dead") await executions.release(inspected.lease)
	return undefined
}

async function inspectAbandonment(
	store: Pick<RunStore, "executions">,
	runId: string,
	events: readonly RunEvent[],
	isActive: IsRunActive = () => false,
	now: () => Date = () => new Date(),
	knownInspection?: InspectedRunExecution,
): Promise<Abandonment | undefined> {
	const executions = store.executions
	if (!executions || isActive(runId) || summarizeRun(events)?.status !== "in_progress") return undefined

	const inspected = knownInspection ?? (await executions.inspect(runId))
	if (inspected && inspected.state !== "dead") return undefined
	const executionId = inspected?.lease.executionId ?? latestExecutionId(events)
	const owner = inspected?.lease.owner
	return {
		inspected,
		crash: {
			type: "run-crashed",
			runId,
			executionId,
			error: owner
				? `workflow executor PID ${owner.pid} on ${owner.host} exited without recording a terminal event`
				: "workflow executor disappeared without an execution lease or terminal event",
			at: now().toISOString(),
		},
	}
}

export function latestExecutionId(events: readonly RunEvent[]): string | undefined {
	let executionId: string | undefined
	for (const event of events) if (event.type === "run-execution-started") executionId = event.executionId
	return executionId
}
