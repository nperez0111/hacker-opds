/**
 * The website's static assets, held in memory and addressed by content hash.
 *
 * There is no public/ directory and no serverAssets binding. Every asset here
 * is generated from a TypeScript module, which means it bundles with the server
 * unconditionally and can be asserted on in tests without a filesystem or an
 * HTTP listener - the same argument that keeps the EPUB stylesheet in
 * src/epub/styles.ts.
 */
import { type AssetBody, FONT_ASSETS } from "~/web/fonts";
import { ICON_ASSETS } from "~/web/icons";
import { APP_JS, serviceWorkerJs, webManifest } from "~/web/sw";
import { SITE_CSS } from "~/web/styles";

export interface WebAsset {
  /**
   * Text for the generated assets, bytes for the fonts. The Uint8Array is
   * parameterised on ArrayBuffer because a bare Uint8Array is not assignable to
   * BodyInit, and the route hands this straight to a Response.
   */
  body: AssetBody;
  type: string;
  /** Quoted ETag, always. Cheap to compare and it is what the route sends. */
  etag: string;
  /**
   * True when the URL carries the content hash, so the bytes at that URL can
   * never change and the response may be cached permanently.
   */
  immutable: boolean;
}

function sha(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

/**
 * Cache-busting token. Eight hex characters is 32 bits: enough that an
 * accidental collision between two builds of the same file is not a thing that
 * happens, and short enough to stay readable in a URL.
 */
function token(value: string): string {
  return sha(value).slice(0, 8);
}

const CSS_TOKEN = token(SITE_CSS);
const APP_TOKEN = token(APP_JS);

/**
 * Precache list, and the reason it is exactly these four entries.
 *
 * install blocks on this, and a worker that fails to install is a worker that
 * never runs, so the list holds only what is needed to render *something*
 * useful with the network gone: the two assets every page links, the front
 * page, and the fallback shown for a page that was never visited. Story pages
 * arrive through runtime caching as they are read, or in bulk via the save
 * button.
 */
const PRECACHE = [
  "/",
  "/offline",
  `/assets/site.css?v=${CSS_TOKEN}`,
  `/assets/app.js?v=${APP_TOKEN}`,
];

/*
 * The worker's cache version has to change whenever *any* asset changes,
 * otherwise a stylesheet edit ships to a reader who is still being served the
 * old one out of the old cache. Hashing the worker generated with a fixed
 * placeholder version breaks what would otherwise be a circular definition:
 * the version depends on the source, which depends on the version.
 */
const SW_VERSION = token(
  SITE_CSS + APP_JS + serviceWorkerJs({ version: "0", precache: PRECACHE }),
);

const SW_JS = serviceWorkerJs({ version: SW_VERSION, precache: PRECACHE });

function asset(body: string, type: string, immutable: boolean): WebAsset {
  return { body, type, etag: `"${token(body)}"`, immutable };
}

const ASSETS: Record<string, WebAsset> = {
  /*
   * Fonts first so the generated entries below cannot be shadowed by a font
   * file that happens to be named site.css. They are content-hashed and
   * immutable like the rest, but deliberately absent from PRECACHE - see the
   * note on that list.
   */
  ...FONT_ASSETS,
  /*
   * The icon set: the SVG master, favicon.ico and the PNG rasters. Content
   * hashed and immutable like the fonts, and out of PRECACHE for the same
   * reason - see the note on `ICON_ASSETS`. `/favicon.ico` at the site root is
   * served by its own route, which reads the very same bytes out of here.
   */
  ...ICON_ASSETS,
  "site.css": asset(SITE_CSS, "text/css; charset=utf-8", true),
  "app.js": asset(APP_JS, "text/javascript; charset=utf-8", true),
  /*
   * The worker is the one asset that must NOT be immutable. Its URL is the
   * registration identity, so it cannot carry a hash; the browser detects an
   * update by refetching this exact URL and comparing bytes. Caching it hard
   * would freeze the site's client behaviour permanently.
   */
  "sw.js": asset(SW_JS, "text/javascript; charset=utf-8", false),
  "manifest.webmanifest": asset(
    webManifest(),
    "application/manifest+json; charset=utf-8",
    false,
  ),
};

export function getWebAsset(name: string): WebAsset | null {
  return Object.hasOwn(ASSETS, name) ? (ASSETS[name] as WebAsset) : null;
}

export function webAssetNames(): string[] {
  return Object.keys(ASSETS);
}

/** Hashed URL for the assets pages link to. */
export const CSS_URL = `/assets/site.css?v=${CSS_TOKEN}`;
export const APP_JS_URL = `/assets/app.js?v=${APP_TOKEN}`;
export const SW_URL = "/assets/sw.js";
export const MANIFEST_URL = "/assets/manifest.webmanifest";

/*
 * Icon URLs are re-exported rather than redefined, so a page and the manifest
 * cannot end up pointing at different builds of the same drawing. They are
 * declared in `~/web/icons` because `~/web/sw` needs them too and this module
 * imports that one.
 */
export {
  APPLE_TOUCH_ICON_URL,
  FAVICON_ICO_NAME,
  FAVICON_ICO_URL,
  FAVICON_PATH,
  ICON_SVG_URL,
} from "~/web/icons";

/** Exposed for tests, which assert the worker retires stale caches by name. */
export const SERVICE_WORKER_VERSION = SW_VERSION;
export const PRECACHE_URLS = PRECACHE;
