# PI Workflows — Extension Spec

## Goal

Build an extension for the PI coding harness that supports authoring and
executing arbitrary workflows. A workflow orchestrates a sequence of steps —
TypeScript functions, LLM agent runs, nested workflows, or user questionnaires —
with deterministic, harness-driven transitions and durable, resumable state.

## Concepts & terminology

- **Workflow** — a definition authored in a TypeScript file (git-tracked,
  editable). Declares steps, control flow, and I/O schemas.
- **Step** — a single unit of work. One of four types (§2).
- **Run** — a single execution instance of a workflow. Has a `run-id`, a status
  (§5), and an event log.
- **Session** — the PI session. Runs are recorded in the session's event log;
  this log is the source of truth for status, resume, and listing.
- **Running run** — at most one run **executes** at a time (§7); other runs may
  coexist `parked` or stopped. A run with no Q&A steps runs to completion without
  human interaction (§10).
- **Engine** — the harness-side executor that drives transitions between steps
  deterministically (§4).

## 1. Workflow definition

1.1. A workflow is defined in a TypeScript file held outside PI, tracked in git,
and edited like any TypeScript file. *(orig. R1)*

1.2. The authoring API is inspired by Mastra's workflow model (`createStep`,
`createWorkflow`, loops, branching) but is **not** a port or clone — it adapts
those fundamentals to PI's conventions. *(orig. R2)*

1.3. Step input/output schemas are defined with **TypeBox**, the harness's schema
library of choice. TypeBox's native JSON Schema output is used directly for LLM
structured-output validation. *(orig. R13/R14)*

1.4. **Loading & execution:** workflow files are loaded via PI's existing
TypeScript loader and transpiled on `/workflow run` (esbuild/tsx/bun). There is
no separate full `tsc` type-check gate; imports/dependencies resolve through PI's
existing mechanism. *(decision)*

1.5. **Identity & versioning.** A workflow declares a `name`/`id` in
`createWorkflow`, used in `list` (§6.3) and the run store (§8.7). **Versioning is
out of scope** — the file is git-tracked (§1.1) and that is the versioning story.
Definition changes are reconciled by step-name matching on resume (§8.5); if an
edit breaks compatibility, the engine surfaces the error (§8.5) and the author
resolves it. *(decision)*

## 2. Step types

A step is one of:

2.1. **Function step** — a TypeScript function. *(orig. R11)*

2.2. **Agent step** — passes a message to the PI harness and runs the agent tool
loop until the agent ends (stops calling tools). May be declared **Q&A-capable**
(§10) so it can both do real work *and* ask the user clarifying questions (e.g. a
"planning" step). *(orig. R12)*

2.3. **Nested-workflow step** — another workflow executed as a step. *(orig. R10;
tracking in §11)*

2.4. **Questionnaire step** — a first-class step that collects structured input
from the user (e.g. to gather workflow parameters). Inherently **Q&A** (§10): it
always suspends for the user. Unlike a Q&A-capable agent step (§2.2) it does no
other work — it only asks. Some workflows need no input at all (e.g. a
dependency-update flow that opens a PR unattended) and omit this step. *(decision)*

2.5. **Step context (what the harness injects).** Every step receives: its
validated **input**; the **run context** (prior step outputs by name, workflow
initial input, run metadata — `getStepResult`/`getInitData`, §3.7); an **abort
signal** (for cooperative cancel, §8.6); and a **logger** (writes to the run event
log, §8.1). An agent step additionally gets its resolved model (§9.5) and the PI
message/tooling harness. *(orig. R11/R12; decision)*

## 3. Control flow & data flow

A workflow is built by chaining constructs on a builder (Mastra-inspired, §1.2)
and finalized (`.commit()`-style). Every step has a unique **name** used both for
data-flow addressing (§3.7) and event-log matching on resume (§8.5).

**Control-flow constructs** *(orig. R2)*:

3.1. **Sequence** — `.then(step)`: run steps in order.

