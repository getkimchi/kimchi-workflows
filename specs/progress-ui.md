# PI Workflows — Progress UI Spec

Companion to `spec.md`; supersedes its §12.1–§12.3 once built. Section references
without a prefix are to `spec.md`.

## Goal

A run must be **legible while it happens**. Today `/workflow run` emits one
`ctx.ui.notify` when the run *ends* (`src/host/commands/context.ts:109`); everything
between start and finish is invisible — the engine's event stream goes straight to
disk (`createHostPort`'s `emit`, `src/host/host-port.ts:32`) and nowhere else. A user
watching a multi-step run cannot tell which step is executing, how many remain,
whether a loop is on iteration 2 or 9, whether a step is retrying, or whether the run
is alive at all.

This spec renders the workflow **as a live structural tree pinned above the editor**,
updated in place as events arrive, replaced by one plain-text summary when the run
reaches a terminal state (§7.6.1).

**Non-goals.** Changing what the engine emits (the event stream is already
sufficient — §8.1); changing how agent output is displayed (§12.2's isolation-derived
streaming rule stands); a run *browser* beyond the summary and `/workflow status`
(§11.4); a hard line budget for the panel (§6.5 — deferred).

## 0. Repo facts this spec builds on

Verified at commit `0c0b7f1` (the session-directory/run-slug rework), suite green at
532 tests. Every one of these is load-bearing; re-check before implementing if the
tree has moved again.

- **The `emit` seam is untouched** by that rework — `src/host/host-port.ts:32` is
  still `emit: (event) => store.appendEvent(event)`, which is where §2.3 tees in.
- **Provenance is an event, not a sidecar.** `RunMeta`, `saveMeta`, and `loadMeta` are
  gone; a `run-meta` event (`src/engine/types.ts`) carries `workflowFilePath` and is
  appended by the adapter before the first engine event. A run is exactly one file.
- **Run ids are readable slugs**, `workflow-<name>-<8 hex>` (`src/host/naming.ts`), not
  UUIDs. `runIdHash(runId)` returns the trailing 8 hex — the short form the panel
  header shows.
- **Run arguments already resolve loosely.** `resolveRunRef`
  (`src/host/commands/context.ts:94`) matches exact → short hash → unique prefix and
  notifies on ambiguity; `/workflow status` (§11.4) uses it rather than matching again.
- **Artifacts live under the harness's session directory**, in a `workflow/`
  subdirectory (`src/host/project-dir.ts`), resolved per invocation from
  `ctx.sessionManager.getSessionDir()`. Under `--no-session` there is no such
  directory — one reason §7.6 announces through `notify` rather than a session entry.
- **`notifyResult` is at `src/host/commands/context.ts:109`** — the call §7.6 replaces.
- **Nothing in `src/` writes to stdout today.** §8 would be the first, which is why it
  writes to stderr instead (§8.1).
- **The harness that loads us is not the package we type-check against.** `pi` 0.80.2
  has no `registerEntryRenderer`; 0.80.10 does. Anything reached through `ExtensionAPI`
  must either exist across that range or not be used — see §7.6.1, which is what this
  cost when ignored. `notify`, `setWidget`, `setWorkingMessage`, `appendEntry` and
  `registerCommand` are all present in both.
- **`/workflow status` must be added to spec.md §14's completion grammar** (verb list,
  plus a run-id slot with no status filter — any recorded run can be shown). §14 is
  specced but not yet implemented; if it lands first, this is a one-row change.

## 1. Concepts

- **Outline** — the static tree derived from a `WorkflowDefinition`: every node in
  declaration order, nested as authored. Known before the run starts.
- **Projection** — the outline joined with a run's event log to produce per-node
  state, counters, timings, and token totals. A pure fold; the same function serves
  live rendering, resume, and the terminal summary.
- **View** — the projection collapsed (§6) and turned into styled rows.
- **Sink** — the impure host-side consumer that tees engine events into a projection
  and pushes the result at a surface (widget, summary, stderr).

## 2. Architecture

2.1. **The progress model is pure and lives outside the host.** A new `src/progress/`
layer depends only on `src/flow` types and `src/engine`'s `RunEvent`/`deriveStepStates`
— no PI, no `node:fs`, no clock of its own (`now` is a parameter). The host layer
depends on it, never the reverse. This is the same seam that makes the engine testable
(§13.1) and it exists here for the same reason: a rendering bug should be reproducible
in a unit test, not only in a terminal. *(decision)*

