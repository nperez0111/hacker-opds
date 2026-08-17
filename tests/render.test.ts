import { describe, expect, test } from "bun:test";
import { XMLValidator } from "fast-xml-parser";

import {
  authorLink,
  bylineParts,
  commentBodyHtml,
  isoDate,
  linkFootnotes,
  relativeAge,
  renderArticle,
  stripLeadingHeading,
  renderFrontMatter,
  renderNoComments,
  renderThread,
  snippet,
  threadTitle,
  markQuotes,
  threadLabel,
} from "~/epub/render";
import type { StoryRow } from "~/core/edition";
import type { CommentRow } from "~/core/comments";
import type { ArticleRecord } from "~/core/extract";

const T0 = 1755302400; // 2025-08-16T00:00:00Z, story post time

function expectWellFormed(xml: string) {
  const r = XMLValidator.validate(xml, { allowBooleanAttributes: false });
  if (r !== true) {
    throw new Error(`not well-formed: ${r.err.msg} (line ${r.err.line})\n${xml.slice(0, 400)}`);
  }
}

function story(over: Partial<StoryRow> = {}): StoryRow {
  return {
    id: 44921137,
    edition_date: "2026-08-16",
    rank: 1,
    title: "Good system design",
    url: "https://seangoedecke.com/good-system-design/",
    domain: "seangoedecke.com",
    author: "ingve",
    points: 957,
    num_comments: 208,
    created_at_i: T0,
    story_text: null,
    is_text_post: 0,
    ...over,
  };
}

function article(over: Partial<ArticleRecord> = {}): ArticleRecord {
  return {
    story_id: 44921137,
    state: "ok",
    fetched_at: T0 + 100,
    http_status: 200,
    final_url: "https://seangoedecke.com/good-system-design/",
    title: "Good system design",
    author: "Sean Goedecke",
    published: "2025-08-01T00:00:00Z",
    site: "seangoedecke.com",
    language: "en",
    word_count: 1200,
    xhtml: "<p>Systems should be boring.</p>",
    markdown: "Systems should be boring.",
    error_code: null,
    ...over,
  };
}

function comment(over: Partial<CommentRow> = {}): CommentRow {
  return {
    id: 1,
    story_id: 44921137,
    parent_id: null,
    root_id: 1,
    depth: 0,
    sort_index: 0,
    author: "alice",
    created_at_i: T0 + 3600,
    text_html: "<p>Nice writeup.</p>",
    ...over,
  };
}

/* ------------------------------------------------------------------ */

describe("relativeAge", () => {
  test("is relative to the story, never the wall clock", () => {
    expect(relativeAge(T0 + 4 * 3600, T0)).toBe("+4h");
    // Same inputs a year later must give the same answer.
    expect(relativeAge(T0 + 4 * 3600, T0)).toBe("+4h");
  });

  test("covers each unit boundary", () => {
    expect(relativeAge(T0, T0)).toBe("+0m");
    expect(relativeAge(T0 + 59, T0)).toBe("+0m");
    expect(relativeAge(T0 + 60, T0)).toBe("+1m");
    expect(relativeAge(T0 + 59 * 60, T0)).toBe("+59m");
    expect(relativeAge(T0 + 3600, T0)).toBe("+1h");
    expect(relativeAge(T0 + 47 * 3600, T0)).toBe("+47h");
    expect(relativeAge(T0 + 48 * 3600, T0)).toBe("+2d");
    expect(relativeAge(T0 + 59 * 86400, T0)).toBe("+59d");
    expect(relativeAge(T0 + 60 * 86400, T0)).toBe("+2mo");
  });

  test("clamps negatives and tolerates null", () => {
    expect(relativeAge(T0 - 5000, T0)).toBe("+0m");
    expect(relativeAge(null, T0)).toBe("");
  });
});

describe("isoDate", () => {
  test("formats to minute precision in UTC", () => {
    expect(isoDate(T0)).toBe("2025-08-16 00:00Z");
  });
});

