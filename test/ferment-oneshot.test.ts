import { describe, expect, it } from "vitest";
import fermentOneshot from "../benchmarks/terminal-bench/ferment/ferment-oneshot.workflow.ts";
import { runVerification } from "../benchmarks/terminal-bench/ferment/verify.ts";
import { type AgentStep, forEachNode } from "../src/flow/index.ts";
import { createTestRun, reply, throws } from "../src/testing/index.ts";

/**
 * Structural tests for the one-shot ferment solver
 * (benchmarks/terminal-bench/ferment/ferment-oneshot.workflow.ts), with every agent step scripted and
 * the verification command stubbed — so this pins the WIRING (which stage reads whose output, when a
 * step is sent back, what the judge is asked) without a model or a container.
 *
 * The thing most worth pinning is the SHAPE of the port: this workflow claims to be kimchi's one-shot
 * ferment minus its nudges, so the tests check both halves of that claim — the ferment's instruction
 * text is present, and its continuation machinery is not.
 */

const gates = (ids: readonly string[], verdict = "pass") => ids.map((id) => ({ id, verdict, rationale: `${id} holds`, evidence: "n/a" }));

const plan = {
  title: "Print ok from cli",
  goal: "Make the cli print ok",
  success_criteria: ["running the cli prints ok and exits 0"],
  constraints: [],
  phases: [
    {
      name: "Fix the cli",
      goal: "the cli prints ok",
      steps: [
        { description: "patch main.py so it prints ok", verify: "python /app/main.py", budget_tier: "standard" },
        { description: "remove the debug line", verify: "! grep -q DEBUG /app/main.py", budget_tier: "narrow" },
      ],
    },
  ],
  questions: [],
  gates: gates(["P1", "P2", "P3"]),
};

const onePhaseOneStep = {
  ...plan,
  phases: [{ name: "Fix the cli", goal: "the cli prints ok", steps: [{ description: "patch main.py so it prints ok", verify: "python /app/main.py" }] }],
};

const completedReport = {
  status: "completed",
  summary: "patched main.py to print ok",
  steps_completed: ["edited /app/main.py"],
  remaining_steps: [],
  files_touched: ["/app/main.py"],
};

const stepPass = { summary: "main.py now prints ok", gates: gates(["S1", "S2", "S3"]) };
const stepFlagged = {
  summary: "claims a file it never touched",
  gates: [
    { id: "S1", verdict: "flag", rationale: "the summary names src/other.py, which is not in the diff", evidence: "git diff shows only /app/main.py" },
    { id: "S2", verdict: "pass", rationale: "smoke: runs the cli", evidence: "python /app/main.py" },
    { id: "S3", verdict: "pass", rationale: "empty input handled", evidence: "returns early" },
  ],
};
const phasePass = { summary: "the cli prints ok", gates: gates(["F1", "F2", "F3"]) };
/** kimchi's phase grader: A/B advance, C/D/F refuse and buy a rework. */
const gradeA = { grade: "A", rationale: "the phase goal is met and the diff shows it", recommendations: [] };
const gradeC = {
  grade: "C",
  rationale: "the merge is there but the conflict markers were never checked",
  recommendations: ["grep the working tree for conflict markers and remove any that remain"],
};
const shipPass = { summary: "delivered", gates: gates(["C1", "C2", "C3"]) };

/** A verification that exits 0, standing in for the real `bash -lc` run. */
const verifyOk = () => ({ ran: true, command: "python /app/main.py", exitCode: 0, stdout: "ok\n", stderr: "" });
const verifyFail = () => ({ ran: true, command: "python /app/main.py", exitCode: 1, stdout: "", stderr: "SyntaxError: stray paren" });

/** The phase-diff evidence steps shell out to git; stub them so the suite stays hermetic. */
const noGit = {
  "phase-start-ref": () => ({ ref: "abc123" }),
  "phase-diff": () => ({ available: true, filesChanged: " _includes/about.md | 2 +-", diffSnippet: "@@ -1 +1 @@" }),
};

const roomyInput = () => ({ instruction: "Make the cli print ok.", deadlineIso: new Date(Date.now() + 3_600_000).toISOString() });