2.2. Modules:

| Module | Kind | Responsibility |
| --- | --- | --- |
| `src/progress/outline.ts` | pure | `buildOutline(definition)` → ordered node tree with static paths |
| `src/progress/project.ts` | pure | `project(outline, events, now)` → `ProgressView` |
| `src/progress/collapse.ts` | pure | `collapse(view)` → the rows to draw (§6) |
| `src/progress/render.ts` | pure | rows + width + theme → `string[]` |
| `src/host/progress-widget.ts` | host | the PI `Component`, its timer, `setWidget` lifecycle |
| `src/host/progress-card.ts` | host | the terminal summary text (§7.6) |
| `src/host/progress-plain.ts` | host | headless line writer (§8) |
| `src/host/progress-sink.ts` | host | picks a surface from `ctx.mode` (§7.2), tees `emit` |

*(decision)*

2.3. **The sink tees `emit`; it never replaces it.** `createHostPort`'s `emit`
persists first and renders second — `await store.appendEvent(event)` then
`sink.accept(event)` — so a rendering failure can never lose an event. The sink is
best-effort: it catches everything, and on its first throw it disables itself for the
rest of the run after one `notify(…, "warning")`. Progress is a convenience; a run
must not die because a terminal could not draw a box. *(decision)*

2.4. **Rendering is state-free between events.** The sink holds the accumulated
`RunEvent[]` (already bounded by the run) and re-projects on each event rather than
mutating a live tree. Re-projection is O(events) over a list that a real run keeps in
the thousands at worst, and it makes the live widget, a resumed run, and the terminal
summary literally the same function of the same input — the property that stops the
three from drifting. If a run ever makes this hot, the fold is incrementalisable
without changing the interface. *(decision)*

## 3. The projection

3.1. **Step state comes from `deriveStepStates` (§5.1), not from a second
interpretation of the log.** The projection *adds* what a tree needs and the state map
does not carry — counters, timings, attempt numbers, token sums — but never
recomputes state. Two answers to "is this step done?" is a bug the framework can
avoid by construction. *(decision)*

3.2. Each event contributes exactly:

| Event | Contribution |
| --- | --- |
| `run-meta` | not rendered in the tree; its `workflowFilePath` is the summary's provenance line |
| `run-started` / `run-resumed` | run clock start; header |
| `step-started` | row `in_progress`, start time |
| `step-completed` | row `completed`, duration |
| `step-retry` | `attempt` + `reason` badge on the row (§5.3) |
| `agent-steer` | `repair N` badge |
| `agent-error` | no badge of its own: what became of the step reaches the row through the `step-retry` (reason `provider error`) or failure that follows it |
| `agent-usage` | `+totalTokens` on the row and on the run header |
| `step-failed` | row `failed` — optional step, run continues (§9.1) |
| `step-cancelled` | row `cancelled` (drain-then-crash, §9.5) |
| `node-started` / `node-completed` | construct row open/close |
| `loop-iteration` | `↻ N/max` on the loop row; body rows reset |
| `branch-arm` | arm row `taken` or `skipped` |
| `foreach-started` | `count` on the foreach row |
| `foreach-item-started` / `-completed` | live item rows; `done/count` track |
| `questionnaire-asked` | row `blocked`, question count |
| `answers-provided` | row leaves `blocked` |
| `run-completed` / `-crashed` / `-cancelled` | terminal status, failure reason |
| `step-log` | not rendered in the tree (§13.2) |

*(decision)*

3.3. **Rows are keyed by static node path (§5.4), so a loop body shows the current
iteration and nothing else.** Iteration 7 overwrites iteration 6 in place, exactly as
step state already collapses; the loop row carries `↻ 7/10` so nothing is lost. A
foreach is the documented exception — item indices are kept — so its live items each
get their own row, bounded by the concurrency ceiling (§3.6). *(decision)*

