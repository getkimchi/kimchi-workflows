/**
 * Run-status derivation (spec §5.2, §5.3): no status field is authoritative on its own — the event
 * log decides, with step states (step-state.ts) as the intermediate view. Pure function over the log.
 */
import { deriveStepStates, type StepState, type StepStateKey } from "./step-state.ts";
import type { RunEvent } from "./types.ts";

/** A run's derived status (spec §5.2). */
export type RunStatus = "in_progress" | "blocked" | "completed" | "cancelled" | "crashed";

/**
 * Derive a run's status from its event log (spec §5.3), in precedence order:
 *
 *  1. any step `in_progress` → `in_progress` (work is happening, even if another step is simultaneously
 *     `blocked` — genuinely possible under concurrency, spec §3.4/§3.5/§8.6: a `.parallel`/`.foreach`
 *     arm can block while a sibling is still executing);
 *  2. else any step `blocked` → `blocked`;
 *  3. else the latest recorded run-level terminal event (`run-completed`/`run-cancelled`/`run-crashed`)
 *     decides. `completed` and `cancelled` are run-level facts that cannot be derived from step states
 *     alone (spec §5.3): a run completes when its final node completes, and a cold cancel (§6.4) can
 *     land on a run with no step executing at all. `crashed` is included in this same scan rather than
 *     kept as a separate "any step crashed" fallback (spec's literal 4th bullet): in this engine a step
 *     crash is *always* accompanied by exactly one `run-crashed` event (retries exhausted → the walk
 *     unwinds and `execute()` emits it, spec §9.5), so the two conditions never diverge, and folding
 *     them together also correctly handles a `run-crashed` with no `stepName` at all (a node-level
 *     crash — loop `maxIterations`, workflow input violation, resume drift check — which "any step
 *     crashed" alone could never catch, since no step is crashed);
 *  4. defensive fallback: a step recorded `crashed` with no matching terminal event (shouldn't happen
 *     given the above, but cheap to guard);
 *  5. otherwise `in_progress` — `run-started` recorded, nothing else yet.
 */
export function deriveRunStatus(events: readonly RunEvent[]): RunStatus | undefined {
  if (!events.some((event) => event.type === "run-started")) return undefined;

  const states = deriveStepStates(events);
  if (hasState(states, "in_progress")) return "in_progress";
  if (hasState(states, "blocked")) return "blocked";

  let terminal: RunStatus | undefined;
  for (const event of events) {
    if (event.type === "run-completed") terminal = "completed";
    else if (event.type === "run-cancelled") terminal = "cancelled";
    else if (event.type === "run-crashed") terminal = "crashed";
  }
  if (terminal) return terminal;

  if (hasState(states, "crashed")) return "crashed";
  return "in_progress";
}

function hasState(states: ReadonlyMap<StepStateKey, StepState>, target: StepState): boolean {
  for (const value of states.values()) if (value === target) return true;
  return false;
}

/**
 * The step a listing should show as "current" for a run (spec §6.3): whichever step matches the run's
 * own derived status (its `in_progress`/`blocked` step while live, or the step it stopped at when
 * `crashed`/`cancelled`). `undefined` for a cleanly `completed` run, or one that hasn't touched a step
 * yet. Under concurrency more than one step can genuinely match (spec §3.4/§3.5/§8.6); this reports the
 * first one found and callers that need the full set (e.g. pending-question counts) use
 * `pendingQuestionCount`/`deriveStepStates` directly rather than this single-name convenience.
 */
export function currentStepName(status: RunStatus, states: ReadonlyMap<StepStateKey, StepState>): string | undefined {
  if (status === "completed") return undefined;
  for (const [key, value] of states) if (value === status) return key;
  return undefined;
}

/**
 * How many steps are currently `blocked` (spec §6.3): not decoration — a run with one blocked step and
 * one executing step reads `in_progress` (§5.3), so without this a waiting question is invisible.
 */
export function pendingQuestionCount(states: ReadonlyMap<StepStateKey, StepState>): number {
  let count = 0;
  for (const value of states.values()) if (value === "blocked") count += 1;
  return count;
}
