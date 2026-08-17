/**
 * The write side of the search index.
 *
 * `search_fts` is a plain FTS5 table, not an external-content one, because the
 * two things it indexes live in two tables: `stories.title` and
 * `articles.markdown`. FTS5's external-content mode mirrors exactly one table,
 * so there is nothing here for it to mirror.
 *
 * The cost of that is that nothing keeps the index in step automatically. There
 * are no triggers either - a trigger would have to fire on both tables, would
 * run inside every ingest and every extraction whether or not the text changed,
 * and would put the flattening in `src/search/text.ts` out of reach. Instead
 * every write path calls `indexStory`, and the operation is defined so that
 * calling it twice is the same as calling it once: delete every row for the
 * story, then insert exactly one built from a fresh read of both tables.
 *
 * That makes the index a projection of `stories LEFT JOIN articles`, which is
 * the property `reindexAll` relies on to rebuild it from nothing.
 *
 * Comments are deliberately not indexed. See the note on `indexStory`.
 */
import { getDb, tx } from "~/db/client";
import { searchBody } from "~/search/text";

interface SourceRow {
  title: string;
  markdown: string | null;
}

const SELECT_SOURCE = `SELECT s.title AS title, a.markdown AS markdown
     FROM stories s LEFT JOIN articles a ON a.story_id = s.id
    WHERE s.id = ?`;

const DELETE_ROW = `DELETE FROM search_fts WHERE story_id = ?`;

const INSERT_ROW = `INSERT INTO search_fts (title, body, story_id) VALUES (?, ?, ?)`;

/**
 * Rebuilds the index row for one story from the database as it stands.
 *
 * Returns false when the story does not exist, having removed any row left
 * behind for it - so a caller that races a deletion cannot leave an orphan the
 * query layer would have to filter out.
 *
 * Only the title and the article go in. Indexing the comment trees as well was
 * measured on the live corpus (210 stories, 43,282 comments, 14.2 MB of HTML
 * against 2.8 MB of article text) and it fails on all three axes:
 *
 *  - Relevance. A search for "design" goes from 63 hits to 176, out of 210
 *    stories. Every popular thread mentions every common word at least once,
 *    so the index stops discriminating: bm25 scores across the top of the
 *    result set collapse to -0.00 and the ranking becomes arbitrary. Search
 *    that returns 84 % of the archive is a list, not a search.
 *  - Size. The index grows from 776 KB to 6.8 MB, roughly nine times, for a
 *    corpus this is meant to stay small enough to sit beside.
 *  - Latency. Worst-case query goes from 62 ms to 2.7 s, because snippet
 *    extraction has to scan a document that is now five times larger.
 *
 * The threads are still reachable: they are on the story page and in the EPUB,
 * both one tap from a result row.
 */
export function indexStory(storyId: number): boolean {
  const db = getDb();
  const row = db.query<SourceRow, [number]>(SELECT_SOURCE).get(storyId);

  return tx(() => {
    db.query(DELETE_ROW).run(storyId);
    if (!row) return false;
    db.query(INSERT_ROW).run(row.title, searchBody(row.markdown), storyId);
    return true;
  });
}

/** Drops a story from the index. Used when the story row itself goes away. */
export function unindexStory(storyId: number): void {
  getDb().query(DELETE_ROW).run(storyId);
}

/**
 * Rebuilds the index from scratch, optionally for a single edition.
 *
 * The unscoped form empties the table first rather than reindexing story by
 * story, because that is also how rows for stories that no longer exist get
 * collected - a scoped rebuild cannot see them, since it works from the story
 * list it is given.
 */
export function reindexAll(opts: { date?: string } = {}): number {
  const db = getDb();
  const ids = opts.date
    ? db
        .query<{ id: number }, [string]>(
          "SELECT id FROM stories WHERE edition_date = ? ORDER BY rank",
        )
        .all(opts.date)
        .map((r) => r.id)
    : db
        .query<{ id: number }, []>("SELECT id FROM stories ORDER BY id")
        .all()
        .map((r) => r.id);

  return tx(() => {
    if (!opts.date) db.query("DELETE FROM search_fts").run();
    let n = 0;
    for (const id of ids) if (indexStory(id)) n += 1;
    return n;
  });
}

/** Rows currently in the index, including any that no longer join a story. */
export function indexedCount(): number {
  return (
    getDb().query<{ n: number }, []>("SELECT count(*) AS n FROM search_fts").get()?.n ?? 0
  );
}
