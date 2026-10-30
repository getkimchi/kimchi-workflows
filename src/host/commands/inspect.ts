/**
 * `/workflow inspect [run-ref] [step-path]` (inspection, specs/progress-ui.md §14) — the answer to
 * "what is this step actually DOING in there?".
 *
 * The panel answers "which step"; this answers what is inside it: the prompt the step was given, every
 * tool call and result, the assistant's text, and its per-turn cost — live, while the step runs, and
 * after the fact from the same file. Both execution modes read the same way because both leave the
 * same artifact: an isolated step's subprocess session file, or an in-session step's sidecar
 * (step-transcript.ts, one naming rule).
 *
 * Resolution mirrors `/workflow status` deliberately (resolveRunRef, the recorded-workflow loader, the
 * projection), so the two commands cannot disagree about which run or step a name means. A step that
 * left no transcript — a function step, a session that never started — falls back to the facts the
 * run log does hold: lifecycle, retries, steers, and the step's own `step-log` lines.
 */

import { statSync } from "node:fs"
import { formatPath, parsePath } from "../../engine/node-path.ts"
import type { RunEvent } from "../../engine/types.ts"
import type { StepDefinition, WorkflowDefinition, WorkflowNode } from "../../flow/types.ts"
import { buildOutline } from "../../progress/outline.ts"
import { project } from "../../progress/project.ts"
import type { ProgressNode } from "../../progress/types.ts"
import { missingWorkflowProvenance, recordedWorkflowLoadFailure } from "../failure-messages.ts"
import { showNavigator } from "../inspect-navigator.ts"
import { inspectLines, inspectOverlay, type OverlayComponent } from "../inspect-view.ts"
import { runIdHash } from "../naming.ts"
import type { ProgressCtx } from "../progress-sink.ts"
import { runArtifactsDir } from "../project-dir.ts"
import { projectRunEvents } from "../reconcile-runs.ts"
import { loadRecordedWorkflow, workflowSourceOf } from "../recorded-workflow.ts"
import { type ActivityBus, type StepActivity, terminalSafe } from "../step-activity.ts"
import { loadStepTranscript, renderStepTranscript, stepTranscriptFile } from "../step-transcript.ts"
import type { RunStore } from "../types.ts"
import { type CommandCtx, describe, resolveRunRef } from "./context.ts"

/** What `handleInspect` needs beyond the store. Bound in extension.ts, faked in a test. */
export interface InspectDeps {
	/** Locally executing runs — the live view needs the run's in-process activity bus. */
	readonly activeRunIds: () => readonly string[]
	readonly activityBus?: ActivityBus
	readonly now?: () => Date
	/** The width the view is drawn to when the surface cannot report one (a notification). */
	readonly width?: number
}

/** The TUI overlay's factory arguments — structural, so a test satisfies it with fakes. */
type CustomFactory = (
	tui: { requestRender(): void },
	theme: unknown,
	keybindings: { matches(data: string, binding: string): boolean },
	done: (result: unknown) => void,
) => OverlayComponent

/** A bound `ctx.ui.custom` — feature-detected at call time, never assumed present (§7.6.1's lesson). */
type ShowCustom = (factory: CustomFactory) => Promise<unknown>

/** How many lines a notification-bounded view keeps — a transcript that does not fit is pointed at, not truncated silently. */
const NOTIFY_MAX_LINES = 40