3.4. **The outline is a template, not the truth.** Branch arms are undecided until
`branch-arm` arrives, a foreach's length is unknown until `foreach-started`, and
iteration count is unknown until the loop runs. Unentered structure renders in its
declared shape with no counters; nothing is invented. A dynamic node with no outline
counterpart (a foreach item) is instantiated from its event path. *(decision)*

3.5. **A nested workflow (§11) renders as a nested subtree**, not as one opaque row:
its steps fold into the parent log by design, so hiding them here would discard
information the log already carries. *(decision)*

3.6. **A foreach item row is labelled by its body step's name, plus a stub of the
item when one is obvious** — the item itself if it is a string, else its `name`, `id`,
or `path` field — giving `review · src/engine` rather than `review · item 3`. Anything
less obvious (a nested object, a number) falls back to the index. Cheap where it
works, silent where it does not; nothing here inspects an item deeply enough to
become a second guessing game. *(decision)*

3.7. **The item value is recovered from the log, not requested from the engine.**
`foreach-item-started` carries only an index; the item itself arrives as the `input` of
the first `step-started` inside that item. So a row shows `item 3` in the instant
between those two events and its stub from then on. The alternative — widening an
engine event to carry a display string — is what §13.7 exists to refuse. *(decision)*

3.7.1. **Consequence, and it is visible to authors:** a step that declares no `input`
schema is recorded with `input: undefined` (`engine/execute.ts:270`), so a foreach
whose body starts with such a step labels its rows `check · item 0`, not
`check · src/engine`. This is a real limit of what the log knows, not a rendering
choice, and it is the honest behaviour: the panel never invents a label it cannot
source. Declaring the body's input schema is what turns the indices into names.
*(decision)*

3.8. **Unstarted foreach items get no row**, even once `foreach-started` declares the
count: the log has no value to label them with, and materialising 500 todo rows for a
long list would bury the active path. The count lives on the foreach row. *(decision)*

3.9. **Token sums accumulate across loop iterations; state, timings, and badges reset
with each execution.** A collapsed loop reports what the whole loop cost, not what its
last iteration cost — the latter under-reports spend by everything that came before,
which is the exact number §5.4 exists to surface. *(decision)*

## 4. Visual design

The panel is one composed object, not a list of printed lines. Three ideas carry it:
**one alignment grid**, **weight hierarchy instead of colour variety**, and **only
one thing on screen ever moves**.

A calm run at 72 columns:

```

  ── fix-until-green ─────────────────────────────── 3f9a2c1d · 01:12 ──

    ✓ analyze                                       3.1s
    ✓ plan                                          8.4s
    ▾ until-green                                 ↻ 2/10
    │ ✓ implement                                  21.0s      8.1k tok
    │ ⠹ test                               running · 12s      3.2k tok
    │ ○ review
    └ ○ summarize

  ━━━━━━━━━━━━━━━━━━━━╸─────────────────────────────  2 of 5 · 12.4k tok

```

A wider run mid fan-out, with a collapsed loop, an optional failure, and a
blocked step:

```

  ── release-audit ───────────────────────────────────────────── a71b04e7 · 04:38 ──

    ✓ collect-changes                                       1.2s
    ▸ classify                            ↻ 3 iterations · 38.1s       12.0k tok
    ▾ review-each                             ▰▰▰▰▱▱▱  4/7 items
    │ ✓ review · src/engine                                12.7s        4.1k tok
    │ ⠙ review · src/host                           running · 9s        2.8k tok
    │ ⠸ review · src/flow                           running · 6s        1.9k tok
    │ ○ review · src/testing
    ▾ gate                                                2 arms
    │ ⊘ needs-migration                                  skipped
    │ ⚠ changelog                       failed · optional · 2.4s        6.2k tok
    └ ? sign-off                           waiting · 2 questions

  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╸─────────────────────  9 of 14 · 88.2k tok

```

4.1. **Frame.** One blank line above and below the panel; a hairline rule
(`borderMuted`) carrying the workflow name as an accent chip on the left and
`runIdHash(runId) · elapsed` dim on the right — the slug's 8-hex tail, since the slug
already leads with the workflow name the chip just showed (§0); the tree; a footer
rule that *is* the progress bar. No box drawing on the sides — vertical borders cost two columns on every row and
buy nothing that the rules do not already say. *(decision)*

