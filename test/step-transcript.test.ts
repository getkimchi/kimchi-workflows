/**
 * Step transcripts (inspection, specs/progress-ui.md §14): the writer that gives an in-session step a
 * sidecar under the same naming rule the isolated subprocess path already uses, the loader that reads
 * both shapes back through the harness's own session parser, and the pure renderer the live and
 * post-hoc views share.
 */
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { SessionEntry } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import { traceSessionFile } from "../src/host/naming.ts"
import {
	createStepTranscriptWriter,
	loadStepTranscript,
	renderStepSummary,
	renderStepTranscript,
	stepTranscriptFile,
} from "../src/host/step-transcript.ts"
import { agentRequest, tempSessionsDir } from "./helpers.ts"

/** A throwaway directory; the real host binds the harness's own session dir's `workflow/` subdir. */
const dir = tempSessionsDir()

describe("createStepTranscriptWriter + loadStepTranscript (inspection §14)", () => {
	it("appends one entry per message under the trace name, with a session header, and reads back", () => {
		const request = agentRequest({ stepName: "inline" })
		const writer = createStepTranscriptWriter(dir, request)
		writer.appendMessage({
			role: "custom",
			customType: "kimchi-workflow-agent",
			content: "do the work",
			display: false,
		})
		writer.appendMessage({
			role: "assistant",
			content: [
				{ type: "text", text: "on it" },
				{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } },
			],
			usage: { totalTokens: 42 },
		})
		writer.appendMessage({ role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "12 passed" }] })

		const expectedFile = path.join(dir, traceSessionFile("test", request.runId, "inline", 1))
		const load = loadStepTranscript({
			dir,
			workflowName: "test",
			runId: request.runId,
			path: "inline",
			attempt: 1,
		})
		expect(load).toMatchObject({ ok: true, file: expectedFile })
		if (!load.ok) return
		// The header is filtered out by the loader; the four conversation records survive, and the
		// prompt is a custom_message entry exactly as the harness itself would persist it.
		expect(load.entries.map((entry) => entry.type)).toEqual(["custom_message", "message", "message"])
	})

	it("continues appending across turns of one session without rewriting the header", () => {
		const request = agentRequest({ stepName: "multi" })
		const writer = createStepTranscriptWriter(dir, request)
		writer.appendMessage({ role: "custom", customType: "kimchi-workflow-agent", content: "first", display: false })
		writer.appendMessage({ role: "assistant", content: [{ type: "text", text: "one" }] })
		writer.appendMessage({ role: "custom", customType: "kimchi-workflow-agent", content: "second", display: false })
		writer.appendMessage({ role: "assistant", content: [{ type: "text", text: "two" }] })

		const load = loadStepTranscript({
			dir,
			workflowName: "test",
			runId: request.runId,
			path: "multi",
			attempt: 1,
		})
		expect(load.ok).toBe(true)
		if (load.ok) expect(load.entries).toHaveLength(4)
	})

	it("continues a KEYED file's chain across executions — the second writer parents to the last entry", () => {
		const first = agentRequest({ stepName: "worker", resumeKey: "worker" })
		createStepTranscriptWriter(dir, first).appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "first execution" }],
		})
		// A later execution of the same key opens its own writer on the SAME file (that is what
		// resuming continues): its first entry must parent to the previous leaf, not start a second root.
		const second = agentRequest({ stepName: "worker", resumeKey: "worker", attempt: 2 })
		createStepTranscriptWriter(dir, second).appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "second execution" }],
		})

		const load = loadStepTranscript({
			dir,
			workflowName: "test",
			runId: second.runId,
			path: "worker",
			attempt: 2,
			resumeKey: "worker",
		})
		expect(load.ok).toBe(true)
		if (!load.ok) return
		const entries = load.entries as unknown as { id: string; parentId: string | null }[]
		expect(entries).toHaveLength(2)
		expect(entries[0]?.parentId).toBeNull()
		expect(entries[1]?.parentId).toBe(entries[0]?.id) // one chain, not two roots mid-file
	})

	it("names a resumable step's sidecar by its key — the same file every execution", () => {
		const request = agentRequest({ stepName: "worker", resumeKey: "worker" })
		createStepTranscriptWriter(dir, request).appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
		})

		const load = loadStepTranscript({
			dir,
			workflowName: "test",
			runId: request.runId,
			path: "worker",
			attempt: 1,
			resumeKey: "worker",
		})
		expect(load.ok).toBe(true)
		expect(load.ok && load.file).toContain("-key-worker.jsonl")
		// Without the key the same execution's trace name does not exist — a reader that guesses wrong
		// finds nothing, which is what makes the naming rule load-bearing.
		const wrong = loadStepTranscript({
			dir,
			workflowName: "test",
			runId: request.runId,
			path: "worker",
			attempt: 1,
		})
		expect(wrong).toMatchObject({ ok: false, reason: "missing" })
	})

	it("reports the first write failure once, then stays silent for the rest of the session", () => {
		const blocker = mkdtempSync(path.join(tmpdir(), "pi-workflows-blocked-"))
		const notADir = path.join(blocker, "occupied")
		writeFileSync(notADir, "a file, not a directory", "utf8") // mkdir under it must fail

		const onError = vi.fn()
		const writer = createStepTranscriptWriter(path.join(notADir, "workflow"), agentRequest({ stepName: "x" }), onError)
		writer.appendMessage({ role: "assistant", content: [{ type: "text", text: "one" }] })
		writer.appendMessage({ role: "assistant", content: [{ type: "text", text: "two" }] })

		expect(onError).toHaveBeenCalledTimes(1)
	})

	it("reports a missing file as a miss, never a throw", () => {
		const load = loadStepTranscript({
			dir,
			workflowName: "test",
			runId: "workflow-test-00000000",
			path: "never",
			attempt: 1,
		})
		expect(load).toMatchObject({ ok: false, reason: "missing" })
	})
})

