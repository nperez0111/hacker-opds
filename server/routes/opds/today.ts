import { HTTPError, defineHandler } from "nitro/h3";
import { latestEdition } from "~/core/edition";
import { ACQUISITION_TYPE } from "~/opds/atom";
import { buildEditionFeed } from "~/opds/catalog";
import { resolveBase } from "~/opds/origin";
import { feedResponse } from "~/opds/respond";

export default defineHandler((event) => {
  const date = latestEdition();
  if (!date) {
    // Nothing ingested yet. A 404 is more honest than an empty feed, which
    // readers cache and then stop polling.
    throw new HTTPError({ status: 404, message: "No editions available yet" });
  }
  // `selfPath` stays `/opds/today` rather than the dated path, so a reader that
  // refreshes through its `self` link keeps tracking the latest edition instead
  // of pinning itself to whatever date it first saw.
  const feed = buildEditionFeed(date, {
    base: resolveBase(event),
    selfPath: "/opds/today",
  });
  return feedResponse(feed, ACQUISITION_TYPE);
});
