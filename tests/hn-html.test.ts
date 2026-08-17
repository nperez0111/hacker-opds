import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resetConfig, setConfigForTests } from "~/config";
import { recordingClock, type RecordingClock } from "./helpers/clock";
import { readFixture } from "./helpers/http-cache";
import { flattenComments } from "~/core/comments";
import {
  buildTree,
  fetchStoryTreeHtml,
  HnThrottled,
  moreLink,
  parseAge,
  parseRows,
  resetHnHtmlStateForTests,
  retryAfterMs,
  throttleRemainingMs,
} from "~/core/hn-html";

/**
 * The fixture is a real capture of https://news.ycombinator.com/item?id=49323157.
 * It is a deliberately awkward story: 58 comment rows, of which only 24 carry
 * the bare `athing comtr` class -- the other 34 are `noshow` or `coll`, and 5
 * are moderation stubs with no body. Parsing only the bare class is exactly the
 * bug that made HN look like it served 24 comments, so this fixture guards the
 * regression directly.
 */
const HTML = readFixture("hn-item-49323157.html");
const STORY = 49_323_157;

describe("parseAge", () => {
  test("takes the trailing unix seconds", () => {
    expect(parseAge("2026-08-11T09:48:02 1786441682")).toBe(1786441682);
  });

  test("falls back to the ISO half when seconds are absent", () => {
    expect(parseAge("2026-08-11T09:48:02")).toBe(Math.floor(Date.parse("2026-08-11T09:48:02") / 1000));
  });

  test("returns null for null, empty and junk", () => {
    expect(parseAge(null)).toBeNull();
    expect(parseAge("")).toBeNull();
    expect(parseAge("not a date")).toBeNull();
  });
});