describe("snippet", () => {
  test("strips tags and collapses whitespace", () => {
    expect(snippet("<p>hello   <i>there</i></p>\n<p>friend</p>")).toBe("hello there friend");
  });

  test("decodes the entities HN emits", () => {
    expect(snippet("a &amp; b &lt;c&gt; &quot;d&quot; &#x27;e&#x27;")).toBe(`a & b <c> "d" 'e'`);
  });

  test("truncates on a word boundary with an ellipsis", () => {
    const out = snippet("the quick brown fox jumps over the lazy dog again and again", 20);
    expect(out.endsWith("\u2026")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(21);
    expect(out).not.toContain("  ");
  });

  test("leaves short text alone", () => {
    expect(snippet("short")).toBe("short");
  });
});

/* ------------------------------------------------------------------ */

describe("renderFrontMatter", () => {
  test("is well-formed and carries the headline facts", () => {
    const xml = renderFrontMatter(story(), article());
    expectWellFormed(xml);
    expect(xml).toContain("Good system design");
    expect(xml).toContain("957 points");
    expect(xml).toContain("208 comments");
    expect(xml).toContain("submitted by ingve");
    expect(xml).toContain("seangoedecke.com");
    expect(xml).toContain("1200 words");
  });

  test("links to both the article and the HN thread", () => {
    const xml = renderFrontMatter(story(), article());
    expect(xml).toContain('href="https://seangoedecke.com/good-system-design/"');
    expect(xml).toContain("https://news.ycombinator.com/item?id=44921137");
  });

  test("omits the article link for text posts", () => {
    const xml = renderFrontMatter(story({ url: null, domain: null, is_text_post: 1 }), null);
    expectWellFormed(xml);
    expect(xml).not.toContain("Original article");
    expect(xml).toContain("Hacker News discussion");
  });

  test("escapes XML metacharacters in the title", () => {
    const xml = renderFrontMatter(story({ title: `Tom & Jerry <script> "x"` }), null);
    expectWellFormed(xml);
    expect(xml).toContain("Tom &amp; Jerry &lt;script&gt;");
    expect(xml).not.toContain("<script>");
  });

  test("survives a null submitter and zero counts", () => {
    const xml = renderFrontMatter(story({ author: null, points: 0, num_comments: 0 }), null);
    expectWellFormed(xml);
    expect(xml).toContain("0 points");
    expect(xml).not.toContain("submitted by");
  });
});

/* ------------------------------------------------------------------ */

describe("renderArticle", () => {
  test("renders extracted content", () => {
    const xml = renderArticle(story(), article());
    expectWellFormed(xml);
    expect(xml).toContain("Systems should be boring.");
    expect(xml).toContain("Sean Goedecke");
    expect(xml).not.toContain("class=\"stub\"");
  });

  test("carries the detected language onto the document", () => {
    const xml = renderArticle(story(), article({ language: "de" }));
    expect(xml).toContain('lang="de"');
    expect(xml).toContain('xml:lang="de"');
  });

  test("emits a stub chapter when extraction failed", () => {
    const xml = renderArticle(story(), article({ state: "failed", xhtml: "", error_code: "timeout", http_status: null }));
    expectWellFormed(xml);
    expect(xml).toContain("Article text unavailable");
    expect(xml).toContain("did not respond in time");
    expect(xml).toContain("<code>timeout</code>");
    expect(xml).toContain("discussion follows");
  });

  test("names the HTTP status when there was one", () => {
    const xml = renderArticle(story(), article({ state: "failed", xhtml: "", error_code: "http_error", http_status: 403 }));
    expect(xml).toContain("HTTP 403");
  });

  test("falls back to a stub for an unknown error code", () => {
    const xml = renderArticle(story(), article({ state: "failed", xhtml: "", error_code: "weird_new_code" }));
    expectWellFormed(xml);
    expect(xml).toContain("could not be extracted");
    expect(xml).toContain("weird_new_code");
  });

  test("treats a missing article record as a stub", () => {
    const xml = renderArticle(story(), null);
    expectWellFormed(xml);
    expect(xml).toContain("Article text unavailable");
  });

  test("treats whitespace-only content as a stub", () => {
    const xml = renderArticle(story(), article({ xhtml: "   \n  " }));
    expect(xml).toContain("Article text unavailable");
  });
});

/* ------------------------------------------------------------------ */

describe("renderThread", () => {
  const thread: CommentRow[] = [
    comment({ id: 1, depth: 0, sort_index: 0, author: "alice" }),
    comment({ id: 2, depth: 1, parent_id: 1, sort_index: 1, author: "bob", created_at_i: T0 + 7200 }),
    comment({ id: 3, depth: 2, parent_id: 2, sort_index: 2, author: "carol" }),
    comment({ id: 4, depth: 5, parent_id: 3, sort_index: 3, author: "dave" }),
  ].map((c) => ({ ...c, root_id: 1 }));

  test("is well-formed", () => {
    expectWellFormed(renderThread(story(), thread, 0));
  });

  test("leads the header with a bold depth marker, then author and age", () => {
    const xml = renderThread(story(), thread, 0);
    expect(xml).toContain(
      '<strong class="lvl">L1</strong> \u00b7 ' +
        '<a class="who" href="https://news.ycombinator.com/item?id=2">bob</a> \u00b7 +2h',
    );
  });

  test("links the author to their comment on Hacker News", () => {
    // The book and the website have to agree on where a name points, and the
    // comment id is the only durable address a comment has.
    const xml = renderThread(story(), thread, 0);
    expect(xml).toContain('<a class="who" href="https://news.ycombinator.com/item?id=1">alice</a>');
    expect(xml).toContain('<a class="who" href="https://news.ycombinator.com/item?id=4">dave</a>');
  });

  test("omits the level marker on root comments", () => {
    const xml = renderThread(story(), [thread[0]!], 0);
    expect(xml).toContain(">alice</a> \u00b7 +1h");
    expect(xml).not.toContain("L0");
  });

  test("maps depth to indent classes and flattens past the cap", () => {
    const xml = renderThread(story(), thread, 0, { indentMaxDepth: 4 });
    expect(xml).toContain('class="comment"'); // depth 0
    expect(xml).toContain('class="comment d1"');
    expect(xml).toContain('class="comment d2"');
    expect(xml).toContain('class="comment dx"'); // depth 5 > cap
    expect(xml).toContain("L5"); // true depth still stated
  });

  test("indents a fifth level by default instead of flattening it", () => {
    const xml = renderThread(story(), thread, 0);
    expect(xml).toContain('class="comment d5"');
    expect(xml).not.toContain('class="comment dx"');
  });

  test("respects a lower indent cap", () => {
    const xml = renderThread(story(), thread, 0, { indentMaxDepth: 1 });
    expect(xml).toContain('class="comment d1"');
    expect(xml).not.toContain('class="comment d2"');
    expect(xml).toContain('class="comment dx"');
  });

  test("marks the submitter", () => {
    const xml = renderThread(story({ author: "bob" }), thread, 0);
    expect(xml).toContain('<a class="who op" href="https://news.ycombinator.com/item?id=2">bob</a>');
    // Everyone else keeps the plain treatment.
    expect(xml).toContain('<a class="who" href="https://news.ycombinator.com/item?id=1">alice</a>');
  });

  test("gives each comment a stable anchor id", () => {
    const xml = renderThread(story(), thread, 0);
    expect(xml).toContain('id="c1"');
    expect(xml).toContain('id="c4"');
  });

  test("repairs unclosed HN comment markup", () => {
    const xml = renderThread(story(), [comment({ text_html: "<p>one<p>two<p>three" })], 0);
    expectWellFormed(xml);
    expect(xml.match(/<\/p>/g)?.length).toBeGreaterThanOrEqual(3);
  });

  test("sanitises hostile comment markup", () => {
    const xml = renderThread(
      story(),
      [comment({ text_html: `<p>hi</p><script>alert(1)</script><a href="javascript:x">z</a>` })],
      0,
    );
    expectWellFormed(xml);
    expect(xml).not.toContain("alert(1)");
    expect(xml).not.toContain("javascript:");
  });

  test("truncates at maxDepth and says so", () => {
    const xml = renderThread(story(), thread, 0, { maxDepth: 1 });
    expectWellFormed(xml);
    expect(xml).toContain("bob"); // depth 1 kept
    expect(xml).not.toContain("carol"); // depth 2 dropped
    expect(xml).not.toContain("dave"); // depth 5 dropped
    expect(xml).toContain("2 deeper replies omitted");
    expect(xml).toContain("news.ycombinator.com");
  });

  test("uses the singular for one omitted reply", () => {
    const xml = renderThread(story(), thread.slice(0, 3), 0, { maxDepth: 1 });
    expect(xml).toContain("1 deeper reply omitted");
  });

  test("counts only visible comments in the heading", () => {
    expect(renderThread(story(), thread, 0)).toContain("4 comments");
    expect(renderThread(story(), [thread[0]!], 2)).toContain("Thread C \u00b7 1 comment");
  });

  test("handles a null author", () => {
    const xml = renderThread(story(), [comment({ author: null })], 0);
    expectWellFormed(xml);
    expect(xml).toContain("anonymous");
  });
});

describe("threadTitle", () => {
  test("combines thread letter, author and opening text", () => {
    expect(threadTitle([comment({ author: "alice", text_html: "<p>Nice writeup.</p>" })], 0)).toBe(
      "A \u00b7 alice: Nice writeup.",
    );
  });

  test("falls back to the author alone when the body is markup-only", () => {
    expect(threadTitle([comment({ author: "alice", text_html: "<p></p>" })], 0)).toBe(
      "A \u00b7 alice",
    );
  });

  test("falls back to a bare letter for an empty thread", () => {
    expect(threadTitle([], 4)).toBe("Thread E");
  });

  test("labels match the chapter heading so the TOC can be correlated", () => {
    const thread = [comment({ author: "alice", text_html: "<p>Nice writeup.</p>" })];
    expect(threadTitle(thread, 2).startsWith("C \u00b7")).toBe(true);
    expect(renderThread(story(), thread, 2)).toContain("Thread C");
  });
});

describe("renderNoComments", () => {
  test("is well-formed and links out", () => {
    const xml = renderNoComments(story());
    expectWellFormed(xml);
    expect(xml).toContain("No comments were available");
    expect(xml).toContain("item?id=44921137");
  });
});

/* ------------------------------------------------------------------ */
/* deduplication                                                       */
/* ------------------------------------------------------------------ */

describe("bylineParts", () => {
  test("drops case-insensitive duplicates", () => {
    expect(bylineParts("RISC-V Article", "RISC-V Article", "2026-08-16")).toEqual([
      "RISC-V Article",
      "2026-08-16",
    ]);
    expect(bylineParts("Rhonabwy", "rhonabwy")).toEqual(["Rhonabwy"]);
  });

  test("skips null, undefined and blank values", () => {
    expect(bylineParts(null, undefined, "  ", "Site")).toEqual(["Site"]);
    expect(bylineParts()).toEqual([]);
  });

  test("preserves order and keeps genuinely different values", () => {
    expect(bylineParts("Jane Doe", "Example Blog", "2026-01-02")).toEqual([
      "Jane Doe",
      "Example Blog",
      "2026-01-02",
    ]);
  });
});

describe("stripLeadingHeading", () => {
  test("removes a leading heading that repeats the title", () => {
    const out = stripLeadingHeading("<h2>Good system design</h2><p>Body.</p>", "Good system design");
    expect(out).toBe("<p>Body.</p>");
  });

  test("matches across punctuation, case and smart quotes", () => {
    const out = stripLeadingHeading(
      '<h1>A Response to \u201cRISC-V\u201d</h1><p>Body.</p>',
      'A response to "RISC-V"',
    );
    expect(out).toBe("<p>Body.</p>");
  });

  test("removes a heading that is a prefix of the metadata title", () => {
    const out = stripLeadingHeading(
      "<h1>Software Engineering fundamentals</h1><p>Body.</p>",
      "Software Engineering fundamentals matter more than ever",
    );
    expect(out).toBe("<p>Body.</p>");
  });

  test("keeps a leading heading that is unrelated to the title", () => {
    const html = "<h2>Introduction</h2><p>Body.</p>";
    expect(stripLeadingHeading(html, "Good system design")).toBe(html);
  });

  test("leaves content alone when it does not start with a heading", () => {
    const html = "<p>Body.</p><h2>Good system design</h2>";
    expect(stripLeadingHeading(html, "Good system design")).toBe(html);
  });

  test("only strips the first heading, never a later duplicate", () => {
    const html = "<h2>Title</h2><p>a</p><h2>Title</h2>";
    expect(stripLeadingHeading(html, "Title")).toBe("<p>a</p><h2>Title</h2>");
  });
});

describe("renderArticle deduplication", () => {
  test("does not print the article title twice", () => {
    const xml = renderArticle(
      story({ title: "Good system design" }),
      article({ title: "Good system design", xhtml: "<h2>Good system design</h2><p>Body.</p>" }),
    );
    expectWellFormed(xml);
    expect(xml.match(/Good system design/g)?.length).toBe(2); // <title> + <h2>
    expect(xml).toContain("<p>Body.</p>");
  });

  test("does not repeat a byline segment shared by author and site", () => {
    const xml = renderArticle(
      story(),
      article({ author: "RISC-V Article", site: "RISC-V Article", published: "2026-08-16" }),
    );
    expectWellFormed(xml);
    expect(xml).toContain('<p class="meta">RISC-V Article \u00b7 2026-08-16</p>');
  });

  test("still shows a distinct author and site", () => {
    const xml = renderArticle(story(), article({ author: "Jane", site: "Example", published: null }));
    expectWellFormed(xml);
    expect(xml).toContain('<p class="meta">Jane \u00b7 Example</p>');
  });
});

describe("threadLabel", () => {
  test("counts A, B, C from zero", () => {
    expect([0, 1, 2].map(threadLabel)).toEqual(["A", "B", "C"]);
  });

  test("continues past Z as AA, AB", () => {
    expect(threadLabel(25)).toBe("Z");
    expect(threadLabel(26)).toBe("AA");
    expect(threadLabel(27)).toBe("AB");
    expect(threadLabel(51)).toBe("AZ");
    expect(threadLabel(52)).toBe("BA");
  });

  test("stays unique across a realistic thread count", () => {
    const labels = Array.from({ length: 300 }, (_, i) => threadLabel(i));
    expect(new Set(labels).size).toBe(300);
  });
});

describe("markQuotes", () => {
  test("tags an HN quote paragraph and drops the marker", () => {
    expect(markQuotes("<p>&gt; quoted text</p>")).toBe('<p class="quote">quoted text</p>');
  });

  test("handles the literal > the serialiser emits", () => {
    expect(markQuotes("<p>> quoted text</p>")).toBe('<p class="quote">quoted text</p>');
  });

  test("strips a nested >> marker run", () => {
    expect(markQuotes("<p>&gt;&gt; deeper quote</p>")).toBe('<p class="quote">deeper quote</p>');
  });

  test("leaves ordinary paragraphs untouched", () => {
    const p = "<p>Agreed, though I'd push back a little.</p>";
    expect(markQuotes(p)).toBe(p);
  });

  test("marks only the quoted paragraphs in a mixed comment", () => {
    const out = markQuotes("<p>&gt; you said this</p><p>And here is my reply.</p>");
    expect(out).toBe('<p class="quote">you said this</p><p>And here is my reply.</p>');
  });

  test("does not treat a mid-paragraph > as a quote", () => {
    const p = "<p>use a &gt; b to compare</p>";
    expect(markQuotes(p)).toBe(p);
  });

  test("output stays well-formed", () => {
    expectWellFormed(`<root>${markQuotes("<p>&gt; a</p><p>b</p>")}</root>`);
  });
});

describe("linkFootnotes", () => {
  const DEF = '<p>[1] https://example.com/paper</p>';

  test("links a citation to the definition and the definition back to it", () => {
    const out = linkFootnotes(`<p>As shown in [1].</p>${DEF}`, 42);
    expect(out).toContain('<a class="fnref" id="fnref-42-1" href="#fn-42-1">[1]</a>');
    expect(out).toContain('<a class="fndef" id="fn-42-1" href="#fnref-42-1">[1]</a>');
  });

  test("namespaces anchors by comment, because a page holds hundreds", () => {
    const a = linkFootnotes(`<p>see [1]</p>${DEF}`, 111);
    const b = linkFootnotes(`<p>see [1]</p>${DEF}`, 222);
    expect(a).toContain('id="fn-111-1"');
    expect(b).toContain('id="fn-222-1"');
    // Ids must be valid XML names, i.e. never start with a digit.
    expect(a.match(/id="([^"]+)"/g)?.every((m) => /id="[A-Za-z_]/.test(m))).toBe(true);
  });

  test("handles several distinct footnotes in one comment", () => {
    const out = linkFootnotes(
      "<p>see [1] and [2]</p><p>[1] https://a.example</p><p>[2] https://b.example</p>",
      7,
    );
    expect(out).toContain('href="#fn-7-1"');
    expect(out).toContain('href="#fn-7-2"');
    expect(out).toContain('id="fn-7-2"');
  });

  test("gives the back-link id to the first citation only, so ids stay unique", () => {
    const out = linkFootnotes(`<p>[1] here, [1] again</p>${DEF}`, 5);
    expect(out.match(/id="fnref-5-1"/g)).toHaveLength(1);
    expect(out.match(/href="#fn-5-1"/g)).toHaveLength(2);
  });

  test("accepts a definition after a line break, not only after a paragraph", () => {
    const out = linkFootnotes("<p>text [1]<br />[1] https://a.example</p>", 1);
    expect(out).toContain('class="fndef"');
    expect(out).toContain('class="fnref"');
  });

  test("accepts a newline inside a text run as a line start", () => {
    const out = linkFootnotes("<p>text [1]\n[1] https://a.example</p>", 1);
    expect(out).toContain('class="fndef"');
  });

  /* --- the false positives, which matter more than the positives --- */

  test("leaves a citation alone when nothing in the comment defines it", () => {
    const input = "<p>See [1] for the details.</p>";
    expect(linkFootnotes(input, 1)).toBe(input);
  });

  test("leaves a definition alone when nothing cites it", () => {
    // Marking it up would put a link in the text that goes nowhere useful.
    const input = "<p>[1] https://example.com</p>";
    expect(linkFootnotes(input, 1)).toBe(input);
  });

  test("does not touch an array subscript", () => {
    const input = `<p>arr[1] is the second element, unlike xs[1].</p>${DEF}`;
    const out = linkFootnotes(input, 1);
    expect(out).toContain("arr[1] is the second element, unlike xs[1].");
    expect(out).not.toContain('class="fnref"');
  });

  test("does not touch a subscript after a closing bracket", () => {
    const input = `<p>f(x)[1] and m[0][1] stay put.</p>${DEF}`;
    expect(linkFootnotes(input, 1)).toContain("f(x)[1] and m[0][1] stay put.");
  });

  test("ignores [0], which is an index far more often than a footnote", () => {
    const input = "<p>see [0]</p><p>[0] https://a.example</p>";
    expect(linkFootnotes(input, 1)).toBe(input);
  });

  test("ignores a zero-padded or over-long number", () => {
    const input = "<p>see [01] and [1234]</p><p>[01] x</p><p>[1234] y</p>";
    expect(linkFootnotes(input, 1)).toBe(input);
  });

  test("ignores bracketed words such as [citation needed]", () => {
    const input = "<p>true [citation needed]</p><p>[citation needed] nope</p>";
    expect(linkFootnotes(input, 1)).toBe(input);
  });

  test("ignores markdown-ish [1](url), which HN renders literally", () => {
    const out = linkFootnotes(`<p>[1](https://x.example) then [1]</p>${DEF}`, 1);
    expect(out).toContain("[1](https://x.example)");
    // The bare citation later in the same paragraph is still linked.
    expect(out).toContain('<a class="fnref" id="fnref-1-1" href="#fn-1-1">[1]</a>');
  });

  test("never rewrites inside code or pre, where [1] is an index", () => {
    const out = linkFootnotes(
      `<pre><code>xs[1]\n[1] = 2\n</code></pre><p>see [1]</p>${DEF}`,
      1,
    );
    expect(out).toContain("<pre><code>xs[1]\n[1] = 2\n</code></pre>");
  });

  test("never rewrites inside an anchor, where it would nest links", () => {
    const out = linkFootnotes(
      '<p>see [1]</p><p>[1] <a href="https://a.example">paper [1] revised</a></p>',
      1,
    );
    expect(out).toContain('<a href="https://a.example">paper [1] revised</a>');
    expect(out).not.toContain("<a class=\"fnref\" href=\"#fn-1-1\">[1]</a></a>");
  });

  test("does not treat a mid-sentence marker as a definition", () => {
    // "[2]" opens no line, so there is no definition and nothing is linked.
    const input = "<p>compare [1] with [2] here</p>";
    expect(linkFootnotes(input, 1)).toBe(input);
  });

  test("is a no-op on text with no brackets at all", () => {
    const input = "<p>Nothing to see.</p>";
    expect(linkFootnotes(input, 1)).toBe(input);
  });

  test("leaves attribute values containing > alone", () => {
    const input = `<p><a href="https://x.example/?a=1&#x3E;2">link</a> [1]</p>${DEF}`;
    const out = linkFootnotes(input, 1);
    expect(out).toContain('href="https://x.example/?a=1&#x3E;2"');
    expect(out).toContain('class="fnref"');
  });

  test("output stays well-formed", () => {
    expectWellFormed(`<root>${linkFootnotes(`<p>see [1]</p>${DEF}`, 1)}</root>`);
  });

  test("is deterministic: same input, same bytes", () => {
    const input = `<p>see [1] and [1]</p>${DEF}`;
    expect(linkFootnotes(input, 9)).toBe(linkFootnotes(input, 9));
  });
});

