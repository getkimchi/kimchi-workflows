/**
 * The live surface (progress §7): one widget, keyed `pi-workflows:progress`, above the editor.
 *
 * **The surface is chosen by `ctx.mode`, not by `hasUI`** (§7.2) — the two disagree exactly where it
 * matters. RPC has a UI and no frame clock: `setWidget` carries `widgetLines: string[]` over the wire,
 * a component factory cannot cross that boundary, and there is no `requestRender` on the far side to
 * drive an animation. So RPC gets the same tree, redrawn only when an event moves it, which is the
 * honest thing to show a client that cannot animate. Handing it a factory would not degrade; it would
 * fail.
 *
 * **The TUI surface owns one timer, and only while work is in flight** (§7.3). 120 ms advances the
 * spinner and asks for a re-render; it starts when the projection first reports an `in_progress` node
 * and stops the moment none remains — including while `blocked`, which may last hours and must not wake
 * the TUI at all. That is also why the pure renderer takes its frame as a parameter (progress §4.8):
 * the only thing this timer does is count, and between whole seconds the render it triggers is
 * byte-identical, so a diffing TUI redraws nothing.
 *
 * Everything about how the panel LOOKS lives in `src/progress` and nothing about it is decided here.
 */
import type { ExtensionUIContext, WidgetPlacement } from "@earendil-works/pi-coding-agent"
import { collapse } from "../progress/collapse.ts"
import { render } from "../progress/render.ts"
import type { ProgressNode, ProgressTheme, ProgressView } from "../progress/types.ts"

/** The widget key (progress §7.1). One executing run per project (spec §7) means one widget, never a set. */
export const PROGRESS_WIDGET_KEY = "pi-workflows:progress"

const PLACEMENT: WidgetPlacement = "aboveEditor"

/** Progress §4.8/§7.3: the spinner's tick, and the only recurring work this feature does. */
const SPINNER_INTERVAL_MS = 120

/** RPC has no terminal width to report, so the tree is drawn to a conventional one. */
const RPC_WIDTH = 80

/** RPC carries plain lines over the wire; ANSI would be the client's decision to make, not ours. */
const UNSTYLED: ProgressTheme = { fg: (_colour, text) => text, bold: (text) => text }

/** The slice of PI's UI a surface touches. Narrow on purpose: a fake in a test is three functions. */
export type WidgetUI = Pick<ExtensionUIContext, "setWidget" | "setWorkingMessage">

/** Somewhere a projection can be pushed. The sink holds one and never asks which kind it is. */
export interface ProgressSurface {
	/** Draw `view`. `working` names the current step for the harness's own working indicator (§7.4). */
	update(view: ProgressView, working: string | undefined): void
	/** Remove the widget and stop anything recurring. Idempotent. */
	clear(): void
}

/**
 * The interactive surface: a component factory, a live theme, and the spinner timer.
 *
 * The factory is installed ONCE and then fed by mutation — `setWidget` on every event would hand PI a
 * new component each time, discarding the one holding the timer and leaking an interval per event.
 */
export function createTuiSurface(ui: WidgetUI, runLabel: string): ProgressSurface {
	let view: ProgressView | undefined
	let frame = 0
	let installed = false
	let timer: ReturnType<typeof setInterval> | undefined
	let requestRender: (() => void) | undefined

	const stop = (): void => {
		if (timer) clearInterval(timer)
		timer = undefined
	}

	// Start on the first in-flight node, stop the moment there is none — `blocked` included (§7.3).
	const syncTimer = (): void => {
		const busy = view !== undefined && hasWorkInFlight(view)
		if (!busy || requestRender === undefined) return void stop()
		if (timer) return
		timer = setInterval(() => {
			frame += 1
			requestRender?.()
		}, SPINNER_INTERVAL_MS)
		// A run is not the only thing in the process; never hold the event loop open for a spinner.
		timer.unref?.()
	}

	return {
		update(next: ProgressView, working: string | undefined): void {
			view = next
			if (!installed) {
				ui.setWidget(
					PROGRESS_WIDGET_KEY,
					(tui, theme) => {
						requestRender = () => tui.requestRender()
						syncTimer()
						return {
							render: (width: number) => (view ? render(view, collapse(view), { width, theme, frame, runLabel }) : []),
							invalidate: () => {},
							dispose: stop,
						}
					},
					{ placement: PLACEMENT },
				)
				// Recorded only once the call RETURNED: a surface that threw was never installed, so `clear()`
				// must not poke it again on the way out (progress §2.3's self-disable path does exactly that).
				installed = true
			}
			syncTimer()
			requestRender?.()
			// TUI only (§7.4) — a documented no-op in RPC, and it puts the step name where PI already draws
			// the user's eye during a turn.
			ui.setWorkingMessage(working)
		},

		clear(): void {
			stop()
			requestRender = undefined
			if (installed) ui.setWidget(PROGRESS_WIDGET_KEY, undefined)
			installed = false
			ui.setWorkingMessage()
		},
	}
}

/**
 * The RPC surface: the same tree as `string[]`, re-pushed per event. No factory (it cannot cross the
 * wire) and no timer (there is no `requestRender` on the far side to drive one), so the spinner never
 * advances — an honest still frame rather than an animation nobody would see.
 */
export function createRpcSurface(ui: WidgetUI, runLabel: string): ProgressSurface {
	let installed = false
	return {
		update(view: ProgressView): void {
			ui.setWidget(PROGRESS_WIDGET_KEY, render(view, collapse(view), { width: RPC_WIDTH, theme: UNSTYLED, runLabel }), {
				placement: PLACEMENT,
			})
			installed = true // only once the push landed — see the TUI surface's note
		},
		clear(): void {
			if (installed) ui.setWidget(PROGRESS_WIDGET_KEY, undefined)
			installed = false
		},
	}
}

/**
 * Whether anything is executing right now — the timer's whole start/stop condition (§7.3).
 *
 * Deliberately generous: ANY node reading `in_progress` counts, construct or leaf. Being briefly
 * awake with nothing to animate costs one wasted tick; being asleep while a spinner should be turning
 * is the panel freezing in front of the user, which is the failure this feature exists to prevent.
 */
export function hasWorkInFlight(view: ProgressView): boolean {
	const any = (nodes: readonly ProgressNode[]): boolean =>
		nodes.some((node) => node.state === "in_progress" || any(node.children))
	return any(view.nodes)
}

/**
 * `workflow: test (2 of 5)` — what `setWorkingMessage` says while a run is live (§7.4). `undefined`
 * once nothing is executing, which restores PI's own message.
 */
export function workingMessage(view: ProgressView): string | undefined {
	const running = firstRunningLeaf(view.nodes)
	if (!running) return undefined
	return `workflow: ${running} (${view.stepsSettled} of ${view.stepsTotal})`
}

function firstRunningLeaf(nodes: readonly ProgressNode[]): string | undefined {
	for (const node of nodes) {
		if (node.state !== "in_progress") continue
		const deeper = firstRunningLeaf(node.children)
		if (deeper) return deeper
		if (node.children.length === 0) return node.name
	}
	return undefined
}
