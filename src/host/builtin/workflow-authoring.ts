import { type Static, type TSchema, Type } from "typebox"
import type { WorkflowDefinition, WorkflowNode } from "../../flow/types.ts"
import { type AuthoringCapability, GENERATED_AUTHORING_REFERENCE } from "./generated/authoring-reference.ts"

/** A compact, deterministic schema language used by the creation planner. */
export type SchemaBlueprint =
	| { kind: "string"; description?: string }
	| { kind: "number"; description?: string }
	| { kind: "integer"; description?: string }
	| { kind: "boolean"; description?: string }
	| { kind: "unknown"; description?: string }
	| { kind: "literal"; value: string | number | boolean; description?: string }
	| { kind: "array"; items: SchemaBlueprint; description?: string }
	| { kind: "object"; fields: SchemaFieldBlueprint[]; description?: string }
	| { kind: "union"; variants: SchemaBlueprint[]; description?: string }

export interface SchemaFieldBlueprint {
	readonly name: string
	readonly optional?: boolean
	readonly title?: string
	readonly description?: string
	readonly schema: SchemaBlueprint
}

export interface NamedSchemaBlueprint {
	readonly name: string
	readonly description?: string
	readonly schema: SchemaBlueprint
}

export interface RetryBlueprint {
	readonly maxRetry: number
	readonly backoffMs?: number
}

export type InputSource = "previous" | "workflow" | "context" | "scope" | "none"

interface StepBlueprintBase {
	readonly name: string
	readonly description?: string
	readonly purpose: string
	readonly input?: string
	readonly output?: string
	readonly inputSource?: InputSource
	readonly retry?: RetryBlueprint
	readonly maxDurationMs?: number
	readonly optional?: boolean
}

export interface FunctionBlueprint extends StepBlueprintBase {
	readonly kind: "function"
}

export interface AgentBlueprint extends StepBlueprintBase {
	readonly kind: "agent"
	readonly mode: "act" | "report" | "ask"
	readonly model?: string
	readonly maxOutputRepairs?: number
	readonly maxTokens?: number
	readonly background?: boolean
	readonly resumable?: boolean | string
}

export interface QuestionnaireBlueprint extends StepBlueprintBase {
	readonly kind: "questionnaire"
	readonly output: string
}

export type LeafStepBlueprint = FunctionBlueprint | AgentBlueprint | QuestionnaireBlueprint

export interface MapBlueprint {
	readonly kind: "map"
	readonly name: string
	readonly purpose: string
	readonly sources: string[]
}

export interface LoopBlueprint {
	readonly kind: "loop"
	readonly name: string
	readonly purpose: string
	readonly mode: "dowhile" | "dountil"
	readonly maxIterations: number
	readonly body: WorkflowBodyBlueprint
}

export interface ForeachBlueprint {
	readonly kind: "foreach"
	readonly name: string
	readonly purpose: string
	readonly concurrency?: number
	readonly feedback?: boolean
	readonly body: WorkflowBodyBlueprint
}

export interface ParallelBlueprint {
	readonly kind: "parallel"
	readonly name: string
	readonly purpose: string
	readonly arms: LeafStepBlueprint[]
}

export interface BranchArmBlueprint {
	readonly purpose: string
	readonly body: WorkflowBodyBlueprint
}

export interface BranchBlueprint {
	readonly kind: "branch"
	readonly name: string
	readonly purpose: string
	readonly arms: BranchArmBlueprint[]
}

export interface NestedWorkflowBlueprint {
	readonly kind: "workflow"
	readonly name: string
	readonly purpose: string
	readonly body: WorkflowBodyBlueprint
}

export type BlueprintNode =
	| LeafStepBlueprint
	| MapBlueprint
	| LoopBlueprint
	| ForeachBlueprint
	| ParallelBlueprint
	| BranchBlueprint
	| NestedWorkflowBlueprint

export interface WorkflowBodyBlueprint {
	readonly name: string
	readonly description?: string
	readonly input?: string
	readonly nodes: BlueprintNode[]
}

export interface WorkflowBlueprint extends WorkflowBodyBlueprint {
	readonly description: string
	readonly summary: string
	readonly schemas: NamedSchemaBlueprint[]
	readonly defaultModel?: string
	readonly maxConcurrency?: number
}

