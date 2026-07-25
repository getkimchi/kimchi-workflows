import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { runWorkflow } from "../src/engine/run-workflow.ts";
import type { AgentRequest } from "../src/engine/types.ts";
import { createAgentStep, createStep, createWorkflow } from "../src/flow/index.ts";
import { createTestHost } from "./helpers.ts";
import { scriptedAgent } from "./scripted-agent.ts";

const okSchema = Type.Object({ ok: Type.Boolean() });

/** Records what each opened session was asked for, so the seam itself can be asserted. */
function recordingAgent(replies: readonly string[]) {
  const requests: AgentRequest[] = [];
  const inner = scriptedAgent(replies.map((reply) => [reply]));
  return {
    requests,
    startAgent: (request: AgentRequest) => {
      requests.push(request);
      return inner.startAgent(request);
    },
  };
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
      .then(createAgentStep({ name: "worker", output: okSchema, background: true, resumable: true, prompt: () => "work" }))
      .commit();
    const workflow = createWorkflow({ name: "resumable" })
      .dowhile(body, (ctx) => (ctx.getStepResult<{ n: number }>("rounds")?.n ?? 0) < 2, { name: "loop", maxIterations: 3 })
      .commit();

    // Two rounds, so the step executes twice; both must carry the same resume key.
    const agent = recordingAgent([JSON.stringify({ ok: true }), JSON.stringify({ ok: true }), JSON.stringify({ ok: true })]);
    const { host } = createTestHost({ startAgent: agent.startAgent });
    await runWorkflow(workflow, undefined, host);

    expect(agent.requests.length).toBeGreaterThanOrEqual(2);
    for (const request of agent.requests) {
      expect(request.resumeKey).toBe("worker");
      expect(request.background).toBe(true);
    }
  });

  it("says nothing about resuming for an ordinary step, keeping the cheap cold-start default", async () => {
    const workflow = createWorkflow({ name: "not-resumable" })
      .then(createAgentStep({ name: "fresh", output: okSchema, background: true, prompt: () => "look" }))
      .commit();

    const agent = recordingAgent([JSON.stringify({ ok: true })]);
    const { host } = createTestHost({ startAgent: agent.startAgent });
    await runWorkflow(workflow, undefined, host);

    expect(agent.requests[0]?.resumeKey).toBeUndefined();
  });

  it("keeps the key stable across a retry, since the point is continuity of one step's work", async () => {
    const workflow = createWorkflow({ name: "resumable-retry" })
      .then(createAgentStep({ name: "worker", output: okSchema, background: true, resumable: true, retry: { maxRetry: 1 }, prompt: () => "work" }))
      .commit();

    // First attempt replies with invalid output; the retry opens a second session for the same step.
    const agent = recordingAgent(["not json at all", JSON.stringify({ ok: true })]);
    const { host } = createTestHost({ startAgent: agent.startAgent });
    const result = await runWorkflow(workflow, undefined, host);

    expect(result.status).toBe("completed");
    expect(agent.requests.map((r) => r.resumeKey)).toEqual(["worker", "worker"]);
  });
});

/** The PI host turns that key into a session file the harness writes and resumes; everything else stays ephemeral. */
describe("the PI host's subagent invocation", () => {
  it("names a session file for a resumable step and stays ephemeral otherwise", async () => {
    const { createPiAgentBridge } = await import("../src/host/pi-agent.ts");
    const spawned: string[][] = [];
    const pi = {
      on: () => {},
      exec: async (_command: string, args: string[]) => {
        spawned.push(args);
        return {
          code: 0,
          stdout: JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "{}" }], usage: { totalTokens: 1 } } }),
          stderr: "",
        };
      },
    } as never;
    const start = createPiAgentBridge(pi, (args) => ({ command: "kimchi", args }))({ find: () => undefined } as never);

    await start({ stepName: "worker", background: true, resumeKey: "worker" }).sendAndAwaitEnd("go");
    await start({ stepName: "looker", background: true }).sendAndAwaitEnd("go");

    expect(spawned[0]).toContain("--session");
    expect(spawned[0]?.join(" ")).toContain("worker.jsonl");
    expect(spawned[0]).not.toContain("--no-session");
    expect(spawned[1]).toContain("--no-session");
    expect(spawned[1]).not.toContain("--session");
  });
});
