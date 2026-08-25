/**
 * The `/workflow create` meta-workflow: goal → clarify → review behavior → implement → prove.
 *
 * The approval contract is intentionally smaller than the implementation. It records what the user
 * wants, how information moves, and where observable results or effects occur. Framework constructs
 * and source-level policies are selected only after approval, while writing the simplest useful first
 * version.
 */
import { mkdir, readdir, stat, writeFile } from "node:fs/promises"
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
import { prepareWorkflowPackage } from "../workflow-package.ts"
import { verifyWorkflowTest, WorkflowTestInfrastructureError } from "../workflow-test-verifier.ts"
import { renderAuthoringGuidance } from "./authoring-guidance.ts"
import { renderWorkflowPlan, type WorkflowPlan, workflowPlanSchema } from "./workflow-authoring.ts"

/** Project locations supplied by the host; no user-facing command arguments are required. */
export const createInputSchema = Type.Object({
	projectRoot: Type.String(),
	workflowsDir: Type.Optional(Type.String()),
})

const goalSchema = Type.Object({
	goal: Type.String({
		title: "Goal",
		description: "What would you like the workflow to accomplish?",
		chat: true,
	}),
})

const targetSchema = Type.Object({
	entryPath: Type.String(),
})

const proposedTargetSchema = Type.Object({
	plan: workflowPlanSchema,
	target: targetSchema,
})

const approveSchema = Type.Object({
	decision: Type.Union([Type.Literal("approve"), Type.Literal("revise")], {
		title: "Decision",
		description: "Approve the behavior above, or ask for changes?",
	}),
	feedback: Type.Optional(Type.String({ title: "Feedback", description: "If revising, what should change?" })),
})

const planDocumentSchema = Type.Object({
	plan: workflowPlanSchema,
	target: targetSchema,
	markdown: Type.String(),
})

const reviewOutcomeSchema = Type.Object({
	decision: approveSchema.properties.decision,
	feedback: Type.Optional(Type.String()),
	plan: workflowPlanSchema,
	entryPath: Type.String(),
})

const generatedFilesSchema = Type.Object({
	testPath: Type.String({ description: "The focused happy-path test file written for package verification." }),
	verification: Type.Optional(Type.String({ description: "Additional project checks actually run, if any." })),
})

const packageReadySchema = Type.Object({
	packageDirectory: Type.String(),
	verifyCommand: Type.String(),
})

const checkSchema = Type.Object({
	ok: Type.Boolean(),
	entryPath: Type.String(),
	testPath: Type.String(),
	error: Type.Optional(Type.String()),
	verification: Type.Optional(Type.String()),
})

const completionSchema = Type.Object({
	path: Type.String(),
	testPath: Type.String(),
	command: Type.String(),
	verification: Type.String(),
})

/** Ask only for the goal. Naming and technical configuration are not the user's opening burden. */
const collectGoal = createQuestionnaireStep({
	name: "goal",
	description: "Understand the outcome the user wants",
	output: goalSchema,
})

/** Interview on the first pass; preserve confirmed decisions when revising a reviewed plan. */
const design = createAgentStep({
	name: "design",
	description: "Resolve material ambiguity and propose the workflow's behavior",
	output: workflowPlanSchema,
	asks: true,
	prompt: ({ ctx }) => designPrompt(ctx),
})

const resolveTargetStep = createStep({
	name: "resolve-target",
	description: "Resolve a collision-free workflow name and project-local path",
	input: workflowPlanSchema,
	output: proposedTargetSchema,
	run: async ({ input, ctx }) => {
		const resolved = await resolveTarget(input, ctx)
		return {
			plan: { ...input, name: resolved.name },
			target: { entryPath: resolved.entryPath },
		}
	},
})

const planDocument = createStep({
	name: "plan-document",
	description: "Render the behavior and information flow for review",
	input: proposedTargetSchema,
	output: planDocumentSchema,
	run: ({ input }) => ({ ...input, markdown: renderWorkflowPlan(input.plan, input.target) }),
})

const PLAN_WIDGET_KEY = "workflow-create-plan-review"
const MAX_AUTHORING_ITERATIONS = 10

