/**
 * Runs a single step to a validated output under its unified retry policy (spec §9), per-step budgets
 * (time + tokens, spec §9.3), and — for agent steps — in-session output steering (spec §9.2) and Q&A
 * suspension (spec §10). Pure w.r.t. the engine boundary: all agent/network coupling is behind
 * `host.startAgent`; all delay (backoff + budget timers) is `host.sleep`.
 */
import {
	buildAskingProtocol,
	buildOutputProtocol,
	formatAnswers,
	type Questionnaire,
	QuestionnaireSchema,
} from "../flow/questionnaire.ts"
import type { AgentStep, FunctionStep, RetryPolicy, RunContext, StepLogger } from "../flow/types.ts"
import { describeSchemaViolations } from "../flow/validation.ts"
import { buildCorrectionMessage } from "./agent-output.ts"
import { createRunContext, createStepLogger, iso, type RunState, type StepOutcome } from "./context.ts"
import type { NodePath } from "./node-path.ts"
import { readSubmittedPayload, SUBMIT_QUESTIONS_TOOL, SUBMIT_RESULT_TOOL } from "./output-tools.ts"
import type { AgentTurn, HostPort, RetryReason } from "./types.ts"

/** Default in-session output-steering budget (spec §9.2) when an agent step declares none. */
const DEFAULT_MAX_OUTPUT_REPAIRS = 2

/** Fields the retry loop / budget wrapper need from any step. The wall-time budget is NOT among them:
 * it is resolved per execution by {@link resolveBudgetMs} and passed in already reduced to a number. */
interface BudgetedStep {
	readonly name: string
	readonly retry?: RetryPolicy
}

/**
 * Reduce a step's declared budget (spec §9.3) to milliseconds for THIS execution.
 *
 * Called once, before the first attempt, so every retry of one execution races the same clock — a retry
 * is a second try at the same work, not a fresh grant of time. The function form receives the same `ctx`
 * a prompt builder does, which is what lets a step inside a loop take a share of the time actually left
 * rather than a fixed slice sized for the worst case.
 *
 * A non-finite result is treated as "no budget declared" rather than crashing the run: the alternative
 * is failing a step over arithmetic in a budget expression. A non-positive one is passed through
 * unchanged — it means "no time left", and `withTimeBudget` turns that into an immediate
 * `budget-exceeded` without starting the attempt.
 */
function resolveBudgetMs(
	step: { readonly maxDurationMs?: number | ((args: { ctx: RunContext }) => number) },
	ctx: RunContext,
): number | undefined {
	const declared = step.maxDurationMs
	if (declared === undefined) return undefined
	const value = typeof declared === "function" ? declared({ ctx }) : declared
	return Number.isFinite(value) ? value : undefined
}

/**
 * Which conversation this step continues, if any (spec §2.2).
 *
 * `resumable: true` means "continue MYSELF", so the key is the step's own name. A string means
 * "continue THIS conversation", which any number of steps may name to take turns in one context —
 * the difference between a chain of briefed strangers and a single orchestrator that remembers why it
 * planned what it planned. `.commit()` has already rejected a shared key wherever two holders could
 * run at once, so nothing here has to reason about who else might be writing.
 */
function resolveResumeKey(step: AgentStep): string | undefined {
	if (typeof step.resumable === "string") return step.resumable
	return step.resumable === true ? step.name : undefined
}

/**
 * How an agent step's conversation begins: a `fresh` run builds the prompt from input+context; an
 * `answer` resume (spec §8.4) seeds the session with the blocked conversation and replays the user's
 * structured answers as the next turn. `elapsedMs`/`tokensUsed` (spec §9.4) are this attempt's budget
 * totals as of the block being answered — see `runAgentStep`'s carry-forward.
 */
export type AgentEntry =
	| { kind: "fresh" }
	| {
			kind: "answer"
			answers: Record<string, unknown>
			conversation: readonly unknown[]
			elapsedMs?: number
			tokensUsed?: number
	  }

