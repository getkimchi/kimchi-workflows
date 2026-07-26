# Handover — terminal-bench solver

State as of 2026-07-26, written so this can be picked up cold **without re-deriving decisions already
made**. `LESSONS.md` at the repo root has the transferable engineering lessons; this file is the record
of what is settled, what was tried and rejected, and what is genuinely still open.

---

## 1. Settled facts — do not re-litigate these

**The framework is the product; the benchmark is a demonstration of it.** Terminal-bench is a poor
showcase (single coherent effort, one context window, graded on final state) — the regime where a
well-tuned agent loop is the right tool and decomposition can only add overhead. Do not tune workflow
constants to chase score; that is fitting noise.

**Baselines in this repo's `jobs/` are stale.** The stock-kimchi runs are 27 May – 1 June
(0.421–0.472, kimi-k2.6 / multi-model). The current kimchi-dev agent scores materially higher —
**~50–60% per the repo owner** — and that is the number to treat as the bar. Do not quote the old
`jobs/` numbers as a live comparison; they are two months of agent development out of date. The
`claude-code-*` jobs (0.528 / 0.472) are a **different harness and model** (Opus / Sonnet), not a
kimchi baseline.

**Latest full workflow run:** `jobs/2026-07-26__00-06-23` — **41/89 = 0.461**, 3 errored, 5h 44m,
10.75M tokens, `-k 1 -n 4`.

**The round-scheduling work did not move the score.** Paired over the 78 tasks scored in both full
runs: 35 → 36 (8 gained, 7 lost). The apparent 0.432 → 0.461 gain was **coverage** — 11 tasks that
previously produced no result at all, recovered by freeing disk. Cost rose 48% (7.25M → 10.75M) for
that flat score.

**n=1 cannot rank configurations.** Same config, same task, across re-runs: `1,1,0,0`. Judge changes on
mechanism (budget used, step timeouts, round counts) unless running `-k 3`+.

**Container OOM costs ~10% of trials and is environmental, not a framework bug.** `task.toml` sets
`memory_mb = 2048`; a workflow runs orchestrator *and* subagent inside it. Subagents are stable at
~230MB; the orchestrator ranges 200MB–1GB. Symptom: `exit code 137`, reward `0.0`, near-empty event
log. Ruled out as framework causes **by measurement**: engine state accumulation (7 steps, trivial) and
`pi.exec` stdout buffering (would need ~150MB of tool output; session was 204KB).

---

## 2. Decisions taken, with the reason

| Decision | Status | Why |
| --- | --- | --- |
| Dynamic `maxDurationMs` (function of run state) | **shipped** `ac0becb` | A constant forces equal rounds: small fragments the work, large overruns the deadline |
| `implement` takes a share of remaining time, not a flat 20% | **shipped** `ee98c0e` | 53 of 89 implementations were cut off mid-job by the flat box |
| Agent `output` schema optional — a step may **act, not report** | **shipped** `42f4633` | `implement`'s report was redundant, usually empty, and twice fatal (`/auto`, `/perm`) |
| Last round takes the whole remaining tail | **shipped** | A reserve held for a round that can never happen left 233 of 855s unspent |
| survey/verify caps from measured cost + floor | **shipped** | Pure percentages were wrong in both directions (25% too greedy; 8% below the median) |
| Re-run stock agent for a same-day baseline | **declined by owner** | Owner has current numbers; trust them rather than spend ~6h |

### Rejected — and why, so they are not retried

- **In-session "nudge" on invalid output for resumable steps.** Written, then dropped: making
  `implement` schema-free removes the failure entirely, leaving the capability with no consumer. The
  simpler fix beat the more clever one.
- **A `submit_result` tool for in-loop validation** (`ExtensionAPI.registerTool` does exist). Viable and
  strictly cheaper than out-of-loop retries, but needs `-e` passed to subagents plus a recursion guard —
  and is moot now that acting steps need no validation at all.
- **`BUN_JSC_forceRAMSize`** to curb orchestrator memory. Accepted by the binary but **could not be
  shown to change GC behaviour** (38MB peak either way in a controlled test). Not shipped on a hunch.
- **Rewriting the `pi.exec` spawn path to stream.** Started, then abandoned: measurement ruled out
  buffering as the OOM cause. The unbounded buffer is still real and worth fixing *on its own merits*,
  as its own change with its own evidence — not as an OOM fix.
