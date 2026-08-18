import { parseHTML } from "linkedom";

import { config, userAgent } from "~/config";
import { errFields, log } from "~/log";
import { realSleep, type Now, type Sleep } from "./clock";
import type { CommentNode } from "./tree";

/**
 * Comment trees parsed from Hacker News' own item page.
 *
 * This is the only comment source. The alternatives were each measured and
 * each fails on something load-bearing:
 *
 * - Algolia `/items/:id` returns the whole tree in one request but omits every
 *   subtree hanging off a dead or deleted parent. That is not a bug on their
 *   side -- it mirrors what HN renders un-collapsed -- but it cost us 24 of 53
 *   comments on one story and 734 of 760 on another.
 * - Algolia comment *search* has complete coverage in one request, but exposes
 *   no ranking field, so sibling order can only be chronological. Measured
 *   against HN's real order, ~46-53% of sibling pairs came out inverted.
 * - HN's Firebase API is complete and correctly ordered, but has no bulk
 *   endpoint: one request per comment, 810 requests and ~2.8s for a 760-comment
 *   thread even at concurrency 128. It was carried for a while as a fallback
 *   and then dropped: it could only ever produce bytes identical to what this
 *   parser already returns, at 810x the request cost.
 *
 * The HTML page gives all three properties at once: complete coverage
 * (including collapsed subtrees, which ship in the markup as `noshow`), exact
 * sibling ordering (document order *is* HN's display order), and one request.
 * Measured on the same 760-comment thread: 1 request, ~1.5s including parse.
 *
 * HN's `robots.txt` allows `/item` and asks for a 30 second crawl delay. One
 * request per story is dramatically politer than 810 Firebase hits.
 *
 * The cost of being single-sourced is that HN's markup is unversioned. That is
 * accepted deliberately: a parse failure surfaces as a failed build rather than
 * being routed around, so it gets noticed and fixed.
 */
const BASE = "https://news.ycombinator.com";

/**
 * HN rate-limits item pages aggressively, and its 403 is a soft throttle page
 * whose body is literally "Sorry." -- not a permanent denial. A 210-story
 * rebuild at concurrency 4 drew 32 x 403 and 22 x 429, and the penalty box
 * outlived a 180s cooldown even at 5s spacing.
 *
 * The response is to wait, not to degrade. EPUBs are built ahead of demand
 * purely because that is cheaper than building them on request -- nothing needs
 * them at any particular moment. A story that cannot be fetched now is simply
 * left unbuilt for the next hourly prewarm to pick up, which costs nothing but
 * time.
 *
 * Two mechanisms implement that:
 *
 * 1. Requests are serialized through a single slot with a delay between them.
 *    Concurrency is what trips the limiter hardest -- 8 parallel requests were
 *    rejected 8/8.
 * 2. A throttle response parks *every* queued request until the penalty is
 *    likely over, so thirty stories do not each independently rediscover that
 *    HN is unhappy. Retries then continue against a caller-supplied deadline.
 */
const THROTTLE_BACKOFF_MS = [5_000, 15_000, 30_000, 60_000, 120_000];

/** Shared cool-off deadline. Set when HN throttles, respected by every caller. */
let throttledUntil = 0;

/** Serializes item-page fetches and enforces the inter-request gap. */
let hnChain: Promise<unknown> = Promise.resolve();

/** Raised when HN is still throttling us past the caller's patience. */
export class HnThrottled extends Error {
  readonly waitMs: number;

  constructor(waitMs: number) {
    super(`hacker news is rate limiting; retry in ~${Math.ceil(waitMs / 1000)}s`);
    this.name = "HnThrottled";
    this.waitMs = waitMs;
  }
}

function noteThrottle(ms: number, now: Now = Date.now): void {
  const until = now() + ms;
  if (until > throttledUntil) throttledUntil = until;
}

/** Milliseconds remaining on the shared cool-off, or 0 when clear. */
export function throttleRemainingMs(now = Date.now()): number {
  return Math.max(0, throttledUntil - now);
}

/** Test seam: clears throttle state so cases cannot leak into each other. */
export function resetHnHtmlStateForTests(): void {
  throttledUntil = 0;
  hnChain = Promise.resolve();
}

/**
 * Runs `fn` after every previously queued HN request, then holds the slot open
 * for `hnRequestDelayMs` so the next caller cannot fire immediately.
 *
 * Also absorbs the shared cool-off, so a throttle discovered by one story
 * silently delays the rest instead of letting each one probe and fail.
 */
function hnSlot<T>(fn: () => Promise<T>, sleep: Sleep = realSleep, now: Now = Date.now): Promise<T> {
  const gated = async () => {
    const wait = throttleRemainingMs(now());
    if (wait > 0) await sleep(wait);
    return fn();
  };

  const run = hnChain.then(gated, gated);
  hnChain = run.then(
    () => sleep(config().hnRequestDelayMs),
    () => sleep(config().hnRequestDelayMs),
  );
  return run;
}