/**
 * Outcome of a single attempt:
 *  - `ok`        — produced schema-valid output;
 *  - `retryable` — a failure the retry policy may re-attempt: thrown error / invalid function output /
 *                  agent transport error / budget exceeded (spec §9.3), OR an agent's output that is
 *                  STILL invalid once its in-session repair budget is exhausted (spec §9.2 — "only when
 *                  repairs are exhausted does the attempt fail and the repeat policy apply", so this is
 *                  never treated as a dead end in its own right, background step or not);
 *  - `blocked`    — a Q&A step emitted a `{questions}` batch (spec §10); `elapsedMs`/`tokensUsed`
 *                  (agent steps only) are the running budget totals at the moment of blocking (§9.4);
 *  - `cancelled` — the abort signal fired.
 */
type AttemptResult =
	| { kind: "ok"; output: unknown }
	| { kind: "retryable"; reason: RetryReason; error: string }
	| {
			kind: "blocked"
			questionnaire: Questionnaire
			conversation: readonly unknown[]
			elapsedMs?: number
			tokensUsed?: number
	  }
	| { kind: "cancelled" }

/** Run a function step under its retry + time budget (spec §9). Emits `step-retry`; the caller emits step lifecycle. */
export async function runFunctionStep(
	step: FunctionStep,
	input: unknown,
	host: HostPort,
	state: RunState,
	signal: AbortSignal,
	parentPath: NodePath,
	path: string,
): Promise<StepOutcome> {
	const ctx = createRunContext(state, parentPath)
	const logger = createStepLogger(host, state.runId, path)
	return retryLoop(
		step,
		host,
		state,
		signal,
		path,
		(sig) => runFunctionAttempt(step, input, ctx, logger, sig),
		resolveBudgetMs(step, ctx),
	)
}

/**
 * Run an agent step under its retry policy (spec §9), budgets (time + tokens, §9.3), steering (§9.2),
 * and Q&A (§10). `entry` selects a fresh run or an answer-resume that continues the same loop (§8.4).
 * Emits `step-retry`/`agent-steer`; the caller emits step lifecycle + `questionnaire-asked`.
 */
export async function runAgentStep(
	step: AgentStep,
	input: unknown,
	host: HostPort,
	state: RunState,
	signal: AbortSignal,
	parentPath: NodePath,
	path: string,
	entry: AgentEntry,
): Promise<StepOutcome> {
	const ctx = createRunContext(state, parentPath)

	// Budget carry across a block/answer boundary (spec §9.4): an answer-continuation is the SAME attempt
	// resuming, not a fresh one, so the wall time and tokens spent before the block carry into THIS
	// call's first attempt only. If that attempt itself then needs an outer retry (a thrown error), that
	// IS a genuinely fresh attempt and both budgets restart at zero (spec §9.1) — hence the one-shot
	// `carry` consumed by the closure below rather than threaded permanently through every retry.
	let carry =
		entry.kind === "answer" ? { elapsedMs: entry.elapsedMs ?? 0, tokensUsed: entry.tokensUsed ?? 0 } : undefined
	const carryOverMs = carry?.elapsedMs ?? 0

	const attempt = (sig: AbortSignal, attemptNumber: number): Promise<AttemptResult> => {
		const startingTokens = carry?.tokensUsed ?? 0
		carry = undefined
		return runAgentSession(step, input, host, ctx, state, sig, path, entry, attemptNumber, startingTokens)
	}

	// A step with an output contract is always steerable: the model can be reminded to call
	// `submit_result` in the same resumed session, whether it runs in-process or as a background
	// subprocess. `background`/`isolated` control HOW the session runs, not whether it can be steered.
	// A step with no output contract cannot be wrong, so neither repairs nor default retries apply.
	return retryLoop(step, host, state, signal, path, attempt, resolveBudgetMs(step, ctx), carryOverMs)
}

/**
 * Shared retry loop (spec §9): wrap each attempt in the time budget, re-attempt `retryable` failures
 * within budget. A step that declares no policy of its own runs exactly once (§9.1's `maxRetry` default
 * of 0): an agent step with a contract has already spent its in-session repairs by the time an attempt
 * fails here (§9.2), and those are the cheaper budget — they keep the context a retry would rebuild.
 */
