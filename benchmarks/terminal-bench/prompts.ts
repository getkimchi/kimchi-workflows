/**
 * What each step is actually told.
 *
 * Split out so `tb-solver.workflow.ts` stays about STRUCTURE — which step runs when, and what it may
 * cost — while the wording lives here. These are pure functions of plain data: no run context, no
 * engine types, so a prompt can be read, diffed and tested on its own.
 *
 * Nearly every paragraph below is the residue of a measured failure. `FAILURE-MODES.md` records which,
 * and why the wording is the way it is — read it before rewording anything.
 */
import type { Static } from "typebox"
import { criteriaBlock, GRADING_CONTRACT, type planSchema, READ_ONLY, timeLine, type verifySchema } from "./contract.ts"

type Plan = Static<typeof planSchema>
type Verdict = Static<typeof verifySchema>

/**
 * Recon, first pass: look at the machine, then turn the task into a checkable contract.
 *
 * The ordering is deliberate — requirements are enumerated BEFORE any check is written, because a
 * requirement nobody notices here is one nobody downstream ever checks.
 */
export function surveyPrompt(instruction: string, stepSec: number, remainingSec: number): string {
	return [
		"Inspect this machine and turn the task below into an acceptance contract that can be checked by",
		"running commands.",
		"",
		"TASK:",
		instruction,
		"",
		READ_ONLY,
		"",
		GRADING_CONTRACT,
		"",
		timeLine(stepSec, remainingSec),
		"",
		"First look around (ls, cat, find, git status/log, running processes, installed tooling) until you",
		"know what is actually here — do not plan against a machine you have imagined. Be quick about it:",
		"a few commands, not an audit. You are not solving the task in this step, and every second here is",
		"one the work itself does not get.",
		"",
		"Then, BEFORE writing any check, list `requirements`: go through the task sentence by sentence and",
		"write down every distinct thing it demands — each path, filename, format, exact value, exit code,",
		"count and behaviour. Quote its words. This list is what your criteria must cover; anything you fail",
		"to notice here is something nobody downstream will ever check.",
		"",
		"Then turn those requirements into acceptance criteria.",
		"Rules for criteria:",
		"  - each is checkable by ONE non-interactive shell command that exits 0 exactly when it holds;",
		"  - EVERY check must be able to fail on the WRONG thing being present, not only on the right thing",
		"    being absent. A check that confirms the values you expect, while ignoring whatever else is",
		"    there, passes a result with an extra row, a stray file or a trailing field — and the real tests",
		"    will not. Count things exhaustively, compare whole outputs, assert the absence of extras.",
		"  - the command must test real behaviour (run the program, query the service, parse the output),",
		"    not merely that a file exists — unless existence is genuinely all that is required;",
		"  - prefer a check that costs seconds over one that costs minutes: it is run more than once, by",
		"    more than one step. Where the honest check is expensive (cracking a hash, a full test suite),",
		"    checking the ARTIFACT it should have produced is usually just as decisive;",
		"  - no command may reference tests you have not seen, or write to the paths under test;",
		"  - keep it to the handful that actually decide the outcome, ordered most important first.",
		"",
		"For each criterion set `source` to the task's own words that require it, or the literal word",
		"INFERRED when the task does not say it and you worked it out. Be honest about which is which: an",
		"inference stated as a requirement is how a run ends up confidently satisfying the wrong contract.",
		"Then CHECK YOUR OWN WORK for contradictions — if one criterion enumerates a set and another counts",
		"it, the numbers must agree. (Measured: a survey demanded 16 rows for a table it had itself",
		"enumerated as 5 x 3 = 15. Every check passed; the task scored zero.)",
		"",
		"Finally, list `uncertainties`: the places the task is genuinely ambiguous and you had to pick a",
		"reading. Naming them is what lets the later check spend its scepticism where it is warranted.",
		"Also give the approach you would take, briefly.",
	].join("\n")
}

