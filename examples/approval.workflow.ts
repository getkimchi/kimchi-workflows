import { getMarkdownTheme } from "@earendil-works/pi-coding-agent"
import { Markdown } from "@earendil-works/pi-tui"
import { createInteractiveStep, createWorkflow } from "@kimchi-dev/kimchi-workflows"
import { Type } from "typebox"

const reviewRequest = Type.Object({ markdown: Type.String() })
const reviewResult = Type.Union([
	Type.Object({ decision: Type.Literal("approve") }),
	Type.Object({ decision: Type.Literal("revise"), feedback: Type.String() }),
])
const widgetKey = "approval-example-review"

const review = createInteractiveStep({
	name: "review",
	request: reviewRequest,
	output: reviewResult,
	buildRequest: () => ({
		markdown: ["# Proposed change", "", "Add a deterministic, resumable approval boundary."].join("\n"),
	}),
	render: async ({ request, ui, mode, hasUI, write }) => {
		if (!hasUI) {
			write(request.markdown)
			return undefined
		}
		try {
			if (mode === "tui") {
				ui.setWidget(widgetKey, () => new Markdown(request.markdown, 1, 0, getMarkdownTheme()), {
					placement: "aboveEditor",
				})
			} else {
				ui.setWidget(widgetKey, request.markdown.split("\n"), { placement: "aboveEditor" })
			}
			const decision = await ui.select("Review change", ["Approve", "Revise"])
			if (decision === "Approve") return { decision: "approve" as const }
			if (decision !== "Revise") return undefined
			const feedback = (await ui.editor("What should change?", ""))?.trim()
			return feedback ? { decision: "revise" as const, feedback } : undefined
		} finally {
			ui.setWidget(widgetKey, undefined)
		}
	},
})

export default createWorkflow({
	name: "approval",
	description: "Present Markdown and collect a resumable approve/revise decision",
})
	.then(review)
	.commit()
