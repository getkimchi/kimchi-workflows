/**
 * The run summary (progress §7.6): what a run leaves behind when it ends, after the live panel clears.
 *
 * **Plain text through `ctx.ui.notify`, not a custom entry with a registered renderer.** The richer
 * option existed — `pi.appendEntry` + `pi.registerEntryRenderer` gives a durable, themed, expandable
 * card — and it cost the whole extension: `registerEntryRenderer` is absent from pi 0.80.2 and present
 * in 0.80.10, so calling it threw at LOAD time and `/workflow` stopped existing on the older binary.
 * Type-checking against the installed package says nothing about the binary that loads us.
 *
 * The reply to that is not to feature-detect the newer API; it is to not need it. `notify` takes
 * multi-line text on every harness this package targets, and `/workflow list` has always rendered its
 * catalog that way (commands/list.ts) — so this is the codebase's existing idiom, not a downgrade
 * invented under pressure. It also keeps §13.4's guarantee for free: a notification never enters LLM
 * context, so a workflow's own agent steps can never read their own progress report back as input.
 *
 * What is given up, honestly: no expand/collapse, no per-theme colour, and nothing persisted into the
 * session as a structured entry. The fully expanded tree was always reachable another way —
 * `/workflow status` (§11.4) — which is exactly why the live panel is free to collapse in the first
 * place. One shape for all five outcomes (§7.6): a run that succeeded is the one a user later wants the
 * duration and the token total of.
 */
import type { RunStatus } from "../engine/run-status.ts"
import { formatClock, formatTokens } from "../progress/render.ts"
import type { ProgressView } from "../progress/types.ts"

/** How a summary should be announced — `notify`'s own severity vocabulary. */
export type SummaryLevel = "info" | "warning" | "error"

/** Status glyph plus the severity it is announced at, in the same vocabulary as the tree (progress §4.4). */
const STATUS: Readonly<Record<RunStatus, readonly [string, SummaryLevel]>> = {
	completed: ["✓", "info"],
	crashed: ["✗", "error"],
	cancelled: ["■", "warning"],
	blocked: ["?", "info"],
	in_progress: ["…", "info"],
}

export interface RunSummaryText {
	readonly message: string
	readonly level: SummaryLevel
}

/**
 * Build the summary a finished run is announced with (§7.6).
 *
 * Unstyled by construction: `notify` takes a string, so there is no theme to apply and no width to
 * wrap to — the host draws it. That also makes this trivially testable, which the themed card was not.
 */
export function runSummaryText(view: ProgressView, runLabel: string, workflowFilePath?: string): RunSummaryText {
	const status = view.status ?? "in_progress"
	const [glyph, level] = STATUS[status]

	const facts = [
		`${view.stepsSettled} of ${view.stepsTotal} steps`,
		formatClock(view.elapsedMs ?? 0),
		view.tokens > 0 ? `${formatTokens(view.tokens)} tok` : undefined,
		runLabel,
	].filter((fact): fact is string => fact !== undefined)

	const lines = [`${glyph} workflow "${view.workflowName}" ${status} · ${facts.join(" · ")}`]
	// The failure reason is the one thing a crashed run is opened for, so it goes on its own line rather
	// than being truncated into the first one.
	if (status === "crashed" && view.failureReason) lines.push(`  ${view.failureReason}`)
	if (workflowFilePath) lines.push(`  ${workflowFilePath}`)
	// `/workflow status` is where the fully expanded tree lives (§11.4, §6.6) — say so, since the panel
	// that was showing it has just been cleared.
	lines.push(`  /workflow status ${runLabel} for the full tree`)

	return { message: lines.join("\n"), level }
}