/**
 * Recon, later pass: the first one ran out of time before writing the contract down.
 *
 * It must NOT look again. The step is resumable, so this reopens the same conversation with everything
 * the first pass found still in it — the only thing missing is the answer, and sending it back to
 * explore is how a recon loop turns into a budget leak.
 */
export function surveyLandingPrompt(stepSec: number, remainingSec: number): string {
	return [
		"YOU RAN OUT OF TIME WRITING THIS UP. The conversation above is your own: you have already looked",
		"at this machine, and everything you found is there.",
		"",
		"DO NOT RUN ANY MORE COMMANDS. Do not look at anything else. There is only time to write down the",
		"answer, so produce it NOW from what you already know — requirements, criteria and uncertainties,",
		"in the required shape. An incomplete contract delivered is worth everything; a better one you",
		"never deliver is worth nothing, and the steps after this have no checklist at all without it.",
		"",
		timeLine(stepSec, remainingSec),
	].join("\n")
}

/** Do the work. `continuing` is true from round two, where this reopens its own earlier conversation. */
export function implementPrompt(args: {
	instruction: string
	design: Plan | undefined
	failures: Verdict["failures"]
	continuing: boolean
	stepSec: number
	remainingSec: number
}): string {
	const { instruction, design, failures, continuing, stepSec, remainingSec } = args

	// Continuity across rounds is the SESSION's job, not a summary's: the step is `resumable`, so a later
	// round reopens the same conversation and still holds everything it read, ran and learned.
	const priorWork = continuing
		? [
				"",
				"YOU HAVE BEEN HERE BEFORE. This conversation is your own from the previous round, which ran",
				"out of time or was judged incomplete — continue it rather than starting over, and re-read any",
				"file before you change it again.",
			].join("\n")
		: ""

	const retryBlock =
		failures.length > 0
			? [
					"",
					"AN INDEPENDENT CHECK FOUND THE WORK INCOMPLETE.",
					"These criteria did NOT pass — fix the underlying cause, do not paper over them:",
					...failures.map((f) => `  [${f.id}] observed: ${f.actual}\n        diagnosis: ${f.diagnosis}`),
				].join("\n")
			: ""

	return [
		"Complete this task on the machine you are on.",
		"",
		"TASK:",
		instruction,
		"",
		// Deliberately NOT "what your work is measured against" — that is what this used to say, and it
		// made a two-minute reconnaissance pass the definition of success. The criteria come from a step
		// that had never attempted the work; the hidden tests come from the task. Where they disagree the
		// task wins, and an implementer that has learned something the survey did not know must be free
		// to act on it.
		"CHECKLIST FROM A QUICK RECONNAISSANCE PASS — useful, but NOT the specification:",
		(design?.criteria?.length ?? 0) > 0
			? criteriaBlock(design?.criteria ?? [])
			: "  (none were derived — satisfy the task statement above, in full)",
		"Treat these as a floor, not a ceiling: satisfying every one of them is not the same as completing",
		"the task, and if one contradicts the task statement above, the task statement is right.",
		"",
		`PLANNED APPROACH: ${design?.approach ?? "(none derived — work from the task statement above)"}`,
		priorWork,
		retryBlock,
		"",
		GRADING_CONTRACT,
		"",
		timeLine(stepSec, remainingSec),
		"",
		"You are time-boxed. If you cannot finish everything, land the most important criteria FIRST and",
		"leave the machine in a working state — a partial result that runs beats a half-applied edit that",
		"does not, and another round may follow this one.",
		"",
		"Do the work now, then RUN EACH CHECK COMMAND ABOVE YOURSELF and fix what fails — catching your",
		"own mistakes here is worth more than any later step can be, because you still have the context to",
		"fix them. (Measured: an implementer told to leave checking to the verifier lands broken work and",
		"the run rarely has time to repair it.)",
		"",
		"Check the task's own words too, not only the checklist above — it was written before anyone",
		"attempted the work and it misses things. Re-read the task for every path, filename, exact format,",
		"value and count it names, and make sure your result contains exactly what is asked for and nothing",
		"extra: a stray row, file or field fails a real test that a narrow check waves through.",
		"",
		"Delete any scratch files, probe scripts or sample outputs YOU created that the task did not ask",
		"for — they can only confuse whatever grades this machine.",
	].join("\n")
}

