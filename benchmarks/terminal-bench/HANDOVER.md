# Handover — terminal-bench solver

State as of 2026-07-25, written so this can be picked up cold. Read `LESSONS.md` at the repo root first
if you want the *why*; this file is the *where things stand and what to do next*.

---

## 1. What exists

**In this repo (all committed on `spec-v2`):**

| Path | What |
| --- | --- |
| `benchmarks/terminal-bench/tb-solver.workflow.ts` | The workflow: `survey → (implement → verify)* → report` |
| `benchmarks/terminal-bench/contract.ts` | Schemas the steps exchange + shared prompt blocks |
| `benchmarks/terminal-bench/extension.ts` | PI extension: hooks `input`, runs the workflow, owns the deadline |
| `benchmarks/terminal-bench/README.md` | How to run it, and the measurements |
| `test/tb-solver.test.ts` | Structural tests (8), all scripted — no model needed |

**In `../kimchi-dev` (UNCOMMITTED — decide whether to commit):**

```
benchmark/terminal-bench-2/src/kimchi_agent/workflow_agent.py   (new) harbor agent
benchmark/terminal-bench-2/scripts/run-workflow.sh              (new) runner
benchmark/terminal-bench-2/src/kimchi_agent/__init__.py         (modified) exports KimchiWorkflow
```

**Engine features added this session** (all with tests, 409 passing): `optional` steps, `resumable`
isolated steps, output-protocol injection, `agent-usage` events, default repeat for unsteerable steps.
Plus three engine bug fixes (concurrency-ceiling deadlock, answer targeting, resume prefix).

---

## 2. How to run it

```bash
cd ~/dev/private/kimchi-dev/benchmark/terminal-bench-2
export KIMCHI_API_KEY=...                          # or from ../../.env
export KIMCHI_CODE_BINARY=/tmp/kstage/bin/kimchi   # staged linux binary, see below
export PI_WORKFLOWS_DIR=~/dev/private/pi-workflows
MODEL=kimchi-dev/kimi-k2.7 ./scripts/run-workflow.sh -k 1 -n 4        # full 89-task set
MODEL=kimchi-dev/kimi-k2.7 ./scripts/run-workflow.sh -i terminal-bench/fix-git   # one task
```

Staging a binary without a cross-build:
```bash
mkdir -p /tmp/kstage/bin /tmp/kstage/share
cp ~/.local/bin/kimchi /tmp/kstage/bin/kimchi
cp -a ~/.local/share/kimchi /tmp/kstage/share/kimchi
```

**Traps, each of which cost a run:**

- **Never set `TB_AGENT_TIMEOUT_SEC`.** The adapter reads each task's own `[agent] timeout_sec` from
  harbor's cache; the env var overrides it and pins every task to one number. It silently gave a 12000s
  task a 900s clock and invalidated a whole diagnostic run. Only set it with `--timeout-multiplier`.
- **Don't background with `nohup ... &`** inside a wrapper — a run died 60s in. Use `setsid` or tmux.
- **Watch the disk.** A full run needs ~120GB of images; at 95% full, trials die mid-write and leave
  zero-byte `result.json` files that look like model failures. `docker builder prune -f` is the safe
  reclaim (37GB last time); `docker images` sizes double-count shared layers, so deleting many tags of
  one repo frees far less than it appears.

Helper scripts (in `/tmp/e2e/`, **copy somewhere durable**): `run-arm.sh` (baseline vs workflow),
`progress.sh` (live), `analyze.py` (per-task reward/tokens), `postmortem.py` (failure breakdown).

---

## 3. Where the numbers stand

**Full 89-task run** (`jobs/2026-07-25__16-11-10`, kimi-k2.7, k=1, n=4): **0.432 mean, 35 solved**, 81
trials (8 never started, 9 errored, 1 zero-byte result). ~5h10m.

**Cost, robust across every run: ~20–25× fewer tokens than the stock single-session agent** (e.g. 602k
vs 14.5M over ten hard tasks). One long session re-sends its whole history each turn; a chain of short
isolated sessions doesn't. This is the one result to defend without more trials.

**Score is at or below the stock agent** on small matched sets (4/10 vs 6/10 on ten hard tasks; equal
4/4 on four easy ones). **Single runs cannot separate configurations** — the same config scored
`1,1,0,0` on one task across re-runs.

**Post-mortem of the full run — the finding that matters:**

| the workflow's own verdict | trials | actually solved |
| --- | --- | --- |
| "done" | 34 | 27 (**79%**) |
| "not done" | 44 | 8 (18%) |

Self-verification is well calibrated. The failure was **scheduling**: 44 runs stopped while their own
verifier still listed failures, and long tasks used a mean of 50% of their budget.

---

## 4. What is in flight right now

A diagnostic re-run of 10 tasks (`compile-compcert mailman caffe-cifar-10 constraints-scheduling
adaptive-rejection-sampler log-summary-date-ranges regex-chess write-compressor path-tracing
polyglot-rust-c`), started ~22:53, job dir `jobs/2026-07-25__22-53-58`.

It tests the four fixes in commits `6ebf0b3` and `f9b0752`. **Compare against the previous run of the
same subset** (`jobs/2026-07-25__22-16-58`), which gave:

| metric | previous | target |
| --- | --- | --- |
| budget used (mean) | 40–69%, four tasks idle 36–46% | higher, little idle |
| `survey` timeouts | **4 of 10** | ~0 |
| rounds | 1 for most tasks | 3–4 |
| reward | 2/7 finished | — (n=1, directional only) |

```bash
/tmp/e2e/progress.sh
python3 /tmp/e2e/postmortem.py ~/dev/private/kimchi-dev/benchmark/terminal-bench-2/jobs/2026-07-25__22-53-58
```

---

## 5. Next steps, in the order I would do them

1. **Read the in-flight run** against the table above. Judge it on *mechanism* (budget used, survey
   timeouts, round counts), not on reward — n=1 cannot settle reward.
2. **If survey still times out**, the remaining lever is making it cheaper rather than longer: cap the
   criteria count, or split recon from criteria-writing.
3. **Dynamic step budgets** (engine change, ~30 lines): let `maxDurationMs` take a function of run
   state, so a step can take a share of *remaining* time. This is the principled fix for the ragged
   tail — it sizes the final round to exactly what is left, removing both idle time and mid-write
   truncation. Discussed and deferred; do it as its own measurable change.
4. **Re-run the full 89** only when the mechanism looks right. ~5h at `-n 4`.
5. **Multiple trials** (`-k 3`) on a subset if you ever want to claim a score difference.
6. **Investigate the 8 tasks that never produced a trial** in the full run — unexplained.
7. **Decide about the kimchi-dev changes** — still uncommitted.

## 6. What NOT to change without evidence

- **The verifier.** It is calibrated (79%/82%); the losses are scheduling, not judgement.
- **The step structure.** Four structural iterations moved the score inside the noise band; the wins
  came from budget arithmetic.
- **Implementer self-checking.** Removing it (telling it to leave checking to the verifier) measured
  *worse* — 3/6 → 2/6 — and was reverted.
