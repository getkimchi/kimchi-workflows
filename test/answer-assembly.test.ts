import { describe, expect, it } from "vitest"
import type { Question, Questionnaire } from "../src/flow/index.ts"
import {
	assembleAnswers,
	collectSingle,
	collectText,
	OTHER_VALUE,
	optionLabel,
	orderedOptions,
	type Picker,
	questionTitle,
	useRichForm,
} from "../src/host/answer-assembly.ts"
import { collectViaDialogs, type DialogUI } from "../src/host/questionnaire-fallback.ts"

// -- §1 pure answer assembly ------------------------------------------------------------------------

describe("assembleAnswers (pure core, spec §10)", () => {
	it("types single/multi/text/chat by question kind", () => {
		const questionnaire: Questionnaire = {
			questions: [
				{ key: "env", header: "Env", question: "Which?", kind: "single", options: [{ value: "prod", label: "Prod" }] },
				{ key: "tags", header: "Tags", question: "Which?", kind: "multi", options: [{ value: "a", label: "A" }] },
				{ key: "name", header: "Name", question: "Who?", kind: "text" },
				{ key: "note", header: "Note", question: "Say?", kind: "chat" },
			],
		}
		expect(
			assembleAnswers(questionnaire, {
				env: { option: "prod" },
				tags: { options: ["a", "b"] },
				name: { text: "Ada" },
				note: { text: "hello" },
			}),
		).toEqual({ env: "prod", tags: ["a", "b"], name: "Ada", note: "hello" })
	})

	it("resolves a single-choice 'Other' selection to its free text", () => {
		const questionnaire: Questionnaire = {
			questions: [
				{
					key: "env",
					header: "Env",
					question: "Which?",
					kind: "single",
					allowOther: true,
					options: [{ value: "prod", label: "Prod" }],
				},
			],
		}
		expect(assembleAnswers(questionnaire, { env: { option: OTHER_VALUE, text: "staging" } })).toEqual({
			env: "staging",
		})
	})

	it("preserves distinct dotted section keys (no collision across sections)", () => {
		const questionnaire: Questionnaire = {
			questions: [
				{ key: "source.name", header: "Name", question: "?", kind: "text", section: "Source" },
				{ key: "target.name", header: "Name", question: "?", kind: "text", section: "Target" },
			],
		}
		expect(assembleAnswers(questionnaire, { "source.name": { text: "A" }, "target.name": { text: "B" } })).toEqual({
			"source.name": "A",
			"target.name": "B",
		})
	})

	it("collapses an un-answered question to the empty value of its shape", () => {
		const questionnaire: Questionnaire = {
			questions: [
				{ key: "env", header: "Env", question: "?", kind: "single", options: [{ value: "prod", label: "Prod" }] },
				{ key: "tags", header: "Tags", question: "?", kind: "multi", options: [{ value: "a", label: "A" }] },
				{ key: "name", header: "Name", question: "?", kind: "text" },
			],
		}
		expect(assembleAnswers(questionnaire, {})).toEqual({ env: "", tags: [], name: "" })
	})
})

// -- ordering + display + gate ----------------------------------------------------------------------

describe("orderedOptions / display helpers", () => {
	it("puts recommended options first, keeping the rest in order (stable)", () => {
		const question = {
			key: "env",
			header: "Env",
			question: "?",
			kind: "single" as const,
			options: [
				{ value: "dev", label: "Dev" },
				{ value: "prod", label: "Prod", recommended: true },
				{ value: "test", label: "Test" },
			],
		}
		expect(orderedOptions(question).map((option) => option.value)).toEqual(["prod", "dev", "test"])
	})

	it("labels options with recommended marker + description, and titles questions with the section", () => {
		expect(optionLabel({ value: "prod", label: "Prod", recommended: true, description: "live" })).toBe(
			"Prod (recommended) — live",
		)
		expect(
			questionTitle({ key: "source.url", header: "URL", question: "Which URL?", kind: "text", section: "Source" }),
		).toBe("Source — Which URL?")
	})
})

describe("useRichForm capability gate (pure)", () => {
	it("is true only for a real TUI with UI, false for RPC/JSON/print/no-UI", () => {
		expect(useRichForm("tui", true)).toBe(true)
		expect(useRichForm("tui", false)).toBe(false)
		expect(useRichForm("rpc", true)).toBe(false)
		expect(useRichForm("json", true)).toBe(false)
		expect(useRichForm("print", true)).toBe(false)
	})
})

// -- shared Picker collection (collectSingle / collectText) -----------------------------------------

/** A scripted {@link Picker}: dequeues pick/text responses in call order and records what it was shown. */
function fakePicker(script: { pick?: (string | undefined)[]; text?: (string | undefined)[] }): Picker & {
	pickCalls: { title: string; labels: string[] }[]
} {
	const pick = [...(script.pick ?? [])]
	const text = [...(script.text ?? [])]
	const pickCalls: { title: string; labels: string[] }[] = []
	return {
		pickCalls,
		pick(title, labels) {
			pickCalls.push({ title, labels })
			return Promise.resolve(pick.shift())
		},
		text() {
			return Promise.resolve(text.shift())
		},
	}
}

