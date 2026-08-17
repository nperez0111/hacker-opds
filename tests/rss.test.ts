/**
 * The RSS surface: serialiser, channel construction, and both routes.
 *
 * A feed that does not parse is worthless, and "worthless" here is silent - a
 * reader shows an empty subscription rather than an error anyone sees. So the
 * assertions below parse the generated XML with fast-xml-parser and interrogate
 * the resulting tree, rather than matching substrings that would still pass
 * against a document with an unclosed tag in it.
 *
 * The route tests call the handlers directly through h3's `mockEvent`, the same
 * seam tests/web-routes.test.tsx uses, so nothing here needs a listener or a
 * port. `expectNoFetch` makes the absence of network access a failure rather
 * than an assumption: a feed is generated from SQLite and must never reach out.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { HTTPError, mockEvent, type H3Event } from "nitro/h3";
import { XMLParser, XMLValidator } from "fast-xml-parser";

import { resetConfig, setConfigForTests } from "~/config";
import { DEFAULTS } from "~/defaults";
import { getDb, resetDbForTests } from "~/db/client";
import type { StoryRow } from "~/core/edition";
import { recentStories } from "~/core/edition";
import type { ArticleRecord } from "~/core/extract";
import { saveArticle } from "~/core/extract";
import { readyStoryEpubBytes } from "~/build/artifacts";
import { storyEntryId } from "~/opds/catalog";
import {
  editionChannel,
  latestChannel,
  rssEditionPath,
  storyItem,
} from "~/rss/channel";
import { EDITION_CACHE, LATEST_CACHE, rssResponse } from "~/rss/respond";
import { renderRss, rfc822, RSS_TYPE, xmlText, type RssChannel } from "~/rss/rss";
import { RSS_HREF } from "~/web/layout";
import { serviceWorkerJs } from "~/web/sw";

import rssRoute from "../server/routes/rss/index";
import rssEditionRoute from "../server/routes/rss/archive/[date]";
import archiveDateRoute from "../server/routes/archive/[date]";
import indexRoute from "../server/routes/index";
import { makeTempDataDir } from "./helpers/data-dir";

const BASE = 1_755_302_400; // 2025-08-16T00:00:00Z, i.e. 02:00 in Amsterdam

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function expectWellFormed(xml: string, label = "feed"): void {
  const result = XMLValidator.validate(xml);
  if (result !== true) {
    throw new Error(`${label} is not well-formed: ${JSON.stringify(result.err)}`);
  }
}

interface ParsedItem {
  title?: string;
  link?: string;
  guid?: { "#text": string; "@_isPermaLink": string };
  pubDate?: string;
  description?: string;
  "content:encoded"?: string;
  "dc:creator"?: string;
  category?: string | string[];
  comments?: string;
  enclosure?: { "@_url": string; "@_length": string; "@_type": string };
}

interface ParsedChannel {
  title: string;
  link: string;
  description: string;
  language: string;
  lastBuildDate: string;
  generator: string;
  "atom:link": { "@_rel": string; "@_type": string; "@_href": string };
  item?: ParsedItem | ParsedItem[];
}

/**
 * Parse, after checking well-formedness.
 *
 * `isArray` pins `item` and `category` to arrays: fast-xml-parser collapses a
 * single occurrence to a scalar otherwise, which would make every assertion
 * below depend on how many stories the fixture happened to have.
 */
function parseFeed(xml: string, label = "feed"): ParsedChannel {
  expectWellFormed(xml, label);
  const parser = new XMLParser({
    ignoreAttributes: false,
    isArray: (name, jpath) =>
      jpath === "rss.channel.item" || jpath === "rss.channel.item.category",
  });
  const doc = parser.parse(xml) as {
    rss: { channel: ParsedChannel; "@_version": string };
  };
  expect(doc.rss["@_version"]).toBe("2.0");
  return doc.rss.channel;
}

function items(channel: ParsedChannel): ParsedItem[] {
  return (channel.item ?? []) as ParsedItem[];
}

