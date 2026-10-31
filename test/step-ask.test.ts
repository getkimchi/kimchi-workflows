/**
 * Follow-up questions to a step's conversation (inspection §14.13): one spawned-worker turn against the
 * same session file the navigator reads, claimed for its duration, with the answer reduced as it
 * arrives. The spawn itself is driven through the scripted-subagent fake, so the argv shape, the
 * stdin prompt, and the failure paths are all asserted offline.
 */
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { traceSessionFile } from "../src/host/naming.ts"
import { askStep } from "../src/host/step-ask.ts"
import { assistantLine, type SpawnRecord, scriptedSubagent } from "./fake-subagent.ts"

/** A throwaway session directory with the step's transcript file ALREADY recorded. */
function recordedConversation(): { dir: string; file: string } {
	const dir = path.join(tmpdir(), "pi-workflows-ask-")
	const made = mkdtempSync(dir)
	const file = path.join(made, traceSessionFile("audit", "workflow-audit-1a2b3c4d", "collect", 1))
	writeFileSync(file, "", "utf8")
	return { dir: made, file }
}

const BASE = {
	dir: "",
	workflowName: "audit",
	runId: "workflow-audit-1a2b3c4d",
	path: "collect",
	attempt: 1,
	invocationResolver: (args: readonly string[]) => ({ command: "kimchi", args }),
} as const

describe("askStep (inspection §14.13)", () => {
	it("spawns a worker against the step's session file, prompts over stdin, and returns the answer", async () => {
		const { dir } = recordedConversation()
		const { spawn, calls } = scriptedSubagent(`${assistantLine("It found two failing tests.", 900)}\n`)
		const answer = await askStep({ ...BASE, dir, spawnSubagent: spawn }, "what did the audit find?")
		expect(answer).toBe("It found two failing tests.")
		const call: SpawnRecord | undefined = calls[0]
		expect(call?.command).toBe("kimchi")
		expect(call?.args).toContain("--session")
		expect(call?.args[call.args.indexOf("--session") + 1]).toContain("workflow-audit") // the step's own file
		expect(call?.env?.KIMCHI_PERMISSIONS).toBe("yolo") // the spawned-worker posture (§2.2)
		expect(call?.child.stdin.chunks.join("")).toBe("what did the audit find?") // the question, over stdin
	})

	it("passes the declared model to the worker — the follow-up speaks to the model that built the conversation", async () => {
		const { dir } = recordedConversation()
		const { spawn, calls } = scriptedSubagent(`${assistantLine("ok", 10)}\n`)
		await askStep({ ...BASE, dir, spawnSubagent: spawn, model: "anthropic/claude" }, "again?")
		const args = calls[0]?.args ?? []
		expect(args).toContain("--model")
		expect(args[args.indexOf("--model") + 1]).toBe("anthropic/claude")
	})

	it("refuses when the step has no recorded conversation — there is nothing to ask", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pi-workflows-ask-empty-"))
		const { spawn } = scriptedSubagent("")
		await expect(askStep({ ...BASE, dir, spawnSubagent: spawn }, "hello?")).rejects.toThrow(/no conversation recorded/)
	})

	it("surfaces a failing worker with its stderr tail", async () => {
		const { dir } = recordedConversation()
		const { spawn } = scriptedSubagent("", { stderr: "provider unreachable", code: 3 })
		await expect(askStep({ ...BASE, dir, spawnSubagent: spawn }, "hello?")).rejects.toThrow(
			/exited with code 3.*provider unreachable/,
		)
	})

	it("refuses a silent worker — no answer is a failure, not a success with empty text", async () => {
		const { dir } = recordedConversation()
		const { spawn } = scriptedSubagent("")
		await expect(askStep({ ...BASE, dir, spawnSubagent: spawn }, "hello?")).rejects.toThrow(/ended without an answer/)
	})

	it("releases the claim when it ends — a second ask of the same step is welcome", async () => {
		const { dir } = recordedConversation()
		const { spawn } = scriptedSubagent(`${assistantLine("first", 1)}\n`)
		await askStep({ ...BASE, dir, spawnSubagent: spawn }, "one")
		await expect(askStep({ ...BASE, dir, spawnSubagent: spawn }, "two")).resolves.toBe("first")
	})

	it("does not hold the claim when the worker fails — the file is free again", async () => {
		const { dir } = recordedConversation()
		const failing = scriptedSubagent("", { code: 1 })
		await expect(askStep({ ...BASE, dir, spawnSubagent: failing.spawn }, "one")).rejects.toThrow()
		const healthy = scriptedSubagent(`${assistantLine("recovered", 1)}\n`)
		await expect(askStep({ ...BASE, dir, spawnSubagent: healthy.spawn }, "two")).resolves.toBe("recovered")
	})
})
