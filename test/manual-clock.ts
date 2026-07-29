/**
 * A controllable clock for deterministic time-budget tests. `sleep(ms)` registers a pending timer
 * that resolves only when the test fires it — so a fast step that resolves on its own is never timed
 * out, and the exceed case is triggered by `fireAll()` while the step awaits its abort signal.
 *
 * `sleep` also resolves immediately if its `signal` aborts (mirroring the real host), so a step that
 * finishes within budget cleanly cancels its timer.
 */
export interface ManualClock {
	sleep(ms: number, signal?: AbortSignal): Promise<void>
	/** Resolves once at least one timer is pending (waiting for the engine to register the budget timer). */
	waitForTimer(): Promise<void>
	/** Fire (resolve) all currently-pending timers. */
	fireAll(): void
	/** Count of currently-pending timers. */
	readonly pendingCount: number
}

export function createManualClock(): ManualClock {
	let pending: Array<() => void> = []
	let notifyRegistered: (() => void) | undefined

	const sleep = (_ms: number, signal?: AbortSignal): Promise<void> =>
		new Promise<void>((resolve) => {
			if (signal?.aborted) return resolve()
			pending.push(resolve)
			signal?.addEventListener("abort", () => resolve(), { once: true })
			const notify = notifyRegistered
			notifyRegistered = undefined
			notify?.()
		})

	const waitForTimer = (): Promise<void> => {
		if (pending.length > 0) return Promise.resolve()
		return new Promise<void>((resolve) => {
			notifyRegistered = resolve
		})
	}

	const fireAll = (): void => {
		const timers = pending
		pending = []
		for (const resolve of timers) resolve()
	}

	return {
		sleep,
		waitForTimer,
		fireAll,
		get pendingCount() {
			return pending.length
		},
	}
}
