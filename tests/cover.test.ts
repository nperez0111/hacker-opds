/**
 * Cover generation, the asset caching behind it, and the two routes that serve
 * it.
 *
 * Entirely offline: covers are drawn from a font this repository ships and
 * rasterised in-process, so nothing here fetches. `expectNoFetch` makes that a
 * failure rather than an assumption, because a cover route that reached the
 * network would be a catalogue that stalls on a device with no radio.
 *
 * Full-size rasterising is ~115ms, so the cases that do not care about pixel
 * dimensions run at a tenth scale (see tests/helpers/covers.ts). The ones that
 * do are marked and pay for it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { mockEvent, HTTPError, type H3Event } from "nitro/h3";

import { resetConfig, setConfigForTests } from "~/config";
import { getDb, resetDbForTests } from "~/db/client";
import type { StoryRow } from "~/core/edition";
import { readMetrics, woffToSfnt } from "~/epub/sfnt";
import { FONT_FACE_FILES } from "~/web/font-files";
import {
  COVER_HEIGHT,
  COVER_WIDTH,
  editionCover,
  editionCoverSvg,
  fitText,
  rasteriseCover,
  setCoverScaleForTests,
  storyCover,
  storyCoverSvg,
  toDrawable,
  truncateToWidth,
  wrapText,
} from "~/epub/cover";
import { resetQueueForTests } from "~/build/queue";

import { makeTempDataDir } from "./helpers/data-dir";
import { restoreCoverScale, useSmallCovers } from "./helpers/covers";

import storyCoverRoute from "../server/routes/cover/story/[file]";
import editionCoverRoute from "../server/routes/cover/edition/[file]";

const BASE = 1_755_302_400; // 2025-08-16T00:00:00Z
const bold = readMetrics(
  woffToSfnt(
    Uint8Array.from(
      Buffer.from(FONT_FACE_FILES.find((f) => f.id === "charis-700")!.woff.base64, "base64"),
    ),
  ),
);

let dir: string;
let savedFetch: typeof globalThis.fetch;

function story(over: Partial<StoryRow> = {}): StoryRow {
  return {
    id: 999_999_001,
    edition_date: "2026-08-16",
    rank: 3,
    title: "Good system design",
    url: "https://seangoedecke.com/good-system-design/",
    domain: "seangoedecke.com",
    author: "pg",
    points: 412,
    num_comments: 208,
    created_at_i: BASE + 3600,
    story_text: null,
    is_text_post: 0,
    ...over,
  };
}

function seed(over: Partial<StoryRow> = {}): StoryRow {
  const row = story(over);
  getDb()
    .query(
      `INSERT INTO editions (date, tz, start_unix, end_unix, closed_at, ingested_at, story_count, state)
       VALUES (?, 'Europe/Amsterdam', ?, ?, ?, ?, 1, 'ingested')
       ON CONFLICT(date) DO NOTHING`,
    )
    .run(row.edition_date, BASE, BASE + 86400, BASE + 86400, BASE + 86400);
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
  return row;
}

function event(path: string, params: Record<string, string>, headers: Record<string, string> = {}): H3Event {
  const ev = mockEvent(`http://localhost${path}`, { headers });
  ev.context.params = params;
  return ev;
}

async function call(handler: (ev: H3Event) => unknown, ev: H3Event): Promise<Response> {
  const result = await handler(ev);
  if (!(result instanceof Response)) throw new Error("expected a Response");
  return result;
}

/** PNG's eight-byte signature. */
function isPng(bytes: Uint8Array): boolean {
  return (
    bytes.length > 8 &&
    Array.from(bytes.subarray(0, 8)).join(",") === [137, 80, 78, 71, 13, 10, 26, 10].join(",")
  );
}

beforeEach(() => {
  dir = makeTempDataDir("hn-opds-cover-");
  setConfigForTests({ dataDir: dir });
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    throw new Error(`cover generation made a network request: ${String(input)}`);
  }) as unknown as typeof fetch;
  resetDbForTests();
  resetQueueForTests();
  useSmallCovers();
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  restoreCoverScale();
  resetDbForTests();
  resetConfig();
  rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* text fitting                                                        */
/* ------------------------------------------------------------------ */