describe("renderStepTranscript (inspection §14)", () => {
	/** A small but complete execution: prompt, an assistant tool call, its result, and a final text. */
	// Fixtures are SHAPES, not full provider messages; the renderer reads them structurally.
	const entries = [
		{
			type: "custom_message",
			customType: "kimchi-workflow-agent",
			content: "Run the tests and fix any failures",
			display: false,
			id: "1",
			parentId: null,
			timestamp: "2026-10-30T00:00:00.000Z",
		},
		{
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } }],
				usage: { totalTokens: 800 },
			},
			id: "2",
			parentId: "1",
			timestamp: "2026-10-30T00:00:01.000Z",
		},
		{
			type: "message",
			message: { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "12 passed, 0 failed" }] },
			id: "3",
			parentId: "2",
			timestamp: "2026-10-30T00:00:05.000Z",
		},
		{
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "All green — no fix needed." }],
				usage: { totalTokens: 1200 },
			},
			id: "4",
			parentId: "3",
			timestamp: "2026-10-30T00:00:06.000Z",
		},
	] as unknown as SessionEntry[]

	it("renders one aligned block per message: prompt, tool call, result, assistant text with its cost", () => {
		expect(renderStepTranscript(entries, { width: 60 })).toEqual([
			"  ● prompt     Run the tests and fix any failures",
			"  → bash       npm test · 800 tok",
			"  ← bash       12 passed, 0 failed",
			"  ● assistant  All green — no fix needed. · 1.2k tok",
		])
	})

	it("marks an errored tool result and falls back to `tool` when the call is not in view", () => {
		const failing = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "unknown",
					content: [{ type: "text", text: "boom" }],
					isError: true,
				},
				id: "1",
				parentId: null,
				timestamp: "2026-10-30T00:00:00.000Z",
			},
		] as unknown as SessionEntry[]
		expect(renderStepTranscript(failing, { width: 60 })).toEqual(["  ←! tool       boom"])
	})

	it("wraps long text to the content column rather than truncating it", () => {
		const long = [
			{
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "word ".repeat(30).trim() }] },
				id: "1",
				parentId: null,
				timestamp: "2026-10-30T00:00:00.000Z",
			},
		] as unknown as SessionEntry[]
		const lines = renderStepTranscript(long, { width: 40 }) // content column: 40 - 15 = 25
		expect(lines.length).toBeGreaterThan(1)
		for (const line of lines) expect(line.length).toBeLessThanOrEqual(40)
		// The continuation lines line up under the first line's content, not under its glyph.
		expect(lines[1]).toMatch(/^ {15}word/)
	})

	it("caps at maxLines with one summary line for what was dropped", () => {
		const many = renderStepTranscript(entries, { width: 60, maxLines: 2 })
		expect(many).toEqual(["  ● prompt     Run the tests and fix any failures", "… +3 more lines"])
	})

	it("renders nothing for an empty transcript", () => {
		expect(renderStepTranscript([])).toEqual([])
	})

	it("strips control bytes from message text — the renderer feeds a terminal surface directly", () => {
		const poisoned = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "hi \u001b]52;c;aGF4ZWQ=\u0007 there \u001b[31mred\u001b[0m" },
						{ type: "toolCall", id: "c1", name: "ba\u001b[2Jsh", arguments: { command: "echo" } },
					],
				},
				id: "1",
				parentId: null,
				timestamp: "2026-10-30T00:00:00.000Z",
			},
			{
				type: "message",
				message: { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "out\u0007" }] },
				id: "2",
				parentId: "1",
				timestamp: "2026-10-30T00:00:01.000Z",
			},
		] as unknown as SessionEntry[]
		const lines = renderStepTranscript(poisoned, { width: 80 })
		expect(lines.some((line) => line.includes("\u001b") || line.includes("\u0007"))).toBe(false)
		expect(lines[0]).toContain("hi ]52;c;aGF4ZWQ= there [31mred[0m")
		// The LABEL column too — a tool name read back off disk is as untrusted as its output: the
		// ESC is gone, the printable remains.
		expect(lines.some((line) => line.includes("ba[2Jsh") && line.includes("echo"))).toBe(true)
	})
})

