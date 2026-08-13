import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import { renderPlanReview } from "../src/host/builtin/create.workflow.ts"

const plan = {
	goal: "Do one useful thing",
	acceptanceCriteria: ["The useful thing is done"],
	decisions: [],
	summary: "Does one useful thing.",
	name: "demo",
	invocation: { requiresArguments: false },
	steps: [{ title: "Work", purpose: "Do the work", receives: [], produces: [], delivers: [] }],
}
const request = {
	plan,
	target: { entryPath: "/project/demo.workflow.ts" },
	markdown: "# Proposed workflow\n\nDoes one useful thing.",
}

function fakeUi(selection: string | undefined, feedback?: string | undefined) {
	const widgets: unknown[] = []
	const select = vi.fn(async () => selection)
	const editor = vi.fn(async () => feedback)
	const setWidget = vi.fn((_key: string, content: unknown) => void widgets.push(content))
	const notify = vi.fn()
	return {
		ui: { select, editor, setWidget, notify } as unknown as ExtensionUIContext,
		widgets,
		select,
		editor,
		setWidget,
		notify,
	}
}

describe("create workflow plan review renderer (PI 0.79.10)", () => {
	it("keeps a TUI Markdown component widget visible while approval is selected, then clears it", async () => {
		const fake = fakeUi("Approve")

		const result = await renderPlanReview({
			request,
			ui: fake.ui,
			mode: "tui",
			hasUI: true,
			write: vi.fn(),
		})

		expect(result).toEqual({ decision: "approve" })
		expect(fake.select).toHaveBeenCalledWith("Review proposed workflow", ["Approve", "Revise"])
		expect(fake.widgets[0]).toBeTypeOf("function")
		expect(fake.widgets.at(-1)).toBeUndefined()
		expect(fake.editor).not.toHaveBeenCalled()
	})

	it("uses PI's multiline editor for revision feedback and preserves its text", async () => {
		const feedback = "Change the first step.\n\nAlso add a verifier."
		const fake = fakeUi("Revise", feedback)

		const result = await renderPlanReview({
			request,
			ui: fake.ui,
			mode: "rpc",
			hasUI: true,
			write: vi.fn(),
		})

		expect(result).toEqual({ decision: "revise", feedback })
		expect(fake.editor).toHaveBeenCalledWith("What should change?", "")
		expect(fake.widgets[0]).toEqual(request.markdown.split("\n"))
		expect(fake.widgets.at(-1)).toBeUndefined()
	})

	it("requires non-empty revision feedback and trims the accepted multiline text", async () => {
		const fake = fakeUi("Revise", "unused")
		fake.editor.mockResolvedValueOnce("   \n").mockResolvedValueOnce("  Add a verifier.\nThen retry.  ")

		const result = await renderPlanReview({
			request,
			ui: fake.ui,
			mode: "rpc",
			hasUI: true,
			write: vi.fn(),
		})

		expect(result).toEqual({ decision: "revise", feedback: "Add a verifier.\nThen retry." })
		expect(fake.editor).toHaveBeenCalledTimes(2)
		expect(fake.notify).toHaveBeenCalledWith("Revision feedback cannot be empty.", "warning")
	})

	it("treats selector/editor dismissal as unresolved and always clears the widget", async () => {
		const selectDismissed = fakeUi(undefined)
		expect(
			await renderPlanReview({
				request,
				ui: selectDismissed.ui,
				mode: "tui",
				hasUI: true,
				write: vi.fn(),
			}),
		).toBeUndefined()
		expect(selectDismissed.widgets.at(-1)).toBeUndefined()

		const editorDismissed = fakeUi("Revise", undefined)
		expect(
			await renderPlanReview({
				request,
				ui: editorDismissed.ui,
				mode: "rpc",
				hasUI: true,
				write: vi.fn(),
			}),
		).toBeUndefined()
		expect(editorDismissed.widgets.at(-1)).toBeUndefined()
	})

	it("clears the widget when a PI dialog fails", async () => {
		const fake = fakeUi("Approve")
		fake.select.mockRejectedValueOnce(new Error("dialog transport failed"))

		await expect(renderPlanReview({ request, ui: fake.ui, mode: "tui", hasUI: true, write: vi.fn() })).rejects.toThrow(
			"dialog transport failed",
		)
		expect(fake.widgets.at(-1)).toBeUndefined()
	})

	it("prints the persisted Markdown and remains blocked in headless modes", async () => {
		const fake = fakeUi("Approve")
		const write = vi.fn()

		const result = await renderPlanReview({ request, ui: fake.ui, mode: "print", hasUI: false, write })

		expect(result).toBeUndefined()
		expect(write).toHaveBeenNthCalledWith(1, request.markdown)
		expect(fake.select).not.toHaveBeenCalled()
		expect(fake.setWidget).not.toHaveBeenCalled()
	})
})
