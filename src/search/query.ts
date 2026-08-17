/**
 * The read side of the search index: a raw string in, ranked stories out.
 *
 * ## Why the query is rewritten rather than passed through
 *
 * FTS5's MATCH argument is a small query language, and almost every way a
 * person mistypes something is a syntax error rather than a search that finds
 * nothing. Measured against the real index, all of these throw:
 *
 *   "unbalanced      unterminated string
 *   *                unknown special query
 *   NEAR/            fts5: syntax error near "/"
 *   AND              fts5: syntax error near "AND"
 *   title:           fts5: syntax error near ""
 *   ( ) ^ -          fts5: syntax error
 *   (spaces only)    fts5: syntax error near ""
 *
 * An exception here is a 500 on a page whose entire input is a text box, so the
 * question is not whether to sanitise but how.
 *
 * ## The choice: quote everything
 *
 * The alternative was to expose a subset of the syntax - keep AND/OR/NOT, keep
 * prefix stars - and reject or repair the rest. That was rejected on three
 * grounds:
 *
 *  - It fails open. A subset is defined by what it forbids, so every FTS5
 *    grammar production nobody thought of is a syntax error waiting for a
 *    reader to type it. Quoting fails closed: inside a double-quoted FTS5
 *    string the *only* character with any meaning is the quote itself, and this
 *    module is what emits the quotes, so there is no input that can reach the
 *    parser as syntax.
 *  - Operators would be a trap for the people using this. The audience is
 *    someone typing two or three words into an e-reader's on-screen keyboard.
 *    Bare AND, OR and NOT as operators means a search for "cats and dogs" and a
 *    search for "not fooled" quietly mean something other than what was typed.
 *  - Prefix stars cost more than they return. The tokenizer is `porter`, so
 *    "design" already finds "designs" and "designing" - measured, all three
 *    return the same 63 hits - which is most of what a trailing star is for.
 *
 * One piece of syntax survives, because it is the one people mean literally:
 * a matched pair of double quotes is kept as a phrase. That costs nothing in
 * safety - the quotes in the output are still ours, one open and one close by
 * construction - and "system design" as a phrase is a genuinely different
 * search from the two words apart.
 *
 * Tokens are joined with no operator, which in FTS5 is an implicit AND. Adding
 * a word narrows the search, which is what everyone expects a search box to do.
 */
import { config } from "~/config";
import { getDb } from "~/db/client";

/**
 * Bounds on the query itself. These are not tuning knobs, they are the limits
 * that make an adversarial query cheap to answer, so they live here rather than
 * in the config.
 */
const MAX_QUERY_CHARS = 256;
const MAX_TOKENS = 12;
const MAX_TOKEN_CHARS = 64;

/** Hard ceiling on a page of results, whatever a caller asks for. */
export const MAX_LIMIT = 100;

/**
 * Deep paging is a scan: FTS5 has to rank the whole result set to skip past it.
 * Nothing legitimate walks past this on an archive of a few thousand stories.
 */
const MAX_OFFSET = 1000;

/**
 * Column weights for bm25.
 *
 * One per indexed column, title first. A term in a 9-word title is a much
 * stronger signal than the same term buried in 3,000 words of body text, and
 * bm25's own length normalisation only partly accounts for that because it
 * compares each column against the average length of *that* column.
 *
 * The UNINDEXED story_id takes no weight. Verified against the real table:
 * passing two weights, three, or none produces identical scores, and swapping
 * these two changes the ranking, so the mapping is title then body as written.
 */
const BM25_TITLE_WEIGHT = 10;
const BM25_BODY_WEIGHT = 1;

/** Snippet width, in tokens. About one line of an e-reader panel either side. */
const SNIPPET_TOKENS = 22;

export interface SearchHit {
  id: number;
  edition_date: string;
  title: string;
  url: string | null;
  domain: string | null;
  author: string | null;
  points: number;
  num_comments: number;
  /**
   * Carried so an OPDS entry built from a hit is identical to the one the
   * edition feed publishes for the same story - same id, same `updated`, same
   * author. A reader deduplicates on the id and re-downloads on a changed
   * `updated`, so a search result that differed here would look like a new
   * edition of a book already on the shelf.
   */
  created_at_i: number;
  /**
   * A window of the article around the match, plain text.
   *
   * Empty when the story matched on its title alone or extraction never
   * produced a body, which is deliberate: the alternative is FTS5's automatic
   * column choice, which in that case returns the title, and a result row whose
   * summary is a second copy of its own heading is worse than no summary.
   */
  snippet: string;
  /** bm25 relevance. Negative, and more negative is better. */
  score: number;
}

export interface SearchResults {
  /** The string as typed, trimmed. Echoed back into the form and the feed. */
  query: string;
  /** What was actually handed to MATCH, or null when nothing searchable was left. */
  expression: string | null;
  hits: SearchHit[];
  /** Matching stories in total, which is more than `hits.length` when paging. */
  total: number;
  limit: number;
  offset: number;
}

