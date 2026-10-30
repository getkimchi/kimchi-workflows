/**
 * Live step activity (inspection, specs/progress-ui.md §14): the process-local channel that carries
 * WHAT an executing step is doing — tool calls, assistant text — from the two places it can be
 * observed to whoever wants to watch it (the progress panel's inline hint, `/workflow inspect`).
 *
 * Those two places are both host-side, which is why this module is host-side too:
 *
 *  - an in-session step's turn runs through the shared PI session, so its tool calls and streaming
 *    text surface as the harness's own extension events (`tool_execution_start/end`,
 *    `message_update`) — observable only by the bridge that already tracks which step's turn is in
 *    flight (pi-agent.ts's `inFlight`);
 *  - an isolated/background step runs as a `pi --mode json` subprocess whose NDJSON stdout carries
 *    the same facts as stream events — observable only by the reader that drains that pipe
 *    (pi-agent-messages.ts), which until now discarded everything but the final assistant message.
 *
 * The engine never sees any of this, by design (spec §13.7 — rendering must not become a reason to
 * change the engine's event stream). The channel is fire-and-forget and non-durable: nothing here is
 * persisted, replayed, or allowed to throw back into a caller. A display convenience that could fail
 * a step would violate the same rule the progress sink already follows (progress §2.3).
 *
 * Pure bookkeeping plus parsing — no PI imports, no filesystem, no clock (timestamps are supplied by
 * the caller) — so the whole module is unit-testable offline.
 */

/** What an executing step did just now. The kinds the two capture paths can both produce, plus two
 * synthesized ones: a `notice` is a non-fatal problem with inspection itself (e.g. a sidecar that
 * could not be written) — carried where the watchers already look rather than dropped — and an `end`
 * is the bus's terminal poke, delivered to a run's subscribers when its execution finishes so a live
 * view re-reads once more and shows the step's final message (its `path`/`attempt` are placeholders:
 * the signal is the kind, nothing else). */
export type StepActivityKind = "tool-start" | "tool-end" | "assistant-text" | "notice" | "end"

/**
 * One observable moment of a step's execution, tagged with the identity its events are keyed by — the
 * same `runId`/`path`/`attempt` triple the run log uses, so a consumer can join activity back to the
 * step it belongs to without a second vocabulary.
 */
export interface StepActivity {
	readonly runId: string
	readonly path: string
	/** 1-based retry attempt the activity belongs to — the attempt the session was opened for. */
	readonly attempt: number
	/** ISO timestamp, supplied by the capture site (this module owns no clock). */
	readonly at: string
	readonly kind: StepActivityKind
	readonly toolName?: string
	/** Single line, bounded — see {@link SUMMARY_MAX_CHARS}. */
	readonly summary?: string
	readonly isError?: boolean
}

/** The execution identity every capture path already has in hand. */
export interface StepActivityIdentity {
	readonly runId: string
	readonly path: string
	readonly attempt: number
}

/** A listener for one run's activity. Must not throw; a throwing listener is dropped, not propagated. */
export type StepActivityListener = (activity: StepActivity) => void

/**
 * The bus itself. One per process (extension.ts), subscribed to by surface code filtered by run id.
 */
export interface ActivityBus {
	publish(activity: StepActivity): void
	/** Listen to one run's activity. Returns the unsubscribe. */
	subscribe(runId: string, listener: StepActivityListener): () => void
	/** This run's recent activity, oldest first — what a view opened mid-step replays before going live. */
	recent(runId: string): readonly StepActivity[]
	/** Drop a run's buffer. Safe to call more than once; subscribers are left alone (they simply hear no more). */
	clear(runId: string): void
}

/**
 * How much of one run's activity the bus keeps. A ring, not a log: it exists so a view opened halfway
 * through a step can show what it missed, not so the run's history can be reconstructed — that is
 * what the transcript sidecars are for (step-transcript.ts). Past this the oldest entries go.
 */
const RING_LIMIT = 200

