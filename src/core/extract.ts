/**
 * Article extraction.
 *
 * Network access and parsing are deliberately separated: `defuddleHtml` is a
 * pure function over an HTML string so it can be tested against recorded
 * fixtures, while `extractArticle` layers fetching and error handling on top.
 *
 * Extraction failure is never fatal. Every story yields an article record; a
 * failed one carries an `error_code` and renders as a stub chapter, so an EPUB
 * always builds and the comments are always readable.
 */
import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import type { StoryRow } from "~/core/edition";
import { FetchFailure, fetchPage } from "~/core/fetcher";
import { getDb, tx } from "~/db/client";
import { toXhtmlFragment } from "~/epub/xhtml";
import { log } from "~/log";
import { indexStory } from "~/search/indexer";

export type ArticleState = "ok" | "failed" | "text_post";

export interface ArticleRecord {
  story_id: number;
  state: ArticleState;
  fetched_at: number;
  http_status: number | null;
  final_url: string | null;
  title: string | null;
  author: string | null;
  published: string | null;
  site: string | null;
  language: string | null;
  word_count: number;
  /** Sanitised, well-formed XHTML fragment ready to drop into a chapter. */
  xhtml: string;
  markdown: string;
  error_code: string | null;
}

export interface DefuddleResult {
  xhtml: string;
  markdown: string;
  title: string | null;
  author: string | null;
  published: string | null;
  site: string | null;
  language: string | null;
  wordCount: number;
}

let turndown: TurndownService | undefined;
function md() {
  turndown ??= new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  return turndown;
}

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function countWords(text: string): number {
  const matches = text.trim().match(/\S+/g);
  return matches ? matches.length : 0;
}

/**
 * Runs defuddle over a raw HTML string and normalises its output into the
 * shape the EPUB builder wants. Throws nothing: an unparseable document comes
 * back with empty `xhtml`, which callers treat as `extraction_empty`.
 */
export async function defuddleHtml(
  html: string,
  url: string,
): Promise<DefuddleResult> {
  const { document } = parseHTML(html);

  const result = await Defuddle(document, url, {
    url,
    separateMarkdown: true,
    removeImages: false,
    standardize: true,
  });

  const rawHtml = typeof result.content === "string" ? result.content : "";
  const xhtml = toXhtmlFragment(rawHtml, { baseUrl: url });

  // defuddle only populates contentMarkdown when it succeeds at conversion;
  // fall back to converting the sanitised XHTML so /md is never empty when the
  // chapter itself has content.
  let markdown = clean(result.contentMarkdown) ?? "";
  if (!markdown && xhtml) markdown = md().turndown(xhtml);

  const wordCount =
    typeof result.wordCount === "number" && result.wordCount > 0
      ? result.wordCount
      : countWords(markdown);

  return {
    xhtml,
    markdown,
    title: clean(result.title),
    author: clean(result.author),
    published: clean(result.published),
    site: clean(result.site),
    language: clean(result.language),
    wordCount,
  };
}

/** Renders an Ask/Show/Tell HN self-post body as the article chapter. */
export function textPostArticle(story: StoryRow): ArticleRecord {
  const xhtml = toXhtmlFragment(story.story_text ?? "", {
    baseUrl: "https://news.ycombinator.com/",
  });
  return {
    story_id: story.id,
    state: "text_post",
    fetched_at: Math.floor(Date.now() / 1000),
    http_status: null,
    final_url: null,
    title: story.title,
    author: story.author,
    published: null,
    site: "Hacker News",
    language: "en",
    word_count: countWords(story.story_text ?? ""),
    xhtml,
    markdown: xhtml ? md().turndown(xhtml) : "",
    error_code: null,
  };
}

export function failedArticle(
  storyId: number,
  errorCode: string,
  httpStatus: number | null = null,
): ArticleRecord {
  return {
    story_id: storyId,
    state: "failed",
    fetched_at: Math.floor(Date.now() / 1000),
    http_status: httpStatus,
    final_url: null,
    title: null,
    author: null,
    published: null,
    site: null,
    language: null,
    word_count: 0,
    xhtml: "",
    markdown: "",
    error_code: errorCode,
  };
}

