/**
 * `GET /favicon.ico` - the icon nobody asks the HTML about.
 *
 * Every page links its icons explicitly, with hashed URLs under `/assets/`, and
 * that is the path a browser rendering the page will take. This route is for
 * everything that never renders the page: a browser restoring a tab from
 * session history, a feed reader drawing a subscription list, a chat client
 * unfurling a link, a bookmark manager. All of them request `/favicon.ico` at
 * the site root, and a 404 there is a site that shows a blank square in a list
 * of sites that do not.
 *
 * ## Bytes rather than a redirect
 *
 * A 301 to the hashed URL would be tidier - one copy of the caching policy, one
 * canonical URL - and it is the wrong trade twice over. It costs a second round
 * trip, which on the radio this site is written for is the expensive part of
 * the request rather than the 1.8 KB that follows. And favicon fetchers are the
 * least conformant HTTP clients in service: several historically did not follow
 * redirects for icons at all, and one that does not gets nothing. Serving the
 * bytes here is a re-export of an in-memory buffer.
 *
 * ## Its cache policy is not the assets route's
 *
 * This URL cannot carry a content hash - it is fixed by convention - so the
 * bytes behind it *can* change, and it must be revalidated rather than frozen.
 * That is the same argument that keeps `sw.js` and the manifest mutable. The
 * ETag makes the revalidation cheap: a conditional request costs a 304 with no
 * body, and this handler answers it without touching the payload.
 *
 * `robots.txt.ts` is the precedent for a root-level non-HTML route.
 */
import { HTTPError, defineHandler } from "nitro/h3";
import { FAVICON_ICO_NAME, getWebAsset } from "~/web/assets";

export default defineHandler((event) => {
  const asset = getWebAsset(FAVICON_ICO_NAME);
  if (!asset) {
    // Unreachable while the icon is registered, and a 500 rather than a silent
    // empty response if a refactor ever unregisters it.
    throw new HTTPError({ status: 500, message: "favicon.ico is not registered" });
  }

  if (event.req.headers.get("if-none-match") === asset.etag) {
    return new Response(null, { status: 304, headers: { etag: asset.etag } });
  }

  return new Response(asset.body, {
    headers: {
      "content-type": asset.type,
      etag: asset.etag,
      // A day, matching robots.txt: long enough that nothing refetches an icon
      // on every visit, short enough that a redrawn mark reaches readers
      // without a cache purge.
      "cache-control": "public, max-age=86400, must-revalidate",
    },
  });
});
