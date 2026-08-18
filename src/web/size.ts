/**
 * How large the pages of an edition are, computed from the database.
 *
 * The "Save for offline" button asks a reader to spend somewhere around a
 * megabyte of radio time and four of storage without telling them so. This
 * module is what lets the button say the number before it is spent.
 *
 * ## Why the server, and why an estimate
 *
 * The only exact answer is the rendered bytes, and the only way to have those
 * is to render all thirty pages - which is precisely the work the reader is
 * being asked whether to authorise. Measuring on the client is worse still: it
 * means fetching everything to find out whether to fetch everything. So the
 * number is estimated from the two columns that dominate it, `articles.xhtml`
 * and `comments.text_html`, which are already sitting in SQLite next to the
 * request that is about to render the page anyway.
 *
 * Lengths are taken as `length(cast(<col> as blob))`. On a `TEXT` value
 * `length()` counts *characters*, and the page is served as UTF-8; on a corpus
 * of Hacker News comments - em dashes, smart quotes, the occasional CJK
 * quotation, a great deal of emoji - characters undercount bytes by a few
 * percent, and always in the same direction. The cast makes SQLite count the
 * stored octets, which is what crosses the wire.
 *
 * ## The formula, and what it was fitted against
 *
 * Every story page rendered by this codebase is
 *
 *     shell + article body + comment bodies + per-comment chrome
 *
 * where the chrome is the `<details>`, the `<summary>`, the author link, the
 * relative age, the reply count and the two wrapper `<div>`s that
 * `~/web/story` emits around each comment - a fixed cost repeated once per
 * comment and entirely invisible to a byte count of the comment text.
 *
 * Fitted by ordinary least squares against all 240 story pages in this
 * project's own database, measured as `Content-Length` off the running server:
 *
 *     bytes = 7146.26 + 0.999*article + 1.014*comments + 251.70*comments_n
 *
 * The two body coefficients coming back at essentially 1.0 is the check that
 * matters: it says the article and comment HTML really is passed through
 * byte-for-byte, so the model is a description of the renderer rather than a
 * curve fitted to noise. Rounded to the constants below, the residuals over
 * those 240 pages run from -2.5% to +6.7%, median -0.7%, with 95% of them
 * inside 1.8%. The worst case is the smallest page in the corpus - 7,460 bytes,
 * a two-comment story with a failed extraction - where 6.7% is 500 bytes; the
 * error is bounded in absolute terms by the fixed part of the model, so it is
 * largest exactly where it matters least.
 *
 * What is actually shown is a whole edition, thirty-one pages, where the
 * per-page errors cancel: the eight editions in the database estimate to
 * between -0.95% and +0.47% of what the server really sent.
 *
 * ## Two numbers, because the reader is asking two questions
 *
 * "How much will this cost me" is about the radio; "will this fill my reader"
 * is about the disk. They differ by a factor of about three and a half, because
 * the service worker's `fetch()` decodes transparently: what crosses the network
 * is compressed, what lands in the Cache API is the decompressed body.
 *
 * Compression is done by the reverse proxy, not by this application - `encode
 * zstd gzip` in the Caddyfile - so the ratio is a property of the deployment
 * and has to be measured against the deployment rather than assumed. Six live
 * story pages spanning 41 KB to 654 KB identity compress by 3.42x to 3.65x
 * under gzip and 3.65x under zstd. Note that stock Caddy has no brotli encoder,
 * so the better figure brotli would give is not on offer here.
 *
 * `WIRE_DIVISOR` is 3.4, under the worst ratio observed rather than near the
 * average. Overstating what a download costs sends a reader away from a button
 * they could have afforded; understating it spends data they did not agree to
 * spend. Where the two errors are not symmetric the estimate should lean the
 * way that cannot hurt, and an old e-reader on a slow radio is exactly the
 * client least able to absorb a surprise. If the proxy is ever reconfigured -
 * a brotli build of Caddy, or compression removed entirely - this constant is
 * the thing to re-measure, and removing compression would make it a 3.4x lie.
 */
import { getDb } from "~/db/client";

