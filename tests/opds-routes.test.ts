/**
 * The OPDS routes as HTTP: content types, cache policy, and conditional GET.
 *
 * `tests/opds.test.ts` covers the catalogue as pure functions - what the feeds
 * say - and until now nothing covered four of the five routes at all. The
 * distinction matters most for the thing being added here, because an entity
 * tag is not a property of a feed. It is a property of two requests, and the
 * only way to test it is to make both.
 *
 * Two failure modes are worth naming, because both are silent:
 *
 *  - An unstable tag. If anything in the render reached for the clock, every
 *    revalidation would answer 200 with an identical body, and the feature would
 *    look like it worked while costing slightly more than doing nothing. The
 *    "stable across repeated requests" tests are the guard, and they are the
 *    reason `expectNoFetch` is here too.
 *  - A stale tag. If the tag did not move when the feed did, a reader would be
 *    frozen on an old catalogue with no way to notice. Points and comment counts
 *    are the sharp case: a re-ingest rewrites them and no timestamp in the
 *    database moves at all.
 *
 * The handlers are called directly through h3's `mockEvent`, the same seam
 * tests/rss.test.ts uses, so nothing here needs a listener or a port.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { HTTPError, mockEvent, type H3Event } from "nitro/h3";
import { XMLValidator } from "fast-xml-parser";

import { resetConfig, setConfigForTests } from "~/config";
import { getDb, resetDbForTests } from "~/db/client";
import type { StoryRow } from "~/core/edition";
import { ACQUISITION_TYPE, NAVIGATION_TYPE, OPENSEARCH_TYPE } from "~/opds/atom";
import { EDITION_CACHE, FEED_CACHE } from "~/opds/respond";

import archiveDateRoute from "../server/routes/opds/archive/[date]";
import archiveRoute from "../server/routes/opds/archive/index";
import opensearchRoute from "../server/routes/opds/opensearch.xml";
import rootRoute from "../server/routes/opds/index";
import searchRoute from "../server/routes/opds/search";
import todayRoute from "../server/routes/opds/today";
import { makeTempDataDir } from "./helpers/data-dir";

const BASE = 1_755_302_400; // 2025-08-16T00:00:00Z

let dir: string;
let savedFetch: typeof globalThis.fetch;

function seedEdition(date: string, storyCount = 1): void {
  getDb()
    .query(
      `INSERT INTO editions (date, tz, start_unix, end_unix, closed_at, ingested_at, built_at, story_count, state)
       VALUES (?, 'Europe/Amsterdam', ?, ?, ?, ?, ?, ?, 'built')`,
    )
    .run(date, BASE, BASE + 86400, BASE + 86400, BASE + 86400, BASE + 90000, storyCount);
}

function seedStory(over: Partial<StoryRow> = {}): void {
  const row: StoryRow = {
    id: 999_999_001,
    edition_date: "2026-08-16",
    rank: 1,
    title: "Good system design",
    url: "https://seangoedecke.com/good-system-design/",
    domain: "seangoedecke.com",
    author: "ingve",
    points: 412,
    num_comments: 208,
    created_at_i: BASE + 3600,
    story_text: null,
    is_text_post: 0,
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
      Object.fromEntries(Object.entries(row).map(([k, v]) => [`$${k}`, v])) as Record<
        string,
        string | number | null
      >,
    );
}

function event(
  path: string,
  opts: { params?: Record<string, string>; headers?: Record<string, string> } = {},
): H3Event {
  const ev = mockEvent(`http://localhost${path}`, { headers: opts.headers ?? {} });
  if (opts.params) ev.context.params = opts.params;
  return ev;
}

async function call(handler: (ev: H3Event) => unknown, ev: H3Event): Promise<Response> {
  const result = await handler(ev);
  if (!(result instanceof Response)) {
    throw new Error(`expected a Response, got ${typeof result}`);
  }
  return result;
}

/** Fetch, then fetch again quoting the tag. Returns both responses. */
async function revalidate(
  handler: (ev: H3Event) => unknown,
  path: string,
  opts: { params?: Record<string, string> } = {},
): Promise<{ first: Response; second: Response; etag: string }> {
  const first = await call(handler, event(path, opts));
  const etag = first.headers.get("etag");
  if (!etag) throw new Error(`${path} answered without an etag`);
  const second = await call(
    handler,
    event(path, { ...opts, headers: { "if-none-match": etag } }),
  );
  return { first, second, etag };
}

