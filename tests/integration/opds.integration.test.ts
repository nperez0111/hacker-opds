/**
 * End-to-end HTTP tests against a real server on an ephemeral port.
 *
 * These are excluded from the normal `bun test` run because they boot a
 * process and read the on-disk database, neither of which belongs in the unit
 * suite. Set `RUN_INTEGRATION=1` (or use `bun run test:integration`) to enable
 * them.
 *
 * The centrepiece is the cross-origin crawl test. A catalogue that advertises
 * hrefs on a different origin than the one it is served from loads its root
 * feed perfectly and then fails on every subsequent tap with "connection
 * refused" on a real device. Two tests cover it from both sides: the correctly
 * configured server must produce zero cross-origin findings, and a
 * deliberately misconfigured one must produce some. Without the second test the
 * first would still pass if the detector were broken.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { XMLValidator } from "fast-xml-parser";
import { join } from "node:path";

import { startServer, withServer, type ServerHandle } from "../../scripts/serve-test.ts";
import { probe } from "../../scripts/opds-probe.ts";

const RUN = process.env.RUN_INTEGRATION === "1";

const PROJECT_ROOT = join(import.meta.dir, "..", "..");
const DB_PATH = join(PROJECT_ROOT, ".data", "hacker-opds.sqlite");

const NAVIGATION_TYPE = "application/atom+xml;profile=opds-catalog;kind=navigation";
const ACQUISITION_TYPE = "application/atom+xml;profile=opds-catalog;kind=acquisition";

/**
 * A story id that already has a built artifact, read from the database rather
 * than hardcoded so the test survives retention pruning and re-ingestion.
 *
 * Read at module scope because `test.skipIf` is evaluated during collection,
 * before any hook has run.
 */
