/**
 * The terminal-bench solver's shared vocabulary: the schemas its steps exchange, and the prompt blocks
 * every step is given. Split from the workflow itself so that file stays about STRUCTURE — which step
 * runs when, and what it may cost — while the wording lives here.
 */
import { type Static, Type } from "typebox";

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

export const implementSchema = Type.Object({
  changes: Type.String({ description: "What you actually changed, as paths and one-line reasons." }),
  ranChecks: Type.String({ description: "Which acceptance checks you ran yourself, and their real output." }),
  incomplete: Type.String({ description: "Anything you could NOT finish. Empty string if nothing." }),
});

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

export function timeLine(remainingSec: number): string {
  return `TIME: about ${Math.max(0, Math.round(remainingSec))}s remain before this machine is taken away and graded. A correct, verified partial result beats an elaborate unfinished one — do not start work you cannot land in the time left.`;
}

export function criteriaBlock(criteria: readonly { id: string; statement: string; check: string; expect: string }[]): string {
  return criteria.map((c) => `  [${c.id}] ${c.statement}\n        check:  ${c.check}\n        expect: ${c.expect}`).join("\n");
}