/**
 * Everything on a page that is not article or comment text.
 *
 * The shell (head, masthead, nav, settings panel, footer), the story header,
 * the four buttons, the comment section heading. Fitted at 7146 bytes and
 * stated to the nearest fifty, because a constant carried to the byte is a
 * claim about precision this does not have.
 */
export const PAGE_SHELL_BYTES = 7150;

/** Markup around one comment: `<details>`, `<summary>`, byline, reply count. */
export const COMMENT_CHROME_BYTES = 252;

/**
 * One row of a story list.
 *
 * Not fitted - measured directly, since an edition page is nothing but shell
 * plus thirty of these. The eight edition pages in the database render between
 * 19,724 and 20,103 bytes, which against the shell above is 419 to 432 bytes a
 * row, and 430 puts every one of them inside 1.7%.
 */
export const STORY_ROW_BYTES = 430;

/**
 * Identity bytes per byte on the wire. See the module note on why this is the
 * worst ratio the proxy was observed to achieve rather than a typical one.
 */
export const WIRE_DIVISOR = 3.4;

/** The three columns a story page's size is a function of. */
export interface StoryPageInputs {
  /** `length(cast(articles.xhtml as blob))`, or 0 when extraction failed. */
  articleBytes: number;
  /** `sum(length(cast(comments.text_html as blob)))` for the story. */
  commentBytes: number;
  /** How many comments are stored, which is how many times the chrome repeats. */
  commentCount: number;
}

/** What one `/story/<id>` page weighs, decompressed. */
export function estimateStoryPageBytes(inputs: StoryPageInputs): number {
  return (
    PAGE_SHELL_BYTES +
    Math.max(0, inputs.articleBytes) +
    Math.max(0, inputs.commentBytes) +
    COMMENT_CHROME_BYTES * Math.max(0, inputs.commentCount)
  );
}

/** What one `/archive/<date>` page weighs, decompressed. */
export function estimateEditionPageBytes(storyCount: number): number {
  return PAGE_SHELL_BYTES + STORY_ROW_BYTES * Math.max(0, storyCount);
}

export interface EditionSaveSize {
  /** Pages the save button would fetch: the edition page plus one per story. */
  pages: number;
  /** What lands in the Cache API, which is the decompressed body. */
  storageBytes: number;
  /** What crosses the radio, which is the same bodies content-encoded. */
  wireBytes: number;
}

/**
 * Size of everything behind the save button on an edition page.
 *
 * The list the button posts to the worker is `/archive/<date>` followed by one
 * `/story/<id>` per story (`~/web/views`, `EditionView`), so this counts
 * exactly that and nothing else - the front page is never in it, even on the
 * front page, because the button saves the *edition* at its permanent URL.
 *
 * Two correlated subqueries rather than a join onto a grouped `comments`: the
 * grouped form aggregates the whole 49,000-row table to answer a question
 * about thirty stories. Measured on the real database this runs in 3-8 ms for
 * an edition, which is affordable on a page whose render is already dominated
 * by thirty rows of markup, and cheap enough not to need a memo cache that
 * would then have to be invalidated when the prewarm task adds comments.
 */
export function estimateEditionSave(date: string): EditionSaveSize {
  const rows = getDb()
    .query<
      { article_bytes: number; comment_bytes: number; comment_count: number },
      [string]
    >(
      `SELECT COALESCE(length(cast(a.xhtml as blob)), 0) AS article_bytes,
              (SELECT COALESCE(SUM(length(cast(c.text_html as blob))), 0)
                 FROM comments c WHERE c.story_id = s.id) AS comment_bytes,
              (SELECT COUNT(*) FROM comments c WHERE c.story_id = s.id) AS comment_count
         FROM stories s
         LEFT JOIN articles a ON a.story_id = s.id
        WHERE s.edition_date = ?`,
    )
    .all(date);

  let storageBytes = estimateEditionPageBytes(rows.length);
  for (const row of rows) {
    storageBytes += estimateStoryPageBytes({
      articleBytes: row.article_bytes,
      commentBytes: row.comment_bytes,
      commentCount: row.comment_count,
    });
  }

  return {
    pages: rows.length + 1,
    storageBytes,
    wireBytes: Math.round(storageBytes / WIRE_DIVISOR),
  };
}
