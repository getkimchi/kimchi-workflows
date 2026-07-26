# Lessons

Written after an adversarial review of this engine and a day of driving it against real terminal-bench
tasks (kimchi-dev harness, `kimchi-dev/kimi-k2.7`). Everything here is something that cost time to
learn or that contradicted what I expected going in. Evidence is quoted where it exists, including the
places I was wrong.

---

## Engine design

### A resource ceiling belongs to the thing that can't wait on itself

The run-wide concurrency slot used to be held by the enclosing construct. That deadlocks the moment
constructs nest: a `.foreach` at the ceiling occupied every slot while each of its items waited for a
slot of its own. The run hung forever — no timeout, project lock held. The log signature was stark:

```
4 foreach items started, 0 steps ever started, 0 completed
```

The slot now belongs to the **step**, which is a leaf and never waits on another holder. The general
rule: hold a bounded resource at the level where acquisition cannot recurse. If a holder can, directly
or transitively, wait for the same resource, the bound is a deadlock waiting for the right shape of
input.

Spec wording helped find it — §3.6 says "steps executing at once", and the implementation was counting
constructs. When code and spec disagree about *what* is counted, that gap is usually a bug.

### Deliver the answer to the question that was asked

With several steps blocked at once, the attended loop resumed with no path and let the engine's FIFO
default pick the target. After a re-block those diverge — the re-asked step is the *most recently*
asked while a sibling is still the earliest. Live consequence:

```
user is shown askA "How many widgets?", types 12
log records:   answers-provided → par/askB     ("Name the batch")
```

Whenever a UI renders one of several pending items, the action must carry the identity of what was
rendered. A "sensible default" computed at action time is a different question than the one on screen.

### String-prefixing a structured key is a silent-corruption bug

Resume filtered recorded outputs with `key.split("/")[0]`, which never matches an indexed segment
(`each@0/inner` vs the node name `each`). Every inner output of a completed foreach was dropped, a
later step read `undefined` where a fresh run read a value — **and the run still completed**. Silent
wrong answers are worse than crashes. Parse structured keys with the parser you already have.

### Guards that fail loudly earn their keep

`getStepResult` throws when a step reads a value that is currently in flight, rather than returning
`undefined`. That guard caught a genuine bug in *my own* workflow: `implement`'s prompt tried to read
`implement`'s own previous output while it was executing. A tolerant `undefined` would have shipped a
workflow that silently forgot its own history. The fix was to carry the value through a step that had
already settled.

### If the framework enforces a contract, the framework should state it

Agent replies are parsed and validated against the step's output schema whether or not the author
described that schema in the prompt. So the first live run crashed with:

```
step "orient" output: <root>: must have required properties summary, keyPaths, howToRun, risks
```

— because my prompt said "matching the schema you were given" and nothing had given it one. The engine
already injected a protocol for `asks` steps and for steering corrections; it now does so for every
agent step. **An unstated expectation is a bug in the framework, not the caller** — especially for a
step that cannot be steered, where one bad reply is the whole attempt.

### Observability has to live where the work happens

An isolated step is its own subprocess, so everything outside the engine — session files, harness
accounting, the trial's own token counters — sees roughly zero for the entire run. Per-turn
`agent-usage` events were the only way to measure cost at all, and every number in this document comes
from them. When work moves out of process, telemetry must move with it or it disappears.

### Defaults should mirror what the thing can actually do

A steerable step gets two free in-session repairs. An isolated one gets none — and used to die on a
single malformed reply. Making unsteerable steps default to one repeat restores the symmetry: the
budget matches the capability. Look for defaults that were written for one execution mode and silently
inherited by another.

### Two primitives that only became obvious under time pressure

- **`optional`** — a step whose final failure the run survives. Without it, a worker that overran its
  budget took the whole run down mid-edit: no verification, no repair round, container graded in
  whatever state the edit stopped at.
- **`resumable`** — an isolated step that keeps its conversation across executions. Without it, a
  time-boxed worker restarted cold every round and re-derived what the last one already knew.

Neither was visible from the spec or from unit tests. Both came from watching real runs fail.

