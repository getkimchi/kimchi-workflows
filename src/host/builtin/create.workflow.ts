/**
 * The `/workflow create` meta-workflow: a workflow that writes workflows.
 *
 * It is an ordinary `WorkflowDefinition` — same authoring API, same engine, same event log — which
 * means it blocks, resumes, retries, and is testable exactly like any workflow a user writes.
 *
 * Shape (six top-level nodes, spec §6.6):
 *
 *   brief          questionnaire step — what to build, and what to call the file
 *   target         function            — settle the destination, failing fast on a bad or taken name
 *   review         loop (.dountil)     — design proposes/revises a plan; approve asks approve/revise
 *     design         Q&A agent           — interview → propose (or revise) a blueprint
 *     plan-document  function            — deterministically render blueprint Markdown
 *     approve        interactive         — show Markdown and collect approve/revise feedback
 *   scaffold       function            — reserve the final entry path with a deterministic starter module
 *   until-valid    loop                — edit files in place, validate the entry graph, retry on failure
 *   complete       function            — report the already-written, validated entry path
 *
 * The approval step persists its exact plan document and lets the attended host render it through PI
 * after the engine releases the project lock. Revision is still an ordinary `.dountil` iteration.
 */
import { existsSync } from "node:fs"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent"
import { Markdown } from "@earendil-works/pi-tui"
import { type Static, Type } from "typebox"
import {
	createAgentStep,
	createInteractiveStep,
	createQuestionnaireStep,
	createStep,
	createWorkflow,
} from "../../flow/index.ts"
import type { InteractionRenderArgs, RunContext } from "../../flow/types.ts"
import { WORKFLOW_SUFFIX } from "../load-workflow.ts"
import { validateWorkflowFile } from "../workflow-candidate-validator.ts"
import {
	describeSourceConformance,
	renderAuthoringGuide,
	renderWorkflowPlan,
	renderWorkflowScaffold,
	type WorkflowBlueprint,
	workflowBlueprintSchema,
} from "./workflow-authoring.ts"

/**
 * Initial input: the extension supplies the project root so steps can resolve paths without a cwd
 * assumption, and the workflows directory as the RUNNING harness names it (`.<app>/workflows/`,
 * project-dir.ts). The directory arrives as DATA because this module may not compute it: it is loaded
 * back through `loadWorkflowFile`'s restricted loader (on resume, and by the attended loop), where
 * project-dir.ts's `@earendil-works/pi-coding-agent` import does not resolve.
 */
export const createInputSchema = Type.Object({
	projectRoot: Type.String(),
	workflowsDir: Type.Optional(Type.String()),
})

/** What the interview must establish before any code is generated. */
export const specSchema = workflowBlueprintSchema

const briefSchema = Type.Object({
	goal: Type.String({ title: "Goal", description: "What should this workflow do?", chat: true }),
	fileName: Type.String({
		title: "File name",
		description: "File to write, e.g. `deploy.workflow.ts` (saved under the project's workflows directory).",
	}),
})

/** The Approve/Revise response returned by the workflow-defined PI renderer. */
const approveSchema = Type.Object({
	decision: Type.Union([Type.Literal("approve"), Type.Literal("revise")], {
		title: "Decision",
		description: "Approve the plan above, or ask for changes?",
	}),
	feedback: Type.Optional(Type.String({ title: "Feedback", description: "If revising, what should change?" })),
})

/** Exact review payload persisted in the interaction event and rendered again after process restart. */
const planDocumentSchema = Type.Object({
	blueprint: specSchema,
	markdown: Type.String(),
})

