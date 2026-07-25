import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { pendingQuestionnaires, resumeWithAnswer } from "../src/engine/resume-workflow.ts";
import { deriveRunStatus } from "../src/engine/run-status.ts";
import { runWorkflow } from "../src/engine/run-workflow.ts";
import { deriveStepStates, stepState } from "../src/engine/step-state.ts";
import { createQuestionnaireStep, createStep, createWorkflow } from "../src/flow/index.ts";
import { createTestRun } from "../src/testing/index.ts";
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

  it("a RE-blocked step keeps receiving the answers it asked for, rather than handing them to a sibling", async () => {
    const workflow = buildTwoAsks();

    // The attended loop (src/host/commands/attended.ts) and `TestRun.answer` both answer the block they
    // just displayed. That is not the same as the engine's own default (FIFO by latest ask): once askA
    // re-blocks, ITS question is the most recent while askB's is the earliest, so a default-targeted
    // answer would land on askB — the question the user never saw.
    const blocked = await createTestRun(workflow);
    expect(blocked.path).toBe("par/askA");

    const reblocked = await blocked.answer({ wrong: "field" }); // invalid → askA re-asks
    expect(reblocked.status).toBe("blocked");
    expect(reblocked.path).toBe("par/askA");
    expect(reblocked.violation).toMatch(/name/);
    expect(reblocked.pendingQuestions.map((p) => p.path)).toEqual(["par/askB", "par/askA"]); // askA is now LAST

    const afterA = await reblocked.answer({ name: "Ada" }); // must still go to askA, not askB
    expect(afterA.stepOutput("par/askA")).toEqual({ name: "Ada" });
    expect(afterA.status).toBe("blocked");
    expect(afterA.path).toBe("par/askB");

    const done = await afterA.answer({ name: "Bob" });
    expect(done.status).toBe("completed");
    expect(done.output).toEqual({ askA: { name: "Ada" }, askB: { name: "Bob" } });
  });

  it("an explicit path from pendingQuestions answers a different pending block than the reported one", async () => {
    const blocked = await createTestRun(buildTwoAsks());
    expect(blocked.path).toBe("par/askA");

    const afterB = await blocked.answer({ name: "Bob" }, "par/askB");
    expect(afterB.stepOutput("par/askB")).toEqual({ name: "Bob" });
    expect(afterB.path).toBe("par/askA");
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

/**
 * spec §10.1's new "Q&A-capable agent steps may not overlap" paragraph carves out an explicit
 * asymmetry: a Q&A *agent* step cannot sit inside an overlapping construct (rejected at `.commit()`,
 * test/no-overlapping-asks.test.ts), but a **questionnaire** step is unaffected — its questions come
 * from a schema, not a conversation, so it may block anywhere, fan-out included. This is what keeps
 * spec §8.6's "several steps may be blocked at once" real rather than theoretical: prove it with THREE
 * questionnaire steps genuinely blocking in the same round (not just two), answered strictly FIFO by
 * original ask order — which, since items run concurrently (spec §3.4), is not assumed to be item order.
 */
describe(".foreach({concurrency: 3}) of questionnaire steps: several blocked at once, answered FIFO (spec §8.6/§10.1)", () => {
  it("all three items block in the same round; resuming with no explicit path resolves them in original ask order", async () => {
    const body = createWorkflow({ name: "ask-body" })
      .then(createQuestionnaireStep({ name: "ask", output: nameSchema }))
      .commit();
    const workflow = createWorkflow({ name: "foreach-three-blocks" })
      .foreach(body, () => [1, 2, 3], { name: "each", concurrency: 3 })
      .commit();

    const { host, store } = createTestHost();
    const blocked = await runWorkflow(workflow, undefined, host);
    expect(blocked.status).toBe("blocked");

    const events = await store.loadEvents(blocked.runId);
    expect(events.filter((e) => e.type === "questionnaire-asked")).toHaveLength(3); // all three blocked in the SAME round
    const states = deriveStepStates(events);
    expect(stepState(states, "each@0/ask")).toBe("blocked");
    expect(stepState(states, "each@1/ask")).toBe("blocked");
    expect(stepState(states, "each@2/ask")).toBe("blocked");

    // FIFO (spec §8.6) means original ask order as recorded in the log — NOT assumed to be item order,
    // since the three items ran genuinely concurrently.
    const fifoOrder = pendingQuestionnaires(events).map((p) => p.path);
    expect(new Set(fifoOrder)).toEqual(new Set(["each@0/ask", "each@1/ask", "each@2/ask"]));

    const answerByPath = new Map(fifoOrder.map((path, i) => [path, `answer-${i}`]));

    let currentEvents = events;
    for (let i = 0; i < fifoOrder.length; i++) {
      const path = fifoOrder[i] as string;
      const result = await resumeWithAnswer(workflow, currentEvents, { name: answerByPath.get(path) }, host); // no explicit `path`: must pick FIFO-first
      currentEvents = await store.loadEvents(blocked.runId);
      if (i < fifoOrder.length - 1) {
        expect(result.status).toBe("blocked");
        expect(result.path).toBe(fifoOrder[i + 1]); // next in FIFO order, whatever item it belongs to
      } else {
        expect(result.status).toBe("completed");
        // Final output is in ITEM order (spec §3.4), independent of the FIFO answer order above.
        expect(result.output).toEqual([{ name: answerByPath.get("each@0/ask") }, { name: answerByPath.get("each@1/ask") }, { name: answerByPath.get("each@2/ask") }]);
      }
    }
  });
});
