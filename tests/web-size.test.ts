/**
 * The offline-save size estimate.
 *
 * Two halves, and they fail for different reasons. The arithmetic is pure and
 * is pinned here against the shape it was fitted to - shell plus bodies plus a
 * fixed cost per comment - so a coefficient that gets "tidied" shows up as a
 * failure rather than as a number on a button that is quietly wrong by a
 * third.
 *
 * The query half is the one worth the temp database. `length()` on a `TEXT`
 * value counts characters, and this codebase deliberately casts to `blob` to
 * get octets instead; on ASCII fixtures the two agree exactly, which is
 * precisely how that cast gets deleted by someone simplifying the SQL. The
 * fixtures below are therefore not ASCII.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

import { resetConfig, setConfigForTests } from "~/config";
import { getDb, resetDbForTests } from "~/db/client";
import {
  COMMENT_CHROME_BYTES,
  PAGE_SHELL_BYTES,
  STORY_ROW_BYTES,
  WIRE_DIVISOR,
  estimateEditionPageBytes,
  estimateEditionSave,
  estimateStoryPageBytes,
} from "~/web/size";
import { makeTempDataDir } from "./helpers/data-dir";

const BASE = 1_755_302_400; // 2025-08-16T00:00:00Z
const DATE = "2026-08-16";

let dir: string;

function seedEdition(date: string, storyCount: number): void {
  getDb()
    .query(
      `INSERT INTO editions (date, tz, start_unix, end_unix, closed_at, ingested_at, story_count, state)
       VALUES (?, 'Europe/Amsterdam', ?, ?, ?, ?, ?, 'ingested')`,
    )
    .run(date, BASE, BASE + 86400, BASE + 86400, BASE + 86400, storyCount);
}

function seedStory(id: number, date = DATE): void {
  getDb()
    .query(
      `INSERT INTO stories (id, edition_date, rank, title, url, domain, author,
                            points, num_comments, created_at_i, story_text, is_text_post)
       VALUES (?, ?, 1, 'Good system design', 'https://example.test/', 'example.test',
               'ingve', 1, 0, ?, NULL, 0)`,
    )
    .run(id, date, BASE);
}

function seedArticle(storyId: number, xhtml: string): void {
  getDb()
    .query(
      `INSERT INTO articles (story_id, state, word_count, xhtml, markdown)
       VALUES (?, 'ok', 100, ?, '')`,
    )
    .run(storyId, xhtml);
}

function seedComment(id: number, storyId: number, textHtml: string): void {
  getDb()
    .query(
      `INSERT INTO comments (id, story_id, parent_id, root_id, depth, sort_index,
                             author, created_at_i, text_html)
       VALUES (?, ?, NULL, ?, 0, 0, 'alice', ?, ?)`,
    )
    .run(id, storyId, id, BASE + 3600, textHtml);
}

/** Bytes of a string as UTF-8, which is what the page is served as. */
function utf8(value: string): number {
  return new TextEncoder().encode(value).length;
}

beforeEach(() => {
  dir = makeTempDataDir("hn-opds-size-");
  setConfigForTests({ dataDir: dir });
  resetDbForTests();
});

afterEach(() => {
  resetDbForTests();
  resetConfig();
  rmSync(dir, { recursive: true, force: true });
});

describe("estimateStoryPageBytes", () => {
  test("is the shell, both bodies, and a fixed cost per comment", () => {
    expect(
      estimateStoryPageBytes({ articleBytes: 1000, commentBytes: 2000, commentCount: 4 }),
    ).toBe(PAGE_SHELL_BYTES + 1000 + 2000 + COMMENT_CHROME_BYTES * 4);
  });

  test("passes both bodies through at 1:1", () => {
    // The fit put these coefficients at 0.999 and 1.014, which is the check
    // that the renderer really does emit the stored HTML byte for byte. A
    // coefficient here would mean the model had stopped describing the code.
    const base = estimateStoryPageBytes({
      articleBytes: 0,
      commentBytes: 0,
      commentCount: 0,
    });
    expect(
      estimateStoryPageBytes({ articleBytes: 5000, commentBytes: 0, commentCount: 0 }) - base,
    ).toBe(5000);
    expect(
      estimateStoryPageBytes({ articleBytes: 0, commentBytes: 5000, commentCount: 0 }) - base,
    ).toBe(5000);
  });

  test("charges the comment chrome once per comment, not per byte", () => {
    // The `<details>`, `<summary>`, author link, age and reply count are the
    // same size whatever the comment says, and they are the whole reason a
    // naive sum of the columns underestimates a busy story by 40%.
    const quiet = estimateStoryPageBytes({
      articleBytes: 0,
      commentBytes: 10_000,
      commentCount: 1,
    });
    const busy = estimateStoryPageBytes({
      articleBytes: 0,
      commentBytes: 10_000,
      commentCount: 201,
    });
    expect(busy - quiet).toBe(COMMENT_CHROME_BYTES * 200);
  });

  test("never goes below the shell on nonsensical input", () => {
    // Every input is a SQLite aggregate, and a COALESCE that stopped covering
    // a case would otherwise reach a reader as a negative megabyte count.
    expect(
      estimateStoryPageBytes({ articleBytes: -1, commentBytes: -1, commentCount: -1 }),
    ).toBe(PAGE_SHELL_BYTES);
  });
});

