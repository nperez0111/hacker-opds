/**
 * Response helpers for the RSS routes.
 *
 * Still split from `~/opds/respond`, but the reason has narrowed. Both used to
 * differ in two ways - the caching policy and the conditional handling - and
 * only the first is still true. The conditional half now lives in `~/http`,
 * because it turned out to be the same answer to the same question and keeping
 * two copies meant two entity tags that could drift apart in length, in quoting
 * or in what a 304 carries.
 *
 * What remains here is the policy and the one header the format adds. The size
 * argument is why this feed got the treatment first: an OPDS feed is a list of
 * titles and links, a few kilobytes; an RSS feed here is fifty complete
 * articles, close to a megabyte. Feed readers poll on their own schedule and
 * many ignore `Cache-Control` entirely, so without an entity tag every reader
 * pulls the whole thing down every time, on a device that is usually on a phone
 * hotspot.
 */
import type { H3Event } from "nitro/h3";

import { conditionalResponse } from "~/http";
import { originVary } from "~/opds/origin";
import { renderRss, RSS_TYPE, type RssChannel } from "~/rss/rss";

/**
 * The site feed changes whenever an edition lands, which is once a day at an
 * hour nobody polling can predict. Five minutes matches the OPDS feeds and is
 * short enough that a reader checking in the morning gets that night's
 * edition; `must-revalidate` keeps a proxy from extending it.
 */
export const LATEST_CACHE = "public, max-age=300, must-revalidate";

/**
 * A dated edition is finished: the stories in it are fixed, and this matches
 * the day-long policy the HTML page for the same edition already uses.
 *
 * The one thing that can still change is enclosures - a story whose EPUB has
 * not been built yet has none, and gains one later. That is why this is a day
 * rather than the year the EPUBs themselves get: a subscriber to a fresh
 * edition picks up the books within a day, and in the meantime the items still
 * carry the whole article, which is the part that matters.
 */
export const EDITION_CACHE = "public, max-age=86400";

export function rssResponse(
  event: H3Event,
  channel: RssChannel,
  cacheControl: string,
): Response {
  const headers: Record<string, string> = {
    "content-type": `${RSS_TYPE}; charset=utf-8`,
    "cache-control": cacheControl,
    // HTTP dates are IMF-fixdate and must be GMT, which is not the RFC 822
    // form with a numeric offset that goes inside the feed. Same instant,
    // different spelling, and a reader that gets the offset form here will
    // either ignore the header or fail to parse it.
    //
    // Advertised, never honoured - see the note on `conditionalResponse`. The
    // enclosure case above is exactly why: this feed can change while
    // `lastBuild` stands still.
    "last-modified": new Date(channel.lastBuild * 1000).toUTCString(),
  };

  const vary = originVary();
  if (vary) headers.vary = vary;

  return conditionalResponse(event, renderRss(channel), headers);
}
