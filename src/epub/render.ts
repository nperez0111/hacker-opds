/**
 * Chapter rendering: turns story/article/comment rows into EPUB XHTML documents.
 *
 * Every function here is pure over its inputs. In particular nothing reads the
 * wall clock: comment ages are expressed relative to the story's own post time,
 * not "now". That is deliberate on two grounds:
 *
 *  1. Determinism. Editions are immutable and content-addressed; if age were
 *     computed from build time, two builds of the same edition would differ.
 *  2. Honesty. A book read three weeks later would otherwise claim a comment is
 *     "4h old". "+4h" — four hours after submission — stays true forever.
 */

import type { StoryRow } from "~/core/edition";
import type { CommentRow } from "~/core/comments";
import type { ArticleRecord } from "~/core/extract";
import { toXhtmlFragment, xhtmlDocument, xmlEscape } from "~/epub/xhtml";
import { EPUB_CSS_HREF } from "~/epub/styles";

const HN_ITEM = "https://news.ycombinator.com/item?id=";

export interface RenderOptions {
  /** Depths beyond this render flush left; the true depth stays in the header. */
  indentMaxDepth?: number;
  /** Cap on rendered depth per thread. Deeper comments are omitted (digest use). */
  maxDepth?: number;
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Offset of `at` from `base`, both unix seconds, as a short human string.
 * Always relative to the story, hence the leading "+".
 */
export function relativeAge(at: number | null, base: number): string {
  if (at == null || !Number.isFinite(at)) return "";
  const d = Math.max(0, Math.round(at - base));
  if (d < 60) return "+0m";
  const m = Math.floor(d / 60);
  if (m < 60) return `+${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `+${h}h`;
  const days = Math.floor(h / 24);
  if (days < 60) return `+${days}d`;
  return `+${Math.floor(days / 30)}mo`;
}

/** Absolute date, for front matter. Fixed UTC format keeps builds deterministic. */
export function isoDate(unix: number): string {
  return new Date(unix * 1000).toISOString().replace("T", " ").slice(0, 16) + "Z";
}

/**
 * Plain-text summary of an HTML fragment, for TOC labels.
 * Entity handling is limited to the five predefined XML entities plus the few
 * HN actually emits; a full decoder is not worth pulling in for a TOC label.
 */
export function snippet(html: string, maxLen = 64): string {
  const text = html
    // Drop these subtrees wholly: a naive tag strip would keep their text
    // content, which is code, not prose, and would end up in the TOC label.
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen);
  const sp = cut.lastIndexOf(" ");
  return (sp > maxLen * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + "\u2026";
}

export function depthClass(depth: number, indentMax: number): string {
  if (depth <= 0) return "comment";
  return `comment ${depth <= indentMax ? `d${depth}` : "dx"}`;
}

const ERROR_TEXT: Record<string, string> = {
  robots_disallowed: "The site's robots.txt asks automated clients not to fetch this page.",
  http_error: "The server returned an error response.",
  http_404: "The page was not found.",
  timeout: "The server did not respond in time.",
  network_error: "The page could not be reached.",
  too_large: "The page exceeded the size limit for extraction.",
  too_many_redirects: "The page redirected too many times.",
  unsupported_content_type: "The link does not point at an HTML page (it may be a PDF, video or archive).",
  invalid_url: "The submitted link could not be parsed.",
  extraction_empty: "The page was fetched but no article text could be identified.",
  extraction_error: "The page was fetched but could not be parsed.",
};

/**
 * Plain-English reason for a failed extraction.
 *
 * Shared with the website so a story that could not be extracted explains
 * itself the same way in the book and in the browser. An unknown code is a
 * new failure mode that has not been given wording yet, so it falls back to
 * something honest rather than printing the bare identifier.
 */
export function articleErrorText(code: string | null | undefined): string {
  return (code && ERROR_TEXT[code]) || "The article could not be extracted.";
}

/* ------------------------------------------------------------------ */
/* front matter                                                        */
/* ------------------------------------------------------------------ */

export function renderFrontMatter(story: StoryRow, article: ArticleRecord | null): string {
  const meta: string[] = [];
  meta.push(
    `<p class="meta">${story.points} points \u00b7 ${story.num_comments} comments` +
      (story.author ? ` \u00b7 submitted by ${xmlEscape(story.author)}` : "") +
      `</p>`,
  );
  meta.push(`<p class="meta">${xmlEscape(isoDate(story.created_at_i))}</p>`);
  if (story.domain) meta.push(`<p class="meta">${xmlEscape(story.domain)}</p>`);
  if (article && article.state === "ok" && article.word_count > 0) {
    meta.push(`<p class="meta">${article.word_count} words</p>`);
  }

  const links: string[] = [];
  if (story.url) {
    links.push(`<p><a href="${xmlEscape(story.url)}">Original article</a><br />${xmlEscape(story.url)}</p>`);
  }
  const hn = `${HN_ITEM}${story.id}`;
  links.push(`<p><a href="${xmlEscape(hn)}">Hacker News discussion</a><br />${xmlEscape(hn)}</p>`);

  const body =
    `<section class="frontmatter" epub:type="titlepage">\n` +
    `<h1 class="title">${xmlEscape(story.title)}</h1>\n` +
    meta.join("\n") +
    `\n<div class="links">\n${links.join("\n")}\n</div>\n` +
    `</section>`;

  return xhtmlDocument(story.title, body, { cssHref: EPUB_CSS_HREF });
}

/* ------------------------------------------------------------------ */
/* article                                                             */
/* ------------------------------------------------------------------ */

/** Loose comparison key for titles: case/punctuation/whitespace insensitive. */
function titleKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, (c) => (c === "\u2018" || c === "\u2019" ? "'" : '"'))
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Remove a leading `<h1>`–`<h3>` whose text repeats the chapter title.
 *
 * `renderArticle` prints its own heading, and defuddle's `standardize` only
 * strips the page's title heading when it matches the metadata title exactly.
 * When it does not (different punctuation, a subtitle, a site suffix) the
 * title renders twice at the top of every chapter. Dropping the duplicate here
 * is safer than suppressing our own heading, which is the one guaranteed to be
 * present and correctly escaped.
 */
export function stripLeadingHeading(html: string, title: string): string {
  const match = /^\s*<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/.exec(html);
  if (!match) return html;

  const headingText = snippet(match[2] ?? "", 500);
  if (!headingText) return html;

  const want = titleKey(title);
  const got = titleKey(headingText);
  if (!want || !got) return html;
  // Also drop headings that merely prefix the title, e.g. a page <h1> without
  // the site's trailing " — Blog Name" that the metadata title carries.
  if (got !== want && !want.startsWith(got) && !got.startsWith(want)) return html;

  return html.slice(match[0].length).replace(/^\s+/, "");
}

/** Join byline parts, dropping case-insensitive duplicates. */
export function bylineParts(...values: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

interface ArticleParts {
  /** Document title: the extracted one when there is one. */
  title: string;
  /** Document language, when the extractor identified one. */
  lang?: string;
  /** The `<section>` element, ready to drop into a document body. */
  body: string;
}

/**
 * The article chapter's contents, without the surrounding document.
 *
 * Split out so the digest can put the same section under its own per-story
 * header rather than reimplementing the stub handling, the byline dedupe and
 * the duplicate-heading strip.
 */
function articleParts(story: StoryRow, article: ArticleRecord | null): ArticleParts {
  const title = article?.title || story.title;
  const heading = `<h2>${xmlEscape(title)}</h2>`;

  if (!article || article.state === "failed" || !article.xhtml.trim()) {
    const code = article?.error_code ?? "extraction_empty";
    const why = articleErrorText(code);
    const target = story.url
      ? `<p>Source: <a href="${xmlEscape(story.url)}">${xmlEscape(story.url)}</a></p>`
      : "";
    const body =
      `<section epub:type="bodymatter">\n${heading}\n` +
      `<div class="stub">\n` +
      `<p class="reason">Article text unavailable</p>\n` +
      `<p>${xmlEscape(why)}</p>\n` +
      `<p>Reason code: <code>${xmlEscape(code)}</code>` +
      (article?.http_status ? ` (HTTP ${article.http_status})` : "") +
      `</p>\n${target}` +
      `<p>The Hacker News discussion follows.</p>\n` +
      `</div>\n</section>`;
    return { title: story.title, body };
  }

  // Extractors frequently report the same string as both author and site
  // (e.g. "RISC-V Article · RISC-V Article"), so dedupe before joining.
  const byline = bylineParts(
    article.author,
    article.site,
    article.published?.slice(0, 10),
  ).map(xmlEscape);
  const bylineHtml = byline.length ? `<p class="meta">${byline.join(" \u00b7 ")}</p>\n` : "";

  const content = stripLeadingHeading(article.xhtml, title);

  const body = `<section epub:type="bodymatter">\n${heading}\n${bylineHtml}${content}\n</section>`;

  return { title, lang: article.language || undefined, body };
}

export function renderArticle(story: StoryRow, article: ArticleRecord | null): string {
  const parts = articleParts(story, article);
  return xhtmlDocument(parts.title, parts.body, {
    cssHref: EPUB_CSS_HREF,
    lang: parts.lang,
  });
}

/* ------------------------------------------------------------------ */
/* comments                                                            */
/* ------------------------------------------------------------------ */

/**
 * Thread identifiers as letters rather than numbers.
 *
 * Comments already carry a numeric depth marker (`L3`), and a numeric thread
 * marker next to it turns every header into a small arithmetic puzzle. Letters
 * for the thread and digits for the depth keep the two axes visually distinct.
 *
 * Counts past Z continue as AA, AB, ... so the label is always unique.
 */
export function threadLabel(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/**
 * Styles HN-convention quotes.
 *
 * HN has no blockquote markup: users prefix a line with `>` and the site
 * renders it as an ordinary paragraph, so a reply and the text it is quoting
 * look identical. That is hard to follow anywhere and worse on a small
 * greyscale screen, so paragraphs opening with one or more `>` are tagged for
 * the stylesheet.
 *
 * The markers themselves are dropped once the styling carries the meaning,
 * exactly as Markdown does. Nothing else about the paragraph is touched.
 */
export function markQuotes(fragment: string): string {
  return fragment.replace(
    /<p>(\s*(?:&gt;|>)[\s\S]*?)<\/p>/gi,
    (_whole, inner: string) =>
      `<p class="quote">${inner.replace(/^(?:\s*(?:&gt;|>))+\s*/i, "")}</p>`,
  );
}

/* ------------------------------------------------------------------ */
/* HN footnote conventions                                             */
/* ------------------------------------------------------------------ */

/**
 * Elements whose text is never prose and must never be rewritten.
 *
 * `a` because a footnote marker inside a link is already a link, and nesting
 * anchors is not representable in HTML; `code` and `pre` because `arr[1]` in a
 * snippet is an index expression and turning it into a hyperlink would be a lie
 * about the code.
 */
const FN_OPAQUE = new Set(["a", "code", "pre"]);

/**
 * Inline elements. Crossing one neither starts nor ends a line, so `See <i>the
 * paper</i> [1]` does not look like a definition just because the text run
 * after `</i>` happens to begin with whitespace.
 */
const FN_INLINE = new Set([
  "a", "abbr", "b", "cite", "code", "del", "dfn", "em", "i", "img", "ins",
  "kbd", "mark", "q", "s", "samp", "small", "span", "strong", "sub", "sup",
  "u", "var", "wbr",
]);

/** `[12]` and nothing longer; the range check happens on the captured digits. */
const FN_TOKEN = /\[(\d{1,3})\]/g;
const FN_TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/y;

interface FnHit {
  start: number;
  end: number;
  n: string;
  /** True when this occurrence opens a line, i.e. it defines rather than cites. */
  def: boolean;
}

/** True when everything after the last newline (if any) is blank. */
function fnLineOpen(text: string, wasOpen: boolean): boolean {
  const nl = text.lastIndexOf("\n");
  if (nl !== -1) return !text.slice(nl + 1).trim();
  if (!text) return wasOpen;
  return wasOpen && !text.trim();
}

function fnScanText(text: string, base: number, lineOpen: boolean, out: FnHit[]): void {
  FN_TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FN_TOKEN.exec(text))) {
    const n = m[1] as string;
    // "[0]" is not a footnote and "[01]" is not a number anyone writes; both
    // are far more likely to be array indices or literal text.
    if (!/^[1-9]\d{0,2}$/.test(n)) continue;

    const at = m.index;
    const before = text.slice(0, at);
    const after = text.slice(at + m[0].length);

    // "[1](https://...)" is markdown. HN does not render markdown, so the text
    // is meant literally and rewriting it would corrupt what was typed.
    if (after.startsWith("(")) continue;

    const nl = before.lastIndexOf("\n");
    const prefix = nl === -1 ? before : before.slice(nl + 1);
    const opens = (nl !== -1 || lineOpen) && !prefix.trim();

    if (opens && (after === "" || /^[\s:.\u2013\u2014-]/.test(after))) {
      out.push({ start: base + at, end: base + at + m[0].length, n, def: true });
      continue;
    }
    // "arr[1]", "xs[2]" and "f(x)[3]" are subscripts, not citations: a
    // citation is always preceded by a space, a bracket or nothing at all.
    if (/[A-Za-z0-9_\])]$/.test(before)) continue;
    out.push({ start: base + at, end: base + at + m[0].length, n, def: false });
  }
}

/**
 * Wires up HN's ad-hoc footnote convention.
 *
 * People write `as shown in [1]` and then, further down, a line beginning
 * `[1] https://...`. HN renders both as plain text, so on a small screen the
 * reader has to scroll away, find the line, and scroll back with no way to
 * return. This turns the definition into an anchor, every citation of it into a
 * link to that anchor, and the definition itself into a link back to the first
 * citation.
 *
 * The transform is deliberately conservative, because a false positive damages
 * text a human wrote:
 *
 *  - a marker is only linked when a matching definition exists in the *same*
 *    comment, so a bare `[1]` with nothing to point at is left alone;
 *  - a definition must open a line or a paragraph;
 *  - `[0]`, `[citation needed]`, `arr[1]` and `[1](url)` are all rejected;
 *  - text inside `a`, `code` and `pre` is never touched.
 *
 * Anchors are namespaced with `scope` (the comment id) because the website puts
 * hundreds of comments in one document, and duplicate ids would send every
 * `[1]` on the page to whichever comment happened to be first.
 *
 * Input must be sanitised XHTML - it is scanned as markup, not parsed - and the
 * output is markup-for-markup identical apart from the inserted anchors.
 */
export function linkFootnotes(fragment: string, scope: string | number): string {
  if (!fragment || !fragment.includes("[")) return fragment;

  const hits: FnHit[] = [];
  const opaque: string[] = [];
  let i = 0;
  let lineOpen = true;

  while (i < fragment.length) {
    const lt = fragment.indexOf("<", i);
    const textEnd = lt === -1 ? fragment.length : lt;
    if (textEnd > i) {
      const text = fragment.slice(i, textEnd);
      if (opaque.length === 0) fnScanText(text, i, lineOpen, hits);
      lineOpen = fnLineOpen(text, lineOpen);
      i = textEnd;
    }
    if (lt === -1) break;

    if (fragment.startsWith("<!--", i)) {
      const close = fragment.indexOf("-->", i);
      i = close === -1 ? fragment.length : close + 3;
      continue;
    }

    FN_TAG.lastIndex = i;
    const tag = FN_TAG.exec(fragment);
    if (!tag) {
      // A bare "<" in text. Treat it as text and carry on.
      i += 1;
      lineOpen = false;
      continue;
    }

    // Attribute values may contain ">", so the tag ends at the first ">" that
    // is not inside quotes.
    let j = i + tag[0].length;
    let quote = "";
    for (; j < fragment.length; j++) {
      const ch = fragment[j] as string;
      if (quote) {
        if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ">") break;
    }

    const name = (tag[2] as string).toLowerCase();
    const closing = tag[1] === "/";
    const empty = /\/\s*$/.test(fragment.slice(i + tag[0].length, j));

    if (FN_OPAQUE.has(name) && !empty) {
      if (closing) {
        const last = opaque.lastIndexOf(name);
        if (last !== -1) opaque.splice(last, 1);
      } else opaque.push(name);
    }

    if (name === "br") lineOpen = true;
    else if (!FN_INLINE.has(name)) lineOpen = true;

    i = j + 1;
  }

  if (hits.length === 0) return fragment;

  const defs = new Map<string, FnHit>();
  const refs = new Map<string, FnHit[]>();
  for (const hit of hits) {
    if (hit.def && !defs.has(hit.n)) {
      defs.set(hit.n, hit);
      continue;
    }
    // A repeat of a definition-shaped marker is a citation of the first one.
    const list = refs.get(hit.n);
    if (list) list.push(hit);
    else refs.set(hit.n, [hit]);
  }

  const ns = String(scope).replace(/[^A-Za-z0-9_-]/g, "");
  const out: string[] = [];
  let cursor = 0;
  for (const hit of hits) {
    const def = defs.get(hit.n);
    const cites = refs.get(hit.n);
    // Both halves have to exist: an unreferenced definition needs no anchor and
    // a citation with nowhere to go must stay plain text.
    if (!def || !cites || cites.length === 0) continue;

    const target = `fn-${ns}-${hit.n}`;
    const back = `fnref-${ns}-${hit.n}`;
    out.push(fragment.slice(cursor, hit.start));
    if (hit === def) {
      out.push(`<a class="fndef" id="${target}" href="#${back}">[${hit.n}]</a>`);
    } else {
      const first = cites[0] === hit ? ` id="${back}"` : "";
      out.push(`<a class="fnref"${first} href="#${target}">[${hit.n}]</a>`);
    }
    cursor = hit.end;
  }
  out.push(fragment.slice(cursor));
  return out.join("");
}

/**
 * The whole of a comment's body: sanitised, quoted paragraphs marked, footnotes
 * wired up. Shared so the book and the website say exactly the same thing.
 *
 * `markQuotes` runs first: it keys on a paragraph's opening characters, and
 * inserting an anchor there would hide the `>` marker from it.
 */
export function commentBodyHtml(comment: CommentRow): string {
  return linkFootnotes(markQuotes(toXhtmlFragment(comment.text_html)), comment.id);
}

/**
 * The author's name, linked to the comment on Hacker News.
 *
 * The id in a comment header is the one piece of a comment that is also a
 * durable address: it is where you go to reply, to see the votes, or to read
 * the replies that were flagged after the edition was built. Shared with the
 * website so the book and the page agree on where a name points.
 */
export function authorLink(
  commentId: number,
  author: string | null,
  isOp: boolean,
  rel?: string,
): string {
  const who = xmlEscape(author ?? "anonymous");
  const href = xmlEscape(`${HN_ITEM}${commentId}`);
  const cls = isOp ? "who op" : "who";
  return `<a class="${cls}" href="${href}"${rel ? ` rel="${xmlEscape(rel)}"` : ""}>${who}</a>`;
}

/** TOC label for a root thread: the root author plus an opening snippet. */
export function threadTitle(thread: CommentRow[], index: number): string {
  const label = threadLabel(index);
  const root = thread[0];
  if (!root) return `Thread ${label}`;
  const who = root.author ?? "anonymous";
  const text = snippet(root.text_html, 52);
  return `${label} \u00b7 ${text ? `${who}: ${text}` : who}`;
}

/**
 * One root thread as a fragment.
 *
 * Separate from `renderThread` because the digest puts every thread of a story
 * into one document, and a digest that reimplemented the comment markup would
 * drift from the per-story book within a release.
 */
export function threadSection(
  story: StoryRow,
  thread: CommentRow[],
  index: number,
  opts: RenderOptions = {},
): string {
  const indentMax = opts.indentMaxDepth ?? 5;
  const maxDepth = opts.maxDepth ?? Infinity;

  const visible = thread.filter((c) => c.depth <= maxDepth);
  const omitted = thread.length - visible.length;

  const parts: string[] = [];
  parts.push(
    `<p class="thread-head">Thread ${threadLabel(index)} \u00b7 ${visible.length} comment${
      visible.length === 1 ? "" : "s"
    }</p>`,
  );

  for (const c of visible) {
    const isOp = story.author != null && c.author === story.author;
    // Depth leads the line and is bold: with a tight indent step it is the
    // marker you actually read to place a comment in the tree. Roots carry no
    // marker -- they are the thread, so "L0" would be noise on every chapter.
    const bits: string[] = [];
    if (c.depth > 0) bits.push(`<strong class="lvl">L${c.depth}</strong>`);
    bits.push(authorLink(c.id, c.author, isOp));
    const age = relativeAge(c.created_at_i, story.created_at_i);
    if (age) bits.push(xmlEscape(age));

    parts.push(
      `<div class="${depthClass(c.depth, indentMax)}" id="c${c.id}">\n` +
        `<p class="chead">${bits.join(" \u00b7 ")}</p>\n` +
        `<div class="cbody">${commentBodyHtml(c)}</div>\n` +
        `</div>`,
    );
  }

  if (omitted > 0) {
    parts.push(
      `<p class="chead">${omitted} deeper repl${omitted === 1 ? "y" : "ies"} omitted \u00b7 ` +
        `<a href="${xmlEscape(HN_ITEM + (thread[0]?.id ?? story.id))}">read on Hacker News</a></p>`,
    );
  }

  return parts.join("\n");
}

/** One root thread as a standalone chapter. */
export function renderThread(
  story: StoryRow,
  thread: CommentRow[],
  index: number,
  opts: RenderOptions = {},
): string {
  const body = `<section epub:type="bodymatter">\n${threadSection(story, thread, index, opts)}\n</section>`;
  return xhtmlDocument(threadTitle(thread, index), body, { cssHref: EPUB_CSS_HREF });
}

/* ------------------------------------------------------------------ */
/* the edition digest                                                  */
/* ------------------------------------------------------------------ */

/**
 * Per-story header for the digest.
 *
 * The digest has no title page per story - thirty of them would be thirty
 * pages of chrome - so the facts a reader needs to place an article (where it
 * ranked, what it scored, where it came from, how to get back to the
 * discussion) are folded into a strip above the article itself.
 */
function digestStoryHeader(story: StoryRow): string {
  const facts = [
    `No. ${story.rank}`,
    `${story.points} points`,
    `${story.num_comments} comments`,
    story.domain ?? "news.ycombinator.com",
  ];

  const links = [`<a href="${xmlEscape(HN_ITEM + story.id)}">Discussion</a>`];
  if (story.url) links.unshift(`<a href="${xmlEscape(story.url)}">Original</a>`);

  return (
    `<section class="storyhead">\n` +
    `<p class="meta">${xmlEscape(facts.join(" \u00b7 "))}</p>\n` +
    `<p class="meta">${links.join(" \u00b7 ")}</p>\n` +
    `</section>`
  );
}

/** A story's article chapter inside the digest: the header, then the article. */
export function renderDigestArticle(story: StoryRow, article: ArticleRecord | null): string {
  const parts = articleParts(story, article);
  return xhtmlDocument(`${story.rank}. ${parts.title}`, `${digestStoryHeader(story)}\n${parts.body}`, {
    cssHref: EPUB_CSS_HREF,
    lang: parts.lang,
  });
}

/**
 * Every thread of one story in a single chapter.
 *
 * The per-story book gives each root thread its own chapter, which is right
 * when the book *is* the discussion. A digest cannot: thirty stories at twenty
 * threads each would be six hundred files in the manifest and six hundred rows
 * in the table of contents, which is unusable on a device that redraws the
 * whole panel to scroll.
 *
 * `total` is the thread count before capping, so the chapter can say what it
 * left out instead of quietly ending.
 */
export function renderStoryComments(
  story: StoryRow,
  threads: CommentRow[][],
  opts: RenderOptions & { total?: number } = {},
): string {
  const total = opts.total ?? threads.length;
  const omitted = Math.max(0, total - threads.length);

  const parts: string[] = [`<h2>Comments</h2>`];
  if (threads.length === 0) {
    parts.push(
      `<div class="stub"><p>No comments were available when this edition was built.</p></div>`,
    );
  }
  for (const [i, thread] of threads.entries()) {
    parts.push(threadSection(story, thread, i, opts));
  }
  if (omitted > 0) {
    parts.push(
      `<p class="chead">${omitted} further thread${omitted === 1 ? "" : "s"} omitted \u00b7 ` +
        `<a href="${xmlEscape(HN_ITEM + story.id)}">read on Hacker News</a></p>`,
    );
  }

  const body = `<section epub:type="bodymatter">\n${parts.join("\n")}\n</section>`;
  return xhtmlDocument(`Comments \u00b7 ${story.title}`, body, { cssHref: EPUB_CSS_HREF });
}

export interface DigestEntry {
  href: string;
  rank: number;
  title: string;
  facts: string;
}

/**
 * The digest's contents chapter.
 *
 * Duplicating the navigation document on purpose: the nav doc is a reader
 * feature and several e-readers bury it two menus deep, while a first page you
 * can page into is how someone actually skims thirty stories to pick one.
 */
export function renderDigestContents(date: string, entries: DigestEntry[]): string {
  const items = entries
    .map(
      (e) =>
        `<li class="toc-item"><a href="${xmlEscape(e.href)}">` +
        `<strong class="lvl">${e.rank}</strong> ${xmlEscape(e.title)}</a>` +
        `<br /><span class="meta">${xmlEscape(e.facts)}</span></li>`,
    )
    .join("\n");

  const body =
    `<section class="frontmatter" epub:type="titlepage">\n` +
    `<h1 class="title">Hacker News</h1>\n` +
    `<p class="meta">${xmlEscape(date)}</p>\n` +
    `<p class="meta">${entries.length} ${entries.length === 1 ? "story" : "stories"}, with comments</p>\n` +
    `</section>\n` +
    `<section epub:type="toc">\n<h2>Contents</h2>\n<ol class="toc">\n${items}\n</ol>\n</section>`;

  return xhtmlDocument(`Hacker News \u2014 ${date}`, body, { cssHref: EPUB_CSS_HREF });
}

/** Placeholder chapter used when a story has no renderable comments. */
export function renderNoComments(story: StoryRow): string {
  const hn = `${HN_ITEM}${story.id}`;
  const body =
    `<section epub:type="bodymatter">\n<h2>Comments</h2>\n` +
    `<div class="stub"><p>No comments were available when this edition was built.</p>\n` +
    `<p><a href="${xmlEscape(hn)}">View the discussion on Hacker News</a></p></div>\n</section>`;
  return xhtmlDocument("Comments", body, { cssHref: EPUB_CSS_HREF });
}
