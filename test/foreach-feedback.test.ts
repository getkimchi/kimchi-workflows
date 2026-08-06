import { Type } from "typebox"
import { describe, expect, it } from "vitest"
import { resumeWithAnswer, resumeWorkflow } from "../src/engine/resume-workflow.ts"
import { runWorkflow } from "../src/engine/run-workflow.ts"
import { createQuestionnaireStep, createStep, createWorkflow } from "../src/flow/index.ts"
import { createTestHost } from "./helpers.ts"

const accSchema = Type.Object({ seen: Type.Array(Type.String()) })

describe("sequential foreach feedback (Feature 3)", () => {
	it("item N receives item N−1's output; item 0 the upstream input; the item itself rides the frame (3.1)", async () => {
		const inputsSeen: unknown[] = []
		const digest = createStep({
			name: "digest",
			input: Type.Any(),
			output: accSchema,
			run: ({ input, ctx }) => {
				inputsSeen.push(input)
				const prior = (input as { seen?: string[] } | undefined)?.seen ?? []
				const item = ctx.scope("batch")?.input as string
				return { seen: [...prior, item] }
			},
		})
		const body = createWorkflow({ name: "per-item" }).then(digest).commit()
		const workflow = createWorkflow({ name: "accumulating" })
			.then(createStep({ name: "seed", output: accSchema, run: () => ({ seen: [] }) }))
			.foreach(body, () => ["a", "b", "c"], { name: "batch", feedback: true })
			.commit()

		const result = await runWorkflow(workflow, undefined, createTestHost().host)
		expect(result.status).toBe("completed")

		expect(inputsSeen).toEqual([{ seen: [] }, { seen: ["a"] }, { seen: ["a", "b"] }])
		// The construct's output stays the per-item array (spec §3.4) — the accumulation is the AUTHOR's,
		// threaded inside the fed value; the last item's output holds the full accumulation.
		expect(result.status === "completed" && result.output).toEqual([
			{ seen: ["a"] },
			{ seen: ["a", "b"] },
			{ seen: ["a", "b", "c"] },
		])
	})

	it("an item producing no output forwards what it received (3.2)", async () => {
		const inputsSeen: unknown[] = []
		const digest = createStep({
			name: "digest",
			input: Type.Any(),
			output: accSchema,
			optional: true,
			run: ({ input, ctx }) => {
				inputsSeen.push(input)
				const item = ctx.scope("batch")?.input as string
				if (item === "b") throw new Error("item b lost")
				const prior = (input as { seen?: string[] } | undefined)?.seen ?? []
				return { seen: [...prior, item] }
			},
		})
		const body = createWorkflow({ name: "per-item" }).then(digest).commit()
		const workflow = createWorkflow({ name: "lossy" })
			.then(createStep({ name: "seed", output: accSchema, run: () => ({ seen: [] }) }))
			.foreach(body, () => ["a", "b", "c"], { name: "batch", feedback: true })
			.commit()

		const result = await runWorkflow(workflow, undefined, createTestHost().host)
		expect(result.status).toBe("completed")
		// Item "c" received item "a"'s output — "b"'s failure lost the item, not the accumulation.
		expect(inputsSeen).toEqual([{ seen: [] }, { seen: ["a"] }, { seen: ["a"] }])
		expect(result.status === "completed" && result.output).toEqual([{ seen: ["a"] }, undefined, { seen: ["a", "c"] }])
	})

	it("feedback with concurrency > 1 is rejected at .commit() (3.3)", () => {
		const body = createWorkflow({ name: "per-item" })
			.then(createStep({ name: "digest", output: accSchema, run: () => ({ seen: [] }) }))
			.commit()
		expect(() =>
			createWorkflow({ name: "raced" })
				.foreach(body, () => ["a", "b"], { name: "batch", feedback: true, concurrency: 2 })
				.commit(),
		).toThrow(/no defined order/)
	})

	it("a non-feedback foreach still hands each body its ITEM as input — unchanged", async () => {
		const inputsSeen: unknown[] = []
		const body = createWorkflow({ name: "per-item" })
			.then(
				createStep({
					name: "digest",
					input: Type.String(),
					output: accSchema,
					run: ({ input }) => {
						inputsSeen.push(input)
						return { seen: [input] }
					},
				}),
			)
			.commit()
		const workflow = createWorkflow({ name: "plain" })
			.foreach(body, () => ["a", "b"], { name: "batch" })
			.commit()

		await runWorkflow(workflow, undefined, createTestHost().host)
		expect(inputsSeen).toEqual(["a", "b"])
	})

	it("feedback threads through a body whose LAST node is a construct — the construct's output IS the body output", async () => {
		// The passed value is whatever the body's last NODE records, step or construct alike: runNodeSequence
		// records every node under its own static key, so a nested-workflow tail hands its own output to the
		// next item. (Construct tails have no `optional`, so the 3.2 failure case has no construct analog.)
		const inputsSeen: unknown[] = []
		const wrapped = createWorkflow({ name: "wrap" })
			.then(
				createStep({
					name: "digest",
					input: Type.Any(),
					output: accSchema,
					run: ({ input, ctx }) => {
						inputsSeen.push(input)
						const prior = (input as { seen?: string[] } | undefined)?.seen ?? []
						const item = ctx.scope("batch")?.input as string
						return { seen: [...prior, item] }
					},
				}),
			)
			.commit()
		const body = createWorkflow({ name: "per-item" }).workflow(wrapped).commit()
		const workflow = createWorkflow({ name: "construct-tailed" })
			.then(createStep({ name: "seed", output: accSchema, run: () => ({ seen: [] }) }))
			.foreach(body, () => ["a", "b", "c"], { name: "batch", feedback: true })
			.commit()

		const result = await runWorkflow(workflow, undefined, createTestHost().host)
		expect(result.status).toBe("completed")

		// Item N received item N−1's NESTED WORKFLOW output — identical to a step-tailed body (3.1).
		expect(inputsSeen).toEqual([{ seen: [] }, { seen: ["a"] }, { seen: ["a", "b"] }])
		expect(result.status === "completed" && result.output).toEqual([
			{ seen: ["a"] },
			{ seen: ["a", "b"] },
			{ seen: ["a", "b", "c"] },
		])
	})

	it("a crash-resume rebuilds the fed value from the recorded item history (3.2 on resume)", async () => {
		const inputsSeen: unknown[] = []
		let crashOnce = true
		const digest = createStep({
			name: "digest",
			input: Type.Any(),
			output: accSchema,
			run: ({ input, ctx }) => {
				inputsSeen.push(input)
				const item = ctx.scope("batch")?.input as string
				if (item === "c" && crashOnce) {
					crashOnce = false
					throw new Error("transient failure at item c")
				}
				const prior = (input as { seen?: string[] } | undefined)?.seen ?? []
				return { seen: [...prior, item] }
			},
		})
		const body = createWorkflow({ name: "per-item" }).then(digest).commit()
		const workflow = createWorkflow({ name: "resumable-accumulation" })
			.then(createStep({ name: "seed", output: accSchema, run: () => ({ seen: [] }) }))
			.foreach(body, () => ["a", "b", "c"], { name: "batch", feedback: true })
			.commit()

		const { host, store } = createTestHost()
		const first = await runWorkflow(workflow, undefined, host)
		expect(first.status).toBe("crashed")

		const resumed = await resumeWorkflow(workflow, await store.loadEvents(first.runId), host)
		expect(resumed.status).toBe("completed")

		// The resume skipped items a/b (recorded) and re-fed item c EXACTLY what the continuous run fed it:
		// item b's recorded output, rebuilt by walking the history prefix.
		expect(inputsSeen).toEqual([
			{ seen: [] }, // a, first run
			{ seen: ["a"] }, // b, first run
			{ seen: ["a", "b"] }, // c, first run (crashed)
			{ seen: ["a", "b"] }, // c, resumed
		])
		expect(resumed.status === "completed" && resumed.output).toEqual([
			{ seen: ["a"] },
			{ seen: ["a", "b"] },
			{ seen: ["a", "b", "c"] },
		])
	})
})