export async function handleInspect(
	ctx: CommandCtx & ProgressCtx,
	store: RunStore,
	deps: InspectDeps,
	runRef: string | undefined,
	stepPath: string | undefined,
): Promise<void> {
	// The run: exactly the resolution `status` performs — active run when unambiguous, else the ref.
	const activeRunIds = [...new Set(deps.activeRunIds())]
	let runId: string | undefined
	if (runRef) {
		runId = await resolveRunRef(ctx, store, runRef, "inspect")
	} else if (activeRunIds.length === 1) {
		runId = activeRunIds[0]
	} else if (activeRunIds.length > 1) {
		return void ctx.ui.notify(
			`workflow: ${activeRunIds.length} runs are executing (${activeRunIds.join(", ")}); pass a run-id to inspect one.`,
			"warning",
		)
	} else {
		return void ctx.ui.notify("workflow: no run is executing; pass a run-id to inspect a recorded one.", "info")
	}
	if (!runId) return

	const events = await projectRunEvents(store, runId, {
		isActive: (candidate) => activeRunIds.includes(candidate),
		now: deps.now,
	})
	if (events.length === 0) return void ctx.ui.notify(`workflow: run "${runId}" has no recorded events.`, "error")

	const workflowSource = workflowSourceOf(events)
	if (!workflowSource) return void ctx.ui.notify(missingWorkflowProvenance(runId, "shown"), "error")
	const workflowName =
		events.find((event): event is Extract<RunEvent, { type: "run-started" }> => event.type === "run-started")
			?.workflowName ?? "unknown"
	const loaded = await loadRecordedWorkflow({ source: workflowSource, projectRoot: ctx.cwd, identity: workflowName })
	if (!loaded.ok) {
		return void ctx.ui.notify(
			recordedWorkflowLoadFailure({
				workflowName,
				runId,
				workflowSource,
				action: "show status",
				cause: loaded.cause,
			}),
			"error",
		)
	}
	const workflow = loaded.workflow

	// Bare `/workflow inspect` on a live TUI run opens the NAVIGATOR (§14.9) — the panel's step list
	// as a focused, navigable overlay (the subagent-view shape; the pinned panel cannot take keys,
	// §6.6). Explicit run/path arguments keep today's direct behaviour, and so does every non-TUI mode.
	if (
		!runRef &&
		!stepPath &&
		activeRunIds.includes(runId) &&
		ctx.mode === "tui" &&
		typeof (ctx.ui as { custom?: unknown }).custom === "function"
	) {
		try {
			await showNavigator({
				ctx,
				store,
				deps,
				runId,
				workflow,
				initialEvents: events,
				stepFacts: (path, currentEvents) => {
					const facts = resolveResumeKey(stepByStaticPath(workflow, path), currentEvents, path)
					return {
						attempt: currentAttempt(currentEvents, path),
						...(facts.key ? { resumeKey: facts.key } : {}),
						dynamic: facts.dynamic,
					}
				},
			})
		} catch (error) {
			// A surface failure must not fail the command — the §7.6.1 lesson: degrade, never take /workflow down.
			ctx.ui.notify(`workflow: could not open the inspect view: ${describe(error)}`, "warning")
		}
		return
	}

	// The target step: the projection's own state decides, so the choice cannot disagree with the panel.
	const now = deps.now ?? (() => new Date())
	const view = project(buildOutline(workflow), events, now())
	const steps = collectViewSteps(view.nodes)
	const target = stepPath
		? matchStepPath(steps, stepPath, ctx)
		: singleRunningStep(steps, ctx, activeRunIds.includes(runId))
	if (!target) return

	const attempt = currentAttempt(events, target.path)
	const dir = runArtifactsDir(ctx.cwd, ctx.sessionManager.getSessionDir())
	const step = stepByStaticPath(workflow, target.path)
	const resumeKey = resolveResumeKey(step, events, target.path)
	const live = activeRunIds.includes(runId)

	// The transcript is re-read when activity ARRIVES, not when PI renders (design-003): the refresh
	// cadence is the bus's, and a render is pure assembly over what was already loaded — a chatty step
	// then pays one file read per event instead of one per frame. The read itself is change-gated on
	// the file's size: tool events between message appends poke at an unchanged file, and a `statSync`
	// is all they cost.
	const transcriptRef = {
		workflowName: workflow.name,
		runId,
		path: target.path,
		attempt,
		...(resumeKey.key ? { resumeKey: resumeKey.key } : {}),
	}
	const transcriptFile = stepTranscriptFile(dir, transcriptRef)
	let lastSize = sizeOf(transcriptFile)
	let transcriptState = loadStepTranscript({ dir, ...transcriptRef })
	const reload = (): void => {
		const size = sizeOf(transcriptFile)
		if (size === lastSize) return // nothing new landed — the poke was for an unchanged file
		lastSize = size
		transcriptState = loadStepTranscript({ dir, ...transcriptRef })
	}

	const assemble = (width: number): readonly string[] => {
		const header = [
			`workflow ${workflow.name} · run ${runIdHash(runId)}`,
			`step ${target.name} (${target.path}) · attempt ${attempt}${resumeKey.dynamic ? " · resume key dynamic" : ""}`,
		]
		const body =
			transcriptState.ok && transcriptState.entries.length > 0
				? renderStepTranscript(transcriptState.entries, { width })
				: liveBody(width)
		const footer = transcriptState.ok ? `transcript: ${transcriptState.file}` : undefined
		return [header, "", body, footer].flat().filter((line) => line !== undefined)
	}

	/** What a live step shows before its transcript has anything in it: the bus's ring is the earliest
	 * signal (the prompt's message_end may not have landed yet), and only then the log's facts. */
	const liveBody = (width: number): readonly string[] => {
		if (!live) return renderStepFacts(events, target.path, transcriptState.ok ? transcriptState.file : undefined)
		const recent = (deps.activityBus?.recent(runId) ?? []).filter((activity) => activity.path === target.path)
		if (recent.length > 0) return renderRecentActivity(recent, width)
		return renderStepFacts(events, target.path, transcriptState.ok ? transcriptState.file : undefined)
	}

	if (live && ctx.mode === "tui" && typeof (ctx.ui as { custom?: unknown }).custom === "function") {
		try {
			await showOverlay(ctx.ui.custom.bind(ctx.ui) as ShowCustom, deps, runId, assemble, reload)
		} catch (error) {
			// A surface failure must not fail the command — the §7.6.1 lesson: degrade, never take /workflow down.
			ctx.ui.notify(`workflow: could not open the inspect overlay: ${describe(error)}`, "warning")
		}
		return
	}
	if (live && ctx.mode === "rpc") {
		showWidget(ctx, deps, runId, assemble, reload)
		return
	}

	// Post-hoc (or a harness without `custom`): one bounded snapshot through `notify` — the same
	// shape `/workflow status` prints, with the transcript's file named for the full read.
	const width = deps.width ?? 100
	ctx.ui.notify(
		inspectLines({ header: [], body: assemble(width), footer: undefined }, NOTIFY_MAX_LINES).join("\n"),
		"info",
	)
}

