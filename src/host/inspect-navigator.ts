/**
 * The interactive run view (inspection, specs/progress-ui.md §14.9): what bare `/workflow inspect`
 * opens on a live TUI run — the panel's step list as a NAVIGABLE, focused overlay.
 *
 * The pinned panel cannot take keys (§6.6 — PI widgets get no keyboard input), which is why its
 * collapse had to be automatic. This surface is the other half of that trade: `ctx.ui.custom()` gives
 * a component real keyboard focus, so the tree can be walked and any step's transcript opened — the
 * subagent-view shape. The list is the SAME projection the panel draws (§2.4's one function), kept
 * live by the activity bus's pokes plus a one-second poll, so it settles steps and moves on exactly
 * like the panel does.
 *
 * Selection follows the run's current step until the user moves it (the "follow until touched"
 * decision): a cursor you placed stays where you put it while the world underneath keeps updating.
 */
import type { RunEvent } from "../engine/types.ts"
import type { WorkflowDefinition } from "../flow/types.ts"
import { buildOutline } from "../progress/outline.ts"
import { project } from "../progress/project.ts"
import type { ProgressNode } from "../progress/types.ts"
import type { InspectDeps } from "./commands/inspect.ts"
import { isDownKey, isEnterKey, isEscapeKey, isUpKey } from "./inspect-view.ts"
import { runIdHash } from "./naming.ts"
import { runArtifactsDir } from "./project-dir.ts"
import { projectRunEvents } from "./reconcile-runs.ts"
import {
	loadStepTranscript,
	renderStepSummary,
	renderStepTranscript,
	type StepTranscriptLoad,
} from "./step-transcript.ts"
import type { RunStore } from "./types.ts"

/** The slice of the command context the navigator needs — narrow enough for a fake in a test. */
export interface NavigatorCtx {
	readonly cwd: string
	readonly sessionManager: { getSessionDir(): string }
	readonly ui: { custom(factory: unknown, options?: unknown): Promise<unknown> }
}

/** What the command knows about a step that the navigator cannot derive on its own. */
/** What the command knows about a step that the navigator cannot derive on its own — computed
 * against the navigator's CURRENT events, so facts stay true across retries mid-view. */
export type StepFacts = (
	path: string,
	events: readonly RunEvent[],
) => { attempt: number; resumeKey?: string; dynamic: boolean }

/** One drawable row of the navigator's list: every projected node, steps selectable. */
export interface ViewRow {
	readonly name: string
	readonly path: string
	readonly state: ProgressNode["state"]
	readonly kind: ProgressNode["kind"]
	readonly depth: number
	readonly selectable: boolean
}

/** The projected nodes in declaration order, depth-annotated — the panel's tree, as rows. */
export function collectViewRows(nodes: readonly ProgressNode[], depth = 0, out: ViewRow[] = []): ViewRow[] {
	for (const node of nodes) {
		out.push({
			name: node.name,
			path: node.path,
			state: node.state,
			kind: node.kind,
			depth,
			selectable: node.kind === "step" || node.kind === "foreach-item",
		})
		collectViewRows(node.children, depth + 1, out)
	}
	return out
}

/** Static per-state glyphs — the list has no frame clock, so in-progress is a steady ●. */
const ROW_GLYPHS: Readonly<Record<ProgressNode["state"], string>> = {
	todo: "○",
	in_progress: "●",
	blocked: "?",
	completed: "✓",
	skipped: "⊘",
	cancelled: "■",
	crashed: "✗",
}

/** A construct row's glyph: structural, never selectable, so never the run's state. */
const CONSTRUCT_GLYPH = "▸"

/** The one-second refresh poll: catches everything that emits no activity (function steps, the run ending). */
const POLL_INTERVAL_MS = 1_000

/** A focused component as PI sees it — structural, so a test satisfies it with fakes. */
interface FocusedComponent {
	render(width: number): string[]
	handleInput?(data: string): void
	invalidate(): void
	dispose?(): void
}

/**
 * Open the navigator. Resolves when the user closes it (Escape from the list). Re-throws surface
 * failures for the caller's own notify path — the §7.6.1 lesson: degrade, never take /workflow down.
 */