const description = Type.Optional(Type.String())
const schemaBlueprintSchema = Type.Cyclic(
	{
		Schema: Type.Union([
			Type.Object({ kind: Type.Literal("string"), description }),
			Type.Object({ kind: Type.Literal("number"), description }),
			Type.Object({ kind: Type.Literal("integer"), description }),
			Type.Object({ kind: Type.Literal("boolean"), description }),
			Type.Object({ kind: Type.Literal("unknown"), description }),
			Type.Object({
				kind: Type.Literal("literal"),
				value: Type.Union([Type.String(), Type.Number(), Type.Boolean()]),
				description,
			}),
			Type.Object({ kind: Type.Literal("array"), items: Type.Ref("Schema"), description }),
			Type.Object({
				kind: Type.Literal("object"),
				fields: Type.Array(
					Type.Object({
						name: Type.String(),
						optional: Type.Optional(Type.Boolean()),
						title: Type.Optional(Type.String()),
						description,
						schema: Type.Ref("Schema"),
					}),
				),
				description,
			}),
			Type.Object({
				kind: Type.Literal("union"),
				variants: Type.Array(Type.Ref("Schema"), { minItems: 1 }),
				description,
			}),
		]),
	},
	"Schema",
)

const inputSourceSchema = Type.Optional(
	Type.Union([
		Type.Literal("previous"),
		Type.Literal("workflow"),
		Type.Literal("context"),
		Type.Literal("scope"),
		Type.Literal("none"),
	]),
)
const retrySchema = Type.Optional(
	Type.Object({ maxRetry: Type.Integer({ minimum: 0 }), backoffMs: Type.Optional(Type.Integer({ minimum: 0 })) }),
)
const stepBase = {
	name: Type.String(),
	description,
	purpose: Type.String(),
	input: Type.Optional(Type.String()),
	output: Type.Optional(Type.String()),
	inputSource: inputSourceSchema,
	retry: retrySchema,
	maxDurationMs: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
	optional: Type.Optional(Type.Boolean()),
}
const functionBlueprintSchema = Type.Object({ kind: Type.Literal("function"), ...stepBase })
const agentBlueprintSchema = Type.Object({
	kind: Type.Literal("agent"),
	...stepBase,
	mode: Type.Union([Type.Literal("act"), Type.Literal("report"), Type.Literal("ask")]),
	model: Type.Optional(Type.String()),
	maxOutputRepairs: Type.Optional(Type.Integer({ minimum: 0 })),
	maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
	background: Type.Optional(Type.Boolean()),
	resumable: Type.Optional(Type.Union([Type.Boolean(), Type.String()])),
})
const questionnaireBlueprintSchema = Type.Object({
	kind: Type.Literal("questionnaire"),
	...stepBase,
	output: Type.String(),
})

const blueprintNodeSchema = Type.Cyclic(
	{
		Leaf: Type.Union([functionBlueprintSchema, agentBlueprintSchema, questionnaireBlueprintSchema]),
		Body: Type.Object({
			name: Type.String(),
			description,
			input: Type.Optional(Type.String()),
			nodes: Type.Array(Type.Ref("Node"), { minItems: 1 }),
		}),
		Node: Type.Union([
			Type.Ref("Leaf"),
			Type.Object({
				kind: Type.Literal("map"),
				name: Type.String(),
				purpose: Type.String(),
				sources: Type.Array(Type.String(), {
					minItems: 1,
					description: "Bare names of prior steps/constructs whose outputs the map reads.",
				}),
			}),
			Type.Object({
				kind: Type.Literal("loop"),
				name: Type.String(),
				purpose: Type.String(),
				mode: Type.Union([Type.Literal("dowhile"), Type.Literal("dountil")]),
				maxIterations: Type.Integer({ minimum: 1 }),
				body: Type.Ref("Body"),
			}),
			Type.Object({
				kind: Type.Literal("foreach"),
				name: Type.String(),
				purpose: Type.String(),
				concurrency: Type.Optional(Type.Integer({ minimum: 1 })),
				feedback: Type.Optional(Type.Boolean()),
				body: Type.Ref("Body"),
			}),
			Type.Object({
				kind: Type.Literal("parallel"),
				name: Type.String(),
				purpose: Type.String(),
				arms: Type.Array(Type.Ref("Leaf"), { minItems: 1 }),
			}),
			Type.Object({
				kind: Type.Literal("branch"),
				name: Type.String(),
				purpose: Type.String(),
				arms: Type.Array(Type.Object({ purpose: Type.String(), body: Type.Ref("Body") }), { minItems: 1 }),
			}),
			Type.Object({
				kind: Type.Literal("workflow"),
				name: Type.String(),
				purpose: Type.String(),
				body: Type.Ref("Body"),
			}),
		]),
	},
	"Node",
)

