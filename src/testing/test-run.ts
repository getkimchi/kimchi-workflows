/**
 * The workflow test driver: run a committed workflow against a fake host and walk it through its
 * states — parked, answered, re-parked, retried, cancelled — without touching PI, the filesystem, or
 * the network.
 *
 * The engine is deterministic, so a workflow's behaviour is fully pinned by three inputs: the initial
 * input, the answers delivered to input/Q&A steps, and what agent steps say. The first two are
 * arguments here; the third is scripted per step by {@link createAgentDouble}.
 *
 * Each transition returns a NEW {@link TestRun} rather than mutating: `start()`, `answer()` and
 * `resume()` read as a chain of states, and an earlier state stays inspectable for comparison.
 */

import { resumeWithAnswer, resumeWorkflow } from "../engine/resume-workflow.ts";
import { runWorkflow } from "../engine/run-workflow.ts";
import type { HostPort, RunEvent, RunResult } from "../engine/types.ts";
import type { Questionnaire } from "../flow/questionnaire.ts";
import type { WorkflowDefinition } from "../flow/types.ts";
import { createHostPort } from "../host/host-port.ts";
import { createMemoryStore } from "../host/memory-store.ts";
import type { RunStore } from "../host/types.ts";
import { type AgentDouble, type AgentRecord, type AgentScripts, createAgentDouble } from "./agent-double.ts";

export interface TestRunOptions {
  /** The workflow's initial input (spec §3.6), validated against its declared input schema. */
  input?: unknown;
  /** What each agent step says, keyed by step name (see `ask`/`reply`/`raw`/`throws`). */
  agents?: AgentScripts;
  /** Fixed run id, so event-log assertions are stable. Default: `"test-run"`. */
  runId?: string;
  /** Fixed clock. Default: a frozen epoch, so timestamps never vary between runs. */
  now?: () => Date;
  /**
   * Delay used for retry backoff and time budgets. Default: instant + recorded, so retry tests are
   * fast and can assert the requested backoff via {@link TestRun.sleepCalls}.
   */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * Cancel the run just as this step is about to run (spec §8.6): the abort fires when the step's
   * `step-started` is emitted, which the retry loop observes before the step body executes — so the
   * named step does NOT run. Fires once, so a following `resume()` proceeds normally.
   *
   * Only function and agent steps can be cancelled this way. An input step is never cancelled by
   * this or anything else: unanswered or invalid answers re-park it (spec §2.4).
   */
  cancelAt?: string;
}

/** A frozen default clock: deterministic timestamps without the caller having to supply one. */
const FIXED_NOW = new Date("2026-01-01T00:00:00.000Z");

/**
 * One observed state of a run, plus the transitions out of it. Wraps the engine's `RunResult` and
 * holds the host/store, so a resume needs no event-log plumbing from the test.
 */
export interface TestRun {
  readonly runId: string;
  readonly status: RunResult["status"];
  readonly output: unknown;
  readonly error: string | undefined;
  /** The pending questionnaire when `parked`. */
  readonly questionnaire: Questionnaire | undefined;
  /** The step that parked, or the step a crash/cancel occurred at. */
  readonly stepName: string | undefined;
  /** Why a form input step RE-parked: the schema violation in the delivered answers (spec §2.4). */
  readonly violation: string | undefined;
  /** The full event log so far, across every transition of this run. */
  readonly events: readonly RunEvent[];
  /** Every `sleep(ms)` the engine requested (retry backoff, time budgets), in order. */
  readonly sleepCalls: readonly number[];

  /** The keys of the pending questionnaire — the questions currently being asked. */
  questionKeys(): string[];
  /** Events of one type, narrowed. */
  eventsOf<T extends RunEvent["type"]>(type: T): Extract<RunEvent, { type: T }>[];
  /** A completed step's (or node's) recorded output. */
  stepOutput(name: string): unknown;
  /** What an agent step's double recorded: messages sent to it, models, sessions opened. */
  agent(stepName: string): AgentRecord;

  /**
   * Deliver structured answers to the parked step (spec §8.4). Complete + valid answers let the run
   * continue; incomplete or invalid ones re-park with `violation` set — an input step is never
   * cancelled by a bad answer, exactly as leaving a mandatory question blank leaves it pending.
   */
  answer(answers: Record<string, unknown>): Promise<TestRun>;
  /**
   * Node-atomic resume of a `crashed`/`cancelled` run (spec §8.2/§8.3): completed nodes are skipped
   * and the first incomplete node re-runs wholesale. Not the answer path — see {@link answer}.
   */
  resume(): Promise<TestRun>;
}

