import { createStep, createWorkflow } from "@kimchi-dev/kimchi-workflows"
import slugify from "slugify"
import { Type } from "typebox"

const resultSchema = Type.Object({
	dependency: Type.Literal("slugify"),
	input: Type.String(),
	slug: Type.String(),
})

const createSlug = createStep({
	name: "create-slug",
	description: "Use a workflow-local third-party dependency to create a URL-safe slug",
	output: resultSchema,
	run: () => {
		const input = "Kimchi resolves workflow-local dependencies"
		return {
			dependency: "slugify" as const,
			input,
			slug: slugify(input, { lower: true, strict: true }),
		}
	},
})

export default createWorkflow({
	name: "external-dependency-check",
	description: "Verify that a workflow can load a third-party package from its own package directory",
})
	.then(createSlug)
	.commit()
