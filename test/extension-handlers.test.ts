import { describe, expect, it } from "vitest";
import type { RunResult } from "../src/engine/types.ts";
import { handleList, runGuarded } from "../src/host/extension.ts";
import { createRunGuard } from "../src/host/run-guard.ts";
import type { RunSummary } from "../src/host/types.ts";

type NoteType = "info" | "warning" | "error" | undefined;
function notifySpy() {
  const notes: [string, NoteType][] = [];
  return { notes, notify: (message: string, type?: Exclude<NoteType, undefined>) => void notes.push([message, type]) };
}

// -- runGuarded (extracted guard lifecycle, spec §7) ------------------------------------------------

describe("runGuarded", () => {
  const completed: RunResult = { runId: "r1", status: "completed" };

  it("runs with the run's abort signal and releases the guard on success", async () => {
    const guard = createRunGuard();
    const spy = notifySpy();
    let sawSignal: AbortSignal | undefined;
    const result = await runGuarded(guard, "r1", spy.notify, (signal) => {
      sawSignal = signal;
      expect(guard.active?.runId).toBe("r1"); // held during the run
      return Promise.resolve(completed);
    });
    expect(result).toBe(completed);
    expect(sawSignal).toBeInstanceOf(AbortSignal);
    expect(guard.active).toBeUndefined(); // released
    expect(spy.notes).toEqual([]);
  });

  it("releases the guard even when the run throws", async () => {
    const guard = createRunGuard();
    const spy = notifySpy();
    await expect(runGuarded(guard, "r1", spy.notify, () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(guard.active).toBeUndefined();
  });

  it("notifies the race message and skips the run when the guard is busy", async () => {
    const guard = createRunGuard();
    guard.begin("other"); // occupy the guard
    const spy = notifySpy();
    let ran = false;
    const result = await runGuarded(guard, "r1", spy.notify, () => {
      ran = true;
      return Promise.resolve(completed);
    });
    expect(result).toBeUndefined();
    expect(ran).toBe(false);
    expect(spy.notes).toEqual([["workflow: another run became active; try again.", "warning"]]);
    expect(guard.active?.runId).toBe("other"); // the busy run is untouched
  });
});

// -- handleList (formatting via a narrowed context) ------------------------------------------------

describe("handleList", () => {
  it("reports when there are no runs", async () => {
    const spy = notifySpy();
    await handleList({ ui: { notify: spy.notify } }, { list: () => Promise.resolve([]) });
    expect(spy.notes).toEqual([["No workflow runs recorded.", "info"]]);
  });

  it("formats one line per run, using a dash for a missing completedAt", async () => {
    const spy = notifySpy();
    const runs: RunSummary[] = [
      { runId: "a1", workflowName: "survey", status: "completed", startedAt: "T0", completedAt: "T1" },
      { runId: "b2", workflowName: "plan", status: "parked", startedAt: "T2" },
    ];
    await handleList({ ui: { notify: spy.notify } }, { list: () => Promise.resolve(runs) });
    expect(spy.notes).toEqual([
      ["a1  survey  completed  started=T0  completed=T1\nb2  plan  parked  started=T2  completed=-", "info"],
    ]);
  });
});
