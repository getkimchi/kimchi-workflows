import type { RunSummary } from "./types.ts";

/** A run's status as seen by the adapter (from `summarizeRun`). */
export type RunStatus = RunSummary["status"];

/**
 * How `/workflow resume` should proceed for a given run status (spec §5.2/§6.2):
 *  - `answer`  — the run is `parked`: render the pending question and continue via `resumeWithAnswer`;
 *  - `rerun`   — the run is `crashed`/`cancelled`: node-atomic re-run via `resumeWorkflow`;
 *  - `error`   — nothing to resume (`completed`, or still `running`).
 */
export type ResumeAction = { kind: "answer" } | { kind: "rerun" } | { kind: "error"; reason: string };

/** Pure routing: map a run's status to the resume action (spec §5.2). */
export function resumeAction(status: RunStatus): ResumeAction {
  switch (status) {
    case "parked":
      return { kind: "answer" };
    case "crashed":
    case "cancelled":
      return { kind: "rerun" };
    case "completed":
      return { kind: "error", reason: "run is already completed; start a new run instead" };
    case "running":
      return { kind: "error", reason: "run is currently running" };
  }
}
