/**
 * Host adapter — one rich, multi-page questionnaire form rendered through `ctx.ui.custom`.
 *
 * Text answers use PI's multiline Editor. Multi-select options behave like checkboxes: Space toggles
 * the focused row in place. A questionnaire with more than one question keeps all answers in the same
 * overlay and completes only from its final Submit page.
 */
import { type ExtensionCommandContext, getSelectListTheme, type Theme } from "@earendil-works/pi-coding-agent"
import {
	type Component,
	Editor,
	Key,
	matchesKey,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui"
import type { Question, Questionnaire } from "../flow/questionnaire.ts"
import { OTHER_VALUE, optionLabel, questionTitle, type RawSelection } from "./answer-assembly.ts"
import {
	allQuestionsAnswered,
	currentFormOptions,
	currentFormQuestion,
	type FormEffect,
	type FormEvent,
	type FormState,
	formAnswers,
	initialFormState,
	isSubmitPage,
	reduceForm,
} from "./questionnaire-form-state.ts"

/** The slice of the command context the rich form needs: the `ctx.ui.custom` overlay seam. */
type FormContext = Pick<ExtensionCommandContext, "ui">

/** Render the questionnaire and return structured answers, or `undefined` when the user cancels. */
export function renderRichForm(
	ctx: FormContext,
	questionnaire: Questionnaire,
): Promise<Record<string, unknown> | undefined> {
	if (questionnaire.questions.length === 0) return Promise.resolve({})
	return ctx.ui.custom<Record<string, unknown> | undefined>((tui, theme, _keybindings, done) =>
		createQuestionnaireForm(tui, theme, questionnaire, done),
	)
}

/** Build the rich questionnaire component. Exported so keyboard/render integration can be tested. */
export function createQuestionnaireForm(
	tui: TUI,
	theme: Theme,
	questionnaire: Questionnaire,
	done: (answers: Record<string, unknown> | undefined) => void,
): Component {
	let state = initialFormState(questionnaire)
	let cachedLines: string[] | undefined
	let cachedWidth = 0
	let completed = false
	const editor = new Editor(tui, {
		borderColor: (text) => theme.fg("muted", text),
		selectList: getSelectListTheme(),
	})
	editor.focused = true

	function applyEffects(effects: readonly FormEffect[]): void {
		for (const effect of effects) {
			switch (effect.kind) {
				case "render":
					cachedLines = undefined
					tui.requestRender()
					break
				case "editor-set-text":
					editor.setText(effect.text)
					break
				case "done":
					if (completed) break
					completed = true
					done(effect.cancelled ? undefined : formAnswers(state))
					break
			}
		}
	}

	function dispatch(event: FormEvent): void {
		const transition = reduceForm(state, event)
		state = transition.state
		applyEffects(transition.effects)
	}

	editor.onSubmit = (value) => dispatch({ kind: "editor-submit", value })

	function handleInput(data: string): void {
		if (state.inputMode) {
			if (matchesKey(data, Key.escape)) dispatch({ kind: "key-escape" })
			else {
				editor.handleInput(data)
				cachedLines = undefined
				tui.requestRender()
			}
			return
		}

		const event = keyEvent(data)
		if (event) dispatch(event)
	}

	function render(width: number): string[] {
		if (cachedLines && cachedWidth === width) return cachedLines
		const renderWidth = Math.max(1, width)
		const lines: string[] = []
		const question = currentFormQuestion(state)
		const options = currentFormOptions(state)

		const add = (text: string) => lines.push(...wrapTextWithAnsi(text, renderWidth))
		const addWithPrefix = (prefix: string, text: string) => {
			const prefixWidth = visibleWidth(prefix)
			if (prefixWidth >= renderWidth) {
				add(prefix + text)
				return
			}
			const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth)
			for (let index = 0; index < wrapped.length; index++) {
				lines.push(`${index === 0 ? prefix : " ".repeat(prefixWidth)}${wrapped[index]}`)
			}
		}

		add(theme.fg("accent", "─".repeat(renderWidth)))
		if (questionnaire.title) {
			addWithPrefix(" ", theme.fg("text", theme.bold(questionnaire.title)))
			lines.push("")
		}

		if (questionnaire.questions.length > 1) {
			renderTabs(state, theme, addWithPrefix)
			lines.push("")
		}

		if (state.inputMode && question) {
			addWithPrefix(" ", theme.fg("text", questionTitle(question)))
			lines.push("")
			addWithPrefix(" ", theme.fg("muted", "Your answer:"))
			for (const line of editor.render(Math.max(1, renderWidth - 2))) addWithPrefix(" ", line)
			lines.push("")
			const action = questionnaire.questions.length > 1 ? "Enter continue" : "Enter submit"
			addWithPrefix(" ", theme.fg("dim", `${action} • Shift+Enter newline • Esc close editor`))
		} else if (isSubmitPage(state)) {
			renderSubmitPage(state, theme, addWithPrefix, lines)
		} else if (question?.kind === "text" || question?.kind === "chat") {
			addWithPrefix(" ", theme.fg("text", questionTitle(question)))
			const existing = state.answers.get(question.key)?.text
			if (existing !== undefined) {
				lines.push("")
				addWithPrefix(" ", theme.fg("muted", "Current answer:"))
				addWithPrefix("   ", theme.fg("text", existing || "(empty)"))
			}
			lines.push("")
			addWithPrefix(" ", theme.fg("dim", "Press Enter to edit"))
		} else if (question) {
			addWithPrefix(" ", theme.fg("text", questionTitle(question)))
			lines.push("")
			const selected = new Set(state.answers.get(question.key)?.options ?? [])
			for (const [index, option] of options.entries()) {
				const focused = index === state.optionIndex
				const prefix = focused ? theme.fg("accent", "> ") : "  "
				const checkbox = question.kind === "multi" ? `${selected.has(option.value) ? "[x]" : "[ ]"} ` : ""
				addWithPrefix(prefix, theme.fg(focused ? "accent" : "text", `${checkbox}${optionLabel(option)}`))
			}
		}

		lines.push("")
		if (!state.inputMode) addWithPrefix(" ", theme.fg("dim", helpText(state)))
		add(theme.fg("accent", "─".repeat(renderWidth)))

		cachedLines = lines
		cachedWidth = width
		return lines
	}

	return {
		render,
		invalidate: () => {
			cachedLines = undefined
			cachedWidth = 0
		},
		handleInput,
	}
}

