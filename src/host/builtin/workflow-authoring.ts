import { type Static, Type } from "typebox"

/** A logical workflow step. It describes behavior rather than framework constructs. */
const workflowStepPlanSchema = Type.Object({
	title: Type.String({ description: "Short, user-facing name for this part of the workflow." }),
	purpose: Type.String({ description: "What this part accomplishes." }),
	receives: Type.Array(Type.String(), {
		description: "Information available to this part. Empty when it starts from project or ambient context.",
	}),
	produces: Type.Array(Type.String(), {
		description: "Information made available to later parts. Empty when this part only performs an effect.",
	}),
	delivers: Type.Array(Type.String(), {
		description: "User-visible results or observable effects delivered here, not necessarily at the end.",
	}),
})

/**
 * The complete authoring and approval contract: enough behavior to implement, with no source design.
 * Every material answer must become a criterion, decision, step, information hand-off, or delivery.
 */
export const workflowPlanSchema = Type.Object({
	goal: Type.String({ description: "The overall outcome the user wants." }),
	summary: Type.String({ description: "A short explanation of how the workflow achieves the goal." }),
	acceptanceCriteria: Type.Array(Type.String(), {
		minItems: 1,
		description: "Observable conditions that make the first version successful.",
	}),
	decisions: Type.Array(Type.String(), {
		description: "Material user answers, explicit exclusions, and behaviorally relevant inferred choices.",
	}),
	name: Type.String({ description: "The concise kebab-case workflow name derived from the user's goal." }),
	invocation: Type.Object({
		requiresArguments: Type.Boolean({
			description: "False by default; true only when the user explicitly wants command arguments.",
		}),
		reason: Type.Optional(Type.String({ description: "Why arguments are required when the value is true." })),
	}),
	steps: Type.Array(workflowStepPlanSchema, { minItems: 1 }),
})

export type WorkflowPlan = Static<typeof workflowPlanSchema>

export interface WorkflowTarget {
	readonly entryPath: string
}

/** Render the exact behavior-focused document shown for approval. */
export function renderWorkflowPlan(plan: WorkflowPlan, target: WorkflowTarget): string {
	return [
		"# Proposed workflow",
		"",
		plan.goal,
		"",
		plan.summary,
		"",
		"## Acceptance criteria",
		"",
		...plan.acceptanceCriteria.map((criterion) => `- ${criterion}`),
		"",
		"## Flow",
		"",
		...renderPlanSteps(plan.steps),
		...(plan.decisions.length > 0
			? ["", "## Confirmed decisions", "", ...plan.decisions.map((item) => `- ${item}`)]
			: []),
		"",
		"## Run and edit",
		"",
		`- Command: ${inlineCode(
			plan.invocation.requiresArguments ? `/workflow run ${plan.name} --input …` : `/workflow run ${plan.name}`,
		)}`,
		...(plan.invocation.requiresArguments && plan.invocation.reason ? [`- Arguments: ${plan.invocation.reason}`] : []),
		`- Workflow: ${inlineCode(target.entryPath)}`,
	].join("\n")
}

function renderPlanSteps(steps: WorkflowPlan["steps"]): string[] {
	return steps.flatMap((step, index) => [
		`${index + 1}. **${step.title}** — ${step.purpose}`,
		`   - Receives: ${describeList(step.receives, "nothing from an earlier step")}`,
		`   - Makes available: ${describeList(step.produces, "no information for later steps")}`,
		...(step.delivers.length > 0 ? [`   - Delivers here: ${step.delivers.join("; ")}`] : []),
	])
}

function describeList(values: readonly string[], empty: string): string {
	return values.length > 0 ? values.join("; ") : empty
}

function inlineCode(value: string): string {
	return `\`${value.replaceAll("`", "\\`")}\``
}