describe("renderStepSummary — the step view's default (inspection §14.11)", () => {
	/** The same complete execution as the full view's fixture, plus a longer history to tail. */
	const entry = (body: Record<string, unknown>, id: string, parentId: string, at: string): SessionEntry =>
		({ type: "message", message: body, id, parentId, timestamp: at }) as unknown as SessionEntry

	const prompt = {
		type: "custom_message",
		customType: "kimchi-workflow-agent",
		content: "Run the audit and collect the facts\nwith care",
		display: false,
		id: "1",
		parentId: null,
		timestamp: "2026-10-30T00:00:00.000Z",
	} as unknown as SessionEntry

	it("shows the prompt's first line, the tool tail with paired durations, and the assistant tail", () => {
		const feed = renderStepSummary(
			[
				prompt,
				entry(
					{
						role: "assistant",
						content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } }],
					},
					"2",
					"1",
					"2026-10-30T00:00:01.000Z",
				),
				entry(
					{ role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "12 passed" }] },
					"3",
					"2",
					"2026-10-30T00:00:05.000Z",
				),
				entry(
					{ role: "assistant", content: [{ type: "text", text: "All green." }] },
					"4",
					"3",
					"2026-10-30T00:00:06.000Z",
				),
			],
			{ width: 60, hint: "enter: full detail · esc: close" },
		)
		expect(feed).toEqual([
			"  ● prompt     Run the audit and collect the facts", // first line only — the rest is a drill-down away
			"  → bash       npm test",
			"  ← bash       12 passed · 4.0s", // paired from the two entries' timestamps
			"  ● assistant  All green.",
			"enter: full detail · esc: close",
		])
	})

	it("keeps the tail of long tool activity and reports the calls behind it", () => {
		const busy = [prompt]
		let id = 1
		let parent = "1"
		let at = 1
		for (let call = 1; call <= 5; call++) {
			const callId = `c${call}`
			busy.push(
				entry(
					{
						role: "assistant",
						content: [{ type: "toolCall", id: callId, name: "bash", arguments: { command: `cmd-${call}` } }],
					},
					`${++id}`,
					parent,
					new Date(Date.parse("2026-10-30T00:00:00.000Z") + at++ * 1000).toISOString(),
				),
			)
			parent = String(id)
			busy.push(
				entry(
					{ role: "toolResult", toolCallId: callId, content: [{ type: "text", text: `out-${call}` }] },
					`${++id}`,
					parent,
					new Date(Date.parse("2026-10-30T00:00:00.000Z") + at++ * 1000).toISOString(),
				),
			)
			parent = String(id)
		}
		busy.push(
			entry(
				{ role: "assistant", content: [{ type: "text", text: "done" }] },
				`${++id}`,
				parent,
				"2026-10-30T00:00:59.000Z",
			),
		)

		const feed = renderStepSummary(busy as unknown as SessionEntry[], { width: 60 })
		expect(feed).toHaveLength(6 /* default toolLines */ + 2 /* prompt + assistant */ + 1 /* counts */)
		expect(feed.some((line) => line.includes("cmd-1"))).toBe(false) // the oldest call fell out of the tail
		expect(feed.some((line) => line.includes("cmd-5"))).toBe(true) // the newest stayed
		expect(feed.at(-1)).toContain("+2 more tool calls") // two calls dropped, in calls — not lines
	})

	it("bounds the assistant tail and marks the cut", () => {
		const chatty = [
			prompt,
			entry(
				{
					role: "assistant",
					content: [
						{ type: "text", text: ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"].join("\n") },
					],
				},
				"2",
				"1",
				"2026-10-30T00:00:01.000Z",
			),
		]
		const feed = renderStepSummary(chatty as unknown as SessionEntry[], { width: 60 })
		expect(feed.some((line) => line.includes("one"))).toBe(false) // the head is gone
		expect(feed.some((line) => line.includes("… six"))).toBe(true) // the tail begins, marked
		expect(feed.some((line) => line.includes("nine"))).toBe(true)
	})

	it("says so when nothing was recorded", () => {
		expect(renderStepSummary([], { width: 60 })).toEqual(["(nothing recorded yet)"])
	})
})