/**
 * Fetches and extracts a story's linked article. Self-posts short-circuit to
 * their own text; everything else is fetched, and any failure is captured as a
 * record rather than thrown.
 */
export async function extractArticle(story: StoryRow): Promise<ArticleRecord> {
  if (!story.url) return textPostArticle(story);

  let page;
  try {
    page = await fetchPage(story.url);
  } catch (err) {
    if (err instanceof FetchFailure) {
      return failedArticle(story.id, err.code, err.status ?? null);
    }
    return failedArticle(story.id, "network_error");
  }

  let parsed: DefuddleResult;
  try {
    parsed = await defuddleHtml(page.html, page.finalUrl);
  } catch {
    return failedArticle(story.id, "extraction_error", page.status);
  }

  if (!hasContent(parsed)) {
    log("extract").info(
      { storyId: story.id, url: page.finalUrl, wordCount: parsed.wordCount },
      "extraction produced no usable content",
    );
    return failedArticle(story.id, "extraction_empty", page.status);
  }

  return {
    story_id: story.id,
    state: "ok",
    fetched_at: Math.floor(Date.now() / 1000),
    http_status: page.status,
    final_url: page.finalUrl,
    title: parsed.title,
    author: parsed.author,
    published: parsed.published,
    site: parsed.site,
    language: parsed.language,
    word_count: parsed.wordCount,
    xhtml: parsed.xhtml,
    markdown: parsed.markdown,
    error_code: null,
  };
}

/**
 * Did the extraction actually yield something worth reading?
 *
 * A bare `!xhtml` check is not enough: defuddle regularly returns a couple of
 * whitespace characters, or markup with no text in it at all, and those stored
 * as `state: 'ok'` produce a blank chapter, index nothing for search, and hide
 * the very condition a render fallback should react to.
 *
 * Image-only articles are deliberately still accepted -- zero words but real
 * `<img>` content is a comic or a photo essay, not a failure.
 */
export function hasContent(parsed: DefuddleResult): boolean {
  if (!parsed.xhtml.trim()) return false;
  const text = parsed.xhtml.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (text.length > 0) return true;
  return /<img\b/i.test(parsed.xhtml);
}

/**
 * Stores an article and refreshes the story's search index row.
 *
 * The two happen in one transaction because they are one fact: the searchable
 * body of a story *is* its stored article. Splitting them would let a crash
 * leave the index describing text the database no longer holds, and nothing
 * downstream would ever notice - a stale index does not fail, it just answers
 * wrongly. `indexStory` re-reads both tables and rewrites the row from scratch,
 * so re-extracting a story replaces its entry rather than adding a second one.
 */
export function saveArticle(article: ArticleRecord): void {
  tx(() => {
    insertArticle(article);
    indexStory(article.story_id);
  });
}

function insertArticle(article: ArticleRecord): void {
  getDb()
    .query(
      `INSERT INTO articles
         (story_id, state, fetched_at, http_status, final_url, title, author,
          published, site, language, word_count, xhtml, markdown, error_code)
       VALUES ($story_id, $state, $fetched_at, $http_status, $final_url, $title,
               $author, $published, $site, $language, $word_count, $xhtml,
               $markdown, $error_code)
       ON CONFLICT(story_id) DO UPDATE SET
         state=excluded.state, fetched_at=excluded.fetched_at,
         http_status=excluded.http_status, final_url=excluded.final_url,
         title=excluded.title, author=excluded.author,
         published=excluded.published, site=excluded.site,
         language=excluded.language, word_count=excluded.word_count,
         xhtml=excluded.xhtml, markdown=excluded.markdown,
         error_code=excluded.error_code`,
    )
    // bun:sqlite matches named placeholders by their literal `$name`, so the
    // binding object's keys have to carry the prefix too.
    .run(
      Object.fromEntries(Object.entries(article).map(([k, v]) => [`$${k}`, v])) as Record<
        string,
        string | number | null
      >,
    );
}

export function getArticle(storyId: number): ArticleRecord | null {
  return (
    (getDb()
      .query(`SELECT * FROM articles WHERE story_id = ?`)
      .get(storyId) as ArticleRecord | null) ?? null
  );
}
