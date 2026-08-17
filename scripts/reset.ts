#!/usr/bin/env bun
/**
 * Selective teardown of derived state.
 *
 *   bun run reset                      # show what is stored, change nothing
 *   bun run reset --epubs              # drop built EPUBs, keep extracted data
 *   bun run reset --articles           # drop extracted article text (forces refetch)
 *   bun run reset --comments           # drop fetched comment trees
 *   bun run reset --images             # drop cached image and cover blobs
 *   bun run reset --content            # articles + comments + images + epubs
 *   bun run reset --all                # delete the entire data directory
 *   bun run reset --epubs --date 2026-08-16   # scope any of the above to one edition
 *   bun run reset --content --dry-run  # print the plan, touch nothing
 *
 * Everything here is rebuildable from Algolia and the open web, which is why a
 * destructive script is safe to have. The layering is deliberate: `--epubs`
 * only invalidates packaging, `--articles` forces re-extraction, `--all` starts
 * from nothing. Reaching for `--all` when `--epubs` would do costs an hour of
 * refetching.
 *
 * The load-bearing rule: **deleting content always deletes the matching build
 * rows and blobs.** `buildStoryEpub` short-circuits on a usable artifact, so
 * clearing `articles` without clearing `builds` produces a story that will
 * never re-extract and silently serves the stale EPUB forever.
 */
import { rmSync } from "node:fs";
import { unlink } from "node:fs/promises";

import { editionEpubPath, storyEpubPath } from "~/build/artifacts";
import { config } from "~/config";
import { blobPath, dataDir, getDb, tx } from "~/db/client";
import { indexStory } from "~/search/indexer";

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
const content = flags.has("--content");
const wantEpubs = all || content || flags.has("--epubs");
const wantArticles = all || content || flags.has("--articles");
const wantComments = all || content || flags.has("--comments");
const wantImages = all || content || flags.has("--images");

const cfg = config();
const db = getDb();

/** `?` placeholder list plus bindings, so every query can be optionally scoped. */
const scope = date ? { clause: " WHERE edition_date = ?", args: [date] } : { clause: "", args: [] };

function count(sql: string, ...bind: string[]): number {
  return db.query<{ n: number }, string[]>(sql).get(...bind)?.n ?? 0;
}

function storyIds(): number[] {
  return db
    .query<{ id: number }, string[]>(`SELECT id FROM stories${scope.clause}`)
    .all(...scope.args)
    .map((r) => r.id);
}

function editionDates(): string[] {
  const sql = date ? "SELECT date FROM editions WHERE date = ?" : "SELECT date FROM editions";
  return db
    .query<{ date: string }, string[]>(sql)
    .all(...scope.args)
    .map((r) => r.date);
}

function report(): void {
  const suffix = date ? ` (edition ${date})` : "";
  console.log(`data dir: ${dataDir()}${suffix}`);
  console.log(`  editions   ${count("SELECT count(*) AS n FROM editions")}`);
  console.log(`  stories    ${count(`SELECT count(*) AS n FROM stories${scope.clause}`, ...scope.args)}`);
  console.log(
    `  articles   ${count(
      `SELECT count(*) AS n FROM articles WHERE story_id IN (SELECT id FROM stories${scope.clause})`,
      ...scope.args,
    )}`,
  );
  console.log(
    `  comments   ${count(
      `SELECT count(*) AS n FROM comments WHERE story_id IN (SELECT id FROM stories${scope.clause})`,
      ...scope.args,
    )}`,
  );
  console.log(
    `  assets     ${count("SELECT count(*) AS n FROM assets")}` +
      ` (${count("SELECT count(*) AS n FROM asset_urls")} cached urls)`,
  );
  console.log(
    `  builds     ${count("SELECT count(*) AS n FROM builds WHERE state = 'ready'")} ready, ` +
      `${count("SELECT count(*) AS n FROM builds WHERE state = 'failed'")} failed, ` +
      `${count("SELECT count(*) AS n FROM builds WHERE state = 'building'")} building`,
  );
}

/** Best-effort blob removal. A missing file is the desired end state either way. */
async function drop(paths: string[]): Promise<number> {
  let gone = 0;
  for (const p of paths) {
    try {
      await unlink(p);
      gone += 1;
    } catch {
      /* already absent */
    }
  }
  return gone;
}

