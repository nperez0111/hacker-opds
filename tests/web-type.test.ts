/**
 * Text size and line spacing: the shared cookie parser, the two registries,
 * the generated rules and the `/settings` parameters that write them.
 *
 * Three of these groups are about failures a reader cannot report:
 *
 *  - `cookieValue` now runs on every request four times over, once per
 *    preference. It was three private copies before this module existed, so the
 *    hostile-input cases are repeated here rather than trusted to the two
 *    wrappers that already had them: a header this cannot survive is a site-wide
 *    500 triggered by a value the reader cannot clear without developer tools.
 *  - `TYPE_CSS` is the only thing that makes either setting do anything. A
 *    binding that does not outrank the base rule presents as a setting that
 *    reports itself Selected and changes nothing on the page, which looks like a
 *    broken device rather than a broken site.
 *  - The spacing rules have to match `body`. That is not a style preference; a
 *    rule on the root loses to `body`'s own declaration and the setting silently
 *    does nothing.
 */
import { describe, expect, test } from "bun:test";
import { mockEvent, type H3Event } from "nitro/h3";

import { PREFERENCE_MAX_AGE, cookieValue, preferenceCookie } from "~/web/cookie";
import { SITE_CSS } from "~/web/styles";
import {
  DEFAULT_LINE_SPACING,
  DEFAULT_TEXT_SIZE,
  LINE_SPACINGS,
  LINE_SPACING_COOKIE,
  TEXT_SIZES,
  TEXT_SIZE_COOKIE,
  TYPE_CSS,
  isLineSpacing,
  isTextSize,
  lineSpacingCookie,
  lineSpacingFromCookieHeader,
  readLineSpacing,
  readTextSize,
  textSizeCookie,
  textSizeFromCookieHeader,
} from "~/web/type";

import settingsRoute from "../server/routes/settings";

/** The stylesheets are heavily commented, and the comments name the very rules
 * these tests grep for. Assertions about what the CSS *does* run against the
 * declarations only. */
