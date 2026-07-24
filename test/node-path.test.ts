import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { appendSegment, formatPath, parsePath, staticKeyOf, staticPathOf } from "../src/engine/node-path.ts";
import { resumeWithAnswer, resumeWorkflow } from "../src/engine/resume-workflow.ts";
import { runWorkflow } from "../src/engine/run-workflow.ts";
import { createQuestionnaireStep, createStep, createWorkflow } from "../src/flow/index.ts";
import { createTestHost } from "./helpers.ts";

describe("node-path grammar (spec §8.5): format/parse round-trip", () => {
  it("round-trips a plain top-level path", () => {
    const path = [{ name: "audit" }, { name: "lint" }];
    expect(formatPath(path)).toBe("audit/lint");
    expect(parsePath("audit/lint")).toEqual(path);
  });

  it("round-trips a loop-iteration path", () => {
    const path = appendSegment([{ name: "until-valid", index: 3 }], "design");
    expect(formatPath(path)).toBe("until-valid#3/design");
    expect(parsePath("until-valid#3/design")).toEqual(path);
  });

  it("round-trips a foreach-item path", () => {
    expect(formatPath([{ name: "batch", index: 7 }, { name: "review" }])).toBe("batch#7/review");
    expect(parsePath("batch#7/review")).toEqual([{ name: "batch", index: 7 }, { name: "review" }]);
  });

  it("drops indices for the static key (spec §5.4)", () => {
    const dynamic = parsePath("until-valid#3/design");
    expect(staticKeyOf(dynamic)).toBe("until-valid/design");
    expect(staticPathOf(dynamic)).toEqual([{ name: "until-valid" }, { name: "design" }]);
  });

  it("fails loudly rather than mis-parsing malformed input", () => {
    expect(() => parsePath("")).toThrow();
    expect(() => parsePath("audit//lint")).toThrow(); // empty segment
    expect(() => parsePath("audit#")).toThrow(); // empty index
    expect(() => parsePath("audit#x")).toThrow(); // non-integer index
    expect(() => parsePath("audit#1#2")).toThrow(); // more than one "#" in a segment
    // A log written before node-path addressing landed has no `path` field — `undefined` off disk
    // must not be silently mis-parsed as a path.
    expect(() => parsePath(undefined as unknown as string)).toThrow(/non-empty path string/);
  });

  it("formatPath rejects an empty path", () => {
    expect(() => formatPath([])).toThrow();
  });
});

describe(".commit() rejects path syntax and same-scope name collisions (spec §3)", () => {
  it("rejects a step name containing '/'", () => {
    expect(() =>
      createWorkflow({ name: "w" })
        .then(createStep({ name: "bad/name", run: () => ({}) }))
        .commit(),
    ).toThrow(/"\/" or "#"/);
  });

  it("rejects a step name containing '#'", () => {
    expect(() =>
      createWorkflow({ name: "w" })
        .then(createStep({ name: "bad#name", run: () => ({}) }))
        .commit(),
    ).toThrow(/"\/" or "#"/);
  });

  it("rejects a loop/foreach/nested-workflow node name containing path syntax", () => {
    const body = createWorkflow({ name: "body" })
      .then(createStep({ name: "s", run: () => ({}) }))
      .commit();
    expect(() =>
      createWorkflow({ name: "w" })
        .dountil(body, () => true, { name: "bad/loop" })
        .commit(),
    ).toThrow(/"\/" or "#"/);
  });

  it("rejects two nodes sharing a name within the SAME scope — the concrete case a bare-name read would be ambiguous in", () => {
    // Same scope, same name: a bare `ctx.getStepResult("dup")` from anywhere reaching this scope
    // would have two equally-near candidates — `.commit()` refuses rather than guessing (spec §3.9).
    expect(() =>
      createWorkflow({ name: "w" })
        .then(createStep({ name: "dup", run: () => ({}) }))
        .then(createStep({ name: "dup", run: () => ({}) }))
        .commit(),
    ).toThrow(/duplicate node\/step name "dup"/);
  });

  it("rejects a branch arm name colliding with a sibling arm or the branch's own name (arms share the branch's addressing scope, spec §8.5)", () => {
    const armA = createWorkflow({ name: "same" })
      .then(createStep({ name: "a", run: () => ({}) }))
      .commit();
    const armB = createWorkflow({ name: "same" })
      .then(createStep({ name: "b", run: () => ({}) }))
      .commit();
    expect(() =>
      createWorkflow({ name: "w" })
        .branch([
          [() => true, armA],
          [() => false, armB],
        ])
        .commit(),
    ).toThrow(/duplicate node\/step name "same"/);
  });

  it("allows the SAME sub-workflow to be composed twice under different aliases (spec §11.2) — the node path, not the name, disambiguates", async () => {
    const shared = createWorkflow({ name: "shared" })
      .then(createStep({ name: "step", output: Type.Object({ v: Type.Number() }), run: () => ({ v: 1 }) }))
      .commit();
    const workflow = createWorkflow({ name: "double-compose" }).workflow(shared, { name: "first" }).workflow(shared, { name: "second" }).commit();

    const { host, store } = createTestHost();
    const result = await runWorkflow(workflow, undefined, host);
    expect(result.status).toBe("completed");

    const events = await store.loadEvents(result.runId);
    expect(events.some((e) => e.type === "step-completed" && e.path === "first/step")).toBe(true);
    expect(events.some((e) => e.type === "step-completed" && e.path === "second/step")).toBe(true);
  });

  it("still rejects composing the same sub-workflow twice under the SAME (default) alias", () => {
    const shared = createWorkflow({ name: "shared" })
      .then(createStep({ name: "step", run: () => 1 }))
      .commit();
    expect(() => createWorkflow({ name: "w" }).workflow(shared).workflow(shared).commit()).toThrow(/duplicate node\/step name "shared"/);
  });
});

