/**
 * Agent steps that ACT rather than REPORT (spec §2.2): no `output` schema.
 *
 * Requiring a structured answer from a step whose product is a side effect turns formatting into a way
 * to fail at work that already succeeded. Measured live: an implementation step whose edits were on
 * disk was failed for replying `/auto` instead of JSON, discarding the round.
 */
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createAgentStep, createStep, createWorkflow } from "../src/flow/index.ts";
import { createTestRun, raw, reply } from "../src/testing/index.ts";

describe("agent step without an output schema (spec §2.2)", () => {
  it("accepts any reply — even one that is not JSON at all", async () => {
    const act = createAgentStep({ name: "act", background: true, prompt: () => "do the work" });
    const run = await createTestRun(createWorkflow({ name: "acting" }).then(act).commit(), { agents: { act: [raw("/auto")] } });

    expect(run.status).toBe("completed");
    expect(run.output).toBe("/auto"); // the raw text IS the output
  });

  it("does not inject an output contract into the prompt", async () => {
    const act = createAgentStep({ name: "act", background: true, prompt: () => "do the work" });
    const run = await createTestRun(createWorkflow({ name: "no-contract" }).then(act).commit(), { agents: { act: [raw("done")] } });

    expect(run.agent("act").messages[0]).toBe("do the work"); // nothing appended
    expect(run.agent("act").messages[0]).not.toMatch(/JSON/i);
  });

  it("still validates a step that DOES declare a schema", async () => {
    const reporter = createAgentStep({
      name: "reporter",
      output: Type.Object({ ok: Type.Boolean() }),
      background: true,
      retry: { maxRetry: 0 },
      prompt: () => "report",
    });
    const run = await createTestRun(createWorkflow({ name: "reporting" }).then(reporter).commit(), { agents: { reporter: [raw("/auto")] } });

    expect(run.status).toBe("crashed"); // a consumed contract is still enforced
  });

  it("rejects `asks` without a schema at commit — the questions come FROM the schema", () => {
    const asker = createAgentStep({ name: "asker", asks: true, prompt: () => "ask me" });
    expect(() => createWorkflow({ name: "bad-asker" }).then(asker).commit()).toThrow(/asks but no output schema/);
  });

  it("passes the raw text downstream, so a following step can still use it", async () => {
    const act = createAgentStep({ name: "act", background: true, prompt: () => "go" });
    const echo = createStep({
      name: "echo",
      output: Type.Object({ seen: Type.String() }),
      run: ({ ctx }) => ({ seen: ctx.getStepResult<string>("act") ?? "" }),
    });
    const run = await createTestRun(createWorkflow({ name: "chained" }).then(act).then(echo).commit(), { agents: { act: [raw("changed /app/main.py")] } });

    expect(run.status).toBe("completed");
    expect((run.output as { seen: string }).seen).toContain("changed /app/main.py");
  });

  it("leaves a reporting step's steering budget untouched", async () => {
    // A schema-bearing step still gets its in-session repairs; only the contract-free one skips them.
    const reporter = createAgentStep({ name: "reporter", output: Type.Object({ ok: Type.Boolean() }), prompt: () => "report" });
    const run = await createTestRun(createWorkflow({ name: "steered" }).then(reporter).commit(), {
      agents: { reporter: [raw("nonsense"), reply({ ok: true })] },
    });

    expect(run.status).toBe("completed");
    expect(run.agent("reporter").messages).toHaveLength(2); // corrected in session
  });
});
