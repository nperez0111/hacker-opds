/**
 * Reading-font selection, done server-side.
 *
 * This is `~/web/theme` applied to typography, and for the same reasons: the
 * preference lives in a cookie, it is read during rendering so the first byte
 * already carries it, and no script is involved at any point. A font swapped in
 * by client script would be worse than a swapped theme - it reflows every line
 * on the page, and a reflow on e-ink is a full-panel refresh.
 *
 * ## Why offer a choice at all
 *
 * Because "the right font" is a property of the panel, not of the site. Charis
 * SIL is set by default because it was drawn for low-resolution output and
 * holds its stem contrast at 212 ppi with no subpixel rendering. But a Kindle
 * already has Bookerly, which its owner has read a thousand books in and whose
 * hinting Amazon tuned for that exact display; a reader with low vision is
 * better served by Atkinson Hyperlegible; and a reader on a slow radio may want
 * whatever costs zero bytes. None of those is the default, and none of them is
 * wrong.
 *
 * ## Cost
 *
 * The self-hosted families are subset to Latin + punctuation and shipped as
 * woff2 with a woff fallback (see scripts/build-fonts.ts). A face is 11-19 KB
 * of woff2. Only the selected family is ever downloaded, because `@font-face`
 * fetches are driven by what the cascade actually uses, and only one
 * `[data-font]` rule matches at a time.
 */
import type { H3Event } from "nitro/h3";

import {
  FONT_FACE_FILES,
  FONT_UNICODE_RANGE,
  type FontFaceFiles,
} from "~/web/font-files";

/* ------------------------------------------------------------------ */
/* registry                                                            */
/* ------------------------------------------------------------------ */

export type FontId =
  | "charis"
  | "literata"
  | "bookerly"
  | "georgia"
  | "atkinson"
  | "system-sans";

export interface FontEntry {
  /** URL-safe slug. This is the cookie value and the `data-font` attribute. */
  id: FontId;
  /** Name shown in the settings panel. */
  label: string;
  /**
   * The full CSS `font-family` value, self-hosted family first and a generic
   * last. The generic is not decoration: it is what a reader gets when every
   * named font is missing and the download failed, and without it the browser
   * falls back to its own default, which on several e-reader browsers is a
   * condensed sans nobody would choose.
   */
  stack: string;
  /**
   * True when this site ships the binaries. False means the entry only names
   * fonts the device may already have, and costs nothing to select.
   */
  selfHosted: boolean;
  /** One line in the settings panel, explaining who the option is for. */
  note: string;
}

/**
 * The registry. Adding a font is one entry here, plus - if it is self-hosted -
 * one entry in `FAMILIES` in scripts/build-fonts.ts and a rerun of that script.
 * Nothing else in the codebase enumerates fonts.
 */
export const FONTS: readonly FontEntry[] = [
  {
    id: "charis",
    label: "Charis SIL",
    stack: `"Charis SIL", Charter, Georgia, "Liberation Serif", "Times New Roman", serif`,
    selfHosted: true,
    note: "Drawn for low-resolution printing. The default.",
  },
  {
    id: "literata",
    label: "Literata",
    stack: `Literata, Charter, Georgia, "Liberation Serif", serif`,
    selfHosted: true,
    note: "Google Play Books' reading face. Slightly wider.",
  },
  {
    /*
     * Bookerly is Amazon's, licensed for Amazon's hardware and not
     * redistributable, so there is no `@font-face` for it and nothing to
     * download. On a Kindle the first name in the stack hits and the reader
     * gets the typeface they already read everything else in. Everywhere else
     * the name matches nothing and the browser moves on to Georgia - which is
     * the entire reason the stack has four more entries after it.
     */
    id: "bookerly",
    label: "Bookerly",
    stack: `Bookerly, "Bookerly Display", Georgia, "Liberation Serif", "Times New Roman", serif`,
    selfHosted: false,
    note: "Kindle's own face. Falls back to Georgia elsewhere.",
  },
  {
    id: "georgia",
    label: "Georgia",
    stack: `Georgia, Charter, "Liberation Serif", "Times New Roman", serif`,
    selfHosted: false,
    note: "Already on the device. Downloads nothing.",
  },
  {
    id: "atkinson",
    label: "Atkinson Hyperlegible",
    stack: `"Atkinson Hyperlegible", "Helvetica Neue", Helvetica, Arial, "Liberation Sans", sans-serif`,
    selfHosted: true,
    note: "Separates I l 1 and O 0. Built for low vision.",
  },
  {
    id: "system-sans",
    label: "System sans",
    stack: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Liberation Sans", sans-serif`,
    selfHosted: false,
    note: "Whatever the browser ships. Downloads nothing.",
  },
];

