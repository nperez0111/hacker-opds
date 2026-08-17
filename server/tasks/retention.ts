import { unlink } from "node:fs/promises";

import { defineTask } from "nitro/task";

import { editionEpubPath, storyEpubPath } from "~/build/artifacts";
import { config } from "~/config";
import { shiftDate, today } from "~/core/edition";
import { getDb, tx } from "~/db/client";

/**
 * Rolling-window retention sweep.
 *
 * Editions older than `retentionDays` are removed completely: database rows,
 * EPUB blobs, and search index entries, all together. Keeping any one of the
 * three behind the others produces the two failure modes worth avoiding — a
 * catalog entry whose download 404s, or a search hit for a story that can no
 * longer be built.
 *
 * Blob deletion is best-effort. A missing file is not an error (the row is
 * going away regardless), and `artifactUsable()` already treats an absent blob
 * as a cache miss rather than trusting the ledger.
 */
export default defineTask({
  meta: {
    name: "retention",
    description: "Delete editions outside the rolling retention window",
  },
  async run() {
    const cfg = config();
    const cutoff = shiftDate(today(cfg.editionTz), -cfg.retentionDays);
    const db = getDb();

    const expired = db
      .query<{ date: string }, [string]>(`SELECT date FROM editions WHERE date < ? ORDER BY date`)
      .all(cutoff);

    if (expired.length === 0) {
      return { result: { cutoff, editions: 0, blobs: 0 } };
    }

    const paths: string[] = [];
    let removed = 0;

    for (const { date } of expired) {
      const stories = db
        .query<{ id: number }, [string]>(`SELECT id FROM stories WHERE edition_date = ?`)
        .all(date);

      for (const { id } of stories) paths.push(storyEpubPath(id));
      paths.push(editionEpubPath(date));

      // Rows first, inside a transaction. If blob deletion then fails partway
      // the leftovers are unreferenced garbage rather than dangling pointers.
      tx(() => {
        for (const { id } of stories) {
          db.query(`DELETE FROM search_fts WHERE story_id = ?`).run(id);
          db.query(`DELETE FROM builds WHERE kind = 'story' AND build_key = ?`).run(String(id));
          db.query(`DELETE FROM story_assets WHERE story_id = ?`).run(id);
        }
        db.query(`DELETE FROM builds WHERE kind = 'edition' AND build_key = ?`).run(date);
        // stories, articles and comments all cascade from this.
        db.query(`DELETE FROM editions WHERE date = ?`).run(date);
      });

      removed += 1;
      console.log(`[retention] dropped edition ${date} (${stories.length} stories)`);
    }

    let blobs = 0;
    for (const path of paths) {
      try {
        await unlink(path);
        blobs += 1;
      } catch {
        // Already gone, never built, or pruned by an earlier run.
      }
    }

    // Assets are content-addressed and shared between the per-story and digest
    // EPUBs, so they are only safe to remove once nothing references them.
    //
    // Both reference tables have to be consulted. A digest's cover belongs to
    // an edition rather than to any one story, so checking `story_assets`
    // alone would unlink the cover of every edition still in the window - and
    // then, because `asset_urls` cascades, quietly re-rasterise it on the next
    // request.
    const orphans = db
      .query<{ sha256: string; path: string }, []>(
        `SELECT a.sha256, a.path FROM assets a
          WHERE NOT EXISTS (SELECT 1 FROM story_assets s WHERE s.sha256 = a.sha256)
            AND NOT EXISTS (SELECT 1 FROM edition_assets e WHERE e.sha256 = a.sha256)`,
      )
      .all();

    for (const orphan of orphans) {
      try {
        await unlink(orphan.path);
        blobs += 1;
      } catch {
        // Best effort, as above.
      }
      db.query(`DELETE FROM assets WHERE sha256 = ?`).run(orphan.sha256);
    }

    return { result: { cutoff, editions: removed, blobs } };
  },
});
