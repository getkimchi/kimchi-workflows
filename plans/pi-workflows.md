# Plan: PI Workflows extension

> Source PRD: `spec.md` (this repo) — a programmable, deterministic workflow
> engine for the PI coding harness.

## Guiding principles

- **Clean, layered, host-agnostic design.** Strong typing via TypeBox. The
  deterministic core runs and is fully tested **without any LLM or network**.
- Inspired by kimchi-dev's PI integration and Mastra's workflow model —
  **neither is copied**. We build cleaner logic, clearer code, stronger design.

## Architectural decisions

Durable decisions that apply across all phases.

- **Three layers, one seam.**
  - **Flow layer** (workflow-definition API, `src/flow/`) — `createWorkflow` /
    `createStep`, TypeBox input/output schemas, control-flow builder (`.then` /
    `.branch` / `.dowhile` / `.dountil` / `.foreach` / `.map` / `.workflow`).
    Pure; no host or network dependencies.
  - **Engine** — deterministic scheduler: step transitions, run-context data
    flow, checkpointing, unified retry, and the run state machine. Depends only
    on a narrow **`HostPort`** interface. Fully unit-testable with a fake host.
  - **Host adapter** — implements `HostPort` against the PI harness
    (`@earendil-works/pi-coding-agent`): run the agent loop, resolve models,
    render/collect questions, register `/workflow` commands, append events.
    The PI harness is one adapter; **kimchi-dev is only where we run it and the
    source of the `kimi-k2.7` model.** Nothing in the core is kimchi-specific.
- **Run store** — an append-only **JSONL event log keyed by `run-id`**, in a
  per-project location; the source of truth, replayed to rebuild run state.
  Behind a small store interface (filesystem implementation).
- **State machine** — `running` | `parked` | `crashed` | `cancelled` |
  `completed`. Only `completed` is terminal; **only `running` blocks** new runs;
  transitions per spec §5.3.
- **Commands** — `/workflow run <file> [input]`, `/workflow resume [run-id]`,
  `/workflow list`, `/workflow cancel [run-id]`, `/workflow delete <run-id>`.
- **Models** — `provider/modelId` format; resolution order
  `step → workflow default → session default`. Test binding:
  **`kimchi-dev/kimi-k2.7`**.
- **Determinism** — the engine drives all transitions; branch/loop conditions
  are pure, side-effect-free predicates; LLM calls happen only inside
  agent-step bodies. This enables scripted (no-network) engine tests plus real
  E2E via the PI adapter.

### PI host adapter — verified seam

Confirmed against `@earendil-works/pi-coding-agent` (the only real integration
unknown before P4); the `HostPort` maps cleanly onto it:

- **Command** — `registerCommand("workflow", { handler(args, ctx) })`.
- **Run an agent step** — `setModel(kimi-k2.7)` → `ctx.sendUserMessage(prompt)`;
  subscribe `on("agent_end", e => …)`. `AgentEndEvent = { messages }`; the last
  assistant message is the step's raw output.
- **Validate + steer** — check that message against the step's TypeBox output; on
  mismatch `sendMessage(correction, { deliverAs: "steer" })` and retry within the
  policy (spec §9.2).
- **Q&A / same-loop resume** — a `{question}` final message → `parked`; on answer
  `sendUserMessage(answer, { deliverAs: "followUp" })`.
- **UI** — render parked questions and progress via `CustomMessage`
  (`customType` / `content` / `display` / `details`) + a message renderer.
- **Adapter gotchas** (from a kimchi spike): `agent_end` carries no `willRetry`
  flag → dedupe across provider retries; `.dountil` echo-back observed.

## Testing strategy

- **Unit** — the pure core with a fake `HostPort` (scripted agent outputs);
  deterministic, no network.
- **E2E / smoke** — the real PI host adapter on the **kimchi-dev** harness with
  the model pinned to **`kimchi-dev/kimi-k2.7`**. From Phase 4 onward each phase
  ships an example workflow proven end-to-end on the harness.
