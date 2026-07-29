/**
 * The panel (progress §4): collapsed rows, a width and a theme, in; plain lines out.
 *
 * The panel is one composed object, not a list of printed lines, and three ideas carry it:
 *
 *  - **One alignment grid** (§4.2). Every row is `gutter · connectors · glyph · name · … · metadata`,
 *    and the metadata block sits at a single offset computed once per render from the widest row. A
 *    ragged right edge is the main thing that makes terminal output look thrown together, and
 *    alignment is what makes a tree scannable at all.
 *  - **Weight instead of a palette** (§4.5). At most three colours are live in a calm panel; the eye is
 *    steered by weight — active names bold, completed muted, pending dim, structure and metadata dim.
 *    `warning` and `error` appear only when something has actually gone wrong, which is what makes them
 *    worth noticing when they do.
 *  - **Only one thing ever moves** (§4.8). The spinner frame is an INPUT here, not something this module
 *    advances, and every live duration is truncated to whole seconds. Two renders taken inside the same
 *    second are therefore byte-identical, so a diffing TUI redraws nothing between ticks — and a
 *    duration flickering through tenths ten times a second is the fastest way to make a calm panel feel
 *    frantic.
 *
 * **Styling is applied last** (§4.11): every width, pad and truncation below is computed on PLAIN
 * strings and the theme wraps the finished segments. ANSI-aware width arithmetic is a recurring source
 * of off-by-N corruption, and this ordering is what lets the whole module be asserted line-for-line in
 * a unit test with two identity functions standing in for a terminal.
 *
 * Pure — no PI, no `node:fs`, no clock (progress §2.1).
 */
import type { StepState } from "../engine/step-state.ts"
import type { RetryReason } from "../engine/types.ts"
import type { ProgressColour, ProgressNode, ProgressRow, ProgressTheme, ProgressView } from "./types.ts"

export interface RenderOptions {
	/** Terminal columns. Degradation (progress §4.10) is decided entirely from this. */
	readonly width: number
	readonly theme: ProgressTheme
	/**
	 * The braille spinner's frame, advanced by the host's 120 ms timer (progress §4.8) and passed in
	 * rather than read from a clock — animation state that lived here would make every render
	 * time-dependent and unassertable.
	 */
	readonly frame?: number
	/**
	 * The run's short form for the header (progress §4.1) — `runIdHash(runId)`, which the host computes,
	 * since `src/host/naming.ts` owns that shape and this layer may not import it. Defaults to the run
	 * id's trailing 8 characters, which is the same string.
	 */
	readonly runLabel?: string
}

/** The frame's own left margin (progress §4.1) — no side borders, so this is the only horizontal inset. */
const GUTTER = 2
/** Tree rows sit two columns inside the frame's gutter, which is progress §4.2's `gutter(2)`. */
const ROW_GUTTER = GUTTER + 2
/** Columns between the name field and the status cell, and between the status and token cells. */
const GAP = 2
/** Below this the metadata column goes entirely, and the footer bar with it (progress §4.10). */
const NARROW_WIDTH = 60
/** Names never squeeze below this, however wide the metadata gets — a row of pure ellipsis says nothing. */
const MIN_NAME_FIELD = 12
/** How many segments a foreach track draws at most (progress §4.6): a 500-item run must not draw 500. */
const TRACK_SEGMENTS = 10
const ELLIPSIS = "…"

/** PI's own default braille spinner (progress §4.4) — the only animation in the panel. */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const

/** One glyph per `StepState` (progress §4.4). `crashed` splits on `optional`, which is the whole point of the flag. */
const STATE_GLYPHS: Readonly<Record<Exclude<StepState, "in_progress">, readonly [string, ProgressColour]>> = {
	todo: ["○", "dim"],
	blocked: ["?", "warning"],
	completed: ["✓", "success"],
	skipped: ["⊘", "dim"],
	cancelled: ["■", "muted"],
	crashed: ["✗", "error"],
}

/** Why a step is retrying, in words (progress §5.3's `retry 2/3 · invalid output`). */
const RETRY_REASONS: Readonly<Record<RetryReason, string>> = {
	"thrown-error": "error",
	"invalid-output": "invalid output",
	"budget-exceeded": "budget exceeded",
}

/** The plain cells of one row, before any padding or styling (progress §4.11). */
interface RowCells {
	readonly row: ProgressRow
	readonly prefix: string
	readonly glyph: string
	readonly glyphColour: ProgressColour
	readonly name: string
	readonly status: string
	readonly token: string
}