if (!wantEpubs && !wantArticles && !wantComments && !wantImages) {
  report();
  console.log("\nnothing selected. pass --epubs, --articles, --comments, --images, --content or --all");
  process.exit(0);
}

console.log(dryRun ? "DRY RUN - nothing will be deleted\n" : "");
report();

// `--all` is a different operation, not a bigger one: it removes the SQLite
// file itself rather than rows, so the schema is recreated from scratch on the
// next boot. That is the only way to clear a migration mistake.
if (all && !date) {
  const dir = dataDir();
  console.log(`\nremoving entire data directory: ${dir}`);
  if (!dryRun) {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    console.log("removed. the next run recreates the schema.");
  }
  process.exit(0);
}

const ids = storyIds();
const dates = editionDates();
console.log(`\nscope: ${ids.length} stories across ${dates.length} editions`);

const plan: string[] = [];
if (wantEpubs) plan.push("epubs + build ledger");
if (wantArticles) plan.push("extracted articles");
if (wantComments) plan.push("comment trees");
if (wantImages) plan.push("image and cover blobs + asset rows");
console.log(`deleting: ${plan.join(", ")}`);

if (dryRun) process.exit(0);

// Rows first, blobs second. A crash between the two leaves unreferenced files,
// which is harmless; the reverse order leaves ledger rows pointing at nothing,
// which makes the server serve 500s until someone notices.
const blobs: string[] = [];

tx(() => {
  if (wantArticles) {
    for (const id of ids) {
      db.query("DELETE FROM articles WHERE story_id = ?").run(id);
      // Reindex rather than delete. The index spans stories and articles, so
      // with the article gone the correct state is a row holding the title and
      // an empty body, not no row at all - the story is still in the archive
      // and still findable by name. Doing it per story also keeps --date
      // honest: the previous blanket DELETE emptied the index for every
      // edition even when the run was scoped to one.
      indexStory(id);
    }
  }
  if (wantComments) {
    for (const id of ids) db.query("DELETE FROM comments WHERE story_id = ?").run(id);
  }
  if (wantImages) {
    for (const id of ids) db.query("DELETE FROM story_assets WHERE story_id = ?").run(id);
    // Covers are derived assets too, and they hang off the edition rather than
    // off a story, so their references have to be dropped in the same pass or
    // the sweep below would leave them behind as permanently unreferenced rows.
    for (const d of dates) db.query("DELETE FROM edition_assets WHERE edition_date = ?").run(d);
    // Content-addressed assets survive only while something still points at them.
    for (const row of db
      .query<{ sha256: string; path: string }, []>(
        `SELECT sha256, path FROM assets
          WHERE sha256 NOT IN (SELECT sha256 FROM story_assets)
            AND sha256 NOT IN (SELECT sha256 FROM edition_assets)`,
      )
      .all()) {
      blobs.push(row.path);
      // asset_urls cascades on this delete, but say so explicitly: the whole
      // point of --images is that the next build refetches, and a surviving
      // URL mapping would point at a blob we are about to unlink.
      db.query("DELETE FROM asset_urls WHERE sha256 = ?").run(row.sha256);
      db.query("DELETE FROM assets WHERE sha256 = ?").run(row.sha256);
    }
  }
  // Any content deletion invalidates packaging, so the ledger goes with it
  // regardless of whether --epubs was named explicitly.
  if (wantEpubs || wantArticles || wantComments || wantImages) {
    for (const id of ids) {
      db.query("DELETE FROM builds WHERE kind = 'story' AND build_key = ?").run(String(id));
      blobs.push(storyEpubPath(id));
    }
    for (const d of dates) {
      db.query("DELETE FROM builds WHERE kind = 'edition' AND build_key = ?").run(d);
      blobs.push(editionEpubPath(d));
    }
  }
});

const removed = await drop(blobs);
console.log(`\nremoved ${removed} blob(s) of ${blobs.length} candidate(s)`);

if (wantImages && !date) {
  // Sweep the blob directories themselves: content-addressed files can outlive
  // their rows if a previous run died between the transaction and the unlink.
  for (const name of ["images", "covers"]) {
    const dir = blobPath(name);
    console.log(`clearing ${dir}`);
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\nafter:");
report();
console.log(
  `\nrebuild with: bun run scripts/ingest.ts ${date ?? "<YYYY-MM-DD>"} --build   (tz ${cfg.editionTz})`,
);
