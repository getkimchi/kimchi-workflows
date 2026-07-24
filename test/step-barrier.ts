/**
 * A deterministic interleaving control for concurrency tests (P3's governing constraint: no
 * `setTimeout`, no real races). A step body calls `barrier.enter(key)` to record "I have started" and
 * then suspend; the TEST decides when it resumes by calling `barrier.release(key)` — so a test can
 * assert "exactly these items are concurrently in flight" before releasing any of them, and release
 * them in whatever order it wants to force out-of-order completion, all via plain promise resolution
 * (no timers, no hoping about scheduling).
 */
export interface StepBarrier<K> {
  /** Record arrival at `key` and suspend until the test calls `release(key)`. */
  enter(key: K): Promise<void>;
  /** Resume whichever `enter(key)` call is currently waiting (or the next one, if it hasn't arrived yet). */
  release(key: K): void;
  /**
   * Resolve once `key` is currently inside `enter` (has arrived, not yet released). Keyed on the
   * SPECIFIC key rather than a bare count, so a caller can't be fooled by a stale, about-to-be-released
   * OTHER key coincidentally keeping the live set's size at the expected number.
   */
  waitFor(key: K): Promise<void>;
  /** Keys currently inside `enter`, awaiting `release` — a live snapshot. */
  readonly entered: ReadonlySet<K>;
}

export function createStepBarrier<K = string>(): StepBarrier<K> {
  const entered = new Set<K>();
  const gates = new Map<K, { promise: Promise<void>; resolve: () => void }>();
  const arrivalWaiters = new Map<K, Array<() => void>>();

  const gateFor = (key: K): { promise: Promise<void>; resolve: () => void } => {
    let gate = gates.get(key);
    if (!gate) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      gate = { promise, resolve };
      gates.set(key, gate);
    }
    return gate;
  };

  return {
    async enter(key: K): Promise<void> {
      entered.add(key);
      const waiters = arrivalWaiters.get(key);
      if (waiters) {
        arrivalWaiters.delete(key);
        for (const notify of waiters) notify();
      }
      await gateFor(key).promise;
      entered.delete(key);
    },
    release(key: K): void {
      gateFor(key).resolve();
    },
    waitFor(key: K): Promise<void> {
      if (entered.has(key)) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const waiters = arrivalWaiters.get(key) ?? [];
        waiters.push(resolve);
        arrivalWaiters.set(key, waiters);
      });
    },
    get entered(): ReadonlySet<K> {
      return entered;
    },
  };
}
