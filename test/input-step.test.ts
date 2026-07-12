import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createAgentStep, createInputStep, createStep, createWorkflow } from "../src/flow/index.ts";
import { resumeWithAnswer } from "../src/engine/resume-workflow.ts";
import { runWorkflow } from "../src/engine/run-workflow.ts";
import type { RunEvent } from "../src/engine/types.ts";
import { createTestHost } from "./helpers.ts";
import { scriptedAgent } from "./scripted-agent.ts";

const questionnaire = (events: RunEvent[]) => events.filter((e): e is Extract<RunEvent, { type: "questionnaire-asked" }> => e.type === "questionnaire-asked");

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
    const workflow = createWorkflow({ name: "form" }).then(createInputStep({ name: "ask", output: formSchema })).then(consume).commit();

    const { host, store } = createTestHost(); // NO startAgent — a form step never opens an agent session
    const parked = await runWorkflow(workflow, undefined, host);

    expect(parked.status).toBe("parked");
    expect(parked.stepName).toBe("ask");
    expect(parked.questionnaire?.questions.map((q) => q.key)).toEqual(["name", "env", "tags", "address.city"]); // nested key qualified
    expect(parked.questionnaire?.questions.map((q) => q.kind)).toEqual(["text", "single", "multi", "text"]);
    expect(parked.questionnaire?.questions.find((q) => q.key === "address.city")?.section).toBe("Address");

    const done = await resumeWithAnswer(workflow, await store.loadEvents(parked.runId), { name: "Ada", env: "prod", tags: ["a"], "address.city": "NYC" }, host);

    expect(done.status).toBe("completed");
    expect(done.output).toEqual({ label: "Ada/prod/NYC" }); // the following step consumed the reassembled input
    const events = await store.loadEvents(parked.runId);
    const completed = events.find((e) => e.type === "step-completed" && e.stepName === "ask");
    expect(completed).toMatchObject({ output: { name: "Ada", env: "prod", tags: ["a"], address: { city: "NYC" } } }); // reassembled + validated
  });

  it("re-parks when the answers violate the target schema", async () => {
    const workflow = createWorkflow({ name: "form-bad" }).then(createInputStep({ name: "ask", output: formSchema })).commit();
    const { host, store } = createTestHost();
    const parked = await runWorkflow(workflow, undefined, host);

    const bad = await resumeWithAnswer(workflow, await store.loadEvents(parked.runId), { name: "Ada", env: "staging", tags: [], "address.city": "NYC" }, host);
    expect(bad.status).toBe("parked"); // "staging" is not in the union → re-park

    const good = await resumeWithAnswer(workflow, await store.loadEvents(parked.runId), { name: "Ada", env: "dev", tags: [], "address.city": "NYC" }, host);
    expect(good.status).toBe("completed");
    expect(good.output).toEqual({ name: "Ada", env: "dev", tags: [], address: { city: "NYC" } });
  });
});

// ---- Agent (elicitation) mode ----------------------------------------------------------------------

const agentSchema = Type.Object({ answer: Type.String() });
const asked = (key: string, question: string) => JSON.stringify({ questionnaire: { questions: [{ key, header: key, question, kind: "text" }] } });
const resulted = (answer: string) => JSON.stringify({ result: { answer } });

describe("input step — agent (elicitation) mode (B2, spec §10.1)", () => {
  it("emits {questionnaire} → parks → answers delivered → emits {result} → completes; asking protocol injected", async () => {
    const workflow = createWorkflow({ name: "agent-input" }).then(createInputStep({ name: "elicit", output: agentSchema, agent: {} })).commit();
    const agent = scriptedAgent([[asked("answer", "What is the answer?")], [resulted("42")]]);
    const { host, store } = createTestHost({ startAgent: agent.startAgent });

    const parked = await runWorkflow(workflow, undefined, host);
    expect(parked.status).toBe("parked");
    expect(parked.questionnaire?.questions[0]?.key).toBe("answer");
    // The framework auto-injected the asking protocol (author's prompt is task-only).
    expect(agent.messages[0]).toMatch(/"questionnaire":/);
    expect(agent.messages[0]).toMatch(/"result":/);
    expect(agent.messages[0]).toMatch(/[Bb]atch as many questions/);

    const done = await resumeWithAnswer(workflow, await store.loadEvents(parked.runId), { answer: "42" }, host);
    expect(done.status).toBe("completed");
    expect(done.output).toEqual({ answer: "42" });
    expect(agent.opened).toBe(2); // fresh session, then the continuation session seeded with history
    expect(agent.histories[1]?.length).toBeGreaterThan(0);
  });

  it("supports two questionnaire batches (re-batch) before the result", async () => {
    const workflow = createWorkflow({ name: "agent-rebatch" }).then(createInputStep({ name: "elicit", output: agentSchema, agent: {} })).commit();
    const agent = scriptedAgent([[asked("answer", "Q1?")], [asked("answer", "Q2?")], [resulted("done")]]);
    const { host, store } = createTestHost({ startAgent: agent.startAgent });

    const parked1 = await runWorkflow(workflow, undefined, host);
    expect(parked1.status).toBe("parked");

    const parked2 = await resumeWithAnswer(workflow, await store.loadEvents(parked1.runId), { answer: "a1" }, host);
    expect(parked2.status).toBe("parked"); // re-batched

    const done = await resumeWithAnswer(workflow, await store.loadEvents(parked1.runId), { answer: "a2" }, host);
    expect(done.status).toBe("completed");
    expect(done.output).toEqual({ answer: "done" });
    expect(questionnaire(await store.loadEvents(parked1.runId))).toHaveLength(2);
  });
});

describe("non-input agent step (regression: no Q&A, no protocol)", () => {
  it("still returns bare validated output and never parks", async () => {
    const step = createAgentStep({ name: "plain", output: Type.Object({ ok: Type.Boolean() }), prompt: () => "just do it" });
    const workflow = createWorkflow({ name: "plain" }).then(step).commit();
    const agent = scriptedAgent([[JSON.stringify({ ok: true })]]);
    const { host } = createTestHost({ startAgent: agent.startAgent });

    const result = await runWorkflow(workflow, undefined, host);
    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ ok: true });
    expect(agent.messages[0]).toBe("just do it"); // no asking protocol appended
  });
});
