# PI Workflows — Extension Spec

## Goal

Build an extension for the PI coding harness that supports authoring and
executing arbitrary workflows. A workflow orchestrates a sequence of steps —
TypeScript functions, LLM agent runs, nested workflows, or user questionnaires —
with deterministic, harness-driven transitions and durable, resumable state.

## Concepts & terminology

- **Workflow** — a definition authored in a TypeScript file (git-tracked,
  editable). Declares steps, control flow, and I/O schemas.
- **Step** — a single unit of work. One of four types (§2). Every step has a
  **state** (§5.1).
- **Run** — a single execution instance of a workflow. Has a `run-id`, a status
  (§5.2), and an event log.
- **Session** — the PI session. Runs are recorded in the per-project run store;
  the event log is the source of truth for state, resume, and listing.
- **Executing run** — at most one run **executes** per project at a time (§7);
  other runs may coexist blocked or stopped. A run with no Q&A steps runs to
  completion without human interaction (§10.3).
- **Engine** — the harness-side executor that drives transitions between steps
  deterministically (§4).
- **Node path** — the address of a step within a run: enclosing node names, the
  iteration or item index where one applies, then the step name — e.g.
  `until-valid#3/design`, `batch@7/review`, `audit/lint` (§8.5). `#` marks a loop
  iteration and `@` a foreach item: the two are addressed alike but keyed differently
  (§5.4), so the wire format says which it is rather than leaving it inferred.

## 1. Workflow definition

1.1. A workflow is defined in a TypeScript file held outside PI, tracked in git,
and edited like any TypeScript file. *(orig. R1)*

1.2. The authoring API is inspired by Mastra's workflow model (`createStep`,
`createWorkflow`, loops, branching, structural fan-out) but is **not** a port or
clone — it adapts those fundamentals to PI's conventions. In particular,
concurrency is **structural** as it is in Mastra: it comes from `.parallel` and
`.foreach`, not from declared step dependencies. There is no `dependsOn` and no
readiness scheduler. *(orig. R2; decision)*

1.3. Step input/output schemas are defined with **TypeBox**, the harness's schema
library of choice. TypeBox's native JSON Schema output is used directly for LLM
structured-output validation. *(orig. R13/R14)*

1.4. **Loading & execution:** workflow files are loaded via PI's existing
TypeScript loader and transpiled on `/workflow run` (esbuild/tsx/bun). There is
no separate full `tsc` type-check gate; imports/dependencies resolve through PI's
existing mechanism. The authoring API is reachable from a workflow file by package
package name (`@kimchi-dev/kimchi-workflows`), which also resolves for files inside this
package itself; module resolution is relative to the importing file, so a workflow
must be validated from the directory it will actually live in (§6.6). *(decision)*

1.5. **Identity & versioning.** A workflow declares a `name`/`id` in
`createWorkflow`, used in the catalog (§6.7), `run list` (§6.3), and the run store
(§8.9). **Versioning is out of scope** — the file is git-tracked (§1.1) and that is
the versioning story. Definition changes are reconciled on resume by re-validating
recorded outputs (§8.7); if an edit breaks compatibility, the engine surfaces the
error and the author resolves it. *(decision)*

## 2. Step types

A step is one of:

2.1. **Function step** — a TypeScript function. *(orig. R11)*

2.2. **Agent step** — passes a message to the PI harness and runs the agent tool
loop until the agent ends (stops calling tools). May be declared **Q&A-capable**
(§10) so it can both do real work *and* ask the user clarifying questions (e.g. a
"planning" step). Each agent session the engine opens is tagged with the **step
name** it belongs to, so a host can attribute cost and telemetry per step — and a
test double can script replies per step rather than per session. *(orig. R12;
step tagging: decision)*

  **Overlap implies isolation.** An agent step that *can* run concurrently with another
  — one inside `.parallel`, or inside a `.foreach` whose concurrency exceeds 1 — is
  executed isolated, exactly as `background` is, and this is decided statically from the
  definition rather than from what happens to be in flight. The reason is not a
  limitation to be engineered around: a session hosts one conversation, and two agents
  cannot both be mid-turn in it. Sharing one would mean either serialising the fan-out
  (making `.parallel` a lie) or interleaving two agents' turns in one history (making
  both incoherent). A host whose session rejects a second concurrent turn must therefore
  fail loudly rather than let two steps race for one reply. *(decision)*

  An agent step may declare `background: true`, which runs it as a **PI subagent**:
  its own context window and tool loop, no access to the parent session's history,
  returning only its schema-valid output (§12.2). Background is for agent steps
  only, and a background step may not be Q&A-capable — `background` together with
  `asks` is rejected at `.commit()` (§10.1). *(decision)*

  **Continuity is declared, and may be shared.** An isolated step starts cold every
  execution, which is right for a verifier and wrong for a worker that was interrupted.
  `resumable: true` asks the host to keep that step's conversation under its own name and
  resume it next time. A **string** names a conversation shared by every step declaring
  the same key: they take turns in one context, in workflow order. That is what it takes
  to express an **orchestrator** — the step that plans work and the step that rules on
  what came back are one agent carrying its own reasoning between them, not two strangers
  each briefed with a summary of it. Isolation is the limit: a shared key is a shared
  session, so `.commit()` rejects one on any step that can overlap, for the same reason
  two agents cannot share a session mid-turn. A key is node-path syntax-checked like a
  step name (§3) — the host makes it a filename. *(decision)*

2.3. **Nested-workflow step** — another workflow executed as a step. *(orig. R10;
tracking in §11)*

2.4. **Questionnaire step** — a first-class step that collects structured input
from the user (e.g. to gather workflow parameters). Inherently **Q&A** (§10): it
always blocks for the user. Unlike a Q&A-capable agent step (§2.2) it does no
other work — it only asks. Some workflows need no input at all (e.g. a
dependency-update flow that opens a PR unattended) and omit this step.

  Its annotated TypeBox output schema is the single source of truth: the framework
  derives the questionnaire from it, renders it, and validates the answers against
  it.

  A questionnaire step is **never cancelled by its answers**: answers that are
  incomplete or fail the target schema re-block it with the same batch, exactly as
  leaving a mandatory question blank leaves it pending. A re-block carries the schema
  **violation** that rejected the answers, which is what distinguishes "asking" from
  "asking again, and here is what was wrong" — a first ask carries none, and neither
  does an agent's question (§10.1), which is a question rather than a rejection.
  *(decision)*