describe("bounded full view (inspection §14.11)", () => {
	const long = (lines: number, prefix: string): string =>
		Array.from({ length: lines }, (_, index) => `${prefix}-${index + 1}`).join("\n")

	it("bounds the prompt's head and the assistant text's tail with honest markers", () => {
		const bounded = renderStepTranscript(
			[
				{
					type: "custom_message",
					customType: "kimchi-workflow-agent",
					content: long(14, "line"),
					display: false,
					id: "1",
					parentId: null,
					timestamp: "2026-10-30T00:00:00.000Z",
				},
				{
					type: "message",
					message: { role: "assistant", content: [{ type: "text", text: long(14, "note") }] },
					id: "2",
					parentId: "1",
					timestamp: "2026-10-30T00:00:01.000Z",
				},
			] as unknown as SessionEntry[],
			{ width: 60, bounded: true },
		)
		// The prompt keeps its head (the instruction) and says what was cut.
		expect(bounded.some((line) => /\bline-1\b/.test(line))).toBe(true)
		expect(bounded.some((line) => /\bline-11\b/.test(line))).toBe(false)
		expect(bounded.some((line) => line.includes("+4 more lines"))).toBe(true)
		// The assistant text keeps its tail (the latest state) and says what is above.
		expect(bounded.some((line) => /\bnote-1\b/.test(line))).toBe(false)
		expect(bounded.some((line) => /\bnote-14\b/.test(line))).toBe(true)
		expect(bounded.some((line) => line.includes("+6 lines above"))).toBe(true)
	})

	it("leaves short blocks whole — a bound must not cut what fits", () => {
		const bounded = renderStepTranscript(
			[
				{
					type: "custom_message",
					customType: "kimchi-workflow-agent",
					content: "short prompt",
					display: false,
					id: "1",
					parentId: null,
					timestamp: "2026-10-30T00:00:00.000Z",
				},
			],
			{ width: 60, bounded: true },
		)
		expect(bounded).toEqual(["  ● prompt     short prompt"])
	})
})

describe("stepTranscriptFile naming (inspection §14)", () => {
	it("follows the isolated path's rule: keyed when resumable, per-execution trace otherwise", () => {
		const base = { workflowName: "test", runId: "workflow-test-1a2b3c4d", path: "build", attempt: 2 }
		expect(path.basename(stepTranscriptFile("/d", base))).toBe(
			traceSessionFile("test", "workflow-test-1a2b3c4d", "build", 2),
		)
		expect(path.basename(stepTranscriptFile("/d", { ...base, resumeKey: "build" }))).toBe(
			"workflow-test-key-build.jsonl",
		)
	})
})

describe("torn-tail tolerance (review round 3)", () => {
	it("continues the chain from the last PARSEABLE entry when the file's tail is torn", async () => {
		const request = agentRequest({ stepName: "torn", resumeKey: "torn" })
		const writer = createStepTranscriptWriter(dir, request)
		writer.appendMessage({ role: "assistant", content: [{ type: "text", text: "good entry" }] })

		// A crash mid-append leaves a torn line; a second writer must skip it and parent to the last
		// good entry — not fork the chain back at its root.
		const file = stepTranscriptFile(dir, {
			workflowName: "test",
			runId: request.runId,
			path: "torn",
			attempt: 1,
			resumeKey: "torn",
		})
		const { appendFileSync } = await import("node:fs")
		appendFileSync(file, '{"type":"message","id":"torn","pare')

		const second = createStepTranscriptWriter(dir, { ...request, attempt: 2 })
		second.appendMessage({ role: "assistant", content: [{ type: "text", text: "after the tear" }] })

		const load = loadStepTranscript({
			dir,
			workflowName: "test",
			runId: request.runId,
			path: "torn",
			attempt: 2,
			resumeKey: "torn",
		})
		expect(load.ok).toBe(true) // the tear costs the entries after it on READ — PI's own parser's bound

		// The chain itself is what round 3 pinned: read the RAW lines and assert the continuation
		// parented to the last PARSEABLE entry, not to a second root.
		const raw = (await import("node:fs"))
			.readFileSync(file, "utf8")
			.split("\n")
			.filter((line) => line.trim())
		const parsed = raw
			.map((line) => {
				try {
					return JSON.parse(line) as { type?: string; id?: string; parentId?: string | null }
				} catch {
					return null // the torn line
				}
			})
			.filter(
				(entry): entry is { type?: string; id: string; parentId: string | null } =>
					entry !== null && entry.type === "message",
			)
		expect(parsed.length).toBe(2)
		expect(parsed[0]?.parentId).toBeNull()
		expect(parsed[1]?.parentId).toBe(parsed[0]?.id) // one chain, the tear notwithstanding
	})
})