const generatedFilesSchema = Type.Object({
	entryPath: Type.String({
		description: "Path to the main .workflow.ts entry file written on disk. Do not submit source code here.",
	}),
	/**
	 * Any additional check the agent performed itself. The framework independently runs its mandatory
	 * TypeScript/runtime/conformance checks.
	 */
	verification: Type.String({ description: "Any extra checks you ran, or `framework validation only`." }),
})
const checkSchema = Type.Object({
	ok: Type.Boolean(),
	entryPath: Type.String(),
	error: Type.Optional(Type.String()),
	// Carried through from `generate`'s output (names-only addressing, spec 4.1): the loop's output is
	// the body's LAST step's output, so anything a downstream reader needs must ride in it — `complete`
	// reads this from its own input rather than path-reaching into the loop's internals.
	verification: Type.Optional(Type.String()),
})

/** Step 1 — the opening form. Deterministic, no LLM: two questions derived from the schema. */
const brief = createQuestionnaireStep({
	name: "brief",
	description: "What to build, and where to put it",
	output: briefSchema,
})

/**
 * Step 2 — settle the destination before spending anything on it.
 *
 * `resolveTarget` rejects a name that escapes the project or is already taken, and both are knowable
 * the moment the form is answered. Checking here costs milliseconds; checking only after the review
 * would burn the whole interview first. `scaffold` later repeats the availability guarantee with an
 * exclusive create, covering the filesystem race between these two points.
 */
const settleTarget = createStep({
	name: "target",
	description: "Settle where the workflow will be written",
	output: Type.Object({ path: Type.String() }),
	run: ({ ctx }) => ({ path: resolveTarget(ctx) }),
})

/**
 * Step 3a — the interview (spec §6.6). Runs once per `review` iteration: on the first pass it
 * clarifies and proposes a plan; on a later pass (an `approve` re-block recorded "revise") it
 * incorporates that feedback into a revised plan. The framework injects the asking protocol, so this
 * prompt is task-only.
 */
const design = createAgentStep({
	name: "design",
	description: "Interview the user (first pass) or incorporate feedback (a revision pass), and propose a plan",
	// No input schema (spec §3.6): the preceding node is `target`, so the brief is read from run
	// context rather than the linear hand-off.
	output: specSchema,
	asks: true,
	prompt: ({ ctx }) => {
		const goal = ctx.getStepResult<Static<typeof briefSchema>>("brief")?.goal ?? "(not stated)"
		const priorApproval = ctx.getStepResult<Static<typeof approveSchema>>("approve")

		if (!priorApproval) {
			return [
				"You are designing a PI workflow on the user's behalf.",
				"",
				`Their goal: ${goal}`,
				"",
				"Ask batched questions until you genuinely know what to build: its initial input, schemas, data",
				"sources, control-flow constructs, which steps need an LLM or user input, and how it finishes.",
				"Represent that design in the structured blueprint schema you were given. Use a named schema for",
				"every workflow/step input or output. A schema reference must exactly match an entry in `schemas`.",
				"Schema `kind` is exactly one of: string, number, integer, boolean, unknown, literal, array, object,",
				"or union. Object schemas use `fields`; array schemas use `items`. Do not emit TypeBox source here.",
				"Use mode `act` for an agent whose product is side effects, `report` for structured output, and",
				"`ask` only when the agent itself must clarify. Do not put asking agents in parallel/foreach fan-out.",
				"Do not guess at anything that would change generated behavior. Do not ask what you can infer.",
				"",
				"Once confident, emit your result: a proposed plan. Do NOT ask for approval yourself — a",
				"separate step presents your plan and collects the decision.",
			].join("\n")
		}

		// A revision pass: `approve` re-blocked with "revise" (spec §8.5 — this step is being re-entered
		// inside the SAME `review` loop iteration's body, not restarted from scratch).
		return [
			"The user asked to REVISE the plan you proposed. Their goal, for reference:",
			`  ${goal}`,
			"",
			`Feedback: ${priorApproval.feedback || "(no specific feedback given — use your judgment)"}`,
			"",
			"Incorporate it and propose a revised plan. Ask brief clarifying questions only if genuinely",
			"needed; otherwise emit your revised result directly. Do NOT ask for approval yourself.",
		].join("\n")
	},
})

