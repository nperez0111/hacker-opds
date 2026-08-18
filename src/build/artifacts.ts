/**
 * Artifact persistence and the `builds` ledger.
 *
 * Built EPUBs are immutable: an edition is only built once its window has
 * settled, so the bytes for a given key never change. That lets every artifact
 * be served with a strong ETag and `immutable` caching. The sha256 recorded
 * here is the ETag source.
 */

import { config } from "~/config";
import { blobPath, ensureDirs, getDb } from "~/db/client";

export type BuildKind = "story" | "edition";
export type BuildState = "building" | "ready" | "failed";

export interface BuildRow {
  kind: BuildKind;
  build_key: string;
  state: BuildState;
  started_at: number | null;
  finished_at: number | null;
  path: string | null;
  bytes: number | null;
  sha256: string | null;
  error: string | null;
}

export function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

export function storyEpubPath(storyId: number): string {
  return blobPath("epub", `story-${storyId}.epub`);
}

export function editionEpubPath(date: string): string {
  return blobPath("epub", `edition-${date}.epub`);
}

export function getBuild(kind: BuildKind, key: string | number): BuildRow | null {
  return (
    (getDb()
      .query("SELECT * FROM builds WHERE kind = ? AND build_key = ?")
      .get(kind, String(key)) as BuildRow | null) ?? null
  );
}

/**
 * Byte sizes of the story EPUBs that are already built, keyed by story id.
 *
 * Exists for RSS enclosures, which are required to carry a `length`. Guessing
 * one, or sending 0, is worse than omitting the enclosure: a reader that
 * pre-downloads enclosures will either truncate the book or report a broken
 * download. So an unbuilt story simply has no enclosure, and the item still
 * carries the full article text.
 *
 * The ledger alone is enough, with no `Bun.file().exists()` per row. If a blob
 * has been swept from disk while its row still says ready, `buildStoryEpub`
 * notices (`artifactUsable`) and rebuilds on request; rebuilds are
 * deterministic - the EPUB clock is pinned to the story's submission time - so
 * the length advertised here still describes the bytes that get served.
 */
export function readyStoryEpubBytes(storyIds: number[]): Map<number, number> {
  if (storyIds.length === 0) return new Map();
  const rows = getDb()
    .query<{ build_key: string; bytes: number }, string[]>(
      `SELECT build_key, bytes FROM builds
        WHERE kind = 'story' AND state = 'ready' AND bytes IS NOT NULL
          AND build_key IN (${storyIds.map(() => "?").join(",")})`,
    )
    .all(...storyIds.map(String));
  return new Map(rows.map((row) => [Number(row.build_key), row.bytes]));
}

export function markBuilding(kind: BuildKind, key: string | number): void {
  getDb().run(
    `INSERT INTO builds (kind, build_key, state, started_at, finished_at, path, bytes, sha256, error)
     VALUES (?, ?, 'building', ?, NULL, NULL, NULL, NULL, NULL)
     ON CONFLICT(kind, build_key) DO UPDATE SET
       state = 'building', started_at = excluded.started_at,
       finished_at = NULL, error = NULL`,
    [kind, String(key), Math.floor(Date.now() / 1000)],
  );
}

/**
 * An upsert rather than the obvious `UPDATE ... WHERE`, because the row this
 * finishes is not guaranteed to still be there. `reapStaleBuilds` deletes
 * `building` rows it judges abandoned, and its judgement is a timeout: a build
 * that outlives the threshold is still running and will still finish. With an
 * UPDATE that finish matched no rows, and the `getBuild(...)!` below returned
 * null through a non-null assertion -- a TypeError in the caller, several
 * frames from the cause. Re-creating the row costs nothing and makes the
 * reaper's threshold a performance question instead of a correctness one.
 */
export function markReady(
  kind: BuildKind,
  key: string | number,
  info: { path: string; bytes: number; sha256: string },
): BuildRow {
  const at = Math.floor(Date.now() / 1000);
  getDb().run(
    `INSERT INTO builds (kind, build_key, state, started_at, finished_at, path, bytes, sha256, error)
     VALUES (?, ?, 'ready', ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(kind, build_key) DO UPDATE SET
       state = 'ready', finished_at = excluded.finished_at, path = excluded.path,
       bytes = excluded.bytes, sha256 = excluded.sha256, error = NULL`,
    [kind, String(key), at, at, info.path, info.bytes, info.sha256],
  );
  return getBuild(kind, key)!;
}

