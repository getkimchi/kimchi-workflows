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
 * Per-run metadata the engine never sees (spec §8.7): lets the host adapter reload the workflow
 * definition to resume (spec §8.5). The engine stays file-unaware; the adapter writes this at run
 * start and reads it on `/workflow resume`.
 */
export interface RunMeta {
  /** Absolute path to the workflow `.ts` file this run was launched from. */
  readonly workflowFilePath: string;
  /** The workflow's declared name (mirrors the log; handy for listing/diagnostics). */
  readonly workflowName: string;
}

/** Per-project run store (spec §8.7): append-only event log keyed by run-id, plus metadata and listing. */
export interface RunStore {
  /** Append one lifecycle event to the run's log. */
  appendEvent(event: RunEvent): Promise<void>;
  /** Read a run's full ordered event log (empty if the run is unknown). Used to rebuild state on resume. */
  loadEvents(runId: string): Promise<RunEvent[]>;
  /** Persist a run's metadata sidecar. */
  saveMeta(runId: string, meta: RunMeta): Promise<void>;
  /** Read a run's metadata sidecar (undefined if absent). */
  loadMeta(runId: string): Promise<RunMeta | undefined>;
  /** Permanently remove a run: its event log and its metadata (spec §6.5). */
  delete(runId: string): Promise<void>;
  /** Summarize every recorded run for `/workflow list`. */
  list(): Promise<RunSummary[]>;
}