4.2. **Grid.** Every row is `frame gutter(2) · tree indent(2) · connectors(2/level) ·
glyph · space · name · … · metadata`. The metadata block **hangs off the panel's right
edge**, one gutter in, its field widths computed once per render; the name field is
whatever remains. (Anchoring instead to the widest *name* packs metadata against the
names and leaves a ragged right edge — the opposite of the intent.) Durations line up
on the decimal point down the whole panel. Alignment is what makes a tree scannable;
ragged right edges are the main thing that makes terminal output look thrown together.
*(decision)*

4.3. **Connectors.** Two columns per depth: `│ ` for a child with siblings below,
`└ ` for the last, two spaces under a leaf. Rendered in `borderMuted` so structure
recedes and names come forward. *(decision)*

4.4. **Glyphs** — one per `StepState` plus three construct glyphs, following PI's own
conventions (`✓`/`○`, its default braille spinner):

| Glyph | Meaning | Colour |
| --- | --- | --- |
| `○` | todo | `dim` |
| `⠋⠙⠹⠸…` | in_progress (animated) | `accent` |
| `?` | blocked — waiting on a human (§10) | `warning` |
| `✓` | completed | `success` |
| `⊘` | skipped — branch arm not taken | `dim` |
| `⚠` | failed but optional; run continued | `warning` |
| `✗` | crashed | `error` |
| `■` | cancelled | `muted` |
| `▾` | construct, expanded (has live descendants) | `accent` |
| `▸` | construct, collapsed to a summary (§6) | `muted` |

*(decision)*

4.5. **Weight hierarchy, not a palette.** At most three colours are live in a calm
panel — accent for what is happening, success for what is done, muted/dim for
everything structural — and the eye is steered by *weight*: the active row's name in
`text` + bold, completed names in `muted`, pending names in `dim`, connectors and
metadata in `dim`. `warning` and `error` appear only when something has actually gone
wrong, which is what makes them worth noticing when they do. A panel where every row
competes for attention communicates nothing. *(decision)*

4.6. **Counters are pictures where a picture is cheaper to read than a number.** A
foreach draws a segment track (`▰▰▰▰▱▱▱ 4/7 items`) because "how far through" is a
proportion; a loop draws `↻ 2/10` because iteration count against the `maxIterations`
guard (§3.3) is a *number*, and how close it is to the guard is the thing worth
seeing. The footer bar is the same idea for the run as a whole: filled `━` in accent,
a `╸` cap at the head, `─` in `borderMuted` for the remainder. *(decision)*

4.7. **Typography.** Durations: `3.1s` under a minute, `1m 04s` under an hour,
`1:04:22` beyond; the run clock always `mm:ss`. Tokens: `4.1k`, `88.2k`, `1.2M` —
never raw digits, which are unreadable at a glance and change width constantly.
Counters as `4/7`. Every one of these is a fixed-ish width by construction, which is
what keeps §4.2's column from jittering. *(decision)*

4.8. **Motion is rationed.** The braille spinner is the only animation, at 120 ms.
**Precision follows from whether a number can still change**: a *settled* duration
keeps its tenths (`21.0s` — it will never move again), while anything measured against
`now` truncates to whole seconds (`running · 12s`). A live duration flickering through
tenths ten times a second is the single fastest way to make a calm panel feel frantic,
and it is also what makes §12.2's byte-identical property hold. Nothing else moves:
rows do not reflow while a step runs, and a settled row never changes again.
*(decision)*

4.9. **Two metadata cells.** The **status cell** says the one most informative thing
about that row, in this precedence: failure reason > blocked (`waiting · 2 questions`)
> retry/repair badge > live counter (`↻ 2/10`, `4/7 items`) > elapsed
(`running · 12s`) > final duration. The **token cell** follows it on any row that
spent tokens — including a collapsed construct (§6.1), which reports its whole
subtree, so cost stays visible after the detail folds away. *(decision)*

4.9.1. **A badge outranks a duration only while it is still true.** A step that
retried and then *succeeded* must not keep rendering `retry 2/3 · invalid output` —
it reads as "currently retrying" forever. So: while retrying, `retry 2/3 · <reason>`;
once settled, `2 tries · 21.0s`. The retry stays visible, which is §5.3's entire
point, without a finished step claiming to be in flight. *(decision)*

