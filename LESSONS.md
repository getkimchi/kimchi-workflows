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

### Don't retry what a repeat cannot fix

Wall-time overrun is not a transient failure: the work was too big for the box, and nothing about that
changes on a second attempt. Two runs lost 216s and 270s of an 855s budget to retries that timed out
identically. Retry classification should follow the *cause*, not the failure count.

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
  were still up and briefly believed two tasks had errored.
