/**
 * The site's icon, as assets and as the URLs that reference them.
 *
 * The drawing itself is generated - see scripts/build-icon.ts for the design
 * and src/web/icon-files.ts for the payloads. This module is the thin layer
 * that turns those bytes into content-addressed assets, exactly as
 * `~/web/fonts` does for the webfont binaries, and for the same reason: there
 * is no public/ directory and never will be one (nitro.config.ts:38), so every
 * served byte comes from a TypeScript module.
 *
 * ## Why a separate module rather than lines in `~/web/assets`
 *
 * Two of this file's consumers must not import the asset registry.
 * `webManifest()` in `~/web/sw` needs the icon URLs, and `~/web/assets` imports
 * `~/web/sw` to build the worker - so an icon URL reached for through the
 * registry would be a cycle. Declaring the icons here, upstream of both, breaks
 * it the same way the font registry is broken out of the same knot.
 *
 * ## Why five images and not one
 *
 * A favicon is not a picture, it is a family, and the formats exist because the
 * consumers genuinely disagree:
 *
 *  - The SVG is what a modern browser puts in the tab, and the only variant
 *    that inverts itself for dark chrome.
 *  - The ICO carries 16, 32 and 48px rasters drawn with their pixel grid in
 *    mind. Browsers, feed readers and unfurlers ask for `/favicon.ico` at the
 *    site root whatever the HTML says, which is why there is a route for it.
 *  - The 180px PNG is iOS's, which ignores alpha and rounds corners itself.
 *  - The 192 and 512px PNGs are the manifest's, for a launcher icon.
 *  - The maskable 512 is Android's, which crops to a shape the launcher picks
 *    and guarantees only the middle 80% survives.
 */
import type { AssetBody } from "~/web/fonts";
import { FAVICON_ICO_BASE64, ICON_FILES, ICON_SVG } from "~/web/icon-files";

/**
 * The same shape as `WebAsset` in `~/web/assets`, restated rather than
 * imported for the no-cycle reason in the module header. `body` is widened to
 * bytes: a PNG put through a JS string would be UTF-8 encoded on the way into
 * `Response` and every byte above 0x7f would be corrupted.
 */
export interface IconAsset {
  body: AssetBody;
  type: string;
  /** Quoted ETag, always - the assets route compares `if-none-match` verbatim. */
  etag: string;
  immutable: boolean;
}

/** Eight hex characters of sha256, matching `~/web/assets` and `~/web/fonts`. */
function token(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex").slice(0, 8);
}

/**
 * A binary asset, decoded on first request rather than at import.
 *
 * The ETag comes from the base64 text rather than the decoded bytes. Base64 is
 * a bijection, so it is exactly as content-addressed, and a server that never
 * serves an icon never allocates the buffer - the same bargain `binaryAsset` in
 * `~/web/fonts` makes, for the same reason.
 */
function binaryAsset(base64: string, type: string): IconAsset {
  let decoded: Uint8Array<ArrayBuffer> | null = null;
  return {
    get body(): Uint8Array<ArrayBuffer> {
      if (decoded === null) decoded = Uint8Array.from(Buffer.from(base64, "base64"));
      return decoded;
    },
    type,
    etag: `"${token(base64)}"`,
    immutable: true,
  };
}

/* ------------------------------------------------------------------ */
/* the registry                                                        */
/* ------------------------------------------------------------------ */

/** Asset name for the ICO, which the root-level `/favicon.ico` route also serves. */
export const FAVICON_ICO_NAME = "favicon.ico";
export const ICON_SVG_NAME = "icon.svg";

/**
 * `image/x-icon` rather than the registered `image/vnd.microsoft.icon`.
 *
 * IANA blessed the latter in 2003 and essentially nothing sends it. The
 * unregistered type is what every browser has parsed since 1999 and what every
 * CDN, proxy and feed reader has a rule for, and an icon that fails to render
 * is worse than an icon served under a type a standards body dislikes.
 */
const ICO_TYPE = "image/x-icon";

const SVG_TOKEN = token(ICON_SVG);

const FILE_ASSETS: Record<string, IconAsset> = {
  [ICON_SVG_NAME]: {
    body: ICON_SVG,
    // The charset is not decoration on an SVG: it is XML, and a browser that
    // has to guess an encoding for markup is a browser that can guess wrong.
    type: "image/svg+xml; charset=utf-8",
    etag: `"${SVG_TOKEN}"`,
    immutable: true,
  },
  [FAVICON_ICO_NAME]: binaryAsset(FAVICON_ICO_BASE64, ICO_TYPE),
};

/** Hashed URL per icon name, so a rebuilt icon can never be served from cache. */
const URLS = new Map<string, string>();

function hashedUrl(name: string, asset: IconAsset): string {
  return `/assets/${name}?v=${asset.etag.slice(1, -1)}`;
}

for (const [name, asset] of Object.entries(FILE_ASSETS)) {
  URLS.set(name, hashedUrl(name, asset));
}

for (const file of ICON_FILES) {
  const asset = binaryAsset(file.base64, "image/png");
  FILE_ASSETS[file.name] = asset;
  URLS.set(file.name, hashedUrl(file.name, asset));
}

function urlFor(name: string): string {
  // Total by construction: every key of FILE_ASSETS was given a URL above.
  return URLS.get(name) as string;
}

/**
 * Everything this module serves, keyed by the name `/assets/<file>` looks up.
 * Spread into `ASSETS` in `~/web/assets`.
 *
 * Deliberately absent from the service worker's precache list, for the reason
 * given on `FONT_ASSETS`: `install` blocks on that list, and an icon is never
 * needed to render a page. A browser that cannot fetch one shows its own
 * default and nothing else changes. The worker's runtime rule already treats
 * everything under `/assets/` as cache-first, so the two or three a device
 * actually asks for are cached the first time it asks.
 */
export const ICON_ASSETS: Readonly<Record<string, IconAsset>> = FILE_ASSETS;

export function getIconAsset(name: string): IconAsset | null {
  return Object.hasOwn(ICON_ASSETS, name) ? (ICON_ASSETS[name] as IconAsset) : null;
}

/* ------------------------------------------------------------------ */
/* what the head and the manifest reference                            */
/* ------------------------------------------------------------------ */

export const ICON_SVG_URL = urlFor(ICON_SVG_NAME);
export const FAVICON_ICO_URL = urlFor(FAVICON_ICO_NAME);
export const APPLE_TOUCH_ICON_URL = urlFor("apple-touch-icon.png");

/**
 * The root-level path browsers request whether or not the HTML mentions it.
 *
 * Kept here beside the hashed URL so the route and the `<link>` cannot drift.
 */
export const FAVICON_PATH = "/favicon.ico";

export interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose: "any" | "maskable";
}

/**
 * The manifest's `icons` array.
 *
 * `any` and `maskable` are listed as separate entries rather than one entry
 * with `purpose: "any maskable"`. The combined form tells the launcher a single
 * image is safe to crop *and* correct uncropped, which is a lie about both of
 * these: the padded maskable variant looks lost in a context that does not
 * crop, and the tight one loses its serifs in a context that does.
 */
export function manifestIcons(): ManifestIcon[] {
  return ICON_FILES.filter((file) => file.name !== "apple-touch-icon.png").map((file) => ({
    src: urlFor(file.name),
    sizes: `${file.size}x${file.size}`,
    type: "image/png",
    purpose: file.purpose,
  }));
}

/** Every icon URL the site references, for tests and for auditing. */
export function iconUrls(): string[] {
  return [...URLS.values()];
}
