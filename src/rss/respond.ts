/**
 * Response helpers for the RSS routes.
 *
 * Split from `~/opds/respond` because both halves of the answer genuinely
 * differ - the caching policy and the conditional-request handling - and
 * folding them together would hide that.
 *
 * The conditional part is not decoration. An OPDS feed is a list of titles and
 * links, a few kilobytes; an RSS feed here is fifty complete articles, which is
 * close to a megabyte. Feed readers poll on their own schedule and many ignore
 * `Cache-Control` entirely, so without an entity tag every reader pulls the
 * whole thing down every time, on a device that is usually on a phone hotspot.
 * With one, an unchanged feed costs a 304 and no body.
 */
import type { H3Event } from "nitro/h3";
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

/**
 * Entity tag over the rendered bytes.
 *
 * Derived from the body rather than from `lastBuild` because the body can move
 * while the newest story does not: an EPUB finishing its build adds an
 * enclosure to an item without changing any timestamp in the feed. A reader
 * holding the enclosure-less copy has to be told it is stale.
 *
 * Half a sha256 is 128 bits, which is comfortably beyond accidental collision
 * and keeps the header short.
 */
function entityTag(body: string): string {
  return `"${new Bun.CryptoHasher("sha256").update(body).digest("hex").slice(0, 32)}"`;
}

export function rssResponse(
  event: H3Event,
  channel: RssChannel,
  cacheControl: string,
): Response {
  const body = renderRss(channel);
  const etag = entityTag(body);

  const headers: Record<string, string> = {
    "content-type": `${RSS_TYPE}; charset=utf-8`,
    "cache-control": cacheControl,
    etag,
    // HTTP dates are IMF-fixdate and must be GMT, which is not the RFC 822
    // form with a numeric offset that goes inside the feed. Same instant,
    // different spelling, and a reader that gets the offset form here will
    // either ignore the header or fail to parse it.
    "last-modified": new Date(channel.lastBuild * 1000).toUTCString(),
  };

  // Only If-None-Match. If-Modified-Since is deliberately not honoured: the
  // enclosure case above means the feed can change while its timestamp does
  // not, and answering 304 to a date comparison would freeze a reader on a copy
  // with no books in it.
  if (event.req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(body, { headers });
}
