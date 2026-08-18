/**
 * Response helpers shared by the OPDS routes.
 *
 * Handlers return a real `Response` rather than mutating `event.res`, because
 * the content type carries profile parameters that must survive verbatim and
 * returning the object makes that unambiguous.
 *
 * ## Why these feeds are worth an entity tag
 *
 * A catalogue feed is a few kilobytes, so the saving per request is small next
 * to what the same machinery does for RSS. What it saves is not bandwidth, it is
 * the polling. An OPDS reader on an e-reader refreshes the root and the archive
 * every time the catalogue is opened, and the archive feed is one navigation
 * entry per edition - a list that grows without bound and changes once a day.
 * Every one of those refreshes currently rebuilds and resends a list the device
 * already has, on a radio the device turned on to do it.
 *
 * The bodies are stable enough for this to work, and that is not luck: nothing
 * in `~/opds/atom` or `~/opds/catalog` reads the clock. Every `updated` is
 * derived from the newest story, the edition's own date, or the epoch, which was
 * already a deliberate decision - a wall-clock timestamp would tell every reader
 * that every search it had ever run had new results in it.
 */
import type { H3Event } from "nitro/h3";

import { conditionalResponse } from "~/http";
import { renderFeed, type AtomFeed } from "~/opds/atom";
import { originVary } from "~/opds/origin";

/**
 * Feeds are cheap to regenerate and reflect mutable state (new editions, new
 * builds), so they get a short cache window rather than the immutable policy
 * used for artifacts. Five minutes is short enough that a reader checking in
 * the morning gets that night's edition; `must-revalidate` keeps a proxy from
 * extending it.
 */
export const FEED_CACHE = "public, max-age=300, must-revalidate";

/**
 * A dated edition is finished: its stories are fixed, and the HTML and RSS
 * versions of the same edition already use this policy.
 *
 * The one thing that can still move is the acquisition links - a story whose
 * EPUB has not been built yet is served from the digest alone, and gains its own
 * download later. That is why this is a day rather than the year the EPUBs
 * themselves get, and why the entity tag matters more here than the max-age
 * does: a reader who revalidates picks up the books as soon as they exist.
 */
export const EDITION_CACHE = "public, max-age=86400";

/**
 * Renders a feed and answers 304 when the reader already has these bytes.
 *
 * The event is the first parameter rather than an option because it is not
 * optional: a route that forgets it cannot compile, where a route that forgets
 * an optional argument silently opts out of conditional handling and nobody
 * notices until a month of feed traffic has gone out over full bodies.
 */
export function feedResponse(
  event: H3Event,
  feed: AtomFeed,
  contentType: string,
  cacheControl: string = FEED_CACHE,
): Response {
  const headers: Record<string, string> = {
    "content-type": `${contentType}; charset=utf-8`,
    "cache-control": cacheControl,
  };

  const vary = originVary();
  if (vary) headers.vary = vary;

  return conditionalResponse(event, renderFeed(feed), headers);
}
