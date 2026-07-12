import type { FunctionStep, MapFn } from "./types.ts";

/**
 * Build the internal step that backs a `.map()` construct (spec §3.7).
 *
 * A map is modeled as an ordinary step so it flows through the engine's existing execution and
 * event machinery with zero special-casing:
 *  - no input schema — it ignores the linear hand-off value and derives its result purely from `ctx`;
 *  - no output schema — the downstream step's input schema validates the mapped value.
 *
 * Its output becomes the next step's input via the normal linear hand-off.
 */
export function createMapStep(name: string, transform: MapFn): FunctionStep {
  return {
    kind: "function",
    name,
    run: ({ ctx }) => transform(ctx),
  };
}
