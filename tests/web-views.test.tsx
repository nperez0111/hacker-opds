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
import type { EditionSummary, StoryListRow } from "~/core/edition";
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
import { CACHE_MAX_AGE_DAYS } from "~/web/offline";
import type { EditionSaveSize } from "~/web/size";
import { SITE_NAME, SOURCE_URL, Shell, isCurrentSection, pageAttrs } from "~/web/layout";
import type { Preferences } from "~/web/settings";
import type { Theme } from "~/web/theme";
import {
  DEFAULT_LINE_SPACING,
  DEFAULT_TEXT_SIZE,
  type LineSpacing,
  type TextSize,
} from "~/web/type";
import {
  ArchiveView,
  EditionView,
  NotFoundView,
  OfflineView,
  StoryView,
} from "~/web/views";

const T0 = 1_755_302_400; // 2025-08-16T00:00:00Z

/*
 * Carries `word_count` because the list views take a `StoryListRow`, and the
 * default is a real article's length rather than null: a fixture that leaves it
 * out passes every assertion about a row while exercising none of the reading
 * time, which is how this stayed silently uncovered once already.
 */
function story(over: Partial<StoryListRow> = {}): StoryListRow {
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
    word_count: 1200,
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
 * A save estimate, since the button is required to state its cost.
 *
 * The numbers are a real edition's: 4,404,019 bytes stored, and that over the
 * 3.7 the estimator divides by for the wire. Written out rather than derived so
 * the two assertions that read them off the rendered page are checking the
 * formatting, not repeating the arithmetic.
 */
const SAVE: EditionSaveSize = {
  pages: 31,
  storageBytes: 4_404_019,
  wireBytes: 1_190_275,
};

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
    size?: TextSize;
    spacing?: LineSpacing;
    path?: string;
    title?: string;
    description?: string;
  } = {},
): Promise<string> {
  const prefs = preferences(opts);
  const path = opts.path ?? "/";
  return asResponse(
    <html {...pageAttrs({ prefs })}>
      <Shell
        title={opts.title ?? "Today"}
        prefs={prefs}
        path={path}
        description={opts.description}
      >
        {body}
      </Shell>
    </html>,
  ).text();
}

/** A full preference set, defaulted, so a test only names what it is about. */
function preferences(
  opts: {
    theme?: Theme;
    font?: FontId;
    size?: TextSize;
    spacing?: LineSpacing;
  } = {},
): Preferences {
  return {
    theme: opts.theme ?? "auto",
    font: opts.font ?? DEFAULT_FONT,
    size: opts.size ?? DEFAULT_TEXT_SIZE,
    spacing: opts.spacing ?? DEFAULT_LINE_SPACING,
  };
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
  test("emits lang and every preference as an attribute", () => {
    expect(pageAttrs({ prefs: preferences() })).toEqual({
      lang: "en",
      "data-theme": "auto",
      "data-font": DEFAULT_FONT,
      "data-size": DEFAULT_TEXT_SIZE,
      "data-spacing": DEFAULT_LINE_SPACING,
    });
  });

  test("emits every preference even at its default value", () => {
    /*
     * The stylesheet keys on the attribute, not on its absence: the
     * prefers-color-scheme block is written [data-theme="auto"] specifically,
     * and the size and spacing rules exist to override base rules that would
     * otherwise still apply. An omitted attribute is not "the default", it is
     * no rule at all.
     */
    const attrs = pageAttrs({ prefs: preferences() });
    expect(attrs["data-theme"]).toBe("auto");
    expect(attrs["data-size"]).toBe(DEFAULT_TEXT_SIZE);
    expect(attrs["data-spacing"]).toBe(DEFAULT_LINE_SPACING);
  });

  test("carries each preference through to its own attribute", () => {
    const attrs = pageAttrs({
      prefs: preferences({ theme: "dark", font: "atkinson", size: "xl", spacing: "tight" }),
    });
    expect(attrs["data-theme"]).toBe("dark");
    expect(attrs["data-font"]).toBe("atkinson");
    expect(attrs["data-size"]).toBe("xl");
    expect(attrs["data-spacing"]).toBe("tight");
  });

  test("omits status entirely when it is not given, rather than sending 200", () => {
    expect(pageAttrs({ prefs: preferences() })).not.toHaveProperty("status");
    expect(pageAttrs({ prefs: preferences(), status: 404 })).toHaveProperty("status", 404);
  });

  test("omits headers when no cache-control is given", () => {
    expect(pageAttrs({ prefs: preferences() })).not.toHaveProperty("headers");
    expect(
      pageAttrs({ prefs: preferences(), cacheControl: "no-cache" }),
    ).toMatchObject({
      headers: { "cache-control": "no-cache" },
    });
  });
});