---

## Cost structure of agent workflows

### The biggest surprise: a chain of short sessions is far cheaper than one long one

I expected the workflow to cost *more* (5 subagents vs 1 session). Measured over four tasks at equal
score: **384k tokens vs 2.17M**. Over ten harder tasks: **602k vs 14.5M**. One task alone
(`chess-best-move`) burned 5.6M tokens looping until its timeout.

The mechanism is not subtle once seen: a single session re-sends its entire accumulated history on
every turn, so cost grows with the square of the work. A chain of short isolated sessions each pays for
one small context and exits. This held on **every run**, across three workflow revisions — it is the
one result here I'd defend without more trials.

The corollary is a real trade-off, not a free lunch: fresh contexts are cheap *because* they forget,
and forgetting is what fragments long work.

### Time boxes must be fractions of the clock that actually governs

I gave `implement` a 900s cap inside an 855s run. It could never fire, so a single step ran until the
harness killed the run mid-edit — twice, on tasks the baseline solved. Any per-unit budget expressed in
absolute units against a total the code doesn't read is decoration. Derive it, or don't claim it.

### A constant calibrated at one scale is a bug at every other scale

The sharper version of the lesson above, and it cost a whole benchmark run to learn properly. Two
constants were tuned where the budget was always 900s:

```
MAX_ROUNDS = 3                       // three rounds IS a 900s budget
implement  = min(45% of budget, 420s)  // the ceiling never binds at 900s
```

Across the full 89-task set, budgets run from 750s to 12000s, and both invert. A 12000s task got the
same seven-minute implementation window as a 900s one, then `MAX_ROUNDS` ended the run:

```
build-pov-ray     stopped holding 11170s of 12000s  (7% used)
compile-compcert  stopped holding  1861s of  2400s
circuit-fibsqrt   used 4% of its budget
```

Long tasks spent a mean of **50%** of their allowance. The tell was not the score — it was that the
*ratio of budget used to budget available* varied wildly by task size. Any constant that encodes "how
much" should be derived from the quantity it is bounding, and if it can't be, its calibration range
belongs in a comment next to it.

### Measure the round you had, don't predict the round you'll get

Replacing the fixed count with "stop when another round wouldn't fit" raises the question: how big is a
round? Computing it from the step caps is wrong — caps are worst-case, and a real round routinely costs
a fraction of them, so a cap-based estimate refuses rounds there is ample time for. Measuring what the
round just cost (`remaining at open − remaining at close`) is both simpler and honest.

### A safety valve must fail gracefully, or it is just a different crash

Removing the round cap surfaced a case the clock cannot catch: rounds so cheap they consume no budget
(every attempt failing in seconds) loop forever. The loop's own `maxIterations` guard *would* have
caught it — by crashing the run and skipping the final report, losing the cleanup and the summary. So
the valve has to live in the normal stop condition, not in the guard. The guard's job is to be the thing
that never fires.

### Don't retry what a repeat cannot fix

Wall-time overrun is not a transient failure: the work was too big for the box, and nothing about that
changes on a second attempt. Two runs lost 216s and 270s of an 855s budget to retries that timed out
identically. Retry classification should follow the *cause*, not the failure count.

### Self-verification worked — and I nearly discarded it on principle

The received wisdom is that a model checking its own work is worthless. Over 78 real trials, the
verifier was **well calibrated**:

| its verdict | trials | actually solved |
| --- | --- | --- |
| "done" | 34 | 27 (**79%**) |
| "not done" | 44 | 8 (18%) |

Seven false positives out of thirty-four. What makes the difference is not the model's judgement but the
form of the question: the verifier is given *executable* criteria, runs them, and never sees the
implementer's account of its own work. Asked to produce command output rather than an opinion, it is
mostly right.

That table also reframed the whole investigation. The failure was not bad judgement — it was that
**44 runs stopped while their own verifier was still reporting failures**, most with budget left. Which
is a scheduling bug, not a reasoning one, and I would have gone looking in the wrong place without
splitting the trials by what the workflow *believed* about itself.

### Verification only counts if it executes, and if it's independent

