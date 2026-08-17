/**
 * The edition digest: one EPUB holding a whole day.
 *
 * The per-story books are the right unit for reading one thing. They are the
 * wrong unit for the actual habit this site serves - plugging a reader in,
 * pulling the day, and unplugging - because that is thirty downloads, thirty
 * rows on the shelf and thirty covers to page past. The digest is the same
 * content as one book: a contents page, then each story's article followed by
 * its discussion.
 *
 * ## What is capped, and why
 *
 * A digest that embedded every comment of thirty stories would be tens of
 * megabytes and unreadable; the point of a digest is that it can be read.
 * `digestThreadsPerStory` caps how many root threads each story contributes and
 * `digestCommentMaxDepth` caps how deep each of those goes - both defaults
 * chosen so the top of a discussion survives and the long tail does not. Both
 * cuts are announced in the text with a link back to Hacker News, rather than
 * silently truncating.
 *
 * The per-story EPUB stays complete. Nothing here changes it.
 *
 * ## Immutability
 *
 * An edition is built once, after its window has closed and its stories have
 * settled, so the bytes for a date never change. That is what lets the artifact
 * be served with a strong ETag and an immutable cache policy, and it is why the
 * archive clock is pinned rather than read (see `editionClock`).
 */

import pLimit from "p-limit";

import { config } from "~/config";
import { getEditionStories, shiftDate, today, type StoryRow } from "~/core/edition";
import { getDb } from "~/db/client";
import { getComments, groupThreads } from "~/core/comments";
import type { ArticleRecord } from "~/core/extract";
import { HnThrottled } from "~/core/hn-html";
import { editionCover } from "~/epub/cover";
import { embedImages } from "~/epub/images";
import { buildEpub, type EpubResource, type EpubTocEntry } from "~/epub/package";
import {
  renderDigestArticle,
  renderDigestContents,
  renderStoryComments,
  snippet,
  type DigestEntry,
} from "~/epub/render";
import { EPUB_CSS, EPUB_CSS_HREF, EPUB_CSS_ID } from "~/epub/styles";
import { errFields, log } from "~/log";
import {
  artifactUsable,
  clearBuild,
  editionEpubPath,
  getBuild,
  markBuilding,
  markFailed,
  markReady,
  writeArtifact,
  type BuildRow,
} from "./artifacts";
import { coalesce } from "./queue";
import { BuildError, ensureArticle, ensureComments, seriesIndex } from "./story";

const XHTML = "application/xhtml+xml";
const COVER_ID = "cover";
const COVER_HREF = "cover.png";

/** Chapter file names, zero padded so they sort as the spine reads. */
function articleHref(index: number): string {
  return `s${String(index + 1).padStart(3, "0")}.xhtml`;
}

function commentsHref(index: number): string {
  return `s${String(index + 1).padStart(3, "0")}-c.xhtml`;
}

/**
 * The instant the digest's archive entries and `dcterms:modified` are stamped
 * with: the submission time of the newest story in the edition.
 *
 * A digest is an aggregate, so unlike a per-story book it has no single
 * obvious clock. Three candidates were available and only one is defensible:
 *
 *   - Wall clock at build time. Fails outright. The EPUB's sha256 is the ETag
 *     and the response is `immutable`, so two builds of identical input must
 *     produce identical bytes; a wall clock guarantees they do not.
 *   - Midnight on the edition date. Deterministic, but it is a fiction - it
 *     predates every story in the book, and it collapses to the same instant
 *     for an edition that was re-ingested with different stories.
 *   - The newest story's `created_at_i`. Deterministic, derived only from rows
 *     that are frozen once the edition closes, later than every article and
 *     comment the book contains, and - the deciding point - it is exactly the
 *     value `editionFeed` already publishes as the feed's `<updated>`. The
 *     catalogue and the book therefore agree on when this edition last changed,
 *     which is the question a syncing reader is actually asking.
 *
 * An edition with no stories cannot be built at all, so the fallback to
 * midnight is unreachable in practice and exists to keep the function total.
 */
export function editionClock(stories: StoryRow[], date: string): Date {
  if (stories.length === 0) return new Date(`${date}T00:00:00Z`);
  return new Date(Math.max(...stories.map((s) => s.created_at_i)) * 1000);
}

interface Chapter {
  story: StoryRow;
  index: number;
  article: ArticleRecord;
  articleXhtml: string;
  images: EpubResource[];
  commentsXhtml: string;
}

/**
 * Gathers one story's content for the digest.
 *
 * Everything here is normally a cache hit: the digest is built after the
 * per-story books, which already stored the article, the comment tree and the
 * processed images. When it is not, it acquires them through exactly the same
 * paths the per-story build uses, including the throttle behaviour - an
 * `HnThrottled` propagates so the whole digest defers rather than shipping a
 * day with one story's discussion missing.
 */
