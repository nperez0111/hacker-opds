/**
 * The website's route handlers, called directly.
 *
 * h3 exposes `mockEvent`, so a handler can be invoked with a synthetic event
 * and no listener, no port and no process. That keeps these in the default
 * suite - the integration file under tests/integration/ boots a real server and
 * is gated behind RUN_INTEGRATION=1 precisely because that costs seconds.
 *
 * The database-backed routes open a SQLite file in a temp directory, which is
 * the same seam tests/story.test.ts uses. Nothing here touches the network; the
 * handlers under test do not fetch, and `expectNoFetch` makes that a failure
 * rather than an assumption.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { HTTPError, mockEvent, type H3Event } from "nitro/h3";

import { resetConfig, setConfigForTests } from "~/config";
import { getDb, resetDbForTests } from "~/db/client";
import type { StoryRow } from "~/core/edition";
import {
  APP_JS_URL,
  CSS_URL,
  PRECACHE_URLS,
  getWebAsset,
} from "~/web/assets";

import assetRoute from "../server/routes/assets/[file]";
import themeRoute from "../server/routes/theme";
import offlineRoute from "../server/routes/offline";
import indexRoute from "../server/routes/index";
import archiveIndexRoute from "../server/routes/archive/index";
import archiveDateRoute from "../server/routes/archive/[date]";
import storyRoute from "../server/routes/story/[id]";
import { makeTempDataDir } from "./helpers/data-dir";

const BASE = 1_755_302_400; // 2025-08-16T00:00:00Z

let dir: string;
let savedFetch: typeof globalThis.fetch;

/**
 * A fetch that fails the test if anything calls it.
 *
 * Page rendering is a pure read of SQLite. If a route ever grows a network
 * call, it becomes a page that hangs on a device with no radio, which is the
 * one device this site exists for.
 */
function expectNoFetch(): void {
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    throw new Error(`route made a network request: ${String(input)}`);
  }) as unknown as typeof fetch;
}

function event(path: string, opts: { cookie?: string; params?: Record<string, string>; headers?: Record<string, string> } = {}): H3Event {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.cookie) headers.cookie = opts.cookie;
  const ev = mockEvent(`http://localhost${path}`, { headers });
  if (opts.params) ev.context.params = opts.params;
  return ev;
}

/** Every route under test returns a Response, synchronously or otherwise. */
async function call(
  handler: (ev: H3Event) => unknown,
  ev: H3Event,
): Promise<Response> {
  const result = await handler(ev);
  if (!(result instanceof Response)) {
    throw new Error(`expected a Response, got ${typeof result}`);
  }
  return result;
}

function seedEdition(date: string, storyCount = 1): void {
  getDb()
    .query(
      `INSERT INTO editions (date, tz, start_unix, end_unix, closed_at, ingested_at, story_count, state)
       VALUES (?, 'Europe/Amsterdam', ?, ?, ?, ?, ?, 'ingested')`,
    )
    .run(date, BASE, BASE + 86400, BASE + 86400, BASE + 86400, storyCount);
}

function seedStory(over: Partial<StoryRow> = {}): StoryRow {
  const story: StoryRow = {
    id: 999_999_001,
    edition_date: "2026-08-16",
    rank: 1,
    title: "Good system design",
    url: "https://seangoedecke.com/good-system-design/",
    domain: "seangoedecke.com",
    author: "ingve",
    points: 957,
    num_comments: 0,
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
      Object.fromEntries(Object.entries(story).map(([k, v]) => [`$${k}`, v])) as Record<
        string,
        string | number | null
      >,
    );

  return story;
}

