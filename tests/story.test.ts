import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { XMLValidator } from "fast-xml-parser";

import { resetConfig, setConfigForTests } from "~/config";
import { getDb, resetDbForTests } from "~/db/client";
import type { CommentNode } from "~/core/tree";
import { saveComments, flattenComments } from "~/core/comments";
import type { StoryRow } from "~/core/edition";
import { getArticle } from "~/core/extract";
import { getBuild } from "~/build/artifacts";
import { buildStoryEpub, composeStoryEpub, seriesIndex, BuildError } from "~/build/story";
import { resetQueueForTests } from "~/build/queue";
import { installHttpCache, type HttpCacheHandle } from "./helpers/http-cache";
import { makeTempDataDir } from "./helpers/data-dir";
import { restoreCoverScale, useSmallCovers } from "./helpers/covers";

/**
 * Everything here runs offline. A story with `url: null` routes through
 * `textPostArticle` (no fetch), and `ensureComments` skips the network when
 * `num_comments <= 0`. Comment-bearing cases are seeded straight into SQLite.
 *
 * The linked-story cases are the exception: they route through `extractArticle`
 * and really do fetch. Those are served from the committed HTTP fixtures, and
 * the cache is installed for the whole file so that any *other* case that
 * starts reaching for the network fails loudly instead of going quiet and slow.
 */

let dir: string;
let http: HttpCacheHandle;

const BASE = 1_755_302_400; // 2025-08-16T00:00:00Z

function seedEdition(date = "2026-08-16"): void {
  getDb()
    .query(
      `INSERT INTO editions (date, tz, start_unix, end_unix, closed_at, ingested_at, story_count, state)
       VALUES (?, 'Europe/Amsterdam', ?, ?, ?, ?, 1, 'ingested')`,
    )
    .run(date, BASE, BASE + 86400, BASE + 86400, BASE + 86400);
}

function seedStory(over: Partial<StoryRow> = {}): StoryRow {
  const story: StoryRow = {
    // Deliberately not a real HN id. If a seeding bug ever makes the build
    // fall through to Algolia, the request must fail rather than silently
    // pull real comments into the assertions.
    id: 999_999_999,
    edition_date: "2026-08-16",
    rank: 3,
    title: "Ask HN: What are you working on?",
    url: null,
    domain: null,
    author: "pg",
    points: 412,
    num_comments: 0,
    created_at_i: BASE + 3600,
    story_text: "<p>Tell us what you built.<p>Links welcome & appreciated.",
    is_text_post: 1,
    ...over,
  };

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

async function openEpub(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes);
  const text = async (p: string) => {
    const f = zip.file(p);
    if (!f) throw new Error(`missing zip entry: ${p}`);
    return f.async("string");
  };
  return { zip, text, names: Object.keys(zip.files) };
}

function expectWellFormed(xml: string, label: string): void {
  const res = XMLValidator.validate(xml);
  if (res !== true) throw new Error(`${label} is not well-formed: ${JSON.stringify(res)}`);
}

beforeEach(() => {
  dir = makeTempDataDir("hn-opds-story-");
  // perDomainDelayMs is zeroed because `politeSlot` parks a real timer after
  // every request; replayed fixtures make the politeness gap pure dead time.
  setConfigForTests({ dataDir: dir, perDomainDelayMs: 0 });
  http = installHttpCache();
  resetDbForTests();
  resetQueueForTests();
  useSmallCovers();
  seedEdition();
});

afterEach(() => {
  // Every request the build made must have been answered from disk. A miss
  // throws, but `extractArticle` converts any fetch error into a stub record,
  // so without this an escape attempt could still pass unnoticed.
  if (process.env.FIXTURES_RECORD !== "1") {
    expect(http.calls).toEqual([...http.hits]);
    expect(http.recorded).toEqual([]);
  }
  http.restore();
  restoreCoverScale();
  resetDbForTests();
  resetConfig();
  rmSync(dir, { recursive: true, force: true });
});

