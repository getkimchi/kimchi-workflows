/**
 * Streaming vs compact rendering (spec §12.2) — the pure decision, kept separate from any actual
 * terminal/TUI wiring so it is testable with two booleans and no PI session.
 *
 * A step streams its output inline, like a normal PI agent turn, only when it is the sole step
 * executing. As soon as steps overlap (a `.parallel`/`.foreach` fan-out, spec §3.4/§3.5), every
 * concurrent step switches to compact rendering — one progress line each, with a summary flushed on
 * completion — because several interleaved token streams are unreadable. A `background` step (spec
 * §2.2) always renders compactly, whether or not anything else is running: it is a detached subagent
 * with no live conversation to stream in the first place.
 *
 * The caller supplies `othersExecuting` from whatever live step-tracking it has (e.g. the count of
 * other currently `in_progress` node paths, spec §5.1/§5.4); this function only makes the mode call.
 */

/** How a step's progress is shown (spec §12.2). */
export type RenderMode = "inline" | "compact";

/**
 * Decide a step's render mode. Pure function of exactly two facts:
 *  - `background` — is THIS step a `background` agent step (spec §2.2)?
 *  - `othersExecuting` — is at least one OTHER step executing concurrently with it?
 *
 * | background | othersExecuting | mode      |
 * | ---------- | ---------------- | --------- |
 * | false      | false            | `inline`  |
 * | false      | true             | `compact` |
 * | true       | false            | `compact` |
 * | true       | true             | `compact` |
 */
export function stepRenderMode(background: boolean, othersExecuting: boolean): RenderMode {
  if (background) return "compact";
  return othersExecuting ? "compact" : "inline";
}
