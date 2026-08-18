/**
 * The page shell and the view bodies, rendered.
 *
 * mono-jsx turns *only* a literal `<html>` element into a `Response`; a
 * component that returns one yields an inert VNode with no status, no headers
 * and no doctype. That constraint is why routes own their `<html>` tag, and it
 * is why these tests write one too - `asResponse` fails loudly if the shape
 * ever stops being a Response, which is the failure the production routes would
 * otherwise hit silently.
 *
 * Everything here is a string comparison against rendered markup. There is no
 * DOM, no network and no database: the views are pure functions of their props.
 */
import { describe, expect, test } from "bun:test";
import type { CommentRow } from "~/core/comments";
import type { EditionSummary, StoryRow } from "~/core/edition";
import type { ArticleRecord } from "~/core/extract";
import {
  APPLE_TOUCH_ICON_URL,
  APP_JS_URL,
  CSS_URL,
  FAVICON_ICO_URL,
  ICON_SVG_URL,
  MANIFEST_URL,
} from "~/web/assets";
import { DEFAULT_FONT, FONT_CSS_URL, type FontId } from "~/web/fonts";
import { SITE_NAME, SOURCE_URL, Shell, isCurrentSection, pageAttrs } from "~/web/layout";
import type { Theme } from "~/web/theme";
import {
  ArchiveView,
  EditionView,
  NotFoundView,
  OfflineView,
  StoryView,
} from "~/web/views";

const T0 = 1_755_302_400; // 2025-08-16T00:00:00Z

function story(over: Partial<StoryRow> = {}): StoryRow {
  return {
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
    ...over,
  };
}

function article(over: Partial<ArticleRecord> = {}): ArticleRecord {
  return {
    story_id: 44921137,
    state: "ok",
    fetched_at: T0 + 100,
    http_status: 200,
    final_url: "https://seangoedecke.com/good-system-design/",
    title: "Good system design",
    author: "Sean Goedecke",
    published: "2025-08-01T00:00:00Z",
    site: "seangoedecke.com",
    language: "en",
    word_count: 1200,
    xhtml: "<p>Systems should be boring.</p>",
    markdown: "Systems should be boring.",
    error_code: null,
    ...over,
  };
}

