/**
 * The builds ledger's self-healing paths.
 *
 * Two holes closed here, both found in production rather than in a test. A
 * `building` row was never cleaned up after the process that wrote it died, and
 * because every background query treats `building` as work in progress, one
 * abandoned row withheld its edition's digest indefinitely. And the background
 * builder only ever visited editions that were not yet ingested, so a story
 * that missed its single pass never got another.
 *
 * Entirely offline: no EPUB is composed, only ledger rows and the queries that
 * read them.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

import {
  getBuild,
  markBuilding,
  markFailed,
  markReady,
  reapStaleBuilds,
  staleBuildMs,
} from "~/build/artifacts";
import { editionsNeedingDigest } from "~/build/edition";
import { storiesNeedingBuild } from "~/build/story";
import { resetConfig, setConfigForTests } from "~/config";
import { shiftDate, today } from "~/core/edition";
import { getDb, resetDbForTests } from "~/db/client";

import { makeTempDataDir } from "./helpers/data-dir";

let dir: string;

/** Yesterday, so the edition is closed without depending on the wall clock. */
const DATE = () => shiftDate(today(), -1);
const OLDER = () => shiftDate(today(), -2);

function seedEdition(date: string, storyCount: number, state = "ingested"): void {
  getDb()
    .query(
      `INSERT INTO editions (date, tz, start_unix, end_unix, closed_at, ingested_at, story_count, state)
       VALUES (?, 'Europe/Amsterdam', 0, 86400, 86400, 86400, ?, ?)`,
    )
    .run(date, storyCount, state);
}

function seedStory(id: number, date: string, rank: number): void {
  getDb()
    .query(
      `INSERT INTO stories (id, edition_date, rank, title, url, domain, author,
                            points, num_comments, created_at_i, story_text, is_text_post)
       VALUES (?, ?, ?, ?, NULL, NULL, 'pg', 1, 0, 0, '<p>text', 1)`,
    )
    .run(id, date, rank, `Story ${id}`);
}

/** Pushes a ledger row's clock back, as if the process had died long ago. */
function backdate(key: string | number, ms: number): void {
  getDb()
    .query("UPDATE builds SET started_at = ? WHERE build_key = ?")
    .run(Math.floor((Date.now() - ms) / 1000), String(key));
}

const READY = { path: "/tmp/x.epub", bytes: 10, sha256: "abc" };

beforeEach(() => {
  dir = makeTempDataDir("hn-opds-builds-");
  setConfigForTests({ dataDir: dir });
  resetDbForTests();
});

afterEach(() => {
  resetDbForTests();
  resetConfig();
  rmSync(dir, { recursive: true, force: true });
});

describe("reapStaleBuilds", () => {
  test("leaves a build that could still be running", () => {
    markBuilding("story", 1);
    expect(reapStaleBuilds()).toEqual([]);
    expect(getBuild("story", 1)?.state).toBe("building");
  });

  test("drops a building row older than the threshold and says which", () => {
    markBuilding("story", 1);
    backdate(1, staleBuildMs() + 60_000);

    const reaped = reapStaleBuilds();
    expect(reaped.map((row) => row.build_key)).toEqual(["1"]);
    // Deleted, not marked failed: nothing is known to be wrong with the story.
    expect(getBuild("story", 1)).toBeNull();
  });

  test("ignores settled rows however old they are", () => {
    markBuilding("story", 1);
    markReady("story", 1, READY);
    markFailed("story", 2, "boom");
    backdate(1, staleBuildMs() * 10);
    backdate(2, staleBuildMs() * 10);

    expect(reapStaleBuilds()).toEqual([]);
    expect(getBuild("story", 1)?.state).toBe("ready");
    expect(getBuild("story", 2)?.state).toBe("failed");
  });

  test("a reaped build that finishes anyway records itself rather than throwing", () => {
    // The threshold is a guess about liveness, so it can be wrong. When it is,
    // the build must still be able to report success: `markReady` upserts.
    markBuilding("story", 1);
    backdate(1, staleBuildMs() + 60_000);
    reapStaleBuilds();

    const row = markReady("story", 1, READY);
    expect(row.state).toBe("ready");
    expect(row.sha256).toBe("abc");
  });

  test("hands the story back to the sweep, which is what unblocks the digest", () => {
    const date = DATE();
    seedEdition(date, 2);
    seedStory(1, date, 1);
    seedStory(2, date, 2);
    markReady("story", 1, READY);
    markBuilding("story", 2);
    backdate(2, staleBuildMs() + 60_000);

    // Before: story 2 looks like work in progress, so nothing touches it and
    // the edition can never qualify for a digest.
    expect(storiesNeedingBuild(3650)).toEqual([]);
    expect(editionsNeedingDigest(3650)).toEqual([]);

    reapStaleBuilds();
    expect(storiesNeedingBuild(3650)).toEqual([2]);
  });
});

describe("storiesNeedingBuild", () => {
  test("returns unbuilt stories newest edition first, then by rank", () => {
    const [recent, older] = [DATE(), OLDER()];
    seedEdition(older, 2);
    seedStory(10, older, 1);
    seedStory(11, older, 2);
    seedEdition(recent, 2);
    seedStory(20, recent, 2);
    seedStory(21, recent, 1);

    expect(storiesNeedingBuild(3650)).toEqual([21, 20, 10, 11]);
  });

  test("skips stories that already have an epub", () => {
    const date = DATE();
    seedEdition(date, 2);
    seedStory(1, date, 1);
    seedStory(2, date, 2);
    markReady("story", 1, READY);

    expect(storiesNeedingBuild(3650)).toEqual([2]);
  });

  test("retries a failed build but leaves one in progress alone", () => {
    const date = DATE();
    seedEdition(date, 2);
    seedStory(1, date, 1);
    seedStory(2, date, 2);
    markFailed("story", 1, "transient");
    markBuilding("story", 2);

    expect(storiesNeedingBuild(3650)).toEqual([1]);
  });

  test("ignores editions outside the lookback window", () => {
    const date = DATE();
    seedEdition("2000-01-01", 1);
    seedStory(99, "2000-01-01", 1);
    seedEdition(date, 1);
    seedStory(1, date, 1);

    expect(storiesNeedingBuild(30_000)).toContain(99);
    expect(storiesNeedingBuild(7)).toEqual([1]);
  });

  test("ignores an edition that is still being ingested", () => {
    const date = DATE();
    seedEdition(date, 1, "pending");
    seedStory(1, date, 1);

    expect(storiesNeedingBuild(3650)).toEqual([]);
  });

  test("caps the batch, keeping the newest", () => {
    const date = DATE();
    seedEdition(date, 5);
    for (let rank = 1; rank <= 5; rank++) seedStory(rank, date, rank);

    expect(storiesNeedingBuild(3650, 2)).toEqual([1, 2]);
  });
});
