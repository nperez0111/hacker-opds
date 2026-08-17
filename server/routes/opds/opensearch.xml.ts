import { defineHandler } from "nitro/h3";
import { OPENSEARCH_TYPE } from "~/opds/atom";
import { openSearchDescription } from "~/opds/opensearch";
import { resolveBase } from "~/opds/origin";

/**
 * `GET /opds/opensearch.xml` - the document the catalogue's `rel="search"` link
 * points at.
 *
 * Cached for a day rather than the five minutes the feeds get. This describes
 * the shape of the search interface, not its contents: it changes when the
 * software changes, and a reader that re-reads it on every search is spending a
 * round trip to be told the same thing.
 */
export default defineHandler((event) => {
  return new Response(openSearchDescription(resolveBase(event)), {
    headers: {
      "content-type": `${OPENSEARCH_TYPE}; charset=utf-8`,
      "cache-control": "public, max-age=86400",
    },
  });
});
