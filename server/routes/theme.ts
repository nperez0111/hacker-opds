import { defineHandler } from "nitro/h3";
import {
  nextTheme,
  readTheme,
  safeReturnPath,
  themeCookie,
} from "~/web/theme";

/**
 * `GET /theme?to=<path>`
 *
 * Theme switching without scripting, so it works on an e-reader browser that
 * has none. The link cycles auto -> dark -> light -> auto and redirects back
 * to the page you were on.
 *
 * A GET that mutates state is normally a mistake, but the alternative here is
 * a form POST, and several e-ink browsers handle those poorly. The blast
 * radius is one cookie holding one of three enum values, and the link is
 * marked `rel="nofollow"` so crawlers leave it alone.
 *
 * 303 rather than 302: the response to the redirect is unambiguously a GET,
 * and it is never cached.
 */
export default defineHandler((event) => {
  const to = safeReturnPath(new URL(event.req.url).searchParams.get("to"));
  const theme = nextTheme(readTheme(event));

  return new Response(null, {
    status: 303,
    headers: {
      location: to,
      "set-cookie": themeCookie(theme),
      "cache-control": "no-store",
    },
  });
});
