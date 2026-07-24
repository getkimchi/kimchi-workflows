import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { resumeWithAnswer } from "../src/engine/resume-workflow.ts";
import { deriveRunStatus } from "../src/engine/run-status.ts";
import { runWorkflow } from "../src/engine/run-workflow.ts";
import { deriveStepStates, stepState } from "../src/engine/step-state.ts";
import { createQuestionnaireStep, createStep, createWorkflow } from "../src/flow/index.ts";
import { createTestHost } from "./helpers.ts";

const nameSchema = Type.Object({ name: Type.String() });

/**
 * spec §8.6: several steps may be blocked at once when a fan-out construct blocks in more than one
 * arm. Blocking suspends only its own step — siblings keep running (here: are unaffected by another
 * sibling's own resume) — and pending questionnaires are answered one at a time, FIFO by node path.
 *
 * Questionnaire steps (spec §2.4) are used rather than agent steps: they block unconditionally on
 * first entry with no LLM involved, so two arms blocking "at once" is deterministic by construction —
 * no scripted-agent queue-sharing ambiguity to work around under concurrency.
 */
describe(".parallel: several blocked arms at once, answered FIFO (spec §8.6)", () => {
  function buildTwoAsks() {
    const askA = createQuestionnaireStep({ name: "askA", output: nameSchema });
    const askB = createQuestionnaireStep({ name: "askB", output: nameSchema });
    return createWorkflow({ name: "two-blocks" }).parallel([askA, askB], { name: "par" }).commit();
  }

  it("both arms block in the same round; the run reports one pending question at a time and reads pendingQuestions=2", async () => {
    const workflow = buildTwoAsks();
    const { host, store } = createTestHost();

    const blocked = await runWorkflow(workflow, undefined, host);
    expect(blocked.status).toBe("blocked");

    const events = await store.loadEvents(blocked.runId);
    expect(deriveRunStatus(events)).toBe("blocked");
    const states = deriveStepStates(events);
    expect(stepState(states, "par/askA")).toBe("blocked");
    expect(stepState(states, "par/askB")).toBe("blocked");
    expect(events.filter((e) => e.type === "questionnaire-asked")).toHaveLength(2);
  });

  it("answering the first-reported block leaves the OTHER untouched, and the run re-reports it as still pending", async () => {
    const workflow = buildTwoAsks();
    const { host, store } = createTestHost();

    const blocked = await runWorkflow(workflow, undefined, host);
    expect(blocked.status).toBe("blocked");
    const firstPath = blocked.path;
    expect(firstPath === "par/askA" || firstPath === "par/askB").toBe(true);

    const priorEvents = await store.loadEvents(blocked.runId);
    const afterFirst = await resumeWithAnswer(workflow, priorEvents, { name: "Ada" }, host);

    // The OTHER arm is still pending — the run is STILL blocked, naming the other path, not "completed".
    expect(afterFirst.status).toBe("blocked");
    const secondPath = firstPath === "par/askA" ? "par/askB" : "par/askA";
    expect(afterFirst.path).toBe(secondPath);

    const midEvents = await store.loadEvents(blocked.runId);
    // The first arm actually completed...
    expect(midEvents.some((e) => e.type === "step-completed" && e.path === firstPath)).toBe(true);
    // ...and the second arm's ORIGINAL question was not re-asked or otherwise disturbed by answering the first.
    expect(midEvents.filter((e) => e.type === "questionnaire-asked" && e.path === secondPath)).toHaveLength(1);
    expect(deriveRunStatus(midEvents)).toBe("blocked");
    expect(stepState(deriveStepStates(midEvents), secondPath)).toBe("blocked");

    // Answer the second — now the whole construct completes.
    const afterSecond = await resumeWithAnswer(workflow, midEvents, { name: "Bob" }, host);
    expect(afterSecond.status).toBe("completed");
    expect(afterSecond.output).toEqual({ askA: { name: firstPath === "par/askA" ? "Ada" : "Bob" }, askB: { name: firstPath === "par/askB" ? "Ada" : "Bob" } });
  });

  it("an explicit `path` targets a SPECIFIC pending block directly, regardless of default FIFO order", async () => {
    const workflow = buildTwoAsks();
    const { host, store } = createTestHost();

    const blocked = await runWorkflow(workflow, undefined, host);
    expect(blocked.status).toBe("blocked");
    const priorEvents = await store.loadEvents(blocked.runId);

    // Deliberately target "askB" first, even if it was not the one the default/FIFO pick would choose.
    const afterB = await resumeWithAnswer(workflow, priorEvents, { name: "Bob" }, host, { path: "par/askB" });
    expect(afterB.status).toBe("blocked");
    expect(afterB.path).toBe("par/askA");

    const midEvents = await store.loadEvents(blocked.runId);
    expect(midEvents.some((e) => e.type === "step-completed" && e.path === "par/askB")).toBe(true);

    const afterA = await resumeWithAnswer(workflow, midEvents, { name: "Ada" }, host, { path: "par/askA" });
    expect(afterA.status).toBe("completed");
    expect(afterA.output).toEqual({ askA: { name: "Ada" }, askB: { name: "Bob" } });
  });

  it("rejects answering a path that was never asked", async () => {
    const workflow = buildTwoAsks();
    const { host, store } = createTestHost();
    const blocked = await runWorkflow(workflow, undefined, host);
    const priorEvents = await store.loadEvents(blocked.runId);
    await expect(resumeWithAnswer(workflow, priorEvents, { name: "x" }, host, { path: "par/nope" })).rejects.toThrow(/was never asked/);
  });
});

