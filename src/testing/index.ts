/**
 * Workflow testing framework (public): drive a committed workflow through its states against a fake
 * host — no PI, no filesystem, no network.
 *
 * ```ts
 * const parked = await createTestRun(planningWorkflow, {
 *   agents: { plan: [ask({ questions: [...] }), reply({ steps: [...], summary: "..." })] },
 * });
 *
 * const done = await parked.answer({ backend: "Redis" });
 * ```
 */

export type { AgentDouble, AgentRecord, AgentScripts, AgentTurnScript } from "./agent-double.ts";
export { ask, createAgentDouble, raw, reply, throws, usage } from "./agent-double.ts";
export type { TestRun, TestRunOptions } from "./test-run.ts";
export { createTestRun } from "./test-run.ts";
