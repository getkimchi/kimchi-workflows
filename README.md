# PI Workflows

Define **arbitrary workflows in TypeScript** and run them inside the [PI coding harness](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).

---

## The problem this solves

> Define the workflow in TypeScript (in your repo, in git); let the PI harness execute it.

Coding agents are good at doing one thing when you ask. They are bad at reliably executing a **multi-step process**. If you want an agent to "review this code, fix what it finds, re-review, and repeat until it passes," the outcome is unpredictable. Every run is a little different. Agent drifts, forgets steps, loops forever, or quits early.

**PI Workflows** makes the process explicit. You describe it — the steps, the loops, the branches, the stopping conditions — as a plain TypeScript file. A harness-side **engine** drives the transitions between steps **deterministically**, so control flow never depends on the model "deciding" to move on. The LLM is called only *inside* a step, to do the actual work. The result is a workflow that:

- **always terminates** — loops have guards; conditions are pure, side-effect-free predicates the engine evaluates itself, so there are no infinite "the agent kept going" runs;
- **can stop and resume** — every completed step is checkpointed to a durable event log, so a crashed, cancelled, or blocked run picks up from the last checkpoint — across sessions and harness restarts;
- **runs unattended when it can** — a workflow with no questions runs start-to-finish with no human nudges; one that needs input simply *blocks* until answered;
- **is testable outside the harness** — no PI, no model, no network, no filesystem.

And because the steps are explicit, structure the harness can exploit: step-aware compaction, fan-out across steps, running steps in subagents — and you can even ask the harness to design the workflow for you.

---

## How it works

Three layers, one seam. The core is pure and fully testable **without any LLM or network** — the model is only ever invoked from inside an agent step.

```
┌─ Flow layer (src/flow) ────────────────────────────────────────────┐
│  Authoring API: createWorkflow / createStep / createAgentStep /    │
│  createQuestionnaireStep. TypeBox I/O schemas. Builder: .then      │
│  .parallel .branch .dowhile .dountil .foreach .map → .commit()     │
│  Pure. No host, no network.                                        │
└────────────────────────────────────────────────────────────────────┘
                              │  WorkflowDefinition
                              ▼
┌─ Engine (src/engine) ──────────────────────────────────────────────┐
│  Deterministic scheduler: step transitions, run-context data       │
│  flow, checkpointing, unified retry, step and run states.          │
│  Depends only on a narrow HostPort interface → fake-host testable. │
└────────────────────────────────────────────────────────────────────┘
                              │  HostPort
                              ▼
┌─ Host adapter (src/host) ──────────────────────────────────────────┐
│  Implements HostPort against @earendil-works/pi-coding-agent:      │
│  registers /workflow, runs the agent loop, resolves models,        │
│  renders questions, and appends events to a per-project run store. │
└────────────────────────────────────────────────────────────────────┘
```

Because the engine owns every transition — and every branch/loop condition is a pure `(ctx) => boolean` predicate the engine evaluates — a workflow's control flow is deterministic: which steps run, what each receives, and what each construct outputs never depend on scheduling. LLM calls happen only inside agent-step bodies. That is what lets the same workflow run under scripted, no-network tests *and* against a real model in PI.

---

## Features

