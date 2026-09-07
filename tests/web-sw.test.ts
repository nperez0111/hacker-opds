/**
 * The generated service worker source, the page-side shim, and the manifest.
 *
 * These are strings, not modules: a worker runs in its own global scope with
 * its own type universe, so nothing here is type-checked by the build. That
 * makes two cheap assertions unusually valuable - that the source parses at
 * all, and that the routing rules a reader depends on are present in it - since
 * a typo would otherwise ship silently and only fail on a device with no
 * network, which is the one place nobody is watching a console.
 *
 * The scroll correction at the bottom goes further than a syntax check: the
 * shipped source is executed against the markup the story page really emits,
 * parsed by linkedom, with a hand-built viewport standing in for layout. There
 * is no browser in this suite, so the arithmetic is the part that has to be
 * proven here - a correction that is off by a header height puts the reader
 * somewhere they did not ask to be, and on e-ink that costs a page flash to
 * discover.
 */
import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import type { CommentRow } from "~/core/comments";
import type { StoryRow } from "~/core/edition";
import {
  CACHED_AT_HEADER,
  CACHED_BYTES_HEADER,
  CACHE_MAX_AGE_DAYS,
  CACHE_MAX_AGE_MS,
  CACHE_MAX_BYTES,
  CACHE_SWEEP_INTERVAL_MS,
  FRESH_FOR_HEADER,
  SWEEP_MARK_URL,
} from "~/web/offline";
import { commentsHtml } from "~/web/story";
import { SITE_CSS } from "~/web/styles";
import { APP_JS, serviceWorkerJs, webManifest } from "~/web/sw";

const PRECACHE = ["/", "/offline", "/assets/site.css?v=abcd1234", "/assets/app.js?v=ef567890"];

function sw(over: Partial<{ version: string; precache: string[] }> = {}): string {
  return serviceWorkerJs({ version: "v1", precache: PRECACHE, ...over });
}

describe("serviceWorkerJs - parseability", () => {
  test("is syntactically valid JavaScript", () => {
    // `new Function` parses without executing, so the worker's `self` calls
    // are irrelevant here. This is the only syntax check the worker ever gets.
    expect(() => new Function(sw())).not.toThrow();
  });

  test("is strict-mode source", () => {
    expect(sw()).toContain('"use strict";');
  });
});

describe("serviceWorkerJs - cache identity", () => {
  test("puts the version in the cache name", () => {
    expect(sw({ version: "deadbeef" })).toContain('var CACHE = "hacker-opds-deadbeef";');
  });

  test("a different version produces different source", () => {
    // The cache name is what retires a stale build, so a version that did not
    // reach the source would leave readers on last week's stylesheet.
    expect(sw({ version: "aaaa" })).not.toBe(sw({ version: "bbbb" }));
  });

  test("retires previous caches on activate, but only its own", () => {
    const src = sw();
    expect(src).toContain("caches.delete(key)");
    // Namespaced, so a worker on a shared origin does not delete a neighbour's.
    expect(src).toContain('key.indexOf("hacker-opds-") === 0');
    expect(src).toContain("key !== CACHE");
  });

  test("claims clients so the first load is controlled", () => {
    expect(sw()).toContain("self.clients.claim()");
    expect(sw()).toContain("self.skipWaiting()");
  });
});

describe("serviceWorkerJs - precache", () => {
  test("embeds the list as a JSON array", () => {
    expect(sw()).toContain(`var PRECACHE = ${JSON.stringify(PRECACHE)};`);
  });

  test("every precache URL appears in the source", () => {
    const src = sw();
    for (const url of PRECACHE) expect(src).toContain(JSON.stringify(url));
  });

  test("install adds the whole list at once", () => {
    expect(sw()).toContain("cache.addAll(PRECACHE)");
  });

  test("a failed precache cannot wedge the worker in installing", () => {
    // Without the catch a single 404 in the list leaves the previous worker in
    // place forever, and runtime caching would have picked those up anyway.
    const src = sw();
    const install = src.slice(src.indexOf('addEventListener("install"'));
    expect(install).toContain(".catch(function () {})");
  });

  test("an empty precache list is still valid source", () => {
    const src = sw({ precache: [] });
    expect(src).toContain("var PRECACHE = [];");
    expect(() => new Function(src)).not.toThrow();
  });

  test("escapes a URL containing quotes rather than breaking out of the string", () => {
    const hostile = '/assets/"; self.evil()//';
    const src = sw({ precache: [hostile] });
    expect(() => new Function(src)).not.toThrow();

    // The declaration is evaluated on its own: the value has to come back as
    // the literal string, not as source that ran.
    const line = src.slice(src.indexOf("var PRECACHE ="));
    const read = new Function(`${line.slice(0, line.indexOf("\n"))} return PRECACHE;`);
    expect(read()).toEqual([hostile]);
  });
});

describe("serviceWorkerJs - routing", () => {
  test("treats story and archive pages as immutable", () => {
    // Editions never change once built, which is what makes cache-first here
    // correct rather than merely fast.
    const src = sw();
    expect(src).toContain("function isImmutablePage(path)");
    expect(src).toContain("/^\\/story\\/\\d+$/");
    expect(src).toContain("/^\\/archive\\/\\d{4}-\\d{2}-\\d{2}$/");
  });

  test("the immutable-page rules match the URLs the site actually serves", () => {
    // Pulled out of the source and run, so a typo in the pattern fails here
    // rather than on a device with no network.
    const src = sw();
    const build = new Function(`${src.slice(src.indexOf("function isImmutablePage"))}
      ; return isImmutablePage;`);
    const isImmutablePage = build() as (path: string) => boolean;

    expect(isImmutablePage("/story/44921137")).toBe(true);
    expect(isImmutablePage("/archive/2026-08-16")).toBe(true);
    expect(isImmutablePage("/")).toBe(false);
    expect(isImmutablePage("/archive")).toBe(false);
    expect(isImmutablePage("/story/abc")).toBe(false);
    expect(isImmutablePage("/archive/2026-08")).toBe(false);
    expect(isImmutablePage("/offline")).toBe(false);
  });

  test("caches hashed assets first, since their bytes cannot change", () => {
    const src = sw();
    expect(src).toContain("function isAsset(path)");
    expect(src).toContain('path.indexOf("/assets/") === 0');
  });

  test("bypasses everything that is not a page", () => {
    // EPUBs are multi-megabyte downloads, the OPDS feeds belong to the reader
    // app, /healthz must report the live server, and /theme mutates a cookie.
    const src = sw();
    expect(src).toContain('path.indexOf("/epub/") === 0');
    expect(src).toContain('path.indexOf("/opds") === 0');
    expect(src).toContain('path === "/healthz"');
    expect(src).toContain('path === "/theme"');
  });

  test("the bypass rule matches those paths when run", () => {
    const src = sw();
    const build = new Function(`${src.slice(src.indexOf("function isBypassed"))}
      ; return isBypassed;`);
    const isBypassed = build() as (path: string) => boolean;

    expect(isBypassed("/epub/story/1.epub")).toBe(true);
    expect(isBypassed("/opds")).toBe(true);
    expect(isBypassed("/opds/editions")).toBe(true);
    expect(isBypassed("/healthz")).toBe(true);
    expect(isBypassed("/theme")).toBe(true);
    // The root icon path, for the same reason /robots.txt is: navigating to it
    // would otherwise file an icon in the page cache and answer it with the
    // /offline document once the network went away.
    expect(isBypassed("/favicon.ico")).toBe(true);
    expect(isBypassed("/")).toBe(false);
    expect(isBypassed("/story/1")).toBe(false);
    expect(isBypassed("/assets/site.css")).toBe(false);
    // The hashed copy the pages link is *not* bypassed - it is what makes the
    // icon available offline.
    expect(isBypassed("/assets/favicon.ico")).toBe(false);
  });

  test("indexes go network-first, with a deadline", () => {
    // A reader on a captive-portal wifi otherwise waits for the TCP stack to
    // give up, which can be half a minute, with the page already in cache.
    const src = sw();
    expect(src).toContain("function networkFirst(request, timeoutMs)");
    expect(src).toContain("networkFirst(request, 3000)");
    expect(src).toContain("setTimeout(");
  });

  test("falls back to the offline page when the network fails and nothing is cached", () => {
    const src = sw();
    expect(src).toContain('var OFFLINE_URL = "/offline";');
    expect(src).toContain("caches.match(OFFLINE_URL)");
  });

  test("ignores non-GET and cross-origin requests", () => {
    const src = sw();
    expect(src).toContain('request.method !== "GET"');
    expect(src).toContain("url.origin !== self.location.origin");
  });

  test("only intercepts navigations among page requests", () => {
    const src = sw();
    expect(src).toContain('request.mode === "navigate"');
    expect(src).toContain('indexOf("text/html") !== -1');
  });

  test("never stores a non-200 or opaque response", () => {
    const src = sw();
    expect(src).toContain("response.status !== 200");
    expect(src).toContain('response.type === "opaque"');
  });
});

describe("serviceWorkerJs - bulk save", () => {
  test("listens for the save-urls message the page sends", () => {
    const src = sw();
    expect(src).toContain('data.type !== "save-urls"');
    expect(src).toContain('type: "save-progress"');
  });

  test("fetches sequentially rather than in a burst", () => {
    // Thirty parallel requests for pages that each embed a full article is a
    // burst an e-reader radio handles worse than the server does.
    const src = sw();
    expect(src).toContain("return step(i + 1);");
    expect(src).not.toContain("Promise.all(urls");
  });

  test("reports progress and a terminal state", () => {
    const src = sw();
    expect(src).toContain('report("progress")');
    expect(src).toContain('report("done")');
  });
});