function findBuiltStoryId(): number | null {
  if (!RUN) return null;
  try {
    const db = new Database(DB_PATH, { readonly: true });
    try {
      const row = db
        .query(
          "SELECT build_key FROM builds WHERE kind = 'story' AND state = 'ready' AND path IS NOT NULL ORDER BY build_key DESC LIMIT 1",
        )
        .get() as { build_key: string } | null;
      const id = row === null ? Number.NaN : Number(row.build_key);
      return Number.isFinite(id) ? id : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

const STORY_ID = findBuiltStoryId();

const it = test.skipIf(!RUN);
const itWithStory = test.skipIf(!RUN || STORY_ID === null);

let server: ServerHandle;
let baseUrl: string;

beforeAll(async () => {
  if (!RUN) return;
  server = await startServer();
  baseUrl = server.baseUrl;
});

afterAll(async () => {
  await server?.stop();
});

/** Content type minus the charset the server appends. */
function profileOf(header: string | null): string {
  return (header ?? "")
    .split(";")
    .filter((part) => !part.trim().toLowerCase().startsWith("charset="))
    .join(";")
    .trim();
}

describe("OPDS catalogue over HTTP", () => {
  it(
    "serves the root navigation feed as well-formed OPDS",
    async () => {
      const response = await fetch(`${baseUrl}/opds`);

      expect(response.status).toBe(200);
      expect(profileOf(response.headers.get("content-type"))).toBe(NAVIGATION_TYPE);

      const xml = await response.text();
      expect(XMLValidator.validate(xml)).toBe(true);
      expect(xml).toContain("<feed");
      expect(xml).toContain("<id>urn:hacker-opds:root</id>");
    },
    30_000,
  );

  it(
    "serves today's edition as an acquisition feed",
    async () => {
      const response = await fetch(`${baseUrl}/opds/today`);

      expect(response.status).toBe(200);
      expect(profileOf(response.headers.get("content-type"))).toBe(ACQUISITION_TYPE);
      expect(XMLValidator.validate(await response.text())).toBe(true);
    },
    30_000,
  );

  it(
    "crawls clean, with zero cross-origin hrefs (KOReader regression)",
    async () => {
      const report = await probe({ baseUrl, deep: false });

      // The headline assertion. Anything above zero means a reader on another
      // host would hit "connection refused" after the root feed loads.
      const crossOrigin = report.findings.filter((f) => f.category === "cross-origin");
      expect(crossOrigin.map((f) => `${f.feed} -> ${f.href ?? ""}`)).toEqual([]);
      expect(report.stats.crossOriginLinks).toBe(0);

      // And nothing else went wrong either.
      const errors = report.findings.filter((f) => f.severity === "error");
      expect(errors.map((f) => `${f.category}: ${f.message} (${f.feed})`)).toEqual([]);
      expect(report.ok).toBe(true);

      // Guard against a vacuous pass: the crawl must actually have reached the
      // acquisition feeds, not just the root.
      expect(report.stats.feedsCrawled).toBeGreaterThanOrEqual(3);
      expect(report.stats.entriesSeen).toBeGreaterThan(0);
      expect(report.stats.linksChecked).toBeGreaterThan(0);
      expect(report.feeds.some((f) => f.inferredKind === "acquisition")).toBe(true);
    },
    120_000,
  );

  it(
    "detects cross-origin hrefs when the public base URL is wrong",
    async () => {
      // Proves the check above is not vacuous: same catalogue, wrong base URL.
      const report = await withServer(
        (misconfigured) => probe({ baseUrl: misconfigured, deep: false }),
        { publicBaseUrl: "http://example.invalid:8080" },
      );

      expect(report.ok).toBe(false);
      expect(report.stats.crossOriginLinks).toBeGreaterThan(0);

      const crossOrigin = report.findings.filter((f) => f.category === "cross-origin");
      expect(crossOrigin.length).toBeGreaterThan(0);
      expect(crossOrigin[0]?.severity).toBe("error");
      expect(crossOrigin[0]?.actual).toBe("http://example.invalid:8080");

      // Rebasing onto the crawl origin means one bad base URL does not hide the
      // rest of the catalogue behind an unreachable root.
      expect(report.stats.feedsCrawled).toBeGreaterThanOrEqual(3);
    },
    120_000,
  );

  it(
    "deep crawl verifies EPUB downloads end to end",
    async () => {
      const report = await probe({ baseUrl, deep: true, epubSamples: 2 });

      expect(report.epubs.length).toBeGreaterThan(0);
      for (const epub of report.epubs) {
        expect(epub.status).toBe(200);
        expect(epub.magicOk).toBe(true);
        expect(epub.etag).not.toBeNull();
        expect(epub.notModifiedOk).toBe(true);
      }
      expect(report.ok).toBe(true);
    },
    180_000,
  );
});

describe("archive date validation", () => {
  it(
    "rejects a malformed date with 400",
    async () => {
      const response = await fetch(`${baseUrl}/opds/archive/not-a-date`);
      expect(response.status).toBe(400);
    },
    30_000,
  );

  it(
    "returns 404 for a date with no edition",
    async () => {
      const response = await fetch(`${baseUrl}/opds/archive/1999-01-01`);
      expect(response.status).toBe(404);
    },
    30_000,
  );
});

describe("EPUB acquisition", () => {
  itWithStory(
    "serves a real story as an EPUB with a working ETag",
    async () => {
      const url = `${baseUrl}/epub/story/${STORY_ID}.epub`;
      const response = await fetch(url);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/epub+zip");

      const etag = response.headers.get("etag");
      expect(etag).not.toBeNull();
      expect(etag).toMatch(/^"[0-9a-f]{64}"$/);

      // EPUB is a zip, so the payload must open with the local file header.
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(bytes.length).toBeGreaterThan(4);
      expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);

      const revalidated = await fetch(url, {
        headers: { "if-none-match": etag as string },
      });
      expect(revalidated.status).toBe(304);
      await revalidated.arrayBuffer();
    },
    120_000,
  );

  it(
    "returns 404 for an unknown story id",
    async () => {
      const response = await fetch(`${baseUrl}/epub/story/1.epub`);
      expect(response.status).toBe(404);
    },
    60_000,
  );

  it(
    "returns 400 for a non-numeric story id",
    async () => {
      const response = await fetch(`${baseUrl}/epub/story/abc.epub`);
      expect(response.status).toBe(400);
    },
    30_000,
  );
});
