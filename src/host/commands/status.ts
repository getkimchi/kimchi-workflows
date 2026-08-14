/**
 * `/workflow status [run-id]` (progress §11.4) — the answer to "show me everything".
 *
 * This command is the reason the live panel is free to collapse at all. A widget never receives
 * keyboard focus in PI (`handleInput` fires only for the focused component, and a widget is not one),
 * so there is no expand key on the panel itself (progress §6.6); the fully expanded tree has to be
 * reachable some other way, and this is it.
 *
 * Printed as plain text through `ctx.ui.notify`, for the reason recorded in progress-card.ts: the entry
 * renderer that would draw a themed, expandable card does not exist on every harness we run in, and a
 * command that works everywhere beats a prettier one that takes the extension down on pi 0.80.2.
 *
 * It reads a run's log and nothing else. That is what lets it show a PAST run exactly as it showed the
 * live one: the projection is a pure function of the log (progress §2.4), so "rebuild it from disk" and
 * "watch it happen" are the same code path, and a card printed a week later cannot disagree with the
 * panel that was on screen at the time.
 *
 * The argument goes through the same `resolveRunRef` as `resume`/`cancel`/`delete` (progress §0), so a
 * user can type the full slug, the 8-hex tail, or any unique prefix, and an ambiguous one is reported
 * with its candidates rather than resolved by guessing.
 */

import type { RunEvent } from "../../engine/types.ts"
import { collapse } from "../../progress/collapse.ts"
import { buildOutline } from "../../progress/outline.ts"
import { project } from "../../progress/project.ts"
import { render } from "../../progress/render.ts"
import { missingWorkflowProvenance, recordedWorkflowLoadFailure, workflowFailureLine } from "../failure-messages.ts"
import { runIdHash } from "../naming.ts"
import type { ProgressCtx } from "../progress-sink.ts"
import type { RunStore } from "../types.ts"
import { loadValidatedWorkflow } from "../workflow-preflight.ts"
import { type CommandCtx, resolveRunRef } from "./context.ts"

/** What `handleStatus` needs beyond the store. Bound in extension.ts, faked in a test. */
export interface StatusDeps {
	/** The run to show when no argument is given: whatever is executing right now (spec §7). */
	activeRunId(): string | undefined
	now?: () => Date
	/** The width the tree is drawn to. A notification is plain text, so nothing else can know it. */
	width?: number
}

export async function handleStatus(
	ctx: CommandCtx & ProgressCtx,
	store: RunStore,
	deps: StatusDeps,
	runRef: string | undefined,
): Promise<void> {
	const runId = runRef ? await resolveRunRef(ctx, store, runRef, "show") : deps.activeRunId()
	if (!runId) {
		if (runRef) return // unknown or ambiguous — already notified by resolveRunRef
		return void ctx.ui.notify("workflow: no run is executing; pass a run-id to show a recorded one.", "info")
	}

	const events = await store.loadEvents(runId)
	if (events.length === 0) return void ctx.ui.notify(`workflow: run "${runId}" has no recorded events.`, "error")

	const workflowFilePath = workflowFileOf(events)
	if (!workflowFilePath) {
		return void ctx.ui.notify(missingWorkflowProvenance(runId, "shown"), "error")
	}

	// The DEFINITION is what supplies the shape — the log alone knows only what happened, not what was
	// meant to (progress §3.4). A run whose file has since moved cannot be shown as a tree, and saying
	// so plainly beats rendering a plausible-looking partial one.
	const loaded = await loadValidatedWorkflow({ filePath: workflowFilePath, projectRoot: ctx.cwd })
	if (!loaded.ok) {
		ctx.ui.notify(
			recordedWorkflowLoadFailure({
				workflowName: workflowNameOf(events) ?? "unknown",
				runId,
				workflowFilePath,
				action: "show status",
				cause: loaded.cause,
			}),
			"error",
		)
		return
	}
	const workflow = loaded.workflow

	const view = project(buildOutline(workflow), events, (deps.now ?? (() => new Date()))())

	// The tree, unstyled: `notify` takes a string, so the theme is the host's business and there is no
	// width to discover — hence the explicit default. Unlike the live panel this is NOT collapsed by
	// §6.1's rule... it is, in fact, exactly the same `collapse`, because a finished run's folded
	// constructs are what makes a 40-step tree readable in a scrollback. `/workflow status` differs from
	// the panel in being unbounded and re-readable, not in showing different rows.
	const lines = render(view, collapse(view), { width: deps.width ?? 100, theme: PLAIN, runLabel: runIdHash(runId) })
	const failure =
		view.status === "crashed" && view.failureReason
			? workflowFailureLine({ path: view.failurePath, cause: view.failureReason })
			: undefined
	ctx.ui.notify(
		[`${workflowFilePath}`, failure, ...lines].filter((line): line is string => line !== undefined).join("\n"),
		view.status === "crashed" ? "error" : "info",
	)
}

/** No colour: a notification is plain text on every harness, so the theme is the identity. */
const PLAIN = { fg: (_colour: string, text: string) => text, bold: (text: string) => text }

function workflowFileOf(events: readonly RunEvent[]): string | undefined {
	return events.find((event) => event.type === "run-meta")?.workflowFilePath
}

function workflowNameOf(events: readonly RunEvent[]): string | undefined {
	return events.find((event): event is Extract<RunEvent, { type: "run-started" }> => event.type === "run-started")
		?.workflowName
}