/** Structured contract emitted by the design agent and approved by the user. */
export const workflowBlueprintSchema = Type.Object({
	name: Type.String({ description: "Workflow name in kebab-case." }),
	description: Type.String({ description: "One-line workflow description." }),
	summary: Type.String({ description: "Human-readable explanation of the proposed workflow." }),
	input: Type.Optional(Type.String({ description: "Name of the schema accepted when the workflow starts." })),
	defaultModel: Type.Optional(Type.String({ description: "Optional provider/modelId default for agent steps." })),
	maxConcurrency: Type.Optional(Type.Integer({ minimum: 1 })),
	schemas: Type.Array(Type.Object({ name: Type.String(), description, schema: schemaBlueprintSchema }), {
		description: "Named schemas referenced by workflow and step input/output fields.",
	}),
	nodes: Type.Array(blueprintNodeSchema, { minItems: 1 }),
})

export type WorkflowBlueprintOutput = Static<typeof workflowBlueprintSchema>

/** Select only the generated TSDoc/signature entries needed by this blueprint. */
export function renderAuthoringGuide(blueprint: WorkflowBlueprint): string {
	const selected = new Set<AuthoringCapability>(["steps", "data-flow"])
	visitBlueprintNodes(blueprint.nodes, (node) => {
		if (node.kind === "map") selected.add("map")
		if (node.kind === "loop") selected.add("loop")
		if (node.kind === "foreach") selected.add("foreach")
		if (node.kind === "parallel") selected.add("parallel")
		if (node.kind === "branch") selected.add("branch")
		if (node.kind === "workflow") selected.add("workflow")
		if (
			node.kind === "agent" &&
			(node.background || node.resumable || node.retry || node.maxDurationMs || node.maxTokens || node.maxOutputRepairs)
		) {
			selected.add("advanced-agent")
		}
	})
	const seen = new Set<string>()
	return [...selected]
		.flatMap((capability) => GENERATED_AUTHORING_REFERENCE[capability])
		.filter((entry) => {
			const key = `${entry.symbol}\n${entry.signature}`
			if (seen.has(key)) return false
			seen.add(key)
			return true
		})
		.map((entry) => [`### ${entry.symbol}`, "```ts", entry.signature, "```", entry.documentation].join("\n"))
		.join("\n\n")
}

/** Render a complete, loadable starter module. The model replaces only explicit TODO implementations. */
export function renderWorkflowScaffold(blueprint: WorkflowBlueprint): string {
	const renderer = new BlueprintRenderer(blueprint)
	return renderer.render()
}

class BlueprintRenderer {
	private readonly declarations: string[] = []
	private readonly schemaIdentifiers = new Map<string, string>()
	private readonly usedIdentifiers = new Set<string>()

	constructor(private readonly blueprint: WorkflowBlueprint) {}

	render(): string {
		for (const schema of this.blueprint.schemas) {
			const identifier = this.uniqueIdentifier(`${schema.name}-schema`)
			this.schemaIdentifiers.set(schema.name, identifier)
			this.declarations.push(`const ${identifier} = ${renderSchema(schema.schema)}`)
		}

		const rootIdentifier = this.renderWorkflow(this.blueprint, [this.blueprint.name], true)
		return [
			'import { Type } from "typebox"',
			'import { createAgentStep, createQuestionnaireStep, createStep, createWorkflow } from "@kimchi-dev/kimchi-workflows"',
			"",
			...this.declarations,
			"",
			`export default ${rootIdentifier}`,
		].join("\n")
	}

	private renderWorkflow(body: WorkflowBodyBlueprint, path: readonly string[], root: boolean): string {
		const renderedNodes = body.nodes.map((node, index) => this.renderNode(node, [...path, String(index)]))
		const workflowIdentifier = this.uniqueIdentifier(`${path.join("-")}-workflow`)
		const options = [`name: ${quote(body.name)}`]
		if (body.description) options.push(`description: ${quote(body.description)}`)
		if (body.input) options.push(`input: ${this.schemaReference(body.input)}`)
		if (root && this.blueprint.defaultModel) options.push(`defaultModel: ${quote(this.blueprint.defaultModel)}`)
		if (root && this.blueprint.maxConcurrency !== undefined) {
			options.push(`maxConcurrency: ${this.blueprint.maxConcurrency}`)
		}

		const chain = renderedNodes.map((node) => `\n  ${node}`).join("")
		this.declarations.push(
			`const ${workflowIdentifier} = createWorkflow({ ${options.join(", ")} })${chain}\n  .commit()`,
		)
		return workflowIdentifier
	}