function expectWellFormed(xml: string, label: string): void {
  const result = XMLValidator.validate(xml);
  if (result !== true) {
    throw new Error(`${label} is not well-formed: ${JSON.stringify(result.err)}`);
  }
}

beforeEach(() => {
  dir = makeTempDataDir("hn-opds-routes-");
  setConfigForTests({ dataDir: dir });
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    throw new Error(`feed generation made a network request: ${String(input)}`);
  }) as unknown as typeof fetch;
  resetDbForTests();
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  resetDbForTests();
  resetConfig();
  rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */

describe("GET /opds", () => {
  test("serves a well-formed navigation feed", async () => {
    seedEdition("2026-08-16");
    const res = await call(rootRoute, event("/opds"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(`${NAVIGATION_TYPE}; charset=utf-8`);
    expectWellFormed(await res.text(), "root feed");
  });

  test("carries a quoted 128-bit entity tag", async () => {
    seedEdition("2026-08-16");
    const res = await call(rootRoute, event("/opds"));
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{32}"$/);
  });

  test("answers an unchanged feed with 304 and no body", async () => {
    seedEdition("2026-08-16");
    const { second, etag } = await revalidate(rootRoute, "/opds");
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
    expect(second.headers.get("etag")).toBe(etag);
  });

  /*
   * A validating cache updates its stored headers from the 304. Dropping the
   * policy there would silently reset the freshness window it was told about
   * the first time, so every future request would revalidate.
   */
  test("the 304 repeats the cache policy rather than dropping it", async () => {
    seedEdition("2026-08-16");
    const { second } = await revalidate(rootRoute, "/opds");
    expect(second.headers.get("cache-control")).toBe(FEED_CACHE);
    expect(second.headers.get("content-type")).toBe(`${NAVIGATION_TYPE}; charset=utf-8`);
  });

  test("is cached briefly, because a new edition can land at any hour", async () => {
    seedEdition("2026-08-16");
    const res = await call(rootRoute, event("/opds"));
    expect(res.headers.get("cache-control")).toBe("public, max-age=300, must-revalidate");
  });

  test("still answers, with a tag, before anything is ingested", async () => {
    const { first, second } = await revalidate(rootRoute, "/opds");
    expect(first.status).toBe(200);
    expect(second.status).toBe(304);
  });

  /*
   * Nothing in the catalogue reads the clock - every `updated` comes from a
   * story, an edition date or the epoch. If that ever stopped being true the
   * tag would change on every request and the whole feature would quietly stop
   * working while still looking present.
   */
  test("the tag is stable across repeated requests", async () => {
    seedEdition("2026-08-16");
    seedStory();
    const a = await call(rootRoute, event("/opds"));
    const b = await call(rootRoute, event("/opds"));
    expect(a.headers.get("etag")).toBe(b.headers.get("etag"));
  });

  test("the tag moves when a new edition lands", async () => {
    seedEdition("2026-08-15");
    const before = (await call(rootRoute, event("/opds"))).headers.get("etag");
    seedEdition("2026-08-16");
    const after = (await call(rootRoute, event("/opds"))).headers.get("etag");
    expect(after).not.toBe(before);
  });
});

describe("GET /opds/today", () => {
  test("serves the newest edition as an acquisition feed", async () => {
    seedEdition("2026-08-16");
    seedStory();
    const res = await call(todayRoute, event("/opds/today"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(`${ACQUISITION_TYPE}; charset=utf-8`);
    expectWellFormed(await res.text(), "today feed");
  });

  test("answers an unchanged feed with 304", async () => {
    seedEdition("2026-08-16");
    seedStory();
    const { second } = await revalidate(todayRoute, "/opds/today");
    expect(second.status).toBe(304);
  });

  /*
   * This path always means "the newest edition", so its bytes change the day a
   * new one lands. It keeps the five-minute policy for that reason, unlike the
   * dated feed below.
   */
  test("keeps the short cache policy, because the date behind it moves", async () => {
    seedEdition("2026-08-16");
    const res = await call(todayRoute, event("/opds/today"));
    expect(res.headers.get("cache-control")).toBe(FEED_CACHE);
  });

  /*
   * The case a timestamp validator would get wrong. `stories` has no
   * updated_at, so a re-ingest rewrites the score with nothing in the database
   * recording that it happened.
   */
  test("the tag moves when a re-ingest rewrites a story's score", async () => {
    seedEdition("2026-08-16");
    seedStory();
    const before = (await call(todayRoute, event("/opds/today"))).headers.get("etag");
    getDb().query("UPDATE stories SET points = 999 WHERE id = ?").run(999_999_001);
    const after = (await call(todayRoute, event("/opds/today"))).headers.get("etag");
    expect(after).not.toBe(before);
  });

  test("404s before anything is ingested rather than serving an empty feed", async () => {
    await expect(call(todayRoute, event("/opds/today"))).rejects.toBeInstanceOf(HTTPError);
  });
});

describe("GET /opds/archive", () => {
  test("serves a well-formed navigation feed of editions", async () => {
    seedEdition("2026-08-15");
    seedEdition("2026-08-16");
    const res = await call(archiveRoute, event("/opds/archive"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(`${NAVIGATION_TYPE}; charset=utf-8`);
    expectWellFormed(await res.text(), "archive feed");
  });

  /*
   * The feed most worth a tag: one entry per edition, so it grows without
   * bound, and an e-reader refetches it every time the catalogue is opened.
   */
  test("answers an unchanged archive with 304", async () => {
    seedEdition("2026-08-16");
    const { second, etag } = await revalidate(archiveRoute, "/opds/archive");
    expect(second.status).toBe(304);
    expect(second.headers.get("etag")).toBe(etag);
  });

  test("the tag moves when an edition is added", async () => {
    seedEdition("2026-08-16");
    const before = (await call(archiveRoute, event("/opds/archive"))).headers.get("etag");
    seedEdition("2026-08-17");
    const after = (await call(archiveRoute, event("/opds/archive"))).headers.get("etag");
    expect(after).not.toBe(before);
  });

  test("survives an empty archive", async () => {
    const res = await call(archiveRoute, event("/opds/archive"));
    expect(res.status).toBe(200);
    expectWellFormed(await res.text(), "empty archive feed");
  });
});

describe("GET /opds/archive/:date", () => {
  const params = { params: { date: "2026-08-16" } };

  test("serves one edition as an acquisition feed", async () => {
    seedEdition("2026-08-16");
    seedStory();
    const res = await call(archiveDateRoute, event("/opds/archive/2026-08-16", params));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(`${ACQUISITION_TYPE}; charset=utf-8`);
    expectWellFormed(await res.text(), "dated feed");
  });

  /*
   * A finished edition, matching what the HTML and RSS versions of the same day
   * already promise. It was five minutes before this change, purely because
   * nothing had ever passed a policy to the helper.
   */
  test("is cached for a day, since the edition is finished", async () => {
    seedEdition("2026-08-16");
    const res = await call(archiveDateRoute, event("/opds/archive/2026-08-16", params));
    expect(res.headers.get("cache-control")).toBe(EDITION_CACHE);
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
  });

  test("answers an unchanged edition with 304", async () => {
    seedEdition("2026-08-16");
    seedStory();
    const { second } = await revalidate(archiveDateRoute, "/opds/archive/2026-08-16", params);
    expect(second.status).toBe(304);
  });

  test("400s a malformed date without touching the database", async () => {
    await expect(
      call(archiveDateRoute, event("/opds/archive/nope", { params: { date: "nope" } })),
    ).rejects.toBeInstanceOf(HTTPError);
  });

  test("404s a date with no edition rather than an empty feed", async () => {
    await expect(
      call(archiveDateRoute, event("/opds/archive/2026-08-16", params)),
    ).rejects.toBeInstanceOf(HTTPError);
  });
});

describe("GET /opds/search", () => {
  test("answers an unchanged result set with 304", async () => {
    seedEdition("2026-08-16");
    seedStory();
    const { first, second } = await revalidate(searchRoute, "/opds/search?q=design");
    expect(first.status).toBe(200);
    expect(second.status).toBe(304);
  });

  /*
   * No column anywhere records when the answer to a query last changed, so the
   * body hash is not merely the cheapest validator here - it is the only one.
   */
  test("two different queries do not share a tag", async () => {
    seedEdition("2026-08-16");
    seedStory();
    const a = await call(searchRoute, event("/opds/search?q=design"));
    const b = await call(searchRoute, event("/opds/search?q=systems"));
    expect(a.headers.get("etag")).not.toBe(b.headers.get("etag"));
  });

  test("paging through results does not reuse one tag", async () => {
    seedEdition("2026-08-16");
    seedStory();
    const a = await call(searchRoute, event("/opds/search?q=design&offset=0"));
    const b = await call(searchRoute, event("/opds/search?q=design&offset=25"));
    expect(a.headers.get("etag")).not.toBe(b.headers.get("etag"));
  });
});

describe("GET /opds/opensearch.xml", () => {
  test("serves the description under the type readers look for", async () => {
    const res = await call(opensearchRoute, event("/opds/opensearch.xml"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(`${OPENSEARCH_TYPE}; charset=utf-8`);
    expectWellFormed(await res.text(), "opensearch description");
  });

  /*
   * The cheapest tag in the codebase to justify: this document changes only
   * when the software or the origin does, so every revalidation after the first
   * is a 304 over a few hundred bytes, for the life of the subscription.
   */
  test("answers with 304 once a reader has it", async () => {
    const { second } = await revalidate(opensearchRoute, "/opds/opensearch.xml");
    expect(second.status).toBe(304);
    expect(second.headers.get("cache-control")).toBe("public, max-age=86400");
  });
});

/* ------------------------------------------------------------------ */

describe("entity tags and the advertised origin", () => {
  /*
   * Every absolute URL in a feed comes from the request when no base URL is
   * configured. A tag that ignored that would let a cache hand a reader behind
   * one proxy a catalogue whose links all point at another - the "loads fine,
   * then connection refused" failure the origin module exists to prevent.
   */
  test("a different forwarded host is a different feed", async () => {
    seedEdition("2026-08-16");
    const a = await call(rootRoute, event("/opds", { headers: { host: "a.example" } }));
    const b = await call(rootRoute, event("/opds", { headers: { host: "b.example" } }));
    expect(a.headers.get("etag")).not.toBe(b.headers.get("etag"));
  });

  test("the tag from one host does not validate against another", async () => {
    seedEdition("2026-08-16");
    const a = await call(rootRoute, event("/opds", { headers: { host: "a.example" } }));
    const cross = await call(
      rootRoute,
      event("/opds", {
        headers: { host: "b.example", "if-none-match": a.headers.get("etag")! },
      }),
    );
    expect(cross.status).toBe(200);
  });

  test("declares the forwarded headers it varies on", async () => {
    seedEdition("2026-08-16");
    const res = await call(rootRoute, event("/opds"));
    expect(res.headers.get("vary")).toBe("X-Forwarded-Host, X-Forwarded-Proto");
  });

  /*
   * Host is deliberately absent: a cache keys on the target URI, which already
   * includes it. Naming it again would only split entries.
   */
  test("does not name Host, which is already part of every cache key", async () => {
    seedEdition("2026-08-16");
    const res = await call(rootRoute, event("/opds"));
    const named = (res.headers.get("vary") ?? "").split(",").map((h) => h.trim());
    expect(named).not.toContain("Host");
    expect(named).toContain("X-Forwarded-Host");
  });

  test("declares no dependency at all when a base URL is configured", async () => {
    setConfigForTests({ dataDir: dir, publicBaseUrl: "https://hn.example.com" });
    seedEdition("2026-08-16");
    const res = await call(rootRoute, event("/opds"));
    expect(res.headers.get("vary")).toBeNull();
  });

  test("with a configured base URL the host no longer changes the tag", async () => {
    setConfigForTests({ dataDir: dir, publicBaseUrl: "https://hn.example.com" });
    seedEdition("2026-08-16");
    const a = await call(rootRoute, event("/opds", { headers: { host: "a.example" } }));
    const b = await call(rootRoute, event("/opds", { headers: { host: "b.example" } }));
    expect(a.headers.get("etag")).toBe(b.headers.get("etag"));
  });

  /*
   * Different feeds must not collide. They will not by construction - the tag
   * is over the body and the bodies differ - but a helper that ever hashed
   * something narrower, like the edition date, would break this quietly.
   */
  test("the browse feeds do not share a tag", async () => {
    seedEdition("2026-08-16");
    seedStory();
    const tags = await Promise.all(
      [
        call(rootRoute, event("/opds")),
        call(todayRoute, event("/opds/today")),
        call(archiveRoute, event("/opds/archive")),
      ].map(async (p) => (await p).headers.get("etag")),
    );
    expect(new Set(tags).size).toBe(3);
  });
});
