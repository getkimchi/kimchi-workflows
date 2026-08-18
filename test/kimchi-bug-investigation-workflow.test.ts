import { mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import workflow, { renderInvestigationReport, reportFileName } from "../examples/kimchi-bug-investigation.workflow.ts"
import { ask, createTestRun, raw, reply } from "../src/testing/index.ts"

const evidence = {
	artifactsReviewed: ["report.md", "panel.png", "session.jsonl"],
	caseSummary: "The workflow panel stretches across a wide terminal.",
	actualBehavior: "Step metadata is separated from its row label.",
	expectedBehavior: "Step metadata remains visually associated with its row.",
	reproduction: "Open a workflow in a 180-column terminal.",
	observations: ["The screenshot and session dimensions agree."],
	sessionReview: {
		found: true,
		sources: ["session.jsonl"],
		coverage: "complete" as const,
		recordsReviewed: 18,
		recordsTotal: 18,
		summary: "All records were reviewed chronologically.",
		limitations: [],
	},
	candidateCodeAreas: ["workflow progress rendering"],
	openQuestions: [],
}

const codeAssessment = {
	repositoryPath: "/src/kimchi",
	outcome: "confirms-bug" as const,
	summary: "The progress renderer expands its spacer to all available columns.",
	method: ["Reproduced the layout in narrow and wide pseudo-terminals."],
	reproduction: "Open a workflow in a 180-column terminal.",
	measurements: ["At 180 columns, the metadata begins 96 columns after the step name."],
	executionPath: ["Workflow event -> progress state -> row renderer -> terminal output"],
	experiments: [
		{
			question: "Does the drift depend on terminal width?",
			method: "Rendered the same workflow at 100 and 180 columns.",
			result: "The gap grew with the available width.",
			conclusion: "The flexible spacer consumes the excess columns.",
		},
	],
	rootCause: "The progress renderer expands its spacer to all available columns.",
	secondaryFindings: [],
	suggestedFixes: ["Cap the spacer and keep metadata adjacent to the step label."],
	references: [{ path: "src/extensions/workflows/progress.ts", line: 81, explanation: "Uses the full width." }],
	limitations: [],
}

const draft = {
	classification: "bug" as const,
	title: "Workflow panel metadata drifts away from step names",
	what: "On wide terminals, workflow metadata is rendered too far from the step it describes.",
	description: `### Reproduction

Open a workflow in a 180-column terminal.

### Root cause

The progress renderer expands its spacer to all available columns.

### Suggested fix

Cap the spacer and keep metadata adjacent to the step label.`,
}

describe("investigate-kimchi-bug workflow", () => {
	it("asks for the evidence directory first, then completes a source-backed investigation", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "kimchi-bug-investigation-"))
		const canonicalDirectory = await realpath(directory)
		try {
			const reportPath = path.join(canonicalDirectory, "workflow-panel-metadata-drifts-away-from-step-names.md")
			const started = await createTestRun(workflow, {
				agents: {
					"locate-evidence-directory": [reply({ evidenceDirectory: directory })],
					"investigate-evidence": [reply(evidence)],
					"verify-against-code": [reply(codeAssessment)],
					"draft-report": [reply(draft)],
					"announce-report": [raw(`Kimchi investigation report written to: ${reportPath}`)],
				},
			})

			expect(started.status).toBe("blocked")
			expect(started.path).toBe("select-evidence-directory")
			expect(started.questionKeys()).toEqual(["evidenceDirectory"])
			expect(started.agent("locate-evidence-directory").sessions).toBe(0)

			const completed = await started.answer({ evidenceDirectory: "./bugs/panel-width" })
			expect(completed.status).toBe("completed")
			expect(completed.stepOutput("write-report")).toMatchObject({ reportPath, classification: "bug" })
			expect(await readFile(reportPath, "utf8")).toBe(renderInvestigationReport(draft))
			expect(completed.agent("locate-evidence-directory").messages[0]).toContain("./bugs/panel-width")
			expect(completed.agent("investigate-evidence").messages[0]).toContain("process every record")
			expect(completed.agent("verify-against-code").messages[0]).toContain("18")
			expect(completed.agent("verify-against-code").messages[0]).toContain("starting point, not the limit")
			expect(completed.agent("verify-against-code").messages[0]).toContain("actively try to falsify")
			expect(completed.agent("draft-report").messages[0]).toContain("Optimize for helping an engineer")
			expect(completed.agent("announce-report").messages[0]).toContain(reportPath)
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	})

	it("lets the locator ask for confirmation when directory discovery has a problem", async () => {
		const locatorQuestion = {
			title: "Confirm evidence directory",
			questions: [
				{
					key: "evidenceDirectory",
					header: "Evidence directory",
					question: "Use /cases/panel-width?",
					kind: "text" as const,
				},
			],
		}
		const started = await createTestRun(workflow, {
			agents: {
				"locate-evidence-directory": [ask(locatorQuestion), reply({ evidenceDirectory: "/cases/panel-width" })],
				"investigate-evidence": [reply(evidence)],
				"verify-against-code": [reply(codeAssessment)],
				"draft-report": [reply(draft)],
				"announce-report": [raw("Report path announced")],
			},
			steps: {
				"write-report": () => ({
					reportPath: "/cases/panel-width/kimchi-investigation.md",
					classification: "bug",
					markdown: renderInvestigationReport(draft),
				}),
			},
		})

		const locating = await started.answer({ evidenceDirectory: "./missing" })
		expect(locating.status).toBe("blocked")
		expect(locating.path).toBe("locate-evidence-directory")
		expect(locating.questionKeys()).toEqual(["evidenceDirectory"])

		const completed = await locating.answer({ evidenceDirectory: "/cases/panel-width" })
		expect(completed.status).toBe("completed")
	})
})

describe("investigation report rendering", () => {
	it("uses the report title as the Markdown filename", () => {
		expect(reportFileName("Workflow panel: too wide")).toBe("workflow-panel-too-wide.md")
	})

	it("preserves the actionable investigation body", () => {
		const markdown = renderInvestigationReport(draft)

		expect(markdown).toContain("# Workflow panel metadata drifts away from step names")
		expect(markdown).toContain("## What")
		expect(markdown).toContain("## Description")
		expect(markdown).toContain("### Reproduction")
		expect(markdown).toContain("### Root cause")
		expect(markdown).toContain("### Suggested fix")
		expect(markdown).toContain("Cap the spacer")
	})

	it("keeps exactly one level-one title when the description repeats it", () => {
		const markdown = renderInvestigationReport({
			...draft,
			description: `# Duplicate agent title\n\n${draft.description}`,
		})

		expect(markdown.match(/^# /gm)).toHaveLength(1)
		expect(markdown).not.toContain("Duplicate agent title")
		expect(markdown).toContain("### Root cause")
	})
})