describe("sequential foreach feedback: deep re-entry (spec §8.5 interplay)", () => {
	it("answering a block inside item N rebuilds the fed value for N and threads on to N+1", async () => {
		const inputsSeen: unknown[] = []
		const confirmSchema = Type.Object({ go: Type.Boolean() })
		const digest = createStep({
			name: "digest",
			input: Type.Any(),
			output: accSchema,
			run: ({ input, ctx }) => {
				inputsSeen.push(input)
				const prior = (input as { seen?: string[] } | undefined)?.seen ?? []
				return { seen: [...prior, ctx.scope("batch")?.input as string] }
			},
		})
		const close = createStep({
			name: "close",
			// Re-emit digest's record as the body output: the questionnaire's answer must not clobber the
			// accumulation the next item is fed.
			output: accSchema,
			run: ({ ctx }) => ctx.getStepResult<{ seen: string[] }>("digest") ?? { seen: [] },
		})
		const body = createWorkflow({ name: "per-item" })
			.then(digest)
			.then(createQuestionnaireStep({ name: "confirm", output: confirmSchema }))
			.then(close)
			.commit()
		const workflow = createWorkflow({ name: "blocking-accumulation" })
			.then(createStep({ name: "seed", output: accSchema, run: () => ({ seen: [] }) }))
			.foreach(body, () => ["a", "b"], { name: "batch", feedback: true })
			.commit()

		const { host, store } = createTestHost()
		let result = await runWorkflow(workflow, undefined, host)
		for (let answers = 0; answers < 2 && result.status === "blocked"; answers++) {
			result = await resumeWithAnswer(workflow, await store.loadEvents(result.runId), { go: true }, host)
		}

		expect(result.status).toBe("completed")
		// Item "b" — reached through a deep re-entry into item "a"'s block, then a second one into its own —
		// was fed item "a"'s body output, exactly as a continuous run would.
		expect(inputsSeen).toEqual([{ seen: [] }, { seen: ["a"] }])
		expect(result.status === "completed" && result.output).toEqual([{ seen: ["a"] }, { seen: ["a", "b"] }])
	})
})
