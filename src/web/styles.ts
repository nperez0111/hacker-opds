/**
 * Stylesheet for the website.
 *
 * Inlined as a TS module for the same reason the EPUB stylesheet is (see
 * src/epub/styles.ts): it bundles without a serverAssets round-trip and can be
 * asserted on in tests without standing up a server.
 *
 * The design target is not a phone. It is a six-inch greyscale panel with a
 * refresh measured in hundreds of milliseconds, a browser several years behind,
 * and a touch digitiser that resolves roughly a fingertip. Everything below
 * follows from that:
 *
 *  - No transitions, animations, shadows or gradients. On e-ink a transition is
 *    a sequence of full-panel flashes, and a gradient is dithered noise.
 *  - No position: fixed. A permanently pinned bar forces a repaint of the whole
 *    panel on every scroll step, which is the single most expensive thing you
 *    can do. There is one deliberate exception, documented where it happens:
 *    comment headers are position: sticky so the collapse toggle for the
 *    comment you are inside stays reachable. It costs a repaint only while a
 *    header is actually pinned, and a browser without sticky lays it out
 *    statically, which loses nothing but the convenience.
 *  - Hairlines are avoided. A 1px rule at greyscale renders as an intermittent
 *    dotted line, so rules are 2px or heavier and structure is carried by
 *    weight and spacing rather than by colour.
 *  - Targets are at least 48px tall with generous separation, because a missed
 *    tap on e-ink costs a page flash and a scroll position.
 *  - Colours are near-pure black on near-pure white. Mid greys that look subtle
 *    on an LCD disappear entirely into the dither pattern.
 */

import { SETTINGS_CSS } from "~/web/settings";
import { TYPE_CSS } from "~/web/type";

