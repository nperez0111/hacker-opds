/**
 * Response helpers shared by the OPDS routes.
 *
 * Handlers return a real `Response` rather than mutating `event.res`, because
 * the content type carries profile parameters that must survive verbatim and
 * returning the object makes that unambiguous.
 */
import { renderFeed, type AtomFeed } from "~/opds/atom";

/**
 * Feeds are cheap to regenerate and reflect mutable state (new editions, new
 * builds), so they get a short cache window rather than the immutable policy
 * used for artifacts.
 */
const FEED_CACHE = "public, max-age=300, must-revalidate";

export function feedResponse(feed: AtomFeed, contentType: string): Response {
  return new Response(renderFeed(feed), {
    headers: {
      "content-type": `${contentType}; charset=utf-8`,
      "cache-control": FEED_CACHE,
    },
  });
}
