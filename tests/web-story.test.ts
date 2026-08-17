/**
 * Article and comment fragments for the website's story page.
 *
 * The EPUB renderer produces whole XHTML documents; this produces fragments for
 * the page shell. Both draw on the same helpers in ~/epub/render, so the tests
 * that matter here are the ones about the seam: what happens when extraction
 * failed, whether the title gets printed twice, and whether anything a stranger
 * typed into an HN comment box can reach the page unescaped.
 */
import { describe, expect, test } from "bun:test";
import type { CommentRow } from "~/core/comments";
import type { StoryRow } from "~/core/edition";
import type { ArticleRecord } from "~/core/extract";
import { HN_ITEM, articleByline, articleHtml, commentsHtml } from "~/web/story";
import { SITE_CSS } from "~/web/styles";

const T0 = 1_755_302_400; // 2025-08-16T00:00:00Z

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

describe("articleHtml - extraction failed", () => {
  test("emits a stub naming the reason in plain English", () => {
    const html = articleHtml(story(), article({ state: "failed", error_code: "http_404" }));
    expect(html).toContain('<div class="stub">');
    expect(html).toContain('<p class="reason">Article text unavailable</p>');
    expect(html).toContain("The page was not found.");
  });

  test("prints the machine-readable reason code as well", () => {
    // The prose is for the reader; the code is what gets pasted into a bug
    // report, so both have to be on the page.
    const html = articleHtml(story(), article({ state: "failed", error_code: "timeout" }));
    expect(html).toContain("<code>timeout</code>");
    expect(html).toContain("The server did not respond in time.");
  });

  test("appends the HTTP status when there was one", () => {
    const html = articleHtml(
      story(),
      article({ state: "failed", error_code: "http_error", http_status: 503 }),
    );
    expect(html).toContain("(HTTP 503)");
  });

  test("omits the status when the request never got one", () => {
    const html = articleHtml(
      story(),
      article({ state: "failed", error_code: "network_error", http_status: null }),
    );
    expect(html).not.toContain("HTTP ");
  });

  test("offers the source link so the reader can go and read it themselves", () => {
    const html = articleHtml(story(), article({ state: "failed", error_code: "http_404" }));
    expect(html).toContain('href="https://seangoedecke.com/good-system-design/"');
    expect(html).toContain('rel="noreferrer"');
  });

  test("omits the source link for a story with no URL", () => {
    const html = articleHtml(
      story({ url: null }),
      article({ state: "failed", error_code: "http_404" }),
    );
    expect(html).not.toContain("Source:");
  });

  test("hands over to the discussion, which is the rest of the page", () => {
    const html = articleHtml(story(), article({ state: "failed", error_code: "http_404" }));
    expect(html).toContain("The Hacker News discussion follows.");
  });

  test("treats a missing record as an empty extraction", () => {
    const html = articleHtml(story(), null);
    expect(html).toContain('<div class="stub">');
    expect(html).toContain("<code>extraction_empty</code>");
  });

  test("treats an ok record with no text as a failure too", () => {
    // "ok" with an empty body would otherwise render as a blank article.
    expect(articleHtml(story(), article({ xhtml: "" }))).toContain('<div class="stub">');
    expect(articleHtml(story(), article({ xhtml: "   \n  " }))).toContain('<div class="stub">');
  });

  test("falls back to generic prose for a reason code it does not know", () => {
    const html = articleHtml(
      story(),
      article({ state: "failed", error_code: "moon_phase_wrong" }),
    );
    expect(html).toContain("The article could not be extracted.");
    expect(html).toContain("<code>moon_phase_wrong</code>");
  });

  test("escapes a hostile URL rather than emitting it into the href", () => {
    const html = articleHtml(
      story({ url: 'https://evil.com/"><script>alert(1)</script>' }),
      article({ state: "failed", error_code: "http_404" }),
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;");
  });
});

describe("articleHtml - extraction succeeded", () => {
  test("inlines the extracted XHTML as-is", () => {
    // Already sanitised and absolutised at extraction time, so re-parsing here
    // would cost a rehype round-trip per request to arrive at the same bytes.
    const html = articleHtml(story(), article());
    expect(html).toBe("<p>Systems should be boring.</p>");
  });

  test("strips a leading heading that repeats the title", () => {
    // The page prints the title as its own h1, so this would be the second
    // copy on screen.
    const html = articleHtml(
      story(),
      article({ xhtml: "<h1>Good system design</h1>\n<p>Body.</p>" }),
    );
    expect(html).toBe("<p>Body.</p>");
    expect(html).not.toContain("<h1>");
  });

  test("strips a leading heading that only prefixes the metadata title", () => {
    const html = articleHtml(
      story(),
      article({
        title: "Good system design - Sean Goedecke",
        xhtml: "<h2>Good system design</h2><p>Body.</p>",
      }),
    );
    expect(html).toBe("<p>Body.</p>");
  });

  test("keeps a leading heading that says something else", () => {
    const html = articleHtml(
      story(),
      article({ xhtml: "<h1>Introduction</h1><p>Body.</p>" }),
    );
    expect(html).toContain("<h1>Introduction</h1>");
  });

  test("keeps headings that are not the first thing in the article", () => {
    const html = articleHtml(
      story(),
      article({ xhtml: "<p>Lede.</p><h2>Good system design</h2><p>Body.</p>" }),
    );
    expect(html).toContain("<h2>Good system design</h2>");
  });

  test("compares against the story title when the article has none", () => {
    const html = articleHtml(
      story(),
      article({ title: null, xhtml: "<h1>Good system design</h1><p>Body.</p>" }),
    );
    expect(html).toBe("<p>Body.</p>");
  });
});

describe("articleHtml - text post", () => {
  /** What `textPostArticle` produces: state "text_post", body from story_text. */
  function textPost() {
    return article({
      state: "text_post",
      http_status: null,
      final_url: null,
      site: "Hacker News",
      author: "pg",
      published: null,
      xhtml: "<p>Tell us what you built.</p><p>Links welcome.</p>",
      word_count: 8,
    });
  }

  test("uses the story text as the article body", () => {
    const html = articleHtml(
      story({ url: null, is_text_post: 1, title: "Ask HN: What are you working on?" }),
      textPost(),
    );
    expect(html).toContain("Tell us what you built.");
    expect(html).toContain("Links welcome.");
  });

  test("does not treat a text post as a failed extraction", () => {
    const html = articleHtml(story({ url: null, is_text_post: 1 }), textPost());
    expect(html).not.toContain("Article text unavailable");
    expect(html).not.toContain('<div class="stub">');
  });

  test("still stubs a text post that carried no text", () => {
    const html = articleHtml(
      story({ url: null, is_text_post: 1 }),
      article({ state: "text_post", xhtml: "" }),
    );
    expect(html).toContain('<div class="stub">');
  });
});

describe("articleByline", () => {
  test("lists author, site and publication date", () => {
    expect(articleByline(article())).toEqual([
      "Sean Goedecke",
      "seangoedecke.com",
      "2025-08-01",
    ]);
  });

  test("drops case-insensitive duplicates", () => {
    expect(
      articleByline(article({ author: "SeanGoedecke.com", site: "seangoedecke.com" })),
    ).toEqual(["SeanGoedecke.com", "2025-08-01"]);
  });

  test("skips blank and missing parts rather than emitting empty separators", () => {
    expect(articleByline(article({ author: null, site: "  ", published: null }))).toEqual([]);
  });

  test("is empty for a failed extraction and for no record at all", () => {
    expect(articleByline(article({ state: "failed" }))).toEqual([]);
    expect(articleByline(null)).toEqual([]);
  });

  test("is empty for a text post, whose 'author' is only the submitter", () => {
    expect(articleByline(article({ state: "text_post" }))).toEqual([]);
  });
});

describe("commentsHtml - no threads", () => {
  test("emits a stub rather than an empty section", () => {
    const html = commentsHtml(story(), []);
    expect(html).toContain('<div class="stub">');
    expect(html).toContain("No comments were available when this edition was built.");
  });

  test("links to the live discussion, which may have comments by now", () => {
    const html = commentsHtml(story(), []);
    expect(html).toContain(`${HN_ITEM}44921137`);
    expect(html).toContain('rel="noreferrer"');
  });

  test("emits no thread markup at all", () => {
    const html = commentsHtml(story(), []);
    expect(html).not.toContain("thread-head");
    expect(html).not.toContain('class="comment');
  });
});

describe("commentsHtml - threads", () => {
  test("prints no heading above a thread", () => {
    // The book needs "Thread A" because its threads are chapters a reader
    // navigates by name. On the page they are adjacent sections, so the label
    // names something the reader cannot act on and costs a line in every gap.
    // The rule between sections carries the whole meaning.
    const html = commentsHtml(story(), [[comment()], [comment({ id: 2, root_id: 2 })]]);
    expect(html).not.toContain("Thread A");
    expect(html).not.toContain("Thread B");
    expect(html).not.toContain("thread-head");
  });

  test("opens a thread section with a comment and nothing else", () => {
    const html = commentsHtml(story(), [[comment({ id: 7 })]]);
    expect(html).toContain('<section class="thread" id="tA"><details');
  });

  test("wraps each thread in its own anchored section", () => {
    const html = commentsHtml(story(), [[comment()], [comment({ id: 2, root_id: 2 })]]);
    expect(html.match(/<section class="thread" id="t[A-Z]+">/g)).toHaveLength(2);
    // The anchor letter matches the printed label, so the index can link to it.
    expect(html).toContain('<section class="thread" id="tA">');
    expect(html).toContain('<section class="thread" id="tB">');
  });

  test("gives every comment an anchor keyed by its HN id", () => {
    const html = commentsHtml(story(), [
      [comment({ id: 111 }), comment({ id: 222, depth: 1, root_id: 111 })],
    ]);
    expect(html).toContain('id="c111"');
    expect(html).toContain('id="c222"');
  });

  test("renders the comment body", () => {
    const html = commentsHtml(story(), [[comment({ text_html: "<p>Nice writeup.</p>" })]]);
    expect(html).toContain('<div class="cbody">');
    expect(html).toContain("Nice writeup.");
  });

  test("marks HN-convention quotes so a reply is distinguishable from what it quotes", () => {
    const html = commentsHtml(story(), [
      [comment({ text_html: "<p>&gt; the original claim</p><p>No.</p>" })],
    ]);
    expect(html).toContain('<p class="quote">the original claim</p>');
    // The marker is dropped once the styling carries the meaning.
    expect(html).toContain('<p class="quote">the original claim');
    expect(html).toContain("<p>No.</p>");
  });
});

describe("commentsHtml - depth", () => {
  test("gives roots the bare comment class and no level marker", () => {
    const html = commentsHtml(story(), [[comment({ depth: 0 })]]);
    expect(html).toContain('<details class="comment" id="c1" open>');
    expect(html).not.toContain("L0");
  });

  test("numbers each depth up to the indent maximum", () => {
    const thread = [0, 1, 2, 3, 4, 5].map((depth) =>
      comment({ id: 10 + depth, depth, root_id: 10 }),
    );
    const html = commentsHtml(story(), [thread], { indentMaxDepth: 5 });
    expect(html).toContain('class="comment" id="c10"');
    expect(html).toContain('class="comment d1" id="c11"');
    expect(html).toContain('class="comment d3" id="c13"');
    expect(html).toContain('class="comment d5" id="c15"');
  });

  test("clamps past the maximum to a single overflow class", () => {
    // Indenting forever would leave a deep reply as a column one word wide.
    const thread = [5, 6, 9, 40].map((depth) => comment({ id: 100 + depth, depth, root_id: 105 }));
    const html = commentsHtml(story(), [thread], { indentMaxDepth: 5 });
    expect(html).toContain('class="comment d5" id="c105"');
    expect(html).toContain('class="comment dx" id="c106"');
    expect(html).toContain('class="comment dx" id="c109"');
    expect(html).toContain('class="comment dx" id="c140"');
    expect(html).not.toContain("d6");
  });

  test("never prints a level marker, at any depth", () => {
    // The book prints "L9" because its comments are a flat list and the marker
    // is the only thing placing them. The page nests them and pins the
    // ancestors, so the position is already on screen. The class is still
    // emitted - it drives the indent clamp and the sticky offset - but nothing
    // in the header restates it.
    for (const depth of [0, 1, 3, 5, 9, 40]) {
      const html = commentsHtml(story(), [[comment({ depth })]], { indentMaxDepth: 5 });
      expect(html).not.toContain("lvl");
      expect(html).not.toContain(`L${depth}<`);
    }
  });

  test("defaults the indent maximum to five", () => {
    const html = commentsHtml(story(), [[comment({ depth: 6 })]]);
    expect(html).toContain('class="comment dx"');
  });
});

describe("commentsHtml - submitter", () => {
  test("marks a comment by the story's submitter", () => {
    const html = commentsHtml(story({ author: "ingve" }), [[comment({ author: "ingve" })]]);
    expect(html).toContain('class="who op"');
    expect(html).toContain(">ingve</a>");
  });

  test("leaves everyone else unmarked", () => {
    const html = commentsHtml(story({ author: "ingve" }), [[comment({ author: "alice" })]]);
    expect(html).not.toContain('class="op"');
    expect(html).toContain("alice");
  });

  test("does not mark anyone when the story has no recorded submitter", () => {
    // Otherwise a null author would match every anonymous comment.
    const html = commentsHtml(story({ author: null }), [[comment({ author: null })]]);
    expect(html).not.toContain('class="op"');
    expect(html).toContain("anonymous");
  });

  test("names a comment with no author 'anonymous'", () => {
    expect(commentsHtml(story(), [[comment({ author: null })]])).toContain("anonymous");
  });
});

describe("commentsHtml - escaping", () => {
  test("escapes a hostile author name", () => {
    const html = commentsHtml(story(), [
      [comment({ author: '<script>alert("xss")</script>' })],
    ]);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("escapes a hostile author name in the submitter branch too", () => {
    // Two code paths write the author out; both have to escape.
    const hostile = '<img src=x onerror="alert(1)">';
    const html = commentsHtml(story({ author: hostile }), [[comment({ author: hostile })]]);
    expect(html).toContain('class="who op"');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  test("strips scripting from a comment body", () => {
    const html = commentsHtml(story(), [
      [comment({ text_html: "<p>hi</p><script>alert(1)</script>" })],
    ]);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("alert(1)");
  });

  test("strips event handler attributes from a comment body", () => {
    const html = commentsHtml(story(), [
      [comment({ text_html: '<p onclick="alert(1)">hi</p>' })],
    ]);
    expect(html).not.toContain("onclick");
  });

  test("escapes a hostile story URL in the no-comments stub", () => {
    const html = commentsHtml(story({ id: 1 }), []);
    expect(html).toContain(`${HN_ITEM}1`);
    expect(html).not.toContain("<script");
  });

  test("escapes a hostile footnote body", () => {
    const html = commentsHtml(story(), [
      [
        comment({
          id: 5,
          text_html:
            '<p>see [1]</p><p>[1] <a href="javascript:alert(1)">x</a>' +
            '<img src=y onerror="alert(2)" /></p>',
        }),
      ],
    ]);
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("onerror");
    expect(html).toContain('href="#fn-5-1"');
  });
});

/* ------------------------------------------------------------------ */
/* collapsible tree                                                     */
/* ------------------------------------------------------------------ */

describe("commentsHtml - collapsible tree", () => {
  /** root 1 > 2 > 3, plus a second reply 4 on the root. */
  const nested = [
    comment({ id: 1, depth: 0, root_id: 1, sort_index: 0 }),
    comment({ id: 2, depth: 1, parent_id: 1, root_id: 1, sort_index: 1 }),
    comment({ id: 3, depth: 2, parent_id: 2, root_id: 1, sort_index: 2 }),
    comment({ id: 4, depth: 1, parent_id: 1, root_id: 1, sort_index: 3 }),
  ];

  test("makes every comment a details element, leaves included", () => {
    // Uniform affordance: the header geometry must not change shape halfway
    // down a thread depending on whether a comment happens to have replies.
    const html = commentsHtml(story(), [nested]);
    expect(html.match(/<details class="comment/g)).toHaveLength(4);
    expect(html).not.toContain('<div class="comment');
  });

  test("opens every comment, so the page arrives fully expanded", () => {
    const html = commentsHtml(story(), [nested]);
    expect(html.match(/ open>/g)).toHaveLength(4);
  });

  test("puts the header in a summary and the text in a sibling div", () => {
    const html = commentsHtml(story(), [[comment({ id: 1 })]]);
    expect(html).toContain('<summary class="chead">');
    expect(html).toContain('</summary><div class="cbody">');
  });

  test("nests replies inside their parent, not beside it", () => {
    const html = commentsHtml(story(), [nested]);
    // 3 sits inside 2, which sits inside 1.
    expect(html).toMatch(
      /id="c1"[^>]*>.*id="c2"[^>]*>.*id="c3"[^>]*>.*<\/details><\/div><\/details>/s,
    );
    // Closing 1 comes after all of its replies.
    const end1 = html.lastIndexOf("</details>");
    expect(html.indexOf('id="c4"')).toBeLessThan(end1);
  });

  test("wraps children in a kids container, which is what carries the indent", () => {
    const html = commentsHtml(story(), [nested]);
    expect(html.match(/<div class="kids">/g)).toHaveLength(2); // 1 and 2 have replies
    expect(html).toContain('<div class="cbody"><p>Nice writeup.</p></div><div class="kids">');
  });

  test("omits the kids container for a leaf", () => {
    const html = commentsHtml(story(), [[comment({ id: 1 })]]);
    expect(html).not.toContain('class="kids"');
  });

  test("states the size of the hidden subtree in the summary", () => {
    // Collapsed, this is the only thing telling a reader what is behind it.
    const html = commentsHtml(story(), [nested]);
    expect(html).toContain('<span class="kidcount">3 replies</span>');
    expect(html).toContain('<span class="kidcount">1 reply</span>');
  });

  test("says nothing about replies on a leaf", () => {
    const html = commentsHtml(story(), [[comment({ id: 1 })]]);
    expect(html).not.toContain("kidcount");
  });

  test("keeps the reply count inside the summary, where it stays visible", () => {
    const html = commentsHtml(story(), [nested]);
    const summary = /<summary class="chead">(.*?)<\/summary>/.exec(html)?.[1] ?? "";
    expect(summary).toContain("3 replies");
  });

  test("falls back to depth when parent_id is missing", () => {
    // Rows predating parentage, or a thread sliced out of a longer list.
    const flat = [
      comment({ id: 1, depth: 0, parent_id: null }),
      comment({ id: 2, depth: 1, parent_id: null }),
    ];
    const html = commentsHtml(story(), [flat]);
    expect(html).toContain('<div class="kids">');
    expect(html.indexOf('id="c2"')).toBeGreaterThan(html.indexOf('class="kids"'));
  });

  test("keeps the depth classes, so the indent cap still has something to bite on", () => {
    const thread = [0, 1, 2, 3, 4, 5, 6].map((depth) =>
      comment({ id: 10 + depth, depth, parent_id: depth === 0 ? null : 9 + depth, root_id: 10 }),
    );
    const html = commentsHtml(story(), [thread], { indentMaxDepth: 5 });
    expect(html).toContain('<details class="comment" id="c10" open>');
    expect(html).toContain('<details class="comment d5" id="c15" open>');
    expect(html).toContain('<details class="comment dx" id="c16" open>');
  });
});

describe("commentsHtml - author links", () => {
  test("links the author name to that comment on Hacker News", () => {
    const html = commentsHtml(story(), [[comment({ id: 4242, author: "alice" })]]);
    expect(html).toContain(`href="${HN_ITEM}4242"`);
    expect(html).toContain(">alice</a>");
    expect(html).toContain('rel="noreferrer"');
  });

  test("uses the comment id, not the story id", () => {
    const html = commentsHtml(story({ id: 1 }), [[comment({ id: 999 })]]);
    expect(html).toContain(`href="${HN_ITEM}999"`);
  });
});

describe("commentsHtml - footnotes", () => {
  test("wires an HN footnote reference to its definition", () => {
    const html = commentsHtml(story(), [
      [comment({ id: 60, text_html: "<p>see [1]</p><p>[1] https://a.example</p>" })],
    ]);
    expect(html).toContain('<a class="fnref" id="fnref-60-1" href="#fn-60-1">[1]</a>');
    expect(html).toContain('<a class="fndef" id="fn-60-1" href="#fnref-60-1">[1]</a>');
  });

  test("namespaces the anchors per comment, since the page holds many", () => {
    const text = "<p>see [1]</p><p>[1] https://a.example</p>";
    const html = commentsHtml(story(), [
      [comment({ id: 11, text_html: text }), comment({ id: 12, depth: 1, parent_id: 11, text_html: text })],
    ]);
    expect(html.match(/id="fn-11-1"/g)).toHaveLength(1);
    expect(html.match(/id="fn-12-1"/g)).toHaveLength(1);
  });

  test("leaves an unmatched reference as plain text", () => {
    const html = commentsHtml(story(), [[comment({ text_html: "<p>see arr[1]</p>" })]]);
    expect(html).toContain("arr[1]");
    expect(html).not.toContain("fnref");
  });
});

describe("commentsHtml - no thread index", () => {
  test("prints no index of the threads", () => {
    // An index keyed by letter and author asks the reader to choose between
    // options they know nothing about: "B, bob, 12 comments" carries no signal
    // about whether B is worth reading. It cost a screen of vertical space
    // above every discussion to answer a question it could not answer.
    const html = commentsHtml(story(), [
      [comment({ id: 1, author: "alice" })],
      [comment({ id: 2, root_id: 2, author: "bob" })],
    ]);
    expect(html).not.toContain("thread-index");
    expect(html).not.toContain("<nav");
    expect(html).not.toContain('href="#tA"');
  });

  test("keeps the thread anchors themselves, which cost nothing", () => {
    // Nothing links to these on the page, but they keep /story/123#tB working
    // as a deep link into a discussion.
    const html = commentsHtml(story(), [[comment()], [comment({ id: 2, root_id: 2 })]]);
    expect(html).toContain('id="tA"');
    expect(html).toContain('id="tB"');
  });

  test("the discussion starts with a comment, not with navigation", () => {
    const html = commentsHtml(story(), [
      [comment({ id: 1 })],
      [comment({ id: 2, root_id: 2 })],
    ]);
    expect(html.startsWith('<section class="thread"')).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* stylesheet contract                                                  */
/* ------------------------------------------------------------------ */

describe("SITE_CSS - collapsible comments", () => {
  test("never hides the comment body, which is what makes the fallback work", () => {
    // A reader whose browser has no <details> sees every child of it rendered
    // normally. Hiding .cbody by default and revealing it with [open] would
    // blank the entire discussion on exactly those devices.
    expect(SITE_CSS).not.toMatch(/\.cbody[^{]*\{[^}]*display:\s*none/);
    expect(SITE_CSS).not.toMatch(/\.kids[^{]*\{[^}]*display:\s*none/);
  });

  test("uses [open] only to change chrome, never to reveal content", () => {
    // Comments stripped first: several of them discuss [open] at length.
    const rules = SITE_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(rules).toContain("[open]"); // the test would otherwise be vacuous
    for (const rule of rules.split("}")) {
      if (!rule.includes("[open]")) continue;
      expect(rule).not.toContain("display:");
      expect(rule).not.toContain("visibility:");
    }
  });

  test("pins the comment header with an opaque, themed background", () => {
    // A transparent sticky header with body text scrolling under it is
    // unreadable; var(--bg) is correct in both themes.
    const rule = /\.comment > \.chead \{[^}]*\}/.exec(SITE_CSS)?.[0] ?? "";
    expect(rule).toContain("position: sticky");
    expect(rule).toContain("top: 0");
    expect(rule).toContain("background: var(--bg)");
  });

  test("stacks pinned headers so a parent paints over its children", () => {
    const z = (sel: string) =>
      Number(new RegExp(`${sel} \\{[^}]*z-index: (\\d+);`).exec(SITE_CSS)?.[1] ?? NaN);
    const root = z("\\.comment > \\.chead");
    expect(root).toBeGreaterThan(z("\\.d1 > \\.chead"));
    expect(z("\\.d1 > \\.chead")).toBeGreaterThan(z("\\.d2 > \\.chead"));
    expect(z("\\.d4 > \\.chead")).toBeGreaterThan(z("\\.d5 > \\.chead"));
    expect(z("\\.dx > \\.chead")).toBeGreaterThanOrEqual(1);
  });

  test("offsets each depth by one header so the stack is flush, not overlapping", () => {
    // Every level pins. Pinning them all at top: 0 would pile them on one
    // another and show only the shallowest; stepping each one down by exactly
    // one header height leaves the ancestry of whatever you are reading on
    // screen as a column, each row still tappable to collapse that level.
    const top = (sel: string) =>
      new RegExp(`${sel} \\{[^}]*top: ([^;]+);`).exec(SITE_CSS)?.[1]?.trim() ?? "";
    expect(top("\\.comment > \\.chead")).toBe("0");
    expect(top("\\.d1 > \\.chead")).toBe("var(--chead-h)");
    expect(top("\\.d2 > \\.chead")).toBe("calc(var(--chead-h) * 2)");
    expect(top("\\.d5 > \\.chead")).toBe("calc(var(--chead-h) * 5)");
    // dx repeats d5 rather than continuing: the indent stops stepping right
    // past the cap, so the pinned column stops stepping down with it.
    expect(top("\\.dx > \\.chead")).toBe(top("\\.d5 > \\.chead"));
  });

  test("fixes the header height the offsets are multiples of", () => {
    // The stack is only flush if the header really is --chead-h tall. A
    // min-height would let a wrapped header grow and be overlapped by its own
    // children, so the height is exact and the line is clipped instead.
    const rule = /\n\.chead \{[^}]*\}/.exec(SITE_CSS)?.[0] ?? "";
    expect(rule).toContain("height: var(--chead-h)");
    expect(rule).not.toContain("min-height");
    expect(rule).toContain("white-space: nowrap");
    expect(rule).toContain("overflow: hidden");
    expect(SITE_CSS).toMatch(/--chead-h:\s*[\d.]+rem;/);
  });

  test("indents from the nesting and cancels it past the cap", () => {
    expect(SITE_CSS).toMatch(/\.kids \{[^}]*padding-left: 0\.75rem/);
    // dx is stamped on everything past the cap, so pulling it back by exactly
    // one step stops the staircase however deep the thread runs.
    expect(SITE_CSS).toMatch(/\.dx \{[^}]*margin-left: -0\.75rem/);
  });

  test("keeps the header tappable without the disclosure marker being clipped", () => {
    // The header is shorter than --tap on purpose: six pinned ancestors at 48px
    // would eat a third of a 6-inch panel. It stays easy to hit because the row
    // is full-bleed. But the overflow clip that guarantees the fixed height
    // would cut off the triangle, which is the only thing saying the row is a
    // control, so the marker is moved inside the box.
    const rule = /\n\.chead \{[^}]*\}/.exec(SITE_CSS)?.[0] ?? "";
    expect(rule).toContain("list-style-position: inside");
    expect(/\.comment > \.chead \{[^}]*\}/.exec(SITE_CSS)?.[0] ?? "").toContain(
      "cursor: pointer",
    );
  });

  test("wraps pasted code rather than scrolling it off a narrow panel", () => {
    expect(SITE_CSS).toMatch(/\.cbody pre \{[^}]*white-space: pre-wrap/);
  });
});

/*
 * Layout rules that are easy to break silently: a story row whose two lines
 * collapse into one reads as "Claude: System Promptsplatform.claude.com", and
 * a container width that stops distinguishing prose from page turns every
 * article into a 120-character line on a desktop.
 */
describe("SITE_CSS - page layout", () => {
  test("stacks a story row onto two lines", () => {
    expect(SITE_CSS).toMatch(/\.story-title,\n\.story-meta \{[^}]*display: block/);
  });

  test("keeps the rank beside the title rather than above it", () => {
    expect(SITE_CSS).toMatch(/\.story-link \{[^}]*display: flex/);
    expect(SITE_CSS).toMatch(/\.story-link \{[^}]*align-items: baseline/);
  });

  test("separates the prose measure from the page container", () => {
    expect(SITE_CSS).toMatch(/--measure: \d+rem;/);
    expect(SITE_CSS).toMatch(/--wrap: var\(--measure\);/);
    expect(SITE_CSS).toMatch(/\.wrap \{[^}]*max-width: var\(--wrap\)/);
  });

  test("caps the article at the prose measure however wide the page gets", () => {
    expect(SITE_CSS).toMatch(/\n\.article \{[^}]*max-width: var\(--measure\)/);
    expect(SITE_CSS).toMatch(/\n\.article \{[^}]*margin-inline: auto/);
  });

  test("widens the container only past every e-ink panel width", () => {
    const widths = [...SITE_CSS.matchAll(/@media \(min-width: (\d+)px\)/g)].map(
      (m) => Number(m[1]),
    );
    expect(widths.length).toBeGreaterThanOrEqual(2);
    for (const w of widths) expect(w).toBeGreaterThanOrEqual(900);
  });

  test("declares breakpoints in px, since rem means something else in a media query", () => {
    expect(SITE_CSS).not.toMatch(/@media \([^)]*width: [\d.]+rem/);
  });

  test("grows the container monotonically", () => {
    const wraps = [...SITE_CSS.matchAll(/--wrap: (\d+)rem;/g)].map((m) =>
      Number(m[1]),
    );
    expect(wraps.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < wraps.length; i++) {
      expect(wraps[i]!).toBeGreaterThan(wraps[i - 1]!);
    }
  });
});