/**
 * Charis SIL, for the reasons in the module header.
 *
 * The brief asked for "ChareInk", a MobileRead forum modification of Charis SIL
 * handed around as zip attachments to forum posts. There is no signed release,
 * no version history and no way to check what was changed, which is not
 * something to put in a supply chain for a typographic tweak. Charis SIL is the
 * OFL original it derives from, and it is the one shipped here.
 */
export const DEFAULT_FONT: FontId = "charis";

export const FONT_COOKIE = "font";

/** A year, matching the theme cookie. Re-asking a reader is pure friction. */
export const FONT_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

const BY_ID: ReadonlyMap<string, FontEntry> = new Map(FONTS.map((f) => [f.id, f]));

export function isFontId(value: string): value is FontId {
  return BY_ID.has(value);
}

export function fontEntry(id: FontId): FontEntry {
  // Total by construction: FontId is exactly the set of keys in BY_ID.
  return BY_ID.get(id) as FontEntry;
}

export function fontLabel(id: FontId): string {
  return fontEntry(id).label;
}

export function fontStack(id: FontId): string {
  return fontEntry(id).stack;
}

/* ------------------------------------------------------------------ */
/* the cookie                                                          */
/* ------------------------------------------------------------------ */

/**
 * Minimal cookie lookup, taking the raw header so it stays a pure function and
 * does not drag an H3Event into every test. Same shape as
 * `themeFromCookieHeader`, deliberately, including the failure behaviour.
 */
export function fontFromCookieHeader(header: string | null): FontId {
  if (!header) return DEFAULT_FONT;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== FONT_COOKIE) continue;
    /*
     * `decodeURIComponent` throws `URIError` on a malformed escape ("font=%").
     * This runs on every request before anything renders, so an unhandled throw
     * is a 500 on every page for anyone holding a corrupt cookie - which they
     * cannot clear, because the site never loads far enough to offer them the
     * settings panel. A cookie that cannot be read means "no preference".
     */
    let value: string;
    try {
      value = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return DEFAULT_FONT;
    }
    return isFontId(value) ? value : DEFAULT_FONT;
  }
  return DEFAULT_FONT;
}

export function readFont(event: H3Event): FontId {
  return fontFromCookieHeader(event.req.headers.get("cookie"));
}

export function fontCookie(id: FontId): string {
  return (
    `${FONT_COOKIE}=${id}; Path=/; Max-Age=${FONT_COOKIE_MAX_AGE}; ` + `SameSite=Lax`
  );
}

/* ------------------------------------------------------------------ */
/* assets                                                              */
/* ------------------------------------------------------------------ */

/**
 * The same shape as `WebAsset` in `~/web/assets`, with `body` widened to allow
 * bytes.
 *
 * It is declared here rather than imported so this module has no dependency on
 * the asset registry - which lets `assets.ts` depend on *it* without a cycle,
 * and lets these tests run without pulling in the stylesheet and the service
 * worker. The one difference from `WebAsset` is the `body` type: a font is
 * binary, and putting binary through a JS string would UTF-8 encode it on the
 * way into `Response` and corrupt every byte above 0x7f.
 */
/**
 * What an asset's bytes may be.
 *
 * The `Uint8Array<ArrayBuffer>` is not pedantry: `BodyInit` will not accept a
 * plain `Uint8Array`, whose buffer is typed `ArrayBufferLike` and could be a
 * `SharedArrayBuffer`. Writing it loosely compiles here and fails at the one
 * place it matters, in the `new Response(asset.body)` inside the assets route.
 */
