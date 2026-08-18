import { defineHandler } from "nitro/h3";
import { searchStories } from "~/search/query";
import { Shell, pageAttrs } from "~/web/layout";
import { readPreferences } from "~/web/settings";
import { SearchView } from "~/web/views";

/**
 * `GET /search?q=...` - full-text search over titles and article text.
 *
 * Always 200, including for a query that matches nothing. A 404 would be a
 * claim about the URL, and this URL exists: the page renders the form, echoes
 * what was typed, and says that nothing matched. It is also what keeps the back
 * button and the browser's history sane on a device where retyping is slow.
 *
 * `no-cache` rather than a max-age. The page is a function of the query string
 * *and* of the index, which grows every night, so a cached copy is wrong the
 * next morning while still looking authoritative. The service worker is left
 * free to cache it - see the note on `isBypassed` in ~/web/sw.
 */
export default defineHandler((event) => {
  const prefs = readPreferences(event);

  const params = event.url.searchParams;
  const q = params.get("q") ?? "";
  const offset = params.get("offset");

  const results = searchStories(q, {
    offset: offset !== null && /^\d+$/.test(offset) ? Number(offset) : 0,
  });

  return (
    <html {...pageAttrs({ prefs, cacheControl: "no-cache" })}>
      <Shell
        title={results.query ? `Search: ${results.query}` : "Search"}
        prefs={prefs}
        path="/search"
        description="Search the Hacker News stories held in this archive."
      >
        <SearchView results={results} />
      </Shell>
    </html>
  );
});
