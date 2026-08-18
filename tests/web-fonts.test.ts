/**
 * The reading-font system: registry, cookie, generated stylesheet, asset
 * registry, the `/settings` route and the settings panel's markup.
 *
 * Three of these groups describe properties that are invisible in development
 * and permanent for a reader once they go wrong:
 *
 *  - `fontFromCookieHeader` runs on every request before anything renders, so a
 *    header it cannot survive is a site-wide outage triggered by a value the
 *    reader cannot clear without developer tools.
 *  - `/settings` writes a header from a query parameter. That is an open
 *    redirect unless every off-origin spelling is rejected, and a CRLF in the
 *    target is a 500 rather than a redirect.
 *  - The generated CSS is the only thing that makes a 291 KB font download
 *    conditional. A missing `local()` makes a device that already has the font
 *    fetch it anyway; a missing `woff` fallback makes an old Kobo render in a
 *    system font with no way to tell.
 *
 * Nothing here touches the network - the font binaries were baked into
 * `src/web/font-files.ts` by `scripts/build-fonts.ts` at author time - and
 * `expectNoFetch` makes that a failure rather than an assumption.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mockEvent, type H3Event } from "nitro/h3";

import { PRECACHE_URLS } from "~/web/assets";
import { FONT_FACE_FILES, FONT_LICENSES } from "~/web/font-files";
import {
  DEFAULT_FONT,
  FONTS,
  FONT_ASSETS,
  FONT_COOKIE,
  FONT_COOKIE_MAX_AGE,
  FONT_CSS_URL,
  fontAssetNames,
  fontAssetUrls,
  fontCookie,
  fontCss,
  fontFromCookieHeader,
  fontLabel,
  fontStack,
  getFontAsset,
  isFontId,
  readFont,
  type FontId,
} from "~/web/fonts";
import { SETTINGS_CSS, SETTINGS_ID, settingsPanelHtml } from "~/web/settings";
import { THEME_COOKIE, type Theme } from "~/web/theme";
import {
  DEFAULT_LINE_SPACING,
  DEFAULT_TEXT_SIZE,
  LINE_SPACINGS,
  TEXT_SIZES,
  type LineSpacing,
  type TextSize,
} from "~/web/type";

import settingsRoute from "../server/routes/settings";

/**
 * Both stylesheets are heavily commented, and the comments discuss the very
 * declarations these tests grep for - the note above `.settings:not(:target)`
 * names the `.settings:target` rule it exists instead of. Assertions about what
 * the CSS *does* therefore have to run against the declarations only.
 */
function rules(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The stylesheet as served. */
const CSS = fontCss();
/** The same sheet with its prose removed, for "what does this rule do" checks. */
const CSS_RULES = rules(CSS);
const PANEL_RULES = rules(SETTINGS_CSS);

/** Every id in the registry, as strings, for the loops below. */
const IDS = FONTS.map((f) => f.id);

/** The faces this site actually ships bytes for. */
const SELF_HOSTED = FONTS.filter((f) => f.selfHosted).map((f) => f.id);

/**
 * A fetch that fails the test if anything calls it.
 *
 * The font pipeline is a build-time script. If any of this ever reaches for the
 * network at runtime it becomes a page that hangs on a device with no radio,
 * which is the one device this site exists for.
 */
let savedFetch: typeof globalThis.fetch;

beforeAll(() => {
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    throw new Error(`the font system made a network request: ${String(input)}`);
  }) as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = savedFetch;
});

function event(path: string, opts: { cookie?: string } = {}): H3Event {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  return mockEvent(`http://localhost${path}`, { headers });
}

async function call(path: string): Promise<Response> {
  const result = await settingsRoute(event(path));
  if (!(result instanceof Response)) {
    throw new Error(`expected a Response, got ${typeof result}`);
  }
  return result;
}

function setCookies(res: Response): string[] {
  return res.headers.getSetCookie();
}

/* ------------------------------------------------------------------ */

describe("isFontId", () => {
  test("accepts exactly the registry's ids", () => {
    for (const id of IDS) expect(isFontId(id)).toBe(true);
    expect(IDS).toEqual([
      "charis",
      "literata",
      "bookerly",
      "georgia",
      "atkinson",
      "system-sans",
    ]);
  });

  test("rejects anything else, including near misses", () => {
    expect(isFontId("Charis")).toBe(false);
    expect(isFontId("charissil")).toBe(false);
    expect(isFontId("chareink")).toBe(false);
    expect(isFontId("")).toBe(false);
    expect(isFontId("null")).toBe(false);
    expect(isFontId("serif")).toBe(false);
  });

  test("rejects inherited Object properties", () => {
    // A plain object lookup would answer true for these and hand the caller a
    // function where a registry entry is expected.
    expect(isFontId("constructor")).toBe(false);
    expect(isFontId("toString")).toBe(false);
    expect(isFontId("__proto__")).toBe(false);
    expect(isFontId("hasOwnProperty")).toBe(false);
  });
});

