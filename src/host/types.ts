import type { RunStatus } from "../engine/run-status.ts"
import type { RunEvent } from "../engine/types.ts"

/** One row of `/workflow list` output (spec §6.3). */
export interface RunSummary {
	readonly runId: string
	readonly workflowName: string
	/** Derived from the event log (spec §5.3) — never an authoritative stored field. */
	readonly status: RunStatus
	readonly startedAt: string
	readonly completedAt?: string
	/** The step the run is currently at, if any (spec §6.3): its `in_progress`/`blocked` step while
	 * live, or the step it stopped at when `crashed`/`cancelled`. */
	readonly currentStep?: string
	/** How many steps await human input — retained under its original field name for compatibility. */
	readonly pendingQuestions: number
}

/** The process identity recorded for one execution owner. It deliberately contains no PI session id. */
export interface RunExecutionOwner {
	/** Private token used only to prove ownership when releasing a lease. */
	readonly ownerId: string
	readonly host: string
	readonly pid: number
	readonly processStartedAt: string
}

/** One attempt to execute (or resume) a run. A resume receives a fresh execution id. */
export interface RunExecutionLease {
	readonly version: 1
	readonly runId: string
	readonly executionId: string
	readonly owner: RunExecutionOwner
	readonly acquiredAt: string
}

export type RunExecutionLeaseState = "owned" | "live" | "dead" | "foreign"

export interface InspectedRunExecution {
	readonly lease: RunExecutionLease
	/** `foreign` means the owner is on another host and cannot be verified locally. */
	readonly state: RunExecutionLeaseState
}

/** Atomic, per-run execution exclusion supplied by durable stores. */
export interface RunExecutionStore {
	acquire(runId: string): Promise<RunExecutionLease>
	inspect(runId: string): Promise<InspectedRunExecution | undefined>
	/**
	 * Exclusively retire this exact lease, running `beforeRelease` while acquisition is still excluded.
	 * Used by reconciliation so a new execution cannot start between the crash event and stale cleanup.
	 */
	retire(lease: RunExecutionLease, beforeRelease: () => Promise<void>): Promise<boolean>
	/** Remove this exact lease. Returns false if it no longer owns the lease path. */
	release(lease: RunExecutionLease): Promise<boolean>
}

/**
 * Per-run store (spec §8.9): an append-only event log keyed by run-id, plus listing.
 *
 * Workflow provenance stays in the JSONL as `run-meta`. Durable stores may additionally expose an
 * execution lease sidecar. The lease is coordination state, not run history: ownership is also written
 * to the JSONL as `run-execution-started`, while the sidecar exists only to make acquisition atomic.
 */
export interface RunStore {
	readonly executions?: RunExecutionStore
	/** Append one lifecycle event to the run's log. */
	appendEvent(event: RunEvent): Promise<void>
	/** Read a run's full ordered event log (empty if the run is unknown). Used to rebuild state on resume. */
	loadEvents(runId: string): Promise<RunEvent[]>
	/** Permanently remove a run's event log (spec §6.5). */
	delete(runId: string): Promise<void>
	/**
	 * Summarize every recorded run for `/workflow run list`. A pure read: it never creates the store's
	 * backing directory, because completion calls it on a keystroke (spec §14.6). No runs recorded — or
	 * nowhere to record them yet — is an empty list.
	 */
	list(): Promise<RunSummary[]>
}