describe("Shell - document", () => {
  test("renders a real Response, not an inert node", () => {
    const res = asResponse(
      <html
        {...pageAttrs({
          prefs: preferences({ theme: "dark" }),
          status: 404,
          cacheControl: "no-store",
        })}
      >
        <Shell title="No such story" prefs={preferences({ theme: "dark" })} path="/">
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
    // No article row behind it, which is the ordinary case for a text post.
    story({ id: 2, title: "Second story", domain: null, is_text_post: 1, word_count: null }),
    story({ id: 3, title: "Third story" }),
  ];

  test("heads the page with the relative day and the exact date under it", async () => {
    const main = mainOf(
      await renderPage(<EditionView date="2026-08-16" today="2026-08-16" stories={stories} save={SAVE} />),
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
          save={SAVE}
          subtitle="Monday, 10 August 2026"
        />,
      ),
    );
    expect(main).toContain('<p class="page-sub">Monday, 10 August 2026</p>');
  });

  test("counts the stories", async () => {
    const main = mainOf(
      await renderPage(<EditionView date="2026-08-16" today="2026-08-16" stories={stories} save={SAVE} />),
    );
    expect(main).toContain("3 stories");
    const one = mainOf(
      await renderPage(
        <EditionView
          date="2026-08-16"
          today="2026-08-16"
          stories={[stories[0] as StoryListRow]}
          save={SAVE}
        />,
      ),
    );
    expect(one).toContain("1 story");
    expect(one).not.toContain("1 stories");
  });

  test("offers the whole edition as one download", async () => {
    const main = mainOf(
      await renderPage(<EditionView date="2026-08-16" today="2026-08-16" stories={stories} save={SAVE} />),
    );
    expect(main).toContain('href="/epub/edition/2026-08-16.epub"');
    expect(main).toContain("Download this edition (3 stories, EPUB)");
  });

  test("does not offer a download for an edition with nothing in it", async () => {
    const main = mainOf(
      await renderPage(<EditionView date="2026-08-16" today="2026-08-16" stories={[]} save={SAVE} />),
    );
    expect(main).not.toContain("/epub/edition/");
  });

  test("ranks the rows by position, one-based", async () => {
    const main = mainOf(
      await renderPage(<EditionView date="2026-08-16" today="2026-08-16" stories={stories} save={SAVE} />),
    );
    expect(main).toContain('<span class="rank">1</span>');
    expect(main).toContain('<span class="rank">2</span>');
    expect(main).toContain('<span class="rank">3</span>');
    expect(main).not.toContain('<span class="rank">0</span>');
  });

  test("makes the whole row one link to the story page", async () => {
    // An e-reader's touch layer is imprecise; the target is the entire block.
    const main = mainOf(
      await renderPage(<EditionView date="2026-08-16" today="2026-08-16" stories={stories} save={SAVE} />),
    );
    expect(main).toContain('<a class="story-link" href="/story/1">');
    expect(main).toContain('<a class="story-link" href="/story/3">');
    expect(main.match(/class="story-link"/g)).toHaveLength(3);
  });

  test("prints the title and the meta line for each row", async () => {
    const main = mainOf(
      await renderPage(<EditionView date="2026-08-16" today="2026-08-16" stories={stories} save={SAVE} />),
    );
    expect(main).toContain('<span class="story-title">First story</span>');
    expect(main).toContain(
      '<span class="story-meta">seangoedecke.com \u00b7 1 point \u00b7 1 comment \u00b7 5 min</span>',
    );
    // The text post names Hacker News as its source instead of a domain, and
    // has no article behind it, so the line ends at the comment count.
    expect(main).toContain(
      '<span class="story-meta">Hacker News \u00b7 957 points \u00b7 208 comments</span>',
    );
  });

  test("says how long a row takes to read, but never says 'read' about it", async () => {
    const main = mainOf(
      await renderPage(<EditionView date="2026-08-16" today="2026-08-16" stories={stories} save={SAVE} />),
    );
    /*
     * The short spelling. On a 34rem meta line already carrying a domain, a
     * score and a comment count, "read" is the one word in it that no reader
     * needs, and it is what pushes the line onto a second row on a Kobo.
     */
    expect(main).toContain("1 comment \u00b7 5 min");
    expect(main).not.toContain("min read");
  });

  test("omits the reading time rather than claiming a minute for a failed extraction", async () => {
    const main = mainOf(
      await renderPage(
        <EditionView
          date="2026-08-16"
          today="2026-08-16"
          // 40 words is a paywall stub, not a forty-word article.
          stories={[story({ word_count: 40 }), story({ id: 9, word_count: null })]}
          save={SAVE}
        />,
      ),
    );
    expect(main).not.toContain("min");
    expect(main).toContain("957 points \u00b7 208 comments</span>");
  });

  test("escapes a hostile story title", async () => {
    const main = mainOf(
      await renderPage(
        <EditionView
          date="2026-08-16"
          today="2026-08-16"
          stories={[story({ title: '<img src=x onerror="alert(1)">' })]}
          save={SAVE}
        />,
      ),
    );
    expect(main).not.toContain("<img");
    expect(main).toContain("&lt;img");
  });

  test("says so when an edition has no stories", async () => {
    const main = mainOf(
      await renderPage(<EditionView date="2026-08-16" today="2026-08-16" stories={[]} save={SAVE} />),
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
      await renderPage(<EditionView date="2026-08-16" today="2026-08-16" stories={stories} save={SAVE} />),
    );
    const raw = attr(main, "data-save-edition");
    expect(raw).not.toBeNull();
    expect(() => JSON.parse(raw as string)).not.toThrow();
    expect(Array.isArray(JSON.parse(raw as string))).toBe(true);
  });

  test("is the archive URL plus one story page each, in order", async () => {
    const main = mainOf(
      await renderPage(<EditionView date="2026-08-16" today="2026-08-16" stories={stories} save={SAVE} />),
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
      await renderPage(<EditionView date="2026-08-16" today="2026-08-16" stories={stories} save={SAVE} />),
    );
    const urls = JSON.parse(attr(main, "data-save-edition") as string) as string[];
    for (const url of urls) {
      expect(url.startsWith("/")).toBe(true);
      expect(url.startsWith("//")).toBe(false);
    }
  });

  test("every story on the page is in the list", async () => {
    const main = mainOf(
      await renderPage(<EditionView date="2026-08-16" today="2026-08-16" stories={stories} save={SAVE} />),
    );
    const urls = JSON.parse(attr(main, "data-save-edition") as string) as string[];
    for (const s of stories) expect(urls).toContain(`/story/${s.id}`);
    expect(urls).toHaveLength(stories.length + 1);
  });

  test("the controls start hidden, for the reader with no worker", async () => {
    const main = mainOf(
      await renderPage(<EditionView date="2026-08-16" today="2026-08-16" stories={stories} save={SAVE} />),
    );
    expect(main).toContain("data-offline-ui");
    expect(main).toContain("hidden");
    expect(main).toContain("data-save-status");
  });

  test("still emits a well-formed list for an empty edition", async () => {
    const main = mainOf(
      await renderPage(<EditionView date="2026-08-16" today="2026-08-16" stories={[]} save={SAVE} />),
    );
    expect(JSON.parse(attr(main, "data-save-edition") as string)).toEqual([
      "/archive/2026-08-16",
    ]);
  });
});

describe("EditionView - what the save button costs", () => {
  const stories = [story({ id: 11 }), story({ id: 22 })];

  async function render(): Promise<string> {
    return mainOf(
      await renderPage(<EditionView date="2026-08-16" today="2026-08-16" stories={stories} save={SAVE} />),
    );
  }

  test("puts the download figure on the button itself", async () => {
    // The wire figure, not the storage one. Since brotli landed the two differ
    // by about 4x - the worker's fetch decodes transparently - and the question
    // the button is answering is "can I afford to press this right now".
    expect(await render()).toContain("Save the whole edition (up to 1.1 MB)");
  });

  test('says "up to", because the worker skips what is already here', async () => {
    // Pages opened while reading were cached as they were read, so the true
    // cost is this number or less and never more.
    expect(await render()).toContain("up to");
  });

  test("states the storage cost, which is the other question", async () => {
    expect(await render()).toContain("about 4.2 MB on the device");
  });

  test("says that opening a page already saves it", async () => {
    // The label used to be "Save for offline", which collided with the fact
    // that visited pages are saved automatically and made the button look like
    // the only way anything is kept.
    const main = await render();
    expect(main).toContain("Pages are saved as you open them");
    expect(main).not.toContain("Save for offline");
  });

  test("prints the legend for the marker, where a title attribute cannot reach", async () => {
    expect(await render()).toContain("\u2193 marks a story that is already saved");
  });

  test("names the retention period from the one place it is defined", async () => {
    expect(await render()).toContain(`kept for ${CACHE_MAX_AGE_DAYS} days`);
  });

  test("hides the note along with the button, for a reader with no worker", async () => {
    // Copy about a control that is not on the page is worse than no copy.
    const main = await render();
    expect(main).toContain('<p class="offline-note" data-offline-ui hidden>');
  });
});

describe("EditionView - the saved marker", () => {
  const stories = [story({ id: 11 }), story({ id: 22 })];

  async function render(): Promise<string> {
    return mainOf(
      await renderPage(<EditionView date="2026-08-16" today="2026-08-16" stories={stories} save={SAVE} />),
    );
  }

  test("ships one per row, hidden, naming the URL to look up", async () => {
    // Whether a page is on the device is knowable only from the Cache API, so
    // the marker cannot be server-rendered visible: on a first visit it would
    // be a claim about storage that is false for every row.
    const main = await render();
    expect(main).toContain('data-saved-mark="/story/11"');
    expect(main).toContain('data-saved-mark="/story/22"');
    expect(main.match(/data-saved-mark=/g)).toHaveLength(2);
    expect(main.match(/class="saved"[^>]*hidden/g)).toHaveLength(2);
  });

  test("carries an accessible name and a title, not a bare glyph", async () => {
    // A lone arrow means nothing to a screen reader, and nothing to a sighted
    // reader who has not seen the legend.
    const main = await render();
    expect(main).toContain('role="img"');
    expect(main).toContain('aria-label="Saved on this device"');
    expect(main).toContain('title="Saved on this device"');
  });

  test("sits inside the row's anchor, so it joins the link's name", async () => {
    const main = await render();
    const row = main.slice(main.indexOf('href="/story/11"'), main.indexOf("</a>"));
    expect(row).toContain('data-saved-mark="/story/11"');
  });

  test("comes after the title and meta, not inside them", async () => {
    // In the title it would re-wrap the headline when it appeared; as the
    // row's own column it lines up down the page and moves nothing.
    const main = await render();
    expect(main.indexOf('class="story-meta"')).toBeLessThan(
      main.indexOf('data-saved-mark="/story/11"'),
    );
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

  test("carries its own saved marker in the page header", async () => {
    // The repo owner asked for the glyph "next to it on the list item & in the
    // page header". Here there is room, so the words are printed rather than
    // hidden behind an accessible name - which is also where a reader finds
    // out what the arrow in the list meant.
    const main = await render();
    expect(main).toContain(
      `<p class="meta saved-line" data-saved-mark="/story/${story().id}" hidden>`,
    );
    expect(main).toContain("Saved on this device");
    expect(main).toContain('<span class="saved-glyph" aria-hidden="true">\u2193</span>');
  });

  test("puts the marker inside the header, above the buttons", async () => {
    const main = await render();
    const head = main.slice(main.indexOf("<header"), main.indexOf("</header>"));
    expect(head).toContain("data-saved-mark");
    expect(head.indexOf("data-saved-mark")).toBeLessThan(head.indexOf('class="actions"'));
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
    // Names the control by the label the edition page actually puts on it.
    expect(main).toContain("Save the whole edition");
    expect(main).toContain(`for ${CACHE_MAX_AGE_DAYS} days`);
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