describe("the registry", () => {
  test("the default is Charis SIL and it is a real entry", () => {
    expect(DEFAULT_FONT).toBe("charis");
    expect(isFontId(DEFAULT_FONT)).toBe(true);
    expect(fontLabel(DEFAULT_FONT)).toBe("Charis SIL");
  });

  test("ids are unique and URL-safe", () => {
    // They go in a query string, a cookie value and an attribute selector
    // without escaping at any of the three.
    expect(new Set(IDS).size).toBe(IDS.length);
    for (const id of IDS) expect(id).toMatch(/^[a-z0-9-]+$/);
  });

  test("every entry has a label and a note", () => {
    for (const font of FONTS) {
      expect(font.label.length).toBeGreaterThan(0);
      expect(font.note.length).toBeGreaterThan(0);
    }
  });

  /**
   * The generic is not decoration. It is what a reader gets when every named
   * font is missing and the download failed, and without it the browser falls
   * back to its own default - which on several e-reader browsers is a condensed
   * sans nobody would have chosen.
   */
  test("every stack ends in a generic family", () => {
    for (const font of FONTS) {
      const last = (fontStack(font.id).split(",").pop() as string).trim();
      expect(["serif", "sans-serif"]).toContain(last);
    }
  });

  test("a stack never ends in a quoted name", () => {
    for (const font of FONTS) {
      expect(fontStack(font.id).trimEnd().endsWith('"')).toBe(false);
    }
  });

  test("Bookerly is not self-hosted and falls through to something universal", () => {
    // Amazon's font, licensed for Amazon's hardware. Selecting it must ship
    // nothing and must still produce readable text on a Kobo.
    const bookerly = FONTS.find((f) => f.id === "bookerly");
    expect(bookerly?.selfHosted).toBe(false);
    expect(bookerly?.stack).toContain("Bookerly");
    expect(bookerly?.stack).toContain("Georgia");
    expect(FONT_FACE_FILES.some((f) => f.fontId === "bookerly")).toBe(false);
  });

  test("the zero-download options ship no faces", () => {
    for (const font of FONTS.filter((f) => !f.selfHosted)) {
      expect(FONT_FACE_FILES.some((f) => f.fontId === font.id)).toBe(false);
    }
  });

  test("every self-hosted entry ships at least a regular and a bold face", () => {
    for (const id of SELF_HOSTED) {
      const weights = FONT_FACE_FILES.filter((f) => f.fontId === id).map((f) => f.weight);
      expect(weights).toContain(400);
      expect(weights).toContain(700);
    }
  });

  test("every shipped face belongs to a registry entry", () => {
    for (const face of FONT_FACE_FILES) {
      expect(IDS).toContain(face.fontId as FontId);
    }
  });

  test("every self-hosted family names its own face first in the stack", () => {
    for (const id of SELF_HOSTED) {
      const face = FONT_FACE_FILES.find((f) => f.fontId === id);
      const first = (fontStack(id as FontId).split(",")[0] as string).trim().replace(/"/g, "");
      expect(first).toBe(face?.family);
    }
  });
});

describe("licensing", () => {
  test("every shipped family records a licence, a copyright and a source", () => {
    for (const id of SELF_HOSTED) {
      const licence = FONT_LICENSES.find((l) => l.fontId === id);
      expect(licence).toBeDefined();
      expect(licence!.license).toBe("OFL-1.1");
      expect(licence!.copyright).toContain("Copyright");
      expect(licence!.source).toStartWith("https://");
      expect(licence!.bytes).toBeGreaterThan(0);
    }
  });

  test("nothing is shipped that is not covered by a licence record", () => {
    const covered = new Set(FONT_LICENSES.map((l) => l.fontId));
    for (const face of FONT_FACE_FILES) expect(covered.has(face.fontId)).toBe(true);
  });

  /**
   * The size budget, as a test rather than a comment. These are downloaded over
   * an e-reader's radio; a family that quietly doubles because someone widened
   * the unicode range should fail here, not in the field.
   */
  test("no family exceeds 400 KB across all its faces and both formats", () => {
    for (const licence of FONT_LICENSES) {
      expect(licence.bytes).toBeLessThan(400 * 1024);
    }
  });

  test("no single face exceeds 32 KB in either format", () => {
    for (const face of FONT_FACE_FILES) {
      expect(face.woff2.bytes).toBeLessThan(32 * 1024);
      expect(face.woff.bytes).toBeLessThan(32 * 1024);
    }
  });
});

describe("fontFromCookieHeader", () => {
  test("defaults when there is no cookie header at all", () => {
    expect(fontFromCookieHeader(null)).toBe(DEFAULT_FONT);
    expect(fontFromCookieHeader("")).toBe(DEFAULT_FONT);
  });

  test("reads the font cookie", () => {
    expect(fontFromCookieHeader("font=literata")).toBe("literata");
    expect(fontFromCookieHeader("font=atkinson")).toBe("atkinson");
    expect(fontFromCookieHeader("font=system-sans")).toBe("system-sans");
  });

  test("finds the font among other cookies, in any position", () => {
    expect(fontFromCookieHeader("theme=dark; font=georgia; sid=abc")).toBe("georgia");
    expect(fontFromCookieHeader("font=georgia; theme=dark")).toBe("georgia");
    expect(fontFromCookieHeader("sid=abc; font=georgia")).toBe("georgia");
  });

  test("tolerates the whitespace real clients send around separators", () => {
    expect(fontFromCookieHeader("  font=georgia  ")).toBe("georgia");
    expect(fontFromCookieHeader("sid=abc;font=georgia")).toBe("georgia");
    expect(fontFromCookieHeader("sid=abc;   font=georgia")).toBe("georgia");
  });

  test("does not match a cookie whose name merely contains 'font'", () => {
    // A prefix match here would let an unrelated cookie drive the typeface.
    expect(fontFromCookieHeader("fontsize=big")).toBe(DEFAULT_FONT);
    expect(fontFromCookieHeader("myfont=georgia")).toBe(DEFAULT_FONT);
    expect(fontFromCookieHeader("font_pref=georgia")).toBe(DEFAULT_FONT);
  });

  test("falls back to the default for an unknown value", () => {
    expect(fontFromCookieHeader("font=comic-sans")).toBe(DEFAULT_FONT);
    expect(fontFromCookieHeader("font=GEORGIA")).toBe(DEFAULT_FONT);
    expect(fontFromCookieHeader("font=")).toBe(DEFAULT_FONT);
    expect(fontFromCookieHeader("font=__proto__")).toBe(DEFAULT_FONT);
  });

  test("skips valueless segments rather than mis-parsing them", () => {
    expect(fontFromCookieHeader("flag; font=georgia")).toBe("georgia");
    expect(fontFromCookieHeader("font")).toBe(DEFAULT_FONT);
    expect(fontFromCookieHeader(";;;")).toBe(DEFAULT_FONT);
  });

  test("decodes a percent-encoded value", () => {
    expect(fontFromCookieHeader("font=%67eorgia")).toBe("georgia");
  });

  /**
   * `decodeURIComponent` throws `URIError` on a malformed escape. This runs
   * before any page renders, so an unhandled throw would be a 500 on every
   * request for anyone holding a corrupt cookie.
   */
  test("survives a malformed percent escape instead of throwing", () => {
    expect(() => fontFromCookieHeader("font=%")).not.toThrow();
    expect(fontFromCookieHeader("font=%")).toBe(DEFAULT_FONT);
    expect(fontFromCookieHeader("font=%E0%A4%A")).toBe(DEFAULT_FONT);
    expect(fontFromCookieHeader("font=%zz")).toBe(DEFAULT_FONT);
    // And a broken cookie must not shadow a good one that follows it.
    expect(fontFromCookieHeader("other=%; font=georgia")).toBe("georgia");
  });
});

describe("readFont", () => {
  test("reads the cookie off the request", () => {
    expect(readFont(event("/", { cookie: "font=atkinson" }))).toBe("atkinson");
    expect(readFont(event("/"))).toBe(DEFAULT_FONT);
  });
});

describe("fontCookie", () => {
  test("emits a site-wide, year-long, lax cookie", () => {
    expect(fontCookie("georgia")).toBe(
      `${FONT_COOKIE}=georgia; Path=/; Max-Age=${FONT_COOKIE_MAX_AGE}; SameSite=Lax`,
    );
  });

  test("round-trips through the parser for every registered font", () => {
    for (const id of IDS) {
      const header = fontCookie(id).split(";")[0] as string;
      expect(fontFromCookieHeader(header)).toBe(id);
    }
  });

  test("Max-Age is a year, so the preference outlives a session", () => {
    expect(FONT_COOKIE_MAX_AGE).toBe(31_536_000);
  });

  test("uses a different cookie name from the theme", () => {
    expect(FONT_COOKIE).not.toBe(THEME_COOKIE);
  });
});

describe("fontCss", () => {
  test("is deterministic", () => {
    // The asset URLs embed content hashes; a non-deterministic sheet would
    // change its own hash on every boot and defeat the cache entirely.
    expect(fontCss()).toBe(CSS);
  });

  test("declares one @font-face per shipped face and no more", () => {
    const blocks = CSS_RULES.match(/@font-face\s*\{/g) ?? [];
    expect(blocks.length).toBe(FONT_FACE_FILES.length);
    expect(blocks.length).toBe(8);
  });

  test("each face block names its family, weight and style", () => {
    for (const face of FONT_FACE_FILES) {
      const block = CSS_RULES.split("@font-face").find(
        (b) => b.includes(face.woff2.name) && b.includes(face.woff.name),
      );
      expect(block).toBeDefined();
      expect(block!).toContain(`font-family: "${face.family}"`);
      expect(block!).toContain(`font-weight: ${face.weight}`);
      expect(block!).toContain(`font-style: ${face.style}`);
    }
  });

  /**
   * The point of `local()`: a Kindle or a Boox with the family already
   * installed matches it and downloads nothing. If it ever stops coming first,
   * every such device silently pays for a font it already has.
   */
  test("every src list starts with local() before any url()", () => {
    const srcs = CSS_RULES.match(/src:[^;]+;/g) ?? [];
    expect(srcs.length).toBe(FONT_FACE_FILES.length);
    for (const src of srcs) {
      expect(src.indexOf("local(")).toBeGreaterThan(-1);
      expect(src.indexOf("local(")).toBeLessThan(src.indexOf("url("));
    }
  });

  test("every face offers woff2 before woff, with format hints on both", () => {
    // Old Kobo and Kindle browsers predate woff2. Browsers take the first
    // format() they recognise, so the order is what makes the fallback work.
    for (const src of CSS_RULES.match(/src:[^;]+;/g) ?? []) {
      expect(src).toContain('format("woff2")');
      expect(src).toContain('format("woff")');
      expect(src.indexOf('format("woff2")')).toBeLessThan(
        src.lastIndexOf('format("woff")'),
      );
    }
  });

  test("every face's local() names are the ones the font answers to", () => {
    for (const face of FONT_FACE_FILES) {
      expect(face.local.length).toBeGreaterThan(0);
      for (const name of face.local) expect(CSS_RULES).toContain(`local("${name}")`);
    }
  });

  /**
   * Regression: instancing a variable font prunes its name table down to the
   * default instance's names, so Literata's bold face called itself "Literata
   * Regular". A `local("Literata Regular")` in the 700 face would make every
   * device with Literata installed render bold text in the regular weight.
   */
  test("a bold face never claims a regular local() name", () => {
    for (const face of FONT_FACE_FILES.filter((f) => f.weight >= 700)) {
      for (const name of face.local) expect(name).not.toContain("Regular");
    }
  });

  test("declares font-display: swap on every face", () => {
    expect((CSS_RULES.match(/font-display: swap/g) ?? []).length).toBe(FONT_FACE_FILES.length);
  });

  test("declares a unicode-range matching the subset actually shipped", () => {
    expect((CSS_RULES.match(/unicode-range:/g) ?? []).length).toBe(FONT_FACE_FILES.length);
    // Latin-1 and General Punctuation are what the subsetter was given.
    expect(CSS_RULES).toContain("U+0000-00FF");
    expect(CSS_RULES).toContain("U+2000-206F");
  });

  test("binds each font to a data-font value on the root element", () => {
    for (const font of FONTS) {
      expect(CSS_RULES).toContain(`:root[data-font="${font.id}"] body {`);
      expect(CSS_RULES).toContain(font.stack);
    }
  });

  test("the binding targets body, so it outranks the site stylesheet", () => {
    // SITE_CSS sets font-family on `body`. A rule on `:root` alone would lose
    // to it regardless of specificity, because body's own declaration beats
    // anything it would otherwise inherit.
    expect(CSS_RULES).not.toContain(`:root[data-font="charis"] {`);
    expect(CSS_RULES).toContain(`:root[data-font="charis"] body {`);
  });

  test("emits a preview class per font for the settings panel", () => {
    for (const font of FONTS) expect(CSS_RULES).toContain(`.font-${font.id} {`);
  });

  test("never references a URL that is not a registered asset", () => {
    const urls = CSS_RULES.match(/url\("([^"]+)"\)/g) ?? [];
    expect(urls.length).toBe(FONT_FACE_FILES.length * 2);
    for (const raw of urls) {
      const url = raw.slice(5, -2);
      const name = url.slice("/assets/".length).split("?")[0] as string;
      expect(getFontAsset(name)).not.toBeNull();
    }
  });

  test("has no unbalanced braces", () => {
    expect((CSS_RULES.match(/\{/g) ?? []).length).toBe((CSS_RULES.match(/\}/g) ?? []).length);
  });
});

describe("the font asset registry", () => {
  test("holds two files per face plus the stylesheet", () => {
    expect(fontAssetNames().length).toBe(FONT_FACE_FILES.length * 2 + 1);
    expect(fontAssetNames()).toContain("fonts.css");
  });

  test("every registered name resolves", () => {
    for (const name of fontAssetNames()) {
      const asset = getFontAsset(name);
      expect(asset).not.toBeNull();
      expect(asset!.body.length).toBeGreaterThan(0);
      expect(asset!.etag).toMatch(/^"[0-9a-f]{8}"$/);
    }
  });

  test("returns null for a name that does not exist", () => {
    expect(getFontAsset("nope.woff2")).toBeNull();
    expect(getFontAsset("")).toBeNull();
    expect(getFontAsset("../font-files.ts")).toBeNull();
  });

  test("returns null for inherited Object properties", () => {
    expect(getFontAsset("constructor")).toBeNull();
    expect(getFontAsset("toString")).toBeNull();
    expect(getFontAsset("__proto__")).toBeNull();
  });

  test("declares the right content type for each file", () => {
    for (const name of fontAssetNames()) {
      const type = getFontAsset(name)!.type;
      if (name.endsWith(".woff2")) expect(type).toBe("font/woff2");
      else if (name.endsWith(".woff")) expect(type).toBe("font/woff");
      else expect(type).toBe("text/css; charset=utf-8");
    }
  });

  test("serves binaries as bytes, not as a string", () => {
    // A font pushed through a JS string would be UTF-8 encoded on the way into
    // Response and every byte above 0x7f would be corrupted.
    const asset = getFontAsset("charis-400.woff2")!;
    expect(asset.body).toBeInstanceOf(Uint8Array);
    expect(typeof asset.body).not.toBe("string");
  });

  test("the decoded bytes are real woff2 and woff files", () => {
    const magic = (name: string) =>
      new TextDecoder().decode((getFontAsset(name)!.body as Uint8Array).slice(0, 4));
    for (const face of FONT_FACE_FILES) {
      expect(magic(face.woff2.name)).toBe("wOF2");
      expect(magic(face.woff.name)).toBe("wOFF");
    }
  });

  test("the decoded length matches the recorded byte count", () => {
    for (const face of FONT_FACE_FILES) {
      expect(getFontAsset(face.woff2.name)!.body.length).toBe(face.woff2.bytes);
      expect(getFontAsset(face.woff.name)!.body.length).toBe(face.woff.bytes);
    }
  });

  test("decoding is memoised, so the same buffer comes back every time", () => {
    const a = getFontAsset("atkinson-400.woff")!;
    expect(a.body).toBe(a.body);
  });

  test("etags are stable across calls", () => {
    for (const name of fontAssetNames()) {
      expect(getFontAsset(name)!.etag).toBe(getFontAsset(name)!.etag);
    }
  });

  test("etags differ between assets, so one cannot be revalidated as another", () => {
    const etags = fontAssetNames().map((n) => getFontAsset(n)!.etag);
    expect(new Set(etags).size).toBe(etags.length);
  });

  test("etags are quoted, which is what the route compares against", () => {
    for (const name of fontAssetNames()) {
      const etag = getFontAsset(name)!.etag;
      expect(etag.startsWith('"')).toBe(true);
      expect(etag.endsWith('"')).toBe(true);
    }
  });

  test("every asset is immutable, because every URL carries its hash", () => {
    for (const name of fontAssetNames()) {
      expect(getFontAsset(name)!.immutable).toBe(true);
    }
  });

  test("every URL resolves back to a real asset and carries an eight-hex token", () => {
    const urls = fontAssetUrls();
    expect(urls.length).toBe(FONT_FACE_FILES.length * 2 + 1);
    for (const url of urls) {
      expect(url).toMatch(/^\/assets\/[A-Za-z0-9.-]+\?v=[0-9a-f]{8}$/);
      const name = url.slice("/assets/".length).split("?")[0] as string;
      expect(getFontAsset(name)).not.toBeNull();
    }
  });

  test("every URL's token is the asset's own etag", () => {
    for (const url of fontAssetUrls()) {
      const [name, token] = url.slice("/assets/".length).split("?v=") as [string, string];
      expect(getFontAsset(name)!.etag).toBe(`"${token}"`);
    }
  });

  test("URLs are distinct, so no two assets share a cache entry", () => {
    const urls = fontAssetUrls();
    expect(new Set(urls).size).toBe(urls.length);
  });

  test("the stylesheet URL points at the generated stylesheet", () => {
    expect(FONT_CSS_URL).toStartWith("/assets/fonts.css?v=");
    expect(getFontAsset("fonts.css")!.body).toBe(CSS);
  });

  test("the registry does not shadow an existing site asset", () => {
    for (const name of fontAssetNames()) {
      expect(["site.css", "app.js", "sw.js", "manifest.webmanifest"]).not.toContain(name);
    }
  });

  /**
   * `install` blocks on the precache list. Blocking a service worker's
   * installation on 291 KB of fonts over an e-reader's radio is how you get a
   * worker that never finishes installing and therefore never caches a page.
   * The worker's runtime rule already treats `/assets/` as cache-first, so the
   * one family a reader actually uses is cached on first paint anyway.
   */
  test("no font binary is in the service worker's precache list", () => {
    for (const url of PRECACHE_URLS) {
      expect(url).not.toContain(".woff");
    }
  });
});

describe("GET /settings", () => {
  test("redirects with 303 and never caches", async () => {
    const res = await call("/settings?font=georgia&to=%2Farchive");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/archive");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("sets the font cookie for every registered font", async () => {
    for (const id of IDS) {
      const res = await call(`/settings?font=${id}&to=%2F`);
      expect(setCookies(res)).toEqual([fontCookie(id)]);
    }
  });

  test("sets the theme cookie on its own", async () => {
    const res = await call("/settings?theme=dark&to=%2F");
    expect(setCookies(res)).toEqual(["theme=dark; Path=/; Max-Age=31536000; SameSite=Lax"]);
  });

  test("sets both preferences in one request, as two Set-Cookie headers", async () => {
    // `set` rather than `append` would silently drop the first of the two.
    const cookies = setCookies(await call("/settings?font=atkinson&theme=light&to=%2F"));
    expect(cookies.length).toBe(2);
    expect(cookies[0]).toStartWith("font=atkinson;");
    expect(cookies[1]).toStartWith("theme=light;");
  });

  test("ignores an unknown value rather than echoing it anywhere", async () => {
    for (const query of [
      "font=comic-sans",
      "font=__proto__",
      "font=",
      "font=%3Cscript%3E",
      "theme=neon",
      "theme=DARK",
    ]) {
      const res = await call(`/settings?${query}&to=%2Farchive`);
      expect(res.status).toBe(303);
      expect(setCookies(res)).toEqual([]);
      expect(res.headers.get("location")).toBe("/archive");
    }
  });

  test("a valid preference still lands when an invalid one rides along", async () => {
    const cookies = setCookies(await call("/settings?font=literata&theme=neon&to=%2F"));
    expect(cookies).toEqual([fontCookie("literata")]);
  });

  test("with no parameters at all it is a harmless redirect to the root", async () => {
    const res = await call("/settings");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(setCookies(res)).toEqual([]);
  });

  /**
   * The security property. `to` is attacker-controllable through a link, and it
   * goes straight into a Location header.
   */
  test("refuses to redirect off-origin", async () => {
    for (const to of [
      "//evil.com",
      "//evil.com/path",
      "///evil.com",
      "https://evil.com",
      "http://evil.com/x",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "/\\evil.com",
      "\\\\evil.com",
      "archive",
      "../archive",
    ]) {
      const res = await call(`/settings?font=georgia&to=${encodeURIComponent(to)}`);
      expect(res.headers.get("location")).toBe("/");
      // The preference is still honoured; only the destination is refused.
      expect(setCookies(res)).toEqual([fontCookie("georgia")]);
    }
  });

  /**
   * `searchParams.get` returns the value already percent-decoded, so "%0d%0a"
   * arrives as a real CRLF. The Headers constructor rejects that outright,
   * which would turn a crafted link into a 500 rather than a redirect.
   */
  test("rejects control characters instead of throwing on the header", async () => {
    for (const to of ["/a\r\nSet-Cookie: sid=hijacked", "/a\nb", "/a\u0000b", "/a\u007fb"]) {
      const res = await call(`/settings?to=${encodeURIComponent(to)}`);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/");
    }
  });

  test("keeps a same-site path with its query and fragment", async () => {
    const res = await call(`/settings?font=charis&to=${encodeURIComponent("/story/1#settings")}`);
    expect(res.headers.get("location")).toBe("/story/1#settings");
  });

  test("has no body, which is what a 303 should carry", async () => {
    expect(await (await call("/settings?font=charis&to=%2F")).text()).toBe("");
  });
});

/**
 * The panel, with every preference defaulted so a test names only the one it
 * is about. Four groups means four required values, and spelling all four out
 * at every call site would bury the one that matters.
 */
function panel(opts: {
  path: string;
  font?: FontId;
  theme?: Theme;
  size?: TextSize;
  spacing?: LineSpacing;
}): string {
  return settingsPanelHtml({
    path: opts.path,
    font: opts.font ?? DEFAULT_FONT,
    theme: opts.theme ?? "auto",
    size: opts.size ?? DEFAULT_TEXT_SIZE,
    spacing: opts.spacing ?? DEFAULT_LINE_SPACING,
  });
}

/** Every option group, as the panel orders them. */
const GROUP_COUNT = FONTS.length + TEXT_SIZES.length + LINE_SPACINGS.length + 3;

describe("the settings panel markup", () => {
  const html = panel({ path: "/story/44921137", font: "literata", theme: "dark" });

  test("is a section carrying the fragment that reveals it", () => {
    expect(SETTINGS_ID).toBe("settings");
    expect(html).toStartWith(`<section id="settings" class="settings"`);
    expect(html).toEndWith("</section>");
  });

  test("contains exactly one link per font, and one per theme", () => {
    for (const font of FONTS) {
      const links = html.match(new RegExp(`href="/settings\\?font=${font.id}&amp;`, "g")) ?? [];
      expect(links.length).toBe(1);
    }
    const fontLinks = html.match(/href="\/settings\?font=/g) ?? [];
    expect(fontLinks.length).toBe(FONTS.length);
    const themeLinks = html.match(/href="\/settings\?theme=/g) ?? [];
    expect(themeLinks.length).toBe(3);
  });

  test("labels each font option with its name and sets it in that font", () => {
    // A reader cannot choose between six serifs from their names alone.
    for (const font of FONTS) {
      expect(html).toContain(`class="settings-option font-${font.id}"`);
      expect(html).toContain(`>${font.label}</span>`);
    }
  });

  test("contains exactly one link per size, and one per spacing", () => {
    for (const s of TEXT_SIZES) {
      const links = html.match(new RegExp(`href="/settings\\?size=${s.id}&amp;`, "g")) ?? [];
      expect(links.length).toBe(1);
    }
    for (const s of LINE_SPACINGS) {
      const links = html.match(new RegExp(`href="/settings\\?spacing=${s.id}&amp;`, "g")) ?? [];
      expect(links.length).toBe(1);
    }
    expect((html.match(/href="\/settings\?size=/g) ?? []).length).toBe(TEXT_SIZES.length);
    expect((html.match(/href="\/settings\?spacing=/g) ?? []).length).toBe(
      LINE_SPACINGS.length,
    );
  });

  test("sets each size and spacing option in the type it names", () => {
    // The same argument as the font previews: nobody picks between five sizes
    // from the words "Small" and "Medium". TYPE_CSS keys its previews on these
    // class names, so a mismatch here is an option that shows nothing.
    for (const s of TEXT_SIZES) {
      expect(html).toContain(`class="settings-option settings-size-${s.id}"`);
      expect(html).toContain(`>${s.label}</span>`);
    }
    for (const s of LINE_SPACINGS) {
      expect(html).toContain(`class="settings-option settings-spacing-${s.id}"`);
      expect(html).toContain(`>${s.label}</span>`);
    }
  });

  test("gives the spacing options enough text to show their leading", () => {
    // Leading is invisible on one line. Each spacing detail has to wrap at the
    // panel's measure or the preview shows the reader nothing at all.
    for (const s of LINE_SPACINGS) {
      const at = html.indexOf(`settings-spacing-${s.id}`);
      const detail = html
        .slice(at)
        .match(/<span class="settings-option-detail">([^<]*)<\/span>/)?.[1];
      expect(detail ?? "").toContain(s.note);
      expect((detail ?? "").length).toBeGreaterThan(120);
    }
  });

  test("orders the groups typography first, room last", () => {
    const order = [
      "settings-font-group",
      "settings-size-group",
      "settings-spacing-group",
      "settings-theme-group",
    ].map((id) => html.indexOf(`<h3 class="settings-group" id="${id}">`));
    expect(order.every((i) => i > -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  test("every list is labelled by the heading above it", () => {
    // The panel has no <form> and no <fieldset>, so aria-labelledby is the only
    // thing telling a screen reader which group a link belongs to.
    const lists = html.match(/<ul class="settings-options" aria-labelledby="([^"]+)">/g) ?? [];
    expect(lists.length).toBe(4);
    for (const list of lists) {
      const id = list.match(/aria-labelledby="([^"]+)"/)![1];
      expect(html).toContain(`id="${id}"`);
    }
  });

  test("marks the current selections, in markup and in words", () => {
    // One per group, always: every group has a current value, including the
    // ones the reader has never touched.
    expect((html.match(/aria-current="true"/g) ?? []).length).toBe(4);
    expect(html).toContain(`class="settings-option font-literata" href="/settings?font=literata`);
    expect(html).toContain(`font=literata&amp;to=%2Fstory%2F44921137%23settings" rel="nofollow" aria-current="true"`);
    expect(html).toContain(`theme=dark&amp;to=%2Fstory%2F44921137%23settings" rel="nofollow" aria-current="true"`);
    // The word carries the same information when the stylesheet does not load.
    expect((html.match(/<span class="settings-state">Selected<\/span>/g) ?? []).length).toBe(4);
  });

  test("returns the reader to the page they were on, panel still open", () => {
    // Comparing six fonts should not mean reopening the panel five times, and
    // each reopen on e-ink is a page flash.
    expect(html).toContain("to=%2Fstory%2F44921137%23settings");
  });

  test("the close link returns to the current path with no fragment", () => {
    expect(html).toContain(`<a class="btn btn-primary settings-close" href="/story/44921137">`);
  });

  test("every option link is nofollow, because each one mutates a cookie", () => {
    const anchors = html.match(/<a class="settings-option[^>]*>/g) ?? [];
    expect(anchors.length).toBe(GROUP_COUNT);
    for (const a of anchors) expect(a).toContain('rel="nofollow"');
  });

  test("escapes the ampersands between query parameters", () => {
    expect(html).not.toMatch(/&(?!amp;|#)/);
  });

  test("an off-origin path collapses to the root", () => {
    // `path` comes from the request. It goes through the same open-redirect
    // guard the route uses rather than a second, subtly different one.
    for (const path of ["//evil.com", "https://evil.com", "/a\r\nb", "\\\\evil.com"]) {
      const out = panel({ path, font: "charis" });
      expect(out).not.toContain("evil.com");
      expect(out).toContain('href="/"');
      expect(out).toContain("to=%2F%23settings");
    }
  });

  test("a quote in an accepted path cannot break out of the attribute", () => {
    // `/x"...` is a legal same-origin path, so the redirect guard passes it and
    // escaping is the only thing between it and an injected event handler.
    const out = panel({ path: '/x" onmouseover="alert(1)', font: "charis" });
    expect(out).toContain('href="/x&quot; onmouseover=&quot;alert(1)"');
    expect(out).not.toContain('href="/x" ');
    // No attribute value anywhere in the document contains a bare quote.
    for (const attribute of out.match(/="[^"]*"/g) ?? []) {
      expect(attribute.slice(2, -1)).not.toContain('"');
    }
  });

  /**
   * Degradation. With the stylesheet gone this has to read as an ordinary
   * settings section at the end of the page, not as a broken overlay - so the
   * structure alone, with every class ignored, must still be a heading, four
   * labelled lists of links, and a way back.
   */
  test("reads as a plain settings section with every style stripped", () => {
    const stripped = html.replace(/ (?:class|id|aria-[a-z]+|rel)="[^"]*"/g, "");
    expect(stripped).toContain("<h2>Settings</h2>");
    expect(stripped).toContain("<h3>Reading font</h3>");
    expect(stripped).toContain("<h3>Text size</h3>");
    expect(stripped).toContain("<h3>Line spacing</h3>");
    expect(stripped).toContain("<h3>Theme</h3>");
    expect((stripped.match(/<ul>/g) ?? []).length).toBe(4);
    expect((stripped.match(/<li>/g) ?? []).length).toBe(GROUP_COUNT);
    expect(stripped).toContain("Close settings");
    // Nothing in it depends on scripting, inline styles or a form control.
    expect(stripped).not.toContain("<script");
    expect(stripped).not.toContain("<form");
    expect(stripped).not.toContain("<input");
    expect(stripped).not.toContain("<button");
    expect(stripped).not.toContain("style=");
    expect(stripped).not.toContain("onclick");
  });

  test("tracks the current selection for any combination", () => {
    for (const id of IDS) {
      const out = panel({ path: "/", font: id });
      const marked = out.match(/class="settings-option ([a-z-]+)" href="[^"]*" rel="nofollow" aria-current/g) ?? [];
      expect(marked.length).toBe(4);
      expect(marked[0]).toContain(`font-${id}`);
    }
  });
});

describe("SETTINGS_CSS", () => {
  /**
   * The degradation mechanism, and the reason it is `:not(:target)` rather than
   * the obvious hide/reveal pair. A browser drops any rule whose selector it
   * cannot parse. Written the obvious way, a browser that does not know
   * `:target` drops the reveal and keeps the hide, and the settings become
   * permanently unreachable. Written this way it drops the hide, and the panel
   * degrades into the plain section the markup already is.
   */
  test("hides the panel with :not(:target), so unsupported means visible", () => {
    expect(PANEL_RULES).toContain(".settings:not(:target) {\n  display: none;\n}");
    expect(PANEL_RULES).not.toContain(".settings:target");
  });

  test("never uses position: fixed, which flashes the whole panel on e-ink", () => {
    expect(PANEL_RULES).not.toContain("position: fixed");
    expect(PANEL_RULES).not.toContain("position:fixed");
  });

  test("has no transitions or animations", () => {
    expect(PANEL_RULES).not.toContain("transition");
    expect(PANEL_RULES).not.toContain("animation");
  });

  test("gives every option at least a full tap target", () => {
    expect(PANEL_RULES).toContain("min-height: var(--tap)");
  });

  test("uses only custom properties the site stylesheet defines", () => {
    const declared = new Set([
      "--bg",
      "--fg",
      "--fg-soft",
      "--rule",
      "--rule-soft",
      "--accent-bg",
      "--accent-fg",
      "--quote-rule",
      "--measure",
      "--wrap",
      "--tap",
      "--chead-h",
    ]);
    for (const raw of PANEL_RULES.match(/var\(--[a-z-]+\)/g) ?? []) {
      expect(declared).toContain(raw.slice(4, -1));
    }
  });

  test("has no unbalanced braces, so concatenating it cannot swallow SITE_CSS", () => {
    expect((PANEL_RULES.match(/\{/g) ?? []).length).toBe(
      (PANEL_RULES.match(/\}/g) ?? []).length,
    );
  });

  test("declares no @charset, which is only legal at the top of a sheet", () => {
    // It is concatenated onto SITE_CSS, which already has one.
    expect(PANEL_RULES).not.toContain("@charset");
  });
});