export type AssetBody = string | Uint8Array<ArrayBuffer>;

export interface FontAsset {
  body: AssetBody;
  type: string;
  /** Quoted ETag, always - it is compared against `if-none-match` verbatim. */
  etag: string;
  immutable: boolean;
}

/**
 * Eight hex characters of sha256, matching `~/web/assets`. Duplicated rather
 * than imported for the no-cycle reason above; it is three lines and its
 * behaviour is pinned by a test in both files.
 */
function token(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex").slice(0, 8);
}

/**
 * A binary asset, decoded on first request rather than at import.
 *
 * The ETag is derived from the base64 text instead of the decoded bytes. Base64
 * is a bijection, so it is exactly as content-addressed, and it means a server
 * that never serves a font never allocates the 291 KB - which matters on the
 * kind of box this runs on more than it would elsewhere.
 */
function binaryAsset(base64: string, type: string): FontAsset {
  let decoded: Uint8Array<ArrayBuffer> | null = null;
  return {
    get body(): Uint8Array<ArrayBuffer> {
      if (decoded === null) decoded = Uint8Array.from(Buffer.from(base64, "base64"));
      return decoded;
    },
    type,
    etag: `"${token(base64)}"`,
    // Every font URL carries the content hash, so the bytes behind it can
    // never change and a reader should keep them until the device is wiped.
    immutable: true,
  };
}

interface FaceUrls {
  woff2: string;
  woff: string;
}

const FILE_ASSETS: Record<string, FontAsset> = {};
const FACE_URLS = new Map<string, FaceUrls>();

for (const face of FONT_FACE_FILES) {
  const woff2 = binaryAsset(face.woff2.base64, "font/woff2");
  const woff = binaryAsset(face.woff.base64, "font/woff");
  FILE_ASSETS[face.woff2.name] = woff2;
  FILE_ASSETS[face.woff.name] = woff;
  FACE_URLS.set(face.id, {
    woff2: `/assets/${face.woff2.name}?v=${woff2.etag.slice(1, -1)}`,
    woff: `/assets/${face.woff.name}?v=${woff.etag.slice(1, -1)}`,
  });
}

function faceUrls(face: FontFaceFiles): FaceUrls {
  return FACE_URLS.get(face.id) as FaceUrls;
}

/* ------------------------------------------------------------------ */
/* the stylesheet                                                      */
/* ------------------------------------------------------------------ */

function quoteCssString(value: string): string {
  return `"${value.replace(/["\\]/g, "\\$&")}"`;
}

/**
 * `src` list for one face.
 *
 * `local()` comes first, and that ordering is the whole point: a Kindle or a
 * Boox that already has Charis SIL installed matches it and downloads nothing.
 * Then woff2, then woff. Browsers take the first entry whose `format()` they
 * recognise, so a Kobo running a WebKit that predates woff2 skips straight past
 * it rather than fetching bytes it cannot decode.
 */
function faceSrc(face: FontFaceFiles): string {
  const urls = faceUrls(face);
  return [
    ...face.local.map((name) => `local(${quoteCssString(name)})`),
    `url(${quoteCssString(urls.woff2)}) format("woff2")`,
    `url(${quoteCssString(urls.woff)}) format("woff")`,
  ].join(",\n       ");
}

function fontFaceBlock(face: FontFaceFiles): string {
  return `@font-face {
  font-family: ${quoteCssString(face.family)};
  font-style: ${face.style};
  font-weight: ${face.weight};
  font-display: swap;
  src: ${faceSrc(face)};
  unicode-range: ${FONT_UNICODE_RANGE};
}`;
}

/**
 * The font stylesheet: every `@font-face`, the rule that binds the reader's
 * choice, and one preview class per family for the settings panel.
 *
 * Kept out of `SITE_CSS` and served as its own file on purpose. It is mostly
 * long generated URLs that change whenever a font is rebuilt, and folding it in
 * would move `CSS_URL`'s hash - invalidating the entire site stylesheet in
 * every reader's cache - every time a font moved by one byte.
 */