- **Define arbitrary workflows in TypeScript.** A workflow is an ordinary, git-tracked `.ts` file that default-exports a committed `WorkflowDefinition`. Edit it like any code; no separate build step (loaded at run time via `jiti`).
- **Goal-driven loops.** `.dountil` / `.dowhile` repeat a step (or a whole sub-workflow) until a condition holds — the pattern behind a code-review loop, a "fix until green" loop, or a propose-and-check loop. A `maxIterations` guard (default 100) means every loop **provably terminates**.
- **Four step types.** *Function* (a TypeScript function), *Agent* (runs the PI agent tool loop until it stops, returning schema-validated structured output), *Questionnaire* (gathers structured input from the user), and *Nested workflow* (compose a whole workflow as a step).
- **Deterministic, harness-driven execution.** The engine — not the model — decides transitions. No steering messages or tool calls influence control flow, so runs are reproducible and always reach a terminal state.
- **Fan-out with a ceiling.** `.parallel([a, b])` runs independent steps at once; `.foreach(body, { concurrency })` iterates a list, sequential by default. A workflow-wide `maxConcurrency` (default 4) caps the whole run, so a wide fan-out can't open twenty model sessions at once.
- **Stop and resume.** Runs are recorded as an append-only JSONL event log under `.pi/workflows/`. `blocked`, `crashed`, and `cancelled` runs all resume from the last checkpoint; `foreach` resumes at the next unprocessed item; a step blocked deep inside a loop resumes back into that iteration with its conversation intact.
- **Human-in-the-loop when needed, unattended when not.** A workflow with no Q&A steps runs to completion with zero human interaction. A Q&A-capable step *blocks* the run and surfaces its question inline; answering resumes the same agent loop with context intact. Dismissing a question does **not** cancel — the run stays blocked until answered or explicitly cancelled.
- **Background subagents.** An agent step marked `background: true` runs as a PI subagent — its own context window and tool loop, returning only its structured output.
- **Typed data flow with TypeBox.** Step input/output schemas are TypeBox; adjacent steps hand off automatically when schemas line up, and `.map()` / the run context (`getStepResult`, `getInitData`) reach non-adjacent outputs. The same schema validates LLM structured output and types your code.
- **Retry & budgets.** Each step can declare a repeat policy (`maxRetry`, backoff) covering thrown errors and budget overruns, plus per-step **token** and **wall-time** budgets. Schema-invalid model output is repaired in-conversation first (`maxOutputRepairs`, default 2) rather than burning a retry. Exhausted retries → `crashed` (and resumable).
- **Per-step model selection.** An agent step may pin a `provider/modelId`; resolution is step → workflow default → session default.
- **Testing as a first-class citizen.** Drive a whole workflow from any test runner with scripted agent replies, supplied answers, and schema-checked step overrides.

---

## States

One vocabulary for steps and runs:

| State | A step | A run |
| --- | --- | --- |
| `todo` | not reached yet | — |
| `in_progress` | executing, including retries | any step executing |
| `blocked` | waiting on a human answer | nothing executing, something asking |
| `completed` | finished, output recorded | final node completed |
| `skipped` | branch arm whose condition was false | — |
| `cancelled` | interrupted by `/workflow cancel` | cancelled by the user |
| `crashed` | retries exhausted | a step crashed |

Status is derived from the event log — nothing stores a status that can drift from what actually happened. A run reads `in_progress` whenever any step is executing, even if another step is simultaneously blocked on a question. Only `completed` is terminal; everything else resumes.

---

## Installing

**Requirements:** Node.js ≥ 22 and the PI coding harness (`@earendil-works/pi-coding-agent`).

There are two separate installs, and most people only need the first:

1. **The extension** — gives you the `/workflow` commands. Install once per machine or per project.
2. **The package as a dependency** — only for type-checking and testing the workflows you write. Running them needs nothing.

### 1. The extension

`package.json` declares `src/host/extension.ts` under the `pi` key, so PI's package machinery installs it directly:

```bash
pi install npm:@pmateusz/pi-workflows        # user-wide (~/.pi/agent/settings.json)
pi install -l npm:@pmateusz/pi-workflows     # this project only (.pi/settings.json)
```

`-l` writes project settings, which makes the project untrusted until you approve it once — pass `-a`, or accept the prompt on the next interactive start. Other routes, all equivalent:

```bash
pi install git:github.com/pmateusz/pi-workflows   # straight from the repo, no npm
pi install /path/to/pi-workflows                  # a local checkout, for development
pi -e /path/to/pi-workflows/src/host/extension.ts # one-off, this run only
```

A local path is recorded rather than copied, so that checkout keeps its own `node_modules` — which it needs, because PI supplies `typebox` to extensions but not `jiti`. Dropping a re-export into `~/.pi/agent/extensions/` or `.pi/extensions/` also works and is what makes `/reload` pick up edits. For a custom host, register the factory by hand:

```ts
import { piWorkflowsExtension } from "@pmateusz/pi-workflows/host";
piWorkflowsExtension(pi);
```

> **A package with no `pi` key loads nothing.** PI records it in settings and contributes no resources, silently — no error on startup. After installing, confirm `/workflow` actually exists.

### 2. The package (optional)

Only if you want autocomplete, `tsc`, or your own tests over the workflows you author — none of it is needed to *run* them:

```bash
npm install -D @pmateusz/pi-workflows typebox     # or pnpm add -D
```

`typebox` comes along because your editor needs its types on disk; at run time PI's own copy is used regardless of what you install. The published package ships built JavaScript with `.d.ts`, so an ordinary `tsconfig.json` type-checks it with no special flags.

### Commands

Once the extension is registered, these are available in any PI session:

| Command | What it does |
| --- | --- |
| `/workflow list` | List the project's workflows: name, file, and description. |
| `/workflow create` | Interview you, propose a plan, and generate a new workflow file. |
| `/workflow run <name\|file.ts>` | Start a run, by declared name or by path. Rejected if a run is already executing in this project. |
| `/workflow run list` | List runs: id, workflow name, status, current step, pending questions, started/completed times. |
| `/workflow resume [run-id]` | Continue a `blocked` / `crashed` / `cancelled` run from its last checkpoint. |
| `/workflow cancel [run-id]` | Stop a run: abort an executing one at the next step boundary, or cancel a blocked one outright. Resumable either way. |
| `/workflow delete <run-id>` | Permanently remove a **stopped** run and its events. The id is always required; a live run is rejected — cancel it first. |

Only one run executes **per project** at a time, enforced by a lock in the run store rather than by reading a status — so two PI sessions open on the same repo can't both drive steps against the same working tree. If the process holding the lock dies, the next contender reclaims it and records the abandoned run as `crashed`, still resumable. Blocked runs coexist and don't block new work. Dismissing a question doesn't cancel — the run stays blocked until you answer it or cancel it explicitly. Since a blocked run isn't executing, there's no signal to interrupt: cancelling one records the stop directly in its log, and a bare `/workflow cancel` targets the sole blocked run when nothing is executing.

**Where things live.** Authored workflows go in `.pi/workflows/` as `*.workflow.ts`, following PI's convention for project resources (`.pi/extensions/`, `.pi/skills/`, …). Run logs are written to the same directory as `<run-id>.jsonl` plus a `.meta.json` sidecar, alongside the `run.lock` held by an executing run; discovery filters on the `.workflow.ts` suffix, so they never collide. `list` is reserved as the first argument to `run`, so no workflow can be reached as `/workflow run list`.

> **Listing imports every workflow.** `/workflow list` reads each file's declared name by importing it, which executes project code — the same trust boundary `.pi/extensions/` sits behind. Keep workflow modules free of import-time side effects: define the workflow, export it, do nothing else.

### Authoring in another project

Workflows belong to the project you run PI in, not to this repo: everything keys off the session's cwd, so any repo with a `.pi/workflows/*.workflow.ts` is an authoring home. **Running one requires that project to install nothing.** A workflow file is imported from its own directory, where `typebox` and `pi-workflows` would ordinarily be unresolvable, so `src/host/load-workflow.ts` hands the loader those modules directly (jiti `virtualModules`, the same device PI's extension loader uses for its own bundled packages). `test/load-workflow-external.test.ts` runs a workflow from a temp directory with no `node_modules` to keep that true, and a negative control asserts the bare loader still fails there.

A useful side effect: the workflow and the engine share **one** typebox instance — under the harness, PI's bundled copy — so a schema built in the workflow is validated by the very module that built it.

Editors are the one thing jiti cannot help with, because `tsc` resolves from disk. Add the package as a dev dependency (step 2 above) and an ordinary `tsconfig.json` type-checks an authored workflow with no special flags:

```bash
npm install -D @pmateusz/pi-workflows typebox
```

Working against a local checkout instead of the registry? `npm install -D file:/path/to/pi-workflows typebox` behaves the same, as long as that checkout has been built (`pnpm build`) — `exports` points at `dist`.

Biome needs nothing either way: it does no type-aware resolution, and the only two rules that would object to an import it cannot resolve — `noUndeclaredDependencies` and `noUnresolvedImports` — are off in this repo's `biome.json` for that reason.

Testing your workflows is the same story — a dev dependency and any runner:

```ts
import { createTestRun, reply } from "@pmateusz/pi-workflows/testing";

const run = await createTestRun(myWorkflow, { agents: { draft: [reply({ summary: "…" })] } });
expect(run.status).toBe("completed");
```

### `/workflow create`

`create` is itself a workflow (`src/host/builtin/create.workflow.ts`) — same authoring API, same engine, same event log — so it blocks, resumes, and is tested like any other:

1. **`brief`** — a questionnaire step: what should this do, and what should the file be called?
2. **`target`** — settle the destination straight away, so a bad or taken name fails in milliseconds rather than after the interview.
3. **`design`** — a Q&A agent asks clarifying questions in batches, then presents the plan for **Approve / Revise** in a `.dountil` loop, revising until you approve.
4. **`until-valid`** — generate the TypeScript, then load it back with the real loader; on failure the agent sees the loader's error and retries. A workflow that never loads crashes the run rather than writing a broken file.
5. **`write`** — save it. A bare name lands in `.pi/workflows/`, so the new workflow is immediately visible to `/workflow list` and runnable by name.