function agentSteps(): Map<string, AgentStep> {
  const steps = new Map<string, AgentStep>();
  forEachNode(fermentOneshot.nodes, (node) => {
    if (node.kind === "step" && node.step.kind === "agent") steps.set(node.step.name, node.step);
  });
  return steps;
}

describe("ferment-oneshot: the lifecycle", () => {
  it("runs plan → phase → steps → gates → ship when nothing objects", async () => {
    const run = await createTestRun(fermentOneshot, {
      input: roomyInput(),
      steps: { ...noGit, verify: verifyOk },
      agents: {
        plan: [reply(plan)],
        worker: [reply(completedReport), reply(completedReport)],
        "step-gates": [reply(stepPass), reply(stepPass)],
        "phase-gates": [reply(phasePass)],
        "phase-grade": [reply(gradeA)],
        ship: [reply(shipPass)],
      },
    });

    if (run.status !== "completed") throw new Error(`${run.status} @ ${run.path} :: ${run.error}`);
    expect(run.output).toEqual({ shipped: true, phases: 1, steps: 2, stepsDone: 2 });
    // One worker per step, one attempt each: nothing was sent back.
    expect(run.agent("worker").sessions).toBe(2);
    expect(run.agent("judge").sessions).toBe(0); // the plan asked nothing
    expect(run.agent("refine-steps").sessions).toBe(0); // the plan already had steps
    expect(run.agent("verify-judge").sessions).toBe(0); // verification passed, so nothing to triage
  });

  it("gives a step ONE bounded continuation when a step gate flags it, and tells the worker why", async () => {
    const run = await createTestRun(fermentOneshot, {
      input: roomyInput(),
      steps: { ...noGit, verify: verifyOk },
      agents: {
        plan: [reply(onePhaseOneStep)],
        worker: [reply(completedReport), reply(completedReport)],
        "step-gates": [reply(stepFlagged), reply(stepPass)],
        "phase-gates": [reply(phasePass)],
        "phase-grade": [reply(gradeA)],
        ship: [reply(shipPass)],
      },
    });

    expect(run.status).toBe("completed");
    expect(run.agent("worker").sessions).toBe(2); // one step, two attempts

    const second = run.agent("worker").messages[1] as string;
    // kimchi's recovery rule: resume the same bounded work rather than restarting it broader.
    expect(second).toContain("BOUNDED CONTINUATION");
    expect(second).toContain("do not widen the task");
    expect(second).toContain("the summary names src/other.py"); // the flag's own rationale reaches it
    expect(run.output).toMatchObject({ shipped: true, stepsDone: 1 });
  });

  it("stops sending a step back after the second attempt, and records it as not done", async () => {
    const run = await createTestRun(fermentOneshot, {
      input: roomyInput(),
      steps: { ...noGit, verify: verifyOk },
      agents: {
        plan: [reply(onePhaseOneStep)],
        worker: [reply(completedReport), reply(completedReport)],
        "step-gates": [reply(stepFlagged), reply(stepFlagged)],
        "phase-gates": [reply(phasePass)],
        "phase-grade": [reply(gradeA)],
        ship: [reply(shipPass)],
      },
    });

    expect(run.status).toBe("completed");
    expect(run.agent("worker").sessions).toBe(2); // not three: the continuation is bounded
    expect(run.output).toMatchObject({ steps: 1, stepsDone: 0 });
  });

  it("triages a non-zero verification, and treats a benign one as done", async () => {
    const run = await createTestRun(fermentOneshot, {
      input: roomyInput(),
      steps: { ...noGit, verify: verifyFail },
      agents: {
        plan: [reply(onePhaseOneStep)],
        worker: [reply(completedReport)],
        "step-gates": [reply(stepPass)],
        "verify-judge": [reply({ verdict: "pass", reason: "the grep matched nothing, which is what the step wanted" })],
        "phase-gates": [reply(phasePass)],
        "phase-grade": [reply(gradeA)],
        ship: [reply(shipPass)],
      },
    });

    expect(run.status).toBe("completed");
    expect(run.agent("verify-judge").sessions).toBe(1);
    expect(run.agent("worker").sessions).toBe(1); // a benign exit is not a reason to redo the work
    expect(run.output).toMatchObject({ stepsDone: 1 });

    const triagePrompt = run.agent("verify-judge").messages[0] as string;
    expect(triagePrompt).toContain("strict verification triage judge");
    expect(triagePrompt).toContain('prefer "fail" — false-pass is the worst outcome');
    expect(triagePrompt).toContain("SyntaxError: stray paren");
  });

  it("sends the step back when triage calls the failure real", async () => {
    const run = await createTestRun(fermentOneshot, {
      input: roomyInput(),
      steps: { ...noGit, verify: verifyFail },
      agents: {
        plan: [reply(onePhaseOneStep)],
        worker: [reply(completedReport), reply(completedReport)],
        "step-gates": [reply(stepPass), reply(stepPass)],
        "verify-judge": [reply({ verdict: "fail", reason: "the cli does not run at all" }), reply({ verdict: "fail", reason: "still broken" })],
        "phase-gates": [reply(phasePass)],
        "phase-grade": [reply(gradeA)],
        ship: [reply(shipPass)],
      },
    });

    expect(run.status).toBe("completed");
    expect(run.agent("worker").sessions).toBe(2);
    expect(run.agent("worker").messages[1]).toContain("verification failed (exit 1)");
    expect(run.output).toMatchObject({ stepsDone: 0 });
  });

  it("reads a missing triage verdict as failure, the way kimchi does", async () => {
    const run = await createTestRun(fermentOneshot, {
      input: roomyInput(),
      steps: { ...noGit, verify: verifyFail },
      agents: {
        plan: [reply(onePhaseOneStep)],
        worker: [reply(completedReport), reply(completedReport)],
        "step-gates": [reply(stepPass), reply(stepPass)],
        // The step is `optional`; a judge that never answered leaves nothing behind. False-pass is the
        // worst outcome available here, so silence must not advance the step.
        "verify-judge": [],
        "phase-gates": [reply(phasePass)],
        "phase-grade": [reply(gradeA)],
        ship: [reply(shipPass)],
      },
    });

    expect(run.status).toBe("completed");
    expect(run.output).toMatchObject({ stepsDone: 0 });
  });

  it("does not complete a step whose worker reported partial work", async () => {
    const partial = { status: "partial", summary: "got halfway", steps_completed: ["read main.py"], remaining_steps: ["actually patch it"] };
    const run = await createTestRun(fermentOneshot, {
      input: roomyInput(),
      steps: { ...noGit, verify: verifyOk },
      agents: {
        plan: [reply(onePhaseOneStep)],
        worker: [reply(partial), reply(completedReport)],
        "step-gates": [reply(stepPass), reply(stepPass)],
        "phase-gates": [reply(phasePass)],
        "phase-grade": [reply(gradeA)],
        ship: [reply(shipPass)],
      },
    });

    expect(run.status).toBe("completed");
    expect(run.agent("worker").sessions).toBe(2);
    expect(run.agent("worker").messages[1]).toContain("actually patch it"); // what it said was outstanding
    expect(run.output).toMatchObject({ stepsDone: 1 });
  });

  it("ships false when a ferment-scope gate flags", async () => {
    const run = await createTestRun(fermentOneshot, {
      input: roomyInput(),
      steps: { ...noGit, verify: verifyOk },
      agents: {
        plan: [reply(onePhaseOneStep)],
        worker: [reply(completedReport)],
        "step-gates": [reply(stepPass)],
        "phase-gates": [reply(phasePass)],
        "phase-grade": [reply(gradeA)],
        ship: [
          reply({
            summary: "not shippable",
            gates: [...gates(["C1", "C2"]), { id: "C3", verdict: "flag", rationale: "nothing ever ran the artifact", evidence: "every verify is a grep" }],
          }),
        ],
      },
    });

    expect(run.status).toBe("completed");
    expect(run.output).toMatchObject({ shipped: false });
  });
});

