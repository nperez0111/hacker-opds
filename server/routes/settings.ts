import { defineHandler } from "nitro/h3";
import { fontCookie, isFontId } from "~/web/fonts";
import { isTheme, safeReturnPath, themeCookie } from "~/web/theme";
import {
  isLineSpacing,
  isTextSize,
  lineSpacingCookie,
  textSizeCookie,
} from "~/web/type";

/**
 * `GET /settings?font=<id>&theme=<theme>&size=<id>&spacing=<id>&to=<path>`
 *
 * The write half of the settings panel. Every option in the panel is a link
 * here; this sets the cookie and sends the reader back to where they were.
 *
 * A GET that mutates state is normally a mistake. The same trade is made here
 * as in `/theme`, for the same reason: the alternative is a form POST, several
 * e-ink browsers handle those poorly, and the blast radius is one cookie
 * holding one value from a closed enum. The links are `rel="nofollow"` so a
 * crawler does not spend its budget cycling a preference it discards.
 *
 * 303 rather than 302, so the response to the redirect is unambiguously a GET,
 * and `no-store` so an intermediary never replays a stale `Set-Cookie`.
 *
 * Every parameter is optional and independent: the panel sets one at a time,
 * but a bookmarked link that sets all four works. An unrecognised value is
 * dropped silently rather than echoed anywhere - the redirect target does not
 * carry it, no cookie is written for it, and no error page repeats it back.
 */
export default defineHandler((event) => {
  const params = new URL(event.req.url).searchParams;

  /*
   * The only untrusted value that reaches a header. `safeReturnPath` is shared
   * with `/theme` rather than reimplemented, because an open-redirect check
   * that exists in two places is an open-redirect check that will disagree with
   * itself eventually.
   */
  const headers = new Headers({
    location: safeReturnPath(params.get("to")),
    "cache-control": "no-store",
  });

  /*
   * `append`, not `set`: two preferences means two `Set-Cookie` headers, and
   * `set` would leave only the last one.
   */
  const font = params.get("font");
  if (font !== null && isFontId(font)) {
    headers.append("set-cookie", fontCookie(font));
  }

  const theme = params.get("theme");
  if (theme !== null && isTheme(theme)) {
    headers.append("set-cookie", themeCookie(theme));
  }

  const size = params.get("size");
  if (size !== null && isTextSize(size)) {
    headers.append("set-cookie", textSizeCookie(size));
  }

  const spacing = params.get("spacing");
  if (spacing !== null && isLineSpacing(spacing)) {
    headers.append("set-cookie", lineSpacingCookie(spacing));
  }

  return new Response(null, { status: 303, headers });
});
