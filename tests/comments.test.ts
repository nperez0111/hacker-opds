import { describe, expect, test } from "bun:test";
import type { CommentNode } from "~/core/tree";
import type { CommentRow, CommentTreeNode } from "~/core/comments";
import {
  buildCommentTree,
  countReplies,
  flattenComments,
  groupThreads,
} from "~/core/comments";

let nextId = 1;

function comment(
  text: string | null,
  children: CommentNode[] = [],
  author = "alice",
): CommentNode {
  return {
    id: nextId++,
    type: "comment",
    author,
    text,
    created_at_i: 1_700_000_000,
    children,
  } as CommentNode;
}

function story(children: CommentNode[]): CommentNode {
  return {
    id: nextId++,
    type: "story",
    author: "op",
    text: null,
    created_at_i: 1_700_000_000,
    children,
  } as CommentNode;
}

describe("flattenComments", () => {
  test("preserves HN preorder and assigns sequential sort_index", () => {
    const a = comment("a", [comment("a1"), comment("a2")]);
    const b = comment("b");
    const rows = flattenComments(1, story([a, b]));

    expect(rows.map((r) => r.text_html)).toEqual(["a", "a1", "a2", "b"]);
    expect(rows.map((r) => r.sort_index)).toEqual([0, 1, 2, 3]);
  });

  test("assigns depth relative to the root thread", () => {
    const rows = flattenComments(
      1,
      story([comment("a", [comment("a1", [comment("a1i")])])]),
    );
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2]);
  });

  test("tags every node in a thread with the same root_id", () => {
    const a = comment("a", [comment("a1", [comment("a1i")])]);
    const b = comment("b", [comment("b1")]);
    const rows = flattenComments(1, story([a, b]));

    const byText = Object.fromEntries(rows.map((r) => [r.text_html, r]));
    expect(byText.a!.root_id).toBe(byText.a!.id);
    expect(byText.a1!.root_id).toBe(byText.a!.id);
    expect(byText.a1i!.root_id).toBe(byText.a!.id);
    expect(byText.b1!.root_id).toBe(byText.b!.id);
  });

  test("sets parent_id to null for roots and to the parent otherwise", () => {
    const a = comment("a", [comment("a1")]);
    const rows = flattenComments(1, story([a]));
    expect(rows[0]!.parent_id).toBeNull();
    expect(rows[1]!.parent_id).toBe(rows[0]!.id);
  });

  test("drops flagged, dead, delayed, empty and null comments", () => {
    const rows = flattenComments(
      1,
      story([
        comment("[flagged]"),
        comment("[dead]"),
        comment("[delayed]"),
        comment(""),
        comment("   "),
        comment(null),
        comment("kept"),
      ]),
    );
    expect(rows.map((r) => r.text_html)).toEqual(["kept"]);
  });

  test("reparents the subtree of a dropped node onto the surviving ancestor", () => {
    // a > [flagged] > a1i  =>  a1i becomes a direct child of a
    const orphan = comment("a1i");
    const dropped = comment("[flagged]", [orphan]);
    const a = comment("a", [dropped]);
    const rows = flattenComments(1, story([a]));

    expect(rows.map((r) => r.text_html)).toEqual(["a", "a1i"]);
    expect(rows[1]!.depth).toBe(1);
    expect(rows[1]!.parent_id).toBe(rows[0]!.id);
    expect(rows[1]!.root_id).toBe(rows[0]!.id);
  });

  test("promotes a subtree to root when the root itself is dropped", () => {
    const survivor = comment("survivor", [comment("child")]);
    const rows = flattenComments(1, story([comment("[dead]", [survivor])]));

    expect(rows.map((r) => r.text_html)).toEqual(["survivor", "child"]);
    expect(rows[0]!.depth).toBe(0);
    expect(rows[0]!.parent_id).toBeNull();
    expect(rows[0]!.root_id).toBe(rows[0]!.id);
    expect(rows[1]!.root_id).toBe(rows[0]!.id);
  });

  test("returns an empty list for a story with no comments", () => {
    expect(flattenComments(1, story([]))).toEqual([]);
    const bare = story([]);
    delete (bare as { children?: unknown }).children;
    expect(flattenComments(1, bare)).toEqual([]);
  });

  test("stamps the given story id on every row", () => {
    const rows = flattenComments(42, story([comment("a", [comment("a1")])]));
    expect(rows.every((r) => r.story_id === 42)).toBe(true);
  });
});

describe("groupThreads", () => {
  test("groups by root_id preserving thread and intra-thread order", () => {
    const a = comment("a", [comment("a1")]);
    const b = comment("b", [comment("b1")]);
    const threads = groupThreads(flattenComments(1, story([a, b])));

    expect(threads.length).toBe(2);
    expect(threads[0]!.map((r) => r.text_html)).toEqual(["a", "a1"]);
    expect(threads[1]!.map((r) => r.text_html)).toEqual(["b", "b1"]);
  });

  test("returns no threads for an empty list", () => {
    expect(groupThreads([])).toEqual([]);
  });
});

