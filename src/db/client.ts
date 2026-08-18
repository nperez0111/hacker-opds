import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { config } from "~/config";
import { SCHEMA_SQL } from "./schema";

let db: Database | undefined;

export function dataDir(): string {
  return resolve(config().dataDir);
}

export function blobPath(...parts: string[]): string {
  return join(dataDir(), "blobs", ...parts);
}

export function ensureDirs(): void {
  const root = dataDir();
  // `blobs/fonts` holds the TTF that cover rasterisation is handed by path;
  // see the font note in ~/epub/cover.
  for (const d of ["", "blobs/epub", "blobs/images", "blobs/covers", "blobs/fonts"]) {
    mkdirSync(d ? join(root, d) : root, { recursive: true });
  }
}

export function getDb(): Database {
  if (db) return db;
  ensureDirs();
  db = new Database(join(dataDir(), "hacker-opds.sqlite"), { create: true });
  db.exec(SCHEMA_SQL);
  return db;
}

/**
 * Wraps a synchronous unit of work in a transaction.
 *
 * IMMEDIATE, not the default DEFERRED. A deferred transaction takes its read
 * snapshot on the first SELECT and only asks for the write lock later, and if
 * another connection committed in between SQLite refuses the upgrade with
 * SQLITE_BUSY straight away -- busy_timeout does not cover that case, because
 * waiting could not help a snapshot that is already stale. Every caller here
 * writes, so taking the lock up front costs nothing and turns the one failure
 * mode a timeout cannot absorb into one it can. Nested calls are unaffected:
 * bun:sqlite uses savepoints inside an open transaction and ignores the mode.
 */
export function tx<T>(fn: () => T): T {
  return getDb().transaction(fn).immediate();
}

/**
 * Drops the cached connection so the next `getDb()` reopens against whatever
 * `config().dataDir` currently points at. Tests use this after redirecting the
 * data directory at a temp path; nothing in the server calls it.
 */
export function resetDbForTests(): void {
  db?.close();
  db = undefined;
}
