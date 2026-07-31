/**
 * The names of the two tools a step submits its output through.
 *
 * A leaf module with no imports: both the prompt text that TELLS a model to call them (questionnaire.ts)
 * and the contract that READS the calls back (engine/output-tools.ts) need these, and they must agree —
 * a prompt naming a tool the engine does not read is the failure this file exists to prevent. Keeping
 * them here rather than in engine/output-tools.ts avoids a flow → engine import cycle.
 */

/** Submits the step's result. Parameters are `{ result: <the step's outputSchema> }`. */
export const SUBMIT_RESULT_TOOL = "submit_result"

/** Submits a question batch instead of a result, blocking the run (spec §10.1). Parameters are the questionnaire. */
export const SUBMIT_QUESTIONS_TOOL = "submit_questions"