describe("estimateEditionPageBytes", () => {
  test("is the shell plus one row each", () => {
    expect(estimateEditionPageBytes(30)).toBe(PAGE_SHELL_BYTES + STORY_ROW_BYTES * 30);
    expect(estimateEditionPageBytes(0)).toBe(PAGE_SHELL_BYTES);
  });
});

describe("estimateEditionSave", () => {
  test("counts the edition page as well as every story page", () => {
    // The save list the button posts is /archive/<date> followed by one story
    // page each, so an estimate that counted only the stories would be short
    // by the page the reader is standing on.
    seedEdition(DATE, 2);
    seedStory(1);
    seedStory(2);

    const size = estimateEditionSave(DATE);
    expect(size.pages).toBe(3);
    expect(size.storageBytes).toBe(estimateEditionPageBytes(2) + PAGE_SHELL_BYTES * 2);
  });

  test("counts octets, not characters", () => {
    /*
     * The regression this exists for: `length(cast(x as blob))` simplified to
     * `length(x)`. Every character here is multi-byte, so the two answers
     * differ by a factor of three - and on an ASCII fixture they would not
     * differ at all.
     */
    const body = "\u4f60\u597d\u4e16\u754c"; // 4 characters, 12 bytes
    seedEdition(DATE, 1);
    seedStory(1);
    seedArticle(1, body);

    expect(utf8(body)).toBe(12);
    expect(estimateEditionSave(DATE).storageBytes).toBe(
      estimateEditionPageBytes(1) + PAGE_SHELL_BYTES + 12,
    );
  });

  test("sums every comment on a story and charges chrome for each", () => {
    const body = "\u2014 a dash\u2019s worth"; // multi-byte again, on purpose
    seedEdition(DATE, 1);
    seedStory(1);
    seedComment(10, 1, body);
    seedComment(11, 1, body);

    expect(estimateEditionSave(DATE).storageBytes).toBe(
      estimateEditionPageBytes(1) +
        PAGE_SHELL_BYTES +
        utf8(body) * 2 +
        COMMENT_CHROME_BYTES * 2,
    );
  });

  test("treats a story with no extraction and no comments as shell only", () => {
    // Both columns come back through COALESCE rather than as null, which is
    // what keeps the arithmetic from turning into NaN.
    seedEdition(DATE, 1);
    seedStory(1);

    expect(estimateEditionSave(DATE).storageBytes).toBe(
      estimateEditionPageBytes(1) + PAGE_SHELL_BYTES,
    );
  });

  test("ignores stories belonging to another edition", () => {
    seedEdition(DATE, 1);
    seedEdition("2026-08-15", 1);
    seedStory(1, DATE);
    seedStory(2, "2026-08-15");
    seedArticle(2, "x".repeat(50_000));

    expect(estimateEditionSave(DATE).pages).toBe(2);
    expect(estimateEditionSave(DATE).storageBytes).toBeLessThan(50_000);
  });

  test("still answers for an edition with nothing in it", () => {
    seedEdition(DATE, 0);
    expect(estimateEditionSave(DATE)).toEqual({
      pages: 1,
      storageBytes: PAGE_SHELL_BYTES,
      wireBytes: Math.round(PAGE_SHELL_BYTES / WIRE_DIVISOR),
    });
  });

  test("the wire figure is the stored one over the compression ratio", () => {
    seedEdition(DATE, 1);
    seedStory(1);
    seedArticle(1, "x".repeat(100_000));

    const size = estimateEditionSave(DATE);
    expect(size.wireBytes).toBe(Math.round(size.storageBytes / WIRE_DIVISOR));
    // Always the smaller of the two. The button quotes the wire figure and the
    // note beside it quotes the stored one, and a reader who read them the
    // other way round would be told a download costs four times what it does.
    expect(size.wireBytes).toBeLessThan(size.storageBytes);
  });

  test("leans conservative: the divisor is under the worst ratio observed", () => {
    // Compression is the reverse proxy's job, so this is a measurement of the
    // deployment rather than of this code. Six live story pages spanning 41 KB
    // to 654 KB compressed by 3.42x to 3.65x under `encode zstd gzip`. The
    // divisor sits under the worst of those, not near the middle: quoting a
    // typical ratio understates the cost for whichever reader lands on the
    // least compressible page, and that reader did not agree to the surprise.
    expect(WIRE_DIVISOR).toBeLessThanOrEqual(3.42);
    // A floor, so that "be conservative" cannot drift into quoting the
    // uncompressed size and scaring readers off a button they can afford.
    expect(WIRE_DIVISOR).toBeGreaterThan(3);
  });
});
