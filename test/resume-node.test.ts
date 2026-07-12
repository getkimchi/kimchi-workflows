import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createStep, createWorkflow } from "../src/flow/index.ts";
import { resumeWorkflow } from "../src/engine/resume-workflow.ts";
import { runWorkflow } from "../src/engine/run-workflow.ts";
import { createTestHost } from "./helpers.ts";

const counterSchema = Type.Object({ count: Type.Integer() });

/**
 * `before -> dountil(loop body)`. The loop body's step throws while `failBody` is set, interrupting
 * the loop node mid-flight. Counters prove which steps (re-)run on resume.
 */
function buildResumeLoopWorkflow() {
  const calls = { before: 0, body: 0 };
  let failBody = true;

  const before = createStep({
    name: "before",
    output: counterSchema,
    run: () => {
      calls.before += 1;
      return { count: 0 };
    },
  });
  const body = createWorkflow({ name: "loop-body" })
    .then(
      createStep({
        name: "body-step",
        input: counterSchema,
        output: counterSchema,
        run: ({ input }) => {
          calls.body += 1;
          if (failBody) throw new Error("boom in loop body");
          return { count: input.count + 1 };
        },
      }),
    )
    .commit();

  const workflow = createWorkflow({ name: "resume-loop" })
    .then(before)
    .dountil(body, (_ctx, last) => (last as { count: number }).count >= 2, { name: "counter-loop", maxIterations: 10 })
    .commit();

  return { workflow, calls, fixBody: () => (failBody = false) };
}

describe("node-atomic resume (spec §8): control-flow node re-runs wholesale", () => {
  it("re-runs an interrupted loop node from scratch without re-running a completed prior step node", async () => {
    const { workflow, calls, fixBody } = buildResumeLoopWorkflow();
    const { host, store } = createTestHost();

    // First run: `before` completes, the loop body throws → crash mid-loop.
    const first = await runWorkflow(workflow, undefined, host);
    expect(first.status).toBe("crashed");
    expect(calls).toEqual({ before: 1, body: 1 });

    // The loop node never reached node-completed; `before` did reach step-completed.
    const priorEvents = await store.loadEvents(first.runId);
    expect(priorEvents.some((e) => e.type === "step-completed" && e.stepName === "before")).toBe(true);
    expect(priorEvents.some((e) => e.type === "node-completed" && e.nodeName === "counter-loop")).toBe(false);

    // Resume: fix the body and continue.
    fixBody();
    const resumed = await resumeWorkflow(workflow, priorEvents, host);

    expect(resumed.status).toBe("completed");
    expect(resumed.runId).toBe(first.runId);
    expect(resumed.output).toEqual({ count: 2 });

    // `before` is NOT re-run (still 1); the loop re-ran wholesale (2 successful body iterations).
    expect(calls.before).toBe(1);
    expect(calls.body).toBe(3); // 1 failed + 2 on resume

    // Resume re-entered at the loop node, not `before`.
    const resumedEvent = priorEventsAfterResume(await store.loadEvents(first.runId));
    expect(resumedEvent?.fromStepName).toBe("counter-loop");
    expect((await store.list())[0]).toMatchObject({ status: "completed" });
  });
});

function priorEventsAfterResume(events: Awaited<ReturnType<ReturnType<typeof createTestHost>["store"]["loadEvents"]>>) {
  return events.find((e) => e.type === "run-resumed") as { type: "run-resumed"; fromStepName?: string } | undefined;
}
