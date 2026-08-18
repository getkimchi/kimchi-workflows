/**
 * The store decorator (telemetry spec R5/R6): what a real run publishes, and what a broken subscriber
 * cannot do to it.
 *
 * The integration half drives the ACTUAL engine through a bridged store rather than hand-feeding events,
 * because the claims worth testing are about the wiring: that a retry, a steering repair and a provider
 * failure each reach the bus from the code paths that produce them, and that the terminal the engine
 * never emits — the cold cancel of a blocked run — reaches it as well (spec R6). That path is why the
 * bridge decorates the store instead of teeing `HostPort.emit`.
 */
import { Type } from "typebox"
import { describe, expect, it } from "vitest"
import { runWorkflow } from "../src/engine/run-workflow.ts"
import type { RunEvent } from "../src/engine/types.ts"
import { createAgentStep, createQuestionnaireStep, createStep, createWorkflow } from "../src/flow/index.ts"
import { runTracked } from "../src/host/commands/context.ts"
import { handleCancel } from "../src/host/commands/lifecycle.ts"
import { createHostPort } from "../src/host/host-port.ts"
import { createMemoryStore } from "../src/host/memory-store.ts"
import { withTelemetry } from "../src/host/telemetry-bridge.ts"
import { WORKFLOW_TELEMETRY_CHANNEL } from "../src/host/telemetry-events.ts"
import { createFakeActiveRuns } from "./helpers.ts"
import { scriptedAgent } from "./scripted-agent.ts"

const RUN_ID = "workflow-demo-1a2b3c4d"
const AT = "2026-01-01T00:00:00.000Z"

/**
 * Collects what reached the bus, in order. Stands in for kimchi's telemetry extension: ONE subscription
 * on the envelope channel, telling payloads apart by their `event` discriminator.
 */
function recording() {
	const published: { channel: string; payload: Record<string, unknown> }[] = []
	const warnings: string[] = []
	return {
		published,
		warnings,
		publish: (channel: string, data: unknown) => {
			published.push({ channel, payload: data as Record<string, unknown> })
		},
		warn: (message: string) => {
			warnings.push(message)
		},
		channels: () => [...new Set(published.map((entry) => entry.channel))],
		events: () => published.map((entry) => entry.payload.event),
		first: (event: string) => published.find((entry) => entry.payload.event === event)?.payload,
		all: (event: string) => published.filter((entry) => entry.payload.event === event).map((entry) => entry.payload),
	}
}

const event = (overrides: Partial<Extract<RunEvent, { type: "run-started" }>> = {}): RunEvent => ({
	type: "run-started",
	runId: RUN_ID,
	workflowName: "demo",
	input: undefined,
	at: AT,
	...overrides,
})