4.9.2. **A failure *reason* is not a right-aligned cell.** Arbitrary error text cannot
share a fixed column without squeezing the grid, which §4.10 forbids. The row reads
`failed · optional · 2.4s`; the reason itself travels on the projection for the summary
(§7.6) and `/workflow status` (§11.4) to print in full. *(decision)*

4.10. **Degrade by removing whole elements, never by squeezing them.** When the grid
cannot fit both cells beside the longest name, the token cell goes first; below
~60 columns the metadata column goes entirely, and the footer bar with it, leaving
glyph + name + the run clock. The grid stays intact at every width. *(decision)*

4.11. **Styling is applied last.** Padding and truncation are computed on plain
strings, then the theme wraps the finished segments — ANSI-aware width maths is a
recurring source of off-by-N corruption, and this order makes the pure renderer's
output assertable without a terminal. `render.ts` takes a minimal
`ProgressTheme { fg(colour, text); bold(text) }`, which PI's `Theme` satisfies
structurally and a test satisfies with identity functions. *(decision)*

## 5. What the tree makes visible that today's UI does not

5.1. **Which step is running, and for how long** — the primary complaint this spec
answers.

5.2. **That a loop is progressing rather than stuck** — `↻ 2/10` against a declared
`maxIterations` is the difference between "working" and "about to hit the guard".

5.3. **Retries and steering.** `step-retry` and `agent-steer` are invisible today, so
a step that silently burned three attempts looks identical to one that succeeded
first try. The badge (`retry 2/3 · invalid output`) surfaces the framework's most
expensive behaviour at the moment it costs money. *(decision)*

5.4. **Cost as it accrues.** The footer sums `agent-usage`, which per LESSONS
("observability has to live where the work happens") is the only place isolated
steps' spend is visible at all — a session file and a provider dashboard both miss
it. *(decision)*

5.5. **Concurrency.** Every `in_progress` node animates simultaneously and the footer
counts them, so a `.parallel`/`.foreach` fan-out reads as fan-out rather than as one
mystery step.

## 6. Collapse & depth

6.1. **Completed constructs collapse to a summary row.** A finished loop becomes
`▸ classify   ↻ 3 iterations · 38.1s`; a finished foreach, `▸ review-each   ✓ 7 items
· 2m 10s`; a finished nested workflow, `▸ audit   ✓ 4 steps · 51.0s`. A finished branch
reports what actually ran — `✓ 1 of 2 arms`, never `✓ 2 arms`, which claims a skipped
arm executed. Nothing is lost — the detail is in the log and in `/workflow status`
(§11.4) — and the panel shrinks exactly when its detail stops being actionable.
*(decision)*

6.1.1. **Collapsed is a statement about being finished, not about being idle.** A
construct whose `node-completed` has not arrived keeps its live form (`↻ 2/10`) even
in the instants when nothing inside it is in flight — between one iteration ending and
the next step starting, a loop is still running, and the summary phrasing
(`↻ 2 iterations · 7s`) would say it had stopped. *(decision)*

6.2. **The active path is always fully expanded**, root to every `in_progress` or
`blocked` node, together with that node's siblings. This is the only region a user
can act on, so it is the only region that pays for its lines. *(decision)*

6.3. **A construct that has not started renders as a single `○` row** with no body.
Expanding structure that may never run (an untaken branch arm) is noise.
*(decision)*

6.4. Rows truncate to terminal width, ellipsis on the **name** — the metadata cell
carries the live information and is never sacrificed. *(decision)*

6.4.0. **The bar never runs backwards, with one named exception.** Two things make it
retreat, and both are bugs: a foreach whose denominator grows as items start (the bar
retreating on every item), and a loop whose body rows are keyed by static path, so
iteration 2's `step-started` un-completes what iteration 1 finished and the numerator
counts *down* by a whole body per iteration. The fixes: count a foreach's declared
items from `foreach-started`'s `count` × the body's leaf count (without materialising
rows for them, §3.8), and count a leaf once it has **ever** settled. Both stay pure
folds over the log.

The exception is the single `foreach-started` event itself: the item count is unknown
until the selector has run, so the denominator genuinely reveals there and the fraction
dips once (`1 of 2` → `1 of 6`). Over-estimating beforehand is exactly the inventing
§3.4 refuses. So the asserted property is: **the numerator never falls, the denominator
changes only at a `foreach-started`, and the run ends at exactly 1.** *(decision)*