2.5. **Step context (what the harness injects).** Every step receives: its
validated **input**; the **run context** (prior step outputs by name or node path,
workflow initial input, run metadata — `getStepResult`/`getInitData`, §3.9); an
**abort signal** (for cooperative cancel, §8.8); and a **logger** (writes to the run
event log, §8.1). An agent step additionally gets its resolved model (§9.6) and the
PI message/tooling harness. *(orig. R11/R12; decision)*

## 3. Control flow & data flow

A workflow is built by chaining constructs on a builder (Mastra-inspired, §1.2)
and finalized (`.commit()`-style). Every step has a **name**, unique within its
enclosing scope, used for data-flow addressing (§3.9), event-log matching on
resume (§8.7), and node-path addressing (§8.5).

`.commit()` is the authoring-time gate: it rejects a workflow with no nodes,
duplicate names within a scope, a name containing `/`, `#`, or `@` (all three are
node-path syntax, §8.5, and a name carrying one makes a path unparseable), a
per-construct `concurrency` above the workflow ceiling (§3.6), a `background` step
that also asks (§2.2), or a node that is **not a step** — anything not produced by
one of the step constructors (§2). Without that last
check a malformed definition commits successfully and only fails once the engine
tries to execute it, which is precisely how generated code (§6.6) using a
plausible-but-wrong builder API slips through. *(decision)*

**Control-flow constructs** *(orig. R2)*:

3.1. **Sequence** — `.then(step)`: run steps in order.

3.2. **Branch** — `.branch([[cond, step], …])`: **multi-match** — every arm whose
condition is true runs. The construct's output is an object keyed by the executed
step names; when **no** condition matches the output is `{}` and the run continues
(a data-dependent flow reaching none of its arms is a legitimate outcome; a
downstream step that cannot cope says so through its own input schema). Arms whose
condition was false are `skipped` (§5.1). Conditions are **side-effect-free**
predicates `(ctx) => boolean` the engine evaluates over the run context, keeping
transitions deterministic (§4). *(decision)*

3.3. **Loop** — `.dowhile(step, cond)` / `.dountil(step, cond)`: repeat a step
while / until a condition holds. Output is the last iteration's output. `cond` is
likewise a side-effect-free predicate over the run context / the step's latest
output. Every loop declares `maxIterations` (default **100**); exceeding it crashes
the run naming the node, which is what makes termination a property of the engine
rather than of the model's judgement. *(decision)*

3.4. **Foreach** — `.foreach(step, { concurrency })`: iterate a step over an array
input. `concurrency` defaults to **1** (sequential), so a side-effecting body over a
long list does not fan out unless the author says so. Output is the array of per-item
outputs **in item order**, never completion order. An empty array yields `[]` and the
run continues; a non-array input is a wiring failure and crashes (§3.8). Each item
checkpoints (§8.2); resume continues at the next unprocessed item. *(decision)*

3.5. **Parallel** — `.parallel([a, b, …])`: structural fan-out over independent
steps. All arms run concurrently, bounded only by the workflow ceiling (§3.6);
output is an object keyed by step name, so it is independent of completion order.
*(decision)*

3.6. **Concurrency ceiling.** `createWorkflow({ maxConcurrency })` bounds the total
number of steps executing at once across every construct in the run, including
nested workflows, which inherit the root run's ceiling. It defaults to **4** and caps
every construct: a 20-arm `.parallel` runs 4 at a time rather than opening 20 model
sessions at once. Raising it is an explicit author decision. A per-construct
`concurrency` **above** the ceiling is rejected by `.commit()` rather than silently
capped — an author who writes `8` should learn that the workflow says `4`, not
discover it from timing. *(decision)*

**Data flow:**

3.7. A step *may* declare a TypeBox input schema and *may* declare a TypeBox
output schema. *(orig. R13/R14)*

3.8. **Linear default:** a step's input is the previous step's output when the
schemas line up — simple chains need no wiring. A step with no input schema
ignores the upstream output. An input that fails the declared schema is a
deterministic **wiring failure**: it crashes the run immediately and is **never
retried**, since re-running cannot change the result. *(orig. R13/R14; decision)*

3.9. **Non-adjacent access** (after a branch, across a loop, or from an earlier
step): use a `.map()` between steps, or read the **run context** inside a step's
body. The context exposes prior step outputs, the workflow's initial input, and run
metadata. Lookups take either a **bare name**, resolved lexically to the nearest
enclosing scope, or an explicit **node path** (`audit/lint`). Lexical resolution walks
the reading step's own ancestors outward and stops at the first match, so with
names unique within a scope (§3) a bare read is always deterministic — there is no
ambiguity for `.commit()` to reject. A name that matches nothing in scope reads
`undefined`; reach into a sibling scope with an explicit path. (Mastra parity: `.map({ step, path } | fn)`, `getStepResult(step)`,
`getInitData()`.) *(decision)*

  **Reads never race.** A lookup naming a step that is currently **in flight** throws
  rather than returning `undefined`. Step bodies are arbitrary code, so nothing can
  statically prevent a `.map()` or a condition from reaching for a concurrently
  executing step (§3.4/§3.5) — and a silent `undefined` would make the result depend
  on who won the race, which is exactly the nondeterminism §4.2 exists to exclude. A
  deterministic error is the only honest answer. A step that has not been reached, or
  was `skipped`, still reads `undefined`: that is a structural fact, not a race.
  *(decision)*

3.10. **Construct outputs** feeding the next step: branch → object keyed by
executed step name, `{}` when none matched (§3.2); foreach → array of per-item
outputs in item order (§3.4); loop → last iteration's output (§3.3); parallel →
object keyed by step name (§3.5).

3.11. A workflow *may* declare a top-level input schema. Where a workflow requires
user-supplied input, it is gathered via a questionnaire step (§2.4) rather than a
mandatory launch argument — including when nobody is present to answer (§10.3).

## 4. Execution engine (deterministic transitions)

4.1. Transitions between steps are executed by the harness engine
**deterministically**, without relying on LLM tool calls or steering messages to
decide control flow. *(orig. R4)*

