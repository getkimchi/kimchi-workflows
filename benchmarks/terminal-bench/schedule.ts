/**
 * How this run's time is divided.
 *
 * Every number here is the residue of a measured failure — `FAILURE-MODES.md` records which. The shape
 * that survived: percentages with a FLOOR and a CEILING for the fixed-cost steps (looking around a
 * machine does not take four times longer because the budget is four times bigger), and a share of
 * REMAINING time for the work itself, so rounds shrink toward the deadline instead of colliding with it.
 */
export const BUDGET_SEC = Math.max(60, Number(process.env.TB_AGENT_TIMEOUT_SEC ?? 900));

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
export const SURVEY_CAP_MS = Math.round(Math.min(Math.max(BUDGET_SEC * 0.25, 180), 240) * 1000);
// Ceiling 180s, not 300s: verification is paid ONCE PER ROUND, so a generous per-round cap compounds —
// at a 1800s budget a 216s cap over two rounds put 25% of the run into checking. Observed cost is
// 12-180s with a median near 40s, and it does not grow with task size the way the work does.
export const VERIFY_CAP_MS = Math.round(Math.min(Math.max(BUDGET_SEC * 0.12, 120), 180) * 1000);

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
export const IMPLEMENT_SHARE_OF_REMAINING = 0.5;
/** Never hand a round less than this; below it a subagent cannot finish a single useful edit. */
export const IMPLEMENT_FLOOR_MS = 90_000;

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
  const remainingMs = remainingSec * 1000;
  // Everything physically available once this round's check and the settle margin are paid for.
  const spendableMs = remainingMs - VERIFY_CAP_MS - ROUND_MARGIN_SEC * 1000;
  const shareMs = remainingMs * IMPLEMENT_SHARE_OF_REMAINING;
  // Holding back half only makes sense if a further round can actually use it. Ask whether one would
  // still fit after this round took its share; when it would not, this IS the last round, so it takes
  // everything instead of leaving a remainder too small to start anything with. Without this a 900s
  // task stopped with 233 of 855 seconds unspent — a reserve kept for a round that could never happen.
  const anotherRoundFits = remainingMs - shareMs - VERIFY_CAP_MS - VERIFY_CAP_MS - ROUND_MARGIN_SEC * 1000 >= IMPLEMENT_FLOOR_MS;
  return Math.max(IMPLEMENT_FLOOR_MS, Math.round(anotherRoundFits ? Math.min(shareMs, spendableMs) : spendableMs));
};

/**
 * A later recon pass only WRITES DOWN what the first one already found — it does not look again, so it
 * needs room to emit JSON and nothing more. Keeping it small is what makes the recon loop affordable:
 * a second full-sized box would put a third of a short run into reconnaissance.
 */
export const SURVEY_LANDING_MS = 60_000;
/** How many recon passes before we accept whatever we have. Two is the useful case; the third is a guard. */
export const RECON_MAX_PASSES = 3;

/** Slack kept back so the last round settles instead of being cut off mid-write. */
export const ROUND_MARGIN_SEC = 60;
/**
 * A safety valve, NOT the policy — the clock decides when rounds end. This exists for the pathological
 * case the clock cannot catch: rounds so cheap they never consume the budget (every attempt failing in
 * seconds), which would otherwise spin until the loop's `maxIterations` guard CRASHED the run and
 * skipped the final report. Set far above any round count a real budget can pay for.
 */
export const ROUND_SAFETY_VALVE = 15;