/** Step 3b — deterministically turn the structured blueprint into the exact Markdown to review. */
const planDocument = createStep({
	name: "plan-document",
	description: "Render the proposed workflow as Markdown without another model turn",
	input: specSchema,
	output: planDocumentSchema,
	run: ({ input }) => ({ blueprint: input, markdown: renderWorkflowPlan(input) }),
})

const PLAN_WIDGET_KEY = "workflow-create-plan-review"

/**
 * PI 0.79.10 plan review: Markdown remains visible in a transient widget while native selection and
 * multiline editor dialogs collect the decision. `select` is used instead of `confirm`, whose false
 * result cannot distinguish rejection from dismissal.
 */
export async function renderPlanReview({
	request,
	ui,
	mode,
	hasUI,
	write,
}: InteractionRenderArgs<Static<typeof planDocumentSchema>>) {
	const plan = request
	if (!hasUI) {
		write(plan.markdown)
		write("This workflow is waiting for approval. Resume it in TUI or RPC mode to respond.")
		return undefined
	}

	try {
		if (mode === "tui") {
			ui.setWidget(PLAN_WIDGET_KEY, () => new Markdown(plan.markdown, 1, 0, getMarkdownTheme()), {
				placement: "aboveEditor",
			})
		} else {
			// RPC/ACP transports serialize widget lines; component factories exist only inside the TUI.
			ui.setWidget(PLAN_WIDGET_KEY, plan.markdown.split("\n"), { placement: "aboveEditor" })
		}
		const decision = await ui.select("Review proposed workflow", ["Approve", "Revise"])
		if (decision === undefined) return undefined
		if (decision === "Approve") return { decision: "approve" as const }
		if (decision !== "Revise") return undefined
		for (;;) {
			const feedback = await ui.editor("What should change?", "")
			if (feedback === undefined) return undefined
			const trimmed = feedback.trim()
			if (trimmed) return { decision: "revise" as const, feedback: trimmed }
			ui.notify("Revision feedback cannot be empty.", "warning")
		}
	} finally {
		ui.setWidget(PLAN_WIDGET_KEY, undefined)
	}
}

/** Step 3c — block on the exact plan document and let the attended host invoke the renderer above. */
const approve = createInteractiveStep({
	name: "approve",
	description: "Approve the plan design just proposed, or ask for changes",
	input: planDocumentSchema,
	request: planDocumentSchema,
	output: approveSchema,
	buildRequest: ({ input }) => input,
	render: renderPlanReview,
})

/**
 * The `review` loop's output must carry everything downstream readers need (names-only addressing,
 * spec 4.1): a loop's output is its body's LAST step's output, and `generate` — a sibling construct,
 * outside this loop's scope — reads the approved plan from it by the loop's bare name. This tail step
 * widens the approval decision with the plan itself, replacing `generate`'s old path-form reach into
 * `review/design`.
 */
const reviewOutcomeSchema = Type.Object({
	decision: approveSchema.properties.decision,
	feedback: Type.Optional(Type.String()),
	plan: specSchema,
})
const reviewOutcome = createStep({
	name: "review-outcome",
	description: "Bundle the approval decision with the plan it approved",
	input: approveSchema,
	output: reviewOutcomeSchema,
	run: ({ input, ctx }) => {
		const document = ctx.getStepResult<Static<typeof planDocumentSchema>>("plan-document")
		if (!document) throw new Error("review-outcome: the plan-document step produced no plan")
		return { decision: input.decision, feedback: input.feedback, plan: document.blueprint }
	},
})

const reviewBody = createWorkflow({ name: "review-body" })
	.then(design)
	.then(planDocument)
	.then(approve)
	.then(reviewOutcome)
	.commit()