describe("ferment-oneshot: the phase grader", () => {
  it("refuses a phase graded below the bar, reworks it, and grades it again", async () => {
    const run = await createTestRun(fermentOneshot, {
      input: roomyInput(),
      steps: { ...noGit, verify: verifyOk },
      agents: {
        plan: [reply(onePhaseOneStep)],
        worker: [reply(completedReport)],
        "step-gates": [reply(stepPass)],
        "phase-gates": [reply(phasePass), reply(phasePass)],
        // C on the first closing turn refuses; the rework lands and the second turn grades A.
        "phase-grade": [reply(gradeC), reply(gradeA)],
        "phase-rework": [reply(completedReport)],
        ship: [reply(shipPass)],
      },
    });

    expect(run.status).toBe("completed");
    expect(run.agent("phase-rework").sessions).toBe(1);
    expect(run.agent("phase-grade").sessions).toBe(2);
    expect(run.output).toMatchObject({ shipped: true, phases: 1 });

    // The rework is handed exactly what kimchi hands its planner: the grade, the bar, and the fixes.
    const rework = run.agent("phase-rework").messages[0] as string;
    expect(rework).toContain("the grader assigned grade C, minimum required is A");
    expect(rework).toContain("grep the working tree for conflict markers");

    // The grader sees the diff, not just the agent's account of it.
    const grader = run.agent("phase-grade").messages[0] as string;
    expect(grader).toContain("Verify the agent's claims independently using your tools");
    expect(grader).toContain("--- PHASE DIFF ---");
    expect(grader).toContain("_includes/about.md");
    expect(grader).toContain("agent self-reported — verify independently");
  });

  it("accepts a B after a rework, because the bar drops once the phase has been sent back", async () => {
    const gradeB = { grade: "B", rationale: "goal met, one rough edge", recommendations: ["tidy the commit message"] };
    const run = await createTestRun(fermentOneshot, {
      input: roomyInput(),
      steps: { ...noGit, verify: verifyOk },
      agents: {
        plan: [reply(onePhaseOneStep)],
        worker: [reply(completedReport)],
        "step-gates": [reply(stepPass)],
        "phase-gates": [reply(phasePass), reply(phasePass)],
        "phase-grade": [reply(gradeC), reply(gradeB)],
        "phase-rework": [reply(completedReport)],
        ship: [reply(shipPass)],
      },
    });

    expect(run.status).toBe("completed");
    // A B would have been refused on the first turn and is accepted on the second: kimchi's
    // `minimumAcceptableGrade` is A first, B after rework.
    expect(run.agent("phase-grade").sessions).toBe(2);
    expect(run.agent("phase-rework").sessions).toBe(1);
  });

  it("advances a phase it cannot fix rather than blocking forever", async () => {
    const run = await createTestRun(fermentOneshot, {
      input: roomyInput(),
      steps: { ...noGit, verify: verifyOk },
      agents: {
        plan: [reply(onePhaseOneStep)],
        worker: [reply(completedReport)],
        "step-gates": [reply(stepPass)],
        "phase-gates": Array.from({ length: 6 }, () => reply(phasePass)),
        "phase-grade": Array.from({ length: 6 }, () => reply(gradeC)),
        "phase-rework": Array.from({ length: 6 }, () => reply(completedReport)),
        ship: [reply(shipPass)],
      },
    });

    expect(run.status).toBe("completed");
    // kimchi: "the agent had its retries; we don't block continuation indefinitely" — MAX_BLOCK_RETRIES
    // reworks, then the grade is accepted and the phase advances with it recorded.
    expect(run.agent("phase-rework").sessions).toBe(3);
    expect(run.agent("phase-grade").sessions).toBe(4);
    expect(run.output).toMatchObject({ phases: 1 });
  });

  it("advances when the grader itself never answered, because an unreachable judge is advisory", async () => {
    const run = await createTestRun(fermentOneshot, {
      input: roomyInput(),
      steps: { ...noGit, verify: verifyOk },
      agents: {
        plan: [reply(onePhaseOneStep)],
        worker: [reply(completedReport)],
        "step-gates": [reply(stepPass)],
        "phase-gates": [reply(phasePass)],
        "phase-grade": [], // the step is optional; a grader that returns nothing must not block
        ship: [reply(shipPass)],
      },
    });

    expect(run.status).toBe("completed");
    expect(run.agent("phase-rework").sessions).toBe(0);
    expect(run.output).toMatchObject({ shipped: true, phases: 1 });
  });
});

