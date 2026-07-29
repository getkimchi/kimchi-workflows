/**
 * `/workflow resume <run-id>` (spec §6.2) — continue a `blocked`, `crashed`, or `cancelled` run from
 * its last checkpoint.
 *
 * Which of the two resume paths applies is decided by pure routing over the run's status
 * (`resumeAction`, spec §5.2): a blocked run takes the answer path (§8.4), a stopped one is re-run
 * node-atomically (§8.2/§8.3). A re-run can itself reach a Q&A step, so both converge on the attended
 * loop.
 */
import { resumeWorkflow } from "../../engine/resume-workflow.ts";
import { createHostPort } from "../host-port.ts";
import { loadWorkflowFile } from "../load-workflow.ts";
import { noProgressFor, type ProgressFor } from "../progress-sink.ts";
import { resumeAction } from "../resume-router.ts";
import type { RunLock } from "../run-lock.ts";
import { summarizeRun } from "../summarize-run.ts";
import type { RunStore } from "../types.ts";
import { askOf, handleAttendedQuestionnaire, pendingAsk } from "./attended.ts";
import { type CommandCtx, describe, notifier, rejectIfBusy, reportResult, resolveRunRef, runGuarded, type StartAgent } from "./context.ts";

export async function handleResume(
  ctx: CommandCtx,
  store: RunStore,
  guard: RunLock,
  startAgent: StartAgent,
  runRef: string,
  progressFor: ProgressFor = noProgressFor,
): Promise<void> {
  if (rejectIfBusy(ctx, guard, "resuming")) return;

  const runId = await resolveRunRef(ctx, store, runRef, "resume");
  if (!runId) return; // unknown or ambiguous — already notified

  // The log FIRST, and the workflow file out of it: provenance is a `run-meta` event now (spec §8.9),
  // not a sidecar, so there is nothing else to consult. A log with no `run-meta` is one this build
  // cannot resume — pre-slug runs are inert by design (no migration), and saying so plainly beats
  // guessing at a path.
  const events = await store.loadEvents(runId);
  const status = summarizeRun(events)?.status;
  if (!status) return void ctx.ui.notify(`workflow: run "${runId}" has no recorded events.`, "error");

  const workflowFilePath = events.find((event) => event.type === "run-meta")?.workflowFilePath;
  if (!workflowFilePath) return void ctx.ui.notify(`workflow: run ${runId} does not record which workflow file it was launched from; it cannot be resumed.`, "error");

  const workflow = await loadWorkflowFile(workflowFilePath).catch((err: unknown) => {
    ctx.ui.notify(`workflow: failed to reload "${workflowFilePath}" for resume: ${describe(err)}`, "error");
    return undefined;
  });
  if (!workflow) return;

  // Pure routing (spec §5.2): blocked → answer path; crashed/cancelled → re-run; completed → error.
  const action = resumeAction(status);
  if (action.kind === "error") return void ctx.ui.notify(`workflow: cannot resume run ${runId}: ${action.reason}.`, "warning");

  // Seed the panel from the log BEFORE the first new event (progress §9.1), so the widget opens showing
  // everything already done — collapsed per §6.1 — rather than an empty tree that fills in backwards.
  // This falls out of §2.4: the projection does not care whether events arrived live or from disk.
  const progress = progressFor(workflow, runId, workflowFilePath);
  progress.seed(events);
  try {
    if (action.kind === "answer") {
      await handleAttendedQuestionnaire(ctx, store, guard, workflow.name, workflowFilePath, startAgent, runId, pendingAsk(events), progress);
      return;
    }

    // rerun: node-atomic re-run (3a/5a). A re-run may itself reach a Q&A step and block → attend it.
    const result = await runGuarded(guard, runId, ctx.cwd, store, notifier(ctx), (signal) => {
      const host = createHostPort(store, { startAgent, onEvent: progress.accept });
      return resumeWorkflow(workflow, events, host, { signal });
    });
    if (!result) return; // guard was busy (race) — already notified

    if (result.status === "blocked") {
      await handleAttendedQuestionnaire(ctx, store, guard, workflow.name, workflowFilePath, startAgent, runId, askOf(result), progress);
    } else {
      reportResult(ctx, workflow.name, result, progress.reportedOutcome());
    }
  } finally {
    progress.dispose();
  }
}
