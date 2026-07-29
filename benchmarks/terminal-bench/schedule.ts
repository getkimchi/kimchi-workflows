/**
 * How this run's time is divided.
 *
 * Every number here is the residue of a measured failure — `FAILURE-MODES.md` records which. The shape
 * that survived: percentages with a FLOOR and a CEILING for the fixed-cost steps (looking around a
 * machine does not take four times longer because the budget is four times bigger), and a share of
 * REMAINING time for the work itself, so rounds shrink toward the deadline instead of colliding with it.
 */
export const BUDGET_SEC = Math.max(60, Number(process.env.TB_AGENT_TIMEOUT_SEC ?? 900))

/**
 * Recon is sized from what it MEASURABLY COSTS, and that turns out not to depend on the budget at all.
 *
 * Measured over 88 surveys in one full run: median 66s, p90 153s, p95 211s, max 276s — and crucially,
 * flat across task size. `build-pov-ray`, with a 11955s budget, surveyed in **59s**; `sam-cell-seg`
 * (7155s) took 129s; every task in the 2000-5000s band finished under a 400s cap with none truncated
 * and a maximum of 211s. Reconnaissance is bounded by how much looking around is USEFUL, not by how big
 * the task is: a bigger build does not mean more `ls`.
 *
 * So a percentage is the wrong instrument, and it has now been wrong in both directions — 25% made
 * recon a quarter of the run before any work began, while 8% and then a 150s floor put the cap under
 * the p90 and truncated roughly one survey in nine. A near-CONSTANT cap with a guard for tiny budgets
 * is what the distribution actually supports.
 *
 * The cap is a ceiling, not a target: at a 66s median it almost never binds, so setting it generously
 * costs nothing in the common case and only spends time on the tail — which is precisely the case where
 * the alternative is losing the acceptance contract entirely.
 *
 * 225s covers 98.8% of surveys that completed; 150s covered 88.8%.
 */
export const SURVEY_CAP_MS = Math.round(Math.min(Math.max(BUDGET_SEC * 0.25, 180), 240) * 1000)
/**
 * The 12% stays and so does the ceiling — checking is paid ONCE PER ROUND, so a generous cap compounds
 * over the rounds a long budget buys. Both BOUNDS move, because they were set below what checking costs.
 *
 * Measured in `jobs/2026-07-26__12-00-55`: 6 of 15 verifications died at their box, and the kills pile
 * up ON the cap (180, 180, 180, 180) instead of trailing off — so the observed median of 101s is
 * censored, not measured. A check killed at its cap is the worst outcome available: it spends the entire
 * box AND returns nothing, so the round is decided by a default rather than by evidence.
 *
 * Only the CEILING moves, 180s -> 240s, and only because that is where the censoring actually is: four
 * of the six kills are there, on the 1800s-and-up budgets where 240s is still a small share of the run.
 *
 * The floor stays at 120s against the temptation to raise it, because the surviving times say it is not
 * the binding constraint: every verification that reached a verdict did so in 119s or less, so a check
 * still going at 120s is one that has stopped converging rather than one that needs a little longer.
 * Buying it more time on an 855s budget costs 30s per ROUND out of the work — on a run where checking
 * already took 28% of the wall clock — to rescue a case the evidence says would not be rescued. The
 * landing instruction in `verifyPrompt` is the fix for that end of the distribution, and it is free.
 */
export const VERIFY_CAP_MS = Math.round(Math.min(Math.max(BUDGET_SEC * 0.12, 120), 240) * 1000)

/**
 * `implement` takes a share of the time ACTUALLY LEFT, resolved fresh on every round (spec §9.3's
 * function form) — not a fixed fraction of the whole budget.
 *
 * A fixed fraction is the same on every round, which forces a choice between two bad schedules. Small
 * (20%, what this was) fragments the work: a full-benchmark run had 53 of 89 implementations cut off
 * mid-job, each restart re-establishing footing the last one already had. Large enough to be useful
 * overruns instead — 15 runs were killed by the deadline mid-edit, because the last round was granted
 * the same slice as the first when a fraction of it remained.
 *
 * Taking 70% of what is left is self-correcting: round one gets the long coherent stretch that is the
 * agent's actual strength, each later round is necessarily smaller, and the 30% held back always covers
 * `verify` plus the margin — so the loop shrinks toward its deadline instead of colliding with it.
 */
export const IMPLEMENT_SHARE_OF_REMAINING = 0.5
/** Never hand a round less than this; below it a subagent cannot finish a single useful edit. */
export const IMPLEMENT_FLOOR_MS = 90_000

