# terminal-bench solver

A terminal-bench agent built as a workflow instead of one long agent loop.

```
survey ──▶ ( implement ──▶ verify )*  ──▶ report
```

Every step is an isolated subagent (`background: true`), which in the PI host means a fresh subprocess
of **the harness binary that is actually running**. Nothing is compiled into a separate agent binary:
`extension.ts` hooks pi's `input` event, swallows the piped instruction (`action: "handled"`, so the
orchestrating session never starts an LLM turn of its own) and hands it to the engine.

| File | What it is |
| --- | --- |
| `tb-solver.workflow.ts` | The workflow: which step runs when, and what it may cost |
| `contract.ts` | The schemas the steps exchange and the prompt blocks they share |
| `extension.ts` | The PI extension that turns an instruction into a run, and owns the deadline |

## Running it

The harbor adapter lives in the kimchi-dev checkout
(`benchmark/terminal-bench-2/src/kimchi_agent/workflow_agent.py`):

```bash
cd ../kimchi-dev/benchmark/terminal-bench-2
export KIMCHI_API_KEY=...
MODEL=kimchi-dev/kimi-k2.7 ./scripts/run-workflow.sh -i terminal-bench/fix-git
```

The script builds the bundle (`bun build extension.ts --target=node --format=esm`), uploads it beside
the binary, and launches the ordinary agent command plus one flag: `-e <bundle>`. Set
`TB_AGENT_TIMEOUT_SEC` to the dataset's `[agent] timeout_sec` — every per-step cap is a fraction of it.

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
