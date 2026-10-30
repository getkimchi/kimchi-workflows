/**
 * Step transcripts (inspection, specs/progress-ui.md §14): the durable half of "what did this step
 * actually do" — one PI session-shaped JSONL file per step execution, readable live (while the step
 * runs) and after the fact.
 *
 * An isolated/background step already leaves exactly that behind: the bridge spawns it with
 * `--session <file>` and the child persists its whole conversation there (pi-agent.ts's
 * `sessionPath`). An in-session step writes its conversation into the PARENT session, mixed with the
 * user's own traffic and carrying no step identity — so this module gives it a sidecar of its own,
 * appended message by message as the turn runs, under the SAME naming rule the isolated path uses
 * (`naming.ts`): one reader then covers both execution modes, which is what keeps live inspection and
 * post-hoc inspection the same code path.
 *
 * Entry shapes are PI's own (`SessionEntry`, session-manager.d.ts) — `message` entries for
 * user/assistant/toolResult messages, `custom_message` entries for the framework-sent prompt — parsed
 * back with the harness's own `parseSessionEntries`, so a sidecar and a real subprocess session file
 * are indistinguishable to the loader.
 *
 * Writing is best-effort by the same rule the progress sink follows (progress §2.3): a display
 * artifact must never be able to fail the step that produced it, so the writer swallows its errors and
 * reports the first one once through the injected callback.
 */
