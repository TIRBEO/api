/* Walking a parent/child table that Postgres cannot promise is a tree.
 *
 * Both directory tables — groups and organisational units — store `parent_id`
 * and both need the same three answers: how far up a node goes, how far down,
 * and whether a proposed placement would make a node its own ancestor. That
 * last one is not paranoia. Nothing in the schema stops it, the console's move
 * form is two selects that can be set to each other, and a group that contains
 * itself does not fail on the way in — it fails on the way out, in whatever
 * read walks the tree later.
 *
 * So the traversal lives here, once, with the depth cap as an argument rather
 * than a constant: the two tables are allowed different ceilings, and a shared
 * function with the number baked into it is how one of them quietly inherits the
 * other's limit.
 */

export type ParentDelegate = {
  /** The parent id of one node, or null at the top. */
  parentOf: (id: string) => Promise<string | null>;
  /** The direct children of a set of nodes, one query per level. */
  childrenOf: (ids: string[]) => Promise<string[]>;
};

export type Ancestry = {
  /** Every ancestor, nearest first. Never includes the node asked about. */
  ids: string[];
  /** True when the walk came back to a node it had already visited, or ran out
   *  of patience. Either way the stored tree is already broken and a write that
   *  leans on it must not be allowed to make it worse. */
  cycled: boolean;
};

/** Climb from `startId` towards the root, at most `cap * 2` steps.
 *
 *  Iterative and bounded on purpose. A recursive CTE would be one round trip
 *  and no ceiling, and the whole point of the ceiling is that a corrupt tree
 *  returns an answer instead of a stack error. */
export async function ancestorsOf(startId: string, cap: number, delegate: ParentDelegate): Promise<Ancestry> {
  const ids: string[] = [];
  const seen = new Set<string>([startId]);
  let cursor: string | null = startId;
  while (cursor && ids.length < cap * 2) {
    cursor = await delegate.parentOf(cursor);
    if (!cursor) return { ids, cycled: false };
    if (seen.has(cursor)) return { ids, cycled: true };
    seen.add(cursor);
    ids.push(cursor);
  }
  return { ids, cycled: true };
}

/** Edges from `rootId` down to its deepest descendant. A leaf is 0.
 *
 *  Stops counting at `cap + 1` rather than proving a subtree is deeper than the
 *  limit: the caller only needs to know whether it fits, and measuring a
 *  thousand-level tree to conclude "more than ten" is a slow way to say no. */
export async function subtreeDepth(rootId: string, cap: number, delegate: ParentDelegate): Promise<number> {
  let frontier = [rootId];
  let depth = 0;
  while (frontier.length && depth <= cap) {
    const next = await delegate.childrenOf(frontier);
    if (!next.length) return depth;
    frontier = next;
    depth += 1;
  }
  return depth;
}

/** What a caller needs to refuse a placement, in one sentence per cause.
 *  Null means the placement is fine. */
export async function placementRefusal(
  nodeId: string,
  parentId: string,
  cap: number,
  delegate: ParentDelegate,
  nouns: { singular: string; plural: string },
): Promise<{ message: string; status: number } | null> {
  if (nodeId === parentId) {
    return { message: `A ${nouns.singular} cannot be inside itself.`, status: 400 };
  }
  const chain = await ancestorsOf(parentId, cap, delegate);
  if (chain.cycled) {
    return {
      message: `The tree above that ${nouns.singular} already loops back on itself. Repair it before adding to it.`,
      status: 409,
    };
  }
  if (chain.ids.includes(nodeId)) {
    return {
      message: `That ${nouns.singular} is inside this one already, so the two would contain each other.`,
      status: 409,
    };
  }
  const below = await subtreeDepth(nodeId, cap, delegate);
  const levelsAbove = chain.ids.length + 1;
  if (levelsAbove + 1 + below > cap) {
    return {
      message: `That would make ${levelsAbove + 1 + below} levels, and ${cap} is the limit.`,
      status: 409,
    };
  }
  return null;
}
