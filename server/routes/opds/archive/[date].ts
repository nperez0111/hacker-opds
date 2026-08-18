import { HTTPError, defineHandler } from "nitro/h3";
import { listEditions } from "~/core/edition";
import { ACQUISITION_TYPE } from "~/opds/atom";
import { buildEditionFeed } from "~/opds/catalog";
import { resolveBase } from "~/opds/origin";
import { EDITION_CACHE, feedResponse } from "~/opds/respond";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export default defineHandler((event) => {
  const date = event.context.params?.date ?? "";
  if (!DATE.test(date)) {
    throw new HTTPError({ status: 400, message: "Expected a YYYY-MM-DD date" });
  }
  // Only serve editions we actually hold, so a typo returns 404 rather than an
  // empty feed that a reader will happily cache.
  const known = listEditions(1000).some((e) => e.date === date);
  if (!known) {
    throw new HTTPError({ status: 404, message: `No edition for ${date}` });
  }
  /*
   * A day, not the five minutes the browse feeds get, matching what the HTML
   * and RSS versions of this same edition already promise. The edition is
   * finished; the only thing still moving is which stories have EPUBs, and the
   * entity tag covers that for any reader that revalidates.
   */
  return feedResponse(
    event,
    buildEditionFeed(date, { base: resolveBase(event) }),
    ACQUISITION_TYPE,
    EDITION_CACHE,
  );
});