async function retryLoop(
	step: BudgetedStep,
	host: HostPort,
	state: RunState,
	runSignal: AbortSignal,
	path: string,
	// The 1-based attempt number travels INTO the attempt (rather than staying a loop-local counter)
	// because a host that persists a session names the file after it — see `AgentRequest.attempt`.
	attempt: (signal: AbortSignal, attemptNumber: number) => Promise<AttemptResult>,
	budgetMs: number | undefined,
	carryOverMs = 0,
): Promise<StepOutcome> {
	const totalAttempts = Math.max(1, (step.retry?.maxRetry ?? 0) + 1)
	const backoffMs = step.retry?.backoffMs ?? 0
	let lastError = ""

	for (let n = 1; n <= totalAttempts; n++) {
		if (runSignal.aborted) return { kind: "cancelled" }

		// The budget carry (spec §9.4) applies only to this loop's FIRST attempt — the one continuing an
		// interrupted block. A subsequent retry (n > 1) is a fresh attempt and gets a clean budget.
		const result = await withTimeBudget(
			step,
			budgetMs,
			host,
			runSignal,
			(sig) => attempt(sig, n),
			n === 1 ? carryOverMs : 0,
		)
		if (result.kind === "cancelled") return { kind: "cancelled" }
		if (result.kind === "ok") return { kind: "ok", output: result.output }
		if (result.kind === "blocked") {
			return {
				kind: "blocked",
				questionnaire: result.questionnaire,
				conversation: result.conversation,
				elapsedMs: result.elapsedMs,
				tokensUsed: result.tokensUsed,
			}
		}

		// Retryable failure (thrown / invalid output / budget exceeded): re-attempt if budget remains.
		lastError = result.error
		if (await retryScheduled(host, state.runId, path, n, totalAttempts, backoffMs, result.reason, result.error))
			continue
		return { kind: "crashed", error: lastError }
	}

	return { kind: "crashed", error: lastError || "retry loop exited without a result" }
}

/**
 * Enforce a step's wall-time budget (spec §9.3/§9.4): race the attempt against a `host.sleep` timer
 * whose signal is combined with the run's cancel signal. On timeout, abort the step (cooperatively) and
 * fail with a retryable `budget-exceeded`. Without a budget, the step just gets the run signal.
 *
 * `consumedMs` is wall time already spent `in_progress` earlier THIS attempt (spec §9.4: carried across
 * a block/answer boundary — zero for a fresh attempt). The timer is shortened by it, and if it has
 * already exhausted the budget the attempt fails immediately without ever starting — a Q&A step that
 * blocked right at its limit does not get a bonus fresh window just because a human answered it. On a
 * successful `blocked` outcome (the attempt suspended again rather than timing out), the wall time this
 * call actually spent is folded into the running total and returned, so the NEXT continuation knows how
 * much budget remains; time spent blocked in between is excluded by construction — nothing samples the
 * clock while there is no code running.
 */
async function withTimeBudget(
	step: BudgetedStep,
	budgetMs: number | undefined,
	host: HostPort,
	runSignal: AbortSignal,
	attempt: (signal: AbortSignal) => Promise<AttemptResult>,
	consumedMs = 0,
): Promise<AttemptResult> {
	if (budgetMs === undefined) {
		return attempt(runSignal)
	}

	const remainingMs = budgetMs - consumedMs
	if (remainingMs <= 0) {
		return {
			kind: "retryable",
			reason: "budget-exceeded",
			error: `step "${step.name}" exceeded its ${budgetMs}ms time budget`,
		}
	}

	const startedAt = host.now().getTime()
	const timeout = new AbortController()
	const cleanup = new AbortController()
	// `AbortSignal.any` rather than a hand-rolled listener pair: the composite is held WEAKLY by its
	// sources, so a step that finishes well inside its budget leaves nothing attached to the run-wide
	// cancel signal — a workflow with hundreds of budgeted steps would otherwise pile up a listener per
	// attempt on the one signal that lives for the whole run.
	const attemptPromise = attempt(AbortSignal.any([runSignal, timeout.signal]))
	const timerPromise = host.sleep(remainingMs, cleanup.signal).then((): "timeout" => "timeout")

	const outcome = await Promise.race([attemptPromise, timerPromise])
	if (outcome === "timeout") {
		timeout.abort() // ask the running step to stop at its next safe point (spec §8.6)
		void attemptPromise.catch(() => {}) // swallow the abandoned step's eventual rejection
		return {
			kind: "retryable",
			reason: "budget-exceeded",
			error: `step "${step.name}" exceeded its ${budgetMs}ms time budget`,
		}
	}
	cleanup.abort() // the step finished first — cancel the timer so it does not linger

	if (outcome.kind === "blocked") {
		return { ...outcome, elapsedMs: consumedMs + (host.now().getTime() - startedAt) }
	}
	return outcome
}

