/**
 * The one cookie parser, and the one cookie format.
 *
 * Every reader preference on this site is the same shape: a short value from a
 * closed enum, written by `/settings`, read during rendering so the first byte
 * already carries it. Each preference used to carry its own copy of the lookup
 * - `themeFromCookieHeader` and `fontFromCookieHeader` were the same
 * twenty-five lines with a different constant in the middle - and adding text
 * size and line spacing would have made four copies of a parser that has to
 * agree with itself about hostile input.
 *
 * That is the argument `safeReturnPath` already won, in this module's
 * neighbour: a check that exists in two places is a check that will disagree
 * with itself eventually. The typed readers stay where their types live; only
 * the string handling moves here.
 *
 * h3 has a cookie helper. It is not used, because it needs an `H3Event`, and
 * taking the raw header instead keeps this a pure function that a test can hit
 * with a malformed string and no request object at all.
 */

/**
 * The value of one cookie, or null when it is absent or unreadable.
 *
 * Two behaviours here are load-bearing and were preserved from the
 * implementations this replaced.
 *
 * The first match wins and the search then stops. A client that sends the same
 * cookie name twice is already in undefined territory; picking the first and
 * moving on is at least deterministic.
 *
 * `decodeURIComponent` throws `URIError` on a malformed escape - "theme=%" is
 * enough - and this runs on every request before anything renders. An unhandled
 * throw is a 500 on every page for anyone holding a corrupt cookie, which they
 * cannot clear, because the site never loads far enough to offer them the
 * settings panel. A cookie that cannot be read means "no preference", so the
 * failure returns null rather than continuing to look: a header that has
 * already been mangled is not a header to keep trusting.
 */
export function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    // A segment with no "=" is not a cookie. Skipping rather than treating the
    // whole segment as a name keeps "a; theme=dark" readable.
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * One year. A reading preference is not sensitive and re-asking is pure
 * friction - the reader who set it did so on the device they read on, and that
 * device is the only place it means anything.
 */
export const PREFERENCE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * A `Set-Cookie` value for a preference.
 *
 * No `Secure`, because the site is reachable over plain HTTP on a local network
 * and a preference that silently fails to stick there is worse than one an
 * attacker on the wire could read. No `HttpOnly`, because there is nothing to
 * protect and the offline script has legitimate reason to look. No `Domain`, so
 * it stays on the exact host that set it. `SameSite=Lax` because the only thing
 * that ever sets one is a link the reader followed on this site.
 *
 * The value is not encoded. Every caller passes a member of a closed enum whose
 * ids are constrained to be URL-safe, and encoding here would only make the
 * header harder to read in a test failure.
 */
export function preferenceCookie(name: string, value: string): string {
  return `${name}=${value}; Path=/; Max-Age=${PREFERENCE_MAX_AGE}; SameSite=Lax`;
}
