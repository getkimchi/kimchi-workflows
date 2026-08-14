import { Type } from "typebox"
import { describe, expect, it } from "vitest"
import { runWorkflow } from "../src/engine/run-workflow.ts"
import type { RunEvent, RunResult } from "../src/engine/types.ts"
import { createAgentStep, createInteractiveStep, createStep, createWorkflow } from "../src/flow/index.ts"
import type { WorkflowDefinition } from "../src/flow/types.ts"
import { createTestHost } from "./helpers.ts"
import { scriptedAgent } from "./scripted-agent.ts"

const noop = (name: string) => createStep({ name, run: () => ({ ok: true }) })

async function runAndReadCrash(
	workflow: WorkflowDefinition,
	startAgent?: ReturnType<typeof scriptedAgent>["startAgent"],
): Promise<{ result: RunResult; crash: Extract<RunEvent, { type: "run-crashed" }> }> {
	const { host, events } = createTestHost(startAgent ? { startAgent } : {})
	const result = await runWorkflow(workflow, undefined, host)
	expect(result.status).toBe("crashed")
	const crashes = events.filter(
		(event): event is Extract<RunEvent, { type: "run-crashed" }> => event.type === "run-crashed",
	)
	expect(crashes).toHaveLength(1)
	return { result, crash: crashes[0] as Extract<RunEvent, { type: "run-crashed" }> }
}

describe("user-authored callback failures become recorded crashes", () => {
	it("attributes a branch condition exception to the branch", async () => {
		const arm = createWorkflow({ name: "ship" }).then(noop("publish")).commit()
		const workflow = createWorkflow({ name: "release" })
			.branch(
				[
					[
						() => {
							throw new Error("branch boom")
						},
						arm,
					],
				],
				{ name: "choose" },
			)
			.commit()

		const { result, crash } = await runAndReadCrash(workflow)
		expect(result.path).toBe("choose")
		expect(crash).toMatchObject({
			path: "choose",
			error: 'branch "choose" condition for arm "ship" threw: branch boom',
		})
	})

	it("attributes a loop-condition exception to the current iteration", async () => {
		const body = createWorkflow({ name: "body" }).then(noop("work")).commit()
		const workflow = createWorkflow({ name: "release" })
			.dountil(
				body,
				() => {
					throw new Error("loop boom")
				},
				{ name: "repeat", maxIterations: 3 },
			)
			.commit()

		const { result, crash } = await runAndReadCrash(workflow)
		expect(result.path).toBe("repeat#1")
		expect(crash.error).toBe('loop "repeat" condition threw: loop boom')
	})

	it("attributes a foreach-selector exception to the foreach node", async () => {
		const body = createWorkflow({ name: "body" }).then(noop("work")).commit()
		const workflow = createWorkflow({ name: "release" })
			.foreach(
				body,
				() => {
					throw new Error("selector boom")
				},
				{ name: "items" },
			)
			.commit()

		const { result, crash } = await runAndReadCrash(workflow)
		expect(result.path).toBe("items")
		expect(crash.error).toBe('foreach "items" selector threw: selector boom')
	})

	it("attributes a map-transform exception to the generated map step", async () => {
		const workflow = createWorkflow({ name: "release" })
			.map(
				() => {
					throw new Error("map boom")
				},
				{ name: "select-release" },
			)
			.commit()

		const { result, crash } = await runAndReadCrash(workflow)
		expect(result.path).toBe("select-release")
		expect(crash.error).toBe('map "select-release" transform threw: map boom')
	})

	it("attributes an interactive request-builder exception to its step", async () => {
		const workflow = createWorkflow({ name: "release" })
			.then(
				createInteractiveStep({
					name: "approve",
					request: Type.Object({ title: Type.String() }),
					output: Type.Object({ approved: Type.Boolean() }),
					buildRequest: () => {
						throw new Error("request boom")
					},
					render: () => undefined,
				}),
			)
			.commit()

		const { result, crash } = await runAndReadCrash(workflow)
		expect(result.path).toBe("approve")
		expect(crash.error).toBe('step "approve" interaction request threw: request boom')
	})

	it("attributes an agent prompt-builder exception to its step", async () => {
		const agent = createAgentStep({
			name: "review",
			prompt: () => {
				throw new Error("prompt boom")
			},
		})
		const workflow = createWorkflow({ name: "release" }).then(agent).commit()

		const { result, crash } = await runAndReadCrash(workflow, scriptedAgent([["unused"]]).startAgent)
		expect(result.path).toBe("review")
		expect(crash.error).toBe('agent step "review" prompt builder threw: prompt boom')
	})

	it("attributes a dynamic-budget exception to its step", async () => {
		const step = createStep({
			name: "bounded",
			maxDurationMs: () => {
				throw new Error("budget boom")
			},
			run: () => ({ ok: true }),
		})
		const workflow = createWorkflow({ name: "release" }).then(step).commit()

		const { result, crash } = await runAndReadCrash(workflow)
		expect(result.path).toBe("bounded")
		expect(crash.error).toBe('step "bounded" maxDurationMs callback threw: budget boom')
	})

	it("attributes a resumability-key exception to its agent step", async () => {
		const agent = createAgentStep({
			name: "review",
			prompt: () => "review",
			resumable: () => {
				throw new Error("resume-key boom")
			},
		})
		const workflow = createWorkflow({ name: "release" }).then(agent).commit()

		const { result, crash } = await runAndReadCrash(workflow, scriptedAgent([["unused"]]).startAgent)
		expect(result.path).toBe("review")
		expect(crash.error).toBe('agent step "review" resumable callback threw: resume-key boom')
	})
})
