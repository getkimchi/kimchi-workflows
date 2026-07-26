/**
 * The terminal-bench solver's shared vocabulary: the schemas its steps exchange, and the prompt blocks
 * every step is given. Split from the workflow itself so that file stays about STRUCTURE — which step
 * runs when, and what it may cost — while the wording lives here.
 */
import { Type } from "typebox";

export const taskInputSchema = Type.Object({
  /** The verbatim terminal-bench instruction. */
  instruction: Type.String(),
  /** When the harness will kill the agent phase — ISO 8601. */
  deadlineIso: Type.String(),
});

export const criterionSchema = Type.Object({
  id: Type.String({ description: "Short stable id, e.g. `c1`." }),
  statement: Type.String({ description: "What must be true, in one sentence." }),
  check: Type.String({ description: "A single shell command that tests it, non-interactive, exits 0 on success." }),
  expect: Type.String({ description: "What the command's output/exit status must show for this to pass." }),
});

export const planSchema = Type.Object({
  approach: Type.String({ description: "The intended change, in a few sentences." }),
  criteria: Type.Array(criterionSchema, { description: "Acceptance criteria, each independently checkable." }),
});

// No schema for `implement`: it acts on the machine and `verify` reads the machine, so nothing consumes
// its words. Requiring a shape there only added a way to fail at work that had already landed.

export const verifySchema = Type.Object({
  allPass: Type.Boolean({ description: "True only if every criterion's check actually passed when you ran it." }),
  failures: Type.Array(
    Type.Object({
      id: Type.String(),
      actual: Type.String({ description: "The real command output/exit status you observed." }),
      diagnosis: Type.String({ description: "Why it failed, concretely." }),
    }),
    { description: "Empty when everything passes." },
  ),
});

/**
 * The framing every step gets. It says what is graded and what the clock is — deliberately NOT "this is
 * a benchmark, passing is extremely important". Naming the benchmark and raising the stakes is what
 * invites test-hunting and hardcoded outputs, and since the tests are not in the container during the
 * agent phase, those attempts burn the clock and then fail anyway.
 */
export const GRADING_CONTRACT = [
  "HOW THIS IS GRADED",
  "- The FINAL STATE of this machine is what counts. It is checked by automated tests that are not",
  "  present here and that you will never see.",
  "- Only genuinely working behaviour scores. Do not go looking for test files, do not write or edit",
  "  tests, and never hardcode a value to satisfy a checker — a stub that returns the expected answer",
  "  scores zero, and so does a passing check over functionality that does not really work.",
  "- Everything must survive your shell exiting: write to disk, install properly, restart services so",
  "  they are actually running. Never rely on session state (exported vars, cwd, an activated venv).",
  "- Follow the task's stated requirements exactly — paths, filenames, formats and exit codes are",
  "  usually what is being checked.",
].join("\n");

/**
 * Steps that think, rather than act, say so in the same words. Observed live: without this, the
 * planner solved a `fix-git` task itself and the implementer then reported "no changes needed" — the
 * run passed, but the division of labour that makes `verify` meaningful had quietly collapsed.
 */
export const READ_ONLY = [
  "THIS STEP DOES NOT CHANGE ANYTHING.",
  "Inspect all you like with read-only commands, but do not edit, create, delete, move, install, or",
  "run anything that mutates this machine (no writes, no git commit/merge/checkout, no package",
  "installs). A later step does the work; doing it here would leave it unverified.",
].join("\n");

/**
 * What a step is told about the clock. It gets TWO numbers, and the first one matters most: its own box.
 *
 * Measured: with only the run's remaining time in the prompt, four in ten `survey` steps explored as
 * though they owned the whole budget and were killed mid-thought at their cap — leaving the run with no
 * acceptance criteria at all, which everything downstream is built on. A step that knows it has 180
 * seconds paces itself to produce something in 180 seconds; a step told it has 855 does not.
 */
export function timeLine(stepSec: number, remainingSec: number): string {
  return [
    `TIME: you have about ${Math.max(0, Math.round(stepSec))}s for THIS step. It is a hard limit — if you`,
    "overrun it you are stopped where you stand and whatever you have not written down is lost. Aim to",
    "finish comfortably inside it, and if you are running short, produce your best answer NOW rather than",
    "a better one you will never get to deliver.",
    `(The whole run has about ${Math.max(0, Math.round(remainingSec))}s left before this machine is graded.)`,
  ].join("\n");
}

export function criteriaBlock(criteria: readonly { id: string; statement: string; check: string; expect: string }[]): string {
  return criteria.map((c) => `  [${c.id}] ${c.statement}\n        check:  ${c.check}\n        expect: ${c.expect}`).join("\n");
}
