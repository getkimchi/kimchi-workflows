import { describe, expect, it } from "vitest";
import type { RunEvent } from "../src/engine/types.ts";
import { createStep, createWorkflow } from "../src/flow/index.ts";
import { collapse } from "../src/progress/collapse.ts";
import { buildOutline } from "../src/progress/outline.ts";
import { project } from "../src/progress/project.ts";
import { formatTokens, type RenderOptions, render } from "../src/progress/render.ts";
import type { ProgressTheme } from "../src/progress/types.ts";
import {
  at,
  blockedRetryRun,
  branchRun,
  foreachRun,
  idleLoopRun,
  loopRun,
  nestedRun,
  now,
  parallelRun,
  plainTheme,
  RUN_ID,
  runStarted,
  type Scenario,
  sequenceRun,
  settledRetryRun,
  terminalRun,
  viewOf,
} from "./progress-fixtures.ts";

/** The whole panel for a scenario: blank line, header, tree, blank line, footer, blank line. */
function panel(scenario: Scenario, width = 72, options: Partial<Omit<RenderOptions, "width" | "theme">> = {}): string[] {
  const view = viewOf(scenario);
  return render(view, collapse(view), { width, theme: plainTheme, ...options });
}

/** Just the tree — the lines between the two rules, which is where every §4 rule shows. */
function rowsOf(lines: readonly string[]): string[] {
  return lines.slice(3, lines.indexOf("", 3));
}

const everyScenario: readonly [string, Scenario][] = [
  ["sequence", sequenceRun()],
  ["loop", loopRun()],
  ["foreach", foreachRun()],
  ["parallel", parallelRun()],
  ["branch", branchRun()],
  ["nested", nestedRun()],
  ["blocked + retrying", blockedRetryRun()],
  ["terminal", terminalRun()],
];

/**
 * Golden lines, one panel per construct (progress §12.1). These are the whole point of §4.11's
 * styling-applied-last rule: with two identity functions standing in for a terminal, the renderer's
 * real output — every pad, every connector, every column — is a plain string an assertion can read.
 *
 * They are deliberately full-panel rather than per-fragment. The alignment grid (§4.2) is a property of
 * a panel, not of a row, and a per-row assertion would pass happily while the columns drifted apart.
 */
describe("render (progress §4): golden panels per construct", () => {
  it("a sequence: one step settled, one running with its spend, one not reached", () => {
    expect(panel(sequenceRun())).toEqual([
      "",
      "  ── fix-until-green ─────────────────────────────── 3f9a2c1d · 00:15 ──",
      "",
      "    ✓ analyze                                           3.1s",
      "    ⠋ plan                                     running · 11s  3.2k tok",
      "    ○ summarize",
      "",
      "  ━━━━━━━━━━━━━━━━━╸─────────────────────────────────  1 of 3 · 3.2k tok",
      "",
    ]);
  });

  it("a loop mid-iteration: `↻ 2/10` on the loop row, iteration 2's body below it", () => {
    expect(panel(loopRun())).toEqual([
      "",
      "  ── fix-until-green ─────────────────────────────── 3f9a2c1d · 01:18 ──",
      "",
      "    ✓ analyze                                          3.1s",
      "    ▾ until-green                                    ↻ 2/10  11.3k tok",
      "    │ ✓ implement                                     21.0s   8.1k tok",
      "    │ ⠋ test                                  running · 12s   3.2k tok",
      "    └ ✓ review                                         2.7s",
      "    ○ summarize",
      "",
      // `test` completed in iteration 1 and is running again in iteration 2 — the bar holds instead of
      // retreating by the whole body every time the loop goes round (progress §6.4.1).
      "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╸─────────  4 of 5 · 11.3k tok",
      "",
    ]);
  });

  it("a foreach with live items: a segment track on the construct, one row per item in flight", () => {
    expect(panel(foreachRun())).toEqual([
      "",
      "  ── release-audit ───────────────────────────────── 3f9a2c1d · 00:23 ──",
      "",
      "    ✓ collect-changes                                   1.2s",
      "    ▾ review-each                          ▰▱▱▱▱▱▱ 1/7 items  8.8k tok",
      "    │ ✓ review · src/engine                            12.7s  4.1k tok",
      "    │ ⠋ review · src/host                       running · 9s  2.8k tok",
      "    └ ⠋ review · src/flow                       running · 6s  1.9k tok",
      "",
      // 1 collected + all SEVEN declared items: the fan-out's size is known from `foreach-started`,
      // so the denominator does not grow item by item as the rows appear (progress §6.4.1).
      "  ━━━━━━━━━━━━━╸─────────────────────────────────────  2 of 8 · 8.8k tok",
      "",
    ]);
  });

  it("a parallel fan-out: every in-flight arm animates at once (progress §5.5)", () => {
    expect(panel(parallelRun())).toEqual([
      "",
      "  ── audit ───────────────────────────────────────── 3f9a2c1d · 00:09 ──",
      "",
      "    ✓ collect                                          0.9s",
      "    ▾ checks                                         3 arms  12.4k tok",
      "    │ ✓ lint                                           3.6s",
      "    │ ⠋ types                                  running · 8s",
      "    └ ⠋ tests                                  running · 8s  12.4k tok",
      "",
      "  ━━━━━━━━━━━━━━━━━━━━━━━━━╸────────────────────────  2 of 4 · 12.4k tok",
      "",
    ]);
  });

  it("a branch with a skipped arm: the skip is one row, the taken arm expands", () => {
    expect(panel(branchRun())).toEqual([
      "",
      "  ── release-audit ───────────────────────────────── 3f9a2c1d · 00:06 ──",
      "",
      "    ▾ gate                                                      2 arms",
      "    │ ⊘ needs-migration                                        skipped",
      "    └ ▾ changelog                                         running · 6s",
      "      └ ⠋ write-changelog                                 running · 5s",
      "",
      // `migrate`, inside the untaken arm, is settled-as-skipped — it counts, and it will never run.
      "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╸──────────────────────────────  1 of 2",
      "",
    ]);
  });

  it("a finished nested workflow folds to one summary row (progress §6.1)", () => {
    expect(panel(nestedRun())).toEqual([
      "",
      "  ── release ─────────────────────────────────────── 3f9a2c1d · 01:00 ──",
      "",
      "    ▸ audit                                          ✓ 2 steps · 51.0s",
      "    ⠋ publish                                             running · 9s",
      "",
      "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╸────────────────────  2 of 3",
      "",
    ]);
  });
});