6.4.1. **The footer counts *settled* leaves, and a completed run always reads full.**
The numerator is every leaf that has reached a terminal state — completed, skipped,
crashed, cancelled — not merely `completed`, or a run that skipped a branch arm would
sit at `4 of 5` forever. **A skipped arm settles its whole subtree**: `deriveStepStates`
marks the arm, and no event ever mentions the steps inside it, so anything counting
only what the log names leaves them `todo` for good and a cleanly finished run renders
a two-thirds-full bar. The invariant to hold, and to test: **a run whose status is
`completed` renders a full bar, whatever was skipped inside it.** *(decision)*

6.5. **No hard line budget for now.** §6.1–§6.3 keep a realistic run comfortably
small, and a fixed cap is a mechanism with a tuning problem attached (what number,
measured how, degrading how). Deferred until a real workflow is observed overflowing;
until then the panel is as tall as the active path needs. *(decision, deferred)*

6.6. **Widgets never receive keyboard focus in PI** (`handleInput` fires only for the
focused component; a widget is not one), so there is no expand/collapse key. The
fully expanded tree is reachable through `/workflow status` (§11.4) and through the
`/workflow status` output (§11.4). *(decision)*

## 7. Live surface

7.1. **One widget, keyed `pi-workflows:progress`, placement `aboveEditor`**, installed
on `run-started`/`run-resumed` and cleared on the terminal event. *(decision)*

7.2. **The surface is chosen by `ctx.mode`, not by `hasUI`** — the two disagree
exactly where it matters, and `CommandCtx` already carries both:

| `ctx.mode` | `hasUI` | Surface |
| --- | --- | --- |
| `tui` | true | widget as a **component factory** — gets `tui` + live `theme`, animates |
| `rpc` | true | widget as **`string[]` lines**, re-pushed per event; no animation |
| `json`, `print` | false | stderr lines (§8) |

RPC's `setWidget` carries `widgetLines: string[]` over the wire (`rpc-types.d.ts`);
a component factory cannot cross that boundary, and there is no `requestRender` on the
far side to drive an animation. So RPC gets the same tree, redrawn only when an event
moves it — which is the honest thing to show a client that has no frame clock.
*(decision)*

7.3. **The TUI component owns one timer, and only while work is in flight.** A 120 ms
interval advances the spinner and re-renders via `tui.requestRender()`; it is started
when the projection first reports an `in_progress` node and stopped the moment none
remains — including while `blocked`, which may last hours and must not wake the TUI at
all. `dispose()` clears it. RPC has no timer at all. *(decision)*

7.4. **`setWorkingMessage` names the current step** (`workflow: test (2/5)`) while a
run is live, and is restored on terminal — **TUI only**, since it is a documented
no-op in RPC. Nearly free, and it puts the step name where PI already draws the user's
eye during a turn. *(decision)*

7.5. **A blocked run keeps its widget** — the blocked row marked `? … waiting · N
questions` — while the questionnaire renders inline through the existing path
(§10.2, `questionnaire-form.ts`), unchanged. The widget is what tells a user *which
step of what* is asking. *(decision)*

7.6. **On every terminal status — including a clean completion — the widget clears and
the run is announced once, as multi-line text through `ctx.ui.notify`**: status line,
step tally, duration, total tokens, run label, the failure reason when crashed, the
workflow file, and a pointer to `/workflow status` for the full tree. One shape for all
five outcomes: a run that succeeded is exactly the run a user later wants the duration
and the token total of. *(decision)*

7.6.1. **Text, not a custom entry with a registered renderer — and this was learned the
expensive way.** The richer surface (`pi.appendEntry` + `pi.registerEntryRenderer`)
gives a durable, themed, expandable card, and it is what this spec originally called
for. It also **took the whole extension down**: `registerEntryRenderer` does not exist
on pi 0.80.2, so the call threw at load and `/workflow` stopped existing. Type-checking
against the installed package proves nothing about the binary that loads the extension.