function rules(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

const TYPE_RULES = rules(TYPE_CSS);

const SIZE_IDS = TEXT_SIZES.map((s) => s.id);
const SPACING_IDS = LINE_SPACINGS.map((s) => s.id);

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

/* ------------------------------------------------------------------ */

describe("cookieValue", () => {
  test("returns null when there is no header at all", () => {
    expect(cookieValue(null, "size")).toBeNull();
    expect(cookieValue("", "size")).toBeNull();
  });

  test("reads a lone cookie", () => {
    expect(cookieValue("size=l", "size")).toBe("l");
  });

  test("finds the cookie among others, in any position", () => {
    expect(cookieValue("theme=dark; size=l; font=charis", "size")).toBe("l");
    expect(cookieValue("size=l; theme=dark", "size")).toBe("l");
    expect(cookieValue("theme=dark; size=l", "size")).toBe("l");
  });

  test("tolerates the whitespace real clients send around separators", () => {
    expect(cookieValue("  theme=dark ;   size=xl  ", "size")).toBe("xl");
  });

  /*
   * The reason this is a map-free string compare on the *name* rather than a
   * substring search: "spacing" contains "spacin", and more to the point
   * "text-size" contains "size". A parser that matched loosely would hand the
   * wrong cookie's value to the wrong guard.
   */
  test("does not match a cookie whose name merely contains the one asked for", () => {
    expect(cookieValue("mysize=l", "size")).toBeNull();
    expect(cookieValue("sizeable=l", "size")).toBeNull();
    expect(cookieValue("line-spacing=loose", "spacing")).toBeNull();
  });

  test("skips valueless segments rather than mis-parsing them", () => {
    expect(cookieValue("justaflag; size=s", "size")).toBe("s");
    expect(cookieValue("justaflag", "size")).toBeNull();
  });

  test("decodes a percent-encoded value", () => {
    expect(cookieValue("size=%6c", "size")).toBe("l");
  });

  /*
   * decodeURIComponent throws URIError on a malformed escape. This runs before
   * anything renders, so an unhandled throw is every page 500ing for anyone
   * holding the cookie - and they cannot clear it, because the site never loads
   * far enough to show them the panel.
   */
  test("survives a malformed percent escape instead of throwing", () => {
    expect(() => cookieValue("size=%", "size")).not.toThrow();
    expect(cookieValue("size=%", "size")).toBeNull();
    expect(cookieValue("size=%zz", "size")).toBeNull();
  });

  test("takes the first of a duplicated name and stops looking", () => {
    expect(cookieValue("size=s; size=xl", "size")).toBe("s");
  });

  test("an empty value is a value, not an absence", () => {
    expect(cookieValue("size=", "size")).toBe("");
  });
});

describe("preferenceCookie", () => {
  test("emits a site-wide, year-long, lax cookie", () => {
    expect(preferenceCookie("size", "l")).toBe(
      "size=l; Path=/; Max-Age=31536000; SameSite=Lax",
    );
  });

  test("Max-Age is a year, so a preference outlives a session", () => {
    expect(PREFERENCE_MAX_AGE).toBe(60 * 60 * 24 * 365);
  });

  test("round-trips through the parser", () => {
    const header = preferenceCookie("spacing", "loose").split(";")[0]!;
    expect(cookieValue(header, "spacing")).toBe("loose");
  });
});

/* ------------------------------------------------------------------ */

describe("isTextSize", () => {
  test("accepts exactly the registry's ids", () => {
    for (const id of SIZE_IDS) expect(isTextSize(id)).toBe(true);
    expect(SIZE_IDS).toEqual(["xs", "s", "m", "l", "xl"]);
  });

  test("rejects anything else, including near misses", () => {
    expect(isTextSize("M")).toBe(false);
    expect(isTextSize("medium")).toBe(false);
    expect(isTextSize("")).toBe(false);
    expect(isTextSize("20")).toBe(false);
  });

  test("rejects inherited Object properties", () => {
    expect(isTextSize("__proto__")).toBe(false);
    expect(isTextSize("constructor")).toBe(false);
    expect(isTextSize("toString")).toBe(false);
  });
});

describe("isLineSpacing", () => {
  test("accepts exactly the registry's ids", () => {
    for (const id of SPACING_IDS) expect(isLineSpacing(id)).toBe(true);
    expect(SPACING_IDS).toEqual(["tight", "normal", "loose"]);
  });

  test("rejects anything else, including near misses", () => {
    expect(isLineSpacing("Normal")).toBe(false);
    expect(isLineSpacing("1.55")).toBe(false);
    expect(isLineSpacing("")).toBe(false);
  });

  test("rejects inherited Object properties", () => {
    expect(isLineSpacing("__proto__")).toBe(false);
    expect(isLineSpacing("constructor")).toBe(false);
  });
});

describe("the type registries", () => {
  test("the defaults are real entries", () => {
    expect(SIZE_IDS).toContain(DEFAULT_TEXT_SIZE);
    expect(SPACING_IDS).toContain(DEFAULT_LINE_SPACING);
  });

  /*
   * The default has to be what the site already served, or shipping this
   * feature silently reformats the page for every reader who never asked.
   */
  test("the defaults are the sizes the site already used", () => {
    const size = TEXT_SIZES.find((s) => s.id === DEFAULT_TEXT_SIZE)!;
    const spacing = LINE_SPACINGS.find((s) => s.id === DEFAULT_LINE_SPACING)!;
    expect(size.px).toBe(20);
    expect(spacing.ratio).toBe(1.55);
    expect(rules(SITE_CSS)).toContain(`font-size: ${size.px}px;`);
    expect(rules(SITE_CSS)).toContain(`line-height: ${spacing.ratio};`);
  });

  test("ids are unique and URL-safe, since they are cookie values and selectors", () => {
    expect(new Set(SIZE_IDS).size).toBe(SIZE_IDS.length);
    expect(new Set(SPACING_IDS).size).toBe(SPACING_IDS.length);
    for (const id of [...SIZE_IDS, ...SPACING_IDS]) {
      expect(id).toMatch(/^[a-z-]+$/);
      expect(encodeURIComponent(id)).toBe(id);
    }
  });

  test("every entry has a label and a note for the panel to show", () => {
    for (const s of [...TEXT_SIZES, ...LINE_SPACINGS]) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.note.length).toBeGreaterThan(0);
    }
  });

  test("the scales are strictly increasing, so the list reads as a scale", () => {
    const px = TEXT_SIZES.map((s) => s.px);
    const ratios = LINE_SPACINGS.map((s) => s.ratio);
    expect(px).toEqual([...px].sort((a, b) => a - b));
    expect(ratios).toEqual([...ratios].sort((a, b) => a - b));
    expect(new Set(px).size).toBe(px.length);
    expect(new Set(ratios).size).toBe(ratios.length);
  });

  /*
   * Below 16px an e-ink panel loses stem contrast and the type goes grey, which
   * is the failure the 20px default exists to avoid. The upper bound is where a
   * 34rem measure stops fitting any e-reader panel.
   */
  test("no step leaves the range the module argues for", () => {
    for (const s of TEXT_SIZES) {
      expect(s.px).toBeGreaterThanOrEqual(16);
      expect(s.px).toBeLessThanOrEqual(26);
      expect(Number.isInteger(s.px)).toBe(true);
    }
    for (const s of LINE_SPACINGS) {
      expect(s.ratio).toBeGreaterThanOrEqual(1.2);
      expect(s.ratio).toBeLessThanOrEqual(2);
    }
  });
});