export async function showNavigator(args: {
	readonly ctx: NavigatorCtx
	readonly store: RunStore
	readonly deps: InspectDeps
	readonly runId: string
	readonly workflow: WorkflowDefinition
	readonly initialEvents: readonly RunEvent[]
	readonly stepFacts: StepFacts
}): Promise<void> {
	const { ctx, store, deps, runId, workflow, stepFacts } = args
	const outline = buildOutline(workflow)
	const now = deps.now ?? (() => new Date())
	const dir = runArtifactsDir(ctx.cwd, ctx.sessionManager.getSessionDir())

	// -- Everything render() reads, mutated only by refresh() and handleInput.
	let events: readonly RunEvent[] = args.initialEvents
	let rows: readonly ViewRow[] = []
	let selected = -1 // index into `rows`, always a selectable row while the list is non-empty
	let touched = false // set by the first manual move: after that, the selection is the user's
	let mode: "list" | "transcript" = "list"
	let detail = false // the step view starts COMPACT (§14.11); Enter drills down, per step
	let transcript: StepTranscriptLoad | undefined
	let closed = false
	let requestRender: (() => void) | undefined
	let refreshChain: Promise<void> = Promise.resolve()

	const selectables = (): readonly number[] => rows.flatMap((row, index) => (row.selectable ? [index] : []))

	const selectedRow = (): ViewRow | undefined => rows[selected]

	/** Re-point the cursor at the run's current step — only while the user has not moved it. */
	const follow = (): void => {
		if (touched) return
		const running = rows.findIndex((row) => row.selectable && row.state === "in_progress")
		if (running >= 0) selected = running
		else if (selected < 0) selected = selectables()[0] ?? -1
	}

	const reloadTranscript = (): void => {
		const row = selectedRow()
		if (!row) return
		const facts = stepFacts(row.path, events)
		transcript = loadStepTranscript({
			dir,
			workflowName: workflow.name,
			runId,
			path: row.path,
			attempt: facts.attempt,
			...(facts.resumeKey ? { resumeKey: facts.resumeKey } : {}),
		})
	}

	/** Reload the list from the log, and the open transcript pane when there is one. */
	const refresh = async (): Promise<void> => {
		if (closed) return
		events = await projectRunEvents(store, runId, {
			isActive: (candidate) => [...deps.activeRunIds()].includes(candidate),
			now: deps.now,
		})
		rows = collectViewRows(project(outline, events, now()).nodes)
		follow()
		if (mode === "transcript") reloadTranscript()
		requestRender?.()
	}

	// Refreshes are chained, never concurrent — a slow read cannot reorder the list under the cursor.
	const pokeRefresh = (): Promise<void> => {
		refreshChain = refreshChain
			.then(() => refresh())
			.catch(() => {
				// A failed refresh leaves the last good list on screen; the next poke retries.
			})
		return refreshChain
	}

	const unsubscribe = deps.activityBus?.subscribe(runId, () => void pokeRefresh())
	const poll = setInterval(() => void pokeRefresh(), POLL_INTERVAL_MS)
	poll.unref?.()

	const move = (delta: number): void => {
		const order = selectables()
		if (order.length === 0) return
		const current = order.indexOf(selected)
		const next = Math.min(order.length - 1, Math.max(0, (current === -1 ? 0 : current) + delta))
		const target = order[next]
		if (target !== undefined && target !== selected) {
			selected = target
			touched = true // the selection is the user's now — no more following
			requestRender?.()
		}
	}

	const enterTranscript = (): void => {
		if (selected < 0) return
		mode = "transcript"
		detail = false
		reloadTranscript()
		requestRender?.()
	}

	const listPane = (): string[] => {
		const view = project(outline, events, now())
		const lines = [
			"",
			`  ${view.workflowName} · run ${runIdHash(runId)} · ${view.stepsSettled} of ${view.stepsTotal}`,
			"  ↑↓/jk move · enter inspect · esc close",
			"",
		]
		for (const [index, row] of rows.entries()) {
			const glyph = row.selectable ? (ROW_GLYPHS[row.state] as string) : CONSTRUCT_GLYPH
			const cursor = index === selected ? "❯ " : "  "
			lines.push(`${cursor}${"  ".repeat(row.depth)}${glyph} ${row.name}`)
		}
		return lines
	}

	const transcriptPane = (width: number): string[] => {
		const row = selectedRow()
		if (!row || !transcript) return ["", "  (no step selected)"]
		const facts = stepFacts(row.path, events)
		const header = [
			`  step ${row.name} (${row.path}) · attempt ${facts.attempt}${facts.dynamic ? " · resume key dynamic" : ""}`,
			`  ${detail ? "enter: summary" : "enter: full detail"} · esc back · transcript: ${transcript.ok ? transcript.file : "none recorded"}`,
			"",
		]
		const body =
			transcript.ok && transcript.entries.length > 0
				? detail
					? renderStepTranscript(transcript.entries, { width: Math.max(20, width - 2), bounded: true })
					: renderStepSummary(transcript.entries, { width: Math.max(20, width - 2) })
				: ["  (no transcript recorded for this execution)"]
		return [...header, ...body]
	}

	try {
		await pokeRefresh() // the first fill happens before the first render
		await ctx.ui.custom(
			(
				tui: { requestRender(): void },
				_theme: unknown,
				keybindings: { matches(data: string, binding: string): boolean },
				done: (result: unknown) => void,
			): FocusedComponent => {
				requestRender = () => tui.requestRender()
				// `matches` is a method on the harness's Keybindings instance: pass the BARE function on and
				// its receiver is gone (`this.keysById` is then undefined and every keypress crashes — the
				// crash report that found this). An arrow wrapper keeps the receiver; a harness without
				// `matches` at all means "not bound", and the helpers fall back to comparing raw bytes.
				const matches =
					typeof keybindings.matches === "function"
						? (data: string, binding: string) => keybindings.matches(data, binding)
						: undefined
				return {
					render: (width: number): string[] => (mode === "transcript" ? transcriptPane(width) : listPane()),
					handleInput: (data: string): void => {
						if (mode === "list") {
							if (isUpKey(data, matches)) move(-1)
							else if (isDownKey(data, matches)) move(1)
							else if (isEnterKey(data, matches)) enterTranscript()
							else if (isEscapeKey(data, matches)) done(undefined)
						} else if (isEnterKey(data, matches)) {
							detail = !detail // the drill-down toggle — the pane header restates the keys
							requestRender?.()
						} else if (isEscapeKey(data, matches)) {
							mode = "list" // back to the list, not out of the view
							requestRender?.()
						}
					},
					invalidate: () => {},
					dispose: () => {},
				}
			},
		)
	} finally {
		closed = true
		unsubscribe?.()
		clearInterval(poll)
	}
}