"Review your work" is an opinion pass — the model re-reads its own reasoning and agrees with itself.
What works is a planner that emits **acceptance criteria with the shell command that checks each one**,
and a verifier with **fresh context** that receives the criteria and the task but never the
implementer's account of its own work. It has to go and look. That verifier caught, for example, a CSV
written with CRLF line endings that the implementer believed was correct.

A corollary discovered by breaking it: making the implementer skip its own checks (leaving all
verification to the verifier) scored *worse*. Self-checking catches mistakes while the context to fix
them is still live. Both layers earn their place.

### Say what is graded, not how much it matters

I deliberately did not write "this is a benchmark and passing is critical". Naming the benchmark and
raising the stakes invites test-hunting and hardcoded outputs, and the tests aren't even in the
container during the agent phase — so those attempts burn the clock and then fail. What went in
instead: what is graded (the final state of the machine, by tests you will not see), what must persist
(nothing may depend on shell session state), and how long there is.

### A step that thinks must be told it does not act

The planner solved a `fix-git` task itself; the implementer then reported "no changes needed". The run
passed — **by accident** — with the division of labour that makes verification meaningful quietly
collapsed. Any step whose value is analysis needs an explicit "you are not doing the work here", or it
will do the work.

---

## Measurement discipline

### Diagnose the mechanism, not the score

0.432 says nothing about what to fix. What identified the cause, in one pass over the run's own event
logs, was a handful of derived quantities: percentage of budget consumed, what the workflow believed at
the end, which step failed, and what stopped the loop. Score is the thing you optimise; mechanism is the
thing you can act on, and at n=1 it is also the only one that is reliable.

### n=1 is not a measurement

Same configuration, same tasks, same model, different runs:

```
cancel-async-tasks:  1, 1, 0, 0
kv-store-grpc:       1, 1, 1, 0
build-cython-ext:    0, 0, 0, 1
```

I made four structural changes and read the score after each. Only afterwards did the re-runs reveal
that the differences between variants were inside the noise. Anything conclusion-shaped needs repeated
trials (`-k 3`+); single runs are for finding *mechanisms* in the logs, not for ranking configurations.

### An improvement can be a regression — re-measure, then revert on evidence

The v5 change (stop duplicating verification work) was well-reasoned, cheap, and made things worse:
3/6 → 2/6, losing the one task the workflow reliably won. Reverted. Reasoning about a change is not
evidence about a change.

### Reproduce the "before" state, or the fix is a story

For each bug I re-ran the failing scenario against the pre-fix code: the deadlock hung for 90s with
zero output; the mis-delivered answer landed on `par/askB`; the resume returned `-1,-1` instead of
`10,20`. Cheap to do, and it converts "I fixed it" into "here is what it did, and here is what it does
now".

### Verify each commit, not just the final tree

I split work into focused commits by slicing diff hunks, misidentified which hunk removed a function
parameter, and produced **four commits that didn't typecheck** — while the final tree was green. Now:
check out every commit, typecheck, run the suite. Changes that must move together (a signature and its
call sites) cannot be separated for narrative tidiness.

### Only demand structured output from a step whose output is consumed

`implement` was required to return `{changes, ranChecks, incomplete}`. Nothing needed it:

- **Redundant.** The step is `resumable`, so the next round reopens the same session and already holds
  everything it read, ran and learned — strictly more than a three-field summary.
- **Usually absent.** A round that spends its whole time box produces no output at all, so the field was
  `""` in nearly every checkpoint of every run.
- **Yet fatal.** Two implementations replied `/auto` and `/perm` instead of JSON. The schema check
  failed the step, and the round was discarded — with its edits already on disk. 374s lost to the shape
  of a message nobody read.

The fix was to delete the requirement, not to harden it. `output` is now optional on agent steps: with
no schema, no contract is injected, nothing is parsed, and the raw text is the output. A step that
changes the world and is judged by looking at the world should not also have to describe itself.

