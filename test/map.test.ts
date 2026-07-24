import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { runWorkflow } from "../src/engine/run-workflow.ts";
import { createStep, createWorkflow, nodeName } from "../src/flow/index.ts";
import { createTestHost } from "./helpers.ts";

describe(".map() construct (spec §3.7)", () => {
  it("crashes with a descriptive error when the mapped value is rejected by the downstream input schema", async () => {
    const source = createStep({
      name: "source",
      output: Type.Object({ value: Type.Number() }),
      run: () => ({ value: 5 }),
    });
    const consumer = createStep({
      name: "consumer",
      input: Type.Object({ label: Type.String() }), // expects a string `label`...
      output: Type.Object({ ok: Type.Boolean() }),
      run: () => ({ ok: true }),
    });
    const workflow = createWorkflow({ name: "bad-map" })
      .then(source)
      // ...but the map produces a number `label`, which the downstream schema rejects.
      .map((ctx) => ({ label: ctx.getStepResult<{ value: number }>("source")?.value }))
      .then(consumer)
      .commit();

    const { host } = createTestHost();
    const result = await runWorkflow(workflow, undefined, host);

    expect(result.status).toBe("crashed");
    expect(result.error).toMatch(/consumer/); // attributed to the downstream step's input
    expect(result.error).toMatch(/label/);
    expect(result.error).toMatch(/string/);
  });

  it("does not run the downstream step when the mapped value is invalid", async () => {
    let downstreamRan = false;
    const source = createStep({ name: "source", output: Type.Object({ value: Type.Number() }), run: () => ({ value: 5 }) });
    const consumer = createStep({
      name: "consumer",
      input: Type.Object({ label: Type.String() }),
      run: () => {
        downstreamRan = true;
        return { ok: true };
      },
    });
    const workflow = createWorkflow({ name: "bad-map" })
      .then(source)
      .map((ctx) => ({ label: ctx.getStepResult<{ value: number }>("source")?.value }))
      .then(consumer)
      .commit();

    const { host, events } = createTestHost();
    await runWorkflow(workflow, undefined, host);

    expect(downstreamRan).toBe(false);
    // The map completes (it produced a value); the crash is at the downstream step's input boundary.
    const types = events.map((event) => ("path" in event ? `${event.type}:${event.path}` : event.type));
    expect(types).toEqual(["run-started", "step-started:source", "step-completed:source", "step-started:map-1", "step-completed:map-1", "run-crashed:consumer"]);
  });

  it("auto-names anonymous maps map-1, map-2, ... in order", async () => {
    const first = createStep({ name: "first", run: () => 1 });
    const workflow = createWorkflow({ name: "auto-name" })
      .then(first)
      .map(() => 2)
      .map(() => 3)
      .commit();

    expect(workflow.nodes.map((node) => nodeName(node))).toEqual(["first", "map-1", "map-2"]);
  });

  it("rejects a workflow with duplicate step names at commit()", () => {
    const a = createStep({ name: "dup", run: () => 1 });
    const b = createStep({ name: "dup", run: () => 2 });
    expect(() => createWorkflow({ name: "collision" }).then(a).then(b).commit()).toThrow(/duplicate node\/step name "dup"/);
  });
});

/**
 * `.then()` takes a `StepDefinition`. Anything else used to commit successfully and only fail once
 * the engine tried to execute it — which is how a generated workflow using a hallucinated builder
 * API ("`.then(w => w.addStep(...))`") could import cleanly and still be nonsense.
 */
describe("commit() step validation (spec §2)", () => {
  it("rejects a bare function passed to .then()", () => {
    const notAStep = function addStep() {
      return 1;
    };
    expect(() =>
      createWorkflow({ name: "bad" })
        .then(notAStep as never)
        .commit(),
    ).toThrow(/expects a step from createStep\/createAgentStep\/createQuestionnaireStep, but received a function \(addStep\)/);
  });

  it("rejects a plain object that is not a step", () => {
    expect(() =>
      createWorkflow({ name: "bad" })
        .then({ name: "x" } as never)
        .commit(),
    ).toThrow(/an object with no `kind`/);
  });

  it("rejects an object with an unknown kind", () => {
    expect(() =>
      createWorkflow({ name: "bad" })
        .then({ kind: "sqlQuery", name: "x" } as never)
        .commit(),
    ).toThrow(/an object with kind "sqlQuery"/);
  });

  it("rejects a step missing its name", () => {
    expect(() =>
      createWorkflow({ name: "bad" })
        .then({ kind: "function", run: () => 1 } as never)
        .commit(),
    ).toThrow(/missing its required "name"/);
  });

  it("validates steps nested inside loops and branches too", () => {
    const body = { name: "body", nodes: [{ kind: "step", step: () => 1 }] } as never;
    expect(() =>
      createWorkflow({ name: "bad" })
        .dountil(body, () => true)
        .commit(),
    ).toThrow(/expects a step from createStep/);
  });

  it("still accepts every real step kind", () => {
    const fn = createStep({ name: "fn", run: () => 1 });
    expect(() => createWorkflow({ name: "good" }).then(fn).commit()).not.toThrow();
  });
});