4.2. **What determinism means under concurrency (§3.4/§3.5).** The set of steps
that execute, the input each receives, and every construct's output are
deterministic and independent of scheduling: foreach output is ordered by item,
branch and parallel outputs are keyed by name. What is **not** deterministic is the
interleaving of concurrent steps' side effects and the order in which their events
land in the log. Conditions remain pure, and a context read cannot observe an
in-flight step (§3.9), so the engine — never the model, never a race — decides
transitions. *(decision)*

4.3. This constraint applies to **transitions only**. Two mechanisms operate
*within* a step and are not transitions:
  - **Output steering** (§9.2): correcting an agent's invalid output.
  - **Question suspension** (§10): an agent emitting a `{questions}`.

  These are step-internal and do not contradict 4.1. *(clarifies orig. R4 vs
  R15/R19)*

## 5. States

5.1. **Step state.** A step is always in exactly one state: *(decision)*
  - **todo** — not reached yet.
  - **in_progress** — executing, including retries and output steering.
  - **blocked** — suspended awaiting a human answer (§10).
  - **completed** — finished; its output is recorded.
  - **skipped** — never eligible: a branch arm whose condition was false (§3.2).
  - **cancelled** — interrupted by an explicit user cancel (§6.4).
  - **crashed** — retries exhausted (§9.5).

  `todo` covers "inputs not ready / not reached"; `blocked` means, and only ever
  means, *waiting on a human*. The two must not be conflated — a step waiting for a
  free concurrency slot is `todo`, not `blocked`.

5.2. **Run status** uses the same vocabulary, minus the two that only make sense
per step: a run is `in_progress`, `blocked`, `completed`, `cancelled`, or
`crashed`. *(decision — replaces the earlier `running`/`parked` wording)*

5.3. **Status is derived from the event log**, with step states as the intermediate
view — no status field is authoritative on its own:
  - any step `in_progress` → run `in_progress` (work is happening, even if another
    step is simultaneously blocked);
  - else any step `blocked` → run `blocked`;
  - else a recorded run-level `cancelled` or `completed` event decides;
  - else any step `crashed` → run `crashed`.

  `completed` and `cancelled` are run-level facts and cannot be derived from step
  states alone: a run completes when its final node completes, and a cold cancel
  (§6.4) can arrive at a run with no step executing at all. *(decision)*

5.4. **State keys.** Step state is keyed by **static node path** — the node path
with iteration indices dropped (`until-valid/design`) — and the latest execution
wins, so a `run list` stays bounded no matter how many iterations ran. Foreach item
state is the exception: it is keyed **per item index**, because with
`concurrency > 1` several items are genuinely live at once. Iteration counters,
per-item history and retry attempts remain readable from the events themselves.
*(decision)*

5.5. **Terminality & retry (GitHub-Actions-style).** Only **completed** is
terminal. `blocked`, `crashed`, and `cancelled` are all recoverable via
`/workflow resume`: resume continues from the last checkpoint, re-running
interrupted steps and everything after them (§8). Re-running a `completed` run means
starting a **new** run (fresh run-id), never a transition back. *(decision)*

5.6. **Transitions:**
  - `in_progress →` `completed` | `crashed` | `cancelled`, or the suspension `blocked`.
  - `crashed` | `cancelled` `→ in_progress` via `resume`; `blocked → in_progress` on answer.
  - `cancel` is an explicit user action from `in_progress` or `blocked`; a blocked run
    is never cancelled automatically — dismissing its question keeps it blocked
    (§10.2). *(decision)*

## 6. Commands

6.1. `/workflow run <name|file.ts> [--input <json>|@<file>]` — start a run. The
argument is resolved as a filesystem path when it ends in `.ts`, otherwise as a
workflow **name** from the catalog (§6.7). Paths resolve relative to the project
root. Rejected if another run is executing in this project (§7). *(orig. R3; name
resolution: decision)*

  **`--input`** supplies the run's initial input (§3.11): `--input <json>` parses its
  argument as JSON directly; `--input @<path>` reads the file at `<path>` (a relative
  path resolves against the project root, exactly like `<name|file.ts>` itself) and
  parses its contents as JSON. The parsed value is validated against the workflow's
  declared top-level input schema, if it has one, using the SAME TypeBox check the
  engine runs on it at the top of `runWorkflow` (§4) — not a second, hand-rolled one
  that could drift from it. Every failure — malformed JSON, an unreadable file, a
  schema violation — is reported and the run is **never started**: no run-id is
  minted, the project lock (§7.2) is never acquired, and nothing is appended to any
  run's log. This is deliberately stricter than leaving it to the engine's own check
  alone, which would still catch a bad payload correctly but only after paying for
  all three. Omitting `--input` is `undefined`, exactly as before the flag existed.
  Until this, only `/workflow create` (§6.6) supplied an initial input — its own
  project root, fixed and hardcoded — so a workflow whose first step needs input
  could not be started from the command surface at all. *(decision)*

6.2. `/workflow resume [run-id]` — recover a `blocked` (with an answer), `crashed`,
or `cancelled` run, continuing from the last checkpoint (§5.5/§8). Requires that no
run is executing. A run-id selects among coexisting or earlier-session runs;
omittable when exactly one recoverable run exists. *(orig. R7)*

6.3. `/workflow run list` — list runs: run-id, workflow name, started-at,
stopped/completed-at, status, current step, and **pending-question count**. The count
is not decoration: a run with one blocked step and one executing step reads
`in_progress` (§5.3), so without it a waiting question is invisible in the listing.
`list` is reserved as `run`'s first argument, so it can never name a workflow.
*(orig. R9; decision)*

6.4. `/workflow cancel [run-id]` — stop a run. Two cases, because a `blocked` run is
not executing (§7.1) and so has no signal to interrupt:
  - **executing run** — cooperatively abort at the next step boundary (§8.8);
  - **blocked run** — a *cold* cancel: the transition is recorded directly in the
    event log (§5.6, §8.1), which is what makes §10.2's "stopping a blocked run
    requires explicit `/workflow cancel`" actually hold.

  Bare targets the executing run, or — when none is executing — the sole `blocked`
  run; with several blocked, a run-id is required. Only an executing or `blocked` run
  can be cancelled; a stopped run is rejected. Cancelled runs stay recoverable via
  `resume` (§5.5). *(orig. R6; blocked cancel: decision)*