	private renderNode(node: BlueprintNode, path: readonly string[]): string {
		switch (node.kind) {
			case "function":
			case "agent":
			case "questionnaire": {
				const identifier = this.renderLeaf(node, path)
				return `.then(${identifier})`
			}
			case "map":
				return `.map((ctx) => {\n    // Sources: ${node.sources.join(", ")}\n    throw new Error(${quote(`TODO_WORKFLOW: ${node.purpose}`)})\n  }, { name: ${quote(node.name)} })`
			case "loop": {
				const body = this.renderWorkflow(node.body, [...path, node.name], false)
				return `.${node.mode}(\n    ${body},\n    (ctx, lastOutput) => {\n      throw new Error(${quote(`TODO_WORKFLOW: completion condition for ${node.purpose}`)})\n    },\n    { name: ${quote(node.name)}, maxIterations: ${node.maxIterations} },\n  )`
			}
			case "foreach": {
				const body = this.renderWorkflow(node.body, [...path, node.name], false)
				const options = [`name: ${quote(node.name)}`]
				if (node.concurrency !== undefined) options.push(`concurrency: ${node.concurrency}`)
				if (node.feedback !== undefined) options.push(`feedback: ${node.feedback}`)
				return `.foreach(\n    ${body},\n    (ctx) => {\n      throw new Error(${quote(`TODO_WORKFLOW: item selector for ${node.purpose}`)})\n    },\n    { ${options.join(", ")} },\n  )`
			}
			case "parallel": {
				const arms = node.arms.map((arm, index) => this.renderLeaf(arm, [...path, "arm", String(index)]))
				return `.parallel([${arms.join(", ")}], { name: ${quote(node.name)} })`
			}
			case "branch": {
				const arms = node.arms.map((arm, index) => {
					const body = this.renderWorkflow(arm.body, [...path, "arm", String(index)], false)
					return `[\n      (ctx) => {\n        throw new Error(${quote(`TODO_WORKFLOW: branch condition for ${arm.purpose}`)})\n      },\n      ${body},\n    ]`
				})
				return `.branch([\n    ${arms.join(",\n    ")}\n  ], { name: ${quote(node.name)} })`
			}
			case "workflow": {
				const body = this.renderWorkflow(node.body, [...path, node.name], false)
				return `.workflow(${body}, { name: ${quote(node.name)} })`
			}
		}
	}

	private renderLeaf(step: LeafStepBlueprint, path: readonly string[]): string {
		const identifier = this.uniqueIdentifier(`${path.join("-")}-${step.name}`)
		const fields = [`name: ${quote(step.name)}`]
		if (step.description) fields.push(`description: ${quote(step.description)}`)
		if (step.kind !== "questionnaire" && step.input) fields.push(`input: ${this.schemaReference(step.input)}`)
		if (step.output && !(step.kind === "agent" && step.mode === "act")) {
			fields.push(`output: ${this.schemaReference(step.output)}`)
		} else if (step.kind === "agent" && step.mode !== "act") {
			fields.push(
				`output: Type.Unknown({ description: ${quote(`TODO_WORKFLOW: declare an output schema for ${step.name}`)} })`,
			)
		}
		if (step.retry) {
			const retry = [`maxRetry: ${step.retry.maxRetry}`]
			if (step.retry.backoffMs !== undefined) retry.push(`backoffMs: ${step.retry.backoffMs}`)
			fields.push(`retry: { ${retry.join(", ")} }`)
		}
		if (step.maxDurationMs !== undefined) fields.push(`maxDurationMs: ${step.maxDurationMs}`)
		if (step.optional !== undefined) fields.push(`optional: ${step.optional}`)

		let stepFactory: string
		if (step.kind === "questionnaire") {
			stepFactory = "createQuestionnaireStep"
		} else if (step.kind === "function") {
			stepFactory = "createStep"
			fields.push(
				`run: ({ input, ctx, abortSignal, logger }) => {\n    throw new Error(${quote(`TODO_WORKFLOW: ${step.purpose}`)})\n  }`,
			)
		} else {
			stepFactory = "createAgentStep"
			if (step.mode === "ask") fields.push("asks: true")
			if (step.model) fields.push(`model: ${quote(step.model)}`)
			if (step.maxOutputRepairs !== undefined) fields.push(`maxOutputRepairs: ${step.maxOutputRepairs}`)
			if (step.maxTokens !== undefined) fields.push(`maxTokens: ${step.maxTokens}`)
			if (step.background !== undefined && step.mode !== "ask") fields.push(`background: ${step.background}`)
			if (step.resumable !== undefined) fields.push(`resumable: ${JSON.stringify(step.resumable)}`)
			fields.push(`prompt: ({ input, ctx }) => ${quote(`TODO_WORKFLOW: write a precise prompt for ${step.purpose}`)}`)
		}

		this.declarations.push(
			`// ${step.purpose}${step.inputSource ? `; input source: ${step.inputSource}` : ""}\nconst ${identifier} = ${stepFactory}({\n  ${fields.join(",\n  ")},\n})`,
		)
		return identifier
	}