/* ------------------------------------------------------------------ */

describe("textSizeFromCookieHeader", () => {
  test("defaults when there is no cookie header at all", () => {
    expect(textSizeFromCookieHeader(null)).toBe(DEFAULT_TEXT_SIZE);
    expect(textSizeFromCookieHeader("")).toBe(DEFAULT_TEXT_SIZE);
  });

  test("reads every registered size", () => {
    for (const id of SIZE_IDS) {
      expect(textSizeFromCookieHeader(`${TEXT_SIZE_COOKIE}=${id}`)).toBe(id);
    }
  });

  test("finds the size among the other preferences", () => {
    expect(textSizeFromCookieHeader("theme=dark; font=charis; size=xl")).toBe("xl");
  });

  test("falls back to the default for an unknown value", () => {
    expect(textSizeFromCookieHeader("size=enormous")).toBe(DEFAULT_TEXT_SIZE);
    expect(textSizeFromCookieHeader("size=__proto__")).toBe(DEFAULT_TEXT_SIZE);
  });

  test("survives a malformed percent escape", () => {
    expect(textSizeFromCookieHeader("size=%")).toBe(DEFAULT_TEXT_SIZE);
  });
});

describe("lineSpacingFromCookieHeader", () => {
  test("defaults when there is no cookie header at all", () => {
    expect(lineSpacingFromCookieHeader(null)).toBe(DEFAULT_LINE_SPACING);
    expect(lineSpacingFromCookieHeader("")).toBe(DEFAULT_LINE_SPACING);
  });

  test("reads every registered spacing", () => {
    for (const id of SPACING_IDS) {
      expect(lineSpacingFromCookieHeader(`${LINE_SPACING_COOKIE}=${id}`)).toBe(id);
    }
  });

  test("falls back to the default for an unknown value", () => {
    expect(lineSpacingFromCookieHeader("spacing=airy")).toBe(DEFAULT_LINE_SPACING);
  });

  test("survives a malformed percent escape", () => {
    expect(lineSpacingFromCookieHeader("spacing=%")).toBe(DEFAULT_LINE_SPACING);
  });
});

describe("the type cookies", () => {
  test("read off a request", () => {
    const ev = event("/", { cookie: "size=l; spacing=loose" });
    expect(readTextSize(ev)).toBe("l");
    expect(readLineSpacing(ev)).toBe("loose");
  });

  test("each round-trips through its own parser, for every value", () => {
    for (const id of SIZE_IDS) {
      const header = textSizeCookie(id).split(";")[0]!;
      expect(textSizeFromCookieHeader(header)).toBe(id);
    }
    for (const id of SPACING_IDS) {
      const header = lineSpacingCookie(id).split(";")[0]!;
      expect(lineSpacingFromCookieHeader(header)).toBe(id);
    }
  });

  /*
   * Four preferences share one cookie jar. Two of them colliding would make
   * changing one silently change the other.
   */
  test("the four preference cookies have four distinct names", () => {
    const names = ["font", "theme", TEXT_SIZE_COOKIE, LINE_SPACING_COOKIE];
    expect(new Set(names).size).toBe(4);
  });
});

/* ------------------------------------------------------------------ */