describe("toDrawable", () => {
  test("passes through text the font covers", () => {
    expect(toDrawable("Good system design", bold)).toBe("Good system design");
    expect(toDrawable("Café — naïve", bold)).toBe("Café — naïve");
  });

  test("collapses a run of undrawable characters into one mark", () => {
    // Falling back to a system font here would make the bytes depend on the
    // host, so the only options are a mark or nothing.
    expect(toDrawable("中文标题 and English", bold)).toBe("\ufffd and English");
  });

  test("normalises whitespace so wrapping sees single spaces", () => {
    expect(toDrawable("  two   words\n\there ", bold)).toBe("two words here");
  });
});

describe("wrapText", () => {
  test("breaks on spaces to fit the box", () => {
    const lines = wrapText("one two three four five", bold, 50, 200);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(bold.measure(line, 50)).toBeLessThanOrEqual(200);
  });

  test("keeps the words, in order", () => {
    const text = "the quick brown fox jumps over the lazy dog";
    expect(wrapText(text, bold, 60, 300).join(" ")).toBe(text);
  });

  test("breaks a word that cannot fit rather than letting it overflow", () => {
    const lines = wrapText("short Pneumonoultramicroscopicsilicovolcanoconiosis", bold, 80, 200);
    for (const line of lines) expect(bold.measure(line, 80)).toBeLessThanOrEqual(200);
    // Broken, not dropped: every letter survives somewhere.
    expect(lines.join("").replace(/ /g, "")).toBe(
      "shortPneumonoultramicroscopicsilicovolcanoconiosis",
    );
  });
});

describe("truncateToWidth", () => {
  test("leaves text that already fits alone", () => {
    expect(truncateToWidth("short", bold, 40, 1000)).toBe("short");
  });

  test("cuts and marks the cut", () => {
    const cut = truncateToWidth("a very long line of words indeed", bold, 40, 200);
    expect(cut).toEndWith("\u2026");
    expect(bold.measure(cut, 40)).toBeLessThanOrEqual(200);
  });
});

describe("fitText", () => {
  const sizes = [100, 80, 60, 40];

  test("takes the largest size that fits the line budget", () => {
    const small = fitText("Two words", bold, { sizes, maxWidth: 840, maxLines: 6 });
    expect(small.size).toBe(100);
    expect(small.lines).toHaveLength(1);
  });

  test("steps down for a long headline", () => {
    const long = fitText(
      "Show HN: I built a self-hosted offline-first OPDS catalogue for e-ink readers",
      bold,
      { sizes, maxWidth: 840, maxLines: 3 },
    );
    expect(long.size).toBeLessThan(100);
    expect(long.lines.length).toBeLessThanOrEqual(3);
  });

  test("truncates rather than overflowing when nothing fits", () => {
    const impossible = fitText("word ".repeat(200).trim(), bold, {
      sizes,
      maxWidth: 300,
      maxLines: 2,
    });
    expect(impossible.lines).toHaveLength(2);
    expect(impossible.lines[1]).toEndWith("\u2026");
  });
});

/* ------------------------------------------------------------------ */
/* the drawings                                                        */
/* ------------------------------------------------------------------ */

describe("storyCoverSvg", () => {
  test("carries the title and the source, and nothing from the clock", () => {
    const svg = storyCoverSvg(story());
    // The headline is wrapped into <text> lines, so it is the words that are
    // present rather than the string.
    expect(svg).toContain("Good system");
    expect(svg).toContain("design");
    expect(svg).toContain("seangoedecke.com");
    expect(svg).toContain("2026-08-16");
    expect(svg).toContain("No. 3");
    expect(svg).toBe(storyCoverSvg(story()));
  });

  test("escapes markup in a title instead of emitting it", () => {
    const svg = storyCoverSvg(story({ title: "Tags <b> & \"quotes\"" }));
    expect(svg).toContain("&lt;b&gt;");
    expect(svg).not.toContain("<b>");
  });

  test("names Hacker News as the source of a text post", () => {
    expect(storyCoverSvg(story({ url: null, domain: null }))).toContain("news.ycombinator.com");
  });

  test("stays inside the text column for a title of any length", () => {
    const svg = storyCoverSvg(
      story({ title: "Pneumonoultramicroscopicsilicovolcanoconiosis considered harmful, again" }),
    );
    const size = Number(/font-size="(\d+)"[^>]*>Pneumo/.exec(svg)?.[1] ?? 0);
    expect(size).toBeGreaterThan(0);

    // Every line set at the headline size has to fit the text column, which is
    // the whole reason the font metrics are parsed at all.
    const headlines = [...svg.matchAll(/<text [^>]*font-size="(\d+)"[^>]*>([^<]*)<\/text>/g)]
      .filter((m) => Number(m[1]) === size)
      .map((m) => m[2] as string);
    expect(headlines.length).toBeGreaterThan(1);
    for (const line of headlines) {
      expect(bold.measure(line, size)).toBeLessThan(COVER_WIDTH - 160);
    }
  });
});

