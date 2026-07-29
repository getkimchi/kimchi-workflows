import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { parsePath, staticKeyOf } from "../src/engine/node-path.ts";
import { deriveRunStatus } from "../src/engine/run-status.ts";
import { runWorkflow } from "../src/engine/run-workflow.ts";
import type { RunEvent } from "../src/engine/types.ts";
import { createStep, createWorkflow } from "../src/flow/index.ts";
import type { WorkflowDefinition } from "../src/flow/types.ts";
import { collapse } from "../src/progress/collapse.ts";
import { buildOutline } from "../src/progress/outline.ts";
import { project } from "../src/progress/project.ts";
import { render } from "../src/progress/render.ts";
import type { ProgressNode, ProgressView } from "../src/progress/types.ts";
import { createTestHost } from "./helpers.ts";
import { plainTheme } from "./progress-fixtures.ts";

/**
 * The progress layer against a REAL engine run (progress §12.1, and LESSONS' "observability has to live
 * where the work happens").
 *
 * Every other progress test builds its log by hand, which is what makes one behaviour per case cheap —
 * and which is also exactly how a whole class of bug survives a green suite. A hand-built log is written
 * by the same person who wrote the code that reads it, so a mistaken node path is simply mistaken
 * consistently in both places: `buildOutline` addresses a branch arm under its branch, the fixture
 * records the event under the same wrong path, every assertion passes, and the live panel renders an
 * entire subtree as `todo` for the life of the run with nothing failing anywhere. Nothing about that
 * failure is loud. The steps look pending, which is a thing steps are allowed to look.
 *
 * So this file lets the ENGINE write the log — real paths, real ordering, real concurrency — and asserts
 * two invariants that no hand-built fixture can vouch for:
 *
 *   (a) a run whose derived status is `completed` renders a FULL bar, whatever was skipped inside it;
 *   (b) every path the log says completed is a projected row that says `completed` too.
 *
 * (b) is the path-matching assertion: it fails loudly the moment an outline path and an emitted path
 * disagree, in either direction — a row addressed at a path no event carries, or an event with no row.
 */

const count = Type.Object({ count: Type.Number() });
const fixed = (name: string, value = 1) => createStep({ name, output: count, run: () => ({ count: value }) });

/** One workflow over every construct: loop, concurrent foreach, parallel, branch with a skipped arm, nested. */
function everyConstruct(): WorkflowDefinition {
  let iterations = 0;
  const loopBody = createWorkflow({ name: "loop-body" })
    .then(createStep({ name: "review", output: count, run: () => ({ count: ++iterations }) }))
    // Passes the count through: a loop's condition sees the LAST node's output (spec §3.3), so a body
    // whose tail dropped it would spin to the `maxIterations` guard.
    .then(createStep({ name: "fixup", input: count, output: count, run: ({ input }) => input }))
    .commit();

  const itemBody = createWorkflow({ name: "item-body" })
    .then(createStep({ name: "check", input: Type.String(), output: count, run: () => ({ count: 1 }) }))
    .commit();

  const nested = createWorkflow({ name: "checks" }).then(fixed("audit")).then(fixed("lint")).commit();

  const arm = (name: string) =>
    createWorkflow({ name })
      .then(fixed(`${name}-step`))
      .commit();

  return (
    createWorkflow({ name: "live-demo" })
      .then(fixed("implement", 0))
      .dountil(loopBody, (_ctx, last) => (last as { count: number }).count >= 3, { name: "until-good", maxIterations: 10 })
      .foreach(itemBody, () => ["src/engine", "src/host", "src/flow"], { name: "sweep", concurrency: 2 })
      .parallel([fixed("fmt"), fixed("types")], { name: "gate" })
      // Multi-match (spec §3.2): `untaken` is never eligible, so nothing inside it ever runs.
      .branch(
        [
          [() => true, arm("taken")],
          [() => false, arm("untaken")],
        ],
        { name: "decide" },
      )
      .workflow(nested, { name: "nested" })
      .then(fixed("summarize"))
      .commit()
  );
}

function walk(nodes: readonly ProgressNode[]): ProgressNode[] {
  return nodes.flatMap((node) => [node, ...walk(node.children)]);
}

/** The projection at `now` = the log's last timestamp plus a beat, so nothing depends on the wall clock. */
function viewAt(definition: WorkflowDefinition, events: readonly RunEvent[], afterMs = 100): ProgressView {
  const last = events.at(-1);
  if (!last) throw new Error("no events recorded");
  return project(buildOutline(definition), events, new Date(Date.parse(last.at) + afterMs));
}

