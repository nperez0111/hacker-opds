/**
 * Turns database rows into OPDS feeds.
 *
 * Kept separate from the route handlers so the feed shape can be tested
 * without standing up an HTTP server.
 */
import { config } from "~/config";
import { bookAuthor, getEditionStories, listEditions, type StoryRow } from "~/core/edition";
import {
  ACQUISITION_TYPE,
  EPUB_TYPE,
  NAVIGATION_TYPE,
  OPENSEARCH_TYPE,
  REL,
  rfc3339,
  type AtomEntry,
  type AtomFeed,
  type AtomLink,
} from "~/opds/atom";
import { OPENSEARCH_PATH, OPENSEARCH_RESULTS_PATH } from "~/opds/opensearch";
import type { SearchResults } from "~/search/query";

const HN_ITEM = "https://news.ycombinator.com/item?id=";

/**
 * Absolute URL for `path`, which must start with a slash.
 *
 * `base` is threaded in from the request by the route handlers (see
 * `~/opds/origin`) so the catalogue advertises an origin the reader can
 * actually reach. It falls back to the configured value for callers outside a
 * request, such as tests.
 */
export function absUrl(path: string, base: string = config().publicBaseUrl): string {
  return `${base}${path}`;
}

/**
 * Feed and entry ids are `urn:` values rather than URLs.
 *
 * OPDS clients use the id for deduplication across refreshes. Deriving it from
 * the public base URL would make every subscription break the moment the
 * deployment moves to a real domain.
 */
export function feedId(suffix: string): string {
  return `urn:hacker-opds:${suffix}`;
}

/**
 * Entry id for a story.
 *
 * Deliberately the same URN the EPUB carries as its `dc:identifier`. A reader
 * that has already downloaded the book can then correlate the catalogue entry
 * with the file on disk; two different namespaces for the same object would
 * defeat that.
 */
export function storyEntryId(storyId: number): string {
  return `urn:hn:story:${storyId}`;
}

/**
 * Atom demands an RFC 3339 string, but callers hold whatever the database gave
 * them - a unix timestamp, a `Date`, or a bare `YYYY-MM-DD`. Normalising here
 * keeps that coercion out of every call site.
 */
function stamp(value: Date | number | string): string {
  if (typeof value !== "string") return rfc3339(value);
  const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  return Number.isNaN(parsed.getTime()) ? value : rfc3339(parsed);
}

/**
 * The one-line summary of a story: score, discussion size, source, submitter.
 *
 * Shared with the RSS feed so a story reads the same in a catalogue entry and
 * in a feed item rather than being described twice, differently.
 */
export function storyFacts(story: StoryRow): string {
  return [
    `${story.points} points`,
    `${story.num_comments} comments`,
    story.domain ? `on ${story.domain}` : null,
    story.author ? `submitted by ${story.author}` : null,
  ]
    .filter(Boolean)
    .join(" \u00b7 ");
}

const PNG_TYPE = "image/png";

/**
 * The cover pair every entry carries.
 *
 * OPDS has two image relations and readers use them differently: `thumbnail`
 * is what a grid draws, `image` is what a detail view or a download shows. A
 * catalogue that only emits `image` makes a reader pull thirty full-size covers
 * to draw them at 120px, which on an e-reader's radio is the difference between
 * a list that appears and a list that spins.
 */
function coverLinks(path: string, base?: string): AtomLink[] {
  return [
    { rel: REL.image, href: absUrl(`${path}.png`, base), type: PNG_TYPE },
    { rel: REL.thumbnail, href: absUrl(`${path}.thumb.png`, base), type: PNG_TYPE },
  ];
}

/** One acquisition entry per story. */
export function storyEntry(story: StoryRow, base?: string): AtomEntry {
  const links: AtomLink[] = [
    {
      rel: REL.acquisition,
      href: absUrl(`/epub/story/${story.id}.epub`, base),
      type: EPUB_TYPE,
      title: "Download EPUB",
    },
    ...coverLinks(`/cover/story/${story.id}`, base),
    {
      rel: REL.alternate,
      href: `${HN_ITEM}${story.id}`,
      type: "text/html",
      title: "Hacker News discussion",
    },
  ];

  if (story.url) {
    links.push({
      rel: REL.alternate,
      href: story.url,
      type: "text/html",
      title: "Original article",
    });
  }

  return {
    id: storyEntryId(story.id),
    title: story.title,
    // Ranking is settled before an edition is built, so the story's own
    // submission time is the honest `updated` value and keeps the feed stable
    // across refreshes.
    updated: rfc3339(story.created_at_i),
    published: rfc3339(story.created_at_i),
    authors: [bookAuthor(story)],
    summary: storyFacts(story),
    categories: story.domain ? [story.domain] : undefined,
    links,
  };
}

