/**
 * The edition digest: one EPUB per day.
 *
 * Runs entirely offline. Every story here is a text post (no article fetch) and
 * every comment tree is seeded straight into SQLite, so `ensureArticle` and
 * `ensureComments` are cache hits; `globalThis.fetch` is replaced with one that
 * throws, so an accidental network call fails the test instead of quietly
 * slowing the suite down.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import JSZip from "jszip";
import { XMLValidator } from "fast-xml-parser";
import { mockEvent, HTTPError, type H3Event } from "nitro/h3";

import { resetConfig, setConfigForTests } from "~/config";
import { getDb, resetDbForTests } from "~/db/client";
import { flattenComments, saveComments } from "~/core/comments";
import type { CommentNode } from "~/core/tree";
import type { StoryRow } from "~/core/edition";
import { getBuild } from "~/build/artifacts";
import {
  buildEditionEpub,
  composeEditionEpub,
  editionClock,
  editionIdentifier,
  editionsNeedingDigest,
} from "~/build/edition";
import { BuildError } from "~/build/story";
import { resetQueueForTests } from "~/build/queue";

import { makeTempDataDir } from "./helpers/data-dir";
import { restoreCoverScale, useSmallCovers } from "./helpers/covers";

import editionEpubRoute from "../server/routes/epub/edition/[file]";

const DATE = "2026-08-16";
const BASE = 1_755_302_400; // 2025-08-16T00:00:00Z

let dir: string;
let savedFetch: typeof globalThis.fetch;

function seedEdition(date = DATE, storyCount = 3): void {
  getDb()
    .query(
      `INSERT INTO editions (date, tz, start_unix, end_unix, closed_at, ingested_at, story_count, state)
       VALUES (?, 'Europe/Amsterdam', ?, ?, ?, ?, ?, 'ingested')`,
    )
    .run(date, BASE, BASE + 86400, BASE + 86400, BASE + 86400, storyCount);
}

function seedStory(over: Partial<StoryRow> = {}): StoryRow {
  const story: StoryRow = {
    id: 900_000_001,
    edition_date: DATE,
    rank: 1,
    title: "Ask HN: What are you working on?",
    url: null,
    domain: null,
    author: "pg",
    points: 412,
    num_comments: 0,
    created_at_i: BASE + 3600,
    story_text: "<p>Tell us what you built.",
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

/** Three root threads, each with one reply and one grandchild. */
function seedComments(storyId: number, roots = 3): void {
  const tree: CommentNode = {
    id: storyId,
    type: "story",
    author: "pg",
    text: null,
    created_at_i: BASE,
    // Comment ids are globally unique in HN and in the schema, so each story's
    // tree gets its own numeric space.
    children: Array.from({ length: roots }, (_, r) => ({
      id: storyId * 100 + r * 10,
      type: "comment" as const,
      author: `root${r}`,
      text: `<p>Root thought ${r}.`,
      created_at_i: BASE + 4000 + r,
      children: [
        {
          id: storyId * 100 + r * 10 + 1,
          type: "comment" as const,
          author: `reply${r}`,
          text: `<p>Reply at depth one, thread ${r}.`,
          created_at_i: BASE + 4100 + r,
          children: [
            {
              id: storyId * 100 + r * 10 + 2,
              type: "comment" as const,
              author: `deep${r}`,
              text: `<p>Reply at depth two, thread ${r}.`,
              created_at_i: BASE + 4200 + r,
              children: [],
            },
          ],
        },
      ],
    })),
  };
  saveComments(storyId, flattenComments(storyId, tree));
}

function seedThreeStories(): StoryRow[] {
  const rows = [
    seedStory({ id: 900_000_001, rank: 1, title: "First story", num_comments: 9 }),
    seedStory({ id: 900_000_002, rank: 2, title: "Second story", num_comments: 9 }),
    seedStory({
      id: 900_000_003,
      rank: 3,
      title: "Third story",
      num_comments: 0,
      created_at_i: BASE + 9000,
    }),
  ];
  seedComments(900_000_001);
  seedComments(900_000_002);
  return rows;
}

