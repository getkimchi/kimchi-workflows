# terminal-bench solvers

Two terminal-bench agents, each built as a workflow instead of one long agent loop, behind one
extension. `TB_WORKFLOW` picks which one a run uses.

```
solver (default)   survey ──▶ ( implement ──▶ verify ──▶ audit? )*  ──▶ report
ferment            plan ──▶ ( phase ──▶ ( step turn ──▶ gates ──▶ verify )* ──▶ gates )* ──▶ ship
```

Every step is an isolated subagent (`background: true`), which in the PI host means a fresh subprocess
of **the harness binary that is actually running**. Nothing is compiled into a separate agent binary:
`extension.ts` hooks pi's `input` event, swallows the piped instruction (`action: "handled"`, so the
orchestrating session never starts an LLM turn of its own) and hands it to the engine.

| File | What it is |
| --- | --- |
| `tb-solver.workflow.ts` | The default solver: which step runs when, and what it may cost |
| `contract.ts` | The schemas its steps exchange and the prompt blocks they share |
| `prompts.ts` | What each of its steps is told (read `FAILURE-MODES.md` before rewording) |
| `ferment/` | kimchi's one-shot ferment, ported (see below) |
| `extension.ts` | The PI extension that turns an instruction into a run, owns the deadline, and picks the workflow |

## Running it

The harbor adapter lives in the kimchi-dev checkout
(`benchmark/terminal-bench-2/src/kimchi_agent/workflow_agent.py`):

```bash
cd ../kimchi-dev/benchmark/terminal-bench-2
export KIMCHI_API_KEY=...
MODEL=kimchi-dev/kimi-k2.7 ./scripts/run-workflow.sh -i terminal-bench/fix-git

# the ferment solver instead — agent env reaches the container, so `--ae` is all it takes
MODEL=kimchi-dev/kimi-k2.7 ./scripts/run-workflow.sh -i terminal-bench/fix-git --ae TB_WORKFLOW=ferment
```

The script builds the bundle (`bun build extension.ts --target=node --format=esm`), uploads it beside
the binary, and launches the ordinary agent command plus one flag: `-e <bundle>`. Set
`TB_AGENT_TIMEOUT_SEC` to the dataset's `[agent] timeout_sec` — every per-step cap is a fraction of it.

## The ferment solver (`ferment/`)

`ferment/ferment-oneshot.workflow.ts` is not a second design — it is **kimchi's `--ferment-oneshot`
mode, rendered 1:1 as a workflow**: the same five-step planning process, the same P/S/F/C gate
registry, the same budget tiers, the same judge standing in for the user, the same verification
triage. It exists so that "workflow engine vs. one long session" can be measured without also changing
the instructions, which is the one thing a comparison against `tb-solver` cannot tell you.

What is deliberately *not* ported is the ferment's continuation machinery — the stop nudges, the
"call `start_ferment_step` now" scheduler messages, the scoping-progress counter, the "Turn discipline"
section. All of it exists to make a single session behave like a state machine; here the engine is the
state machine, so there is no turn to nudge. `ferment/prompts.ts` documents, per prompt, which kimchi
file it came from and what was dropped.

| File | What it is |
| --- | --- |
| `ferment/ferment-oneshot.workflow.ts` | The lifecycle: scoping loop, phase/step fan-out, the step retry and the phase-grader loop |
| `ferment/contract.ts` | kimchi's tool parameters as output schemas, plus the gate registry, budget tiers and grade bar |
| `ferment/prompts.ts` | The ported prompts, with provenance |
| `ferment/verify.ts` | Runs a step's verify command (`bash -lc`, 60s) and gathers the phase diff the grader is shown |

**A step is one agent turn, and no worker is ever dispatched.** kimchi's `start_ferment_step` offers both
branches — "Either spawn a subagent … or execute the step directly using bash/edit/write. … If you
executed directly, call `complete_ferment_step` with just the summary and gates (`worker_agent_id` is
optional)" — and one-shot ferment takes the second one every time: across six live native runs all 31
`complete_ferment_step` calls omit `worker_agent_id`, and the orchestrator session itself spends 108
`bash`, 16 `write` and 13 `edit` calls with **zero** agent spawns. So `step-turn` does the work with its
tools and then answers S1/S2/S3 about that work, which is what makes the gate registry's second person
literal: "Read **your own** summary" is addressed to the agent that wrote it because it did the work.

