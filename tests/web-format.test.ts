/**
 * Presentation helpers for the website.
 *
 * The theme running through most of this file is the timezone. An edition *is*
 * a calendar day in `editionTz`, so every date the site prints has to be
 * rendered in that zone. The obvious way to get this wrong is to let the host's
 * zone leak in - and on a machine whose clock happens to be set to the edition
 * zone that bug is invisible. `withHostTz` moves the process clock somewhere
 * else for the duration of a test so the two cannot be confused.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { resetConfig, setConfigForTests } from "~/config";
import type { StoryRow } from "~/core/edition";
import {
  editionHeading,
  longDate,
  plural,
  readingTime,
  relativeDay,
  shortDate,
  storyMetaParts,
  submittedAt,
} from "~/web/format";

/** 2025-08-15T23:30:00Z. Amsterdam is already on the 16th; UTC is not. */
const SUMMER = 1_755_300_600;
/** 2025-01-15T23:30:00Z. Same trick with CET rather than CEST. */
const WINTER = 1_736_983_800;

/**
 * Runs `fn` with the process timezone set somewhere the edition zone is not.
 *
 * Luxon resolves the system zone per call, so this really does change what a
 * zone-less format would produce. Kiritimati is UTC+14: no other zone shares
 * its offset, and it is a full day ahead of Amsterdam for part of every day.
 */
