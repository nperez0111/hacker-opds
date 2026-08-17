/**
 * The comment tree shape shared by the parser that produces it
 * (`~/core/hn-html`) and the flattener that consumes it (`~/core/comments`).
 *
 * It lives in its own module so neither side has to import the other, and so
 * the shape survives a change of comment source. It has already outlived two:
 * Algolia's `/items/:id` and HN's Firebase API both produced this same node.
 */

export interface CommentNode {
  id: number;
  type: string;
  author: string | null;
  text: string | null;
  created_at_i: number | null;
  children: CommentNode[];
}