6.5. `/workflow delete <run-id>` — permanently remove a **stopped** run
(`crashed`/`cancelled`/`completed`) and its recorded events from history (§8). The
run-id is **always required**: deletion is irreversible, so it is never inferred.
Rejected for a live run (`in_progress`/`blocked`) — cancel it first (§6.4), so
removal is always a deliberate second act. *(decision)*

6.6. `/workflow create` — interview the user and generate a new workflow file.
Implemented as a **meta-workflow** (an ordinary `WorkflowDefinition` shipped with
the adapter), so it runs through the same guard, event log, and attended Q&A loop
as any other run. It receives the project root as its initial input. Shape: a
questionnaire step gathers the goal and target file name; a Q&A agent step (§10.1)
asks clarifying batches; a `.dountil` loop presents the plan for Approve/Revise
until approved; a further `.dountil` loop generates the source and validates it by
loading it back (§1.4), retrying on failure; a final function step writes the file.
Because a step may now block anywhere (§8.5), the approval loop is an ordinary loop
rather than an interview crammed into one step.

Generation is **non-destructive and contained**: the target must resolve inside the
project, and an existing file is never written over. Both are hard failures — the
run crashes naming the offending path — rather than accommodations. Quietly writing
to a different name would be worse than failing, since the run would report success
while the file the user named still held something else.

Both are settled **immediately after the opening form**, before the interview runs,
because both are knowable as soon as the filename is given. Deferring them to the
write would spend an interview and a generation round first, and could not be
recovered: the form is already a completed step, so a resume re-runs the write with
the same name (§8.2). The guard is re-applied at the write against the filesystem
as it is then.

Validation loads the candidate **from its destination directory**, since imports
resolve relative to the importing file (§1.4); validating elsewhere rejects every
candidate on unresolvable imports. Loading proves the module imports and commits
(§3); the generating agent is additionally required to check its own output with
whatever tooling the project has (TypeScript, Biome) and to report plainly when
none is available rather than claim a check it did not run. *(decision)*

6.7. `/workflow list` — list the project's workflows: name, file, and description.
The file is shown because two workflows may declare the same name, which `run` then
rejects as ambiguous; such rows are flagged. Files that fail to load are reported
rather than omitted. *(decision)*

6.8. **Workflow catalog.** A project's workflows live in
`<project>/.<app>/workflows/` as `*.workflow.ts`, where `<app>` is the running
harness's own name (§8.9); discovery filters on the suffix. The directory holds
authored sources and the execution lock (§7.2) — never a run's own records, which
live with the harness's sessions (§8.9).

Discovery imports every candidate to read its declared name, so workflow modules
must have no import-time side effects. Because that executes project code,
resolving a **name** first tries the `<name>.workflow.ts` convention and only falls
back to a full scan when it does not hold — so running one workflow does not
normally execute the others. *(decision)*

6.9. **Every argument above is completable** in the interactive editor — verbs,
workflow names, and run-ids filtered to the statuses the verb accepts. Completion is
advisory and changes no dispatch rule; see §14. *(decision)*

6.10. **`/workflow` already works in `print` and `json` mode — no extension-side
dispatch needed.** `AgentSession.prompt()` (`@earendil-works/pi-coding-agent`,
`core/agent-session.js`) checks whether the incoming text starts with `/` and, if so,
tries the harness's own registered-command dispatch FIRST; only when that returns
unhandled does it fall through to emit the `input` event and treat the text as an
ordinary prompt. `/workflow` is always a registered command (`pi.registerCommand`
above), so this dispatch step catches it in every mode — `print` and `json` included
— before the text could ever reach `input`. An extension-side `input` handler
re-parsing `/workflow` lines is therefore unreachable code, not a headless fallback:
this note exists so that fact is not re-derived, and the dead handler is not
re-added, the next time headless dispatch looks like a gap. *(decision)*

## 7. One executing run per project

7.1. At most one run is **executing** per project at any time. Runs in other states
— `blocked`, `crashed`, `cancelled`, `completed` — may coexist and remain listable
until deleted (§6.5). A `blocked` run does **not** block new work. Concurrency
*within* a run (§3.4/§3.5) is unaffected by this rule: it bounds runs, not steps.
*(decision)*

7.2. **The guard is a lock in the project**, not a status read — a status can be
stale, a lock cannot lie about who holds it. An executing run holds
`<project>/.<app>/workflows/.run.lock` recording `{ runId, pid, host, startedAt }`.
It sits with the authored sources (§6.8) rather than with a run's own records
(§8.9), because "one executing run" is a fact about the *project* and must hold
whatever session directory a given invocation happens to write to; it is
dot-prefixed so the authoring directory still lists only workflow sources. `/workflow run`
and `/workflow resume` acquire it and are rejected while it is held, naming the run
that holds it. Acquisition is **atomic** (exclusive create), so two contenders racing
for a free or reclaimable lock cannot both win. This is what makes the rule hold across concurrent PI sessions on the
same project — sessions that would otherwise each execute steps against the same
working tree. Separate projects, and separate git worktrees, have separate stores and
run independently. *(decision)*

7.3. **Stale locks are reclaimed, not waited out.** A contender checks the holder's
liveness: a dead pid on the same host means the process died mid-run, so the lock is
taken and the abandoned run is recorded `crashed` (an explicit event, §8.1) and stays
resumable. That `crashed` event is written **under the acquired lock**, by whichever
process won it — the one moment a session appends to a run other than its own. A lock held by a live pid, or by a different host, is refused rather than
guessed at. Pid liveness is meaningless across container boundaries, so a store shared
between namespaces needs the lock cleared deliberately. *(decision)*

7.4. Bare `/workflow cancel` targets the executing run; when nothing is executing or
the target is ambiguous, a run-id is required. `resume` takes a run-id to pick among
coexisting runs (omittable when exactly one is recoverable); `delete` always requires
one (§6.5). *(decision)*

## 8. Persistence, durability & resume

8.1. **Recording:** run execution is recorded as an append-only **event log** —
step started/completed, retries, questions/answers, state changes. This log is the
source of truth for state, resume, and listing; the active session surfaces it
live (§12) and it persists in the per-project run store (§8.9). Under concurrency the
log's *order* is not deterministic (§4.2), so every event carries the node path it
belongs to and consumers reconstruct per-step history by path rather than by
adjacency. *(orig. R6/R7)*

8.2. **Checkpoint granularity:** completed steps are checkpointed, and a foreach
checkpoints each completed item. On resume the engine continues after the last
completed step(s) and the last completed item(s). *(orig. R8)*

