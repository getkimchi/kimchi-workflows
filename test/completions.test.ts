import { describe, expect, it } from "vitest";
import type { CompletionSources } from "../src/host/completions.ts";
import { completeWorkflowArgument } from "../src/host/completions.ts";
import type { RunStatus } from "../src/host/resume-router.ts";
import type { RunSummary } from "../src/host/types.ts";

/**
 * `/workflow` argument completion (spec §14) against static sources — the module is pure by design
 * (spec §14.8), so these need no filesystem, no store, and no PI session.
 */

function summary(runId: string, status: RunStatus, startedAt: string, extra: Partial<RunSummary> = {}): RunSummary {
  return { runId, workflowName: "survey", status, startedAt, pendingQuestions: 0, ...extra };
}

function sourcesOf(workflows: readonly string[] = [], runs: readonly RunSummary[] = []): CompletionSources {
  return { workflows: async () => workflows, runs: async () => runs };
}

/** One run per status, all started at distinguishable times. */
const everyStatus: readonly RunSummary[] = [
  summary("r-progress", "in_progress", "2026-01-01T00:00:00Z"),
  summary("r-blocked", "blocked", "2026-01-02T00:00:00Z"),
  summary("r-crashed", "crashed", "2026-01-03T00:00:00Z"),
  summary("r-cancelled", "cancelled", "2026-01-04T00:00:00Z"),
  summary("r-completed", "completed", "2026-01-05T00:00:00Z"),
];

const labels = (items: { label: string }[] | null): string[] => (items ?? []).map((item) => item.label);

// -- the verb slot (spec §14.4) --------------------------------------------------------------------

describe("verb slot", () => {
  it("offers every verb on an empty argument, in the order §6 introduces them", async () => {
    const items = await completeWorkflowArgument("", sourcesOf());
    expect(labels(items)).toEqual(["run", "create", "list", "status", "resume", "cancel", "delete"]);
  });

  it("inserts a trailing space for the verbs that take an argument, and none for those that do not", async () => {
    const items = await completeWorkflowArgument("", sourcesOf());
    expect(items?.map((item) => item.value)).toEqual(["run ", "create", "list", "status ", "resume ", "cancel ", "delete "]);
  });

  it("filters the verbs by what has been typed", async () => {
    expect(labels(await completeWorkflowArgument("r", sourcesOf()))).toEqual(["run", "resume"]);
    expect(labels(await completeWorkflowArgument("del", sourcesOf()))).toEqual(["delete"]);
  });

  it("matches case-insensitively, and falls back to substring when no candidate has the prefix", async () => {
    expect(labels(await completeWorkflowArgument("RuN", sourcesOf()))).toEqual(["run"]);
    // No verb starts with "eat"; `create` contains it (spec §14.5).
    expect(labels(await completeWorkflowArgument("eat", sourcesOf()))).toEqual(["create"]);
  });

  it("falls back to substring only when nothing has the typed text as a prefix, keeping source order", async () => {
    // `list` has the prefix, so the verbs merely containing an l (`cancel`, `delete`) stay out.
    expect(labels(await completeWorkflowArgument("l", sourcesOf()))).toEqual(["list"]);
    // Nothing starts with an e, so every verb containing one is offered, in the verb table's order.
    expect(labels(await completeWorkflowArgument("e", sourcesOf()))).toEqual(["create", "resume", "cancel", "delete"]);
  });

  it("reads no candidate source at all — a verb keystroke costs nothing (spec §14.6)", async () => {
    let reads = 0;
    const counting: CompletionSources = {
      workflows: async () => {
        reads++;
        return [];
      },
      runs: async () => {
        reads++;
        return [];
      },
    };
    await completeWorkflowArgument("ru", counting);
    expect(reads).toBe(0);
  });

  it("says nothing when no verb matches", async () => {
    expect(await completeWorkflowArgument("zzz", sourcesOf())).toBeNull();
  });
});

// -- `run <workflow>` (spec §14.4, §14.6) -----------------------------------------------------------

