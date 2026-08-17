import { unlink } from "node:fs/promises";
import { DateTime } from "luxon";
import { storyEpubPath } from "~/build/artifacts";
import { config } from "~/config";
import { getDb, tx } from "~/db/client";
import { log } from "~/log";
import { indexStory, unindexStory } from "~/search/indexer";
import { searchTopStories } from "./algolia";

export interface DayWindow {
  date: string;
  startUnix: number;
  endUnix: number;
}

/**
 * Calendar-day window in the edition timezone. luxon handles DST, so on the
 * spring-forward day this window is 23h and on fall-back 25h -- which is the
 * correct definition of "stories posted that day" for a reader in that zone.
 */
export function dayWindow(date: string, tz = config().editionTz): DayWindow {
  const start = DateTime.fromISO(date, { zone: tz }).startOf("day");
  if (!start.isValid) throw new Error(`invalid edition date: ${date}`);
  const end = start.plus({ days: 1 });
  return {
    date: start.toFormat("yyyy-MM-dd"),
    startUnix: Math.floor(start.toSeconds()),
    endUnix: Math.floor(end.toSeconds()),
  };
}

/** Unix seconds at which an edition becomes eligible to build. */
export function closesAt(date: string, tz = config().editionTz): number {
  return dayWindow(date, tz).endUnix + config().editionLagHours * 3600;
}

export function today(tz = config().editionTz): string {
  return DateTime.now().setZone(tz).toFormat("yyyy-MM-dd");
}

export function shiftDate(date: string, days: number, tz = config().editionTz) {
  return DateTime.fromISO(date, { zone: tz })
    .plus({ days })
    .toFormat("yyyy-MM-dd");
}

/**
 * Editions whose window has closed (day end + lag) but which have not been
 * ingested yet, oldest first. Self-determining so the hourly task is
 * idempotent, DST-safe, and catches up after downtime.
 */
export function dueEditions(maxLookbackDays = 7): string[] {
  const c = config();
  const now = Math.floor(Date.now() / 1000);
  const db = getDb();
  const out: string[] = [];

  for (let i = 1; i <= maxLookbackDays; i++) {
    const date = shiftDate(today(c.editionTz), -i, c.editionTz);
    if (closesAt(date, c.editionTz) > now) continue;
    const row = db
      .query<{ state: string }, [string]>(
        "SELECT state FROM editions WHERE date = ?",
      )
      .get(date);
    if (!row || row.state === "pending") out.push(date);
  }
  return out.reverse();
}

export function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * What to show as the book's author.
 *
 * HN usernames carry almost no signal on a bookshelf, so linked stories are
 * attributed to their source instead. This uses the bare domain rather than
 * the full URL on purpose: e-reader libraries sort and group by author, so
 * `seangoedecke.com` collects every article from that site into one heading,
 * whereas a full URL is unique per book (it groups nothing) and gets truncated
 * in the narrow author column anyway.
 *
 * Self-posts are the exception. Ask/Show/Tell HN have no source URL and the
 * submitter genuinely wrote the text, so there the username is the honest
 * attribution.
 */
export function bookAuthor(story: Pick<StoryRow, "domain" | "author" | "url">): string {
  if (story.url && story.domain) return story.domain;
  return story.author ?? "Hacker News";
}

export interface StoryRow {
  id: number;
  edition_date: string;
  rank: number;
  title: string;
  url: string | null;
  domain: string | null;
  author: string | null;
  points: number;
  num_comments: number;
  created_at_i: number;
  story_text: string | null;
  is_text_post: number;
}

/**
 * Fetches the top stories for a closed day and records them. Idempotent:
 * re-ingesting an edition replaces its story rows. Story content (articles,
 * comments, EPUBs) is built separately.
 */
