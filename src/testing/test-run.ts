/**
 * The workflow test driver: run a committed workflow against a fake host and walk it through its
 * states — blocked, answered, re-blocked, retried, cancelled — without touching PI, the filesystem, or
 * the network.
 *
 * The engine is deterministic, so a workflow's behaviour is fully pinned by three inputs: the initial
 * input, the answers delivered to questionnaire/Q&A steps, and what agent steps say. The first two are
 * arguments here; the third is scripted per step by {@link createAgentDouble}.
 *
 * Each transition returns a NEW {@link TestRun} rather than mutating: `start()`, `answer()` and
 * `resume()` read as a chain of states, and an earlier state stays inspectable for comparison.
 */

import { parsePath, staticKeyOf } from "../engine/node-path.ts";
import { pendingQuestionnaires, resumeWithAnswer, resumeWorkflow } from "../engine/resume-workflow.ts";
import { runWorkflow } from "../engine/run-workflow.ts";
import { deriveStepStates, type StepState, stepState as stepStateAt } from "../engine/step-state.ts";
import type { HostPort, RunEvent, RunResult } from "../engine/types.ts";
import type { Questionnaire } from "../flow/questionnaire.ts";
import type { WorkflowDefinition } from "../flow/types.ts";
import { createHostPort } from "../host/host-port.ts";
import { createMemoryStore } from "../host/memory-store.ts";
import type { RunStore } from "../host/types.ts";
import { type AgentDouble, type AgentRecord, type AgentScripts, createAgentDouble } from "./agent-double.ts";
import { applyStepOverrides, type StepOverrides } from "./step-override.ts";

export interface TestRunOptions {
  /** The workflow's initial input (spec §3.6), validated against its declared input schema. */
  input?: unknown;
  /** What each agent step says, keyed by step name (see `ask`/`reply`/`raw`/`throws`). */
  agents?: AgentScripts;
  /**
   * Replace any step, by name, with a stub (spec §13.2/§13.3) — schema-checked against the REAL step's
   * declared output schema, and rejected at construction if the name does not match a step in the
   * workflow. A stub that throws drives that step's own retry/crash/resume policy, making an otherwise
   * unreachable failure path directly testable. See {@link StepOverrides}.
   */
  steps?: StepOverrides;
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
   * Only function and agent steps can be cancelled this way. A questionnaire step is never cancelled
   * by this or anything else: unanswered or invalid answers re-block it (spec §2.4).
   */
  cancelAt?: string;
}

/** A frozen default clock: deterministic timestamps without the caller having to supply one. */
const FIXED_NOW = new Date("2026-01-01T00:00:00.000Z");

/** One step CURRENTLY blocked (spec §8.6): what `TestRun.pendingQuestions` exposes, in FIFO ask order. */
export interface PendingQuestion {
  /** The step's full node path (spec §8.5) — pass to a future path-addressed `answer()` to disambiguate. */
  readonly path: string;
  readonly questionnaire: Questionnaire;
  /** Set only on a RE-block: why the previously-delivered answers were rejected (spec §2.4). */
  readonly violation: string | undefined;
}

/**
 * One observed state of a run, plus the transitions out of it. Wraps the engine's `RunResult` and
 * holds the host/store, so a resume needs no event-log plumbing from the test.
 */
export interface TestRun {
  readonly runId: string;
  readonly status: RunResult["status"];
  readonly output: unknown;
  readonly error: string | undefined;
  /** The pending questionnaire when `blocked`. */
  readonly questionnaire: Questionnaire | undefined;
  /** The full node path (spec §8.5) of the step that blocked, or that a crash/cancel occurred at. */
  readonly path: string | undefined;
  /** Why a questionnaire step RE-blocked: the schema violation in the delivered answers (spec §2.4). */
  readonly violation: string | undefined;
  /** The full event log so far, across every transition of this run. */
  readonly events: readonly RunEvent[];
  /** Every `sleep(ms)` the engine requested (retry backoff, time budgets), in order. */
  readonly sleepCalls: readonly number[];
  /**
   * Every step currently `blocked` (spec §8.6/§13.4), FIFO by original ask order — what `answer()`
   * targets by default when more than one is pending. Empty outside concurrency, where at most one
   * step is ever blocked at a time and `questionnaire`/`path`/`violation` above already cover it.
   */
  readonly pendingQuestions: readonly PendingQuestion[];

  /** The keys of the pending questionnaire — the questions currently being asked. */
  questionKeys(): string[];
  /** Events of one type, narrowed. */
  eventsOf<T extends RunEvent["type"]>(type: T): Extract<RunEvent, { type: T }>[];
  /** A completed step's (or node's) recorded output, addressed by bare name (top-level) or static node path. */
  stepOutput(name: string): unknown;
  /**
   * A step's (or node's) current lifecycle state (spec §5.1/§13.4) — `todo` if never reached — addressed
   * the same way as {@link stepOutput}: a bare name (top-level) or an explicit static node path
   * (`until-valid/design`, spec §5.4/§8.5).
   */
  stepState(path: string): StepState;
  /** What an agent step's double recorded: messages sent to it, models, sessions opened. */
  agent(stepName: string): AgentRecord;

