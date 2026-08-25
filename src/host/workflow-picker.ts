/** Screenshot-faithful TUI quick-pick for bare `/workflow`. */
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent"
import {
	type Component,
	Key,
	matchesKey,
	parseKey,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui"
import type { WorkflowWelcomeAction } from "./commands/welcome.ts"
import type { WorkflowEntry } from "./workflow-catalog.ts"
import { workflowOptionDisplay } from "./workflow-display.ts"

type PickerCtx = {
	ui: Pick<ExtensionCommandContext["ui"], "custom">
}

interface PickerItem {
	readonly kind: "run" | "create"
	readonly filePath?: string
	readonly name: string
	readonly description?: string
}

/**
 * Render in the host's editor slot, like `/settings`, so there is exactly one active interaction
 * surface. PI restores the ordinary editor after `done` settles this custom component.
 */
export async function pickWorkflowInTui(
	ctx: PickerCtx,
	entries: readonly WorkflowEntry[],
	directory: string,
): Promise<WorkflowWelcomeAction> {
	return ctx.ui.custom<WorkflowWelcomeAction>((tui, theme, _keybindings, done) =>
		createWorkflowPicker(tui, theme, entries, directory, done),
	)
}

/** Exported for deterministic rendering and keyboard tests without starting a PI session. */
export function createWorkflowPicker(
	tui: TUI,
	theme: Theme,
	entries: readonly WorkflowEntry[],
	directory: string,
	done: (selection: WorkflowWelcomeAction) => void,
): Component {
	const items = pickerItems(entries)
	let selectedIndex = 0
	let completed = false

	const complete = (selection: WorkflowWelcomeAction): void => {
		if (completed) return
		completed = true
		done(selection)
	}

	const move = (delta: -1 | 1): void => {
		selectedIndex = Math.max(0, Math.min(items.length - 1, selectedIndex + delta))
		tui.requestRender()
	}

	return {
		render: (width) =>
			renderPicker(theme, items, selectedIndex, directory, entries.length === 0, width, tui.terminal.rows),
		invalidate: () => {},
		handleInput: (data) => {
			try {
				if (completed) return
				if (matchesKey(data, Key.up) || data === "k") return move(-1)
				if (matchesKey(data, Key.down) || data === "j") return move(1)
				if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) return complete(undefined)
				if (matchesKey(data, Key.enter)) return complete(selectionOf(items[selectedIndex]))

				const key = parseKey(data) ?? data
				if (/^[1-9]$/.test(key)) {
					const index = Number(key) - 1
					if (index < items.length) complete(selectionOf(items[index]))
				}
			} catch {
				// Fail closed so PI restores the ordinary editor even if a picker input path fails.
				complete(undefined)
			}
		},
	}
}

function pickerItems(entries: readonly WorkflowEntry[]): PickerItem[] {
	return [
		...entries.map((entry) => {
			const display = workflowOptionDisplay(entry)
			return { kind: "run" as const, filePath: entry.filePath, ...display }
		}),
		{ kind: "create" as const, name: entries.length === 0 ? "Create a workflow" : "Create new workflow" },
	]
}

function selectionOf(item: PickerItem | undefined): WorkflowWelcomeAction {
	if (!item) return undefined
	if (item.kind === "create") return { kind: "create" }
	return item.filePath ? { kind: "run", filePath: item.filePath } : undefined
}

function renderPicker(
	theme: Theme,
	items: readonly PickerItem[],
	selectedIndex: number,
	directory: string,
	empty: boolean,
	width: number,
	terminalRows: number,
): string[] {
	const renderWidth = Math.max(1, width)
	const lines: string[] = [""]
	const add = (text: string) => lines.push(...wrapTextWithAnsi(text, renderWidth))

	add(theme.fg("success", theme.bold("~ Kimchi Workflows ~")))
	add(theme.fg("muted", `Run structured long running tasks. Workflows are stored in ${directory}.`))
	lines.push("")
	add(theme.fg("text", empty ? "No workflows found." : "Which workflow do you want to run?"))
	lines.push("")

	const maxVisible = Math.max(1, Math.min(items.length, 8, Math.max(1, terminalRows - 10)))
	const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), items.length - maxVisible))
	const end = Math.min(items.length, start + maxVisible)
	for (let index = start; index < end; index++) {
		addPickerRow(
			lines,
			theme,
			items[index] as PickerItem,
			index,
			index === selectedIndex,
			renderWidth,
			items.length > 1,
		)
	}
	if (start > 0 || end < items.length) {
		add(theme.fg("dim", `  ${selectedIndex + 1}/${items.length} · use ↑↓ to see more`))
	}
	return lines
}

function addPickerRow(
	lines: string[],
	theme: Theme,
	item: PickerItem,
	index: number,
	selected: boolean,
	width: number,
	numbered: boolean,
): void {
	const prefix = selected ? theme.fg("accent", "❯ ") : "  "
	const ordinal = numbered ? `${index + 1} · ` : ""
	const styledOrdinal = ordinal ? theme.fg(selected ? "accent" : "muted", ordinal) : ""
	const name = theme.fg(selected ? "text" : "muted", item.name)
	const description = item.description ? theme.fg("dim", ` — ${item.description}`) : ""
	const prefixWidth = visibleWidth(prefix)
	const wrapped = wrapTextWithAnsi(`${styledOrdinal}${name}${description}`, Math.max(1, width - prefixWidth))
	for (const [lineIndex, line] of wrapped.entries()) {
		lines.push(`${lineIndex === 0 ? prefix : " ".repeat(prefixWidth)}${line}`)
	}
}
