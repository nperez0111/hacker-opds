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
import {
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

/**
 * One row of the story list.
 *
 * The whole row is a single anchor rather than a title link with metadata
 * beside it. An e-reader's touch layer is imprecise and its stylus optional,
 * so the target is the entire block - roughly 4x the area of the title alone.
 */
function StoryRowItem(props: { story: StoryRow; index: number }) {
  const { story, index } = props;
  return (
    <li>
      <a class="story-link" href={`/story/${story.id}`}>
        <span class="rank">{index + 1}</span>
        <span class="story-body">
          <span class="story-title">{story.title}</span>
          <span class="story-meta">{storyMetaParts(story).join(DOT)}</span>
        </span>
      </a>
    </li>
  );
}

export interface EditionViewProps {
  date: string;
  today: string;
  stories: StoryRow[];
  /** Present only on the front page, where "Today" needs an exact date under it. */
  subtitle?: string;
}

export function EditionView(props: EditionViewProps) {
  const { date, today, stories, subtitle } = props;
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

      <p class="actions" data-offline-ui hidden>
        <button class="btn" type="button" data-save-edition={saveUrls}>
          Save for offline
        </button>
        <span class="meta" data-save-status></span>
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
        Pages you have already opened stay available offline. To keep a whole
        edition, open it while connected and use <strong>Save for offline</strong>.
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
