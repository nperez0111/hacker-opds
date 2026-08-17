/**
 * Cookie-driven theme selection.
 *
 * Two of these describe security properties rather than presentation, and both
 * are hostile-input tests:
 *
 *  - `safeReturnPath` is the only thing standing between `/theme?to=...` and an
 *    open redirect. Every case a browser treats as off-origin has to be
 *    rejected, including the ones that do not look like URLs.
 *  - `themeFromCookieHeader` runs on every request before anything else, so a
 *    header it cannot survive is a site-wide outage triggerable by a value the
 *    reader cannot clear without developer tools.
 */
import { describe, expect, test } from "bun:test";
import {
  THEME_COOKIE,
  THEME_COOKIE_MAX_AGE,
  isTheme,
  nextTheme,
  safeReturnPath,
  themeCookie,
  themeFromCookieHeader,
  themeLabel,
  type Theme,
} from "~/web/theme";

describe("isTheme", () => {
  test("accepts exactly the three states", () => {
    expect(isTheme("auto")).toBe(true);
    expect(isTheme("light")).toBe(true);
    expect(isTheme("dark")).toBe(true);
  });

  test("rejects anything else, including near misses", () => {
    expect(isTheme("Dark")).toBe(false);
    expect(isTheme("darkmode")).toBe(false);
    expect(isTheme("")).toBe(false);
    expect(isTheme("null")).toBe(false);
  });
});

describe("themeFromCookieHeader", () => {
  test("defaults to auto when there is no cookie header at all", () => {
    expect(themeFromCookieHeader(null)).toBe("auto");
    expect(themeFromCookieHeader("")).toBe("auto");
  });

  test("reads the theme cookie", () => {
    expect(themeFromCookieHeader("theme=dark")).toBe("dark");
    expect(themeFromCookieHeader("theme=light")).toBe("light");
    expect(themeFromCookieHeader("theme=auto")).toBe("auto");
  });

  test("finds the theme among other cookies, in any position", () => {
    expect(themeFromCookieHeader("sid=abc; theme=dark; tz=CET")).toBe("dark");
    expect(themeFromCookieHeader("theme=dark; sid=abc")).toBe("dark");
    expect(themeFromCookieHeader("sid=abc; theme=light")).toBe("light");
  });

  test("tolerates the whitespace real clients send around separators", () => {
    expect(themeFromCookieHeader("  theme=dark  ")).toBe("dark");
    expect(themeFromCookieHeader("sid=abc;theme=dark")).toBe("dark");
    expect(themeFromCookieHeader("sid=abc;   theme=dark")).toBe("dark");
  });

  test("does not match a cookie whose name merely contains 'theme'", () => {
    // A prefix match here would let an unrelated cookie drive the site's theme.
    expect(themeFromCookieHeader("themepark=dark")).toBe("auto");
    expect(themeFromCookieHeader("mytheme=dark")).toBe("auto");
    expect(themeFromCookieHeader("theme_pref=dark")).toBe("auto");
  });

  test("falls back to auto for an unknown value", () => {
    expect(themeFromCookieHeader("theme=neon")).toBe("auto");
    expect(themeFromCookieHeader("theme=DARK")).toBe("auto");
    expect(themeFromCookieHeader("theme=")).toBe("auto");
  });

  test("skips valueless segments rather than mis-parsing them", () => {
    expect(themeFromCookieHeader("flag; theme=dark")).toBe("dark");
    expect(themeFromCookieHeader("theme")).toBe("auto");
    expect(themeFromCookieHeader(";;;")).toBe("auto");
  });

  test("decodes a percent-encoded value", () => {
    expect(themeFromCookieHeader("theme=%64ark")).toBe("dark");
  });

  /**
   * Regression: `decodeURIComponent` throws `URIError` on a malformed escape.
   * This runs before any page renders, so an unhandled throw was a 500 on every
   * request for anyone holding a corrupt cookie.
   */
  test("survives a malformed percent escape instead of throwing", () => {
    expect(() => themeFromCookieHeader("theme=%")).not.toThrow();
    expect(themeFromCookieHeader("theme=%")).toBe("auto");
    expect(themeFromCookieHeader("theme=%E0%A4%A")).toBe("auto");
    expect(themeFromCookieHeader("theme=%zz")).toBe("auto");
    // And a broken cookie must not shadow a good one that follows it.
    expect(themeFromCookieHeader("other=%; theme=dark")).toBe("dark");
  });
});

describe("nextTheme", () => {
  test("cycles auto to dark to light and back to auto", () => {
    expect(nextTheme("auto")).toBe("dark");
    expect(nextTheme("dark")).toBe("light");
    expect(nextTheme("light")).toBe("auto");
  });

  test("returns to the starting state in exactly three steps", () => {
    // "auto" has to stay reachable by tapping: there is no other control for
    // it, and a reader cannot clear a cookie on an e-reader browser.
    const seen: Theme[] = [];
    let theme: Theme = "auto";
    for (let i = 0; i < 3; i += 1) {
      theme = nextTheme(theme);
      seen.push(theme);
    }
    expect(seen).toEqual(["dark", "light", "auto"]);
    expect(new Set(seen).size).toBe(3);
  });
});

