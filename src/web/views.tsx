/**
 * Page bodies.
 *
 * These are the `<main>` contents only. Routes own the literal `<html>`
 * element, because mono-jsx turns *only* a literal `<html>` in the returned
 * expression into a Response - a component that returns one yields an inert
 * VNode with no status and no headers.
 *
 * Everything here is server-rendered, static markup. No component holds state,
 * nothing is hydrated, and every interactive affordance is a link or a form
 * that works with scripting switched off. The service worker layers offline
 * caching on top; it is never load-bearing.
 */
import type { EditionSummary, StoryRow } from "~/core/edition";
import type { CommentRow } from "~/core/comments";
import type { ArticleRecord } from "~/core/extract";
import type { SearchResults } from "~/search/query";
import type { EditionSaveSize } from "~/web/size";
import { CACHE_MAX_AGE_DAYS } from "~/web/offline";
import {
  byteSize,
  editionHeading,
  longDate,
  plural,
  readingTime,
  relativeDay,
  shortDate,
  storyMetaParts,
  submittedAt,
} from "~/web/format";
import { HN_ITEM, articleByline, articleHtml, commentsHtml } from "~/web/story";

const DOT = " \u00b7 ";

/** The glyph the repo owner asked for, and the words that make it mean something. */
const SAVED_GLYPH = "\u2193";
const SAVED_LABEL = "Saved on this device";

/**
 * The marker on a story that is already in the offline cache.
 *
 * Server-rendered and shipped hidden, because whether a page is on the device
 * is knowable only from the Cache API and only in the browser. The page-side
 * script in `~/web/sw` finds these by their `data-saved-mark` attribute -
 * whose value is the URL to look up - and takes the `hidden` attribute off the
 * ones it finds. A reader with no worker, no Cache API or no scripting sees
 * nothing, which is correct: they have nothing saved.
 *
 * A bare arrow is meaningless to anyone who has not been told what it means,
 * so it carries its meaning three ways.
 *
 * `role="img"` with an `aria-label` is the accessible name. The alternative
 * was a visually hidden span beside an `aria-hidden` glyph, which is the older
 * idiom and was written first; it was replaced because `aria-label` on a
 * `role="img"` is the pattern that exists for exactly this - a glyph standing
 * in for a word - and because the span version was three elements and 190
 * bytes rather than one and 145, repeated thirty times on a page rendered by a
 * device where the DOM is the expensive part. Since the marker sits inside the
 * row's anchor, that name becomes part of the link's: a screen reader
 * announces the story and then says it is on the device, which is the whole
 * point.
 *
 * `title` is for the sighted reader who wondered what the arrow meant and
 * rested a pointer on it. It is not sufficient on its own - a title is
 * unreachable by touch, and an e-reader is a touch device - which is why the
 * edition page also prints the legend in words under the save button.
 */
function SavedMark(props: { href: string }) {
  return (
    <span
      class="saved"
      role="img"
      aria-label={SAVED_LABEL}
      title={SAVED_LABEL}
      data-saved-mark={props.href}
      hidden
    >
      {SAVED_GLYPH}
    </span>
  );
}

/**
 * One row of the story list.
 *
 * The whole row is a single anchor rather than a title link with metadata
 * beside it. An e-reader's touch layer is imprecise and its stylus optional,
 * so the target is the entire block - roughly 4x the area of the title alone.
 *
 * The marker is the row's third flex child rather than something appended to
 * the title, so it occupies a column of its own down the right edge of the
 * list. Inside the title it would reflow the headline when it appeared and
 * would be lost in the middle of a wrapped line; in a column it is scannable
 * from the top of the page, which is what a reader deciding what to open
 * offline is actually doing.
 */
function StoryRowItem(props: { story: StoryRow; index: number }) {
  const { story, index } = props;
  const href = `/story/${story.id}`;
  return (
    <li>
      <a class="story-link" href={href}>
        <span class="rank">{index + 1}</span>
        <span class="story-body">
          <span class="story-title">{story.title}</span>
          <span class="story-meta">{storyMetaParts(story).join(DOT)}</span>
        </span>
        <SavedMark href={href} />
      </a>
    </li>
  );
}

export interface EditionViewProps {
  date: string;
  today: string;
  stories: StoryRow[];
  /**
   * What the save button is about to spend, estimated from the database by
   * `~/web/size`. Required rather than optional: a button that asks for four
   * megabytes without saying so is the thing this exists to stop, and an
   * optional prop is a button that silently goes back to not saying so the
   * first time a new route forgets it.
   */
  save: EditionSaveSize;
  /** Present only on the front page, where "Today" needs an exact date under it. */
  subtitle?: string;
}