describe("render (progress §4.4, §4.9): golden panels per state", () => {
  it("blocked and retrying: the retry badge outranks the duration, `waiting` names the batch size", () => {
    expect(panel(blockedRetryRun())).toEqual([
      "",
      "  ── states ──────────────────────────────────────── 3f9a2c1d · 00:09 ──",
      "",
      "    ⠋ flaky                                 retry 2/3 · invalid output",
      "    ? sign-off                                   waiting · 2 questions",
      "",
      "  ──────────────────────────────────────────────────────────────  0 of 2",
      "",
    ]);
  });

  it("optional-failed, crashed and cancelled: three glyphs, three different things (progress §4.4)", () => {
    // `⚠` vs `✗` is the difference between a step the author chose to be able to lose (spec §9.1) and
    // the one that ended the run — the panel must not say the same thing about both.
    expect(panel(terminalRun())).toEqual([
      "",
      "  ── states ──────────────────────────────────────── 3f9a2c1d · 00:07 ──",
      "",
      "    ⚠ changelog                     failed · optional · 2.4s  6.2k tok",
      "    ✗ boom                                     failed · 0.6s",
      "    ■ stopped                                      cancelled",
      "",
      "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  3 of 3 · 6.2k tok",
      "",
    ]);
  });

  it("a live loop between iterations keeps its live form — no past-tense summary over a running run", () => {
    // The bug this pins: every body row holds the last iteration's `completed`, so a subtree roll-up
    // collapsed the loop to `▸ until-green  ↻ 2 iterations · 7s` while it was still going.
    const rows = rowsOf(panel(idleLoopRun()));
    expect(rows).toEqual([
      "    ▾ until-green                                               ↻ 2/10",
      "    │ ✓ implement                                                21.0s",
      "    └ ✓ test                                                     18.2s",
      "    ○ summarize",
    ]);
  });

  it("a settled retry reads as history, not as in-flight (progress §4.9)", () => {
    expect(rowsOf(panel(settledRetryRun()))).toEqual(["    ✓ implement                                        2 tries · 21.0s"]);
  });

  it("the spinner is an input, not state: the same view at a different frame differs only in its glyph", () => {
    const [first, second] = [panel(sequenceRun(), 72, { frame: 0 }), panel(sequenceRun(), 72, { frame: 3 })];
    expect(rowsOf(second)[1]).toBe("    ⠸ plan                                     running · 11s  3.2k tok");
    expect(rowsOf(first).map((line) => line.replace(/[⠋⠸]/, "*"))).toEqual(rowsOf(second).map((line) => line.replace(/[⠋⠸]/, "*")));
  });
});

// -- Degradation (progress §4.10) -----------------------------------------------------------------------