import { randomUUID } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import {
	CURRENT_SESSION_VERSION,
	parseSessionEntries,
	type SessionEntry,
	type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent"
import type { AgentRequest } from "../engine/types.ts"
import { formatTokens } from "../progress/render.ts"
import { resumeSessionFile, traceSessionFile } from "./naming.ts"
import { summarizeToolArguments, summarizeToolResult, terminalSafe } from "./step-activity.ts"

/**
 * The one file a step execution's transcript lives in, under the same naming rule the isolated
 * subprocess path already uses (pi-agent.ts's `sessionPath`): a `resumeKey` step shares ONE keyed
 * file across executions — which is what resuming continues — and everything else gets a per-execution
 * trace file. In-session and isolated steps are disjoint, so a sidecar can never collide with a real
 * subprocess session file.
 */
export function stepTranscriptFile(
	dir: string,
	ref: {
		readonly workflowName: string
		readonly runId: string
		readonly path: string
		readonly attempt: number
		readonly resumeKey?: string
	},
): string {
	const file = ref.resumeKey
		? resumeSessionFile(ref.workflowName, ref.resumeKey)
		: traceSessionFile(ref.workflowName, ref.runId, ref.path, ref.attempt)
	return path.join(dir, file)
}

// -- Writing (in-session sidecars) ------------------------------------------------------------------------

/** Appends one conversation message to a step's transcript file. Never throws. */
export interface StepTranscriptWriter {
	appendMessage(message: unknown): void
}

/**
 * The writer an in-session step's sidecar is built through. One per session (`sendAndAwaitEnd` may
 * run several turns against it — steering repairs, answer resumes — and they all append).
 *
 * The file is created lazily on the first message, with the same session header a real PI session
 * file starts with, so the loader treats it exactly like a subprocess's own session file.
 */
export function createStepTranscriptWriter(
	dir: string,
	request: AgentRequest,
	/** Called at most once, on the first write failure — the bus turns it into a run activity. */
	onError?: (error: unknown) => void,
): StepTranscriptWriter {
	const file = stepTranscriptFile(dir, request)
	let started = false
	let failed = false
	let lastId: string | null = null
	// Set when an existing file's tail is torn (a crash mid-append left no trailing newline): the
	// continuation's first entry starts a fresh line rather than gluing onto the fragment.
	let pendingNewline = false

	return {
		appendMessage(message: unknown): void {
			if (failed) return // one attempt per session: a broken disk does not get cheaper by retrying
			try {
				if (!started) {
					mkdirSync(dir, { recursive: true })
					if (!existsSync(file)) {
						appendFileSync(
							file,
							`${JSON.stringify({
								type: "session",
								version: CURRENT_SESSION_VERSION,
								id: path.basename(file, ".jsonl"),
								timestamp: new Date().toISOString(),
								cwd: process.cwd(),
							})}\n`,
						)
					} else {
						// A KEYED file is shared across executions (that is what resuming continues), so this
						// writer continues the chain the previous execution left: its first entry is parented
						// to the file's current last entry rather than starting a second root mid-file. A trace
						// file is unique per execution and never takes this path.
						const tail = tailOf(file)
						lastId = tail.lastId
						pendingNewline = tail.torn
					}
					started = true
				}
				const entry = entryForMessage(message)
				const id = randomUUID()
				appendFileSync(
					file,
					`${pendingNewline ? "\n" : ""}${JSON.stringify({ ...entry, id, parentId: lastId, timestamp: new Date().toISOString() })}\n`,
				)
				pendingNewline = false
				lastId = id
			} catch (error) {
				failed = true
				try {
					onError?.(error)
				} catch {
					// Even the report is best-effort.
				}
			}
		},
	}
}

/** The entry PI itself would persist for this message — `custom_message` for the framework's prompt, `message` for the rest. */
function entryForMessage(message: unknown): SessionEntry {
	const record = (message ?? {}) as { role?: unknown }
	if (record.role === "custom") {
		const custom = message as {
			customType: string
			content: string | { type: string; text?: string }[]
			display: boolean
			details?: unknown
		}
		return {
			type: "custom_message",
			customType: custom.customType,
			content: custom.content,
			details: custom.details,
			display: custom.display,
		} as SessionEntry
	}
	return { type: "message", message } as SessionEntry
}

// -- Loading (both modes) ----------------------------------------------------------------------------------

/** What a transcript load found. `missing` covers absent AND unreadable — nothing downstream can act on the difference. */
export type StepTranscriptLoad =
	| { readonly ok: true; readonly entries: readonly SessionEntry[]; readonly file: string }
	| { readonly ok: false; readonly reason: "missing"; readonly file: string }

export interface StepTranscriptRef {
	readonly dir: string
	readonly workflowName: string
	readonly runId: string
	readonly path: string
	readonly attempt: number
	/**
	 * The step's resume key, when it is derivable — statically from the definition, or from a recorded
	 * `agent-steer`/`agent-error`. A function-form `resumable` leaves no trace in the log when the step
	 * ran cleanly, and its key is honestly underivable rather than guessed.
	 */
	readonly resumeKey?: string
}

/** Read one step execution's transcript — a subprocess's own session file, or an in-session sidecar. */
export function loadStepTranscript(ref: StepTranscriptRef): StepTranscriptLoad {
	const file = stepTranscriptFile(ref.dir, ref)
	try {
		if (!existsSync(file)) return { ok: false, reason: "missing", file }
		// The parser returns the header alongside the entries (`FileEntry`); only entries render.
		const entries = parseSessionEntries(readFileSync(file, "utf8")).filter(
			(entry): entry is SessionEntry => (entry as { type?: string }).type !== "session",
		)
		return { ok: true, entries, file }
	} catch {
		return { ok: false, reason: "missing", file }
	}
}

// -- Rendering ---------------------------------------------------------------------------------------------

export interface StepTranscriptRenderOptions {
	/** Total columns; long lines wrap to the content column. Default 100, like `/workflow status`. */
	readonly width?: number
	/** Cap on rendered lines; the remainder is summarized in one final line. Uncapped by default. */
	readonly maxLines?: number
	/** Bound the blocks instead of replaying them whole: the prompt keeps its head (≤10 lines) and
	 * every assistant text its tail (≤8 lines) — the drill-down stays detailed without being a wall. */
	readonly bounded?: boolean
}

/** Compact-view bounds (progress §14.11): how much of the tail the activity feed shows. */
const SUMMARY_TOOL_LINES = 6
const SUMMARY_TEXT_TAIL = 4
/** Bounded full-view caps: how many lines each block keeps in drill-down mode. */
const BOUNDED_PROMPT_LINES = 10
const BOUNDED_TEXT_TAIL = 8

/** The label column's width — `assistant` is the longest role word and sets it. */
const LABEL_WIDTH = 9

/**
 * Render a step's transcript as plain, aligned lines — the same choice `/workflow status` made for
 * the tree (a notification is plain text on every harness). One block per message:
 *
 * ```
 *   ● prompt     Run the tests and fix any failures
 *   → bash       npm test
 *   ← bash       12 passed, 0 failed
 *   ● assistant  Fixed the import in src/engine/x.ts · 4.1k tok
 * ```
 *
 * Pure: entries in, strings out, no clock or theme, so the live view and the post-hoc view are the
 * same function of the same input (progress §2.4's property, applied to inspection).
 */
export function renderStepTranscript(
	entries: readonly SessionEntry[],
	options: StepTranscriptRenderOptions = {},
): string[] {
	const width = options.width ?? 100
	const contentColumn = 4 + LABEL_WIDTH + 2 // gutter + glyph + label + gap — where every block's text starts
	const contentWidth = Math.max(20, width - contentColumn)
	const lines: string[] = []
	const toolNames = new Map<string, string>()

	const bounded = options.bounded === true
	for (const entry of entries) {
		if (entry.type === "custom_message") {
			bounded
				? pushHeadBounded(lines, "prompt", textOfContent(entry.content), contentWidth, BOUNDED_PROMPT_LINES)
				: pushMessage(lines, "prompt", textOfContent(entry.content), contentWidth)
			continue
		}
		if (entry.type !== "message") continue
		const message = (entry as SessionMessageEntry).message as {
			role?: string
			content?: unknown
			usage?: { totalTokens?: number }
		}
		if (message.role === "user") {
			bounded
				? pushHeadBounded(lines, "prompt", textOfContent(message.content), contentWidth, BOUNDED_PROMPT_LINES)
				: pushMessage(lines, "prompt", textOfContent(message.content), contentWidth)
			continue
		}
		if (message.role === "assistant") {
			const before = lines.length
			const parts = Array.isArray(message.content) ? (message.content as { type?: string }[]) : []
			for (const part of parts) {
				if (part?.type === "toolCall") {
					const call = part as unknown as { id?: string; name?: string; arguments?: unknown }
					if (call.id && call.name) toolNames.set(call.id, call.name)
					lines.push(prefixed("→", call.name ?? "tool", summarizeToolArguments(call.arguments) ?? "", contentWidth))
				} else if (part?.type === "text") {
					const text = (part as { text?: string }).text ?? ""
					if (text)
						bounded
							? pushTailBounded(lines, "assistant", text, contentWidth, BOUNDED_TEXT_TAIL)
							: pushMessage(lines, "assistant", text, contentWidth)
				}
			}
			const tokens = message.usage?.totalTokens
			// Token usage belongs to the whole assistant message; it reads best at the end of the block
			// it priced, and only when the block said anything at all.
			if (tokens !== undefined && tokens > 0 && lines.length > before) {
				lines[lines.length - 1] = `${lines[lines.length - 1]} · ${formatTokens(tokens)} tok`
			}
		}
		if (message.role === "toolResult") {
			const result = message as { toolCallId?: string; isError?: boolean }
			const name = toolNames.get(result.toolCallId ?? "") ?? "tool"
			const summary = summarizeToolResult(textOfContent(message.content)) ?? ""
			lines.push(prefixed(result.isError === true ? "←!" : "←", name, summary, contentWidth))
		}
	}

	if (options.maxLines !== undefined && lines.length > options.maxLines) {
		const kept = lines.slice(0, Math.max(0, options.maxLines - 1))
		return [...kept, `… +${lines.length - kept.length} more lines`]
	}
	return lines
}

/** One message as a labelled block: the label column, then the text wrapped to the content column —
 * stripped of control bytes here, the one place every message's text passes on its way to a terminal. */
function pushMessage(lines: string[], label: string, text: string, contentWidth: number): void {
	const wrapped = wrap(terminalSafe(text) || "(empty)", contentWidth)
	for (const [index, line] of wrapped.entries()) {
		lines.push(index === 0 ? `  ● ${label.padEnd(LABEL_WIDTH)}  ${line}` : `${" ".repeat(4 + LABEL_WIDTH + 2)}${line}`)
	}
}

/** A head-bounded block: the first `max` lines, then how many were cut — for text whose BEGINNING
 * is the point (a prompt's instruction). */
function pushHeadBounded(lines: string[], label: string, text: string, contentWidth: number, max: number): void {
	const wrapped = wrap(terminalSafe(text) || "(empty)", contentWidth)
	if (wrapped.length <= max) {
		pushMessage(lines, label, text, contentWidth)
		return
	}
	for (const [index, line] of wrapped.slice(0, max).entries()) {
		lines.push(index === 0 ? `  ● ${label.padEnd(LABEL_WIDTH)}  ${line}` : `${" ".repeat(4 + LABEL_WIDTH + 2)}${line}`)
	}
	lines.push(`${" ".repeat(4 + LABEL_WIDTH + 2)}… +${wrapped.length - max} more lines`)
}

/** A tail-bounded block: how many lines were cut, then the last `max` — for text whose END is the
 * point (an assistant message's latest state). */
function pushTailBounded(lines: string[], label: string, text: string, contentWidth: number, max: number): void {
	const wrapped = wrap(terminalSafe(text) || "(empty)", contentWidth)
	if (wrapped.length <= max) {
		pushMessage(lines, label, text, contentWidth)
		return
	}
	lines.push(`${" ".repeat(4 + LABEL_WIDTH + 2)}… +${wrapped.length - max} lines above`)
	for (const [index, line] of wrapped.slice(-max).entries()) {
		lines.push(index === 0 ? `  ● ${label.padEnd(LABEL_WIDTH)}  ${line}` : `${" ".repeat(4 + LABEL_WIDTH + 2)}${line}`)
	}
}

export interface StepSummaryOptions {
	/** Total columns; lines ellipsize to the content column. Default 100, like `/workflow status`. */
	readonly width?: number
	/** Tool lines kept in the feed's tail. Default 6. */
	readonly toolLines?: number
	/** Wrapped lines kept of the latest assistant text. Default 4. */
	readonly textTail?: number
	/** Appended to the counts footer — each surface states its own keys. */
	readonly hint?: string
}

/** The step view's DEFAULT (progress §14.11): what the step is doing, at a glance — the prompt's
 * first line, the tail of the tool activity with durations, the latest assistant text's tail, and
 * a counts footer. One pass over the same entries the full view renders, so live and post-hoc are
 * the same function of the same input. Pure: entries in, strings out. */
export function renderStepSummary(entries: readonly SessionEntry[], options: StepSummaryOptions = {}): string[] {
	const width = options.width ?? 100
	const toolLines = options.toolLines ?? SUMMARY_TOOL_LINES
	const textTail = options.textTail ?? SUMMARY_TEXT_TAIL
	const contentWidth = Math.max(20, width - 4 - LABEL_WIDTH - 2)

	let prompt: string | undefined
	type ToolLine = { marker: string; name: string; summary: string; suffix: string }
	const toolHistory: ToolLine[] = []
	const toolNames = new Map<string, string>() // toolCallId → name, so a result line can carry its call's name
	const callAt = new Map<string, string>() // toolCallId → the call entry's timestamp, for pairing a duration
	let lastText = ""

	for (const entry of entries) {
		if (entry.type === "custom_message") {
			if (prompt === undefined) prompt = firstLine(textOfContent(entry.content), contentWidth)
			continue
		}
		if (entry.type !== "message") continue
		const message = (entry as SessionMessageEntry).message as { role?: string; content?: unknown }
		if (message.role === "user") {
			if (prompt === undefined) prompt = firstLine(textOfContent(message.content), contentWidth)
			continue
		}
		if (message.role === "assistant") {
			const parts = Array.isArray(message.content) ? (message.content as { type?: string }[]) : []
			for (const part of parts) {
				if (part?.type === "toolCall") {
					const call = part as unknown as { id?: string; name?: string; arguments?: unknown }
					if (call.id && call.name) {
						toolNames.set(call.id, call.name)
						callAt.set(call.id, entry.timestamp)
					}
					toolHistory.push({
						marker: "→",
						name: call.name ?? "tool",
						summary: summarizeToolArguments(call.arguments) ?? "",
						suffix: "",
					})
				} else if (part?.type === "text") {
					const text = (part as { text?: string }).text ?? ""
					if (text) lastText = text
				}
			}
		}
		if (message.role === "toolResult") {
			const result = message as { toolCallId?: string; isError?: boolean }
			const startedAt = result.toolCallId ? callAt.get(result.toolCallId) : undefined
			const duration = startedAt !== undefined ? durationBetween(startedAt, entry.timestamp) : undefined
			toolHistory.push({
				marker: result.isError === true ? "←!" : "←",
				name: (result.toolCallId ? toolNames.get(result.toolCallId) : undefined) ?? "tool",
				summary: summarizeToolResult(textOfContent(message.content)) ?? "",
				suffix: duration !== undefined ? ` · ${duration}` : "",
			})
		}
	}

	const lines: string[] = []
	if (prompt !== undefined) lines.push(`  ● ${"prompt".padEnd(LABEL_WIDTH)}  ${prompt}`)
	// The feed keeps the TAIL of the tool activity — what the step is doing NOW — and reports how
	// much older activity is behind it, in calls (a call implies its result, so the count is honest).
	const toolTail = toolHistory.slice(-toolLines)
	for (const toolLine of toolTail)
		lines.push(prefixed(toolLine.marker, toolLine.name, toolLine.summary, contentWidth, toolLine.suffix))
	if (lastText) {
		const wrapped = wrap(terminalSafe(lastText), contentWidth)
		const tail = wrapped.slice(-textTail)
		for (const [index, line] of tail.entries()) {
			const prefix =
				index === 0
					? `  ● ${"assistant".padEnd(LABEL_WIDTH)}  ${wrapped.length > textTail ? "… " : ""}`
					: `${" ".repeat(4 + LABEL_WIDTH + 2)}`
			lines.push(`${prefix}${line}`)
		}
	}

	const counts: string[] = []
	if (toolHistory.length > toolLines) {
		const callsDropped = toolHistory
			.slice(0, toolHistory.length - toolLines)
			.filter((line) => line.marker === "→").length
		if (callsDropped > 0) counts.push(`… +${callsDropped} more tool calls`)
	}
	if (options.hint) counts.push(options.hint)
	if (counts.length > 0) lines.push(counts.join(" · "))
	return lines.length > 0 ? lines : ["(nothing recorded yet)"]
}

/** The first line of a text, ellipsized to the content column — a prompt's first line is the
 * instruction; the rest is one Enter away. */
function firstLine(text: string, contentWidth: number): string {
	const line = terminalSafe(text).split("\n")[0] ?? ""
	return line.length > contentWidth ? `${line.slice(0, contentWidth - 1)}…` : line
}

/** A duration between two entry timestamps, the way a progress clock would show it: one decimal
 * under a minute, minutes-and-seconds above. Malformed timestamps render nothing (degrade, never
 * fail) — the caller treats undefined as "no duration to show". */
function durationBetween(from: string, to: string): string | undefined {
	const start = Date.parse(from)
	const end = Date.parse(to)
	if (Number.isNaN(start) || Number.isNaN(end) || end < start) return undefined
	const seconds = (end - start) / 1000
	if (seconds < 60) return `${seconds.toFixed(1)}s`
	const minutes = Math.floor(seconds / 60)
	return `${minutes}m${Math.round(seconds - minutes * 60)}s`
}

/** A tool line: arrow marker, tool name in the label column, one bounded summary — and optionally a
 * trailing suffix (a paired duration), which reserves its own columns before truncation. The label is
 * stripped too — it is read back off disk, same as the content (security-fix-001). */
function prefixed(marker: string, label: string, content: string, contentWidth: number, suffix = ""): string {
	const budget = Math.max(20, contentWidth - suffix.length)
	const truncated = content.length > budget ? `${content.slice(0, budget - 1)}…` : content
	return `  ${marker} ${terminalSafe(label).padEnd(LABEL_WIDTH)}  ${truncated}${suffix}`.replace(/\s+$/, "")
}

/** A message's text: a bare string, or the concatenation of its text parts — control bytes stripped,
 * because the renderers hand this straight to a terminal surface (security-002). */
function textOfContent(content: unknown): string {
	if (typeof content === "string") return terminalSafe(content)
	if (Array.isArray(content)) {
		let text = ""
		for (const part of content as { type?: string; text?: string }[]) {
			if (part?.type === "text" && part.text) text += part.text
		}
		return terminalSafe(text)
	}
	return ""
}

/** What a continuation needs to know about an existing session file: the last entry's id, and
 * whether its tail is clean. Per-line tolerant, like `parseSessionEntries`: a torn line (a crash
 * mid-append, or a cross-process tear) is skipped and the scan continues to the last PARSEABLE
 * entry, so one bad line cannot fork the chain back at its root. `torn` is true when the file does
 * not end on a line boundary — the continuation then starts a fresh line rather than gluing its
 * first entry onto the fragment (which would make BOTH unparseable). */
function tailOf(file: string): { lastId: string | null; torn: boolean } {
	let content: string
	try {
		content = readFileSync(file, "utf8")
	} catch {
		return { lastId: null, torn: false } // an unreadable file leaves the chain at its root
	}
	const torn = content.length > 0 && !content.endsWith("\n")
	for (const line of content.split("\n").reverse()) {
		const trimmed = line.trim()
		if (!trimmed) continue
		try {
			const parsed = JSON.parse(trimmed) as { type?: string; id?: unknown }
			if (parsed.type === "session") continue // the header is not an entry
			return { lastId: typeof parsed.id === "string" ? parsed.id : null, torn }
		} catch {}
	}
	return { lastId: null, torn }
}

/** Word wrap on the plain string — the transcript view is scrollable, so nothing is cut, only folded. */
function wrap(text: string, width: number): string[] {
	const paragraphs = text.replace(/\r/g, "").split("\n")
	const lines: string[] = []
	for (const paragraph of paragraphs) {
		if (paragraph.length <= width) {
			lines.push(paragraph)
			continue
		}
		let line = ""
		for (const word of paragraph.split(/\s+/)) {
			const candidate = line ? `${line} ${word}` : word
			if (candidate.length > width && line) {
				lines.push(line)
				line = word
			} else {
				line = candidate
			}
		}
		if (line) lines.push(line)
	}
	return lines.length > 0 ? lines : [""]
}