export function EditionView(props: EditionViewProps) {
  const { date, today, stories, save, subtitle } = props;
  const heading = editionHeading(date, today);
  // Handed to the service worker as a JSON array. With no worker registered the
  // button stays hidden by CSS, so this costs a disabled reader nothing.
  const saveUrls = JSON.stringify([
    `/archive/${date}`,
    ...stories.map((s) => `/story/${s.id}`),
  ]);

  return (
    <>
      <h1 class="page-title">{heading}</h1>
      <p class="page-sub">{subtitle ?? longDate(date)}</p>
      <p class="meta">
        {plural(stories.length, "story", "stories")}
      </p>

      {stories.length === 0 ? (
        <p class="empty">This edition has no stories yet.</p>
      ) : (
        <ol class="stories">
          {stories.map((story, i) => (
            <StoryRowItem story={story} index={i} />
          ))}
        </ol>
      )}

      {stories.length > 0 ? (
        <p class="actions">
          {/*
            The digest is offered before the offline button because it is the
            same errand done better: one file, read anywhere, no service worker
            and no browser involved once it is on the device.
          */}
          <a class="btn btn-primary" href={`/epub/edition/${date}.epub`}>
            Download this edition ({plural(stories.length, "story", "stories")}, EPUB)
          </a>
        </p>
      ) : null}

      {/*
        The label states the download, not the storage, and the note under it
        states both. Two different questions are being asked of that number -
        "can I afford this right now, on this radio" and "will this fill my
        reader" - and they differ by about 3.4x, because the reverse proxy
        compresses and the worker's fetch decodes transparently: what crosses
        the network is compressed and what lands in the cache is not. The one
        that belongs on the button is the one that decides whether to press it.

        "up to", because the worker skips whatever is already cached and every
        page opened has been cached as it was read, so the true cost is this
        number or less and never more.
      */}
      <p class="actions" data-offline-ui hidden>
        <button class="btn" type="button" data-save-edition={saveUrls}>
          Save the whole edition (up to {byteSize(save.wireBytes)})
        </button>
        <span class="meta" data-save-status></span>
      </p>
      <p class="offline-note" data-offline-ui hidden>
        Pages are saved as you open them; this fetches the rest and skips what
        is already here, about {byteSize(save.storageBytes)} on the device once
        all of it is. {SAVED_GLYPH} marks a story that is already saved. Saved
        pages are kept for {CACHE_MAX_AGE_DAYS} days.
      </p>
    </>
  );
}

export interface ArchiveViewProps {
  editions: EditionSummary[];
  today: string;
}

