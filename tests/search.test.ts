/**
 * Full-text search: what goes into the index, what comes out of it, and the
 * two front ends over the top.
 *
 * Everything DB-backed here runs against a real SQLite file with a real FTS5
 * table, because the whole feature is FTS5 behaviour. A fake would assert that
 * the code calls the functions it calls, which is exactly the class of bug that
 * cannot happen here and none of the ones that can: whether `bm25` accepts two
 * weights for a three-column table, whether `snippet` returns the title when
 * the body is empty, and whether a given string parses as a MATCH expression
 * are all questions only sqlite can answer.
 *
 * Nothing reaches the network. The handlers under test read SQLite and nothing
 * else, and `expectNoFetch` makes that a failure rather than an assumption.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { mockEvent, type H3Event } from "nitro/h3";
import { XMLParser, XMLValidator } from "fast-xml-parser";

import { resetConfig, setConfigForTests } from "~/config";
import { DEFAULTS } from "~/defaults";
import { getDb, resetDbForTests } from "~/db/client";
import type { StoryRow } from "~/core/edition";
import { saveArticle, type ArticleRecord } from "~/core/extract";
import { ACQUISITION_TYPE, OPENSEARCH_TYPE, REL, renderFeed } from "~/opds/atom";
import { rootFeed, searchFeed } from "~/opds/catalog";
import {
  OPENSEARCH_PATH,
  OPENSEARCH_RESULTS_PATH,
  openSearchDescription,
} from "~/opds/opensearch";
import { indexStory, indexedCount, reindexAll, unindexStory } from "~/search/indexer";
import { MAX_LIMIT, searchStories, toMatchExpression } from "~/search/query";
import { BODY_MAX_CHARS, searchBody } from "~/search/text";
import { serviceWorkerJs } from "~/web/sw";

import opdsRootRoute from "../server/routes/opds/index";
import opdsSearchRoute from "../server/routes/opds/search";
import opensearchRoute from "../server/routes/opds/opensearch.xml";
import searchPageRoute from "../server/routes/search";
import { makeTempDataDir } from "./helpers/data-dir";

const BASE = 1_755_302_400; // 2025-08-16T00:00:00Z

let dir: string;
let savedFetch: typeof globalThis.fetch;

/* -------------------------------------------------------------------------- */
/* harness                                                                    */
/* -------------------------------------------------------------------------- */

function event(path: string): H3Event {
  return mockEvent(`http://localhost${path}`);
}

async function call(handler: (ev: H3Event) => unknown, ev: H3Event): Promise<Response> {
  const result = await handler(ev);
  if (!(result instanceof Response)) {
    throw new Error(`expected a Response, got ${typeof result}`);
  }
  return result;
}

function seedEdition(date: string): void {
  getDb()
    .query(
      `INSERT OR IGNORE INTO editions
         (date, tz, start_unix, end_unix, closed_at, ingested_at, story_count, state)
       VALUES (?, 'Europe/Amsterdam', ?, ?, ?, ?, 1, 'ingested')`,
    )
    .run(date, BASE, BASE + 86400, BASE + 86400, BASE + 86400);
}

/**
 * Inserts a story directly, bypassing `ingestEdition` (which would need
 * Algolia). Indexing is explicit in these tests for the same reason: the
 * write-path wiring is asserted on its own, further down.
 */
function seedStory(over: Partial<StoryRow> = {}): StoryRow {
  const story: StoryRow = {
    id: 999_000_001,
    edition_date: "2026-08-16",
    rank: 1,
    title: "Good system design",
    url: "https://seangoedecke.com/good-system-design/",
    domain: "seangoedecke.com",
    author: "ingve",
    points: 957,
    num_comments: 208,
    created_at_i: BASE + 3600,
    story_text: null,
    is_text_post: 0,
    ...over,
  };

  seedEdition(story.edition_date);
  getDb()
    .query(
      `INSERT INTO stories (id, edition_date, rank, title, url, domain, author,
                            points, num_comments, created_at_i, story_text, is_text_post)
       VALUES ($id,$edition_date,$rank,$title,$url,$domain,$author,
               $points,$num_comments,$created_at_i,$story_text,$is_text_post)`,
    )
    .run(
      Object.fromEntries(Object.entries(story).map(([k, v]) => [`$${k}`, v])) as Record<
        string,
        string | number | null
      >,
    );

  return story;
}

function article(storyId: number, markdown: string): ArticleRecord {
  return {
    story_id: storyId,
    state: "ok",
    fetched_at: BASE + 7200,
    http_status: 200,
    final_url: "https://example.com/a",
    title: "An article",
    author: "A Writer",
    published: null,
    site: "example.com",
    language: "en",
    word_count: markdown.split(/\s+/).length,
    xhtml: `<p>${markdown}</p>`,
    markdown,
    error_code: null,
  };
}

/** A story with an extracted article, indexed through the production path. */
function seedIndexed(over: Partial<StoryRow>, markdown: string): StoryRow {
  const story = seedStory(over);
  saveArticle(article(story.id, markdown));
  return story;
}

function titles(query: string, opts?: { limit?: number; offset?: number }): string[] {
  return searchStories(query, opts).hits.map((h) => h.title);
}

