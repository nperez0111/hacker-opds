import { describe, expect, test } from "bun:test";
import { DateTime } from "luxon";
import { bookAuthor, dayWindow, hostOf, shiftDate } from "~/core/edition";

const TZ = "Europe/Amsterdam";

describe("dayWindow", () => {
  test("spans exactly 24h on an ordinary day", () => {
    const w = dayWindow("2026-08-16", TZ);
    expect(w.date).toBe("2026-08-16");
    expect(w.endUnix - w.startUnix).toBe(24 * 3600);
  });

  test("starts at local midnight, not UTC midnight", () => {
    const w = dayWindow("2026-08-16", TZ);
    const start = DateTime.fromSeconds(w.startUnix, { zone: TZ });
    expect(start.hour).toBe(0);
    expect(start.minute).toBe(0);
    // CEST is UTC+2 in August, so local midnight is 22:00 UTC the day before.
    expect(DateTime.fromSeconds(w.startUnix, { zone: "utc" }).hour).toBe(22);
  });

  test("is 23h on the spring-forward DST day", () => {
    // Europe/Amsterdam springs forward on the last Sunday of March.
    const w = dayWindow("2026-03-29", TZ);
    expect(w.endUnix - w.startUnix).toBe(23 * 3600);
  });

  test("is 25h on the fall-back DST day", () => {
    // Europe/Amsterdam falls back on the last Sunday of October.
    const w = dayWindow("2026-10-25", TZ);
    expect(w.endUnix - w.startUnix).toBe(25 * 3600);
  });

  test("windows of consecutive days abut exactly with no gap or overlap", () => {
    const a = dayWindow("2026-10-24", TZ);
    const b = dayWindow("2026-10-25", TZ);
    const c = dayWindow("2026-10-26", TZ);
    expect(a.endUnix).toBe(b.startUnix);
    expect(b.endUnix).toBe(c.startUnix);
  });

  test("differs from a UTC-based window", () => {
    const ams = dayWindow("2026-08-16", TZ);
    const utc = dayWindow("2026-08-16", "utc");
    expect(ams.startUnix).not.toBe(utc.startUnix);
    expect(utc.startUnix - ams.startUnix).toBe(2 * 3600);
  });

  test("rejects an invalid date", () => {
    expect(() => dayWindow("not-a-date", TZ)).toThrow();
    expect(() => dayWindow("2026-13-45", TZ)).toThrow();
  });
});

describe("shiftDate", () => {
  test("moves backwards across a month boundary", () => {
    expect(shiftDate("2026-03-01", -1, TZ)).toBe("2026-02-28");
  });

  test("moves across a DST boundary without slipping a day", () => {
    expect(shiftDate("2026-03-30", -1, TZ)).toBe("2026-03-29");
    expect(shiftDate("2026-10-26", -1, TZ)).toBe("2026-10-25");
  });

  test("handles a leap day", () => {
    expect(shiftDate("2028-03-01", -1, TZ)).toBe("2028-02-29");
  });
});

describe("hostOf", () => {
  test("strips a www prefix", () => {
    expect(hostOf("https://www.example.com/a/b")).toBe("example.com");
  });

  test("keeps other subdomains", () => {
    expect(hostOf("https://blog.example.com/x")).toBe("blog.example.com");
  });

  test("returns null for missing or malformed urls", () => {
    expect(hostOf(null)).toBeNull();
    expect(hostOf("not a url")).toBeNull();
  });
});

describe("bookAuthor", () => {
  const linked = { url: "https://seangoedecke.com/good-system-design/", domain: "seangoedecke.com", author: "tosh" };

  test("attributes a linked story to its source domain, not the submitter", () => {
    expect(bookAuthor(linked)).toBe("seangoedecke.com");
  });

  test("groups every article from one site under the same author heading", () => {
    const a = bookAuthor({ ...linked, url: "https://seangoedecke.com/a/", author: "alice" });
    const b = bookAuthor({ ...linked, url: "https://seangoedecke.com/b/", author: "bob" });
    expect(a).toBe(b);
  });

  test("keeps the username for self-posts, where the submitter really is the author", () => {
    expect(bookAuthor({ url: null, domain: null, author: "pg" })).toBe("pg");
  });

  test("falls back to Hacker News when there is no url and no author", () => {
    expect(bookAuthor({ url: null, domain: null, author: null })).toBe("Hacker News");
  });

  test("falls back to the author when a url exists but the domain never parsed", () => {
    expect(bookAuthor({ url: "not a url", domain: null, author: "pg" })).toBe("pg");
  });
});