- **Raising `memory_mb`** to dodge the OOM. Rejected: the stock agent lives within 2048MB, so changing
  it makes the comparison dishonest.

---

## 3. Current configuration (after `42f4633`)

```
survey → ( implement → verify )* → report
```

- `survey` — `min(max(15% , 150s), 240s)`, `optional`, no repeat. Observed cost 16–231s.
- `implement` — **half of the time remaining**, floored at 90s; the *last* round instead takes the whole
  tail (`remaining − verify − 60s margin`). `optional`, `resumable`, **no output schema**.
- `verify` — `min(max(12%, 120s), 300s)`, `optional`. Observed cost 12–180s. Keeps its schema — its
  verdict is consumed.
- Stop rule: stop when `remaining − verify − margin < 90s` floor, or round ≥ 15 (safety valve).

Simulated utilisation: every task budget lands on exactly the 60s margin — 750s→1 round (89% used),
900s→1 (91%), 1800s→2 (96%), 12000s→4 (99%).

**Criteria are labelled a reconnaissance checklist, not the specification** — a survey written in under
two minutes must not be able to redefine the task away from the hidden tests.

---

## 4. How to run it

```bash
cd ~/dev/private/kimchi-dev/benchmark/terminal-bench-2
set -a; . ~/dev/private/kimchi-dev/.env; set +a
unset TB_AGENT_TIMEOUT_SEC                          # see traps
export KIMCHI_CODE_BINARY=/tmp/kstage/bin/kimchi
export PI_WORKFLOWS_DIR=~/dev/private/pi-workflows
MODEL=kimchi-dev/kimi-k2.7 ./scripts/run-workflow.sh -k 1 -n 4      # full 89
```

Stage a linux binary without cross-building:
`mkdir -p /tmp/kstage/bin /tmp/kstage/share && cp ~/.local/bin/kimchi /tmp/kstage/bin/ && cp -a ~/.local/share/kimchi /tmp/kstage/share/`

**Traps, each of which cost a run:**

- **Never set `TB_AGENT_TIMEOUT_SEC`.** The adapter reads each task's own `[agent] timeout_sec`; the env
  var pins every task to one number and silently gave a 12000s task a 900s clock. Verify per-task
  variation after launch: `pgrep -af "kimchi --print" | grep -oE "TB_AGENT_TIMEOUT_SEC=[0-9]+"`.
- **Don't background with `nohup … &`** — a run died 60s in. Use `setsid`.
- **Watch the disk.** ~120GB of images; at 95% full trials die mid-write leaving zero-byte
  `result.json` that look like model failures. Task images are `alexgshaw/*` (~83GB) — never delete
  those. Build cache and non-benchmark images are the safe reclaim.
- **Don't write a watcher whose own command line contains its `pgrep` pattern.** Both of mine matched
  themselves and looped forever. Poll for the *artifact* (`jobs/<id>/result.json`), not the process.

Helpers live in `/tmp/e2e/` (**not durable**): `progress.sh`, `postmortem.py`, `steps.py`, `analyze.py`.

---

## 5. Genuinely open

1. **Does the current config beat the stock agent?** Unknown and unmeasured. The last validation was
   3/6 — identical to the old config on the same 6 tasks — but ran with survey timing out in 4 of 6,
   so it does not measure the current build. **Re-run those 6 first**: `polyglot-rust-c`,
   `log-summary-date-ranges`, `write-compressor`, `adaptive-rejection-sampler`, `mailman`,
   `path-tracing`.
2. **Reason-aware retry.** The engine records *why* an attempt failed (`invalid-output` vs
   `budget-exceeded`) but the retry policy cannot discriminate — so "retry a malformed reply, never
   retry a timeout" is inexpressible. Less urgent now that acting steps cannot produce invalid output.
3. **The unbounded `pi.exec` stdout buffer** — real, latent, not the OOM cause.
4. **kimchi-dev adapter files are still uncommitted** in that repo (`workflow_agent.py`,
   `run-workflow.sh`, `__init__.py`).

## 6. Do not change without evidence

- **The verifier.** Calibrated at 79% precision on "done", 82% on "not done". The losses were
  scheduling, not judgement.
- **The step structure.** Four structural iterations all landed inside the noise band.
- **Implementer self-checking.** Removing it measured *worse* (3/6 → 2/6) and was reverted.