/** Where the grid's columns fall for this render — computed once, from the widest cell (progress §4.2). */
interface Layout {
	/** False below `NARROW_WIDTH`: no metadata cells and no footer bar (progress §4.10). */
	readonly metadata: boolean
	/** Total columns of `prefix + glyph + space + name`, which every row is padded to. */
	readonly nameField: number
	readonly statusField: number
	readonly tokenField: number
}

/**
 * Draw the panel: a blank line, the header rule, the tree, and the footer rule that IS the progress bar
 * (progress §4.1). `rows` comes from `collapse` — this module decides nothing about which rows exist,
 * only how they look.
 */
export function render(view: ProgressView, rows: readonly ProgressRow[], options: RenderOptions): string[] {
	const { width, theme } = options
	const cells = rows.map((row) => rowCells(row, options.frame ?? 0))
	const layout = planLayout(cells, width)

	const lines = ["", headerLine(view, options), ""]
	for (const cell of cells) lines.push(rowLine(cell, layout, theme, width))
	lines.push("")
	// The footer goes on WIDTH alone (progress §4.10): below ~60 columns nothing is left of it but a
	// ratio nobody can read, and the run clock in the header already says the run is alive. It is
	// deliberately NOT tied to `layout.metadata`, which is a fact about the ROWS — a run that has only
	// just started has no row metadata at all, and tying the two together made the footer vanish at the
	// exact moment `0 of 6` is the most useful thing on screen.
	if (width >= NARROW_WIDTH) lines.push(footerLine(view, theme, width), "")
	return lines
}

// -- Layout (progress §4.2, §4.10) ---------------------------------------------------------------------

/**
 * Fit the grid to the width by REMOVING WHOLE ELEMENTS, never by squeezing them (progress §4.10): the
 * token cell goes first when both cells cannot sit beside the longest name, and below ~60 columns the
 * metadata column goes entirely. What remains always keeps its shape — that is the difference between a
 * narrow panel and a broken one.
 */
function planLayout(cells: readonly RowCells[], width: number): Layout {
	const bare: Layout = { metadata: false, nameField: width, statusField: 0, tokenField: 0 }
	if (width < NARROW_WIDTH) return bare

	const statusField = max(cells.map((cell) => cell.status.length))
	const wanted = max(cells.map((cell) => cell.token.length))
	if (statusField === 0 && wanted === 0) return bare

	// The metadata block hangs off the RIGHT edge, one gutter in, and the name field is whatever is left
	// — which is what puts every duration on the same column down the whole panel however short the
	// names happen to be. Sizing the name field to the longest name instead would slide the metadata
	// left on a panel of short names and give the grid a different shape on every run.
	const room = (token: number): number => width - GUTTER - GAP - statusField - (token > 0 ? GAP + token : 0)
	// Progress §4.10: when both cells cannot sit beside the longest name, the token cell goes first —
	// whole elements are removed, never squeezed. §6.4's ellipsis takes it from there.
	const tokenField =
		wanted > 0 && max(cells.map(headLength)) <= room(wanted) && room(wanted) >= MIN_NAME_FIELD ? wanted : 0
	const nameField = room(tokenField)
	// A status cell so wide that no legible name would be left is the same situation as a narrow
	// terminal, and takes the same answer: the metadata column goes, rather than the grid overflowing.
	return nameField < MIN_NAME_FIELD ? bare : { metadata: true, nameField, statusField, tokenField }
}

function headLength(cell: RowCells): number {
	return cell.prefix.length + cell.glyph.length + 1 + cell.name.length
}

function max(values: readonly number[]): number {
	let highest = 0
	for (const value of values) if (value > highest) highest = value
	return highest
}

// -- Rows ----------------------------------------------------------------------------------------------

function rowCells(row: ProgressRow, frame: number): RowCells {
	const [glyph, glyphColour] = glyphOf(row, frame)
	return {
		row,
		prefix: connectors(row),
		glyph,
		glyphColour,
		name: row.node.name,
		status: statusCell(row),
		token: tokenCell(row.node),
	}
}

/**
 * Two columns per depth (progress §4.3): `│ ` for a level that continues below, `└ ` for a last child,
 * two spaces where a level has run out. Depth 0 draws none — the tree's top level needs no rule to say
 * it is the top level. Rendered in `borderMuted` so structure recedes and names come forward.
 */
