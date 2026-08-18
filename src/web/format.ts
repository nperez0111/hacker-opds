/**
 * Presentation helpers for the website.
 *
 * Pure functions over their inputs, with one deliberate exception noted on
 * `editionHeading`, so page rendering stays testable without a clock or a
 * database.
 */
import { DateTime } from "luxon";
import { config } from "~/config";
import type { StoryRow } from "~/core/edition";

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Facts under a story title, already ordered by how much they help a reader
 * decide whether to open it.
 *
 * The domain leads. On a list of thirty links the source is the strongest
 * signal available at a glance - far stronger than the score, which mostly
 * says the same thing thirty times over.
 */
export function storyMetaParts(
  story: Pick<StoryRow, "domain" | "is_text_post" | "points" | "num_comments">,
): string[] {
  const parts: string[] = [];
  if (story.domain) parts.push(story.domain);
  else if (story.is_text_post) parts.push("Hacker News");
  parts.push(plural(story.points, "point"));
  parts.push(plural(story.num_comments, "comment"));
  return parts;
}

/**
 * `2026-08-16` as `Sunday, 16 August 2026`.
 *
 * Rendered in the edition timezone, not the viewer's: an edition *is* a
 * calendar day in that zone, so showing it shifted by the reader's offset would
 * name the wrong day.
 */
export function longDate(date: string, tz = config().editionTz): string {
  const dt = DateTime.fromISO(date, { zone: tz });
  return dt.isValid ? dt.toFormat("cccc, d LLLL yyyy") : date;
}

/** `2026-08-16` as `16 Aug`, for dense lists. */
export function shortDate(date: string, tz = config().editionTz): string {
  const dt = DateTime.fromISO(date, { zone: tz });
  return dt.isValid ? dt.toFormat("d LLL yyyy") : date;
}

/**
 * Relative naming for a date, against a supplied "today".
 *
 * `today` is a parameter rather than a call to the clock so pages that show it
 * stay deterministic under test. Callers in a request pass `today()` from
 * ~/core/edition, which is the same day boundary the editions themselves use.
 */
export function relativeDay(date: string, today: string, tz = config().editionTz): string | null {
  if (date === today) return "Today";
  const a = DateTime.fromISO(date, { zone: tz });
  const b = DateTime.fromISO(today, { zone: tz });
  if (!a.isValid || !b.isValid) return null;
  const days = Math.round(b.diff(a, "days").days);
  if (days === 1) return "Yesterday";
  if (days > 1 && days < 7) return `${days} days ago`;
  return null;
}

/**
 * Heading for an edition page: the date, qualified when it is recent enough
 * for a relative name to be more meaningful than the absolute one.
 */
export function editionHeading(date: string, today: string): string {
  const rel = relativeDay(date, today);
  return rel ? `${rel}` : longDate(date);
}

/**
 * Absolute time of a story's submission, in the edition timezone.
 *
 * Deliberately not "3 days ago". A relative age has to be recomputed on every
 * render, which makes the page uncacheable in any honest sense - and this site
 * caches whole pages in a service worker for offline reading, where a saved
 * page would sit there insisting it was posted three days ago forever.
 */
export function submittedAt(story: StoryRow, tz = config().editionTz): string {
  return DateTime.fromSeconds(story.created_at_i, { zone: tz }).toFormat(
    "d LLL yyyy, HH:mm",
  );
}

/**
 * A byte count as a reader would say it.
 *
 * Powers of 1024 and the `KB`/`MB` spellings, because that is what the rest of
 * this codebase already says when it talks about bytes (`src/search/text.ts:11`,
 * `scripts/build-ops.ts:88`) and a site that measures the same thing two ways
 * is a site that has to be read twice.
 *
 * Exactly one decimal place above a megabyte and none below it. The only
 * caller is the offline-save estimate, which is accurate to within a couple of
 * percent (see `~/web/size`); `4.2 MB` claims about that much precision, while
 * `4.23 MB` would claim ten times more than the number has and `4 MB` would
 * throw away a distinction the reader can act on.
 */
export function byteSize(bytes: number): string {
  const n = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  // Rounded rather than truncated, so 1023 bytes is "1 KB" and not "0 KB".
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return plural(Math.round(n), "byte");
}

/** Rough reading time. Only shown when extraction actually produced text. */
export function readingTime(words: number): string | null {
  if (!Number.isFinite(words) || words < 100) return null;
  // 220 wpm is the usual figure for adult non-fiction reading.
  return `${Math.max(1, Math.round(words / 220))} min read`;
}