export async function ingestEdition(date: string): Promise<StoryRow[]> {
  const c = config();
  const win = dayWindow(date, c.editionTz);
  const hits = await searchTopStories(
    win.startUnix,
    win.endUnix,
    c.editionStoryLimit,
  );

  const rows: StoryRow[] = hits.map((h, i) => {
    const url = h.url || null;
    return {
      id: Number(h.objectID),
      edition_date: win.date,
      rank: i + 1,
      title: h.title ?? "(untitled)",
      url,
      domain: hostOf(url),
      author: h.author,
      points: h.points ?? 0,
      num_comments: h.num_comments ?? 0,
      created_at_i: h.created_at_i,
      story_text: h.story_text ?? null,
      is_text_post: url ? 0 : 1,
    };
  });

  const db = getDb();
  let dropped: number[] = [];
  tx(() => {
    db.query(
      `INSERT INTO editions (date, tz, start_unix, end_unix, closed_at, ingested_at, story_count, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'ingested')
       ON CONFLICT(date) DO UPDATE SET
         tz=excluded.tz, start_unix=excluded.start_unix, end_unix=excluded.end_unix,
         closed_at=excluded.closed_at, ingested_at=excluded.ingested_at,
         story_count=excluded.story_count, state='ingested'`,
    ).run(
      win.date,
      c.editionTz,
      win.startUnix,
      win.endUnix,
      closesAt(win.date, c.editionTz),
      Math.floor(Date.now() / 1000),
      rows.length,
    );

    // Only drop stories that fell out of the new top-N. Deleting the whole
    // edition and reinserting would cascade away `articles` and `comments`,
    // discarding every extracted article and fetched comment tree on a routine
    // re-ingest -- and the `builds` rows would survive as 'ready', so
    // `buildStoryEpub` would keep serving stale blobs it could no longer
    // rebuild from. The upsert below already refreshes points and ranks.
    const keep = rows.map((r) => r.id);
    // `id NOT IN (NULL)` is NULL, not true, so an empty keep-set would match no
    // rows and silently drop nothing. The empty case needs its own query.
    dropped =
      keep.length === 0
        ? db
            .query<{ id: number }, [string]>(
              "SELECT id FROM stories WHERE edition_date = ?",
            )
            .all(win.date)
            .map((r) => r.id)
        : db
            .query<{ id: number }, string[]>(
              `SELECT id FROM stories WHERE edition_date = ?
                 AND id NOT IN (${keep.map(() => "?").join(",")})`,
            )
            .all(win.date, ...keep.map(String))
            .map((r) => r.id);

    for (const id of dropped) {
      db.query("DELETE FROM builds WHERE kind = 'story' AND build_key = ?").run(
        String(id),
      );
      // The index has no foreign key to cascade through - a virtual table
      // cannot have one - so a dropped story would otherwise stay searchable
      // and answer with a link to a page that no longer exists.
      unindexStory(id);
      db.query("DELETE FROM stories WHERE id = ?").run(id);
    }

    const ins = db.query(
      `INSERT INTO stories (id, edition_date, rank, title, url, domain, author,
                            points, num_comments, created_at_i, story_text, is_text_post)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         edition_date=excluded.edition_date, rank=excluded.rank, title=excluded.title,
         url=excluded.url, domain=excluded.domain, author=excluded.author,
         points=excluded.points, num_comments=excluded.num_comments,
         story_text=excluded.story_text, is_text_post=excluded.is_text_post`,
    );
    for (const r of rows) {
      ins.run(
        r.id, r.edition_date, r.rank, r.title, r.url, r.domain, r.author,
        r.points, r.num_comments, r.created_at_i, r.story_text, r.is_text_post,
      );
      // Titles are searchable from the moment an edition is ingested, hours
      // before anything is extracted or built. This also republishes a title
      // that HN edited between passes, which the upsert above has just
      // changed underneath the index.
      indexStory(r.id);
    }
  });

  // Blobs are unlinked after the transaction commits: a failed unlink should
  // leave an unreferenced file behind, never a ledger row pointing at nothing.
  for (const id of dropped) {
    try {
      await unlink(storyEpubPath(id));
    } catch {
      // Already gone, or never built. Either way there is nothing to reclaim.
    }
  }

  log("ingest").info(
    {
      date: win.date,
      stories: rows.length,
      dropped: dropped.length,
      tz: c.editionTz,
    },
    `ingested ${rows.length} stories for ${win.date}`,
  );

  return rows;
}

export function getEditionStories(date: string): StoryRow[] {
  return getDb()
    .query<StoryRow, [string]>(
      "SELECT * FROM stories WHERE edition_date = ? ORDER BY rank",
    )
    .all(date);
}

/**
 * The newest stories we hold, regardless of which edition they belong to.
 *
 * Ordered by submission time rather than by (edition, rank) because that is the
 * order the consumer of this list - a syndication feed - will re-sort into
 * anyway: `pubDate` is the story's own `created_at_i`. Sorting here to match
 * means the `LIMIT` drops the items a reader would have seen at the bottom of
 * the list, not an arbitrary slice of them.
 *
 * The two orderings never actually interleave, since an edition is a calendar
 * day window and stories cannot straddle one; the difference is only that rank
 * stops deciding the order within a day.
 *
 * The join excludes editions still marked pending, matching `listEditions` and
 * `latestEdition`, so a half-ingested day cannot surface in the feed.
 */
export function recentStories(limit: number): StoryRow[] {
  return getDb()
    .query<StoryRow, [number]>(
      `SELECT s.* FROM stories s
         JOIN editions e ON e.date = s.edition_date
        WHERE e.state != 'pending'
        ORDER BY s.created_at_i DESC
        LIMIT ?`,
    )
    .all(limit);
}

export function getStory(id: number): StoryRow | null {
  return (
    getDb()
      .query<StoryRow, [number]>("SELECT * FROM stories WHERE id = ?")
      .get(id) ?? null
  );
}

export function latestEdition(): string | null {
  const row = getDb()
    .query<{ date: string }, []>(
      "SELECT date FROM editions WHERE state != 'pending' ORDER BY date DESC LIMIT 1",
    )
    .get();
  return row?.date ?? null;
}

/** One row of the archive index. `built_at` is null until the edition closes. */
export interface EditionSummary {
  date: string;
  story_count: number;
  built_at: number | null;
}

export function listEditions(limit = 100, offset = 0): EditionSummary[] {
  return getDb()
    .query<EditionSummary, [number, number]>(
      `SELECT date, story_count, built_at FROM editions
       WHERE state != 'pending' ORDER BY date DESC LIMIT ? OFFSET ?`,
    )
    .all(limit, offset);
}
