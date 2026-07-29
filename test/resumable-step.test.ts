import path from "node:path"
import { Type } from "typebox"
import { describe, expect, it } from "vitest"
import { runWorkflow } from "../src/engine/run-workflow.ts"
import type { AgentRequest } from "../src/engine/types.ts"
import { createAgentStep, createWorkflow } from "../src/flow/index.ts"
import { assistantLine, scriptedSubagent } from "./fake-subagent.ts"
import { agentRequest, createTestHost, tempSessionsDir } from "./helpers.ts"
import { scriptedAgent } from "./scripted-agent.ts"

/** Where the bridge under test writes its step sessions (the real host binds the harness's own session dir). */
const sessionsDir = tempSessionsDir()

const okSchema = Type.Object({ ok: Type.Boolean() })

/** Records what each opened session was asked for, so the seam itself can be asserted. */
function recordingAgent(replies: readonly string[]) {
	const requests: AgentRequest[] = []
	const inner = scriptedAgent(replies.map((reply) => [reply]))
	return {
		requests,
		startAgent: (request: AgentRequest) => {
			requests.push(request)
			return inner.startAgent(request)
		},
	}
}

/**
 * `resumable` (spec §2.2): an isolated step is a one-shot subprocess, so every execution starts cold.
 * That is right for a verifier and wrong for a worker that was interrupted — a step time-boxed out of
 * one loop round and re-run in the next would otherwise re-derive everything it already knew. The
 * engine asks the host to keep that step's conversation under a stable key; the PI host names a session
 * file after it, which the harness both writes and resumes.
 */
describe("resumable isolated steps", () => {
	it("asks the host to continue the same conversation on every execution of that step", async () => {
		const body = createWorkflow({ name: "round" })
			.then(
				createAgentStep({ name: "worker", output: okSchema, background: true, resumable: true, prompt: () => "work" }),
			)
			.commit()
		const workflow = createWorkflow({ name: "resumable" })
			.dowhile(body, (ctx) => (ctx.getStepResult<{ n: number }>("rounds")?.n ?? 0) < 2, {
				name: "loop",
				maxIterations: 3,
			})
			.commit()

		// Two rounds, so the step executes twice; both must carry the same resume key.
		const agent = recordingAgent([
			JSON.stringify({ ok: true }),
			JSON.stringify({ ok: true }),
			JSON.stringify({ ok: true }),
		])
		const { host } = createTestHost({ startAgent: agent.startAgent })
		await runWorkflow(workflow, undefined, host)

		expect(agent.requests.length).toBeGreaterThanOrEqual(2)
		for (const request of agent.requests) {
			expect(request.resumeKey).toBe("worker")
			expect(request.background).toBe(true)
		}
	})

	it("says nothing about resuming for an ordinary step, keeping the cheap cold-start default", async () => {
		const workflow = createWorkflow({ name: "not-resumable" })
			.then(createAgentStep({ name: "fresh", output: okSchema, background: true, prompt: () => "look" }))
			.commit()

		const agent = recordingAgent([JSON.stringify({ ok: true })])
		const { host } = createTestHost({ startAgent: agent.startAgent })
		await runWorkflow(workflow, undefined, host)

		expect(agent.requests[0]?.resumeKey).toBeUndefined()
	})

	it("keeps the key stable across a retry, since the point is continuity of one step's work", async () => {
		const workflow = createWorkflow({ name: "resumable-retry" })
			.then(
				createAgentStep({
					name: "worker",
					output: okSchema,
					background: true,
					resumable: true,
					retry: { maxRetry: 1 },
					prompt: () => "work",
				}),
			)
			.commit()

		// First attempt replies with invalid output; the retry opens a second session for the same step.
		const agent = recordingAgent(["not json at all", JSON.stringify({ ok: true })])
		const { host } = createTestHost({ startAgent: agent.startAgent })
		const result = await runWorkflow(workflow, undefined, host)

		expect(result.status).toBe("completed")
		expect(agent.requests.map((r) => r.resumeKey)).toEqual(["worker", "worker"])
	})
})

/**
 * A shared resume key (spec §2.2): several steps naming ONE conversation and taking turns in it. This
 * is what it takes to model an orchestrator — the step that plans the work and the step that rules on
 * what came back are the same agent, carrying its own reasoning between them, rather than two
 * strangers each handed a summary. The key is a shared file, so `.commit()` refuses it wherever two
 * holders could run at once.
 */
