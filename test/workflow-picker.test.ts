import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent"
import type { Component, TUI } from "@earendil-works/pi-tui"
import { describe, expect, it, vi } from "vitest"
import type { WorkflowEntry } from "../src/host/workflow-catalog.ts"
import { createWorkflowPicker, pickWorkflowInTui } from "../src/host/workflow-picker.ts"

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme

function entry(
	identity: string,
	description?: string,
	filePath = `/project/.kimchi/workflows/${identity}.workflow.ts`,
	name = identity,
) {
	return { identity, name, description, filePath } satisfies WorkflowEntry
}

function picker(entries: readonly WorkflowEntry[]) {
	const tui = { requestRender: vi.fn(), terminal: { rows: 40, columns: 120 } } as unknown as TUI
	const done = vi.fn()
	const component = createWorkflowPicker(tui, theme, entries, ".kimchi/workflows", done)
	return { component, done, tui }
}

function press(component: Component, data: string): void {
	expect(component.handleInput).toBeTypeOf("function")
	component.handleInput?.(data)
}

describe("workflow welcome quick-pick", () => {
	it("matches the screenshot's compact empty state and accepts its sole action with Enter", () => {
		const { component, done } = picker([])
		const rendered = component.render(100).join("\n")

		expect(rendered).toContain("~ Kimchi Workflows ~")
		expect(rendered).toContain("Run structured long running tasks. Workflows are stored in .kimchi/workflows.")
		expect(rendered).toContain("No workflows found.")
		expect(rendered).toContain("❯ Create a workflow")
		expect(rendered).not.toContain("1 · Create a workflow")

		press(component, "\r")
		expect(done).toHaveBeenCalledWith({ kind: "create" })
	})

	it("renders numbered workflow rows, wraps descriptions, and keeps creation last", () => {
		const { component } = picker([
			entry("implement-with-Matt", "implement a task using Matt Pocock's skills"),
			entry(
				"guided-bug-fix",
				"Investigate a bug, agree on acceptance criteria and a fix plan, then implement and verify it without committing or pushing.",
			),
		])
		const lines = component.render(74)
		const rendered = lines.join("\n")

		expect(rendered).toContain("Which workflow do you want to run?")
		expect(rendered).toContain("❯ 1 · implement-with-Matt — implement a task using Matt Pocock's skills")
		expect(rendered).toContain("  2 · guided-bug-fix — Investigate a bug")
		expect(rendered).toContain("  3 · Create new workflow")
		expect(
			lines.filter((line) => line.includes("guided-bug-fix") || line.includes("committing or pushing")),
		).toHaveLength(2)
	})

	it("moves with arrows, runs the exact selected file, and supports numbered shortcuts", () => {
		const entries = [entry("first"), entry("second")]
		const moved = picker(entries)

		press(moved.component, "\u001b[B")
		expect(moved.tui.requestRender).toHaveBeenCalledTimes(1)
		expect(moved.component.render(80).join("\n")).toContain("❯ 2 · second")
		press(moved.component, "\r")
		expect(moved.done).toHaveBeenCalledWith({ kind: "run", filePath: entries[1]?.filePath })

		const shortcut = picker(entries)
		press(shortcut.component, "3")
		expect(shortcut.done).toHaveBeenCalledWith({ kind: "create" })
	})

	it("ignores input after settling", () => {
		const { component, done, tui } = picker([entry("first"), entry("second")])

		press(component, "\r")
		press(component, "\u001b[B")

		expect(done).toHaveBeenCalledOnce()
		expect(done).toHaveBeenCalledWith({ kind: "run", filePath: "/project/.kimchi/workflows/first.workflow.ts" })
		expect(tui.requestRender).not.toHaveBeenCalled()
		expect(component.render(80).join("\n")).toContain("❯ 1 · first")
	})

	it("scrolls a catalog with more rows than the visible window", () => {
		const { component } = picker(
			Array.from({ length: 10 }, (_, index) => entry(`workflow-${String(index + 1).padStart(2, "0")}`)),
		)

		const initial = component.render(80).join("\n")
		expect(initial).toContain("1/11 · use ↑↓ to see more")
		expect(initial).not.toContain("10 · workflow-10")

		for (let index = 0; index < 9; index++) press(component, "\u001b[B")
		const scrolled = component.render(80).join("\n")
		expect(scrolled).toContain("❯ 10 · workflow-10")
		expect(scrolled).toContain("10/11 · use ↑↓ to see more")
		expect(scrolled).toContain("11 · Create new workflow")
	})

	it("uses unique filename identities when declared names match and dismisses with Escape", () => {
		const { component, done } = picker([
			entry("a", "first", "/project/.kimchi/workflows/a.workflow.ts", "deploy"),
			entry("b", "second", "/project/.kimchi/workflows/b.workflow.ts", "deploy"),
		])
		const rendered = component.render(100).join("\n")

		expect(rendered).toContain("a — first")
		expect(rendered).toContain("b — second")
		expect(rendered).not.toContain("(a.workflow.ts)")
		press(component, "\u001b")
		expect(done).toHaveBeenCalledWith(undefined)
	})

	it("uses the host's custom editor slot, adds top spacing, and settles after selection", async () => {
		const tui = { requestRender: vi.fn(), terminal: { rows: 40, columns: 120 } } as unknown as TUI
		let component: Component | undefined
		const customMock = vi.fn((factory: Parameters<ExtensionCommandContext["ui"]["custom"]>[0]) => {
			return new Promise<unknown>((resolve) => {
				component = factory(tui, theme, {} as never, resolve) as Component
			})
		})
		const ctx = {
			ui: { custom: customMock } as unknown as Pick<ExtensionCommandContext["ui"], "custom">,
		}

		const pending = pickWorkflowInTui(ctx, [], ".kimchi/workflows")
		expect(component?.render(80)[0]).toBe("")
		expect(component?.render(80).join("\n")).toContain("❯ Create a workflow")
		component?.handleInput?.("\r")
		expect(await pending).toEqual({ kind: "create" })
		expect(customMock).toHaveBeenCalledOnce()
	})

	it("fails closed so PI can restore the editor when a component input path throws", async () => {
		const tui = {
			requestRender: vi.fn(() => {
				throw new Error("render request failed")
			}),
			terminal: { rows: 40, columns: 120 },
		} as unknown as TUI
		let component: Component | undefined
		const customMock = vi.fn((factory: Parameters<ExtensionCommandContext["ui"]["custom"]>[0]) => {
			return new Promise<unknown>((resolve) => {
				component = factory(tui, theme, {} as never, resolve) as Component
			})
		})
		const ctx = {
			ui: { custom: customMock } as unknown as Pick<ExtensionCommandContext["ui"], "custom">,
		}

		const pending = pickWorkflowInTui(ctx, [entry("one"), entry("two")], ".kimchi/workflows")
		expect(() => component?.handleInput?.("\u001b[B")).not.toThrow()
		expect(await pending).toBeUndefined()
		expect(customMock).toHaveBeenCalledOnce()
	})
})