describe("commentBodyHtml", () => {
  test("sanitises, marks quotes and wires footnotes in one pass", () => {
    const out = commentBodyHtml(
      comment({
        id: 314,
        text_html:
          "<p>&gt; the claim</p><p>Wrong, see [1]<script>alert(1)</script></p><p>[1] https://a.example</p>",
      }),
    );
    expect(out).toContain('<p class="quote">the claim</p>');
    expect(out).toContain('href="#fn-314-1"');
    expect(out).not.toContain("alert(1)");
  });

  test("keys the anchors on the comment id, so two comments cannot collide", () => {
    const text = "<p>see [1]</p><p>[1] https://a.example</p>";
    expect(commentBodyHtml(comment({ id: 1, text_html: text }))).toContain('id="fn-1-1"');
    expect(commentBodyHtml(comment({ id: 2, text_html: text }))).toContain('id="fn-2-1"');
  });

  test("survives a hostile footnote body", () => {
    const out = commentBodyHtml(
      comment({
        id: 8,
        text_html:
          `<p>see [1]</p><p>[1] <a href="javascript:alert(1)">x</a> ` +
          `<img src=x onerror="alert(2)" /> &lt;script&gt;alert(3)&lt;/script&gt;</p>`,
      }),
    );
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("onerror");
    expect(out).not.toContain("<script");
    expect(out).toContain("&#x3C;script>alert(3)");
    expect(out).toContain('class="fndef"');
  });

  test("cannot be made to emit an attacker-chosen anchor id", () => {
    // The namespace comes from the comment id and the digits from a matched
    // number, so nothing a commenter types reaches an id or an href. The
    // quote soup below stays what it was: text.
    const out = commentBodyHtml(
      comment({ id: 3, text_html: '<p>see [1]</p><p>[1] " id="x" onclick="y</p>' }),
    );
    expect(out.match(/<a [^>]*>/g)).toEqual([
      '<a class="fnref" id="fnref-3-1" href="#fn-3-1">',
      '<a class="fndef" id="fn-3-1" href="#fnref-3-1">',
    ]);
  });
});