function markStoriesReady(date = DATE): void {
  const db = getDb();
  for (const { id } of db.query<{ id: number }, [string]>(
    "SELECT id FROM stories WHERE edition_date = ?",
  ).all(date)) {
    db.query(
      `INSERT INTO builds (kind, build_key, state, started_at, finished_at, path, bytes, sha256, error)
       VALUES ('story', ?, 'ready', 1, 2, '/dev/null', 1, 'x', NULL)`,
    ).run(String(id));
  }
}

async function openEpub(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes);
  const text = async (p: string) => {
    const file = zip.file(p);
    if (!file) throw new Error(`missing zip entry: ${p}`);
    return file.async("string");
  };
  return { zip, text, names: Object.keys(zip.files) };
}

function expectWellFormed(xml: string, label: string): void {
  const result = XMLValidator.validate(xml);
  if (result !== true) throw new Error(`${label} is not well-formed: ${JSON.stringify(result)}`);
}

function event(params: Record<string, string>, headers: Record<string, string> = {}): H3Event {
  const ev = mockEvent("http://localhost/epub/edition/x", { headers });
  ev.context.params = params;
  return ev;
}

async function call(handler: (ev: H3Event) => unknown, ev: H3Event): Promise<Response> {
  const result = await handler(ev);
  if (!(result instanceof Response)) throw new Error("expected a Response");
  return result;
}

beforeEach(() => {
  dir = makeTempDataDir("hn-opds-digest-");
  setConfigForTests({ dataDir: dir });
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    throw new Error(`digest build made a network request: ${String(input)}`);
  }) as unknown as typeof fetch;
  resetDbForTests();
  resetQueueForTests();
  useSmallCovers();
  seedEdition();
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  restoreCoverScale();
  resetDbForTests();
  resetConfig();
  rmSync(dir, { recursive: true, force: true });
});

describe("editionClock", () => {
  test("pins to the newest story in the edition", () => {
    const stories = [
      { created_at_i: BASE + 100 } as StoryRow,
      { created_at_i: BASE + 9000 } as StoryRow,
      { created_at_i: BASE + 50 } as StoryRow,
    ];
    expect(editionClock(stories, DATE).toISOString()).toBe(
      new Date((BASE + 9000) * 1000).toISOString(),
    );
  });

  test("falls back to the edition date when there is nothing to pin to", () => {
    expect(editionClock([], DATE).toISOString()).toBe("2026-08-16T00:00:00.000Z");
  });
});

