import { Type } from "typebox"
import { describe, expect, it } from "vitest"
import { resumeWithAnswer } from "../src/engine/resume-workflow.ts"
import { runWorkflow } from "../src/engine/run-workflow.ts"
import { createAgentStep, createStep, createWorkflow } from "../src/flow/index.ts"
import { createTestHost } from "./helpers.ts"
import { scriptedAgent } from "./scripted-agent.ts"

/**
 * Spec §8.5, the heart of P2: a Q&A step may block anywhere — inside a loop, a foreach, a branch arm,
 * or a nested workflow. Resume must re-enter that EXACT position and continue the SAME agent
 * conversation with the answers appended, rather than restarting the enclosing node and re-asking.
 *
 * Each case below proves re-entry (not restart) three ways:
 *  1. the enclosing construct is NOT re-driven from its own start (a prior sibling/iteration/item is
 *     not re-run, and its own start event is not re-emitted);
 *  2. the blocked step's SECOND session is seeded with `history` (spec §8.4: "the SAME agent loop") —
 *     `scriptedAgent.histories[1]` is non-empty, not `undefined` as a fresh session would show;
 *  3. the run completes with the expected combined output.
 */

const resultSchema = Type.Object({ note: Type.String() })
const askQuestions = JSON.stringify({
	questions: { questions: [{ key: "confirm", header: "Confirm", question: "Proceed?", kind: "text" }] },
})
const askResult = (note: string) => JSON.stringify({ result: { note } })

