/**
 * The engine's concurrency seam (spec §3.5/§3.6/§9.5): a deterministic, promise-driven bounded-pool
 * scheduler used by `.parallel` and `.foreach(concurrency > 1)`. No timers, no real races — every
 * transition here is a plain promise resolution, so a test can force ANY interleaving it wants simply
 * by controlling exactly when the tasks IT supplies resolve (e.g. hand-rolled deferred promises a step
 * body awaits) — never by hoping about scheduling. This is what makes concurrency testable without a
 * green suite hiding a race (see the module's tests, scheduler.test.ts, and the workflow-level
 * concurrency tests in parallel.test.ts / foreach-concurrency.test.ts).
 *
 * Two pieces, deliberately unaware of each other:
 *  - {@link ConcurrencyGate} — the RUN-WIDE ceiling (spec §3.6): one instance per run, shared by every
 *    construct (including nested workflows, which inherit it — see `RunState.concurrencyGate`). It is
 *    held by a STEP, for exactly as long as that step executes (`runStepNode`, execute.ts), so the
 *    ceiling bounds "steps executing at once" across the whole tree, exactly as spec §3.6 words it.
 *    Gating the enclosing CONSTRUCT instead would deadlock the moment constructs nest: a foreach at the
 *    ceiling would hold every slot while its items waited for slots for their own inner fan-out.
 *  - {@link runConcurrent} — runs one construct's own items/arms, bounded by a LOCAL cap (a foreach's
 *    own `concurrency`, or the ceiling for a parallel, which declares none). Since a leaf step is what
 *    holds a gate slot, this needs no gate of its own — lanes are the construct's shape, slots are the
 *    run's budget. Implements drain-then-crash (spec §9.5): once any settled result asks to stop, no
 *    further items START: already running ones finish naturally.
 *
 * Pure — no fs/PI/network/setTimeout.
 */

/** A run-wide semaphore (spec §3.6): at most `limit` holders at once, FIFO wake order. */
export interface ConcurrencyGate {
	/** The ceiling this gate was sized to — also what a `.parallel` (which declares no cap of its own) uses as its lane count. */
	readonly limit: number
	/** Resolve once a slot is free (immediately if one already is). */
	acquire(): Promise<void>
	/** Release a held slot, waking the longest-waiting queued acquirer, if any. */
	release(): void
}

/** Create a fresh gate sized to a run's concurrency ceiling (spec §3.6). */
export function createConcurrencyGate(limit: number): ConcurrencyGate {
	const capacity = Math.max(1, limit)
	let active = 0
	const queue: Array<() => void> = []

	return {
		limit: capacity,
		acquire(): Promise<void> {
			if (active < capacity) {
				active += 1
				return Promise.resolve()
			}
			return new Promise<void>((resolve) => {
				queue.push(() => {
					active += 1
					resolve()
				})
			})
		},
		release(): void {
			active -= 1
			const next = queue.shift()
			if (next) next()
		},
	}
}

/**
 * Run `items` through `worker` in at most `localLimit` lanes — this construct's own concurrency cap (a
 * foreach's declared `concurrency`, or the run's ceiling for a parallel, which declares none). Results
 * land at their ITEM'S OWN INDEX in the returned array regardless of completion order (spec §3.4/§3.5's
 * item/name-ordering guarantee starts here). The run-wide ceiling is enforced one level down, by the
 * steps themselves (see the module header), so nothing here touches the gate.
 *
 * Drain-then-crash (spec §9.5): `shouldStop` is checked against each settled result; once it returns
 * true, no further items are STARTED — a lane claims its next item only after its current one settled,
 * so the check is always seen before the claim. Items already running are not interrupted: they finish
 * and checkpoint normally, per spec. Items that never start stay whatever `results[i]` starts as (the
 * caller distinguishes "ran" from "never started" itself, e.g. via a discriminated `TResult`).
 */
export async function runConcurrent<TItem, TResult>(
	items: readonly TItem[],
	worker: (item: TItem, index: number) => Promise<TResult>,
	localLimit: number,
	shouldStop: (result: TResult) => boolean,
): Promise<(TResult | undefined)[]> {
	const results: (TResult | undefined)[] = new Array(items.length)
	if (items.length === 0) return results

	let nextIndex = 0
	let stopped = false
	const claimNext = (): number | undefined => {
		if (stopped || nextIndex >= items.length) return undefined
		const claimed = nextIndex
		nextIndex += 1
		return claimed
	}

	const lane = async (): Promise<void> => {
		for (let index = claimNext(); index !== undefined; index = claimNext()) {
			const result = await worker(items[index] as TItem, index)
			results[index] = result
			if (shouldStop(result)) stopped = true
		}
	}

	const laneCount = Math.max(1, Math.min(localLimit, items.length))
	await Promise.all(Array.from({ length: laneCount }, () => lane()))
	return results
}
