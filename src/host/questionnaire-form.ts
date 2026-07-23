/**
 * Host adapter — rich questionnaire form (spec §10.2), rendered via `ctx.ui.custom`.
 *
 * Composes PI's exported TUI widgets — {@link ExtensionSelectorComponent} for single/multi choice and
 * {@link ExtensionInputComponent} for text/chat — inside `ctx.ui.custom<T>` overlays, one per question,
 * collecting into the pure {@link assembleAnswers} core. Single-choice lists options with descriptions,
 * recommended first, plus an implicit "Other → free text" entry; multi-choice is a check/uncheck loop
 * over the same selector; text/chat is a single input.
 *
 * This is the terminal-only path — the capability gate ({@link useRichForm}) selects it only when a
 * real TUI is present, and the extension loads it lazily so RPC/offline never value-imports the widgets
 * (`@earendil-works/pi-tui` is only present inside the live harness). Visual correctness is verified
 * manually, by design.
 */
import { type ExtensionCommandContext, ExtensionInputComponent, ExtensionSelectorComponent } from "@earendil-works/pi-coding-agent";
import type { Question, Questionnaire } from "../flow/questionnaire.ts";

/** The slice of the command context the rich form needs: the `ctx.ui.custom` overlay seam. */
type FormContext = Pick<ExtensionCommandContext, "ui">;

import { assembleAnswers, collectSingle, collectText, DONE_LABEL, optionLabel, orderedOptions, type Picker, questionTitle, type RawSelection } from "./answer-assembly.ts";

/** A {@link Picker} over `ctx.ui.custom` TUI overlays — the primitives single/text collection is shared on. */
function tuiPicker(ctx: FormContext): Picker {
  return {
    pick: (title, labels) => selector(ctx, title, labels),
    text: (title, placeholder) => textInput(ctx, title, placeholder),
  };
}

/**
 * Render the questionnaire as a sequence of rich overlays and return the structured answers keyed by
 * `question.key`. Returns `undefined` if the user cancels any widget (dismiss ≠ cancel — the caller
 * keeps the run parked).
 */
export async function renderRichForm(ctx: FormContext, questionnaire: Questionnaire): Promise<Record<string, unknown> | undefined> {
  const picker = tuiPicker(ctx);
  const raw: Record<string, RawSelection> = {};
  for (const question of questionnaire.questions) {
    const selection = await renderQuestion(ctx, picker, question);
    if (selection === undefined) return undefined; // cancelled
    raw[question.key] = selection;
  }
  return assembleAnswers(questionnaire, raw);
}

function renderQuestion(ctx: FormContext, picker: Picker, question: Question): Promise<RawSelection | undefined> {
  switch (question.kind) {
    case "single":
      return collectSingle(picker, question);
    case "multi":
      return renderMulti(ctx, question);
    case "text":
    case "chat":
      return collectText(picker, question);
  }
}

/** Multi-choice is genuinely different from single/text: a check/uncheck loop over one selector. */
async function renderMulti(ctx: FormContext, question: Question): Promise<RawSelection | undefined> {
  const options = orderedOptions(question);
  const selected = new Set<string>();
  const title = questionTitle(question);
  for (;;) {
    const labels = options.map((candidate) => `${selected.has(candidate.value) ? "[x]" : "[ ]"} ${optionLabel(candidate)}`);
    labels.push(DONE_LABEL);
    const picked = await selector(ctx, title, labels);
    if (picked === undefined) return undefined; // cancelled
    if (picked === DONE_LABEL) return { options: [...selected] };
    const option = options[labels.indexOf(picked)];
    if (!option) continue;
    if (selected.has(option.value)) selected.delete(option.value);
    else selected.add(option.value);
  }
}

/** One selector overlay: resolves to the chosen label, or `undefined` on cancel. */
function selector(ctx: FormContext, title: string, labels: string[]): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>(
    (tui, _theme, _keybindings, done) =>
      new ExtensionSelectorComponent(
        title,
        labels,
        (option) => done(option),
        () => done(undefined),
        { tui },
      ),
  );
}

/** One text-input overlay: resolves to the entered string, or `undefined` on cancel. */
function textInput(ctx: FormContext, title: string, placeholder?: string): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>(
    (tui, _theme, _keybindings, done) =>
      new ExtensionInputComponent(
        title,
        placeholder,
        (value) => done(value),
        () => done(undefined),
        { tui },
      ),
  );
}