// -- Step targeting ----------------------------------------------------------------------------------------

/** A step-shaped row of the projected tree — the addressing units inspect accepts. */
interface ViewStep {
	readonly name: string
	readonly path: string
	readonly state: ProgressNode["state"]
}

function collectViewSteps(nodes: readonly ProgressNode[], out: ViewStep[] = []): ViewStep[] {
	for (const node of nodes) {
		if (node.kind === "step" || node.kind === "foreach-item") {
			out.push({ name: node.name, path: node.path, state: node.state })
		}
		collectViewSteps(node.children, out)
	}
	return out
}

/** A path argument matches exactly, or as a prefix of deeper paths (`loop` matches `loop/test`). */
function matchStepPath(
	steps: readonly ViewStep[],
	arg: string,
	ctx: { ui: { notify: (m: string, t?: "info" | "warning" | "error") => void } },
): ViewStep | undefined {
	const exact = steps.filter((step) => step.path === arg)
	if (exact.length === 1) return exact[0]
	const prefixed = exact.length > 0 ? exact : steps.filter((step) => step.path.startsWith(`${arg}/`))
	if (prefixed.length === 1) return prefixed[0]
	if (prefixed.length > 1) {
		ctx.ui.notify(
			`workflow: "${arg}" matches ${prefixed.length} steps (${prefixed
				.map((step) => step.path)
				.slice(0, 5)
				.join(", ")}${prefixed.length > 5 ? ", …" : ""}); use a longer path.`,
			"warning",
		)
		return undefined
	}
	ctx.ui.notify(`workflow: no step "${arg}" in this run.`, "error")
	return undefined
}

function singleRunningStep(
	steps: readonly ViewStep[],
	ctx: { ui: { notify: (m: string, t?: "info" | "warning" | "error") => void } },
	live: boolean,
): ViewStep | undefined {
	const running = steps.filter((step) => step.state === "in_progress")
	if (running.length === 1) return running[0]
	if (running.length > 1) {
		ctx.ui.notify(
			`workflow: ${running.length} steps are executing (${running
				.map((step) => step.path)
				.slice(0, 5)
				.join(", ")}${running.length > 5 ? ", …" : ""}); pass a step path to inspect one.`,
			"warning",
		)
		return undefined
	}
	ctx.ui.notify(
		live
			? "workflow: nothing is executing right now; pass a step path to inspect a recorded one."
			: "workflow: this run is not executing; pass a step path to inspect a step.",
		"info",
	)
	return undefined
}