const longNames: Scenario = (() => {
  const base = sequenceRun();
  const long = "analyze-every-single-package-in-the-monorepo";
  return {
    ...base,
    definition: createWorkflow({ name: "fix-until-green" })
      .then(createStep({ name: long, run: () => ({}) }))
      .then(createStep({ name: "plan", run: () => ({}) }))
      .then(createStep({ name: "summarize", run: () => ({}) }))
      .commit(),
    events: base.events.map((event) => ("path" in event && event.path === "analyze" ? { ...event, path: long } : event)),
  };
})();

describe("render (progress §4.10): degrade by removing whole elements", () => {
  it("the token cell goes first when both cells cannot sit beside the longest name", () => {
    expect(panel(longNames, 72)).toEqual([
      "",
      "  ── fix-until-green ─────────────────────────────── 3f9a2c1d · 00:15 ──",
      "",
      "    ✓ analyze-every-single-package-in-the-monorepo                3.1s",
      "    ⠋ plan                                               running · 11s",
      "    ○ summarize",
      "",
      "  ━━━━━━━━━━━━━━━━━╸─────────────────────────────────  1 of 3 · 3.2k tok",
      "",
    ]);
  });

  it("then the NAME takes the ellipsis — the metadata carries the live information (progress §6.4)", () => {
    expect(panel(longNames, 62)).toEqual([
      "",
      "  ── fix-until-green ───────────────────── 3f9a2c1d · 00:15 ──",
      "",
      "    ✓ analyze-every-single-package-in-the-mo…           3.1s",
      "    ⠋ plan                                     running · 11s",
      "    ○ summarize",
      "",
      "  ━━━━━━━━━━━━━━╸──────────────────────────  1 of 3 · 3.2k tok",
      "",
    ]);
  });

  it("the footer survives a panel whose rows have no metadata at all — it is a fact about the RUN", () => {
    // The zero state: `run-started` and nothing else. Every row is `todo`, so there is no row metadata
    // to size a column from — but `0 of 3` is precisely the most useful thing on screen at that moment,
    // and tying the footer to the rows' layout made it vanish exactly there.
    const scenario = sequenceRun();
    const panelLines = panel({ ...scenario, events: [runStarted("fix-until-green")], nowMs: 0 });
    expect(panelLines).toEqual([
      "",
      "  ── fix-until-green ─────────────────────────────── 3f9a2c1d · 00:00 ──",
      "",
      "    ○ analyze",
      "    ○ plan",
      "    ○ summarize",
      "",
      "  ──────────────────────────────────────────────────────────────  0 of 3",
      "",
    ]);
  });

  it("below ~60 columns the metadata column goes entirely, and the footer bar with it", () => {
    expect(panel(sequenceRun(), 50)).toEqual(["", "  ── fix-until-green ───────── 3f9a2c1d · 00:15 ──", "", "    ✓ analyze", "    ⠋ plan", "    ○ summarize", ""]);
  });

  it("the grid stays inside the terminal at every width, for every construct", () => {
    for (const [label, scenario] of everyScenario) {
      for (const width of [40, 50, 60, 62, 72, 100, 200]) {
        for (const line of panel(scenario, width)) {
          expect([label, width, line.length <= width]).toEqual([label, width, true]);
        }
      }
    }
  });
});

// -- The two asserted properties (progress §12.2) ---------------------------------------------------------

