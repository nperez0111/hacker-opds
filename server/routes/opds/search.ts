import { defineHandler } from "nitro/h3";
import { ACQUISITION_TYPE } from "~/opds/atom";
import { searchFeed } from "~/opds/catalog";
import { resolveBase } from "~/opds/origin";
import { feedResponse } from "~/opds/respond";
import { searchStories } from "~/search/query";

/**
 * `GET /opds/search?q=...` - the acquisition feed an OpenSearch client lands on.
 *
 * An empty or unsearchable `q` answers with an empty feed rather than a 404.
 * Readers probe this URL: some fetch the template with no terms substituted
 * while they are adding the catalogue, and a 404 there is remembered as "search
 * is broken" long after the reader has typed something real.
 *
 * `limit` and `offset` are honoured because this feed publishes its own paging
 * links and they have to round-trip. Both are clamped in the query layer, so a
 * hand-edited URL asking for ten thousand results gets a page of the maximum
 * size instead of an expensive scan.
 */
export default defineHandler((event) => {
  const params = event.url.searchParams;
  const q = params.get("q") ?? "";

  const results = searchStories(q, {
    limit: numberParam(params.get("limit")),
    offset: numberParam(params.get("offset")),
  });

  return feedResponse(searchFeed(results, resolveBase(event)), ACQUISITION_TYPE);
});

/** Undefined for anything that is not a plain non-negative integer. */
function numberParam(raw: string | null): number | undefined {
  if (raw === null || !/^\d+$/.test(raw)) return undefined;
  return Number(raw);
}