It never destroys existing work. A name that already exists fails the run and leaves the file untouched — pick a different name, or delete the old one first. A name resolving outside the project is rejected too. Both are checked at step 2, before a single model call.

---

## Writing a workflow

A minimal function-step workflow:

```ts
import { Type } from "typebox";
import { createStep, createWorkflow } from "@pmateusz/pi-workflows";

const sayHello = createStep({
  name: "say-hello",
  output: Type.Object({ message: Type.String() }),
  run: () => ({ message: "Hello, PI workflows!" }),
});

export default createWorkflow({ name: "hello", description: "Say hello" })
  .then(sayHello)
  .commit();
```

A goal-driven loop (an agent proposes, a function checks, repeat until it passes — with a guard so it always terminates):

```ts
export default createWorkflow({ name: "review-loop" })
  .dountil(
    reviewBody, // a committed sub-workflow: propose → check
    (ctx) => ctx.getStepResult<{ passed: boolean }>("review-slug")?.passed === true,
    { name: "until-valid", maxIterations: 5 },
  )
  .commit();
```

Fan-out, bounded by the workflow ceiling:

```ts
export default createWorkflow({ name: "audit", maxConcurrency: 4 })
  .parallel([lint, typecheck, deps]) // independent, run together
  .foreach(reviewFileBody, (ctx) => ctx.getInitData<string[]>() ?? [], { concurrency: 2 }) // two files at a time
  .then(report)
  .commit();
```

Run it from inside PI:

```
/workflow run examples/review-loop.workflow.ts
```

Two rules come with fan-out. **Concurrent steps must not touch the same files** — the engine can't know what an agent will edit, so overlapping side effects are yours to avoid; sequence anything that shares state. And **reading a step that's currently in flight throws** rather than returning `undefined`, because a silent `undefined` would make the value depend on who won the race.

Step names need only be unique within their enclosing workflow — the same sub-workflow can be composed twice, and steps are addressed by **node path** (`audit/lint`, `until-valid#3/design`, `batch@7/review`). `ctx.getStepResult("lint")` resolves to the nearest enclosing scope; pass a full path when a bare name would be ambiguous.

---

## Examples

Nine runnable examples live in [`examples/`](examples/), each covering one capability — see [`examples/README.md`](examples/README.md) for the full table and per-example notes.

| Example | Kind | Shows |
| --- | --- | --- |
| `hello` | function | A single function step with a TypeBox output. |
| `pipeline` | function | Linear hand-off plus a non-adjacent `.map()` reaching an earlier step. |
| `batch` | function | `.foreach()` over a list (sequential, the default). |
| `fan-out` | function | `.parallel()` over two independent steps sharing the same input; output keyed by arm name. |
| `foreach-concurrent` | function | `.foreach({ concurrency: 3 })`: several items genuinely in flight at once, output still ordered by item. |
| `survey` | questionnaire | A form gathers params up front, then a step consumes them. |
| `summarize` | agent | A single agent step returning schema-valid structured output. |
| `review-loop` | agent + loop | Propose → check, `.dountil` it passes (with a max-iteration guard). |
| `planning` | Q&A agent | A planning agent that may ask a clarifying question (blocks), then plans. |

Function-only and questionnaire examples run with no network; agent examples use a model (the examples default to `kimchi-dev/kimi-k2.7`).

---

## Documentation

- **[`spec.md`](spec.md)** — the full extension specification: step types, control and data flow, step and run states, commands, persistence/resume semantics, retry & budgets, the questions/human-input model, and the testing contract. Start here to understand *why* things behave as they do.
- **[`examples/README.md`](examples/README.md)** — how to run each example and which tests cover it.
- **Source** — the authoring API is in [`src/flow/`](src/flow/), the deterministic engine in [`src/engine/`](src/engine/), and the PI adapter in [`src/host/`](src/host/). Each `index.ts` re-exports that layer's public surface.

---

## Testing a workflow

A workflow's behaviour is pinned by three things: the agents' replies, the answers given to questions, and what its steps do. `src/testing` supplies all three — no PI, no filesystem, no network, and no runner-specific matchers, so it works under Vitest, Jest, or `node:test`.

