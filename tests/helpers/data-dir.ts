/**
 * Throwaway data directories, pre-seeded with an already-migrated database.
 *
 * Most suites give every test its own `dataDir` so that blobs and rows cannot
 * leak between cases. The cost of that isolation is one fresh SQLite file per
 * test, and creating one is dominated by applying `SCHEMA_SQL`: ~14 `CREATE
 * TABLE` statements plus indexes, each committed through a WAL fsync. Measured
 * at ~5ms per test, over ~75 database creations in the suite.
 *
 * The schema is identical every time, so it is built **once per process** into
 * a template directory and thereafter copied. Copying a ~40 KB SQLite file is a
 * single `copyFileSync`, which is roughly a third of the cost of replaying the
 * DDL, and it stays byte-identical to what the DDL would have produced.
 *
 * The template is built by calling the real `getDb()` rather than by executing
 * `SCHEMA_SQL` here. That keeps the file name, the directory layout and the
 * applied schema definitionally in step with production: if `getDb()` starts
 * creating another table or moves the file, the template follows automatically
 * instead of silently drifting.
 */
import { copyFileSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { resetConfig, setConfigForTests } from "~/config";
import { getDb, resetDbForTests } from "~/db/client";

let template: string[] | undefined;

const TEMPLATE_PREFIX = "hn-opds-template-";

/**
 * Removes template directories left by earlier runs.
 *
 * The template outlives every test in the process, so there is no lifecycle
 * hook that can delete it: `process.on("exit")` does not fire under `bun test`,
 * and an `afterAll` in this module would run once and pull the directory out
 * from under the files that had not run yet. Sweeping on the way in instead
 * keeps the litter bounded at roughly one directory per recent run.
 *
 * Only directories older than an hour are touched, so a concurrent `bun test`
 * cannot have its template deleted mid-run.
 */
function sweepStaleTemplates(): void {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const entry of readdirSync(tmpdir())) {
    if (!entry.startsWith(TEMPLATE_PREFIX)) continue;
    const path = join(tmpdir(), entry);
    try {
      if (statSync(path).mtimeMs < cutoff) rmSync(path, { recursive: true, force: true });
    } catch {
      // Raced with another run that swept or rebuilt it first; nothing to do.
    }
  }
}

/**
 * Builds the migrated database once, through the production code path.
 *
 * The connection is closed before returning so that WAL contents are
 * checkpointed back into the main file; otherwise the copied template would be
 * missing every table, which live in the uncommitted `-wal` sidecar.
 */
function buildTemplate(): string[] {
  sweepStaleTemplates();
  const dir = mkdtempSync(join(tmpdir(), TEMPLATE_PREFIX));
  // Only ever reached from a `beforeEach`, before the test installs its own
  // config, so clobbering and then restoring the config here is safe.
  setConfigForTests({ dataDir: dir });
  resetDbForTests();
  // TRUNCATE folds the WAL back into the main file and empties the sidecar, so
  // the single main file below is a complete database. Without it the tables
  // would live only in `-wal` and every copy would need that sidecar too.
  getDb().exec("PRAGMA wal_checkpoint(TRUNCATE)");
  resetDbForTests();
  resetConfig();

  // `-wal` is now empty and `-shm` is pure scratch, so neither is worth
  // copying 127 times. Filtering by suffix keeps this independent of whatever
  // `getDb()` decides to name the database file.
  return readdirSync(dir)
    .map((entry) => join(dir, entry))
    .filter((path) => !/-wal$|-shm$/.test(path) && statSync(path).isFile());
}

/**
 * Creates a fresh temp data dir containing an already-migrated database.
 *
 * Drop-in replacement for `mkdtempSync(join(tmpdir(), prefix))`. The caller
 * still owns the directory and is responsible for removing it.
 */
export function makeTempDataDir(prefix: string): string {
  const src = (template ??= buildTemplate());
  const dir = mkdtempSync(join(tmpdir(), prefix));
  // The blob subdirectories are left out: they are empty, and `getDb()`
  // recreates them via `ensureDirs()` on first use anyway.
  for (const from of src) copyFileSync(from, join(dir, basename(from)));
  return dir;
}