describe("ferment-oneshot: the interview", () => {
  it("routes decision-blocking questions to the judge and replans with its answers", async () => {
    const asking = {
      ...onePhaseOneStep,
      questions: [
        {
          id: "target",
          type: "single",
          question: "Which python should the cli run under?",
          options: [
            { id: "sys", label: "System python" },
            { id: "venv", label: "The project venv" },
          ],
        },
      ],
    };
    const run = await createTestRun(fermentOneshot, {
      input: roomyInput(),
      steps: { ...noGit, verify: verifyOk },
      agents: {
        plan: [reply(asking), reply(onePhaseOneStep)],
        judge: [reply({ answers: [{ id: "target", value: "venv" }], rationale: "the venv is what the task's own commands use" })],
        worker: [reply(completedReport)],
        "step-gates": [reply(stepPass)],
        "phase-gates": [reply(phasePass)],
        "phase-grade": [reply(gradeA)],
        ship: [reply(shipPass)],
      },
    });

    expect(run.status).toBe("completed");
    expect(run.agent("judge").sessions).toBe(1);

    const judgePrompt = run.agent("judge").messages[0] as string;
    expect(judgePrompt).toContain("You are standing in for the user during an autonomous ferment run");
    expect(judgePrompt).toContain("Which python should the cli run under?");

    // The planner's second pass is a REPLAN with the decision in hand, not a fresh start.
    const passes = run.agent("plan").messages as string[];
    expect(passes).toHaveLength(2);
    expect(passes[0]).not.toContain("Answers from the judge");
    expect(passes[1]).toContain("Answers from the judge");
    expect(passes[1]).toContain("Which python should the cli run under?: venv");
    expect(passes[1]).toContain("the venv is what the task's own commands use");
    expect(run.agent("plan").sessions).toBe(2); // resumable: one conversation, two executions
  });

  it("keeps interviewing for as long as the planner keeps asking, with no round cap of its own", async () => {
    const asking = { ...onePhaseOneStep, questions: [{ id: "target", type: "text", question: "Which python?" }] };
    const answer = () => reply({ answers: [{ id: "target", value: "venv" }], rationale: "matches the task" });
    const run = await createTestRun(fermentOneshot, {
      input: roomyInput(),
      steps: { ...noGit, verify: verifyOk },
      agents: {
        // Four rounds of questions before the planner settles — more than any cap this used to impose.
        plan: [reply(asking), reply(asking), reply(asking), reply(asking), reply(onePhaseOneStep)],
        judge: [answer(), answer(), answer(), answer()],
        worker: [reply(completedReport)],
        "step-gates": [reply(stepPass)],
        "phase-gates": [reply(phasePass)],
        "phase-grade": [reply(gradeA)],
        ship: [reply(shipPass)],
      },
    });

    expect(run.status).toBe("completed");
    // kimchi's interview runs until the planner stops asking; nothing here decides that for it. The run's
    // own deadline (extension.ts) is the backstop, not a round counter in the workflow.
    expect(run.agent("plan").sessions).toBe(5);
    expect(run.agent("judge").sessions).toBe(4);
    expect(run.output).toMatchObject({ phases: 1, stepsDone: 1 });
  });

  it("retries a judge that answers in prose, the way kimchi retries the form call", async () => {
    const asking = {
      ...onePhaseOneStep,
      questions: [
        {
          id: "target",
          type: "single",
          question: "Which python?",
          options: [
            { id: "sys", label: "System" },
            { id: "venv", label: "Venv" },
          ],
        },
      ],
    };
    const run = await createTestRun(fermentOneshot, {
      input: roomyInput(),
      steps: { ...noGit, verify: verifyOk },
      agents: {
        plan: [reply(asking), reply(onePhaseOneStep)],
        // Two invalid replies, then a good one: kimchi loops the judge call up to
        // ASK_USER_FORM_MAX_ATTEMPTS before giving up on it.
        judge: [
          throws(new Error("output: the reply was not valid JSON")),
          throws(new Error("output: the reply was not valid JSON")),
          reply({ answers: [{ id: "target", value: "venv" }], rationale: "the venv is what the task uses" }),
        ],
        worker: [reply(completedReport)],
        "step-gates": [reply(stepPass)],
        "phase-gates": [reply(phasePass)],
        "phase-grade": [reply(gradeA)],
        ship: [reply(shipPass)],
      },
    });

    expect(run.status).toBe("completed");
    expect(run.agent("judge").sessions).toBe(3); // two failures then the answer
    expect(run.agent("plan").messages[1]).toContain("Which python?: venv"); // the real answer reached the planner
  });

  it("answers on the judge's behalf with conservative defaults when it never comes back", async () => {
    const asking = {
      ...onePhaseOneStep,
      questions: [
        {
          id: "target",
          type: "single",
          question: "Which python?",
          options: [
            { id: "sys", label: "System" },
            { id: "venv", label: "Venv" },
          ],
        },
        { id: "force", type: "confirm", question: "Force-push?" },
        { id: "note", type: "text", question: "Anything else?" },
      ],
    };
    const dead = () => throws(new Error("output: the reply was not valid JSON"));
    const run = await createTestRun(fermentOneshot, {
      input: roomyInput(),
      steps: { ...noGit, verify: verifyOk },
      agents: {
        plan: [reply(asking), reply(onePhaseOneStep)],
        judge: [dead(), dead(), dead()],
        worker: [reply(completedReport)],
        "step-gates": [reply(stepPass)],
        "phase-gates": [reply(phasePass)],
        "phase-grade": [reply(gradeA)],
        ship: [reply(shipPass)],
      },
    });

    expect(run.status).toBe("completed");
    expect(run.agent("judge").sessions).toBe(3); // every attempt spent

    // kimchi's `defaultAnswerForQuestion`: first option for single/multi, "yes" for confirm, an explicit
    // non-answer for text — never silence, because a question the planner never gets answered is the one
    // outcome the one-shot interview exists to prevent.
    const replan = run.agent("plan").messages[1] as string;
    expect(replan).toContain("Which python?: sys");
    expect(replan).toContain("Force-push?: yes");
    expect(replan).toContain("(no answer — judge was unavailable)");
    expect(replan).toContain("Judge was unavailable after 3 attempts");
  });

  it("breaks a phase the plan left empty into steps", async () => {
    const emptyPhase = { ...plan, phases: [{ name: "Fix the cli", goal: "the cli prints ok", steps: [] }] };
    const run = await createTestRun(fermentOneshot, {
      input: roomyInput(),
      steps: { ...noGit, verify: verifyOk },
      agents: {
        plan: [reply(emptyPhase)],
        "refine-steps": [reply({ steps: [{ description: "patch main.py", verify: "python /app/main.py" }] })],
        worker: [reply(completedReport)],
        "step-gates": [reply(stepPass)],
        "phase-gates": [reply(phasePass)],
        "phase-grade": [reply(gradeA)],
        ship: [reply(shipPass)],
      },
    });

    expect(run.status).toBe("completed");
    expect(run.agent("refine-steps").sessions).toBe(1);
    expect(run.agent("refine-steps").messages[0]).toContain("into 3–6 concrete steps");
    expect(run.output).toMatchObject({ steps: 1, stepsDone: 1 });
  });
});

