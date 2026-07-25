/**
 * Workflow testing framework (public): drive a committed workflow through its states against a fake
 * host — no PI, no filesystem, no network.
 *
 * ```ts
 * const blocked = await createTestRun(planningWorkflow, {
 *   agents: { plan: [ask({ questions: [...] }), reply({ steps: [...], summary: "..." })] },
 * });
 *
 * const done = await blocked.answer({ backend: "Redis" });
 * ```
 */

export type { StepState } from "../engine/step-state.ts";
export type { AgentDouble, AgentRecord, AgentScripts, AgentTurnScript } from "./agent-double.ts";
export { ask, createAgentDouble, raw, reply, throws, usage } from "./agent-double.ts";
export type { StepOverride, StepOverrides } from "./step-override.ts";
export { applyStepOverrides } from "./step-override.ts";
export type { PendingQuestion, TestRun, TestRunOptions } from "./test-run.ts";
export { createTestRun } from "./test-run.ts";