async function runFunctionAttempt(
	step: FunctionStep,
	input: unknown,
	ctx: RunContext,
	logger: StepLogger,
	signal: AbortSignal,
): Promise<AttemptResult> {
	let output: unknown
	try {
		output = await step.run({ input, ctx, abortSignal: signal, logger })
	} catch (err) {
		if (signal.aborted) return { kind: "cancelled" } // a throw while cancelling is a cooperative stop
		return { kind: "retryable", reason: "thrown-error", error: err instanceof Error ? err.message : String(err) }
	}

	if (step.outputSchema) {
		const violation = describeSchemaViolations(step.outputSchema, output)
		if (violation) {
			if (signal.aborted) return { kind: "cancelled" }
			return { kind: "retryable", reason: "invalid-output", error: `step "${step.name}" output: ${violation}` }
		}
	}
	return { kind: "ok", output }
}

/**
 * One agent attempt: open a session (seeded with `entry` history), send the first message (prompt or
 * answer), and steer within the same session on invalid output up to `maxOutputRepairs` (spec §9.2).
 * Token usage is summed across turns, starting from `startingTokens` (spec §9.4: carried forward across
 * an answer-continuation of the same attempt — zero for a fresh one); exceeding `maxTokens` → retryable
 * `budget-exceeded` (§9.3). A Q&A `{questions}` → `blocked` (§10); transport error → `retryable`.
 *
 * When `asks`, the framework owns the questionnaire schema: the step submits EITHER tool, and which one
 * it called decides result-vs-block. The asking protocol is auto-injected into the fresh prompt, so the
 * author's prompt stays task-only.
 *
 * **Exhausted repairs are `retryable`, not fatal (spec §9.2/§9.3).** "Only when repairs are exhausted
 * does the attempt FAIL and the repeat policy apply" — a fresh session (a genuine retry, §9.1) can
 * succeed where a poisoned context could not, so this never short-circuits the outer retry policy.
 * `maxRetry` defaults to 0, so by default the crash still happens on the very next loop turn — only an
 * author who declared `retry` sees a different outcome. `background` and `isolated` steps (spec §2.2)
 * take the SAME path: they run as a subprocess per turn (src/host/pi-agent.ts) but resume one session
 * file, so a correction reaches the model in the conversation that holds its work. How a session runs
 * has no bearing on whether it can be steered — only the presence of an output contract does.
 */
