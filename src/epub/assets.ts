/**
 * Persistent cache for processed article images.
 *
 * Downloading and re-encoding an image is by far the slowest part of building a
 * book, and the result is deterministic: the same URL under the same settings
 * always yields the same bytes. Without a cache every rebuild re-fetches every
 * image, which is slow for us and rude to the origin — a book rebuilt to pick
 * up a stylesheet tweak has no business hitting someone's CDN again.
 *
 * Two tables are involved, and the split matters:
 *
 *   - `assets` is keyed by the sha256 of the *processed* output. It is the
 *     content store, so identical bytes are held once no matter how many
 *     articles reference them.
 *   - `asset_urls` maps (source URL, processing variant) onto that digest. It
 *     exists because the mapping is many-to-one — the same logo served from
 *     two paths collapses to one asset — and because a URL alone is not a
 *     sufficient key once the output depends on width and quality settings.
 *
 * The blob on disk is the source of truth. A row whose file has gone missing
 * (a partial `reset`, a lost volume) is treated as a miss and refetched rather
 * than trusted, so the cache can never hand back bytes that no longer exist.
 */
import { config } from "~/config";
import { blobPath, ensureDirs, getDb, tx } from "~/db/client";
import { log } from "~/log";

export interface AssetBytes {
  sha256: string;
  /**
   * The bytes.
   *
   * Deliberately `Uint8Array<ArrayBuffer>` and not a plain `Uint8Array`, whose
   * buffer is typed `ArrayBufferLike` and could in principle be a
   * `SharedArrayBuffer`. `BodyInit` rejects that, so the loose type compiles
   * everywhere except the one place it matters - handing an asset straight to
   * a `Response` in the cover routes.
   */
  data: Uint8Array<ArrayBuffer>;
  mediaType: string;
  ext: string;
}

/**
 * What an asset is.
 *
 * `image` is something an article referenced and this server downloaded;
 * `cover` is something this server drew. They differ in provenance rather than
 * in handling - both are content-addressed, both live under `blobs/`, both are
 * swept when nothing references them - but the distinction is worth recording:
 * it is the difference between bytes belonging to someone else and bytes
 * belonging to us, which is the first question asked of any of this.
 */
export type AssetKind = "image" | "cover";

export interface AssetInput {
  data: Uint8Array<ArrayBuffer>;
  mediaType: string;
  ext: string;
  /** Defaults to `image`, which is what the article pipeline stores. */
  kind?: AssetKind;
  width?: number | null;
  height?: number | null;
}

/** Blob subdirectory per kind, matching the layout `ensureDirs` creates. */
function blobDir(kind: AssetKind): string {
  return kind === "cover" ? "covers" : "images";
}

/**
 * Identifies the processing settings an asset was produced under.
 *
 * Part of the cache key so that changing `IMAGE_MAX_WIDTH` or `IMAGE_QUALITY`
 * produces a miss instead of quietly serving stale output.
 */
export function assetVariant(): string {
  const cfg = config();
  return `w${cfg.imageMaxWidth}q${cfg.imageQuality}`;
}

function extFor(mediaType: string): string {
  return mediaType === "image/png" ? "png" : "jpg";
}

/** Returns the cached bytes for a URL, or null when absent or unreadable. */
export async function lookupAsset(url: string, variant: string): Promise<AssetBytes | null> {
  const row = getDb()
    .query<
      { sha256: string; path: string; media_type: string },
      [string, string]
    >(
      `SELECT a.sha256, a.path, a.media_type
         FROM asset_urls u JOIN assets a ON a.sha256 = u.sha256
        WHERE u.src_url = ? AND u.variant = ?`,
    )
    .get(url, variant);
  if (!row) return null;

  const file = Bun.file(row.path);
  if (!(await file.exists())) {
    // The ledger outlived the blob. Drop the mapping so the caller refetches
    // and the row does not keep pointing at nothing.
    getDb()
      .query("DELETE FROM asset_urls WHERE src_url = ? AND variant = ?")
      .run(url, variant);
    log("assets").debug({ url, path: row.path }, "cached asset blob missing");
    return null;
  }

  return {
    sha256: row.sha256,
    data: new Uint8Array(await file.arrayBuffer()),
    mediaType: row.media_type,
    ext: extFor(row.media_type),
  };
}

/**
 * Stores processed bytes and maps the URL onto them.
 *
 * The blob is written before the rows so a crash between the two leaves an
 * unreferenced file (harmless, swept later) rather than a row pointing at a
 * file that was never created.
 */
export async function putAsset(
  url: string,
  variant: string,
  input: AssetInput,
): Promise<AssetBytes> {
  const sha256 = Bun.CryptoHasher.hash("sha256", input.data, "hex");
  const ext = input.ext || extFor(input.mediaType);
  const kind = input.kind ?? "image";
  const path = blobPath(blobDir(kind), `${sha256}.${ext}`);

  ensureDirs();
  if (!(await Bun.file(path).exists())) await Bun.write(path, input.data);

  tx(() => {
    getDb()
      .query(
        `INSERT INTO assets (sha256, kind, src_url, path, bytes, width, height, media_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(sha256) DO UPDATE SET
           path = excluded.path, bytes = excluded.bytes, media_type = excluded.media_type`,
      )
      .run(
        sha256,
        kind,
        url,
        path,
        input.data.byteLength,
        input.width ?? null,
        input.height ?? null,
        input.mediaType,
      );
    getDb()
      .query(
        `INSERT INTO asset_urls (src_url, variant, sha256, fetched_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(src_url, variant) DO UPDATE SET
           sha256 = excluded.sha256, fetched_at = excluded.fetched_at`,
      )
      .run(url, variant, sha256, Math.floor(Date.now() / 1000));
  });

  return { sha256, data: input.data, mediaType: input.mediaType, ext };
}

/** Records which assets a story's book depends on, replacing any prior set. */
export function linkStoryAssets(storyId: number, digests: string[]): void {
  tx(() => {
    getDb().query("DELETE FROM story_assets WHERE story_id = ?").run(storyId);
    const stmt = getDb().query(
      "INSERT OR IGNORE INTO story_assets (story_id, sha256) VALUES (?, ?)",
    );
    for (const sha256 of digests) stmt.run(storyId, sha256);
  });
}

/**
 * Adds one asset to a story's set without disturbing the rest.
 *
 * Covers are produced after the article's images have been resolved, and
 * `linkStoryAssets` replaces the whole set - so a cover has to be added, not
 * declared. Being referenced is what keeps retention's orphan sweep from
 * deleting a blob that a book embeds or a catalogue links to; the full cover is
 * both, and the thumbnail is the latter.
 */
export function linkStoryAsset(storyId: number, sha256: string): void {
  getDb()
    .query("INSERT OR IGNORE INTO story_assets (story_id, sha256) VALUES (?, ?)")
    .run(storyId, sha256);
}

/**
 * The same, for an edition.
 *
 * A digest's cover belongs to a day rather than to any one story, and hanging
 * it off (say) the day's top story would make it disappear the moment that
 * story fell out of the ranking on a re-ingest. `edition_assets` cascades from
 * `editions`, so the reference dies exactly when the edition does.
 */
export function linkEditionAsset(date: string, sha256: string): void {
  getDb()
    .query("INSERT OR IGNORE INTO edition_assets (edition_date, sha256) VALUES (?, ?)")
    .run(date, sha256);
}