/**
 * Start `workflow` under a fresh fake host and resolve at its first terminal-or-parked state.
 *
 * One call per run, deliberately: the agent queues, the event store, and the fixed run id are all
 * per-run state, so a reusable factory would let a second run silently inherit the first's consumed
 * replies and duplicate its run id. Continue a run through {@link TestRun.answer}/{@link TestRun.resume}.
 *
 * Agent scripts are validated against the workflow's steps up front, so a script naming an unknown
 * step — or asking from a step that cannot park — fails here with a clear message rather than
 * surfacing mid-run as an opaque schema violation.
 */
export async function createTestRun(workflow: WorkflowDefinition, options: TestRunOptions = {}): Promise<TestRun> {
  const runId = options.runId ?? "test-run";
  const now = options.now ?? (() => FIXED_NOW);
  const sleepCalls: number[] = [];
  const sleep =
    options.sleep ??
    (async (ms: number) => {
      sleepCalls.push(ms);
    });

  const double = createAgentDouble(workflow.nodes, options.agents ?? {});
  const store = createMemoryStore();
  const base = createHostPort(store, { generateRunId: () => runId, now, sleep, startAgent: double.startAgent });
  const canceller = createCanceller(options.cancelAt);

  // Observe the event stream to arm the cancel: `step-started` is emitted before the step body runs,
  // so the retry loop sees the abort at the step boundary (spec §8.6) and the step never executes.
  const host: HostPort = canceller
    ? {
        ...base,
        emit: async (event) => {
          await base.emit(event);
          canceller.observe(event);
        },
      }
    : base;

  const context: RunContextForTest = { workflow, host, store, double, sleepCalls, canceller };

  return toTestRun(context, await runWorkflow(workflow, options.input, host, { signal: canceller?.arm() }));
}

/**
 * A one-shot cancel armed by a step name. Each transition gets a fresh `AbortController`, and the
 * abort fires at most once — so `start()` can cancel at a step and the following `resume()` still
 * completes, which is the whole point of testing the cancel/resume pair (spec §8.3).
 */
interface Canceller {
  /** Begin a transition: a fresh signal, or `undefined` once the cancel has already fired. */
  arm(): AbortSignal | undefined;
  observe(event: RunEvent): void;
}

function createCanceller(cancelAt: string | undefined): Canceller | undefined {
  if (cancelAt === undefined) return undefined;
  let controller: AbortController | undefined;
  let fired = false;

  return {
    arm(): AbortSignal | undefined {
      if (fired) return undefined;
      controller = new AbortController();
      return controller.signal;
    },
    observe(event: RunEvent): void {
      if (fired || event.type !== "step-started" || event.stepName !== cancelAt) return;
      fired = true;
      controller?.abort();
    },
  };
}

/** Everything a `TestRun` needs to perform its next transition. */
interface RunContextForTest {
  readonly workflow: WorkflowDefinition;
  readonly host: HostPort;
  readonly store: RunStore;
  readonly double: AgentDouble;
  readonly sleepCalls: readonly number[];
  readonly canceller: Canceller | undefined;
}

async function toTestRun(context: RunContextForTest, result: RunResult): Promise<TestRun> {
  const events = await context.store.loadEvents(result.runId);

  return {
    runId: result.runId,
    status: result.status,
    output: result.output,
    error: result.error,
    questionnaire: result.questionnaire,
    stepName: result.stepName,
    violation: result.violation,
    events,
    sleepCalls: context.sleepCalls,

    questionKeys() {
      return (result.questionnaire?.questions ?? []).map((question) => question.key);
    },

    eventsOf<T extends RunEvent["type"]>(type: T): Extract<RunEvent, { type: T }>[] {
      return events.filter((event): event is Extract<RunEvent, { type: T }> => event.type === type);
    },

    stepOutput(name: string): unknown {
      // Last write wins: a step inside a loop completes once per iteration.
      let output: unknown;
      for (const event of events) {
        if (event.type === "step-completed" && event.stepName === name) output = event.output;
        else if (event.type === "node-completed" && event.nodeName === name) output = event.output;
      }
      return output;
    },

    agent(stepName: string): AgentRecord {
      return context.double.record(stepName);
    },

    async answer(answers: Record<string, unknown>): Promise<TestRun> {
      if (result.status !== "parked") {
        throw new Error(`answer(): the run is ${result.status}, not parked — nothing is asking a question`);
      }
      const next = await resumeWithAnswer(context.workflow, events, answers, context.host, { signal: context.canceller?.arm() });
      return toTestRun(context, next);
    },

    async resume(): Promise<TestRun> {
      if (result.status !== "crashed" && result.status !== "cancelled") {
        throw new Error(
          `resume(): only a crashed or cancelled run is re-run node-atomically; this run is ${result.status}${result.status === "parked" ? " — use answer() instead" : ""}`,
        );
      }
      const next = await resumeWorkflow(context.workflow, events, context.host);
      return toTestRun(context, next);
    },
  };
}