/**
 * Audit the machine. Gets the task and the checklist, never the implementer's account of its own work.
 *
 * Measured precision over a full run was 71%: 13 of 45 "done" verdicts were wrong, and the losses were
 * unexamined corners rather than sloppy checking — which is why this asks what was NOT checked before
 * it asks for a verdict, and biases the verdict toward "not done".
 */
export function verifyPrompt(args: {
	instruction: string
	design: Plan | undefined
	stepSec: number
	remainingSec: number
}): string {
	const { instruction, design, stepSec, remainingSec } = args
	return [
		"You are auditing a machine that someone else has just worked on. Assume nothing they may have",
		"claimed is true: your job is to find out what is actually the case, by running commands.",
		"",
		"THE TASK THEY WERE GIVEN:",
		instruction,
		"",
		"THE QUESTION YOU ARE ANSWERING is whether THE TASK ABOVE is done — not whether the checklist below",
		"passes. The checklist was written by someone who had looked at this machine for a couple of minutes",
		"and had not yet attempted the work. It is a starting point and it is often incomplete. The tests",
		"that decide the outcome were written from the task, so the task is what you audit.",
		"",
		"STARTING CHECKLIST — run each one and observe the real result:",
		(design?.criteria?.length ?? 0) > 0
			? criteriaBlock(design?.criteria ?? [])
			: "  (none were derived — judge the task statement above on its own terms, end to end)",
		(design?.uncertainties?.length ?? 0) > 0
			? [
					"",
					"THE CHECKLIST'S AUTHOR WAS UNSURE ABOUT THESE — check them harder than the rest:",
					...(design?.uncertainties ?? []).map((u) => `  - ${u}`),
				].join("\n")
			: "",
		"",
		timeLine(stepSec, remainingSec),
		"",
		"Rules:",
		"  - run every check FROM A CLEAN SHELL (`bash -lc '<check>'`, starting from /), never from state",
		"    you have set up yourself: the machine is graded after everyone has left, so anything that",
		"    depends on an exported variable, a cwd or an activated venv is already broken;",
		"  - run every check; never mark one passed because it looks like it should pass;",
		"  - then RE-READ THE TASK and check what the checklist does not cover. Go requirement by",
		"    requirement: every path, filename, format, exact value, count and exit code it names. This is",
		"    where the outcome is usually decided;",
		"  - look for what should NOT be there as well as what should: an extra row, a stray file, a wrong",
		"    order, a trailing field. Checks tend to confirm the expected and ignore the unexpected, and the",
		"    real tests do not;",
		"  - an end-to-end run of what the task actually asks for often fails where every narrow check passes;",
		"  - if a check command is itself broken, judge the underlying criterion by other means and say so;",
		"  - DO NOT FIX ANYTHING. Report only. Someone else gets one more round to repair what you find.",
		"",
		"KEEP THE LAST THIRD OF YOUR BOX FOR WRITING THE VERDICT, and stop investigating when you reach it.",
		"A reply that never arrives is read as NOT PASSED, so everything you found is thrown away and the run",
		"spends another round rediscovering it. (Measured: 6 checks in 15 died at this box and returned",
		"nothing.) A partial verdict delivered beats a thorough one that is not — report what you actually",
		"checked and put everything you did not get to in `unchecked`.",
		"",
		"Then the verdict. List in `unchecked` everything the task requires that you did not actually",
		"verify — write that list BEFORE you decide `allPass`, and let it decide for you: if the list is not",
		"empty, `allPass` is false. Set `allPass` true only if you personally ran checks covering every",
		"requirement of the task and saw them all hold.",
		"",
		"WHEN IN DOUBT, SAY NOT DONE. Being wrong in that direction costs one more round, which there is",
		"time for. Being wrong the other way ends the run with the task broken and the clock unspent —",
		"measured, that happened to 13 of 45 runs that declared themselves finished.",
	].join("\n")
}