8.3. **Interrupted (not completed) steps** on resume:
  - **Function step** — treated as idempotent and re-run.
  - **Agent step** — re-run, with the agent told the previous run was interrupted
    (so it can inspect current state before acting).

  With concurrency, several steps may be interrupted at once; each re-runs by the
  same rule, so the idempotency exposure scales with the fan-out.

  > NOTE / author contract: "functions are idempotent" is an assumption the
  > workflow author must uphold. Side-effecting functions (appends, external POST,
  > non-deterministic reads) can double-apply on rerun; author accordingly.
  >
  > SECOND author contract — **non-overlapping side effects.** Steps that can run
  > concurrently (§3.4/§3.5) must not touch the same files, branches, or external
  > resources. This matters more here than in a general workflow engine: the steps are
  > agents editing a working tree, so two overlapping steps are two models rewriting
  > one file. The engine does **not** enforce this — it cannot know what a step or its
  > subagent will touch. Sequence anything that shares state, or keep it out of a
  > fan-out.
  *(decision)*

8.4. **Two distinct interruption paths** (must not be conflated):
  - **Crash / cancel** — mid-step abort: the interrupted step re-runs from
    scratch per 8.3.
  - **Question suspension** (§10) — a clean, fully-recorded suspend point: the
    **same agent loop resumes** with the user's answer appended, context intact.
  *(clarifies orig. R8 vs R19)*

  Answering requires the block to still be pending. A recorded questionnaire is not
  proof a run is *currently* blocked — it may have been cancelled after asking (§6.4)
  — so answers arriving afterwards are refused rather than silently reviving a run the
  user stopped. This matters because the run store is shared across sessions (§8.9)
  and a prompt may be open while another session cancels. *(decision)*

8.5. **Blocking is legal anywhere.** A Q&A step may sit inside a loop, a foreach, a
branch arm, or a nested workflow. The block event records the step's full **node
path** — `until-valid#3/design`, `batch@7/review`, `audit/design` — and the
checkpoint records the enclosing node's position (iteration counter and the output
feeding its condition; the item index for a foreach). Resume re-enters the node at
that position and continues the same agent conversation with the answers appended,
rather than restarting the node and re-asking. *(decision — replaces the earlier
top-level-only restriction)*

8.6. **Several steps may be blocked at once** when a fan-out construct blocks in more
than one arm or item — questionnaire steps, since a Q&A *agent* step may not overlap at
all (§10.1). Blocking suspends only its own step: siblings keep running, and
the run reads `in_progress` while any of them does (§5.3). Pending questionnaires form
a **FIFO queue** addressed by node path; the session renders one at a time, and an
answer is matched to the path it was asked from. *(decision)*

  **Settle, then ask.** A fan-out round runs to quiescence before the run reports
  `blocked`: siblings finish or block in turn, and only then does the run surface its
  queue. At that moment nothing is executing and the lock is released (§7.2), so any
  session answers through the ordinary resume path. This is what keeps §7.2 and this
  clause from deadlocking — not a special case exempting answers from the guard, but
  the absence of any moment where a question is pending *while* the run executes.

  The cost, stated plainly: a question raised early in a wide fan-out is not shown
  until its siblings finish, so one slow sibling delays the prompt. At concurrency 1 —
  the default — there is no difference at all. Buying earlier prompts would mean the
  engine handing out a handle answerable mid-flight, which trades this simplicity for
  an interactive surface that is far harder to keep pure and to test. *(decision)*

8.7. **Definition drift** (file edited between launch and resume): resume re-reads
the current file and **re-validates each completed step's recorded output against
that step's current output schema**. A run resumes when the recorded data still
satisfies the definition — a renamed description, a reordered branch, or a step
appended later is no obstacle — and is refused, naming the step and the violation,
when it does not. Cosmetic edits therefore never invalidate a long-running run,
while an edit that would feed stale data downstream is caught before it does.
*(decision)*

8.8. **Cancel semantics:** `/workflow cancel` signals a cooperative abort; executing
steps are asked to stop at the next safe point (abort signal); status → `cancelled`.
Already-applied side effects (files, commits, PRs, commands) are **not** rolled back.
The run is recoverable — `resume` continues from the last checkpoint (§5.5).
*(decision)*

8.9. **Run store.** Runs and their event logs persist keyed by `run-id`, independent
of any single session — so `list` / `resume` / `delete` work across sessions and
harness restarts. A run is **one file**, `<run-id>.events.jsonl`: its workflow `name`
and **file path** (§1.5) are recorded as an event *in that log* rather than in a
sidecar, so a log is self-describing wherever it is read and `resume` can reload the
definition (§8.7) from it alone. `delete` (§6.5) removes it.

The store lives in the **harness's own session directory**, one level down in
`workflow/`, alongside the step session files a run spawns (§2.2) — most of what a
run writes *is* a session, and one location for all of it honours a relocated session
directory for free. The subdirectory is load-bearing: the harness enumerates sessions
non-recursively, so a child directory is invisible to "continue my last session" and
to the session pickers, which a fan-out depositing one file per item would otherwise
flood. When the harness has no session directory at all (an ephemeral, session-less
invocation), the store falls back to `<project>/.<app>/workflows/runs/`, with no
subdirectory — nothing enumerates a project directory. `<app>` is the running
harness's own name, read from it rather than hardcoded, so a product other than `pi`
keeps its own project directory (`.kimchi/…`) instead of being given one.

A `run-id` is **readable and retypeable**: `workflow-<workflow-name>-<8 hex>`, minted
against the store so a name shared by many runs cannot collide. It is the single
identity — the log's filename, the tag inside every step session filename, and the
argument `resume` / `cancel` / `delete` take, which they accept in full, as the bare
hash, or as any unambiguous prefix; several matches are refused with the candidates
named rather than resolved by guessing. *(decision)*

## 9. Retry, failure & budgets

9.1. **Unified repeat policy:** a step may declare a repeat policy (`maxRetry`,
backoff) covering thrown errors and budget overruns uniformly. `maxRetry` counts
attempts **after** the first (default 0 = run once). A retry starts a fresh attempt:
for an agent step, a fresh session from the original prompt. Retry counters are
per-attempt-sequence and **reset on resume**, since a resume is a deliberate user act
— otherwise a crashed run would re-crash immediately with an exhausted budget.
*(orig. R16; decision)*

