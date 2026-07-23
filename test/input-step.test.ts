import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createAgentStep, createInputStep, createStep, createWorkflow } from "../src/flow/index.ts";
import { ask, createTestRun, reply } from "../src/testing/index.ts";

/**
 * Input steps (spec §2.4) and Q&A agent steps (spec §10.1), driven through the public testing
 * framework — which is also the worked example of what that framework is for.
 */

// ---- Form mode -------------------------------------------------------------------------------------

const formSchema = Type.Object({
  name: Type.String({ description: "What is your name?" }),
  env: Type.Union([Type.Literal("dev"), Type.Literal("prod")], { default: "dev" }),
  tags: Type.Array(Type.Union([Type.Literal("a"), Type.Literal("b")])),
  address: Type.Object({ city: Type.String() }, { title: "Address" }),
});

describe("input step — form mode (B2, spec §2.4)", () => {
  it("parks with a questionnaire derived from the annotated schema; answers reassemble + validate into output", async () => {
    const consume = createStep({
      name: "consume",
      input: formSchema,
      output: Type.Object({ label: Type.String() }),
      run: ({ input }) => ({ label: `${input.name}/${input.env}/${input.address.city}` }),
    });
    const workflow = createWorkflow({ name: "form" })
      .then(createInputStep({ name: "ask", output: formSchema }))
      .then(consume)
      .commit();

    // No agent scripts: a form step never opens an agent session.
    const parked = await createTestRun(workflow);

    expect(parked.status).toBe("parked");
    expect(parked.stepName).toBe("ask");
    expect(parked.questionKeys()).toEqual(["name", "env", "tags", "address.city"]); // nested key qualified
    expect(parked.questionnaire?.questions.map((q) => q.kind)).toEqual(["text", "single", "multi", "text"]);
    expect(parked.questionnaire?.questions.find((q) => q.key === "address.city")?.section).toBe("Address");
    expect(parked.violation).toBeUndefined(); // a first ask rejects nothing

    const done = await parked.answer({ name: "Ada", env: "prod", tags: ["a"], "address.city": "NYC" });

    expect(done.status).toBe("completed");
    expect(done.output).toEqual({ label: "Ada/prod/NYC" }); // the following step consumed the reassembled input
    expect(done.stepOutput("ask")).toEqual({ name: "Ada", env: "prod", tags: ["a"], address: { city: "NYC" } }); // reassembled + validated
  });

  it("re-parks with a violation when the answers violate the target schema", async () => {
    const workflow = createWorkflow({ name: "form-bad" })
      .then(createInputStep({ name: "ask", output: formSchema }))
      .commit();
    const parked = await createTestRun(workflow);

    const bad = await parked.answer({ name: "Ada", env: "staging", tags: [], "address.city": "NYC" });
    expect(bad.status).toBe("parked"); // "staging" is not in the union → re-park
    expect(bad.violation).toMatch(/env/);

    const good = await bad.answer({ name: "Ada", env: "dev", tags: [], "address.city": "NYC" });
    expect(good.status).toBe("completed");
    expect(good.output).toEqual({ name: "Ada", env: "dev", tags: [], address: { city: "NYC" } });
  });

  it("re-parks with a violation naming every mandatory question left unanswered", async () => {
    const workflow = createWorkflow({ name: "form-partial" })
      .then(createInputStep({ name: "ask", output: formSchema }))
      .commit();
    const parked = await createTestRun(workflow);

    const partial = await parked.answer({ name: "Ada" });
    expect(partial.status).toBe("parked");
    expect(partial.violation).toMatch(/env/);
    expect(partial.violation).toMatch(/tags/);
    expect(partial.questionKeys()).toEqual(["name", "env", "tags", "address.city"]); // the same batch comes back
  });
});

// ---- Agent (elicitation) mode ----------------------------------------------------------------------

const agentSchema = Type.Object({ answer: Type.String() });
const oneQuestion = (key: string, question: string) => ({ questions: [{ key, header: key, question, kind: "text" as const }] });

describe("Q&A agent step — elicitation (B2, spec §10.1)", () => {
  it("emits {questionnaire} → parks → answers delivered → emits {result} → completes; asking protocol injected", async () => {
    const elicit = createAgentStep({ name: "elicit", output: agentSchema, asks: true, prompt: () => "Collect the answer." });
    const workflow = createWorkflow({ name: "agent-input" }).then(elicit).commit();

    const parked = await createTestRun(workflow, {
      agents: { elicit: [ask(oneQuestion("answer", "What is the answer?")), reply({ answer: "42" })] },
    });

    expect(parked.status).toBe("parked");
    expect(parked.questionKeys()).toEqual(["answer"]);
    // The framework auto-injected the asking protocol (the author's prompt is task-only).
    const firstMessage = parked.agent("elicit").messages[0] ?? "";
    expect(firstMessage).toMatch(/"questionnaire":/);
    expect(firstMessage).toMatch(/"result":/);
    expect(firstMessage).toMatch(/[Bb]atch as many questions/);

    const done = await parked.answer({ answer: "42" });
    expect(done.status).toBe("completed");
    expect(done.output).toEqual({ answer: "42" });
    expect(done.agent("elicit").sessions).toBe(2); // fresh session, then the continuation seeded with history
  });

  it("supports two questionnaire batches (re-batch) before the result", async () => {
    const elicit = createAgentStep({ name: "elicit", output: agentSchema, asks: true, prompt: () => "Collect the answer." });
    const workflow = createWorkflow({ name: "agent-rebatch" }).then(elicit).commit();

    const parked1 = await createTestRun(workflow, {
      agents: { elicit: [ask(oneQuestion("answer", "Q1?")), ask(oneQuestion("answer", "Q2?")), reply({ answer: "done" })] },
    });
    expect(parked1.status).toBe("parked");

    const parked2 = await parked1.answer({ answer: "a1" });
    expect(parked2.status).toBe("parked"); // re-batched
    expect(parked2.violation).toBeUndefined(); // an agent's re-batch is a new question, not a rejection

    const done = await parked2.answer({ answer: "a2" });
    expect(done.status).toBe("completed");
    expect(done.output).toEqual({ answer: "done" });
    expect(done.eventsOf("questionnaire-asked")).toHaveLength(2);
  });
});

describe("non-input agent step (regression: no Q&A, no protocol)", () => {
  it("still returns bare validated output and never parks", async () => {
    const step = createAgentStep({ name: "plain", output: Type.Object({ ok: Type.Boolean() }), prompt: () => "just do it" });
    const workflow = createWorkflow({ name: "plain" }).then(step).commit();

    const result = await createTestRun(workflow, { agents: { plain: [reply({ ok: true })] } });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ ok: true });
    expect(result.agent("plain").messages[0]).toBe("just do it"); // no asking protocol appended
  });
});