/** Root navigation feed: the entry point a reader subscribes to. */
export function rootFeed(updatedAt: Date | number | string, base?: string): AtomFeed {
  const updated = stamp(updatedAt);
  return {
    id: feedId("root"),
    title: "Hacker News",
    subtitle: "Top stories of the day, with comments, as EPUB",
    updated,
    author: { name: "hacker-opds", uri: absUrl("", base) },
    links: [
      { rel: REL.self, href: absUrl("/opds", base), type: NAVIGATION_TYPE },
      { rel: REL.start, href: absUrl("/opds", base), type: NAVIGATION_TYPE },
      // Search is advertised as a link, not as an entry. A reader turns this
      // into a search box in its own chrome; an entry would be a row in the
      // catalogue that cannot be opened without terms to open it with.
      {
        rel: REL.search,
        href: absUrl(OPENSEARCH_PATH, base),
        type: OPENSEARCH_TYPE,
        title: "Search",
      },
    ],
    entries: [
      {
        id: feedId("nav:today"),
        title: "Today",
        updated,
        summary: "The most recent edition.",
        links: [
          { rel: "subsection", href: absUrl("/opds/today", base), type: ACQUISITION_TYPE },
        ],
      },
      {
        id: feedId("nav:archive"),
        title: "Archive",
        updated,
        summary: "Past editions by date.",
        links: [
          { rel: "subsection", href: absUrl("/opds/archive", base), type: NAVIGATION_TYPE },
        ],
      },
    ],
  };
}

/**
 * Entry id for an edition digest.
 *
 * The same URN the digest EPUB carries as its `dc:identifier`, for the reason
 * given on `storyEntryId`: one namespace for one object.
 */
export function editionEntryId(date: string): string {
  return `urn:hn:edition:${date}`;
}

/**
 * The digest entry: the whole day as one download.
 *
 * It leads the edition feed rather than trailing it, because a reader plugged
 * in to collect the day wants one row, and the thirty individual books below it
 * are the exception - someone who came for one story.
 */
export function editionDigestEntry(
  date: string,
  stories: StoryRow[],
  base?: string,
): AtomEntry {
  const cfg = config();
  const count = stories.length;
  const updated = rfc3339(
    stories.length ? Math.max(...stories.map((s) => s.created_at_i)) : new Date(`${date}T00:00:00Z`),
  );

  return {
    id: editionEntryId(date),
    title: `Complete edition \u2014 ${date}`,
    updated,
    published: rfc3339(new Date(`${date}T00:00:00Z`)),
    authors: ["Hacker News"],
    summary:
      `All ${count} ${count === 1 ? "story" : "stories"} of the day in one book, each with its ` +
      `article and discussion. Up to ${cfg.digestThreadsPerStory} threads per story, ` +
      `replies to depth ${cfg.digestCommentMaxDepth}.`,
    links: [
      {
        rel: REL.acquisition,
        href: absUrl(`/epub/edition/${date}.epub`, base),
        type: EPUB_TYPE,
        title: "Download EPUB",
      },
      ...coverLinks(`/cover/edition/${date}`, base),
    ],
  };
}

/** Acquisition feed for one edition. */
export function editionFeed(
  date: string,
  stories: StoryRow[],
  opts: { base?: string; selfPath?: string } = {},
): AtomFeed {
  const updated = stories.length
    ? rfc3339(Math.max(...stories.map((s) => s.created_at_i)))
    : rfc3339(new Date(`${date}T00:00:00Z`));

  const { base } = opts;
  // `/opds/today` serves the same edition under a different path. Its `self`
  // link has to be the path the reader actually requested, otherwise a client
  // that refreshes via `self` silently pins itself to one date and stops
  // following the latest edition.
  const selfPath = opts.selfPath ?? `/opds/archive/${date}`;

  return {
    id: feedId(`edition:${date}`),
    title: `Hacker News \u2014 ${date}`,
    subtitle: `${stories.length} stories`,
    updated,
    links: [
      { rel: REL.self, href: absUrl(selfPath, base), type: ACQUISITION_TYPE },
      { rel: REL.start, href: absUrl("/opds", base), type: NAVIGATION_TYPE },
      { rel: REL.up, href: absUrl("/opds/archive", base), type: NAVIGATION_TYPE },
    ],
    entries: stories.length
      ? [editionDigestEntry(date, stories, base), ...stories.map((s) => storyEntry(s, base))]
      : [],
  };
}

/** Navigation feed listing every edition held locally, newest first. */
export function archiveFeed(
  dates: string[],
  updatedAt: Date | number | string,
  base?: string,
): AtomFeed {
  return {
    id: feedId("archive"),
    title: "Archive",
    subtitle: "Past editions",
    updated: stamp(updatedAt),
    links: [
      { rel: REL.self, href: absUrl("/opds/archive", base), type: NAVIGATION_TYPE },
      { rel: REL.start, href: absUrl("/opds", base), type: NAVIGATION_TYPE },
      { rel: REL.up, href: absUrl("/opds", base), type: NAVIGATION_TYPE },
    ],
    entries: dates.map((date) => ({
      id: feedId(`nav:edition:${date}`),
      title: date,
      updated: rfc3339(new Date(`${date}T00:00:00Z`)),
      links: [
        {
          rel: "subsection",
          href: absUrl(`/opds/archive/${date}`, base),
          type: ACQUISITION_TYPE,
        },
      ],
    })),
  };
}