beforeEach(() => {
  dir = makeTempDataDir("hn-opds-web-");
  setConfigForTests({ dataDir: dir });
  expectNoFetch();
  resetDbForTests();
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  resetDbForTests();
  resetConfig();
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /theme", () => {
  test("redirects with 303, which is unambiguously a GET", async () => {
    const res = await call(themeRoute, event("/theme?to=%2Farchive"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/archive");
  });

  test("advances the cycle from whatever the cookie says", async () => {
    const at = async (cookie: string | undefined) => {
      const res = await call(themeRoute, event("/theme?to=%2F", { cookie }));
      return res.headers.get("set-cookie");
    };
    expect(await at(undefined)).toContain("theme=dark");
    expect(await at("theme=auto")).toContain("theme=dark");
    expect(await at("theme=dark")).toContain("theme=light");
    expect(await at("theme=light")).toContain("theme=auto");
  });

  test("sets a path-wide, year-long, lax cookie", async () => {
    const res = await call(themeRoute, event("/theme?to=%2F"));
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=31536000");
    expect(cookie).toContain("SameSite=Lax");
  });

  test("is never cached, or the toggle would stop toggling", async () => {
    const res = await call(themeRoute, event("/theme?to=%2F"));
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("defaults to the front page when no return path is given", async () => {
    const res = await call(themeRoute, event("/theme"));
    expect(res.headers.get("location")).toBe("/");
  });

  test("refuses to redirect off-origin", async () => {
    // The whole reason safeReturnPath exists: this is a GET anyone can link to.
    const hostile = [
      "//evil.com",
      "https://evil.com/x",
      "/%5Cevil.com",
      "%2F%2Fevil.com",
      "javascript:alert(1)",
    ];
    for (const to of hostile) {
      const res = await call(themeRoute, event(`/theme?to=${to}`));
      expect(res.headers.get("location")).toBe("/");
    }
  });

  test("survives a return path carrying a header injection attempt", async () => {
    // searchParams decodes %0d%0a into a real CRLF before it reaches the header.
    const res = await call(themeRoute, event("/theme?to=%2Fa%0d%0aSet-Cookie:%20sid%3Dx"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.get("set-cookie")).not.toContain("sid=x");
  });

  test("keeps a legitimate deep path with its query string", async () => {
    const res = await call(
      themeRoute,
      event(`/theme?to=${encodeURIComponent("/archive/2026-08-16?x=1")}`),
    );
    expect(res.headers.get("location")).toBe("/archive/2026-08-16?x=1");
  });

  test("survives a corrupt theme cookie instead of 500ing", async () => {
    const res = await call(themeRoute, event("/theme?to=%2F", { cookie: "theme=%" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie")).toContain("theme=dark");
  });
});

describe("GET /assets/:file", () => {
  test("serves each registered asset with its own type and etag", async () => {
    for (const name of ["site.css", "app.js", "sw.js", "manifest.webmanifest"]) {
      const asset = getWebAsset(name)!;
      const res = await call(assetRoute, event(`/assets/${name}`, { params: { file: name } }));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(asset.type);
      expect(res.headers.get("etag")).toBe(asset.etag);
      expect(await res.text()).toBe(asset.body);
    }
  });

  test("freezes hashed assets for a year", async () => {
    for (const name of ["site.css", "app.js"]) {
      const res = await call(assetRoute, event(`/assets/${name}`, { params: { file: name } }));
      expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    }
  });

  test("makes the worker and manifest revalidate every time", async () => {
    // A worker's URL is its registration identity, so a frozen copy would
    // freeze the site's client behaviour permanently.
    for (const name of ["sw.js", "manifest.webmanifest"]) {
      const res = await call(assetRoute, event(`/assets/${name}`, { params: { file: name } }));
      expect(res.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    }
  });

  test("lets the worker control the whole origin, not just /assets/", async () => {
    const res = await call(assetRoute, event("/assets/sw.js", { params: { file: "sw.js" } }));
    expect(res.headers.get("service-worker-allowed")).toBe("/");
  });

  test("sends that header for nothing else", async () => {
    const res = await call(assetRoute, event("/assets/app.js", { params: { file: "app.js" } }));
    expect(res.headers.get("service-worker-allowed")).toBeNull();
  });

  test("answers a matching if-none-match with 304 and no body", async () => {
    const etag = getWebAsset("site.css")!.etag;
    const res = await call(
      assetRoute,
      event("/assets/site.css", {
        params: { file: "site.css" },
        headers: { "if-none-match": etag },
      }),
    );
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe(etag);
    expect(await res.text()).toBe("");
  });

  test("sends the body when the etag does not match", async () => {
    const res = await call(
      assetRoute,
      event("/assets/site.css", {
        params: { file: "site.css" },
        headers: { "if-none-match": '"stale123"' },
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.text()).length).toBeGreaterThan(0);
  });

  test("404s an unknown asset rather than serving an empty body", () => {
    expect(() => assetRoute(event("/assets/nope.css", { params: { file: "nope.css" } }))).toThrow(
      HTTPError,
    );
  });

  test("404s a missing parameter and an inherited property name", () => {
    expect(() => assetRoute(event("/assets/"))).toThrow(HTTPError);
    expect(() =>
      assetRoute(event("/assets/constructor", { params: { file: "constructor" } })),
    ).toThrow(HTTPError);
  });

  test("serves every URL the service worker precaches", async () => {
    for (const url of PRECACHE_URLS.filter((u) => u.startsWith("/assets/"))) {
      const name = url.slice("/assets/".length).split("?")[0] as string;
      const res = await call(assetRoute, event(url, { params: { file: name } }));
      expect(res.status).toBe(200);
    }
  });
});

describe("GET /offline", () => {
  test("renders the offline page", async () => {
    const res = await call(offlineRoute, event("/offline"));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("This page has not been saved to your device.");
  });

  test("is cached hard, because it must survive having no network at all", async () => {
    const res = await call(offlineRoute, event("/offline"));
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
  });

  test("reflects the theme cookie", async () => {
    const res = await call(offlineRoute, event("/offline", { cookie: "theme=dark" }));
    expect(await res.text()).toContain('data-theme="dark"');
  });

  test("links the hashed assets, so a precached page finds precached files", async () => {
    const html = await (await call(offlineRoute, event("/offline"))).text();
    expect(html).toContain(CSS_URL);
    expect(html).toContain(APP_JS_URL);
  });
});

describe("GET /", () => {
  test("404s with an explanation before any edition exists", async () => {
    const res = await call(indexRoute, event("/"));
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("No edition has been built yet.");
    // Still a whole page, not a bare error string.
    expect(html).toContain("<!DOCTYPE html>");
  });

  test("renders the latest edition", async () => {
    seedEdition("2026-08-15");
    seedEdition("2026-08-16");
    seedStory({ id: 1, edition_date: "2026-08-16", title: "Newest story" });
    seedStory({ id: 2, edition_date: "2026-08-15", title: "Older story" });

    const html = await (await call(indexRoute, event("/"))).text();
    expect(html).toContain("Newest story");
    expect(html).not.toContain("Older story");
  });

  test("orders stories by rank", async () => {
    seedEdition("2026-08-16");
    seedStory({ id: 1, rank: 2, title: "Second" });
    seedStory({ id: 2, rank: 1, title: "First" });

    const html = await (await call(indexRoute, event("/"))).text();
    expect(html.indexOf("First")).toBeLessThan(html.indexOf("Second"));
  });

  test("is never cached, since which edition is newest changes daily", async () => {
    seedEdition("2026-08-16");
    const res = await call(indexRoute, event("/"));
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  test("marks Today as the current section", async () => {
    seedEdition("2026-08-16");
    const html = await (await call(indexRoute, event("/"))).text();
    expect(html).toContain('<a href="/" aria-current="page">Today</a>');
  });

  test("offers the whole edition for offline saving", async () => {
    seedEdition("2026-08-16");
    seedStory({ id: 7 });
    const html = await (await call(indexRoute, event("/"))).text();
    expect(html).toContain("data-save-edition");
    expect(html).toContain("/archive/2026-08-16");
    expect(html).toContain("/story/7");
  });
});

describe("GET /archive", () => {
  test("lists every edition, newest first", async () => {
    seedEdition("2026-08-14");
    seedEdition("2026-08-16");
    seedEdition("2026-08-15");

    const html = await (await call(archiveIndexRoute, event("/archive"))).text();
    expect(html.indexOf("/archive/2026-08-16")).toBeLessThan(
      html.indexOf("/archive/2026-08-15"),
    );
    expect(html.indexOf("/archive/2026-08-15")).toBeLessThan(
      html.indexOf("/archive/2026-08-14"),
    );
  });

  test("says so when nothing has been built", async () => {
    const html = await (await call(archiveIndexRoute, event("/archive"))).text();
    expect(html).toContain("No editions have been built yet.");
  });

  test("is not cached, because the list grows", async () => {
    const res = await call(archiveIndexRoute, event("/archive"));
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.status).toBe(200);
  });

  test("marks Archive as the current section", async () => {
    const html = await (await call(archiveIndexRoute, event("/archive"))).text();
    expect(html).toContain('<a href="/archive" aria-current="page">Archive</a>');
  });
});

describe("GET /archive/:date", () => {
  test("renders an edition that exists", async () => {
    seedEdition("2026-08-16");
    seedStory({ id: 5, title: "An archived story" });

    const res = await call(
      archiveDateRoute,
      event("/archive/2026-08-16", { params: { date: "2026-08-16" } }),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("An archived story");
    expect(html).toContain("Sunday, 16 August 2026");
  });

  test("is cached hard, which is what makes the worker's cache-first correct", async () => {
    seedEdition("2026-08-16");
    const res = await call(
      archiveDateRoute,
      event("/archive/2026-08-16", { params: { date: "2026-08-16" } }),
    );
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
  });

  test("404s a date with no edition, rather than an empty page", async () => {
    // An empty page here would be cached by the browser and the worker for a
    // day that will never exist.
    const res = await call(
      archiveDateRoute,
      event("/archive/2020-01-01", { params: { date: "2020-01-01" } }),
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("There is no edition for 2020-01-01.");
  });

  test("404s a malformed date without touching the database", async () => {
    for (const date of ["nope", "2026-8-16", "2026-08-16'", "", "../../etc/passwd"]) {
      const res = await call(archiveDateRoute, event("/archive/x", { params: { date } }));
      expect(res.status).toBe(404);
    }
  });

  test("escapes the requested date in the 404 message", async () => {
    const res = await call(
      archiveDateRoute,
      event("/archive/x", { params: { date: "<script>alert(1)</script>" } }),
    );
    const html = await res.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("does not cache a 404", async () => {
    const res = await call(
      archiveDateRoute,
      event("/archive/2020-01-01", { params: { date: "2020-01-01" } }),
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("GET /story/:id", () => {
  test("renders a story that exists", async () => {
    seedEdition("2026-08-16");
    const story = seedStory();

    const res = await call(
      storyRoute,
      event(`/story/${story.id}`, { params: { id: String(story.id) } }),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Good system design");
    expect(html).toContain(`/epub/story/${story.id}.epub`);
    expect(html).toContain("957 points");
  });

  test("stubs the article when nothing was extracted", async () => {
    seedEdition("2026-08-16");
    const story = seedStory();
    const html = await (
      await call(storyRoute, event("/story/x", { params: { id: String(story.id) } }))
    ).text();
    expect(html).toContain("Article text unavailable");
    expect(html).toContain("No comments were available when this edition was built.");
  });

  test("is cached for a day", async () => {
    seedEdition("2026-08-16");
    const story = seedStory();
    const res = await call(storyRoute, event("/story/x", { params: { id: String(story.id) } }));
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
  });

  test("404s an unknown story", async () => {
    const res = await call(storyRoute, event("/story/1", { params: { id: "1" } }));
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toContain("That story is not in any edition we hold.");
  });

  test("404s a non-numeric id without querying for it", async () => {
    for (const id of ["abc", "1; DROP TABLE stories", "", "1.5", "-1", "0x10"]) {
      const res = await call(storyRoute, event("/story/x", { params: { id } }));
      expect(res.status).toBe(404);
    }
  });

  test("leaves the stories table intact after an injection attempt", async () => {
    seedEdition("2026-08-16");
    const story = seedStory();
    await call(storyRoute, event("/story/x", { params: { id: "1; DROP TABLE stories" } }));
    expect(getDb().query("SELECT COUNT(*) AS n FROM stories").get()).toEqual({ n: 1 });
    expect(story.id).toBe(999_999_001);
  });
});
