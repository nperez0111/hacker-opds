/**
 * Article and comment markup for the website's story page.
 *
 * The EPUB renderer in ~/epub/render produces complete XHTML *documents*, one
 * per chapter, each with its own head and stylesheet link. The web page needs
 * fragments to drop into a shell instead, so this module renders its own rather
 * than unwrapping the EPUB output with a regex.
 *
 * What it does not do is reimplement the presentation decisions.
 * `commentBodyHtml` (quotes and footnotes), `authorLink`, `relativeAge`,
 * `threadLabel`, `depthClass` and `stripLeadingHeading` are all imported, so
 * the two surfaces stay in step: if HN quoting conventions or the thread
 * labelling change, they change in one place and both the book and the page
 * follow.
 *
 * The structure does differ, and deliberately. The book is paginated and its
 * comments are flat, indented by the `d1`..`dx` classes. The page nests them in
 * `<details>` so they can be collapsed, and there the indent comes from the
 * nesting rather than from the class - see `commentHtml` and the `.kids` rules
 * in the stylesheet.
 */
import type { CommentRow, CommentTreeNode } from "~/core/comments";
import { buildCommentTree, countReplies } from "~/core/comments";
import type { StoryRow } from "~/core/edition";
import type { ArticleRecord } from "~/core/extract";
import {
  articleErrorText,
  authorLink,
  commentBodyHtml,
  depthClass,
  relativeAge,
  stripLeadingHeading,
  threadLabel,
} from "~/epub/render";
import { xmlEscape } from "~/epub/xhtml";

export const HN_ITEM = "https://news.ycombinator.com/item?id=";

export interface StoryHtmlOptions {
  /** Depths past this flush left. The header still shows the true depth. */
  indentMaxDepth?: number;
}

/** Anchor for a thread section, matching the letter in its heading. */
export function threadAnchor(index: number): string {
  return `t${threadLabel(index)}`;
}

/**
 * The article body, or an explanation of why there is not one.
 *
 * `article.xhtml` was sanitised and absolutised when it was extracted (see
 * `defuddleHtml`), so it is inserted as-is. Re-parsing it here would cost a
 * full rehype round-trip per request to arrive at the same bytes.
 */
export function articleHtml(story: StoryRow, article: ArticleRecord | null): string {
  if (!article || article.state === "failed" || !article.xhtml.trim()) {
    const code = article?.error_code ?? "extraction_empty";
    const status = article?.http_status ? ` (HTTP ${article.http_status})` : "";
    const source = story.url
      ? `\n<p>Source: <a href="${xmlEscape(story.url)}" rel="noreferrer">${xmlEscape(
          story.url,
        )}</a></p>`
      : "";
    return (
      `<div class="stub">\n` +
      `<p class="reason">Article text unavailable</p>\n` +
      `<p>${xmlEscape(articleErrorText(code))}</p>\n` +
      `<p>Reason code: <code>${xmlEscape(code)}</code>${status}</p>` +
      `${source}\n` +
      `<p>The Hacker News discussion follows.</p>\n` +
      `</div>`
    );
  }

  // The page prints the title as its own h1, so a leading heading repeating it
  // would be the second copy on screen.
  return stripLeadingHeading(article.xhtml, article.title || story.title);
}

/** Byline under the article heading, or an empty string when nothing is known. */
export function articleByline(article: ArticleRecord | null): string[] {
  if (!article || article.state !== "ok") return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of [article.author, article.site, article.published?.slice(0, 10)]) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/**
 * One comment and its replies.
 *
 * Every comment is a `<details>`, leaves included. That is the whole
 * collapsing mechanism: no script, no state, no cookie, just the element the
 * browser already knows how to toggle. Leaves get one too so that the header
 * geometry, the tap target and the disclosure marker do not change shape
 * halfway down a thread, which on a slow panel reads as a rendering fault.
 *
 * The critical property is what happens when `<details>` is *not* supported,
 * which is a real possibility on the older WebKit builds these readers ship.
 * An unknown element renders as an inline box and its children render
 * normally, so the whole comment stays on screen and only the affordance is
 * lost. Nothing here is allowed to compromise that, which is why the
 * stylesheet never hides `.cbody` and never uses `details[open]` to *reveal*
 * anything - only ever to adjust chrome. Turning it around, so that content is
 * hidden by default and shown by `[open]`, would blank the discussion entirely
 * on exactly the devices this site exists for.
 *
 * `open` is set on every comment, so the page arrives fully expanded and
 * collapsing is something the reader chooses.
 */
function commentHtml(
  story: StoryRow,
  node: CommentTreeNode,
  indentMax: number,
): string {
  const comment = node.row;
  const isOp = story.author != null && comment.author === story.author;

  const bits: string[] = [];
  // No depth marker here, unlike the book. The book's comments are a flat list
  // and "L3" is the only thing placing them in the tree; the page nests them,
  // so the indent and the rule down the left edge already say it, and the
  // ancestors are pinned to the top of the viewport besides. Printing it too
  // would spend a third of a one-line header restating what is on screen.
  bits.push(authorLink(comment.id, comment.author, isOp, "noreferrer"));
  const age = relativeAge(comment.created_at_i, story.created_at_i);
  if (age) bits.push(xmlEscape(age));

  // The count is the whole subtree, because that is what the toggle hides. A
  // collapsed comment that just said "collapsed" would give the reader no way
  // to judge whether reopening it is worth a page flash.
  const replies = countReplies(node);
  if (replies > 0) {
    bits.push(
      `<span class="kidcount">${replies} repl${replies === 1 ? "y" : "ies"}</span>`,
    );
  }

  const kids = node.children.length
    ? `<div class="kids">${node.children
        .map((child) => commentHtml(story, child, indentMax))
        .join("")}</div>`
    : "";

  return (
    `<details class="${depthClass(comment.depth, indentMax)}" id="c${comment.id}" open>` +
    `<summary class="chead">${bits.join(" \u00b7 ")}</summary>` +
    `<div class="cbody">${commentBodyHtml(comment)}</div>` +
    kids +
    `</details>`
  );
}

/**
 * Every thread, in order.
 *
 * Threads are separated by a rule and nothing else. A heading here would have
 * to be either a label ("Thread B") or a summary of the thread, and the label
 * is the worse of the two: it names something the reader has no prior
 * knowledge of and cannot act on, while costing a line of vertical space in
 * every gap. The rule already says "a new top-level comment starts here",
 * which is the entire content of the heading.
 *
 * The anchor stays. It is invisible, it costs nothing, and it keeps
 * `/story/123#tB` working as a deep link into a discussion.
 *
 * Threads arrive flat and depth-ordered, as they are stored; the reply
 * structure is rebuilt here because the markup is a tree even though the table
 * is not.
 */
export function commentsHtml(
  story: StoryRow,
  threads: CommentRow[][],
  opts: StoryHtmlOptions = {},
): string {
  const indentMax = opts.indentMaxDepth ?? 5;
  if (threads.length === 0) {
    const hn = `${HN_ITEM}${story.id}`;
    return (
      `<div class="stub">` +
      `<p>No comments were available when this edition was built.</p>` +
      `<p><a href="${xmlEscape(hn)}" rel="noreferrer">View the discussion on Hacker News</a></p>` +
      `</div>`
    );
  }

  return threads
    .map((thread, index) => {
      const body = buildCommentTree(thread)
        .map((node) => commentHtml(story, node, indentMax))
        .join("");
      return `<section class="thread" id="${threadAnchor(index)}">${body}</section>`;
    })
    .join("");
}
