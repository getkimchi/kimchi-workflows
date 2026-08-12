# Kimchi Workflows

Define **arbitrary workflows in TypeScript** and run them inside the Kimchi coding harness, built on [PI](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).

---

## The problem this solves

> Define the workflow in TypeScript (in your repo, in git); let the Kimchi harness execute it.

Coding agents are good at doing one thing when you ask. They are bad at reliably executing a **multi-step process**. If you want an agent to "review this code, fix what it finds, re-review, and repeat until it passes," the outcome is unpredictable. Every run is a little different. Agent drifts, forgets steps, loops forever, or quits early.

**Kimchi Workflows** makes the process explicit. You describe it — the steps, the loops, the branches, the stopping conditions — as a plain TypeScript file. A harness-side **engine** drives the transitions between steps **deterministically**, so control flow never depends on the model "deciding" to move on. The LLM is called only *inside* a step, to do the actual work. The result is a workflow that:

- **always terminates** — loops have guards; conditions are pure, side-effect-free predicates the engine evaluates itself, so there are no infinite "the agent kept going" runs;
- **can stop and resume** — every completed step is checkpointed to a durable event log, so a crashed, cancelled, or blocked run picks up from the last checkpoint — across sessions and harness restarts;
- **runs unattended when it can** — a workflow with no questions runs start-to-finish with no human nudges; one that needs input simply *blocks* until answered;
- **is testable outside the harness** — no Kimchi, no model, no network, no filesystem.

And because the steps are explicit, structure the harness can exploit: step-aware compaction, fan-out across steps, running steps in subagents — and you can even ask the harness to design the workflow for you.

---

## How it works

Three layers, one seam. The core is pure and fully testable **without any LLM or network** — the model is only ever invoked from inside an agent step.

```
┌─ Flow layer (src/flow) ────────────────────────────────────────────┐
│  Authoring API: createWorkflow / createStep / createAgentStep /    │
│  createQuestionnaireStep / createInteractiveStep. TypeBox schemas. │
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
│  renders human-input steps, and appends events to the run store.    │
└────────────────────────────────────────────────────────────────────┘
```

Because the engine owns every transition — and every branch/loop condition is a pure `(ctx) => boolean` predicate the engine evaluates — a workflow's control flow is deterministic: which steps run, what each receives, and what each construct outputs never depend on scheduling. LLM calls happen only inside agent-step bodies. That is what lets the same workflow run under scripted, no-network tests *and* against a real model in Kimchi.

---

## Features

- **Define arbitrary workflows in TypeScript.** A workflow is an ordinary, git-tracked `.ts` file that default-exports a committed `WorkflowDefinition`. Edit it like any code; no separate build step (loaded at run time via `jiti`).
- **Goal-driven loops.** `.dountil` / `.dowhile` repeat a step (or a whole sub-workflow) until a condition holds — the pattern behind a code-review loop, a "fix until green" loop, or a propose-and-check loop. A `maxIterations` guard (default 100) means every loop **provably terminates**.
- **Five composable node/step types.** *Function* (a TypeScript function), *Agent* (runs the harness agent tool loop), *Questionnaire* (schema-derived forms), *Interactive* (a workflow-defined, resumable Kimchi UI), and *Nested workflow* (compose a committed workflow).
- **Deterministic, harness-driven execution.** The engine — not the model — decides transitions. No steering messages or tool calls influence control flow, so runs are reproducible and always reach a terminal state.
- **Fan-out with a ceiling.** `.parallel([a, b])` runs independent steps at once; `.foreach(body, { concurrency })` iterates a list, sequential by default. A workflow-wide `maxConcurrency` (default 4) caps the whole run, so a wide fan-out can't open twenty model sessions at once.
- **Stop and resume.** Runs are recorded as an append-only JSONL event log alongside the harness's own sessions. `blocked`, `crashed`, and `cancelled` runs all resume from the last checkpoint; `foreach` resumes at the next unprocessed item; a step blocked deep inside a loop resumes back into that iteration with its conversation intact.
- **Human-in-the-loop when needed, unattended when not.** A workflow with no Q&A steps runs to completion with zero human interaction. A Q&A-capable step *blocks* the run and surfaces its question inline; answering resumes the same agent loop with context intact. Dismissing a question does **not** cancel — the run stays blocked until answered or explicitly cancelled.
- **Background subagents.** An agent step marked `background: true` runs as a Kimchi subagent — its own context window and tool loop, returning only its structured output.
- **Typed data flow with TypeBox.** Step input/output schemas are TypeBox; adjacent steps hand off automatically when schemas line up, and `.map()` / the run context (`getStepResult`, `getInitData`) reach non-adjacent outputs. The same schema validates LLM structured output and types your code.
- **Retry & budgets.** Each step can declare a repeat policy (`maxRetry`, backoff) covering thrown errors and budget overruns, plus per-step **token** and **wall-time** budgets. Schema-invalid model output is repaired in-conversation first (`maxOutputRepairs`, default 2) rather than burning a retry. Exhausted retries → `crashed` (and resumable).
- **Per-step model selection.** An agent step may pin a `provider/modelId`; resolution is step → workflow default → session default.
- **Testing as a first-class citizen.** Drive a whole workflow from any test runner with scripted agent replies, supplied answers, and schema-checked step overrides.

