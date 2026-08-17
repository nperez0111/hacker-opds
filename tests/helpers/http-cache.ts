/**
 * Record-and-replay HTTP fixture cache for the test suite.
 *
 * The suite must be runnable with no network at all: CI has none, and a test
 * that quietly reaches seangoedecke.com is both slow and non-deterministic.
 * `installHttpCache()` swaps in a `globalThis.fetch` that answers from files
 * under `tests/fixtures/http/` and, by default, *throws* on anything it has
 * never seen. A miss is therefore a loud failure rather than a silent packet.
 *
 * Recording
 * ---------
 *   FIXTURES_RECORD=1 bun test tests/story.test.ts
 *
 * With that set the stub performs the real request, writes the fixture pair to
 * disk, and returns the live response. Commit the new files and the run is
 * offline from then on. Without it, no request can ever leave the machine.
 *
 * On-disk shape
 * -------------
 * Each entry is two files, keyed by a slug plus a hash of `METHOD URL`:
 *
 *   http/seangoedecke.com-good-system-design-<hash>.json   metadata
 *   http/seangoedecke.com-good-system-design-<hash>.html   body
 *
 * The split keeps HTML and JSON bodies readable and diffable instead of
 * escaping a 200 KB page into a JSON string. `bodyFile` is a path relative to
 * `tests/fixtures`, so a fixture may point at a body that already exists --
 * `hn-item-49323157.html`, say -- rather than duplicating those bytes.
 *
 * Only a small allowlist of response headers is stored. Volatile ones (`date`,
 * `set-cookie`, `cf-ray`) would make fixtures churn on every re-record, and
 * `content-encoding` would be an outright lie because the body is stored
 * decoded. `content-length` is recomputed from the stored bytes for the same
 * reason.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Root of the committed fixture tree; `bodyFile` paths are relative to this. */
export const FIXTURE_ROOT = join(import.meta.dir, "..", "fixtures");
const HTTP_DIR = join(FIXTURE_ROOT, "http");

const RECORDING = process.env.FIXTURES_RECORD === "1";

/**
 * Headers worth replaying. `location` drives the manual redirect follow in
 * `~/core/fetcher`, and `content-type` gates both the HTML check there and the
 * image check in `~/epub/images`, so neither can be dropped.
 */
const KEPT_HEADERS = ["content-type", "location", "retry-after", "etag", "last-modified"];

/** Statuses the Response constructor refuses to pair with a body. */
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

interface FixtureMeta {
  method: string;
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** Path to the body, relative to `tests/fixtures`. */
  bodyFile: string;
}

/** Reads a committed fixture as text. Exported so tests share one accessor. */
export function readFixture(relativePath: string): string {
  return readFileSync(join(FIXTURE_ROOT, relativePath), "utf8");
}

/** Stable per-request key. Method is included so a POST cannot shadow a GET. */
export function fixtureKey(method: string, url: string): string {
  return Bun.CryptoHasher.hash("sha256", `${method.toUpperCase()} ${url}`, "hex").slice(0, 16);
}

/**
 * Human-readable filename prefix. Purely cosmetic -- the hash is what makes the
 * name unique -- but it turns an opaque directory into a browsable one.
 */
function slug(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "url";
  }
  const raw = `${parsed.host}${parsed.pathname}`;
  const cleaned = raw
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return (cleaned || "url").slice(0, 60);
}

function extensionFor(contentType: string): string {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  const table: Record<string, string> = {
    "text/html": "html",
    "application/xhtml+xml": "html",
    "application/json": "json",
    "text/plain": "txt",
    "text/css": "css",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/svg+xml": "svg",
  };
  return table[type] ?? "bin";
}

function metaPath(method: string, url: string): string {
  return join(HTTP_DIR, `${slug(url)}-${fixtureKey(method, url)}.json`);
}

function readMeta(method: string, url: string): FixtureMeta | null {
  try {
    return JSON.parse(readFileSync(metaPath(method, url), "utf8")) as FixtureMeta;
  } catch {
    return null;
  }
}

function toResponse(meta: FixtureMeta): Response {
  const body = readFileSync(join(FIXTURE_ROOT, meta.bodyFile));
  const headers = new Headers(meta.headers);
  headers.set("content-length", String(body.byteLength));
  return new Response(NULL_BODY_STATUS.has(meta.status) ? null : new Uint8Array(body), {
    status: meta.status,
    statusText: meta.statusText,
    headers,
  });
}

function writeFixture(method: string, url: string, res: Response, body: Uint8Array): void {
  mkdirSync(HTTP_DIR, { recursive: true });

  const headers: Record<string, string> = {};
  for (const name of KEPT_HEADERS) {
    const value = res.headers.get(name);
    if (value !== null) headers[name] = value;
  }

  const base = `${slug(url)}-${fixtureKey(method, url)}`;
  const bodyFile = join("http", `${base}.${extensionFor(headers["content-type"] ?? "")}`);

  writeFileSync(join(FIXTURE_ROOT, bodyFile), body);
  writeFileSync(
    join(HTTP_DIR, `${base}.json`),
    `${JSON.stringify(
      {
        method,
        url,
        status: res.status,
        statusText: res.statusText,
        headers,
        // Always POSIX-separated so fixtures are portable across platforms.
        bodyFile: bodyFile.split(/[\\/]/).join("/"),
      } satisfies FixtureMeta,
      null,
      2,
    )}\n`,
  );
}

export interface HttpCacheHandle {
  /** Restores whatever `globalThis.fetch` was in place before the install. */
  restore(): void;
  /** Every `METHOD URL` the stub saw, in order. */
  readonly calls: readonly string[];
  /** Requests answered from disk rather than the network. */
  readonly hits: readonly string[];
  /** Requests that went to the network. Always empty unless recording. */
  readonly recorded: readonly string[];
}

/**
 * Installs the replaying fetch. Call `restore()` in `afterEach`/`afterAll`.
 *
 * The previous `globalThis.fetch` is captured rather than assumed, so this
 * composes with a test that has already installed a stub of its own.
 */
export function installHttpCache(): HttpCacheHandle {
  const previous = globalThis.fetch;
  const calls: string[] = [];
  const hits: string[] = [];
  const recorded: string[] = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();

    calls.push(`${method} ${url}`);

    const meta = readMeta(method, url);
    if (meta) {
      hits.push(`${method} ${url}`);
      return toResponse(meta);
    }

    if (!RECORDING) {
      throw new Error(
        `http fixture miss: ${method} ${url}\n` +
          `  expected: ${metaPath(method, url)}\n` +
          `  the test suite is offline by default. Re-record with:\n` +
          `    FIXTURES_RECORD=1 bun test <file>`,
      );
    }

    const res = await previous(input as never, init);
    const body = new Uint8Array(await res.clone().arrayBuffer());
    writeFixture(method, url, res, body);
    recorded.push(`${method} ${url}`);
    return res;
  }) as unknown as typeof fetch;

  return {
    restore() {
      globalThis.fetch = previous;
    },
    calls,
    hits,
    recorded,
  };
}