3.2. **Branch** — `.branch([[cond, step], …])`: **multi-match** — every arm whose
condition is true runs (sequentially; there is no parallel execution). The
construct's output is an object keyed by the executed step names. Conditions are
**side-effect-free** predicates `(ctx) => boolean` the engine evaluates over the
run context, keeping transitions deterministic (§4). *(decision)*

3.3. **Loop** — `.dowhile(step, cond)` / `.dountil(step, cond)`: repeat a step
while / until a condition holds. Output is the last iteration's output. `cond` is
likewise a side-effect-free predicate over the run context / the step's latest
output.

3.4. **Foreach** — `.foreach(step)`: iterate a step over an array input
**sequentially** (one item at a time; no concurrency). Output is the array of
per-item outputs. Each iteration checkpoints (§8); resume continues at the next
unprocessed item.

**Data flow:**

3.5. A step *may* declare a TypeBox input schema and *may* declare a TypeBox
output schema. *(orig. R13/R14)*

3.6. **Linear default:** a step's input is the previous step's output when the
schemas line up — simple chains need no wiring. A step with no input schema
ignores the upstream output. *(orig. R13/R14; decision)*

3.7. **Non-adjacent access** (after a branch, across a loop, or from an earlier
step): use a `.map()` between steps, or read the **run context** inside a step's
body. The context exposes prior step outputs keyed by step name, the workflow's
initial input, and run metadata. (Mastra parity: `.map({ step, path } | fn)`,
`getStepResult(step)`, `getInitData()`.) *(decision)*

3.8. **Construct outputs** feeding the next step: branch → object keyed by
executed step name (§3.2); foreach → array of per-item outputs (§3.4); loop →
last iteration's output (§3.3).

3.9. A workflow *may* declare a top-level input schema. Where a workflow requires
user-supplied input, it is gathered via a questionnaire step (§2.4) rather than a
mandatory launch argument.

## 4. Execution engine (deterministic transitions)

4.1. Transitions between steps are executed by the harness engine
**deterministically**, without relying on LLM tool calls or steering messages to
decide control flow. *(orig. R4)*

4.2. This constraint applies to **transitions only**. Two mechanisms operate
*within* a step and are not transitions:
  - **Output steering** (§9.2): correcting an agent's invalid output.
  - **Question suspension** (§10): an agent emitting a `{question}`.

  These are step-internal and do not contradict 4.1. *(clarifies orig. R4 vs
  R15/R19)*

## 5. Run lifecycle & states

5.1. A run is always in exactly one status: *(orig. R5)*
  - **running** — actively executing.
  - **parked** — suspended at a Q&A step awaiting an answer (§10). Parks
    indefinitely; never auto-cancels or times out.
  - **crashed** — a step failed and retries were exhausted (§9).
  - **cancelled** — the user deliberately stopped the run (§6.4).
  - **completed** — reached the final step.

5.2. **Terminality & retry (GitHub-Actions-style).** Only **completed** is
terminal. `parked`, `crashed`, and `cancelled` are all
recoverable via `/workflow resume`: resume continues from the last completed step,
re-running the failed/interrupted step and everything after it (§8). Re-running a
`completed` run means starting a **new** run (fresh run-id), never a transition
back. *(decision)*

5.3. **Transitions:**
  - `running →` `completed` | `crashed` | `cancelled`, or the suspension `parked`.
  - `crashed` | `cancelled` `→ running` via `resume`; `parked → running` on answer.
  - `cancel` is an explicit user action from `running` or `parked`; a parked run is
    never cancelled automatically — dismissing its question keeps it parked
    (§10.2). *(decision)*

## 6. Commands

6.1. `/workflow run <file.ts>` — start a run. Rejected if another run is currently
`running` (§7). *(orig. R3)*

6.2. `/workflow resume [run-id]` — recover a `parked` (with an answer), `crashed`,
or `cancelled` run, continuing from the last checkpoint (§5.2/§8). Requires that no
run is currently `running`. A run-id selects among coexisting or earlier-session
runs; omittable when unambiguous. *(orig. R7)*

