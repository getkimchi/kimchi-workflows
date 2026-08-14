/**
 * Host adapter — native-dialog questionnaire fallback (spec §10.2).
 *
 * Collects each question through PI's built-in dialogs (`ctx.ui.select` / `confirm` / `input`) and
 * assembles the structured answers via the pure {@link assembleAnswers} core. These dialogs work in
 * both TUI and RPC modes, so this is the path used whenever the rich `ctx.ui.custom` form cannot render
 * (RPC / JSON / print — see {@link useRichForm}). Modeled on kimchi's questionnaire-fallback pattern.
 *
 * PI is referenced only as a *type* ({@link ExtensionUIContext}, narrowed to {@link DialogUI}) — a
 * type-only import, so this module is fully offline-testable with a scripted fake.
 */
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import type { Question, Questionnaire } from "../flow/questionnaire.ts"
import {
	assembleAnswers,
	OTHER_LABEL,
	OTHER_VALUE,
	optionLabel,
	orderedOptions,
	questionTitle,
	type RawSelection,
} from "./answer-assembly.ts"

/** The subset of `ctx.ui` the fallback needs — narrowed so tests can supply a scripted stand-in. */
export type DialogUI = Pick<ExtensionUIContext, "select" | "confirm" | "input">

/**
 * Drive the questionnaire through native dialogs and return the structured answers keyed by
 * `question.key`. Returns `undefined` if the user dismisses any dialog: dismiss ≠ cancel, so the
 * caller keeps the run blocked (spec §10.2).
 */
export async function collectViaDialogs(
	ui: DialogUI,
	questionnaire: Questionnaire,
): Promise<Record<string, unknown> | undefined> {
	const raw: Record<string, RawSelection> = {}
	for (const question of questionnaire.questions) {
		const selection = await collectOne(ui, question)
		if (selection === undefined) return undefined
		raw[question.key] = selection
	}
	return assembleAnswers(questionnaire, raw)
}

function collectOne(ui: DialogUI, question: Question): Promise<RawSelection | undefined> {
	switch (question.kind) {
		case "single":
			return collectSingle(ui, question)
		case "multi":
			return collectMulti(ui, question)
		case "text":
		case "chat":
			return collectText(ui, question)
	}
}

async function collectSingle(ui: DialogUI, question: Question): Promise<RawSelection | undefined> {
	const options = orderedOptions(question)
	const labels = options.map(optionLabel)
	if (question.allowOther) labels.push(OTHER_LABEL)

	const picked = await ui.select(questionTitle(question), labels)
	if (picked === undefined) return undefined
	if (question.allowOther && picked === OTHER_LABEL) {
		const text = await ui.input(`${question.header}: other`, "type your answer")
		return text === undefined ? undefined : { option: OTHER_VALUE, text }
	}
	return { option: options[labels.indexOf(picked)]?.value ?? picked }
}

async function collectText(ui: DialogUI, question: Question): Promise<RawSelection | undefined> {
	const text = await ui.input(questionTitle(question), question.header)
	return text === undefined ? undefined : { text }
}

/** Collect a multi-choice answer through one yes/no confirmation per option. */
async function collectMulti(ui: DialogUI, question: Question): Promise<RawSelection> {
	const chosen: string[] = []
	for (const option of orderedOptions(question)) {
		const yes = await ui.confirm(questionTitle(question), `Include "${optionLabel(option)}"?`)
		if (yes) chosen.push(option.value)
	}
	return { options: chosen }
}
