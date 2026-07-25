import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createQuestionnaireStep, createStep, createWorkflow } from "../src/flow/index.ts";
import { createTestRun } from "../src/testing/index.ts";

/**
 * The test handle's inspection surface beyond status/output/error (spec §13.4): `stepState(path)` and
 * `pendingQuestions`, addressed by bare name or explicit static node path exactly like `stepOutput`.
 */

const nameSchema = Type.Object({ name: Type.String() });
const flagSchema = Type.Object({ go: Type.Boolean() });

describe("TestRun.stepState (spec §5.1/§13.4)", () => {
  it("reads todo for a step never reached, completed for one that ran, and skipped for an untaken branch arm", async () => {
    const seed = createStep({ name: "seed", output: flagSchema, run: () => ({ go: false }) });
    const yes = createStep({ name: "yes-step", output: nameSchema, run: () => ({ name: "yes" }) });
    const no = createStep({ name: "no-step", output: nameSchema, run: () => ({ name: "no" }) });
    const yesArm = createWorkflow({ name: "yes-arm" }).then(yes).commit();
    const noArm = createWorkflow({ name: "no-arm" }).then(no).commit();
    const workflow = createWorkflow({ name: "states" })
      .then(seed)
      .branch([
        [(ctx) => ctx.getStepResult<{ go: boolean }>("seed")?.go === true, yesArm],
        [(ctx) => ctx.getStepResult<{ go: boolean }>("seed")?.go === false, noArm],
      ])
      .commit();

    const run = await createTestRun(workflow);

    expect(run.status).toBe("completed");
    expect(run.stepState("seed")).toBe("completed");
    expect(run.stepState("no-arm/no-step")).toBe("completed"); // the taken arm's own step ran (nested path, spec §8.5)
    expect(run.stepState("yes-arm")).toBe("skipped"); // the arm whose condition was false
    expect(run.stepState("no-arm")).toBe("completed"); // a taken arm completes with its body (spec §5.1)
  });

  it("reads todo for a step that is never reached at all", async () => {
    const first = createStep({ name: "first", output: flagSchema, run: () => ({ go: true }) });
    const unreachable = createStep({ name: "unreachable", output: nameSchema, run: () => ({ name: "x" }) });
    const armBody = createWorkflow({ name: "arm" }).then(unreachable).commit();
    const workflow = createWorkflow({ name: "todo-case" })
      .then(first)
      .branch([[() => false, armBody]]) // condition never holds — the arm's body never runs
      .commit();

    const run = await createTestRun(workflow);

    expect(run.status).toBe("completed");
    expect(run.stepState("unreachable")).toBe("todo");
  });

  it("reads blocked for a currently-blocked step", async () => {
    const form = createQuestionnaireStep({ name: "form", output: nameSchema });
    const workflow = createWorkflow({ name: "blocked-state" }).then(form).commit();

    const run = await createTestRun(workflow);

    expect(run.status).toBe("blocked");
    expect(run.stepState("form")).toBe("blocked");
  });

  it("reads completed for a step nested inside a loop, keyed by its STATIC path (indices dropped)", async () => {
    const counter = Type.Object({ count: Type.Integer() });
    const seed = createStep({ name: "seed", output: counter, run: () => ({ count: 0 }) });
    const inc = createStep({ name: "inc", input: counter, output: counter, run: ({ input }) => ({ count: input.count + 1 }) });
    const loopBody = createWorkflow({ name: "loop-body" }).then(inc).commit();
    const workflow = createWorkflow({ name: "loop-state" })
      .then(seed)
      .dountil(loopBody, (_ctx, last) => (last as { count: number }).count >= 3, { name: "count-loop" })
      .commit();

    const run = await createTestRun(workflow);

    expect(run.status).toBe("completed");
    // The explicit STATIC path (no iteration index) is what step state is keyed by (spec §5.4).
    expect(run.stepState("count-loop/inc")).toBe("completed");
  });

  it("reads crashed for a step whose retries are exhausted", async () => {
    const broken = createStep({
      name: "broken",
      run: () => {
        throw new Error("boom");
      },
    });
    const workflow = createWorkflow({ name: "crash-state" }).then(broken).commit();

    const run = await createTestRun(workflow);

    expect(run.status).toBe("crashed");
    expect(run.stepState("broken")).toBe("crashed");
  });

  it("reads cancelled for a step interrupted by cancelAt", async () => {
    const a = createStep({ name: "a", output: flagSchema, run: () => ({ go: true }) });
    const b = createStep({ name: "b", input: flagSchema, output: flagSchema, run: ({ input }) => input });
    const workflow = createWorkflow({ name: "cancel-state" }).then(a).then(b).commit();

    const run = await createTestRun(workflow, { cancelAt: "b" });

    expect(run.status).toBe("cancelled");
    expect(run.stepState("a")).toBe("completed");
    expect(run.stepState("b")).toBe("cancelled");
  });
});

describe("TestRun.pendingQuestions (spec §8.6/§13.4)", () => {
  it("is empty when nothing is blocked", async () => {
    const step = createStep({ name: "solo", output: flagSchema, run: () => ({ go: true }) });
    const workflow = createWorkflow({ name: "no-blocks" }).then(step).commit();

    const run = await createTestRun(workflow);

    expect(run.pendingQuestions).toEqual([]);
  });

  it("lists every step currently blocked, and shrinks as each is answered in turn", async () => {
    const askA = createQuestionnaireStep({ name: "askA", output: nameSchema });
    const askB = createQuestionnaireStep({ name: "askB", output: nameSchema });
    const workflow = createWorkflow({ name: "two-blocks" }).parallel([askA, askB], { name: "par" }).commit();

    const blocked = await createTestRun(workflow);

    expect(blocked.status).toBe("blocked");
    expect(blocked.pendingQuestions.map((q) => q.path).sort()).toEqual(["par/askA", "par/askB"]);
    expect(blocked.pendingQuestions[0]?.violation).toBeUndefined();

    const afterFirst = await blocked.answer({ name: "Ada" });
    expect(afterFirst.status).toBe("blocked");
    expect(afterFirst.pendingQuestions).toHaveLength(1);

    const done = await afterFirst.answer({ name: "Bob" });
    expect(done.status).toBe("completed");
    expect(done.pendingQuestions).toEqual([]);
  });
});