9.2. **Invalid output is repaired in-session, not retried.** When an agent's final
output does not match the TypeBox output schema, the harness sends a steering message
explaining the violation and lets the agent correct itself within the same
conversation, up to `maxOutputRepairs` times (default **2**). Only when repairs are
exhausted does the attempt fail and the repeat policy apply. The two budgets are
deliberately separate: a repair costs one turn and keeps the agent's own context on
what it got wrong, whereas a retry discards a working session and re-pays the prompt.

  In-session repair requires a resumable conversation, and every step with an output
  contract has one. A `background` or `isolated` step (§2.2) runs as a fresh
  subprocess per turn, but that subprocess resumes the step's own session file, so a
  correction reaches the model with its prior work intact. Execution mode therefore
  does **not** narrow the repair budget: only the absence of an output schema does,
  because a step that reports nothing has nothing to be steered toward.
  *(orig. R15; decision, amended)*

9.3. Failure kinds handled within the repeat policy:
  - **Thrown error** — a step raised an error.
  - **Invalid output** — after in-session repairs were exhausted (§9.2).
  - **Budget/time exceeded** — see 9.4.
  - **Agent error** — the turn completed but the REQUEST failed: the provider
    refused it and the harness recorded an empty assistant message. This is not
    invalid output and is never steered (§9.2), because there is no reply to
    correct; reported as its own `agent-error` event carrying the provider's own
    message, which is otherwise stated nowhere the engine can see.

  **Not** covered: an input that fails its schema, which is a wiring failure and
  crashes without retry (§3.8). Nor a context window exceeded by a session the step
  RESUMES (§2.2): every later turn re-sends that transcript plus more, so the
  attempt is terminal and the repeat policy is skipped rather than spent.
  *(decision)*

9.4. **Per-step budgets:** a step may declare a max token budget and/or max wall
time (§orig. R18). Exceeding a budget is a failure kind counted against the repeat
policy.
  - **Wall time** counts only while the step is `in_progress`. Time spent `blocked`
    is excluded, so a human taking a weekend to answer cannot crash a run.
  - **Tokens** accumulate across an attempt's turns — prompt, steering repairs, and
    answer continuations — and reset when a retry starts a fresh attempt, matching
    what the retry actually restarts. *(decision)*

9.5. **Terminal outcome:** when retries are exhausted the step is `crashed`. With
concurrency, the run then **drains**: no new steps start, in-flight siblings run to
completion and checkpoint normally, and the run ends `crashed`. Draining rather than
aborting preserves work already paid for — which matters most in a foreach, where
every completed item is a checkpoint a later resume need not redo. *(orig. R16/R18;
decision)*

  **A drain does not wait on humans.** Steps that are `blocked` (§8.6) are not
  drained: their pending questions are dropped and those steps are recorded
  `cancelled`. A blocked step waits indefinitely by design, so draining it would hang
  a run that is already doomed on an answer that can no longer change the outcome.
  The questions return if the run is resumed (§5.5). *(decision)*

  > NOTE: a retry re-runs the failed step and carries the **same idempotency
  > caveat** as resume (§8.3) — a step that applied side effects before failing
  > (e.g. opened a PR, then failed output validation) may double-apply on retry.
  > The §8.3 author contract applies to retries too.

9.6. **Per-step model:** an agent step may declare the `model` to use — a PI model
id (`provider/modelId`) validated against PI's existing model registry. A workflow
may declare a default model. Resolution order for a step: step `model` → workflow
default → the harness/session default; a background step (§2.2) resolves the same
way. Function steps take no model. *(orig. R17; decision)*

## 10. Questions & human input

10.1. **Q&A capability is per-step.** A step may be declared **Q&A-capable**; only
such steps may ask the user and block the run. This is a static property of the
workflow definition, not a run-level mode. *(orig. R19/R20; decision)*
  - **Q&A-capable agent step** — output schema is a discriminated union
    `{ result } | { questions }`, where the question payload is a **batch** of
    questions, not a single one. The step does real work *and* may emit a
    `{questions}` to reduce ambiguity (e.g. a "planning" step), possibly multiple
    times. Each `{questions}` blocks the step, displays the batch, and — on answers —
    resumes the **same agent loop** with them appended (§8.4), until the step finally
    emits `{result}`. The framework owns the question schema and injects the asking
    protocol, so the author's prompt stays task-only. Questions **do not** use LLM
    tools.
  - **Non-Q&A agent step** — output is `{ result }` only; the agent cannot ask and
    must decide autonomously. A `background` step (§2.2) is always of this kind: a
    subagent runs isolated and unwatched, so interrupting the parent session for an
    answer whose reasoning the user never saw is rejected at `.commit()`.
  - **Questionnaire step** (§2.4) — inherently Q&A; only asks, does no other work.

  **Q&A-capable agent steps may not overlap.** `asks` inside a `.parallel` arm, or
  inside a `.foreach` whose concurrency exceeds 1, is rejected at `.commit()` — the same
  rejection as `background` + `asks` (§2.2), and for the same underlying reason: an
  overlapping step is isolated, and an isolated step has no conversation to resume an
  answer into. A **questionnaire** step is unaffected and may block anywhere, fan-out
  included: its questions come from a schema, not from a conversation, so there is
  nothing to preserve across the block. That asymmetry is what keeps §8.6's several-steps-
  blocked-at-once case real rather than theoretical. *(decision)*

10.2. **Rendering & dismissing a blocked question.** When the harness session is
active, it recognizes a pending question and renders it inline; answering resumes
that step. **Dismissing/exiting the prompt does not cancel** — the step stays
`blocked` and the question resurfaces on return or via `resume`. Stopping a blocked
run requires explicit `/workflow cancel`. With several questions pending — within one
run (§8.6) or across runs — `list` surfaces them and the queue is answered in order;
`resume <run-id>` selects which run to answer. *(decision)*

10.3. **Unattended execution is a design property, not a policy.** A workflow with
no Q&A steps never blocks on a human. A workflow that reaches a Q&A step with no
one present simply **blocks** indefinitely until resumed from an interactive session.
There is no attended/unattended run mode, no AFK question-policy, and **no launch-time
answer file**: an agent generates its question batches at run time, so no pre-supplied
set could anticipate them, and a second way to fill a step's output would have to be
kept consistent with the first for no gain. Workflows meant for CI are written without
Q&A steps. *(decision — replaces orig. R20 policy enum)*

