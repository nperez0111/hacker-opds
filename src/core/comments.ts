import type { CommentNode } from "./tree";
import { getDb, tx } from "~/db/client";

export interface CommentRow {
  id: number;
  story_id: number;
  parent_id: number | null;
  root_id: number;
  depth: number;
  sort_index: number;
  author: string | null;
  created_at_i: number | null;
  text_html: string;
}

function isRenderable(item: CommentNode): boolean {
  const t = item.text;
  if (!t) return false;
  const stripped = t.trim();
  if (!stripped) return false;
  return stripped !== "[flagged]" && stripped !== "[dead]" &&
    stripped !== "[delayed]";
}

/**
 * Preorder flatten of the HN item tree, preserving HN's native ordering.
 *
 * Deleted / flagged nodes are dropped but their subtrees are kept and
 * reparented onto the nearest surviving ancestor, which is what HN itself
 * renders. `depth` therefore counts surviving ancestors, not raw tree depth.
 */
export function flattenComments(
  storyId: number,
  tree: CommentNode,
): CommentRow[] {
  const out: CommentRow[] = [];
  let sort = 0;

  const walk = (
    node: CommentNode,
    parentId: number | null,
    rootId: number | null,
    depth: number,
  ): void => {
    const children = node.children ?? [];
    if (node.type === "comment" && isRenderable(node)) {
      const root = rootId ?? node.id;
      out.push({
        id: node.id,
        story_id: storyId,
        parent_id: parentId,
        root_id: root,
        depth,
        sort_index: sort++,
        author: node.author,
        created_at_i: node.created_at_i,
        text_html: node.text as string,
      });
      for (const c of children) walk(c, node.id, root, depth + 1);
    } else {
      // Dropped node: children attach to the nearest surviving ancestor.
      for (const c of children) walk(c, parentId, rootId, depth);
    }
  };

  for (const c of tree.children ?? []) walk(c, null, null, 0);
  return out;
}

export function saveComments(storyId: number, rows: CommentRow[]): void {
  const db = getDb();
  tx(() => {
    db.query("DELETE FROM comments WHERE story_id = ?").run(storyId);
    const ins = db.query(
      `INSERT INTO comments (id, story_id, parent_id, root_id, depth,
                             sort_index, author, created_at_i, text_html)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rows) {
      ins.run(
        r.id, r.story_id, r.parent_id, r.root_id, r.depth,
        r.sort_index, r.author, r.created_at_i, r.text_html,
      );
    }
  });
}

export function getComments(storyId: number): CommentRow[] {
  return getDb()
    .query<CommentRow, [number]>(
      "SELECT * FROM comments WHERE story_id = ? ORDER BY sort_index",
    )
    .all(storyId);
}

/** Groups the flat preorder list into root threads, order preserved. */
export function groupThreads(rows: CommentRow[]): CommentRow[][] {
  const threads = new Map<number, CommentRow[]>();
  for (const r of rows) {
    let t = threads.get(r.root_id);
    if (!t) threads.set(r.root_id, (t = []));
    t.push(r);
  }
  return [...threads.values()];
}

/** A comment with its replies attached. Preorder is preserved at every level. */
export interface CommentTreeNode {
  row: CommentRow;
  children: CommentTreeNode[];
}

/**
 * Rebuilds the parent/child structure that `flattenComments` folded away.
 *
 * The database stores comments flat because that is what both renderers wanted
 * until the website grew collapsible replies, and because a flat table with a
 * `sort_index` is the cheapest thing to read back in display order. Nesting is
 * derived here rather than stored so the storage format does not have to
 * change and so old rows keep working.
 *
 * Parentage comes from `parent_id`. That is authoritative, but it is not always
 * usable: a thread sliced out of the full list (a digest capped at some depth,
 * a single thread handed to a renderer) contains rows whose parent is not in
 * the input. Those fall back to the depth stack - the most recent row at
 * `depth - 1` - which is exactly the reading a human gives an indented list.
 * Anything that resolves to neither becomes a root, so no row is ever dropped.
 *
 * Input is assumed to be in preorder (`sort_index`), which is how `getComments`
 * and `groupThreads` return it; a parent therefore always precedes its
 * children, and only already-seen nodes are candidate parents. That also makes
 * cycles impossible, including from a row that claims itself as its parent.
 */
export function buildCommentTree(rows: CommentRow[]): CommentTreeNode[] {
  const roots: CommentTreeNode[] = [];
  const byId = new Map<number, CommentTreeNode>();
  /** stack[d] is the last node seen at depth d; the depth-stack fallback. */
  const stack: CommentTreeNode[] = [];

  for (const row of rows) {
    const node: CommentTreeNode = { row, children: [] };

    let parent = row.parent_id == null ? undefined : byId.get(row.parent_id);
    if (!parent && row.depth > 0) parent = stack[row.depth - 1];

    if (parent) parent.children.push(node);
    else roots.push(node);

    // Registered after the lookup, so a self-parenting row cannot loop.
    if (!byId.has(row.id)) byId.set(row.id, node);
    const depth = row.depth > 0 ? row.depth : 0;
    stack[depth] = node;
    // Deeper entries belong to a sibling subtree that has now ended.
    stack.length = depth + 1;
  }

  return roots;
}

/**
 * Number of comments below `node`, all levels.
 *
 * Collapsing a comment hides its whole subtree, so this - not the direct child
 * count - is the figure that tells a reader what is behind the toggle.
 */
export function countReplies(node: CommentTreeNode): number {
  let n = 0;
  for (const child of node.children) n += 1 + countReplies(child);
  return n;
}
