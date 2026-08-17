/**
 * Per-story EPUB assembly: front matter, then the article, then one chapter
 * per root comment thread.
 *
 * Content acquisition is memoised in SQLite rather than in the build, so a
 * rebuild after a code change does not refetch the article or the comment
 * tree. The build itself is coalesced by key (see `./queue`), because Nitro
 * tasks dedupe by name and would collide across different stories.
 */

import { errFields, log } from "~/log";
import { fetchStoryTreeHtml, HnThrottled } from "~/core/hn-html";
import { flattenComments, getComments, groupThreads, saveComments } from "~/core/comments";
import { bookAuthor, getStory, type StoryRow } from "~/core/edition";
import { extractArticle, getArticle, saveArticle, type ArticleRecord } from "~/core/extract";
import { buildEpub, type EpubResource, type EpubTocEntry } from "~/epub/package";
import {
  renderArticle,
  renderFrontMatter,
  renderNoComments,
  renderThread,
  threadTitle,
} from "~/epub/render";
import { embedImages } from "~/epub/images";
import { storyCover } from "~/epub/cover";
import { EPUB_CSS, EPUB_CSS_HREF, EPUB_CSS_ID } from "~/epub/styles";
import { config } from "~/config";
import {
  artifactUsable,
  clearBuild,
  getBuild,
  markBuilding,
  markFailed,
  markReady,
  storyEpubPath,
  writeArtifact,
  type BuildRow,
} from "./artifacts";
import { coalesce } from "./queue";

const XHTML = "application/xhtml+xml";
const HN_ITEM = "https://news.ycombinator.com/item?id=";
const COVER_ID = "cover";
const COVER_HREF = "cover.png";

export class BuildError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "BuildError";
  }
}

/** Pads to 3 digits so chapter files sort lexically in the same order as the spine. */
function threadHref(index: number): string {
  return `thread-${String(index).padStart(3, "0")}.xhtml`;
}

/**
 * Packs the edition date and rank into one `calibre:series_index` value:
 * 2026-08-16 rank 3 becomes `20260816.03`, so books sort by day then rank.
 *
 * Kept as a string deliberately. As a float, rank 10 would render `.1` and
 * collide with rank 1; the zero-padded fraction must survive verbatim.
 */
export function seriesIndex(editionDate: string, rank: number): string {
  return `${editionDate.replaceAll("-", "")}.${String(rank).padStart(2, "0")}`;
}

/**
 * Fetches and stores the comment tree unless it is already cached.
 *
 * Exported because the digest needs the same acquisition, with the same
 * failure semantics; a second implementation of "get me this story's comments"
 * would be one more place for the throttle handling to drift.
 */
export async function ensureComments(story: StoryRow, maxWaitMs?: number) {
  const cached = getComments(story.id);
  if (cached.length > 0) return cached;
  // A story really can have zero comments; skip the round trip in that case.
  if (story.num_comments <= 0) return cached;

  // HN's own item page carries the complete tree in one request and in exact
  // display order. It is the only comment source.
  //
  // Neither failure mode is papered over here:
  //
  // - A throttle throws `HnThrottled` once `fetchStoryTreeHtml` has waited out
  //   its budget, and that propagates so the caller defers the whole build.
  // - A `null` return means the page loaded but parsed to zero rows, i.e. HN
  //   changed its markup. That is a bug to fix, not a condition to route
  //   around, so it fails the build loudly rather than shipping a book whose
  //   comments silently vanished.
  const tree = await fetchStoryTreeHtml(story.id, { maxWaitMs });
  if (!tree) {
    throw new BuildError(
      `hacker news item page for ${story.id} parsed to zero comments; markup likely changed`,
      "comment_parse_failed",
    );
  }

  const rows = flattenComments(story.id, tree);
  saveComments(story.id, rows);
  return rows;
}

/** Fetches and stores the article unless it is already cached. See above. */
export async function ensureArticle(story: StoryRow): Promise<ArticleRecord> {
  const cached = getArticle(story.id);
  if (cached) return cached;
  const article = await extractArticle(story);
  saveArticle(article);
  return article;
}

