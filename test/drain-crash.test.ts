import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { resumeWithAnswer, resumeWorkflow } from "../src/engine/resume-workflow.ts";
import { runWorkflow } from "../src/engine/run-workflow.ts";
import { deriveStepStates, stepState } from "../src/engine/step-state.ts";
import { createQuestionnaireStep, createStep, createWorkflow } from "../src/flow/index.ts";
import { createTestHost } from "./helpers.ts";
import { createStepBarrier } from "./step-barrier.ts";

const nameSchema = Type.Object({ name: Type.String() });
const numberOutput = Type.Object({ n: Type.Integer() });

describe("drain-then-crash (spec §9.5): a blocked sibling is dropped, not drained", () => {
  it(".parallel: a crashing arm drains around a blocked sibling — its question is cancelled, not waited on", async () => {
    const asker = createQuestionnaireStep({ name: "asker", output: nameSchema });
    let shouldFail = true;
    const crasher = createStep({
      name: "crasher",
      output: numberOutput,
      run: () => {
        if (shouldFail) throw new Error("boom");
        return { n: 1 };
      },
    });
    const workflow = createWorkflow({ name: "drain-with-block" }).parallel([asker, crasher], { name: "par" }).commit();

    const { host, store } = createTestHost();
    const result = await runWorkflow(workflow, undefined, host);

    // Crash wins over blocked (spec §9.5 precedence): the run does NOT report "blocked".
    expect(result.status).toBe("crashed");

    const events = await store.loadEvents(result.runId);
    expect(events.filter((e) => e.type === "run-crashed")).toHaveLength(1);
    expect(events.some((e) => e.type === "step-cancelled" && e.path === "par/asker")).toBe(true);
    // Its question WAS asked (recorded) before being dropped — the drop is explicit, not a silent gap.
    expect(events.some((e) => e.type === "questionnaire-asked" && e.path === "par/asker")).toBe(true);

    const states = deriveStepStates(events);
    expect(stepState(states, "par/asker")).toBe("cancelled"); // NOT "blocked" — nobody is waiting on it
    expect(stepState(states, "par/crasher")).toBe("crashed");

    // The dropped question cannot be answered — it is stale the instant it was abandoned.
    await expect(resumeWithAnswer(workflow, events, { name: "Ada" }, host, { path: "par/asker" })).rejects.toThrow(/cancelled after blocking/);

    // Resuming re-runs the WHOLE parallel node wholesale (no per-arm checkpoint) — the question
    // genuinely RETURNS (spec §5.5), because "asker" runs fresh again, not because anything was cached.
    shouldFail = false;
    const resumed = await resumeWorkflow(workflow, events, host);
    expect(resumed.status).toBe("blocked");
    expect(resumed.path).toBe("par/asker");

    const resumedEvents = await store.loadEvents(result.runId);
    expect(resumedEvents.filter((e) => e.type === "questionnaire-asked" && e.path === "par/asker")).toHaveLength(2); // asked again

    const finished = await resumeWithAnswer(workflow, resumedEvents, { name: "Ada" }, host);
    expect(finished.status).toBe("completed");
    expect(finished.output).toEqual({ asker: { name: "Ada" }, crasher: { n: 1 } });
  });

  it(".foreach(concurrency>1): an in-flight sibling finishes and checkpoints normally while draining; a never-started one stays untouched", async () => {
    const barrier = createStepBarrier<number>();
    const itemSchema = Type.Object({ n: Type.Integer() });
    const itemResultSchema = Type.Object({ n: Type.Integer() });

    // item 0: completes immediately. item 1: gated on the barrier — still genuinely in flight when
    // item 2 crashes; draining must let it finish and checkpoint, not abandon it. item 2: throws.
    // item 3: with concurrency 2, it never gets a lane before the crash stops new starts.
    const body = createWorkflow({ name: "mixed-body" })
      .then(
        createStep({
          name: "process",
          input: itemSchema,
          output: itemResultSchema,
          run: async ({ input }) => {
            if (input.n === 2) throw new Error("boom on item 2");
            if (input.n === 1) await barrier.enter(1);
            return { n: input.n };
          },
        }),
      )
      .commit();
    const workflow = createWorkflow({ name: "foreach-drain" })
      .foreach(body, () => [{ n: 0 }, { n: 1 }, { n: 2 }, { n: 3 }], { name: "each", concurrency: 2 })
      .commit();

    const { host, store } = createTestHost();
    const resultPromise = runWorkflow(workflow, undefined, host);

    await barrier.waitFor(1); // item 1 is genuinely in flight now
    // NOT rendezvous-able on an observable signal (unlike the rest of this suite): a step-level crash
    // has no event of its own (only the run-level `run-crashed`, emitted much later, after the WHOLE
    // drain including item 1 completes — too late to gate on here) — there is nothing for item 1's
    // release to wait ON. The property this margin protects — once a result asks to stop, no further
    // item starts — is proven WITHOUT any margin at the scheduler seam itself (test/scheduler.test.ts's
    // "drain-then-crash", which controls every resolution by hand): that test's comment on release
    // order explains why `stopped` is always observed before the next claim CAN happen, once the flag
    // is set. What is not (and cannot be, short of adding a step-crash event solely to serve this one
    // test) fully rendezvous-able is item 2 (the crasher) actually REACHING that point before this
    // release — its path is several engine layers deeper (retry policy, finishStep) than item 1's path
    // to the barrier, so a generous, deterministic-but-approximate microtask margin stands in.
    for (let i = 0; i < 50; i++) await Promise.resolve();
    barrier.release(1); // let the in-flight sibling proceed to completion — this is what "draining" means

    const result = await resultPromise;
    expect(result.status).toBe("crashed");

    const events = await store.loadEvents(result.runId);
    const completedIndices = events.filter((e) => e.type === "foreach-item-completed").map((e) => e.index);
    expect(completedIndices.toSorted((a, b) => a - b)).toEqual([0, 1]); // 0 finished before the crash; 1 (in-flight) drained to completion
    expect(events.some((e) => e.type === "foreach-item-started" && e.index === 3)).toBe(false); // never started — no new work after the crash

    const states = deriveStepStates(events);
    expect(stepState(states, "each@2/process")).toBe("crashed");
    expect(stepState(states, "each@0/process")).toBe("completed");
    expect(stepState(states, "each@1/process")).toBe("completed");
    expect(stepState(states, "each@3/process")).toBe("todo"); // untouched, not cancelled — it never ran at all
  });
});
