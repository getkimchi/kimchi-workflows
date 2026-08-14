/**
 * The sink (progress §1, §2.3): the one impure thing in the whole feature. It tees the engine's event
 * stream into a projection and pushes the result at whichever surface this invocation actually has.
 *
 * Three decisions carry it, and none of them is about how the panel looks:
 *
 *  - **It tees `emit`; it never replaces it** (§2.3). `createHostPort` persists FIRST and renders
 *    second, so a rendering failure can never lose an event.
 *  - **It is best-effort and self-disabling** (§2.3). Everything is caught, and on the first throw it
 *    disables itself for the rest of the run after one warning. Progress is a convenience; a run must
 *    not die because a terminal could not draw a box. This is not defensive programming for its own
 *    sake — the sink runs inside `emit`, which the engine awaits, so an exception here would propagate
 *    into the step that emitted the event and fail work that had already succeeded.
 *  - **Durable rendering state is re-projected, never mutated** (§2.4). The accumulated `RunEvent[]` is
 *    re-projected each time, which makes the live widget, a resumed run, and the terminal card the same
 *    function of the same history. Monotonic time since that projection and the current turn's usage
 *    preview are explicitly transient inputs: neither can contaminate replay or a final summary.
 *
 * The surface is chosen by `ctx.mode`, not by `hasUI` (§7.2) — see progress-widget.ts for why those
 * two disagree exactly where it matters.
 */
