/**
 * Flow layer — questionnaire foundation (pure; no host/PI/network).
 *
 * The framework owns the "how to ask" contract: an annotated TypeBox target schema is the single
 * source of truth for asking, rendering, and validating structured user input.
 *
 * - {@link QuestionnaireSchema} is the canonical ask/block payload (a BATCH of questions).
 * - {@link questionnaireFromSchema} derives that batch from an annotated target `Type.Object`.
 * - {@link buildAskingProtocol} produces the prompt text injected into an agent so authors never
 *   repeat the protocol.
 * - {@link validateAnswers} validates collected answers against the target schema.
 *
 * ## Annotation vocabulary (arbitrary TypeBox metadata on the target schema)
 * Standard JSON-Schema metadata:
 *  - `title`       → a field's `header` (and a nested object's `section` label; an option's `label`).
 *  - `description` → a field's `question` text (and a literal option's `description`).
 *  - `default`     → on a single-choice field, marks the matching option `recommended`.
 * Framework metadata (pass through a schema's options object):
 *  - `allowOther?: boolean`   → the question permits a free-form "other" answer.
 *  - `chat?: boolean`         → render a free-form chat input (`kind: "chat"`) instead of text.
 *  - `recommended?: boolean`  → on a literal member, marks that option `recommended`.
 */
import { type Static, type TSchema, Type } from "typebox";
import { describeSchemaViolations } from "./validation.ts";

/** A selectable option for a single/multi question. */
export const QuestionOptionSchema = Type.Object({
  value: Type.String(),
  label: Type.String(),
  description: Type.Optional(Type.String()),
  recommended: Type.Optional(Type.Boolean()),
});
export type QuestionOption = Static<typeof QuestionOptionSchema>;

/** How a question is answered (spec §2.4/§10). */
export const QuestionKindSchema = Type.Union([Type.Literal("single"), Type.Literal("multi"), Type.Literal("text"), Type.Literal("chat")]);
export type QuestionKind = Static<typeof QuestionKindSchema>;

/** One question in a questionnaire batch. `key` addresses the answer field on the target schema. */
export const QuestionSchema = Type.Object({
  key: Type.String(),
  header: Type.String(),
  question: Type.String(),
  kind: QuestionKindSchema,
  options: Type.Optional(Type.Array(QuestionOptionSchema)),
  allowOther: Type.Optional(Type.Boolean()),
  section: Type.Optional(Type.String()),
});
export type Question = Static<typeof QuestionSchema>;

/** The canonical ask/block payload: a batch of questions with an optional title (mirrors AskUserQuestion). */
export const QuestionnaireSchema = Type.Object({
  title: Type.Optional(Type.String()),
  questions: Type.Array(QuestionSchema),
});
export type Questionnaire = Static<typeof QuestionnaireSchema>;

/** Result of validating collected answers against the target schema. */
export type AnswersCheck = { ok: true } | { ok: false; violation: string };

/**
 * Derive a {@link Questionnaire} batch from an annotated target `Type.Object` schema (pure). See the
 * module header for the annotation vocabulary and the construct → question mapping.
 */
export function questionnaireFromSchema(outputSchema: TSchema): Questionnaire {
  const meta = asMeta(outputSchema);
  const questions: Question[] = [];

  for (const [key, field] of objectProperties(outputSchema)) {
    if (isObjectSchema(field)) {
      // Nested object → a section: its sub-fields become questions keyed by the dotted parent path
      // (globally unique — two sections may share a leaf name), tagged with the section label, and
      // headed by the sub-field's own title/humanized name.
      const section = readString(field, "title") ?? humanize(key);
      for (const [subKey, subField] of objectProperties(field)) {
        const question = buildQuestion(subKey, subField, section);
        questions.push({ ...question, key: `${key}.${subKey}` });
      }
    } else {
      questions.push(buildQuestion(key, field, undefined));
    }
  }

  const questionnaire: Questionnaire = { questions };
  const title = typeof meta.title === "string" ? meta.title : undefined;
  if (title !== undefined) questionnaire.title = title;
  return questionnaire;
}

/**
 * The protocol text injected into an agent's prompt (pure). Tells the model to ask by replying with
 * ONLY `{ questions: … }` (batching questions) and to finish with ONLY `{ result: … }`, embedding
 * both the {@link QuestionnaireSchema} and the target output schema (TypeBox schemas *are* JSON Schema).
 */
export function buildAskingProtocol(outputSchema: TSchema): string {
  return [
    "When you need information from the user, reply with ONLY a JSON object of the form",
    '{ "questions": <Questionnaire> } and nothing else. Batch as many questions as you can into a',
    "single batch rather than asking one at a time. The Questionnaire must match this JSON Schema:",
    JSON.stringify(QuestionnaireSchema, null, 2),
    "",
    'When you have enough information, reply with ONLY { "result": <result> }, where <result> matches',
    "this JSON Schema:",
    JSON.stringify(outputSchema, null, 2),
  ].join("\n");
}

/** Validate collected answers against the target schema (reuses `describeSchemaViolations`). */
export function validateAnswers(outputSchema: TSchema, answers: unknown): AnswersCheck {
  const violation = describeSchemaViolations(outputSchema, answers);
  return violation ? { ok: false, violation } : { ok: true };
}