/**
 * Step 4 — claim the final entry path and put the deterministic scaffold there.
 *
 * The exclusive write closes the race between `target`'s early availability check and authoring: if
 * another process creates the requested file while the user is reviewing the plan, creation fails
 * here rather than handing an agent permission to overwrite it. From this point on the entry file is
 * this run's workspace and the agent may edit it in place.
 */
const scaffold = createStep({
	name: "scaffold",
	description: "Reserve the final entry path with the approved workflow scaffold",
	input: reviewOutcomeSchema,
	output: Type.Object({ entryPath: Type.String() }),
	run: async ({ input, ctx }) => {
		const entryPath = plannedTarget(ctx)
		await mkdir(path.dirname(entryPath), { recursive: true })
		try {
			await writeFile(entryPath, renderWorkflowScaffold(input.plan), { encoding: "utf8", flag: "wx" })
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				throw new Error(`workflow entry appeared before it could be reserved at ${entryPath}; choose another name`)
			}
			throw error
		}
		return { entryPath }
	},
})

/**
 * Step 5a — author the workflow files directly at their final location. On a retry the previous
 * validation error is in run context, so the same agent can inspect and repair the files in place.
 */
const generate = createAgentStep({
	name: "generate",
	description: "Edit the workflow entry file and any helper modules in place",
	// Deliberately no input schema (spec §3.6): on a retry the loop hands this step the previous
	// iteration's `check` output, not the spec — so the spec is read from run context instead.
	output: generatedFilesSchema,
	prompt: ({ ctx }) => {
		// `design` lives inside the `review` loop, a SIBLING of `until-valid` — outside this step's
		// lexical scope. The approved plan rides the review loop's own OUTPUT (review-outcome), read here
		// by the loop's bare name (names-only addressing, spec 4.1).
		const input = ctx.getStepResult<{ plan: WorkflowBlueprint }>("review")?.plan
		if (!input) throw new Error("generate: the review loop produced no approved plan")
		const entryPath = plannedTarget(ctx)
		const previous = ctx.getStepResult<{ ok: boolean; entryPath?: string; error?: string }>("check")
		const retry = previous?.error
			? [
					"",
					"The files currently on disk FAILED validation with:",
					previous.error,
					"Inspect the entry file and its imports, then repair them in place. Keep the deterministic",
					"structure unless the diagnostic requires a change.",
				]
			: []
		return [
			"Complete the PI workflow by editing files directly in the project.",
			"A deterministic scaffold has already been written to the final entry file:",
			`  ${entryPath}`,
			"Use your filesystem tools to read and edit that file in place. You may create helper .ts files",
			"when useful and import them with relative paths from the entry module. Do not edit unrelated files.",
			"",
			"APPROVED BLUEPRINT:",
			JSON.stringify(input, null, 2),
			"",
			"RELEVANT AUTHORING API:",
			renderAuthoringGuide(input),
			"",
			"Requirements:",
			"  - save all implementation changes to disk; do not return source code through submit_result",
			"  - replace every TODO_WORKFLOW placeholder with working semantic code",
			"  - preserve the scaffold's imports, schemas, node names/kinds, control-flow shape, and export",
			"  - an acting (`mode: act`) agent intentionally has no output schema; report/ask agents do",
			"  - use only real API signatures from the generated authoring reference above",
			"  - no side effects at import time — the module must only define and export the workflow",
			`  - submit entryPath as exactly ${JSON.stringify(entryPath)} after the files have been saved`,
			"",
			"The framework will typecheck the on-disk entry module and its imports, load it, and compare its structure to the",
			"approved blueprint. Formatting is not part of candidate validation.",
			"In `verification`, state any extra check you actually ran; say `framework validation only` otherwise.",
			"",
			...retry,
		].join("\n")
	},
})

/**
 * Where the generated workflow will land. A bare name goes to the project's workflows directory
 * (`.<app>/workflows/`, project-dir.ts) so the new workflow is immediately discoverable by
 * `/workflow list` and runnable by name; anything containing a separator is a path relative to the
 * project root.
 */