describe("composeEditionEpub", () => {
  test("produces a valid EPUB containing every story", async () => {
    const stories = seedThreeStories();
    const bytes = await composeEditionEpub(DATE, stories);

    // OCF: the archive begins with a local file header and `mimetype` first.
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);

    const { names, text } = await openEpub(bytes);
    expect(names).toContain("mimetype");
    expect(names).toContain("META-INF/container.xml");
    expect(names).toContain("OEBPS/content.opf");
    expect(names).toContain("OEBPS/nav.xhtml");
    expect(names).toContain("OEBPS/toc.ncx");
    expect(names).toContain("OEBPS/contents.xhtml");
    expect(names).toContain("OEBPS/cover.png");
    for (const n of ["s001", "s002", "s003"]) {
      expect(names).toContain(`OEBPS/${n}.xhtml`);
      expect(names).toContain(`OEBPS/${n}-c.xhtml`);
    }
    expect(await text("mimetype")).toBe("application/epub+zip");
  });

  test("every document it emits is well-formed XML", async () => {
    const stories = seedThreeStories();
    const { zip } = await openEpub(await composeEditionEpub(DATE, stories));
    for (const name of Object.keys(zip.files)) {
      if (!/\.(xhtml|opf|ncx|xml)$/.test(name)) continue;
      expectWellFormed(await zip.file(name)!.async("string"), name);
    }
  });

  test("opens on a contents page listing every story in rank order", async () => {
    const stories = seedThreeStories();
    const { text } = await openEpub(await composeEditionEpub(DATE, stories));
    const contents = await text("OEBPS/contents.xhtml");

    expect(contents.indexOf("First story")).toBeLessThan(contents.indexOf("Second story"));
    expect(contents.indexOf("Second story")).toBeLessThan(contents.indexOf("Third story"));
    expect(contents).toContain("s001.xhtml");
    expect(contents).toContain("3 stories, with comments");
  });

  test("orders the spine contents, then article and comments per story", async () => {
    const stories = seedThreeStories();
    const { text } = await openEpub(await composeEditionEpub(DATE, stories));
    const opf = await text("OEBPS/content.opf");
    const spine = opf.slice(opf.indexOf("<spine"));
    const order = [...spine.matchAll(/idref="([^"]+)"/g)].map((m) => m[1]);

    expect(order).toEqual(["contents", "s0", "s0c", "s1", "s1c", "s2", "s2c"]);
  });

  test("declares the cover so a library has something to show", async () => {
    const stories = seedThreeStories();
    const { text } = await openEpub(await composeEditionEpub(DATE, stories));
    const opf = await text("OEBPS/content.opf");

    // EPUB 3 readers use the manifest property; EPUB 2 ones the legacy meta.
    expect(opf).toContain('properties="cover-image"');
    expect(opf).toContain('name="cover" content="cover"');
  });

  test("writes digest metadata that sorts ahead of the day's own stories", async () => {
    const stories = seedThreeStories();
    const { text } = await openEpub(await composeEditionEpub(DATE, stories));
    const opf = await text("OEBPS/content.opf");

    expect(opf).toContain(editionIdentifier(DATE));
    expect(opf).toContain("Hacker News \u2014 2026-08-16");
    expect(opf).toContain('name="calibre:series" content="Hacker News"');
    // Rank 0: the digest precedes 20260816.01 in a series listing.
    expect(opf).toContain('content="20260816.00"');
    expect(opf).toContain('name="hn:kind" content="digest"');
    expect(opf).toContain('name="hn:stories" content="3"');
  });

  test("stamps dcterms:modified from the newest story, not the clock", async () => {
    const stories = seedThreeStories();
    const { text } = await openEpub(await composeEditionEpub(DATE, stories));
    const opf = await text("OEBPS/content.opf");

    const expected = new Date((BASE + 9000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    expect(opf).toContain(`<meta property="dcterms:modified">${expected}</meta>`);
  });

  test("carries a per-story header where a title page would be", async () => {
    const stories = seedThreeStories();
    const { text } = await openEpub(await composeEditionEpub(DATE, stories));
    const first = await text("OEBPS/s001.xhtml");

    expect(first).toContain("No. 1");
    expect(first).toContain("412 points");
    expect(first).toContain("news.ycombinator.com/item?id=900000001");
    expect(first).toContain("Tell us what you built.");
  });

  test("puts a story's threads in one chapter, not one chapter each", async () => {
    const stories = seedThreeStories();
    const { names, text } = await openEpub(await composeEditionEpub(DATE, stories));
    const comments = await text("OEBPS/s001-c.xhtml");

    expect(names.some((n) => n.includes("thread-"))).toBe(false);
    expect(comments).toContain("Root thought 0.");
    expect(comments).toContain("Root thought 1.");
    expect(comments).toContain("Root thought 2.");
  });

  test("says so when a story has no comments", async () => {
    const stories = seedThreeStories();
    const { text } = await openEpub(await composeEditionEpub(DATE, stories));
    expect(await text("OEBPS/s003-c.xhtml")).toContain("No comments were available");
  });

  test("is deterministic: two builds of the same edition are byte-identical", async () => {
    const stories = seedThreeStories();
    const a = await composeEditionEpub(DATE, stories);
    const b = await composeEditionEpub(DATE, stories);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});

describe("digest caps", () => {
  test("honours digestThreadsPerStory and announces what it dropped", async () => {
    setConfigForTests({ dataDir: dir, digestThreadsPerStory: 1 });
    const stories = seedThreeStories();
    const { text } = await openEpub(await composeEditionEpub(DATE, stories));
    const comments = await text("OEBPS/s001-c.xhtml");

    expect(comments).toContain("Root thought 0.");
    expect(comments).not.toContain("Root thought 1.");
    expect(comments).toContain("2 further threads omitted");
    expect(comments).toContain("news.ycombinator.com/item?id=900000001");
  });

  test("honours digestCommentMaxDepth and announces what it dropped", async () => {
    setConfigForTests({ dataDir: dir, digestCommentMaxDepth: 1 });
    const stories = seedThreeStories();
    const { text } = await openEpub(await composeEditionEpub(DATE, stories));
    const comments = await text("OEBPS/s001-c.xhtml");

    expect(comments).toContain("Reply at depth one, thread 0.");
    expect(comments).not.toContain("Reply at depth two, thread 0.");
    expect(comments).toContain("deeper repl");
  });

  test("records the caps in the metadata so a book explains itself", async () => {
    setConfigForTests({ dataDir: dir, digestThreadsPerStory: 7, digestCommentMaxDepth: 2 });
    const stories = seedThreeStories();
    const { text } = await openEpub(await composeEditionEpub(DATE, stories));
    const opf = await text("OEBPS/content.opf");

    expect(opf).toContain('name="hn:threads-per-story" content="7"');
    expect(opf).toContain('name="hn:comment-max-depth" content="2"');
  });

  test("leaves the per-story book uncapped", async () => {
    // The digest is a summary; the individual book is the record. Asserted here
    // rather than in story.test.ts because it is this file's caps that would
    // leak into it.
    setConfigForTests({ dataDir: dir, digestThreadsPerStory: 1, digestCommentMaxDepth: 1 });
    const stories = seedThreeStories();
    const { composeStoryEpub } = await import("~/build/story");
    const { zip } = await openEpub(await composeStoryEpub(stories[0] as StoryRow));

    const threads = Object.keys(zip.files).filter((n) => /thread-\d{3}/.test(n));
    expect(threads).toHaveLength(3);
    const first = await zip.file("OEBPS/thread-000.xhtml")!.async("string");
    expect(first).toContain("Reply at depth two, thread 0.");
  });
});

describe("buildEditionEpub", () => {
  test("writes the artifact and records it as ready", async () => {
    seedThreeStories();
    const row = await buildEditionEpub(DATE);

    expect(row.state).toBe("ready");
    expect(row.kind).toBe("edition");
    expect(row.build_key).toBe(DATE);
    expect(row.path).toContain(`edition-${DATE}.epub`);
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await Bun.file(row.path!).exists()).toBe(true);
    expect((await Bun.file(row.path!).arrayBuffer()).byteLength).toBe(row.bytes);
  });

  test("references the cover from the edition so retention cannot orphan it", async () => {
    seedThreeStories();
    await buildEditionEpub(DATE);

    const rows = getDb()
      .query<{ edition_date: string; sha256: string }, []>("SELECT * FROM edition_assets")
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.edition_date).toBe(DATE);

    const asset = getDb()
      .query<{ kind: string }, [string]>("SELECT kind FROM assets WHERE sha256 = ?")
      .get(rows[0]!.sha256);
    expect(asset!.kind).toBe("cover");
  });

  test("reuses the artifact on a second call", async () => {
    seedThreeStories();
    const first = await buildEditionEpub(DATE);
    const second = await buildEditionEpub(DATE);
    expect(second.sha256).toBe(first.sha256);
    expect(second.finished_at).toBe(first.finished_at);
  });

  test("coalesces concurrent builds of the same date", async () => {
    seedThreeStories();
    const [a, b, c] = await Promise.all([
      buildEditionEpub(DATE),
      buildEditionEpub(DATE),
      buildEditionEpub(DATE),
    ]);
    expect(a.sha256).toBe(b.sha256);
    expect(b.sha256).toBe(c.sha256);
  });

  test("rebuilds when the blob has been swept", async () => {
    seedThreeStories();
    const first = await buildEditionEpub(DATE);
    rmSync(first.path!);

    const again = await buildEditionEpub(DATE);
    expect(again.state).toBe("ready");
    expect(await Bun.file(again.path!).exists()).toBe(true);
    // Deterministic input, so the replacement is the same book.
    expect(again.sha256).toBe(first.sha256);
  });

  test("throws a typed error for a date with no stories, leaving no ledger row", async () => {
    await expect(buildEditionEpub("2020-01-01")).rejects.toBeInstanceOf(BuildError);
    await expect(buildEditionEpub("2020-01-01")).rejects.toMatchObject({
      code: "unknown_edition",
    });
    expect(getBuild("edition", "2020-01-01")).toBeNull();
  });
});

describe("editionsNeedingDigest", () => {
  test("waits until every story in the edition has been built", () => {
    seedThreeStories();
    expect(editionsNeedingDigest(3650)).toEqual([]);

    markStoriesReady();
    expect(editionsNeedingDigest(3650)).toEqual([DATE]);
  });

  test("drops an edition once its digest is ready", async () => {
    seedThreeStories();
    markStoriesReady();
    await buildEditionEpub(DATE);
    expect(editionsNeedingDigest(3650)).toEqual([]);
  });

  test("ignores editions older than the lookback window", () => {
    // Deliberately an ancient date rather than one relative to the test's
    // clock: the window is measured from today, and a fixture that happened to
    // sit near the edge would start failing on a particular calendar day.
    seedEdition("2000-01-01", 1);
    seedStory({ id: 100, edition_date: "2000-01-01", rank: 1, created_at_i: 946_684_800 });
    markStoriesReady("2000-01-01");

    seedThreeStories();
    markStoriesReady();

    expect(editionsNeedingDigest(30_000)).toContain("2000-01-01");
    expect(editionsNeedingDigest(7)).not.toContain("2000-01-01");
  });

  test("ignores an edition that is still being ingested", () => {
    seedThreeStories();
    markStoriesReady();
    getDb().query("UPDATE editions SET state = 'pending' WHERE date = ?").run(DATE);
    expect(editionsNeedingDigest(3650)).toEqual([]);
  });
});

describe("GET /epub/edition/:file", () => {
  test("serves the digest with a strong ETag and an immutable policy", async () => {
    seedThreeStories();
    const res = await call(editionEpubRoute, event({ file: `${DATE}.epub` }));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/epub+zip");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(res.headers.get("content-disposition")).toContain(`hn-${DATE}.epub`);
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{64}"$/);

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes.slice(0, 2))).toEqual([0x50, 0x4b]);
    expect(bytes.byteLength).toBe(Number(res.headers.get("content-length")));
  });

  test("answers 304 to a matching if-none-match", async () => {
    seedThreeStories();
    const first = await call(editionEpubRoute, event({ file: `${DATE}.epub` }));
    const etag = first.headers.get("etag") as string;

    const second = await call(
      editionEpubRoute,
      event({ file: `${DATE}.epub` }, { "if-none-match": etag }),
    );
    expect(second.status).toBe(304);
    expect(second.body).toBeNull();
  });

  test("404s for a date this archive does not hold", async () => {
    await expect(
      call(editionEpubRoute, event({ file: "2020-01-01.epub" })),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("400s for anything that is not a dated EPUB", async () => {
    for (const file of ["2026-8-16.epub", "latest.epub", "2026-08-16.zip"]) {
      await expect(call(editionEpubRoute, event({ file }))).rejects.toBeInstanceOf(HTTPError);
    }
  });
});
