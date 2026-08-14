/**
 * Pure state machine for the rich questionnaire form.
 *
 * Keeping keyboard intent and answer collection separate from PI's TUI makes the interaction contract
 * directly testable: a multi-page form completes only from its final Submit page, and Space toggles a
 * checkbox without leaving the current question.
 */
import type { Question, Questionnaire, QuestionOption } from "../flow/questionnaire.ts"
import { assembleAnswers, OTHER_LABEL, OTHER_VALUE, orderedOptions, type RawSelection } from "./answer-assembly.ts"

export type FormEvent =
	| { kind: "key-up" }
	| { kind: "key-down" }
	| { kind: "key-left" }
	| { kind: "key-right" }
	| { kind: "key-enter" }
	| { kind: "key-escape" }
	| { kind: "key-space" }
	| { kind: "editor-submit"; value: string }

export type FormEffect =
	| { kind: "render" }
	| { kind: "editor-set-text"; text: string }
	| { kind: "done"; cancelled: boolean }

export interface FormState {
	readonly questionnaire: Questionnaire
	readonly currentPage: number
	readonly optionIndex: number
	readonly inputMode: boolean
	readonly answers: ReadonlyMap<string, RawSelection>
}

export interface FormTransition {
	readonly state: FormState
	readonly effects: FormEffect[]
}

type RenderOption = QuestionOption & { readonly isOther?: boolean }

export function initialFormState(questionnaire: Questionnaire): FormState {
	return {
		questionnaire,
		currentPage: 0,
		optionIndex: 0,
		inputMode: isTextQuestion(questionnaire.questions[0]),
		answers: new Map(),
	}
}

export function currentFormQuestion(state: FormState): Question | undefined {
	return state.questionnaire.questions[state.currentPage]
}

export function currentFormOptions(state: FormState): RenderOption[] {
	const question = currentFormQuestion(state)
	if (!question || question.kind === "text" || question.kind === "chat") return []
	const options: RenderOption[] = orderedOptions(question)
	if (question.kind === "single" && question.allowOther) {
		options.push({ value: OTHER_VALUE, label: OTHER_LABEL, isOther: true })
	}
	return options
}

export function isSubmitPage(state: FormState): boolean {
	return isMultiPage(state) && state.currentPage === state.questionnaire.questions.length
}

export function allQuestionsAnswered(state: FormState): boolean {
	return state.questionnaire.questions.every((question) => state.answers.has(question.key))
}

export function formAnswers(state: FormState): Record<string, unknown> {
	return assembleAnswers(state.questionnaire, Object.fromEntries(state.answers))
}

export function reduceForm(state: FormState, event: FormEvent): FormTransition {
	let next = state
	const effects: FormEffect[] = []

	if (event.kind === "editor-submit") {
		const question = currentFormQuestion(next)
		if (!question) return { state: next, effects }

		const selection: RawSelection =
			question.kind === "single" ? { option: OTHER_VALUE, text: event.value } : { text: event.value }
		next = withAnswer(next, question.key, selection)
		next = { ...next, inputMode: false }
		effects.push({ kind: "editor-set-text", text: "" })
		return advanceAfterAnswer(next, effects)
	}

	if (next.inputMode) {
		if (event.kind === "key-escape") {
			next = { ...next, inputMode: false }
			effects.push({ kind: "editor-set-text", text: "" }, { kind: "render" })
		}
		return { state: next, effects }
	}

	if (isMultiPage(next)) {
		if (event.kind === "key-right") return navigate(next, 1)
		if (event.kind === "key-left") return navigate(next, -1)
	}

	if (isSubmitPage(next)) {
		if (event.kind === "key-enter" && allQuestionsAnswered(next)) {
			effects.push({ kind: "done", cancelled: false })
		} else if (event.kind === "key-escape") {
			effects.push({ kind: "done", cancelled: true })
		}
		return { state: next, effects }
	}

	const question = currentFormQuestion(next)
	const options = currentFormOptions(next)
	if (!question) return { state: next, effects }

	if (question.kind === "text" || question.kind === "chat") {
		if (event.kind === "key-enter") return enterTextMode(next, question)
		if (event.kind === "key-escape") effects.push({ kind: "done", cancelled: true })
		return { state: next, effects }
	}

	if (event.kind === "key-up") {
		next = { ...next, optionIndex: Math.max(0, next.optionIndex - 1) }
		effects.push({ kind: "render" })
		return { state: next, effects }
	}
	if (event.kind === "key-down") {
		next = { ...next, optionIndex: Math.min(Math.max(0, options.length - 1), next.optionIndex + 1) }
		effects.push({ kind: "render" })
		return { state: next, effects }
	}

	if (question.kind === "multi" && event.kind === "key-space") {
		const option = options[next.optionIndex]
		if (!option) return { state: next, effects }
		const selected = new Set(next.answers.get(question.key)?.options ?? [])
		if (selected.has(option.value)) selected.delete(option.value)
		else selected.add(option.value)
		next = withAnswer(next, question.key, { options: [...selected] })
		effects.push({ kind: "render" })
		return { state: next, effects }
	}

	if (event.kind === "key-enter") {
		if (question.kind === "multi") {
			const selection = next.answers.get(question.key) ?? { options: [] }
			next = withAnswer(next, question.key, selection)
			return advanceAfterAnswer(next, effects)
		}

		const option = options[next.optionIndex]
		if (!option) return { state: next, effects }
		if (option.isOther) return enterTextMode(next, question)
		next = withAnswer(next, question.key, { option: option.value })
		return advanceAfterAnswer(next, effects)
	}

	if (event.kind === "key-escape") effects.push({ kind: "done", cancelled: true })
	return { state: next, effects }
}

function isMultiPage(state: FormState): boolean {
	return state.questionnaire.questions.length > 1
}

function withAnswer(state: FormState, key: string, selection: RawSelection): FormState {
	const answers = new Map(state.answers)
	answers.set(key, selection)
	return { ...state, answers }
}

function navigate(state: FormState, delta: 1 | -1): FormTransition {
	const totalPages = state.questionnaire.questions.length + 1
	return enterPage(state, (state.currentPage + delta + totalPages) % totalPages)
}

function enterTextMode(state: FormState, question: Question): FormTransition {
	const existing = state.answers.get(question.key)?.text ?? ""
	return {
		state: { ...state, inputMode: true },
		effects: [{ kind: "editor-set-text", text: existing }, { kind: "render" }],
	}
}

function advanceAfterAnswer(state: FormState, effects: FormEffect[]): FormTransition {
	if (!isMultiPage(state)) {
		effects.push({ kind: "done", cancelled: false })
		return { state, effects }
	}
	const lastQuestion = state.questionnaire.questions.length - 1
	const page = state.currentPage < lastQuestion ? state.currentPage + 1 : state.questionnaire.questions.length
	const transition = enterPage(state, page)
	return {
		state: transition.state,
		effects: [...effects, ...transition.effects],
	}
}

function enterPage(state: FormState, currentPage: number): FormTransition {
	const question = state.questionnaire.questions[currentPage]
	const inputMode = isTextQuestion(question)
	const effects: FormEffect[] = []
	if (inputMode && question) {
		effects.push({ kind: "editor-set-text", text: state.answers.get(question.key)?.text ?? "" })
	}
	effects.push({ kind: "render" })
	return {
		state: { ...state, currentPage, optionIndex: 0, inputMode },
		effects,
	}
}

function isTextQuestion(question: Question | undefined): boolean {
	return question?.kind === "text" || question?.kind === "chat"
}
