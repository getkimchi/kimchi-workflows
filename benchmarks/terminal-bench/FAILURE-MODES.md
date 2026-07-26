# Observed failure modes

Unwanted behaviours seen in live runs, what caused them, and what was done. Each entry is something that
cost real budget and would otherwise be rediscovered from scratch. **Add to this file rather than
re-deriving.** Counts come from the full 89-task run (`jobs/2026-07-26__00-06-23`) unless stated.

---

## F1. The verifier confirms a spec that was never right — "correlated error"

**Seen:** `log-summary-date-ranges`, `jobs/2026-07-26__10-52-17`. Survey finished comfortably (99s of a
150s box), wrote five detailed criteria including a full independent recount in Python, two rounds ran,
`verify` returned `allPass: true`, run completed with 360s to spare. **Reward 0.0.**

**Cause — not time, and not diligence.** Survey, implement and verify all read the same task statement
and formed the same interpretation. `verify` then confirms that interpretation by running survey's own
commands. Three agents agreeing with each other is not independent verification; it is one reading,
checked three times. More survey budget just buys a more confident wrong contract.

**Smoking gun in the same run:** survey wrote

```
[c2] ...contains exactly 16 data rows    check: test $(wc -l < summary.csv) -eq 17
[c3] ...recount...   periods = 5 (today, last_7, last_30, month_to_date, total) x severities = 3
```

5 x 3 = **15**, not 16. Survey's own two criteria contradicted each other, every check passed anyway,
and the hidden test failed.

**Done:** `verify` is now told it is judging **the task**, not the checklist — the checklist is described
as written by someone who had looked at the machine for two minutes and had not attempted the work — and
is required to re-read the task requirement by requirement. Survey must enumerate `requirements` before
writing any check, tag each criterion's `source` with the task's own words or the literal `INFERRED`,
and check its own criteria for internal contradictions.

**Still open:** the loop is only partly broken. All three steps still read one task statement.

---

## F2. Checks that can only detect absence, never excess

**Seen:** the same run. The recount verified that the 15 expected `(period, severity)` values were
correct. It never asserted that *nothing else* was present, so a result with an extra row satisfied it.

**Cause:** naturally-written checks confirm what is expected and ignore what is not. Hidden tests do the
opposite — they compare whole outputs. Nearly every criterion an LLM writes has this shape by default.

**Done:** survey is instructed that every check "must be able to fail on the WRONG thing being present,
not only on the right thing being absent — count exhaustively, compare whole outputs, assert the absence
of extras". `verify` and `implement` are both told to look for the stray row, file, field or ordering.

---

## F3. False positives end the run; false negatives are nearly free

**Measured** over 89 trials: of 45 "done" verdicts, 32 were right (**71% precision**); of 44 "not done"
verdicts, 33 were right. The 9 false negatives (`extract-elf`, `kv-store-grpc`, `log-summary`, `mailman`,
`qemu-startup`, `regex-log`, `vulnerable-secret`, +2) were tasks **already solved** when the verifier
said otherwise — the loop ran another round and **all nine still scored 1.0**. No damage.

**So the errors are not symmetric.** A false positive stops the run with the task broken and the clock
unspent. A false negative costs one extra round, which the current schedule has time for (it already
spends 90-99% of budget).

**Done:** `verify` must write `unchecked` (everything required that it did not verify) **before** the
verdict, `allPass` is false whenever that list is non-empty, and the prompt says plainly: *when in doubt,
say not done*.

---

## F4. A hard cap discards the answer the step was about to give

**Seen:** 4 of 6 surveys in `jobs/2026-07-26__08-36-15` died exactly at their cap (72/72/120/72s),
leaving those runs with **no acceptance criteria at all**.

**Cause:** two compounding mistakes. The cap was set below the measured median (survey costs 16-231s,
cap was 72s), and `timeLine` quoted the agent *exactly* the number the engine enforced — so there was no
slack for ordinary overshoot, and an abort discards everything not yet written down.

**Done:** caps are sized from measured cost with a floor (`survey max(15%,150s)..240s`,
`verify max(12%,120s)..300s`), and the prompt now quotes a **soft deadline at 75% of the enforced box**.
The gap absorbs overshoot and converts "killed mid-sentence" into "delivered something".

**Note:** true mid-flight steering ("you have 30s left, wrap up") is **not available** for background
steps — they are one-shot `pi.exec` subprocesses with no channel to send into a running turn. The soft
deadline and the round boundary are the achievable substitutes.

---

## F5. A step failed at formatting after its work had already landed

**Seen:** two implementations replied `/auto` and `/perm…` instead of JSON. The schema check failed the
step and the round was discarded — with the edits already on disk. ~374s lost.

**Cause:** `implement` was required to return `{changes, ranChecks, incomplete}`. Nothing consumed it:
the step is `resumable`, so the next round reopens the same session and holds strictly more than the
summary; and a round that spends its whole box produces no output at all, so the field was empty in
nearly every checkpoint anyway.

**Done:** `output` is now optional on agent steps (engine change). `implement` declares none, so no
contract is injected, nothing is parsed, and any reply is accepted. See `LESSONS.md` — *a validated
contract is a liability wherever it is not a dependency*.

---

## F6. Fragmenting continuous work

**Seen:** 53 of 89 implementations were cut off mid-job by a flat 20%-of-budget box; separately, 15 runs
were killed by the deadline mid-edit because the last round was granted the same slice as the first.

**Cause:** a constant `maxDurationMs` is identical on every loop iteration, so it must be sized either
small (fragments) or large (overruns).

**Done:** `maxDurationMs` may be a function of run state (engine change). `implement` takes half of the
time remaining, floored at 90s; the last round instead takes the whole tail. Every task budget now lands
on the 60s settle margin at 89-99% utilisation.

---

## F7. Container OOM masquerading as model failure

**Seen:** ~10% of trials — `exit code 137`, reward `0.0`, near-empty event log.

**Cause:** `task.toml` sets `memory_mb = 2048`; a workflow runs orchestrator *and* subagent inside that
one limit. Subagents are stable at ~230MB; the orchestrator ranges 200MB-1GB.

**Ruled out as framework causes, by measurement:** engine state accumulation (7 steps, trivial), and
`pi.exec` stdout buffering (a 400KB tool output yields 735KB of stdout, so 683MB would need ~150MB of
tool output — the session was 204KB).

**Not fixed.** Environmental. Check `dmesg | grep CONSTRAINT_MEMCG` before blaming the model for a task
that produced almost no events.

---

## F8. The planner doing the implementer's work

**Seen:** early runs — the planner solved a `fix-git` task itself, and the implementer then reported "no
changes needed". The run passed, but the division of labour that makes `verify` meaningful had collapsed.

**Done:** the shared `READ_ONLY` block, given to every thinking step.

---

## F9. Naming the benchmark invites cheating

**Not adopted deliberately.** Prompts do **not** say "this is a benchmark, passing is extremely
important". Raising the stakes invites test-hunting and hardcoded outputs, and since the tests are not in
the container during the agent phase, those attempts burn the clock and fail anyway. `GRADING_CONTRACT`
states what is graded without naming the game.
