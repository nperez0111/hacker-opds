/**
 * Schema is applied idempotently at startup. `by` and `key` are SQLite
 * keywords, so the HN submitter column is `author` and the build key column is
 * `build_key`.
 */
export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS editions (
  date        TEXT PRIMARY KEY,          -- YYYY-MM-DD in edition tz
  tz          TEXT NOT NULL,
  start_unix  INTEGER NOT NULL,
  end_unix    INTEGER NOT NULL,
  closed_at   INTEGER,                   -- when the window became eligible
  ingested_at INTEGER,
  built_at    INTEGER,
  story_count INTEGER NOT NULL DEFAULT 0,
  state       TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS stories (
  id            INTEGER PRIMARY KEY,     -- HN item id
  edition_date  TEXT NOT NULL REFERENCES editions(date) ON DELETE CASCADE,
  rank          INTEGER NOT NULL,
  title         TEXT NOT NULL,
  url           TEXT,                    -- null for text posts
  domain        TEXT,
  author        TEXT,
  points        INTEGER NOT NULL DEFAULT 0,
  num_comments  INTEGER NOT NULL DEFAULT 0,
  created_at_i  INTEGER NOT NULL,
  story_text    TEXT,                    -- Ask/Show/Tell HN body
  is_text_post  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_stories_edition ON stories(edition_date, rank);
CREATE INDEX IF NOT EXISTS idx_stories_created ON stories(created_at_i DESC);

CREATE TABLE IF NOT EXISTS articles (
  story_id    INTEGER PRIMARY KEY REFERENCES stories(id) ON DELETE CASCADE,
  state       TEXT NOT NULL,             -- ok | failed | skipped
  fetched_at  INTEGER,
  http_status INTEGER,
  final_url   TEXT,
  title       TEXT,
  author      TEXT,
  published   TEXT,
  site        TEXT,
  language    TEXT,
  word_count  INTEGER,
  xhtml       TEXT,                      -- sanitized article body (XHTML)
  markdown    TEXT,
  error_code  TEXT
);

CREATE TABLE IF NOT EXISTS comments (
  id           INTEGER PRIMARY KEY,      -- HN item id
  story_id     INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  parent_id    INTEGER,
  root_id      INTEGER NOT NULL,
  depth        INTEGER NOT NULL,
  sort_index   INTEGER NOT NULL,         -- preorder position, HN native order
  author       TEXT,
  created_at_i INTEGER,
  text_html    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_story ON comments(story_id, sort_index);
CREATE INDEX IF NOT EXISTS idx_comments_root  ON comments(story_id, root_id, sort_index);

CREATE TABLE IF NOT EXISTS assets (
  sha256   TEXT PRIMARY KEY,
  kind     TEXT NOT NULL,                -- image | cover
  src_url  TEXT,
  path     TEXT NOT NULL,
  bytes    INTEGER NOT NULL,
  width    INTEGER,
  height   INTEGER,
  media_type TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS story_assets (
  story_id   INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  sha256     TEXT NOT NULL REFERENCES assets(sha256),
  PRIMARY KEY (story_id, sha256)
);

-- The same, for assets owned by a whole edition rather than by one story: the
-- digest EPUB's cover. It cannot hang off a story, because a re-ingest can drop
-- any given story from the day while the edition itself stays.
--
-- Retention's orphan sweep consults both tables before unlinking a blob.
CREATE TABLE IF NOT EXISTS edition_assets (
  edition_date TEXT NOT NULL REFERENCES editions(date) ON DELETE CASCADE,
  sha256       TEXT NOT NULL REFERENCES assets(sha256),
  PRIMARY KEY (edition_date, sha256)
);

-- Maps a source URL to the processed bytes it produced, so a rebuild reuses
-- the download instead of hitting the origin again.
--
-- This cannot live on assets.src_url: assets are keyed by the sha256 of the
-- *processed* output, and two different URLs routinely produce identical bytes
-- (the same logo served from two paths), so a single row cannot record both.
--
-- variant encodes the processing parameters (width, quality). Changing
-- IMAGE_MAX_WIDTH or IMAGE_QUALITY must invalidate the cache rather than
-- silently serve images processed under the old settings, and making it part
-- of the key does that without a migration or a manual purge.
CREATE TABLE IF NOT EXISTS asset_urls (
  src_url    TEXT NOT NULL,
  variant    TEXT NOT NULL,
  sha256     TEXT NOT NULL REFERENCES assets(sha256) ON DELETE CASCADE,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (src_url, variant)
);
CREATE INDEX IF NOT EXISTS idx_asset_urls_sha ON asset_urls(sha256);

CREATE TABLE IF NOT EXISTS builds (
  kind        TEXT NOT NULL,             -- story | edition
  build_key   TEXT NOT NULL,             -- story id | edition date
  state       TEXT NOT NULL,             -- building | ready | failed
  started_at  INTEGER,
  finished_at INTEGER,
  path        TEXT,
  bytes       INTEGER,
  sha256      TEXT,
  error       TEXT,
  PRIMARY KEY (kind, build_key)
);

-- Plain (non-external-content) FTS5: the index spans stories.title and
-- articles.markdown, so there is no single content table to mirror.
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  title,
  body,
  story_id UNINDEXED,
  tokenize = 'porter unicode61'
);
`;