async function runAgentSession(
	step: AgentStep,
	input: unknown,
	host: HostPort,
	ctx: RunContext,
	state: RunState,
	signal: AbortSignal,
	path: string,
	entry: AgentEntry,
	attempt: number,
	startingTokens = 0,
): Promise<AttemptResult> {
	const model = step.model ?? state.defaultModel // step → workflow default; host applies the session default when undefined (spec §9.5)
	// Static isolation (spec §2.2): decided from the workflow's SHAPE at `.commit()` (flow/isolation.ts)
	// and tagged onto the step itself — read straight off it here, never re-derived from what happens to
	// be in flight.
	const isolated = step.isolated === true
	// A step with an output contract is always steerable: a `background` or `isolated` step runs as a
	// subprocess per turn, but its session file (`--session <path>`) is resumed on each
	// `sendAndAwaitEnd`, so a correction reaches the model in the SAME conversation, with its prior work
	// in front of it. `maxOutputRepairs` applies regardless of how the session runs.
	// A step with no output contract has nothing to be steered TOWARD: its reply is whatever it says,
	// and cannot be wrong (spec §2.2 — it acts rather than reports).
	const noSteering = step.outputSchema === undefined
	const maxRepairs = noSteering ? 0 : Math.max(0, step.maxOutputRepairs ?? DEFAULT_MAX_OUTPUT_REPAIRS)
	const steerSchema = step.outputSchema
	const history = entry.kind === "answer" ? entry.conversation : undefined
	// `resumeKey` defaults to the step's own name: every execution of THIS step continues the same
	// conversation, which is what makes a round-two worker pick up where round one was cut off (spec
	// §2.2). A step declaring a STRING instead continues the conversation under THAT key, which several
	// steps may share to take turns in one orchestrator context — `.commit()` has already established
	// that they cannot overlap, so the file has one writer at a time.
	const session = host.startAgent({
		model,
		history,
		stepName: step.name,
		// Run/execution identity (spec §8.5): everything a host needs to give this session a durable name
		// of its own — see `AgentRequest.runId`. All four are already here; none of them changes what the
		// engine does with the session.
		runId: state.runId,
		workflowName: state.workflowName,
		path,
		attempt,
		background: step.background,
		isolated,
		resumeKey: resolveResumeKey(step),
		// Handed over so a host running this out-of-process can register `submit_result` typed by it there.
		outputSchema: step.outputSchema,
		asks: step.asks,
		signal,
	})

	try {
		let message = entry.kind === "answer" ? formatAnswers(entry.answers) : freshPrompt(step, input, ctx)
		let lastViolation = ""
		let totalTokens = startingTokens

		for (let repair = 0; repair <= maxRepairs; repair++) {
			if (signal.aborted) return { kind: "cancelled" }

			let turn: AgentTurn
			try {
				turn = await session.sendAndAwaitEnd(message)
			} catch (err) {
				if (signal.aborted) return { kind: "cancelled" }
				return { kind: "retryable", reason: "thrown-error", error: err instanceof Error ? err.message : String(err) }
			}

			if (signal.aborted) return { kind: "cancelled" }

			// Token budget (spec §9.3/§9.4): accumulate usage across prompt + steering + answer turns.
			const turnTokens = turn.usage?.totalTokens ?? 0
			totalTokens += turnTokens
			if (turn.usage)
				await host.emit({ type: "agent-usage", runId: state.runId, path, totalTokens: turnTokens, at: iso(host) })
			if (step.maxTokens !== undefined && totalTokens > step.maxTokens) {
				return {
					kind: "retryable",
					reason: "budget-exceeded",
					error: `step "${step.name}" exceeded its ${step.maxTokens}-token budget (used ${totalTokens})`,
				}
			}

			const check = checkAgentTurn(step, turn)
			if (check.ok) {
				if (check.kind === "questions") {
					// Chain onto whatever conversation SEEDED this attempt (spec §8.4): an answer-resume's session
					// only ever accumulates ITS OWN local turns in `session.getConversation()` — a host that seeds
					// `entry.conversation` into outgoing calls (e.g. src/host/pi-agent.ts, across a harness restart)
					// does so without folding it back into the session's own state. Without this, a re-block of an
					// already-resumed step would record only the post-resume exchange, and a LATER resume of THAT
					// block would lose everything before the first restart — the same "forgets what it asked" gap
					// one hop further out.
					const conversation =
						entry.kind === "answer" ? [...entry.conversation, ...session.getConversation()] : session.getConversation()
					return { kind: "blocked", questionnaire: check.questions, conversation, tokensUsed: totalTokens }
				}
				return { kind: "ok", output: check.value }
			}
			lastViolation = check.violation

			if (repair < maxRepairs && steerSchema) {
				await host.emit({
					type: "agent-steer",
					runId: state.runId,
					path,
					attempt: repair + 1,
					violation: lastViolation,
					at: iso(host),
				})
				message = buildCorrectionMessage(steerSchema, lastViolation, step.asks === true)
				continue
			}

			// Repairs exhausted (or the author set maxOutputRepairs: 0): the attempt fails and falls back to
			// the repeat policy (spec §9.2/§9.3) — never a dead end in its own right.
			return { kind: "retryable", reason: "invalid-output", error: `step "${step.name}" output: ${lastViolation}` }
		}

		return { kind: "retryable", reason: "invalid-output", error: `step "${step.name}" output: ${lastViolation}` }
	} finally {
		session.dispose()
	}
}

