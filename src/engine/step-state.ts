/**
 * Step-state derivation (spec §5.1, §5.4): a pure function over the event log. No fs, no PI, no
 * clock reads of its own — it only walks events already carrying their own `at` timestamps.
 */
import type { RunEvent } from "./types.ts";

/** A step's lifecycle state (spec §5.1). Exactly one at a time. */
export type StepState = "todo" | "in_progress" | "blocked" | "completed" | "skipped" | "cancelled" | "crashed";

/**
 * The addressing key a step's state is keyed by (spec §5.4: "static node path"). Node-path
 * addressing (enclosing nodes + iteration/item index + name) is P2 work; today the tree is globally
 * name-unique (`assertUniqueNames` in create-workflow.ts), so the step/arm name alone is already a
 * collision-free key. Kept as a distinct type — not a bare `string` at call sites — so P2 can swap
 * `keyOf` below for real path construction without changing `deriveStepStates`'s callers.
 */
export type StepStateKey = string;

/** Today: the key IS the name. P2 replaces this with node-path construction (enclosing scope + iteration/item index + name). */
function keyOf(name: string): StepStateKey {
  return name;
}

/**
 * Derive every step's current state from a run's event log (spec §5.1, §5.4).
 *
 * Latest execution wins: a step reflects only its most recently emitted state (a step re-entered by a
 * loop iteration simply overwrites its own map entry — no loop-awareness needed since each iteration
 * re-emits the same step name's events). A branch arm whose condition was false is `skipped` directly
 * from its `branch-arm` event; the arm's OWN name is the key (its body's individual steps, if any,
 * simply never run and stay `todo` — enumerating them would require walking the `WorkflowDefinition`,
 * which is exactly the kind of thing node-path addressing in P2 exists for).
 *
 * A run-level terminal event (`run-crashed`/`run-cancelled`) force-closes any step still `in_progress`
 * or `blocked` at that point to the same terminal state, even when the event carries no `stepName`
 * (a node-level crash — e.g. a loop's `maxIterations` guard, a workflow input violation, or a resume's
 * definition-drift check — has no single step to attribute to) or when it names a *different* step than
 * the one left open (a cold cancel of a blocked run, spec §6.4, records `run-cancelled` with no
 * `stepName` at all). Without this, a step blocked when its run later crashed for an unrelated reason
 * would read `blocked` forever, even though nothing is waiting on it any more (spec §5.1: `blocked`
 * means, and only ever means, waiting on a human).
 */
export function deriveStepStates(events: readonly RunEvent[]): Map<StepStateKey, StepState> {
  const states = new Map<StepStateKey, StepState>();
  const open = new Set<StepStateKey>(); // keys currently in_progress or blocked

  const set = (name: string, state: StepState): void => {
    const key = keyOf(name);
    states.set(key, state);
    if (state === "in_progress" || state === "blocked") {
      open.add(key);
    } else {
      open.delete(key);
    }
  };

  const closeOpen = (state: "crashed" | "cancelled"): void => {
    for (const key of open) states.set(key, state);
    open.clear();
  };

  for (const event of events) {
    switch (event.type) {
      case "step-started":
      case "step-retry":
      case "agent-steer":
      case "answers-provided":
        set(event.stepName, "in_progress");
        break;
      case "step-completed":
        set(event.stepName, "completed");
        break;
      case "questionnaire-asked":
        set(event.stepName, "blocked");
        break;
      case "branch-arm":
        if (!event.taken) set(event.armName, "skipped");
        break;
      case "run-crashed":
        if (event.stepName) set(event.stepName, "crashed");
        closeOpen("crashed");
        break;
      case "run-cancelled":
        if (event.stepName) set(event.stepName, "cancelled");
        closeOpen("cancelled");
        break;
      default:
        break; // run-started/resumed, node/loop/foreach lifecycle, step-log: no step-state effect
    }
  }

  return states;
}

/** One step's derived state (`todo` when it has no recorded events yet). */
export function stepState(states: ReadonlyMap<StepStateKey, StepState>, name: string): StepState {
  return states.get(keyOf(name)) ?? "todo";
}