function resolveTarget(ctx: RunContext): string {
	const init = ctx.getInitData<Static<typeof createInputSchema>>() ?? { projectRoot: process.cwd() }
	const projectRoot = init.projectRoot
	// `.pi` is the same "we are not being told a name" fallback project-dir.ts documents; the extension
	// always passes the real directory.
	const workflowsDir = init.workflowsDir ?? path.join(projectRoot, ".pi", "workflows")
	const { fileName } = ctx.getStepResult<{ fileName: string }>("brief") ?? { fileName: "untitled.workflow.ts" }
	const named = fileName.endsWith(".ts") ? fileName : `${fileName}${WORKFLOW_SUFFIX}`
	const target =
		named.includes(path.sep) || named.includes("/") ? path.resolve(projectRoot, named) : path.join(workflowsDir, named)

	// Containment: `/workflow create` writes into the project, never outside it. `fileName` is free
	// text from the opening form, so `../../elsewhere.ts` would otherwise resolve anywhere on disk.
	const root = path.resolve(projectRoot)
	if (target !== root && !target.startsWith(root + path.sep)) {
		throw new Error(`"${fileName}" resolves outside the project (${target}); choose a name inside ${root}`)
	}

	assertAvailable(target, fileName)
	return target
}

/** Read the destination settled by `target` without re-running its "must not exist" preflight. */
function plannedTarget(ctx: RunContext): string {
	const target = ctx.getStepResult<{ path: string }>("target")?.path
	if (!target) throw new Error("the target step did not settle a workflow entry path")
	return path.resolve(target)
}

/** Resolve a submitted absolute or project-relative entry path for an exact comparison with the plan. */
function resolveSubmittedEntryPath(entryPath: string, projectRoot: string): string {
	return path.isAbsolute(entryPath) ? path.resolve(entryPath) : path.resolve(projectRoot, entryPath)
}

/**
 * Read the entry module and every local TypeScript module it statically imports or re-exports.
 *
 * Runtime conformance can prove the exported workflow's shape, but it does not call step bodies. A
 * `TODO_WORKFLOW` throw moved into a helper would therefore survive both typechecking and loading if
 * conformance inspected only the entry source. TypeScript remains the authority for full resolution;
 * this small traversal exists solely to keep deterministic scaffold placeholders out of any authored
 * module that belongs to the entry graph.
 */
async function readAuthoredModuleGraph(entryPath: string): Promise<string> {
	const visited = new Set<string>()
	const sources: string[] = []

	async function visit(file: string): Promise<void> {
		const resolved = path.resolve(file)
		if (visited.has(resolved)) return
		visited.add(resolved)
		const source = await readFile(resolved, "utf8")
		sources.push(source)
		for (const specifier of relativeModuleSpecifiers(source)) {
			const imported = await resolveRelativeTypeScriptModule(path.dirname(resolved), specifier)
			if (imported) await visit(imported)
		}
	}

	await visit(entryPath)
	return sources.join("\n")
}

