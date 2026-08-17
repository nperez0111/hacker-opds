/**
 * Light/dark selection, done server-side.
 *
 * The obvious implementation is a button that flips a class and writes
 * localStorage. It is rejected here for two reasons.
 *
 * First, it needs scripting, and the whole point of this site is that it works
 * on a reader whose browser may have JavaScript disabled or broken.
 *
 * Second, even where scripting works it produces a flash: the server sends the
 * default theme, the browser paints it, then script corrects it. On an LCD that
 * flash is a frame. On e-ink it is a full white-to-black panel refresh, which
 * is the single most unpleasant thing a page can do on that hardware.
 *
 * A cookie read during rendering means the first byte already carries the right
 * theme, and no script is involved at any point.
 */
import type { H3Event } from "nitro/h3";

export type Theme = "auto" | "light" | "dark";

export const THEME_COOKIE = "theme";

/** One year. The preference is not sensitive and re-asking is pure friction. */
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isTheme(value: string): value is Theme {
  return value === "auto" || value === "light" || value === "dark";
}

/**
 * Minimal cookie lookup.
 *
 * h3 has a cookie helper, but pulling it in here would make this module need an
 * H3Event to be testable. Taking the raw header keeps the parsing pure.
 */
export function themeFromCookieHeader(header: string | null): Theme {
  if (!header) return "auto";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== THEME_COOKIE) continue;
    /*
     * decodeURIComponent throws on a malformed escape ("theme=%"), and this
     * runs on every request before anything else. An unhandled throw here is
     * a 500 on every page for anyone holding a corrupt cookie - which they
     * cannot clear without developer tools, because the site would never load
     * far enough to offer them the toggle. A bad cookie means "no preference".
     */
    let value: string;
    try {
      value = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return "auto";
    }
    return isTheme(value) ? value : "auto";
  }
  return "auto";
}

export function readTheme(event: H3Event): Theme {
  return themeFromCookieHeader(event.req.headers.get("cookie"));
}

/**
 * The theme the toggle should move to next.
 *
 * Three states in a fixed cycle rather than a two-way switch, because "auto"
 * has to remain reachable: a reader who follows the system setting and taps the
 * control once should be able to get back without clearing a cookie.
 */
export function nextTheme(current: Theme): Theme {
  if (current === "auto") return "dark";
  if (current === "dark") return "light";
  return "auto";
}

/** Label for the toggle: names the current state, not the destination. */
export function themeLabel(current: Theme): string {
  if (current === "dark") return "Dark";
  if (current === "light") return "Light";
  return "Auto";
}

/**
 * Rejects anything that is not a path on this site.
 *
 * The toggle round-trips through a redirect carrying the page to return to,
 * which is an open redirect unless the target is constrained. A leading double
 * slash is the case worth naming: "//evil.example" is a protocol-relative URL,
 * not a local path, and browsers will follow it off-origin.
 */
export function safeReturnPath(value: string | null, fallback = "/"): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return fallback;
  if (value.includes("\\")) return fallback;
  /*
   * The result goes straight into a Location header. A query string arrives
   * percent-decoded from searchParams, so "%0d%0a" reaches here as a real
   * CRLF; the Headers constructor rejects that with a TypeError, turning a
   * crafted link into a 500 rather than a redirect. Control characters have no
   * business in a path either way.
   */
  if (/[\u0000-\u001f\u007f]/.test(value)) return fallback;
  return value;
}

export function themeCookie(theme: Theme): string {
  return (
    `${THEME_COOKIE}=${theme}; Path=/; Max-Age=${THEME_COOKIE_MAX_AGE}; ` +
    `SameSite=Lax`
  );
}
