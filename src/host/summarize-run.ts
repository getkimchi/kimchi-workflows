import type { RunEvent } from "../engine/types.ts";
import type { RunSummary } from "./types.ts";

/**
 * Fold one run's ordered events into a `RunSummary`. Shared by every `RunStore` implementation
 * (memory, filesystem) so listing logic is defined exactly once.
 *
 * Status reflects the *latest* lifecycle transition, so a run that crashed and was then resumed to
 * completion lists as `completed`, and one still executing after a resume lists as `running`.
 */
export function summarizeRun(events: readonly RunEvent[]): RunSummary | undefined {
  const started = events.find((event): event is Extract<RunEvent, { type: "run-started" }> => event.type === "run-started");
  if (!started) {
    return undefined;
  }

  let status: RunSummary["status"] = "running";
  let completedAt: string | undefined;
  for (const event of events) {
    if (event.type === "run-completed") {
      status = "completed";
      completedAt = event.at;
    } else if (event.type === "run-crashed") {
      status = "crashed";
      completedAt = event.at;
    } else if (event.type === "run-cancelled") {
      status = "cancelled";
      completedAt = event.at;
    } else if (event.type === "questionnaire-asked") {
      status = "parked"; // suspended awaiting answers (spec §10); non-terminal, resumable
      completedAt = undefined;
    } else if (event.type === "run-resumed" || event.type === "answers-provided") {
      status = "running";
      completedAt = undefined;
    }
  }

  return {
    runId: started.runId,
    workflowName: started.workflowName,
    startedAt: started.at,
    completedAt,
    status,
  };
}