export function ArchiveView(props: ArchiveViewProps) {
  const { editions, today } = props;
  return (
    <>
      <h1 class="page-title">Archive</h1>
      <p class="page-sub">Every edition still in retention.</p>

      {editions.length === 0 ? (
        <p class="empty">No editions have been built yet.</p>
      ) : (
        <ul class="editions">
          {editions.map((edition) => (
            <li>
              <a class="edition-link" href={`/archive/${edition.date}`}>
                <span class="edition-date">
                  {[relativeDay(edition.date, today), shortDate(edition.date)]
                    .filter(Boolean)
                    .join(DOT)}
                </span>
                <span class="edition-count">
                  {plural(edition.story_count, "story", "stories")}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export interface StoryViewProps {
  story: StoryRow;
  article: ArticleRecord | null;
  threads: CommentRow[][];
  indentMaxDepth: number;
}

export function StoryView(props: StoryViewProps) {
  const { story, article, threads, indentMaxDepth } = props;
  const byline = articleByline(article);
  const words = article?.word_count ?? 0;
  const minutes = readingTime(words);
  const commentCount = threads.reduce((n, t) => n + t.length, 0);

  const facts = [
    plural(story.points, "point"),
    plural(commentCount, "comment"),
    minutes,
    submittedAt(story),
  ].filter((part): part is string => Boolean(part));

  return (
    <>
      {/* The id is the target of "Back to top" at the foot of the discussion.
          The page shell belongs to another module, so the story page anchors
          its own top rather than assuming one exists further out. */}
      <header class="story-head" id="top">
        <h1 class="page-title">{story.title}</h1>
        {byline.length > 0 ? <p class="page-sub">{byline.join(DOT)}</p> : null}
        <p class="meta">{facts.join(DOT)}</p>
        {/*
          The same marker as on the list, spelled out. There is room for words
          here and no legend nearby, so the glyph gets its meaning printed
          beside it rather than only in an accessible name - which also makes
          this the place a reader learns what the arrow in the list meant.
        */}
        <p class="meta saved-line" data-saved-mark={`/story/${story.id}`} hidden>
          <span class="saved-glyph" aria-hidden="true">
            {SAVED_GLYPH}
          </span>{" "}
          {SAVED_LABEL}
        </p>
        <p class="actions">
          <a class="btn btn-primary" href={`/epub/story/${story.id}.epub`}>
            Download EPUB
          </a>
          {story.url ? (
            <a class="btn" href={story.url} rel="noreferrer">
              Original
            </a>
          ) : null}
          {/* A plain fragment link: the one navigation primitive that works
              with scripting off, on every reader, with no reflow cost. An
              article can be twenty screens of e-ink page turns, and the
              discussion is often what the reader came for. */}
          <a class="btn jump" href="#comments">
            {commentCount > 0 ? `Comments (${commentCount})` : "Comments"}
          </a>
          <a class="btn" href={`${HN_ITEM}${story.id}`} rel="noreferrer">
            Discussion
          </a>
        </p>
      </header>

      <article class="article">{html(articleHtml(story, article))}</article>

      <section class="comments" id="comments">
        <h2>
          {commentCount > 0
            ? plural(commentCount, "comment")
            : "Comments"}
        </h2>
        {html(commentsHtml(story, threads, { indentMaxDepth }))}
        <p class="actions">
          <a class="btn jump" href="#top">
            Back to top
          </a>
        </p>
      </section>
    </>
  );
}

export interface SearchViewProps {
  results: SearchResults;
}

/** Path plus query string for a page of results at `offset`. */
function searchHref(query: string, offset: number): string {
  const params = new URLSearchParams({ q: query });
  if (offset > 0) params.set("offset", String(offset));
  return `/search?${params.toString()}`;
}

export function SearchView(props: SearchViewProps) {
  const { query, hits, total, limit, offset } = props.results;
  const first = offset + 1;
  const last = offset + hits.length;

  return (
    <>
      <h1 class="page-title">Search</h1>

      {/*
       * A plain GET form, and nothing else.
       *
       * No script, no autocomplete, no live results. On an e-reader every
       * keystroke that repaints the panel is a visible flash, and a browser
       * four major versions behind is a browser where a clever search box is a
       * dead search box. A GET form is also the only kind whose result has a
       * URL, which is what makes a search bookmarkable, shareable and cacheable
       * by the service worker.
       *
       * action is written out rather than left to default to the current URL:
       * submitting from /search?q=old would otherwise carry the old query
       * string forward as a hidden default.
       */}
      <form class="search-form" method="GET" action="/search" role="search">
        <label class="search-label" for="q">
          Search titles and article text
        </label>
        {/*
         * maxLength matches the ceiling the query layer imposes, so the field
         * cannot accept text that will be silently truncated on the server.
         * Autocomplete is left on: the browser's own history of what was typed
         * here before is worth a great deal on a device with an on-screen
         * keyboard, and it costs nothing.
         */}
        <input
          class="search-input"
          type="search"
          id="q"
          name="q"
          value={query}
          maxLength={256}
          enterKeyHint="search"
        />
        <button class="btn btn-primary" type="submit">
          Search
        </button>
      </form>

      {query === "" ? (
        <p class="meta">
          Comments are not indexed. Every result links to the story page, which
          has the discussion on it.
        </p>
      ) : total === 0 ? (
        <p class="empty">Nothing in the archive matches {query}.</p>
      ) : (
        <>
          <p class="meta">
            {total > hits.length
              ? `${first}\u2013${last} of ${plural(total, "result")}`
              : plural(total, "result")}
          </p>

          <ol class="stories">
            {hits.map((hit) => (
              <li>
                <a class="story-link" href={`/story/${hit.id}`}>
                  <span class="story-body">
                    <span class="story-title">{hit.title}</span>
                    <span class="story-meta">
                      {[
                        ...storyMetaParts({
                          domain: hit.domain,
                          is_text_post: hit.url ? 0 : 1,
                          points: hit.points,
                          num_comments: hit.num_comments,
                        }),
                        shortDate(hit.edition_date),
                      ].join(DOT)}
                    </span>
                    {hit.snippet ? (
                      <span class="story-snippet">{hit.snippet}</span>
                    ) : null}
                  </span>
                  {/* The same marker as the edition list. A search result is
                      the same destination reached another way, and a glyph
                      that means one thing on one list and nothing on another
                      is worse than no glyph. */}
                  <SavedMark href={`/story/${hit.id}`} />
                </a>
              </li>
            ))}
          </ol>

          {total > limit ? (
            <p class="actions">
              {offset > 0 ? (
                <a class="btn" href={searchHref(query, Math.max(0, offset - limit))}>
                  Previous
                </a>
              ) : null}
              {last < total ? (
                <a class="btn" href={searchHref(query, offset + limit)}>
                  Next
                </a>
              ) : null}
            </p>
          ) : null}
        </>
      )}
    </>
  );
}

export function OfflineView() {
  return (
    <>
      <h1 class="page-title">Offline</h1>
      <p class="page-sub">This page has not been saved to your device.</p>
      <p class="offline-note">
        Pages you have already opened stay available offline for{" "}
        {CACHE_MAX_AGE_DAYS} days. To keep a whole edition, open it while
        connected and use <strong>Save the whole edition</strong>.
      </p>
      <p class="actions">
        <a class="btn btn-primary" href="/">
          Today
        </a>
        <a class="btn" href="/archive">
          Archive
        </a>
      </p>
    </>
  );
}

export function NotFoundView(props: { message: string }) {
  return (
    <>
      <h1 class="page-title">Not found</h1>
      <p class="page-sub">{props.message}</p>
      <p class="actions">
        <a class="btn btn-primary" href="/">
          Today
        </a>
        <a class="btn" href="/archive">
          Archive
        </a>
      </p>
    </>
  );
}