- **Canonical example workflows**: `hello`, `pipeline`, `review-loop`,
  `planning`.

---

## Phase 1: Tracer bullet — single function step, end-to-end

**Covers**: spec §1, §2.1, §4, §6.1/§6.3, §7, §8.1–§8.2, §12.

### What to build

The thinnest complete path: the Flow layer (`createWorkflow` / `createStep`
with a TypeBox output schema), a deterministic engine that runs a linear
workflow, `/workflow run <file>` on the PI host, a per-project run store that
appends run/step lifecycle events, and `/workflow list` that reads it. No LLM.

### Acceptance criteria

- [ ] `createWorkflow` / `createStep` type-check with TypeBox schemas; a `hello`
      example workflow file exists and is loaded via the PI loader (bun/tsx).
- [ ] `/workflow run hello.workflow.ts` executes the step and reaches
      `completed` with no LLM/tool involvement.
- [ ] The run is persisted to the per-project store as an ordered event log
      keyed by a unique `run-id`.
- [ ] `/workflow list` shows the run: id, name, started/completed timestamps,
      status `completed`.
- [ ] An engine unit test drives the same workflow through a fake `HostPort`
      (no PI, no network).

---

## Phase 2: Sequencing + typed data flow

**Covers**: spec §2.5, §3.5–§3.9.

### What to build

Multi-step sequences with linear hand-off (previous output → next input) plus
`.map()` and the run context (prior outputs by name, workflow initial input).
TypeBox validation at step boundaries with descriptive errors. The step context
the harness injects: **input, run context (`getStepResult`/`getInitData`), abort
signal, logger**.

### Acceptance criteria

- [ ] The `pipeline` example (≥3 function steps) runs; each step's output feeds
      the next per the linear rule.
- [ ] A later step reads a **non-adjacent** step's output via `.map()` / the run
      context.
- [ ] Input/output that violates a step's TypeBox schema fails the step with a
      descriptive error.
- [ ] Step bodies receive `{ input, ctx, abortSignal, logger }`; `logger` writes
      to the run event log.
- [ ] Unit tests cover linear hand-off and mapped/non-adjacent data flow.

---

## Phase 3: Lifecycle — persistence, resume, cancel, delete, retry

**Covers**: spec §5, §6.2/§6.4/§6.5, §7, §8, §9.1/§9.4.

### What to build

Checkpointing at completed-step boundaries; `/workflow resume` (continue after
the last completed step, re-running the interrupted one — function idempotent,
agent told it was interrupted); `/workflow cancel` (cooperative abort →
`cancelled`); `/workflow delete` (stopped runs only); unified retry
(`maxRetry` + backoff) → `crashed` on exhaustion; the only-`running`-blocks
rule; and resume across a fresh process/session.

### Acceptance criteria

- [ ] A `pipeline` run cancelled mid-flight → `cancelled`; `resume` continues
      from the last completed step to `completed`.
- [ ] Reloading the run store in a **new process** reconstructs status and
      resumes correctly (persistence survives restart).
- [ ] A step that throws exhausts `maxRetry`, then the run → `crashed` with the
      reason recorded; `resume` retries from that step.
- [ ] `/workflow run` is rejected while another run is `running`; parked/stopped
      runs do not block.
- [ ] `/workflow delete <id>` removes a stopped run; rejected for a live run.
- [ ] Unit tests cover the state transitions (§5.3) and retry exhaustion.

---

## Phase 4: LLM agent step — first `kimi-k2.7` E2E 🤖

**Covers**: spec §2.2, §9.2 (invalid-output steering), §9.5, §12.2.

### What to build

An agent step that runs the PI agent loop until agent-end; its final message is
parsed and validated against the step's TypeBox output schema; invalid output
triggers a steering correction within the retry policy; per-step model
resolution. Ships a minimal single-agent-step workflow (the stepping-stone into
`review-loop`).

### Acceptance criteria

- [ ] An agent step runs on the PI host with `kimchi-dev/kimi-k2.7`, ends, and
      yields a TypeBox-valid output object.