export const SITE_CSS = `@charset "utf-8";

/* ------------------------------------------------------------------ */
/* theme                                                               */
/* ------------------------------------------------------------------ */

/*
 * Two independent mechanisms, in priority order:
 *
 *  1. data-theme on the root element, set server-side from a cookie. This is
 *     the one that works everywhere, including readers whose browsers predate
 *     prefers-color-scheme entirely.
 *  2. prefers-color-scheme, used only when data-theme is "auto".
 *
 * Custom properties are declared on :root so both paths write to the same
 * variables and the rest of the sheet never branches on theme again.
 */

:root {
  color-scheme: light dark;

  --bg: #ffffff;
  --fg: #000000;
  --fg-soft: #3a3a3a;
  --rule: #000000;
  --rule-soft: #b8b8b8;
  --accent-bg: #000000;
  --accent-fg: #ffffff;
  --quote-rule: #7a7a7a;

  /*
   * Two different constraints, deliberately separated.
   *
   * --measure is a legibility limit: the longest line of prose that still
   * scans comfortably. It does not grow, because a wider screen does not make
   * a 120-character line easier to read.
   *
   * --wrap is the page container, and it is only limited by the device. On an
   * e-reader the two are the same, because the panel is about that wide
   * anyway. On a desktop the container opens up so that lists, headers and
   * nested comment threads use the room; prose stays capped at --measure.
   */
  --measure: 34rem;
  --wrap: var(--measure);
  --tap: 48px;

  /*
   * Height of one comment header, and the step by which nested headers stack
   * when they pin.
   *
   * This has to be an exact number rather than a min-height, because each
   * depth pins at a multiple of it and any drift compounds down the tree. The
   * header is forced onto one line to keep the promise (see .chead).
   */
  --chead-h: 1.75rem;
}

:root[data-theme="dark"] {
  color-scheme: dark;

  --bg: #000000;
  --fg: #ffffff;
  --fg-soft: #c8c8c8;
  --rule: #ffffff;
  --rule-soft: #5a5a5a;
  --accent-bg: #ffffff;
  --accent-fg: #000000;
  --quote-rule: #8a8a8a;
}

@media (prefers-color-scheme: dark) {
  :root[data-theme="auto"] {
    color-scheme: dark;

    --bg: #000000;
    --fg: #ffffff;
    --fg-soft: #c8c8c8;
    --rule: #ffffff;
    --rule-soft: #5a5a5a;
    --accent-bg: #ffffff;
    --accent-fg: #000000;
    --quote-rule: #8a8a8a;
  }
}

/* ------------------------------------------------------------------ */
/* base                                                                */
/* ------------------------------------------------------------------ */

*,
*::before,
*::after {
  box-sizing: border-box;
}

html {
  /*
   * 20px rather than the usual 16. E-ink panels are typically around 212 ppi
   * with no subpixel rendering, so small type loses its stem contrast and turns
   * grey. This is the smallest size that still reads as black.
   */
  font-size: 20px;
  background: var(--bg);
  -webkit-text-size-adjust: 100%;
}

body {
  margin: 0;
  padding: 0 1rem 4rem;
  background: var(--bg);
  color: var(--fg);
  font-family: Charter, Georgia, "Liberation Serif", "Times New Roman", serif;
  line-height: 1.55;
  /*
   * Justified text needs hyphenation to avoid rivers, and e-reader browsers
   * are inconsistent about supporting it. Ragged right is the safe default and
   * costs nothing in legibility.
   */
  text-align: left;
}
${TYPE_CSS}
.wrap {
  max-width: var(--wrap);
  margin: 0 auto;
}

/*
 * Breakpoints are in px, not rem, on purpose. Inside a media query rem is
 * resolved against the browser's initial font size, not the 20px set on
 * html, so a rem breakpoint here would not mean what the rest of the sheet
 * means by rem.
 *
 * That also insulates the layout from the reader's text size. The root font
 * size is a setting now, and a rem breakpoint would move with it - a reader
 * who chose larger type would silently cross into the desktop layout on a
 * panel that had not changed width.
 *
 * 900px clears every e-ink panel this is aimed at: the largest of them are
 * around 825 CSS px wide in portrait once device pixel ratio is applied. So a
 * reader never sees these rules, and nothing about the e-reader layout moves.
 */
@media (min-width: 900px) {
  :root {
    --wrap: 46rem;
  }

  body {
    padding: 0 2rem 4rem;
  }
}

@media (min-width: 1200px) {
  :root {
    --wrap: 54rem;
  }
}

/* Skip target for keyboard and screen-reader users. */
.skip {
  position: absolute;
  left: -9999px;
  top: 0;
}

.skip:focus {
  position: static;
  display: block;
  padding: 0.75rem;
  font-weight: 700;
}

a {
  color: inherit;
  text-decoration: underline;
  /*
   * Thick, offset underlines. The default hairline underline is the first
   * thing to vanish into the dither on a greyscale panel, and it collides with
   * descenders at this size.
   */
  text-decoration-thickness: 2px;
  text-underline-offset: 3px;
}

a:focus-visible,
button:focus-visible,
summary:focus-visible {
  outline: 3px solid var(--fg);
  outline-offset: 2px;
}

img {
  max-width: 100%;
  height: auto;
  /* Reserve the line box so reflow does not jump once images decode. */
  display: block;
  margin: 1.5rem auto;
}

figure {
  margin: 1.5rem 0;
}

figcaption {
  font-size: 0.8rem;
  color: var(--fg-soft);
  text-align: center;
}

hr {
  border: 0;
  border-top: 2px solid var(--rule-soft);
  margin: 2rem 0;
}

code,
pre,
kbd {
  font-family: "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 0.85em;
}

pre {
  overflow-x: auto;
  padding: 0.75rem;
  border: 2px solid var(--rule-soft);
  /* Long code lines must not widen the page and break the scroll axis. */
  max-width: 100%;
}

blockquote {
  margin: 1.5rem 0;
  padding-left: 1rem;
  border-left: 4px solid var(--quote-rule);
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}

th,
td {
  border: 2px solid var(--rule-soft);
  padding: 0.4rem;
  text-align: left;
}

/* ------------------------------------------------------------------ */
/* masthead and footer                                                 */
/* ------------------------------------------------------------------ */

.masthead {
  border-bottom: 4px solid var(--rule);
  padding: 1.25rem 0 0.75rem;
  margin-bottom: 1.5rem;
}

.masthead-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}

.wordmark {
  font-family: inherit;
  font-size: 1.5rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin: 0;
  text-decoration: none;
}

.wordmark a {
  text-decoration: none;
}

.masthead nav {
  display: flex;
  flex-wrap: wrap;
  gap: 0 1.25rem;
}

.masthead nav a {
  display: inline-flex;
  align-items: center;
  min-height: var(--tap);
  font-size: 0.9rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.masthead nav a[aria-current] {
  text-decoration-thickness: 4px;
}

.site-foot {
  border-top: 4px solid var(--rule);
  margin-top: 3rem;
  padding-top: 1rem;
  font-size: 0.8rem;
  color: var(--fg-soft);
}

.site-foot ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0 1.25rem;
}

.site-foot a {
  display: inline-flex;
  align-items: center;
  min-height: var(--tap);
}

/* ------------------------------------------------------------------ */
/* page furniture                                                      */
/* ------------------------------------------------------------------ */

.page-title {
  font-size: 1.6rem;
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: -0.02em;
  margin: 0 0 0.25rem;
}

.page-sub {
  margin: 0 0 1.5rem;
  font-size: 0.9rem;
  color: var(--fg-soft);
}

.meta {
  font-size: 0.85rem;
  color: var(--fg-soft);
}

.empty {
  border: 4px solid var(--rule-soft);
  padding: 1.5rem;
  text-align: center;
}

/* ------------------------------------------------------------------ */
/* story list                                                          */
/* ------------------------------------------------------------------ */

.stories {
  list-style: none;
  margin: 0;
  padding: 0;
}

.stories > li {
  border-bottom: 2px solid var(--rule-soft);
}

.stories > li:first-child {
  border-top: 2px solid var(--rule-soft);
}

/*
 * The whole row is the link. Two adjacent tap targets in a list this dense is
 * how you get a mis-tap, and a mis-tap on e-ink is a full page flash plus a
 * lost scroll position. Secondary destinations live on the story page.
 */
.story-link {
  display: flex;
  gap: 0.85rem;
  align-items: baseline;
  padding: 1rem 0;
  min-height: var(--tap);
  text-decoration: none;
}

.rank {
  flex: 0 0 auto;
  min-width: 1.8rem;
  font-size: 0.95rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--fg-soft);
}

.story-body {
  flex: 1 1 auto;
  min-width: 0;
}

/*
 * Title and meta are spans so the whole row can stay a single anchor, which
 * means they need blockifying by hand - left inline they run together into
 * "Claude: System Promptsplatform.claude.com" and the margin below is
 * dropped.
 */
.story-title,
.story-meta {
  display: block;
}

.story-title {
  font-size: 1.05rem;
  font-weight: 700;
  line-height: 1.3;
  /* The row is not underlined, but the title must still read as a link. */
  text-decoration: underline;
  text-decoration-thickness: 2px;
  text-underline-offset: 3px;
}

.story-meta {
  margin-top: 0.3rem;
  font-size: 0.8rem;
  color: var(--fg-soft);
}

.story-meta .dot::before {
  content: " \\00b7 ";
}

/*
 * The matched passage under a search result.
 *
 * Not underlined and not bold, because the whole row is already a link and the
 * title above it carries the underline: a second underlined block in the same
 * target would read as a second destination. Two lines maximum is a deliberate
 * ceiling rather than a consequence of the snippet width - a result list is
 * scanned, and a five-line quotation per row turns twenty-five results into
 * eight screens of page turns.
 */
.story-snippet {
  /*
   * Two display declarations, in this order, on purpose. The snippet is inside
   * an anchor, so it has to be blockified either way; a browser that does not
   * know -webkit-box discards that line and keeps block, showing the snippet in
   * full, and one that does clamps it. Neither outcome is a broken layout.
   */
  display: block;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin-top: 0.35rem;
  font-size: 0.85rem;
  line-height: 1.45;
  color: var(--fg-soft);
}

/* ------------------------------------------------------------------ */
/* search                                                              */
/* ------------------------------------------------------------------ */

/*
 * One column, always.
 *
 * A label above a field above a button is the layout that cannot go wrong: no
 * horizontal space to run out of, no shrinking input, and the submit button is
 * a full-width target rather than a 60px square next to a text field. On a
 * panel this narrow a side-by-side field and button would put both below the
 * comfortable tap size at exactly the moment the on-screen keyboard has taken
 * half the screen.
 */
.search-form {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  margin: 0 0 1.5rem;
  padding-bottom: 1.5rem;
  border-bottom: 4px solid var(--rule);
}

.search-label {
  font-size: 0.85rem;
  font-weight: 700;
  color: var(--fg-soft);
}

/*
 * A 3px border to match the buttons, and inherited type at full size. The
 * browser default for a text field is a hairline box at 13px, which on
 * greyscale is an invisible outline around illegible text.
 *
 * font-size must stay at or above 1rem: several reader browsers zoom the whole
 * page when a focused field is smaller than their own minimum, and the zoom is
 * not undone on blur.
 */
.search-input {
  width: 100%;
  min-height: var(--tap);
  padding: 0.6rem 0.7rem;
  border: 3px solid var(--fg);
  background: var(--bg);
  color: var(--fg);
  font: inherit;
  font-size: 1rem;
  /* Safari and the WebKit builds on most readers otherwise round the corners
   * and paint an inner shadow that dithers into a grey smear. */
  border-radius: 0;
  -webkit-appearance: none;
  appearance: none;
}

.search-form .btn {
  align-self: flex-start;
}

@media (min-width: 900px) {
  /* Room for the field and its button side by side, with the label above
   * both. The input keeps growing; the button keeps its content width. */
  .search-form {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
  }

  .search-label {
    grid-column: 1 / -1;
  }

  /* Undo the flex-column alignment: in the grid the button shares a row with
   * the field and should sit on its centreline, not at the top of it. */
  .search-form .btn {
    align-self: center;
  }
}

/* ------------------------------------------------------------------ */
/* buttons                                                             */
/* ------------------------------------------------------------------ */

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin: 1.5rem 0;
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: var(--tap);
  padding: 0.6rem 1.1rem;
  border: 3px solid var(--fg);
  background: var(--bg);
  color: var(--fg);
  font: inherit;
  font-size: 0.9rem;
  font-weight: 700;
  text-decoration: none;
  cursor: pointer;
}

.btn-primary {
  background: var(--accent-bg);
  color: var(--accent-fg);
  border-color: var(--accent-bg);
}

.btn[aria-disabled="true"] {
  border-color: var(--rule-soft);
  color: var(--fg-soft);
}

/* ------------------------------------------------------------------ */
/* archive index                                                       */
/* ------------------------------------------------------------------ */

.editions {
  list-style: none;
  margin: 0;
  padding: 0;
}

.editions > li {
  border-bottom: 2px solid var(--rule-soft);
}

.editions > li:first-child {
  border-top: 2px solid var(--rule-soft);
}

.edition-link {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  padding: 1rem 0;
  min-height: var(--tap);
  text-decoration: none;
}

.edition-date {
  font-size: 1.05rem;
  font-weight: 700;
  text-decoration: underline;
  text-decoration-thickness: 2px;
  text-underline-offset: 3px;
}

.edition-count {
  flex: 0 0 auto;
  font-size: 0.8rem;
  color: var(--fg-soft);
  font-variant-numeric: tabular-nums;
}

/* ------------------------------------------------------------------ */
/* story page                                                          */
/* ------------------------------------------------------------------ */

.story-head {
  border-bottom: 4px solid var(--rule);
  padding-bottom: 1.25rem;
  margin-bottom: 1.5rem;
}

.story-head h1 {
  font-size: 1.6rem;
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: -0.02em;
  margin: 0 0 0.5rem;
}

/*
 * The article is the one place the wider container is not an improvement, so
 * it keeps the prose measure and centres inside whatever room it is given.
 * Everything around it - the story header, the comment threads - still spans
 * the full container.
 */
.article {
  font-size: 1rem;
  max-width: var(--measure);
  margin-inline: auto;
}

.article h2,
.article h3,
.article h4 {
  line-height: 1.25;
  margin: 2rem 0 0.75rem;
  font-weight: 700;
}

.article h2 {
  font-size: 1.3rem;
}

.article h3 {
  font-size: 1.1rem;
}

.article h4 {
  font-size: 1rem;
}

.article p {
  margin: 0 0 1.1rem;
}

.article li {
  margin-bottom: 0.5rem;
}

.stub {
  border: 4px solid var(--rule-soft);
  padding: 1.25rem;
}

.stub .reason {
  margin-top: 0;
  font-weight: 700;
}

/* ------------------------------------------------------------------ */
/* comments                                                            */
/* ------------------------------------------------------------------ */

.comments {
  border-top: 4px solid var(--rule);
  margin-top: 2.5rem;
  padding-top: 1rem;
}

.comments h2 {
  font-size: 1.3rem;
  margin: 0 0 1rem;
}

/*
 * Threads are separated by a rule and carry no heading.
 *
 * Only between threads, not above the first: the .comments border and the
 * Comments heading already close the article off, and a second rule 1rem below
 * the first reads as a mistake.
 */
.thread + .thread {
  border-top: 4px solid var(--rule);
  padding-top: 1.25rem;
  margin-top: 1.75rem;
}

/* ------------------------------------------------------------------ */
/* comment tree                                                        */
/* ------------------------------------------------------------------ */

/*
 * Each comment is a details element: summary is the header, and the body plus
 * the replies are what collapsing hides.
 *
 * Nothing below hides .cbody, and no rule uses details[open] to reveal
 * content, only to change chrome. That is load-bearing. A browser that does
 * not implement details renders the unknown elements inline and shows all
 * their children, so the discussion is complete and only the toggle is
 * missing. Hiding the body by default and revealing it with [open] would look
 * identical on a modern browser and blank the entire discussion on the old
 * WebKit builds this site is written for.
 */
/*
 * Both of these are the browser's own defaults where details is implemented,
 * and are stated only for browsers where it is not: an unknown element is laid
 * out inline, which would run a comment header into the first line of its body.
 * display: list-item on the summary rather than block, because that is what
 * carries the disclosure marker; block would delete the triangle on the
 * browsers that do work.
 */
details {
  display: block;
}

summary {
  display: list-item;
}

.comment {
  margin: 0 0 0.9rem;
}

/*
 * Indentation comes from the nesting, not from the d-classes.
 *
 * The markup is a real tree here (the book keeps a flat list, and its own
 * stylesheet still indents by class), so one padding step on the reply
 * container produces the whole staircase. The step is small: a 6-inch panel is
 * about 34 characters wide at this type size, so a per-level indent of any real
 * width would leave deep replies as a column two words across.
 *
 * There is no rule down the left edge. There was, and it was carrying the
 * subtree boundary while the indent only hinted at it - but a 2px grey hairline
 * is the exact thing the top of this file says not to draw, and stacked five
 * deep it read as a smear of dither rather than five distinct lines. The indent
 * plus the pinned ancestor headers already say where you are, and the header
 * stack says it far more precisely than a line ever did: it names the parents
 * rather than merely implying them.
 */
.kids {
  padding-left: 0.75rem;
}

/*
 * The indent cap, expressed structurally.
 *
 * depthClass stamps dx on every comment past the cap, so pulling dx back by
 * exactly one step cancels the padding of the container it sits in, at every
 * level. The effect is that the staircase stops dead at the cap however deep
 * the thread goes, which is the same clamp the class-driven indent gave.
 */
.dx {
  margin-left: -0.75rem;
}

/*
 * Sticky headers, and the one place this sheet accepts a scroll-time repaint.
 *
 * Scrolled into a long subtree, the toggle that would collapse the comment you
 * are reading is far above the fold; without this you have to scroll back to
 * find it, which on e-ink is several full page flashes.
 *
 * Every level pins, and they stack rather than overlap: a comment at depth n
 * pins n steps down, directly under its parent. So the ancestry of whatever you
 * are reading stays on screen as a column of headers, and any of them can be
 * collapsed from where you are. That is also the depth indicator - the reason
 * the header does not print an "L3" the way the book has to.
 *
 * The offsets are multiples of --chead-h and the header is exactly that tall,
 * so the stack is flush. Shallower headers paint over deeper ones, which only
 * matters in the moment a child slides under its parent.
 *
 * The background must be opaque in both themes - a transparent pinned header
 * with body text scrolling through it is unreadable - and var(--bg) is the
 * themed page colour, so it is correct in light and dark from one rule.
 *
 * Browsers without position: sticky lay the header out statically. Nothing is
 * lost but the convenience.
 */
.comment > .chead {
  position: sticky;
  top: 0;
  z-index: 6;
  background: var(--bg);
  border-bottom: 2px solid var(--rule-soft);
  cursor: pointer;
}

/*
 * Same specificity as the rule above, so these must stay after it.
 *
 * dx repeats d5's offset instead of continuing the sequence, matching the
 * indent clamp: past the cap the tree stops stepping right, so the pinned
 * column stops stepping down. Six rows is already about a fifth of a 6-inch
 * panel, and an uncapped stack on a deep subthread would leave no page left to
 * read.
 */
.d1 > .chead { top: var(--chead-h);            z-index: 5; }
.d2 > .chead { top: calc(var(--chead-h) * 2);  z-index: 4; }
.d3 > .chead { top: calc(var(--chead-h) * 3);  z-index: 3; }
.d4 > .chead { top: calc(var(--chead-h) * 4);  z-index: 2; }
.d5 > .chead { top: calc(var(--chead-h) * 5);  z-index: 1; }
.dx > .chead { top: calc(var(--chead-h) * 5);  z-index: 1; }

/* Chrome only: a collapsed comment states louder that something is behind it.
 * Removing this rule changes nothing about what is on screen. */
.comment:not([open]) > .chead {
  color: var(--fg);
  font-weight: 700;
}

/*
 * Exactly --chead-h tall and exactly one line, because the stacked sticky
 * offsets above are multiples of it: a header that wrapped to two lines would
 * be overlapped by its own children.
 *
 * nowrap plus ellipsis is the guard that keeps that true. It should never
 * actually fire - the header is a username, an age and a reply count, perhaps
 * 30 characters against 70-odd available even at the deepest indent - but if a
 * username ever does run long, one clipped header is a far smaller failure
 * than a tree whose pinned column no longer lines up.
 *
 * list-style-position: inside because the overflow clip would otherwise cut
 * off the disclosure triangle, which sits outside the box by default and is
 * the only affordance saying this row can be tapped.
 *
 * This is well under the 48px tap target the rest of the sheet holds to. It is
 * a deliberate trade: the row is full-bleed so it is still an easy target
 * horizontally, and paying 48px per header would mean six pinned ancestors
 * eating 288px - over a third of a 6-inch panel - which defeats the point of
 * pinning them.
 */
.chead {
  box-sizing: border-box;
  height: var(--chead-h);
  margin: 0;
  padding: 0.28rem 0;
  font-size: 0.78rem;
  line-height: 1.25;
  color: var(--fg-soft);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  list-style-position: inside;
}

.chead .op {
  font-weight: 700;
  color: var(--fg);
}

/*
 * The author name is plain text, and gets no rule of its own.
 *
 * It used to be a link to the comment on HN, padded so it could be hit without
 * catching the toggle. Both of those are now exactly backwards: the name is a
 * span, the whole header collapses the comment, and the padding was carving a
 * dead strip out of the widest target in the row. Deleting the rule is the
 * change - the name inherits the header's colour, and .op below still marks the
 * submitter.
 */

/* How much is behind a collapsed toggle. Full strength, because it is the one
 * part of the header that matters once the body is hidden. */
.kidcount {
  font-weight: 700;
  color: var(--fg);
}

.cbody {
  font-size: 0.95rem;
  padding-top: 0.4rem;
}

.cbody p {
  margin: 0 0 0.7rem;
}

.cbody p:last-child {
  margin-bottom: 0;
}

.cbody .quote {
  padding-left: 0.75rem;
  border-left: 4px solid var(--quote-rule);
  color: var(--fg-soft);
  font-style: italic;
}

/*
 * Pasted code in a comment wraps rather than scrolling. The measure here is
 * about 34 characters and most e-reader browsers cannot scroll a nested
 * element horizontally at all, so a non-wrapping block is simply a block with
 * its right half missing. overflow-x stays as a backstop for a single
 * unbreakable token.
 */
.cbody pre {
  white-space: pre-wrap;
  overflow-wrap: break-word;
  padding: 0.5rem;
}

/* HN linkifies bare URLs, which are routinely wider than the measure. */
.cbody a {
  overflow-wrap: break-word;
}

/*
 * HN footnotes: [1] in the text, and the line lower down that defines it.
 * Both ends are links, so the marker has to read as one without breaking
 * across a line.
 */
.fnref,
.fndef {
  font-weight: 700;
  white-space: nowrap;
}

/* Where the jump landed. Cheap on e-ink: an outline is one rectangle, not a
 * repaint of a block of inverted text. */
.fnref:target,
.fndef:target {
  outline: 3px solid var(--fg);
  outline-offset: 2px;
}

/* In-page jumps between the article and the discussion. Sized as a button
 * like any other control; the digits are tabular so the count does not shift
 * the label width between stories. */
.jump {
  font-variant-numeric: tabular-nums;
}

/* ------------------------------------------------------------------ */
/* thread jump                                                         */
/* ------------------------------------------------------------------ */

/*
 * A floating control that walks the reader through the discussion, one
 * top-level thread per tap, in either direction.
 *
 * This is the only position: fixed in the stylesheet, and the rest of this file
 * spends a paragraph at the top explaining why there are none. The ban is real
 * and it is not repealed here - it is scoped. A pinned layer forces a repaint
 * of the region under it on every scroll step, which on a panel with a
 * hundreds-of-milliseconds refresh is the most expensive thing the page can do.
 * On any other display it is free. The control is shown on the slow panels
 * anyway, at the reader's request: the walk it offers is exactly what a long
 * discussion wants on an e-ink reader, where the scrollbar is weakest, and the
 * repaint cost is paid a step at a time, on content the reader has chosen to
 * look at. The cost is accepted, not hidden.
 *
 * The gate is the script, not the panel. [data-thread-jump-ready] is set only
 * once something is able to act on a tap, so a browser that cannot run the
 * page script sees no pinned layer no matter how fast its display is. No
 * media query rations the rest, because none can name the device being asked
 * about: an e-ink reader running a mainstream Android browser reports
 * update: fast because the browser does not know what panel it is attached
 * to, so a query on update would have shown it the control whether it could
 * afford one or not - and withheld it from exactly the reader who asked for
 * it. Everything else - screen width, pixel ratio, monochrome - is a proxy
 * that guesses.
 *
 * With no stylesheet at all the button is a plain, statically positioned button
 * at the foot of the discussion - the base rule is the hiding one, so losing
 * the sheet loses the hiding, not the control.
 */
[data-thread-jump] {
  display: none;
}

/*
 * Gated on the root attribute the page script sets, so the button only
 * appears once something is able to act on a tap. The markup also ships
 * the hidden attribute; both halves are needed, because [hidden] is not
 * reliably in the UA stylesheet on this hardware - the same belt-and-braces
 * the saved marker uses.
 */
html[data-thread-jump-ready] [data-thread-jump] {
  display: flex;
  /*
   * Back on the left, on the right, in source order. Half a tap between them
   * so a thumb aiming for one does not carry into the other - the two do
   * opposite things, and this is the one place on the page where a mis-tap
   * undoes the tap before it.
   */
  gap: 0.5rem;
  position: fixed;
  right: 0.9rem;
  /*
   * Clear of the browser's own bottom chrome, which on iOS Safari is an
   * overlay that appears on scroll-up and would otherwise sit on top of this.
   */
  bottom: 1.5rem;
  /*
   * Above the pinned header stack, which tops out at 6. A thread boundary is
   * exactly where a pinned ancestor is sliding out, so these do overlap.
   */
  z-index: 7;
}

/*
 * The circles themselves, outside the reveal rule on purpose: they only ever
 * paint inside a box that rule has to switch on first, so gating them again
 * would state the same condition twice and let the two copies disagree.
 */
.thread-jump-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--tap);
  height: var(--tap);
  padding: 0;
  border: 3px solid var(--bg);
  /*
   * The one curve in the stylesheet. Everything else is square because a
   * dithered arc on a greyscale panel is a ragged edge, and the panels this
   * sheet is built for are greyscale.
   */
  border-radius: 50%;
  background: var(--accent-bg);
  color: var(--accent-fg);
  cursor: pointer;
}

/*
 * The arrow. Sized in em so it tracks the button rather than the root font
 * size, which the reader can change.
 */
.thread-jump-icon {
  width: 1.4em;
  height: 1.4em;
  /*
   * So a tap reports the button, not the glyph. The script can walk up from an
   * SVG child and does, but only on a browser whose SVG elements carry closest;
   * this makes that walk a fallback rather than the mechanism.
   */
  pointer-events: none;
}

/* ------------------------------------------------------------------ */
/* offline affordance                                                  */
/* ------------------------------------------------------------------ */

/*
 * Hidden until the service worker registers. Without it the button cannot do
 * anything, and an inert control is worse than no control.
 */
[data-offline-ui] {
  display: none;
}

html[data-sw="ready"] [data-offline-ui] {
  display: inline-flex;
}

/*
 * The note under the button is prose, not a control, so it takes the block
 * back off the inline-flex above. Same attribute because it has the same
 * condition attached: it explains a button that is not there without a worker.
 */
html[data-sw="ready"] p.offline-note[data-offline-ui] {
  display: block;
}

.offline-note {
  font-size: 0.8rem;
  color: var(--fg-soft);
  margin: 0.5rem 0 0;
}

/*
 * The marker for a page that is already on the device.
 *
 * There is no data-sw gate on this one, unlike the save button. The button is
 * hidden until the worker registers because an inert control is worse than no
 * control; a marker is hidden until the page-side script has *looked in the
 * cache and found it*, which is a stronger condition and cannot be true
 * without a worker anyway. So the reveal is the script removing the hidden
 * attribute, and the rule below is the only thing standing between that and a
 * browser whose UA stylesheet does not carry [hidden] - which is a real
 * possibility on this hardware and would otherwise show an arrow next to
 * every story on the site.
 */
[data-saved-mark][hidden] {
  display: none;
}

/*
 * A column of its own at the end of the row, not something appended to the
 * title. Fixed width so the arrows line up down the page and so a row that
 * gains one does not re-wrap its headline; baseline-aligned by the flex
 * container, so the arrow sits on the same line as the first line of title.
 *
 * Bold for the same reason the rules on this site are 2px: at this size on a
 * greyscale panel an arrow at normal weight is three or four grey pixels and
 * reads as dirt on the screen rather than as a mark.
 */
.saved,
.saved-glyph {
  font-weight: 700;
}

.saved {
  flex: 0 0 auto;
  width: 1.2rem;
  text-align: right;
}

/* The spelled-out version in a story page's header. */
.saved-line {
  margin-top: 0.35rem;
}

/* ------------------------------------------------------------------ */
/* print                                                               */
/* ------------------------------------------------------------------ */

@media print {
  .masthead nav,
  .actions,
  .site-foot,
  .settings,
  /* The reveal rule carries no media condition, so this is what keeps the
   * control off paper: a control that only exists to scroll has no business
   * being reachable by a rule this file does not control. */
  html[data-thread-jump-ready] [data-thread-jump] {
    display: none;
  }
}
${SETTINGS_CSS}`;

/** Path the pages link to. The query string carries the content hash. */
export const SITE_CSS_PATH = "/assets/site.css";