describe("a resume key shared by several steps", () => {
	it("continues one conversation across every step that names it", async () => {
		const workflow = createWorkflow({ name: "orchestrated" })
			.then(
				createAgentStep({
					name: "plan",
					output: okSchema,
					background: true,
					resumable: "orchestrator",
					prompt: () => "plan it",
				}),
			)
			.then(
				createAgentStep({ name: "work", output: okSchema, background: true, resumable: true, prompt: () => "do it" }),
			)
			.then(
				createAgentStep({
					name: "gates",
					output: okSchema,
					background: true,
					resumable: "orchestrator",
					prompt: () => "rule on it",
				}),
			)
			.commit()

		const agent = recordingAgent([
			JSON.stringify({ ok: true }),
			JSON.stringify({ ok: true }),
			JSON.stringify({ ok: true }),
		])
		const { host } = createTestHost({ startAgent: agent.startAgent })
		const result = await runWorkflow(workflow, undefined, host)

		expect(result.status).toBe("completed")
		// `plan` and `gates` share one session; `work` keeps its own, keyed by its name.
		expect(agent.requests.map((r) => r.resumeKey)).toEqual(["orchestrator", "work", "orchestrator"])
	})

	it("rejects a shared key on a step that can overlap, rather than letting two writers share one file", () => {
		const body = createWorkflow({ name: "item" })
			.then(
				createAgentStep({
					name: "judge",
					output: okSchema,
					background: true,
					resumable: "orchestrator",
					prompt: () => "rule",
				}),
			)
			.commit()

		expect(() =>
			createWorkflow({ name: "fanned-out" })
				.foreach(body, () => [{ n: 1 }, { n: 2 }, { n: 3 }], { name: "items", concurrency: 3 })
				.commit(),
		).toThrow(/shares the resume key "orchestrator" but can overlap/)
	})

	it("still allows a shared key inside a fan-out that runs one item at a time", () => {
		const body = createWorkflow({ name: "item" })
			.then(
				createAgentStep({
					name: "judge",
					output: okSchema,
					background: true,
					resumable: "orchestrator",
					prompt: () => "rule",
				}),
			)
			.commit()

		expect(() =>
			createWorkflow({ name: "sequential-fanout" })
				.foreach(body, () => [{ n: 1 }, { n: 2 }], { name: "items", concurrency: 1 })
				.commit(),
		).not.toThrow()
	})

	it("rejects a key carrying node-path syntax, which would escape the sessions directory", () => {
		for (const key of ["../escape", "a#b", "a@b", ""]) {
			expect(() =>
				createWorkflow({ name: "bad-key" })
					.then(
						createAgentStep({ name: "step", output: okSchema, background: true, resumable: key, prompt: () => "go" }),
					)
					.commit(),
			).toThrow(/is not a valid resume key/)
		}
	})
})

/**
 * The PI host turns that key into a session file the harness writes and resumes; everything else gets a
 * file of its own. Both live in the ONE run-artifacts directory the bridge is bound to (project-dir.ts),
 * kept apart by the `-key-`/`-run-` infix rather than by a subdirectory (naming.ts).
 */