The general rule: **a validated contract is a liability wherever it is not a dependency.** Before
requiring a step to report, find the code that reads the report. If the answer is "the next prompt,
loosely" — and especially if some other mechanism already carries the same information — the contract is
buying nothing and can only cost. The near-miss here is instructive: the first two fixes considered were
retrying the step and nudging it in-session, both of which would have added machinery to protect a field
that should not have existed.

### Rule a cause out by measuring it, not by finding it plausible

A container was OOM-killed at its 2GB cgroup limit, and the orchestrator process — the one that runs no
LLM turns at all — held 1GB of it. Two framework explanations fit the shape of the evidence perfectly:

- **The engine accumulates run state.** Ruled out: the run had completed 7 steps and 2 agent turns. Step
  outputs are small JSON; there was nothing there to hold.
- **`pi.exec` buffers the whole subagent stdout** (it does — the entire NDJSON event stream, parsed in
  one pass, to extract only the final assistant message). Ruled out by measuring the actual ratio: a
  400KB tool output produces 735KB of stdout, so reaching 683MB needs ~150MB of tool output, and the
  task's whole session file was 204KB.

I had started rewriting the spawn path on the second theory before measuring it. Both theories were
mechanically sound and both were wrong; the cause is the host runtime's own heap behaviour in a cgroup
it can't see (Bun/JSC sizes its heap from *host* RAM, 31GB, while confined to 2GB). The general point:
"this could produce the symptom" is a hypothesis, and the cheap measurement that discriminates between
hypotheses is almost always available. An unbounded buffer is still worth fixing on its own merits —
but as its own change, with its own evidence, not smuggled in as a fix for something it didn't cause.

### Green offline suites hide exactly the bugs that matter

The fake agent bridge doesn't model the harness's one-turn-in-flight limit; the offline suite doesn't
model a container, a clock, or a real model's verbosity. Every serious bug in this pass — the missing
output contract, the unfirable time box, the fragmenting restarts — was invisible offline and obvious
within one live run.

---

## Operational notes

- **`nohup` + a backgrounded tool call silently killed a 4-task run ~60s in.** Symptom: rewards came
  back `None` and the logs stopped after the first step. Long harness runs stay in the foreground.
- **Scratch state must never land in the graded directory.** Resumable steps write a session file; its
  default location is the working directory, which for a benchmark *is the artifact under test*. It's
  now pointed at the trial's log directory.
- **Parallelism distorts wall-clock-bounded benchmarks.** These runs used `-n 4..6` on one machine; a
  workflow that spawns a subprocess per step is penalised by contention far more than a single-session
  agent, and several tasks that finished comfortably alone ran to their deadline under load.
- **Check the run actually finished before reading results.** I analysed a job while three containers
  were still up and briefly believed two tasks had errored. Later I made the opposite error and
  announced a completed run was "dead" because no processes remained — the job-level `result.json`
  existed the whole time. Check for the artifact, not for the process.
- **A full run exposes infrastructure, not just the agent.** Of 89 tasks: 8 never produced a trial, 9
  errored, and one wrote a zero-byte `result.json` — the signature of a process dying mid-write while
  the disk sat at 95%. Any of those can masquerade as model failure. Before reading a benchmark result,
  reconcile the trial count against the task count and check `df`.
- **A subprocess-per-step workflow pays a memory tax the single-session agent doesn't.** Task containers
  cap at `memory_mb = 2048` (`task.toml`); a workflow runs orchestrator *and* subagent inside that one
  limit. Measured steady state: subagents are stable at ~230MB, the orchestrator ranges 200MB–1GB, and
  when the pair crosses 2GB the kernel kills it — `exit code 137`, which surfaces as a bare `0.0` reward
  with a near-empty event log. This is environmental, not a framework defect (see the "rule a cause out"
  entry above), and it cost ~10% of trials in both full runs. Check `dmesg` for
  `constraint=CONSTRAINT_MEMCG` before blaming the model for a task that produced almost no events.
- **Docker image sizes double-count shared layers.** Deleting 18 `arctus-backend` tags that `docker
  images` listed at ~1.04GB each reclaimed ~1.1GB total, not ~18GB: they shared nearly every layer. The
  build cache — invisible in `docker images` — was the real consumer at 37GB.