	private schemaReference(name: string): string {
		return (
			this.schemaIdentifiers.get(name) ??
			`Type.Unknown({ description: ${quote(`TODO_WORKFLOW: declare missing schema ${name}`)} })`
		)
	}

	private uniqueIdentifier(source: string): string {
		const base = toIdentifier(source)
		let candidate = base
		let suffix = 2
		while (this.usedIdentifiers.has(candidate)) {
			candidate = `${base}_${suffix}`
			suffix += 1
		}
		this.usedIdentifiers.add(candidate)
		return candidate
	}
}

function renderSchema(schema: SchemaBlueprint, metadata?: Pick<SchemaFieldBlueprint, "title" | "description">): string {
	const optionFields: string[] = []
	if (metadata?.title) optionFields.push(`title: ${quote(metadata.title)}`)
	const schemaDescription = metadata?.description ?? schema.description
	if (schemaDescription) optionFields.push(`description: ${quote(schemaDescription)}`)
	const options = optionFields.length > 0 ? `{ ${optionFields.join(", ")} }` : undefined
	switch (schema.kind) {
		case "string":
			return `Type.String(${options ?? ""})`
		case "number":
			return `Type.Number(${options ?? ""})`
		case "integer":
			return `Type.Integer(${options ?? ""})`
		case "boolean":
			return `Type.Boolean(${options ?? ""})`
		case "unknown":
			return `Type.Unknown(${options ?? ""})`
		case "literal":
			return `Type.Literal(${JSON.stringify(schema.value)}${options ? `, ${options}` : ""})`
		case "array":
			return `Type.Array(${renderSchema(schema.items)}${options ? `, ${options}` : ""})`
		case "object": {
			const fields = schema.fields.map((field) => {
				const rendered = renderSchema(field.schema, field)
				return `${quoteProperty(field.name)}: ${field.optional ? `Type.Optional(${rendered})` : rendered}`
			})
			return `Type.Object({ ${fields.join(", ")} }${options ? `, ${options}` : ""})`
		}
		case "union":
			return `Type.Union([${schema.variants.map((variant) => renderSchema(variant)).join(", ")}]${options ? `, ${options}` : ""})`
	}
}

/** Reject unfinished or structurally divergent generated source before it is written. */
export function describeSourceConformance(
	blueprint: WorkflowBlueprint,
	source: string,
	workflow: WorkflowDefinition,
): string | undefined {
	if (source.includes("TODO_WORKFLOW")) return "generated source still contains TODO_WORKFLOW scaffold placeholders"
	if (workflow.name !== blueprint.name) {
		return `generated workflow is named "${workflow.name}", but the approved blueprint is named "${blueprint.name}"`
	}
	return compareBody(blueprint, workflow)
}

function compareBody(blueprint: WorkflowBodyBlueprint, workflow: WorkflowDefinition): string | undefined {
	if (workflow.name !== blueprint.name) {
		return `expected workflow name "${blueprint.name}", got "${workflow.name}"`
	}
	if (workflow.nodes.length !== blueprint.nodes.length) {
		return `workflow "${blueprint.name}" has ${workflow.nodes.length} nodes; the approved blueprint requires ${blueprint.nodes.length}`
	}
	for (let index = 0; index < blueprint.nodes.length; index += 1) {
		const expected = blueprint.nodes[index]
		const actual = workflow.nodes[index]
		if (!expected || !actual) continue
		const issue = compareNode(expected, actual)
		if (issue) return `workflow "${blueprint.name}" node ${index + 1}: ${issue}`
	}
	return undefined
}