describe("run argument", () => {
  it("offers the reserved `list` first, then workflow names sorted (spec §6.3)", async () => {
    const items = await completeWorkflowArgument("run ", sourcesOf(["review-loop", "audit"]));
    expect(labels(items)).toEqual(["list", "audit", "review-loop"]);
  });

  it("assembles the whole argument string as the value, with the bare name as the label", async () => {
    const items = await completeWorkflowArgument("run rev", sourcesOf(["review-loop"]));
    expect(items).toEqual([{ value: "run review-loop", label: "review-loop" }]);
  });

  it("carries no description — for a workflow the name is the file (spec §14.6)", async () => {
    const items = await completeWorkflowArgument("run ", sourcesOf(["audit"]));
    expect(items?.every((item) => item.description === undefined)).toBe(true);
  });

  it("cannot be shadowed by a workflow file literally named `list`", async () => {
    const items = await completeWorkflowArgument("run li", sourcesOf(["list"]));
    expect(labels(items)).toEqual(["list"]);
  });

  it("says nothing when nothing matches", async () => {
    expect(await completeWorkflowArgument("run nope", sourcesOf(["audit"]))).toBeNull();
  });
});

// -- run-id slots, filtered to the statuses each verb accepts (spec §14.4) --------------------------

describe("run-id arguments", () => {
  it("offers resume the recoverable runs only (blocked, crashed, cancelled)", async () => {
    const items = await completeWorkflowArgument("resume ", sourcesOf([], everyStatus));
    expect(labels(items)).toEqual(["r-cancelled", "r-crashed", "r-blocked"]);
  });

  it("offers cancel the live runs only (in_progress, blocked)", async () => {
    const items = await completeWorkflowArgument("cancel ", sourcesOf([], everyStatus));
    expect(labels(items)).toEqual(["r-blocked", "r-progress"]);
  });

  it("offers delete the stopped runs only (completed, crashed, cancelled)", async () => {
    const items = await completeWorkflowArgument("delete ", sourcesOf([], everyStatus));
    expect(labels(items)).toEqual(["r-completed", "r-cancelled", "r-crashed"]);
  });

  it("offers status every recorded run, whatever its status — a tree rebuilds from any log (progress §11.4)", async () => {
    const items = await completeWorkflowArgument("status ", sourcesOf([], everyStatus));
    expect(labels(items)).toEqual(["r-completed", "r-cancelled", "r-crashed", "r-blocked", "r-progress"]);
  });

  it("orders runs newest first (spec §14.5)", async () => {
    const items = await completeWorkflowArgument("delete ", sourcesOf([], everyStatus));
    expect(labels(items)).toEqual(["r-completed", "r-cancelled", "r-crashed"]);
  });

  it("caps the popup at 20 runs", async () => {
    const many = Array.from({ length: 30 }, (_, i) => summary(`r${String(i).padStart(2, "0")}`, "completed", `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`));
    const items = await completeWorkflowArgument("delete ", sourcesOf([], many));
    expect(items).toHaveLength(20);
    expect(items?.[0]?.label).toBe("r29"); // newest first, then the next 19
  });

  it("describes a run by workflow name, status, and current step (spec §14.5)", async () => {
    const runs = [summary("r-blocked", "blocked", "2026-01-02T00:00:00Z", { workflowName: "review-loop", currentStep: "ask" })];
    const items = await completeWorkflowArgument("resume ", sourcesOf([], runs));
    expect(items).toEqual([{ value: "resume r-blocked", label: "r-blocked", description: "review-loop  blocked  step=ask" }]);
  });

  it("filters the run-ids by what has been typed", async () => {
    const items = await completeWorkflowArgument("resume r-c", sourcesOf([], everyStatus));
    expect(labels(items)).toEqual(["r-cancelled", "r-crashed"]);
  });

  it("says nothing when the verb's status set is empty", async () => {
    expect(await completeWorkflowArgument("cancel ", sourcesOf([], [summary("r-done", "completed", "2026-01-01T00:00:00Z")]))).toBeNull();
  });
});

// -- verbs that take no argument, and the end of the grammar (spec §14.4) ---------------------------

describe("silence", () => {
  it("offers nothing after `create` or `list`, which take no argument", async () => {
    expect(await completeWorkflowArgument("create ", sourcesOf(["audit"], everyStatus))).toBeNull();
    expect(await completeWorkflowArgument("list ", sourcesOf(["audit"], everyStatus))).toBeNull();
  });

  it("offers nothing after an unknown verb", async () => {
    expect(await completeWorkflowArgument("frobnicate ", sourcesOf(["audit"], everyStatus))).toBeNull();
  });

  it("offers nothing from the second argument onward", async () => {
    expect(await completeWorkflowArgument("run audit ", sourcesOf(["audit"], everyStatus))).toBeNull();
    expect(await completeWorkflowArgument("run audit ex", sourcesOf(["audit"], everyStatus))).toBeNull();
    expect(await completeWorkflowArgument("resume r-blocked now", sourcesOf(["audit"], everyStatus))).toBeNull();
  });
});
