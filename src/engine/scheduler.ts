/**
 * The engine's concurrency seam (spec §3.5/§3.6/§9.5): a deterministic, promise-driven bounded-pool
 * scheduler used by `.parallel` and `.foreach(concurrency > 1)`. No timers, no real races — every
 * transition here is a plain promise resolution, so a test can force ANY interleaving it wants simply
 * by controlling exactly when the tasks IT supplies resolve (e.g. hand-rolled deferred promises a step
 * body awaits) — never by hoping about scheduling. This is what makes concurrency testable without a
 * green suite hiding a race (see the module's tests, scheduler.test.ts, and the workflow-level
 * concurrency tests in parallel.test.ts / foreach-concurrency.test.ts).
 *
 * Two pieces:
 *  - {@link ConcurrencyGate} — the RUN-WIDE ceiling (spec §3.6): one instance per run, shared by every
 *    construct (including nested workflows, which inherit it — see `RunState.concurrencyGate`), so the
 *    ceiling bounds TOTAL in-flight steps across the whole tree, not per construct.
 *  - {@link runConcurrent} — runs one construct's own items/arms through that shared gate, additionally
 *    bounded by a LOCAL cap (a foreach's own `concurrency`, or a parallel's arm count). Implements
 *    drain-then-crash (spec §9.5): once any settled result asks to stop, no further items START: already
 *    running ones finish naturally.
 *
 * Pure — no fs/PI/network/setTimeout.
 */

/** A run-wide semaphore (spec §3.6): at most `limit` holders at once, FIFO wake order. */
export interface ConcurrencyGate {
  /** Resolve once a slot is free (immediately if one already is). */
  acquire(): Promise<void>;
  /** Release a held slot, waking the longest-waiting queued acquirer, if any. */
  release(): void;
}

/** Create a fresh gate sized to a run's concurrency ceiling (spec §3.6). */
export function createConcurrencyGate(limit: number): ConcurrencyGate {
  const capacity = Math.max(1, limit);
  let active = 0;
  const queue: Array<() => void> = [];

  return {
    acquire(): Promise<void> {
      if (active < capacity) {
        active += 1;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        queue.push(() => {
          active += 1;
          resolve();
        });
      });
    },
    release(): void {
      active -= 1;
      const next = queue.shift();
      if (next) next();
    },
  };
}

/**
 * Run `items` through `worker`, each acquiring a slot from the shared run-wide `gate` (spec §3.6) AND
 * respecting `localLimit` — this construct's own concurrency cap (a foreach's declared `concurrency`,
 * or `items.length` for a parallel, which has none). Results land at their ITEM'S OWN INDEX in the
 * returned array regardless of completion order (spec §3.4/§3.5's item/name-ordering guarantee starts
 * here).
 *
 * Drain-then-crash (spec §9.5): `shouldStop` is checked against each settled result; once it returns
 * true, no further items are STARTED (an item already past `gate.acquire()` and running is not
 * interrupted — it finishes and checkpoints normally, per spec). Already-queued-but-not-yet-started
 * items simply never run, staying whatever `results[i]` starts as (the caller distinguishes "ran" from
 * "never started" itself, e.g. via a discriminated `TResult`).
 */
export async function runConcurrent<TItem, TResult>(
  items: readonly TItem[],
  worker: (item: TItem, index: number) => Promise<TResult>,
  gate: ConcurrencyGate,
  localLimit: number,
  shouldStop: (result: TResult) => boolean,
): Promise<(TResult | undefined)[]> {
  const results: (TResult | undefined)[] = new Array(items.length);
  if (items.length === 0) return results;

  let nextIndex = 0;
  let stopped = false;
  const claimNext = (): number | undefined => {
    if (stopped || nextIndex >= items.length) return undefined;
    const claimed = nextIndex;
    nextIndex += 1;
    return claimed;
  };

  const runOne = async (index: number): Promise<void> => {
    await gate.acquire();
    try {
      if (stopped) return; // crashed elsewhere while this lane waited for a slot — never start
      const result = await worker(items[index] as TItem, index);
      results[index] = result;
      if (shouldStop(result)) stopped = true;
    } finally {
      gate.release();
    }
  };

  const lane = async (): Promise<void> => {
    for (let index = claimNext(); index !== undefined; index = claimNext()) {
      await runOne(index);
    }
  };

  const laneCount = Math.max(1, Math.min(localLimit, items.length));
  await Promise.all(Array.from({ length: laneCount }, () => lane()));
  return results;
}
