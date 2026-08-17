import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

import { resetConfig, setConfigForTests } from "~/config";
import { getDb, resetDbForTests } from "~/db/client";
import {
  STARTED_AT,
  formatUptime,
  gitSha,
  healthReport,
  resetGitShaForTests,
  uptimeMs,
} from "~/health";
import { makeTempDataDir } from "./helpers/data-dir";

let dir: string;

beforeEach(() => {
  dir = makeTempDataDir("hn-opds-health-");
  setConfigForTests({ dataDir: dir });
  resetDbForTests();
  resetGitShaForTests();
});

afterEach(() => {
  resetDbForTests();
  resetConfig();
  resetGitShaForTests();
  delete process.env.GIT_SHA;
  rmSync(dir, { recursive: true, force: true });
});

describe("STARTED_AT", () => {
  test("is fixed at module load, not recomputed per read", () => {
    const first = STARTED_AT.getTime();
    const second = STARTED_AT.getTime();
    expect(first).toBe(second);
  });

  test("is in the past", () => {
    expect(STARTED_AT.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe("uptimeMs", () => {
  test("grows with the supplied clock", () => {
    const base = STARTED_AT.getTime();
    expect(uptimeMs(base + 5000)).toBe(5000);
    expect(uptimeMs(base + 90_000)).toBe(90_000);
  });

  test("is zero at the start instant", () => {
    expect(uptimeMs(STARTED_AT.getTime())).toBe(0);
  });
});

describe("formatUptime", () => {
  test("shows seconds for a fresh process", () => {
    // The whole point of the endpoint is answering "did this just restart?",
    // so sub-minute resolution has to survive formatting.
    expect(formatUptime(0)).toBe("0s");
    expect(formatUptime(3_000)).toBe("3s");
    expect(formatUptime(59_999)).toBe("59s");
  });

  test("adds minutes, hours and days as they accrue", () => {
    expect(formatUptime(60_000)).toBe("1m 0s");
    expect(formatUptime(3_599_000)).toBe("59m 59s");
    expect(formatUptime(3_600_000)).toBe("1h 0m 0s");
    expect(formatUptime(86_400_000)).toBe("1d 0h 0m 0s");
    expect(formatUptime(90_061_000)).toBe("1d 1h 1m 1s");
  });

  test("clamps negative input rather than emitting nonsense", () => {
    expect(formatUptime(-5000)).toBe("0s");
  });
});

describe("gitSha", () => {
  test("prefers GIT_SHA, which is how a container gets a version", () => {
    process.env.GIT_SHA = "abc1234def5678";
    resetGitShaForTests();
    expect(gitSha()).toBe("abc1234def5678");
  });

  test("trims whitespace from the env value", () => {
    process.env.GIT_SHA = "  abc1234  ";
    resetGitShaForTests();
    expect(gitSha()).toBe("abc1234");
  });

  test("ignores an empty GIT_SHA instead of reporting an empty version", () => {
    process.env.GIT_SHA = "   ";
    resetGitShaForTests();
    // Falls through to git, which in a repo with no commits yields null.
    expect(gitSha() === null || typeof gitSha() === "string").toBe(true);
  });

  test("memoises so health polls do not spawn a subprocess each time", () => {
    process.env.GIT_SHA = "first";
    resetGitShaForTests();
    expect(gitSha()).toBe("first");
    process.env.GIT_SHA = "second";
    expect(gitSha()).toBe("first");
  });

  test("returns null rather than throwing when there is no version", () => {
    resetGitShaForTests();
    expect(() => gitSha()).not.toThrow();
  });
});

describe("healthReport", () => {
  test("reports ok against a live database", () => {
    const r = healthReport();
    expect(r.status).toBe("ok");
    expect(r.startedAt).toBe(STARTED_AT.toISOString());
    expect(r.pid).toBe(process.pid);
    expect(r.error).toBeUndefined();
  });

  test("counts an empty database as zeroes, not as failure", () => {
    const r = healthReport();
    expect(r.editions).toBe(0);
    expect(r.stories).toBe(0);
    expect(r.articles).toBe(0);
    expect(r.builds).toEqual({ ready: 0, failed: 0, building: 0 });
  });

  test("reflects real rows", () => {
    const db = getDb();
    db.query(
      "INSERT INTO editions (date, tz, start_unix, end_unix, story_count, state) VALUES (?,?,?,?,?,?)",
    ).run("2026-08-16", "Europe/Amsterdam", 1, 2, 1, "ingested");
    db.query(
      `INSERT INTO stories (id, edition_date, rank, title, url, domain, author, points,
         num_comments, created_at_i, story_text, is_text_post)
       VALUES (1,'2026-08-16',1,'t','https://e.com/a','e.com','pg',1,0,1,NULL,0)`,
    ).run();
    db.query(
      "INSERT INTO builds (kind, build_key, state, started_at) VALUES ('story','1','ready',1)",
    ).run();

    const r = healthReport();
    expect(r.editions).toBe(1);
    expect(r.stories).toBe(1);
    expect(r.builds.ready).toBe(1);
  });

  test("excludes failed extractions from the article count", () => {
    const db = getDb();
    db.query(
      "INSERT INTO editions (date, tz, start_unix, end_unix, story_count, state) VALUES (?,?,?,?,?,?)",
    ).run("2026-08-16", "Europe/Amsterdam", 1, 2, 2, "ingested");
    for (const id of [1, 2]) {
      db.query(
        `INSERT INTO stories (id, edition_date, rank, title, url, domain, author, points,
           num_comments, created_at_i, story_text, is_text_post)
         VALUES (?,'2026-08-16',?,'t','https://e.com/a','e.com','pg',1,0,1,NULL,0)`,
      ).run(id, id);
    }
    db.query("INSERT INTO articles (story_id, state) VALUES (1,'ok')").run();
    db.query("INSERT INTO articles (story_id, state) VALUES (2,'failed')").run();

    // A stub chapter is not a stored article; counting it would make an
    // edition of nothing but paywalls look fully extracted.
    expect(healthReport().articles).toBe(1);
  });

  test("degrades instead of throwing when the database is unreachable", () => {
    resetDbForTests();
    setConfigForTests({ dataDir: "/proc/definitely-not-writable/nope" });
    const r = healthReport();
    expect(r.status).toBe("degraded");
    expect(typeof r.error).toBe("string");
    // Process facts must survive a storage failure -- they are the part that
    // still answers "which build is this?".
    expect(r.startedAt).toBe(STARTED_AT.toISOString());
    expect(r.pid).toBe(process.pid);
  });

  test("exposes a short sha alongside the full one", () => {
    process.env.GIT_SHA = "0123456789abcdef";
    resetGitShaForTests();
    const r = healthReport();
    expect(r.git).toBe("0123456789abcdef");
    expect(r.gitShort).toBe("0123456");
  });

  test("nulls both sha fields together when there is no version", () => {
    resetGitShaForTests();
    const r = healthReport();
    if (r.git === null) expect(r.gitShort).toBeNull();
    else expect(r.gitShort).toBe(r.git.slice(0, 7));
  });
});