const SELECT_HITS = `SELECT s.id           AS id,
          s.edition_date AS edition_date,
          s.title        AS title,
          s.url          AS url,
          s.domain       AS domain,
          s.author       AS author,
          s.points       AS points,
          s.num_comments AS num_comments,
          s.created_at_i AS created_at_i,
          snippet(search_fts, 1, '', '', char(8230), ?) AS snippet,
          bm25(search_fts, ?, ?) AS score
     FROM search_fts
     JOIN stories s ON s.id = search_fts.story_id
    WHERE search_fts MATCH ?
    ORDER BY score, s.points DESC, s.id
    LIMIT ? OFFSET ?`;

const COUNT_HITS = `SELECT count(*) AS n
     FROM search_fts
     JOIN stories s ON s.id = search_fts.story_id
    WHERE search_fts MATCH ?`;

/** Anything that can carry meaning to the tokenizer. */
function hasWordCharacter(value: string): boolean {
  return /[\p{L}\p{N}]/u.test(value);
}

/**
 * Splits the input into phrases.
 *
 * A double quote opens a phrase that runs to the next quote or to the end of
 * the input, so an unbalanced quote is a phrase rather than an error. Anything
 * outside quotes is split on whitespace.
 */
function phrases(input: string): string[] {
  const out: string[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i] as string;

    if (ch === '"') {
      const end = input.indexOf('"', i + 1);
      const body = end === -1 ? input.slice(i + 1) : input.slice(i + 1, end);
      out.push(body);
      i = end === -1 ? input.length : end + 1;
      continue;
    }

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    let end = i;
    while (end < input.length && !/[\s"]/.test(input[end] as string)) end += 1;
    out.push(input.slice(i, end));
    i = end;
  }

  return out;
}

/**
 * Rewrites a user's string into an FTS5 MATCH expression, or null when there is
 * nothing left worth running.
 *
 * Exported for the tests, which check the output directly as well as running it
 * against a real index.
 */
export function toMatchExpression(raw: unknown): string | null {
  if (typeof raw !== "string") return null;

  const input = raw
    // Truncate before anything else, so the work below is bounded even if the
    // caller was handed a megabyte of query string.
    .slice(0, MAX_QUERY_CHARS)
    // Compatibility normalisation, so a ligature or a full-width letter matches
    // the plain form the tokenizer stored.
    .normalize("NFKC")
    // Soft keyboards produce curly quotes. Someone who types them means to
    // quote a phrase, and left as-is they would be indistinguishable from any
    // other punctuation and the phrase would be lost.
    .replace(/[\u201c\u201d\u00ab\u00bb]/g, '"');

  const tokens: string[] = [];
  for (const phrase of phrases(input)) {
    if (tokens.length >= MAX_TOKENS) break;
    // A phrase of pure punctuation would come out as the empty phrase, which
    // FTS5 accepts and which matches nothing - so it can only ever turn a good
    // query into a dead one.
    if (!hasWordCharacter(phrase)) continue;
    // The quote is the one character with meaning inside a quoted string. It
    // cannot appear here, because phrases are split on it, but this module's
    // whole claim is that its output is well-formed, so it does not rest on
    // that being true elsewhere.
    tokens.push(`"${phrase.slice(0, MAX_TOKEN_CHARS).replaceAll('"', " ")}"`);
  }

  return tokens.length === 0 ? null : tokens.join(" ");
}

function clampLimit(value: number | undefined): number {
  const fallback = config().searchResultLimit;
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(value)));
}

function clampOffset(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.min(MAX_OFFSET, Math.max(0, Math.floor(value)));
}

/**
 * Runs a search.
 *
 * The join against `stories` is not incidental. `search_fts` has no foreign
 * key - a virtual table cannot have one - so a story removed by the retention
 * sweep can leave a row behind if anything ever deletes out of order. Joining
 * means such a row is invisible rather than a result that 404s when tapped.
 *
 * No try/catch around MATCH. `toMatchExpression` is what guarantees the
 * expression parses, and swallowing an error here would turn a regression in it
 * into "search silently returns nothing", which is the hardest possible version
 * of that bug to notice. The tests fuzz it against a real index instead.
 */
export function searchStories(
  raw: string,
  opts: { limit?: number; offset?: number } = {},
): SearchResults {
  const query = typeof raw === "string" ? raw.trim() : "";
  const limit = clampLimit(opts.limit);
  const offset = clampOffset(opts.offset);
  const expression = toMatchExpression(raw);

  if (expression === null) {
    return { query, expression: null, hits: [], total: 0, limit, offset };
  }

  const db = getDb();
  const hits = db
    .query<SearchHit, [number, number, number, string, number, number]>(SELECT_HITS)
    .all(
      SNIPPET_TOKENS,
      BM25_TITLE_WEIGHT,
      BM25_BODY_WEIGHT,
      expression,
      limit,
      offset,
    );

  const total = db.query<{ n: number }, [string]>(COUNT_HITS).get(expression)?.n ?? 0;

  return { query, expression, hits, total, limit, offset };
}