/**
 * Installs a throwaway database for the enclosing describe.
 *
 * Called per describe rather than once for the file because half of what is
 * tested here - the flattener, the query rewriter, the feed builders - is pure,
 * and a fresh SQLite file per test that never opens one is the sort of cost
 * that quietly puts a suite over its time budget.
 */
function withTempDataDir(): void {
  beforeEach(() => {
    dir = makeTempDataDir("hn-opds-search-");
    setConfigForTests({ dataDir: dir });
    resetDbForTests();
  });

  afterEach(() => {
    resetDbForTests();
    resetConfig();
    rmSync(dir, { recursive: true, force: true });
  });
}

// The network guard is file-wide and costs nothing. Everything here reads
// SQLite; a route that grew a fetch would be a page that hangs on a device
// with no radio, which is the one device this exists for.
beforeEach(() => {
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    throw new Error(`search made a network request: ${String(input)}`);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = savedFetch;
});

/* -------------------------------------------------------------------------- */
/* searchBody                                                                 */
/* -------------------------------------------------------------------------- */

describe("searchBody", () => {
  test("returns empty for anything that is not text", () => {
    expect(searchBody(null)).toBe("");
    expect(searchBody(undefined)).toBe("");
    expect(searchBody("")).toBe("");
  });

  test("drops fenced code blocks whole", () => {
    const md = "Before\n\n```js\nconst secret = 1;\n```\n\nAfter";
    expect(searchBody(md)).toBe("Before After");
    expect(searchBody("a\n~~~\nzzcode\n~~~\nb")).toBe("a b");
  });

  test("drops images but keeps link text", () => {
    expect(searchBody("![alt](https://x/y.png) rest")).toBe("rest");
    expect(searchBody("see [the paper](https://x/y) now")).toBe("see the paper now");
  });

  test("handles brackets inside a label, which real alt text has", () => {
    // Observed in the wild: this shipped "![Plot of Sin[" into a search result.
    expect(searchBody("out ![Plot of Sin[x]](https://x/y.png) here")).toBe("out here");
    expect(searchBody("[the a[1] paper](https://x/y)")).toBe("the a[1] paper");
  });

  test("drops horizontal rules and setext underlines", () => {
    expect(searchBody("Examples\n---\nOutput")).toBe("Examples Output");
    expect(searchBody("a\n***\nb")).toBe("a b");
    expect(searchBody("Title\n===\nbody")).toBe("Title body");
    // A single dash is a hyphen, not a rule.
    expect(searchBody("well-known thing")).toBe("well-known thing");
  });

  test("drops bare URLs, which are never what someone searched for", () => {
    expect(searchBody("go to https://example.com/a/b?c=d now")).toBe("go to now");
    expect(searchBody("mail mailto:a@b.com ok")).toBe("mail ok");
  });

  test("strips emphasis, headings, quotes, pipes and bullets", () => {
    expect(searchBody("## Heading")).toBe("Heading");
    expect(searchBody("**bold** and _thin_")).toBe("bold and thin");
    expect(searchBody("> quoted line")).toBe("quoted line");
    expect(searchBody("- one\n- two")).toBe("one two");
    expect(searchBody("| a | b |")).toBe("a b");
  });

  test("strips leftover html and collapses whitespace", () => {
    expect(searchBody("<p>one</p>\n\n\n   two\t\tthree")).toBe("one two three");
  });

  test("caps the body and cuts on a word boundary", () => {
    const word = "kubernetes ";
    const md = word.repeat(Math.ceil((BODY_MAX_CHARS * 2) / word.length));
    const out = searchBody(md);
    expect(out.length).toBeLessThanOrEqual(BODY_MAX_CHARS);
    expect(out.length).toBeGreaterThan(BODY_MAX_CHARS - 200);
    // The cap must not leave a fragment: every token is a whole word.
    expect(out.endsWith("kubernetes")).toBe(true);
  });

  test("leaves a body under the cap exactly as it flattened", () => {
    expect(searchBody("plain prose about design")).toBe("plain prose about design");
  });
});

/* -------------------------------------------------------------------------- */
/* toMatchExpression                                                          */
/* -------------------------------------------------------------------------- */