function story(over: Partial<StoryRow> = {}): StoryRow {
  return {
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
}

function article(over: Partial<ArticleRecord> = {}): ArticleRecord {
  return {
    story_id: 999_999_001,
    state: "ok",
    fetched_at: BASE + 100,
    http_status: 200,
    final_url: "https://seangoedecke.com/good-system-design/",
    title: "Good system design",
    author: "Sean Goedecke",
    published: "2025-08-01T00:00:00Z",
    site: "seangoedecke.com",
    language: "en",
    word_count: 1200,
    xhtml: "<p>Boring systems are good systems, and here is why that is.</p>",
    markdown: "Boring systems are good systems, and here is why that is.",
    error_code: null,
    ...over,
  };
}

/* ------------------------------------------------------------------ */
/* Serialiser                                                          */
/* ------------------------------------------------------------------ */

function channel(over: Partial<RssChannel> = {}): RssChannel {
  return {
    title: "Hacker News Daily",
    link: "https://hn.example.com/",
    description: "Top stories.",
    selfUrl: "https://hn.example.com/rss",
    lastBuild: BASE,
    items: [],
    ...over,
  };
}

describe("rfc822", () => {
  test("renders a unix timestamp in the edition timezone", () => {
    // BASE is midnight UTC on 16 August, which is 02:00 in Amsterdam on CEST.
    expect(rfc822(BASE)).toBe("Sat, 16 Aug 2025 02:00:00 +0200");
  });

  test("uses the winter offset when the instant is in winter", () => {
    // 2025-01-15T00:00:00Z, when Amsterdam is CET rather than CEST. Getting
    // this wrong by an hour is the classic fixed-offset bug.
    expect(rfc822(1_736_899_200)).toBe("Wed, 15 Jan 2025 01:00:00 +0100");
  });

  test("names days and months in English regardless of the host locale", () => {
    // RFC 822 day and month names are not translatable, and a format string
    // would be one LANG away from emitting "sam." for Saturday.
    expect(rfc822(BASE)).toStartWith("Sat, 16 Aug");
  });

  test("accepts a Date as well as a timestamp", () => {
    expect(rfc822(new Date(BASE * 1000))).toBe(rfc822(BASE));
  });

  test("honours an overridden timezone", () => {
    expect(rfc822(BASE, "UTC")).toBe("Sat, 16 Aug 2025 00:00:00 +0000");
  });

  test("survives a misconfigured timezone instead of emitting nothing", () => {
    expect(rfc822(BASE, "Not/AZone")).toMatch(/^\w{3}, \d{2} \w{3} \d{4}/);
  });

  test("is stable for the same input", () => {
    expect(rfc822(BASE)).toBe(rfc822(BASE));
  });
});

describe("xmlText", () => {
  test("escapes the XML metacharacters", () => {
    expect(xmlText(`a & b < c > d " e ' f`)).toBe(
      "a &amp; b &lt; c &gt; d &quot; e &apos; f",
    );
  });

  test("strips control characters XML 1.0 cannot represent at all", () => {
    // There is no escape for these: &#12; is as illegal as the raw byte, so
    // stripping is the only repair. One of them anywhere in a body would take
    // the whole feed from "one odd item" to "does not parse".
    expect(xmlText("a\u000Cb\u0000c\u001Fd")).toBe("abcd");
  });

  test("keeps the whitespace XML does allow", () => {
    expect(xmlText("a\tb\nc\rd")).toBe("a\tb\nc\rd");
  });
});

describe("renderRss", () => {
  test("produces a well-formed RSS 2.0 document", () => {
    const parsed = parseFeed(renderRss(channel()));
    expect(parsed.title).toBe("Hacker News Daily");
    expect(parsed.language).toBe("en");
    expect(parsed.generator).toBe("hacker-opds");
  });

  test("declares the namespaces its elements use", () => {
    const xml = renderRss(
      channel({
        items: [
          {
            title: "t",
            link: "https://hn.example.com/story/1",
            guid: "urn:hn:story:1",
            pubDate: rfc822(BASE),
            creator: "example.com",
            content: "<p>body</p>",
          },
        ],
      }),
    );
    expect(xml).toContain('xmlns:content="http://purl.org/rss/1.0/modules/content/"');
    expect(xml).toContain('xmlns:dc="http://purl.org/dc/elements/1.1/"');
    expect(xml).toContain('xmlns:atom="http://www.w3.org/2005/Atom"');
  });

  test("carries a self link, so a passed-around feed knows where to poll", () => {
    const parsed = parseFeed(renderRss(channel()));
    expect(parsed["atom:link"]["@_rel"]).toBe("self");
    expect(parsed["atom:link"]["@_type"]).toBe("application/rss+xml");
    expect(parsed["atom:link"]["@_href"]).toBe("https://hn.example.com/rss");
  });

  test("marks the guid as not a permalink, because it is a urn", () => {
    const parsed = parseFeed(
      renderRss(
        channel({
          items: [
            {
              title: "t",
              link: "https://hn.example.com/story/1",
              guid: "urn:hn:story:1",
              pubDate: rfc822(BASE),
            },
          ],
        }),
      ),
    );
    const item = items(parsed)[0]!;
    expect(item.guid!["#text"]).toBe("urn:hn:story:1");
    // Left at its default of true a reader may fetch the guid as a URL.
    expect(item.guid!["@_isPermaLink"]).toBe("false");
  });

  test("escapes metacharacters in titles rather than emitting markup", () => {
    const parsed = parseFeed(
      renderRss(
        channel({
          items: [
            {
              title: 'Ask HN: "quotes" & <script>alert(1)</script>',
              link: "https://hn.example.com/story/1",
              guid: "urn:hn:story:1",
              pubDate: rfc822(BASE),
            },
          ],
        }),
      ),
    );
    // Parsed back out it is the original text, and as bytes it never contained
    // a live tag.
    expect(items(parsed)[0]!.title).toBe('Ask HN: "quotes" & <script>alert(1)</script>');
  });

  test("survives a body containing several CDATA terminators", () => {
    /*
     * The bug that removed the `feed` dependency. It wraps bodies in CDATA and
     * escapes the terminator with a string-pattern `.replace(']]>', ...)`,
     * which only replaces the first occurrence; the second closes the section
     * early and the document stops being well-formed. There is no CDATA here at
     * all, so `]]>` is just three characters.
     */
    const hostile = "<p>one ]]> two ]]> three</p>";
    const xml = renderRss(
      channel({
        items: [
          {
            title: "a ]]> b ]]> c",
            link: "https://hn.example.com/story/1",
            guid: "urn:hn:story:1",
            pubDate: rfc822(BASE),
            content: hostile,
          },
        ],
      }),
    );

    const item = items(parseFeed(xml, "hostile feed"))[0]!;
    expect(xml).not.toContain("<![CDATA[");
    expect(item.title).toBe("a ]]> b ]]> c");
    expect(item["content:encoded"]).toBe(hostile);
  });

  test("keeps a control character in an article body from breaking the feed", () => {
    const xml = renderRss(
      channel({
        items: [
          {
            title: "t",
            link: "https://hn.example.com/story/1",
            guid: "urn:hn:story:1",
            pubDate: rfc822(BASE),
            content: "<pre>page\u000Cbreak</pre>",
          },
        ],
      }),
    );
    expect(items(parseFeed(xml, "control-char feed"))[0]!["content:encoded"]).toBe(
      "<pre>pagebreak</pre>",
    );
  });

  test("emits an enclosure with a real byte length", () => {
    const parsed = parseFeed(
      renderRss(
        channel({
          items: [
            {
              title: "t",
              link: "https://hn.example.com/story/1",
              guid: "urn:hn:story:1",
              pubDate: rfc822(BASE),
              enclosure: {
                url: "https://hn.example.com/epub/story/1.epub",
                length: 4096,
                type: "application/epub+zip",
              },
            },
          ],
        }),
      ),
    );
    const enclosure = items(parsed)[0]!.enclosure!;
    // A string on the wire, but it has to be a number in it: a reader parses
    // this to size the download.
    expect(enclosure["@_length"]).toBe("4096");
    expect(enclosure["@_type"]).toBe("application/epub+zip");
  });

  test("an empty channel is still a valid feed", () => {
    const parsed = parseFeed(renderRss(channel({ items: [] })));
    expect(items(parsed)).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* Channels, against the database                                      */
/* ------------------------------------------------------------------ */

let dir: string;
let savedFetch: typeof globalThis.fetch;

function expectNoFetch(): void {
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    throw new Error(`feed generation made a network request: ${String(input)}`);
  }) as unknown as typeof fetch;
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
  const row = story(over);
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

/** A ready build row, as `markReady` would leave it, without writing a blob. */
function seedBuild(storyId: number, bytes: number, state = "ready"): void {
  getDb()
    .query(
      `INSERT INTO builds (kind, build_key, state, started_at, finished_at, path, bytes, sha256, error)
       VALUES ('story', ?, ?, ?, ?, ?, ?, 'abc123', NULL)`,
    )
    .run(String(storyId), state, BASE, BASE, `/blobs/epub/story-${storyId}.epub`, bytes);
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

beforeEach(() => {
  dir = makeTempDataDir("hn-opds-rss-");
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

describe("recentStories", () => {
  test("spans editions, newest submission first", () => {
    seedEdition("2026-08-15");
    seedEdition("2026-08-16");
    seedStory({ id: 1, edition_date: "2026-08-15", created_at_i: BASE });
    seedStory({ id: 2, edition_date: "2026-08-16", created_at_i: BASE + 90_000 });
    seedStory({ id: 3, edition_date: "2026-08-16", created_at_i: BASE + 95_000 });

    expect(recentStories(10).map((s) => s.id)).toEqual([3, 2, 1]);
  });

  test("drops the oldest when limited", () => {
    seedEdition("2026-08-16");
    seedStory({ id: 1, created_at_i: BASE });
    seedStory({ id: 2, created_at_i: BASE + 10 });
    expect(recentStories(1).map((s) => s.id)).toEqual([2]);
  });

  test("ignores stories belonging to an edition still pending", () => {
    getDb()
      .query(
        `INSERT INTO editions (date, tz, start_unix, end_unix, story_count, state)
         VALUES ('2026-08-17', 'Europe/Amsterdam', ?, ?, 1, 'pending')`,
      )
      .run(BASE, BASE + 86400);
    seedStory({ id: 9, edition_date: "2026-08-17" });
    expect(recentStories(10)).toHaveLength(0);
  });
});

describe("readyStoryEpubBytes", () => {
  test("returns sizes only for builds that are ready", () => {
    seedEdition("2026-08-16");
    seedStory({ id: 1 });
    seedStory({ id: 2 });
    seedStory({ id: 3 });
    seedBuild(1, 51_200);
    seedBuild(2, 0, "failed");

    const sizes = readyStoryEpubBytes([1, 2, 3]);
    expect(sizes.get(1)).toBe(51_200);
    expect(sizes.has(2)).toBe(false);
    expect(sizes.has(3)).toBe(false);
  });

  test("does not query at all for an empty id list", () => {
    expect(readyStoryEpubBytes([]).size).toBe(0);
  });
});

describe("storyItem", () => {
  test("identifies the story with the same urn the catalogue and the EPUB use", () => {
    const item = storyItem(story(), article(), undefined, "https://hn.example.com");
    expect(item.guid).toBe(storyEntryId(999_999_001));
    expect(item.guid).toBe("urn:hn:story:999999001");
  });

  test("dates the item from the submission, not the wall clock", () => {
    const item = storyItem(story(), article(), undefined, "https://hn.example.com");
    expect(item.pubDate).toBe(rfc822(BASE + 3600));
    expect(storyItem(story(), article(), undefined).pubDate).toBe(item.pubDate);
  });

  test("carries the extracted article body, absolute URLs and all", () => {
    const item = storyItem(
      story(),
      article({ xhtml: '<p>See <a href="https://seangoedecke.com/x/">this</a>.</p>' }),
      undefined,
      "https://hn.example.com",
    );
    expect(item.content).toContain("https://seangoedecke.com/x/");
  });

  test("links the story page on this site, where the comments are", () => {
    const item = storyItem(story(), article(), undefined, "https://hn.example.com");
    expect(item.link).toBe("https://hn.example.com/story/999999001");
    // The original and the discussion are still reachable from the item.
    expect(item.comments).toBe("https://news.ycombinator.com/item?id=999999001");
    expect(item.content).toContain("https://seangoedecke.com/good-system-design/");
  });

  test("summarises with the article's own opening", () => {
    const item = storyItem(story(), article(), undefined);
    expect(item.description).toStartWith("Boring systems are good systems");
  });

  test("falls back to the metadata line when nothing was extracted", () => {
    const item = storyItem(story(), null, undefined);
    expect(item.description).toContain("412 points");
    expect(item.description).toContain("208 comments");
  });

  test("explains a failed extraction rather than shipping an empty body", () => {
    const item = storyItem(
      story(),
      article({ state: "failed", xhtml: "", error_code: "http_404" }),
      undefined,
    );
    expect(item.content).toContain("Article text unavailable");
    expect(item.content).toContain("http_404");
  });

  test("attaches an enclosure when the EPUB is built", () => {
    const item = storyItem(story(), article(), 51_200, "https://hn.example.com");
    expect(item.enclosure).toEqual({
      url: "https://hn.example.com/epub/story/999999001.epub",
      length: 51_200,
      type: "application/epub+zip",
    });
  });

  test("omits the enclosure entirely when the EPUB is not built", () => {
    // A guessed or zero length is worse than no enclosure: a reader that
    // pre-downloads them reports a broken file instead of simply not offering
    // a book that does not exist yet.
    const item = storyItem(story(), article(), undefined, "https://hn.example.com");
    expect(item.enclosure).toBeUndefined();
    expect(item.content).not.toContain("Download EPUB");
  });

  test("credits the source domain as the author", () => {
    expect(storyItem(story(), article(), undefined).creator).toBe("seangoedecke.com");
    expect(
      storyItem(story({ url: null, domain: null, is_text_post: 1 }), null, undefined).creator,
    ).toBe("ingve");
  });
});

describe("latestChannel", () => {
  beforeEach(() => {
    seedEdition("2026-08-15");
    seedEdition("2026-08-16");
    seedStory({ id: 1, edition_date: "2026-08-15", title: "Older", created_at_i: BASE });
    seedStory({
      id: 2,
      edition_date: "2026-08-16",
      title: "Newer",
      created_at_i: BASE + 90_000,
    });
    saveArticle(article({ story_id: 2 }));
    seedBuild(2, 51_200);
  });

  test("renders both editions into one well-formed feed", () => {
    const parsed = parseFeed(renderRss(latestChannel("https://hn.example.com")), "latest");
    expect(items(parsed).map((i) => i.title)).toEqual(["Newer", "Older"]);
  });

  test("dates the channel from the newest item, not from now", () => {
    expect(latestChannel("https://hn.example.com").lastBuild).toBe(BASE + 90_000);
    expect(parseFeed(renderRss(latestChannel())).lastBuildDate).toBe(rfc822(BASE + 90_000));
  });

  test("respects the item limit", () => {
    setConfigForTests({ dataDir: dir, rssItemLimit: 1 });
    expect(latestChannel().items).toHaveLength(1);
  });

  test("is empty but valid before anything is ingested", () => {
    getDb().run("DELETE FROM stories");
    const parsed = parseFeed(renderRss(latestChannel("https://hn.example.com")), "empty");
    expect(items(parsed)).toHaveLength(0);
    expect(parsed.lastBuildDate).toBe(rfc822(0));
  });

  test("every URL in the feed is absolute and on the requested origin", () => {
    const xml = renderRss(latestChannel("https://hn.example.com"));
    const parsed = parseFeed(xml, "absolute");

    const urls = [
      parsed.link,
      parsed["atom:link"]["@_href"],
      ...items(parsed).flatMap((i) => [i.link!, i.enclosure?.["@_url"]]),
    ].filter((u): u is string => typeof u === "string");

    expect(urls.length).toBeGreaterThan(3);
    for (const url of urls) {
      expect(new URL(url).origin).toBe("https://hn.example.com");
    }
    expect(xml).not.toContain(DEFAULTS.publicBaseUrl);
  });
});

describe("editionChannel", () => {
  test("carries only that edition, in a well-formed feed", () => {
    seedEdition("2026-08-15");
    seedEdition("2026-08-16");
    seedStory({ id: 1, edition_date: "2026-08-15", title: "Older" });
    seedStory({ id: 2, edition_date: "2026-08-16", title: "Newer" });

    const parsed = parseFeed(
      renderRss(editionChannel("2026-08-16", "https://hn.example.com")),
      "edition",
    );
    expect(items(parsed).map((i) => i.title)).toEqual(["Newer"]);
    expect(parsed["atom:link"]["@_href"]).toBe(
      "https://hn.example.com/rss/archive/2026-08-16",
    );
    expect(parsed.link).toBe("https://hn.example.com/archive/2026-08-16");
  });

  test("mirrors the OPDS and website paths for the same edition", () => {
    expect(rssEditionPath("2026-08-16")).toBe("/rss/archive/2026-08-16");
  });
});

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

describe("GET /rss", () => {
  test("serves a parseable feed with the RSS content type", async () => {
    seedEdition("2026-08-16");
    seedStory({ id: 1 });

    const res = await call(rssRoute, event("/rss"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/rss+xml; charset=utf-8");
    expect(items(parseFeed(await res.text(), "route feed"))).toHaveLength(1);
  });

  test("derives absolute URLs from the request when no base URL is set", async () => {
    // The KOReader failure this guards against: a reader loads the feed over
    // the LAN and every link inside points at the reader's own localhost.
    seedEdition("2026-08-16");
    seedStory({ id: 1 });

    const res = await call(rssRoute, event("/rss", { headers: { host: "192.168.1.50:3000" } }));
    const parsed = parseFeed(await res.text(), "lan feed");
    expect(parsed["atom:link"]["@_href"]).toBe("http://192.168.1.50:3000/rss");
    expect(items(parsed)[0]!.link).toBe("http://192.168.1.50:3000/story/1");
  });

  test("an explicit base URL wins over the request", async () => {
    setConfigForTests({ dataDir: dir, publicBaseUrl: "https://hn.example.com" });
    seedEdition("2026-08-16");
    seedStory({ id: 1 });

    const res = await call(rssRoute, event("/rss", { headers: { host: "192.168.1.50:3000" } }));
    expect(parseFeed(await res.text(), "configured feed")["atom:link"]["@_href"]).toBe(
      "https://hn.example.com/rss",
    );
  });

  test("is cached briefly, because a new edition can land at any hour", async () => {
    const res = await call(rssRoute, event("/rss"));
    expect(res.headers.get("cache-control")).toBe(LATEST_CACHE);
    expect(LATEST_CACHE).toContain("max-age=300");
  });

  test("answers an unchanged feed with 304 and no body", async () => {
    // Fifty full articles is close to a megabyte, and feed readers poll on
    // their own schedule whatever Cache-Control says.
    seedEdition("2026-08-16");
    seedStory({ id: 1 });

    const first = await call(rssRoute, event("/rss"));
    const etag = first.headers.get("etag")!;
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);

    const second = await call(
      rssRoute,
      event("/rss", { headers: { "if-none-match": etag } }),
    );
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
    expect(second.headers.get("etag")).toBe(etag);
  });

  test("changes its etag when a story's EPUB appears", async () => {
    // The timestamps do not move when a build finishes, so an etag over the
    // rendered bytes is the only thing that tells a reader its copy has no
    // enclosures in it.
    seedEdition("2026-08-16");
    seedStory({ id: 1 });

    const before = (await call(rssRoute, event("/rss"))).headers.get("etag");
    seedBuild(1, 51_200);
    const after = (await call(rssRoute, event("/rss"))).headers.get("etag");

    expect(before).not.toBe(after);
  });

  test("sends Last-Modified as an HTTP date in GMT, not the feed's own format", async () => {
    seedEdition("2026-08-16");
    seedStory({ id: 1, created_at_i: BASE });

    const res = await call(rssRoute, event("/rss"));
    // The feed body says "+0200" for this instant; the header may not.
    expect(res.headers.get("last-modified")).toBe("Sat, 16 Aug 2025 00:00:00 GMT");
  });

  test("answers 200 with an empty feed before anything is ingested", async () => {
    // Deliberately unlike /opds/today, which 404s. A feed reader polls on a
    // schedule regardless of item count, but it will refuse to create a
    // subscription that answered 404.
    const res = await call(rssRoute, event("/rss"));
    expect(res.status).toBe(200);
    expect(items(parseFeed(await res.text(), "empty route feed"))).toHaveLength(0);
  });
});

describe("GET /rss/archive/:date", () => {
  test("serves one edition", async () => {
    seedEdition("2026-08-16");
    seedStory({ id: 1, title: "An archived story" });

    const res = await call(
      rssEditionRoute,
      event("/rss/archive/2026-08-16", { params: { date: "2026-08-16" } }),
    );
    expect(res.status).toBe(200);
    expect(items(parseFeed(await res.text(), "edition route"))[0]!.title).toBe(
      "An archived story",
    );
  });

  test("is cached for a day, since an edition is finished", async () => {
    seedEdition("2026-08-16");
    const res = await call(
      rssEditionRoute,
      event("/rss/archive/2026-08-16", { params: { date: "2026-08-16" } }),
    );
    expect(res.headers.get("cache-control")).toBe(EDITION_CACHE);
  });

  test("404s a date with no edition rather than an empty feed", () => {
    expect(() =>
      rssEditionRoute(event("/rss/archive/2020-01-01", { params: { date: "2020-01-01" } })),
    ).toThrow(HTTPError);
  });

  test("400s a malformed date without touching the database", () => {
    for (const date of ["nope", "2026-8-16", "", "../../etc/passwd", "2026-08-16'"]) {
      expect(() => rssEditionRoute(event("/rss/archive/x", { params: { date } }))).toThrow(
        HTTPError,
      );
    }
  });
});

/* ------------------------------------------------------------------ */
/* Discovery                                                           */
/* ------------------------------------------------------------------ */

describe("feed discovery", () => {
  test("every page advertises the site feed and links it for a human", async () => {
    seedEdition("2026-08-16");
    seedStory({ id: 1 });

    const html = await (await call(indexRoute, event("/"))).text();
    expect(html).toContain(
      '<link rel="alternate" type="application/rss+xml" href="/rss"',
    );
    expect(html).toContain('<a href="/rss">RSS feed</a>');
  });

  test("an edition page advertises the live feed before its own frozen one", async () => {
    seedEdition("2026-08-16");
    seedStory({ id: 1 });

    const html = await (
      await call(
        archiveDateRoute,
        event("/archive/2026-08-16", { params: { date: "2026-08-16" } }),
      )
    ).text();

    const site = html.indexOf('href="/rss"');
    const dated = html.indexOf('href="/rss/archive/2026-08-16"');
    expect(site).toBeGreaterThan(-1);
    expect(dated).toBeGreaterThan(-1);
    // A dated feed never updates again, so a client that takes only the first
    // autodiscovered feed must find the live one.
    expect(site).toBeLessThan(dated);
  });

  test("the service worker leaves feed requests alone", () => {
    const src = serviceWorkerJs({ version: "v1", precache: [] });
    const isBypassed = new Function(
      `${src.slice(src.indexOf("function isBypassed"))}; return isBypassed;`,
    )() as (path: string) => boolean;

    expect(isBypassed(RSS_HREF)).toBe(true);
    expect(isBypassed("/rss/archive/2026-08-16")).toBe(true);
    // Still not a blanket prefix match on everything that starts with a slash.
    expect(isBypassed("/story/1")).toBe(false);
  });
});