/**
 * How many runs keep a ring at all. The bus outlives any one run in a long-lived host process, and a
 * run whose execution has finished has nothing live to show — the oldest finished run's ring is the
 * cheapest memory to reclaim when a new run starts publishing.
 */
const TRACKED_RUNS = 8

export function createActivityBus(): ActivityBus {
	const rings = new Map<string, StepActivity[]>()
	const listeners = new Map<string, Set<StepActivityListener>>()

	return {
		publish(activity: StepActivity): void {
			let ring = rings.get(activity.runId)
			if (ring === undefined) {
				// Eviction prefers the oldest ring with no live subscriber — a run someone is watching
				// keeps its replayable history — and only falls back to the oldest ring outright. Plain
				// insertion order would kill the longest-running LIVE run's ring once 9+ runs published.
				if (rings.size >= TRACKED_RUNS) {
					const evictable = [...rings.keys()].find((runId) => !listeners.has(runId)) ?? rings.keys().next().value
					if (evictable !== undefined) rings.delete(evictable)
				}
				ring = []
				rings.set(activity.runId, ring)
			}
			ring.push(activity)
			if (ring.length > RING_LIMIT) ring.splice(0, ring.length - RING_LIMIT)
			for (const listener of listeners.get(activity.runId) ?? []) {
				try {
					listener(activity)
				} catch {
					// A display callback must not break the agent stream it observes.
				}
			}
		},

		subscribe(runId: string, listener: StepActivityListener): () => void {
			let set = listeners.get(runId)
			if (set === undefined) {
				set = new Set()
				listeners.set(runId, set)
			}
			set.add(listener)
			return () => {
				set.delete(listener)
				if (set.size === 0) listeners.delete(runId)
			}
		},

		recent(runId: string): readonly StepActivity[] {
			return [...(rings.get(runId) ?? [])]
		},

		clear(runId: string): void {
			// The terminal poke (inspection §14): tell the run's watchers it is over BEFORE dropping the
			// ring, so an open view re-reads the transcript one last time and shows the step's concluding
			// message — the final sidecar append publishes nothing of its own. The sink ignores the kind;
			// a live overlay reloads on any event.
			for (const listener of listeners.get(runId) ?? []) {
				try {
					listener({ runId, path: "", attempt: 0, at: new Date().toISOString(), kind: "end" })
				} catch {
					// A display callback must not break the run's own teardown.
				}
			}
			rings.delete(runId)
		},
	}
}

// -- Summaries -------------------------------------------------------------------------------------------

/** One line, at most this long — the width of a status cell, not a transcript. */
export const SUMMARY_MAX_CHARS = 200

/**
 * Control bytes a terminal would EXECUTE rather than print — C0 (except newline and tab), DEL, and
 * C1 — which `\s+` deliberately does not match. Tool output and model text are untrusted by
 * construction (a prompt-injected step can emit them), and they now reach live terminal surfaces
 * (the panel's status cells, the working message, the inspect view), so every producer strips before
 * rendering: an ESC sequence left standing is not cosmetic, it is the terminal's to interpret
 * (screen spoofing, OSC clipboard writes).
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the strip list IS control characters — naming them is its entire job
const TERMINAL_UNSAFE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g

/** Strip the control bytes a terminal would execute. Newlines and tabs survive — text still wraps. */
export function terminalSafe(text: string): string {
	return text.replace(TERMINAL_UNSAFE, "")
}

/** Argument fields worth quoting on their own when a tool has one — the common tool surfaces. */
const PREFERRED_FIELDS = ["command", "cmd", "file_path", "filePath", "path", "pattern", "query", "url"] as const

/**
 * A tool call's arguments as one bounded line. A preferred field (a command, a path, a pattern) is
 * quoted on its own because it is the fact a human reads; anything else falls back to compact JSON.
 */
