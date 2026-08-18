/**
 * The page shell.
 *
 * Every route renders through this, so the invariants that make the site usable
 * on a reader live here rather than being restated per page: one stylesheet
 * link, one deferred script, a theme already resolved server-side, and a
 * navigation bar whose targets are big enough to hit.
 *
 * The split between `pageAttrs` and `Shell` is forced by mono-jsx, not chosen:
 * only a literal `<html>` element in the returned expression becomes a
 * `Response`. A component that returns `<html>` yields a plain node and the
 * status, headers and doctype are silently lost. So each route writes its own
 * `<html>` tag, spreads the attributes from `pageAttrs`, and puts everything
 * else inside `Shell`, which renders `<head>` and `<body>` as a fragment.
 */
import {
  APPLE_TOUCH_ICON_URL,
  APP_JS_URL,
  CSS_URL,
  FAVICON_ICO_URL,
  ICON_SVG_URL,
  MANIFEST_URL,
} from "~/web/assets";
import { FONT_CSS_URL, type FontId } from "~/web/fonts";
import { SETTINGS_ID, settingsPanelHtml } from "~/web/settings";
import type { Theme } from "~/web/theme";

/**
 * What a component may be handed as children.
 *
 * mono-jsx has a `ChildType` of its own but does not expose `types/jsx.d.ts`
 * through its exports map, and reaching past an exports map into a package's
 * internals is how a dependency bump turns into a build break. This is the
 * same shape, stated locally.
 */
type Renderable = JSX.Element | string | number | boolean | null | undefined;

export const SITE_NAME = "Hacker News Daily";

/**
 * Where the source lives.
 *
 * Declared here rather than inlined at the one call site because it is the
 * project's own identity, not a piece of footer markup: the same URL belongs in
 * anything that has to say who made this - a future `<link rel="author">`, an
 * OPDS publisher field, an about page. One constant now is cheaper than finding
 * three stale copies later.
 */
export const SOURCE_URL = "https://github.com/nperez0111/hacker-opds";

/**
 * Nav destinations.
 *
 * OPDS is listed alongside the HTML sections on purpose. The catalogue is the
 * reason this service exists, and a reader who arrives at the website on a
 * device with a reader app installed needs to be told the feed URL somewhere.
 *
 * Search sits third, between the two ways of browsing and the machine-readable
 * catalogue, because that is where it belongs in the order someone reaches for
 * them: today, then the archive, then find something in it.
 *
 * Five items - four here and Settings below - do not shrink the targets. The
 * bar is `display: flex` with `flex-wrap: wrap`, and a flex item's automatic
 * minimum size is its min-content width, so a one-word link cannot be
 * compressed below the width of its word: when the row runs out of space it
 * breaks to a second line and every target keeps its full width and its 48px
 * height. The cost of the fifth item is up to 48px of masthead on a narrow
 * panel, paid only when the words do not fit, which is a fair price for making
 * the archive searchable from every page.
 */
const NAV = [
  { href: "/", label: "Today" },
  { href: "/archive", label: "Archive" },
  { href: "/search", label: "Search" },
  { href: "/opds", label: "OPDS" },
] as const;

export interface PageAttrOptions {
  theme: Theme;
  font: FontId;
  /** HTTP status, for the error pages that render through the same shell. */
  status?: number;
  /** Cache-Control. Immutable pages set a long max-age; indexes must not. */
  cacheControl?: string;
}

/**
 * Attributes for the `<html>` element of a page. Spread, do not rebuild.
 *
 * `data-theme` is always emitted, including for "auto", because the stylesheet
 * keys its prefers-color-scheme block off `[data-theme="auto"]` specifically -
 * an absent attribute would leave a reader with no theme at all.
 */
export function pageAttrs(opts: PageAttrOptions) {
  const { theme, font, status, cacheControl } = opts;
  return {
    lang: "en",
    "data-theme": theme,
    "data-font": font,
    ...(status === undefined ? {} : { status }),
    ...(cacheControl === undefined ? {} : { headers: { "cache-control": cacheControl } }),
  };
}

/**
 * Where a page's content actually came from.
 *
 * This site republishes other people's writing. Every page that renders someone
 * else's article says so in its markup: `rel="canonical"` names the original as
 * the authoritative copy, and the Open Graph tags describe *that* work rather
 * than this rendering of it, so a link shared from here credits the source.
 *
 * Nothing here is speculative SEO. The site is noindex either way; this exists
 * so that a machine reading the page cannot mistake it for the origin.
 */