// -- Definition lookup + resume key -------------------------------------------------------------------------

/**
 * The dynamic path with every index dropped (`until-green#3/test` → `until-green/test`,
 * `batch@7/review` → `batch/review`) — the form the definition's own tree is keyed by.
 */
function definitionKeyOf(path: string): string {
	return formatPath(parsePath(path).map((segment) => ({ name: segment.name })))
}

/** Every step in a definition, keyed by its index-free path — the walker's accumulating helper. */
function collectDefinitionSteps(
	nodes: readonly WorkflowNode[],
	prefix: readonly string[],
	out: Map<string, StepDefinition>,
): void {
	for (const node of nodes) {
		switch (node.kind) {
			case "step":
				out.set([...prefix, node.step.name].join("/"), node.step)
				break
			case "branch":
				for (const arm of node.arms) collectDefinitionSteps(arm.body.nodes, [...prefix, node.name, arm.name], out)
				break
			case "loop":
			case "foreach":
				collectDefinitionSteps(node.body.nodes, [...prefix, node.name], out)
				break
			case "parallel":
				for (const arm of node.arms) out.set([...prefix, node.name, arm.name].join("/"), arm)
				break
			case "workflow":
				collectDefinitionSteps(node.workflow.nodes, [...prefix, node.name], out)
				break
		}
	}
}

function stepByStaticPath(workflow: WorkflowDefinition, path: string): StepDefinition | undefined {
	const steps = new Map<string, StepDefinition>()
	collectDefinitionSteps(workflow.nodes, [], steps)
	return steps.get(definitionKeyOf(path))
}

/** A resolved resume key: statically from the definition, or from a recorded steer/error when it isn't. */
function resolveResumeKey(
	step: StepDefinition | undefined,
	events: readonly RunEvent[],
	path: string,
): { key?: string; dynamic: boolean } {
	const resumable = step !== undefined && "resumable" in step ? step.resumable : undefined
	if (resumable === undefined || resumable === false) return { dynamic: false }
	if (resumable === true && step) return { key: step.name, dynamic: false }
	if (typeof resumable === "string") return { key: resumable, dynamic: false }
	// A function-form key does not exist until the step runs — but the log records the RESOLVED key on
	// any steer or error this path produced, which is strictly better than the static answer.
	for (let index = events.length - 1; index >= 0; index--) {
		const event = events[index]
		if (!event) continue
		if ((event.type === "agent-steer" || event.type === "agent-error") && event.path === path && event.resumeKey) {
			return { key: event.resumeKey, dynamic: false }
		}
	}
	return { dynamic: true } // honestly underivable: say so in the header rather than guess
}

/** The attempt this path is on or last completed: 1 plus the retries recorded for it. */
function currentAttempt(events: readonly RunEvent[], path: string): number {
	let attempt = 1
	for (const event of events) {
		if (event.type === "step-retry" && event.path === path) attempt = Math.max(attempt, event.attempt + 1)
	}
	return attempt
}

// -- The fallback facts --------------------------------------------------------------------------------------

/**
 * What the log alone knows about a step — the view for a step with no transcript (a function step, a
 * session that never opened), and the honest answer rather than an empty panel.
 */
/** Recent bus activity as view lines — the earliest live signal, before the transcript's first
 * message lands. The same 15-column shape renderStepTranscript draws, so the view does not reflow
 * when the transcript takes over; labels stripped (they are model-sourced) and lines bounded to
 * the view's width. */