  /**
   * Deliver structured answers to the blocked step (spec §8.4). Complete + valid answers let the run
   * continue; incomplete or invalid ones re-block with `violation` set — a questionnaire step is never
   * cancelled by a bad answer, exactly as leaving a mandatory question blank leaves it pending.
   *
   * The answers go to the step this state is REPORTING ({@link TestRun.path}) — the one whose
   * `questionnaire` was just read — so a test answers the question it looked at even when several steps
   * are blocked at once (spec §8.6). Pass a `path` from {@link TestRun.pendingQuestions} to target a
   * different pending block instead.
   */
  answer(answers: Record<string, unknown>, path?: string): Promise<TestRun>;
  /**
   * Node-atomic resume of a `crashed`/`cancelled` run (spec §8.2/§8.3): completed nodes are skipped
   * and the first incomplete node re-runs wholesale. Not the answer path — see {@link answer}.
   */
  resume(): Promise<TestRun>;
}

/**
 * Start `workflow` under a fresh fake host and resolve at its first terminal-or-blocked state.
 *
 * One call per run, deliberately: the agent queues, the event store, and the fixed run id are all
 * per-run state, so a reusable factory would let a second run silently inherit the first's consumed
 * replies and duplicate its run id. Continue a run through {@link TestRun.answer}/{@link TestRun.resume}.
 *
 * Agent scripts are validated against the workflow's steps up front, so a script naming an unknown
 * step — or asking from a step that cannot block — fails here with a clear message rather than
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

  // Overrides (spec §13.3) are spliced in BEFORE the agent double is built and BEFORE anything runs, so
  // an overridden agent step is no longer scriptable as one (a stub replaces it entirely) and a bad
  // override name fails immediately rather than mid-run. Every later transition (`answer`/`resume`)
  // reuses this SAME rewritten definition, via `context.workflow` below.
  const overridden = applyStepOverrides(workflow, options.steps);

  const double = createAgentDouble(overridden.nodes, options.agents ?? {});
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

  const context: RunContextForTest = { workflow: overridden, host, store, double, sleepCalls, canceller };

  return toTestRun(context, await runWorkflow(overridden, options.input, host, { signal: canceller?.arm() }));
}

/**
 * A one-shot cancel armed by a step's node path (a bare name matches a top-level step, since its path
 * IS its bare name). Each transition gets a fresh `AbortController`, and the abort fires at most once
 * — so `start()` can cancel at a step and the following `resume()` still completes, which is the whole
 * point of testing the cancel/resume pair (spec §8.3).
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
      if (fired || event.type !== "step-started" || event.path !== cancelAt) return;
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
  const states = deriveStepStates(events);
  const pendingQuestions: PendingQuestion[] = pendingQuestionnaires(events).map((event) => ({
    path: event.path,
    questionnaire: event.questionnaire,
    violation: event.violation,
  }));

  return {
    runId: result.runId,
    status: result.status,
    output: result.output,
    error: result.error,
    questionnaire: result.questionnaire,
    path: result.path,
    violation: result.violation,
    events,
    sleepCalls: context.sleepCalls,
    pendingQuestions,

    questionKeys() {
      return (result.questionnaire?.questions ?? []).map((question) => question.key);
    },

    eventsOf<T extends RunEvent["type"]>(type: T): Extract<RunEvent, { type: T }>[] {
      return events.filter((event): event is Extract<RunEvent, { type: T }> => event.type === type);
    },

    stepOutput(name: string): unknown {
      // Last write wins (spec §5.4): a step inside a loop/foreach completes once per iteration/item,
      // and `name` is matched against the STATIC key (indices dropped) so a bare top-level name or an
      // explicit static path (`"until-valid/design"`) both work without the caller tracking iteration.
      let output: unknown;
      for (const event of events) {
        if ((event.type === "step-completed" || event.type === "node-completed") && staticKeyOf(parsePath(event.path)) === name) output = event.output;
      }
      return output;
    },

    stepState(path: string): StepState {
      return stepStateAt(states, path);
    },

    agent(stepName: string): AgentRecord {
      return context.double.record(stepName);
    },

    async answer(answers: Record<string, unknown>, path?: string): Promise<TestRun> {
      if (result.status !== "blocked") {
        throw new Error(`answer(): the run is ${result.status}, not blocked — nothing is asking a question`);
      }
      const next = await resumeWithAnswer(context.workflow, events, answers, context.host, { signal: context.canceller?.arm(), path: path ?? result.path });
      return toTestRun(context, next);
    },

    async resume(): Promise<TestRun> {
      if (result.status !== "crashed" && result.status !== "cancelled") {
        throw new Error(
          `resume(): only a crashed or cancelled run is re-run node-atomically; this run is ${result.status}${result.status === "blocked" ? " — use answer() instead" : ""}`,
        );
      }
      const next = await resumeWorkflow(context.workflow, events, context.host);
      return toTestRun(context, next);
    },
  };
}
