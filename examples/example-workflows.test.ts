import { ask, createTestRun, raw, reply } from "@kimchi-dev/kimchi-workflows/testing"
import { describe, expect, it } from "vitest"
import approvalWorkflow from "./approval.workflow.ts"
import batchWorkflow from "./batch.workflow.ts"
import codeReviewWorkflow from "./code-review.workflow.ts"
import fanOutWorkflow from "./fan-out.workflow.ts"
import foreachConcurrentWorkflow from "./foreach-concurrent.workflow.ts"
import helloWorkflow from "./hello.workflow.ts"
import bugInvestigationWorkflow from "./kimchi-bug-investigation.workflow.ts"
import pipelineWorkflow from "./pipeline.workflow.ts"
import planningWorkflow from "./planning.workflow.ts"
import reviewLoopWorkflow from "./review-loop.workflow.ts"
import summarizeWorkflow from "./summarize.workflow.ts"
import surveyWorkflow from "./survey.workflow.ts"

describe("example workflows (offline)", () => {
	it("approval: blocks for an interactive decision and resumes", async () => {
		const blocked = await createTestRun(approvalWorkflow)
		expect(blocked.status).toBe("blocked")
		expect(blocked.interaction).toEqual({
			markdown: "# Proposed change\n\nAdd a deterministic, resumable approval boundary.",
		})

		const done = await blocked.respond({ decision: "approve" })
		expect(done.status).toBe("completed")
		expect(done.output).toEqual({ decision: "approve" })
	})

	it("hello: runs a single function step", async () => {
		const run = await createTestRun(helloWorkflow)
		expect(run.status).toBe("completed")
		expect(run.output).toEqual({ message: "Hello, PI workflows!" })
	})

	it("pipeline: hands data through a linear pipeline and map", async () => {
		const run = await createTestRun(pipelineWorkflow)
		expect(run.status).toBe("completed")
		expect(run.output).toEqual({ summary: '3 words, starting with "hello"' })
	})

	it("batch: processes a list sequentially", async () => {
		const run = await createTestRun(batchWorkflow)
		expect(run.status).toBe("completed")
		expect(run.output).toEqual([{ doubled: 2 }, { doubled: 4 }, { doubled: 6 }, { doubled: 8 }])
	})

	it("fan-out: runs independent steps over shared input", async () => {
		const run = await createTestRun(fanOutWorkflow)
		expect(run.status).toBe("completed")
		expect(run.output).toEqual({ "count-words": { words: 4 }, "count-chars": { chars: 31 } })
	})

	it("foreach-concurrent: preserves item order", async () => {
		const run = await createTestRun(foreachConcurrentWorkflow)
		expect(run.status).toBe("completed")
		expect(run.output).toEqual([{ squared: 1 }, { squared: 4 }, { squared: 9 }, { squared: 16 }, { squared: 25 }])
	})

	it("survey: gathers structured input before continuing", async () => {
		const blocked = await createTestRun(surveyWorkflow)
		expect(blocked.status).toBe("blocked")
		expect(blocked.questionKeys()).toEqual(["name", "environment"])

		const done = await blocked.answer({ name: "Ada", environment: "prod" })
		expect(done.status).toBe("completed")
		expect(done.output).toEqual({ message: "Hello Ada, deploying to prod." })
	})

	it("planning: lets an agent ask a question before returning a plan", async () => {
		const blocked = await createTestRun(planningWorkflow, {
			agents: {
				plan: [
					ask({ questions: [{ key: "backend", header: "Backend", question: "Which cache backend?", kind: "text" }] }),
					reply({ steps: ["add a redis client", "wrap the handlers"], summary: "Redis cache" }),
				],
			},
		})

		expect(blocked.status).toBe("blocked")
		expect(blocked.questionKeys()).toEqual(["backend"])

		const done = await blocked.answer({ backend: "Redis" })
		expect(done.status).toBe("completed")
		expect(done.output).toEqual({ message: "Plan ready with 2 steps: Redis cache" })
	})

	it("summarize: accepts a schema-valid scripted agent result", async () => {
		const run = await createTestRun(summarizeWorkflow, {
			agents: {
				summarize: [reply({ summary: "TypeBox joins static and runtime types.", keywords: ["typebox", "schema"] })],
			},
		})

		expect(run.status).toBe("completed")
		expect(run.output).toEqual({
			summary: "TypeBox joins static and runtime types.",
			keywords: ["typebox", "schema"],
		})
	})

	it("review-loop: retries an invalid proposal until it passes", async () => {
		const run = await createTestRun(reviewLoopWorkflow, {
			agents: {
				"propose-slug": [reply({ slug: "Not Valid" }), reply({ slug: "valid-slug" })],
			},
		})

		expect(run.status).toBe("completed")
		expect(run.output).toEqual({ slug: "valid-slug", passed: true, reason: "valid slug" })
		expect(run.agent("propose-slug").sessions).toBe(2)
	})

	it("code-review: exercises the complete review graph without Git or filesystem writes", async () => {
		const snapshot = {
			repositoryRoot: "/repo",
			reviewRoot: "/repo",
			baseRef: "main",
			headRef: "feature",
			baseSha: "1111111111111111111111111111111111111111",
			mergeBaseSha: "1111111111111111111111111111111111111111",
			headSha: "2222222222222222222222222222222222222222",
			changedFiles: ["src/example.ts"],
			ownsWorktree: false,
		}
		const inference = {
			statement: "The change adds example coverage.",
			evidence: ["src/example.ts"],
			confidence: "high" as const,
		}
		const intent = {
			summary: "Add example coverage.",
			goal: inference,
			userVisibleBehavior: [inference],
			constraints: [],
			acceptanceCriteria: [inference],
			nonGoals: [],
			changedAreas: ["examples"],
			riskAreas: [],
			uncertainties: [],
		}
		const targetedReview = (angle: string) => ({
			angle,
			summary: "No issues found.",
			findings: [],
			positiveObservations: ["The change has deterministic tests."],
			questions: [],
		})
		const report = {
			verdict: "approve" as const,
			changeSummary: "Adds deterministic example coverage.",
			acceptanceAssessment: [
				{ criterion: "Examples are tested.", status: "satisfied" as const, evidence: "The suite completes." },
			],
			findings: [],
			positiveObservations: ["The suite is offline."],
			actions: { mustFix: [], shouldFix: [], optional: [] },
			questions: [],
		}
		const reportPath = "/repo/.kimchi/reports/code-review.md"
		const run = await createTestRun(codeReviewWorkflow, {
			agents: {
				"scope-review": [reply({ baseRef: "main", headRef: "feature", rationale: "Review the feature." })],
				"infer-intent": [reply(intent)],
				"project-fit": [reply(targetedReview("Project fit and hygiene"))],
				correctness: [reply(targetedReview("Feature correctness"))],
				architecture: [reply(targetedReview("Architecture and ecosystem idioms"))],
				"change-risk": [reply(targetedReview("Change-specific risk"))],
				"synthesize-review": [reply(report)],
				"present-report": [raw(`Code review report written to: ${reportPath}`)],
			},
			steps: {
				"prepare-review": () => snapshot,
				"cleanup-review": () => ({ markdown: "# Code review" }),
				"save-report": () => ({ markdown: "# Code review", reportPath }),
			},
		})

		expect(run.status).toBe("completed")
		expect(run.stepOutput("render-report")).toMatchObject({ markdown: expect.stringContaining("**Verdict:** Approve") })
		expect(run.stepOutput("save-report")).toEqual({ markdown: "# Code review", reportPath })
	})

	it("kimchi-bug-investigation: completes with agent and write steps stubbed", async () => {
		const evidenceDirectory = "/tmp/example-evidence"
		const reportPath = `${evidenceDirectory}/example-bug.md`
		const evidence = {
			artifactsReviewed: ["report.md"],
			caseSummary: "The example behavior is wrong.",
			actualBehavior: "Wrong output.",
			expectedBehavior: "Correct output.",
			observations: ["The report reproduces consistently."],
			sessionReview: {
				found: false,
				sources: [],
				coverage: "not-present" as const,
				summary: "No session was supplied.",
				limitations: [],
			},
			candidateCodeAreas: ["src/example.ts"],
			openQuestions: [],
		}
		const assessment = {
			repositoryPath: "/repo",
			outcome: "confirms-bug" as const,
			summary: "The implementation returns the wrong value.",
			method: ["Inspected the implementation."],
			measurements: ["One reproducible path."],
			executionPath: ["input -> example"],
			experiments: [],
			rootCause: "The wrong value is hard-coded.",
			secondaryFindings: [],
			suggestedFixes: ["Return the expected value."],
			references: [{ path: "src/example.ts", line: 1, explanation: "Contains the wrong value." }],
			limitations: [],
		}
		const draft = {
			classification: "bug" as const,
			title: "Example bug",
			what: "The example returns the wrong value.",
			description: "## Root cause\n\nThe wrong value is hard-coded.",
		}
		const started = await createTestRun(bugInvestigationWorkflow, {
			agents: {
				"locate-evidence-directory": [reply({ evidenceDirectory })],
				"investigate-evidence": [reply(evidence)],
				"verify-against-code": [reply(assessment)],
				"draft-report": [reply(draft)],
				"announce-report": [raw(`Kimchi investigation report written to: ${reportPath}`)],
			},
			steps: {
				"write-report": () => ({
					reportPath,
					classification: "bug",
					markdown: "# Example bug",
				}),
			},
		})

		expect(started.status).toBe("blocked")
		expect(started.questionKeys()).toEqual(["evidenceDirectory"])

		const completed = await started.answer({ evidenceDirectory })
		expect(completed.status).toBe("completed")
		expect(completed.stepOutput("write-report")).toMatchObject({ reportPath, classification: "bug" })
	})
})