function compareNode(expected: BlueprintNode, actual: WorkflowNode): string | undefined {
	if (expected.kind === "function" || expected.kind === "agent" || expected.kind === "questionnaire") {
		if (actual.kind !== "step") return `expected ${expected.kind} step "${expected.name}", got ${actual.kind}`
		if (actual.step.name !== expected.name || actual.step.kind !== expected.kind) {
			return `expected ${expected.kind} step "${expected.name}", got ${actual.step.kind} step "${actual.step.name}"`
		}
		if (expected.kind === "agent") {
			if (actual.step.kind !== "agent") return `expected agent step "${expected.name}"`
			if (expected.mode === "act" && actual.step.outputSchema !== undefined) {
				return `acting agent "${expected.name}" unexpectedly declares an output schema`
			}
			if (expected.mode !== "act" && actual.step.outputSchema === undefined) {
				return `agent "${expected.name}" must declare its approved output schema`
			}
			if ((expected.mode === "ask") !== (actual.step.asks === true)) {
				return `agent "${expected.name}" does not match approved ${expected.mode} mode`
			}
		}
		return undefined
	}
	if (expected.kind === "map") {
		return actual.kind === "step" && actual.step.name === expected.name
			? undefined
			: `expected map "${expected.name}", got ${actual.kind}`
	}
	if (expected.kind === "loop") {
		if (actual.kind !== "loop" || actual.name !== expected.name || actual.mode !== expected.mode) {
			return `expected ${expected.mode} loop "${expected.name}", got ${actual.kind}`
		}
		return compareBody(expected.body, actual.body)
	}
	if (expected.kind === "foreach") {
		if (actual.kind !== "foreach" || actual.name !== expected.name) {
			return `expected foreach "${expected.name}", got ${actual.kind}`
		}
		return compareBody(expected.body, actual.body)
	}
	if (expected.kind === "parallel") {
		if (actual.kind !== "parallel" || actual.name !== expected.name) {
			return `expected parallel "${expected.name}", got ${actual.kind}`
		}
		const actualNames = actual.arms.map((arm) => arm.name)
		const expectedNames = expected.arms.map((arm) => arm.name)
		return JSON.stringify(actualNames) === JSON.stringify(expectedNames)
			? undefined
			: `parallel arms ${JSON.stringify(actualNames)} do not match ${JSON.stringify(expectedNames)}`
	}
	if (expected.kind === "branch") {
		if (actual.kind !== "branch" || actual.name !== expected.name || actual.arms.length !== expected.arms.length) {
			return `expected branch "${expected.name}" with ${expected.arms.length} arms, got ${actual.kind}`
		}
		for (let index = 0; index < expected.arms.length; index += 1) {
			const expectedArm = expected.arms[index]
			const actualArm = actual.arms[index]
			if (expectedArm && actualArm) {
				const issue = compareBody(expectedArm.body, actualArm.body)
				if (issue) return issue
			}
		}
		return undefined
	}
	if (actual.kind !== "workflow" || actual.name !== expected.name) {
		return `expected nested workflow "${expected.name}", got ${actual.kind}`
	}
	return compareBody(expected.body, actual.workflow)
}

function visitBlueprintNodes(nodes: readonly BlueprintNode[], visit: (node: BlueprintNode) => void): void {
	for (const node of nodes) {
		visit(node)
		if (node.kind === "loop" || node.kind === "foreach" || node.kind === "workflow") {
			visitBlueprintNodes(node.body.nodes, visit)
		} else if (node.kind === "branch") {
			for (const arm of node.arms) visitBlueprintNodes(arm.body.nodes, visit)
		} else if (node.kind === "parallel") {
			for (const arm of node.arms) visit(arm)
		}
	}
}

function quote(value: string): string {
	return JSON.stringify(value)
}

function quoteProperty(value: string): string {
	return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) ? value : quote(value)
}

function toIdentifier(value: string): string {
	const cleaned = value.replace(/[^A-Za-z0-9_$]+/g, "_").replace(/^_+|_+$/g, "") || "workflow_value"
	return /^[A-Za-z_$]/.test(cleaned) ? cleaned : `_${cleaned}`
}

/** The schema type is exported for focused drift tests without coupling them to the creation workflow. */
export const authoringSchemas: Readonly<{ workflowBlueprint: TSchema }> = {
	workflowBlueprint: workflowBlueprintSchema,
}
