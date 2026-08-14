/**
 * `/workflow resume <run-id>` (spec §6.2) — continue a `blocked`, `crashed`, or `cancelled` run from
 * its last checkpoint.
 *
 * Which of the two resume paths applies is decided by pure routing over the run's status
 * (`resumeAction`, spec §5.2): a blocked run takes the answer path (§8.4), a stopped one is re-run
 * node-atomically (§8.2/§8.3). A re-run can itself reach a Q&A step, so both converge on the attended
 * loop.
 */
import { resumeWorkflow } from "../../engine/resume-workflow.ts"
import { missingWorkflowProvenance, recordedWorkflowLoadFailure } from "../failure-messages.ts"
import { createHostPort } from "../host-port.ts"
import { noProgressFor, type ProgressFor, progressCallbacks } from "../progress-sink.ts"
import { resumeAction } from "../resume-router.ts"
import type { RunLock } from "../run-lock.ts"
import { summarizeRun } from "../summarize-run.ts"
import type { RunStore } from "../types.ts"
import { loadValidatedWorkflow } from "../workflow-preflight.ts"
import { handleAttendedInput, humanInputOf, pendingHumanInput } from "./attended.ts"
import {
	type CommandCtx,
	notifier,
	rejectIfBusy,
	reportResult,
	resolveRunRef,
	runGuarded,
	type StartAgent,
} from "./context.ts"

export async function handleResume(
	ctx: CommandCtx,
	store: RunStore,
	guard: RunLock,
	startAgent: StartAgent,
	runRef: string,
	progressFor: ProgressFor = noProgressFor,
): Promise<void> {
	if (rejectIfBusy(ctx, guard, "resuming")) return

	const runId = await resolveRunRef(ctx, store, runRef, "resume")
	if (!runId) return // unknown or ambiguous — already notified

	// The log FIRST, and the workflow file out of it: provenance is a `run-meta` event now (spec §8.9),
	// not a sidecar, so there is nothing else to consult. A log with no `run-meta` is one this build
	// cannot resume — pre-slug runs are inert by design (no migration), and saying so plainly beats
	// guessing at a path.
	const events = await store.loadEvents(runId)
	const summary = summarizeRun(events)
	if (!summary) return void ctx.ui.notify(`workflow: run "${runId}" has no recorded events.`, "error")
	const status = summary.status

	const workflowFilePath = events.find((event) => event.type === "run-meta")?.workflowFilePath
	if (!workflowFilePath) return void ctx.ui.notify(missingWorkflowProvenance(runId, "resumed"), "error")

	const loaded = await loadValidatedWorkflow({ filePath: workflowFilePath, projectRoot: ctx.cwd })
	if (!loaded.ok) {
		ctx.ui.notify(
			recordedWorkflowLoadFailure({
				workflowName: summary.workflowName,
				runId,
				workflowFilePath,
				action: "resume",
				cause: loaded.cause,
			}),
			"error",
		)
		return
	}
	const workflow = loaded.workflow

	// Pure routing (spec §5.2): blocked → answer path; crashed/cancelled → re-run; completed → error.
	const action = resumeAction(status)
	if (action.kind === "error")
		return void ctx.ui.notify(`workflow: cannot resume run ${runId}: ${action.reason}.`, "warning")

	// Seed the panel from the log BEFORE the first new event (progress §9.1), so the widget opens showing
	// everything already done — collapsed per §6.1 — rather than an empty tree that fills in backwards.
	// This falls out of §2.4: the projection does not care whether events arrived live or from disk.
	const progress = progressFor(workflow, runId, workflowFilePath)
	progress.seed(events)
	try {
		if (action.kind === "answer") {
			await handleAttendedInput(
				ctx,
				store,
				guard,
				workflow.name,
				workflowFilePath,
				startAgent,
				runId,
				pendingHumanInput(events),
				progress,
			)
			return
		}

		// rerun: node-atomic re-run (3a/5a). A re-run may itself reach a Q&A step and block → attend it.
		const result = await runGuarded(guard, runId, ctx.cwd, store, notifier(ctx), (signal) => {
			const host = createHostPort(store, { startAgent, ...progressCallbacks(progress) })
			return resumeWorkflow(workflow, events, host, { signal })
		})
		if (!result) return // guard was busy (race) — already notified

		if (result.status === "blocked") {
			await handleAttendedInput(
				ctx,
				store,
				guard,
				workflow.name,
				workflowFilePath,
				startAgent,
				runId,
				humanInputOf(result),
				progress,
			)
		} else {
			reportResult(ctx, workflow.name, result, progress.reportedOutcome())
		}
	} finally {
		progress.dispose()
	}
}