---

## Installing

### Requirements

- **Node.js 24 or newer is required.**

On Node.js 20 or 22, npm may misleadingly fail with `ETARGET No matching version found for @kimchi-dev/kimchi-workflows@*`. The package exists; npm has rejected it because it requires Node.js 24 or newer. Upgrade Node.js, then retry the installation.

There are two separate installs, and most people only need the first:

1. **The extension** — gives you the `/workflow` commands. Install once per machine or per project.
2. **The package as a dependency** — only for type-checking and testing the workflows you write. Running them needs nothing.

### 1. The extension

`package.json` declares `src/host/extension.ts` under the PI-compatible `pi` manifest key, so Kimchi's package machinery installs it directly:

```bash
kimchi install npm:@kimchi-dev/kimchi-workflows        # user-wide (~/.config/kimchi/harness/settings.json)
kimchi install -l npm:@kimchi-dev/kimchi-workflows     # this project only (.config/kimchi/harness/settings.json)
```

`-l` writes project settings, which makes the project untrusted until you approve it once — pass `-a`, or accept the prompt on the next interactive start. Other routes, all equivalent:

```bash
kimchi install git:github.com/getkimchi/kimchi-workflows   # straight from the repo, no npm
kimchi install /path/to/kimchi-workflows                  # a local checkout, for development
kimchi -e /path/to/kimchi-workflows/src/host/extension.ts # one-off, this run only
```

A local path is recorded rather than copied, so that checkout keeps its own `node_modules` — which it needs, because Kimchi supplies `typebox` to extensions but not `jiti`. Dropping a re-export into `~/.config/kimchi/harness/extensions/` or `.kimchi/extensions/` also works and is what makes `/reload` pick up edits. For a custom PI-compatible host, register the factory by hand:

```ts
import { piWorkflowsExtension } from "@kimchi-dev/kimchi-workflows/host";
piWorkflowsExtension(pi);
```

> **A package with no `pi` key loads nothing.** Kimchi records it in settings and contributes no resources, silently — no error on startup. After installing, confirm `/workflow` actually exists.

### 2. The package (optional)

Only if you want autocomplete, `tsc`, or your own tests over the workflows you author — none of it is needed to *run* them:

```bash
npm install -D @kimchi-dev/kimchi-workflows typebox     # or pnpm add -D
```

`typebox` comes along because your editor needs its types on disk; at run time Kimchi's own copy is used regardless of what you install. The published package ships built JavaScript with `.d.ts`, so an ordinary `tsconfig.json` type-checks it with no special flags.

### Commands

Once the extension is registered, these are available in any Kimchi session:

| Command | What it does |
| --- | --- |
| `/workflow list` | List the project's workflows: name, file, and description. |
| `/workflow create` | Interview you, propose a plan, and generate a new workflow file. |
| `/workflow run <name\|file.ts>` | Start a run, by declared name or by path. Rejected if a run is already executing in this project. |
| `/workflow run list` | List runs: id, workflow name, status, current step, pending questions, started/completed times. |
| `/workflow resume [run-id]` | Continue a `blocked` / `crashed` / `cancelled` run from its last checkpoint. |
| `/workflow cancel [run-id]` | Stop a run: abort an executing one at the next step boundary, or cancel a blocked one outright. Resumable either way. |
| `/workflow delete <run-id>` | Permanently remove a **stopped** run and its events. The id is always required; a live run is rejected — cancel it first. |

> **Listing imports every workflow.** `/workflow list` reads each file's declared name by importing it, which executes project code — the same trust boundary `.kimchi/extensions/` sits behind. Keep workflow modules free of import-time side effects: define the workflow, export it, do nothing else.

---

## Writing a workflow

Store project workflows as `*.workflow.ts` files in `.kimchi/workflows/`, or pass a file path directly to `/workflow run`.

A minimal function-step workflow:

```ts
import { Type } from "typebox";
import { createStep, createWorkflow } from "@kimchi-dev/kimchi-workflows";

const sayHello = createStep({
  name: "say-hello",
  output: Type.Object({ message: Type.String() }),
  run: () => ({ message: "Hello, Kimchi workflows!" }),
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

Run it from inside Kimchi:

```
/workflow run examples/review-loop.workflow.ts
```

Concurrent steps must not modify the same files, branches, or external state; sequence work with overlapping side effects.

---

## Examples

Examples live in [`examples/`](examples/), each covering one capability — see [`examples/README.md`](examples/README.md) for the full table and per-example notes.

For complete control-flow, runtime, state, and testing semantics, see the [`extension specification`](specs/extension-spec.md).

---

## Development

```bash
pnpm test                 # offline unit + example suite (no network)
pnpm test:integration     # live agent examples, gated on KIMCHI_API_KEY
pnpm typecheck            # tsc --noEmit
```