## 11. Nested workflows

11.1. A nested-workflow step is tracked **transparently**: its steps fold into
the parent's event log under the **parent run-id**, addressed by node path
(`audit/lint`). `/workflow run list` shows a single run; parent resume/cancel
naturally cover the child, including a child step that blocks (§8.5). *(orig. R10;
decision)*

11.2. Step names need only be unique **within their enclosing workflow**, so the same
sub-workflow may be composed twice in one parent without cloning or renaming; the node
path disambiguates. Context reads resolve a bare name lexically and require an explicit
path when ambiguous (§3.9). *(decision)*

## 12. Progress & observability

12.1. The engine emits step lifecycle events — started, completed, retry, blocked
(question shown), answered, skipped, crashed — to the session transcript / event log
(§8.1) as they occur, so a user watching the session sees live progress. Each event
carries its node path, so concurrent steps remain attributable (§8.1). *(decision)*

12.2. **Streaming vs compact rendering follows from isolation** (§2.2), rather than
being decided separately. A step that runs in the session streams inline like a normal
PI agent turn; an isolated step — `background`, or one that can overlap — has no
session turn to stream and renders compactly instead: one progress line, with a summary
flushed on completion. That the two questions have one answer is the point: a step
streams inline exactly when it is the session's single conversation, which is also
exactly when it is safe for it to be. A blocked step renders its `{questions}`
inline (§10.2). *(decision)*

12.3. `/workflow run list` (§6.3) reflects each run's derived status (§5.3) and
current step; per-run detail — step states by node path, event history, pending
questions, failure reason — is available from the recorded events (§8.1).
*(decision)*

## 13. Testing

13.1. **Testing is a first-class part of the framework, not a harness concern.** A
workflow is an ordinary TypeScript value, so it must be executable in a plain test
runner with **no PI, no network, no model, and no filesystem**. The engine's purity
and the host seam exist to make this true; `src/testing` is the supported public
surface, usable from any runner (it ships no runner-specific matchers). *(decision)*

13.2. **A run's behaviour is pinned by three inputs**, and the framework supplies all
three:
  - **agent replies** — scripted per step name as a queue consumed in order across
    sessions, so a retry or an answer-resume simply takes the next entry. Builders
    cover every turn an agent can take: return a result, ask a question batch, return
    something schema-invalid (driving §9.2 steering), throw (driving §9.1 retry), or
    report token usage (driving §9.4);
  - **answers** — supplied to blocked steps; incomplete or invalid answers re-block
    with a `violation`, exactly as in a real session (§2.4);
  - **step overrides** — any step may be replaced by name with a stub. *(decision)*

13.3. **Overrides are schema-checked.** A stub's return value is validated against
the real step's declared output schema, and an override naming a step the workflow
does not contain fails immediately. This is what separates a framework override from
an ad-hoc mock: a stub that has drifted from the contract it stands in for fails the
test instead of hiding the drift. Overrides exist because the alternative — dependency
injection through closures — has nowhere to inject when the unit under test is a
workflow file loaded from disk, and because a function step's failure paths
(retry, crash, resume-after-crash) are otherwise unreachable without writing code that
fails on purpose. *(decision)*

13.4. **Inspectable, immutable results.** Each transition returns a new run handle, so
earlier states stay inspectable: status, output, error, pending question, violation,
events (and events by type), step output by name or node path, per-step agent script
state, and recorded sleeps. Cancellation and resume are drivable from a test, so
§8.3's re-run semantics and §8.5's re-entry into a nested block are directly
assertable. *(decision)*

13.5. **Not in scope:** recording and replaying real model responses as fixtures. The
value is real, but a fixture format, a staleness rule for edited prompts, and a
re-record workflow are a project of their own; hand-scripted replies plus the live
integration suite cover the ground meanwhile. *(decision)*

## 14. Command completion

14.1. **The problem.** Every `/workflow` argument must currently be typed blind.
Workflow names live inside files the user has to remember, and run-ids are opaque
(§8.9) — nobody types one from memory. A mistyped argument only fails *after* the
command dispatches. Completion turns both into a menu at the point of typing.

Scope: the **arguments** of `/workflow` in interactive (TUI) mode. Nothing about
execution changes. Completion is **advisory**: it never becomes a validation path, and
every handler keeps validating its argument exactly as it does today (§6.1, §6.8),
because the user can always type past the menu. *(decision)*

14.2. **The harness seam.** `pi.registerCommand` takes an optional
`getArgumentCompletions(argumentPrefix) => Item[] | null | Promise<…>`, where an item
is `{ value, label, description? }`. Its contract, as PI implements it — the rest of
this section follows from it:

  - it fires only when the line starts with `/` and the word before the first space
    equals the command's invocation name (so duplicate registrations, which PI renames
    `workflow:1`, still complete);
  - `argumentPrefix` is **everything after that first space up to the cursor** — the
    whole argument text, not the token under the cursor;
  - the chosen `value` **replaces that whole argument text**, cursor at its end, no
    trailing space appended. So values are *full argument strings* (`"run
    review-loop"`), `label` carries the short display form, and `description` a
    single-line annotation (rendered dimmed and truncated, only when the popup is
    wider than 40 columns);
  - `null` or `[]` means "no popup" — not "no matches";
  - PI fuzzy-filters *command names* but passes argument prefixes through **untouched**;
    filtering is ours (§14.5);
  - the callback gets **no `ExtensionCommandContext`** — no `cwd`, no store, no UI
    (§14.7);
  - it may be async. PI debounces and abandons stale requests, but hands us no
    `AbortSignal`, so a slow callback is a slow keystroke (§14.6). *(constraint)*

14.3. **What opens the menu.** The popup opens on `/` at line start and re-opens on
any name character typed while the line starts with `/` — so `/workflow r` shows the
filtered verb list. A typed **space** re-queries only while the popup is already open;
**Tab** accepts the highlighted item when the popup is open, and when it is closed
forces *file-path* completion, which bypasses argument completions entirely.
Consequence: `/workflow ` + Tab offers files, not verbs. We accept this (§14.9) —
typing one more character opens the menu. *(constraint)*

14.4. **The grammar.** Completion is a slot table over the same grammar §6 dispatches
on, so the two cannot drift:

