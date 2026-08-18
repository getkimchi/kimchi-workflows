/**
 * Shared plumbing for the `/workflow` command handlers: the narrowed context they run against, the
 * non-exclusive execution lifecycle, and the notification helpers they format results with.
 *
 * Everything here is UI- and lifecycle-shaped. The handlers themselves live in sibling modules and
 * depend only on this one, which keeps the command layer a flat, acyclic tree.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import type { AgentRequest, AgentSession, RunResult } from "../../engine/types.ts"
import type { ActiveRuns } from "../active-runs.ts"
import { workflowCrashMessage } from "../failure-messages.ts"
import { matchRunId } from "../naming.ts"
import type { RunStore } from "../types.ts"

/** How a command opens an agent session (spec §2.2), bound to the invoking context's model registry. */
export type StartAgent = (request: AgentRequest) => AgentSession

/**
 * The slice of the command context the handlers actually use. The registered handler still receives the
 * full `ExtensionCommandContext` (structurally compatible), but narrowing here documents the surface and
 * makes the handlers unit-testable with a small fake.
 */
export type CommandCtx = Pick<ExtensionCommandContext, "ui" | "cwd" | "mode" | "hasUI" | "modelRegistry">

/** The narrowest context a handler can take: enough to talk to the user, nothing more. */
export interface NotifyCtx {
	ui: Pick<CommandCtx["ui"], "notify">
}

export type Notify = CommandCtx["ui"]["notify"]

/**
 * Track one execution without imposing exclusivity: register its abort controller, run, report its
 * outcome to the optional telemetry observer, and unregister it on every exit. Registration never
 * checks what else is active, so separate executions of the same or different workflows may overlap.
 *
 * `store.observeResult` — present only when the store is the telemetry-decorated one
 * (`host/telemetry-bridge.ts`) — is handed the outcome on the way out. This is the one run state with no
 * event behind it: BLOCKING is the absence of a terminal event, so a bridge listening to the log alone
 * cannot see it. It travels on the store rather than as a seventh parameter because the store is already
 * the single object every execution's bookkeeping goes through here, and this is the only place every
 * `RunResult` in the process passes.
 */
export async function runTracked(
	activeRuns: ActiveRuns,
	runId: string,
	store: Pick<RunStore, "appendEvent"> & { observeResult?: (result: RunResult) => void },
	run: (signal: AbortSignal) => Promise<RunResult>,
): Promise<RunResult> {
	const execution = activeRuns.start(runId)
	try {
		const outcome = await run(execution.controller.signal)
		store.observeResult?.(outcome)
		return outcome
	} finally {
		activeRuns.finish(execution)
	}
}

/**
 * Turn a `resume`/`cancel`/`delete` argument into a run-id, or notify why it cannot be one and return
 * `undefined` (spec §6.2/§6.4/§6.5).
 *
 * Run-ids are slugs now (naming.ts), which are readable but long, so what the user types is matched the
 * way the harness matches its own session ids: exact first, then the short hash, then any unique prefix.
 * Several matches are reported WITH the candidates rather than resolved by picking one — two of these
 * three commands destroy state. `verb` completes "no run … to <verb>", so callers read as the user does.
 */
export async function resolveRunRef(
	ctx: NotifyCtx,
	store: Pick<RunStore, "list">,
	arg: string,
	verb: string,
): Promise<string | undefined> {
	const match = matchRunId(
		(await store.list()).map((run) => run.runId),
		arg,
	)
	if (match.kind === "ok") return match.runId
	if (match.kind === "ambiguous") {
		ctx.ui.notify(
			`workflow: "${arg}" matches ${match.candidates.length} runs (${match.candidates.join(", ")}); use a longer prefix or the full run-id.`,
			"warning",
		)
		return undefined
	}
	ctx.ui.notify(`workflow: no run "${arg}" to ${verb}.`, "error")
	return undefined
}

/**
 * Report a run's terminal (or blocked) outcome (spec §5.1), unless the progress card already did.
 *
 * Progress §7.8: the card REPLACES this notification wherever it lands, rather than sitting beside it —
 * two reports of one outcome is noise. It does not always land (§7.7: `appendEntry` needs a session,
 * and the entry only renders in the interactive TUI), and a run that went silent about its own result
 * would be a strictly worse outcome than a duplicate, so the fallback is unconditional.
 */
export function reportResult(ctx: NotifyCtx, workflowName: string, result: RunResult, reportedByCard: boolean): void {
	if (reportedByCard && result.status !== "blocked") return
	notifyResult(ctx, workflowName, result)
}

/** Report a run's terminal (or blocked) outcome to the user (spec §5.1). */
export function notifyResult(ctx: NotifyCtx, workflowName: string, result: RunResult): void {
	if (result.status === "completed") {
		ctx.ui.notify(`workflow "${workflowName}" completed (run ${result.runId}).`, "info")
	} else if (result.status === "cancelled") {
		ctx.ui.notify(`workflow "${workflowName}" cancelled (run ${result.runId}); resume to continue.`, "warning")
	} else if (result.status === "blocked") {
		ctx.ui.notify(`workflow "${workflowName}" blocked (run ${result.runId}) awaiting user input.`, "info")
	} else {
		ctx.ui.notify(
			workflowCrashMessage({
				workflowName,
				runId: result.runId,
				path: result.path,
				cause: result.error ?? "unknown error",
			}),
			"error",
		)
	}
}

export function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}
