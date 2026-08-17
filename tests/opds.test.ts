import { describe, expect, test } from "bun:test";
import { XMLValidator } from "fast-xml-parser";

import {
  ACQUISITION_TYPE,
  EPUB_TYPE,
  NAVIGATION_TYPE,
  REL,
  renderFeed,
  rfc3339,
} from "~/opds/atom";
import {
  archiveFeed,
  editionDigestEntry,
  editionEntryId,
  editionFeed,
  feedId,
  rootFeed,
  storyEntry,
} from "~/opds/catalog";
import { resetConfig, setConfigForTests } from "~/config";
import { DEFAULTS } from "~/defaults";
import type { StoryRow } from "~/core/edition";

const BASE = 1_755_302_400; // 2025-08-16T00:00:00Z

function expectWellFormed(xml: string, label = "xml") {
  const result = XMLValidator.validate(xml);
  if (result !== true) {
    throw new Error(`${label} is not well-formed: ${JSON.stringify(result.err)}\n${xml}`);
  }
}

function story(over: Partial<StoryRow> = {}): StoryRow {
  return {
    id: 999_999_001,
    edition_date: "2026-08-16",
    rank: 1,
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

describe("rfc3339", () => {
  test("strips milliseconds", () => {
    expect(rfc3339(new Date("2026-08-16T09:30:00.123Z"))).toBe("2026-08-16T09:30:00Z");
  });

  test("treats a number as unix seconds", () => {
    expect(rfc3339(BASE)).toBe("2025-08-16T00:00:00Z");
  });

  test("is stable for the same input", () => {
    expect(rfc3339(BASE)).toBe(rfc3339(BASE));
  });
});

describe("feedId", () => {
  test("is a URN, not derived from the base URL", () => {
    setConfigForTests({ publicBaseUrl: "https://example.org" });
    const a = feedId("today");
    setConfigForTests({ publicBaseUrl: "http://localhost:8080" });
    const b = feedId("today");
    resetConfig();

    expect(a).toBe("urn:hacker-opds:today");
    // Subscriptions dedupe on id; moving the deployment must not orphan them.
    expect(a).toBe(b);
  });
});

describe("renderFeed", () => {
  test("produces well-formed XML with the OPDS namespaces", () => {
    const xml = renderFeed({
      id: feedId("root"),
      title: "Hacker News",
      updated: rfc3339(BASE),
      links: [{ rel: REL.self, href: "https://example.org/opds", type: NAVIGATION_TYPE }],
      entries: [],
    });

    expectWellFormed(xml, "root feed");
    expect(xml).toStartWith('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('xmlns="http://www.w3.org/2005/Atom"');
    expect(xml).toContain("http://opds-spec.org/2010/catalog");
  });

  test("escapes XML metacharacters in titles and summaries", () => {
    const xml = renderFeed({
      id: feedId("x"),
      title: "Tom & Jerry <script>",
      updated: rfc3339(BASE),
      links: [],
      entries: [
        {
          id: "urn:hn:story:1",
          title: 'Ask HN: "quotes" & <tags>',
          updated: rfc3339(BASE),
          links: [],
          summary: "a & b < c",
        },
      ],
    });

    expectWellFormed(xml, "escaped feed");
    expect(xml).toContain("Tom &amp; Jerry &lt;script&gt;");
    expect(xml).not.toContain("<script>");
  });
});

describe("rootFeed", () => {
  const feed = rootFeed(BASE);
  const xml = renderFeed(feed);

  test("is well-formed and uses a URN id", () => {
    expectWellFormed(xml, "root feed");
    expect(feed.id).toBe("urn:hacker-opds:root");
  });

  test("links Today as an acquisition feed", () => {
    const today = feed.entries.find((e) => e.title === "Today");
    expect(today).toBeDefined();
    const link = today!.links.find((l) => l.href.endsWith("/opds/today"));
    expect(link?.type).toBe(ACQUISITION_TYPE);
    expect(link?.rel).toBe("subsection");
  });

  test("links Archive as a navigation feed", () => {
    const archive = feed.entries.find((e) => e.title === "Archive");
    const link = archive!.links.find((l) => l.href.endsWith("/opds/archive"));
    expect(link?.type).toBe(NAVIGATION_TYPE);
  });

  test("carries a self link", () => {
    expect(feed.links.some((l) => l.rel === REL.self)).toBe(true);
  });
});

describe("storyEntry", () => {
  const entry = storyEntry(story());

  test("identifies the story by URN", () => {
    expect(entry.id).toBe("urn:hn:story:999999001");
  });

  test("offers an open-access EPUB acquisition link", () => {
    const acq = entry.links.find((l) => l.rel === REL.acquisition);
    expect(acq).toBeDefined();
    expect(acq!.type).toBe(EPUB_TYPE);
    expect(acq!.href).toEndWith("/epub/story/999999001.epub");
  });

  test("uses the documented OPDS acquisition relation", () => {
    expect(REL.acquisition).toBe("http://opds-spec.org/acquisition/open-access");
  });

  test("links both the HN discussion and the original article", () => {
    const hrefs = entry.links.filter((l) => l.rel === REL.alternate).map((l) => l.href);
    expect(hrefs).toContain("https://news.ycombinator.com/item?id=999999001");
    expect(hrefs).toContain("https://seangoedecke.com/good-system-design/");
  });

  test("summarises points, comments, domain and submitter", () => {
    expect(entry.summary).toContain("412 points");
    expect(entry.summary).toContain("208 comments");
    expect(entry.summary).toContain("seangoedecke.com");
    expect(entry.summary).toContain("pg");
  });

  test("omits the article link for a text post", () => {
    const e = storyEntry(story({ url: null, is_text_post: 1, domain: "news.ycombinator.com" }));
    const hrefs = e.links.filter((l) => l.rel === REL.alternate).map((l) => l.href);
    expect(hrefs).toEqual(["https://news.ycombinator.com/item?id=999999001"]);
  });

  test("dates the entry from the story, not the wall clock", () => {
    expect(entry.updated).toBe(rfc3339(BASE + 3600));
    expect(storyEntry(story()).updated).toBe(entry.updated);
  });

  test("categorises by domain", () => {
    expect(entry.categories).toContain("seangoedecke.com");
  });

  test("advertises a cover and a separate thumbnail", () => {
    const image = entry.links.find((l) => l.rel === REL.image);
    const thumb = entry.links.find((l) => l.rel === REL.thumbnail);

    expect(image!.href).toEndWith("/cover/story/999999001.png");
    expect(image!.type).toBe("image/png");
    // Distinct URLs, or a reader drawing a grid pulls full-size covers for
    // every row - which is the entire reason OPDS has two relations.
    expect(thumb!.href).toEndWith("/cover/story/999999001.thumb.png");
    expect(thumb!.href).not.toBe(image!.href);
  });
});

describe("editionDigestEntry", () => {
  const entry = editionDigestEntry("2026-08-16", [story(), story({ id: 2, rank: 2 })]);

  test("shares its id with the digest EPUB's dc:identifier", () => {
    expect(entry.id).toBe("urn:hn:edition:2026-08-16");
    expect(entry.id).toBe(editionEntryId("2026-08-16"));
  });

  test("offers the digest as an open-access EPUB", () => {
    const acq = entry.links.find((l) => l.rel === REL.acquisition);
    expect(acq!.type).toBe(EPUB_TYPE);
    expect(acq!.href).toEndWith("/epub/edition/2026-08-16.epub");
  });

  test("states the caps rather than silently applying them", () => {
    expect(entry.summary).toContain("2 stories");
    expect(entry.summary).toContain(String(DEFAULTS.digestThreadsPerStory));
    expect(entry.summary).toContain(String(DEFAULTS.digestCommentMaxDepth));
  });

  test("carries its own cover", () => {
    const image = entry.links.find((l) => l.rel === REL.image);
    expect(image!.href).toEndWith("/cover/edition/2026-08-16.png");
  });

  test("is dated from the newest story, matching the feed", () => {
    const e = editionDigestEntry("2026-08-16", [
      story({ created_at_i: BASE + 10 }),
      story({ id: 2, created_at_i: BASE + 7000 }),
    ]);
    expect(e.updated).toBe(rfc3339(BASE + 7000));
  });
});

describe("editionFeed", () => {
  test("renders every story and stays well-formed", () => {
    const stories = [story(), story({ id: 999_999_002, rank: 2, title: "Second & <b>bold</b>" })];
    const xml = renderFeed(editionFeed("2026-08-16", stories));

    expectWellFormed(xml, "edition feed");
    expect(xml).toContain("urn:hn:story:999999001");
    expect(xml).toContain("urn:hn:story:999999002");
    expect(xml).toContain("Second &amp; &lt;b&gt;bold&lt;/b&gt;");
  });

  test("takes updated from the newest story", () => {
    const feed = editionFeed("2026-08-16", [
      story({ created_at_i: BASE + 100 }),
      story({ id: 2, created_at_i: BASE + 9000 }),
    ]);
    expect(feed.updated).toBe(rfc3339(BASE + 9000));
  });

  test("leads with the digest, then the stories in rank order", () => {
    const feed = editionFeed("2026-08-16", [
      story(),
      story({ id: 999_999_002, rank: 2 }),
    ]);
    expect(feed.entries.map((e) => e.id)).toEqual([
      "urn:hn:edition:2026-08-16",
      "urn:hn:story:999999001",
      "urn:hn:story:999999002",
    ]);
  });

  test("handles an empty edition without crashing", () => {
    const feed = editionFeed("2026-08-16", []);
    const xml = renderFeed(feed);
    expectWellFormed(xml, "empty edition feed");
    // No stories means no digest either: there would be nothing in the book.
    expect(feed.entries).toHaveLength(0);
  });

  test("carries self, start and up links", () => {
    const feed = editionFeed("2026-08-16", [story()]);
    const rels = feed.links.map((l) => l.rel);
    expect(rels).toContain(REL.self);
    expect(rels).toContain(REL.start);
    expect(rels).toContain(REL.up);
  });
});

describe("archiveFeed", () => {
  test("lists one navigation entry per edition", () => {
    const feed = archiveFeed(["2026-08-16", "2026-08-15"], BASE);
    const xml = renderFeed(feed);

    expectWellFormed(xml, "archive feed");
    expect(feed.entries).toHaveLength(2);
    expect(xml).toContain("/opds/archive/2026-08-16");
    expect(xml).toContain("/opds/archive/2026-08-15");
  });

  test("points entries at acquisition feeds", () => {
    const feed = archiveFeed(["2026-08-16"], BASE);
    const link = feed.entries[0]!.links[0]!;
    expect(link.type).toBe(ACQUISITION_TYPE);
  });

  test("survives an empty archive", () => {
    const feed = archiveFeed([], BASE);
    expectWellFormed(renderFeed(feed), "empty archive");
    expect(feed.entries).toHaveLength(0);
  });
});

describe("content types", () => {
  test("carry the OPDS catalog profile", () => {
    expect(NAVIGATION_TYPE).toBe(
      "application/atom+xml;profile=opds-catalog;kind=navigation",
    );
    expect(ACQUISITION_TYPE).toBe(
      "application/atom+xml;profile=opds-catalog;kind=acquisition",
    );
  });
});