describe("authorLink", () => {
  test("links the name to that comment on Hacker News", () => {
    expect(authorLink(9, "alice", false)).toBe(
      '<a class="who" href="https://news.ycombinator.com/item?id=9">alice</a>',
    );
  });

  test("keeps the submitter treatment as a class on the link", () => {
    expect(authorLink(9, "ingve", true)).toContain('class="who op"');
  });

  test("names a missing author anonymous", () => {
    expect(authorLink(9, null, false)).toContain(">anonymous</a>");
  });

  test("escapes a hostile name", () => {
    const out = authorLink(9, '"><script>alert(1)</script>', false);
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("&quot;");
    expectWellFormed(`<root>${out}</root>`);
  });

  test("adds rel only when asked, since the book has no referrer to leak", () => {
    expect(authorLink(9, "alice", false)).not.toContain("rel=");
    expect(authorLink(9, "alice", false, "noreferrer")).toContain('rel="noreferrer"');
  });
});

describe("renderThread - footnotes", () => {
  test("wires up a footnote inside a chapter and stays well-formed", () => {
    const xml = renderThread(
      story(),
      [comment({ id: 77, text_html: "<p>see [1]</p><p>[1] https://a.example</p>" })],
      0,
    );
    expectWellFormed(xml);
    expect(xml).toContain('href="#fn-77-1"');
    expect(xml).toContain('id="fn-77-1"');
  });
});