describe("seriesIndex", () => {
  test("packs the edition date and rank into a sortable string", () => {
    expect(seriesIndex("2026-08-16", 3)).toBe("20260816.03");
  });

  test("zero-pads rank so 10 sorts after 1", () => {
    expect(seriesIndex("2026-08-16", 1)).toBe("20260816.01");
    expect(seriesIndex("2026-08-16", 10)).toBe("20260816.10");
    // The whole point of the string form: as floats these would collide.
    expect(seriesIndex("2026-08-16", 1)).not.toBe(seriesIndex("2026-08-16", 10));
  });

  test("orders lexically by date then rank", () => {
    const got = [
      seriesIndex("2026-08-17", 1),
      seriesIndex("2026-08-16", 10),
      seriesIndex("2026-08-16", 2),
    ].sort();
    expect(got).toEqual(["20260816.02", "20260816.10", "20260817.01"]);
  });
});

describe("composeStoryEpub - text post with no comments", () => {
  test("produces a valid EPUB entirely offline", async () => {
    const story = seedStory();
    const bytes = await composeStoryEpub(story);

    expect(bytes.byteLength).toBeGreaterThan(0);
    // OCF: the archive must begin with a local file header.
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);

    const { names } = await openEpub(bytes);
    expect(names).toContain("mimetype");
    expect(names).toContain("META-INF/container.xml");
    expect(names).toContain("OEBPS/content.opf");
    expect(names).toContain("OEBPS/frontmatter.xhtml");
    expect(names).toContain("OEBPS/article.xhtml");
    expect(names).toContain("OEBPS/style.css");
  });

  test("renders the story text as the article chapter", async () => {
    const story = seedStory();
    const { text } = await openEpub(await composeStoryEpub(story));
    const article = await text("OEBPS/article.xhtml");

    expectWellFormed(article, "article.xhtml");
    expect(article).toContain("Tell us what you built.");
    // HN's unclosed <p> must be repaired on the way in.
    expect(article).toContain("</p>");
    // And the bare ampersand must be escaped rather than emitted raw.
    expect(article).not.toMatch(/&(?![a-z#])/i);
  });

  test("does not emit a failure stub for a text post", async () => {
    const story = seedStory();
    const { text } = await openEpub(await composeStoryEpub(story));
    const article = await text("OEBPS/article.xhtml");
    expect(article).not.toContain("Article text unavailable");
  });

  test("front matter carries the story facts and both links", async () => {
    const story = seedStory();
    const { text } = await openEpub(await composeStoryEpub(story));
    const fm = await text("OEBPS/frontmatter.xhtml");

    expectWellFormed(fm, "frontmatter.xhtml");
    expect(fm).toContain("412");
    expect(fm).toContain("pg");
    expect(fm).toContain("news.ycombinator.com/item?id=999999999");
  });

  test("substitutes a placeholder chapter when there are no comments", async () => {
    const story = seedStory();
    const { names, text } = await openEpub(await composeStoryEpub(story));

    expect(names).toContain("OEBPS/comments.xhtml");
    expect(names.some((n) => n.startsWith("OEBPS/thread-"))).toBe(false);
    expectWellFormed(await text("OEBPS/comments.xhtml"), "comments.xhtml");
  });

  test("writes the expected package metadata", async () => {
    const story = seedStory();
    const { text } = await openEpub(await composeStoryEpub(story));
    const opf = await text("OEBPS/content.opf");

    expectWellFormed(opf, "content.opf");
    expect(opf).toContain("urn:hn:story:999999999");
    expect(opf).toContain("Ask HN: What are you working on?");
    expect(opf).toContain(">pg<");
    expect(opf).toContain("Hacker News");
    expect(opf).toContain('name="calibre:series"');
    expect(opf).toContain('content="20260816.03"');
    expect(opf).toContain('name="hn:score" content="412"');
    expect(opf).toContain('name="hn:rank" content="3"');
    expect(opf).toContain('name="hn:edition" content="2026-08-16"');
  });

  test("is deterministic for identical inputs", async () => {
    const story = seedStory();
    const a = await composeStoryEpub(story);
    const b = await composeStoryEpub(story);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  test("carries a cover, declared both ways", async () => {
    const story = seedStory();
    const { names, text } = await openEpub(await composeStoryEpub(story));

    expect(names).toContain("OEBPS/cover.png");
    const opf = await text("OEBPS/content.opf");
    // EPUB 3 readers look for the manifest property, EPUB 2 ones for the meta.
    expect(opf).toContain('properties="cover-image"');
    expect(opf).toContain('name="cover" content="cover"');
  });

  test("records the cover as an asset the story depends on", async () => {
    const story = seedStory();
    await composeStoryEpub(story);

    const rows = getDb()
      .query<{ sha256: string }, [number]>(
        `SELECT a.sha256 FROM story_assets s JOIN assets a ON a.sha256 = s.sha256
          WHERE s.story_id = ? AND a.kind = 'cover'`,
      )
      .all(story.id);
    // Without the reference, retention's orphan sweep would delete the blob out
    // from under a book that embeds it.
    expect(rows).toHaveLength(1);
  });
});

describe("composeStoryEpub - book author", () => {
  /**
   * Asserts the article was really fetched and extracted.
   *
   * `extractArticle` turns any fetch failure into a stub record rather than
   * throwing, so without this the linked-story cases below would pass just as
   * happily on a failed fetch as on a successful one -- which is exactly how
   * they behaved when they were still hitting the live network. This makes the
   * committed HTTP fixture load-bearing: delete it and these tests fail.
   */
  function expectExtracted(storyId: number): void {
    const article = getArticle(storyId);
    expect(article).not.toBeNull();
    expect(article!.error_code).toBeNull();
    expect(article!.state).toBe("ok");
    expect(article!.word_count).toBeGreaterThan(100);
  }

  test("uses the source domain as dc:creator for a linked story", async () => {
    const story = seedStory({
      title: "Good system design",
      url: "https://seangoedecke.com/good-system-design/",
      domain: "seangoedecke.com",
      author: "tosh",
      is_text_post: 0,
      story_text: null,
      num_comments: 0,
    });

    const { text } = await openEpub(await composeStoryEpub(story));
    const opf = await text("OEBPS/content.opf");

    expectExtracted(story.id);
    expect(opf).toContain("<dc:creator>seangoedecke.com</dc:creator>");
    // The submitter is not the author of a linked article, so the username
    // must not leak into the bookshelf attribution.
    expect(opf).not.toContain("<dc:creator>tosh</dc:creator>");
  });

  test("still credits the submitter on a self-post", async () => {
    const story = seedStory();
    const { text } = await openEpub(await composeStoryEpub(story));
    expect(await text("OEBPS/content.opf")).toContain("<dc:creator>pg</dc:creator>");
  });

  test("front matter still records who submitted the linked story", async () => {
    const story = seedStory({
      url: "https://seangoedecke.com/good-system-design/",
      domain: "seangoedecke.com",
      author: "tosh",
      is_text_post: 0,
      story_text: null,
      num_comments: 0,
    });

    const { text } = await openEpub(await composeStoryEpub(story));
    expectExtracted(story.id);
    expect(await text("OEBPS/frontmatter.xhtml")).toContain("submitted by tosh");
  });
});

describe("composeStoryEpub - with comments", () => {
  function seedThreads(storyId: number) {
    // `type` is load-bearing: flattenComments only emits a row when a node is
    // tagged `type: "comment"`. Omitting it silently yields zero rows, which
    // makes ensureComments fall through to the live Algolia API.
    const tree: CommentNode = {
      id: storyId,
      type: "story",
      author: "submitter",
      text: null,
      created_at_i: BASE,
      children: [
        {
          id: 1,
          type: "comment",
          author: "alice",
          text: "<p>First root thought.",
          created_at_i: BASE + 4000,
          children: [
            {
              id: 2,
              type: "comment",
              author: "bob",
              text: "<p>A reply.",
              created_at_i: BASE + 4200,
              children: [],
            },
          ],
        },
        {
          id: 3,
          type: "comment",
          author: "carol",
          text: "<p>Second root thought.",
          created_at_i: BASE + 5000,
          children: [],
        },
        {
          id: 4,
          type: "comment",
          author: "dave",
          text: "[flagged]",
          created_at_i: BASE + 5500,
          children: [],
        },
      ],
    };
    saveComments(storyId, flattenComments(storyId, tree));
  }

  test("emits one chapter per surviving root thread", async () => {
    const story = seedStory({ num_comments: 4 });
    seedThreads(story.id);

    const { names } = await openEpub(await composeStoryEpub(story));
    const threads = names.filter((n) => /^OEBPS\/thread-\d{3}\.xhtml$/.test(n)).sort();

    // The [flagged] root is dropped, leaving alice and carol.
    expect(threads).toEqual(["OEBPS/thread-000.xhtml", "OEBPS/thread-001.xhtml"]);
    expect(names).not.toContain("OEBPS/comments.xhtml");
  });

  test("keeps replies with their root and marks depth", async () => {
    const story = seedStory({ num_comments: 4 });
    seedThreads(story.id);

    const { text } = await openEpub(await composeStoryEpub(story));
    const first = await text("OEBPS/thread-000.xhtml");

    expectWellFormed(first, "thread-000.xhtml");
    expect(first).toContain("alice");
    expect(first).toContain("First root thought.");
    expect(first).toContain("bob");
    expect(first).toContain("A reply.");
    expect(first).toContain("L1"); // the reply's depth marker
    expect(first).toContain('id="c1"');
    expect(first).toContain('id="c2"');

    const second = await text("OEBPS/thread-001.xhtml");
    expect(second).toContain("carol");
    expect(second).not.toContain("alice");
  });

  test("omits flagged comments entirely", async () => {
    const story = seedStory({ num_comments: 4 });
    seedThreads(story.id);

    const { zip } = await openEpub(await composeStoryEpub(story));
    const all = await Promise.all(
      Object.keys(zip.files)
        .filter((n) => n.endsWith(".xhtml"))
        .map((n) => zip.file(n)!.async("string")),
    );
    expect(all.join("\n")).not.toContain("[flagged]");
  });

  test("gives every root thread its own TOC entry", async () => {
    const story = seedStory({ num_comments: 4 });
    seedThreads(story.id);

    const { text } = await openEpub(await composeStoryEpub(story));
    const nav = await text("OEBPS/nav.xhtml");

    expectWellFormed(nav, "nav.xhtml");
    expect(nav).toContain("thread-000.xhtml");
    expect(nav).toContain("thread-001.xhtml");
    // Thread labels are "<author>: <snippet>".
    expect(nav).toContain("alice");
    expect(nav).toContain("carol");
  });

  test("orders the spine front matter, article, then threads", async () => {
    const story = seedStory({ num_comments: 4 });
    seedThreads(story.id);

    const { text } = await openEpub(await composeStoryEpub(story));
    const opf = await text("OEBPS/content.opf");
    const spine = opf.slice(opf.indexOf("<spine"));
    const order = [...spine.matchAll(/idref="([^"]+)"/g)].map((m) => m[1]);

    expect(order[0]).toContain("frontmatter");
    expect(order[1]).toContain("article");
    expect(order.slice(2).every((id) => id!.includes("thread"))).toBe(true);
    // The stylesheet is a manifest item only, never a spine item.
    expect(order.some((id) => id!.includes("css"))).toBe(false);
  });
});

describe("buildStoryEpub", () => {
  test("writes the artifact and records it as ready", async () => {
    const story = seedStory();
    const row = await buildStoryEpub(story.id);

    expect(row.state).toBe("ready");
    expect(row.kind).toBe("story");
    expect(row.build_key).toBe(String(story.id));
    expect(row.path).toContain(`story-${story.id}.epub`);
    expect(row.bytes).toBeGreaterThan(0);
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await Bun.file(row.path!).exists()).toBe(true);
  });

  test("the written bytes match the recorded size and digest", async () => {
    const story = seedStory();
    const row = await buildStoryEpub(story.id);

    const bytes = new Uint8Array(await Bun.file(row.path!).arrayBuffer());
    expect(bytes.byteLength).toBe(row.bytes!);
    expect(Bun.CryptoHasher.hash("sha256", bytes, "hex")).toBe(row.sha256!);
  });

  test("reuses the existing artifact on a second call", async () => {
    const story = seedStory();
    const first = await buildStoryEpub(story.id);
    const second = await buildStoryEpub(story.id);

    expect(second.sha256).toBe(first.sha256);
    expect(second.finished_at).toBe(first.finished_at);
  });

  test("force rebuilds even when a usable artifact exists", async () => {
    const story = seedStory();
    const first = await buildStoryEpub(story.id);
    // `finished_at` is second-resolution, so a second build in the same second
    // would land on the same value. Backdating the ledger row is equivalent to
    // waiting a second and costs nothing.
    getDb()
      .query("UPDATE builds SET finished_at = finished_at - 60 WHERE kind = 'story' AND build_key = ?")
      .run(String(story.id));
    const backdated = getBuild("story", story.id)!;

    const second = await buildStoryEpub(story.id, { force: true });

    expect(backdated.finished_at).not.toBe(first.finished_at); // guard the setup
    expect(second.finished_at).not.toBe(backdated.finished_at);
    // Same input, so the bytes are unchanged - only the ledger moved.
    expect(second.sha256).toBe(first.sha256);
  });

  test("rebuilds when the blob has gone missing", async () => {
    const story = seedStory();
    const first = await buildStoryEpub(story.id);
    rmSync(first.path!);

    const second = await buildStoryEpub(story.id);
    expect(second.state).toBe("ready");
    expect(await Bun.file(second.path!).exists()).toBe(true);
  });

  test("coalesces concurrent builds of the same story", async () => {
    const story = seedStory();
    const [a, b, c] = await Promise.all([
      buildStoryEpub(story.id),
      buildStoryEpub(story.id),
      buildStoryEpub(story.id),
    ]);

    expect(a.sha256).toBe(b.sha256);
    expect(b.sha256).toBe(c.sha256);
    expect(a.finished_at).toBe(c.finished_at);
  });

  test("throws a typed error for an unknown story", async () => {
    await expect(buildStoryEpub(999_999)).rejects.toBeInstanceOf(BuildError);
    await expect(buildStoryEpub(999_999)).rejects.toMatchObject({ code: "unknown_story" });
  });

  test("leaves no build row behind for an unknown story", async () => {
    await expect(buildStoryEpub(999_999)).rejects.toThrow();
    expect(getBuild("story", 999_999)).toBeNull();
  });
});

describe("composeStoryEpub - comment source failure", () => {
  /**
   * There is exactly one comment source now, so an unparseable item page has
   * nowhere to fall through to. It must fail the build rather than quietly
   * produce a book whose comments have vanished -- that would be indexed,
   * cached and served as though it were complete.
   */
  test("fails the build when the item page parses to zero comments", async () => {
    const story = seedStory({ num_comments: 5 });
    const stub = (async () =>
      new Response("<html><body>redesigned</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;
    const saved = globalThis.fetch;
    globalThis.fetch = stub;
    try {
      await expect(composeStoryEpub(story)).rejects.toMatchObject({
        name: "BuildError",
        code: "comment_parse_failed",
      });
    } finally {
      globalThis.fetch = saved;
    }
  });
});
