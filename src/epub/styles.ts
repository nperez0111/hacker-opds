/**
 * EPUB stylesheet.
 *
 * Inlined as a TS module rather than a bundled asset: it needs no runtime I/O,
 * survives Rolldown bundling unconditionally, and is testable outside Nitro.
 *
 * Constraints this is written against:
 *  - E-ink is greyscale. Colour carries no information, so everything is
 *    expressed in black/grey/white and still reads correctly on paper-white.
 *  - Readers (KOReader, Kobo, Boox) routinely override font-family, font-size
 *    and line-height. Nothing here should *depend* on those winning, so layout
 *    is driven by margins/borders instead.
 *  - Horizontal space is scarce on a 6" screen. Comment nesting uses a 1px
 *    rule + small padding instead of wide indents (see COMMENT_INDENT_MAX_DEPTH).
 *  - No @font-face, no colour profiles, no media queries: maximum compatibility.
 */

export const EPUB_CSS = `@charset "utf-8";

body {
  margin: 0 5%;
  padding: 0;
  line-height: 1.5;
  text-align: left;
  widows: 2;
  orphans: 2;
}

h1, h2, h3, h4, h5, h6 {
  line-height: 1.25;
  margin: 1.2em 0 0.5em;
  page-break-after: avoid;
  break-after: avoid;
}

h1 { font-size: 1.5em; }
h2 { font-size: 1.3em; }
h3 { font-size: 1.15em; }
h4, h5, h6 { font-size: 1em; }

p {
  margin: 0 0 0.8em;
  text-indent: 0;
}

a {
  color: inherit;
  text-decoration: underline;
}

hr {
  border: 0;
  border-top: 1px solid #888;
  margin: 1.5em 0;
  height: 0;
}

/* ---------- front matter ---------- */

.frontmatter {
  margin: 1em 0 2em;
}

.frontmatter .title {
  font-size: 1.4em;
  font-weight: bold;
  line-height: 1.25;
  margin: 0 0 0.5em;
}

.frontmatter .meta {
  font-size: 0.85em;
  color: #555;
  margin: 0 0 0.3em;
}

.frontmatter .links {
  font-size: 0.85em;
  margin-top: 1em;
  word-wrap: break-word;
  overflow-wrap: break-word;
}

/* ---------- digest ---------- */

/*
 * The digest's contents page. A numbered list with the rank set as the marker
 * would leave the reader guessing whether 12 means position or item count, so
 * the rank is printed explicitly and the list's own numbering is suppressed.
 */

.toc {
  list-style: none;
  margin: 0;
  padding: 0;
}

.toc-item {
  margin: 0 0 0.7em;
  page-break-inside: avoid;
  break-inside: avoid;
}

.toc-item .lvl {
  font-weight: bold;
  /* A fixed inline-block width keeps single and double digit ranks on the same
     left edge without a table. */
  display: inline-block;
  min-width: 1.6em;
}

.toc-item .meta {
  font-size: 0.8em;
  color: #555;
}

/*
 * Per-story header in the digest, where there is no separate title page. A rule
 * underneath is enough to separate it from the article heading that follows.
 */
.storyhead {
  border-bottom: 1px solid #999;
  margin: 0 0 0.6em;
  padding-bottom: 0.3em;
}

.storyhead .meta {
  font-size: 0.8em;
  color: #555;
  margin: 0 0 0.2em;
}

/* ---------- article body ---------- */

blockquote {
  margin: 0.8em 0 0.8em 1em;
  padding-left: 0.8em;
  border-left: 2px solid #999;
  font-style: italic;
}

pre {
  margin: 0.8em 0;
  padding: 0.5em;
  border: 1px solid #ccc;
  font-size: 0.8em;
  line-height: 1.35;
  white-space: pre-wrap;
  word-wrap: break-word;
  overflow-wrap: break-word;
}

code {
  font-family: monospace;
  font-size: 0.9em;
}

pre code {
  font-size: 1em;
}

code.math {
  font-style: italic;
}

img {
  max-width: 100%;
  /* Cap height too: a tall narrow image otherwise fills several screens and
     forces the reader to page through one picture. */
  max-height: 100vh;
  height: auto;
  /* Images arrive greyscale already; centring keeps figures from hugging the
     left margin when they are narrower than the text column. */
  display: block;
  margin: 0.6em auto;
}

figure {
  margin: 1em 0;
  text-align: center;
}

figcaption {
  font-size: 0.8em;
  color: #555;
  margin-top: 0.3em;
}

table {
  border-collapse: collapse;
  font-size: 0.85em;
  margin: 1em 0;
  width: 100%;
}

th, td {
  border: 1px solid #999;
  padding: 0.3em 0.4em;
  text-align: left;
  vertical-align: top;
}

th {
  font-weight: bold;
}

ul, ol {
  margin: 0 0 0.8em;
  padding-left: 1.4em;
}

li {
  margin-bottom: 0.3em;
}

/* ---------- extraction failure stub ---------- */

.stub {
  border: 1px solid #999;
  padding: 0.8em;
  margin: 1em 0;
  font-size: 0.9em;
}

.stub .reason {
  font-weight: bold;
}

/* ---------- comments ---------- */

/*
 * Nesting is shown with a hairline rule rather than whitespace so deep threads
 * do not lose usable line width. Depth beyond .d4 renders flush; the true depth
 * is still printed in the header line, so no information is lost.
 */

.comment {
  margin: 0 0 0.9em;
  page-break-inside: auto;
}

.comment > .chead {
  font-size: 0.75em;
  color: #555;
  margin: 0 0 0.25em;
  line-height: 1.3;
}

/*
 * The depth marker leads the header line and is bold. Once the indent step is
 * small enough to be ambiguous at a glance, the number is what you actually
 * read to place a comment in the tree, so it should be the first thing on the
 * line rather than trailing behind the author and age. Darker than the rest of
 * the header so it separates without needing a larger size.
 */
.comment > .chead .lvl {
  font-weight: bold;
  color: #222;
}

.comment > .cbody p {
  margin: 0 0 0.5em;
}

.comment > .cbody p:last-child {
  margin-bottom: 0;
}

/*
 * HN quotes. Users prefix a line with a > marker and the site renders it as an
 * ordinary paragraph, so quoted text and the reply to it look identical.
 *
 * Grey text plus a heavier left bar separates the two. The bar is 3px where
 * the nesting rules below are 1px, so the two never read as the same thing,
 * and the effect survives on panels that dither a background fill into mush.
 */
.comment > .cbody p.quote {
  color: #555;
  border-left: 3px solid #bbb;
  padding-left: 0.6em;
  margin-left: 0;
}

/*
 * Consecutive quoted paragraphs are one quotation, so tighten the gap between
 * them to read as a single block rather than a stack of separate ones.
 */
.comment > .cbody p.quote + p.quote {
  margin-top: -0.25em;
}

/*
 * Nesting rules. The step is 0.45em rather than 0.6em, which buys a fifth
 * visible level while still ending narrower than the old four did: d5 sits at
 * 2.25em of total left offset where the old d4 sat at 2.4em. On a 6" panel
 * every em of body width matters, and the bar carries the structure anyway --
 * the indent only has to be large enough to tell two adjacent bars apart.
 */
.d1 { border-left: 1px solid #999; padding-left: 0.45em; margin-left: 0; }
.d2 { border-left: 1px solid #999; padding-left: 0.45em; margin-left: 0.45em; }
.d3 { border-left: 1px solid #999; padding-left: 0.45em; margin-left: 0.9em; }
.d4 { border-left: 1px solid #999; padding-left: 0.45em; margin-left: 1.35em; }
.d5 { border-left: 1px solid #999; padding-left: 0.45em; margin-left: 1.8em; }

/* depth > COMMENT_INDENT_MAX_DEPTH: flush, depth shown in the header only */
.dx { border-left: 1px solid #ccc; padding-left: 0.45em; margin-left: 1.8em; }

.thread-head {
  font-size: 0.8em;
  color: #555;
  border-bottom: 1px solid #999;
  padding-bottom: 0.3em;
  margin: 0 0 1em;
}

.op {
  font-weight: bold;
}
`;

/** Href used for the stylesheet inside the EPUB, relative to OEBPS/. */
export const EPUB_CSS_HREF = "style.css";

/** Manifest id for the stylesheet resource. */
export const EPUB_CSS_ID = "css";