6.3. `/workflow list` — list runs: run-id, workflow name, started-at,
stopped/completed-at, and status. *(orig. R9)*

6.4. `/workflow cancel [run-id]` — cooperatively abort a run (§8.6); bare targets
the `running` run. Cancelled runs are recoverable via `resume` (§5.2). *(orig. R6)*

6.5. `/workflow delete <run-id>` — permanently remove a **stopped** run
(`crashed`/`cancelled`/`completed`) and its recorded events from history (§8).
Rejected for a live run (`running`/`parked`) — cancel it first. Irreversible: the
run can no longer be resumed or listed. *(decision)*

## 7. Single running run (no concurrent execution)

7.1. At most one run is **`running`** (actively executing a step / the agent loop)
at any time; there is no concurrent or background execution. Runs in other states
— `parked`, `crashed`, `cancelled`, `completed` — may coexist and remain listable
until deleted (§6.5). A `parked` run does **not** block new work. *(decision)*

7.2. `/workflow run` and `/workflow resume` require that no run is currently
`running`; they are rejected while one executes. Resuming a `parked` / `crashed` /
`cancelled` run makes it the single running run, subject to the same rule.

7.3. Bare `/workflow cancel` targets the currently `running` run; when nothing is
running or the target is ambiguous, a run-id is required. `resume` / `delete` take
a run-id to pick among coexisting runs (omittable when unambiguous). *(decision)*

## 8. Persistence, durability & resume

8.1. **Recording:** run execution is recorded as an append-only **event log** —
step started/completed, retries, questions/answers, status changes. This log is
the source of truth for status, resume, and listing; the active session surfaces it
live (§12) and it persists in the per-project run store (§8.7). *(orig. R6/R7)*

8.2. **Checkpoint granularity:** completed steps are checkpointed. On resume the
engine continues after the last completed step(s). *(orig. R8)*

8.3. **Interrupted (not completed) steps** on resume:
  - **Function step** — treated as idempotent and re-run.
  - **Agent step** — re-run, with the agent told the previous run was interrupted
    (so it can inspect current state before acting).

  > NOTE / author contract: "functions are idempotent" is an assumption the
  > workflow author must uphold. Side-effecting functions (appends, external POST,
  > non-deterministic reads) can double-apply on rerun; author accordingly.
  *(decision)*

8.4. **Two distinct interruption paths** (must not be conflated):
  - **Crash / cancel** — mid-step abort: the interrupted step re-runs from
    scratch per 8.3.
  - **Question suspension** (§10) — a clean, fully-recorded suspend point: the
    **same agent loop resumes** with the user's answer appended, context intact.
  *(clarifies orig. R8 vs R19)*

8.5. **Definition drift** (file edited between launch and resume): resume
re-reads the current file. Completed steps are matched by name (skipped / allowed
to rerun). If a step's schema no longer matches the recorded I/O, the engine
reports the incompatibility to the user rather than proceeding silently.
*(decision)*

8.6. **Cancel semantics:** `/workflow cancel` signals a cooperative abort; the
current step is asked to stop at the next safe point (abort signal); status →
`cancelled`. Already-applied side effects (files, commits, PRs, commands) are
**not** rolled back. The run is recoverable — `resume` continues from the last
completed step (§5.2). *(decision)*

8.7. **Run store (per project).** Runs and their event logs persist in a
**per-project** store, keyed by `run-id`, independent of any single session — so
`list` / `resume` / `delete` work across sessions and harness restarts. Each run
records its workflow `name`/`id` and **file path** (§1.5) so `resume` can reload
the definition (§8.5). `delete` (§6.5) removes a stopped run from this store.
*(decision)*

## 9. Retry, failure & budgets

9.1. **Unified repeat policy:** a step may declare a repeat policy (`maxRetry`,
backoff) that covers all failure kinds uniformly. *(orig. R16)*