describe("render (progress §12.2): the two properties, asserted rather than snapshotted", () => {
  /**
   * (a) The metadata column sits at the same offset on every row of a render.
   *
   * Both cells are right-aligned into fixed-width fields, so every row carrying metadata ends at one of
   * exactly two columns — the status column, or the token column beyond it — and the distance between
   * them is the token field plus its gap. If any row's field width were computed per row rather than per
   * render, this would fall apart immediately, and the panel would look thrown together in exactly the
   * way progress §4.2 exists to prevent.
   */
  it("(a) every row's metadata is right-aligned to the same one or two columns", () => {
    for (const [label, scenario] of everyScenario) {
      const view = viewOf(scenario);
      const rows = collapse(view);
      const lines = rowsOf(render(view, rows, { width: 72, theme: plainTheme }));

      // A row carries metadata iff something follows the name across a run of padding.
      const ends = [...new Set(lines.filter((line) => /\S {2,}\S/.test(line)).map((line) => line.length))].sort((a, b) => a - b);
      expect([label, ends.length <= 2]).toEqual([label, true]);

      if (ends.length === 2) {
        const tokenField = Math.max(...rows.map((row) => (row.node.tokens > 0 ? `${formatTokens(row.node.tokens)} tok`.length : 0)));
        // The two columns are exactly one gap plus one token field apart — nothing per-row about it.
        expect([label, (ends[1] as number) - (ends[0] as number)]).toEqual([label, 2 + tokenField]);
      }
    }
  });

  /**
   * (b) Two renders whose only difference is sub-second elapsed time are byte-identical (progress §4.8).
   *
   * This is what lets a diffing TUI redraw nothing between spinner ticks, and it is exactly the kind of
   * thing that decays silently: one `toFixed(1)` on a live duration and the panel starts flickering
   * through tenths ten times a second with every test still green.
   */
  it("(b) a whole second of `now` renders byte-identically", () => {
    // Every clock in this run starts on a whole second, so the entire second is one window: any
    // difference at all between these 1000 renders would be a sub-second leak.
    const scenario: Scenario = {
      definition: createWorkflow({ name: "tick" })
        .then(createStep({ name: "warm", run: () => ({}) }))
        .then(createStep({ name: "work", run: () => ({}) }))
        .commit(),
      events: [
        runStarted("tick"),
        { type: "step-started", runId: RUN_ID, path: "warm", input: undefined, at: at(0) },
        { type: "step-completed", runId: RUN_ID, path: "warm", output: undefined, at: at(3100) },
        { type: "step-started", runId: RUN_ID, path: "work", input: undefined, at: at(4000) },
      ],
      nowMs: 30_000,
    };

    const baseline = panel(scenario, 72);
    for (let offset = 1; offset < 1000; offset++) {
      const view = project(buildOutline(scenario.definition), scenario.events, now(scenario.nowMs + offset));
      expect([offset, render(view, collapse(view), { width: 72, theme: plainTheme })]).toEqual([offset, baseline]);
    }
    // ...and the very next millisecond genuinely does move, so the assertion above is not vacuous.
    const ticked = project(buildOutline(scenario.definition), scenario.events, now(scenario.nowMs + 1000));
    expect(render(ticked, collapse(ticked), { width: 72, theme: plainTheme })).not.toEqual(baseline);
  });

  it("(b) holds for the real fixtures too, across each one's own second", () => {
    // Only fixtures whose live clocks all start on a whole second qualify for a full-second sweep: a
    // step that started at `x.9s` legitimately ticks over partway through, and the property is about
    // renders inside ONE second of each clock, not about a fixed wall-clock window.
    for (const scenario of [loopRun(), foreachRun()]) {
      const baseline = panel(scenario);
      for (const offset of [1, 137, 500, 999]) {
        expect(panel({ ...scenario, nowMs: scenario.nowMs + offset })).toEqual(baseline);
      }
    }
  });
});

// -- Styling is applied last (progress §4.11) --------------------------------------------------------------

describe("render (progress §4.11): padding is computed on plain strings, the theme wraps afterwards", () => {
  it("a marking theme changes only what is inside the markers, never a column", () => {
    // ANSI-aware width arithmetic is a recurring source of off-by-N corruption; this pins the ordering
    // that makes it impossible — strip the markers and the styled render IS the plain one.
    const marking: ProgressTheme = { fg: (colour, text) => `«${colour}:${text}»`, bold: (text) => `«b:${text}»` };
    for (const [label, scenario] of everyScenario) {
      const view = viewOf(scenario);
      const rows = collapse(view);
      const styled = render(view, rows, { width: 72, theme: marking });
      const stripped = styled.map((line) => line.replace(/«[a-zA-Z]+:/g, "").replace(/»/g, ""));
      expect([label, stripped]).toEqual([label, render(view, rows, { width: 72, theme: plainTheme })]);
    }
  });

  it("the run label defaults to the run id's hash and can be supplied by the host", () => {
    expect(panel(sequenceRun())[1]).toContain("3f9a2c1d · 00:15");
    expect(panel(sequenceRun(), 72, { runLabel: "abcd1234" })[1]).toContain("abcd1234 · 00:15");
  });

  it("a workflow with no recorded run still draws its declared shape, clock at zero", () => {
    const definition = createWorkflow({ name: "unrun" })
      .then(createStep({ name: "first", run: () => ({}) }))
      .commit();
    const empty: readonly RunEvent[] = [];
    const view = project(buildOutline(definition), empty, now(9000));
    expect(render(view, collapse(view), { width: 72, theme: plainTheme })).toEqual([
      "",
      "  ── unrun ──────────────────────────────────────────────────── 00:00 ──",
      "",
      "    ○ first",
      "",
      // The footer is a fact about the RUN, not about the rows: a panel whose steps have no metadata
      // yet is exactly when `0 of 1` is the most useful thing on it.
      "  ──────────────────────────────────────────────────────────────  0 of 1",
      "",
    ]);
  });
});