describe("themeLabel", () => {
  test("names the current state, not the destination", () => {
    expect(themeLabel("auto")).toBe("Auto");
    expect(themeLabel("dark")).toBe("Dark");
    expect(themeLabel("light")).toBe("Light");
  });
});

describe("safeReturnPath", () => {
  test("accepts an ordinary same-site path", () => {
    expect(safeReturnPath("/")).toBe("/");
    expect(safeReturnPath("/archive")).toBe("/archive");
    expect(safeReturnPath("/archive/2026-08-16")).toBe("/archive/2026-08-16");
    expect(safeReturnPath("/story/44921137")).toBe("/story/44921137");
  });

  test("keeps a query string and fragment intact", () => {
    expect(safeReturnPath("/archive?page=2")).toBe("/archive?page=2");
    expect(safeReturnPath("/story/1?from=archive#c42")).toBe("/story/1?from=archive#c42");
  });

  test("rejects a protocol-relative URL", () => {
    // The case worth naming: browsers follow "//host" off-origin.
    expect(safeReturnPath("//evil.com")).toBe("/");
    expect(safeReturnPath("//evil.com/path")).toBe("/");
    expect(safeReturnPath("///evil.com")).toBe("/");
  });

  test("rejects an absolute URL on any scheme", () => {
    expect(safeReturnPath("https://evil.com")).toBe("/");
    expect(safeReturnPath("http://evil.com/x")).toBe("/");
    expect(safeReturnPath("javascript:alert(1)")).toBe("/");
    expect(safeReturnPath("data:text/html,<script>alert(1)</script>")).toBe("/");
  });

  test("rejects backslash variants, which some browsers normalise to slashes", () => {
    expect(safeReturnPath("/\\evil.com")).toBe("/");
    expect(safeReturnPath("\\\\evil.com")).toBe("/");
    expect(safeReturnPath("/\\/evil.com")).toBe("/");
    expect(safeReturnPath("/path\\..\\evil")).toBe("/");
  });

  test("rejects anything not anchored at the root", () => {
    expect(safeReturnPath("archive")).toBe("/");
    expect(safeReturnPath("./archive")).toBe("/");
    expect(safeReturnPath("../archive")).toBe("/");
    // Leading whitespace means it does not start with "/", and trimming it
    // would only recreate the problem it is being rejected for.
    expect(safeReturnPath(" /archive")).toBe("/");
    expect(safeReturnPath("\t/archive")).toBe("/");
  });

  test("rejects empty and absent values", () => {
    expect(safeReturnPath("")).toBe("/");
    expect(safeReturnPath(null)).toBe("/");
  });

  /**
   * `searchParams.get` returns the value already percent-decoded, so "%0d%0a"
   * arrives here as a real CRLF. The Headers constructor rejects that outright,
   * which turned a crafted link into a 500 rather than a redirect.
   */
  test("rejects control characters that would corrupt the Location header", () => {
    expect(safeReturnPath("/a\r\nSet-Cookie: sid=hijacked")).toBe("/");
    expect(safeReturnPath("/a\nb")).toBe("/");
    expect(safeReturnPath("/a\u0000b")).toBe("/");
    expect(safeReturnPath("/a\u007fb")).toBe("/");
  });

  test("every rejection is constructible as a Location header", () => {
    const hostile = [
      "//evil.com",
      "https://evil.com",
      "/\\evil.com",
      "archive",
      "",
      "/a\r\nSet-Cookie: sid=hijacked",
    ];
    for (const value of hostile) {
      const safe = safeReturnPath(value);
      expect(() => new Response(null, { status: 303, headers: { location: safe } })).not.toThrow();
    }
  });

  test("honours a caller-supplied fallback", () => {
    expect(safeReturnPath("https://evil.com", "/archive")).toBe("/archive");
    expect(safeReturnPath(null, "/archive")).toBe("/archive");
  });
});

describe("themeCookie", () => {
  test("emits a site-wide, year-long, lax cookie", () => {
    expect(themeCookie("dark")).toBe(
      `${THEME_COOKIE}=dark; Path=/; Max-Age=${THEME_COOKIE_MAX_AGE}; SameSite=Lax`,
    );
  });

  test("round-trips through the parser for every theme", () => {
    for (const theme of ["auto", "light", "dark"] as const) {
      const header = themeCookie(theme).split(";")[0] as string;
      expect(themeFromCookieHeader(header)).toBe(theme);
    }
  });

  test("Max-Age is a year, so the preference outlives a session", () => {
    expect(THEME_COOKIE_MAX_AGE).toBe(31_536_000);
  });
});