/**
 * What a round may spend on implementation, given the seconds left when it opened. This is the ONE
 * definition — used both as the enforced budget and as the number the prompt quotes, so the agent is
 * never told a deadline the engine will not honour.
 *
 * Two bounds, and the tighter one wins. The share keeps early rounds from eating the clock, so there is
 * always something left to repair with. `spendableMs` is what physically remains once checking and
 * settling are paid for — it binds on the LAST round, letting it fill the tail exactly instead of
 * taking half of it and idling the rest (a 750s task otherwise finished with 38% of its budget unused,
 * because half of a small remainder is never worth starting).
 */
export const implementBoxMs = (remainingSec: number): number => {
	const remainingMs = remainingSec * 1000
	// Everything physically available once this round's check and the settle margin are paid for.
	const spendableMs = remainingMs - VERIFY_CAP_MS - ROUND_MARGIN_SEC * 1000
	const shareMs = remainingMs * IMPLEMENT_SHARE_OF_REMAINING
	// Holding back half only makes sense if a further round can actually use it. Ask whether one would
	// still fit after this round took its share; when it would not, this IS the last round, so it takes
	// everything instead of leaving a remainder too small to start anything with. Without this a 900s
	// task stopped with 233 of 855 seconds unspent — a reserve kept for a round that could never happen.
	const anotherRoundFits =
		remainingMs - shareMs - VERIFY_CAP_MS - VERIFY_CAP_MS - ROUND_MARGIN_SEC * 1000 >= IMPLEMENT_FLOOR_MS
	return Math.max(IMPLEMENT_FLOOR_MS, Math.round(anotherRoundFits ? Math.min(shareMs, spendableMs) : spendableMs))
}

/**
 * The audit is NOT `verify` run twice, and pricing it as though it were killed every trial of it: both
 * audits in `jobs/2026-07-26__12-27-05` spent their full 120s and returned no verdict at all — which
 * `checkpoint` correctly reads as "no objection", so the step was pure cost and bought nothing.
 *
 * It is handed NO checklist, by design; that ignorance is the whole decorrelation. So before it can run
 * a single check it has to derive its own, which is the reconnaissance `verify` is given for free. Its
 * cost is `survey` PLUS `verify`, not `verify` — measured medians on this build, 130s and 101s.
 *
 * 20% floored at 240s and capped at 360s: roughly the sum of the two boxes whose work it actually does,
 * so the step has room to reach a verdict rather than dying on the way to one.
 */
export const AUDIT_CAP_MS = Math.round(Math.min(Math.max(BUDGET_SEC * 0.2, 240), 360) * 1000)

/**
 * Whether a second opinion on a "done" verdict is worth buying yet.
 *
 * A wrong "done" is the most expensive thing that happens in a run: of 45 such verdicts in one full run
 * 13 were wrong, and those 13 stopped with a median of 1412s of budget still unspent (p25 641s, max
 * 8700s) — the run halts holding exactly the time that would have fixed the task. The mirror-image error
 * is nearly free, because a run that is told "not done" simply keeps working: 9 of 42 "not done"
 * verdicts were also wrong and every one of them still scored 1.0.
 *
 * So the question is not whether a second opinion is affordable but whether a DISAGREEMENT is: what has
 * to fit is the audit, plus the smallest repair round that could land anything, plus the check that
 * repair still has to pass, plus the settle margin. Below that the audit can only ever confirm a verdict
 * or deliver news nobody can act on, which is pure cost. At a 900s budget this lands at 540s, up from
 * 390s purely because the audit's own box grew (see `AUDIT_CAP_MS`). That is stricter than the ">300s
 * left" the threshold analysis over those 45 verdicts pointed at — gating there would fire on 27 of the
 * 32 correct verdicts (what it costs) and reach all 13 of the wrong ones (what it buys) — and the gate is
 * only ever as generous as the audit is cheap. An audit that cannot finish reaches none of them.
 */
export const auditIsAffordable = (remainingSec: number): boolean =>
	remainingSec * 1000 >= AUDIT_CAP_MS + IMPLEMENT_FLOOR_MS + VERIFY_CAP_MS + ROUND_MARGIN_SEC * 1000

/**
 * A later recon pass only WRITES DOWN what the first one already found — it does not look again, so it
 * needs room to emit JSON and nothing more. Keeping it small is what makes the recon loop affordable:
 * a second full-sized box would put a third of a short run into reconnaissance.
 */
export const SURVEY_LANDING_MS = 60_000
/** How many recon passes before we accept whatever we have. Two is the useful case; the third is a guard. */
export const RECON_MAX_PASSES = 3

/** Slack kept back so the last round settles instead of being cut off mid-write. */
export const ROUND_MARGIN_SEC = 60
/**
 * A safety valve, NOT the policy — the clock decides when rounds end. This exists for the pathological
 * case the clock cannot catch: rounds so cheap they never consume the budget (every attempt failing in
 * seconds), which would otherwise spin until the loop's `maxIterations` guard CRASHED the run and
 * skipped the final report. Set far above any round count a real budget can pay for.
 */
export const ROUND_SAFETY_VALVE = 15