describe("progress against a real engine run (progress §12.1)", () => {
  it("(a) a completed run renders a full bar, whatever was skipped inside it", async () => {
    const definition = everyConstruct();
    const { host, events } = createTestHost();
    const result = await runWorkflow(definition, undefined, host);
    expect(result.status).toBe("completed");
    expect(deriveRunStatus(events)).toBe("completed");

    const view = viewAt(definition, events);
    // The invariant: nothing outstanding is left in the tally of a run that is over. The untaken arm's
    // body is the case that broke it — those steps have no events at all, so they read `todo` unless
    // the skip is carried down (progress §3.4).
    expect([view.stepsSettled, view.stepsTotal]).toEqual([view.stepsTotal, view.stepsTotal]);
    for (const node of walk(view.nodes)) {
      expect([node.path, node.state === "todo"]).toEqual([node.path, false]);
    }

    // ...and it reaches the screen: a full bar has no unfilled track and no cap left to move.
    const footer = render(view, collapse(view), { width: 76, theme: plainTheme }).at(-2) as string;
    expect(footer).not.toContain("─");
    expect(footer).not.toContain("╸");
    expect(footer).toContain(`${view.stepsTotal} of ${view.stepsTotal}`);
  });

  it("(b) every path the log says completed is a row that says completed too", async () => {
    const definition = everyConstruct();
    const { host, events } = createTestHost();
    await runWorkflow(definition, undefined, host);

    const view = viewAt(definition, events);
    const byPath = new Map(walk(view.nodes).map((node) => [node.path, node]));
    const completed = new Set(events.filter((event) => event.type === "step-completed").map((event) => staticKeyOf(parsePath(event.path))));
    expect(completed.size).toBeGreaterThan(0);

    for (const path of completed) {
      // `undefined` here means the outline addressed this step at a path the engine never emits — the
      // failure mode that renders a whole subtree pending forever without anything throwing.
      expect([path, byPath.get(path)?.state]).toEqual([path, "completed"]);
    }
  });

  it("(b) holds for construct checkpoints as well as steps — every node-completed has a row", async () => {
    const definition = everyConstruct();
    const { host, events } = createTestHost();
    await runWorkflow(definition, undefined, host);

    const view = viewAt(definition, events);
    const byPath = new Map(walk(view.nodes).map((node) => [node.path, node]));
    for (const event of events) {
      if (event.type !== "node-completed") continue;
      // A foreach item's checkpoint is `foreach-item-completed`, not this — every `node-completed` path
      // belongs to a construct or a taken branch arm, and each is a row.
      expect([event.path, byPath.get(staticKeyOf(parsePath(event.path)))?.state]).toEqual([event.path, "completed"]);
    }
  });

  it("the untaken arm's whole subtree is skipped, and its branch says so when it folds", async () => {
    const definition = everyConstruct();
    const { host, events } = createTestHost();
    await runWorkflow(definition, undefined, host);

    const view = viewAt(definition, events);
    const byPath = new Map(walk(view.nodes).map((node) => [node.path, node]));
    expect(byPath.get("untaken")?.state).toBe("skipped");
    expect(byPath.get("untaken/untaken-step")?.state).toBe("skipped");
    expect(byPath.get("taken/taken-step")?.state).toBe("completed");

    const branch = collapse(view).find((row) => row.node.path === "decide");
    expect(branch?.collapsed).toBe(true);
    const line = render(view, collapse(view), { width: 76, theme: plainTheme }).find((row) => row.includes("decide"));
    expect(line).toContain("✓ 1 of 2 arms");
  });

  it("a real mid-run cut between iterations keeps the loop live rather than folding it", async () => {
    const definition = everyConstruct();
    const { host, events } = createTestHost();
    await runWorkflow(definition, undefined, host);

    // Cut exactly at `loop-iteration 2`: the body's rows still carry iteration 1's `completed`.
    const cut = events.findIndex((event) => event.type === "loop-iteration" && event.iteration === 2);
    expect(cut).toBeGreaterThan(0);
    const view = viewAt(definition, events.slice(0, cut + 1), 7000);

    const loop = collapse(view).find((row) => row.node.path === "until-good");
    expect(loop?.node.state).toBe("in_progress");
    expect(loop?.collapsed).toBe(false);
    expect(loop?.expanded).toBe(true);
    const line = render(view, collapse(view), { width: 76, theme: plainTheme }).find((row) => row.includes("until-good"));
    expect(line).toContain("↻ 2/10");
    expect(line).not.toContain("iterations");
  });

  it("a real concurrent fan-out shows every live item at once, labelled by its own item", async () => {
    const definition = everyConstruct();
    const { host, events } = createTestHost();
    await runWorkflow(definition, undefined, host);

    // Cut once the SECOND item's step has started: `concurrency: 2` means both are genuinely in flight,
    // and a stub is only knowable once a step inside an item reports the item as its input (§3.6).
    const cut = events.findIndex((event) => event.type === "step-started" && event.path === "sweep@1/check");
    expect(cut).toBeGreaterThan(0);
    const view = viewAt(definition, events.slice(0, cut + 1));

    const items = walk(view.nodes).filter((node) => node.kind === "foreach-item");
    expect(items.map((item) => item.path)).toEqual(["sweep@0", "sweep@1"]);
    // The body step declares an input schema, so the item value reaches the log (progress §3.6).
    expect(items.map((item) => item.name)).toEqual(["check · src/engine", "check · src/host"]);
    expect(walk(view.nodes).find((node) => node.path === "sweep")?.foreach).toEqual({ done: 0, count: 3 });

    // Both are drawn, and each item's single step is the item's own row rather than a second line.
    const rows = collapse(view).filter((row) => row.node.kind === "foreach-item");
    expect(rows.map((row) => [row.collapsed, row.expanded])).toEqual([
      [false, false],
      [false, false],
    ]);
    expect(collapse(view).some((row) => row.node.path === "sweep@0/check")).toBe(false);
  });

  /**
   * The footer must never retreat while a run is healthy (progress §6.4.1).
   *
   * A bar that goes backwards says the panel is wrong about something, and a user has no way to tell
   * which something — so it discredits the tree, the timings and the cost at the same time. It used to
   * happen on EVERY foreach: items materialised one at a time, so a four-item fan-out walked the
   * denominator `2 → 3 → 4 → 5 → 6` and the fraction fell four times while nothing was wrong.
   *
   * The denominator is now allowed to move exactly once per foreach, at that foreach's own
   * `foreach-started` — the single event where the run learns how much work it is. That revision is
   * unavoidable and it is honest: the count comes from a selector that has not run yet, and inventing a
   * number for it up front is precisely what progress §3.4 refuses. Everywhere else the fraction is
   * non-decreasing, which is what this pins.
   */
  it("the completed fraction never decreases across successive prefixes of a real run", async () => {
    const definition = everyConstruct();
    const { host, events } = createTestHost();
    await runWorkflow(definition, undefined, host);

    const outline = buildOutline(definition);
    const reveals = new Set(events.flatMap((event, index) => (event.type === "foreach-started" ? [index] : [])));
    expect(reveals.size).toBe(1); // one foreach in this workflow, so exactly one legitimate revision

    let previous = { fraction: 0, total: 0 };
    for (let cut = 1; cut <= events.length; cut++) {
      const prefix = events.slice(0, cut);
      const view = project(outline, prefix, new Date(Date.parse(prefix.at(-1)?.at ?? "") + 100));
      const fraction = view.stepsTotal === 0 ? 0 : view.stepsSettled / view.stepsTotal;
      const revealed = reveals.has(cut - 1);

      if (!revealed) {
        expect([cut, events[cut - 1]?.type, fraction >= previous.fraction]).toEqual([cut, events[cut - 1]?.type, true]);
        // ...and the denominator itself is untouched by anything but a reveal, so the bar's scale is
        // stable: the numerator is the only thing that moves.
        if (previous.total > 0) expect([cut, view.stepsTotal]).toEqual([cut, previous.total]);
      }
      previous = { fraction, total: view.stepsTotal };
    }

    expect(previous.fraction).toBe(1); // and it ends full (§6.4.1)
  });

  it("a fan-out's whole size lands the moment `foreach-started` declares it, with no rows for it", async () => {
    const definition = everyConstruct();
    const { host, events } = createTestHost();
    await runWorkflow(definition, undefined, host);

    const cut = events.findIndex((event) => event.type === "foreach-started");
    const prefix = events.slice(0, cut + 1);
    const view = viewAt(definition, prefix);

    // Three items declared, none started: three items' worth of work in the tally, and no item rows.
    expect(walk(view.nodes).filter((node) => node.kind === "foreach-item")).toEqual([]);
    const sweep = walk(view.nodes).find((node) => node.path === "sweep");
    expect([sweep?.pendingItems, sweep?.perItemSteps]).toEqual([3, 1]);
    expect(view.stepsTotal).toBe(viewAt(definition, events).stepsTotal); // already the final total
  });

  it("a real crash leaves no row spinning and no clock reading the wall time", async () => {
    const definition = createWorkflow({ name: "live-crash" })
      .then(fixed("seed"))
      .dountil(
        createWorkflow({ name: "body" })
          .then(
            createStep({
              name: "boom",
              run: () => {
                throw new Error("kaboom");
              },
            }),
          )
          .commit(),
        () => true,
        { name: "spin", maxIterations: 3 },
      )
      .commit();

    const { host, events } = createTestHost();
    const result = await runWorkflow(definition, undefined, host);
    expect(result.status).toBe("crashed");

    // A terminal run stops depending on `now` entirely — the durable card must not grow as it is redrawn.
    const early = viewAt(definition, events, 100);
    const late = viewAt(definition, events, 9_000_000);
    expect(late).toEqual(early);

    const byPath = new Map(walk(early.nodes).map((node) => [node.path, node]));
    expect(byPath.get("spin/boom")?.state).toBe("crashed");
    expect(byPath.get("spin")?.state).toBe("crashed");
    expect(early.failureReason).toContain("kaboom");
    for (const node of walk(early.nodes)) expect([node.path, node.live]).toEqual([node.path, false]);
  });
});