describe("buildCommentTree", () => {
  /** A stored row, with the fields the tree builder actually reads. */
  function row(over: Partial<CommentRow> & { id: number }): CommentRow {
    return {
      story_id: 1,
      parent_id: null,
      root_id: over.id,
      depth: 0,
      sort_index: 0,
      author: "alice",
      created_at_i: 1_700_000_000,
      text_html: `<p>${over.id}</p>`,
      ...over,
    };
  }

  /** Shape as nested ids, which is the only thing these tests care about. */
  function shape(nodes: CommentTreeNode[]): unknown {
    return nodes.map((n) => (n.children.length ? [n.row.id, shape(n.children)] : n.row.id));
  }

  test("nests replies under the parent named by parent_id", () => {
    const rows = [
      row({ id: 1, depth: 0 }),
      row({ id: 2, depth: 1, parent_id: 1 }),
      row({ id: 3, depth: 2, parent_id: 2 }),
      row({ id: 4, depth: 1, parent_id: 1 }),
    ];
    expect(shape(buildCommentTree(rows))).toEqual([[1, [[2, [3]], 4]]]);
  });

  test("keeps several roots side by side, in input order", () => {
    const rows = [
      row({ id: 1 }),
      row({ id: 2, depth: 1, parent_id: 1 }),
      row({ id: 9 }),
    ];
    expect(shape(buildCommentTree(rows))).toEqual([[1, [2]], 9]);
  });

  test("preserves sibling order rather than reordering by id", () => {
    const rows = [
      row({ id: 1 }),
      row({ id: 30, depth: 1, parent_id: 1, sort_index: 1 }),
      row({ id: 20, depth: 1, parent_id: 1, sort_index: 2 }),
    ];
    const kids = buildCommentTree(rows)[0]!.children.map((c) => c.row.id);
    expect(kids).toEqual([30, 20]);
  });

  test("falls back to the depth stack when the parent is not in the input", () => {
    // A thread sliced out of the full list, or rows from a schema that never
    // recorded parentage: depth is all there is, and it is enough.
    const rows = [
      row({ id: 1, depth: 0, parent_id: null }),
      row({ id: 2, depth: 1, parent_id: 999 }),
      row({ id: 3, depth: 2, parent_id: 998 }),
      row({ id: 4, depth: 1, parent_id: 997 }),
    ];
    expect(shape(buildCommentTree(rows))).toEqual([[1, [[2, [3]], 4]]]);
  });

  test("prefers parent_id over the depth stack when the two disagree", () => {
    // parent_id is authoritative: depth here would attach 3 to 2.
    const rows = [
      row({ id: 1, depth: 0 }),
      row({ id: 2, depth: 1, parent_id: 1 }),
      row({ id: 3, depth: 2, parent_id: 1 }),
    ];
    expect(shape(buildCommentTree(rows))).toEqual([[1, [2, 3]]]);
  });

  test("treats a row whose depth has no ancestor as a root rather than dropping it", () => {
    const rows = [row({ id: 1, depth: 0 }), row({ id: 2, depth: 3, parent_id: 404 })];
    expect(shape(buildCommentTree(rows))).toEqual([1, 2]);
  });

  test("does not loop on a row that claims itself as its parent", () => {
    const rows = [row({ id: 1, depth: 0, parent_id: 1 })];
    expect(shape(buildCommentTree(rows))).toEqual([1]);
  });

  test("keeps every row exactly once, however odd the parentage", () => {
    const rows = [
      row({ id: 1, depth: 0, parent_id: 7 }),
      row({ id: 2, depth: 1, parent_id: 1 }),
      row({ id: 3, depth: 9, parent_id: 2 }),
      row({ id: 4, depth: 0, parent_id: null }),
    ];
    const seen: number[] = [];
    const walk = (nodes: CommentTreeNode[]) => {
      for (const n of nodes) {
        seen.push(n.row.id);
        walk(n.children);
      }
    };
    walk(buildCommentTree(rows));
    expect(seen.sort()).toEqual([1, 2, 3, 4]);
  });

  test("returns nothing for no rows", () => {
    expect(buildCommentTree([])).toEqual([]);
  });

  test("round-trips the flattener: same shape in, same shape out", () => {
    const a = comment("a", [comment("a1", [comment("a1i")]), comment("a2")]);
    const rows = flattenComments(1, story([a]));
    const tree = buildCommentTree(rows);
    const texts = (nodes: CommentTreeNode[]): unknown =>
      nodes.map((n) => (n.children.length ? [n.row.text_html, texts(n.children)] : n.row.text_html));
    expect(texts(tree)).toEqual([["a", [["a1", ["a1i"]], "a2"]]]);
  });
});

describe("countReplies", () => {
  function node(id: number, children: CommentTreeNode[] = []): CommentTreeNode {
    return { row: { id } as CommentRow, children };
  }

  test("counts the whole subtree, not just direct children", () => {
    // Collapsing hides everything below, so that is the number to report.
    expect(countReplies(node(1, [node(2, [node(3), node(4)]), node(5)]))).toBe(4);
  });

  test("is zero for a leaf", () => {
    expect(countReplies(node(1))).toBe(0);
  });
});