function keyEvent(data: string): FormEvent | undefined {
	if (matchesKey(data, Key.up)) return { kind: "key-up" }
	if (matchesKey(data, Key.down)) return { kind: "key-down" }
	if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) return { kind: "key-right" }
	if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) return { kind: "key-left" }
	if (matchesKey(data, Key.enter)) return { kind: "key-enter" }
	if (matchesKey(data, Key.escape)) return { kind: "key-escape" }
	if (matchesKey(data, Key.space)) return { kind: "key-space" }
	return undefined
}

function renderTabs(state: FormState, theme: Theme, addWithPrefix: (prefix: string, text: string) => void): void {
	const tabs = ["← "]
	for (const [index, question] of state.questionnaire.questions.entries()) {
		const answered = state.answers.has(question.key)
		const text = ` ${answered ? "■" : "□"} ${question.header} `
		const styled =
			index === state.currentPage
				? theme.bg("selectedBg", theme.fg("text", text))
				: theme.fg(answered ? "success" : "muted", text)
		tabs.push(`${styled} `)
	}
	const submitText = " ✓ Submit "
	const submit = isSubmitPage(state)
		? theme.bg("selectedBg", theme.fg("text", submitText))
		: theme.fg(allQuestionsAnswered(state) ? "success" : "dim", submitText)
	tabs.push(`${submit} →`)
	addWithPrefix(" ", tabs.join(""))
}

function renderSubmitPage(
	state: FormState,
	theme: Theme,
	addWithPrefix: (prefix: string, text: string) => void,
	lines: string[],
): void {
	addWithPrefix(" ", theme.fg("accent", theme.bold("Ready to submit")))
	lines.push("")
	for (const question of state.questionnaire.questions) {
		const selection = state.answers.get(question.key)
		const summary = selection ? answerSummary(question, selection) : "(unanswered)"
		addWithPrefix(` ${theme.fg("muted", `${question.header}: `)}`, theme.fg("text", summary))
	}
	lines.push("")
	if (allQuestionsAnswered(state)) addWithPrefix(" ", theme.fg("success", "Press Enter to submit"))
	else {
		const missing = state.questionnaire.questions
			.filter((question) => !state.answers.has(question.key))
			.map((question) => question.header)
			.join(", ")
		addWithPrefix(" ", theme.fg("warning", `Unanswered: ${missing}`))
	}
}

function answerSummary(question: Question, selection: RawSelection): string {
	if (question.kind === "text" || question.kind === "chat") return selection.text || "(empty)"
	if (question.kind === "single") {
		if (selection.option === OTHER_VALUE) return selection.text || "(empty)"
		return (
			question.options?.find((option) => option.value === selection.option)?.label ?? selection.option ?? "(unanswered)"
		)
	}
	const selected = new Set(selection.options ?? [])
	const labels = (question.options ?? []).filter((option) => selected.has(option.value)).map((option) => option.label)
	return labels.length > 0 ? labels.join(", ") : "(none)"
}

function helpText(state: FormState): string {
	const multiPage = state.questionnaire.questions.length > 1
	if (isSubmitPage(state)) return "Tab/←→ navigate • Enter submit • Esc cancel"
	const question = currentFormQuestion(state)
	const navigation = multiPage ? "Tab/←→ pages • " : ""
	const action = multiPage ? "Enter continue" : "Enter submit"
	if (question?.kind === "multi") return `${navigation}↑↓ navigate • Space toggle • ${action} • Esc cancel`
	if (question?.kind === "text" || question?.kind === "chat") {
		return `${navigation}Enter edit • Esc cancel`
	}
	return `${navigation}↑↓ navigate • ${action} • Esc cancel`
}