describe("the decorator's invariants (spec R5: telemetry never affects execution)", () => {
	it("a subscriber that throws does not fail the append that carried it", async () => {
		const sink = recording()
		const inner = createMemoryStore()
		const store = withTelemetry(
			inner,
			() => {
				throw new Error("subscriber exploded")
			},
			{ warn: sink.warn },
		)

		await expect(store.appendEvent(event())).resolves.toBeUndefined()
		expect(inner.events).toHaveLength(1) // the log is intact: the write happened before the publish
	})

	it("self-disables after one warning, rather than narrating every event of the run", async () => {
		const sink = recording()
		let calls = 0
		const store = withTelemetry(
			createMemoryStore(),
			() => {
				calls += 1
				throw new Error("subscriber exploded")
			},
			{ warn: sink.warn },
		)

		await store.appendEvent(event())
		await store.appendEvent({ type: "step-started", runId: RUN_ID, path: "s", input: undefined, at: AT })
		await store.appendEvent({ type: "run-completed", runId: RUN_ID, output: undefined, at: AT })

		expect(calls).toBe(1) // nothing is attempted after the first failure
		expect(sink.warnings).toHaveLength(1)
		expect(sink.warnings[0]).toMatch(/subscriber exploded/)
		expect(sink.warnings[0]).toMatch(/run is unaffected/)
	})

	it("publishes nothing for a write that failed, and lets the store's error through untouched", async () => {
		const sink = recording()
		const store = withTelemetry(
			{
				appendEvent: () => Promise.reject(new Error("disk full")),
				loadEvents: async () => [],
				delete: async () => {},
				list: async () => [],
			},
			sink.publish,
			{ warn: sink.warn },
		)

		await expect(store.appendEvent(event())).rejects.toThrow("disk full")
		expect(sink.published).toHaveLength(0)
		expect(sink.warnings).toHaveLength(0) // the store's failure is not telemetry's to report
	})

	it("persists before it publishes", async () => {
		const order: string[] = []
		const sink = recording()
		const store = withTelemetry(
			{
				appendEvent: async () => {
					order.push("append")
				},
				loadEvents: async () => [],
				delete: async () => {},
				list: async () => [],
			},
			(channel) => order.push(`publish:${channel}`),
			{ warn: sink.warn },
		)

		await store.appendEvent(event())

		expect(order).toEqual(["append", `publish:${WORKFLOW_TELEMETRY_CHANNEL}`])
	})

	it("learns from a log read off disk without re-publishing any of it", async () => {
		const sink = recording()
		const inner = createMemoryStore()
		await inner.appendEvent(event())
		await inner.appendEvent({ type: "run-crashed", runId: RUN_ID, error: "boom", at: AT })
		const store = withTelemetry(inner, sink.publish)

		const events = await store.loadEvents(RUN_ID)

		expect(events).toHaveLength(2) // forwarded verbatim
		expect(sink.published).toHaveLength(0) // history was already reported by whoever wrote it
		// ...but the run's identity was learned from it, so this leg's own events are attributable.
		await store.appendEvent({ type: "run-resumed", runId: RUN_ID, fromPath: "s", at: AT })
		expect(sink.first("run_resumed")).toMatchObject({ workflow_name: "demo" })
	})

	it("forwards the reads and the delete it adds nothing to", async () => {
		const sink = recording()
		const inner = createMemoryStore()
		const store = withTelemetry(inner, sink.publish)
		await store.appendEvent(event())

		expect(await store.list()).toMatchObject([{ runId: RUN_ID, workflowName: "demo" }])
		await store.delete(RUN_ID)
		expect(await store.loadEvents(RUN_ID)).toEqual([])
		expect(await store.list()).toEqual([])
	})
})

// ----------------------------------------------------------------------------------------------------
// Through the engine
// ----------------------------------------------------------------------------------------------------

const summary = Type.Object({ summary: Type.String() })

/** A bridged store plus a host built on it, as `extension.ts` wires them for real. */
function bridged(startAgent?: ReturnType<typeof scriptedAgent>["startAgent"]) {
	const sink = recording()
	const store = withTelemetry(createMemoryStore(), sink.publish, { warn: sink.warn, now: () => new Date(AT) })
	const host = createHostPort(store, {
		generateRunId: () => RUN_ID,
		startAgent,
		sleep: async () => {},
	})
	return { sink, store, host }
}