export interface PageMeta {
  /** The original article. Absent on index pages, which are our own. */
  canonical?: string;
  /** og:type. "article" for a story, left unset for a listing. */
  type?: string;
  /** Publication of origin - the article's site, not this one. */
  siteName?: string;
  /** ISO 8601. Feeds article:published_time. */
  published?: string;
  author?: string;
  /** The Hacker News thread, advertised as a related resource. */
  discussion?: string;
}

/**
 * A feed this particular page has, beyond the site-wide one.
 *
 * Only the edition pages have one, and it is advertised *after* `/rss` - see
 * the links in the head below.
 */
export interface PageFeed {
  href: string;
  title: string;
}

export interface ShellProps {
  /** Shown in the tab and prefixed onto the site name. */
  title: string;
  /** Resolved server-side from the cookie. Drives the settings panel. */
  theme: Theme;
  /** Resolved server-side from the cookie. Drives the settings panel. */
  font: FontId;
  /** Path of the page being rendered, for nav highlighting and setting returns. */
  path: string;
  /** Meta description. Omitted rather than faked when a page has nothing to say. */
  description?: string;
  /** Provenance. Omitted on pages that are not a rendering of someone else's work. */
  meta?: PageMeta;
  /** A page-specific feed, listed after the site feed. */
  feed?: PageFeed;
  children?: Renderable | Renderable[];
}

/** The site-wide RSS feed. Advertised on every page. */
export const RSS_HREF = "/rss";
export const RSS_TYPE = "application/rss+xml";

/**
 * True when `href` should be marked as the current section.
 *
 * Prefix matching for everything but the root, so an edition page still
 * highlights Archive. The root has to be exact or it would match every path.
 */
export function isCurrentSection(href: string, path: string): boolean {
  if (href === "/") return path === "/";
  return path === href || path.startsWith(`${href}/`);
}