| argument text            | slot     | candidates                                          |
| ------------------------ | -------- | --------------------------------------------------- |
| empty, or one partial token | verb  | `run`, `create`, `list`, `status`, `resume`, `cancel`, `delete` |
| `run <partial>`          | workflow | `list` (§6.3, reserved and offered first), then `*.workflow.ts` filenames (§14.6) |
| `status <partial>`       | run-id   | **every** recorded run — no filter                  |
| `resume <partial>`       | run-id   | `blocked`, `crashed`, `cancelled` (§6.2)            |
| `cancel <partial>`       | run-id   | `in_progress`, `blocked` (§6.4)                     |
| `delete <partial>`       | run-id   | `completed`, `crashed`, `cancelled` (§6.5)          |
| `create …`, `list …`     | —        | none                                                 |
| a second argument onward | —        | none                                                 |

Each candidate is emitted as `<verb> <candidate>`, the full argument string per §14.2,
with the bare candidate as its `label`. A verb that takes an argument inserts its
**trailing space** (`"run "`), because PI appends none and accepting a completion
closes the popup: without it the user lands mid-token, and the menu only re-opens on a
name character (§14.3). `create` and `list` insert no trailing space.

`status` is the one run-id slot with no filter, and for the same reason the others
have one: a run's tree is rebuilt from its log alone, so every recorded run can be
shown. Its id is optional at the command — bare means the executing run — which makes
completion the only practical way to reach a run that is *not* executing.

The **status filters are the feature**, not decoration: they are exactly the sets each
verb accepts, so a completed run-id is one the command cannot then reject. They are
therefore derived from the existing predicates — `resumeAction(status).kind !== "error"`
for `resume` (§5.2), the live/stopped split for `cancel`/`delete` — never restated as
a second copy of the rule. *(decision)*

`run <partial>`'s slot completes ONLY the workflow-name token — `--input` (§6.1) is,
textually, a second argument, and the existing "a second argument onward: none" row
already covers it. This is not an oversight left over from before `--input` existed:
completing a `--input` VALUE would mean completing arbitrary JSON or a project-relative
file path, neither of which fits "one popup, one candidate list" the rest of this
section is built on, and completing the bare flag name alone (`--input `) would not
save a keystroke the way a workflow name or a run-id does. *(decision)*

14.5. **Filtering and ordering.** Case-insensitive prefix match on the slot token,
falling back to substring; ties keep the source order. Workflows sort by name; runs
come **newest first**, capped at 20, because runs accumulate until deleted (§6.5) and
the interesting one is nearly always recent. Workflow items carry no `description` —
the name *is* the file (§14.6). A run's does the work that makes an opaque id
meaningful: workflow name, status, current step (§6.3). *(decision)*

14.6. **Candidate sources must be cheap and read-only.** The callback runs on a
keystroke, possibly while a run is executing, so neither listing path can be reused
as it stands:

  - **Workflow names come from filenames, never an import.** `discoverWorkflows`
    (§6.8) imports every candidate module through a fresh loader to read its declared
    name; per keystroke that recompiles the project's workflows and re-executes their
    module bodies. Completion instead lists the workflows directory and strips the
    `.workflow.ts` suffix — one `readdir`, no code executed, no cache to keep honest.
    This is the same convention `run` resolves against first (§6.8), so a completed
    name normally resolves in one import rather than a full scan. A file whose
    *declared* name differs from its filename is therefore not completable — it stays
    visible in `/workflow list` and runnable by name or path, and the convention it
    breaks is the one §6.8 already asks for. Trading it for a background catalog cache
    would buy declared names and descriptions at the price of executing project code
    on a keystroke path. *(decision)*
  - **Listing runs is a read.** `RunStore.list()` currently ensures the directory
    exists first; a keystroke in a project that has never run a workflow must not
    create the run-artifacts directory (§8.9). `list()` stops creating it and returns
    empty when it is absent. Because that listing parses every run's log, memoize for
    **one second** — enough that a burst of keystrokes costs one read, short enough
    that no invalidation hook is needed after a run starts, is cancelled, or is
    deleted. *(decision)*

14.7. **Locating the project without a context.** Workflow files are keyed by project
root (§6.8) and run logs by the harness's session directory (§8.9) — the callback has
neither (§14.2). The extension captures both from `session_start`, where `ctx.cwd` and
`ctx.sessionManager.getSessionDir()` are exactly what the command handler already uses
to build its store, re-captured on every start whatever the reason, with `process.cwd()`
and an empty session dir as the pre-first-start fallback. This copy exists for
completion only; handlers keep resolving from their own invocation's context, which
stays authoritative. *(decision)*

14.8. **Shape and testability.** The grammar, filtering, and value assembly live in one
**pure** module taking injected sources (`workflows()`, `runs()`) and returning items —
no filesystem, no store, no PI session, testable exactly like the engine (§13.1). The
extension wires the real sources, the memo, and the cwd capture. Tests cover: the
verb list and its filtering, the reserved `run list`, each verb's run-id status set,
whole-argument value assembly, silence on a second argument, and empty → `null`.
*(decision)*

14.9. **Rejected and out of scope.**

  - **A stacked autocomplete provider** (`ctx.ui.addAutocompleteProvider`) to make Tab
    on an empty argument work (§14.3). It means re-implementing PI's slash parsing and
    delegating file completion to fix one keystroke. *(rejected)*
  - **One command per verb** (`/workflow-run`, `/workflow-resume`, …) so the built-in
    command menu completes verbs: six top-level names for one feature, and it would
    still complete neither workflow names nor run-ids. *(rejected)*
  - **Path completion for `run <file>.ts`.** Tab already force-completes paths (§14.3);
    duplicating it here would fight the built-in provider. *(decision)*
  - **An argument hint** on the command row. pi-tui's slash-command model has
    `argumentHint`, and PI forwards it for built-ins and prompt templates, but
    `RegisteredCommand` has no such field — an extension cannot set one. The verbs are
    named in the command's own `description` instead, which does render. *(constraint)*
  - **Non-TUI modes.** Completion is an editor affordance; RPC and print modes have
    nothing to complete. *(decision)*

## Open items (TODO)

*None outstanding.* Remaining unknowns are implementation-level — the exact TypeBox
shape of the `{ result } | { questions }` union, the `.map()` context typing, and the
node-path encoding in the event log — not spec gaps.
