import { describe, expect, test } from "bun:test";
import { XMLValidator } from "fast-xml-parser";
import {
  defuddleHtml,
  failedArticle,
  hasContent,
  textPostArticle,
} from "~/core/extract";
import type { DefuddleResult } from "~/core/extract";
import type { StoryRow } from "~/core/edition";

function expectWellFormed(fragment: string) {
  const doc = `<?xml version="1.0" encoding="UTF-8"?><root>${fragment}</root>`;
  const result = XMLValidator.validate(doc);
  if (result !== true) {
    throw new Error(`not well-formed: ${result.err.msg}\n${fragment.slice(0, 400)}`);
  }
}

function page(body: string, head = ""): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>Fixture Title</title>${head}</head><body>${body}</body></html>`;
}

/** Defuddle drops low-scoring nodes, so fixtures need real prose to survive. */
const PROSE = Array.from(
  { length: 6 },
  (_, i) =>
    `<p>Paragraph ${i + 1}. The quick brown fox jumps over the lazy dog, and then
     continues running through the field for a considerable distance while the
     narrator describes the scene in unnecessary but content-bearing detail.</p>`,
).join("\n");

const story = (over: Partial<StoryRow> = {}): StoryRow =>
  ({
    id: 1,
    edition_date: "2026-08-16",
    rank: 1,
    title: "A Story",
    url: "https://example.com/a",
    domain: "example.com",
    author: "alice",
    points: 100,
    num_comments: 10,
    created_at_i: 1_755_302_400,
    story_text: null,
    is_text_post: 0,
    ...over,
  }) as StoryRow;

describe("defuddleHtml", () => {
  test("extracts article content as well-formed xhtml", async () => {
    const html = page(`<article><h1>Fixture Title</h1>${PROSE}</article>`);
    const r = await defuddleHtml(html, "https://example.com/a");

    expect(r.xhtml).toContain("quick brown fox");
    expect(r.wordCount).toBeGreaterThan(50);
    expectWellFormed(r.xhtml);
  });

  test("produces markdown alongside xhtml", async () => {
    const html = page(`<article>${PROSE}</article>`);
    const r = await defuddleHtml(html, "https://example.com/a");

    expect(r.markdown.length).toBeGreaterThan(50);
    expect(r.markdown).toContain("quick brown fox");
    expect(r.markdown).not.toContain("<p>");
  });

  test("reads metadata from meta tags", async () => {
    const html = page(
      `<article>${PROSE}</article>`,
      `<meta name="author" content="Jane Roe">
       <meta property="article:published_time" content="2026-08-01T10:00:00Z">
       <meta property="og:site_name" content="Example Journal">`,
    );
    const r = await defuddleHtml(html, "https://example.com/a");

    expect(r.title).toBe("Fixture Title");
    expect(r.author).toBe("Jane Roe");
    expect(r.site).toBe("Example Journal");
    expect(r.published).toContain("2026-08-01");
  });

  test("strips scripts, styles and navigation chrome", async () => {
    const html = page(`
      <nav><a href="/x">Nav link</a></nav>
      <article>${PROSE}</article>
      <script>window.tracker = 'BEACON_TOKEN';</script>
      <style>.ad { color: red }</style>
      <footer>FOOTER_MARKER</footer>`);
    const r = await defuddleHtml(html, "https://example.com/a");

    expect(r.xhtml).not.toContain("BEACON_TOKEN");
    expect(r.xhtml).not.toContain("<script");
    expect(r.xhtml).not.toContain("<style");
    expect(r.xhtml).toContain("quick brown fox");
  });

  test("resolves relative links and images against the article url", async () => {
    const html = page(
      `<article>${PROSE}<p><a href="/next">next</a></p>
       <p><img src="../img/diagram.png" alt="Diagram"></p></article>`,
    );
    const r = await defuddleHtml(html, "https://example.com/posts/a");

    expect(r.xhtml).toContain("https://example.com/next");
    expect(r.xhtml).toContain("https://example.com/img/diagram.png");
    expectWellFormed(r.xhtml);
  });

  test("preserves code blocks", async () => {
    const html = page(
      `<article>${PROSE}<pre><code class="language-js">const x = 1 &amp;&amp; 2;</code></pre></article>`,
    );
    const r = await defuddleHtml(html, "https://example.com/a");

    expect(r.xhtml).toContain("<pre>");
    expect(r.xhtml).toContain("const x = 1");
    expectWellFormed(r.xhtml);
  });

  test("returns empty xhtml for a document with no content", async () => {
    const r = await defuddleHtml(page("<div></div>"), "https://example.com/a");
    expect(r.xhtml).toBe("");
  });

  test("survives malformed html", async () => {
    const html = `<html><body><article><p>unclosed ${PROSE}<div><span></article>`;
    const r = await defuddleHtml(html, "https://example.com/a");
    expectWellFormed(r.xhtml);
  });
});

describe("textPostArticle", () => {
  test("renders story text as the article chapter", () => {
    const a = textPostArticle(
      story({
        url: null,
        is_text_post: 1,
        story_text: "<p>What are you working on?<p>Tell us below.",
        title: "Ask HN: What are you working on?",
      }),
    );

    expect(a.state).toBe("text_post");
    expect(a.error_code).toBeNull();
    expect(a.xhtml).toContain("What are you working on?");
    expect(a.word_count).toBeGreaterThan(0);
    expectWellFormed(a.xhtml);
  });

  test("closes hacker news' unclosed paragraph tags", () => {
    const a = textPostArticle(
      story({ url: null, story_text: "<p>one<p>two<p>three" }),
    );
    expect(a.xhtml.match(/<\/p>/g)).toHaveLength(3);
    expectWellFormed(a.xhtml);
  });

  test("handles a missing body", () => {
    const a = textPostArticle(story({ url: null, story_text: null }));
    expect(a.xhtml).toBe("");
    expect(a.word_count).toBe(0);
  });

  test("carries hacker news attribution", () => {
    const a = textPostArticle(
      story({ url: null, story_text: "<p>hi</p>", author: "bob" }),
    );
    expect(a.author).toBe("bob");
    expect(a.site).toBe("Hacker News");
  });
});

describe("failedArticle", () => {
  test("records the failure reason without content", () => {
    const a = failedArticle(42, "robots_disallowed");
    expect(a.story_id).toBe(42);
    expect(a.state).toBe("failed");
    expect(a.error_code).toBe("robots_disallowed");
    expect(a.xhtml).toBe("");
    expect(a.word_count).toBe(0);
  });

  test("carries an http status when there was one", () => {
    expect(failedArticle(42, "http_404", 404).http_status).toBe(404);
  });
});

describe("hasContent", () => {
  function parsed(over: Partial<DefuddleResult> = {}): DefuddleResult {
    return {
      xhtml: "",
      markdown: "",
      title: null,
      author: null,
      published: null,
      site: null,
      language: null,
      wordCount: 0,
      ...over,
    };
  }

  test("accepts real prose", () => {
    expect(hasContent(parsed({ xhtml: "<p>Some actual words.</p>", wordCount: 3 }))).toBe(true);
  });

  test("rejects an empty string", () => {
    expect(hasContent(parsed({ xhtml: "" }))).toBe(false);
  });

  // The regression: story 49314744 stored two whitespace characters and was
  // recorded as state='ok', producing a blank chapter that indexed nothing.
  test("rejects whitespace-only content", () => {
    expect(hasContent(parsed({ xhtml: "\n " }))).toBe(false);
    expect(hasContent(parsed({ xhtml: "   \t\n  " }))).toBe(false);
  });

  test("rejects markup that contains no text", () => {
    expect(hasContent(parsed({ xhtml: "<div><p></p><span> </span></div>" }))).toBe(false);
  });

  // Zero words but real images is a comic or a photo essay, not a failure.
  test("accepts image-only content despite a zero word count", () => {
    expect(hasContent(parsed({ xhtml: '<p><img src="https://x/a.png"/></p>' }))).toBe(true);
  });

  test("accepts text even when defuddle reported no word count", () => {
    expect(hasContent(parsed({ xhtml: "<p>Words here.</p>", wordCount: 0 }))).toBe(true);
  });
});