function connectors(row: ProgressRow): string {
	const own = row.guides.length - 1
	const columns = row.guides.map((continues, level) => {
		if (continues) return "│ " // this level has a sibling below, whether it is the node's own or an ancestor's
		return level === own ? "└ " : "  "
	})
	return " ".repeat(ROW_GUTTER) + columns.join("")
}

function rowLine(cell: RowCells, layout: Layout, theme: ProgressTheme, width: number): string {
	const fixed = cell.prefix.length + cell.glyph.length + 1
	const field = layout.metadata ? layout.nameField : width
	const name = truncate(cell.name, Math.max(0, field - fixed))
	const head = `${theme.fg("borderMuted", cell.prefix)}${theme.fg(cell.glyphColour, cell.glyph)} ${styledName(name, cell.row.node, theme)}`

	// `tokenField` is 0 when the layout dropped the token cell entirely (progress §4.10) — the row must
	// honour that, or a panel that degraded because names were long would print the very cell it just
	// made room by removing, past the right edge.
	const showToken = layout.tokenField > 0 && cell.token.length > 0

	// No metadata on this row at all: stop here rather than pad, so a bare row carries no trailing
	// whitespace (which a transcript, a diff, and a copy-paste all notice).
	if (!layout.metadata || (cell.status.length === 0 && !showToken)) return head

	const padded = head + " ".repeat(Math.max(0, field - fixed - name.length))
	const status = padded + " ".repeat(GAP) + metaCell(cell.status, layout.statusField, theme)
	return showToken ? status + " ".repeat(GAP) + metaCell(cell.token, layout.tokenField, theme) : status
}

/** A right-aligned metadata cell. Padding stays outside the theme call so no escape wraps bare spaces. */
function metaCell(text: string, field: number, theme: ProgressTheme): string {
	const pad = " ".repeat(Math.max(0, field - text.length))
	return text.length === 0 ? pad : pad + theme.fg("dim", text)
}

/**
 * Weight hierarchy (progress §4.5): the active row's name in `text` + bold, completed names `muted`,
 * pending and settled-without-running names `dim`. A crashed name stays readable in `text` — its glyph
 * already carries the colour, and colouring the name too would make the row shout twice.
 */
function styledName(name: string, node: ProgressNode, theme: ProgressTheme): string {
	if (node.state === "in_progress" || node.state === "blocked") return theme.bold(theme.fg("text", name))
	if (node.state === "completed") return theme.fg("muted", name)
	if (node.state === "crashed") return theme.fg("text", name)
	return theme.fg("dim", name)
}

function glyphOf(row: ProgressRow, frame: number): readonly [string, ProgressColour] {
	// A construct says whether it is open or folded (progress §4.4); a construct drawn as a single row —
	// never entered, or a skipped arm (§6.3) — says its state instead, which is the more useful fact.
	if (row.collapsed) return ["▸", "muted"]
	if (row.expanded) return ["▾", "accent"]
	if (row.node.state === "in_progress") return [SPINNER[frame % SPINNER.length] as string, "accent"]
	if (row.node.state === "crashed" && row.node.optional) return ["⚠", "warning"]
	return STATE_GLYPHS[row.node.state]
}

// -- The status cell (progress §4.9) --------------------------------------------------------------------

/**
 * The one most informative thing about a row, in progress §4.9's precedence: failure reason > blocked >
 * retry/repair badge > live counter > elapsed > final duration. A collapsed construct short-circuits it
 * entirely with its summary (§6.1), since a folded subtree's counters ARE the informative thing.
 *
 * A failed row reads `failed · optional · 2.4s` rather than carrying the error text: an error message
 * is arbitrarily long and a right-aligned column cannot take one without squeezing the grid, which
 * §4.10 forbids. The text is on the node (`failureReason`) for the terminal card, which has room.
 */
