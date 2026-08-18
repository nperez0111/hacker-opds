import { defineHandler } from "nitro/h3";
import { latestEdition } from "~/core/edition";
import { NAVIGATION_TYPE, rfc3339 } from "~/opds/atom";
import { rootFeed } from "~/opds/catalog";
import { resolveBase } from "~/opds/origin";
import { feedResponse } from "~/opds/respond";

export default defineHandler((event) => {
  const date = latestEdition();
  const updated = date
    ? rfc3339(new Date(`${date}T00:00:00Z`))
    : rfc3339(new Date(0));
  return feedResponse(event, rootFeed(updated, resolveBase(event)), NAVIGATION_TYPE);
});
