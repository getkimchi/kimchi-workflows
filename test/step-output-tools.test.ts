/**
 * The child-process half of the output-tool contract: the schema handoff a spawned step is given, the
 * registration it performs from it, and the bridge wiring that produces the handoff in the first place.
 */
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { describe, expect, it, vi } from "vitest"
import { SUBMIT_QUESTIONS_TOOL, SUBMIT_RESULT_TOOL } from "../src/engine/output-tools.ts"
import { createPiAgentBridge, inheritedExtensionArgs } from "../src/host/pi-agent.ts"
import type { ModelRegistry } from "../src/host/pi-agent-messages.ts"
import {
	readStepOutputToolSpec,
	registerStepOutputTools,
	registerStepOutputToolsFromEnv,
	STEP_OUTPUT_TOOLS_ENV,
	writeStepOutputToolSpec,
} from "../src/host/step-output-tools.ts"
import { assistantLine, fakeSubagentSpawner, scriptedSubagent } from "./fake-subagent.ts"
import { agentRequest, tempSessionsDir } from "./helpers.ts"

const outputSchema = Type.Object({ grade: Type.String() })
const scratch = () => mkdtempSync(path.join(tmpdir(), "step-output-tools-"))

function fakePi() {
	const registerTool = vi.fn()
	return { pi: { registerTool, on: () => {} } as unknown as ExtensionAPI, registerTool }
}

// --- the handoff ----------------------------------------------------------

describe("the schema handoff a spawned step is given", () => {
	it("round-trips the step's schema through the file", () => {
		const dir = scratch()
		const file = writeStepOutputToolSpec(dir, "step", { outputSchema, asks: true })

		expect(readStepOutputToolSpec(file)).toEqual({ outputSchema, asks: true })
	})

	it("returns undefined rather than throwing on a missing or corrupt handoff", () => {
		const dir = scratch()
		const corrupt = path.join(dir, "corrupt.json")
		writeFileSync(corrupt, "{not json", "utf8")

		expect(readStepOutputToolSpec(path.join(dir, "absent.json"))).toBeUndefined()
		expect(readStepOutputToolSpec(corrupt)).toBeUndefined()
		// A handoff that parses but carries no schema is not a handoff.
		writeFileSync(corrupt, JSON.stringify({ asks: true }), "utf8")
		expect(readStepOutputToolSpec(corrupt)).toBeUndefined()
	})
})

// --- registration ---------------------------------------------------------

describe("registration inside a spawned step", () => {
	it("registers submit_result typed by the step's own schema", () => {
		const { pi, registerTool } = fakePi()
		registerStepOutputTools(pi, { outputSchema })

		expect(registerTool).toHaveBeenCalledTimes(1)
		const tool = registerTool.mock.calls[0]?.[0] as {
			name: string
			parameters: { properties: Record<string, unknown> }
		}
		expect(tool.name).toBe(SUBMIT_RESULT_TOOL)
		expect(tool.parameters.properties.result).toEqual(outputSchema)
	})

	it("offers submit_questions only to a step that can block", () => {
		const asking = fakePi()
		registerStepOutputTools(asking.pi, { outputSchema, asks: true })
		expect(asking.registerTool.mock.calls.map((c) => (c[0] as { name: string }).name)).toEqual([
			SUBMIT_RESULT_TOOL,
			SUBMIT_QUESTIONS_TOOL,
		])

		const plain = fakePi()
		registerStepOutputTools(plain.pi, { outputSchema })
		expect(plain.registerTool.mock.calls.map((c) => (c[0] as { name: string }).name)).toEqual([SUBMIT_RESULT_TOOL])
	})

	it("terminates PI after either submission without carrying the payload — the transcript does that", async () => {
		const { pi, registerTool } = fakePi()
		registerStepOutputTools(pi, { outputSchema, asks: true })
		const tools = new Map(
			registerTool.mock.calls.map((call) => {
				const tool = call[0] as {
					name: string
					execute: () => Promise<{ content: unknown[]; terminate?: boolean }>
				}
				return [tool.name, tool] as const
			}),
		)

		for (const name of [SUBMIT_RESULT_TOOL, SUBMIT_QUESTIONS_TOOL]) {
			await expect(tools.get(name)?.execute()).resolves.toMatchObject({
				content: [{ type: "text" }],
				terminate: true,
			})
		}
	})

	it("registers nothing in an ordinary session, which is not a step", () => {
		const { pi, registerTool } = fakePi()

		expect(registerStepOutputToolsFromEnv(pi, {})).toBe(false)
		expect(registerTool).not.toHaveBeenCalled()
	})

	it("still reports a step child when the handoff cannot be read, so it never becomes a workflow host", () => {
		const { pi, registerTool } = fakePi()
		const env = { [STEP_OUTPUT_TOOLS_ENV]: path.join(scratch(), "absent.json") }
		const errors = vi.spyOn(console, "error").mockImplementation(() => {})

		// The handoff NAMED this process as a step, so it is one. Returning false would let it register
		// `/workflow` and start a nested run inside the run it belongs to.
		expect(registerStepOutputToolsFromEnv(pi, env)).toBe(true)
		expect(registerTool).not.toHaveBeenCalled()
		expect(errors).toHaveBeenCalledWith(expect.stringContaining("missing or unreadable"))
		errors.mockRestore()
	})

	it("registers from the environment when this process IS a spawned step", () => {
		const { pi, registerTool } = fakePi()
		const file = writeStepOutputToolSpec(scratch(), "step", { outputSchema })

		expect(registerStepOutputToolsFromEnv(pi, { [STEP_OUTPUT_TOOLS_ENV]: file })).toBe(true)
		expect(registerTool).toHaveBeenCalledTimes(1)
	})

	it("consumes the handoff, so a process the step itself launches does not inherit it", () => {
		const file = writeStepOutputToolSpec(scratch(), "step", { outputSchema })
		const env = { [STEP_OUTPUT_TOOLS_ENV]: file }

		expect(registerStepOutputToolsFromEnv(fakePi().pi, env)).toBe(true)
		expect(env[STEP_OUTPUT_TOOLS_ENV]).toBeUndefined()

		// A descendant inheriting that environment is an ordinary session: tools stay off, /workflow stays on.
		const descendant = fakePi()
		expect(registerStepOutputToolsFromEnv(descendant.pi, env)).toBe(false)
		expect(descendant.registerTool).not.toHaveBeenCalled()
	})
})

