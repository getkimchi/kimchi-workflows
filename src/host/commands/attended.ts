/**
 * The attended inline Q&A loop (spec §10.2) — the one place a parked run is turned back into a
 * running one by asking the user.
 *
 * Shared by `/workflow run`, `/workflow create`, and `/workflow resume`, all of which can reach a
 * parked step and must then attend it identically.
 */
import { resumeWithAnswer } from "../../engine/resume-workflow.ts";
import type { RunEvent } from "../../engine/types.ts";
import type { Questionnaire } from "../../flow/questionnaire.ts";
import { createHostPort } from "../host-port.ts";
import { loadWorkflowFile } from "../load-workflow.ts";
import { collectAnswers } from "../questionnaire-render.ts";
import type { RunGuard } from "../run-guard.ts";
import type { RunStore } from "../types.ts";
import { type CommandCtx, describe, notifier, notifyResult, runGuarded, type StartAgent } from "./context.ts";

/**
 * Render the pending questionnaire (rich `ctx.ui.custom` form when a TUI is present, native dialogs
 * otherwise — see {@link collectAnswers}), collect structured answers, and continue via
 * `resumeWithAnswer` — looping while it re-parks.
 *
 * Dismissing the prompt leaves the run `parked` (dismiss ≠ cancel, spec §10.2). The guard is acquired
 * only around each resume execution, so while parked/prompting it is released and does not block new
 * runs (spec §7.1).
 */
export async function handleAttendedQuestionnaire(
  ctx: CommandCtx,
  store: RunStore,
  guard: RunGuard,
  workflowName: string,
  workflowFilePath: string,
  startAgent: StartAgent,
  runId: string,
  initialQuestionnaire: Questionnaire | undefined,
): Promise<void> {
  let questionnaire = initialQuestionnaire;
  for (;;) {
    if (!questionnaire) return void ctx.ui.notify(`workflow: run ${runId} is parked but has no recorded questions.`, "warning");

    const answers = await collectAnswers(ctx, questionnaire);
    if (answers === undefined) {
      // Dismiss ≠ cancel (spec §10.2): the run stays parked and is resumable later.
      ctx.ui.notify(`workflow: run ${runId} is still parked; answer later via "/workflow resume ${runId}", or "/workflow cancel ${runId}" to stop it.`, "info");
      return;
    }

    // The run may have been stopped while the prompt was open (another session, spec §8.7); the
    // engine refuses such an answer rather than undoing the cancellation, and we report it plainly.
    let result: Awaited<ReturnType<typeof runGuarded>>;
    try {
      result = await runGuarded(guard, runId, notifier(ctx), async (signal) => {
        const workflow = await loadWorkflowFile(workflowFilePath);
        const events = await store.loadEvents(runId);
        const host = createHostPort(store, { startAgent });
        return resumeWithAnswer(workflow, events, answers, host, { signal });
      });
    } catch (err) {
      ctx.ui.notify(`workflow: ${describe(err)}`, "warning");
      return;
    }
    if (!result) return; // guard was busy (race) — already notified; the run stays parked

    if (result.status === "parked") {
      questionnaire = result.questionnaire; // re-park (another batch, or invalid answers) → ask again
      continue;
    }
    notifyResult(ctx, workflowName, result);
    return;
  }
}

/** The pending questionnaire of a parked run: the last `questionnaire-asked` payload. */
export function pendingQuestionnaire(events: readonly RunEvent[]): Questionnaire | undefined {
  let questionnaire: Questionnaire | undefined;
  for (const event of events) {
    if (event.type === "questionnaire-asked") questionnaire = event.questionnaire;
  }
  return questionnaire;
}
