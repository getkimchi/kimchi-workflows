/**
 * The attended inline Q&A loop (spec §10.2) — the one place a blocked run is turned back into an
 * in_progress one by asking the user.
 *
 * Shared by `/workflow run`, `/workflow create`, and `/workflow resume`, all of which can reach a
 * blocked step and must then attend it identically.
 */
import { pendingQuestionnaires, resumeWithAnswer } from "../../engine/resume-workflow.ts"
import type { RunEvent, RunResult } from "../../engine/types.ts"
import type { Questionnaire } from "../../flow/questionnaire.ts"
import { createHostPort } from "../host-port.ts"
import { loadWorkflowFile } from "../load-workflow.ts"
import { inertProgress, type ProgressSink } from "../progress-sink.ts"
import { collectAnswers } from "../questionnaire-render.ts"
import type { RunLock } from "../run-lock.ts"
import type { RunStore } from "../types.ts"
import { type CommandCtx, describe, notifier, reportResult, runGuarded, type StartAgent } from "./context.ts"

/** A blocked step's pending batch plus the node path (spec §8.5) that batch belongs to. */
export interface PendingAsk {
	readonly path: string
	readonly questionnaire: Questionnaire
}

/**
 * Render the pending questionnaire (rich `ctx.ui.custom` form when a TUI is present, native dialogs
 * otherwise — see {@link collectAnswers}), collect structured answers, and continue via
 * `resumeWithAnswer` — looping while it re-blocks.
 *
 * The answers are delivered to the exact `path` whose questions were just shown, never to whichever
 * block the engine's own default would pick: under concurrency several steps can be blocked at once
 * (spec §8.6), and a step that RE-blocks (invalid answers, or a follow-up batch) becomes the most
 * recently asked while a sibling remains the earliest — so "the one just displayed" and "the FIFO-first
 * pending one" are genuinely different steps, and answering the latter would file the user's reply
 * under a question they never saw.
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
	initialAsk: PendingAsk | undefined,
	/** The invocation's sink, shared across every resume in this loop so the widget survives the block (progress §7.5). */
	progress: ProgressSink = inertProgress,
): Promise<void> {
	let ask = initialAsk
	for (;;) {
		if (!ask) return void ctx.ui.notify(`workflow: run ${runId} is blocked but has no recorded questions.`, "warning")

		const answers = await collectAnswers(ctx, ask.questionnaire)
		if (answers === undefined) {
			// Dismiss ≠ cancel (spec §10.2): the run stays blocked and is resumable later.
			ctx.ui.notify(
				`workflow: run ${runId} is still blocked; answer later via "/workflow resume ${runId}", or "/workflow cancel ${runId}" to stop it.`,
				"info",
			)
			return
		}

		const targetPath = ask.path // answer the block we just showed, not whatever the engine would default to
		// The run may have been stopped while the prompt was open (another session, spec §8.9); the
		// engine refuses such an answer rather than undoing the cancellation, and we report it plainly.
		let result: Awaited<ReturnType<typeof runGuarded>>
		try {
			result = await runGuarded(guard, runId, ctx.cwd, store, notifier(ctx), async (signal) => {
				const workflow = await loadWorkflowFile(workflowFilePath)
				const events = await store.loadEvents(runId)
				const host = createHostPort(store, { startAgent, onEvent: progress.accept })
				return resumeWithAnswer(workflow, events, answers, host, { signal, path: targetPath })
			})
		} catch (err) {
			ctx.ui.notify(`workflow: ${describe(err)}`, "warning")
			return
		}
		if (!result) return // guard was busy (race) — already notified; the run stays blocked

		if (result.status === "blocked") {
			ask = askOf(result) // re-block (another batch, invalid answers, or a still-pending sibling) → ask again
			continue
		}
		reportResult(ctx, workflowName, result, progress.reportedOutcome())
		return
	}
}

/** The block a `blocked` {@link RunResult} is reporting — its questions together with the path they belong to. */
export function askOf(result: RunResult): PendingAsk | undefined {
	return result.questionnaire && result.path ? { path: result.path, questionnaire: result.questionnaire } : undefined
}

/**
 * The block a `/workflow resume` should show first: the FIFO-first currently-blocked one (spec §8.6).
 * With several steps blocked at once, the path travels with the questions so the answer is delivered
 * back to the step that asked them.
 */
export function pendingAsk(events: readonly RunEvent[]): PendingAsk | undefined {
	const pending = pendingQuestionnaires(events)[0]
	return pending && { path: pending.path, questionnaire: pending.questionnaire }
}
