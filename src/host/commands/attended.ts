/**
 * The attended human-input loop. Questionnaire collection and workflow-defined interactions converge
 * here, outside the engine and outside the project run lock.
 */

import { parsePath } from "../../engine/node-path.ts"
import {
	pendingHumanInputs,
	resolveStepAtStaticPath,
	resumeWithAnswer,
	resumeWithInteraction,
} from "../../engine/resume-workflow.ts"
import type { RunEvent, RunResult } from "../../engine/types.ts"
import type { Questionnaire } from "../../flow/questionnaire.ts"
import type { InteractiveStep, WorkflowDefinition } from "../../flow/types.ts"
import { createHostPort } from "../host-port.ts"
import { loadWorkflowFile } from "../load-workflow.ts"
import { inertProgress, type ProgressSink } from "../progress-sink.ts"
import { collectAnswers } from "../questionnaire-render.ts"
import type { RunLock } from "../run-lock.ts"
import type { RunStore } from "../types.ts"
import { type CommandCtx, describe, notifier, reportResult, runGuarded, type StartAgent } from "./context.ts"

export interface PendingAsk {
	readonly kind: "questionnaire"
	readonly path: string
	readonly questionnaire: Questionnaire
}

export interface PendingInteraction {
	readonly kind: "interaction"
	readonly path: string
	readonly request: unknown
	readonly violation?: string
}

export type PendingHumanInput = PendingAsk | PendingInteraction

/**
 * Render and resolve human-input blocks until the run settles or the user dismisses one.
 *
 * Rendering is intentionally before `runGuarded`: a blocked run owns neither the project lock nor a
 * concurrency slot while a dialog/editor is open. Responses always target the exact path whose input
 * was displayed, including when several concurrent steps are blocked.
 */
export async function handleAttendedInput(
	ctx: CommandCtx,
	store: RunStore,
	guard: RunLock,
	workflowName: string,
	workflowFilePath: string,
	startAgent: StartAgent,
	runId: string,
	initialInput: PendingHumanInput | undefined,
	progress: ProgressSink = inertProgress,
): Promise<void> {
	let pending = initialInput
	for (;;) {
		if (!pending) {
			ctx.ui.notify(`workflow: run ${runId} is blocked but has no recorded human-input request.`, "warning")
			return
		}

		const targetPath = pending.path
		const pendingKind = pending.kind
		let candidate: unknown
		if (pending.kind === "questionnaire") {
			candidate = await collectAnswers(ctx, pending.questionnaire)
		} else {
			const workflow = await reloadForInteraction(ctx, workflowFilePath)
			if (!workflow) return
			const step = interactiveStepAt(workflow, targetPath)
			if (!step) {
				ctx.ui.notify(
					`workflow: cannot render interaction at "${targetPath}": the current workflow definition no longer contains that interactive step.`,
					"warning",
				)
				return
			}
			try {
				candidate = await step.render({
					request: pending.request,
					ui: ctx.ui,
					mode: ctx.mode,
					hasUI: ctx.hasUI,
					write: writePlain,
				})
			} catch (error) {
				ctx.ui.notify(
					`workflow: interaction "${targetPath}" could not be rendered: ${describe(error)}. The run remains blocked.`,
					"warning",
				)
				return
			}
		}

		if (candidate === undefined) {
			ctx.ui.notify(
				`workflow: run ${runId} is still blocked; respond later via "/workflow resume ${runId}", or "/workflow cancel ${runId}" to stop it.`,
				"info",
			)
			return
		}

		let result: Awaited<ReturnType<typeof runGuarded>>
		try {
			result = await runGuarded(guard, runId, ctx.cwd, store, notifier(ctx), async (signal) => {
				const workflow = await loadWorkflowFile(workflowFilePath)
				const events = await store.loadEvents(runId)
				const host = createHostPort(store, { startAgent, onEvent: progress.accept })
				return pendingKind === "questionnaire"
					? resumeWithAnswer(workflow, events, candidate as Record<string, unknown>, host, {
							signal,
							path: targetPath,
						})
					: resumeWithInteraction(workflow, events, candidate, host, { signal, path: targetPath })
			})
		} catch (error) {
			ctx.ui.notify(`workflow: ${describe(error)}`, "warning")
			return
		}
		if (!result) return

		if (result.status === "blocked") {
			pending = humanInputOf(result)
			continue
		}
		reportResult(ctx, workflowName, result, progress.reportedOutcome())
		return
	}
}

async function reloadForInteraction(
	ctx: CommandCtx,
	workflowFilePath: string,
): Promise<WorkflowDefinition | undefined> {
	try {
		return await loadWorkflowFile(workflowFilePath)
	} catch (error) {
		ctx.ui.notify(`workflow: failed to reload "${workflowFilePath}" for interaction: ${describe(error)}`, "warning")
		return undefined
	}
}

function interactiveStepAt(workflow: WorkflowDefinition, dynamicPath: string): InteractiveStep | undefined {
	const step = resolveStepAtStaticPath(
		workflow.nodes,
		parsePath(dynamicPath).map((segment) => segment.name),
	)
	return step?.kind === "interactive" ? step : undefined
}

function writePlain(message: string): void {
	process.stderr.write(message.endsWith("\n") ? message : `${message}\n`)
}

/** The human-input block reported by one `blocked` engine result. */
export function humanInputOf(result: RunResult): PendingHumanInput | undefined {
	if (!result.path) return undefined
	if (result.questionnaire) return { kind: "questionnaire", path: result.path, questionnaire: result.questionnaire }
	if (result.interaction !== undefined) {
		return {
			kind: "interaction",
			path: result.path,
			request: result.interaction,
			violation: result.violation,
		}
	}
	return undefined
}

/** The FIFO-first human-input block currently pending in the event log. */
export function pendingHumanInput(events: readonly RunEvent[]): PendingHumanInput | undefined {
	const pending = pendingHumanInputs(events)[0]
	if (!pending) return undefined
	return pending.type === "questionnaire-asked"
		? { kind: "questionnaire", path: pending.path, questionnaire: pending.questionnaire }
		: {
				kind: "interaction",
				path: pending.path,
				request: pending.request,
				violation: pending.violation,
			}
}

/** Backwards-compatible questionnaire-only helpers retained for command-layer consumers. */
export function askOf(result: RunResult): PendingAsk | undefined {
	const pending = humanInputOf(result)
	return pending?.kind === "questionnaire" ? pending : undefined
}

export function pendingAsk(events: readonly RunEvent[]): PendingAsk | undefined {
	const pending = pendingHumanInput(events)
	return pending?.kind === "questionnaire" ? pending : undefined
}