describe("definition drift on resume (spec §8.7): schema violation, not just a missing step", () => {
  const numberOutput = Type.Object({ n: Type.Integer() });

  it("resumeWorkflow refuses, naming the step and the violation, when a completed step's recorded output no longer satisfies its current schema", async () => {
    const seed = createStep({ name: "seed", output: numberOutput, run: () => ({ n: 5 }) });
    const boom = createStep({
      name: "boom",
      input: numberOutput,
      run: () => {
        throw new Error("still failing");
      },
    });
    const original = createWorkflow({ name: "drift-schema" }).then(seed).then(boom).commit();

    const { host, store } = createTestHost();
    const first = await runWorkflow(original, undefined, host);
    expect(first.status).toBe("crashed"); // seed completed and recorded {n: 5}; boom exhausted retries

    // Reload with `seed`'s schema TIGHTENED so the recorded {n: 5} (a number) no longer validates.
    const retypedSeed = createStep({ name: "seed", output: Type.Object({ n: Type.String() }), run: () => ({ n: "5" }) });
    const fixed = createStep({ name: "boom", input: Type.Object({ n: Type.String() }), run: () => ({ ok: true }) });
    const changed = createWorkflow({ name: "drift-schema" }).then(retypedSeed).then(fixed).commit();

    const priorEvents = await store.loadEvents(first.runId);
    const resumed = await resumeWorkflow(changed, priorEvents, host);

    expect(resumed.status).toBe("crashed");
    expect(resumed.error).toMatch(/"seed"/); // names the step
    expect(resumed.error).toMatch(/n/); // names the violated field
  });

  it("resumeWithAnswer refuses the same way for a run blocked deeper in the tree", async () => {
    const seed = createStep({ name: "seed", output: numberOutput, run: () => ({ n: 5 }) });
    const ask = createQuestionnaireStep({ name: "ask", output: Type.Object({ name: Type.String() }) });
    const original = createWorkflow({ name: "drift-schema-blocked" }).then(seed).then(ask).commit();

    const { host, store } = createTestHost();
    const blocked = await runWorkflow(original, undefined, host);
    expect(blocked.status).toBe("blocked");

    const retypedSeed = createStep({ name: "seed", output: Type.Object({ n: Type.String() }), run: () => ({ n: "5" }) });
    const askSame = createQuestionnaireStep({ name: "ask", output: Type.Object({ name: Type.String() }) });
    const changed = createWorkflow({ name: "drift-schema-blocked" }).then(retypedSeed).then(askSame).commit();

    const priorEvents = await store.loadEvents(blocked.runId);
    const result = await resumeWithAnswer(changed, priorEvents, { name: "Ada" }, host);

    expect(result.status).toBe("crashed");
    expect(result.error).toMatch(/"seed"/);
  });

  it("does NOT refuse on a cosmetic edit (renamed description, appended step) — only data that would feed stale values downstream is caught", async () => {
    const seed = createStep({ name: "seed", output: numberOutput, run: () => ({ n: 5 }) });
    const boom = createStep({
      name: "boom",
      input: numberOutput,
      run: () => {
        throw new Error("still failing");
      },
    });
    const original = createWorkflow({ name: "drift-cosmetic" }).then(seed).then(boom).commit();

    const { host, store } = createTestHost();
    const first = await runWorkflow(original, undefined, host);
    expect(first.status).toBe("crashed");

    // Same schema, new description, plus an appended step — none of it invalidates recorded data.
    const reworded = createStep({ name: "seed", description: "renamed for clarity", output: numberOutput, run: () => ({ n: 5 }) });
    const fixed = createStep({ name: "boom", input: numberOutput, output: numberOutput, run: ({ input }) => input });
    const appended = createStep({ name: "extra", input: numberOutput, run: ({ input }) => input });
    const changed = createWorkflow({ name: "drift-cosmetic" }).then(reworded).then(fixed).then(appended).commit();

    const priorEvents = await store.loadEvents(first.runId);
    const resumed = await resumeWorkflow(changed, priorEvents, host);
    expect(resumed.status).toBe("completed");
  });
});