export function summarizeToolArguments(args: unknown): string | undefined {
	if (args === undefined || args === null) return undefined
	if (typeof args === "string") return summarizeHead(args)
	if (typeof args === "object") {
		const record = args as Record<string, unknown>
		for (const field of PREFERRED_FIELDS) {
			const value = record[field]
			if (typeof value === "string" && value.length > 0) return summarizeHead(value)
		}
		return summarizeHead(safeJson(args))
	}
	return summarizeHead(String(args))
}

/** A tool's result as one bounded line — the END of it is where a failure's detail lands. */
export function summarizeToolResult(result: unknown): string | undefined {
	if (result === undefined || result === null) return undefined
	if (typeof result === "string") return summarizeTail(result)
	if (typeof result === "object") {
		const output = (result as Record<string, unknown>).output
		if (typeof output === "string" && output.length > 0) return summarizeTail(output)
		return summarizeTail(safeJson(result))
	}
	return summarizeTail(String(result))
}

/** Collapse to one line, bounded at the head: a command's beginning is what identifies it. */
export function summarizeHead(text: string): string {
	const collapsed = terminalSafe(text).replace(/\s+/g, " ").trim()
	return collapsed.length <= SUMMARY_MAX_CHARS ? collapsed : `${collapsed.slice(0, SUMMARY_MAX_CHARS - 1)}…`
}

/** Collapse to one line, bounded at the tail: streaming text is read for where it has got to. */
export function summarizeTail(text: string): string {
	const collapsed = terminalSafe(text).replace(/\s+/g, " ").trim()
	return collapsed.length <= SUMMARY_MAX_CHARS ? collapsed : `…${collapsed.slice(-(SUMMARY_MAX_CHARS - 1))}`
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value) ?? ""
	} catch {
		return String(value)
	}
}

// -- Stream normalization ---------------------------------------------------------------------------------

/**
 * One NDJSON stream event from a `pi --mode json` subprocess, as a {@link StepActivity}.
 *
 * The stream carries the harness's own extension events (modes/print-mode.js writes them all), but a
 * captured transcript may equally show the tool `tool_call`/`tool_result` pair — so both spellings
 * are accepted, field by field (`toolName` or `name`, `args` or `arguments`). Unknown lines return
 * `undefined`, exactly as the turn reader skips them: a real stream interleaves event types nobody
 * here needs, and an unrecognized one is a fact to ignore, not a parse failure.
 */
export function activityFromStreamEvent(
	event: unknown,
	identity: StepActivityIdentity,
	at: string,
): StepActivity | undefined {
	if (typeof event !== "object" || event === null) return undefined
	const record = event as Record<string, unknown>
	switch (record.type) {
		case "tool_execution_start":
		case "tool_call":
			return {
				...identity,
				at,
				kind: "tool-start",
				toolName: toolNameOf(record),
				summary: summarizeToolArguments(record.args ?? record.arguments),
			}
		case "tool_execution_end":
		case "tool_result":
			return {
				...identity,
				at,
				kind: "tool-end",
				toolName: toolNameOf(record),
				summary: summarizeToolResult(record.result ?? record.message),
				isError: record.isError === true,
			}
		case "message_end": {
			const text = assistantTextOf(record.message)
			return text ? { ...identity, at, kind: "assistant-text", summary: summarizeTail(text) } : undefined
		}
		default:
			return undefined
	}
}

function toolNameOf(record: Record<string, unknown>): string | undefined {
	const name = record.toolName ?? record.name
	return typeof name === "string" && name.length > 0 ? name : undefined
}

/** An assistant message's concatenated text — the one field of a `message_end` worth carrying live. */
function assistantTextOf(message: unknown): string {
	if (typeof message !== "object" || message === null) return ""
	if ((message as { role?: unknown }).role !== "assistant") return ""
	const content = (message as { content?: unknown }).content
	if (!Array.isArray(content)) return ""
	let text = ""
	for (const part of content as { type?: string; text?: string }[]) {
		if (part?.type === "text" && part.text) text += part.text
	}
	return text
}
