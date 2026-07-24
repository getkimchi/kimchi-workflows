/**
 * Node-path addressing (spec §8.5): the address of a step or node within a run — enclosing node
 * names, the iteration/item index where one applies, then the leaf name. E.g. `until-valid#3/design`
 * (loop iteration 3), `batch#7/review` (foreach item 7), `audit/lint` (nested workflow).
 *
 * Two forms of the same segment list:
 *  - DYNAMIC path — every segment carries its real iteration/item index. Recorded on every event
 *    that names a step (spec §8.1) and used for blocking/resume addressing (spec §8.4/§8.5).
 *  - STATIC path — indices dropped. Used to key step state (spec §5.4): latest execution wins, so a
 *    `run list` stays bounded no matter how many iterations ran.
 *
 * Pure — no fs/PI/network. This is the P2 seam P1 left for `step-state.ts`'s `keyOf` to grow into.
 */

export interface PathSegment {
  readonly name: string;
  /** The loop iteration (1-based) or foreach item index (0-based) this segment addresses, if any. */
  readonly index?: number;
}

/** A node path: root-to-leaf, at least one segment. */
export type NodePath = readonly PathSegment[];

const SEGMENT_SEPARATOR = "/";
const INDEX_SEPARATOR = "#";

/**
 * A bare step/node name may not carry path syntax (spec §3): `.commit()` rejects a name containing
 * `/` or `#`, since either would make a path built from it unparseable.
 */
export function isValidNodeName(name: string): boolean {
  return name.length > 0 && !name.includes(SEGMENT_SEPARATOR) && !name.includes(INDEX_SEPARATOR);
}

/** Append one segment (a construct's own addressing name, plus its iteration/item index if any). */
export function appendSegment(parent: NodePath, name: string, index?: number): NodePath {
  return [...parent, { name, index }];
}

/** Render a path to its wire/log form: `until-valid#3/design`. */
export function formatPath(path: NodePath): string {
  if (path.length === 0) throw new Error("formatPath: a node path must have at least one segment");
  return path.map((segment) => (segment.index === undefined ? segment.name : `${segment.name}${INDEX_SEPARATOR}${segment.index}`)).join(SEGMENT_SEPARATOR);
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
  const hashIndex = token.indexOf(INDEX_SEPARATOR);
  if (hashIndex === -1) return { name: token };

  const name = token.slice(0, hashIndex);
  const indexStr = token.slice(hashIndex + 1);
  if (name.length === 0) throw new Error(`parsePath: "${raw}" has an empty name before "#"`);
  if (token.indexOf(INDEX_SEPARATOR, hashIndex + 1) !== -1) throw new Error(`parsePath: "${raw}" has more than one "#" in one segment`);
  if (indexStr.length === 0 || !/^\d+$/.test(indexStr)) throw new Error(`parsePath: "${raw}" has a non-integer index "${indexStr}"`);
  return { name, index: Number(indexStr) };
}

/** Drop every segment's index (spec §5.4) — the form step state is keyed by. */
export function staticPathOf(path: NodePath): NodePath {
  return path.map((segment) => ({ name: segment.name }));
}

/** The static (index-dropped) key for a path, formatted — what `deriveStepStates` keys its map by. */
export function staticKeyOf(path: NodePath): string {
  return formatPath(staticPathOf(path));
}

/** Build a static key directly from a dynamic parent path plus one or more child names, without index. */
export function staticChildKey(parent: NodePath, ...names: readonly string[]): string {
  let path = staticPathOf(parent);
  for (const name of names) path = appendSegment(path, name);
  return formatPath(path);
}

/** The leaf (final) segment's bare name — for display. */
export function leafName(path: NodePath): string {
  const last = path[path.length - 1];
  if (!last) throw new Error("leafName: empty path");
  return last.name;
}
