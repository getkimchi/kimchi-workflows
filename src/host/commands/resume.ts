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
import { resumeAction } from "../resume-router.ts";
import type { RunLock } from "../run-lock.ts";
import { summarizeRun } from "../summarize-run.ts";
import type { RunStore } from "../types.ts";
import { handleAttendedQuestionnaire, pendingQuestionnaire } from "./attended.ts";
import { type CommandCtx, describe, notifier, notifyResult, rejectIfBusy, runGuarded, type StartAgent } from "./context.ts";

export async function handleResume(ctx: CommandCtx, store: RunStore, guard: RunLock, startAgent: StartAgent, runId: string): Promise<void> {
  if (rejectIfBusy(ctx, guard, "resuming")) return;

  const meta = await store.loadMeta(runId);
  if (!meta) return void ctx.ui.notify(`workflow: no run "${runId}" to resume.`, "error");

  const workflow = await loadWorkflowFile(meta.workflowFilePath).catch((err: unknown) => {
    ctx.ui.notify(`workflow: failed to reload "${meta.workflowFilePath}" for resume: ${describe(err)}`, "error");
    return undefined;
  });
  if (!workflow) return;

  const events = await store.loadEvents(runId);
  const status = summarizeRun(events)?.status;
  if (!status) return void ctx.ui.notify(`workflow: run "${runId}" has no recorded events.`, "error");

  // Pure routing (spec §5.2): blocked → answer path; crashed/cancelled → re-run; completed → error.
  const action = resumeAction(status);
  if (action.kind === "error") return void ctx.ui.notify(`workflow: cannot resume run ${runId}: ${action.reason}.`, "warning");

  if (action.kind === "answer") {
    await handleAttendedQuestionnaire(ctx, store, guard, workflow.name, meta.workflowFilePath, startAgent, runId, pendingQuestionnaire(events));
    return;
  }

  // rerun: node-atomic re-run (3a/5a). A re-run may itself reach a Q&A step and block → attend it.
  const result = await runGuarded(guard, runId, ctx.cwd, store, notifier(ctx), (signal) => {
    const host = createHostPort(store, { startAgent });
    return resumeWorkflow(workflow, events, host, { signal });
  });
  if (!result) return; // guard was busy (race) — already notified

  if (result.status === "blocked") {
    await handleAttendedQuestionnaire(ctx, store, guard, workflow.name, meta.workflowFilePath, startAgent, runId, result.questionnaire);
  } else {
    notifyResult(ctx, workflow.name, result);
  }
}