/**
 * Acquisition feed for a set of search results.
 *
 * Entries are the same `storyEntry` the edition feeds use, so a book found
 * through search has the same id, the same acquisition link and the same
 * metadata as the one found by browsing - which is what lets a reader that has
 * already downloaded it recognise the copy on its shelf instead of offering the
 * same file again.
 *
 * The feed is `updated` from the newest story in the result set rather than
 * from the clock. Results for a given query only change when the archive does,
 * and a wall-clock timestamp would tell every reader that every search it has
 * ever run has new content in it.
 */
export function searchFeed(results: SearchResults, base?: string): AtomFeed {
  const { query, hits, total, limit, offset } = results;
  const stories = hits.map(searchHitAsStory);

  const self = `${OPENSEARCH_RESULTS_PATH}?${searchQueryString(query, offset, limit)}`;
  const links: AtomLink[] = [
    { rel: REL.self, href: absUrl(self, base), type: ACQUISITION_TYPE },
    { rel: REL.start, href: absUrl("/opds", base), type: NAVIGATION_TYPE },
    { rel: REL.up, href: absUrl("/opds", base), type: NAVIGATION_TYPE },
    {
      rel: REL.search,
      href: absUrl(OPENSEARCH_PATH, base),
      type: OPENSEARCH_TYPE,
      title: "Search",
    },
  ];

  // Paging links, and only when there is somewhere to go. A rel="next" on the
  // last page makes a reader fetch an empty feed to find out it was the last
  // page, which on a device with a slow radio is a visible pause per search.
  if (offset + limit < total) {
    links.push({
      rel: REL.next,
      href: absUrl(
        `${OPENSEARCH_RESULTS_PATH}?${searchQueryString(query, offset + limit, limit)}`,
        base,
      ),
      type: ACQUISITION_TYPE,
    });
  }
  if (offset > 0) {
    links.push({
      rel: REL.prev,
      href: absUrl(
        `${OPENSEARCH_RESULTS_PATH}?${searchQueryString(query, Math.max(0, offset - limit), limit)}`,
        base,
      ),
      type: ACQUISITION_TYPE,
    });
  }

  const updated = stories.length
    ? rfc3339(Math.max(...stories.map((s) => s.created_at_i)))
    : rfc3339(new Date(0));

  return {
    // Percent-encoded, because an Atom id is an IRI and a raw query would put
    // spaces and quotes in one. Two different searches still get two different
    // ids, which is what a reader deduplicating its shelves needs.
    id: feedId(`search:${encodeURIComponent(query)}`),
    title: query ? `Search: ${query}` : "Search",
    subtitle: query
      ? `${total} ${total === 1 ? "result" : "results"} for ${query}`
      : "Enter a search term.",
    updated,
    links,
    // startIndex is 1-based in OpenSearch, unlike the offset in the URL.
    opensearch: { totalResults: total, startIndex: offset + 1, itemsPerPage: limit },
    entries: stories.map((s) => storyEntry(s, base)),
  };
}

function searchQueryString(query: string, offset: number, limit: number): string {
  const params = new URLSearchParams({ q: query });
  if (offset > 0) params.set("offset", String(offset));
  params.set("limit", String(limit));
  return params.toString();
}

/**
 * A search hit as a `StoryRow`, so it can go through `storyEntry` unchanged.
 *
 * Every field `storyEntry` reads comes straight from the hit. The two that are
 * filled in here - `rank` and `story_text` - are the ones a search does not
 * select, because nothing in an entry uses them: rank belongs to an edition,
 * which a result set spans, and the self-post body would be a kilobyte per row
 * fetched to be discarded.
 */
function searchHitAsStory(hit: SearchResults["hits"][number]): StoryRow {
  return {
    id: hit.id,
    edition_date: hit.edition_date,
    rank: 0,
    title: hit.title,
    url: hit.url,
    domain: hit.domain,
    author: hit.author,
    points: hit.points,
    num_comments: hit.num_comments,
    created_at_i: hit.created_at_i,
    story_text: null,
    is_text_post: hit.url ? 0 : 1,
  };
}

/** Convenience wrappers that read the database. */
export function buildEditionFeed(
  date: string,
  opts: { base?: string; selfPath?: string } = {},
): AtomFeed {
  return editionFeed(date, getEditionStories(date), opts);
}

export function buildArchiveFeed(base?: string): AtomFeed {
  const dates = listEditions().map((e) => e.date);
  const updated = dates[0]
    ? rfc3339(new Date(`${dates[0]}T00:00:00Z`))
    : rfc3339(new Date(0));
  return archiveFeed(dates, updated, base);
}