describe("toMatchExpression", () => {
  test("quotes every word and ANDs them implicitly", () => {
    expect(toMatchExpression("system design")).toBe('"system" "design"');
  });

  test("returns null for nothing searchable", () => {
    expect(toMatchExpression("")).toBeNull();
    expect(toMatchExpression("   ")).toBeNull();
    expect(toMatchExpression("\t\n ")).toBeNull();
    expect(toMatchExpression("!!! ... ---")).toBeNull();
    expect(toMatchExpression("*")).toBeNull();
    expect(toMatchExpression(undefined)).toBeNull();
    expect(toMatchExpression(42)).toBeNull();
    expect(toMatchExpression(null)).toBeNull();
  });

  test("turns FTS5 operators into literal words", () => {
    expect(toMatchExpression("cats AND dogs")).toBe('"cats" "AND" "dogs"');
    expect(toMatchExpression("a OR b")).toBe('"a" "OR" "b"');
    expect(toMatchExpression("NOT fooled")).toBe('"NOT" "fooled"');
    expect(toMatchExpression("NEAR/3")).toBe('"NEAR/3"');
  });

  test("keeps a balanced pair of quotes as a phrase", () => {
    expect(toMatchExpression('"system design"')).toBe('"system design"');
    expect(toMatchExpression('rust "zero cost" abstractions')).toBe(
      '"rust" "zero cost" "abstractions"',
    );
  });

  test("treats an unbalanced quote as a phrase to the end of the input", () => {
    expect(toMatchExpression('"system design')).toBe('"system design"');
    expect(toMatchExpression('a "b c')).toBe('"a" "b c"');
  });

  test("normalises the curly quotes a soft keyboard produces", () => {
    expect(toMatchExpression("\u201csystem design\u201d")).toBe('"system design"');
  });

  test("applies compatibility normalisation so odd code points still match", () => {
    // Full-width latin, which a CJK keyboard produces and unicode61 stores
    // folded to plain ascii.
    expect(toMatchExpression("\uff32\uff35\uff33\uff34")).toBe('"RUST"');
  });

  test("caps the input length, the token count and the token length", () => {
    const long = "x".repeat(500);
    expect(toMatchExpression(long)).toBe(`"${"x".repeat(64)}"`);

    const many = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ");
    const expr = toMatchExpression(many) as string;
    expect(expr.split(" ")).toHaveLength(12);
    expect(expr).toContain('"w0"');
    expect(expr).not.toContain('"w12"');

    // 256 characters in, so a query padded past that contributes no tokens
    // from the tail.
    const truncated = toMatchExpression(`${"a ".repeat(200)}zzsentinel`) as string;
    expect(truncated).not.toContain("zzsentinel");
  });

  test("never emits an odd number of quotes", () => {
    const hostile = [
      '"', '""', '"""', 'a"b"c"', '"a" "b', 'x " y " z "',
    ];
    for (const raw of hostile) {
      const expr = toMatchExpression(raw);
      if (expr === null) continue;
      expect((expr.match(/"/g) ?? []).length % 2).toBe(0);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* index population                                                           */
/* -------------------------------------------------------------------------- */

describe("index population", () => {
  withTempDataDir();

  test("saving an article makes its text searchable", () => {
    seedIndexed({ id: 1, title: "Untitled" }, "A treatise on zzunique widgets.");
    expect(titles("zzunique")).toEqual(["Untitled"]);
  });

  test("a story is searchable by title before anything is extracted", () => {
    seedStory({ id: 2, title: "Kubernetes on Oxide" });
    indexStory(2);
    expect(titles("kubernetes")).toEqual(["Kubernetes on Oxide"]);
    // Nothing to quote from, and the title is already the heading of the row.
    expect(searchStories("kubernetes").hits[0]!.snippet).toBe("");
  });

  test("re-extracting replaces the row instead of adding a second", () => {
    const story = seedIndexed({ id: 3, title: "First" }, "zzalpha content here");
    expect(indexedCount()).toBe(1);

    saveArticle(article(story.id, "zzbeta content here"));

    expect(indexedCount()).toBe(1);
    expect(searchStories("zzbeta").total).toBe(1);
    // The old text is gone, not shadowed by the new row.
    expect(searchStories("zzalpha").total).toBe(0);
  });

  test("indexing the same story repeatedly is a no-op after the first", () => {
    seedIndexed({ id: 4 }, "zzidempotent");
    for (let i = 0; i < 5; i++) indexStory(4);
    expect(indexedCount()).toBe(1);
    expect(searchStories("zzidempotent").total).toBe(1);
  });

  test("indexStory reports an unknown story and leaves nothing behind", () => {
    getDb()
      .query("INSERT INTO search_fts (title, body, story_id) VALUES (?, ?, ?)")
      .run("Ghost", "zzghost", 5150);

    expect(indexStory(5150)).toBe(false);
    expect(indexedCount()).toBe(0);
  });

  test("unindexStory drops just that story", () => {
    seedIndexed({ id: 6, title: "Keep" }, "zzkeep");
    seedIndexed({ id: 7, title: "Drop" }, "zzdrop");

    unindexStory(7);

    expect(searchStories("zzkeep").total).toBe(1);
    expect(searchStories("zzdrop").total).toBe(0);
  });

  test("the body is flattened on the way in, so snippets are prose", () => {
    seedIndexed({ id: 8 }, "Look ![](https://x/y.png) at **zzflat** design");
    const snippet = searchStories("zzflat").hits[0]!.snippet;
    expect(snippet).toContain("zzflat");
    expect(snippet).not.toContain("![](");
    expect(snippet).not.toContain("**");
  });

  test("a failed extraction still leaves the story findable by title", () => {
    const story = seedStory({ id: 9, title: "Zzfailed article" });
    saveArticle({ ...article(story.id, ""), state: "failed", error_code: "network_error" });
    expect(titles("zzfailed")).toEqual(["Zzfailed article"]);
  });

  test("comments are not indexed", () => {
    const story = seedIndexed({ id: 10, title: "Quiet" }, "article body");
    getDb()
      .query(
        `INSERT INTO comments (id, story_id, parent_id, root_id, depth, sort_index,
                               author, created_at_i, text_html)
         VALUES (1, ?, NULL, 1, 0, 0, 'alice', ?, '<p>zzcommentonly</p>')`,
      )
      .run(story.id, BASE);
    indexStory(story.id);

    expect(searchStories("zzcommentonly").total).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* reindexAll                                                                 */
/* -------------------------------------------------------------------------- */

describe("reindexAll", () => {
  withTempDataDir();

  test("backfills stories that were never indexed", () => {
    // The state a database is in before this feature existed: rows in both
    // tables, nothing in the index.
    seedIndexed({ id: 11, title: "One" }, "zzbackfill one");
    seedIndexed({ id: 12, title: "Two" }, "zzbackfill two");
    getDb().query("DELETE FROM search_fts").run();
    expect(searchStories("zzbackfill").total).toBe(0);

    expect(reindexAll()).toBe(2);
    expect(searchStories("zzbackfill").total).toBe(2);
  });

  test("is idempotent, however many times it runs", () => {
    seedIndexed({ id: 13 }, "zzrepeat");
    reindexAll();
    reindexAll();
    reindexAll();
    expect(indexedCount()).toBe(1);
  });

  test("collects rows whose story has gone", () => {
    seedIndexed({ id: 14, title: "Real" }, "zzreal");
    getDb()
      .query("INSERT INTO search_fts (title, body, story_id) VALUES (?, ?, ?)")
      .run("Ghost", "zzghost", 99_999);
    expect(indexedCount()).toBe(2);

    reindexAll();

    expect(indexedCount()).toBe(1);
    expect(searchStories("zzghost").total).toBe(0);
  });

  test("scoped to one edition, it leaves the other editions alone", () => {
    seedIndexed({ id: 15, edition_date: "2026-08-15", title: "Older" }, "zzscope older");
    seedIndexed({ id: 16, edition_date: "2026-08-16", title: "Newer" }, "zzscope newer");
    getDb().query("DELETE FROM search_fts").run();

    expect(reindexAll({ date: "2026-08-16" })).toBe(1);
    expect(titles("zzscope")).toEqual(["Newer"]);
  });
});

/* -------------------------------------------------------------------------- */
/* searchStories                                                              */
/* -------------------------------------------------------------------------- */

describe("searchStories", () => {
  withTempDataDir();

  test("returns an empty result for an empty or unsearchable query", () => {
    seedIndexed({ id: 20 }, "anything at all");

    for (const raw of ["", "   ", "\n\t", "...", "***"]) {
      const results = searchStories(raw);
      expect(results.hits).toEqual([]);
      expect(results.total).toBe(0);
      expect(results.expression).toBeNull();
    }
  });

  test("echoes the trimmed query back for the form to redisplay", () => {
    expect(searchStories("  rust  ").query).toBe("rust");
  });

  test("returns zero results without failing when nothing matches", () => {
    seedIndexed({ id: 21 }, "a body about boats");
    const results = searchStories("zznothingmatches");
    expect(results.hits).toEqual([]);
    expect(results.total).toBe(0);
    expect(results.expression).toBe('"zznothingmatches"');
  });

  test("ranks a title match above a body-only match", () => {
    seedIndexed({ id: 22, title: "Notes on caching" }, "zzrank is mentioned once here");
    seedIndexed({ id: 23, title: "The zzrank problem" }, "an unrelated body about boats");

    expect(titles("zzrank")).toEqual(["The zzrank problem", "Notes on caching"]);
  });

  test("scores are bm25, so more negative sorts first", () => {
    seedIndexed({ id: 24, title: "zzscore" }, "zzscore zzscore zzscore");
    seedIndexed({ id: 25, title: "Other" }, "zzscore once");
    const hits = searchStories("zzscore").hits;
    expect(hits[0]!.score).toBeLessThan(hits[1]!.score);
    expect(hits[0]!.score).toBeLessThan(0);
  });

  test("narrows as words are added, because tokens are ANDed", () => {
    seedIndexed({ id: 26, title: "A" }, "zzalpha only");
    seedIndexed({ id: 27, title: "B" }, "zzalpha and zzbeta together");

    expect(searchStories("zzalpha").total).toBe(2);
    expect(searchStories("zzalpha zzbeta").total).toBe(1);
  });

  test("a phrase is stricter than the same words apart", () => {
    seedIndexed({ id: 28, title: "A" }, "zzphrase then later zzword");
    seedIndexed({ id: 29, title: "B" }, "zzphrase zzword adjacent");

    expect(searchStories("zzphrase zzword").total).toBe(2);
    expect(searchStories('"zzphrase zzword"').total).toBe(1);
  });

  test("the porter tokenizer matches inflections of the same word", () => {
    seedIndexed({ id: 30, title: "A" }, "the zzdesign of things");
    expect(searchStories("zzdesigns").total).toBe(1);
    expect(searchStories("zzdesigning").total).toBe(1);
  });

  test("folds case and diacritics", () => {
    seedIndexed({ id: 31, title: "Bezier curves" }, "about B\u00e9ziers and zzcurves");
    expect(searchStories("b\u00e9ziers").total).toBe(1);
    expect(searchStories("BEZIERS").total).toBe(1);
  });

  test("returns everything a result row needs", () => {
    seedIndexed(
      {
        id: 32,
        title: "Good system design",
        url: "https://seangoedecke.com/x",
        domain: "seangoedecke.com",
        author: "ingve",
        points: 957,
        num_comments: 208,
        edition_date: "2026-08-16",
        created_at_i: BASE + 3600,
      },
      "an article about zzrow layout",
    );

    const hit = searchStories("zzrow").hits[0]!;
    expect(hit).toMatchObject({
      id: 32,
      edition_date: "2026-08-16",
      title: "Good system design",
      url: "https://seangoedecke.com/x",
      domain: "seangoedecke.com",
      author: "ingve",
      points: 957,
      num_comments: 208,
      created_at_i: BASE + 3600,
    });
    expect(hit.snippet).toContain("zzrow");
  });

  test("the snippet is a window around the match, not the head of the article", () => {
    const filler = "padding ".repeat(400);
    seedIndexed({ id: 33 }, `${filler} the zzneedle appears here ${filler}`);

    const snippet = searchStories("zzneedle").hits[0]!.snippet;
    expect(snippet).toContain("zzneedle");
    expect(snippet.length).toBeLessThan(400);
    // FTS5's ellipsis marks a window taken from the middle of the document.
    expect(snippet).toContain("\u2026");
  });

  test("hides a row whose story has been deleted by retention", () => {
    seedIndexed({ id: 34, title: "Doomed" }, "zzorphan text");
    // Exactly what retention leaves if the index delete is ever skipped: the
    // story row gone, the index row still there.
    getDb().query("DELETE FROM stories WHERE id = 34").run();

    expect(indexedCount()).toBe(1);
    expect(searchStories("zzorphan").hits).toEqual([]);
    expect(searchStories("zzorphan").total).toBe(0);
  });

  test("pages with limit and offset, and totals ignore both", () => {
    for (let i = 0; i < 5; i++) {
      seedIndexed({ id: 40 + i, title: `Page ${i}`, points: 100 - i }, "zzpaged body");
    }

    const first = searchStories("zzpaged", { limit: 2, offset: 0 });
    const second = searchStories("zzpaged", { limit: 2, offset: 2 });
    const third = searchStories("zzpaged", { limit: 2, offset: 4 });

    expect(first.hits).toHaveLength(2);
    expect(second.hits).toHaveLength(2);
    expect(third.hits).toHaveLength(1);
    expect(first.total).toBe(5);
    expect(third.total).toBe(5);

    // Pages must not overlap, which needs a total order rather than just a
    // score: equal scores are broken by points then id.
    const seen = [...first.hits, ...second.hits, ...third.hits].map((h) => h.id);
    expect(new Set(seen).size).toBe(5);
  });

  test("clamps the limit and the offset", () => {
    seedIndexed({ id: 50 }, "zzclamp");

    expect(searchStories("zzclamp", { limit: 10_000 }).limit).toBe(MAX_LIMIT);
    expect(searchStories("zzclamp", { limit: 0 }).limit).toBe(1);
    expect(searchStories("zzclamp", { limit: -5 }).limit).toBe(1);
    expect(searchStories("zzclamp", { limit: 2.7 }).limit).toBe(2);
    expect(searchStories("zzclamp", { offset: -10 }).offset).toBe(0);
    expect(searchStories("zzclamp", { offset: 10_000_000 }).offset).toBeLessThanOrEqual(1000);
  });

  test("defaults the limit to the configured page size", () => {
    setConfigForTests({ dataDir: dir, searchResultLimit: 3 });
    expect(searchStories("zzunset").limit).toBe(3);
    expect(DEFAULTS.searchResultLimit).toBe(25);
  });

  test("swallows nothing: a very long query is answered, not rejected", () => {
    seedIndexed({ id: 51 }, "zzlong body");
    const results = searchStories("zzlong ".repeat(5000));
    expect(results.total).toBe(1);
  });

  /**
   * The guarantee this whole module exists for. Every one of these throws
   * `fts5: syntax error` (or worse) if handed to MATCH directly - verified
   * against this same table before the sanitiser was written.
   */
  test("no user input can produce an FTS5 syntax error", () => {
    seedIndexed({ id: 52, title: "Something" }, "a body with words in it");

    const hostile = [
      '"unbalanced',
      'unbalanced"',
      '"',
      '""',
      '"""""',
      "*",
      "**",
      "a*",
      "*a",
      "NEAR/",
      "NEAR/2",
      "NEAR(a b, 3)",
      "AND",
      "OR",
      "NOT",
      "AND OR NOT",
      "title:",
      "title:foo",
      "body:*",
      "story_id:1",
      "^",
      "^foo",
      "-",
      "--",
      "+",
      "()",
      "(",
      ")",
      "(a OR b) AND c",
      "{a b}",
      "[a]",
      ":",
      "::",
      ",",
      ";",
      "\\",
      "%",
      "'",
      "''",
      "' OR 1=1 --",
      "'; DROP TABLE stories; --",
      "\u0000",
      "\u2018smart\u2019",
      "\u201csmart\u201d",
      "a\nb",
      "a\tb",
      "   ",
      "\uFFFD",
      "\ud83d\ude00",
      "e\u0301",
      "x".repeat(1000),
      '"'.repeat(50),
      "*".repeat(50),
      "( ".repeat(50),
      "NEAR ".repeat(50),
      "a:b:c:d",
      "foo AND (bar OR baz) NOT qux",
      "column:value AND other:*",
    ];

    for (const raw of hostile) {
      expect(() => searchStories(raw)).not.toThrow();
    }

    // Random punctuation soup, for the cases nobody thought to list.
    const alphabet = ' "*():^-+.,;\'\\/{}[]<>|&!?~`#@$%=_\n\tabcXY';
    for (let i = 0; i < 200; i++) {
      let raw = "";
      const length = 1 + Math.floor(Math.random() * 24);
      for (let j = 0; j < length; j++) {
        raw += alphabet[Math.floor(Math.random() * alphabet.length)];
      }
      expect(() => searchStories(raw)).not.toThrow();
    }
  });

  test("a hostile query cannot reach the database as SQL either", () => {
    seedIndexed({ id: 53 }, "zzinjection");
    searchStories("'; DROP TABLE stories; --");
    expect(getDb().query("SELECT count(*) AS n FROM stories").get()).toEqual({ n: 1 });
  });
});

/* -------------------------------------------------------------------------- */
/* the web page                                                               */
/* -------------------------------------------------------------------------- */

describe("GET /search", () => {
  withTempDataDir();

  test("renders the form with no query at all", async () => {
    const res = await call(searchPageRoute, event("/search"));
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain('action="/search"');
    expect(html).toContain('name="q"');
    expect(html).toContain("Comments are not indexed.");
  });

  test("the form is a plain GET, which is what makes it work with no script", async () => {
    const html = await (await call(searchPageRoute, event("/search?q=rust"))).text();
    const form = html.slice(html.indexOf("<form"), html.indexOf("</form>"));

    expect(form).toMatch(/method="(get|GET)"/);
    expect(form).not.toContain("onsubmit");
    expect(form).not.toContain("<script");
    expect(form).not.toContain("oninput");
  });

  test("finds a story and links it", async () => {
    seedIndexed({ id: 60, title: "Rust SIMD on the GPU" }, "portable simd for zzgpu work");

    const html = await (await call(searchPageRoute, event("/search?q=zzgpu"))).text();
    expect(html).toContain("Rust SIMD on the GPU");
    expect(html).toContain('href="/story/60"');
    expect(html).toContain("zzgpu");
    expect(html).toContain("1 result");
  });

  test("says so when nothing matches", async () => {
    const html = await (await call(searchPageRoute, event("/search?q=zznothing"))).text();
    expect(html).toContain("Nothing in the archive matches");
    expect(html).toContain("zznothing");
  });

  test("echoes the query into the field so it can be edited, not retyped", async () => {
    const html = await (await call(searchPageRoute, event("/search?q=system+design"))).text();
    expect(html).toContain('value="system design"');
  });

  test("escapes the query everywhere it is echoed", async () => {
    const html = await (
      await call(searchPageRoute, event(`/search?q=${encodeURIComponent('<script>alert(1)</script>')}`))
    ).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("offers paging only when there is another page", async () => {
    setConfigForTests({ dataDir: dir, searchResultLimit: 2 });
    for (let i = 0; i < 5; i++) {
      seedIndexed({ id: 70 + i, title: `Paged ${i}` }, "zzpager body text");
    }

    const first = await (await call(searchPageRoute, event("/search?q=zzpager"))).text();
    expect(first).toContain("offset=2");
    expect(first).toContain("Next");
    expect(first).not.toContain(">Previous<");
    expect(first).toContain("1\u20132 of 5 results");

    const last = await (
      await call(searchPageRoute, event("/search?q=zzpager&offset=4"))
    ).text();
    expect(last).toContain("Previous");
    expect(last).not.toContain(">Next<");
  });

  test("ignores a junk offset rather than failing", async () => {
    seedIndexed({ id: 80, title: "Junk offset" }, "zzjunk body");
    for (const offset of ["abc", "-1", "1.5", "", "9999999999999999999999"]) {
      const res = await call(
        searchPageRoute,
        event(`/search?q=zzjunk&offset=${encodeURIComponent(offset)}`),
      );
      expect(res.status).toBe(200);
    }
  });

  test("is never cached, because the index grows nightly", async () => {
    const res = await call(searchPageRoute, event("/search?q=x"));
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  test("stays out of search engines, like every other page", async () => {
    const html = await (await call(searchPageRoute, event("/search?q=x"))).text();
    expect(html).toContain('name="robots"');
    expect(html).toContain("noindex");
  });

  test("marks Search as the current section", async () => {
    const html = await (await call(searchPageRoute, event("/search"))).text();
    expect(html).toContain('<a href="/search" aria-current="page">Search</a>');
  });

  test("reaches the search page from every other page", async () => {
    // The nav is rendered by the shell, so one page is enough to prove the
    // entry exists; this is the assertion that fails if it is removed again.
    const html = await (await call(searchPageRoute, event("/search"))).text();
    expect(html).toContain('href="/search"');
  });
});

/* -------------------------------------------------------------------------- */
/* the service worker                                                         */
/* -------------------------------------------------------------------------- */

describe("service worker and /search", () => {
  test("does not bypass /search, so an offline reader gets their last results", () => {
    const src = serviceWorkerJs({ version: "v1", precache: [] });
    const build = new Function(`${src.slice(src.indexOf("function isBypassed"))}
      ; return isBypassed;`);
    const isBypassed = build() as (path: string) => boolean;

    expect(isBypassed("/search")).toBe(false);
    // The neighbours it must not be confused with.
    expect(isBypassed("/opds/search")).toBe(true);
    expect(isBypassed("/settings")).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* OPDS: the description document                                             */
/* -------------------------------------------------------------------------- */

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

function expectWellFormed(xml: string, label: string): void {
  const result = XMLValidator.validate(xml);
  if (result !== true) {
    throw new Error(`${label} is not well-formed: ${JSON.stringify(result.err)}\n${xml}`);
  }
}

describe("openSearchDescription", () => {
  const xml = openSearchDescription("https://hn.example.com");

  test("is well-formed and in the OpenSearch 1.1 namespace", () => {
    expectWellFormed(xml, "opensearch description");
    expect(xml).toContain('xmlns="http://a9.com/-/spec/opensearch/1.1/"');
  });

  test("declares a template that a reader can substitute into", () => {
    const doc = parser.parse(xml) as {
      OpenSearchDescription: { Url: { "@_template": string; "@_type": string } };
    };
    const url = doc.OpenSearchDescription.Url;
    expect(url["@_template"]).toBe(
      `https://hn.example.com${OPENSEARCH_RESULTS_PATH}?q={searchTerms}`,
    );
    expect(url["@_type"]).toBe(ACQUISITION_TYPE);
  });

  test("keeps ShortName inside the 16 characters OpenSearch allows", () => {
    const doc = parser.parse(xml) as {
      OpenSearchDescription: { ShortName: string };
    };
    expect(doc.OpenSearchDescription.ShortName.length).toBeLessThanOrEqual(16);
  });

  test("uses an absolute template, since the document is cached apart from the feed", () => {
    expect(xml).toContain("https://hn.example.com/opds/search");
  });

  test("declares no optional parameters a client might leave unsubstituted", () => {
    const braces = xml.match(/\{[^}]*\}/g) ?? [];
    expect(braces).toEqual(["{searchTerms}"]);
  });
});

/* -------------------------------------------------------------------------- */
/* OPDS: feeds                                                                */
/* -------------------------------------------------------------------------- */

describe("rootFeed search link", () => {
  const feed = rootFeed(BASE, "https://hn.example.com");

  test("advertises the description document with rel=search", () => {
    const link = feed.links.find((l) => l.rel === REL.search);
    expect(link).toBeDefined();
    expect(link!.type).toBe(OPENSEARCH_TYPE);
    expect(link!.href).toBe(`https://hn.example.com${OPENSEARCH_PATH}`);
  });

  test("keeps search a link rather than an entry", () => {
    expect(feed.entries.map((e) => e.title)).toEqual(["Today", "Archive"]);
  });

  test("still renders as well-formed XML", () => {
    expectWellFormed(renderFeed(feed), "root feed");
  });
});

describe("searchFeed", () => {
  function results(count: number, over: Partial<{ total: number; limit: number; offset: number }> = {}) {
    const hits = Array.from({ length: count }, (_, i) => ({
      id: 900 + i,
      edition_date: "2026-08-16",
      title: `Result ${i}`,
      url: `https://example.com/${i}`,
      domain: "example.com",
      author: "alice",
      points: 10 + i,
      num_comments: i,
      created_at_i: BASE + i,
      snippet: `a passage mentioning rust number ${i}`,
      score: -1 - i,
    }));
    return {
      query: "rust",
      expression: '"rust"',
      hits,
      total: over.total ?? count,
      limit: over.limit ?? 25,
      offset: over.offset ?? 0,
    };
  }

  test("is a well-formed acquisition feed", () => {
    const xml = renderFeed(searchFeed(results(2), "https://hn.example.com"));
    expectWellFormed(xml, "search feed");
    expect(xml).toContain("urn:hn:story:900");
    expect(xml).toContain("http://opds-spec.org/acquisition/open-access");
    expect(xml).toContain("/epub/story/900.epub");
  });

  test("publishes the OpenSearch counts a reader needs to page", () => {
    const xml = renderFeed(
      searchFeed(results(25, { total: 60, limit: 25, offset: 25 }), "https://hn.example.com"),
    );
    expect(xml).toContain("<opensearch:totalResults>60</opensearch:totalResults>");
    // 1-based, unlike the offset in the URL.
    expect(xml).toContain("<opensearch:startIndex>26</opensearch:startIndex>");
    expect(xml).toContain("<opensearch:itemsPerPage>25</opensearch:itemsPerPage>");
    expect(xml).toContain('xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"');
  });

  test("links next only when there is a next page", () => {
    const middle = searchFeed(results(25, { total: 60, limit: 25, offset: 0 }));
    expect(middle.links.find((l) => l.rel === REL.next)?.href).toContain("offset=25");
    expect(middle.links.find((l) => l.rel === REL.prev)).toBeUndefined();

    const end = searchFeed(results(10, { total: 60, limit: 25, offset: 50 }));
    expect(end.links.find((l) => l.rel === REL.next)).toBeUndefined();
    expect(end.links.find((l) => l.rel === REL.prev)?.href).toContain("offset=25");
  });

  test("carries the query in its self link so a refresh repeats the search", () => {
    const feed = searchFeed(results(1), "https://hn.example.com");
    const self = feed.links.find((l) => l.rel === REL.self)!;
    expect(self.href).toBe("https://hn.example.com/opds/search?q=rust&limit=25");
    expect(self.type).toBe(ACQUISITION_TYPE);
  });

  test("keeps start, up and search links so a reader is never stranded", () => {
    const rels = searchFeed(results(1)).links.map((l) => l.rel);
    expect(rels).toContain(REL.start);
    expect(rels).toContain(REL.up);
    expect(rels).toContain(REL.search);
  });

  test("survives an empty result set", () => {
    const feed = searchFeed(results(0, { total: 0 }));
    expectWellFormed(renderFeed(feed), "empty search feed");
    expect(feed.entries).toHaveLength(0);
    expect(feed.links.find((l) => l.rel === REL.next)).toBeUndefined();
  });

  test("escapes a query with XML metacharacters in it", () => {
    const feed = searchFeed({ ...results(0, { total: 0 }), query: 'a & b <c> "d"' });
    const xml = renderFeed(feed);
    expectWellFormed(xml, "escaped search feed");
    expect(xml).toContain("a &amp; b &lt;c&gt;");
  });

  test("keeps the feed id a legal IRI whatever was typed", () => {
    const feed = searchFeed({ ...results(0, { total: 0 }), query: 'a & b <c> "d"' });
    expect(feed.id).toBe("urn:hacker-opds:search:a%20%26%20b%20%3Cc%3E%20%22d%22");
    expect(feed.id).not.toMatch(/\s/);
    // Distinct searches keep distinct ids, which is what readers dedupe on.
    expect(searchFeed(results(1)).id).not.toBe(feed.id);
  });

  test("dates the feed from the results, not the clock", () => {
    const a = searchFeed(results(3));
    const b = searchFeed(results(3));
    expect(a.updated).toBe(b.updated);
  });
});

/* -------------------------------------------------------------------------- */
/* OPDS: routes                                                               */
/* -------------------------------------------------------------------------- */

describe("GET /opds/opensearch.xml", () => {
  test("serves the description under the type readers look for", async () => {
    const res = await call(opensearchRoute, event(OPENSEARCH_PATH));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(`${OPENSEARCH_TYPE}; charset=utf-8`);
    expectWellFormed(await res.text(), "served description");
  });

  test("templates against the origin the request arrived on", async () => {
    const xml = await (await call(opensearchRoute, event(OPENSEARCH_PATH))).text();
    expect(xml).toContain("http://localhost/opds/search?q={searchTerms}");
  });

  test("is cached for a day, since it describes the interface not the data", async () => {
    const res = await call(opensearchRoute, event(OPENSEARCH_PATH));
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
  });
});

describe("GET /opds/search", () => {
  withTempDataDir();

  test("answers with an acquisition feed of matching stories", async () => {
    seedIndexed({ id: 100, title: "Zzfeed story" }, "a body about zzfeed things");

    const res = await call(opdsSearchRoute, event("/opds/search?q=zzfeed"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(`${ACQUISITION_TYPE}; charset=utf-8`);

    const xml = await res.text();
    expectWellFormed(xml, "opds search results");
    expect(xml).toContain("Zzfeed story");
    expect(xml).toContain("urn:hn:story:100");
    expect(xml).toContain("/epub/story/100.epub");
  });

  test("answers an empty query with an empty feed, not a 404", async () => {
    const res = await call(opdsSearchRoute, event("/opds/search?q="));
    expect(res.status).toBe(200);
    const xml = await res.text();
    expectWellFormed(xml, "empty opds search");
    expect(xml).toContain("<opensearch:totalResults>0</opensearch:totalResults>");
  });

  test("answers a missing q the same way, since readers probe the template", async () => {
    const res = await call(opdsSearchRoute, event("/opds/search"));
    expect(res.status).toBe(200);
  });

  test("survives a hostile query without a 500", async () => {
    for (const q of ['"', "*", "NEAR/", "title:", "'; DROP TABLE stories; --"]) {
      const res = await call(
        opdsSearchRoute,
        event(`/opds/search?q=${encodeURIComponent(q)}`),
      );
      expect(res.status).toBe(200);
    }
  });

  test("honours limit and offset so its own paging links round-trip", async () => {
    for (let i = 0; i < 4; i++) {
      seedIndexed({ id: 110 + i, title: `Zzpage ${i}` }, "zzpage body");
    }

    const xml = await (
      await call(opdsSearchRoute, event("/opds/search?q=zzpage&limit=2&offset=0"))
    ).text();
    expect(xml).toContain("<opensearch:itemsPerPage>2</opensearch:itemsPerPage>");
    expect(xml).toContain("<opensearch:totalResults>4</opensearch:totalResults>");
    expect((xml.match(/<entry>/g) ?? [])).toHaveLength(2);
    expect(xml).toContain("offset=2");
  });

  test("keeps every catalogue link on the origin the reader connected to", async () => {
    seedIndexed({ id: 120, title: "Zzorigin" }, "zzorigin body");
    const xml = await (
      await call(opdsSearchRoute, event("/opds/search?q=zzorigin"))
    ).text();

    // The failure this guards is a feed that loads and whose every link then
    // dies on the device. Third-party alternates are exempt by design.
    for (const [, href] of xml.matchAll(/rel="(?:self|start|up|next|previous|search)" href="([^"]+)"/g)) {
      expect(href).toStartWith("http://localhost/");
    }
  });

  test("the root feed's search link resolves to a real route", async () => {
    const rootXml = await (await call(opdsRootRoute, event("/opds"))).text();
    const match = rootXml.match(/rel="search" href="([^"]+)"/);
    expect(match).not.toBeNull();
    expect(new URL(match![1] as string).pathname).toBe(OPENSEARCH_PATH);

    const res = await call(opensearchRoute, event(OPENSEARCH_PATH));
    expect(res.status).toBe(200);
  });
});