import type { ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import type { RunEvent, RunUpdate } from "../engine/types.ts"
import type { WorkflowDefinition } from "../flow/types.ts"
import { buildOutline } from "../progress/outline.ts"
import { project } from "../progress/project.ts"
import type { Outline, ProgressView } from "../progress/types.ts"
import { withUsagePreviews } from "../progress/usage-preview.ts"
import { runIdHash } from "./naming.ts"
import { runSummaryText } from "./progress-card.ts"
import { createPlainProgress, type LineWriter } from "./progress-plain.ts"
import { createRpcSurface, createTuiSurface, type ProgressSurface, workingMessage } from "./progress-widget.ts"

/** Progress §11.2: the escape hatch for scripted environments that want the old silence. */
export const PROGRESS_OFF_ENV = "PI_WORKFLOWS_PROGRESS"

/** `"tui" | "rpc" | "json" | "print"` — the matrix progress §7.2 dispatches on. Not exported by name from PI. */
export type ProgressMode = ExtensionCommandContext["mode"]

/** The slice of the command context the sink reads. Narrow enough that a test's fake is a literal. */
export interface ProgressCtx {
	readonly mode: ProgressMode
	readonly ui: Pick<ExtensionUIContext, "notify" | "setWidget" | "setWorkingMessage">
	/** `getSessionDir()` is `""` under `--no-session` — which is why the card is best-effort (§7.7). */
	readonly sessionManager: { getSessionDir(): string }
}

export interface ProgressSinkOptions {
	readonly ctx: ProgressCtx
	readonly outline: Outline
	/** The run's short form for the panel header (`runIdHash`, naming.ts) — this layer owns that shape. */
	readonly runLabel: string
	/** `run-meta`'s path (spec §8.9), for the card's provenance line. */
	readonly workflowFilePath?: string
	/** Injected so a test can freeze it; the pure layer takes `now` as a parameter for the same reason. */
	readonly now?: () => Date
	/** Monotonic frame clock. Separate from wall time so system-clock changes cannot move a live duration. */
	readonly monotonicNow?: () => number
	/** Where headless lines go. Default stderr — NEVER stdout (§8.2). */
	readonly write?: LineWriter
	readonly env?: Record<string, string | undefined>
}

export interface ProgressSink {
	/** Tee one event. Never throws: a broken surface disables itself instead (§2.3). */
	accept(event: RunEvent): void
	/** Apply a non-durable update such as the current turn's cumulative usage. Never throws. */
	update(update: RunUpdate): void
	/** Seed from a log loaded off disk, so a resumed run opens showing its history (§9.1). */
	seed(events: readonly RunEvent[]): void
	/** Whether the run's outcome has already been reported by a card, so `notify` should not repeat it (§7.8). */
	reportedOutcome(): boolean
	/** Clear the live surface. Safe to call more than once. */
	dispose(): void
}

/** The complete progress attachment for a host port—kept together so an execution path cannot omit live updates. */
export function progressCallbacks(progress: ProgressSink): {
	readonly onEvent: (event: RunEvent) => void
	readonly onUpdate: (update: RunUpdate) => void
} {
	return { onEvent: progress.accept, onUpdate: progress.update }
}

/** A run-level terminal event — where the widget clears and the card lands (§7.1, §7.6). */
function isTerminal(event: RunEvent): boolean {
	return event.type === "run-completed" || event.type === "run-crashed" || event.type === "run-cancelled"
}

/**
 * Build the sink for one command invocation. Returns a no-op sink when progress is switched off
 * (§11.2) — a disabled feature should cost nothing, not merely render nothing.
 */
export function createProgressSink(options: ProgressSinkOptions): ProgressSink {
	const { ctx, outline, runLabel } = options
	const env = options.env ?? process.env
	if (env[PROGRESS_OFF_ENV] === "off") return inertSink()

	const now = options.now ?? (() => new Date())
	const monotonicNow = options.monotonicNow ?? (() => performance.now())
	const events: RunEvent[] = []
	const usageByPath = new Map<string, number>()

	// `json`/`print` have no UI at all (§7.2's third row): plain lines on stderr, and nothing else.
	const headless = ctx.mode === "json" || ctx.mode === "print"
	const plain = headless ? createPlainProgress(outline, options.write ?? writeStderr) : undefined
	const surface = headless ? undefined : chooseSurface(ctx, runLabel, monotonicNow)

	let disabled = false
	let carded = false

	// One warning, then silence for the rest of the run: a surface that throws once will throw on every
	// event, and a hundred identical warnings would be worse than the missing panel.
	const disable = (err: unknown): void => {
		disabled = true
		try {
			surface?.clear()
			ctx.ui.notify(
				`workflow: progress display disabled after an error (${err instanceof Error ? err.message : String(err)}); the run is unaffected.`,
				"warning",
			)
		} catch {
			// Even the apology is best-effort.
		}
	}

	const draw = (terminal: boolean): void => {
		if (plain) return // headless already wrote its line per event; there is nothing to redraw (§8.3)
		const projected = project(outline, events, now())
		// A terminal summary is durable history only. Normally the engine has already settled or cleared
		// every preview; ignoring the map here also protects the summary from a misbehaving host adapter.
		const view = terminal ? projected : withUsagePreviews(projected, usageByPath)
		if (!terminal) {
			surface?.update({ view, observedAtMs: monotonicNow() }, workingMessage(view))
			return
		}
		surface?.clear()
		carded = announce(options, view) || carded
	}

	return {
		accept(event: RunEvent): void {
			if (disabled) return
			try {
				events.push(event)
				// The durable final turn usage supersedes its preview. Delete before drawing so the handoff is
				// one logical update and can never count the same turn twice.
				if (event.type === "agent-usage") usageByPath.delete(event.path)
				plain?.accept(event)
				draw(isTerminal(event))
			} catch (err) {
				disable(err)
			}
		},

		update(update: RunUpdate): void {
			if (disabled || plain) return
			try {
				if (update.type === "agent-usage-preview") {
					if (update.totalTokens <= 0 || usageByPath.get(update.path) === update.totalTokens) return
					usageByPath.set(update.path, update.totalTokens)
				} else if (!usageByPath.delete(update.path)) {
					return
				}
				draw(false)
			} catch (err) {
				disable(err)
			}
		},

		seed(prior: readonly RunEvent[]): void {
			if (disabled) return
			try {
				// History only — no plain lines, since those are a transition log and these transitions are
				// already in whatever CI output the original run produced (§8.3's append-only rule).
				events.push(...prior)
				if (!plain && events.length > 0) draw(false)
			} catch (err) {
				disable(err)
			}
		},

		reportedOutcome(): boolean {
			return carded
		},

		dispose(): void {
			usageByPath.clear()
			try {
				surface?.clear()
			} catch {
				// Nothing useful to do; the command is finishing either way.
			}
		},
	}
}

/**
 * Announce the finished run, and report that it was announced (§7.6, §7.8).
 *
 * Always lands: a notification needs no session, no renderer, and no particular harness version, which
 * is the entire reason the summary is text rather than a custom entry (progress-card.ts). Headless modes
 * never reach here — they have already written their own last line (§8.1).
 */
function announce(options: ProgressSinkOptions, view: ProgressView): boolean {
	const { message, level } = runSummaryText(view, options.runLabel, options.workflowFilePath)
	options.ctx.ui.notify(message, level)
	return true
}

/** Progress §7.2's first two rows: `rpc` cannot take a component factory, `tui` is the only one that can. */
function chooseSurface(ctx: ProgressCtx, runLabel: string, monotonicNow: () => number): ProgressSurface {
	return ctx.mode === "rpc" ? createRpcSurface(ctx.ui, runLabel) : createTuiSurface(ctx.ui, runLabel, monotonicNow)
}

function writeStderr(line: string): void {
	process.stderr.write(`${line}\n`)
}

function inertSink(): ProgressSink {
	return { accept: () => {}, update: () => {}, seed: () => {}, reportedOutcome: () => false, dispose: () => {} }
}

/**
 * How a command handler asks for a sink without knowing what a sink needs.
 *
 * The alternative — threading the surface choice through `handleRun`/`handleResume`/
 * `handleAttendedQuestionnaire` — would push rendering into three signatures that currently take the
 * narrowest context they can (see commands/context.ts's `CommandCtx`). A bound factory keeps that where
 * it belongs, and makes a test's substitute one line.
 */
export type ProgressFor = (workflow: WorkflowDefinition, runId: string, workflowFilePath?: string) => ProgressSink

/** Bind a factory to one invocation's context. Called once per `/workflow` command, in extension.ts. */
export function bindProgress(
	ctx: ProgressCtx,
	overrides: Pick<ProgressSinkOptions, "now" | "monotonicNow" | "write" | "env"> = {},
): ProgressFor {
	return (workflow, runId, workflowFilePath) =>
		createProgressSink({
			ctx,
			outline: buildOutline(workflow),
			runLabel: runIdHash(runId),
			workflowFilePath,
			...overrides,
		})
}

/** The factory a caller uses when it wants no progress at all — the default in every handler signature. */
export const noProgressFor: ProgressFor = () => inertSink()

/** A sink that does nothing, for handlers called without one. */
export const inertProgress: ProgressSink = inertSink()
