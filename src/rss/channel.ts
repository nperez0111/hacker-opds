/**
 * Turns database rows into RSS channels.
 *
 * The counterpart of `~/opds/catalog`, and it borrows from it deliberately:
 * `absUrl` for link construction, `storyEntryId` for the identifier, and
 * `storyFacts` for the summary. A story therefore carries the same id and the
 * same one-line description whether a reader meets it through OPDS or through
 * RSS.
 *
 * What is different is the payload. An OPDS entry advertises a book to
 * download; an RSS item *is* the article. `content:encoded` carries the whole
 * extracted body, because a feed reader on an e-ink device is often the only
 * thing that will ever render it - the point is not to tempt the reader back to
 * a website they cannot comfortably load.
 */
import { readyStoryEpubBytes } from "~/build/artifacts";
import { config } from "~/config";
import {
  bookAuthor,
  getEditionStories,
  recentStories,
  type StoryRow,
} from "~/core/edition";
import { getArticle, type ArticleRecord } from "~/core/extract";
import { snippet } from "~/epub/render";
import { xmlEscape } from "~/epub/xhtml";
import { EPUB_TYPE } from "~/opds/atom";
import { absUrl, storyEntryId, storyFacts } from "~/opds/catalog";
import { articleHtml, HN_ITEM } from "~/web/story";
import { SITE_NAME } from "~/web/layout";
import { rfc822, type RssChannel, type RssItem } from "~/rss/rss";

/** Where the RSS surface lives. Kept here so routes and links cannot drift. */
export const RSS_LATEST_PATH = "/rss";
export const rssEditionPath = (date: string): string => `/rss/archive/${date}`;

/** Length of the plain-text `<description>`. Two lines in a reader's list. */
const SUMMARY_CHARS = 280;

/**
 * The trailer appended to every item body.
 *
 * A feed item is read in isolation, frequently offline, and the article text
 * that precedes this is someone else's work with no obvious way back to where
 * it came from. These three links are that way back: the original, the
 * discussion, and - when it exists - the book. Nothing else is added to the
 * body; the metadata belongs in the item's own elements.
 */
function sourceTrailer(story: StoryRow, epubUrl: string | null): string {
  const parts: string[] = [];

  if (story.url) {
    parts.push(
      `<a href="${xmlEscape(story.url)}">Read the original` +
        `${story.domain ? ` on ${xmlEscape(story.domain)}` : ""}</a>`,
    );
  }
  parts.push(
    `<a href="${xmlEscape(HN_ITEM + story.id)}">Hacker News discussion</a>`,
  );
  if (epubUrl) {
    parts.push(`<a href="${xmlEscape(epubUrl)}">Download EPUB</a>`);
  }

  return `<hr /><p>${parts.join(" \u00b7 ")}</p>`;
}

/**
 * One item per story.
 *
 * `articleHtml` is the website's renderer, reused rather than reimplemented.
 * That buys two things: the body is the already-sanitised, already-absolutised
 * `articles.xhtml` (see below), and a story whose extraction failed produces
 * the same honest stub in the feed as it does on the page, instead of an item
 * with an empty body that a reader files as a broken article.
 *
 * `articles.xhtml` rather than `articles.markdown`, and it is not close. The
 * XHTML was sanitised through a conservative allow-list and had every relative
 * href and img src made absolute at extraction time, which is precisely what a
 * feed body needs: it will be rendered far from this origin, by a client that
 * will not resolve relative URLs against the article's own site. It is also
 * already well-formed XML, so nesting it inside an XML document cannot go
 * wrong. The markdown column exists for search indexing and for humans; no feed
 * reader renders markdown, so shipping it would mean shipping raw asterisks.
 */
export function storyItem(
  story: StoryRow,
  article: ArticleRecord | null,
  epubBytes: number | undefined,
  base?: string,
): RssItem {
  const epubUrl = epubBytes === undefined ? null : absUrl(`/epub/story/${story.id}.epub`, base);

  const body = articleHtml(story, article);
  const text = article?.xhtml ? snippet(article.xhtml, SUMMARY_CHARS) : "";

  return {
    title: story.title,
    // The story's page on this site, not the original article. The item body
    // is already this site's rendering of that article, so pointing `link`
    // anywhere else would make "open in browser" show something other than
    // what the reader just read - and the page adds the comment tree. The
    // original is credited in the trailer and in `rel="canonical"` on the page
    // itself.
    link: absUrl(`/story/${story.id}`, base),
    guid: storyEntryId(story.id),
    pubDate: rfc822(story.created_at_i),
    creator: bookAuthor(story),
    categories: story.domain ? [story.domain] : undefined,
    comments: `${HN_ITEM}${story.id}`,
    // Prefer the article's own opening over the metadata line: a reader
    // scanning the list wants to know what the piece says. The facts are the
    // fallback for a story whose extraction produced nothing to quote.
    description: text || storyFacts(story),
    content: body + sourceTrailer(story, epubUrl),
    ...(epubUrl && epubBytes !== undefined
      ? { enclosure: { url: epubUrl, length: epubBytes, type: EPUB_TYPE } }
      : {}),
  };
}

/**
 * Items for a set of stories, with one query for the articles and one for the
 * build ledger rather than two per story.
 */
function itemsFor(stories: StoryRow[], base?: string): RssItem[] {
  const sizes = readyStoryEpubBytes(stories.map((s) => s.id));
  return stories.map((story) =>
    storyItem(story, getArticle(story.id), sizes.get(story.id), base),
  );
}

/**
 * The channel's build time, from the newest item and never from the clock.
 *
 * Editions are immutable once built, so a feed that reports "now" every time it
 * is generated is lying, and it defeats the conditional polling a reader does
 * on a metered radio. With no items at all there is nothing to date, and the
 * epoch is the honest answer - the same fallback the OPDS root feed uses.
 */
function newestStamp(stories: StoryRow[]): number {
  if (stories.length === 0) return 0;
  return Math.max(...stories.map((s) => s.created_at_i));
}

/**
 * The site-wide feed: the most recent stories across every edition.
 *
 * Deliberately not "today's edition". An edition only closes six hours after
 * its day ends, so a feed pinned to the current edition would repeat itself for
 * a day and then jump; and a reader polling once a day on a device that is
 * asleep most of the time would have no slack at all. Spanning editions makes
 * the window a count of stories rather than a calendar accident.
 */
export function latestChannel(base?: string): RssChannel {
  const stories = recentStories(config().rssItemLimit);
  return {
    title: SITE_NAME,
    link: absUrl("/", base),
    description:
      "Top Hacker News stories, as readable articles with their discussions.",
    selfUrl: absUrl(RSS_LATEST_PATH, base),
    lastBuild: newestStamp(stories),
    items: itemsFor(stories, base),
  };
}

/**
 * One edition as a feed.
 *
 * Worth being clear about what this is for: an edition never gains a story, so
 * subscribing to one of these is subscribing to something that will never
 * update again. It exists so that a dated page has a machine-readable form -
 * hand it to a reader once and get that day's thirty articles - which is also
 * why the HTML page advertises the site feed ahead of it.
 */
export function editionChannel(date: string, base?: string): RssChannel {
  const stories = getEditionStories(date);
  return {
    title: `${SITE_NAME} \u2014 ${date}`,
    link: absUrl(`/archive/${date}`, base),
    description: `The top ${stories.length} Hacker News stories of ${date}.`,
    selfUrl: absUrl(rssEditionPath(date), base),
    lastBuild: newestStamp(stories),
    items: itemsFor(stories, base),
  };
}
