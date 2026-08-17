import { defineHandler } from "nitro/h3";
import { latestChannel } from "~/rss/channel";
import { resolveBase } from "~/opds/origin";
import { LATEST_CACHE, rssResponse } from "~/rss/respond";

/**
 * `GET /rss` - the most recent stories across every edition, with full text.
 *
 * The base URL comes from the request unless one is configured, for the same
 * reason the OPDS catalogue does it (`~/opds/origin`): every URL in a feed is
 * consumed somewhere else, and `localhost` on the reader is the reader.
 *
 * Unlike `/opds/today`, an empty feed is served as an empty feed rather than a
 * 404. The two client populations behave differently: an OPDS reader shown an
 * empty catalogue caches it and stops asking, while a feed reader polls its
 * subscriptions on a schedule regardless of how many items it saw last time. A
 * 404 here would instead make the subscription itself fail to be created, which
 * on a fresh deployment is the one moment someone is likely to be adding it.
 */
export default defineHandler((event) => {
  return rssResponse(event, latestChannel(resolveBase(event)), LATEST_CACHE);
});
