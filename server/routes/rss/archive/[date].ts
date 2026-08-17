import { HTTPError, defineHandler } from "nitro/h3";
import { listEditions } from "~/core/edition";
import { editionChannel } from "~/rss/channel";
import { resolveBase } from "~/opds/origin";
import { EDITION_CACHE, rssResponse } from "~/rss/respond";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `GET /rss/archive/<YYYY-MM-DD>` - one edition, with full text.
 *
 * The path mirrors `/opds/archive/<date>` and `/archive/<date>` on purpose: the
 * same edition under three representations, reachable by prefixing the page
 * path. Nothing here has to be discovered, only spelled.
 *
 * Unknown dates 404 rather than returning an empty channel. That is the
 * opposite of the decision at `/rss`, and for the opposite reason: an empty
 * site feed means "nothing yet", while an empty dated feed means the date is
 * wrong, and answering 200 would have a reader cache a day that never existed.
 */
export default defineHandler((event) => {
  const date = event.context.params?.date ?? "";
  if (!DATE.test(date)) {
    throw new HTTPError({ status: 400, message: "Expected a YYYY-MM-DD date" });
  }
  const known = listEditions(1000).some((e) => e.date === date);
  if (!known) {
    throw new HTTPError({ status: 404, message: `No edition for ${date}` });
  }
  return rssResponse(event, editionChannel(date, resolveBase(event)), EDITION_CACHE);
});