The right answer is not to feature-detect the newer API but to **not need it**.
`notify` takes multi-line text on every harness, and `/workflow list` has rendered its
catalog that way since long before this feature (`commands/list.ts`), so this is the
codebase's existing idiom rather than a downgrade invented under pressure. It keeps
§13.4's guarantee for free — a notification never enters LLM context — and it deletes
the session-directory gating, the mode gating, and the fallback path along with it.

Given up, honestly: expand/collapse, per-theme colour, and a structured entry persisted
in the session. The expanded tree was always reachable another way (§11.4), which is
why the panel is free to collapse at all. *(decision)*

7.7. **The announcement always lands.** No session, no renderer, no particular harness
version is required — which is the point of §7.6.1. A progress feature must never be
the thing that makes a run silent about its own outcome. Headless modes announce
through their own last line instead (§8.1). *(decision)*

7.8. The existing terminal `notify` (`context.ts:109`) is **replaced** by this
announcement, not kept alongside it. Two reports of one outcome is noise.
*(decision)*

## 8. Headless rendering

8.1. In `json` and `print` mode (`ctx.hasUI === false` — benchmark runs, CI), the sink
writes **one plain, unstyled, append-only line per state transition to stderr**:

```
[workflow] fix-until-green workflow-fix-until-green-3f9a2c1d started
[workflow]   done  analyze (3.1s)
[workflow]   loop  until-green iteration 2/10
[workflow]   run   test
[workflow]   done  test (18.2s, 4.1k tok)
[workflow] completed · 5 steps · 01:44 · 12.4k tok
```

Plain words, not glyphs: this stream is read in log files and CI output where the
theme, the width, and often the font are all unknown. *(decision)*

8.2. **stderr, not stdout — this is a correctness requirement, not a preference.** In
JSON mode stdout *is* the event protocol (PI guards it: `core/output-guard.ts`), and in
print mode it is the assistant's answer, which callers parse. Interleaving progress
lines into either corrupts a contract someone depends on. stderr is the channel that
is already understood to carry diagnostics, and benchmark harnesses capture it
alongside stdout anyway. Nothing in `src/` writes to stdout today (§0); this spec is
not what changes that. *(decision)*

8.3. **Append-only, never a redraw**: an isolated step's subagent has its own pipes
(`subagent-process.ts`), but the parent's stderr is shared with everything else in the
process, and cursor movement in a stream that is being appended to from more than one
place corrupts all of it. *(decision)*

8.4. This is what makes benchmark runs observable — per LESSONS, every serious bug in
this project was invisible offline and obvious within one live run, and those live
runs are exactly the headless ones. *(decision)*

## 9. Resume, concurrency, isolation

9.1. **A resumed run renders its history immediately.** `/workflow resume` already
loads the log to find its `run-meta` and route on status (`commands/resume.ts`), so it
seeds the sink from that same `loadEvents` call before the first new event: the widget
opens showing everything already completed (collapsed per §6.1) rather than an empty
tree. This falls out of §2.4 — the projection does not care whether events arrived
live or from disk. *(decision)*

9.2. **Isolation is not re-litigated here.** §12.2's rule stands: in-session steps
stream inline, isolated ones do not. The tree is orthogonal — it shows *every* step,
isolated or not, which is precisely what makes an isolated step's otherwise silent
execution visible. *(decision)*

9.3. **One executing run per project (§7)** means one widget. No multiplexing.
*(decision)*

## 10. Failure isolation & performance

10.1. Persist-then-render ordering (§2.3); sink throws are caught and self-disable.

10.2. The re-projection cost is bounded (§2.4); the render path allocates only
strings and runs at most once per event plus once per 120 ms tick — and, per §4.8,
produces *identical* output between whole seconds, so a diffing TUI redraws nothing.

10.3. **No progress code runs on the engine's thread of control beyond the `emit`
call it already makes.** No new awaits inside step execution. *(decision)*

## 11. Commands & configuration

11.1. `/workflow run`, `/workflow create`, `/workflow resume` gain the widget with no
new syntax. *(decision)*

11.2. `PI_WORKFLOWS_PROGRESS=off` disables the live surface entirely (summary and
headless lines included), for scripted environments that want the old silence.
*(decision)*

11.3. `/workflow run list` (§6.3) is unchanged.

