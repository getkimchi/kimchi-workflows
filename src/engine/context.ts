/**
 * Shared execution state and per-run helpers for the engine. Pure — no PI/fs/network.
 */
import type { Questionnaire } from "../flow/questionnaire.ts";
import type { RunContext, StepLogger } from "../flow/types.ts";
import { formatPath, type NodePath, parsePath, staticKeyOf, staticPathOf } from "./node-path.ts";
import type { HostPort } from "./types.ts";

/** Immutable run identity + the mutable shared run context (`stepOutputs`) threaded through the node tree. */
export interface RunState {
  readonly runId: string;
  readonly workflowName: string;
  readonly initialInput: unknown;
  /**
   * Prior node/step outputs, keyed by STATIC node path (spec §5.4: indices dropped) — a live view
   * backing `ctx.getStepResult`, mutated as nodes complete. Static keying is what makes a loop or
   * foreach body's OWN steps resolvable by bare name from within the current iteration/item (the
   * only entry there is) while an outer reader sees the latest iteration's value (spec §5.4/§3.9).
   */
  readonly stepOutputs: Map<string, unknown>;
  /** Workflow default model for agent steps that declare none (spec §9.5). */
  readonly defaultModel?: string;
  /**
   * Resume-only (spec §8.2/§8.5): every foreach's recorded per-item outputs, keyed by the foreach's
   * own DYNAMIC path (no item index — e.g. `until-valid#3/batch`), each value a map of item index →
   * output. Lets ANY foreach in the tree — not just a top-level one — skip its completed items on
   * resume, whether re-entering deep inside it (spec §8.5) or restarting it node-atomically (§8.2).
   */
  readonly foreachItemHistory?: ReadonlyMap<string, ReadonlyMap<number, unknown>>;
}

/** Outcome of running a step under its policies (step-runner). Identity (`path`) is attached by the caller. */
export type StepOutcome =
  | { kind: "ok"; output: unknown }
  | { kind: "crashed"; error: string }
  | { kind: "cancelled" }
  // A step asked a `questions` batch (spec §10): the run blocks. `conversation` resumes the same loop.
  // `violation` is set only when a questionnaire step re-blocks because the delivered answers were invalid.
  | { kind: "blocked"; questionnaire: Questionnaire; conversation: readonly unknown[]; violation?: string };

/** Outcome of executing a node or a node sequence. `ok` carries the value handed to the next node. */
export type ExecOutcome =
  | { kind: "ok"; output: unknown }
  | { kind: "crashed"; error: string; path?: string }
  | { kind: "cancelled"; path?: string }
  | { kind: "blocked"; path: string; questionnaire: Questionnaire; conversation: readonly unknown[]; violation?: string };

export function iso(host: HostPort): string {
  return host.now().toISOString();
}

/**
 * Build the run context a step body / condition / selector sees (spec §2.5/§3.9). `callerParentPath`
 * is the CALLING node's own enclosing scope (its ancestors, itself excluded) — indices are dropped
 * internally, since `stepOutputs` is static-keyed throughout (see {@link RunState.stepOutputs}).
 */
export function createRunContext(state: RunState, callerParentPath: NodePath): RunContext {
  const staticParent = staticPathOf(callerParentPath);
  return {
    runId: state.runId,
    workflowName: state.workflowName,
    getStepResult: <T>(nameOrPath: string) => resolveStepResult(state.stepOutputs, staticParent, nameOrPath) as T | undefined,
    getInitData: <T>() => state.initialInput as T | undefined,
  };
}

/**
 * Resolve a `getStepResult` argument (spec §3.9): an explicit path (contains `/` or `#`) is looked up
 * exactly, by its static key — always unambiguous, since a path names one node. A bare name is
 * resolved lexically to the nearest enclosing scope: search the caller's own scope, then each
 * ancestor scope outward to the root, returning the first match. This is deterministic by
 * construction — at every level there is at most one node with a given name (enclosing scopes are
 * validated unique at `.commit()`, spec §3) — so a bare read never races or guesses; it just may find
 * nothing (a step not yet reached, or one outside the caller's lexical scope, reads `undefined`).
 */
function resolveStepResult(stepOutputs: ReadonlyMap<string, unknown>, staticCallerParentPath: NodePath, nameOrPath: string): unknown {
  if (nameOrPath.includes("/") || nameOrPath.includes("#")) {
    const key = staticKeyOf(parsePath(nameOrPath));
    return stepOutputs.get(key);
  }
  for (let i = staticCallerParentPath.length; i >= 0; i--) {
    const prefix = staticCallerParentPath.slice(0, i);
    const key = prefix.length === 0 ? nameOrPath : `${formatPath(prefix)}/${nameOrPath}`;
    if (stepOutputs.has(key)) return stepOutputs.get(key);
  }
  return undefined;
}

export function createStepLogger(host: HostPort, runId: string, path: string): StepLogger {
  const log = (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => {
    void host.emit({ type: "step-log", runId, path, level, message, data, at: iso(host) });
  };
  return {
    info: (message, data) => log("info", message, data),
    warn: (message, data) => log("warn", message, data),
    error: (message, data) => log("error", message, data),
  };
}