- [ ] A deliberately strict schema triggers ≥1 steering correction, then either
      succeeds or `crashes` after exhausting retries — deterministically w.r.t.
      the policy.
- [ ] A per-step `model` overrides the session default; function steps take no
      model.
- [ ] An engine-level test uses a fake host to simulate valid/invalid agent
      outputs (no network).
- [ ] An E2E/smoke test runs the example on kimchi-dev with `kimi-k2.7` and
      asserts the structured result.

---

## Phase 5: Control flow — branch / loops / foreach 🤖

**Covers**: spec §3.1–§3.4.

### What to build

`.branch` multi-match (output keyed by executed step names), `.dowhile` /
`.dountil`, `.foreach` sequential (per-item checkpoint), all conditions pure and
side-effect-free. Ships the `review-loop` example (agent proposes → condition →
loop until pass, with a max-iteration guard).

### Acceptance criteria

- [ ] Branch runs every true arm (sequentially), producing an output keyed by
      executed step names.
- [ ] `foreach` iterates a collection sequentially; interrupting mid-collection
      resumes at the next unprocessed item.
- [ ] A loop repeats until its condition holds; conditions verified pure by test.
- [ ] The `review-loop` example runs E2E on kimchi-dev with `kimi-k2.7` and
      terminates within the max-iteration guard.

---

## Phase 6: Human-in-the-loop — Q&A 🤖

**Covers**: spec §2.4, §5 (`parked`), §10.

### What to build

Q&A-capable agent step with the `{ result } | { question }` discriminated
output; the questionnaire step; `{question}` → `parked`; the harness renders the
question inline; answering resumes the **same** agent loop; **dismiss ≠ cancel**
(stays `parked`); `parked` does not block new runs; multiple parked runs
addressed via `list` + `resume <id>`. Ships the `planning` example.

### Acceptance criteria

- [ ] The `planning` agent step emits `{question}`, run → `parked`; answering
      resumes the same loop, which finally emits `{result}`.
- [ ] Dismissing the prompt leaves the run `parked` (not cancelled); explicit
      `/workflow cancel` stops it.
- [ ] A questionnaire step gathers typed input up front.
- [ ] While a run is `parked`, a second `/workflow run` starts and executes.
- [ ] E2E on kimchi-dev with `kimi-k2.7`: `planning` completes after a scripted
      answer.

---

## Phase 7: Nesting, budgets, observability + example suite 🤖

**Covers**: spec §2.3, §9.3, §11, §12.

### What to build

Nested-workflow step (transparent — folds into the parent `run-id` / event log);
per-step token/time budgets (exceed = a failure kind → retry/crash); full
progress events streamed to the session; and a consolidated example suite with
tests.

### Acceptance criteria

- [ ] A parent workflow runs a nested workflow (composing `pipeline` +
      `review-loop`); child steps appear under the parent `run-id`; parent
      cancel/resume covers the child; `list` shows a single run.
- [ ] A step exceeding its token or wall-time budget is counted as a failure and
      handled by the retry policy.
- [ ] Progress events surface live in the session; `/workflow list` reflects the
      current step and status.
- [ ] The suite `{ hello, pipeline, review-loop, planning }` each has a test;
      the agent-bearing ones run E2E on kimchi-dev with `kimi-k2.7`.

---

## Resolved during planning

- **Granularity** — approved as-is (7 phases).
- **`kimchi-dev/kimi-k2.7` is live** — serverless, tool calls + reasoning +
  vision, 262k context/output. Test binding confirmed.
- **Agent-end API** — `on("agent_end")` → `AgentEndEvent.messages`; final
  assistant message is the step output (see "PI host adapter" above).

## Unresolved questions

- Where should the per-project run store live on disk (e.g. `.pi/workflows/` vs
  the PI/kimchi config dir)?
- `kimi-k2.7` is `is_routable: false` — confirm a workflow agent step can select
  it directly via `setModel` (expected yes; verify in P4).