export function Shell(props: ShellProps) {
  const { title, theme, font, path, description, meta, feed } = props;
  const fullTitle = title === SITE_NAME ? title : `${title} \u00b7 ${SITE_NAME}`;

  return (
    <>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{fullTitle}</title>
        {description ? <meta name="description" content={description} /> : null}
        {/*
         * This is a reading mirror, not a publisher. Crawlers are turned away
         * here as well as in robots.txt, because the two mechanisms fail in
         * different directions: robots.txt stops a polite crawler fetching the
         * page at all, while this tag stops one that fetched it anyway from
         * keeping it. noarchive and nosnippet matter more than noindex - they
         * are what stop a third party serving a cached copy of someone else's
         * article under their own brand.
         */}
        <meta
          name="robots"
          content="noindex, nofollow, noarchive, nosnippet, noimageindex, noai, noimageai"
        />
        {meta?.canonical ? <link rel="canonical" href={meta.canonical} /> : null}
        {/*
         * Open Graph describes the original work. og:url is the source article,
         * not this URL, so anything that unfurls a link to this page credits
         * and points at the publication that wrote it.
         */}
        <meta property="og:title" content={title} />
        <meta property="og:type" content={meta?.type ?? "website"} />
        {meta?.canonical ? <meta property="og:url" content={meta.canonical} /> : null}
        {description ? <meta property="og:description" content={description} /> : null}
        <meta property="og:site_name" content={meta?.siteName ?? SITE_NAME} />
        {meta?.published ? (
          <meta property="article:published_time" content={meta.published} />
        ) : null}
        {meta?.author ? <meta property="article:author" content={meta.author} /> : null}
        {meta?.discussion ? (
          <link rel="related" href={meta.discussion} title="Hacker News discussion" />
        ) : null}
        {/*
         * Named explicitly rather than left to the browser. An e-reader that
         * paints browser chrome around the page should match the page, and with
         * a server-resolved theme we already know which one it is.
         */}
        <meta name="color-scheme" content={theme === "auto" ? "light dark" : theme} />
        {/*
         * theme-color paints the browser's own chrome - Chrome's address bar on
         * Android, the status bar of an installed app - and until now the
         * manifest declared one and the pages did not, so a tab was framed in
         * whatever the browser felt like while the installed app was framed in
         * black. These are the page's actual background colours from
         * src/web/styles.ts, not the manifest's `theme_color`.
         *
         * Two media-scoped tags for "auto" rather than one unscoped tag,
         * because the resolution has to happen on the device: that is the whole
         * meaning of "auto", and a server that guessed would be wrong for
         * exactly the readers who asked not to be guessed at.
         */}
        {theme === "auto" ? (
          <>
            <meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff" />
            <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#000000" />
          </>
        ) : (
          <meta name="theme-color" content={theme === "dark" ? "#000000" : "#ffffff"} />
        )}
        {/*
         * Three icons for three kinds of consumer, in the order a browser
         * should prefer them. The SVG scales and inverts itself for dark
         * chrome; the ICO carries 16/32/48 rasters drawn for their pixel grid,
         * and is what anything predating SVG favicons takes; the
         * apple-touch-icon is iOS's, which reads no manifest and ignores alpha.
         *
         * The ICO is linked at its hashed URL so it can be cached forever. The
         * unhashed /favicon.ico exists as well, because browsers, feed readers
         * and link unfurlers request it at the site root regardless of what any
         * of this says - see server/routes/favicon.ico.ts.
         */}
        <link rel="icon" type="image/svg+xml" href={ICON_SVG_URL} />
        <link rel="icon" type="image/x-icon" sizes="16x16 32x32 48x48" href={FAVICON_ICO_URL} />
        <link rel="apple-touch-icon" sizes="180x180" href={APPLE_TOUCH_ICON_URL} />
        <link rel="stylesheet" href={CSS_URL} />
        {/*
         * Separate from the site stylesheet on purpose: this file is generated
         * from the font registry and its URL moves whenever a face is rebuilt.
         * Folding it into site.css would evict the entire stylesheet from every
         * reader's cache on any font change.
         */}
        <link rel="stylesheet" href={FONT_CSS_URL} />
        <link rel="manifest" href={MANIFEST_URL} />
        {/*
         * Advertises the catalogue to anything that autodiscovers feeds, and
         * documents the OPDS root for a human reading the source.
         */}
        <link
          rel="alternate"
          type="application/atom+xml;profile=opds-catalog;kind=navigation"
          href="/opds"
          title="OPDS catalogue"
        />
        {/*
         * The site feed comes first, and on an edition page that ordering is
         * the whole point. A dated feed is immutable - subscribing to one gets
         * you thirty articles and then silence forever - so a client that takes
         * only the first autodiscovered feed must find the live one. The dated
         * feed follows for anything that offers a choice.
         */}
        <link rel="alternate" type={RSS_TYPE} href={RSS_HREF} title={`${SITE_NAME} \u2014 latest stories`} />
        {feed ? (
          <link rel="alternate" type={RSS_TYPE} href={feed.href} title={feed.title} />
        ) : null}
      </head>
      <body>
        <a class="skip" href="#main">
          Skip to content
        </a>
        <div class="wrap">
          <header class="masthead">
            <div class="masthead-top">
              <p class="wordmark">
                <a href="/">{SITE_NAME}</a>
              </p>
            </div>
            <nav aria-label="Sections">
              {NAV.map((item) => (
                <a
                  href={item.href}
                  aria-current={isCurrentSection(item.href, path) ? "page" : undefined}
                >
                  {item.label}
                </a>
              ))}
              {/*
               * One entry rather than a separate theme toggle. Theme and
               * reading font are both reader preferences and both live in the
               * panel; a fifth nav item would shrink every target on a narrow
               * screen to buy a one-tap shortcut for half of them.
               *
               * A fragment link, so opening the panel costs no request and
               * works with scripting off.
               */}
              <a href={`#${SETTINGS_ID}`}>Settings</a>
            </nav>
          </header>

          <main id="main">{props.children}</main>

          <footer class="site-foot">
            <ul>
              <li>
                <a href="/opds">OPDS catalogue</a>
              </li>
              {/*
               * Spelled out for a human, because feed autodiscovery is a
               * browser feature that mostly no longer exists: the reader who
               * wants this URL has to be able to read it off the page and paste
               * it into an app on another device.
               */}
              <li>
                <a href={RSS_HREF}>RSS feed</a>
              </li>
              <li>
                <a href="/archive">Archive</a>
              </li>
              <li>
                <a href="https://news.ycombinator.com/">Hacker News</a>
              </li>
              {/*
               * Last, and deliberately not in the nav. The masthead is for
               * readers, who are here for the stories; the source link is for
               * the much smaller number of people who want to know how the
               * sausage is made, and the footer is where that convention has
               * put it for twenty years.
               */}
              <li>
                <a href={SOURCE_URL}>Source</a>
              </li>
            </ul>
          </footer>
        </div>
        {/*
         * Outside .wrap and last in the document, which is what makes the
         * no-CSS fallback work: with styles gone the panel is simply a settings
         * section at the foot of the page rather than an overlay stuck open
         * across the content.
         */}
        {html(settingsPanelHtml({ path, font, theme }))}
        {/*
         * Deferred and last. Nothing above depends on it: it registers the
         * service worker and reveals the offline controls, both of which are
         * additions to a page that has already rendered and already works.
         */}
        <script src={APP_JS_URL} defer></script>
      </body>
    </>
  );
}