11.4. **`/workflow status [run-id]`** — new: print the **fully expanded**
tree for the executing run, or for a named past run rebuilt from its log. This is the
answer to "show me everything", and the reason the panel can collapse freely (§6.6).
The argument goes through the existing `resolveRunRef` (§0) — exact id, short hash, or
unique prefix, with ambiguity reported rather than guessed — so this command matches
run-ids exactly the way `resume`/`cancel`/`delete` already do, and gains their
completion behaviour for free once spec.md §14 lands. *(decision)*

## 12. Testing

12.1. `outline`, `project`, `collapse`, and `render` are pure, so the offline suite
covers them directly: a golden-lines test per construct (sequence, loop mid-iteration,
foreach with live items, parallel fan-out, branch with a skipped arm, nested
workflow), per state (blocked, retrying, optional-failed, crashed, cancelled), and at
each degradation step (§4.10). Fake theme, fixed `now`, fixed width. *(decision)*

12.2. **Two properties are asserted, not just snapshots**: the metadata column is at
the same offset on every row of a render, and two renders whose only difference is
sub-second elapsed time are byte-identical (§4.8). Both are exactly the kind of thing
that decays silently under later edits. *(decision)*

12.3. The sink is tested against a fake `ui` capturing `setWidget` calls: widget
installed once, cleared exactly once, timer started and stopped with in-flight work,
one summary per run, self-disable on a renderer throw with the run still completing, and
**one case per `ctx.mode`** (§7.2) — a factory in `tui`, `string[]` in `rpc`, not a
single `setWidget` call and no stdout write in `json`/`print`. The mode matrix is the
part a fake makes cheap to pin and a live session makes expensive to discover.
*(decision)*

12.4. **At least one test drives a REAL engine run**, not a hand-built log: a workflow
covering loop + concurrent foreach + parallel + a branch with a skipped arm + a nested
workflow, executed through `runWorkflow` against `createTestHost`, then projected and
rendered. It asserts §6.4.1's completed-run-is-full invariant and — the one that
matters most — that **no row reads `todo` for a step the log shows completed**, which
is how a path-construction mistake announces itself instead of silently rendering an
entire panel of nothing. Hand-built fixtures agree with whatever the author believed
the engine emits; only a real run disagrees. Every defect found in this spec's first
implementation round was invisible to the fixtures and obvious on the first real run.
*(decision)*

12.5. **Visual correctness is verified manually in a live session**, as
`questionnaire-form.ts` already documents for its own TUI path. Snapshot tests pin
structure and alignment, not legibility. *(decision)*

## 13. Rejected alternatives

13.1. **Footer status line only** — fits one fact; a workflow's whole point is that it
has structure. Kept as a complement (§7.3) rather than as the surface.

13.2. **A transcript line per event** — the current state scrolls away, interleaves
with agent output, and `step-log` alone can produce hundreds of lines. Rejected;
`step-log` stays in the log, readable via §11.4.

13.3. **`setFooter`** — replaces PI's footer wholesale and is hostile to every other
extension.

13.4. **`pi.sendMessage` custom messages** — they participate in LLM context, so the
agent would read its own progress panel as input.

13.4.1. **`pi.appendEntry` + `pi.registerEntryRenderer`** — the durable, themed,
expandable card this spec originally specified. Rejected after it threw at load on pi
0.80.2, where `registerEntryRenderer` does not exist, taking the whole `/workflow`
command with it (§7.6.1). A cosmetic surface must not be able to do that, and an
optional-API guard is a worse answer than an API that is present everywhere.

13.5. **Boxed panel with side borders** — two columns per row spent on vertical rules
that say nothing the top and bottom rules do not, and one more thing to get wrong at
every terminal width.

13.6. **Colouring a loop row `warning` as it nears `maxIterations`** — a threshold to
pick, a second meaning for a colour that otherwise means "something went wrong", and
a panel that changes character on a rule the user did not ask for. `↻ 8/10` already
says it.

13.7. **Emitting new engine events for the UI's benefit** — the existing stream is
already sufficient (§3.2). Rendering must not become a reason to change the engine.

## Open questions

*None outstanding.* What remains is implementation-level: the exact braille frame set,
the `ProgressTheme` colour names against PI's live theme, and where the token cell's
fit threshold lands in practice — all decided by looking at a real terminal, not by
argument.