describe("editionCoverSvg", () => {
  const svg = editionCoverSvg("2026-08-16", 30);

  test("makes the day the artwork", () => {
    expect(svg).toContain("SUNDAY");
    expect(svg).toContain("16 August");
    expect(svg).toContain("2026");
    expect(svg).toContain("30 stories, with comments");
  });

  test("names the month from a table, not the host locale", () => {
    // Intl would render this differently under a different LANG, and the bytes
    // are an ETag.
    expect(editionCoverSvg("2026-01-01", 1)).toContain("1 January");
    expect(editionCoverSvg("2026-01-01", 1)).toContain("1 story, with comments");
  });

  test("says COMPLETE EDITION so a shelf can tell it from a story", () => {
    expect(svg).toContain("COMPLETE EDITION");
  });
});

/* ------------------------------------------------------------------ */
/* rasterising                                                         */
/* ------------------------------------------------------------------ */

describe("rasteriseCover", () => {
  test("draws a PNG at the requested width", async () => {
    const png = await rasteriseCover(storyCoverSvg(story()), 200);
    expect(isPng(png)).toBe(true);
    expect((await new Bun.Image(png).metadata()).width).toBe(200);
  });

  test("is byte-identical across builds", async () => {
    const svg = storyCoverSvg(story());
    const a = await rasteriseCover(svg, 200);
    const b = await rasteriseCover(svg, 200);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  test("actually draws the text rather than silently dropping it", async () => {
    // With loadSystemFonts off, a font that failed to load produces a cover
    // with the bands and nothing else - which still looks plausible. A title
    // with ink in it compresses to noticeably more than one without.
    const withTitle = await rasteriseCover(storyCoverSvg(story()), 200);
    const blank = await rasteriseCover(
      storyCoverSvg(story({ title: " ", domain: null })),
      200,
    );
    expect(withTitle.byteLength).toBeGreaterThan(blank.byteLength * 1.2);
  });
});

/* ------------------------------------------------------------------ */
/* caching                                                             */
/* ------------------------------------------------------------------ */

describe("cover caching", () => {
  function assetRows() {
    return getDb()
      .query<{ kind: string; src_url: string; path: string }, []>("SELECT * FROM assets")
      .all();
  }

  test("stores the cover as a cover, in its own blob directory", async () => {
    const s = seed();
    const cover = await storyCover(s);

    const rows = assetRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("cover");
    expect(rows[0]!.path).toContain("/blobs/covers/");
    expect(await Bun.file(rows[0]!.path).exists()).toBe(true);
    expect(cover.mediaType).toBe("image/png");
  });

  test("serves the second request from the store instead of redrawing", async () => {
    const s = seed();
    const first = await storyCover(s);
    const second = await storyCover(s);

    expect(second.sha256).toBe(first.sha256);
    expect(assetRows()).toHaveLength(1);
    expect(
      getDb().query<{ n: number }, []>("SELECT count(*) AS n FROM asset_urls").get()!.n,
    ).toBe(1);
  });

  test("redraws when the story's title changes", async () => {
    const s = seed();
    const before = await storyCover(s);
    const after = await storyCover({ ...s, title: "A completely different headline" });

    // Same subject, different bytes: the variant is keyed on the drawing, so a
    // changed title cannot be served from the old cache entry.
    expect(after.sha256).not.toBe(before.sha256);
    expect(assetRows()).toHaveLength(2);
  });

  test("keeps the thumbnail as a separate, smaller asset", async () => {
    const s = seed();
    const full = await storyCover(s, "full");
    const thumb = await storyCover(s, "thumb");

    expect(thumb.sha256).not.toBe(full.sha256);
    expect(thumb.data.byteLength).toBeLessThan(full.data.byteLength);
  });

  test("references every cover it produces, thumbnails included", async () => {
    // An unreferenced asset is one retention deletes tonight and something
    // redraws tomorrow, so the reference is made where the bytes are, not by
    // whichever caller happened to ask.
    const s = seed();
    const full = await storyCover(s, "full");
    const thumb = await storyCover(s, "thumb");
    const edition = await editionCover("2026-08-16", 30);

    const linkedToStory = getDb()
      .query<{ sha256: string }, [number]>("SELECT sha256 FROM story_assets WHERE story_id = ?")
      .all(s.id)
      .map((r) => r.sha256);
    expect(linkedToStory).toContain(full.sha256);
    expect(linkedToStory).toContain(thumb.sha256);

    const linkedToEdition = getDb()
      .query<{ sha256: string }, [string]>(
        "SELECT sha256 FROM edition_assets WHERE edition_date = ?",
      )
      .all("2026-08-16")
      .map((r) => r.sha256);
    expect(linkedToEdition).toEqual([edition.sha256]);
  });
});

/* ------------------------------------------------------------------ */
/* routes                                                             */
/* ------------------------------------------------------------------ */

describe("GET /cover/story/:file", () => {
  test("serves the cover with a strong ETag and an immutable policy", async () => {
    const s = seed();
    const res = await call(storyCoverRoute, event(`/cover/story/${s.id}.png`, { file: `${s.id}.png` }));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{64}"$/);
    expect(isPng(new Uint8Array(await res.arrayBuffer()))).toBe(true);
  });

  test("answers 304 to a matching if-none-match", async () => {
    const s = seed();
    const first = await call(storyCoverRoute, event(`/cover/story/${s.id}.png`, { file: `${s.id}.png` }));
    const etag = first.headers.get("etag") as string;

    const second = await call(
      storyCoverRoute,
      event(`/cover/story/${s.id}.png`, { file: `${s.id}.png` }, { "if-none-match": etag }),
    );
    expect(second.status).toBe(304);
    expect(second.headers.get("etag")).toBe(etag);
  });

  test("serves a smaller thumbnail from the same subject", async () => {
    const s = seed();
    const full = await call(storyCoverRoute, event("/x", { file: `${s.id}.png` }));
    const thumb = await call(storyCoverRoute, event("/x", { file: `${s.id}.thumb.png` }));

    expect(thumb.status).toBe(200);
    expect(Number(thumb.headers.get("content-length"))).toBeLessThan(
      Number(full.headers.get("content-length")),
    );
    expect(thumb.headers.get("etag")).not.toBe(full.headers.get("etag"));
  });

  test("404s for a story this archive does not hold", async () => {
    await expect(call(storyCoverRoute, event("/x", { file: "12345.png" }))).rejects.toMatchObject({
      status: 404,
    });
  });

  test("400s for a filename that is not a cover", async () => {
    await expect(
      call(storyCoverRoute, event("/x", { file: "1.jpg" })),
    ).rejects.toBeInstanceOf(HTTPError);
  });
});

describe("GET /cover/edition/:file", () => {
  test("serves the digest cover", async () => {
    seed();
    const res = await call(editionCoverRoute, event("/x", { file: "2026-08-16.png" }));
    expect(res.status).toBe(200);
    expect(isPng(new Uint8Array(await res.arrayBuffer()))).toBe(true);
  });

  test("404s for a date with no stories", async () => {
    await expect(
      call(editionCoverRoute, event("/x", { file: "1999-01-01.png" })),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("400s for a malformed date", async () => {
    await expect(
      call(editionCoverRoute, event("/x", { file: "2026-8-16.png" })),
    ).rejects.toBeInstanceOf(HTTPError);
  });
});

/* ------------------------------------------------------------------ */

describe("the size a reader actually gets", () => {
  /**
   * The only full-size rasterise in the suite, and the reason the scale seam
   * exists: this one case costs more than every other case in this file put
   * together. It is here so the production dimensions are asserted somewhere.
   */
  test("is 1000x1600, the ratio Kindle and Kobo both want", async () => {
    setCoverScaleForTests(1);
    const cover = await storyCover(seed());
    const meta = await new Bun.Image(cover.data).metadata();

    expect(meta.width).toBe(COVER_WIDTH);
    expect(meta.height).toBe(COVER_HEIGHT);
    expect(COVER_HEIGHT / COVER_WIDTH).toBeCloseTo(1.6, 5);
  });
});
