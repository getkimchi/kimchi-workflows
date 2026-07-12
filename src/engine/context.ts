/**
 * Shared execution state and per-run helpers for the engine. Pure — no PI/fs/network.
 */
import type { Questionnaire } from "../flow/questionnaire.ts";
import type { RunContext, StepLogger } from "../flow/types.ts";
import type { HostPort } from "./types.ts";

/** Immutable run identity + the mutable shared run context (`stepOutputs`) threaded through the node tree. */
export interface RunState {
  readonly runId: string;
  readonly workflowName: string;
  readonly initialInput: unknown;
  /** Prior node/step outputs by name; a live view backing `ctx.getStepResult`. Mutated as nodes complete. */
  readonly stepOutputs: Map<string, unknown>;
  /** Workflow default model for agent steps that declare none (spec §9.5). */
  readonly defaultModel?: string;
}

/** Outcome of running a step under its policies (step-runner). Identity (`stepName`) is attached by the caller. */
export type StepOutcome =
  | { kind: "ok"; output: unknown }
  | { kind: "crashed"; error: string }
  | { kind: "cancelled" }
  // A step asked a `questionnaire` batch (spec §10): the run parks. `conversation` resumes the same loop.
  | { kind: "parked"; questionnaire: Questionnaire; conversation: readonly unknown[] };

/** Outcome of executing a node or a node sequence. `ok` carries the value handed to the next node. */
export type ExecOutcome =
  | { kind: "ok"; output: unknown }
  | { kind: "crashed"; error: string; stepName?: string }
  | { kind: "cancelled"; stepName?: string }
  | { kind: "parked"; stepName: string; questionnaire: Questionnaire; conversation: readonly unknown[] };

export function iso(host: HostPort): string {
  return host.now().toISOString();
}

export function createRunContext(state: RunState): RunContext {
  return {
    runId: state.runId,
    workflowName: state.workflowName,
    getStepResult: <T>(stepName: string) => state.stepOutputs.get(stepName) as T | undefined,
    getInitData: <T>() => state.initialInput as T | undefined,
  };
}

export function createStepLogger(host: HostPort, runId: string, stepName: string): StepLogger {
  const log = (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => {
    void host.emit({ type: "step-log", runId, stepName, level, message, data, at: iso(host) });
  };
  return {
    info: (message, data) => log("info", message, data),
    warn: (message, data) => log("warn", message, data),
    error: (message, data) => log("error", message, data),
  };
}
