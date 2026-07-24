/**
 * The attended inline Q&A loop (spec §10.2) — the one place a blocked run is turned back into an
 * in_progress one by asking the user.
 *
 * Shared by `/workflow run`, `/workflow create`, and `/workflow resume`, all of which can reach a
 * blocked step and must then attend it identically.
 */
import { pendingQuestionnaires, resumeWithAnswer } from "../../engine/resume-workflow.ts";
import type { RunEvent } from "../../engine/types.ts";
import type { Questionnaire } from "../../flow/questionnaire.ts";
import { createHostPort } from "../host-port.ts";
import { loadWorkflowFile } from "../load-workflow.ts";
import { collectAnswers } from "../questionnaire-render.ts";
import type { RunLock } from "../run-lock.ts";
import type { RunStore } from "../types.ts";
import { type CommandCtx, describe, notifier, notifyResult, runGuarded, type StartAgent } from "./context.ts";

/**
 * Render the pending questionnaire (rich `ctx.ui.custom` form when a TUI is present, native dialogs
 * otherwise — see {@link collectAnswers}), collect structured answers, and continue via
 * `resumeWithAnswer` — looping while it re-blocks.
 *
 * Dismissing the prompt leaves the run `blocked` (dismiss ≠ cancel, spec §10.2). The guard is acquired
 * only around each resume execution, so while blocked/prompting it is released and does not block new
 * runs (spec §7.1).
 */
export async function handleAttendedQuestionnaire(
  ctx: CommandCtx,
  store: RunStore,
  guard: RunLock,
  workflowName: string,
  workflowFilePath: string,
  startAgent: StartAgent,
  runId: string,
  initialQuestionnaire: Questionnaire | undefined,
): Promise<void> {
  let questionnaire = initialQuestionnaire;
  for (;;) {
    if (!questionnaire) return void ctx.ui.notify(`workflow: run ${runId} is blocked but has no recorded questions.`, "warning");

    const answers = await collectAnswers(ctx, questionnaire);
    if (answers === undefined) {
      // Dismiss ≠ cancel (spec §10.2): the run stays blocked and is resumable later.
      ctx.ui.notify(`workflow: run ${runId} is still blocked; answer later via "/workflow resume ${runId}", or "/workflow cancel ${runId}" to stop it.`, "info");
      return;
    }

    // The run may have been stopped while the prompt was open (another session, spec §8.7); the
    // engine refuses such an answer rather than undoing the cancellation, and we report it plainly.
    let result: Awaited<ReturnType<typeof runGuarded>>;
    try {
      result = await runGuarded(guard, runId, ctx.cwd, store, notifier(ctx), async (signal) => {
        const workflow = await loadWorkflowFile(workflowFilePath);
        const events = await store.loadEvents(runId);
        const host = createHostPort(store, { startAgent });
        return resumeWithAnswer(workflow, events, answers, host, { signal });
      });
    } catch (err) {
      ctx.ui.notify(`workflow: ${describe(err)}`, "warning");
      return;
    }
    if (!result) return; // guard was busy (race) — already notified; the run stays blocked

    if (result.status === "blocked") {
      questionnaire = result.questionnaire; // re-block (another batch, or invalid answers) → ask again
      continue;
    }
    notifyResult(ctx, workflowName, result);
    return;
  }
}

/**
 * The pending questionnaire a `/workflow resume` should show first: the FIFO-first currently-blocked
 * one (spec §8.6) — i.e. exactly the one `resumeWithAnswer` targets by default when this same answer is
 * delivered back with no explicit `path`. With several steps blocked at once, showing anything else
 * (e.g. simply the last EVER asked) would let the user answer a DIFFERENT question than the one displayed.
 */
export function pendingQuestionnaire(events: readonly RunEvent[]): Questionnaire | undefined {
  return pendingQuestionnaires(events)[0]?.questionnaire;
}
