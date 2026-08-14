import { describe, expect, it } from "vitest"
import type { Questionnaire } from "../src/flow/questionnaire.ts"
import {
	allQuestionsAnswered,
	formAnswers,
	initialFormState,
	isSubmitPage,
	reduceForm,
} from "../src/host/questionnaire-form-state.ts"

const multi: Questionnaire = {
	questions: [
		{
			key: "features",
			header: "Features",
			question: "Which features?",
			kind: "multi",
			options: [
				{ value: "alpha", label: "Alpha" },
				{ value: "beta", label: "Beta" },
				{ value: "gamma", label: "Gamma" },
			],
		},
	],
}

describe("rich questionnaire form state", () => {
	it("toggles the focused checkbox with Space without moving focus or completing", () => {
		let state = initialFormState(multi)
		let transition = reduceForm(state, { kind: "key-space" })
		state = transition.state

		expect(state.optionIndex).toBe(0)
		expect(state.currentPage).toBe(0)
		expect(state.answers.get("features")?.options).toEqual(["alpha"])
		expect(transition.effects).toEqual([{ kind: "render" }])

		transition = reduceForm(state, { kind: "key-space" })
		expect(transition.state.answers.get("features")?.options).toEqual([])
		expect(transition.effects).not.toContainEqual({ kind: "done", cancelled: false })
	})

	it("selects, clears, and completes with exactly the currently checked values", () => {
		let state = initialFormState(multi)
		;({ state } = reduceForm(state, { kind: "key-space" })) // alpha on
		;({ state } = reduceForm(state, { kind: "key-down" }))
		;({ state } = reduceForm(state, { kind: "key-space" })) // beta on
		;({ state } = reduceForm(state, { kind: "key-up" }))
		;({ state } = reduceForm(state, { kind: "key-space" })) // alpha off

		const transition = reduceForm(state, { kind: "key-enter" })
		expect(transition.effects).toContainEqual({ kind: "done", cancelled: false })
		expect(formAnswers(transition.state)).toEqual({ features: ["beta"] })
	})

	it("uses a final Submit page for a multi-question questionnaire", () => {
		const questionnaire: Questionnaire = {
			questions: [
				{
					key: "environment",
					header: "Environment",
					question: "Which environment?",
					kind: "single",
					options: [{ value: "prod", label: "Production" }],
				},
				{
					key: "note",
					header: "Note",
					question: "Anything else?",
					kind: "text",
				},
			],
		}
		let state = initialFormState(questionnaire)

		let transition = reduceForm(state, { kind: "key-enter" })
		state = transition.state
		expect(state.currentPage).toBe(1)
		expect(state.inputMode).toBe(true)
		expect(transition.effects).not.toContainEqual({ kind: "done", cancelled: false })

		transition = reduceForm(state, { kind: "editor-submit", value: "Ready" })
		state = transition.state
		expect(isSubmitPage(state)).toBe(true)
		expect(allQuestionsAnswered(state)).toBe(true)
		expect(transition.effects).not.toContainEqual({ kind: "done", cancelled: false })

		transition = reduceForm(state, { kind: "key-enter" })
		expect(transition.effects).toEqual([{ kind: "done", cancelled: false }])
		expect(formAnswers(transition.state)).toEqual({ environment: "prod", note: "Ready" })
	})

	it("does not submit the final page while any question is unanswered", () => {
		const questionnaire: Questionnaire = {
			questions: [
				{ key: "name", header: "Name", question: "Name?", kind: "text" },
				{ key: "note", header: "Note", question: "Note?", kind: "chat" },
			],
		}
		let state = initialFormState(questionnaire)
		;({ state } = reduceForm(state, { kind: "key-escape" }))
		;({ state } = reduceForm(state, { kind: "key-left" }))
		expect(isSubmitPage(state)).toBe(true)
		expect(reduceForm(state, { kind: "key-enter" }).effects).toEqual([])
	})

	it("preserves multiline text verbatim and advances to Submit before completing", () => {
		const questionnaire: Questionnaire = {
			questions: [
				{ key: "details", header: "Details", question: "Describe it", kind: "text" },
				{
					key: "priority",
					header: "Priority",
					question: "Priority?",
					kind: "single",
					options: [{ value: "high", label: "High" }],
				},
			],
		}
		let state = initialFormState(questionnaire)
		expect(state.inputMode).toBe(true)

		const textTransition = reduceForm(state, { kind: "editor-submit", value: "first line\nsecond line" })
		state = textTransition.state
		expect(state.answers.get("details")?.text).toBe("first line\nsecond line")
		expect(state.currentPage).toBe(1)
		expect(textTransition.effects).not.toContainEqual({ kind: "done", cancelled: false })

		;({ state } = reduceForm(state, { kind: "key-enter" }))
		expect(isSubmitPage(state)).toBe(true)
		expect(formAnswers(state)).toEqual({ details: "first line\nsecond line", priority: "high" })
	})

	it("leaves the editor without cancelling the form, then cancels from the question page", () => {
		const questionnaire: Questionnaire = {
			questions: [{ key: "details", header: "Details", question: "Describe it", kind: "text" }],
		}
		let state = initialFormState(questionnaire)
		expect(state.inputMode).toBe(true)

		let transition = reduceForm(state, { kind: "key-escape" })
		state = transition.state
		expect(state.inputMode).toBe(false)
		expect(transition.effects).not.toContainEqual({ kind: "done", cancelled: true })

		transition = reduceForm(state, { kind: "key-escape" })
		expect(transition.effects).toContainEqual({ kind: "done", cancelled: true })
	})
})