/**
 * Safety valve on pagination. HN currently serves every comment in a single
 * response -- verified up to 3873 rows / 5.5 MB -- and ignores `p=2`. Older
 * versions paginated, so the `morelink` follow is kept, bounded.
 */
const MAX_PAGES = 20;

function backoff(attempt: number): number {
  return 500 * 2 ** attempt + Math.random() * 250;
}

/** One parsed comment row, before the tree is assembled. */
export interface ParsedRow {
  id: number;
  indent: number;
  author: string | null;
  text: string | null;
  created_at_i: number | null;
  /** True when the row is a moderation stub with no comment body. */
  stub: boolean;
}

/**
 * `span.age[title]` looks like `2026-08-11T09:48:02 1786441682`. The trailing
 * integer is exact unix seconds, which beats parsing the ISO half (it carries
 * no zone) or the "4 hours ago" text (rounded, and relative to fetch time).
 */
export function parseAge(title: string | null | undefined): number | null {
  if (!title) return null;
  const match = /(\d{9,})\s*$/.exec(title.trim());
  if (match?.[1]) return Number.parseInt(match[1], 10);
  const iso = Date.parse(title.trim().split(/\s+/)[0] ?? "");
  return Number.isNaN(iso) ? null : Math.floor(iso / 1000);
}

/**
 * Extracts comment rows in document order.
 *
 * Selector note: the row class is `athing comtr`, `athing comtr noshow`,
 * `athing comtr coll`, or `athing comtr coll noshow`. Matching only the bare
 * `athing comtr` string is exactly the mistake that makes HN look like it
 * serves 24 comments when it serves 58 -- `noshow` marks a subtree HN collapses
 * by default, not one it withholds. The story's own row is `athing submission`
 * and does not match `.comtr`, so no filtering is needed.
 */
export function parseRows(html: string): ParsedRow[] {
  const { document } = parseHTML(html);
  const rows: ParsedRow[] = [];

  // Array.from because linkedom types NodeListOf without Symbol.iterator.
  for (const row of Array.from(document.querySelectorAll("tr.athing.comtr"))) {
    const id = Number.parseInt(row.getAttribute("id") ?? "", 10);
    if (!Number.isFinite(id)) continue;

    const indent = Number.parseInt(
      row.querySelector("td.ind")?.getAttribute("indent") ?? "0",
      10,
    );

    const body = row.querySelector("div.commtext");
    const author = row.querySelector("a.hnuser")?.textContent?.trim() || null;
    const created = parseAge(row.querySelector("span.age")?.getAttribute("title"));

    rows.push({
      id,
      indent: Number.isFinite(indent) ? indent : 0,
      author,
      // `div.reply` is a sibling of `div.commtext`, not a child, so the body is
      // already free of the reply link.
      text: body ? body.innerHTML.trim() : null,
      created_at_i: created,
      stub: !body,
    });
  }

  return rows;
}

/** True when the page advertises another page of comments. */
export function moreLink(html: string): string | null {
  const { document } = parseHTML(html);
  const href = document.querySelector("a.morelink")?.getAttribute("href");
  return href ? new URL(href, `${BASE}/`).toString() : null;
}

/**
 * Rebuilds parent/child structure from document order plus indent depth.
 *
 * Rows arrive flattened, exactly as HN paints them: a comment's parent is the
 * nearest preceding row with a smaller indent. A monotonic stack recovers that
 * in one pass.
 *
 * Moderation stubs (`[flagged]`, `[dead]`) stay on the stack even though they
 * carry no text. They are real structural nodes, and dropping them here would
 * reparent their surviving replies to the wrong ancestor. `flattenComments`
 * discards them later, correctly reattaching children to the nearest surviving
 * ancestor.
 */
export function buildTree(storyId: number, rows: ParsedRow[]): CommentNode {
  const root: CommentNode = {
    id: storyId,
    type: "story",
    author: null,
    text: null,
    created_at_i: null,
    children: [],
  };

  const stack: { indent: number; node: CommentNode }[] = [{ indent: -1, node: root }];

  for (const row of rows) {
    while (stack.length > 1 && stack[stack.length - 1]!.indent >= row.indent) {
      stack.pop();
    }

    const node: CommentNode = {
      id: row.id,
      type: "comment",
      author: row.author,
      text: row.stub ? null : row.text,
      created_at_i: row.created_at_i,
      children: [],
    };

    stack[stack.length - 1]!.node.children.push(node);
    stack.push({ indent: row.indent, node });
  }

  return root;
}

/** Seconds from a `Retry-After` header, capped so a hostile value cannot stall a build. */
export function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(seconds, 60) * 1000;
}

/** Network-error retries. Throttle retries are governed by the deadline instead. */
const MAX_NETWORK_ATTEMPTS = 3;