```ts
import { ask, createTestRun, reply } from "@pmateusz/pi-workflows/testing";

const blocked = await createTestRun(planningWorkflow, {
  agents: {
    plan: [ask({ questions: [{ key: "backend", header: "Backend", question: "Which cache?", kind: "text" }] }),
           reply({ steps: ["add a redis client"], summary: "Redis cache" })],
  },
});

expect(blocked.status).toBe("blocked");
expect(blocked.questionKeys()).toEqual(["backend"]);

const done = await blocked.answer({ backend: "Redis" });
expect(done.status).toBe("completed");
```

**Agent replies are scripted per step name**, as a queue consumed in order across sessions — a retry or an answer-resume simply takes the next entry, so tests never reason about where a session begins. Five builders cover every turn an agent can take:

| builder | the agent… |
| --- | --- |
| `ask(questions)` | asks a batch → the run blocks (needs `asks: true`) |
| `reply(value)` | returns its output → the step completes |
| `raw(text)` | returns something invalid → drives in-session output repair |
| `throws(error)` | fails at the transport → drives the retry policy |
| `usage(turn, tokens)` | reports token usage → drives the token budget |

**Step overrides replace what a step does.** Any step can be swapped for a stub — to keep a side-effecting step from touching the world, to force a failure that's otherwise unreachable, or to skip expensive setup and exercise late logic directly:

```ts
const run = await createTestRun(releaseWorkflow, {
  steps: {
    "open-pr": () => ({ url: "https://example.test/pr/1" }),
    "read-git": throws(new Error("detached HEAD")),
  },
});
```

Overrides are **schema-checked**: an unknown step name fails immediately, and a stub's return value is validated against the real step's declared output schema — so a stub that has drifted from the contract it stands in for fails the test instead of hiding the drift.

**Questionnaire steps need no double.** They're deterministic, so the test *is* the answers you supply. Answers that are incomplete or invalid re-block the step — a questionnaire step is never cancelled by a bad answer, exactly as leaving a mandatory question blank leaves it pending — and `violation` says why:

```ts
const partial = await blocked.answer({ name: "Ada" });
partial.status;     // "blocked"
partial.violation;  // "<root>: must have required properties environment"
```

A first ask has no `violation` (nothing was rejected yet), so `violation !== undefined` is precisely "asked again, and here's what was wrong".

Each transition returns a **new** run handle, so earlier states stay inspectable: `status`, `output`, `error`, `questionnaire`, `violation`, `events`, `eventsOf(type)`, `stepOutput(name)`, `stepState(path)`, `agent(step)`, `sleepCalls`. Pass `cancelAt: "step"` to cancel the run just before a step executes, then `resume()` to check it picks up from the last checkpoint.

Recording and replaying real model responses as fixtures is deliberately out of scope — hand-scripted replies plus the live integration suite cover that ground.

---

## Development

```bash
pnpm test                 # offline unit + example suite (no network)
pnpm test:integration     # live agent examples, gated on KIMCHI_API_KEY
pnpm typecheck            # tsc --noEmit
```

The offline suite (`test/examples-suite.test.ts`) drives every example end-to-end through the engine with a fake host — including the agent-bearing `planning` example, whose agent is scripted. The integration suite runs the agent examples against a real model.

> **Spec ahead of code, in two places.** `spec.md` is the source of truth, and almost everything it specifies is now implemented — state vocabulary, derived run status, the project lock, node-path addressing and resume-into-nested-blocks, `.parallel`/`concurrency`, background subagents, schema-checked step overrides, output re-validation on resume, budget-clock pausing while blocked, drain-on-crash. Two things still aren't:
>
> - **§12.2's compact rendering** ("a step that can overlap... renders compactly: one progress line, with a summary flushed on completion") has no live consumer. A pure render-mode decision existed briefly and was removed once static isolation made the streaming-vs-not *routing* implicit (an isolated step already runs through the non-streaming subprocess path, `src/host/pi-agent.ts`) — but nothing prints the progress line or summary spec §12.2 describes.
> - **§8.4's "same agent loop resumes... context intact"** holds only within a single live PI process. The real host's in-session bridge (`src/host/pi-agent.ts`) never reads `AgentRequest.history`, so a resume after the harness *process itself* restarted would start that step's session blank rather than seeded with its stored conversation. Resuming a still-running session — and everything the deterministic engine layer models, exercised by the fake-host test suite — is unaffected.
>
> Run logs written by older builds are not readable — pre-1.0, the store format changes without migration.
