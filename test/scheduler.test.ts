import { describe, expect, it } from "vitest";
import { createConcurrencyGate, runConcurrent } from "../src/engine/scheduler.ts";
import { createStepBarrier } from "./step-barrier.ts";

/**
 * Direct unit tests of the scheduler seam (spec §3.5/§3.6/§9.5) — the piece the whole of P3's
 * concurrency rests on. Every interleaving here is driven explicitly via `StepBarrier` (deferred
 * promises the test resolves by hand): no `setTimeout`, no `Promise.all` and hoping about order.
 */
describe("createConcurrencyGate (spec §3.6): a run-wide semaphore", () => {
  it("admits up to `limit` holders immediately, queues the rest, and wakes them FIFO on release", async () => {
    const gate = createConcurrencyGate(2);
    const order: string[] = [];

    const a = gate.acquire().then(() => order.push("a"));
    const b = gate.acquire().then(() => order.push("b"));
    await Promise.all([a, b]);
    expect(order).toEqual(["a", "b"]); // both admitted immediately — capacity 2

    let cAdmitted = false;
    const c = gate.acquire().then(() => {
      cAdmitted = true;
      order.push("c");
    });
    let dAdmitted = false;
    const d = gate.acquire().then(() => {
      dAdmitted = true;
      order.push("d");
    });
    await Promise.resolve(); // let any (incorrect) immediate admission surface
    expect(cAdmitted).toBe(false);
    expect(dAdmitted).toBe(false); // both queued — capacity already full

    gate.release(); // frees one slot
    await c;
    expect(order).toEqual(["a", "b", "c"]); // c (queued first) woke, not d

    gate.release();
    await d;
    expect(order).toEqual(["a", "b", "c", "d"]);
  });
});

describe("runConcurrent (spec §3.4/§3.5): a construct's own bounded lane pool", () => {
  it("never runs more than `localLimit` items at once, and results land at each item's own index regardless of completion order", async () => {
    const barrier = createStepBarrier<number>();
    let current = 0;
    let maxConcurrent = 0;

    const promise = runConcurrent(
      [0, 1, 2, 3],
      async (item) => {
        current += 1;
        maxConcurrent = Math.max(maxConcurrent, current);
        await barrier.enter(item);
        current -= 1;
        return item * 10;
      },
      2, // local cap: at most 2 in flight
      () => false,
    );

    await Promise.all([barrier.waitFor(0), barrier.waitFor(1)]);
    expect(barrier.entered).toEqual(new Set([0, 1])); // items 2,3 have NOT started — capped at 2
    expect(maxConcurrent).toBe(2);

    // Release out of order: item 1 finishes before item 0.
    barrier.release(1);
    await barrier.waitFor(2); // item 2 starts as soon as a slot frees
    expect(barrier.entered).toEqual(new Set([0, 2]));
    expect(maxConcurrent).toBe(2); // still never exceeded the cap

    barrier.release(2);
    await barrier.waitFor(3); // item 3 starts next
    barrier.release(0);
    barrier.release(3);

    const results = await promise;
    // Index-aligned with the INPUT array, independent of the out-of-order completion above.
    expect(results).toEqual([0, 10, 20, 30]);
    expect(maxConcurrent).toBe(2);
  });

  it("drain-then-crash (spec §9.5): once a result asks to stop, no further items start, but already-running ones finish", async () => {
    const barrier = createStepBarrier<number>();
    const started: number[] = [];

    const promise = runConcurrent(
      [0, 1, 2, 3],
      async (item) => {
        started.push(item);
        await barrier.enter(item);
        return item === 1 ? { crashed: true, item } : { crashed: false, item };
      },
      2, // items 0,1 start; 2,3 wait for a free lane
      (result) => result.crashed,
    );

    await Promise.all([barrier.waitFor(0), barrier.waitFor(1)]);
    expect(started).toEqual([0, 1]); // only the first 2 lanes' worth started

    // Release BOTH in-flight items in the same tick (release order does not matter — the pool's own
    // internal resolution chains stay in lockstep, so `stopped` is always observed by every lane's
    // next claim attempt before that claim can happen; see scheduler.ts's `lane`/`claimNext`). Item 0
    // is genuinely still running when item 1 "crashes" — draining means letting it finish, not
    // aborting it, which the FINAL result for index 0 (a real, non-crashed value) proves.
    barrier.release(1); // item 1 "crashes" — must stop starting new items from here
    barrier.release(0); // an already in-flight sibling — drained, not aborted

    const results = await promise;
    expect(started).toEqual([0, 1]); // items 2 and 3 NEVER started
    expect(results[0]).toEqual({ crashed: false, item: 0 }); // in-flight sibling finished normally
    expect(results[1]).toEqual({ crashed: true, item: 1 });
    expect(results[2]).toBeUndefined();
    expect(results[3]).toBeUndefined();
  });

  it("returns an empty array for zero items without opening a lane", async () => {
    const results = await runConcurrent(
      [],
      async () => "unreachable",
      4,
      () => false,
    );
    expect(results).toEqual([]);
  });
});
