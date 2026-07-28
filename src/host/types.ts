import type { RunStatus } from "../engine/run-status.ts";
import type { RunEvent } from "../engine/types.ts";

/** One row of `/workflow list` output (spec §6.3). */
export interface RunSummary {
  readonly runId: string;
  readonly workflowName: string;
  /** Derived from the event log (spec §5.3) — never an authoritative stored field. */
  readonly status: RunStatus;
  readonly startedAt: string;
  readonly completedAt?: string;
  /** The step the run is currently at, if any (spec §6.3): its `in_progress`/`blocked` step while
   * live, or the step it stopped at when `crashed`/`cancelled`. */
  readonly currentStep?: string;
  /** How many steps are currently `blocked` (spec §6.3) — not implied by `status` alone (§5.3). */
  readonly pendingQuestions: number;
}

/**
 * Per-run store (spec §8.9): an append-only event log keyed by run-id, plus listing.
 *
 * There is no metadata sidecar. The one fact the host needed one for — which file a run was launched
 * from, so `/workflow resume` can reload it (spec §8.5) — is now a `run-meta` event in the log itself
 * (engine/types.ts), which makes a run exactly one file: nothing to keep in sync, nothing to leave
 * behind on delete, and a log that is self-describing wherever it is read.
 */
export interface RunStore {
  /** Append one lifecycle event to the run's log. */
  appendEvent(event: RunEvent): Promise<void>;
  /** Read a run's full ordered event log (empty if the run is unknown). Used to rebuild state on resume. */
  loadEvents(runId: string): Promise<RunEvent[]>;
  /** Permanently remove a run's event log (spec §6.5). */
  delete(runId: string): Promise<void>;
  /** Summarize every recorded run for `/workflow list`. */
  list(): Promise<RunSummary[]>;
}
