import { describe, expect, it } from "vitest";
import { createRunGuard } from "../src/host/run-guard.ts";

describe("run guard (spec §7): at most one in_progress run in-process", () => {
  it("blocks a second begin while one run is active, then allows it after end", () => {
    const guard = createRunGuard();

    const first = guard.begin("run-1");
    expect(first).toBeInstanceOf(AbortController);
    expect(guard.active?.runId).toBe("run-1");

    // A second run/resume is rejected while run-1 is active.
    expect(guard.begin("run-2")).toBeUndefined();
    expect(guard.active?.runId).toBe("run-1");

    guard.end("run-1");
    expect(guard.active).toBeUndefined();

    // Now a new run may begin.
    const second = guard.begin("run-2");
    expect(second).toBeInstanceOf(AbortController);
    expect(guard.active?.runId).toBe("run-2");
  });

  it("exposes the active controller so cancel can abort it", () => {
    const guard = createRunGuard();
    const controller = guard.begin("run-1");
    expect(controller?.signal.aborted).toBe(false);

    guard.active?.controller.abort();
    expect(controller?.signal.aborted).toBe(true);
  });

  it("ignores end() for a non-active run id", () => {
    const guard = createRunGuard();
    guard.begin("run-1");
    guard.end("some-other-run"); // no-op
    expect(guard.active?.runId).toBe("run-1");
  });

  it("a blocked run releases the guard, so a subsequent /workflow run is not blocked (spec §7, §10.2)", () => {
    const guard = createRunGuard();

    // The adapter acquires the guard around execution and releases it in `finally` on ALL outcomes —
    // including `blocked`. Model that: begin, then release (as the adapter does when a run blocks).
    const controller = guard.begin("blocked-run");
    expect(controller).toBeInstanceOf(AbortController);
    guard.end("blocked-run"); // released on block (blocked ≠ in_progress)
    expect(guard.active).toBeUndefined();

    // A brand-new run can begin even though "blocked-run" is still blocked (it does not block).
    expect(guard.begin("new-run")).toBeInstanceOf(AbortController);
    expect(guard.active?.runId).toBe("new-run");
  });
});
