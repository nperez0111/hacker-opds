/**
 * Re-ingest must preserve expensive work.
 *
 * An edition is re-ingested every time the prewarm task runs, and previously
 * that deleted and reinserted every story row. `articles` and `comments`
 * cascade off `stories`, so each refresh silently discarded every extracted
 * article and fetched comment tree -- while the `builds` rows survived as
 * 'ready', leaving blobs that could no longer be rebuilt from their source.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { makeTempDataDir } from "./helpers/data-dir";

let hits: unknown[] = [];

mock.module("~/core/algolia", () => ({
  searchTopStories: async () => hits,
}));

// Network guard. This deliberately stubs `fetch` rather than mocking a comment
// source module: Bun's module mocks are global for the whole test run and leak
// into every later file. Stubbing fetch is both narrower in scope and broader
// in coverage -- it catches any egress, not just one function.
const realFetch = globalThis.fetch;

const { ingestEdition, getEditionStories } = await import("~/core/edition");
const { saveArticle, getArticle } = await import("~/core/extract");
const { saveComments, getComments } = await import("~/core/comments");
const { getDb, resetDbForTests } = await import("~/db/client");
const { setConfigForTests, resetConfig } = await import("~/config");
const { markBuilding, markReady, getBuild } = await import("~/build/artifacts");

const DATE = "2026-08-16";
// Inside the 2026-08-16 Europe/Amsterdam day window.
const CREATED = Math.floor(Date.parse("2026-08-16T10:00:00Z") / 1000);

function hit(id: number, over: Record<string, unknown> = {}) {
  return {
    objectID: String(id),
    title: `Story ${id}`,
    url: `https://example.com/${id}`,
    author: "alice",
    points: 100,
    num_comments: 5,
    created_at_i: CREATED,
    story_text: null,
    ...over,
  };
}

let dir: string;

beforeEach(() => {
  globalThis.fetch = (async () => {
    throw new Error("tests must not reach the network");
  }) as unknown as typeof fetch;
  dir = makeTempDataDir("hn-opds-ingest-");
  setConfigForTests({ dataDir: dir });
  resetDbForTests();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetDbForTests();
  resetConfig();
  rmSync(dir, { recursive: true, force: true });
});

describe("ingestEdition re-ingest", () => {
  test("keeps a surviving story's article and comments", async () => {
    hits = [hit(1001), hit(1002)];
    await ingestEdition(DATE);

    saveArticle({
      story_id: 1001,
      state: "ok",
      fetched_at: CREATED,
      http_status: 200,
      final_url: "https://example.com/1001",
      title: "Extracted",
      author: "bob",
      published: null,
      site: "Example",
      language: "en",
      word_count: 900,
      xhtml: "<p>Expensive to obtain.</p>",
      markdown: "Expensive to obtain.",
      error_code: null,
    });
    saveComments(1001, [
      {
        id: 5001,
        story_id: 1001,
        parent_id: null,
        root_id: 5001,
        depth: 0,
        sort_index: 0,
        author: "carol",
        created_at_i: CREATED + 60,
        text_html: "<p>A comment.</p>",
      },
    ]);

    // Points move; the same two stories are still in the top N.
    hits = [hit(1001, { points: 250 }), hit(1002)];
    await ingestEdition(DATE);

    expect(getArticle(1001)?.word_count).toBe(900);
    expect(getComments(1001)).toHaveLength(1);
    expect(getEditionStories(DATE).find((s) => s.id === 1001)?.points).toBe(250);
  });

  test("refreshes rank and points without losing rows", async () => {
    hits = [hit(1001), hit(1002)];
    await ingestEdition(DATE);

    // 1002 overtakes 1001.
    hits = [hit(1002, { points: 900 }), hit(1001, { points: 10 })];
    const rows = await ingestEdition(DATE);

    expect(rows.map((r) => r.id)).toEqual([1002, 1001]);
    expect(getEditionStories(DATE).map((s) => s.rank)).toEqual([1, 2]);
    expect(getEditionStories(DATE)[0]!.id).toBe(1002);
  });

  test("drops a story that fell out of the top N, with its build row", async () => {
    hits = [hit(1001), hit(1002)];
    await ingestEdition(DATE);

    markBuilding("story", 1002);
    markReady("story", 1002, {
      path: join(dir, "blobs", "epub", "story-1002.epub"),
      bytes: 123,
      sha256: "a".repeat(64),
    });
    expect(getBuild("story", 1002)?.state).toBe("ready");

    hits = [hit(1001)];
    await ingestEdition(DATE);

    expect(getEditionStories(DATE).map((s) => s.id)).toEqual([1001]);
    // The stale ledger row must go too, or buildStoryEpub would keep serving a
    // blob for a story whose source rows no longer exist.
    expect(getBuild("story", 1002)).toBeNull();
  });

  test("dropping one story leaves the others' articles intact", async () => {
    hits = [hit(1001), hit(1002)];
    await ingestEdition(DATE);

    saveArticle({
      story_id: 1001,
      state: "ok",
      fetched_at: CREATED,
      http_status: 200,
      final_url: "https://example.com/1001",
      title: "Kept",
      author: null,
      published: null,
      site: null,
      language: "en",
      word_count: 42,
      xhtml: "<p>Kept.</p>",
      markdown: "Kept.",
      error_code: null,
    });

    hits = [hit(1001)];
    await ingestEdition(DATE);

    expect(getArticle(1001)?.title).toBe("Kept");
  });

  test("a dropped story's article and comments are cascaded away", async () => {
    hits = [hit(1001), hit(1002)];
    await ingestEdition(DATE);

    saveComments(1002, [
      {
        id: 6001,
        story_id: 1002,
        parent_id: null,
        root_id: 6001,
        depth: 0,
        sort_index: 0,
        author: "dave",
        created_at_i: CREATED + 60,
        text_html: "<p>Goes away.</p>",
      },
    ]);

    hits = [hit(1001)];
    await ingestEdition(DATE);

    expect(getComments(1002)).toHaveLength(0);
  });

  test("handles an edition going empty", async () => {
    hits = [hit(1001)];
    await ingestEdition(DATE);

    hits = [];
    await ingestEdition(DATE);

    expect(getEditionStories(DATE)).toHaveLength(0);
    const row = getDb()
      .query<{ story_count: number }, [string]>(
        "SELECT story_count FROM editions WHERE date = ?",
      )
      .get(DATE);
    expect(row?.story_count).toBe(0);
  });
});