type ReplyCheck =
	| { ok: true; kind: "result"; value: unknown }
	| { ok: true; kind: "questions"; questions: Questionnaire }
	| { ok: false; violation: string }

/**
 * Read a step's output from one turn, in order of how displaceable each channel is.
 *
 * 1. A `submit_*` tool call — a later message cannot displace it, and which tool was called says whether
 *    this is a result or a question batch, so no union needs sniffing.
 * 2. Nothing else. A step under a contract reports through the tool or not at all — assistant text is
 *    never read as output, because a later message can always displace it (81 of 159 nudged sessions
 *    lost their payload that way). A turn that submits nothing is a violation the repair loop answers.
 */
function checkAgentTurn(step: AgentStep, turn: AgentTurn): ReplyCheck {
	// No declared contract: the step acts, and whatever it said IS the output. Nothing here can fail,
	// which is the point — a step whose edits are already on disk must not be failed over formatting.
	if (step.outputSchema === undefined) return { ok: true, kind: "result", value: turn.text }

	const submitted = readSubmittedPayload(turn.submitted)
	if (!submitted) {
		return {
			ok: false,
			violation: step.asks
				? `the turn ended without calling ${SUBMIT_RESULT_TOOL} or ${SUBMIT_QUESTIONS_TOOL}`
				: `the turn ended without calling ${SUBMIT_RESULT_TOOL}`,
		}
	}

	if (submitted.kind === "malformed") {
		return { ok: false, violation: `${submitted.tool}: ${submitted.reason}` }
	}

	if (submitted.kind === "questions") {
		if (!step.asks) return { ok: false, violation: `${SUBMIT_QUESTIONS_TOOL}: this step cannot ask questions` }
		const violation = describeSchemaViolations(QuestionnaireSchema, submitted.value)
		return violation
			? { ok: false, violation: `${SUBMIT_QUESTIONS_TOOL}: ${violation}` }
			: { ok: true, kind: "questions", questions: submitted.value as Questionnaire }
	}

	const violation = describeSchemaViolations(step.outputSchema, submitted.value)
	return violation
		? { ok: false, violation: `${SUBMIT_RESULT_TOOL}: ${violation}` }
		: { ok: true, kind: "result", value: submitted.value }
}

/**
 * The fresh-run first message: the author's task prompt, plus the framework's own output contract.
 *
 * The contract is injected rather than left to the author because the engine — not the prompt — is what
 * enforces it: the submitted payload is validated against `outputSchema` either way, so a prompt that
 * omits it just fails validation for a reason the model was never told. `asks` steps get the asking
 * protocol (which names both tools and embeds both schemas); every other agent step gets the plain
 * output protocol.
 *
 * Stating it up front is what keeps the repair budget for genuine mistakes: a step that has to spend its
 * first correction learning the shape it was never told has one fewer turn to get the content right.
 */
function freshPrompt(step: AgentStep, input: unknown, ctx: RunContext): string {
	const prompt = step.buildPrompt({ input, ctx })
	// No contract to state: an acting step is asked to do the work, not to describe it in a fixed shape.
	if (step.outputSchema === undefined) return prompt
	return `${prompt}\n\n${step.asks ? buildAskingProtocol(step.outputSchema) : buildOutputProtocol(step.outputSchema)}`
}

async function retryScheduled(
	host: HostPort,
	runId: string,
	path: string,
	attempt: number,
	totalAttempts: number,
	backoffMs: number,
	reason: RetryReason,
	error: string,
): Promise<boolean> {
	if (attempt >= totalAttempts) return false
	await host.emit({ type: "step-retry", runId, path, attempt, reason, error, at: iso(host) })
	if (backoffMs > 0) await host.sleep(backoffMs)
	return true
}
