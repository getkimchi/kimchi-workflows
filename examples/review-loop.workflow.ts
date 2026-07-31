/**
 * Phase 5a example: an agent proposes, a check evaluates, and the workflow loops `.dountil` the
 * check passes (with a max-iteration guard so it always terminates).
 *
 * The loop body is a sub-workflow (propose -> check) executed recursively by the same engine. The
 * loop's pure condition reads the check step's output from the run context.
 */
import { Type } from "typebox"
import { createAgentStep, createStep, createWorkflow } from "../src/flow/index.ts"

/** The agent must return a short slug (lowercase letters, digits, hyphens) — a deliberately strict target. */
export const proposalSchema = Type.Object({ slug: Type.String() })
export const reviewSchema = Type.Object({ slug: Type.String(), passed: Type.Boolean(), reason: Type.String() })

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const propose = createAgentStep({
	name: "propose-slug",
	output: proposalSchema,
	model: "kimchi-dev/kimi-k2.7",
	prompt: () =>
		[
			"Propose a URL slug for an article titled: 'Deterministic Workflow Engines for Coding Agents'.",
			"The slug must be lowercase letters, digits, and single hyphens only.",
		].join("\n"),
})

/** Deterministic function check (no LLM): validates the proposed slug against the slug rule. */
const review = createStep({
	name: "review-slug",
	input: proposalSchema,
	output: reviewSchema,
	run: ({ input }) => {
		const passed = SLUG_RE.test(input.slug)
		return { slug: input.slug, passed, reason: passed ? "valid slug" : "slug must be lowercase letters/digits/hyphens" }
	},
})

const reviewBody = createWorkflow({ name: "review-body" }).then(propose).then(review).commit()

const reviewLoopWorkflow = createWorkflow({
	name: "review-loop",
	description: "Propose a slug and loop until it passes review (Phase 5a)",
})
	.dountil(reviewBody, (ctx) => ctx.getStepResult<{ passed: boolean }>("review-slug")?.passed === true, {
		name: "until-valid",
		maxIterations: 5,
	})
	.commit()

export default reviewLoopWorkflow
