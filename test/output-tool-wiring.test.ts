/**
 * The wiring that makes the output-tool contract reach a model at all.
 *
 * Every assertion here exists because a mutation survived the rest of the suite: deleting the
 * `outputSchema` passthrough, or the in-session registration, or the engine's non-`asks` guard, left the
 * whole suite green while breaking every real run. The doubles cannot see any of this — they answer from
 * the step definition, never from the request — so it is asserted directly against the seam.
 */
import type { AgentEndEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { describe, expect, it } from "vitest"
import { buildCorrectionMessage } from "../src/engine/agent-output.ts"
import { isOutputToolName, SUBMIT_QUESTIONS_TOOL, SUBMIT_RESULT_TOOL } from "../src/engine/output-tools.ts"
import { runWorkflow } from "../src/engine/run-workflow.ts"
import type { AgentRequest, AgentSession } from "../src/engine/types.ts"
import { createAgentStep, createWorkflow } from "../src/flow/index.ts"
import { buildAskingProtocol, buildOutputProtocol } from "../src/flow/questionnaire.ts"
import { createPiAgentBridge } from "../src/host/pi-agent.ts"
import type { ModelRegistry } from "../src/host/pi-agent-messages.ts"
import { ask, createAgentDouble, createTestRun, raw, reply } from "../src/testing/index.ts"
import { createTestHost } from "./helpers.ts"

const outputSchema = Type.Object({ grade: Type.String() })

// --- the engine hands the contract to the host ----------------------------

describe("the step's contract reaches the host", () => {
	async function capture(step: ReturnType<typeof createAgentStep>) {
		const seen: AgentRequest[] = []
		const startAgent = (request: AgentRequest): AgentSession => {
			seen.push(request)
			return {
				async sendAndAwaitEnd() {
					return { text: "", submitted: { tool: SUBMIT_RESULT_TOOL, arguments: { result: { grade: "A" } } } }
				},
				getConversation: () => [],
				dispose: () => {},
			}
		}
		const workflow = createWorkflow({ name: "wiring" }).then(step).commit()
		const { host } = createTestHost({ startAgent })
		await runWorkflow(workflow, undefined, host)
		return seen[0]
	}

	it("passes outputSchema and asks on the request — a spawned step has no other way to type its tool", async () => {
		const request = await capture(
			createAgentStep({ name: "grade", output: outputSchema, asks: true, prompt: () => "go" }),
		)

		expect(request?.outputSchema).toEqual(outputSchema)
		expect(request?.asks).toBe(true)
	})

	it("passes no schema for a step that declares no contract", async () => {
		const request = await capture(createAgentStep({ name: "grade", prompt: () => "go" }))

		expect(request?.outputSchema).toBeUndefined()
	})
})

// --- the in-session bridge registers and scopes the tools -----------------

describe("the in-session bridge registers the tools it promises", () => {
	function fakePi(options: { autoEnd?: boolean } = {}) {
		const registered: { name: string; parameters: unknown }[] = []
		let active: string[] = ["bash", "read"]
		let endHandler: ((event: AgentEndEvent) => void) | undefined
		const pi = {
			on: (event: string, h: (e: AgentEndEvent) => void) => {
				if (event === "agent_end") endHandler = h
			},
			sendMessage: () => {
				if (options.autoEnd === false) return
				endHandler?.({
					type: "agent_end",
					messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }], usage: { totalTokens: 1 } }],
				} as unknown as AgentEndEvent)
			},
			setModel: async () => true,
			// Mirrors pi's own loader: registerTool() calls refreshTools(), which makes the new tool ACTIVE.
			// That is what puts an output tool into the next step's baseline read, and why the baseline is
			// filtered rather than trusted.
			registerTool: (tool: { name: string; parameters: unknown }) => {
				registered.push(tool)
				if (!active.includes(tool.name)) active.push(tool.name)
			},
			getActiveTools: () => [...active],
			setActiveTools: (names: string[]) => {
				active = [...names]
			},
		} as unknown as ExtensionAPI
		const registry = { find: () => undefined } as unknown as ModelRegistry
		return {
			pi,
			registered,
			active: () => active,
			enable: (name: string) => active.push(name),
			start: createPiAgentBridge(pi)(registry, "/tmp/wiring"),
		}
	}

	const request = (over: Partial<AgentRequest>): AgentRequest =>
		({
			stepName: "s",
			runId: "r",
			workflowName: "w",
			path: "s",
			attempt: 1,
			...over,
		}) as AgentRequest

	it("registers workflow_submit_result typed by THIS step's schema before sending the prompt", async () => {
		const { registered, start } = fakePi()
		await start(request({ outputSchema })).sendAndAwaitEnd("go")

		const tool = registered.find((t) => t.name === SUBMIT_RESULT_TOOL)
		expect(tool).toBeTruthy()
		const parameters = tool?.parameters as { properties: Record<string, unknown> }
		expect(parameters.properties.result).toEqual(outputSchema)
	})

	it("offers workflow_submit_questions only while an asking step is running", async () => {
		const { active, start } = fakePi()

		const asking = start(request({ outputSchema, asks: true }))
		await asking.sendAndAwaitEnd("go")
		expect(active()).toContain(SUBMIT_QUESTIONS_TOOL)
		asking.dispose()

		// A later non-asking step must not inherit it: the engine rejects the call, and the step would burn
		// its whole repair budget on a tool the framework itself put in front of the model.
		const plain = start(request({ outputSchema }))
		await plain.sendAndAwaitEnd("go")
		expect(active()).toContain(SUBMIT_RESULT_TOOL)
		expect(active()).not.toContain(SUBMIT_QUESTIONS_TOOL)
	})

	it("hides workflow_submit_result from a step with no contract, whose output IS its text", async () => {
		// Mirrors the engine, which disposes each step's session in a `finally` before the next one starts.
		const { active, start } = fakePi()
		const contract = start(request({ outputSchema }))
		await contract.sendAndAwaitEnd("go")
		contract.dispose()

		const contractFree = start(request({ stepName: "act" }))
		await contractFree.sendAndAwaitEnd("go")
		expect(active()).not.toContain(SUBMIT_RESULT_TOOL)
	})

	it("does not carry one run's baseline into the next — the bridge outlives every run", async () => {
		const { active, start, enable } = fakePi()
		const runOne = start(request({ outputSchema }))
		await runOne.sendAndAwaitEnd("go")
		runOne.dispose()

		// Between runs the user turns something on. A bridge-scoped baseline would revert it.
		enable("write")

		const runTwo = start(request({ outputSchema }))
		await runTwo.sendAndAwaitEnd("go")
		expect(active()).toContain("write")
		runTwo.dispose()
		expect(active()).toEqual(["bash", "read", "write"])
	})

	it("a session rejected by the cross-talk guard cannot strip tools from the turn in flight", async () => {
		const { active, start } = fakePi({ autoEnd: false })
		const live = start(request({ stepName: "a", outputSchema, asks: true }))
		void live.sendAndAwaitEnd("go") // never settles: no agent_end fired
		expect(active()).toContain(SUBMIT_QUESTIONS_TOOL)

		const rejected = start(request({ stepName: "b", outputSchema }))
		await expect(rejected.sendAndAwaitEnd("go")).rejects.toThrow(/in flight/)
		rejected.dispose() // registered nothing, so must restore nothing

		expect(active()).toContain(SUBMIT_QUESTIONS_TOOL)
	})

	it("re-captures a baseline that already carries the tools, rather than baking them in", async () => {
		// pi's own registerTool appends the new name to the ACTIVE set, so by the time a later step reads
		// the baseline it may already contain workflow_submit_result. Treating that as "the user had it" would leave
		// the tool active for every later step and hand it back to the user on dispose.
		const { active, start } = fakePi()
		const first = start(request({ outputSchema }))
		await first.sendAndAwaitEnd("go")
		first.dispose()
		expect(active()).toEqual(["bash", "read"])

		// The second step's baseline read now sees the tool registration made moments earlier.
		const second = start(request({ outputSchema, asks: true }))
		await second.sendAndAwaitEnd("go")
		second.dispose()

		expect(active()).toEqual(["bash", "read"])
	})

	it("hands the session back as it found it", async () => {
		const { active, start } = fakePi()
		const session = start(request({ outputSchema, asks: true }))
		await session.sendAndAwaitEnd("go")
		session.dispose()

		expect(active()).toEqual(["bash", "read"])
	})

	it("leaves a contract-free workflow's tools untouched entirely", async () => {
		const { active, registered, start } = fakePi()
		await start(request({ stepName: "act" })).sendAndAwaitEnd("go")

		expect(registered).toEqual([])
		expect(active()).toEqual(["bash", "read"])
	})
})