function relativeModuleSpecifiers(source: string): string[] {
	const matches = source.matchAll(/\b(?:import|export)\s+(?:[^"'`]*?\s+from\s+)?["'](\.[^"']+)["']/g)
	return [...matches].flatMap((match) => (match[1] ? [match[1]] : []))
}

async function resolveRelativeTypeScriptModule(directory: string, specifier: string): Promise<string | undefined> {
	const base = path.resolve(directory, specifier)
	const extension = path.extname(base)
	const candidates = extension
		? [base, ...(extension === ".js" ? [`${base.slice(0, -3)}.ts`] : [])]
		: [
				`${base}.ts`,
				`${base}.tsx`,
				`${base}.mts`,
				`${base}.cts`,
				path.join(base, "index.ts"),
				path.join(base, "index.tsx"),
			]
	for (const candidate of candidates) {
		try {
			if ((await stat(candidate)).isFile()) return candidate
		} catch {
			// TypeScript reports a missing import later; this traversal only follows files that exist.
		}
	}
	return undefined
}

/**
 * Refuse to write over an existing file. Generating a workflow must never destroy one, and quietly
 * choosing a different name would be worse than failing: the run would report success while the file
 * the user asked for still holds something else.
 *
 * Enforced from {@link resolveTarget}, so the ordinary clash surfaces before the review. The
 * `scaffold` step repeats the guarantee atomically with an exclusive create after approval.
 */
function assertAvailable(target: string, fileName: string): void {
	if (existsSync(target)) {
		throw new Error(`"${fileName}" already exists at ${target}; delete or rename it, or re-run with a different name`)
	}
}

/**
 * Step 5b — validate the files statically and dynamically at their final locations.
 *
 * TypeScript begins at the submitted entry and follows relative imports. The runtime loader then loads
 * that same entry graph, and conformance compares its exported workflow with the approved blueprint.
 */
const check = createStep({
	name: "check",
	description: "Typecheck, load, and compare the on-disk workflow",
	input: generatedFilesSchema,
	output: checkSchema,
	run: async ({ input, ctx, abortSignal }) => {
		const init = ctx.getInitData<Static<typeof createInputSchema>>() ?? { projectRoot: process.cwd() }
		const target = plannedTarget(ctx)
		try {
			const entryPath = resolveSubmittedEntryPath(input.entryPath, init.projectRoot)
			if (entryPath !== target) {
				throw new Error(
					`submitted entryPath resolves to ${entryPath}, but this run reserved ${target}; edit and submit the reserved entry file`,
				)
			}
			const plan = ctx.getStepResult<{ plan: WorkflowBlueprint }>("review")?.plan
			if (!plan) throw new Error("check: the review loop produced no approved plan")
			const source = await readAuthoredModuleGraph(entryPath)
			const validation = await validateWorkflowFile({
				entryPath,
				projectRoot: init.projectRoot,
				signal: abortSignal,
				conformance: (workflow) => describeSourceConformance(plan, source, workflow),
			})
			return {
				ok: true,
				entryPath,
				verification: `${input.verification}; framework: ${validation.summary}`,
			}
		} catch (err) {
			if (abortSignal.aborted) throw err
			return {
				ok: false,
				entryPath: input.entryPath,
				error: err instanceof Error ? err.message : String(err),
				verification: input.verification,
			}
		}
	},
})

const generateAndCheck = createWorkflow({ name: "generate-and-check" }).then(generate).then(check).commit()

/** Step 6 — report the entry that is already written and validated. */
const complete = createStep({
	name: "complete",
	description: "Report the validated workflow entry path",
	input: checkSchema,
	output: Type.Object({ path: Type.String() }),
	run: ({ input, ctx, logger }) => {
		if (!input.ok) throw new Error("complete: validation did not pass")
		const target = plannedTarget(ctx)
		// `generate` lives inside the `until-valid` loop; its verification rides the loop's output
		// (checkSchema) into this step's own input — no reaching into the loop's internals (spec 4.1).
		if (input.verification) logger.info(`validation: ${input.verification}`)
		return { path: target }
	},
})

const createWorkflowWorkflow = createWorkflow({
	name: "create-workflow",
	description: "Interview the user and generate a new workflow file",
	input: createInputSchema,
})
	.then(brief)
	.then(settleTarget)
	.dountil(reviewBody, (_ctx, lastOutput) => (lastOutput as Static<typeof approveSchema>).decision === "approve", {
		name: "review",
		maxIterations: 10,
	})
	.then(scaffold)
	.dountil(generateAndCheck, (ctx) => ctx.getStepResult<{ ok: boolean }>("check")?.ok === true, {
		name: "until-valid",
		maxIterations: 3,
	})
	.then(complete)
	.commit()

export default createWorkflowWorkflow