describe("collectSingle (shared over Picker seam)", () => {
	const question: Question = {
		key: "env",
		header: "Environment",
		question: "Which environment?",
		kind: "single",
		allowOther: true,
		options: [
			{ value: "dev", label: "Dev" },
			{ value: "prod", label: "Prod", recommended: true },
		],
	}

	it("presents recommended options first + an Other entry, and maps the pick back to its value", async () => {
		const picker = fakePicker({ pick: ["Dev"] })
		expect(await collectSingle(picker, question)).toEqual({ option: "dev" })
		expect(picker.pickCalls[0]?.labels).toEqual(["Prod (recommended)", "Dev", "Other…"])
		expect(picker.pickCalls[0]?.title).toBe("Which environment?")
	})

	it("routes the Other entry to a free-text input", async () => {
		const picker = fakePicker({ pick: ["Other…"], text: ["staging"] })
		expect(await collectSingle(picker, question)).toEqual({ option: OTHER_VALUE, text: "staging" })
	})

	it("returns undefined when the selection is dismissed", async () => {
		const picker = fakePicker({ pick: [undefined] })
		expect(await collectSingle(picker, question)).toBeUndefined()
	})

	it("returns undefined when the Other free-text is dismissed", async () => {
		const picker = fakePicker({ pick: ["Other…"], text: [undefined] })
		expect(await collectSingle(picker, question)).toBeUndefined()
	})
})

describe("collectText (shared over Picker seam)", () => {
	const question: Question = { key: "name", header: "Name", question: "Your name?", kind: "text" }

	it("captures the entered text", async () => {
		const picker = fakePicker({ text: ["Ada"] })
		expect(await collectText(picker, question)).toEqual({ text: "Ada" })
	})

	it("returns undefined when dismissed", async () => {
		const picker = fakePicker({ text: [undefined] })
		expect(await collectText(picker, question)).toBeUndefined()
	})
})

// -- §3 native-dialog fallback (scripted fake ctx.ui) -----------------------------------------------

/** A scripted `ctx.ui` subset: dequeues responses in call order and records what it was shown. */
function fakeDialogs(script: {
	select?: (string | undefined)[]
	confirm?: boolean[]
	input?: (string | undefined)[]
}): DialogUI & { selectCalls: { title: string; options: string[] }[] } {
	const select = [...(script.select ?? [])]
	const confirm = [...(script.confirm ?? [])]
	const input = [...(script.input ?? [])]
	const selectCalls: { title: string; options: string[] }[] = []
	return {
		selectCalls,
		select(title, options) {
			selectCalls.push({ title, options })
			return Promise.resolve(select.shift())
		},
		confirm() {
			return Promise.resolve(confirm.shift() ?? false)
		},
		input() {
			return Promise.resolve(input.shift())
		},
	}
}

describe("collectViaDialogs (native fallback, spec §10.2)", () => {
	const single: Questionnaire = {
		questions: [
			{
				key: "env",
				header: "Environment",
				question: "Which environment?",
				kind: "single",
				allowOther: true,
				options: [
					{ value: "dev", label: "Dev" },
					{ value: "prod", label: "Prod", recommended: true },
				],
			},
		],
	}

	it("selects a single choice, presenting recommended options first with an Other entry", async () => {
		const ui = fakeDialogs({ select: ["Prod (recommended)"] })
		expect(await collectViaDialogs(ui, single)).toEqual({ env: "prod" })
		expect(ui.selectCalls[0]?.options).toEqual(["Prod (recommended)", "Dev", "Other…"])
	})

	it("routes the Other entry to a free-text input", async () => {
		const ui = fakeDialogs({ select: ["Other…"], input: ["staging"] })
		expect(await collectViaDialogs(ui, single)).toEqual({ env: "staging" })
	})

	it("collects a multi choice via per-option confirm", async () => {
		const multi: Questionnaire = {
			questions: [
				{
					key: "tags",
					header: "Tags",
					question: "Pick tags",
					kind: "multi",
					options: [
						{ value: "a", label: "A" },
						{ value: "b", label: "B" },
						{ value: "c", label: "C" },
					],
				},
			],
		}
		const ui = fakeDialogs({ confirm: [true, false, true] })
		expect(await collectViaDialogs(ui, multi)).toEqual({ tags: ["a", "c"] })
	})

	it("collects text and chat via input", async () => {
		const q: Questionnaire = {
			questions: [
				{ key: "name", header: "Name", question: "Your name?", kind: "text" },
				{ key: "note", header: "Note", question: "Anything else?", kind: "chat" },
			],
		}
		const ui = fakeDialogs({ input: ["Ada", "no"] })
		expect(await collectViaDialogs(ui, q)).toEqual({ name: "Ada", note: "no" })
	})

	it("returns undefined when the user dismisses (dismiss ≠ cancel → stay blocked)", async () => {
		const ui = fakeDialogs({ select: [undefined] })
		expect(await collectViaDialogs(ui, single)).toBeUndefined()
	})
})