describe("the PI host's subagent invocation", () => {
	const noopPi = { on: () => {} } as never
	const sessionArg = (args: readonly string[]) => args[args.indexOf("--session") + 1] ?? ""

	it("names a keyed session file for a resumable step and a per-execution trace otherwise", async () => {
		const { createPiAgentBridge } = await import("../src/host/pi-agent.ts")
		const { spawn, calls } = scriptedSubagent(assistantLine("{}", 1))
		const start = createPiAgentBridge(
			noopPi,
			(args) => ({ command: "kimchi", args }),
			spawn,
		)({ find: () => undefined } as never, sessionsDir)

		await start(
			agentRequest({
				stepName: "worker",
				workflowName: "round",
				runId: "workflow-round-1a2b3c4d",
				path: "loop#2/worker",
				resumeKey: "worker",
				background: true,
			}),
		).sendAndAwaitEnd("go")
		await start(
			agentRequest({
				stepName: "looker",
				workflowName: "round",
				runId: "workflow-round-1a2b3c4d",
				path: "loop#2/looker",
				background: true,
			}),
		).sendAndAwaitEnd("go")

		const spawned = calls.map((call) => call.args)
		expect(calls.map((call) => call.command)).toEqual(["kimchi", "kimchi"])

		// Keyed: no run component at all, so the NEXT run of this workflow continues this conversation.
		expect(spawned[0]).toContain("--session")
		expect(spawned[0]).not.toContain("--no-session")
		expect(path.basename(sessionArg(spawned[0] ?? []))).toBe("workflow-round-key-worker.jsonl")

		// Trace: run + full node path + attempt, so nothing can ever resume it by accident.
		expect(spawned[1]).toContain("--session")
		expect(spawned[1]).not.toContain("--no-session")
		expect(path.basename(sessionArg(spawned[1] ?? []))).toBe("workflow-round-run-1a2b3c4d-loop-2.looker-a1.jsonl")
		// Both sit in the bound directory — one flat namespace, no `traces/` subdir any more.
		expect(path.dirname(sessionArg(spawned[1] ?? []))).toBe(sessionsDir)

		// And the spawned session is named, so it reads as something if it is ever opened in a picker.
		expect(spawned[1]?.[spawned[1].indexOf("--name") + 1]).toBe("round/loop#2/looker #1a2b3c4d")
	})

	it("gives every non-resumable execution its own trace file, so none of them resumes another", async () => {
		const { createPiAgentBridge } = await import("../src/host/pi-agent.ts")
		const { spawn, calls } = scriptedSubagent(assistantLine("{}", 1))
		const start = createPiAgentBridge(
			noopPi,
			(args) => ({ command: "kimchi", args }),
			spawn,
		)({ find: () => undefined } as never, sessionsDir)

		// Same step, same run: two ITEMS of a fan-out, then a retry of the second — each a file of its own.
		await start(agentRequest({ stepName: "verify", path: "items@0/verify", background: true })).sendAndAwaitEnd("look")
		await start(agentRequest({ stepName: "verify", path: "items@1/verify", background: true })).sendAndAwaitEnd(
			"look again",
		)
		await start(
			agentRequest({ stepName: "verify", path: "items@1/verify", attempt: 2, background: true }),
		).sendAndAwaitEnd("look once more")

		const paths = calls.map((call) => path.basename(sessionArg(call.args)))
		expect(new Set(paths).size).toBe(3)
		expect(paths).toEqual([
			"workflow-test-run-1a2b3c4d-items-0.verify-a1.jsonl",
			"workflow-test-run-1a2b3c4d-items-1.verify-a1.jsonl",
			"workflow-test-run-1a2b3c4d-items-1.verify-a2.jsonl",
		])
	})
})

/**
 * A subagent respawns the running harness to inherit its provider and auth; permission posture has to be
 * carried across explicitly, because a fresh process decides its own from its own argv. A benchmark run
 * launched with permissions bypassed had 59 tool calls refused inside subagent sessions and none in the
 * parent, losing a task whose worker could not install a package the task required.
 */
describe("permission posture is inherited by spawned subagents", () => {
	it("forwards only the bypass flags the parent itself was launched with", async () => {
		const { inheritedPermissionArgs } = await import("../src/host/pi-agent.ts")

		expect(inheritedPermissionArgs(["node", "cli.js", "--dangerously-skip-permissions"])).toEqual([
			"--dangerously-skip-permissions",
		])
		expect(inheritedPermissionArgs(["node", "cli.js", "--yolo"])).toEqual(["--yolo"])
		// A child can never come out more permissive than the parent that spawned it.
		expect(inheritedPermissionArgs(["node", "cli.js", "--print"])).toEqual([])
		// Not a general argv passthrough: the parent's session, prompt and everything else stay behind.
		expect(
			inheritedPermissionArgs(["node", "cli.js", "--session", "/tmp/main.jsonl", "--model", "x/y", "do the thing"]),
		).toEqual([])
	})

	it("puts the inherited flag on the spawned subagent's command line", async () => {
		const { createPiAgentBridge } = await import("../src/host/pi-agent.ts")
		const { spawn, calls } = scriptedSubagent(assistantLine("{}", 1))

		const realArgv = process.argv
		process.argv = [...realArgv, "--dangerously-skip-permissions"]
		try {
			const start = createPiAgentBridge(
				{ on: () => {} } as never,
				(args) => ({ command: "kimchi", args }),
				spawn,
			)({ find: () => undefined } as never, sessionsDir)
			await start(agentRequest({ stepName: "worker", background: true })).sendAndAwaitEnd("go")
		} finally {
			process.argv = realArgv
		}

		expect(calls[0]?.args).toContain("--dangerously-skip-permissions")
	})
})
