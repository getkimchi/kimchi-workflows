import { Type } from "typebox"
import { Value } from "typebox/value"
import { describe, expect, it } from "vitest"
import {
	answersToOutput,
	buildAskingProtocol,
	type Question,
	QuestionnaireSchema,
	questionnaireFromSchema,
	validateAnswers,
} from "../src/flow/questionnaire.ts"

/** Find a question by key in a derived questionnaire. */
function q(schema: Parameters<typeof questionnaireFromSchema>[0], key: string): Question | undefined {
	return questionnaireFromSchema(schema).questions.find((question) => question.key === key)
}

describe("questionnaireFromSchema (Task B1: annotated schema → questionnaire)", () => {
	it("derives a single-choice question from a Type.Union of literals, with per-option descriptions", () => {
		const schema = Type.Object({
			environment: Type.Union(
				[
					Type.Literal("dev", { title: "Dev", description: "Development" }),
					Type.Literal("prod", { description: "Production" }),
				],
				{
					title: "Environment",
					description: "Which environment?",
				},
			),
		})
		const question = q(schema, "environment")
		expect(question).toMatchObject({
			key: "environment",
			header: "Environment",
			question: "Which environment?",
			kind: "single",
		})
		expect(question?.options).toEqual([
			{ value: "dev", label: "Dev", description: "Development" },
			{ value: "prod", label: "prod", description: "Production" },
		])
	})

	it("marks the option matching a field-level default as recommended", () => {
		const schema = Type.Object({
			env: Type.Union([Type.Literal("dev"), Type.Literal("prod")], { default: "prod" }),
		})
		const options = q(schema, "env")?.options ?? []
		expect(options.find((o) => o.value === "prod")?.recommended).toBe(true)
		expect(options.find((o) => o.value === "dev")?.recommended).toBeUndefined()
	})

	it("honors an explicit `recommended` annotation on a literal option", () => {
		const schema = Type.Object({
			plan: Type.Union([Type.Literal("free"), Type.Literal("pro", { recommended: true })]),
		})
		expect(q(schema, "plan")?.options?.find((o) => o.value === "pro")?.recommended).toBe(true)
	})

	it("derives a multi-choice question from a Type.Array of a union", () => {
		const schema = Type.Object({
			tags: Type.Array(Type.Union([Type.Literal("a"), Type.Literal("b"), Type.Literal("c")]), {
				description: "Pick tags",
			}),
		})
		const question = q(schema, "tags")
		expect(question).toMatchObject({ kind: "multi", question: "Pick tags" })
		expect(question?.options?.map((o) => o.value)).toEqual(["a", "b", "c"])
	})

	it("derives a text question from a plain string field", () => {
		const schema = Type.Object({ name: Type.String({ title: "Full Name", description: "What is your name?" }) })
		expect(q(schema, "name")).toMatchObject({ header: "Full Name", question: "What is your name?", kind: "text" })
		expect(q(schema, "name")?.options).toBeUndefined()
	})

	it("expands a nested Type.Object into a section (sub-fields become dotted-path questions tagged with the section)", () => {
		const schema = Type.Object({
			address: Type.Object(
				{ city: Type.String({ title: "City", description: "City?" }), zip: Type.String() },
				{ title: "Address" },
			),
		})
		const questionnaire = questionnaireFromSchema(schema)
		expect(questionnaire.questions.map((question) => question.key)).toEqual(["address.city", "address.zip"]) // parent-qualified keys
		expect(questionnaire.questions.every((question) => question.section === "Address")).toBe(true)
		expect(questionnaire.questions.find((question) => question.key === "address.city")).toMatchObject({
			header: "City",
			question: "City?",
			kind: "text",
		})
	})

	it("qualifies nested keys so two sections sharing a leaf name do not collide", () => {
		const schema = Type.Object({
			source: Type.Object({ name: Type.String(), url: Type.String() }, { title: "Source" }),
			target: Type.Object({ name: Type.String(), url: Type.String() }, { title: "Target" }),
		})
		const questionnaire = questionnaireFromSchema(schema)
		expect(questionnaire.questions.map((question) => question.key)).toEqual([
			"source.name",
			"source.url",
			"target.name",
			"target.url",
		])

		const answers = { "source.name": "A", "source.url": "http://a", "target.name": "B", "target.url": "http://b" }
		expect(answersToOutput(schema, answers)).toEqual({
			source: { name: "A", url: "http://a" },
			target: { name: "B", url: "http://b" }, // distinct values — no collision
		})
		expect(validateAnswers(schema, answersToOutput(schema, answers))).toEqual({ ok: true })
	})

	it("supports the allowOther and chat annotations", () => {
		const schema = Type.Object({
			role: Type.Union([Type.Literal("dev"), Type.Literal("ops")], { allowOther: true }),
			freeform: Type.String({ chat: true }),
		})
		expect(q(schema, "role")?.allowOther).toBe(true)
		expect(q(schema, "freeform")?.kind).toBe("chat")
	})

	it("derives the header from `title`, falling back to a humanized key", () => {
		const schema = Type.Object({
			firstName: Type.String(),
			deploy_env: Type.String({ title: "Deployment Environment" }),
		})
		expect(q(schema, "firstName")?.header).toBe("First Name") // humanized camelCase
		expect(q(schema, "deploy_env")?.header).toBe("Deployment Environment") // explicit title wins
	})

	it("carries the target schema's title onto the questionnaire", () => {
		const schema = Type.Object({ x: Type.String() }, { title: "Deploy Config" })
		expect(questionnaireFromSchema(schema).title).toBe("Deploy Config")
	})

	it("produces a Questionnaire that validates against QuestionnaireSchema", () => {
		const schema = Type.Object({
			env: Type.Union([Type.Literal("dev"), Type.Literal("prod")], { default: "dev" }),
			tags: Type.Array(Type.Union([Type.Literal("a"), Type.Literal("b")])),
			name: Type.String(),
		})
		expect(Value.Check(QuestionnaireSchema, questionnaireFromSchema(schema))).toBe(true)
	})
})

describe("buildAskingProtocol", () => {
	it("embeds both the Questionnaire schema and the target schema, plus the batch instruction", () => {
		const target = Type.Object({ answer: Type.String() })
		const protocol = buildAskingProtocol(target)
		expect(protocol).toMatch(/"questions":/) // the ask shape
		expect(protocol).toMatch(/"result":/) // the finish shape
		expect(protocol).toMatch(/[Bb]atch as many questions/) // batch instruction
		// Both schemas are embedded verbatim.
		expect(protocol).toContain(JSON.stringify(QuestionnaireSchema, null, 2))
		expect(protocol).toContain(JSON.stringify(target, null, 2))
	})
})

describe("validateAnswers", () => {
	it("returns ok for answers matching the target schema", () => {
		const target = Type.Object({ name: Type.String(), env: Type.Union([Type.Literal("dev"), Type.Literal("prod")]) })
		expect(validateAnswers(target, { name: "Ada", env: "prod" })).toEqual({ ok: true })
	})

	it("returns a descriptive violation for invalid answers", () => {
		const target = Type.Object({ count: Type.Integer({ minimum: 10 }) })
		const result = validateAnswers(target, { count: 1 })
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.violation).toMatch(/count/)
			expect(result.violation).toMatch(/>= 10/)
		}
	})
})
