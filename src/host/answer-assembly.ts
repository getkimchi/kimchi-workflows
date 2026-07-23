/**
 * Host adapter — pure answer assembly (spec §10; no PI runtime, no fs, no network).
 *
 * The single typed core both render paths feed. A renderer captures a {@link RawSelection} per
 * question (widget-shaped); {@link assembleAnswers} turns the batch into the structured answers
 * object keyed by `question.key` (dotted for nested sections), which the engine then maps back onto
 * the target schema via `answersToOutput`/`validateAnswers`.
 *
 * The only PI reference here is a *type* — the run mode for the capability gate — a type-only import,
 * fully erased at runtime, so this module stays offline-testable.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Question, Questionnaire, QuestionOption } from "../flow/questionnaire.ts";

/** PI run mode (`"tui" | "rpc" | "json" | "print"`), derived from the exported context type. */
export type ExtensionMode = ExtensionContext["mode"];

/** Sentinel option value meaning "the user took the implicit Other choice and typed free text". */
export const OTHER_VALUE = "__other__";

/** Display label for the implicit "Other" choice appended to a single-choice question. */
export const OTHER_LABEL = "Other…";

/** Display label for the "finish selecting" entry of the rich multi-select loop. */
export const DONE_LABEL = "Done";

/**
 * A renderer's raw capture for one question, before typing. Both render paths (the rich `ctx.ui.custom`
 * form and the native-dialog fallback) produce this shape; {@link assembleAnswers} types it.
 */
export interface RawSelection {
  /** single: the picked option value, or {@link OTHER_VALUE} when the implicit "Other" choice was taken. */
  readonly option?: string;
  /** multi: the picked option values. */
  readonly options?: readonly string[];
  /** text/chat: the entered string; also the free text when `option === OTHER_VALUE`. */
  readonly text?: string;
}

/**
 * Assemble structured answers keyed by `question.key` from a renderer's raw per-question selections
 * (pure). single → the chosen value, or the "Other" free text; multi → an array; text/chat → a string.
 * A question with no capture collapses to the empty value of its shape (`""` / `[]`).
 */
export function assembleAnswers(questionnaire: Questionnaire, raw: Readonly<Record<string, RawSelection>>): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const question of questionnaire.questions) {
    answers[question.key] = assembleOne(question, raw[question.key] ?? {});
  }
  return answers;
}

function assembleOne(question: Question, selection: RawSelection): unknown {
  switch (question.kind) {
    case "single":
      return selection.option === OTHER_VALUE ? (selection.text ?? "") : (selection.option ?? "");
    case "multi":
      return [...(selection.options ?? [])];
    case "text":
    case "chat":
      return selection.text ?? "";
  }
}

/** A question's options ordered for display: recommended first (stable), original order otherwise. */
export function orderedOptions(question: Question): QuestionOption[] {
  return [...(question.options ?? [])].sort((a, b) => optionRank(b) - optionRank(a));
}

function optionRank(option: QuestionOption): number {
  return option.recommended ? 1 : 0;
}

/** A question's prompt title: `"<section> — <question>"` when the question belongs to a section. */
export function questionTitle(question: Question): string {
  return question.section ? `${question.section} — ${question.question}` : question.question;
}

/** A single option's display label: `label` + `(recommended)` marker + ` — description` when present. */
export function optionLabel(option: QuestionOption): string {
  const recommended = option.recommended ? " (recommended)" : "";
  const description = option.description ? ` — ${option.description}` : "";
  return `${option.label}${recommended}${description}`;
}

/**
 * Capability gate (pure): render the rich `ctx.ui.custom` form only when a real terminal TUI is present.
 * Everything else (RPC / JSON / print) falls back to native per-question dialogs — which also work over
 * RPC, where `custom` cannot render.
 */
export function useRichForm(mode: ExtensionMode, hasUI: boolean): boolean {
  return hasUI && mode === "tui";
}

/**
 * The two UI primitives single/text collection needs — a selection list and a free-text input. Both
 * render paths implement this seam over their own widgets (native dialogs vs `ctx.ui.custom`), so the
 * "Other"-handling business logic below lives in exactly one place. `undefined` means the user dismissed.
 */
export interface Picker {
  pick(title: string, labels: string[]): Promise<string | undefined>;
  text(title: string, placeholder?: string): Promise<string | undefined>;
}

/**
 * Single-choice collection (spec §10): present ordered options (recommended first) plus an implicit
 * "Other → free text" entry, then map the pick back to its option value. Pure over the {@link Picker}
 * seam; returns a {@link RawSelection}, or `undefined` when the user dismisses.
 */
export async function collectSingle(picker: Picker, question: Question): Promise<RawSelection | undefined> {
  const options = orderedOptions(question);
  const labels = options.map(optionLabel);
  if (question.allowOther) labels.push(OTHER_LABEL);

  const picked = await picker.pick(questionTitle(question), labels);
  if (picked === undefined) return undefined;
  if (question.allowOther && picked === OTHER_LABEL) {
    const text = await picker.text(`${question.header}: other`, "type your answer");
    if (text === undefined) return undefined;
    return { option: OTHER_VALUE, text };
  }
  const chosen = options[labels.indexOf(picked)];
  return { option: chosen ? chosen.value : picked };
}

/**
 * Text/chat collection (spec §10): a single free-text input. Pure over the {@link Picker} seam; returns
 * a {@link RawSelection}, or `undefined` when the user dismisses.
 */
export async function collectText(picker: Picker, question: Question): Promise<RawSelection | undefined> {
  const text = await picker.text(questionTitle(question), question.header);
  if (text === undefined) return undefined;
  return { text };
}
