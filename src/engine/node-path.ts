/**
 * Node-path addressing (spec §8.5): the address of a step or node within a run — enclosing node
 * names, the iteration/item index where one applies, then the leaf name. E.g. `until-valid#3/design`
 * (loop iteration 3), `batch@7/review` (foreach item 7), `audit/lint` (nested workflow).
 *
 * Two forms of the same segment list:
 *  - DYNAMIC path — every segment carries its real iteration/item index. Recorded on every event
 *    that names a step (spec §8.1) and used for blocking/resume addressing (spec §8.4/§8.5).
 *  - STATIC path — used to key step state and data-flow (spec §5.4). A loop iteration's index is
 *    DROPPED (only the latest iteration's value is ever kept, since a loop is inherently sequential —
 *    at most one iteration is ever live). A foreach item's index is KEPT (spec §5.4's exception): with
 *    `concurrency > 1` several items are genuinely live at once, so collapsing them the way loop
 *    iterations collapse would let one item's bare-name read resolve against a DIFFERENT item's
 *    in-flight value — precisely the race spec §3.9 exists to exclude (P3 closes a P2 gap here).
 *
 * The wire format distinguishes the two kinds of index with a different separator (`#` loop, `@`
 * foreach) specifically so a consumer holding only the formatted STRING (an event off the log) can
 * still tell them apart without the workflow tree — `deriveStepStates`/`rebuildStepOutputs` are pure
 * folds over the log and have no access to the tree to disambiguate otherwise.
 *
 * Pure — no fs/PI/network. This is the P2 seam P1 left for `step-state.ts`'s `keyOf` to grow into.
 */

/** Whether a segment's index is a loop iteration (dropped in the static key) or a foreach item (kept). */
export type IndexKind = "loop" | "foreach";

export interface PathSegment {
  readonly name: string;
  /** The loop iteration (1-based) or foreach item index (0-based) this segment addresses, if any. */
  readonly index?: number;
  /** Present iff `index` is present: which of the two indexed kinds this segment is (spec §5.4). */
  readonly indexKind?: IndexKind;
}

/** A node path: root-to-leaf, at least one segment. */
export type NodePath = readonly PathSegment[];

const SEGMENT_SEPARATOR = "/";
const LOOP_INDEX_SEPARATOR = "#";
const FOREACH_INDEX_SEPARATOR = "@";

/**
 * A bare step/node name may not carry path syntax (spec §3): `.commit()` rejects a name containing
 * `/`, `#`, or `@` — all three are node-path syntax, and any would make a path built from it unparseable.
 */
export function isValidNodeName(name: string): boolean {
  return name.length > 0 && !name.includes(SEGMENT_SEPARATOR) && !name.includes(LOOP_INDEX_SEPARATOR) && !name.includes(FOREACH_INDEX_SEPARATOR);
}

/** Append one plain (non-indexed) segment — a construct's own addressing name, a step name, an arm name. */
export function appendSegment(parent: NodePath, name: string): NodePath {
  return [...parent, { name }];
}

/** Append a loop-iteration segment (1-based `iteration`) — its index is dropped from the static key. */
export function appendLoopIteration(parent: NodePath, name: string, iteration: number): NodePath {
  return [...parent, { name, index: iteration, indexKind: "loop" }];
}

/** Append a foreach-item segment (0-based `index`) — its index is KEPT in the static key (spec §5.4). */
export function appendForeachItem(parent: NodePath, name: string, index: number): NodePath {
  return [...parent, { name, index, indexKind: "foreach" }];
}

/** Render a path to its wire/log form: `until-valid#3/design`, `batch@7/review`. */
export function formatPath(path: NodePath): string {
  if (path.length === 0) throw new Error("formatPath: a node path must have at least one segment");
  return path
    .map((segment) => {
      if (segment.index === undefined) return segment.name;
      const separator = segment.indexKind === "foreach" ? FOREACH_INDEX_SEPARATOR : LOOP_INDEX_SEPARATOR;
      return `${segment.name}${separator}${segment.index}`;
    })
    .join(SEGMENT_SEPARATOR);
}

/**
 * Parse a formatted path string. Fails loudly on anything unparseable rather than guessing — a log
 * written before this phase has no `path` field at all and must not be silently mis-read as one
 * (spec: old logs break by design; the reader fails loudly).
 */
export function parsePath(raw: string): NodePath {
  // `raw` is typed as `string`, but a log written before this phase has no `path` field at all — an
  // event parsed straight off disk could hand this `undefined`. Guard explicitly so that case fails
  // loudly with a clear message rather than as an opaque "Cannot read properties of undefined".
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(`parsePath: expected a non-empty path string, got ${JSON.stringify(raw)} (a log written before node-path addressing landed cannot be read by this build)`);
  }
  return raw.split(SEGMENT_SEPARATOR).map((token) => parseSegment(token, raw));
}

function parseSegment(token: string, raw: string): PathSegment {
  if (token.length === 0) throw new Error(`parsePath: "${raw}" has an empty segment`);
  const hashIndex = token.indexOf(LOOP_INDEX_SEPARATOR);
  const atIndex = token.indexOf(FOREACH_INDEX_SEPARATOR);
  if (hashIndex === -1 && atIndex === -1) return { name: token };
  if (hashIndex !== -1 && atIndex !== -1) throw new Error(`parsePath: "${raw}" segment mixes "#" and "@"`);

  const indexKind: IndexKind = hashIndex === -1 ? "foreach" : "loop";
  const separator = indexKind === "loop" ? LOOP_INDEX_SEPARATOR : FOREACH_INDEX_SEPARATOR;
  const sepIndex = hashIndex === -1 ? atIndex : hashIndex;

  const name = token.slice(0, sepIndex);
  const indexStr = token.slice(sepIndex + 1);
  if (name.length === 0) throw new Error(`parsePath: "${raw}" has an empty name before "${separator}"`);
  if (token.indexOf(separator, sepIndex + 1) !== -1) throw new Error(`parsePath: "${raw}" has more than one "${separator}" in one segment`);
  if (indexStr.length === 0 || !/^\d+$/.test(indexStr)) throw new Error(`parsePath: "${raw}" has a non-integer index "${indexStr}"`);
  return { name, index: Number(indexStr), indexKind };
}

/**
 * Drop LOOP iteration indices (a loop is inherently sequential — at most one iteration is ever live);
 * KEEP foreach item indices (spec §5.4's exception — see the module header). This is the form both
 * `RunState.stepOutputs` (data flow) and `deriveStepStates` (step state) key by.
 */
export function staticPathOf(path: NodePath): NodePath {
  return path.map((segment) => (segment.indexKind === "foreach" ? segment : { name: segment.name }));
}

/** The static key for a path, formatted — what `deriveStepStates` and `RunState.stepOutputs` key by. */
export function staticKeyOf(path: NodePath): string {
  return formatPath(staticPathOf(path));
}

/** Build a static key directly from a dynamic parent path plus one or more child names, without index. */
export function staticChildKey(parent: NodePath, ...names: readonly string[]): string {
  let path = staticPathOf(parent);
  for (const name of names) path = appendSegment(path, name);
  return formatPath(path);
}