async function chapter(
  story: StoryRow,
  index: number,
  maxWaitMs: number | undefined,
): Promise<Chapter> {
  const cfg = config();
  const [article] = await Promise.all([
    ensureArticle(story),
    ensureComments(story, maxWaitMs),
  ]);

  // No story id is passed to `embedImages`: that would rewrite the story's
  // asset links, and this book is not the owner of them. The per-story build
  // is, and it has already recorded the same set.
  const art = await embedImages(renderDigestArticle(story, article));

  const threads = groupThreads(getComments(story.id));
  const capped = threads.slice(0, cfg.digestThreadsPerStory);

  return {
    story,
    index,
    article,
    articleXhtml: art.xhtml,
    images: art.resources,
    commentsXhtml: renderStoryComments(story, capped, {
      indentMaxDepth: cfg.commentIndentMaxDepth,
      maxDepth: cfg.digestCommentMaxDepth,
      total: threads.length,
    }),
  };
}

/** Builds the digest bytes without touching the ledger or the filesystem. */
export async function composeEditionEpub(
  date: string,
  stories: StoryRow[],
  maxWaitMs?: number,
): Promise<Uint8Array> {
  const cfg = config();
  const started = performance.now();

  // Concurrency matches the article fetcher's, because on a cold edition that
  // is what this is waiting on; when everything is cached it is irrelevant.
  const limit = pLimit(cfg.fetchConcurrency);
  const chapters = await Promise.all(
    stories.map((story, index) => limit(() => chapter(story, index, maxWaitMs))),
  );
  // `Promise.all` preserves input order, so chapters are in rank order and the
  // manifest, the spine and the zip entries do not depend on completion order.

  const cover = await editionCover(date, stories.length);

  const resources: EpubResource[] = [
    { id: EPUB_CSS_ID, href: EPUB_CSS_HREF, mediaType: "text/css", data: EPUB_CSS },
    { id: COVER_ID, href: COVER_HREF, mediaType: cover.mediaType, data: cover.data },
  ];

  const contents: DigestEntry[] = chapters.map((c) => ({
    href: articleHref(c.index),
    rank: c.story.rank,
    title: c.story.title,
    facts: [
      c.story.domain ?? "news.ycombinator.com",
      `${c.story.points} points`,
      `${c.story.num_comments} comments`,
    ].join(" \u00b7 "),
  }));

  resources.push({
    id: "contents",
    href: "contents.xhtml",
    mediaType: XHTML,
    data: renderDigestContents(date, contents),
    spine: true,
  });

  const toc: EpubTocEntry[] = [{ href: "contents.xhtml", title: "Contents" }];
  // One image resource may be shared by two stories (a site logo on two
  // articles from the same domain), so the manifest is deduplicated by id.
  const seenImages = new Set<string>();

  for (const c of chapters) {
    const article = articleHref(c.index);
    const comments = commentsHref(c.index);

    resources.push({
      id: `s${c.index}`,
      href: article,
      mediaType: XHTML,
      data: c.articleXhtml,
      spine: true,
    });
    for (const image of c.images) {
      if (seenImages.has(image.id)) continue;
      seenImages.add(image.id);
      resources.push(image);
    }
    resources.push({
      id: `s${c.index}c`,
      href: comments,
      mediaType: XHTML,
      data: c.commentsXhtml,
      spine: true,
    });

    toc.push({
      href: article,
      title: `${c.story.rank}. ${snippet(c.story.title, 70)}`,
      children: [
        { href: article, title: "Article" },
        { href: comments, title: "Comments" },
      ],
    });
  }

  const bytes = await buildEpub(
    {
      metadata: {
        identifier: editionIdentifier(date),
        title: `Hacker News \u2014 ${date}`,
        language: "en",
        creator: "Hacker News",
        publisher: "Hacker News",
        source: "https://news.ycombinator.com/",
        // The calendar day the book covers, which is what a library should
        // show as its date; `dcterms:modified` carries the pinned clock.
        date: `${date}T00:00:00Z`,
        description:
          `The top ${stories.length} Hacker News ${stories.length === 1 ? "story" : "stories"} of ${date}, ` +
          `each with its article and discussion.`,
        series: "Hacker News",
        // Rank 0 sorts the digest ahead of that day's individual stories in a
        // library that groups by series.
        seriesIndex: seriesIndex(date, 0),
        custom: {
          "hn:edition": date,
          "hn:stories": String(stories.length),
          "hn:kind": "digest",
          "hn:threads-per-story": String(cfg.digestThreadsPerStory),
          "hn:comment-max-depth": String(cfg.digestCommentMaxDepth),
        },
      },
      resources,
      toc,
      coverId: COVER_ID,
    },
    editionClock(stories, date),
  );

  log("build").debug(
    {
      date,
      stories: stories.length,
      images: seenImages.size,
      durationMs: +(performance.now() - started).toFixed(1),
    },
    `composed digest for ${date}`,
  );

  return bytes;
}