describe("TYPE_CSS", () => {
  test("is deterministic", () => {
    expect(TYPE_CSS).toBe(TYPE_CSS);
  });

  /*
   * html and :root are the same element, so this beats `html { font-size }` in
   * the site stylesheet on specificity alone. It is the one binding that can
   * live on the root.
   */
  test("binds each size to a data-size value on the root element", () => {
    for (const s of TEXT_SIZES) {
      expect(TYPE_RULES).toContain(`:root[data-size="${s.id}"] {\n  font-size: ${s.px}px;\n}`);
    }
  });

  /*
   * The trap the font stack rules already document: SITE_CSS declares
   * line-height on body, and a declaration on body beats anything body would
   * inherit from the root however specific the root selector is.
   */
  test("binds each spacing to body, not to the root, so it outranks SITE_CSS", () => {
    for (const s of LINE_SPACINGS) {
      expect(TYPE_RULES).toContain(
        `:root[data-spacing="${s.id}"] body {\n  line-height: ${s.ratio};\n}`,
      );
    }
    expect(TYPE_RULES).not.toMatch(/:root\[data-spacing="[a-z]+"\]\s*\{/);
  });

  test("emits a preview class per option for the settings panel", () => {
    for (const s of TEXT_SIZES) {
      expect(TYPE_RULES).toContain(`.settings-size-${s.id} .settings-option-detail {`);
    }
    for (const s of LINE_SPACINGS) {
      expect(TYPE_RULES).toContain(`.settings-spacing-${s.id} .settings-option-detail {`);
    }
  });

  /*
   * One rule per registry entry and no more. A hand-written sheet drifts from
   * the registry, and the drift presents as an option that reports itself
   * Selected and does nothing.
   */
  test("has exactly one rule per registry entry, with nothing left over", () => {
    const selectors = TYPE_RULES.match(/^[^\s@}][^{]*\{/gm) ?? [];
    expect(selectors.length).toBe((TEXT_SIZES.length + LINE_SPACINGS.length) * 2);
  });

  test("never uses !important, which would put the reader beyond reach", () => {
    expect(TYPE_RULES).not.toContain("!important");
  });

  /*
   * A unitless ratio: with a unit, line-height computes once on body and every
   * descendant inherits the resulting length, so a 1.6rem heading would get
   * body-sized leading and overlap itself.
   */
  test("every line-height is unitless", () => {
    const declared = TYPE_RULES.match(/line-height:\s*([^;]+);/g) ?? [];
    expect(declared.length).toBe(LINE_SPACINGS.length * 2);
    for (const d of declared) expect(d).toMatch(/line-height:\s*[\d.]+;/);
  });

  test("has no unbalanced braces, so concatenating it cannot swallow SITE_CSS", () => {
    expect((TYPE_RULES.match(/\{/g) ?? []).length).toBe(
      (TYPE_RULES.match(/\}/g) ?? []).length,
    );
  });

  test("declares no @charset, which is only legal at the top of a sheet", () => {
    expect(TYPE_CSS).not.toContain("@charset");
  });

  test("reaches the reader inside the site stylesheet", () => {
    expect(SITE_CSS).toContain(TYPE_CSS);
  });

  /*
   * Order matters: these override html and body, and equal specificity is
   * settled by document order. Landing before the rules they override would
   * make every one of them a no-op.
   */
  test("comes after the base rules it overrides", () => {
    expect(SITE_CSS.indexOf(TYPE_CSS)).toBeGreaterThan(
      SITE_CSS.indexOf("line-height: 1.55;"),
    );
  });
});

/* ------------------------------------------------------------------ */

describe("GET /settings - size and spacing", () => {
  test("sets the size cookie for every registered size", async () => {
    for (const id of SIZE_IDS) {
      const res = await call(`/settings?size=${id}&to=%2F`);
      expect(res.status).toBe(303);
      expect(res.headers.getSetCookie()).toEqual([textSizeCookie(id)]);
    }
  });

  test("sets the spacing cookie for every registered spacing", async () => {
    for (const id of SPACING_IDS) {
      const res = await call(`/settings?spacing=${id}&to=%2F`);
      expect(res.headers.getSetCookie()).toEqual([lineSpacingCookie(id)]);
    }
  });

  /*
   * `append` rather than `set` in the route. With `set`, four preferences in
   * one link would write only the last, which is exactly what a bookmark
   * carrying a whole configuration would do.
   */
  test("sets all four preferences in one request, as four Set-Cookie headers", async () => {
    const res = await call(
      "/settings?font=literata&theme=dark&size=xl&spacing=loose&to=%2F",
    );
    const cookies = res.headers.getSetCookie();
    expect(cookies.length).toBe(4);
    expect(cookies).toContain(textSizeCookie("xl"));
    expect(cookies).toContain(lineSpacingCookie("loose"));
  });

  test("ignores an unknown size or spacing rather than echoing it anywhere", async () => {
    const res = await call("/settings?size=enormous&spacing=airy&to=%2F");
    expect(res.status).toBe(303);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(res.headers.get("location")).toBe("/");
    expect(await res.text()).toBe("");
  });

  test("a valid preference still lands when an invalid one rides along", async () => {
    const res = await call("/settings?size=l&spacing=airy&to=%2F");
    expect(res.headers.getSetCookie()).toEqual([textSizeCookie("l")]);
  });

  test("an inherited property name is not a size", async () => {
    const res = await call("/settings?size=__proto__&to=%2F");
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  test("the cookies it writes are the ones the readers parse", async () => {
    const res = await call("/settings?size=xs&spacing=tight&to=%2F");
    const header = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    expect(textSizeFromCookieHeader(header)).toBe("xs");
    expect(lineSpacingFromCookieHeader(header)).toBe("tight");
  });
});