describe("what a run publishes (spec R3)", () => {
	it("a clean run: started, its steps, completed — with a duration on each", async () => {
		const workflow = createWorkflow({ name: "demo" })
			.then(createStep({ name: "work", output: summary, run: () => ({ summary: "ok" }) }))
			.commit()
		const { sink, host } = bridged()

		await runWorkflow(workflow, undefined, host)

		// Everything travels on the ONE envelope channel — the subscriber needs a single subscription.
		expect(sink.channels()).toEqual([WORKFLOW_TELEMETRY_CHANNEL])
		expect(sink.events()).toEqual(["run_started", "step_started", "step_completed", "run_completed"])
		expect(sink.first("step_completed")).toMatchObject({
			run_id: RUN_ID,
			workflow_name: "demo",
			step_name: "work",
		})
		for (const type of ["step_completed", "run_completed"]) {
			expect(typeof sink.first(type)?.duration_ms).toBe("number")
		}
	})

	it("a steering repair publishes nothing — repairs are the run log's business, not telemetry's", async () => {
		const step = createAgentStep({ name: "review", output: summary, maxOutputRepairs: 1, prompt: () => "go" })
		const workflow = createWorkflow({ name: "demo" }).then(step).commit()
		const agent = scriptedAgent([["not a submission", '{"summary":"ok"}']])
		const { sink, host } = bridged(agent.startAgent)

		await runWorkflow(workflow, undefined, host)

		// The repair worked inside the attempt: a clean run's sequence, nothing more.
		expect(sink.events()).toEqual(["run_started", "step_started", "step_completed", "run_completed"])
	})

	it("a provider failure, told apart from a model that declined to answer", async () => {
		const step = createAgentStep({
			name: "review",
			output: summary,
			resumable: "orchestrator",
			retry: { maxRetry: 1 },
			prompt: () => "go",
		})
		const workflow = createWorkflow({ name: "demo" }).then(step).commit()
		const agent = scriptedAgent([
			[{ error: { kind: "provider-error", message: "upstream 503" } }],
			['{"summary":"ok"}'],
		])
		const { sink, host } = bridged(agent.startAgent)

		await runWorkflow(workflow, undefined, host)

		// No separate agent event travels: the failed request surfaces as the retry it caused, with the
		// kind the engine recorded resolved into telemetry's own reason vocabulary.
		expect(sink.events()).not.toContain("agent_error")
		expect(sink.first("step_retried")).toMatchObject({
			step_name: "review",
			attempt: 1,
			reason: "provider_error",
			error: { message: expect.stringContaining("upstream 503") },
		})
	})

	it("an optional step's failure, which the run survives — the health signal for these workflows", async () => {
		const workflow = createWorkflow({ name: "demo" })
			.then(
				createStep({
					name: "gate",
					output: summary,
					optional: true,
					retry: { maxRetry: 0 },
					run: () => {
						throw new Error("gate did not pass")
					},
				}),
			)
			.commit()
		const { sink, host } = bridged()

		const result = await runWorkflow(workflow, undefined, host)

		expect(result.status).toBe("completed") // a run can complete with failed steps in it
		expect(sink.first("step_failed")).toMatchObject({
			step_name: "gate",
			error: { message: expect.stringContaining("gate") },
		})
		expect(sink.events()).toContain("run_completed")
		expect(sink.events()).not.toContain("run_failed")
	})

	it("a crash, with its cause in the error envelope", async () => {
		const workflow = createWorkflow({ name: "demo" })
			.then(
				createStep({
					name: "work",
					output: summary,
					retry: { maxRetry: 0 },
					run: () => {
						throw new Error("boom")
					},
				}),
			)
			.commit()
		const { sink, host } = bridged()

		await runWorkflow(workflow, undefined, host)

		expect(sink.first("run_failed")).toMatchObject({
			error: { message: expect.stringContaining("boom") },
		})
		expect(sink.first("run_failed")).not.toHaveProperty("path")
	})

	it("a loop's iterations as repeated events under the one step name", async () => {
		let rounds = 0
		const body = createWorkflow({ name: "round" })
			.then(
				createStep({
					name: "work",
					output: summary,
					run: () => {
						rounds += 1
						return { summary: `round ${rounds}` }
					},
				}),
			)
			.commit()
		const workflow = createWorkflow({ name: "demo" })
			.dowhile(body, () => rounds < 2, { name: "rounds" })
			.commit()
		const { sink, host } = bridged()

		await runWorkflow(workflow, undefined, host)

		expect(sink.all("step_started").map((payload) => payload.step_name)).toEqual(["work", "work"])
		// The iteration's address stays local: telemetry sees the same step twice, not two paths.
		for (const payload of sink.all("step_started")) {
			expect(payload).not.toHaveProperty("path")
			expect(payload).not.toHaveProperty("static_key")
		}
	})
})

describe("terminal-state completeness (spec R6)", () => {
	const blockingWorkflow = createWorkflow({ name: "demo" })
		.then(createQuestionnaireStep({ name: "sign-off", output: Type.Object({ env: Type.String() }) }))
		.commit()

	it("a blocked run is reported, though no event records blocking", async () => {
		const { sink, store, host } = bridged()

		const result = await runTracked(createFakeActiveRuns(), RUN_ID, store, (signal) =>
			runWorkflow(blockingWorkflow, undefined, host, { signal }),
		)

		expect(result?.status).toBe("blocked")
		// The questionnaire itself is below telemetry's altitude — only the run-level wait is reported.
		expect(sink.events()).toEqual(["run_started", "step_started", "run_blocked"])
		expect(sink.first("run_blocked")).toMatchObject({
			run_id: RUN_ID,
			workflow_name: "demo",
		})
	})

	it("the cold cancel of a blocked run — a terminal the engine never emits", async () => {
		const { sink, store, host } = bridged()
		await runWorkflow(blockingWorkflow, undefined, host, {})
		const notified: string[] = []

		await handleCancel({ ui: { notify: (message) => notified.push(message) } }, createFakeActiveRuns(), store, RUN_ID)

		expect(sink.events()).toContain("run_cancelled")
		expect(sink.first("run_cancelled")).toMatchObject({ run_id: RUN_ID, workflow_name: "demo" })
	})
})