export function markFailed(kind: BuildKind, key: string | number, error: string): BuildRow {
  getDb().run(
    `INSERT INTO builds (kind, build_key, state, started_at, finished_at, error)
     VALUES (?, ?, 'failed', ?, ?, ?)
     ON CONFLICT(kind, build_key) DO UPDATE SET
       state = 'failed', finished_at = excluded.finished_at, error = excluded.error`,
    [
      kind,
      String(key),
      Math.floor(Date.now() / 1000),
      Math.floor(Date.now() / 1000),
      error.slice(0, 2000),
    ],
  );
  return getBuild(kind, key)!;
}

/**
 * Removes the ledger row entirely.
 *
 * Used when a build is *deferred* rather than failed - a rate limit upstream
 * says nothing about the story, so leaving a `failed` row would misreport it in
 * /healthz and in the reset script's summary. Dropping the row makes the story
 * simply look unbuilt, which is exactly what it is.
 */
export function clearBuild(kind: BuildKind, key: string | number): void {
  getDb().run("DELETE FROM builds WHERE kind = ? AND build_key = ?", [kind, String(key)]);
}

/**
 * How long a `building` row may sit before it is presumed abandoned.
 *
 * Derived from `hnMaxWaitMs` rather than hard-coded, because that is what
 * actually bounds a legitimate build: a story throttled by HN waits out its
 * whole budget before giving up. Double it, with an hour as the floor, so the
 * threshold still has headroom if the budget is configured down.
 */
export function staleBuildMs(): number {
  return Math.max(2 * config().hnMaxWaitMs, 60 * 60 * 1000);
}

/**
 * Drops `building` rows whose build cannot still be running.
 *
 * Nothing else cleans these up. `started_at` was written and never read back,
 * so a process killed mid-build -- a container restart, an OOM, an operator
 * with a `docker exec` and second thoughts -- left a `building` row forever.
 * That row is not merely untidy: `editionsNeedingDigest` requires every story
 * to be `ready`, and `building` is not `ready`, so one abandoned story silently
 * withholds its entire edition's digest until the day ages out of retention.
 * Observed in production on 2026-08-14, where two stories held back a
 * completed 30-story edition.
 *
 * Deletes rather than marking `failed`, matching `clearBuild`: nothing is known
 * to be wrong with the story, so the honest state is "unbuilt", which is also
 * the state that lets the sweep in the prewarm task pick it up again.
 *
 * Safe against a false positive -- a build that outlives the threshold and then
 * succeeds re-creates its row through `markReady`.
 */
export function reapStaleBuilds(olderThanMs = staleBuildMs()): BuildRow[] {
  const cutoff = Math.floor((Date.now() - olderThanMs) / 1000);
  const db = getDb();
  // Selected before deleting so the caller can say which builds were reaped.
  // A silent reaper would replace one invisible failure mode with another.
  const stale = db
    .query<BuildRow, [number]>(
      "SELECT * FROM builds WHERE state = 'building' AND started_at IS NOT NULL AND started_at < ?",
    )
    .all(cutoff);
  if (stale.length === 0) return [];

  db.run("DELETE FROM builds WHERE state = 'building' AND started_at IS NOT NULL AND started_at < ?", [
    cutoff,
  ]);
  return stale;
}

/** Writes bytes to disk and returns the facts needed for the ledger. */
export async function writeArtifact(
  path: string,
  bytes: Uint8Array,
): Promise<{ path: string; bytes: number; sha256: string }> {
  ensureDirs();
  await Bun.write(path, bytes);
  return { path, bytes: bytes.byteLength, sha256: sha256Hex(bytes) };
}

/**
 * True when the ledger says ready *and* the file is still on disk. Retention
 * sweeps and volume loss can desynchronise the two, in which case the caller
 * should rebuild rather than serve a 404.
 */
export async function artifactUsable(row: BuildRow | null): Promise<boolean> {
  if (!row || row.state !== "ready" || !row.path) return false;
  return await Bun.file(row.path).exists();
}