function withHostTz(zone: string, fn: () => void): void {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

function story(over: Partial<StoryRow> = {}): StoryRow {
  return {
    id: 44921137,
    edition_date: "2026-08-16",
    rank: 1,
    title: "Good system design",
    url: "https://seangoedecke.com/good-system-design/",
    domain: "seangoedecke.com",
    author: "ingve",
    points: 957,
    num_comments: 208,
    created_at_i: SUMMER,
    story_text: null,
    is_text_post: 0,
    ...over,
  };
}

afterEach(() => {
  resetConfig();
});

describe("plural", () => {
  /**
   * The return value *includes* the number. A caller that writes
   * `${n} ${plural(n, "point")}` gets "957 957 points", which is exactly the
   * bug this asserts against.
   */
  test("returns the number and the noun together", () => {
    expect(plural(1, "point")).toBe("1 point");
    expect(plural(2, "point")).toBe("2 points");
    expect(plural(0, "point")).toBe("0 points");
    expect(plural(957, "point")).toBe("957 points");
  });

  test("pluralises by appending s unless told otherwise", () => {
    expect(plural(2, "comment")).toBe("2 comments");
    expect(plural(2, "story", "stories")).toBe("2 stories");
    expect(plural(1, "story", "stories")).toBe("1 story");
  });

  test("only one is singular; zero and negatives are not", () => {
    expect(plural(0, "story", "stories")).toBe("0 stories");
    expect(plural(-1, "point")).toBe("-1 points");
  });
});

describe("storyMetaParts", () => {
  test("leads with the domain, then score, then comments", () => {
    expect(storyMetaParts(story())).toEqual([
      "seangoedecke.com",
      "957 points",
      "208 comments",
    ]);
  });

  test("substitutes Hacker News as the source for a text post", () => {
    expect(
      storyMetaParts(story({ domain: null, is_text_post: 1, points: 1, num_comments: 1 })),
    ).toEqual(["Hacker News", "1 point", "1 comment"]);
  });

  test("omits the source entirely when there is neither a domain nor a text post", () => {
    const parts = storyMetaParts(story({ domain: null, is_text_post: 0 }));
    expect(parts).toEqual(["957 points", "208 comments"]);
  });
});

describe("longDate", () => {
  test("spells out the weekday and month", () => {
    expect(longDate("2026-08-16")).toBe("Sunday, 16 August 2026");
    expect(longDate("2026-01-01")).toBe("Thursday, 1 January 2026");
  });

  test("names the edition's day regardless of the host clock", () => {
    withHostTz("Pacific/Kiritimati", () => {
      expect(longDate("2026-08-16")).toBe("Sunday, 16 August 2026");
    });
    withHostTz("Pacific/Niue", () => {
      expect(longDate("2026-08-16")).toBe("Sunday, 16 August 2026");
    });
  });

  test("follows the configured edition timezone", () => {
    setConfigForTests({ editionTz: "Pacific/Kiritimati" });
    expect(longDate("2026-08-16")).toBe("Sunday, 16 August 2026");
  });

  test("returns an unparseable date unchanged rather than 'Invalid DateTime'", () => {
    expect(longDate("not-a-date")).toBe("not-a-date");
    expect(longDate("")).toBe("");
    expect(longDate("2026-13-45")).toBe("2026-13-45");
  });
});

describe("shortDate", () => {
  test("abbreviates the month and keeps the year", () => {
    expect(shortDate("2026-08-16")).toBe("16 Aug 2026");
    expect(shortDate("2026-09-01")).toBe("1 Sep 2026");
  });

  test("is host-timezone independent", () => {
    withHostTz("Pacific/Kiritimati", () => {
      expect(shortDate("2026-08-16")).toBe("16 Aug 2026");
    });
  });

  test("passes an unparseable date through", () => {
    expect(shortDate("nope")).toBe("nope");
  });
});

describe("relativeDay", () => {
  test("names today and yesterday", () => {
    expect(relativeDay("2026-08-16", "2026-08-16")).toBe("Today");
    expect(relativeDay("2026-08-15", "2026-08-16")).toBe("Yesterday");
  });

  test("counts days up to the end of the week", () => {
    expect(relativeDay("2026-08-14", "2026-08-16")).toBe("2 days ago");
    expect(relativeDay("2026-08-10", "2026-08-16")).toBe("6 days ago");
  });

  test("gives up at a week, where an absolute date reads better", () => {
    expect(relativeDay("2026-08-09", "2026-08-16")).toBeNull();
    expect(relativeDay("2026-01-01", "2026-08-16")).toBeNull();
  });

  test("returns null for a date in the future", () => {
    expect(relativeDay("2026-08-17", "2026-08-16")).toBeNull();
  });

  test("returns null rather than a bogus count for unparseable input", () => {
    expect(relativeDay("nope", "2026-08-16")).toBeNull();
    expect(relativeDay("2026-08-16", "nope")).toBeNull();
  });

  /**
   * The day Amsterdam leaves summer time is 25 hours long, so a naive
   * difference across it is 2.04 days. Rounding is what keeps this correct.
   */
  test("counts whole days across a daylight-saving transition", () => {
    expect(relativeDay("2025-10-25", "2025-10-27")).toBe("2 days ago");
    expect(relativeDay("2025-10-26", "2025-10-27")).toBe("Yesterday");
    // And the spring transition, where the day is 23 hours long.
    expect(relativeDay("2025-03-29", "2025-03-31")).toBe("2 days ago");
    expect(relativeDay("2025-03-30", "2025-03-31")).toBe("Yesterday");
  });

  test("is computed in the edition zone, not the host zone", () => {
    withHostTz("Pacific/Kiritimati", () => {
      expect(relativeDay("2026-08-16", "2026-08-16")).toBe("Today");
      expect(relativeDay("2026-08-15", "2026-08-16")).toBe("Yesterday");
    });
  });
});

describe("editionHeading", () => {
  test("prefers the relative name when there is one", () => {
    expect(editionHeading("2026-08-16", "2026-08-16")).toBe("Today");
    expect(editionHeading("2026-08-15", "2026-08-16")).toBe("Yesterday");
    expect(editionHeading("2026-08-13", "2026-08-16")).toBe("3 days ago");
  });

  test("falls back to the full date once the relative name expires", () => {
    expect(editionHeading("2026-08-09", "2026-08-16")).toBe("Sunday, 9 August 2026");
  });

  test("renders the fallback in the edition zone", () => {
    withHostTz("Pacific/Kiritimati", () => {
      expect(editionHeading("2026-08-09", "2026-08-16")).toBe("Sunday, 9 August 2026");
    });
  });
});

describe("submittedAt", () => {
  /**
   * Absolute, never "3 days ago". The page is cached in a service worker for
   * offline reading, and a relative age baked into a saved page would sit there
   * insisting it was posted three days ago forever.
   */
  test("prints an absolute date and time", () => {
    expect(submittedAt(story())).toBe("16 Aug 2025, 01:30");
    expect(submittedAt(story())).not.toMatch(/ago|Today|Yesterday/);
  });

  test("shifts the instant into the edition zone, crossing midnight if it must", () => {
    // The instant is 23:30 UTC on the 15th. Anything that printed "15 Aug" here
    // is rendering in UTC or west of it.
    expect(submittedAt(story({ created_at_i: SUMMER }))).toBe("16 Aug 2025, 01:30");
    expect(submittedAt(story({ created_at_i: SUMMER }), "utc")).toBe("15 Aug 2025, 23:30");
  });

  test("applies the correct offset for the time of year", () => {
    // CEST in August (+02:00), CET in January (+01:00).
    expect(submittedAt(story({ created_at_i: SUMMER }))).toBe("16 Aug 2025, 01:30");
    expect(submittedAt(story({ created_at_i: WINTER }))).toBe("16 Jan 2025, 00:30");
  });

  test("ignores the host timezone", () => {
    withHostTz("Pacific/Kiritimati", () => {
      // Kiritimati would say "16 Aug 2025, 13:30".
      expect(submittedAt(story({ created_at_i: SUMMER }))).toBe("16 Aug 2025, 01:30");
    });
  });

  test("follows the configured edition timezone", () => {
    setConfigForTests({ editionTz: "Pacific/Kiritimati" });
    expect(submittedAt(story({ created_at_i: SUMMER }))).toBe("16 Aug 2025, 13:30");
  });
});

describe("readingTime", () => {
  test("says nothing at all below a hundred words", () => {
    // Below this the number is noise, and it doubles as the signal that
    // extraction produced nothing worth timing.
    expect(readingTime(0)).toBeNull();
    expect(readingTime(99)).toBeNull();
  });

  test("rounds to whole minutes at 220 words per minute", () => {
    expect(readingTime(220)).toBe("1 min read");
    expect(readingTime(660)).toBe("3 min read");
    expect(readingTime(2200)).toBe("10 min read");
    // 1210/220 = 5.5, which rounds up.
    expect(readingTime(1210)).toBe("6 min read");
  });

  test("never claims zero minutes", () => {
    // 100/220 rounds to 0, and "0 min read" is worse than saying one.
    expect(readingTime(100)).toBe("1 min read");
    expect(readingTime(109)).toBe("1 min read");
  });

  test("returns null for values that are not finite counts", () => {
    expect(readingTime(Number.NaN)).toBeNull();
    expect(readingTime(Number.POSITIVE_INFINITY)).toBeNull();
    expect(readingTime(-500)).toBeNull();
  });
});
