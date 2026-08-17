#!/usr/bin/env bun
/**
 * Rebuild the full-text search index from the database.
 *
 *   bun run reindex                      # show what is indexed, change nothing
 *   bun run reindex --all                # rebuild every story
 *   bun run reindex --date 2026-08-16    # rebuild one edition
 *   bun run reindex --all --dry-run      # print the plan, touch nothing
 *
 * The index is a projection of `stories LEFT JOIN articles` (see
 * ~/search/indexer), so it is always safe to throw away and rebuild: this reads
 * nothing but the database and touches no blobs and no network. It exists for
 * two situations.
 *
 * Backfill. Indexing is done by the write paths - ingest for titles, extraction
 * for article text - so stories that were already in the database before search
 * existed have no rows. Those are found by `--all`.
 *
 * Repair. If the flattening in ~/search/text changes, or the index is suspected
 * of having drifted, `--all` restores it to exactly what the current code would
 * have written. Unlike `--date`, it empties the table first, which is also how
 * rows left behind for stories that no longer exist get collected.
 */
import { config } from "~/config";
import { dataDir, getDb } from "~/db/client";
import { indexedCount, reindexAll } from "~/search/indexer";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));

const dateIdx = args.indexOf("--date");
const date = dateIdx >= 0 ? args[dateIdx + 1] : undefined;
if (dateIdx >= 0 && (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))) {
  console.error("--date needs a YYYY-MM-DD value");
  process.exit(1);
}

const dryRun = flags.has("--dry-run");
const all = flags.has("--all");
const db = getDb();

function count(sql: string, ...bind: string[]): number {
  return db.query<{ n: number }, string[]>(sql).get(...bind)?.n ?? 0;
}

/**
 * Rows in the index that no longer join a story. The query layer already hides
 * these, so they are wasted space rather than wrong answers - but a non-zero
 * number here means something deleted a story without unindexing it.
 */
function orphans(): number {
  return count(
    `SELECT count(*) AS n FROM search_fts
      WHERE story_id NOT IN (SELECT id FROM stories)`,
  );
}

function report(): void {
  const scope = date ? " WHERE edition_date = ?" : "";
  const bind = date ? [date] : [];
  console.log(`data dir: ${dataDir()}${date ? ` (edition ${date})` : ""}`);
  console.log(`  stories    ${count(`SELECT count(*) AS n FROM stories${scope}`, ...bind)}`);
  console.log(
    `  articles   ${count(
      `SELECT count(*) AS n FROM articles WHERE markdown IS NOT NULL AND markdown <> ''`,
    )} with text`,
  );
  console.log(`  indexed    ${indexedCount()} rows, ${orphans()} orphaned`);
}

if (!all && !date) {
  report();
  console.log("\nnothing selected. pass --all, or --date YYYY-MM-DD");
  process.exit(0);
}

console.log(dryRun ? "DRY RUN - the index will not be touched\n" : "");
report();

const target = date
  ? count("SELECT count(*) AS n FROM stories WHERE edition_date = ?", date)
  : count("SELECT count(*) AS n FROM stories");
console.log(`\nreindexing ${target} stor${target === 1 ? "y" : "ies"}`);

if (dryRun) process.exit(0);

const started = performance.now();
const written = reindexAll(date ? { date } : {});
const ms = Math.round(performance.now() - started);

console.log(`wrote ${written} rows in ${ms}ms`);
console.log("\nafter:");
report();
console.log(
  `\nsearch it at ${config().publicBaseUrl}/search?q=... or through OPDS at /opds/search?q=...`,
);
