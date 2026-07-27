# terminal-bench solvers

Two terminal-bench agents, each built as a workflow instead of one long agent loop, behind one
extension. `TB_WORKFLOW` picks which one a run uses.

```
solver (default)   survey ──▶ ( implement ──▶ verify ──▶ audit? )*  ──▶ report
ferment            plan ──▶ ( phase ──▶ ( worker ──▶ gates ──▶ verify )* ──▶ gates )* ──▶ ship
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
registry, the same worker budget tiers, the same judge standing in for the user, the same verification
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
| `ferment/verify.ts` | Runs a step's verify command (`bash -lc`, 60s) and builds the phase diff the grader is shown |

Two refusals, not one, and they are easy to conflate. A flagged **S gate** or a failed verification sends
the *step* back to its worker for one bounded continuation. A phase that clears its **F gates** then has
to clear the **grader** — an independent A–F verdict where A/B advance and C/D/F refuse, buy a rework
against the grader's recommendations, and try again (up to `MAX_BLOCK_RETRIES = 3`, after which the grade
is accepted and the phase advances anyway). The grade is not a report: in kimchi it drives control flow.

**There is no scheduling policy of its own** — no per-stage time boxes, no round caps, no budget talk in
the prompts. A ferment runs until the work is done, so this does too; the only per-step budget is
kimchi's own worker tier (`max_duration` 180/300/600s), and the only deadline is the run-level abort
`extension.ts` already performs for both solvers. An earlier version *did* divide the budget across
stages and it corrupted the experiment: boxes computed from what earlier stages had spent left
`phase-gates` 307ms and `ship` a negative box, so the two closing gate turns never ran.

The remaining differences are forced by the medium, and the workflow's header records each one: phases
and steps run sequentially (concurrent `.foreach` items must have non-overlapping side effects, which two
agents editing one container cannot promise); `budget_tier` is chosen at plan time rather than at
dispatch, since the dispatch turn is the orchestration the engine replaces; gate payloads are output
schemas instead of tool arguments; and each agent step is `optional`, the engine's equivalent of a tool
error the session survives. One judgment call is left: a step that a gate flags gets **one** bounded
continuation (`STEP_MAX_ATTEMPTS`), because kimchi resolves that case with a planner turn that does not
exist here — its own rule is "a bounded direct continuation … do not raise the limits and retry the same
broad task".

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
