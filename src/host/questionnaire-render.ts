/**
 * Host adapter — questionnaire render dispatcher (spec §10.2).
 *
 * Applies the capability gate: render the rich `ctx.ui.custom` form when a real terminal TUI is present,
 * otherwise fall back to native dialogs (which also work over RPC). The rich module is imported lazily
 * so RPC/offline never value-imports the terminal-only TUI widgets. Both paths return the same
 * structured answers object keyed by `question.key`, or `undefined` when the user dismisses (dismiss ≠
 * cancel — the caller keeps the run blocked).
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import type { Questionnaire } from "../flow/questionnaire.ts"
import { useRichForm } from "./answer-assembly.ts"
import { collectViaDialogs } from "./questionnaire-fallback.ts"

/** The slice of the command context the render paths need: the UI seam plus the mode/hasUI gate. */
export type RenderContext = Pick<ExtensionCommandContext, "ui" | "mode" | "hasUI">

export async function collectAnswers(
	ctx: RenderContext,
	questionnaire: Questionnaire,
): Promise<Record<string, unknown> | undefined> {
	if (useRichForm(ctx.mode, ctx.hasUI)) {
		const { renderRichForm } = await import("./questionnaire-form.ts")
		return renderRichForm(ctx, questionnaire)
	}
	return collectViaDialogs(ctx.ui, questionnaire)
}