/**
 * Reassemble a flat `{ questionKey → value }` answers map into the target schema's shape (pure).
 * Top-level fields map directly by name; a nested `Type.Object` field pulls its sub-fields by the
 * dotted `"${parentKey}.${subKey}"` path that {@link questionnaireFromSchema} assigns — so two
 * sections that share a leaf name never collide.
 */
export function answersToOutput(outputSchema: TSchema, answers: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, field] of objectProperties(outputSchema)) {
    if (isObjectSchema(field)) {
      const nested: Record<string, unknown> = {};
      for (const [subKey] of objectProperties(field)) {
        const path = `${key}.${subKey}`;
        if (path in answers) nested[subKey] = answers[path];
      }
      result[key] = nested;
    } else if (key in answers) {
      result[key] = answers[key];
    }
  }
  return result;
}

/** Render collected answers as a short message to feed back into an agent's loop (spec §8.4). */
export function formatAnswers(answers: Record<string, unknown>): string {
  const lines = Object.entries(answers).map(([key, value]) => `- ${key}: ${JSON.stringify(value)}`);
  return [
    "The user answered your questionnaire:",
    ...lines,
    "",
    'Continue: reply with ONLY { "result": … } if you now have enough, or ONLY { "questions": … } if you need more.',
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------
// Schema introspection (pure; reads standard JSON-Schema keywords + framework metadata off the schema).

/** Build a single question from a leaf field schema. `section` tags it when it came from a nested object. */
function buildQuestion(key: string, field: TSchema, section: string | undefined): Question {
  const header = readString(field, "title") ?? humanize(key);
  const question: Question = {
    key,
    header,
    question: readString(field, "description") ?? header,
    kind: "text",
  };
  if (section !== undefined) question.section = section;
  if (readBool(field, "allowOther")) question.allowOther = true;

  const singleOptions = literalOptions(field);
  const multiOptions = isArraySchema(field) ? literalOptions(itemsSchema(field)) : undefined;

  if (singleOptions) {
    question.kind = "single";
    question.options = markDefault(singleOptions, asMeta(field).default);
  } else if (multiOptions) {
    question.kind = "multi";
    question.options = multiOptions;
  } else if (readBool(field, "chat")) {
    question.kind = "chat";
  }
  return question;
}

/** Options derived from a union of literals (`anyOf` of `const`) or a plain `enum`, else undefined. */
function literalOptions(schema: TSchema): QuestionOption[] | undefined {
  const meta = asMeta(schema);

  if (Array.isArray(meta.anyOf)) {
    const options = meta.anyOf.map(optionFromConstMember).filter((option): option is QuestionOption => option !== undefined);
    return options.length > 0 ? options : undefined;
  }

  if (Array.isArray(meta.enum)) {
    return meta.enum.map((value) => ({ value: String(value), label: String(value) }));
  }
  return undefined;
}

/** One `anyOf` member as a `QuestionOption`, or undefined if it is not a `const` literal. */
function optionFromConstMember(member: unknown): QuestionOption | undefined {
  if (!member || typeof member !== "object" || !("const" in member)) return undefined;
  const memberMeta = member as Record<string, unknown>;
  const value = String(memberMeta.const);
  const option: QuestionOption = { value, label: typeof memberMeta.title === "string" ? memberMeta.title : value };
  if (typeof memberMeta.description === "string") option.description = memberMeta.description;
  if (memberMeta.recommended === true) option.recommended = true;
  return option;
}

/** Mark the option whose value equals the field's `default` as recommended (preserving existing flags). */
function markDefault(options: QuestionOption[], defaultValue: unknown): QuestionOption[] {
  if (defaultValue === undefined) return options;
  const target = String(defaultValue);
  return options.map((option) => (option.value === target ? { ...option, recommended: true } : option));
}

function isObjectSchema(schema: TSchema): boolean {
  const meta = asMeta(schema);
  return meta.type === "object" && typeof meta.properties === "object" && meta.properties !== null;
}

function isArraySchema(schema: TSchema): boolean {
  const meta = asMeta(schema);
  return meta.type === "array" && meta.items !== undefined;
}

function itemsSchema(schema: TSchema): TSchema {
  return asMeta(schema).items as TSchema;
}

/** The `[fieldName, fieldSchema]` entries of an object schema (empty for non-objects). */
function objectProperties(schema: TSchema): [string, TSchema][] {
  const properties = asMeta(schema).properties;
  if (!properties || typeof properties !== "object") return [];
  return Object.entries(properties as Record<string, TSchema>);
}

/** Read a schema's arbitrary keywords (standard + framework metadata) without leaking `any`. */
function asMeta(schema: TSchema): Record<string, unknown> {
  return schema as unknown as Record<string, unknown>;
}

function readString(schema: TSchema, key: string): string | undefined {
  const value = asMeta(schema)[key];
  return typeof value === "string" ? value : undefined;
}

function readBool(schema: TSchema, key: string): boolean {
  return asMeta(schema)[key] === true;
}

/** `firstName` / `deploy_env` / `deploy-env` → `First Name` / `Deploy Env`. */
function humanize(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