function statusCell(row: ProgressRow): string {
	const node = row.node
	if (row.collapsed) return collapsedSummary(node)

	switch (node.state) {
		case "crashed":
			return dotted(["failed", node.optional ? "optional" : undefined, durationText(node)])
		case "cancelled":
			return dotted(["cancelled", durationText(node)])
		case "skipped":
			return "skipped"
		case "blocked":
			return node.questions ? `waiting · ${plural(node.questions, "question")}` : "waiting"
		default:
			break
	}

	// Retries and steering are invisible in today's UI, so a step that silently burned three attempts
	// looks identical to one that succeeded first try (progress §5.3) — the badge outranks the duration
	// precisely because it surfaces the framework's most expensive behaviour as it costs money. It
	// changes TENSE when the step settles (progress §4.9): `retry 2/3 · invalid output` while an attempt
	// is in flight, `2 tries · 21.0s` once it is not. A settled row must never read as in-flight, and a
	// settled row must never lose its duration either — the tally keeps both.
	if (node.retry) {
		const badge =
			node.state === "in_progress"
				? `retry ${node.retry.attempt}${node.retry.of === undefined ? "" : `/${node.retry.of}`} · ${RETRY_REASONS[node.retry.reason]}`
				: // `attempt` is the attempt that FAILED (spec §9.1), so the try that settled is the next one.
					dotted([`${node.retry.attempt + 1} tries`, durationText(node)])
		return badge
	}
	if (node.repairs) {
		return node.state === "in_progress"
			? `repair ${node.repairs}`
			: dotted([plural(node.repairs, "repair"), durationText(node)])
	}

	const counter = counterCell(node)
	if (counter) return counter
	if (node.live) return `running · ${durationText(node)}`
	return durationText(node) ?? ""
}

/**
 * Counters are pictures where a picture is cheaper to read than a number (progress §4.6): a foreach
 * draws a track because "how far through" is a proportion, a loop draws `↻ 2/10` because how close the
 * iteration count is to the `maxIterations` guard is a number worth reading exactly.
 */
function counterCell(node: ProgressNode): string | undefined {
	if (node.loop) return `↻ ${node.loop.iteration}/${node.loop.max}`
	if (node.foreach)
		return `${track(node.foreach.done, node.foreach.count)} ${node.foreach.done}/${node.foreach.count} items`
	// An unentered construct shows its declared shape and no counter (progress §3.4).
	if (node.arms !== undefined && node.state !== "todo") return plural(node.arms, "arm")
	return undefined
}

/** Progress §6.1: `↻ 3 iterations · 38.1s`, `✓ 7 items · 2m 10s`, `✓ 4 steps · 51.0s`. */
function collapsedSummary(node: ProgressNode): string {
	const duration = durationText(node)
	if (node.loop) return dotted([`↻ ${plural(node.loop.iteration, "iteration")}`, duration])
	if (node.foreach) return dotted([`✓ ${plural(node.foreach.count, "item")}`, duration])
	if (node.steps !== undefined) return dotted([`✓ ${plural(node.steps, "step")}`, duration])
	if (node.arms !== undefined) return dotted([`✓ ${armTally(node.arms, node.armsTaken)}`, duration])
	return duration ?? ""
}

/**
 * `2 arms` when every arm ran, `1 of 2 arms` when a multi-match branch (spec §3.2) left one behind.
 * Folding the detail away (progress §6.1) may lose lines; it may not gain claims.
 */
function armTally(arms: number, taken: number | undefined): string {
	return taken === undefined || taken === arms ? plural(arms, "arm") : `${taken} of ${plural(arms, "arm")}`
}

function tokenCell(node: ProgressNode): string {
	return node.tokens > 0 ? `${formatTokens(node.tokens)} tok` : ""
}

// -- Frame (progress §4.1, §4.6) -------------------------------------------------------------------------

/**
 * The header rule: the workflow name as an accent chip on the left, `runIdHash · elapsed` dim on the
 * right. The right-hand id is the run slug's 8-hex tail rather than the whole slug, since the slug
 * already leads with the workflow name the chip just showed.
 */
function headerLine(view: ProgressView, options: RenderOptions): string {
	const { width, theme } = options
	const right = headerRight(view, options)
	const overhead = GUTTER + "── ".length + 1 + " ──".length + (right.length > 0 ? 1 + right.length : 0)
	const name = truncate(view.workflowName, Math.max(1, width - overhead - 1))
	const fill = Math.max(1, width - overhead - name.length)

	const rule = theme.fg("borderMuted", "─".repeat(fill))
	const tail = right.length > 0 ? ` ${theme.fg("dim", right)}` : ""
	return `${" ".repeat(GUTTER)}${theme.fg("borderMuted", "── ")}${theme.fg("accent", name)} ${rule}${tail}${theme.fg("borderMuted", " ──")}`
}

function headerRight(view: ProgressView, options: RenderOptions): string {
	// `runIdHash` (src/host/naming.ts) is the same slice; it is not imported because this layer depends
	// on the host in no direction (progress §2.1), and a host that has the real function passes it in.
	const label = options.runLabel ?? (view.runId === undefined ? undefined : view.runId.slice(-8))
	return dotted([label, formatClock(view.elapsedMs ?? 0)], " · ")
}