describe("serviceWorkerJs - retention, as written", () => {
  test("carries the policy from ~/web/offline rather than its own numbers", () => {
    // The worker is a string, the page shim is a string, and the copy on the
    // edition page is JSX. Nothing type-checks the three against each other,
    // so a reader promised thirty days and given twelve is a change nobody
    // would notice - which is what these literals exist to catch.
    const src = sw();
    expect(src).toContain(`var MAX_AGE_MS = ${CACHE_MAX_AGE_MS};`);
    expect(src).toContain(`var MAX_BYTES = ${CACHE_MAX_BYTES};`);
    expect(src).toContain(`var SWEEP_EVERY_MS = ${CACHE_SWEEP_INTERVAL_MS};`);
    expect(src).toContain(`var STAMP_HEADER = ${JSON.stringify(CACHED_AT_HEADER)};`);
    expect(src).toContain(`var BYTES_HEADER = ${JSON.stringify(CACHED_BYTES_HEADER)};`);
    expect(src).toContain(`var SWEEP_MARK = ${JSON.stringify(SWEEP_MARK_URL)};`);
  });

  test("derives the protected set from PRECACHE, not from a second list", () => {
    // A hardcoded copy of the shell URLs here would go stale the moment the
    // stylesheet changed, and the entry it stopped protecting would be the
    // stylesheet.
    const src = sw();
    expect(src).toContain("var PROTECTED = PRECACHE.concat([SWEEP_MARK])");
    expect(src).toContain("function isProtected(url)");
  });

  test("never sets a timer to drive the sweep", () => {
    // A service worker is killed within seconds of going idle, so a repeating
    // timer in one is either dead code or a leak. The one setTimeout in the
    // file is networkFirst's deadline, which is scoped to a request in flight.
    //
    // Stripped of comments first, for the reason APP_CODE is further down:
    // the worker's own prose explains why it does not use setInterval, and
    // matching on that would fail the test for the explanation.
    const src = sw().replace(/\/\*[\s\S]*?\*\//g, "");
    expect(src).not.toContain("setInterval");
    expect(src.match(/setTimeout\(/g)).toHaveLength(1);
  });

  test("stamps what it stores rather than trusting the origin's Date", () => {
    const src = sw();
    expect(src).toContain("function stamped(response, now)");
    expect(src).toContain("headers.set(STAMP_HEADER, String(now));");
    expect(src).toContain("headers.set(BYTES_HEADER, String(body.size));");
  });

  test("sweeps from activate and from a request, never from nothing", () => {
    const src = sw();
    const activate = src.slice(src.indexOf('addEventListener("activate"'));
    expect(activate).toContain("sweep(Date.now())");
    expect(src).toContain("event.waitUntil(maybeSweep(Date.now()));");
  });
});

/*
 * The worker, executed.
 *
 * Everything below runs the shipped source in a scope where `self`, `caches`,
 * `fetch` and `Date` are supplied by the test. That last one is the whole
 * point: eviction is a function of elapsed time, and the only honest way to
 * assert a thirty-day rule is to move the clock rather than to wait. `Response`,
 * `Headers`, `Blob` and `URL` are the real ones, because the stamping is
 * `response.blob()` into a new `Response` and a fake of that would be a test of
 * the fake.
 */

const ORIGIN = "https://reader.test";
const NOW = 1_800_000_000_000; // 2027-01-15T08:00:00Z, a round wall clock

const DAY_MS = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;

function days(n: number): number {
  return n * DAY_MS;
}

/** Cache keys are absolute URLs, whether they went in as a string or a Request. */
function absolute(target: unknown): string {
  const raw =
    typeof target === "string" ? target : ((target as { url: string }).url ?? "");
  return new URL(raw, `${ORIGIN}/`).href;
}

/** One entry to place in the cache before the worker starts. */
interface SeedEntry {
  url: string;
  /** Written as the worker's own stamp. Omit to model an entry it did not write. */
  at?: number;
  /** Written as the stamped byte count. Defaults to the body's length. */
  bytes?: number;
  /** Written as the origin's freshness promise. Omit for an entry with no window. */
  fresh?: number;
  body?: string;
  /** Written as an origin `Date` header, for the fallback path. */
  date?: string;
}

class FakeCache {
  readonly entries = new Map<string, Response>();

  put(request: unknown, response: Response): Promise<void> {
    this.entries.set(absolute(request), response);
    return Promise.resolve();
  }

  match(request: unknown): Promise<Response | undefined> {
    return Promise.resolve(this.entries.get(absolute(request)));
  }

  delete(request: unknown): Promise<boolean> {
    return Promise.resolve(this.entries.delete(absolute(request)));
  }

  keys(): Promise<Array<{ url: string }>> {
    return Promise.resolve([...this.entries.keys()].map((url) => ({ url })));
  }

  addAll(urls: string[]): Promise<void> {
    for (const url of urls) {
      this.entries.set(absolute(url), new Response("precached"));
    }
    return Promise.resolve();
  }
}

class FakeCacheStorage {
  readonly caches = new Map<string, FakeCache>();

  open(name: string): Promise<FakeCache> {
    let cache = this.caches.get(name);
    if (!cache) {
      cache = new FakeCache();
      this.caches.set(name, cache);
    }
    return Promise.resolve(cache);
  }

  keys(): Promise<string[]> {
    return Promise.resolve([...this.caches.keys()]);
  }

  delete(name: string): Promise<boolean> {
    return Promise.resolve(this.caches.delete(name));
  }

  async match(request: unknown): Promise<Response | undefined> {
    for (const cache of this.caches.values()) {
      const hit = await cache.match(request);
      if (hit) return hit;
    }
    return undefined;
  }
}

interface SaveMessage {
  type: string;
  state: string;
  done: number;
  already: number;
  failed: number;
  total: number;
  url: string | null;
}

/** The worker's reply to the page's purge-cache message. */
interface PurgeMessage {
  type: string;
  dropped: number;
}

interface WorkerOptions {
  now?: number;
  seed?: SeedEntry[];
  /**
   * Body for a path, or null to make the request fail. A string becomes a
   * plain 200; a Response is handed over as-is, so a test can give the origin
   * its own cache-control header.
   */
  network?: (path: string) => string | Response | null;
  /** Reuse storage across worker instances, which is what a real update does. */
  storage?: FakeCacheStorage;
}

interface Worker {
  storage: FakeCacheStorage;
  cache: FakeCache;
  /** Paths the stubbed network was asked for, in order. */
  fetched: string[];
  /** What is in the cache now, as paths, sorted. */
  paths: () => string[];
  entry: (url: string) => Response | undefined;
  at: (url: string) => number;
  setNow: (value: number) => void;
  activate: () => Promise<void>;
  /** extra is merged into the fake request, e.g. to set request.cache. */
  navigate: (path: string, extra?: Record<string, unknown>) => Promise<Response | undefined>;
  save: (urls: string[]) => Promise<SaveMessage[]>;
  purge: () => Promise<PurgeMessage[]>;
  /** Lets the worker's fire-and-forget writes land. */
  settle: () => Promise<void>;
}

const CACHE_NAME = "hacker-opds-v1";

function seedResponse(entry: SeedEntry): Response {
  const body = entry.body ?? "cached body";
  const headers = new Headers({ "content-type": "text/html" });
  if (entry.at !== undefined) headers.set(CACHED_AT_HEADER, String(entry.at));
  // Independent of the stamp, so an undated entry can still be given a size -
  // which is the case the size rule has to handle and the age rule cannot.
  headers.set(CACHED_BYTES_HEADER, String(entry.bytes ?? body.length));
  if (entry.fresh !== undefined) headers.set(FRESH_FOR_HEADER, String(entry.fresh));
  if (entry.date) headers.set("date", entry.date);
  return new Response(body, { status: 200, headers });
}

function boot(options: WorkerOptions = {}): Worker {
  const storage = options.storage ?? new FakeCacheStorage();
  const network = options.network ?? (() => "network body");
  const fetched: string[] = [];
  let now = options.now ?? NOW;

  if (!storage.caches.has(CACHE_NAME)) storage.caches.set(CACHE_NAME, new FakeCache());
  const live = storage.caches.get(CACHE_NAME) as FakeCache;
  for (const entry of options.seed ?? []) {
    live.entries.set(absolute(entry.url), seedResponse(entry));
  }

  const listeners: Record<string, ((event: unknown) => void) | undefined> = {};
  const scope = {
    addEventListener(type: string, fn: (event: unknown) => void) {
      listeners[type] = fn;
    },
    location: { origin: ORIGIN, href: `${ORIGIN}/` },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() },
  };

  const fetchStub = (input: unknown): Promise<Response> => {
    const url = absolute(input);
    fetched.push(new URL(url).pathname);
    const body = network(new URL(url).pathname);
    if (body === null) return Promise.reject(new Error("offline"));
    if (typeof body !== "string") return Promise.resolve(body);
    return Promise.resolve(
      new Response(body, { status: 200, headers: { "content-type": "text/html" } }),
    );
  };

  const clock = { now: () => now, parse: (value: string) => Date.parse(value) };

  new Function("self", "caches", "fetch", "Date", sw())(scope, storage, fetchStub, clock);

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  return {
    storage,
    cache: live,
    fetched,
    paths: () =>
      [...live.entries.keys()].map((url) => new URL(url).pathname + new URL(url).search).sort(),
    entry: (url) => live.entries.get(absolute(url)),
    at: (url) => Number(live.entries.get(absolute(url))?.headers.get(CACHED_AT_HEADER)),
    setNow: (value) => {
      now = value;
    },
    settle,
    activate: async () => {
      const pending: Array<Promise<unknown>> = [];
      listeners.activate?.({ waitUntil: (p: Promise<unknown>) => pending.push(p) });
      await Promise.all(pending);
      await settle();
    },
    navigate: async (path, extra) => {
      const pending: Array<Promise<unknown>> = [];
      let answered: Promise<Response> | undefined;
      listeners.fetch?.({
        request: {
          method: "GET",
          url: `${ORIGIN}${path}`,
          mode: "navigate",
          ...extra,
          headers: { get: (name: string) => (name === "accept" ? "text/html" : null) },
        },
        waitUntil: (p: Promise<unknown>) => pending.push(p),
        respondWith: (p: Promise<Response>) => {
          answered = Promise.resolve(p);
        },
      });
      const response = answered ? await answered : undefined;
      await Promise.all(pending);
      await settle();
      return response;
    },
    save: async (urls) => {
      const posted: SaveMessage[] = [];
      const pending: Array<Promise<unknown>> = [];
      listeners.message?.({
        data: { type: "save-urls", urls },
        source: { postMessage: (message: SaveMessage) => posted.push(message) },
        waitUntil: (p: Promise<unknown>) => pending.push(p),
      });
      await Promise.all(pending);
      await settle();
      return posted;
    },
    purge: async () => {
      const posted: PurgeMessage[] = [];
      const pending: Array<Promise<unknown>> = [];
      listeners.message?.({
        data: { type: "purge-cache" },
        source: { postMessage: (message: PurgeMessage) => posted.push(message) },
        waitUntil: (p: Promise<unknown>) => pending.push(p),
      });
      await Promise.all(pending);
      await settle();
      return posted;
    },
  };
}

describe("serviceWorkerJs - stamping, executed", () => {
  test("records when this device stored an entry, and how big it is", async () => {
    const worker = boot({ now: NOW, network: () => "a page" });
    await worker.navigate("/story/1");

    const entry = worker.entry("/story/1");
    expect(entry?.headers.get(CACHED_AT_HEADER)).toBe(String(NOW));
    expect(entry?.headers.get(CACHED_BYTES_HEADER)).toBe("6");
  });

  test("keeps the response's own headers, so the entry is still servable", async () => {
    const worker = boot({ now: NOW });
    await worker.navigate("/story/1");

    expect(worker.entry("/story/1")?.headers.get("content-type")).toBe("text/html");
    expect(await worker.entry("/story/1")?.text()).toBe("network body");
  });

  test("re-stamps on a background refresh, so a page being read never ages out", async () => {
    // cacheFirst refreshes behind a hit. Without the re-stamp, a story opened
    // every week would still expire thirty days after it was first opened.
    const worker = boot({ now: NOW, seed: [{ url: "/story/1", at: NOW - days(20) }] });
    worker.setNow(NOW + days(1));
    await worker.navigate("/story/1");

    expect(worker.at("/story/1")).toBe(NOW + days(1));
  });
});

describe("serviceWorkerJs - freshness, executed", () => {
  test("records how long the origin promises to keep a response", async () => {
    const worker = boot({
      now: NOW,
      network: (path) =>
        path === "/story/1"
          ? new Response("a page", {
              headers: { "content-type": "text/html", "cache-control": "public, max-age=86400" },
            })
          : "network body",
    });
    await worker.navigate("/story/1");

    expect(worker.entry("/story/1")?.headers.get(FRESH_FOR_HEADER)).toBe("86400");
  });

  test("stores a zero window when the origin makes no promise", async () => {
    const worker = boot({ now: NOW });
    await worker.navigate("/story/1");

    expect(worker.entry("/story/1")?.headers.get(FRESH_FOR_HEADER)).toBe("0");
  });

  test("serves an entry within its window without touching the network", async () => {
    // The quiet-page fix: a story opened twice in a day no longer pays for a
    // full network round trip on the second visit.
    const worker = boot({
      now: NOW,
      seed: [{ url: "/story/1", at: NOW - days(1), fresh: 86400 }],
    });
    await worker.navigate("/story/1");

    expect(worker.fetched).toEqual([]);
    expect(worker.at("/story/1")).toBe(NOW - days(1));
  });

  test("revalidates behind the scenes once an entry is past its window", async () => {
    const worker = boot({
      now: NOW,
      seed: [{ url: "/story/1", at: NOW - days(2), fresh: 86400 }],
    });
    await worker.navigate("/story/1");

    expect(worker.fetched).toEqual(["/story/1"]);
  });

  test("still revalidates an entry that carries no window", async () => {
    // Entries from before the window existed must not read as fresh forever.
    const worker = boot({
      now: NOW,
      seed: [{ url: "/story/1", at: NOW - days(1) }],
    });
    await worker.navigate("/story/1");

    expect(worker.fetched).toEqual(["/story/1"]);
  });

  test("a reload asks for fresh bytes even inside the window", async () => {
    const worker = boot({
      now: NOW,
      seed: [{ url: "/story/1", at: NOW - days(1), fresh: 86400 }],
    });
    await worker.navigate("/story/1", { cache: "reload" });

    expect(worker.fetched).toEqual(["/story/1"]);
    expect(worker.at("/story/1")).toBe(NOW);
  });

  test("a failed reload keeps and returns the cached response", async () => {
    const worker = boot({
      now: NOW,
      seed: [{ url: "/story/1", at: NOW - days(1), fresh: 86400, body: "cached" }],
      network: () => new Response("unavailable", { status: 503 }),
    });
    const cached = worker.entry("/story/1");
    const response = await worker.navigate("/story/1", { cache: "reload" });

    expect(response).toBe(cached);
    expect(worker.entry("/story/1")).toBe(cached);
    expect(await response?.text()).toBe("cached");
  });
});

describe("serviceWorkerJs - age eviction, executed", () => {
  test(`drops what is older than ${CACHE_MAX_AGE_DAYS} days and keeps the rest`, async () => {
    const worker = boot({
      now: NOW,
      seed: [
        { url: "/story/1", at: NOW - days(CACHE_MAX_AGE_DAYS + 1) },
        { url: "/story/2", at: NOW - days(CACHE_MAX_AGE_DAYS - 1) },
        { url: "/archive/2026-08-16", at: NOW - days(90) },
      ],
    });

    await worker.activate();

    expect(worker.paths()).toEqual([SWEEP_MARK_URL, "/story/2"]);
  });

  test("keeps an entry that is exactly at the limit", async () => {
    // The comparison is strictly greater, so the promise is "thirty days" and
    // not "twenty-nine and a bit".
    const worker = boot({
      now: NOW,
      seed: [{ url: "/story/1", at: NOW - CACHE_MAX_AGE_MS }],
    });
    await worker.activate();

    expect(worker.paths()).toContain("/story/1");
  });

  test("never touches the app shell, however old it is", async () => {
    /*
     * The one way this feature could make the site worse than it was. Only
     * install puts these back, install only runs on a worker update, and a
     * reader whose shell expired while out of range gets a browser error
     * instead of the offline page.
     */
    const worker = boot({
      now: NOW,
      seed: [
        { url: "/", at: NOW - days(400) },
        { url: "/offline", at: NOW - days(400) },
        { url: PRECACHE[2] as string, at: NOW - days(400) },
        { url: PRECACHE[3] as string, at: NOW - days(400) },
        { url: "/story/1", at: NOW - days(400) },
      ],
    });

    await worker.activate();

    expect(worker.paths()).toEqual([
      "/",
      SWEEP_MARK_URL,
      "/assets/app.js?v=ef567890",
      "/assets/site.css?v=abcd1234",
      "/offline",
    ]);
  });

  test("leaves an entry it cannot date alone", async () => {
    // Treating an unknown age as ancient would turn any future bug in the
    // stamping into the silent deletion of a reader's whole library.
    const worker = boot({ now: NOW, seed: [{ url: "/story/1" }] });
    await worker.activate();

    expect(worker.paths()).toContain("/story/1");
  });

  test("falls back to the origin's Date for an entry with no stamp", async () => {
    const worker = boot({
      now: NOW,
      seed: [
        { url: "/story/1", date: new Date(NOW - days(40)).toUTCString() },
        { url: "/story/2", date: new Date(NOW - days(2)).toUTCString() },
      ],
    });
    await worker.activate();

    expect(worker.paths()).toEqual([SWEEP_MARK_URL, "/story/2"]);
  });

  test("keeps everything when the clock has gone backwards", async () => {
    // A device whose time was wrong and then got fixed must not lose its
    // entire cache in one pass.
    const worker = boot({ now: NOW, seed: [{ url: "/story/1", at: NOW + days(400) }] });
    await worker.activate();

    expect(worker.paths()).toContain("/story/1");
  });
});

describe("serviceWorkerJs - size eviction, executed", () => {
  test("sheds the oldest entries until it is back under the budget", async () => {
    const worker = boot({
      now: NOW,
      seed: [
        { url: "/story/1", at: NOW - days(4), bytes: 20 * MB },
        { url: "/story/2", at: NOW - days(3), bytes: 20 * MB },
        { url: "/story/3", at: NOW - days(2), bytes: 20 * MB },
        { url: "/story/4", at: NOW - days(1), bytes: 20 * MB },
        { url: "/story/5", at: NOW, bytes: 20 * MB },
      ],
    });

    await worker.activate();

    // 100 MB against a 64 MB budget: the two oldest go, 60 MB remains.
    expect(worker.paths()).toEqual([
      SWEEP_MARK_URL,
      "/story/3",
      "/story/4",
      "/story/5",
    ]);
    expect(CACHE_MAX_BYTES).toBe(64 * MB);
  });

  test("does nothing at all while the cache is inside the budget", async () => {
    const worker = boot({
      now: NOW,
      seed: [
        { url: "/story/1", at: NOW - days(4), bytes: 30 * MB },
        { url: "/story/2", at: NOW, bytes: 30 * MB },
      ],
    });
    await worker.activate();

    expect(worker.paths()).toEqual([SWEEP_MARK_URL, "/story/1", "/story/2"]);
  });

  test("counts the shell against the budget but still refuses to evict it", async () => {
    // Otherwise a large shell would be free, and the total the cap is defending
    // would be understated by exactly the amount that cannot be reclaimed.
    const worker = boot({
      now: NOW,
      seed: [
        { url: "/", at: NOW - days(10), bytes: 60 * MB },
        { url: "/story/1", at: NOW - days(2), bytes: 10 * MB },
        { url: "/story/2", at: NOW - days(1), bytes: 10 * MB },
      ],
    });

    await worker.activate();

    expect(worker.paths()).toEqual(["/", SWEEP_MARK_URL]);
  });

  test("sheds undated entries first, since the age rule cannot reach them", async () => {
    const worker = boot({
      now: NOW,
      seed: [
        { url: "/story/1", at: NOW - days(20), bytes: 40 * MB },
        { url: "/story/2", bytes: 40 * MB },
      ],
    });

    await worker.activate();

    expect(worker.paths()).toEqual([SWEEP_MARK_URL, "/story/1"]);
  });
});

describe("serviceWorkerJs - when the sweep runs", () => {
  test("activate always sweeps, whatever happened yesterday", async () => {
    const worker = boot({
      now: NOW,
      seed: [
        { url: SWEEP_MARK_URL, at: NOW - 60_000 },
        { url: "/story/1", at: NOW - days(40) },
      ],
    });

    await worker.activate();

    expect(worker.paths()).toEqual([SWEEP_MARK_URL]);
  });

  test("a request sweeps when the last one was long enough ago", async () => {
    const worker = boot({
      now: NOW,
      seed: [
        { url: SWEEP_MARK_URL, at: NOW - CACHE_SWEEP_INTERVAL_MS - 1 },
        { url: "/story/1", at: NOW - days(40) },
      ],
    });

    await worker.navigate("/archive");

    expect(worker.paths()).not.toContain("/story/1");
    expect(worker.at(SWEEP_MARK_URL)).toBe(NOW);
  });

  test("a request does not sweep again within the interval", async () => {
    // The cost being avoided is an index walk of several hundred entries on
    // every cold start of the worker, which on this hardware is not free.
    const worker = boot({
      now: NOW,
      seed: [
        { url: SWEEP_MARK_URL, at: NOW - 60_000 },
        { url: "/story/1", at: NOW - days(40) },
      ],
    });

    await worker.navigate("/archive");

    expect(worker.paths()).toContain("/story/1");
  });

  test("sweeps at most once per worker instance", async () => {
    const worker = boot({ now: NOW, seed: [{ url: "/story/1", at: NOW - days(40) }] });

    await worker.navigate("/archive");
    expect(worker.paths()).not.toContain("/story/1");

    // A second entry ages out while this instance is still alive. It survives
    // until something else wakes the worker, which is the trade the throttle
    // makes and is worth stating out loud.
    worker.cache.entries.set(
      absolute("/story/2"),
      seedResponse({ url: "/story/2", at: NOW - days(40) }),
    );
    await worker.navigate("/archive");
    expect(worker.paths()).toContain("/story/2");
  });

  test("the next worker instance picks it up", async () => {
    const first = boot({ now: NOW, seed: [{ url: "/story/1", at: NOW - days(40) }] });
    await first.navigate("/archive");

    const second = boot({ storage: first.storage, now: NOW + CACHE_SWEEP_INTERVAL_MS + 1 });
    second.cache.entries.set(
      absolute("/story/2"),
      seedResponse({ url: "/story/2", at: NOW - days(40) }),
    );
    await second.navigate("/archive");

    expect(second.paths()).not.toContain("/story/2");
  });

  test("a bypassed request is not what triggers it", async () => {
    // An EPUB download or a /healthz poll should not be paying for the sweep.
    const worker = boot({ now: NOW, seed: [{ url: "/story/1", at: NOW - days(40) }] });
    await worker.navigate("/healthz");

    expect(worker.paths()).toContain("/story/1");
  });
});

describe("serviceWorkerJs - serving an expired entry", () => {
  test("goes to the network instead, and drops the stale copy", async () => {
    const worker = boot({
      now: NOW,
      seed: [{ url: "/story/1", at: NOW - days(40), body: "stale" }],
      network: () => "fresh",
    });

    const response = await worker.navigate("/story/1");

    expect(await response?.text()).toBe("fresh");
    expect(await worker.entry("/story/1")?.text()).toBe("fresh");
    expect(worker.at("/story/1")).toBe(NOW);
  });

  test("still answers with the stale copy when the network is gone", async () => {
    // The entry is reclaimed either way, which is what the quota cares about;
    // losing the radio in the same second a page aged out should not also cost
    // the reader the page.
    const worker = boot({
      now: NOW,
      seed: [{ url: "/story/1", at: NOW - days(40), body: "stale" }],
      network: () => null,
    });

    const response = await worker.navigate("/story/1");

    expect(await response?.text()).toBe("stale");
    expect(worker.entry("/story/1")).toBeUndefined();
  });

  test("serves a fresh entry from the cache, as before", async () => {
    const worker = boot({
      now: NOW,
      seed: [{ url: "/story/1", at: NOW - days(1), body: "cached" }],
      network: () => "fresh",
    });

    const response = await worker.navigate("/story/1");

    expect(await response?.text()).toBe("cached");
    // ...and refreshed behind the reader's back, which is what it did before.
    expect(worker.fetched).toEqual(["/story/1"]);
  });
});

describe("serviceWorkerJs - cache purge, executed", () => {
  test("drops every saved page but keeps the shell and its bookkeeping", async () => {
    // This backs the pull-to-refresh gesture: after the drop, nothing served
    // from this cache can be stale, while the precache that keeps the shell
    // working offline and the content-hashed assets survive untouched.
    const worker = boot({
      now: NOW,
      seed: [
        { url: "/story/1", at: NOW },
        { url: "/search?q=x", at: NOW },
        { url: "/assets/site.css?v=abcd1234", at: NOW },
        { url: "/", at: NOW },
        { url: "/offline", at: NOW },
        { url: "/__hopds/swept", at: NOW },
      ],
    });

    const posted = await worker.purge();

    expect(worker.paths()).toEqual([
      "/",
      "/__hopds/swept",
      "/assets/site.css?v=abcd1234",
      "/offline",
    ]);
    expect(posted).toEqual([{ type: "cache-purged", dropped: 2 }]);
  });

  test("sends a purged page back to the network on the next visit", async () => {
    const worker = boot({
      now: NOW,
      seed: [{ url: "/story/1", at: NOW }],
    });

    await worker.purge();
    const response = await worker.navigate("/story/1");

    expect(worker.fetched).toEqual(["/story/1"]);
    expect(await response?.text()).toBe("network body");
  });
});

describe("serviceWorkerJs - bulk save, executed", () => {
  test("skips a page that is already here and inside its thirty days", async () => {
    // This is what makes the button's label honest: pages opened while reading
    // were cached as they were read, and the save only pays for the rest.
    const worker = boot({
      now: NOW,
      seed: [{ url: "/story/1", at: NOW - days(2) }],
    });

    const messages = await worker.save(["/story/1", "/story/2"]);
    const done = messages[messages.length - 1] as SaveMessage;

    expect(worker.fetched).toEqual(["/story/2"]);
    expect(done.state).toBe("done");
    expect(done.already).toBe(1);
    expect(done.done).toBe(2);
    expect(done.failed).toBe(0);
  });

  test("refetches a page that has aged out", async () => {
    const worker = boot({ now: NOW, seed: [{ url: "/story/1", at: NOW - days(40) }] });

    const messages = await worker.save(["/story/1"]);

    expect(worker.fetched).toEqual(["/story/1"]);
    expect((messages[messages.length - 1] as SaveMessage).already).toBe(0);
  });

  test("stamps what it stores, so a saved edition expires like anything else", async () => {
    const worker = boot({ now: NOW });
    await worker.save(["/story/1"]);

    expect(worker.at("/story/1")).toBe(NOW);
  });

  test("names each page back to the sender as it lands", async () => {
    // Which is what lets the list the save was launched from grow its markers
    // as the save walks down it, rather than on the next navigation.
    const worker = boot({ now: NOW });
    const messages = await worker.save(["/story/1", "/story/2"]);

    expect(messages.map((m) => m.url)).toEqual([null, "/story/1", "/story/2", null]);
  });

  test("does not name a page it failed to fetch", async () => {
    const worker = boot({ now: NOW, network: () => null });
    const messages = await worker.save(["/story/1"]);
    const done = messages[messages.length - 1] as SaveMessage;

    expect(messages.map((m) => m.url)).toEqual([null, null, null]);
    expect(done.failed).toBe(1);
    expect(done.done).toBe(0);
  });

  test("sweeps once the save is finished", async () => {
    // A bulk save is the largest single write this application makes, so it is
    // the one moment the byte budget is most likely to have been crossed.
    const worker = boot({
      now: NOW,
      seed: [{ url: "/story/9", at: NOW - days(40) }],
    });

    await worker.save(["/story/1"]);

    expect(worker.paths()).not.toContain("/story/9");
  });
});

describe("APP_JS", () => {
  test("is syntactically valid JavaScript", () => {
    expect(() => new Function(APP_JS)).not.toThrow();
  });

  test("does nothing at all where service workers are unavailable", () => {
    // Everything on the page has to work with this script absent or inert.
    expect(APP_JS).toContain('if (!("serviceWorker" in navigator)) return;');
  });

  test("registers the worker at the root scope", () => {
    expect(APP_JS).toContain('register("/assets/sw.js", { scope: "/" })');
  });

  test("marks the document so the stylesheet can reveal the offline controls", () => {
    expect(APP_JS).toContain('setAttribute("data-sw", "ready")');
  });

  test("reads the save list from the attribute the edition view writes", () => {
    expect(APP_JS).toContain('querySelector("[data-save-edition]")');
    expect(APP_JS).toContain('querySelector("[data-save-status]")');
  });

  test("survives an unparseable save list instead of throwing on every page", () => {
    expect(APP_JS).toContain("JSON.parse(");
    expect(APP_JS).toContain("catch (err) {");
  });

  test("waits for the DOM before wiring the button", () => {
    expect(APP_JS).toContain('document.readyState === "loading"');
    expect(APP_JS).toContain('addEventListener("DOMContentLoaded", wire)');
  });
});

describe("APP_JS - offline markers, as written", () => {
  test("judges a marker by the same clock and header the worker stamps with", () => {
    // Two strings that have to agree and that nothing type-checks against each
    // other. Disagreeing means a marker next to a story the worker threw away
    // last week, which is a lie the reader only discovers with no network.
    expect(APP_JS).toContain(`var SAVED_MAX_AGE_MS = ${CACHE_MAX_AGE_MS};`);
    expect(APP_JS).toContain(`var SAVED_STAMP = ${JSON.stringify(CACHED_AT_HEADER)};`);
  });

  test("reveals by removing the attribute the markup shipped with", () => {
    // Never by writing a class or a style: the server-rendered state is the
    // truthful one, and a script that has not run must leave it alone.
    expect(APP_JS).toContain('node.removeAttribute("hidden")');
    expect(APP_CODE).not.toContain('setAttribute("data-saved-mark"');
  });

  test("does nothing where there is no Cache API to ask", () => {
    expect(APP_JS).toContain("if (!window.caches || !document.querySelectorAll) return;");
  });

  test("looks pages up one at a time", () => {
    // Thirty concurrent Cache API reads on an e-reader is a burst of storage
    // work competing with the render of the page being annotated.
    expect(APP_JS).toContain("next(i + 1);");
    expect(APP_CODE).not.toContain("Promise.all");
  });

  test("marks a page as the save reports it, rather than on the next visit", () => {
    expect(APP_JS).toContain("if (data.url) reveal(markFor(data.url));");
  });
});

/*
 * The markers, executed.
 *
 * The DOM here is hand-built rather than rendered, which is a seam: the
 * attribute names below are asserted against the real markup over in
 * web-views.test.tsx, and this file proves what the script does with them. The
 * thing that has to be proven here is the arithmetic - a marker is shown for a
 * cached page and withheld for one that has aged out - and that needs an
 * injected clock, which is why `Date` is a parameter of the evaluated source.
 */
const MARK_HTML =
  '<ol class="stories">' +
  '<li><a class="story-link" href="/story/1">' +
  '<span class="saved" role="img" data-saved-mark="/story/1" hidden>\u2193</span></a></li>' +
  '<li><a class="story-link" href="/story/2">' +
  '<span class="saved" role="img" data-saved-mark="/story/2" hidden>\u2193</span></a></li>' +
  '<li><a class="story-link" href="/story/3">' +
  '<span class="saved" role="img" data-saved-mark="/story/3" hidden>\u2193</span></a></li>' +
  "</ol>" +
  '<span class="meta" data-save-status></span>';

interface MarkerPage {
  /** URLs whose marker is now visible. */
  revealed: () => string[];
  status: () => string;
}

/** `at` is the stamp on the cached entry; a URL that is absent is not cached. */
async function markerPage(
  cached: Record<string, number | null>,
  options: { now?: number; status?: string } = {},
): Promise<MarkerPage> {
  const now = options.now ?? NOW;
  const { document } = parseHTML(
    `<!doctype html><html><body>${MARK_HTML}</body></html>`,
  );
  if (options.status) {
    (document.querySelector("[data-save-status]") as { textContent: string }).textContent =
      options.status;
  }

  const caches = {
    match(url: string): Promise<Response | undefined> {
      if (!(url in cached)) return Promise.resolve(undefined);
      const at = cached[url];
      const headers = new Headers();
      if (at !== null) headers.set(CACHED_AT_HEADER, String(at));
      return Promise.resolve(new Response("", { headers }));
    },
  };

  const window = { caches };
  const navigator = {
    serviceWorker: {
      register: () => Promise.resolve({}),
      addEventListener: () => {},
    },
  };

  new Function("window", "document", "navigator", "caches", "Date", "setTimeout", APP_JS)(
    window,
    document,
    navigator,
    caches,
    { now: () => now },
    (fn: () => void) => {
      fn();
      return 0;
    },
  );

  // The scan walks the list one promise at a time, so one turn per entry plus
  // slack. There is no timer involved, only microtasks.
  for (let i = 0; i < 16; i += 1) await Promise.resolve();

  return {
    revealed: () =>
      Array.from(document.querySelectorAll("[data-saved-mark]"))
        .filter((node) => !(node as unknown as Element).hasAttribute("hidden"))
        .map((node) => (node as unknown as Element).getAttribute("data-saved-mark") ?? ""),
    status: () =>
      (document.querySelector("[data-save-status]") as { textContent: string } | null)
        ?.textContent ?? "",
  };
}

describe("APP_JS - offline markers, executed", () => {
  test("reveals the marker for a page that is in the cache", async () => {
    const page = await markerPage({ "/story/1": NOW - days(2), "/story/3": NOW - days(2) });
    expect(page.revealed()).toEqual(["/story/1", "/story/3"]);
  });

  test("leaves every marker hidden when nothing is cached", async () => {
    // A first visit, and the state the markup ships in.
    const page = await markerPage({});
    expect(page.revealed()).toEqual([]);
  });

  test("withholds the marker from a page that has aged out", async () => {
    // The worker may not have swept it yet, but it is not going to survive the
    // next sweep, and a marker for it would be a promise the site cannot keep.
    const page = await markerPage({
      "/story/1": NOW - days(CACHE_MAX_AGE_DAYS + 1),
      "/story/2": NOW - days(CACHE_MAX_AGE_DAYS - 1),
    });
    expect(page.revealed()).toEqual(["/story/2"]);
  });

  test("shows a marker for an entry it cannot date, matching the worker", async () => {
    // The worker declines to expire an undated entry, so the page must decline
    // to hide it. The two disagreeing is a marker that flickers on the arrow
    // and off on the sweep, or worse, the other way round.
    const page = await markerPage({ "/story/2": null });
    expect(page.revealed()).toEqual(["/story/2"]);
  });

  test("counts what it found into the save button's status line", async () => {
    const page = await markerPage({ "/story/1": NOW, "/story/2": NOW });
    expect(page.status()).toBe("2 of 3 already on this device.");
  });

  test("says so plainly when the whole list is already here", async () => {
    const page = await markerPage({
      "/story/1": NOW,
      "/story/2": NOW,
      "/story/3": NOW,
    });
    expect(page.status()).toBe("Every story here is already on this device.");
  });

  test("says nothing at all when nothing is saved", async () => {
    // "0 of 30 already on this device" is a sentence that costs a line of an
    // e-ink panel to say what the absence of every marker already says.
    expect((await markerPage({})).status()).toBe("");
  });

  test("never overwrites a save already in progress", async () => {
    // Both speak through the same element, and the count is the one that can
    // arrive late.
    const page = await markerPage({ "/story/1": NOW }, { status: "Saving 4 of 31..." });
    expect(page.status()).toBe("Saving 4 of 31...");
    expect(page.revealed()).toEqual(["/story/1"]);
  });
});

/*
 * The scroll correction.
 *
 * Everything below runs the shipped source. The DOM is linkedom parsing the
 * markup commentsHtml really produces, so the selectors are matched by a real
 * selector engine against real markup; layout is the fake, because layout is
 * the one thing a test without a browser cannot have. The fake is honest about
 * the only physics that matters here: collapsing a comment moves the content
 * *below* it and leaves the comment's own document position alone.
 */

/** 1.75rem at the site's 20px root: one row of the pinned header stack. */
const CHEAD_H = 35;

const T0 = 1_755_302_400; // 2025-08-16T00:00:00Z

const STORY: StoryRow = {
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
};

function commentRow(over: Partial<CommentRow>): CommentRow {
  return {
    id: 1,
    story_id: STORY.id,
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

/**
 * c1 > c2 > c3, nested by the page's own renderer.
 *
 * Written this way rather than as a hand-typed fixture so that a change to the
 * comment markup - a class rename, the author link moving out of the summary -
 * breaks these tests instead of quietly turning the enhancement off.
 */
const THREAD_HTML = commentsHtml(STORY, [
  [
    commentRow({ id: 1, depth: 0, parent_id: null, sort_index: 0, author: "alice" }),
    commentRow({ id: 2, depth: 1, parent_id: 1, sort_index: 1, author: "bob" }),
    commentRow({ id: 3, depth: 2, parent_id: 2, sort_index: 2, author: "carol" }),
  ],
]);

/**
 * A whole story page: the header the back arrow bottoms out at, three top-level
 * threads inside the section the page really wraps them in, the same "Back to
 * top" actions paragraph, and the jump control as `StoryView` ships it.
 *
 * Built from `commentsHtml` for the same reason as above. The control is
 * spelled out because it comes from a JSX component this file cannot render,
 * and `tests/web-views.test.tsx` holds the assertion that the real one still
 * carries these attributes.
 */
const JUMP_HTML =
  `<header class="story-head" id="top"><h1>A story</h1></header>` +
  `<section class="comments" id="comments"><h2>3 comments</h2>` +
  commentsHtml(STORY, [
    [
      commentRow({ id: 1, depth: 0, parent_id: null, sort_index: 0, author: "alice" }),
      commentRow({ id: 2, depth: 1, parent_id: 1, sort_index: 1, author: "bob" }),
      commentRow({ id: 3, depth: 2, parent_id: 2, sort_index: 2, author: "carol" }),
    ],
    [commentRow({ id: 10, root_id: 10, depth: 0, sort_index: 3, author: "dan" })],
    [commentRow({ id: 20, root_id: 20, depth: 0, sort_index: 4, author: "erin" })],
  ]) +
  `<p class="actions"><a class="btn jump" href="#top">Back to top</a></p>` +
  `</section>` +
  `<div class="thread-jump" data-thread-jump hidden>` +
  `<button class="thread-jump-btn" type="button" data-thread-jump-to="prev">` +
  `<svg class="thread-jump-icon"><path d="M12 20V5"></path></svg></button>` +
  `<button class="thread-jump-btn" type="button" data-thread-jump-to="next">` +
  `<svg class="thread-jump-icon"><path d="M12 4v15"></path></svg></button>` +
  `</div>`;

/**
 * One function out of the shipped source, by brace counting, so it can be run
 * on its own. Throwing when it is absent makes a rename fail here rather than
 * silently reducing this file to a syntax check.
 */
function extractFunction(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`APP_JS has no function named ${name}`);
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${name} is not brace-balanced in APP_JS`);
}

interface Rect {
  top: number;
}

interface DetailsEl {
  id: string;
  className: string;
  open?: boolean;
  getBoundingClientRect: () => Rect;
}

interface NodeLike {
  dispatchEvent: (event: unknown) => boolean;
  closest?: (selector: string) => DetailsEl | null;
  parentNode?: NodeLike | null;
  getAttribute?: (name: string) => string | null;
}

interface ClickOptions {
  /** False when the default action did not run, so nothing actually toggled. */
  toggles?: boolean;
  /** The browser's own scroll change - anchoring, or clamping at a shortened
   *  document - which lands before the next frame. */
  adjust?: (view: { y: number }) => void;
}

interface PageOptions {
  scrollY?: number;
  /** Document-space top of each comment. Unchanged by a collapse: only what is
   *  below a collapsing comment moves. */
  tops?: Record<string, number>;
  /** False models a browser with no <details>, where `open` stays undefined. */
  details?: boolean;
  /** False models a browser with no requestAnimationFrame. */
  raf?: boolean;
  /** True renders the full discussion section and the jump button with it. */
  jump?: boolean;
  /** Viewport-space top of each jump stop, keyed by id. */
  stops?: Record<string, number>;
}

interface Page {
  /** Every scrollBy the script asked for, in order. */
  scrolls: number[];
  /** Event types the script registered on the document. */
  registrations: string[];
  /** Selectors the script looked up. Delegation means it looks up none. */
  selectors: string[];
  /** Callbacks still waiting, to prove the script scheduled nothing. */
  pending: () => number;
  /** Where a comment's top edge now sits relative to the viewport. */
  topOf: (id: string) => number;
  scrollY: () => number;
  find: (selector: string) => NodeLike;
  click: (target: unknown, options?: ClickOptions) => void;
  /** The jump control's box, or null when the page never rendered one. */
  jump: () => NodeLike | null;
  /** One of the two arrows, by direction. */
  arrow: (to: "prev" | "next") => NodeLike;
  /** The glyph inside an arrow, which is what a real tap lands on. */
  glyph: (to: "prev" | "next") => NodeLike;
  /** The <html> element, which is where the reveal writes its marker. */
  root: () => NodeLike;
}

function page(opts: PageOptions = {}): Page {
  const { document, Event } = parseHTML(
    `<!doctype html><html><body>${opts.jump ? JUMP_HTML : THREAD_HTML}</body></html>`,
  );

  const view = { y: opts.scrollY ?? 0 };
  const tops = opts.tops ?? { c1: 1000, c2: 1400, c3: 1800 };
  const scrolls: number[] = [];
  const registrations: string[] = [];
  const selectors: string[] = [];
  const frames: Array<() => void> = [];
  const timers: Array<() => void> = [];

  for (const node of Array.from(document.querySelectorAll("details.comment"))) {
    const el = node as unknown as DetailsEl;
    const id = el.id;
    el.getBoundingClientRect = () => ({ top: (tops[id] ?? 0) - view.y });
    if (opts.details !== false) el.open = true;
  }

  /*
   * The jump stops, in document space like the comments above. The actions
   * paragraph has no id of its own - it does not need one, nothing links to it
   * - so it answers to "foot" here. The story header answers to its own id,
   * "top", which is the anchor the Back to top link already uses.
   */
  const stopTops = opts.stops ?? {
    top: -400,
    tA: 200,
    tB: 900,
    tC: 1600,
    foot: 2300,
  };
  for (const node of Array.from(
    document.querySelectorAll(".story-head, .comments .thread, .comments .actions"),
  )) {
    const el = node as unknown as DetailsEl;
    const key = el.id || "foot";
    el.getBoundingClientRect = () => ({ top: (stopTops[key] ?? 0) - view.y });
  }

  const doc = document as unknown as {
    addEventListener: (type: string, fn: unknown, capture?: boolean) => void;
    querySelector: (selector: string) => unknown;
    querySelectorAll: (selector: string) => unknown;
  };
  const realAdd = doc.addEventListener.bind(doc);
  const realQuery = doc.querySelector.bind(doc);
  const realQueryAll = doc.querySelectorAll.bind(doc);
  doc.addEventListener = (type, fn, capture) => {
    registrations.push(type);
    realAdd(type, fn, capture);
  };
  doc.querySelector = (selector) => {
    selectors.push(selector);
    return realQuery(selector);
  };
  doc.querySelectorAll = (selector) => {
    selectors.push(selector);
    return realQueryAll(selector);
  };

  const window = {
    /*
     * What getComputedStyle(summary).top resolves to under the real
     * stylesheet: one header height per depth level, with dx repeating d5.
     */
    getComputedStyle(node: unknown) {
      const summary = node as { parentNode: { className: string } };
      const found = /\bd(\d|x)\b/.exec(summary.parentNode.className);
      const level = found ? (found[1] === "x" ? 5 : Number(found[1] ?? 0)) : 0;
      return { top: `${level * CHEAD_H}px` };
    },
    scrollBy(_x: number, y: number) {
      scrolls.push(y);
      view.y += y;
    },
    requestAnimationFrame:
      opts.raf === false
        ? undefined
        : (fn: () => void) => {
            frames.push(fn);
          },
  };

  /*
   * navigator is empty on purpose. The service-worker half of the file has to
   * stay inert while the scroll correction runs, because a browser too old for
   * a worker is exactly the one whose reader most needs their place kept.
   */
  new Function("window", "document", "navigator", "setTimeout", APP_JS)(
    window,
    document,
    {},
    (fn: () => void) => {
      timers.push(fn);
      return 0;
    },
  );

  function ownerDetails(node: NodeLike): DetailsEl | null {
    const start = node.closest ? node : (node.parentNode ?? null);
    if (!start || !start.closest) return null;
    return start.closest("details.comment");
  }

  function flush(): void {
    for (const fn of frames.splice(0).concat(timers.splice(0))) fn();
  }

  return {
    scrolls,
    registrations,
    selectors,
    pending: () => frames.length + timers.length,
    topOf: (id) => (tops[id] ?? 0) - view.y,
    scrollY: () => view.y,
    find: (selector) => {
      const node = realQuery(selector);
      if (!node) throw new Error(`no ${selector} in the rendered thread`);
      return node as NodeLike;
    },
    jump: () => (realQuery("[data-thread-jump]") as NodeLike | null) ?? null,
    arrow: (to) => {
      const node = realQuery(`[data-thread-jump-to="${to}"]`);
      if (!node) throw new Error(`no ${to} arrow in the rendered page`);
      return node as NodeLike;
    },
    glyph: (to) => {
      const node = realQuery(`[data-thread-jump-to="${to}"] .thread-jump-icon`);
      if (!node) throw new Error(`no ${to} glyph in the rendered page`);
      return node as NodeLike;
    },
    root: () => document.documentElement as unknown as NodeLike,
    click: (target, options = {}) => {
      (target as NodeLike).dispatchEvent(new Event("click", { bubbles: true }));

      /* The default action: the browser flips `open` after the handler. */
      if (options.toggles !== false) {
        const el = ownerDetails(target as NodeLike);
        if (el && el.open !== undefined) el.open = !el.open;
      }
      if (options.adjust) options.adjust(view);
      flush();
    },
  };
}

/*
 * The source with its comments removed.
 *
 * The negative assertions below are about what the script *does*, and this
 * file's other half is a long argument about smooth scrolling and
 * preventDefault. Matching on the prose would fail the test for explaining
 * itself. There are no comment delimiters inside any string literal in APP_JS,
 * so stripping block comments is safe here.
 */
const APP_CODE = APP_JS.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * Just the first IIFE - the scroll correction.
 *
 * The service-worker half enumerates on purpose (it has to find every offline
 * marker on the page), so an assertion that the script never enumerates has to
 * be scoped to the half where enumerating would be the bug. Cut at the feature
 * gate that opens the second IIFE, which is asserted to exist a few describes
 * above.
 */
const SCROLL_CODE = APP_CODE.slice(
  0,
  APP_CODE.indexOf('if (!("serviceWorker" in navigator)) return;'),
);

describe("APP_JS - scroll correction, as written", () => {
  test("delegates a single click listener from the document", () => {
    // A busy story is several hundred comments; that many registrations is a
    // measurable cost on this hardware for something most readers never tap.
    expect(APP_JS).toContain('document.addEventListener(\n    "click",');
    expect(APP_JS).toContain('closest("summary.chead")');
    expect(SCROLL_CODE.length).toBeGreaterThan(0);
  });

  test("never enumerates comments, only top-level threads", () => {
    // The reason there is no per-comment registration in the first place. The
    // thread jump is allowed two bounded queries because what each collects is
    // the handful of thread sections, not the comments inside them.
    const queries = SCROLL_CODE.match(/querySelectorAll\([^)]*\)/g) ?? [];
    expect(queries).toEqual([
      'querySelectorAll(".comments .thread, .comments .actions")',
      'querySelectorAll(".story-head, .comments .thread")',
    ]);
  });

  test("does not exempt anything inside the header from toggling", () => {
    // The author name used to be a link to HN and had to be skipped. It is a
    // span now, so the exemption is gone and every part of the row collapses.
    expect(SCROLL_CODE).not.toContain('closest("a")');
    expect(SCROLL_CODE).not.toContain("summary.contains(link)");
  });

  test("measures the details, never the sticky summary", () => {
    // A pinned summary's rect reports where it is painted, not where it sits
    // in the document, and that difference is the number being recovered.
    expect(APP_JS).toContain("comment.getBoundingClientRect().top");
    expect(APP_CODE).not.toContain("summary.getBoundingClientRect");
  });

  test("reads the pinned offset from the cascade", () => {
    // So the stylesheet stays the single source of truth for the stacking.
    expect(APP_JS).toContain("window.getComputedStyle(summary, null)");
    expect(APP_CODE).not.toContain("--chead-h");
  });

  test("never scrolls smoothly", () => {
    // A smooth scroll on e-ink is a run of full-panel flashes ending where an
    // instant one would have started.
    expect(APP_JS).toContain("window.scrollBy(0, delta)");
    expect(APP_CODE).not.toContain("smooth");
    expect(APP_CODE).not.toContain("scrollIntoView");
  });

  test("cannot break collapsing, because it never collapses anything", () => {
    // The zero-JS behaviour is the product; this listener only reads. Scoped to
    // the scroll half: the pull gesture is allowed its preventDefault, but only
    // on touchmove, and only while the indicator is being dragged.
    expect(SCROLL_CODE).not.toContain("preventDefault");
    expect(APP_CODE).not.toMatch(/\.open\s*=[^=]/);
    expect(APP_CODE).not.toContain('setAttribute("open"');
    expect(APP_CODE).not.toContain('removeAttribute("open"');
  });
});

describe("APP_JS - scrollCorrection", () => {
  const build = new Function(
    `${extractFunction(APP_JS, "scrollCorrection")}; return scrollCorrection;`,
  );
  const scrollCorrection = build() as (
    beforeTop: number,
    afterTop: number,
    stickyTop: number,
  ) => number;

  test("leaves a comment that did not move alone", () => {
    expect(scrollCorrection(300, 300, 0)).toBe(0);
    expect(scrollCorrection(300, 300, CHEAD_H)).toBe(0);
  });

  test("puts a comment that was on screen back where it was", () => {
    // Content above it shrank by 300, so the page scrolls up by 300.
    expect(scrollCorrection(500, 200, 0)).toBe(-300);
  });

  test("rests a comment that was scrolled past at its own pinned offset", () => {
    // 2000px into the subtree, at depth 1: the header lands under its parent's.
    expect(scrollCorrection(-2000, -2000, CHEAD_H)).toBe(-2035);
    expect(scrollCorrection(-2000, -2000, CHEAD_H * 2)).toBe(-2070);
  });

  test("treats resting exactly on the offset as visible", () => {
    expect(scrollCorrection(CHEAD_H, CHEAD_H, CHEAD_H)).toBe(0);
    expect(scrollCorrection(CHEAD_H - 1, CHEAD_H - 1, CHEAD_H)).toBe(-1);
  });

  test("never scrolls a top-level comment past the top of the page", () => {
    expect(scrollCorrection(-4000, -4000, 0)).toBe(-4000);
  });
});

describe("APP_JS - stickyOffset", () => {
  const source = extractFunction(APP_JS, "stickyOffset");
  function offsetWith(style: unknown, hasGetComputedStyle = true): number {
    const build = new Function("window", `${source}; return stickyOffset;`);
    const win = hasGetComputedStyle ? { getComputedStyle: () => style } : {};
    return (build(win) as (summary: unknown) => number)({});
  }

  test("reads the resolved px offset", () => {
    expect(offsetWith({ top: "70px" })).toBe(70);
    expect(offsetWith({ top: "0px" })).toBe(0);
  });

  test("treats a browser without position: sticky as pinning nothing", () => {
    // A static element resolves top to "auto", which is not a number.
    expect(offsetWith({ top: "auto" })).toBe(0);
    expect(offsetWith({ top: "" })).toBe(0);
  });

  test("survives a missing or empty computed style", () => {
    expect(offsetWith(null)).toBe(0);
    expect(offsetWith({ top: "35px" }, false)).toBe(0);
  });
});

describe("APP_JS - scroll correction, executed", () => {
  test("the harness pins where the stylesheet pins", () => {
    // Every landing assertion below is in these units, so the fake viewport is
    // only worth anything while this holds. What the offsets are per depth is
    // asserted against SITE_CSS over in web-story.test.ts.
    expect(SITE_CSS).toContain("--chead-h: 1.75rem;");
    expect(SITE_CSS).toContain("font-size: 20px;");
    expect(CHEAD_H).toBe(1.75 * 20);
  });

  test("holds a comment still when it was already on screen", () => {
    // Top-level comment at document y=1000, reader at 700: 300px down the
    // panel. Collapsing it must not move it by a pixel.
    const p = page({ scrollY: 700 });
    p.click(p.find("#c1 > summary.chead"));

    expect(p.scrolls).toEqual([]);
    expect(p.scrollY()).toBe(700);
    expect(p.topOf("c1")).toBe(300);
  });

  test("rests a collapsed ancestor under its pinned ancestors", () => {
    // The bug this exists for: 1600px inside c2's subtree, tapping c2's pinned
    // header. Without the correction the viewport keeps offset 3000, which is
    // now somewhere else entirely.
    const p = page({ scrollY: 3000 });
    p.click(p.find("#c2 > summary.chead"));

    expect(p.scrolls).toEqual([-1635]);
    expect(p.topOf("c2")).toBe(CHEAD_H);
  });

  test("uses the depth's own offset, so the header lands flush", () => {
    const p = page({ scrollY: 3000 });
    p.click(p.find("#c3 > summary.chead"));

    expect(p.topOf("c3")).toBe(CHEAD_H * 2);
  });

  test("composes with a browser that already moved the scroll itself", () => {
    // Scroll anchoring, or the offset clamping at a document that just got
    // shorter. Measuring after layout means the correction absorbs it.
    const p = page({ scrollY: 3000 });
    p.click(p.find("#c2 > summary.chead"), {
      adjust: (view) => {
        view.y = 1800;
      },
    });

    expect(p.topOf("c2")).toBe(CHEAD_H);
  });

  test("corrects a click on the reply count, text node and all", () => {
    // Old WebKit can report a text node as the target of a click, and the
    // reply count is the part of a header worth aiming at.
    const p = page({ scrollY: 3000 });
    const count = p.find("#c2 > summary.chead > span.kidcount");
    p.click((count as unknown as { firstChild: NodeLike }).firstChild);

    expect(p.topOf("c2")).toBe(CHEAD_H);
  });

  test("corrects a click on the author name, which now collapses like the rest", () => {
    // The name was a link to HN and was skipped for that reason. It is a span
    // now and toggles like any other part of the header, so it gets the same
    // correction - and it is the widest target in the row, so this is the path
    // most taps take.
    const p = page({ scrollY: 3000 });
    p.click(p.find("#c2 > summary.chead > span.who"));

    expect(p.topOf("c2")).toBe(CHEAD_H);
  });

  test("ignores clicks in the comment body", () => {
    const p = page({ scrollY: 3000 });
    p.click(p.find("#c2 > .cbody"), { toggles: false });

    expect(p.pending()).toBe(0);
    expect(p.scrolls).toEqual([]);
  });

  test("abandons the correction when nothing toggled", () => {
    // Something swallowed the default action. Scrolling then would move the
    // reader for no reason.
    const p = page({ scrollY: 3000 });
    p.click(p.find("#c2 > summary.chead"), { toggles: false });

    expect(p.scrolls).toEqual([]);
    expect(p.scrollY()).toBe(3000);
  });

  test("does nothing on a browser with no <details> at all", () => {
    // There `open` is undefined before and after, the element renders expanded
    // and inline, and the native fallback is the whole behaviour.
    const p = page({ scrollY: 3000, details: false });
    p.click(p.find("#c2 > summary.chead"));

    expect(p.scrolls).toEqual([]);
  });

  test("falls back to a timeout where requestAnimationFrame is missing", () => {
    const p = page({ scrollY: 3000, raf: false });
    p.click(p.find("#c2 > summary.chead"));

    expect(p.topOf("c2")).toBe(CHEAD_H);
  });

  test("binds one listener on the document and looks up one element", () => {
    // The collapse half enumerates nothing at all - that is what delegation
    // buys. The one lookup is the jump button, which has to be found before it
    // can be ruled out.
    const p = page();

    expect(p.registrations).toEqual(["click"]);
    expect(p.selectors).toEqual(["[data-thread-jump]"]);
  });

  test("runs on a browser with no service worker", () => {
    // The harness gives the script an empty navigator throughout, so every
    // test above is also this test. Stated once, explicitly.
    const p = page({ scrollY: 3000 });
    p.click(p.find("#c1 > summary.chead"));

    expect(p.topOf("c1")).toBe(0);
  });
});

describe("APP_JS - the thread jump control", () => {
  test("stays hidden and inert on a page that renders no control", () => {
    // Every page but a story page. The lookup misses and nothing else happens.
    const p = page();

    expect(p.jump()).toBeNull();
    expect(p.registrations).toEqual(["click"]);
  });

  test("reveals the control it finds, and marks the root for the stylesheet", () => {
    // Two halves of one gate. The attribute is what the media query keys off,
    // so an e-ink reader gets the markup and still sees nothing.
    const p = page({ jump: true });

    expect(p.jump()?.getAttribute("hidden")).toBeNull();
    expect(p.root().getAttribute("data-thread-jump-ready")).toBe("");
  });

  test("moves to the first thread below the fold", () => {
    // Reading the article: every thread is ahead, so the answer is the first.
    const p = page({ jump: true, scrollY: 0 });
    p.click(p.arrow("next"), { toggles: false });

    expect(p.scrolls).toEqual([200]);
  });

  test("moves to the next thread, not back to the first", () => {
    // Sitting on tB. tA is behind and tB is level, so tC is the only answer.
    const p = page({
      jump: true,
      stops: { top: -1600, tA: -700, tB: 0, tC: 900, foot: 1600 },
    });
    p.click(p.arrow("next"), { toggles: false });

    expect(p.scrolls).toEqual([900]);
  });

  test("lands a thread exactly where its fragment link would", () => {
    // #tB already works with scripting off, and the control must not disagree
    // with it: no headroom, no offset, the same top edge. A depth-0 header pins
    // at top 0 anyway, so there is nothing above it to clear.
    const p = page({
      jump: true,
      stops: { top: -200, tA: 500, tB: 1200, tC: 1900, foot: 2600 },
    });
    p.click(p.arrow("next"), { toggles: false });

    expect(p.scrolls).toEqual([500]);
  });

  test("finishes at the foot of the discussion rather than stopping dead", () => {
    // Past the last thread the remaining stop is the actions paragraph, so the
    // last tap reaches the end of the page instead of doing nothing.
    const p = page({
      jump: true,
      stops: { top: -2000, tA: -900, tB: -600, tC: -300, foot: 400 },
    });
    p.click(p.arrow("next"), { toggles: false });

    expect(p.scrolls).toEqual([400]);
  });

  test("does nothing at all once there is nothing left below", () => {
    const p = page({
      jump: true,
      stops: { top: -2000, tA: -900, tB: -600, tC: -300, foot: -50 },
    });
    p.click(p.arrow("next"), { toggles: false });

    expect(p.scrolls).toEqual([]);
  });

  test("never scrolls upward on the forward arrow, whatever the geometry says", () => {
    // The guard behind the "strictly below" rule. A stop at 0 or above is
    // behind the reader, and moving back would make the arrow unusable.
    const p = page({
      jump: true,
      stops: { top: -900, tA: 0, tB: 1, tC: 900, foot: 1600 },
    });
    p.click(p.arrow("next"), { toggles: false });

    for (const delta of p.scrolls) expect(delta).toBeGreaterThan(0);
  });

  test("goes back to the thread above, not the one it is sitting on", () => {
    // Sitting on tC. tC is level and tB is the nearest thing behind it.
    const p = page({
      jump: true,
      stops: { top: -2400, tA: -1400, tB: -700, tC: 0, foot: 700 },
    });
    p.click(p.arrow("prev"), { toggles: false });

    expect(p.scrolls).toEqual([-700]);
  });

  test("never scrolls downward on the back arrow, whatever the geometry says", () => {
    const p = page({
      jump: true,
      stops: { top: -900, tA: -1, tB: 0, tC: 900, foot: 1600 },
    });
    p.click(p.arrow("prev"), { toggles: false });

    for (const delta of p.scrolls) expect(delta).toBeLessThan(0);
  });

  test("bottoms out at the top of the story, not at the first thread", () => {
    // A reader who came down through a long article needs a way back up it, and
    // the masthead does not stay on screen to offer one.
    const p = page({
      jump: true,
      stops: { top: -1800, tA: 0, tB: 700, tC: 1400, foot: 2100 },
    });
    p.click(p.arrow("prev"), { toggles: false });

    expect(p.scrolls).toEqual([-1800]);
  });

  test("does nothing at the very top of the page", () => {
    const p = page({
      jump: true,
      stops: { top: 0, tA: 900, tB: 1600, tC: 2300, foot: 3000 },
    });
    p.click(p.arrow("prev"), { toggles: false });

    expect(p.scrolls).toEqual([]);
  });

  test("ignores the foot block going back, since the last thread is the answer", () => {
    // At the bottom of the page the useful destination is the last thread, not
    // the buttons a few lines above it - which is why the two directions do not
    // share a stop list.
    const p = page({
      jump: true,
      stops: { top: -3000, tA: -2000, tB: -1300, tC: -600, foot: -100 },
    });
    p.click(p.arrow("prev"), { toggles: false });

    expect(p.scrolls).toEqual([-600]);
  });

  test("acts on a tap that lands on the glyph rather than the button", () => {
    // The stylesheet makes the icon transparent to pointers, but a browser that
    // ignores that must still work: the handler walks up to the arrow.
    const p = page({ jump: true, scrollY: 0 });
    p.click(p.glyph("next"), { toggles: false });

    expect(p.scrolls).toEqual([200]);
  });

  test("ignores a tap on the box between the two arrows", () => {
    // The gap is a mis-tap guard. Hitting it must do nothing, not pick a
    // direction on the reader's behalf.
    const p = page({ jump: true, scrollY: 0 });
    p.click(p.jump(), { toggles: false });

    expect(p.scrolls).toEqual([]);
  });

  test("collects both thread lists once, not on every tap", () => {
    // Neither set ever changes; only its geometry does. Re-querying per tap
    // would walk every comment on the page to rediscover the same sections.
    const p = page({ jump: true });
    p.click(p.arrow("next"), { toggles: false });
    p.click(p.arrow("prev"), { toggles: false });

    const all = p.selectors.filter((s) => s.indexOf(".thread") !== -1);
    expect(all).toHaveLength(2);
  });

  test("does not touch the comment collapse listener", () => {
    // Both live in the same IIFE. Collapsing must keep working on a page that
    // has a control, and the control must not ride on the collapse delegation.
    const p = page({ jump: true, scrollY: 3000 });
    p.click(p.find("#c2 > summary.chead"));

    expect(p.topOf("c2")).toBe(CHEAD_H);
  });
});

describe("APP_JS - pull to refresh, executed", () => {
  interface PullOptions {
    /** False models a desktop browser, which has no touch screen at all. */
    touch?: boolean;
    online?: boolean;
  }

  interface TouchEventLike {
    touches: Array<{ clientY: number }>;
    cancelable?: boolean;
    preventDefault: () => void;
  }

  interface BarLike {
    getAttribute: (name: string) => string | null;
  }

  /*
   * The gesture sits behind two gates - worker support and a touch screen -
   * and talks to the worker through the same postMessage channel the save
   * button uses. The harness gives it exactly those surfaces plus a reload it
   * can be seen calling, and hands the test the registered touch handlers to
   * fire directly: linkedom has no touch events to dispatch.
   */
  function pullPage(opts: PullOptions = {}) {
    const { document } = parseHTML(
      `<!doctype html><html><body><main>today's stories</main></body></html>`,
    );

    const doc = document as unknown as {
      addEventListener: (
        type: string,
        fn: (event: TouchEventLike) => void,
        capture?: unknown,
      ) => void;
      documentElement: { scrollTop: number };
      body: { appendChild: (node: unknown) => void };
    };
    const handlers: Record<string, Array<(event: TouchEventLike) => void>> = {};
    doc.addEventListener = (type, fn) => {
      (handlers[type] ??= []).push(fn);
    };
    doc.documentElement.scrollTop = 0;

    const appended: Array<BarLike> = [];
    doc.body.appendChild = (node) => {
      appended.push(node as BarLike);
    };

    const posted: Array<{ type: string }> = [];
    const removed: Array<unknown> = [];
    const messageListeners: Array<(event: { data?: unknown }) => void> = [];
    const navigator = {
      onLine: opts.online ?? true,
      serviceWorker: {
        register: () => Promise.resolve({}),
        ready: Promise.resolve({
          active: {
            postMessage: (message: { type: string }) => posted.push(message),
          },
        }),
        addEventListener: (type: string, fn: (event: { data?: unknown }) => void) => {
          if (type === "message") messageListeners.push(fn);
        },
        removeEventListener: (_type: string, fn: unknown) => {
          removed.push(fn);
        },
      },
    };

    const timers: Array<() => void> = [];
    const reloads: number[] = [];
    const windowLike: Record<string, unknown> = {
      pageYOffset: 0,
      location: {
        reload: () => {
          reloads.push(1);
        },
      },
    };
    if (opts.touch !== false) windowLike.ontouchstart = null;

    new Function("window", "document", "navigator", "caches", "Date", "setTimeout", APP_JS)(
      windowLike,
      doc,
      navigator,
      undefined,
      { now: () => NOW },
      (fn: () => void) => {
        timers.push(fn);
        return timers.length;
      },
    );

    /* The purge reaches the worker through ready.then, so give it a turn. */
    async function flush(): Promise<void> {
      for (let i = 0; i < 16; i += 1) await Promise.resolve();
    }

    function fire(type: string, event: TouchEventLike): void {
      for (const fn of handlers[type] ?? []) fn(event);
    }

    return {
      handlers,
      posted,
      removed,
      reloads,
      timers,
      /* The indicator is the only node the gesture ever adds to the page. */
      barStyle: () => (appended[0] ? appended[0].getAttribute("style") : null),
      flush,
      setTop: (top: number) => {
        windowLike.pageYOffset = top;
      },
      start: (at: number) => fire("touchstart", { touches: [{ clientY: at }], preventDefault: () => {} }),
      move: (at: number, cancelable = true) => {
        const prevented: number[] = [];
        fire("touchmove", {
          touches: [{ clientY: at }],
          cancelable,
          preventDefault: () => {
            prevented.push(1);
          },
        });
        return prevented;
      },
      end: () => fire("touchend", { touches: [], preventDefault: () => {} }),
      cancel: () => fire("touchcancel", { touches: [], preventDefault: () => {} }),
      reply: (message: { type: string; dropped: number }) => {
        for (const fn of messageListeners) fn({ data: message });
      },
    };
  }

  test("binds nothing on a browser without a touch screen", () => {
    // The collapse delegation from the first IIFE still runs; the gesture
    // half must add none of its three touch handlers on top of it.
    const p = pullPage({ touch: false });

    expect(Object.keys(p.handlers)).toEqual(["click"]);
  });

  test("purges the cache after a full pull, and shows it working", async () => {
    // 250 raw pixels come through the half-strength resistance as 125, past
    // the 96 threshold and past the indicator's 64px cap.
    const p = pullPage();
    p.start(100);
    const prevented = p.move(350);
    expect(p.barStyle()).toContain("height:64px;");
    p.end();
    await p.flush();

    expect(prevented).toEqual([1]);
    expect(p.posted).toEqual([{ type: "purge-cache" }]);
    expect(p.timers).toHaveLength(2);
  });

  test("reloads as soon as the worker confirms the purge", async () => {
    const p = pullPage();
    p.start(0);
    p.move(350);
    p.end();
    await p.flush();

    p.reply({ type: "cache-purged", dropped: 2 });
    expect(p.reloads).toEqual([1]);
    expect(p.removed).toHaveLength(1);

    /* The reply already ended it; neither timer may reload a second time. */
    for (const timer of p.timers) timer();
    expect(p.reloads).toEqual([1]);
  });

  test("reloads anyway when the worker never answers", async () => {
    const p = pullPage();
    p.start(0);
    p.move(350);
    p.end();
    await p.flush();

    p.timers[0]();
    expect(p.reloads).toEqual([1]);
  });

  test("leaves a short pull alone", () => {
    // 40 raw pixels resist down to 20, well short of the threshold, and a
    // scroll the browser can still own must not be cancelled.
    const p = pullPage();
    p.start(0);
    const prevented = p.move(40, false);
    p.end();

    expect(prevented).toEqual([]);
    expect(p.posted).toEqual([]);
    expect(p.barStyle()).toContain("height:0;");
  });

  test("cancels an interrupted pull and allows a fresh gesture", async () => {
    const p = pullPage();
    p.start(0);
    p.move(350);
    p.cancel();
    expect(p.barStyle()).toContain("height:0;");

    p.end();
    await p.flush();
    expect(p.posted).toEqual([]);

    p.start(100);
    p.move(350);
    p.end();
    await p.flush();
    expect(p.posted).toEqual([{ type: "purge-cache" }]);
  });

  test("abandons a pull when a new touch starts away from the top", async () => {
    const p = pullPage();
    p.start(0);
    p.move(350);
    p.setTop(10);
    p.start(350);
    p.end();
    await p.flush();

    expect(p.barStyle()).toContain("height:0;");
    expect(p.posted).toEqual([]);
  });

  test("reloads without purging while offline", async () => {
    const p = pullPage({ online: false });
    p.start(0);
    p.move(350);
    p.end();
    await p.flush();

    expect(p.posted).toEqual([]);
    expect(p.reloads).toEqual([1]);
  });

  test("ignores a second pull while a purge is in flight", async () => {
    const p = pullPage();
    p.start(0);
    p.move(350);
    p.end();
    await p.flush();

    p.start(0);
    p.move(350);
    p.end();
    await p.flush();

    expect(p.posted).toEqual([{ type: "purge-cache" }]);
    expect(p.timers).toHaveLength(2);
  });
});

