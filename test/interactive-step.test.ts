import { Type } from "typebox"
import { describe, expect, it, vi } from "vitest"
import { createInteractiveStep, createStep, createWorkflow } from "../src/flow/index.ts"
import { createTestRun } from "../src/testing/index.ts"

const requestSchema = Type.Object({ title: Type.String(), markdown: Type.String() })
const responseSchema = Type.Union([
	Type.Object({ decision: Type.Literal("approve") }),
	Type.Object({ decision: Type.Literal("revise"), feedback: Type.String() }),
])

describe("interactive step", () => {
	it("persists its exact request, blocks without invoking PI, and resumes through the offline handle", async () => {
		const buildRequest = vi.fn(() => ({ title: "Proposed workflow", markdown: "# Plan\n\nShip it." }))
		const render = vi.fn()
		const review = createInteractiveStep({
			name: "review-plan",
			request: requestSchema,
			output: responseSchema,
			buildRequest,
			render,
		})
		const finish = createStep({
			name: "finish",
			input: responseSchema,
			output: Type.String(),
			run: ({ input }) => input.decision,
		})
		const workflow = createWorkflow({ name: "review" }).then(review).then(finish).commit()

		const blocked = await createTestRun(workflow)

		expect(blocked.status).toBe("blocked")
		expect(blocked.path).toBe("review-plan")
		expect(blocked.interaction).toEqual({ title: "Proposed workflow", markdown: "# Plan\n\nShip it." })
		expect(blocked.pendingInteractions).toEqual([
			{
				path: "review-plan",
				request: { title: "Proposed workflow", markdown: "# Plan\n\nShip it." },
				violation: undefined,
			},
		])
		expect(blocked.eventsOf("interaction-requested")).toHaveLength(1)
		expect(buildRequest).toHaveBeenCalledTimes(1)
		expect(render).not.toHaveBeenCalled()

		const done = await blocked.respond({ decision: "approve" })

		expect(done.status).toBe("completed")
		expect(done.output).toBe("approve")
		expect(done.stepOutput("review-plan")).toEqual({ decision: "approve" })
		expect(done.eventsOf("interaction-provided")).toHaveLength(1)
		expect(buildRequest).toHaveBeenCalledTimes(1)
		expect(render).not.toHaveBeenCalled()
	})

	it("re-blocks with the same persisted request when a response violates the output schema", async () => {
		const buildRequest = vi.fn(() => ({ title: "Review", markdown: "original" }))
		const workflow = createWorkflow({ name: "invalid-response" })
			.then(
				createInteractiveStep({
					name: "review",
					request: requestSchema,
					output: responseSchema,
					buildRequest,
					render: () => undefined,
				}),
			)
			.commit()
		const blocked = await createTestRun(workflow)

		const invalid = await blocked.respond({ decision: "revise" })

		expect(invalid.status).toBe("blocked")
		expect(invalid.interaction).toEqual({ title: "Review", markdown: "original" })
		expect(invalid.violation).toMatch(/feedback/)
		expect(invalid.eventsOf("interaction-requested")).toHaveLength(2)
		expect(buildRequest).toHaveBeenCalledTimes(1)

		const done = await invalid.respond({ decision: "revise", feedback: "Add verification." })
		expect(done.status).toBe("completed")
		expect(done.output).toEqual({ decision: "revise", feedback: "Add verification." })
	})

	it("rejects a request whose event-log representation is not JSON data", async () => {
		const workflow = createWorkflow({ name: "json-only" })
			.then(
				createInteractiveStep({
					name: "review",
					request: Type.Unknown(),
					output: Type.Unknown(),
					buildRequest: () => ({ createdAt: new Date() }),
					render: () => undefined,
				}),
			)
			.commit()

		const run = await createTestRun(workflow)

		expect(run.status).toBe("crashed")
		expect(run.error).toMatch(/not JSON-serializable/)
		expect(run.eventsOf("interaction-requested")).toHaveLength(0)
	})

	it("resolves concurrent interactions one exact dynamic path at a time without rebuilding siblings", async () => {
		const interaction = (name: string) =>
			createInteractiveStep({
				name,
				request: Type.Object({ owner: Type.String() }),
				output: Type.Object({ value: Type.String() }),
				buildRequest: () => ({ owner: name }),
				render: () => undefined,
			})
		const workflow = createWorkflow({ name: "parallel-interactions" })
			.parallel([interaction("a"), interaction("b")], { name: "reviews" })
			.commit()
		const blocked = await createTestRun(workflow)

		expect(blocked.pendingInteractions.map((pending) => pending.path).sort()).toEqual(["reviews/a", "reviews/b"])
		const afterB = await blocked.respond({ value: "B" }, "reviews/b")

		expect(afterB.status).toBe("blocked")
		expect(afterB.path).toBe("reviews/a")
		expect(afterB.eventsOf("interaction-requested").filter((event) => event.path === "reviews/a")).toHaveLength(1)
		expect(afterB.pendingInteractions).toEqual([{ path: "reviews/a", request: { owner: "a" }, violation: undefined }])

		const done = await afterB.respond({ value: "A" }, "reviews/a")
		expect(done.status).toBe("completed")
		expect(done.output).toEqual({ a: { value: "A" }, b: { value: "B" } })
	})
})