// --- instructions the model is given --------------------------------------

describe("what the model is told", () => {
	it("names only tools the engine actually reads", () => {
		// A prompt naming a tool the engine ignores is the failure output-tool-names.ts exists to prevent:
		// the model complies, the engine sees no submission, and the step fails blaming the model.
		for (const protocol of [buildOutputProtocol(outputSchema), buildAskingProtocol(outputSchema)]) {
			for (const named of protocol.match(/`(submit|emit|report)_[a-z_]+`/g) ?? []) {
				expect(isOutputToolName(named.replaceAll("`", ""))).toBe(true)
			}
		}
	})

	it("tells a resumed step to submit through a tool, not to reply in text", async () => {
		// The answer message is the LAST thing the model reads before responding, so it decides the channel.
		const asking = createAgentStep({ name: "elicit", output: outputSchema, asks: true, prompt: () => "go" })
		const workflow = createWorkflow({ name: "resume-instruction" }).then(asking).commit()
		const questionnaire = {
			questions: [{ key: "grade", header: "Grade", kind: "text" as const, question: "Which grade?" }],
		}
		const blocked = await createTestRun(workflow, { agents: { elicit: [ask(questionnaire), reply({ grade: "A" })] } })
		const done = await blocked.answer({ grade: "A" })

		const resumeMessage = done.agent("elicit").messages.at(-1) ?? ""
		expect(resumeMessage).toContain(SUBMIT_RESULT_TOOL)
		expect(resumeMessage).toContain(SUBMIT_QUESTIONS_TOOL)
		expect(resumeMessage).not.toMatch(/ONLY \{/)
	})

	it("names both tools in the asking protocol, outside the embedded schemas", () => {
		// Stripping the two JSON Schema dumps leaves only prose: the tool names must survive that.
		const prose = buildAskingProtocol(outputSchema)
			.split("\n")
			.filter((line) => !line.startsWith(" ") && !line.startsWith("{") && !line.startsWith("}"))
			.join("\n")

		expect(prose).toContain(SUBMIT_QUESTIONS_TOOL)
		expect(prose).toContain(SUBMIT_RESULT_TOOL)
	})

	it("keeps asking on the table when correcting a step that may ask", () => {
		// Offering only workflow_submit_result tells a model that was trying to ask a question to invent the answer.
		const correction = buildCorrectionMessage(
			outputSchema,
			"the turn ended without calling workflow_submit_result",
			true,
		)

		expect(correction).toContain(SUBMIT_QUESTIONS_TOOL)
		expect(correction).toContain("do NOT invent")
		expect(correction).toContain('"questions"') // the questionnaire schema, so the model can comply
	})

	it("does not offer workflow_submit_questions when correcting a step that cannot ask", () => {
		expect(buildCorrectionMessage(outputSchema, "bad", false)).not.toContain(SUBMIT_QUESTIONS_TOOL)
	})

	it("carries asks through the ENGINE's correction, not just the builder", async () => {
		// The builder taking an `asks` flag is worthless if step-runner never passes it: a step that needed
		// to ask would still be told only to submit a result, and a compliant model invents one.
		const asking = createAgentStep({
			name: "elicit",
			output: outputSchema,
			asks: true,
			maxOutputRepairs: 1,
			prompt: () => "go",
		})
		const workflow = createWorkflow({ name: "asks-correction" }).then(asking).commit()
		const agent = createAgentDouble(workflow.nodes, { elicit: [raw("thinking"), reply({ grade: "A" })] })
		const { host } = createTestHost({ startAgent: agent.startAgent })
		await runWorkflow(workflow, undefined, host)

		const correction = agent.record("elicit").messages[1] ?? ""
		expect(correction).toContain(SUBMIT_QUESTIONS_TOOL)
		expect(correction).toContain("do NOT invent")
	})
})
