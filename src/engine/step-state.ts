/**
 * Step-state derivation (spec §5.1, §5.4): a pure function over the event log. No fs, no PI, no
 * clock reads of its own — it only walks events already carrying their own `at` timestamps.
 */
import { parsePath, staticKeyOf } from "./node-path.ts"
import type { RunEvent } from "./types.ts"

/** A step's lifecycle state (spec §5.1). Exactly one at a time. */
export type StepState = "todo" | "in_progress" | "blocked" | "completed" | "skipped" | "cancelled" | "crashed"

/**
 * The addressing key a step's state is keyed by (spec §5.4: "static node path" — the node path with
 * iteration/item indices dropped, e.g. `until-valid/design`). Latest execution wins: a step re-entered
 * by a new loop iteration or foreach item simply overwrites its own map entry.
 */
export type StepStateKey = string

/** An event's dynamic `path` (spec §8.5), reduced to the static key `deriveStepStates` keys its map by. */
function keyOf(path: string): StepStateKey {
	return staticKeyOf(parsePath(path))
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
	const states = new Map<StepStateKey, StepState>()
	const open = new Set<StepStateKey>() // keys currently in_progress or blocked
	const takenArms = new Set<StepStateKey>() // branch arms that ran, closed by their own node-completed

	const set = (path: string, state: StepState): void => {
		const key = keyOf(path)
		states.set(key, state)
		if (state === "in_progress" || state === "blocked") {
			open.add(key)
		} else {
			open.delete(key)
		}
	}

	const closeOpen = (state: "crashed" | "cancelled"): void => {
		for (const key of open) states.set(key, state)
		open.clear()
	}

	for (const event of events) {
		switch (event.type) {
			case "step-started":
			case "step-retry":
			case "agent-steer":
			case "answers-provided":
				set(event.path, "in_progress")
				break
			case "step-completed":
				set(event.path, "completed")
				break
			case "step-failed":
				// The STEP crashed even though the run continued (spec §9.1's `optional`), and a listing that
				// said otherwise would hide exactly the thing an author turned this on to find out about.
				set(event.path, "crashed")
				break
			case "questionnaire-asked":
				set(event.path, "blocked")
				break
			case "branch-arm":
				// A skipped arm is terminal immediately. A taken arm opens like any other unit of work and is
				// closed by its own `node-completed` below — without that pairing a taken arm would read `todo`
				// for the life of the run, so a completed run would list unfinished-looking work (spec §5.1).
				if (event.taken) {
					takenArms.add(keyOf(event.path))
					set(event.path, "in_progress")
				} else {
					set(event.path, "skipped")
				}
				break
			case "node-completed":
				if (takenArms.has(keyOf(event.path))) set(event.path, "completed")
				break
			case "step-cancelled":
				// A blocked sibling abandoned by a drain (spec §9.5): cancelled directly, distinct from the
				// blanket run-crashed force-close below (which still applies to whatever step IS attributed
				// to the crash, or a lone open step left over with no concurrency involved at all).
				set(event.path, "cancelled")
				break
			case "run-crashed":
				if (event.path) set(event.path, "crashed")
				closeOpen("crashed")
				break
			case "run-cancelled":
				if (event.path) set(event.path, "cancelled")
				closeOpen("cancelled")
				break
			default:
				break // run-started/resumed, node/loop/foreach lifecycle, step-log: no step-state effect
		}
	}

	return states
}

/** One step's derived state (`todo` when it has no recorded events yet). */
export function stepState(states: ReadonlyMap<StepStateKey, StepState>, name: string): StepState {
	return states.get(keyOf(name)) ?? "todo"
}