describe("ferment-oneshot: what the steps are told", () => {
  it("gives the planner kimchi's planning process and gate contract, and none of its turn machinery", async () => {
    const run = await createTestRun(fermentOneshot, {
      input: roomyInput(),
      steps: { ...noGit, verify: verifyOk },
      agents: {
        plan: [reply(onePhaseOneStep)],
        worker: [reply(completedReport)],
        "step-gates": [reply(stepPass)],
        "phase-gates": [reply(phasePass)],
        "phase-grade": [reply(gradeA)],
        ship: [reply(shipPass)],
      },
    });
    const planPrompt = run.agent("plan").messages[0] as string;

    // kimchi's own words, kept.
    expect(planPrompt).toContain("You are running a one-shot ferment");
    expect(planPrompt).toContain("Make the cli print ok.");
    expect(planPrompt).toContain("STEP 1 — ORIENT");
    expect(planPrompt).toContain("STEP 5 — PLAN");
    expect(planPrompt).toContain("Does each phase have a verifiable success signal?");

    // kimchi's continuation machinery, dropped: there is no turn to keep alive here.
    expect(planPrompt).not.toContain("Turn discipline");
    expect(planPrompt).not.toContain("Next action:");
    expect(planPrompt).not.toContain("do not stall");
    expect(planPrompt).not.toContain("scope_ferment");
    expect(planPrompt).not.toContain("start_ferment_step");
  });

  it("hands each worker its step, its budget tier's limits, and what earlier steps left behind", async () => {
    const run = await createTestRun(fermentOneshot, {
      input: roomyInput(),
      steps: { ...noGit, verify: verifyOk },
      agents: {
        plan: [reply(plan)],
        worker: [reply(completedReport), reply(completedReport)],
        "step-gates": [reply({ ...stepPass, summary: "main.py prints ok now" }), reply(stepPass)],
        "phase-gates": [reply(phasePass)],
        "phase-grade": [reply(gradeA)],
        ship: [reply(shipPass)],
      },
    });

    const [first, second] = run.agent("worker").messages as string[];
    expect(first).toContain("📋 Plan first");
    expect(first).toContain("Step 1/2: patch main.py so it prints ok");
    expect(first).toContain("verify: python /app/main.py");
    // The tier the plan chose picks the limits, verbatim from kimchi's budget policy.
    expect(first).toContain("budget_tier=standard, max_turns=25, max_duration=300s, token_budget=100000");
    expect(first).not.toContain("Prior:"); // nothing ran before it

    // The second worker is a fresh session, so continuity has to arrive in the prompt: kimchi's `Prior:`
    // line, carrying the SUMMARY the first step's gate turn wrote.
    expect(second).toContain("budget_tier=narrow, max_turns=10, max_duration=180s, token_budget=50000");
    expect(second).toContain('Prior: ✓1 "patch main.py so it prints ok" — main.py prints ok now');
  });

  it("shows the gate turns the record but tells them to go and look, and never to fix anything", async () => {
    const run = await createTestRun(fermentOneshot, {
      input: roomyInput(),
      steps: { ...noGit, verify: verifyOk },
      agents: {
        plan: [reply(onePhaseOneStep)],
        worker: [reply(completedReport)],
        "step-gates": [reply(stepPass)],
        "phase-gates": [reply(phasePass)],
        "phase-grade": [reply(gradeA)],
        ship: [reply(shipPass)],
      },
    });

    const stepGatePrompt = run.agent("step-gates").messages[0] as string;
    expect(stepGatePrompt).toContain("Does the summary describe work present in the diff?");
    expect(stepGatePrompt).toContain("patched main.py to print ok"); // the worker's report, shown
    // The one line the medium forces: kimchi's planner already holds the diff, a fresh gate turn does not.
    expect(stepGatePrompt).toContain("The diff and the machine are not in your context");
    expect(stepGatePrompt).toContain("Do not fix anything");

    const phaseGatePrompt = run.agent("phase-gates").messages[0] as string;
    expect(phaseGatePrompt).toContain("Did every step's claim verify against real behavior");
    expect(phaseGatePrompt).toContain("verification: exit 0 (python /app/main.py)"); // what actually happened
    expect(phaseGatePrompt).toContain("S1:pass");

    const shipPrompt = run.agent("ship").messages[0] as string;
    // The phase row must survive the closing LOOP boundary: gates and grade live inside it, this reader
    // does not. A bare read silently produced "(no phase summary)" / "(ungraded)" in a live run.
    expect(shipPrompt).toContain("the cli prints ok"); // the F-gate summary
    expect(shipPrompt).toContain("F1:pass");
    expect(shipPrompt).toContain("Is every success criterion from the plan satisfied?");
    expect(shipPrompt).toContain("running the cli prints ok and exits 0"); // the P3 checklist
    expect(shipPrompt).toContain("C1 and C3 both ask for evidence, so go and look");
  });
});