Two refusals, and conflating them is the most expensive mistake this port has made. A flagged **S gate**
refuses one *completion*: nothing is recorded, the verification never runs ("Gate validation runs BEFORE
any state mutation"), and the same session is re-entered holding kimchi's refusal text — where it may fix
what it flagged and answer again ("they just refuse this single call, and the agent has to fix the
underlying issue and re-call", `tools/steps.ts:427`). A verification the triage judge calls real sends the
*step* back into that same session with the command's output. A phase that clears its **F gates** then has
to clear the **grader** — an independent A–F verdict where A/B advance and C/D/F refuse, buy a rework
against the grader's recommendations, and try again (up to `MAX_BLOCK_RETRIES = 3`, after which the grade
is accepted and the phase advances anyway). The grade is not a report: in kimchi it drives control flow.

`plan`, `step-turn`, `phase-gates` and `ship` share one resume key, which is load-bearing rather than an
optimisation: in kimchi they are turns of the *same session*, which is why C1 can walk a checklist
"declared at scope time" and why a refusal can be handed straight back to the agent that has to resolve
it. The three independent judges (`judge`, `verify-judge`, `phase-grade`) stay cold, because kimchi
really does spawn those separately.

**Nothing here is sized from what is left.** No per-stage share, no round caps, no reading of the clock,
no telling a model how much of the run it may have. An earlier version *did* divide the budget across
stages and it corrupted the experiment: boxes computed from what earlier stages had spent left
`phase-gates` 307ms and `ship` a negative box, so the two closing gate turns never ran.

**A step turn carries no wall clock at all**, and that is the deliberate cost of the merge: kimchi bounds
this turn with nothing but the run deadline, because the work and the completion are tool calls inside a
session its harness owns. There is no second process to box once the orchestrator does the work, so a step
turn that runs away spends the *run's* clock and the phases behind it get less — the same exposure kimchi
carries. The only deadline is still the run-level abort `extension.ts` performs for both solvers, and the
only constant box left is kimchi's `standard` tier on `phase-rework`, the one turn still handed to an
agent of its own.

Three pieces of machinery went with the worker, each an honest repair to a shape kimchi does not have,
all measured on one 6-task run (135 agent turns and 149.5 min, against native kimchi's ~128 turns and
36.1 min):

- **The worker's tier box, its "STOP WORKING AT *N*s" landing instruction, and the kill-and-escalate
  ladder.** All three existed because a dispatched subagent killed at its cap returns *nothing* — 46.0 min
  of that run, 6 of 11 workers on a single task. Nothing is dispatched, so nothing can be killed.
- **The 180s box on the gate turn**, added because a turn that is a tool call in kimchi had become a
  subagent here and one ran 1472s against a p75 of 57s. There is no separate gate turn any more.
- **The step-diff block** pasted into the gate prompt, which cut 92.4 min of gate turns down toward the
  23 min they would have cost at each task's fastest. Its reader had not seen the work; this one made the
  edits itself. What it gets instead is what kimchi actually gives its orchestrator — the step's start
  ref (`stepStartRefs`, "consumed at complete_ferment_step for diff evidence", surfaced as a SHA in
  `derive-state.ts`), so `git diff <ref>` is one command. kimchi assembles a step diff for nobody.

The remaining differences are forced by the medium, and the workflow's header records each one: phases
and steps run sequentially (concurrent `.foreach` items must have non-overlapping side effects, which two
agents editing one container cannot promise); `budget_tier` is chosen at plan time rather than at
dispatch, since the dispatch turn is the orchestration the engine replaces, and it reaches the prompt as
*advice* exactly as kimchi's `limitsHint` does on the branch where no Agent is spawned; gate payloads are
output schemas instead of tool arguments; and each agent step is `optional`, the engine's equivalent of a
tool error the session survives. One judgment call is left: kimchi bounds a step's re-entries not at all,
because its orchestrator eventually resolves the step with a planner turn that does not exist here, so
`STEP_MAX_ATTEMPTS` borrows `MAX_BLOCK_RETRIES` — the only retry budget kimchi actually defines — rather
than inventing a number.

## Why this shape

The dominant terminal-bench failure is not "couldn't work it out", it is stopping while something is
still broken. So `survey` emits **acceptance criteria with the shell command that checks each one**, and
`verify` is a *fresh* agent that receives the criteria and the task but never the implementer's account
of its own work — it has to go and look. The loop turns a failed check back into work.

Everything else in the design came from measurement, not taste:

- **Per-step caps are fractions of the run budget.** An `implement` capped at 900s inside an 855s run can
  never fire; two tasks the baseline solved were lost to a step that ran until the harness killed the
  run mid-edit.
- **Workers are `optional`.** Being time-boxed out costs the round, not the run: the work already on
  disk stays, `verify` still says what is true, and the next round repairs it.
- **`implement` is `resumable`.** It is the step most likely to be cut off, and a cold restart made it
  re-derive what the last round already knew.
- **`survey` does not repeat.** A step that blew its *wall-time* budget will blow it again; two runs lost
  216s and 270s of 855s to exactly that.

## What it measures (kimi-k2.7, single trials)

| Set | Baseline (stock agent) | This workflow |
| --- | --- | --- |
| 4 easy tasks | 4/4 — 2.17M tokens | 4/4 — 326k |
| 6 medium/hard | 4/6 — 9.51M | 3/6 — 192k |
| 4 held-out | 2/4 — 5.02M | 1/4 → 3/4 across configs — ~175–276k |
| 10 harder, final config | 6/10 — 14.5M | 4/10 — 602k |

**The cost result is robust and large: ~20–25× fewer tokens, on every run.** One long session re-sends
its whole accumulated history every turn (one task alone burned 5.6M tokens looping to its timeout); a
chain of short isolated sessions each pays for a small context and exits.

**The score result is not a win, and single runs cannot settle it.** Re-running the *same* config over
the same tasks produced 1,1,0,0 on one task and 1,1,1,0 on another. Treat every score column above as
one sample. The consistent qualitative signature: this workflow wins tasks the baseline abandons early
and loses tasks needing long sustained work, because time-boxed steps fragment continuous effort.

### If you take this further

1. **Multiple trials** (`-k 3` or more) — nothing here separates a real gain from run-to-run noise.
2. **Lower parallelism.** These runs used `-n 4..6` on one machine; the workflow spawns a subprocess per
   step, so contention penalises it more than the baseline on wall-clock-bounded tasks.
3. **Longer budgets.** The fragmentation losses all sit on tasks whose work exceeds one time box.