describe("parseRows", () => {
  const rows = parseRows(HTML);

  test("includes noshow and coll rows", () => {
    // 58 total rows; only 24 carry the bare class.
    expect(rows.length).toBe(58);
  });

  test("finds 53 rows with a comment body", () => {
    expect(rows.filter((r) => !r.stub).length).toBe(53);
  });

  test("marks bodyless moderation rows as stubs", () => {
    const stubs = rows.filter((r) => r.stub);
    expect(stubs.length).toBe(5);
    for (const s of stubs) expect(s.text).toBeNull();
  });

  test("every row has a finite id and indent", () => {
    for (const r of rows) {
      expect(Number.isFinite(r.id)).toBe(true);
      expect(Number.isFinite(r.indent)).toBe(true);
      expect(r.indent).toBeGreaterThanOrEqual(0);
    }
  });

  test("ids are unique", () => {
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  test("bodied rows carry an author and a timestamp", () => {
    for (const r of rows.filter((x) => !x.stub)) {
      expect(r.author).toBeTruthy();
      expect(r.created_at_i).toBeGreaterThan(1_600_000_000);
    }
  });

  test("does not pick up the story submission row", () => {
    expect(rows.some((r) => r.id === STORY)).toBe(false);
  });

  test("comment bodies keep inline markup and drop the reply link", () => {
    const withLink = rows.find((r) => r.text?.includes("<a href="));
    expect(withLink).toBeDefined();
    for (const r of rows) {
      expect(r.text ?? "").not.toContain('class="reply"');
    }
  });

  test("returns nothing for markup with no comment rows", () => {
    expect(parseRows("<html><body><p>nope</p></body></html>")).toEqual([]);
  });
});

describe("moreLink", () => {
  test("is absent on a single-page thread", () => {
    expect(moreLink(HTML)).toBeNull();
  });

  test("resolves a relative morelink against the HN origin", () => {
    const html = '<html><body><a class="morelink" href="item?id=1&amp;p=2">More</a></body></html>';
    expect(moreLink(html)).toBe("https://news.ycombinator.com/item?id=1&p=2");
  });
});

describe("buildTree", () => {
  const tree = buildTree(STORY, parseRows(HTML));

  function walk(node: ReturnType<typeof buildTree>, depth = 0): { depth: number; id: number }[] {
    return node.children.flatMap((c) => [{ depth, id: c.id }, ...walk(c, depth + 1)]);
  }

  test("roots the tree at the story", () => {
    expect(tree.id).toBe(STORY);
    expect(tree.type).toBe("story");
  });

  test("contains every parsed row exactly once", () => {
    const flat = walk(tree);
    expect(flat.length).toBe(58);
    expect(new Set(flat.map((f) => f.id)).size).toBe(58);
  });

  test("preserves document order in a preorder walk", () => {
    const parsed = parseRows(HTML).map((r) => r.id);
    expect(walk(tree).map((f) => f.id)).toEqual(parsed);
  });

  test("tree depth matches the indent attribute", () => {
    const byId = new Map(parseRows(HTML).map((r) => [r.id, r.indent]));
    for (const { id, depth } of walk(tree)) expect(depth).toBe(byId.get(id)!);
  });

  test("indent 0 rows become direct children of the story", () => {
    const topLevel = parseRows(HTML).filter((r) => r.indent === 0).length;
    expect(tree.children.length).toBe(topLevel);
  });

  test("synthetic ladder nests correctly", () => {
    const t = buildTree(1, [
      { id: 10, indent: 0, author: "a", text: "A", created_at_i: 1, stub: false },
      { id: 11, indent: 1, author: "b", text: "B", created_at_i: 2, stub: false },
      { id: 12, indent: 2, author: "c", text: "C", created_at_i: 3, stub: false },
      { id: 13, indent: 1, author: "d", text: "D", created_at_i: 4, stub: false },
      { id: 14, indent: 0, author: "e", text: "E", created_at_i: 5, stub: false },
    ]);
    expect(t.children.map((c) => c.id)).toEqual([10, 14]);
    expect(t.children[0]!.children.map((c) => c.id)).toEqual([11, 13]);
    expect(t.children[0]!.children[0]!.children.map((c) => c.id)).toEqual([12]);
  });

  test("an indent jump greater than one does not lose the row", () => {
    const t = buildTree(1, [
      { id: 10, indent: 0, author: "a", text: "A", created_at_i: 1, stub: false },
      { id: 11, indent: 3, author: "b", text: "B", created_at_i: 2, stub: false },
    ]);
    expect(t.children.map((c) => c.id)).toEqual([10]);
    expect(t.children[0]!.children.map((c) => c.id)).toEqual([11]);
  });

  test("empty row list yields a childless story node", () => {
    expect(buildTree(1, []).children).toEqual([]);
  });
});

describe("integration with flattenComments", () => {
  const rows = flattenComments(STORY, buildTree(STORY, parseRows(HTML)));

  test("drops the 5 stubs, keeping all 53 live comments", () => {
    expect(rows.length).toBe(53);
  });

  test("stub replies are reparented onto the nearest surviving ancestor", () => {
    // Every surviving row must point at another surviving row, or at nothing.
    const ids = new Set(rows.map((r) => r.id));
    for (const r of rows) {
      if (r.parent_id !== null) expect(ids.has(r.parent_id)).toBe(true);
    }
  });

  test("sort_index is dense and ordered", () => {
    expect(rows.map((r) => r.sort_index)).toEqual(rows.map((_, i) => i));
  });

  test("every row carries author, text and timestamp", () => {
    for (const r of rows) {
      expect(r.author).toBeTruthy();
      expect(r.text_html).toBeTruthy();
      expect(r.created_at_i).toBeGreaterThan(1_600_000_000);
    }
  });

  test("depth counts surviving ancestors only", () => {
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const r of rows) {
      const parent = r.parent_id === null ? null : byId.get(r.parent_id);
      expect(r.depth).toBe(parent ? parent.depth + 1 : 0);
    }
  });
});

/**
 * Rate-limit handling.
 *
 * HN throttles hard under bulk load: a 210-story rebuild drew 32x 403 and
 * 22x 429, and the 403 body is literally "Sorry." -- a soft throttle page, not
 * a permanent denial. These tests stub `globalThis.fetch` so the retry path,
 * the serialization slot and the circuit breaker all stay under test without
 * touching the network.
 *
 * `hnRequestDelayMs` is set to 0 throughout, otherwise every case would pay the
 * real 2s inter-request gap.
 *
 * Every case also injects a recording clock via the `sleep` option, so the
 * backoff ladder is walked without any of it being waited out. The durations
 * the code asked for are asserted directly, which pins the behaviour harder
 * than watching `performance.now()` ever did.
 */
describe("throttle handling", () => {
  const realFetch = globalThis.fetch;
  let clock: RecordingClock;

  beforeEach(() => {
    resetHnHtmlStateForTests();
    setConfigForTests({ hnRequestDelayMs: 0, fetchTimeoutMs: 2000 });
    clock = recordingClock();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    resetHnHtmlStateForTests();
    resetConfig();
  });

  /**
   * Serves a scripted sequence of responses, repeating the last one.
   *
   * Retry cases set an explicit `retry-after: 1` so the wait is a second rather
   * than the 5s first rung of the built-in ladder. Deadline cases instead pass
   * a tiny `maxWaitMs`, which makes the very first throttle blow the budget and
   * throw immediately - fast, and it exercises the branch that matters.
   */
  function scriptFetch(
    steps: Array<{ status: number; body?: string; headers?: Record<string, string> }>,
  ) {
    let i = 0;
    globalThis.fetch = (async () => {
      const step = steps[Math.min(i, steps.length - 1)]!;
      i += 1;
      return new Response(step.body ?? "Sorry.", { status: step.status, headers: step.headers });
    }) as unknown as typeof fetch;
    return { count: () => i };
  }

  const RETRY = { "retry-after": "1" };

  /** First rung of the module's own THROTTLE_BACKOFF_MS ladder. */
  const THROTTLE_FIRST_RUNG_MS = 5000;

  test("waits out a 403 and then succeeds", async () => {
    // HN serves its soft throttle page ("Sorry.") under 403, not 429.
    const f = scriptFetch([{ status: 403, headers: RETRY }, { status: 200, body: HTML }]);
    const tree = await fetchStoryTreeHtml(STORY, { maxWaitMs: 10_000, sleep: clock.sleep, now: clock.now });
    expect(f.count()).toBe(2);
    expect(tree).not.toBeNull();
    expect(tree!.children.length).toBeGreaterThan(0);
    // It genuinely waited rather than hot-looping the retry.
    expect(clock.totalMs()).toBeGreaterThan(0);
  });

  test("waits out a 429", async () => {
    const f = scriptFetch([{ status: 429, headers: RETRY }, { status: 200, body: HTML }]);
    expect(
      await fetchStoryTreeHtml(STORY, { maxWaitMs: 10_000, sleep: clock.sleep, now: clock.now }),
    ).not.toBeNull();
    expect(f.count()).toBe(2);
    expect(clock.totalMs()).toBeGreaterThan(0);
  });

  test("waits out a 5xx", async () => {
    const f = scriptFetch([{ status: 503, headers: RETRY }, { status: 200, body: HTML }]);
    expect(
      await fetchStoryTreeHtml(STORY, { maxWaitMs: 10_000, sleep: clock.sleep, now: clock.now }),
    ).not.toBeNull();
    expect(f.count()).toBe(2);
    expect(clock.totalMs()).toBeGreaterThan(0);
  });

  test("honours Retry-After rather than its own ladder", async () => {
    const f = scriptFetch([{ status: 429, headers: RETRY }, { status: 200, body: HTML }]);
    expect(
      await fetchStoryTreeHtml(STORY, { maxWaitMs: 10_000, sleep: clock.sleep, now: clock.now }),
    ).not.toBeNull();

    // The header said 1s, so 1s is what must be slept -- and the 5s first rung
    // of the built-in ladder must never appear.
    const slept = clock.waits.filter((ms) => ms > 0);
    expect(slept).toContain(1000);
    expect(slept).not.toContain(THROTTLE_FIRST_RUNG_MS);
    expect(Math.max(...slept)).toBeLessThan(THROTTLE_FIRST_RUNG_MS);
    expect(f.count()).toBe(2);
  });

  test("throws HnThrottled once the wait budget is spent", async () => {
    const f = scriptFetch([{ status: 403 }]);
    await expect(
      fetchStoryTreeHtml(STORY, { maxWaitMs: 50, sleep: clock.sleep, now: clock.now }),
    ).rejects.toBeInstanceOf(HnThrottled);
    // One call, then it recognises the wait would blow the budget.
    expect(f.count()).toBe(1);
  });

  test("never returns null on a throttle, so no caller can silently degrade", async () => {
    // Null means "markup changed", which fails the build. A throttle must stay
    // distinguishable from that so it can be retried rather than reported as a
    // parser bug.
    scriptFetch([{ status: 403 }]);
    let thrown: unknown;
    try {
      await fetchStoryTreeHtml(STORY, { maxWaitMs: 50, sleep: clock.sleep, now: clock.now });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HnThrottled);
    expect((thrown as HnThrottled).waitMs).toBeGreaterThan(0);
  });

  test("records the cool-off so other callers back off too", async () => {
    scriptFetch([{ status: 403 }]);
    // Read on the same clock the code records against, or this measures the
    // gap between the virtual clock and the real one rather than the cool-off.
    expect(throttleRemainingMs(clock.now())).toBe(0);
    await fetchStoryTreeHtml(STORY, { maxWaitMs: 50, sleep: clock.sleep, now: clock.now }).catch(() => {});
    // A throttle found by one story must slow the whole queue, not just itself.
    expect(throttleRemainingMs(clock.now())).toBeGreaterThan(0);
  });

  test("returns null when the page parses to nothing", async () => {
    // The markup-changed case. Distinct from a throttle: this one is a bug in
    // the parser, and the caller turns it into a failed build.
    scriptFetch([{ status: 200, body: "<html><body><p>nothing here</p></body></html>" }]);
    expect(await fetchStoryTreeHtml(STORY, { maxWaitMs: 5000, sleep: clock.sleep, now: clock.now })).toBeNull();
  });

  test("returns null on a non-throttle error status", async () => {
    scriptFetch([{ status: 404, body: "No such item." }]);
    expect(await fetchStoryTreeHtml(STORY, { maxWaitMs: 5000, sleep: clock.sleep, now: clock.now })).toBeNull();
  });

  test("serializes concurrent requests rather than bursting", async () => {
    // Concurrency is what trips HN hardest: 8 parallel requests drew 8 refusals.
    let inFlight = 0;
    let maxInFlight = 0;
    globalThis.fetch = (async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Long enough to overlap if the slot were not serializing, short enough
      // not to matter: four of these is 8ms, not 80ms.
      await Bun.sleep(2);
      inFlight -= 1;
      return new Response(HTML, { status: 200 });
    }) as unknown as typeof fetch;

    await Promise.all(
      [1, 2, 3, 4].map((id) => fetchStoryTreeHtml(id, { maxWaitMs: 5000, sleep: clock.sleep, now: clock.now })),
    );
    expect(maxInFlight).toBe(1);
  });

  test("gives up on a persistent network error without throwing", async () => {
    let i = 0;
    globalThis.fetch = (async () => {
      i += 1;
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;

    expect(await fetchStoryTreeHtml(STORY, { maxWaitMs: 5000, sleep: clock.sleep, now: clock.now })).toBeNull();
    expect(i).toBe(3); // MAX_NETWORK_ATTEMPTS
    // Two gaps between three attempts, and the ladder grows rather than flat-lining.
    expect(clock.waits.filter((ms) => ms >= 500)).toHaveLength(2);
  });

  test("a rejection does not deadlock the serialization chain", async () => {
    let i = 0;
    globalThis.fetch = (async () => {
      i += 1;
      if (i === 1) throw new Error("socket hang up");
      return new Response(HTML, { status: 200 });
    }) as unknown as typeof fetch;

    expect(
      await fetchStoryTreeHtml(STORY, { maxWaitMs: 5000, sleep: clock.sleep, now: clock.now }),
    ).not.toBeNull();
    // A later call must still be served, proving the chain advanced.
    expect(await fetchStoryTreeHtml(2, { maxWaitMs: 5000, sleep: clock.sleep, now: clock.now })).not.toBeNull();
  });
});

describe("retryAfterMs", () => {
  // Tested directly rather than through fetchStoryTreeHtml: driving the cap
  // through the retry loop means either waiting the full 60s or leaving a
  // dangling promise behind. The header parse is pure, so test it as such.
  const withHeader = (value: string | null) =>
    new Response("", { headers: value === null ? {} : { "retry-after": value } });

  test("reads a plain seconds value", () => {
    expect(retryAfterMs(withHeader("5"))).toBe(5000);
  });

  test("caps at 60 seconds so a hostile value cannot stall a build", () => {
    expect(retryAfterMs(withHeader("86400"))).toBe(60_000);
  });

  test("returns null when the header is absent", () => {
    expect(retryAfterMs(withHeader(null))).toBeNull();
  });

  test("ignores non-numeric values", () => {
    // HTTP also allows an HTTP-date form. We do not parse it; falling back to
    // our own backoff is safer than misreading a date as seconds.
    expect(retryAfterMs(withHeader("Wed, 21 Oct 2026 07:28:00 GMT"))).toBeNull();
  });

  test("ignores zero and negative values", () => {
    expect(retryAfterMs(withHeader("0"))).toBeNull();
    expect(retryAfterMs(withHeader("-30"))).toBeNull();
  });

  test("accepts a value exactly at the cap", () => {
    expect(retryAfterMs(withHeader("60"))).toBe(60_000);
  });
});
