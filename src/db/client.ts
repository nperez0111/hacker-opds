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

/** Wraps a synchronous unit of work in a transaction. */
export function tx<T>(fn: () => T): T {
  return getDb().transaction(fn)();
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