describe("re-entry (spec §8.5): a blocked step resumes in place, wherever it is nested", () => {
	it("inside a .dountil loop: resume re-enters the SAME iteration, not iteration 1 again", async () => {
		const before = createStep({
			name: "before",
			output: Type.Object({ started: Type.Boolean() }),
			run: () => ({ started: true }),
		})
		const askInLoop = createAgentStep({
			name: "ask-in-loop",
			output: resultSchema,
			asks: true,
			prompt: () => "Loop body prompt.",
		})
		const body = createWorkflow({ name: "loop-body" }).then(askInLoop).commit()
		const workflow = createWorkflow({ name: "loop-block" })
			.then(before)
			.dountil(body, (_ctx, last) => (last as { note: string }).note === "done", {
				name: "until-done",
				maxIterations: 5,
			})
			.commit()

		const agent = scriptedAgent([[askQuestions], [askResult("done")]])
		const { host, store } = createTestHost({ startAgent: agent.startAgent })

		const blocked = await runWorkflow(workflow, undefined, host)
		expect(blocked.status).toBe("blocked")
		expect(blocked.path).toBe("until-done#1/ask-in-loop")
		expect(agent.opened).toBe(1)
		expect(agent.histories[0]).toBeUndefined() // fresh session

		const priorEvents = await store.loadEvents(blocked.runId)
		const resumed = await resumeWithAnswer(workflow, priorEvents, { confirm: "yes" }, host)

		expect(resumed.status).toBe("completed")
		expect(resumed.output).toEqual({ note: "done" })

		// Conversation kept (spec §8.4): a second session seeded with the first's history.
		expect(agent.opened).toBe(2)
		expect(agent.histories[1]).toBeDefined()
		expect(agent.histories[1]?.length).toBeGreaterThan(0)
		expect(agent.messages).toHaveLength(2)
		expect(agent.messages[0]).toContain("Loop body prompt.")
		expect(agent.messages[1]).toContain("confirm")

		// Re-entered, not restarted: `before` and iteration 1's own start each fire exactly once.
		const finalEvents = await store.loadEvents(blocked.runId)
		expect(finalEvents.filter((e) => e.type === "step-started" && e.path === "before")).toHaveLength(1)
		expect(finalEvents.filter((e) => e.type === "loop-iteration")).toHaveLength(1)
	})

	it("inside a .foreach: resume re-enters the blocked item without re-running a completed prior item", async () => {
		const askInItem = createAgentStep({
			name: "ask-in-item",
			output: resultSchema,
			asks: true,
			prompt: () => "Item body prompt.",
		})
		const body = createWorkflow({ name: "item-body" }).then(askInItem).commit()
		const workflow = createWorkflow({ name: "foreach-block" })
			.foreach(body, () => [10, 20, 30], { name: "batch" })
			.commit()

		// item 0: fresh, no ask. item 1: asks, then answered. item 2: fresh, no ask.
		const agent = scriptedAgent([[askResult("item-0")], [askQuestions], [askResult("item-1")], [askResult("item-2")]])
		const { host, store } = createTestHost({ startAgent: agent.startAgent })

		const blocked = await runWorkflow(workflow, undefined, host)
		expect(blocked.status).toBe("blocked")
		expect(blocked.path).toBe("batch@1/ask-in-item")

		const priorEvents = await store.loadEvents(blocked.runId)
		expect(priorEvents.filter((e) => e.type === "foreach-item-completed")).toHaveLength(1) // only item 0 so far

		const resumed = await resumeWithAnswer(workflow, priorEvents, { confirm: "yes" }, host)
		expect(resumed.status).toBe("completed")
		expect(resumed.output).toEqual([{ note: "item-0" }, { note: "item-1" }, { note: "item-2" }])

		// Conversation kept for the blocked item's own session.
		expect(agent.histories[2]).toBeDefined() // session index 2 = the item-1 answer-continuation
		expect(agent.histories[2]?.length).toBeGreaterThan(0)

		// Item 0 not re-run; item 1's own "started" is not re-emitted (it was already recorded); item 2 runs fresh.
		const finalEvents = await store.loadEvents(blocked.runId)
		expect(finalEvents.filter((e) => e.type === "step-started" && e.path === "batch@0/ask-in-item")).toHaveLength(1)
		expect(finalEvents.filter((e) => e.type === "foreach-item-started" && e.path === "batch@1")).toHaveLength(1)
		expect(finalEvents.filter((e) => e.type === "foreach-item-started" && e.path === "batch@2")).toHaveLength(1)
	})

	it("inside a branch arm: resume re-enters the taken arm without re-evaluating the branch as unresolved", async () => {
		const pick = createStep({ name: "pick", output: Type.Object({ go: Type.Boolean() }), run: () => ({ go: true }) })
		const askInArm = createAgentStep({
			name: "ask-in-arm",
			output: resultSchema,
			asks: true,
			prompt: () => "Arm body prompt.",
		})
		const takeIt = createWorkflow({ name: "take-it" }).then(askInArm).commit()
		const skipIt = createWorkflow({ name: "skip-it" })
			.then(createStep({ name: "noop", run: () => ({ skipped: true }) }))
			.commit()
		const workflow = createWorkflow({ name: "branch-block" })
			.then(pick)
			.branch(
				[
					[(ctx) => ctx.getStepResult<{ go: boolean }>("pick")?.go === true, takeIt],
					[(ctx) => ctx.getStepResult<{ go: boolean }>("pick")?.go === false, skipIt],
				],
				{ name: "branch-1" },
			)
			.commit()

		const agent = scriptedAgent([[askQuestions], [askResult("approved")]])
		const { host, store } = createTestHost({ startAgent: agent.startAgent })

		const blocked = await runWorkflow(workflow, undefined, host)
		expect(blocked.status).toBe("blocked")
		// The arm is a PEER addressing scope of the branch's own name (spec §8.5), not nested under it.
		expect(blocked.path).toBe("take-it/ask-in-arm")

		const priorEvents = await store.loadEvents(blocked.runId)
		const resumed = await resumeWithAnswer(workflow, priorEvents, { confirm: "yes" }, host)

		expect(resumed.status).toBe("completed")
		expect(resumed.output).toEqual({ "take-it": { note: "approved" } })

		expect(agent.histories[1]).toBeDefined()
		expect(agent.histories[1]?.length).toBeGreaterThan(0)

		// `pick` and the branch's own decision are not replayed a second time.
		const finalEvents = await store.loadEvents(blocked.runId)
		expect(finalEvents.filter((e) => e.type === "step-started" && e.path === "pick")).toHaveLength(1)
		expect(finalEvents.filter((e) => e.type === "branch-arm")).toHaveLength(2) // one decision per arm, not re-decided
	})

	it("inside the SECOND of two taken arms: the first arm's already-completed output is recovered, not re-run", async () => {
		// Multi-match (spec §3.2): both arms are taken. The block is in the SECOND one, so re-entry must
		// recover the FIRST arm's output from the log rather than re-running it.
		const firstArm = createWorkflow({ name: "arm-a" })
			.then(createStep({ name: "a-step", output: Type.Object({ v: Type.Number() }), run: () => ({ v: 1 }) }))
			.commit()
		const askInSecond = createAgentStep({
			name: "ask-in-b",
			output: resultSchema,
			asks: true,
			prompt: () => "Second arm prompt.",
		})
		const secondArm = createWorkflow({ name: "arm-b" }).then(askInSecond).commit()
		const workflow = createWorkflow({ name: "multi-match-block" })
			.branch([
				[() => true, firstArm],
				[() => true, secondArm],
			])
			.commit()

		const agent = scriptedAgent([[askQuestions], [askResult("second-done")]])
		const { host, store } = createTestHost({ startAgent: agent.startAgent })

		const blocked = await runWorkflow(workflow, undefined, host)
		expect(blocked.status).toBe("blocked")
		expect(blocked.path).toBe("arm-b/ask-in-b")

		const priorEvents = await store.loadEvents(blocked.runId)
		expect(priorEvents.some((e) => e.type === "node-completed" && e.path === "arm-a")).toBe(true) // first arm already checkpointed

		const resumed = await resumeWithAnswer(workflow, priorEvents, { confirm: "yes" }, host)
		expect(resumed.status).toBe("completed")
		// Both arms' outputs present — the first RECOVERED, the second freshly completed via the answer.
		expect(resumed.output).toEqual({ "arm-a": { v: 1 }, "arm-b": { note: "second-done" } })

		const finalEvents = await store.loadEvents(blocked.runId)
		expect(finalEvents.filter((e) => e.type === "step-started" && e.path === "arm-a/a-step")).toHaveLength(1) // not re-run
	})

	it("inside a nested workflow: resume re-enters the sub-workflow's own step", async () => {
		const askNested = createAgentStep({
			name: "ask-nested",
			output: resultSchema,
			asks: true,
			prompt: () => "Nested body prompt.",
		})
		const inner = createWorkflow({ name: "inner" }).then(askNested).commit()
		const workflow = createWorkflow({ name: "nested-block" }).workflow(inner, { name: "inner" }).commit()

		const agent = scriptedAgent([[askQuestions], [askResult("nested-done")]])
		const { host, store } = createTestHost({ startAgent: agent.startAgent })

		const blocked = await runWorkflow(workflow, undefined, host)
		expect(blocked.status).toBe("blocked")
		expect(blocked.path).toBe("inner/ask-nested")

		const priorEvents = await store.loadEvents(blocked.runId)
		const resumed = await resumeWithAnswer(workflow, priorEvents, { confirm: "yes" }, host)

		expect(resumed.status).toBe("completed")
		expect(resumed.output).toEqual({ note: "nested-done" })

		expect(agent.histories[1]).toBeDefined()
		expect(agent.histories[1]?.length).toBeGreaterThan(0)

		// The nested workflow's own `node-started` is not re-emitted on the answer path.
		const finalEvents = await store.loadEvents(blocked.runId)
		expect(finalEvents.filter((e) => e.type === "node-started" && e.path === "inner")).toHaveLength(1)
	})
})
