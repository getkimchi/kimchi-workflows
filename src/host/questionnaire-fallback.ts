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
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Question, Questionnaire } from "../flow/questionnaire.ts";
import { collectQuestionnaire, optionLabel, orderedOptions, type Picker, questionTitle, type RawSelection } from "./answer-assembly.ts";

/** The subset of `ctx.ui` the fallback needs — narrowed so tests can supply a scripted stand-in. */
export type DialogUI = Pick<ExtensionUIContext, "select" | "confirm" | "input">;

/** A {@link Picker} over PI's native dialogs — the primitives single/text collection is shared on. */
function dialogPicker(ui: DialogUI): Picker {
  return {
    pick: (title, labels) => ui.select(title, labels),
    text: (title, placeholder) => ui.input(title, placeholder),
  };
}

/**
 * Drive the questionnaire through native dialogs and return the structured answers keyed by
 * `question.key`. Returns `undefined` if the user dismisses any dialog: dismiss ≠ cancel, so the
 * caller keeps the run blocked (spec §10.2).
 */
export function collectViaDialogs(ui: DialogUI, questionnaire: Questionnaire): Promise<Record<string, unknown> | undefined> {
  return collectQuestionnaire(questionnaire, dialogPicker(ui), (question) => collectMulti(ui, question));
}

/** Multi-choice is the one question kind the shared driver cannot serve over `Picker`: one yes/no confirm per option. */
async function collectMulti(ui: DialogUI, question: Question): Promise<RawSelection> {
  const chosen: string[] = [];
  for (const option of orderedOptions(question)) {
    const yes = await ui.confirm(questionTitle(question), `Include "${optionLabel(option)}"?`);
    if (yes) chosen.push(option.value);
  }
  return { options: chosen };
}