/** Builds the EPUB bytes without touching the ledger or the filesystem. */
export async function composeStoryEpub(story: StoryRow, maxWaitMs?: number): Promise<Uint8Array> {
  const [article, comments] = await Promise.all([
    ensureArticle(story),
    ensureComments(story, maxWaitMs),
  ]);
  const threads = groupThreads(comments);
  const cfg = config();

  // Images are pulled in at build time rather than at extraction time so the
  // stored article stays the canonical source text, and so a rebuild picks up
  // any change to the image pipeline without a re-extract.
  const art = await embedImages(renderArticle(story, article), story.id);
  if (art.embedded || art.failed) {
    log("build").debug(
      { storyId: story.id, embedded: art.embedded, failed: art.failed },
      "embedded article images",
    );
  }

  // Drawn after the images are resolved: `embedImages` replaces the story's
  // whole asset set, and `storyCover` records the cover in it.
  const cover = await storyCover(story);

  const resources: EpubResource[] = [
    { id: EPUB_CSS_ID, href: EPUB_CSS_HREF, mediaType: "text/css", data: EPUB_CSS },
    { id: COVER_ID, href: COVER_HREF, mediaType: cover.mediaType, data: cover.data },
    {
      id: "frontmatter",
      href: "frontmatter.xhtml",
      mediaType: XHTML,
      data: renderFrontMatter(story, article),
      spine: true,
    },
    {
      id: "article",
      href: "article.xhtml",
      mediaType: XHTML,
      data: art.xhtml,
      spine: true,
    },
    ...art.resources,
  ];

  const toc: EpubTocEntry[] = [
    { href: "frontmatter.xhtml", title: "Story details" },
    { href: "article.xhtml", title: article.title || story.title },
  ];

  if (threads.length === 0) {
    resources.push({
      id: "comments",
      href: "comments.xhtml",
      mediaType: XHTML,
      data: renderNoComments(story),
      spine: true,
    });
    toc.push({ href: "comments.xhtml", title: "Comments" });
  } else {
    threads.forEach((thread, i) => {
      const href = threadHref(i);
      resources.push({
        id: `thread-${i}`,
        href,
        mediaType: XHTML,
        // Per-story EPUBs carry the full tree; only the digest caps depth.
        data: renderThread(story, thread, i, { indentMaxDepth: cfg.commentIndentMaxDepth }),
        spine: true,
      });
      toc.push({ href, title: threadTitle(thread, i) });
    });
  }

  return await buildEpub({
    metadata: {
      identifier: `urn:hn:story:${story.id}`,
      title: story.title,
      language: article.language || "en",
      creator: bookAuthor(story),
      publisher: "Hacker News",
      source: story.url ?? `${HN_ITEM}${story.id}`,
      date: new Date(story.created_at_i * 1000).toISOString(),
      series: "Hacker News",
      seriesIndex: seriesIndex(story.edition_date, story.rank),
      custom: {
        "hn:id": String(story.id),
        "hn:score": String(story.points),
        "hn:comments": String(story.num_comments),
        "hn:domain": story.domain ?? "news.ycombinator.com",
        "hn:url": story.url ?? `${HN_ITEM}${story.id}`,
        "hn:edition": story.edition_date,
        "hn:rank": String(story.rank),
      },
    },
    resources,
    toc,
    coverId: COVER_ID,
  },
  // Pin the clock to the story's own submission time. Editions are immutable
  // and artifacts are content-addressed (the ETag derives from the sha256),
  // so a wall-clock `dcterms:modified` would make every rebuild of identical
  // input produce different bytes.
  new Date(story.created_at_i * 1000));
}

/**
 * Returns a ready `builds` row for the story, building it if necessary.
 * Concurrent callers for the same id share one build.
 */
export function buildStoryEpub(
  storyId: number,
  opts: { force?: boolean; maxWaitMs?: number } = {},
): Promise<BuildRow> {
  return coalesce(`story:${storyId}`, async () => {
    const existing = getBuild("story", storyId);
    if (!opts.force && (await artifactUsable(existing))) {
      log("build").debug({ storyId, cached: true }, "serving cached epub");
      return existing!;
    }

    const story = getStory(storyId);
    if (!story) throw new BuildError(`unknown story ${storyId}`, "unknown_story");

    markBuilding("story", storyId);
    const started = performance.now();
    try {
      const bytes = await composeStoryEpub(story, opts.maxWaitMs);
      const info = await writeArtifact(storyEpubPath(storyId), bytes);
      log("build").info(
        {
          storyId,
          title: story.title,
          bytes: info.bytes,
          durationMs: +(performance.now() - started).toFixed(1),
        },
        `built epub for ${storyId}`,
      );
      return markReady("story", storyId, info);
    } catch (err) {
      // A throttle is a deferral, not a failure. Nothing is wrong with the
      // story, so drop the ledger row rather than recording a `failed` build
      // the next pass would have to reason about.
      if (err instanceof HnThrottled) {
        clearBuild("story", storyId);
        log("build").warn(
          { storyId, waitMs: err.waitMs, durationMs: +(performance.now() - started).toFixed(1) },
          `deferring epub build for ${storyId}; hacker news is throttling`,
        );
        throw err;
      }

      const message = err instanceof Error ? err.message : String(err);
      markFailed("story", storyId, message);
      log("build").error(
        {
          storyId,
          url: story.url,
          durationMs: +(performance.now() - started).toFixed(1),
          ...errFields(err),
        },
        `epub build failed for ${storyId}`,
      );
      throw err;
    }
  });
}