/** Render the exact persisted plan and collect an approve/revise decision. */
export async function renderPlanReview({
	request,
	ui,
	mode,
	hasUI,
	write,
}: InteractionRenderArgs<Static<typeof planDocumentSchema>>) {
	if (!hasUI) {
		write(request.markdown)
		write("This workflow is waiting for approval. Resume it in TUI or RPC mode to respond.")
		return undefined
	}

	try {
		if (mode === "tui") {
			ui.setWidget(PLAN_WIDGET_KEY, () => new Markdown(request.markdown, 1, 0, getMarkdownTheme()), {
				placement: "aboveEditor",
			})
		} else {
			ui.setWidget(PLAN_WIDGET_KEY, request.markdown.split("\n"), { placement: "aboveEditor" })
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

const approve = createInteractiveStep({
	name: "approve",
	description: "Approve the proposed behavior or request a revision",
	input: planDocumentSchema,
	request: planDocumentSchema,
	output: approveSchema,
	buildRequest: ({ input }) => input,
	render: renderPlanReview,
})

const reviewOutcome = createStep({
	name: "review-outcome",
	description: "Carry the exact reviewed behavior and destination into implementation",
	input: approveSchema,
	output: reviewOutcomeSchema,
	run: ({ input, ctx }) => {
		const document = ctx.getStepResult<Static<typeof planDocumentSchema>>("plan-document")
		if (!document) throw new Error("review-outcome: the plan-document step produced no plan")
		return {
			...input,
			plan: document.plan,
			entryPath: document.target.entryPath,
		}
	},
})

const reviewBody = createWorkflow({ name: "review-body" })
	.then(design)
	.then(resolveTargetStep)
	.then(planDocument)
	.then(approve)
	.then(reviewOutcome)
	.commit()

/** Atomically reserve the reviewed workflow path without generating a scaffold. */
const reserve = createStep({
	name: "reserve",
	description: "Reserve the approved workflow path",
	input: reviewOutcomeSchema,
	output: reviewOutcomeSchema,
	run: async ({ input }) => {
		await mkdir(path.dirname(input.entryPath), { recursive: true })
		try {
			await writeFile(input.entryPath, "", { encoding: "utf8", flag: "wx" })
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				throw new Error(
					"the reviewed workflow destination appeared before it could be reserved; revise the plan to choose another name",
				)
			}
			throw error
		}
		return input
	},
})

/** Establish the package and lockfile before asking the authoring agent to work in it. */
const preparePackage = createStep({
	name: "prepare-package",
	description: "Prepare the workflow package and its reproducible verification command",
	input: reviewOutcomeSchema,
	output: packageReadySchema,
	run: async ({ input, abortSignal, logger }) => {
		const prepared = await prepareWorkflowPackage({
			directory: path.dirname(input.entryPath),
			signal: abortSignal,
		})
		logger.info(
			prepared.installed
				? `prepared workflow package at ${prepared.directory}`
				: `workflow package already ready at ${prepared.directory}`,
		)
		return { packageDirectory: prepared.directory, verifyCommand: prepared.verifyCommand }
	},
})

/** Author clean source and a focused happy-path test directly in the project. */
const implement = createAgentStep({
	name: "implement",
	description: "Implement the approved behavior as a clean, editable workflow",
	output: generatedFilesSchema,
	prompt: ({ ctx }) => implementationPrompt(ctx),
})

/** Independently validate the workflow and confirm that the implementation supplied its project test. */
const check = createStep({
	name: "check",
	description: "Validate the workflow and its happy-path test",
	input: generatedFilesSchema,
	output: checkSchema,
	run: async ({ input, ctx, abortSignal }) => {
		const approved = approvedOutcome(ctx)
		const init = createInput(ctx)
		const packageReady = ctx.getStepResult<Static<typeof packageReadySchema>>("prepare-package")
		if (!packageReady) throw new WorkflowTestInfrastructureError("workflow package preparation produced no result")
		const entryPath = path.resolve(approved.entryPath)
		try {
			const testPath = resolveSubmittedPath(input.testPath, init.projectRoot)
			assertInsideProject(testPath, init.projectRoot, "testPath")
			if (!(await stat(testPath)).isFile()) throw new Error(`submitted testPath is not a file: ${testPath}`)

			const validation = await validateWorkflowFile({
				entryPath,
				projectRoot: init.projectRoot,
				packageRoot: packageReady.packageDirectory,
				signal: abortSignal,
			})
			if (validation.workflow.name !== approved.plan.name) {
				throw new Error(
					`authored workflow is named "${validation.workflow.name}", but the reviewed name is "${approved.plan.name}"`,
				)
			}
			if (!approved.plan.invocation.requiresArguments && validation.workflow.inputSchema) {
				throw new Error(
					"the reviewed workflow runs without arguments, but the authored workflow declares top-level input",
				)
			}

			const testVerification = await verifyWorkflowTest({
				entryPath,
				testPath,
				packageRoot: packageReady.packageDirectory,
				signal: abortSignal,
			})
			const frameworkVerification = `framework: ${validation.summary}; package: ${testVerification.summary}`

			return {
				ok: true,
				entryPath,
				testPath,
				verification: input.verification ? `${input.verification}; ${frameworkVerification}` : frameworkVerification,
			}
		} catch (error) {
			if (abortSignal.aborted) throw error
			if (error instanceof WorkflowTestInfrastructureError) throw error
			return {
				ok: false,
				entryPath,
				testPath: input.testPath,
				error: describe(error),
				verification: input.verification,
			}
		}
	},
})

const implementAndCheck = createWorkflow({ name: "implement-and-check" }).then(implement).then(check).commit()

const complete = createStep({
	name: "complete",
	description: "Report the runnable workflow and its happy-path proof",
	input: checkSchema,
	output: completionSchema,
	run: ({ input, ctx, logger }) => {
		if (!input.ok) throw new Error("complete: workflow validation and happy-path verification did not pass")
		const approved = approvedOutcome(ctx)
		const command = approved.plan.invocation.requiresArguments
			? `/workflow run ${approved.plan.name} --input …`
			: `/workflow run ${approved.plan.name}`
		const verification = input.verification ?? "TypeScript, runtime load, and happy path passed"
		logger.info(`created ${approved.entryPath}`)
		logger.info(`run with: ${command}`)
		const packageReady = ctx.getStepResult<Static<typeof packageReadySchema>>("prepare-package")
		if (packageReady) logger.info(`verify from ${packageReady.packageDirectory}: ${packageReady.verifyCommand}`)
		logger.info(`verification: ${verification}`)
		return { path: approved.entryPath, testPath: input.testPath, command, verification }
	},
})

const createWorkflowWorkflow = createWorkflow({
	name: "create-workflow",
	description: "Turn a goal into a clean, runnable, happy-path-proven workflow",
	input: createInputSchema,
})
	.then(collectGoal)
	.dountil(
		reviewBody,
		(_ctx, lastOutput) => (lastOutput as Static<typeof reviewOutcomeSchema>).decision === "approve",
		{
			name: "review",
			maxIterations: MAX_AUTHORING_ITERATIONS,
		},
	)
	.then(reserve)
	.then(preparePackage)
	.dountil(implementAndCheck, (ctx) => ctx.getStepResult<{ ok: boolean }>("check")?.ok === true, {
		name: "until-ready",
		maxIterations: MAX_AUTHORING_ITERATIONS,
	})
	.then(complete)
	.commit()

export default createWorkflowWorkflow

function designPrompt(ctx: RunContext): string {
	const goal = ctx.getStepResult<Static<typeof goalSchema>>("goal")?.goal ?? "(not stated)"
	const priorApproval = ctx.getStepResult<Static<typeof approveSchema>>("approve")
	const priorDocument = ctx.getStepResult<Static<typeof planDocumentSchema>>("plan-document")
	if (priorApproval?.decision === "revise" && priorDocument) {
		return `Revise a proposed workflow behavior after user review.

Original goal: ${goal}
Revision feedback: ${priorApproval.feedback || "Use your judgment."}

PREVIOUS REVIEWED PROPOSAL:
${JSON.stringify(priorDocument.plan, null, 2)}

Preserve every unaffected acceptance criterion and confirmed decision. Ask only if the requested revision
creates a material ambiguity; never re-ask a settled question merely to confirm it. Return the revised
behavior through workflow_submit_result. Do not ask for approval yourself.`
	}

	return `Design the first useful version of a workflow from the user's goal.

GOAL: ${goal}

First inspect the available project context and infer anything obvious. Ask only questions whose answers can
materially change the workflow's behavior, acceptance criteria, information flow, or delivery of results and
effects. Do not ask for a file name, framework construct, schema, model, timeout, retry count, token budget,
concurrency, maximum iteration count, or another implementation choice.

Batch as many useful questions as possible, but every question in one batch must be independent given what is
currently known. If the answer to one question determines whether or how another should be asked, defer the
dependent question to a later batch. Do not ask obvious questions or ask the user to repeat information already
present in the goal or project.

When it is unclear how results or effects should be exposed, ask an open question such as:
"How should the workflow expose or deliver its results, and at what point should that happen?"
Do not assume that delivery happens at the final step or that the workflow returns a final value.

Default to a workflow started with /workflow run <name> and no top-level input arguments. Only set
requiresArguments to true when the user clearly objects to that default, and record why.

When ambiguity is low enough to build a useful first version, submit one concise behavioral plan:
- convert the goal into observable acceptance criteria;
- turn every material answer into a confirmed decision, criterion, step, hand-off, or delivery point;
- break the behavior into logical steps and state what information each receives and makes available;
- attach user-visible delivery or observable effects to whichever step performs them; and
- choose a concise kebab-case name derived from the goal.

Keep it high-level. Do not encode implementation details or speculative operational constraints. Do not ask for
approval yourself; a separate interaction presents the proposal.`
}

async function resolveTarget(plan: WorkflowPlan, ctx: RunContext) {
	const init = createInput(ctx)
	const directory = init.workflowsDir ?? path.join(init.projectRoot, ".pi", "workflows")
	const files = await readdir(directory).catch(() => [] as string[])
	const occupiedFiles = new Set(files)

	const fallback = ctx.getStepResult<Static<typeof goalSchema>>("goal")?.goal ?? "workflow"
	const base = workflowSlug(plan.name || fallback)
	let workflowName = base
	let suffix = 2
	while (occupiedFiles.has(`${workflowName}${WORKFLOW_SUFFIX}`)) {
		workflowName = `${base}-${suffix}`
		suffix += 1
	}
	return {
		name: workflowName,
		entryPath: path.join(directory, `${workflowName}${WORKFLOW_SUFFIX}`),
	}
}

function workflowSlug(value: string): string {
	const slug = value
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
	return slug || "workflow"
}

function implementationPrompt(ctx: RunContext): string {
	const approved = approvedOutcome(ctx)
	const previous = ctx.getStepResult<Static<typeof checkSchema>>("check")
	const repair = previous?.error
		? `

THE CURRENT FILES FAILED INDEPENDENT VERIFICATION:
${previous.error}
Inspect the existing files, make the smallest clear repair, and resubmit the same paths.`
		: ""

	return `Implement the approved workflow directly in the project. Produce a useful first version that is easy for
its owner to read and change; future iteration is expected.

Workflow name: ${approved.plan.name}
Workflow entry: ${approved.entryPath}

APPROVED BEHAVIORAL PLAN:
${JSON.stringify(approved.plan, null, 2)}

${renderAuthoringGuidance()}

The workflow directory is already a private pnpm package with its own package.json, pnpm-lock.yaml, installed
verification toolchain, and a focused verifier. Run it from the workflow package as:
pnpm run verify:workflow -- --entry ${path.basename(approved.entryPath)} --test <colocated-test-file>

Implementation requirements:
- write complete source directly to the reserved entry path; there is no generated scaffold to preserve;
- use only public @kimchi-dev/kimchi-workflows APIs for workflow constructs; use the embedded reference above,
  then the linked public documentation or examples when more context is needed rather than guessing;
- add ordinary third-party runtime dependencies to the existing workflow package when the approved behavior needs
  them, using pnpm with that package as its directory; never use npm or yarn and do not replace its package metadata;
- use the simplest control flow that implements the approved behavior and information hand-offs;
- prefer meaningful names, small cohesive steps, and local clarity over reusable abstractions;
- add a schema only where information crosses a boundary that benefits from validation;
- do not add timeouts, retries, token or output limits, concurrency ceilings, loop limits, model overrides, or
  other operational policy unless the approved plan explicitly requires it;
- do not declare top-level workflow input unless invocation.requiresArguments is true; gather required run-specific
  information inside the workflow or derive it from project context;
- deliver results or effects at the approved step; do not manufacture a final return value when none is needed;
- declare the workflow name as exactly ${JSON.stringify(approved.plan.name)};
- keep modules free of import-time side effects and leave no placeholder implementation; and
- create helper modules only when they make the result easier to understand.

Create one concise, colocated Vitest happy-path test. Prefer the public
@kimchi-dev/kimchi-workflows/testing helpers (createTestRun, agent replies, step overrides, answers, and
interactions). Assert completion and the observable output or step effect that proves the acceptance criteria. Stub
agent, network, and destructive effects while keeping safe deterministic logic real. Do not overwrite an existing
test or use the parent repository's typecheck, lint, test configuration, or dependencies as proof. You may run the
workflow package's focused verifier against the entry and test while authoring; the framework will run that same
package-owned command after submission.

Save both files before submitting. Return the test path through workflow_submit_result. Include verification only for
additional project checks that project instructions required and that you actually ran; omit it otherwise.

The framework independently loads the workflow through its real Jiti runtime, verifies argument-free invocation
when approved, and executes the package's TypeScript and focused Vitest verification.${repair}`
}

function approvedOutcome(ctx: RunContext): Static<typeof reviewOutcomeSchema> {
	const approved = ctx.getStepResult<Static<typeof reviewOutcomeSchema>>("review")
	if (!approved) throw new Error("the review loop produced no approved behavior")
	return approved
}

function createInput(ctx: RunContext): Static<typeof createInputSchema> {
	return ctx.getInitData<Static<typeof createInputSchema>>() ?? { projectRoot: process.cwd() }
}

function resolveSubmittedPath(filePath: string, projectRoot: string): string {
	return path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(projectRoot, filePath)
}

function assertInsideProject(filePath: string, projectRoot: string, label: string): void {
	const root = path.resolve(projectRoot)
	if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
		throw new Error(`${label} resolves outside the project: ${filePath}`)
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