describe("APP_JS - scroll correction, missing DOM methods", () => {
  function boot(documentLike: unknown): string[] {
    const registered: string[] = [];
    const doc = Object.assign({ addEventListener: (type: string) => registered.push(type) },
      documentLike);
    new Function("window", "document", "navigator", "setTimeout", APP_JS)({}, doc, {}, () => 0);
    return registered;
  }

  test("binds nothing without closest", () => {
    expect(boot({ documentElement: { getBoundingClientRect: () => ({ top: 0 }) } })).toEqual([]);
  });

  test("binds nothing without getBoundingClientRect", () => {
    expect(boot({ documentElement: { closest: () => null } })).toEqual([]);
  });

  test("binds nothing without a documentElement", () => {
    expect(boot({ documentElement: null })).toEqual([]);
  });
});

describe("webManifest", () => {
  test("is valid JSON", () => {
    expect(() => JSON.parse(webManifest())).not.toThrow();
  });

  test("declares the fields an installed app needs", () => {
    const manifest = JSON.parse(webManifest()) as Record<string, unknown>;
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
  });

  test("its scope covers the worker's scope, or the install is broken", () => {
    const manifest = JSON.parse(webManifest()) as { scope: string; start_url: string };
    expect(manifest.start_url.startsWith(manifest.scope)).toBe(true);
    expect(APP_JS).toContain(`scope: "${manifest.scope}"`);
  });

  test("names itself for a home screen", () => {
    const manifest = JSON.parse(webManifest()) as { name: string; short_name: string };
    expect(manifest.name).toBe("Hacker News Daily");
    // Home screens truncate past roughly twelve characters.
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
  });

  test("is stable across calls", () => {
    expect(webManifest()).toBe(webManifest());
  });
});