/**
 * Editions that are ready for a digest and do not have one.
 *
 * An edition qualifies when every one of its stories has a ready EPUB. That is
 * a deliberately strict bar and it is the point of the whole exercise: a digest
 * built while stories are still arriving would be a book with holes in it, and
 * because artifacts are immutable and content-addressed, the holes would be
 * permanent. Waiting costs nothing - the task runs hourly and an edition is
 * already a day old when it closes.
 *
 * The consequence worth stating: an edition containing a story that can never
 * be built (a discussion HN has since removed, say) never gets a background
 * digest. Requesting the URL still attempts one, so the failure is visible
 * rather than silent.
 *
 * A `failed` digest row is not skipped. The precondition above means a failure
 * here is usually transient - a cache that got swept between the check and the
 * build - and retrying costs one CPU-bound pass an hour.
 */
export function editionsNeedingDigest(lookbackDays = 7): string[] {
  const floor = shiftDate(today(config().editionTz), -lookbackDays);
  return getDb()
    .query<{ date: string }, [string]>(
      `SELECT e.date FROM editions e
        WHERE e.state != 'pending'
          AND e.date >= ?
          AND e.story_count > 0
          AND NOT EXISTS (
                SELECT 1 FROM builds b
                 WHERE b.kind = 'edition' AND b.build_key = e.date AND b.state = 'ready')
          AND NOT EXISTS (
                SELECT 1 FROM stories s
                 WHERE s.edition_date = e.date
                   AND NOT EXISTS (
                         SELECT 1 FROM builds sb
                          WHERE sb.kind = 'story'
                            AND sb.build_key = CAST(s.id AS TEXT)
                            AND sb.state = 'ready'))
        ORDER BY e.date DESC`,
    )
    .all(floor)
    .map((row) => row.date);
}

/** The digest's `dc:identifier`, shared with its OPDS entry id. */
export function editionIdentifier(date: string): string {
  return `urn:hn:edition:${date}`;
}

/**
 * Returns a ready `builds` row for the edition digest, building it if
 * necessary. Concurrent callers for the same date share one build.
 *
 * Keyed coalescing rather than a Nitro task: the runtime dedupes tasks by name
 * and ignores the payload, so two dates fired together would collapse into one
 * run and both callers would get the same book.
 */
export function buildEditionEpub(
  date: string,
  opts: { force?: boolean; maxWaitMs?: number } = {},
): Promise<BuildRow> {
  return coalesce(`edition:${date}`, async () => {
    const existing = getBuild("edition", date);
    if (!opts.force && (await artifactUsable(existing))) {
      log("build").debug({ date, cached: true }, "serving cached digest");
      return existing!;
    }

    const stories = getEditionStories(date);
    if (stories.length === 0) {
      // Either the date does not exist or it was ingested and produced nothing.
      // Both are "there is no book here", which is a 404 rather than a failure
      // worth recording against the edition.
      throw new BuildError(`no stories for edition ${date}`, "unknown_edition");
    }

    markBuilding("edition", date);
    const started = performance.now();
    try {
      const bytes = await composeEditionEpub(date, stories, opts.maxWaitMs);
      const info = await writeArtifact(editionEpubPath(date), bytes);
      log("build").info(
        {
          date,
          stories: stories.length,
          bytes: info.bytes,
          durationMs: +(performance.now() - started).toFixed(1),
        },
        `built digest for ${date}`,
      );
      return markReady("edition", date, info);
    } catch (err) {
      // A throttle is a deferral, not a failure: nothing is wrong with the
      // edition, so the row is dropped and the day simply looks unbuilt.
      if (err instanceof HnThrottled) {
        clearBuild("edition", date);
        log("build").warn(
          { date, waitMs: err.waitMs, durationMs: +(performance.now() - started).toFixed(1) },
          `deferring digest build for ${date}; hacker news is throttling`,
        );
        throw err;
      }

      const message = err instanceof Error ? err.message : String(err);
      markFailed("edition", date, message);
      log("build").error(
        { date, durationMs: +(performance.now() - started).toFixed(1), ...errFields(err) },
        `digest build failed for ${date}`,
      );
      throw err;
    }
  });
}
