import { defineHandler } from "nitro/h3";
import { conditionalResponse } from "~/http";
import { OPENSEARCH_TYPE } from "~/opds/atom";
import { openSearchDescription } from "~/opds/opensearch";
import { originVary, resolveBase } from "~/opds/origin";

/**
 * `GET /opds/opensearch.xml` - the document the catalogue's `rel="search"` link
 * points at.
 *
 * Cached for a day rather than the five minutes the feeds get. This describes
 * the shape of the search interface, not its contents: it changes when the
 * software changes, and a reader that re-reads it on every search is spending a
 * round trip to be told the same thing.
 *
 * It gets an entity tag anyway, and it is the cheapest one in the codebase to
 * justify: this document changes only when the software or the origin does, so
 * once a day for the rest of a reader's life the revalidation is a 304 over a
 * few hundred bytes. It builds its own response rather than going through
 * `feedResponse` because it is not an Atom feed and has no `AtomFeed` to render.
 */
export default defineHandler((event) => {
  const headers: Record<string, string> = {
    "content-type": `${OPENSEARCH_TYPE}; charset=utf-8`,
    "cache-control": "public, max-age=86400",
  };

  const vary = originVary();
  if (vary) headers.vary = vary;

  return conditionalResponse(event, openSearchDescription(resolveBase(event)), headers);
});