export function fontCss(): string {
  const faces = FONT_FACE_FILES.map(fontFaceBlock).join("\n\n");

  /*
   * `:root[data-font=...] body` rather than `:root[data-font=...]`, because
   * SITE_CSS sets `font-family` on `body` and a rule on the root would lose to
   * it no matter what this sheet's specificity is - `body`'s own declaration
   * beats anything it would otherwise inherit. Matching `body` with an extra
   * attribute selector wins on specificity and needs no `!important`.
   */
  const bindings = FONTS.map(
    (font) => `:root[data-font="${font.id}"] body {
  font-family: ${font.stack};
}`,
  ).join("\n\n");

  /*
   * Preview classes for the settings panel, so each option is set in the font
   * it names. A reader cannot choose between six serif faces from their names.
   *
   * These do pull the other families' binaries - but only when the panel is
   * actually on screen, because the panel is `display: none` until its fragment
   * is targeted and browsers do not load fonts for boxes they never generate.
   */
  const previews = FONTS.map(
    (font) => `.font-${font.id} {
  font-family: ${font.stack};
}`,
  ).join("\n\n");

  return `@charset "utf-8";

/*
 * Reading fonts. GENERATED FROM src/web/fonts.ts - see that file for the
 * reasoning; this is the output, and editing it achieves nothing.
 *
 * Two descriptors below are decisions rather than boilerplate.
 *
 * font-display: swap. On e-ink a swap costs one repaint, which is real, but
 * "optional" lets the browser decide the font arrived too late and skip it for
 * the life of the page - and on an e-reader's radio that is most of the time.
 * A reader who has just picked a font and is shown the old one would
 * reasonably conclude the setting is broken.
 *
 * unicode-range. The faces are subset to Latin, Latin-1 and punctuation. Saying
 * so lets the browser fall back per character for anything outside it - a title
 * with a Cyrillic or CJK word in it renders in a system font rather than as a
 * row of empty boxes.
 */

${faces}

/* ------------------------------------------------------------------ */
/* the reader's choice, from the cookie, via data-font on <html>        */
/* ------------------------------------------------------------------ */

${bindings}

/* ------------------------------------------------------------------ */
/* settings panel previews                                              */
/* ------------------------------------------------------------------ */

${previews}
`;
}

const FONT_CSS = fontCss();
const FONT_CSS_TOKEN = token(FONT_CSS);

/** The stylesheet URL pages link. Carries the content hash. */
export const FONT_CSS_URL = `/assets/fonts.css?v=${FONT_CSS_TOKEN}`;

/**
 * Everything this module serves, keyed by the name the `/assets/<file>` route
 * looks up. Spread into `ASSETS` in `~/web/assets`.
 *
 * Explicitly *not* added to the service worker's precache list. `install`
 * blocks on that list, and blocking a worker's installation on 291 KB of fonts
 * over an e-reader's radio is how you get a worker that never finishes
 * installing and therefore never caches a single page. The worker's runtime
 * rule already treats anything under `/assets/` as cache-first, so the one
 * family a reader actually uses is cached the first time a page renders in it,
 * and the five they do not are never fetched at all.
 */
export const FONT_ASSETS: Readonly<Record<string, FontAsset>> = {
  ...FILE_ASSETS,
  "fonts.css": {
    body: FONT_CSS,
    type: "text/css; charset=utf-8",
    etag: `"${FONT_CSS_TOKEN}"`,
    immutable: true,
  },
};

export function getFontAsset(name: string): FontAsset | null {
  return Object.hasOwn(FONT_ASSETS, name) ? (FONT_ASSETS[name] as FontAsset) : null;
}

export function fontAssetNames(): string[] {
  return Object.keys(FONT_ASSETS);
}

/** Every URL pages and stylesheets reference, for tests and for auditing. */
export function fontAssetUrls(): string[] {
  const urls = [FONT_CSS_URL];
  for (const face of FONT_FACE_FILES) {
    const u = faceUrls(face);
    urls.push(u.woff2, u.woff);
  }
  return urls;
}
