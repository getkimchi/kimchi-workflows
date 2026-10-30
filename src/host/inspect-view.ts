/**
 * The inspect view (inspection, specs/progress-ui.md §14): the pieces `/workflow inspect` renders with,
 * split from the command so the surface choices (overlay vs widget vs notification) share one pure
 * line assembly.
 *
 * The overlay is `ctx.ui.custom()` — the one PI surface with keyboard focus, so it is the one a live
 * transcript can be dismissed from (widgets never receive input, progress §6.6). It is reached only
 * behind a runtime feature check: the harness that loads the extension may be older than the package
 * type-checked against, and a cosmetic view must not be able to take the command down (the §7.6.1
 * lesson — `registerEntryRenderer` did exactly that on pi 0.80.2). Everywhere else the same lines go
 * out as a `string[]` widget (RPC) or a notification (post-hoc, headless).
 */

/** What one assembled inspect view holds — the command fills it, the surfaces draw it. */
export interface InspectLines {
	/** Header: workflow, run, step identity — composed by the command. */
	readonly header: readonly string[]
	/** The transcript (or the fallback facts) — already width-aware. */
	readonly body: readonly string[]
	/** Optional closing line: where the full transcript lives, how to close the view. */
	readonly footer?: string
}

/** Flatten one view to drawable lines, capping the total with a single summary line. */
export function inspectLines(view: InspectLines, maxLines?: number): string[] {
	const all = [...view.header, "", ...view.body, ...(view.footer ? ["", view.footer] : [])]
	if (maxLines !== undefined && all.length > maxLines) {
		const kept = all.slice(0, Math.max(0, maxLines - 1))
		return [...kept, `… +${all.length - kept.length} more lines`]
	}
	return all
}

/** The shape of the PI TUI component the overlay builds — structural so tests satisfy it with fakes. */
export interface OverlayComponent {
	render(width: number): string[]
	handleInput?(data: string): void
	invalidate(): void
	dispose?(): void
}

/** How the overlay decides a keypress closes it: Escape, or q. */
export function isDismissKey(
	data: string,
	matches: (data: string, keyId: string) => boolean = defaultMatches,
): boolean {
	return matches(data, "escape") || data === "q" || data === "Q"
}

/** The navigator's cursor keys: up/down arrows or k/j, matched through the harness keybindings. */
export function isUpKey(data: string, matches: (data: string, keyId: string) => boolean = defaultMatches): boolean {
	return matches(data, "up") || data === "k"
}

export function isDownKey(data: string, matches: (data: string, keyId: string) => boolean = defaultMatches): boolean {
	return matches(data, "down") || data === "j"
}

export function isEnterKey(data: string, matches: (data: string, keyId: string) => boolean = defaultMatches): boolean {
	return matches(data, "enter")
}

/** Whether `data` is the Escape key alone (the navigator's "go back" / close), via keybindings. */
export function isEscapeKey(data: string, matches: (data: string, keyId: string) => boolean = defaultMatches): boolean {
	return matches(data, "escape")
}

function defaultMatches(data: string, keyId: string): boolean {
	return data === keyId
}

/**
 * The live overlay component: draws {@link read} whenever PI renders, and closes itself through
 * {@link done} on a dismiss key. The command refreshes `read`'s backing state (re-reading the step's
 * transcript) on every activity event and calls {@link requestRender} — the component itself owns no
 * clock, no timers, and no file access, so a test drives it with two functions.
 */
export function inspectOverlay(args: {
	/** Freshly assembled lines at `width` — called per render, so the view never draws stale content. */
	read: (width: number) => string[]
	/** PI's render request — the signal that makes a refresh visible. */
	requestRender: () => void
	/** Keybinding matcher from the component factory (raw bytes in, key id match out). */
	matches?: (data: string, keyId: string) => boolean
	/** Closes the overlay. */
	done: () => void
}): OverlayComponent {
	return {
		render: (width: number) => args.read(width),
		handleInput: (data: string) => {
			if (isDismissKey(data, args.matches ?? defaultMatches)) args.done()
		},
		invalidate: () => {},
		dispose: () => {},
	}
}