9.2. Failure kinds handled within the policy:
  - **Invalid output vs schema** — the agent's final output does not match the
    TypeBox output schema; the harness sends a steering message explaining the
    expected format and retries within the policy. *(orig. R15)*
  - **Thrown error** — a step raised an error.
  - **Budget/time exceeded** — see 9.3.

9.3. **Per-step budgets:** a step may declare a max token budget and/or max wall
time (§orig. R18). Exceeding a budget is a failure kind counted against the
repeat policy.

9.4. **Terminal outcome:** when retries are exhausted, the run enters `crashed`
with the failure reason recorded. *(orig. R16/R18)*

  > NOTE: a retry re-runs the failed step and carries the **same idempotency
  > caveat** as resume (§8.3) — a step that applied side effects before failing
  > (e.g. opened a PR, then failed output validation) may double-apply on retry.
  > The §8.3 author contract applies to retries too.

9.5. **Per-step model:** an agent step may declare the `model` to use — a PI model
id validated against PI's existing model registry. A workflow may declare a default
model. Resolution order for a step: step `model` → workflow default → the
harness/session default. Function steps take no model. *(orig. R17; decision)*

## 10. Questions & human input

10.1. **Q&A capability is per-step.** A step may be declared **Q&A-capable**; only
such steps may ask the user and suspend the run. This is a static property of the
workflow definition, not a run-level mode. *(orig. R19/R20; decision)*
  - **Q&A-capable agent step** — output schema is a discriminated union
    `{ result } | { question }`. The step does real work *and* may emit
    `{question}` to reduce ambiguity (e.g. a "planning" step), possibly multiple
    times. Each `{question}` suspends the run (`parked`), displays the
    question, and — on answer — resumes the **same agent loop** with the answer
    appended (§8.4), until the step finally emits `{result}`. Questions **do not**
    use LLM tools.
  - **Non-Q&A agent step** — output is `{ result }` only; the agent cannot ask and
    must decide autonomously.
  - **Questionnaire step** (§2.4) — inherently Q&A; only asks, does no other work.

10.2. **Rendering & dismissing a parked question.** When the harness session is
active, it recognizes a `parked` run's pending question and renders it (the
questionnaire) inline; answering resumes the run. **Dismissing/exiting the prompt
does not cancel** — the run stays `parked` and the question resurfaces on return or
via `resume`. Stopping a parked run requires explicit `/workflow cancel`. With
several runs parked at once, `list` surfaces them and `resume <run-id>` selects
which to answer. *(decision)*

10.3. **Unattended execution is a design property, not a policy.** A workflow with
no Q&A steps never blocks on a human. A workflow that reaches a Q&A step with no
one present simply **parks** indefinitely until resumed. There is no
attended/unattended run mode and no AFK question-policy. *(decision — replaces
orig. R20 policy enum)*

## 11. Nested workflows

11.1. A nested-workflow step is tracked **transparently**: its steps fold into
the parent's event log under the **parent run-id**. `/workflow list` shows a
single run; parent resume/cancel naturally cover the child. *(orig. R10;
decision)*

## 12. Progress & observability

12.1. The engine emits step lifecycle events — step started, step completed,
retry, parked (question shown), answered, crashed — to the session transcript /
event log (§8.1) as they occur, so a user watching the session sees live progress.
*(decision)*

12.2. A `running` agent step streams its output inline like a normal PI agent turn;
a Q&A-capable step renders its `{question}` inline (§10.2). *(decision)*

12.3. `/workflow list` (§6.3) reflects each run's current status and step; per-run
detail (event history, current step, failure reason) is available from the recorded
events (§8.1). *(decision)*

## Open items (TODO)

*None outstanding — all requirements from the original list are resolved. Remaining
unknowns are implementation-level (e.g. the exact TypeBox shape of the
`{ result } | { question }` union, and the `.map()` context typing), not spec
gaps.*