function comment(over: Partial<CommentRow> = {}): CommentRow {
  return {
    id: 1,
    story_id: 44921137,
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
 * Asserts the mono-jsx contract before unwrapping.
 *
 * If a refactor ever moves the `<html>` element inside a component this stops
 * being a Response, and every route's status and headers would be dropped
 * without a single type error.
 */
function asResponse(element: unknown): Response {
  if (!(element instanceof Response)) {
    throw new Error(
      `expected a literal <html> element to render as a Response, got ${typeof element}`,
    );
  }
  return element;
}

/** Renders a `<main>` body inside the real shell. */
async function renderPage(
  body: JSX.Element,
  opts: {
    theme?: Theme;
    font?: FontId;
    path?: string;
    title?: string;
    description?: string;
  } = {},
): Promise<string> {
  const theme = opts.theme ?? "auto";
  const font = opts.font ?? DEFAULT_FONT;
  const path = opts.path ?? "/";
  return asResponse(
    <html {...pageAttrs({ theme, font })}>
      <Shell
        title={opts.title ?? "Today"}
        theme={theme}
        font={font}
        path={path}
        description={opts.description}
      >
        {body}
      </Shell>
    </html>,
  ).text();
}

/** The rendered `<main>` only, for assertions that should ignore the chrome. */
function mainOf(html: string): string {
  const start = html.indexOf('<main id="main">');
  const end = html.indexOf("</main>");
  return html.slice(start, end);
}

/** Reads an attribute value out of rendered markup, entity-decoded. */
function attr(html: string, name: string): string | null {
  const match = new RegExp(`${name}="([^"]*)"`).exec(html);
  if (!match) return null;
  return (match[1] ?? "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

describe("isCurrentSection", () => {
  test("matches the root only exactly", () => {
    // A prefix match here would mark "Today" current on every page on the site.
    expect(isCurrentSection("/", "/")).toBe(true);
    expect(isCurrentSection("/", "/archive")).toBe(false);
    expect(isCurrentSection("/", "/story/1")).toBe(false);
    expect(isCurrentSection("/", "/offline")).toBe(false);
  });

  test("matches a section exactly", () => {
    expect(isCurrentSection("/archive", "/archive")).toBe(true);
    expect(isCurrentSection("/opds", "/opds")).toBe(true);
  });

  test("matches a page inside a section, so an edition still lights up Archive", () => {
    expect(isCurrentSection("/archive", "/archive/2026-08-16")).toBe(true);
    expect(isCurrentSection("/opds", "/opds/editions")).toBe(true);
  });

  test("requires a path separator, not just a string prefix", () => {
    expect(isCurrentSection("/archive", "/archived")).toBe(false);
    expect(isCurrentSection("/opds", "/opdsx")).toBe(false);
  });

  test("does not match a different section", () => {
    expect(isCurrentSection("/archive", "/story/1")).toBe(false);
    expect(isCurrentSection("/opds", "/archive")).toBe(false);
  });
});

describe("pageAttrs", () => {
  test("always emits lang and data-theme", () => {
    expect(pageAttrs({ theme: "auto" })).toEqual({ lang: "en", "data-theme": "auto" });
  });

  test("emits data-theme for auto too", () => {
    // The stylesheet keys its prefers-color-scheme block off
    // [data-theme="auto"] specifically, so omitting it leaves no theme at all.
    expect(pageAttrs({ theme: "auto" })["data-theme"]).toBe("auto");
    expect(pageAttrs({ theme: "dark" })["data-theme"]).toBe("dark");
    expect(pageAttrs({ theme: "light" })["data-theme"]).toBe("light");
  });

  test("omits status entirely when it is not given, rather than sending 200", () => {
    expect(pageAttrs({ theme: "dark" })).not.toHaveProperty("status");
    expect(pageAttrs({ theme: "dark", status: 404 })).toHaveProperty("status", 404);
  });

  test("omits headers when no cache-control is given", () => {
    expect(pageAttrs({ theme: "dark" })).not.toHaveProperty("headers");
    expect(pageAttrs({ theme: "dark", cacheControl: "no-cache" })).toMatchObject({
      headers: { "cache-control": "no-cache" },
    });
  });
});

describe("Shell - document", () => {
  test("renders a real Response, not an inert node", () => {
    const res = asResponse(
      <html {...pageAttrs({ theme: "dark", status: 404, cacheControl: "no-store" })}>
        <Shell title="No such story" theme="dark" path="/">
          <NotFoundView message="Gone." />
        </Shell>
      </html>,
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("emits a doctype, so browsers do not fall into quirks mode", async () => {
    // Quirks mode changes box sizing, which on a narrow e-ink screen is the
    // difference between a readable column and a horizontally scrolling one.
    expect(await renderPage(<OfflineView />)).toContain("<!DOCTYPE html>");
  });

  test("declares the document language", async () => {
    expect(await renderPage(<OfflineView />)).toContain('lang="en"');
  });

  test("sets the viewport and charset", async () => {
    const html = await renderPage(<OfflineView />);
    expect(html).toContain('name="viewport"');
    expect(html).toContain("width=device-width, initial-scale=1");
    expect(html.toLowerCase()).toContain('charset="utf-8"');
  });

  test("links one stylesheet, one manifest and one deferred script", async () => {
    const html = await renderPage(<OfflineView />);
    expect(html).toContain(`<link rel="stylesheet" href="${CSS_URL}">`);
    expect(html).toContain(`<link rel="manifest" href="${MANIFEST_URL}">`);
    expect(html).toContain(`<script src="${APP_JS_URL}" defer></script>`);
    // Two: the site stylesheet and the generated @font-face file. They are
    // separate so that rebuilding a font does not evict site.css from every
    // reader's cache.
    expect(html).toContain(`<link rel="stylesheet" href="${FONT_CSS_URL}">`);
    expect(html.match(/rel="stylesheet"/g)).toHaveLength(2);
  });

  test("advertises the OPDS catalogue for feed autodiscovery", async () => {
    const html = await renderPage(<OfflineView />);
    expect(html).toContain('rel="alternate"');
    expect(html).toContain("profile=opds-catalog;kind=navigation");
    expect(html).toContain('href="/opds"');
  });

  test("links the icon three ways, one per kind of consumer", async () => {
    const html = await renderPage(<OfflineView />);
    // The URLs are imported, never spelled out: a hashed path written into a
    // test is a hashed path that keeps passing after the icon is redrawn.
    expect(html).toContain(`<link rel="icon" type="image/svg+xml" href="${ICON_SVG_URL}">`);
    expect(html).toContain(
      `<link rel="icon" type="image/x-icon" sizes="16x16 32x32 48x48" href="${FAVICON_ICO_URL}">`,
    );
    expect(html).toContain(
      `<link rel="apple-touch-icon" sizes="180x180" href="${APPLE_TOUCH_ICON_URL}">`,
    );
  });

  test("prefers the SVG, by declaring it first", async () => {
    // Browsers that understand more than one of these take the last one they
    // can render, but several take the first; putting the scalable,
    // self-inverting one at the top is the only ordering that is right for
    // both readings.
    const html = await renderPage(<OfflineView />);
    expect(html.indexOf(ICON_SVG_URL)).toBeLessThan(html.indexOf(FAVICON_ICO_URL));
  });

  test("does not link the root /favicon.ico, which exists for clients that guess", async () => {
    // Linking it would hand every browser an unhashed URL it has to revalidate
    // on each visit, when the hashed one it can freeze is right there.
    expect(await renderPage(<OfflineView />)).not.toContain('href="/favicon.ico"');
  });
});

describe("Shell - theme", () => {
  test("carries the resolved theme on the html element", async () => {
    expect(await renderPage(<OfflineView />, { theme: "dark" })).toContain('data-theme="dark"');
    expect(await renderPage(<OfflineView />, { theme: "light" })).toContain(
      'data-theme="light"',
    );
    expect(await renderPage(<OfflineView />, { theme: "auto" })).toContain('data-theme="auto"');
  });

  test("names the colour scheme so browser chrome matches the page", async () => {
    expect(await renderPage(<OfflineView />, { theme: "dark" })).toContain(
      '<meta name="color-scheme" content="dark">',
    );
    expect(await renderPage(<OfflineView />, { theme: "auto" })).toContain(
      '<meta name="color-scheme" content="light dark">',
    );
  });

  test("paints browser chrome to match the resolved theme", async () => {
    // The page's own background colours, from src/web/styles.ts. Not the
    // manifest's theme_color, which is the installed app's title bar and is
    // black in both themes on purpose.
    expect(await renderPage(<OfflineView />, { theme: "dark" })).toContain(
      '<meta name="theme-color" content="#000000">',
    );
    expect(await renderPage(<OfflineView />, { theme: "light" })).toContain(
      '<meta name="theme-color" content="#ffffff">',
    );
  });

  test("leaves theme-color to the device when the theme is auto", async () => {
    // Two media-scoped tags rather than a server-side guess: "auto" means the
    // reader asked the device to decide, and the server does not know.
    const html = await renderPage(<OfflineView />, { theme: "auto" });
    expect(html).toContain(
      '<meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff">',
    );
    expect(html).toContain(
      '<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#000000">',
    );
    expect(html.match(/name="theme-color"/g)).toHaveLength(2);
  });

  test("marks the current theme as selected in the settings panel", async () => {
    const dark = await renderPage(<OfflineView />, { theme: "dark" });
    // &amp; because this is HTML, not a URL - an unescaped & in an href is a
    // parse error waiting for an entity name to collide with.
    expect(dark).toContain('href="/settings?theme=dark&amp;to=%2F%23settings" rel="nofollow"');
    expect(dark).toMatch(/settings-theme-dark[^>]*aria-current="true"/);
    expect(dark).not.toMatch(/settings-theme-light[^>]*aria-current="true"/);

    const light = await renderPage(<OfflineView />, { theme: "light" });
    expect(light).toMatch(/settings-theme-light[^>]*aria-current="true"/);
    expect(light).not.toMatch(/settings-theme-dark[^>]*aria-current="true"/);
  });

  test("every setting is a link, so the panel works with scripting off", async () => {
    const html = await renderPage(<OfflineView />);
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<form");
  });

  test("settings links are nofollow, so crawlers do not cycle a cookie", async () => {
    const html = await renderPage(<OfflineView />);
    const links = html.match(/href="\/settings\?[^"]*"[^>]*/g) ?? [];
    expect(links.length).toBeGreaterThan(1);
    for (const link of links) expect(link).toContain('rel="nofollow"');
  });

  test("settings return to the page they were opened from, panel still open", async () => {
    const html = await renderPage(<OfflineView />, { path: "/archive/2026-08-16" });
    // %23settings is the encoded fragment: after the redirect the reader lands
    // back on the panel rather than at the top of the page.
    expect(html).toContain("to=%2Farchive%2F2026-08-16%23settings");
  });

  test("the nav opens the panel with a fragment, costing no request", async () => {
    const html = await renderPage(<OfflineView />);
    expect(html).toContain('<a href="#settings">Settings</a>');
    expect(html).toContain('<section id="settings" class="settings"');
  });
});

describe("Shell - navigation", () => {
  test("lists the three sections", async () => {
    const html = await renderPage(<OfflineView />);
    expect(html).toContain('<a href="/"');
    expect(html).toContain('<a href="/archive"');
    expect(html).toContain('<a href="/opds"');
    expect(html).toContain(">Today</a>");
    expect(html).toContain(">Archive</a>");
    expect(html).toContain(">OPDS</a>");
  });

  test("marks exactly one nav item as the current page", async () => {
    for (const path of ["/", "/archive", "/opds"]) {
      const html = await renderPage(<OfflineView />, { path });
      expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    }
  });

  test("marks the right one", async () => {
    expect(await renderPage(<OfflineView />, { path: "/" })).toContain(
      '<a href="/" aria-current="page">Today</a>',
    );
    expect(await renderPage(<OfflineView />, { path: "/archive" })).toContain(
      '<a href="/archive" aria-current="page">Archive</a>',
    );
  });

  test("marks Archive on an edition page", async () => {
    const html = await renderPage(<OfflineView />, { path: "/archive/2026-08-16" });
    expect(html).toContain('<a href="/archive" aria-current="page">Archive</a>');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });

  test("marks nothing on a page outside every section", async () => {
    const html = await renderPage(<OfflineView />, { path: "/offline" });
    expect(html).not.toContain('aria-current="page"');
  });

  test("labels the nav landmark", async () => {
    expect(await renderPage(<OfflineView />)).toContain('<nav aria-label="Sections">');
  });

  test("offers a skip link, as the first thing in the body", async () => {
    // Thirty story rows before the content is a lot of tab stops on a device
    // with no pointer.
    const html = await renderPage(<OfflineView />);
    expect(html).toContain('<a class="skip" href="#main">Skip to content</a>');
    expect(html.indexOf('class="skip"')).toBeLessThan(html.indexOf("<header"));
    expect(html).toContain('<main id="main">');
  });

  test("the wordmark links home", async () => {
    expect(await renderPage(<OfflineView />)).toContain(
      `<p class="wordmark"><a href="/">${SITE_NAME}</a></p>`,
    );
  });

  test("the footer repeats the catalogue and archive links", async () => {
    const html = await renderPage(<OfflineView />);
    const footer = html.slice(html.indexOf('<footer class="site-foot">'));
    expect(footer).toContain('href="/opds"');
    expect(footer).toContain('href="/archive"');
    expect(footer).toContain("https://news.ycombinator.com/");
  });

  test("the footer links to the source", async () => {
    const html = await renderPage(<OfflineView />);
    const footer = html.slice(html.indexOf('<footer class="site-foot">'));
    expect(footer).toContain(`<a href="${SOURCE_URL}">Source</a>`);
  });

  /*
   * The masthead is capped at five entries for tap-target reasons (see the NAV
   * comment in layout.tsx), so this asserts the source link stayed out of it.
   * Without this the next person to "improve discoverability" silently spends
   * the last slot.
   */
  test("the source link is not in the nav", async () => {
    const html = await renderPage(<OfflineView />);
    const nav = html.slice(html.indexOf("<nav"), html.indexOf("</nav>"));
    expect(nav).not.toContain(SOURCE_URL);
  });
});

describe("Shell - head metadata", () => {
  test("suffixes the site name onto a page title", async () => {
    const html = await renderPage(<OfflineView />, { title: "Archive" });
    expect(html).toContain(`<title>Archive \u00b7 ${SITE_NAME}</title>`);
  });

  test("does not repeat the site name when the page is the site", async () => {
    const html = await renderPage(<OfflineView />, { title: SITE_NAME });
    expect(html).toContain(`<title>${SITE_NAME}</title>`);
  });

  test("escapes a hostile title", async () => {
    const html = await renderPage(<OfflineView />, {
      title: '</title><script>alert(1)</script>',
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("emits a description when there is one", async () => {
    const html = await renderPage(<OfflineView />, { description: "The edition of 16 August." });
    expect(html).toContain('<meta name="description" content="The edition of 16 August.">');
  });

  test("escapes a description, which is drawn from extracted article text", async () => {
    const html = await renderPage(<OfflineView />, {
      description: '"><script>alert(1)</script>',
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(attr(html.slice(html.indexOf('name="description"')), "content")).toBe(
      '"><script>alert(1)</script>',
    );
  });

  test("omits the description rather than faking one", async () => {
    expect(await renderPage(<OfflineView />)).not.toContain('name="description"');
  });
});

describe("EditionView", () => {
  const stories = [
    story({ id: 1, title: "First story", points: 1, num_comments: 1 }),
    story({ id: 2, title: "Second story", domain: null, is_text_post: 1 }),
    story({ id: 3, title: "Third story" }),
  ];

  test("heads the page with the relative day and the exact date under it", async () => {
    const main = mainOf(
      await renderPage(<EditionView date="2026-08-16" today="2026-08-16" stories={stories} />),
    );
    expect(main).toContain('<h1 class="page-title">Today</h1>');
    expect(main).toContain('<p class="page-sub">Sunday, 16 August 2026</p>');
  });

  test("uses a supplied subtitle in place of the derived one", async () => {
    const main = mainOf(
      await renderPage(
        <EditionView
          date="2026-08-10"
          today="2026-08-16"
          stories={stories}
          subtitle="Monday, 10 August 2026"
        />,
      ),
    );
    expect(main).toContain('<p class="page-sub">Monday, 10 August 2026</p>');
  });

  test("counts the stories", async () => {
    const main = mainOf(
      await renderPage(<EditionView date="2026-08-16" today="2026-08-16" stories={stories} />),
    );
    expect(main).toContain("3 stories");
    const one = mainOf(
      await renderPage(
        <EditionView date="2026-08-16" today="2026-08-16" stories={[stories[0] as StoryRow]} />,
      ),
    );
    expect(one).toContain("1 story");
    expect(one).not.toContain("1 stories");
  });

  test("offers the whole edition as one download", async () => {
    const main = mainOf(
      await renderPage(<EditionView date="2026-08-16" today="2026-08-16" stories={stories} />),
    );
    expect(main).toContain('href="/epub/edition/2026-08-16.epub"');
    expect(main).toContain("Download this edition (3 stories, EPUB)");
  });

  test("does not offer a download for an edition with nothing in it", async () => {
    const main = mainOf(
      await renderPage(<EditionView date="2026-08-16" today="2026-08-16" stories={[]} />),
    );
    expect(main).not.toContain("/epub/edition/");
  });

  test("ranks the rows by position, one-based", async () => {
    const main = mainOf(
      await renderPage(<EditionView date="2026-08-16" today="2026-08-16" stories={stories} />),
    );
    expect(main).toContain('<span class="rank">1</span>');
    expect(main).toContain('<span class="rank">2</span>');
    expect(main).toContain('<span class="rank">3</span>');
    expect(main).not.toContain('<span class="rank">0</span>');
  });

  test("makes the whole row one link to the story page", async () => {
    // An e-reader's touch layer is imprecise; the target is the entire block.
    const main = mainOf(
      await renderPage(<EditionView date="2026-08-16" today="2026-08-16" stories={stories} />),
    );
    expect(main).toContain('<a class="story-link" href="/story/1">');
    expect(main).toContain('<a class="story-link" href="/story/3">');
    expect(main.match(/class="story-link"/g)).toHaveLength(3);
  });

  test("prints the title and the meta line for each row", async () => {
    const main = mainOf(
      await renderPage(<EditionView date="2026-08-16" today="2026-08-16" stories={stories} />),
    );
    expect(main).toContain('<span class="story-title">First story</span>');
    expect(main).toContain(
      '<span class="story-meta">seangoedecke.com \u00b7 1 point \u00b7 1 comment</span>',
    );
    // The text post names Hacker News as its source instead of a domain.
    expect(main).toContain("Hacker News \u00b7 957 points \u00b7 208 comments");
  });

  test("escapes a hostile story title", async () => {
    const main = mainOf(
      await renderPage(
        <EditionView
          date="2026-08-16"
          today="2026-08-16"
          stories={[story({ title: '<img src=x onerror="alert(1)">' })]}
        />,
      ),
    );
    expect(main).not.toContain("<img");
    expect(main).toContain("&lt;img");
  });

  test("says so when an edition has no stories", async () => {
    const main = mainOf(
      await renderPage(<EditionView date="2026-08-16" today="2026-08-16" stories={[]} />),
    );
    expect(main).toContain("This edition has no stories yet.");
    expect(main).not.toContain("<ol");
    expect(main).toContain("0 stories");
  });
});

describe("EditionView - offline save list", () => {
  const stories = [story({ id: 11 }), story({ id: 22 }), story({ id: 33 })];

  test("carries a valid JSON array on the save button", async () => {
    const main = mainOf(
      await renderPage(<EditionView date="2026-08-16" today="2026-08-16" stories={stories} />),
    );
    const raw = attr(main, "data-save-edition");
    expect(raw).not.toBeNull();
    expect(() => JSON.parse(raw as string)).not.toThrow();
    expect(Array.isArray(JSON.parse(raw as string))).toBe(true);
  });

  test("is the archive URL plus one story page each, in order", async () => {
    const main = mainOf(
      await renderPage(<EditionView date="2026-08-16" today="2026-08-16" stories={stories} />),
    );
    const urls = JSON.parse(attr(main, "data-save-edition") as string) as string[];
    expect(urls).toEqual([
      "/archive/2026-08-16",
      "/story/11",
      "/story/22",
      "/story/33",
    ]);
  });

  test("every entry is a same-site path the worker can fetch", async () => {
    const main = mainOf(
      await renderPage(<EditionView date="2026-08-16" today="2026-08-16" stories={stories} />),
    );
    const urls = JSON.parse(attr(main, "data-save-edition") as string) as string[];
    for (const url of urls) {
      expect(url.startsWith("/")).toBe(true);
      expect(url.startsWith("//")).toBe(false);
    }
  });

  test("every story on the page is in the list", async () => {
    const main = mainOf(
      await renderPage(<EditionView date="2026-08-16" today="2026-08-16" stories={stories} />),
    );
    const urls = JSON.parse(attr(main, "data-save-edition") as string) as string[];
    for (const s of stories) expect(urls).toContain(`/story/${s.id}`);
    expect(urls).toHaveLength(stories.length + 1);
  });

  test("the controls start hidden, for the reader with no worker", async () => {
    const main = mainOf(
      await renderPage(<EditionView date="2026-08-16" today="2026-08-16" stories={stories} />),
    );
    expect(main).toContain("data-offline-ui");
    expect(main).toContain("hidden");
    expect(main).toContain("data-save-status");
  });

  test("still emits a well-formed list for an empty edition", async () => {
    const main = mainOf(
      await renderPage(<EditionView date="2026-08-16" today="2026-08-16" stories={[]} />),
    );
    expect(JSON.parse(attr(main, "data-save-edition") as string)).toEqual([
      "/archive/2026-08-16",
    ]);
  });
});

describe("ArchiveView", () => {
  const editions: EditionSummary[] = [
    { date: "2026-08-16", story_count: 30, built_at: T0 },
    { date: "2026-08-15", story_count: 30, built_at: T0 },
    { date: "2026-08-01", story_count: 1, built_at: null },
  ];

  test("lists one link per edition", async () => {
    const main = mainOf(await renderPage(<ArchiveView editions={editions} today="2026-08-16" />));
    expect(main).toContain('<a class="edition-link" href="/archive/2026-08-16">');
    expect(main).toContain('<a class="edition-link" href="/archive/2026-08-01">');
    expect(main.match(/class="edition-link"/g)).toHaveLength(3);
  });

  test("qualifies recent dates with a relative name", async () => {
    const main = mainOf(await renderPage(<ArchiveView editions={editions} today="2026-08-16" />));
    expect(main).toContain("Today \u00b7 16 Aug 2026");
    expect(main).toContain("Yesterday \u00b7 15 Aug 2026");
  });

  test("prints only the date once the relative name has expired", async () => {
    const main = mainOf(await renderPage(<ArchiveView editions={editions} today="2026-08-16" />));
    // No leading separator where relativeDay returned null.
    expect(main).toContain(">1 Aug 2026<");
    expect(main).not.toContain("\u00b7 1 Aug 2026");
  });

  test("counts the stories in each edition", async () => {
    const main = mainOf(await renderPage(<ArchiveView editions={editions} today="2026-08-16" />));
    expect(main).toContain('<span class="edition-count">30 stories</span>');
    expect(main).toContain('<span class="edition-count">1 story</span>');
  });

  test("says so when there are no editions", async () => {
    const main = mainOf(await renderPage(<ArchiveView editions={[]} today="2026-08-16" />));
    expect(main).toContain("No editions have been built yet.");
    expect(main).not.toContain("<ul class=\"editions\"");
  });
});

describe("StoryView", () => {
  const threads = [
    [comment({ id: 1 }), comment({ id: 2, depth: 1, root_id: 1 })],
    [comment({ id: 3, root_id: 3, author: "ingve" })],
  ];

  async function render(props: Partial<Parameters<typeof StoryView>[0]> = {}) {
    return mainOf(
      await renderPage(
        <StoryView
          story={story()}
          article={article()}
          threads={threads}
          indentMaxDepth={5}
          {...props}
        />,
      ),
    );
  }

  test("heads the page with the story title", async () => {
    expect(await render()).toContain('<h1 class="page-title">Good system design</h1>');
  });

  test("prints the byline when extraction produced one", async () => {
    expect(await render()).toContain(
      "Sean Goedecke \u00b7 seangoedecke.com \u00b7 2025-08-01",
    );
  });

  test("omits the byline entirely when there is nothing to say", async () => {
    const main = await render({ article: null });
    expect(main).not.toContain('class="page-sub"');
  });

  test("states score, comment count, reading time and submission time", async () => {
    const main = await render();
    // The comment count is the number actually rendered, not the HN figure,
    // because flagged and dead comments never reach the page.
    expect(main).toContain(
      '<p class="meta">957 points \u00b7 3 comments \u00b7 5 min read \u00b7 16 Aug 2025, 02:00</p>',
    );
  });

  test("omits the reading time when extraction produced too little text", async () => {
    const main = await render({ article: article({ word_count: 12 }) });
    expect(main).not.toContain("min read");
    expect(main).toContain("957 points");
  });

  test("offers the EPUB, the original and the discussion", async () => {
    const main = await render();
    expect(main).toContain('href="/epub/story/44921137.epub"');
    expect(main).toContain('href="https://seangoedecke.com/good-system-design/"');
    expect(main).toContain('href="https://news.ycombinator.com/item?id=44921137"');
  });

  test("omits the original link for a story with no URL", async () => {
    const main = await render({ story: story({ url: null, is_text_post: 1 }) });
    expect(main).not.toContain(">Original<");
    expect(main).toContain("Download EPUB");
    expect(main).toContain("Discussion");
  });

  test("inlines the article body as markup, not as escaped text", async () => {
    const main = await render();
    expect(main).toContain('<article class="article"><p>Systems should be boring.</p></article>');
  });

  test("inlines the failure stub when extraction failed", async () => {
    const main = await render({ article: article({ state: "failed", error_code: "http_404" }) });
    expect(main).toContain('<div class="stub">');
    expect(main).toContain("The page was not found.");
  });

  test("renders the comment threads", async () => {
    const main = await render();
    expect(main).toContain('<section class="thread" id="tA">');
    expect(main).toContain('<section class="thread" id="tB">');
    expect(main).toContain('id="c1"');
    expect(main).toContain('class="comment d1"');
    // Separated by a rule, not by a heading.
    expect(main).not.toContain("Thread A");
    expect(main).not.toContain("thread-head");
  });

  test("jumps to the discussion without scrolling the article", async () => {
    // A fragment link is the only navigation primitive that works with
    // scripting off on every reader, and an article can be twenty page turns.
    const main = await render();
    expect(main).toContain('href="#comments"');
    expect(main).toContain("Comments (3)");
    expect(main).toContain('<section class="comments" id="comments">');
  });

  test("labels the jump plainly when there are no comments to count", async () => {
    const main = await render({ threads: [] });
    expect(main).toContain('href="#comments"');
    expect(main).toContain(">Comments<");
  });

  test("offers a way back to the top from the foot of the discussion", async () => {
    const main = await render();
    expect(main).toContain('id="top"');
    expect(main).toContain('href="#top"');
    expect(main).toContain("Back to top");
    // The way back must be below the comments, not above them.
    expect(main.indexOf('href="#top"')).toBeGreaterThan(main.indexOf("Thread B"));
  });

  test("sizes both jumps as buttons, which carry the tap target", async () => {
    const main = await render();
    expect(main).toContain('class="btn jump" href="#comments"');
    expect(main).toContain('class="btn jump" href="#top"');
  });

  test("heads the comment section with the count, or a bare label when there is none", async () => {
    expect(await render()).toContain("<h2>3 comments</h2>");
    expect(await render({ threads: [] })).toContain("<h2>Comments</h2>");
  });

  test("stubs the comment section when there are no threads", async () => {
    const main = await render({ threads: [] });
    expect(main).toContain("No comments were available when this edition was built.");
  });

  test("escapes a hostile title in the heading", async () => {
    const main = await render({ story: story({ title: "<script>alert(1)</script>" }) });
    expect(main).not.toContain("<script>alert(1)</script>");
    expect(main).toContain("&lt;script&gt;");
  });
});

describe("OfflineView", () => {
  test("explains why the reader is looking at it", async () => {
    const main = mainOf(await renderPage(<OfflineView />));
    expect(main).toContain('<h1 class="page-title">Offline</h1>');
    expect(main).toContain("This page has not been saved to your device.");
    expect(main).toContain("Save for offline");
  });

  test("offers the two pages most likely to be cached", async () => {
    const main = mainOf(await renderPage(<OfflineView />));
    expect(main).toContain('href="/"');
    expect(main).toContain('href="/archive"');
  });
});

describe("NotFoundView", () => {
  test("renders through the shell with its message and a way out", async () => {
    const main = mainOf(
      await renderPage(<NotFoundView message="There is no edition for 2020-01-01." />),
    );
    expect(main).toContain('<h1 class="page-title">Not found</h1>');
    expect(main).toContain("There is no edition for 2020-01-01.");
    expect(main).toContain('href="/"');
    expect(main).toContain('href="/archive"');
  });

  test("escapes a hostile message", async () => {
    const main = mainOf(
      await renderPage(<NotFoundView message="<script>alert(1)</script>" />),
    );
    expect(main).not.toContain("<script>alert(1)</script>");
    expect(main).toContain("&lt;script&gt;");
  });
});