/**
 * The second opinion, and the only step deliberately kept ignorant of the checklist.
 *
 * Running `verify` twice would not catch what `verify` misses: its 13 wrong "done" verdicts in 45 were
 * unexamined corners rather than sloppy checking, and the same prompt makes the same omissions. So the
 * decorrelation has to be in the METHOD — this one never sees the criteria and works from the task
 * statement end to end, the way whoever ends up using the result would.
 *
 * Its verdict bias is the opposite of `verify`'s, and deliberately so. `verify` decides whether to spend
 * another round; this decides whether to REOPEN one that has been declared finished, and that costs a
 * repair round which may break work that is currently correct. So the bar here is evidence, not doubt.
 */
export function auditPrompt(args: { instruction: string; stepSec: number; remainingSec: number }): string {
	const { instruction, stepSec, remainingSec } = args
	return [
		"ANOTHER CHECKER HAS ALREADY BEEN OVER THIS MACHINE AND DECLARED THE TASK COMPLETE. You are the",
		"second opinion, and you are the last thing between that verdict and the run stopping for good. Your",
		"job is to find the thing that checker missed.",
		"",
		"THE TASK:",
		instruction,
		"",
		"You are NOT being given its checklist, on purpose. It worked down a list of criteria and confirmed",
		"what that list told it to look for; you work from the task above, end to end, as someone using the",
		"result would. A second pass by the same method finds the same things, so the only way you are worth",
		"the time is by looking somewhere else.",
		"",
		timeLine(stepSec, remainingSec),
		"",
		"Where a checklist-driven pass is habitually thin, in the order worth spending your time:",
		"  - actually RUN the deliverable, the whole way through, the way the task describes using it, and",
		"    read what comes out. This is where a result that satisfies every narrow check falls over;",
		"  - run everything FROM A CLEAN SHELL (`bash -lc '<command>'`, starting from /), with nothing you",
		"    exported, no activated venv and no cwd of your own: the machine is graded after everyone has",
		"    left, so anything that depends on session state is already broken;",
		"  - look for what should NOT be there — a debug line, an extra row, a stray scratch file, a leftover",
		"    backup, a trailing field. Checks confirm what they expect and ignore everything else;",
		"  - compare exact formats, exact values, counts and ordering against the task's own words, not",
		"    against what would be reasonable;",
		"  - try the edge inputs the task admits: empty, missing, malformed, duplicate, largest, smallest.",
		"",
		"DO NOT FIX ANYTHING, and do not improve anything. Report only. If you are right, someone else gets a",
		"round to repair what you found; if you start editing, nobody ever checks what you did.",
		"",
		"KEEP THE LAST THIRD OF YOUR BOX FOR WRITING THE VERDICT, and stop investigating when you reach it.",
		"A reply that never arrives is read as NO OBJECTION: the run stops on the first checker's verdict, so",
		"a real defect you found and did not report is a task lost outright. (Measured: both trials of this",
		"step spent their whole box and returned nothing at all.) A partial verdict delivered beats a thorough",
		"one that is not — report what you actually checked and put everything you did not get to in",
		"`unchecked`.",
		"",
		"THE BAR FOR OVERTURNING IS EVIDENCE, NOT SUSPICION. Say `allPass: false` ONLY when you can point at",
		"a concrete failure you actually observed, and paste the command and the output that show it. A",
		"corner you did not get to, a doubt, or something you would have built differently is NOT a dissent:",
		"reopening a finished task spends a repair round that can break work which is currently correct. If",
		"you found nothing you can demonstrate, say `allPass: true` and let the run stop.",
		"",
		"The reply shape is shared with the first checker, so two of its fields read differently here:",
		"`unchecked` is whatever you did not get to — write it down honestly, but here it does NOT decide the",
		"verdict; and each entry in `failures` takes a short id of your own (`a1`, `a2`, ...), the real output",
		"you saw in `actual`, and what is actually wrong in `diagnosis`.",
	].join("\n")
}