/**
 * The footer rule IS the progress bar (progress §4.6): filled `━` in accent, a `╸` cap at the head,
 * `─` in `borderMuted` for the remainder, then the run's tally and cost.
 */
function footerLine(view: ProgressView, theme: ProgressTheme, width: number): string {
	const right = dotted([
		`${view.stepsSettled} of ${view.stepsTotal}`,
		view.tokens > 0 ? `${formatTokens(view.tokens)} tok` : undefined,
	])
	const barWidth = Math.max(1, width - GUTTER - GAP - right.length)
	const filled =
		view.stepsTotal > 0 ? Math.min(barWidth, Math.round((view.stepsSettled / view.stepsTotal) * barWidth)) : 0

	return `${" ".repeat(GUTTER)}${bar(filled, barWidth, theme)}${" ".repeat(GAP)}${theme.fg("dim", right)}`
}

/** Filled `━` in accent, a `╸` cap at the head, `─` in `borderMuted` for the remainder (progress §4.6). */
function bar(filled: number, width: number, theme: ProgressTheme): string {
	if (filled <= 0) return theme.fg("borderMuted", "─".repeat(width)) // nothing done yet, so no head to cap
	if (filled >= width) return theme.fg("accent", "━".repeat(width))
	return theme.fg("accent", `${"━".repeat(filled)}╸`) + theme.fg("borderMuted", "─".repeat(width - filled - 1))
}

/** `▰▰▰▰▱▱▱` — how far through, as a proportion (progress §4.6). */
function track(done: number, count: number): string {
	const segments = Math.max(1, Math.min(count, TRACK_SEGMENTS))
	const filled = count > 0 ? Math.min(segments, Math.round((done / count) * segments)) : 0
	return "▰".repeat(filled) + "▱".repeat(segments - filled)
}

// -- Typography (progress §4.7, §4.8) ---------------------------------------------------------------------

/**
 * A node's duration. A settled one keeps its tenths — it can never change again, so it cannot flicker.
 * A LIVE one is truncated to whole seconds (progress §4.8): no one reads the tenths, and a duration
 * ticking through them ten times a second is the single fastest way to make a calm panel feel frantic.
 * This is also the guarantee that two renders inside one second are byte-identical.
 */
function durationText(node: ProgressNode): string | undefined {
	if (node.elapsedMs === undefined) return undefined
	return node.live ? formatWholeSeconds(node.elapsedMs) : formatDuration(node.elapsedMs)
}

/** `3.1s` under a minute, `1m 04s` under an hour, `1:04:22` beyond (progress §4.7). */
export function formatDuration(ms: number): string {
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
	return formatWholeSeconds(ms)
}

/** The same scale with the tenths removed — every duration measured against `now` uses this (progress §4.8). */
export function formatWholeSeconds(ms: number): string {
	const total = Math.floor(ms / 1000)
	if (total < 60) return `${total}s`
	const seconds = total % 60
	const minutes = Math.floor(total / 60)
	if (minutes < 60) return `${minutes}m ${pad2(seconds)}s`
	return `${Math.floor(minutes / 60)}:${pad2(minutes % 60)}:${pad2(seconds)}`
}

/** The run clock, always `mm:ss` (progress §4.7) — and always whole seconds, being measured against `now`. */
export function formatClock(ms: number): string {
	const total = Math.floor(Math.max(0, ms) / 1000)
	return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`
}

/**
 * `4.1k`, `88.2k`, `1.2M` (progress §4.7). Never raw digits above a thousand: they are unreadable at a
 * glance and change width constantly, which is exactly what §4.2's column cannot afford.
 */
export function formatTokens(tokens: number): string {
	if (tokens < 1000) return String(tokens)
	if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`
	return `${(tokens / 1_000_000).toFixed(1)}M`
}

function pad2(value: number): string {
	return String(value).padStart(2, "0")
}

/** Rows truncate on the NAME (progress §6.4) — the metadata carries the live information. */
function truncate(text: string, limit: number): string {
	if (limit <= 0) return ""
	if (text.length <= limit) return text
	return limit === 1 ? ELLIPSIS : `${text.slice(0, limit - 1)}${ELLIPSIS}`
}

function dotted(parts: readonly (string | undefined)[], separator = " · "): string {
	return parts.filter((part): part is string => part !== undefined && part.length > 0).join(separator)
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`
}