describe("inheritedExtensionArgs", () => {
	it("normalises both spellings to the short form the child is spawned with", () => {
		expect(inheritedExtensionArgs(["node", "kimchi", "-e", "a", "--extension", "b", "--extension=c"])).toEqual([
			"-e",
			"a",
			"-e",
			"b",
			"-e",
			"c",
		])
	})

	it("forwards nothing when the parent named no extension", () => {
		expect(inheritedExtensionArgs(["node", "kimchi", "--model", "kimchi-dev/kimi-k2.7"])).toEqual([])
	})

	it("never consumes a following flag as an extension spec", () => {
		expect(inheritedExtensionArgs(["node", "kimchi", "-e"])).toEqual([])
	})
})

// --- the bridge produces the handoff --------------------------------------

describe("the background bridge hands the contract to the child", () => {
	const sessionsDir = tempSessionsDir()
	const noopPi = { on: () => {} } as unknown as ExtensionAPI
	const fixedResolver = (args: readonly string[]) => ({ command: "pi", args })
	const registry = { find: () => undefined } as unknown as ModelRegistry

	async function spawnStep(request: Parameters<typeof agentRequest>[0]) {
		const { spawn, calls } = scriptedSubagent([assistantLine("ok", 1), ""].join("\n"))
		const startAgent = createPiAgentBridge(noopPi, fixedResolver, spawn)(registry, sessionsDir)
		await startAgent(agentRequest(request)).sendAndAwaitEnd("go")
		return calls[0]
	}

	it("passes a handoff the child can read at the moment it starts", async () => {
		// Read from inside the spawn: the handoff is deleted once the child has had it, so asserting after
		// the run would only prove the cleanup ran.
		let seen: unknown
		const { spawn, calls } = fakeSubagentSpawner((child, call) => {
			const file = call.env?.[STEP_OUTPUT_TOOLS_ENV]
			seen = file ? readStepOutputToolSpec(file) : undefined
			child.write([assistantLine("ok", 1), ""].join("\n"))
			void child.exit(0)
		})
		const startAgent = createPiAgentBridge(noopPi, fixedResolver, spawn)(registry, sessionsDir)
		await startAgent(agentRequest({ stepName: "bg", background: true, outputSchema, asks: true })).sendAndAwaitEnd("go")

		expect(seen).toEqual({ outputSchema, asks: true })
		expect(calls[0]?.env?.[STEP_OUTPUT_TOOLS_ENV]).toBeTruthy()
	})

	it("deletes the handoff once the child has started, leaving nothing beside the user's sessions", async () => {
		const call = await spawnStep({ stepName: "bg", background: true, outputSchema })

		const file = call?.env?.[STEP_OUTPUT_TOOLS_ENV] as string
		expect(file).toBeTruthy()
		expect(existsSync(file)).toBe(false)
	})

	it("gives concurrent items of one resumable step distinct handoffs", async () => {
		// `resumable` names ONE session file for every execution; two `.foreach` items sharing a handoff
		// would let writeFileSync's truncate hand a sibling an empty read.
		const first = await spawnStep({
			stepName: "worker",
			isolated: true,
			resumeKey: "worker",
			path: "items@0/worker",
			outputSchema,
		})
		const second = await spawnStep({
			stepName: "worker",
			isolated: true,
			resumeKey: "worker",
			path: "items@1/worker",
			outputSchema,
		})

		expect(first?.env?.[STEP_OUTPUT_TOOLS_ENV]).not.toBe(second?.env?.[STEP_OUTPUT_TOOLS_ENV])
	})

	it("passes no handoff for a step with no output contract", async () => {
		const call = await spawnStep({ stepName: "bg", background: true })

		expect(call?.env).toBeUndefined()
	})

	it("forwards the parent's own -e flags only when there are tools to register", async () => {
		const argv = [...process.argv]
		process.argv = ["node", "kimchi", "-e", "npm:@kimchi-dev/kimchi-workflows"]
		try {
			const withTools = await spawnStep({ stepName: "bg", background: true, outputSchema })
			expect(withTools?.args).toContain("npm:@kimchi-dev/kimchi-workflows")

			const withoutTools = await spawnStep({ stepName: "bg", background: true })
			expect(withoutTools?.args).not.toContain("npm:@kimchi-dev/kimchi-workflows")
		} finally {
			process.argv = argv
		}
	})
})