describe(".foreach(concurrency>1): several blocked items at once, answered FIFO (spec §8.6)", () => {
  it("two items block in the same round; each is answered independently, item order preserved in the final output", async () => {
    const itemSchema = Type.Object({ n: Type.Integer() });
    const outSchema = Type.Object({ n: Type.Integer(), extra: Type.String() });
    const body = createWorkflow({ name: "ask-body" })
      .then(createStep({ name: "capture", input: itemSchema, output: itemSchema, run: ({ input }) => input }))
      .then(createQuestionnaireStep({ name: "extra", output: Type.Object({ extra: Type.String() }) }))
      .then(
        createStep({
          name: "combine",
          input: Type.Object({ extra: Type.String() }),
          output: outSchema,
          // Reads "capture"'s output from THIS SAME item by bare name (spec §5.4's per-item keying —
          // resolves to the item currently being processed, not a sibling item's value).
          run: ({ input, ctx }) => ({ n: ctx.getStepResult<{ n: number }>("capture")?.n ?? -1, extra: input.extra }),
        }),
      )
      .commit();
    const workflow = createWorkflow({ name: "foreach-two-blocks" })
      .foreach(body, () => [{ n: 1 }, { n: 2 }], { name: "each", concurrency: 2 })
      .commit();

    const { host, store } = createTestHost();
    const blocked = await runWorkflow(workflow, undefined, host);
    expect(blocked.status).toBe("blocked");
    const firstPath = blocked.path as string;
    expect(firstPath === "each@0/extra" || firstPath === "each@1/extra").toBe(true);

    const priorEvents = await store.loadEvents(blocked.runId);
    const afterFirst = await resumeWithAnswer(workflow, priorEvents, { extra: "A" }, host);
    expect(afterFirst.status).toBe("blocked");
    const secondPath = firstPath === "each@0/extra" ? "each@1/extra" : "each@0/extra";
    expect(afterFirst.path).toBe(secondPath);

    const midEvents = await store.loadEvents(blocked.runId);
    const afterSecond = await resumeWithAnswer(workflow, midEvents, { extra: "B" }, host);
    expect(afterSecond.status).toBe("completed");
    // Item order preserved regardless of which item (0 or 1) was answered first.
    expect((afterSecond.output as unknown[]).map((o) => (o as { n: number }).n)).toEqual([1, 2]);
  });
});