describe("ferment-oneshot: the shape", () => {
  it("runs every agent step as an isolated subagent that may fail without ending the run", () => {
    const steps = agentSteps();
    const names = ["plan", "judge", "refine-steps", "worker", "step-gates", "verify-judge", "phase-gates", "phase-grade", "phase-rework", "ship"];

    expect([...steps.keys()].sort()).toEqual([...names].sort());
    for (const name of names) {
      expect(steps.get(name)?.background, name).toBe(true);
      // Optional throughout: a stage that blows its box must cost that stage, not the run — the run has
      // to reach `report` with whatever landed, because the container is graded either way.
      expect(steps.get(name)?.optional, name).toBe(true);
    }
  });

  it("resumes exactly the two steps whose value is continuity, and no others", () => {
    const steps = agentSteps();

    // The planner replans with the judge's answers; a rejected worker continues its own bounded work.
    expect(steps.get("plan")?.resumable).toBe(true);
    expect(steps.get("worker")?.resumable).toBe(true);
    // Every checking step looks with fresh eyes: a resumed gate turn would inherit the belief it exists
    // to test.
    for (const name of ["judge", "step-gates", "verify-judge", "phase-gates", "ship"]) {
      expect(steps.get(name)?.resumable, name).not.toBe(true);
    }
  });

  it("budgets a worker from kimchi's tier table and from nothing else", () => {
    const box = agentSteps().get("worker")?.maxDurationMs;
    expect(typeof box).toBe("function");
    const boxFor = (tier: string, deadlineIso: string): number =>
      (box as (a: { ctx: unknown }) => number)({
        ctx: { getStepResult: () => ({ step: { description: "x", budget_tier: tier } }), getInitData: () => ({ deadlineIso }) },
      });

    const roomy = new Date(Date.now() + 3_600_000).toISOString();
    expect(boxFor("narrow", roomy)).toBe(180_000);
    expect(boxFor("standard", roomy)).toBe(300_000);
    expect(boxFor("complex", roomy)).toBe(600_000);

    // The tier is the WHOLE budget: the deadline does not enter into it. An earlier version scaled every
    // box by the time left, which is scheduling policy kimchi does not have — and which starved the two
    // closing gate turns (`phase-gates` got 307ms, `ship` a negative box) in the first live run.
    expect(boxFor("complex", new Date(Date.now() + 5000).toISOString())).toBe(600_000);
    expect(boxFor("complex", new Date(Date.now() - 60_000).toISOString())).toBe(600_000);
  });

  it("puts no wall clock on anything but the two steps that do work", () => {
    // Both carry a kimchi tier budget and nothing else; the rework is a worker like any other.
    expect(agentSteps().get("phase-rework")?.maxDurationMs).toBe(300_000);
    for (const [name, step] of agentSteps()) {
      if (name === "worker" || name === "phase-rework") continue;
      // Only the worker carries a budget, and it is kimchi's own. Everything else runs until it is done,
      // exactly as a ferment turn does; the run-level deadline in extension.ts is the only other bound.
      expect(step.maxDurationMs, name).toBeUndefined();
    }
  });
});

/**
 * The one piece with real I/O, which every test above stubs: the step's verify command actually runs,
 * and what it produces is what the gates and the triage judge are shown.
 */
describe("ferment-oneshot: running a verify command", () => {
  it("captures the exit code and both streams", async () => {
    const result = await runVerification("printf ok; printf boom >&2; exit 3", new AbortController().signal);

    expect(result).toMatchObject({ ran: true, exitCode: 3, stdout: "ok", stderr: "boom" });
  });

  it("reports a command that could not run at all as a failure", async () => {
    const result = await runVerification("definitely-not-a-real-binary", new AbortController().signal);

    expect(result.ran).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it("kills the command when the run is cancelled, rather than holding the step open", async () => {
    const controller = new AbortController();
    const running = runVerification("sleep 30", controller.signal);
    controller.abort();

    const result = await running;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("cancelled");
  });
});
