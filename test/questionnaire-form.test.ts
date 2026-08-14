import type { Theme } from "@earendil-works/pi-coding-agent"
import type { Component, TUI } from "@earendil-works/pi-tui"
import { describe, expect, it, vi } from "vitest"
import type { Questionnaire } from "../src/flow/questionnaire.ts"
import { createQuestionnaireForm } from "../src/host/questionnaire-form.ts"

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme

function form(questionnaire: Questionnaire) {
	const tui = { requestRender: vi.fn() } as unknown as TUI
	const done = vi.fn<(answers: Record<string, unknown> | undefined) => void>()
	const component = createQuestionnaireForm(tui, theme, questionnaire, done)
	return { component, done, tui }
}

function press(component: Component, data: string): void {
	expect(component.handleInput).toBeTypeOf("function")
	component.handleInput?.(data)
}

describe("rich questionnaire component keyboard interaction", () => {
	it("redraws a checkbox immediately when Space selects and clears it", () => {
		const { component, done, tui } = form({
			questions: [
				{
					key: "features",
					header: "Features",
					question: "Which features?",
					kind: "multi",
					options: [{ value: "alpha", label: "Alpha" }],
				},
			],
		})

		expect(component.render(80).join("\n")).toContain("[ ] Alpha")
		press(component, " ")
		expect(component.render(80).join("\n")).toContain("[x] Alpha")
		expect(tui.requestRender).toHaveBeenCalledTimes(1)
		expect(done).not.toHaveBeenCalled()

		press(component, " ")
		expect(component.render(80).join("\n")).toContain("[ ] Alpha")
		expect(done).not.toHaveBeenCalled()
	})

	it("shows the final review page before submitting a multi-question form", () => {
		const { component, done } = form({
			title: "Deploy",
			questions: [
				{
					key: "environment",
					header: "Environment",
					question: "Which environment?",
					kind: "single",
					options: [{ value: "prod", label: "Production" }],
				},
				{
					key: "region",
					header: "Region",
					question: "Which region?",
					kind: "single",
					options: [{ value: "eu", label: "Europe" }],
				},
			],
		})

		press(component, "\r")
		expect(done).not.toHaveBeenCalled()
		press(component, "\r")
		expect(done).not.toHaveBeenCalled()
		expect(component.render(100).join("\n")).toContain("Ready to submit")

		press(component, "\r")
		expect(done).toHaveBeenCalledWith({ environment: "prod", region: "eu" })
	})

	it("uses the multiline editor and preserves Shift+Enter newlines", () => {
		const { component, done } = form({
			questions: [{ key: "details", header: "Details", question: "Describe it", kind: "text" }],
		})

		press(component, "first line")
		press(component, "\u001b[13;2u") // Shift+Enter
		press(component, "second line")
		expect(done).not.toHaveBeenCalled()
		press(component, "\r")

		expect(done).toHaveBeenCalledWith({ details: "first line\nsecond line" })
	})
})