/**
 * Fetches one item page, waiting out throttles until `deadline`.
 *
 * Throws `HnThrottled` when HN is still refusing past the deadline. Returns
 * null for any other failure, which the caller treats as a parse-level problem
 * worth falling back on.
 */
async function fetchPage(
  url: string,
  deadline: number,
  attempt = 0,
  sleep: Sleep = realSleep,
  now: Now = Date.now,
): Promise<string | null> {
  const cfg = config();
  try {
    const res = await hnSlot(
      () =>
        fetch(url, {
          headers: {
            "user-agent": userAgent(),
            accept: "text/html",
            "accept-encoding": "gzip",
          },
          signal: AbortSignal.timeout(cfg.fetchTimeoutMs),
        }),
      sleep,
      now,
    );

    // 403 belongs here with 429: HN serves a soft throttle page ("Sorry.")
    // under that status rather than a permanent denial.
    if (res.status === 403 || res.status === 429 || res.status >= 500) {
      const step = THROTTLE_BACKOFF_MS[Math.min(attempt, THROTTLE_BACKOFF_MS.length - 1)]!;
      const wait = retryAfterMs(res) ?? step;
      noteThrottle(wait, now);

      if (now() + wait > deadline) {
        log("hn-html").warn(
          { url, status: res.status, attempt, waitMs: wait },
          "hn still throttling past deadline",
        );
        throw new HnThrottled(wait);
      }

      // Deliberately `warn`, not `debug`. At the default log level a debug line
      // here is invisible, and because nothing else prints between the start of
      // a build and its result, a throttled run is indistinguishable from a
      // hung process for the full `hnMaxWaitMs` budget -- half an hour of
      // silence. That happened, twice, and cost more than the log volume ever
      // will: the ladder tops out at 120s, so a blocked host emits well under a
      // line a minute per in-flight request.
      log("hn-html").warn(
        { url, status: res.status, attempt, waitMs: wait },
        "hn throttled, waiting",
      );
      // hnSlot absorbs the cool-off, so no explicit sleep is needed here.
      return fetchPage(url, deadline, attempt + 1, sleep, now);
    }

    if (!res.ok) {
      log("hn-html").warn({ url, status: res.status }, "hn item page unavailable");
      return null;
    }

    return await res.text();
  } catch (error) {
    if (error instanceof HnThrottled) throw error;
    if (attempt + 1 < MAX_NETWORK_ATTEMPTS && now() < deadline) {
      await sleep(backoff(attempt));
      return fetchPage(url, deadline, attempt + 1, sleep, now);
    }
    log("hn-html").warn({ url, ...errFields(error) }, "hn item page fetch failed");
    return null;
  }
}

/** How long to keep waiting on a throttled HN before giving up on this attempt. */
export interface FetchTreeOptions {
  maxWaitMs?: number;
  /**
   * Delay primitive for the throttle cool-off, the inter-request gap and the
   * network-error backoff. Defaults to `Bun.sleep`; tests substitute a
   * recording no-op so the ladder can be asserted without being waited out.
   */
  sleep?: Sleep;
  /**
   * Wall-clock source for the deadline and the shared cool-off. Defaults to
   * `Date.now`. Paired with `sleep`: a test that fakes waiting must also fake
   * the passage of time, or the cool-off it asserts on would be shortened by
   * however many real milliseconds the test itself took to run.
   */
  now?: Now;
}

/**
 * Fetches and parses a story's full comment tree.
 *
 * Throws `HnThrottled` when rate limited beyond `maxWaitMs` -- the caller should
 * defer the build rather than degrade, since the work is not time-critical.
 * Returns null only when the page was reachable but unparseable, which means HN
 * changed its markup. That is a distinct signal from a throttle on purpose:
 * one is a bug in this parser, the other is upstream backpressure.
 */
export async function fetchStoryTreeHtml(
  storyId: number,
  opts: FetchTreeOptions = {},
): Promise<CommentNode | null> {
  const started = performance.now();
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.maxWaitMs ?? config().hnMaxWaitMs);
  const sleep = opts.sleep ?? realSleep;
  let url: string | null = `${BASE}/item?id=${storyId}`;
  const rows: ParsedRow[] = [];
  const seen = new Set<number>();
  let pages = 0;

  while (url && pages < MAX_PAGES) {
    const html: string | null = await fetchPage(url, deadline, 0, sleep, now);
    if (!html) break;
    pages += 1;

    for (const row of parseRows(html)) {
      // HN repeats no rows across pages today, but a duplicate would corrupt
      // the indent stack, so dedupe defensively.
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }

    url = moreLink(html);
  }

  if (rows.length === 0) {
    log("hn-html").warn({ storyId, pages }, "no comment rows parsed");
    return null;
  }

  const tree = buildTree(storyId, rows);
  log("hn-html").debug(
    {
      storyId,
      pages,
      rows: rows.length,
      stubs: rows.filter((r) => r.stub).length,
      durationMs: Math.round(performance.now() - started),
    },
    "parsed comment tree from hn html",
  );

  return tree;
}