function renderRecentActivity(activities: readonly StepActivity[], width: number): readonly string[] {
	const contentWidth = Math.max(20, width - 15)
	const line = (marker: string, label: string, content: string): string => {
		const truncated = content.length > contentWidth ? `${content.slice(0, contentWidth - 1)}…` : content
		return `  ${marker} ${terminalSafe(label).padEnd(9)}  ${truncated}`.replace(/\s+$/, "")
	}
	return activities.map((activity): string => {
		switch (activity.kind) {
			case "tool-start":
				return line("→", activity.toolName ?? "tool", activity.summary ?? "")
			case "tool-end":
				return line(activity.isError === true ? "←!" : "←", activity.toolName ?? "tool", activity.summary ?? "")
			case "assistant-text":
				return line("●", "text", activity.summary ?? "")
			case "notice":
				return line("!", "notice", activity.summary ?? "")
			default:
				return ""
		}
	})
}

/** A transcript file's current size, or −1 when it does not exist — the reload's change gate. */
function sizeOf(file: string): number {
	try {
		return statSync(file).size
	} catch {
		return -1
	}
}

function renderStepFacts(events: readonly RunEvent[], path: string, file: string | undefined): readonly string[] {
	const lines: string[] = []
	const seen = new Set<string>()
	for (const event of events) {
		if ("path" in event && event.path !== path) continue
		if (seen.has(event.type + String("attempt" in event ? event.attempt : ""))) continue
		switch (event.type) {
			case "step-started":
				lines.push("  ● started")
				break
			case "step-completed":
				lines.push("  ● completed")
				break
			case "step-failed":
				lines.push(`  ✗ failed · ${event.error}`)
				break
			case "step-cancelled":
				lines.push("  ■ cancelled")
				break
			case "step-retry":
				lines.push(`  ↻ retry ${event.attempt} · ${event.reason}`)
				break
			case "agent-steer":
				lines.push(`  → repair ${event.attempt} · ${event.violationKind}`)
				break
			case "agent-error":
				lines.push(`  ✗ agent error · ${event.kind}${event.terminal ? " · terminal" : ""}`)
				break
			case "agent-usage":
				lines.push(`  · ${event.totalTokens} tokens this turn`)
				break
			case "step-log":
				lines.push(`  ● ${event.level}  ${event.message}`)
				break
			default:
				break
		}
	}
	if (lines.length === 0) lines.push("  ○ no recorded activity")
	if (file) lines.push(`  (no transcript at ${file})`)
	return lines
}

// -- Surfaces -------------------------------------------------------------------------------------------------

/** The live TUI overlay: refreshed on every activity event, closed with Escape or q. */
async function showOverlay(
	showCustom: ShowCustom,
	deps: InspectDeps,
	runId: string,
	assemble: (width: number) => readonly string[],
	reload: () => void,
): Promise<void> {
	let requestRender: (() => void) | undefined
	const unsubscribe = deps.activityBus?.subscribe(runId, () => {
		// The bus event is the poke: re-read the transcript file (the source of truth) and ask PI to
		// redraw — the render itself never touches the filesystem (design-003).
		reload()
		requestRender?.()
	})
	try {
		await showCustom((tui, _theme, keybindings, done) => {
			requestRender = () => tui.requestRender()
			return inspectOverlay({
				read: (width: number) => [...assemble(width)],
				requestRender: () => requestRender?.(),
				matches: (data, binding) => keybindings.matches(data, binding),
				done: () => done(undefined),
			})
		})
	} finally {
		unsubscribe?.()
	}
}

/** The RPC surface: the same lines as a `string[]` widget, re-pushed per activity event. */
function showWidget(
	ctx: CommandCtx & ProgressCtx,
	deps: InspectDeps,
	runId: string,
	assemble: (width: number) => readonly string[],
	reload: () => void,
): void {
	const width = deps.width ?? 100
	// One live widget at a time: a new invocation replaces the previous one's subscription rather
	// than stacking listeners — the command has no lifecycle hook of its own to unsubscribe on.
	rpcRefresh?.unsubscribe()
	const push = (): void => {
		reload()
		ctx.ui.setWidget(INSPECT_WIDGET_KEY, [...assemble(width)], { placement: "aboveEditor" })
	}
	push()
	rpcRefresh = { unsubscribe: deps.activityBus?.subscribe(runId, push) ?? (() => {}) }
}

/** The inspect widget's key — a second slot beside the progress panel's own (multi-widget is keyed). */
export const INSPECT_WIDGET_KEY = "pi-workflows:inspect"

let rpcRefresh: { unsubscribe: () => void } | undefined
