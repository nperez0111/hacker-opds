/**
 * The generated service worker source, the page-side shim, and the manifest.
 *
 * These are strings, not modules: a worker runs in its own global scope with
 * its own type universe, so nothing here is type-checked by the build. That
 * makes two cheap assertions unusually valuable - that the source parses at
 * all, and that the routing rules a reader depends on are present in it - since
 * a typo would otherwise ship silently and only fail on a device with no
 * network, which is the one place nobody is watching a console.
 *
 * The scroll correction at the bottom goes further than a syntax check: the
 * shipped source is executed against the markup the story page really emits,
 * parsed by linkedom, with a hand-built viewport standing in for layout. There
 * is no browser in this suite, so the arithmetic is the part that has to be
 * proven here - a correction that is off by a header height puts the reader
 * somewhere they did not ask to be, and on e-ink that costs a page flash to
 * discover.
 */
import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import type { CommentRow } from "~/core/comments";
import type { StoryRow } from "~/core/edition";
import { commentsHtml } from "~/web/story";
import { SITE_CSS } from "~/web/styles";
import { APP_JS, serviceWorkerJs, webManifest } from "~/web/sw";

const PRECACHE = ["/", "/offline", "/assets/site.css?v=abcd1234", "/assets/app.js?v=ef567890"];

function sw(over: Partial<{ version: string; precache: string[] }> = {}): string {
  return serviceWorkerJs({ version: "v1", precache: PRECACHE, ...over });
}

describe("serviceWorkerJs - parseability", () => {
  test("is syntactically valid JavaScript", () => {
    // `new Function` parses without executing, so the worker's `self` calls
    // are irrelevant here. This is the only syntax check the worker ever gets.
    expect(() => new Function(sw())).not.toThrow();
  });

  test("is strict-mode source", () => {
    expect(sw()).toContain('"use strict";');
  });
});

describe("serviceWorkerJs - cache identity", () => {
  test("puts the version in the cache name", () => {
    expect(sw({ version: "deadbeef" })).toContain('var CACHE = "hacker-opds-deadbeef";');
  });

  test("a different version produces different source", () => {
    // The cache name is what retires a stale build, so a version that did not
    // reach the source would leave readers on last week's stylesheet.
    expect(sw({ version: "aaaa" })).not.toBe(sw({ version: "bbbb" }));
  });

  test("retires previous caches on activate, but only its own", () => {
    const src = sw();
    expect(src).toContain("caches.delete(key)");
    // Namespaced, so a worker on a shared origin does not delete a neighbour's.
    expect(src).toContain('key.indexOf("hacker-opds-") === 0');
    expect(src).toContain("key !== CACHE");
  });

  test("claims clients so the first load is controlled", () => {
    expect(sw()).toContain("self.clients.claim()");
    expect(sw()).toContain("self.skipWaiting()");
  });
});

describe("serviceWorkerJs - precache", () => {
  test("embeds the list as a JSON array", () => {
    expect(sw()).toContain(`var PRECACHE = ${JSON.stringify(PRECACHE)};`);
  });

  test("every precache URL appears in the source", () => {
    const src = sw();
    for (const url of PRECACHE) expect(src).toContain(JSON.stringify(url));
  });

  test("install adds the whole list at once", () => {
    expect(sw()).toContain("cache.addAll(PRECACHE)");
  });

  test("a failed precache cannot wedge the worker in installing", () => {
    // Without the catch a single 404 in the list leaves the previous worker in
    // place forever, and runtime caching would have picked those up anyway.
    const src = sw();
    const install = src.slice(src.indexOf('addEventListener("install"'));
    expect(install).toContain(".catch(function () {})");
  });

  test("an empty precache list is still valid source", () => {
    const src = sw({ precache: [] });
    expect(src).toContain("var PRECACHE = [];");
    expect(() => new Function(src)).not.toThrow();
  });

  test("escapes a URL containing quotes rather than breaking out of the string", () => {
    const hostile = '/assets/"; self.evil()//';
    const src = sw({ precache: [hostile] });
    expect(() => new Function(src)).not.toThrow();

    // The declaration is evaluated on its own: the value has to come back as
    // the literal string, not as source that ran.
    const line = src.slice(src.indexOf("var PRECACHE ="));
    const read = new Function(`${line.slice(0, line.indexOf("\n"))} return PRECACHE;`);
    expect(read()).toEqual([hostile]);
  });
});

describe("serviceWorkerJs - routing", () => {
  test("treats story and archive pages as immutable", () => {
    // Editions never change once built, which is what makes cache-first here
    // correct rather than merely fast.
    const src = sw();
    expect(src).toContain("function isImmutablePage(path)");
    expect(src).toContain("/^\\/story\\/\\d+$/");
    expect(src).toContain("/^\\/archive\\/\\d{4}-\\d{2}-\\d{2}$/");
  });

  test("the immutable-page rules match the URLs the site actually serves", () => {
    // Pulled out of the source and run, so a typo in the pattern fails here
    // rather than on a device with no network.
    const src = sw();
    const build = new Function(`${src.slice(src.indexOf("function isImmutablePage"))}
      ; return isImmutablePage;`);
    const isImmutablePage = build() as (path: string) => boolean;

    expect(isImmutablePage("/story/44921137")).toBe(true);
    expect(isImmutablePage("/archive/2026-08-16")).toBe(true);
    expect(isImmutablePage("/")).toBe(false);
    expect(isImmutablePage("/archive")).toBe(false);
    expect(isImmutablePage("/story/abc")).toBe(false);
    expect(isImmutablePage("/archive/2026-08")).toBe(false);
    expect(isImmutablePage("/offline")).toBe(false);
  });

  test("caches hashed assets first, since their bytes cannot change", () => {
    const src = sw();
    expect(src).toContain("function isAsset(path)");
    expect(src).toContain('path.indexOf("/assets/") === 0');
  });

  test("bypasses everything that is not a page", () => {
    // EPUBs are multi-megabyte downloads, the OPDS feeds belong to the reader
    // app, /healthz must report the live server, and /theme mutates a cookie.
    const src = sw();
    expect(src).toContain('path.indexOf("/epub/") === 0');
    expect(src).toContain('path.indexOf("/opds") === 0');
    expect(src).toContain('path === "/healthz"');
    expect(src).toContain('path === "/theme"');
  });

  test("the bypass rule matches those paths when run", () => {
    const src = sw();
    const build = new Function(`${src.slice(src.indexOf("function isBypassed"))}
      ; return isBypassed;`);
    const isBypassed = build() as (path: string) => boolean;

    expect(isBypassed("/epub/story/1.epub")).toBe(true);
    expect(isBypassed("/opds")).toBe(true);
    expect(isBypassed("/opds/editions")).toBe(true);
    expect(isBypassed("/healthz")).toBe(true);
    expect(isBypassed("/theme")).toBe(true);
    expect(isBypassed("/")).toBe(false);
    expect(isBypassed("/story/1")).toBe(false);
    expect(isBypassed("/assets/site.css")).toBe(false);
  });

  test("indexes go network-first, with a deadline", () => {
    // A reader on a captive-portal wifi otherwise waits for the TCP stack to
    // give up, which can be half a minute, with the page already in cache.
    const src = sw();
    expect(src).toContain("function networkFirst(request, timeoutMs)");
    expect(src).toContain("networkFirst(request, 3000)");
    expect(src).toContain("setTimeout(");
  });

  test("falls back to the offline page when the network fails and nothing is cached", () => {
    const src = sw();
    expect(src).toContain('var OFFLINE_URL = "/offline";');
    expect(src).toContain("caches.match(OFFLINE_URL)");
  });

  test("ignores non-GET and cross-origin requests", () => {
    const src = sw();
    expect(src).toContain('request.method !== "GET"');
    expect(src).toContain("url.origin !== self.location.origin");
  });

  test("only intercepts navigations among page requests", () => {
    const src = sw();
    expect(src).toContain('request.mode === "navigate"');
    expect(src).toContain('indexOf("text/html") !== -1');
  });

  test("never stores a non-200 or opaque response", () => {
    const src = sw();
    expect(src).toContain("response.status !== 200");
    expect(src).toContain('response.type === "opaque"');
  });
});

describe("serviceWorkerJs - bulk save", () => {
  test("listens for the save-urls message the page sends", () => {
    const src = sw();
    expect(src).toContain('data.type !== "save-urls"');
    expect(src).toContain('type: "save-progress"');
  });

  test("fetches sequentially rather than in a burst", () => {
    // Thirty parallel requests for pages that each embed a full article is a
    // burst an e-reader radio handles worse than the server does.
    const src = sw();
    expect(src).toContain("return step(i + 1);");
    expect(src).not.toContain("Promise.all(urls");
  });

  test("reports progress and a terminal state", () => {
    const src = sw();
    expect(src).toContain('report("progress")');
    expect(src).toContain('report("done")');
  });
});

describe("APP_JS", () => {
  test("is syntactically valid JavaScript", () => {
    expect(() => new Function(APP_JS)).not.toThrow();
  });

  test("does nothing at all where service workers are unavailable", () => {
    // Everything on the page has to work with this script absent or inert.
    expect(APP_JS).toContain('if (!("serviceWorker" in navigator)) return;');
  });

  test("registers the worker at the root scope", () => {
    expect(APP_JS).toContain('register("/assets/sw.js", { scope: "/" })');
  });

  test("marks the document so the stylesheet can reveal the offline controls", () => {
    expect(APP_JS).toContain('setAttribute("data-sw", "ready")');
  });

  test("reads the save list from the attribute the edition view writes", () => {
    expect(APP_JS).toContain('querySelector("[data-save-edition]")');
    expect(APP_JS).toContain('querySelector("[data-save-status]")');
  });

  test("survives an unparseable save list instead of throwing on every page", () => {
    expect(APP_JS).toContain("JSON.parse(");
    expect(APP_JS).toContain("catch (err) {");
  });

  test("waits for the DOM before wiring the button", () => {
    expect(APP_JS).toContain('document.readyState === "loading"');
    expect(APP_JS).toContain('addEventListener("DOMContentLoaded", wire)');
  });
});

/*
 * The scroll correction.
 *
 * Everything below runs the shipped source. The DOM is linkedom parsing the
 * markup commentsHtml really produces, so the selectors are matched by a real
 * selector engine against real markup; layout is the fake, because layout is
 * the one thing a test without a browser cannot have. The fake is honest about
 * the only physics that matters here: collapsing a comment moves the content
 * *below* it and leaves the comment's own document position alone.
 */

/** 1.75rem at the site's 20px root: one row of the pinned header stack. */
const CHEAD_H = 35;

const T0 = 1_755_302_400; // 2025-08-16T00:00:00Z

const STORY: StoryRow = {
  id: 44921137,
  edition_date: "2026-08-16",
  rank: 1,
  title: "Good system design",
  url: "https://seangoedecke.com/good-system-design/",
  domain: "seangoedecke.com",
  author: "ingve",
  points: 957,
  num_comments: 208,
  created_at_i: T0,
  story_text: null,
  is_text_post: 0,
};

function commentRow(over: Partial<CommentRow>): CommentRow {
  return {
    id: 1,
    story_id: STORY.id,
    parent_id: null,
    root_id: 1,
    depth: 0,
    sort_index: 0,
    author: "alice",
    created_at_i: T0 + 3600,
    text_html: "<p>Nice writeup.</p>",
    ...over,
  };
}

/**
 * c1 > c2 > c3, nested by the page's own renderer.
 *
 * Written this way rather than as a hand-typed fixture so that a change to the
 * comment markup - a class rename, the author link moving out of the summary -
 * breaks these tests instead of quietly turning the enhancement off.
 */
const THREAD_HTML = commentsHtml(STORY, [
  [
    commentRow({ id: 1, depth: 0, parent_id: null, sort_index: 0, author: "alice" }),
    commentRow({ id: 2, depth: 1, parent_id: 1, sort_index: 1, author: "bob" }),
    commentRow({ id: 3, depth: 2, parent_id: 2, sort_index: 2, author: "carol" }),
  ],
]);

/**
 * One function out of the shipped source, by brace counting, so it can be run
 * on its own. Throwing when it is absent makes a rename fail here rather than
 * silently reducing this file to a syntax check.
 */
function extractFunction(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`APP_JS has no function named ${name}`);
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${name} is not brace-balanced in APP_JS`);
}

interface Rect {
  top: number;
}

interface DetailsEl {
  id: string;
  className: string;
  open?: boolean;
  getBoundingClientRect: () => Rect;
}

interface NodeLike {
  dispatchEvent: (event: unknown) => boolean;
  closest?: (selector: string) => DetailsEl | null;
  parentNode?: NodeLike | null;
}

interface ClickOptions {
  /** False when the default action did not run, so nothing actually toggled. */
  toggles?: boolean;
  /** The browser's own scroll change - anchoring, or clamping at a shortened
   *  document - which lands before the next frame. */
  adjust?: (view: { y: number }) => void;
}

interface PageOptions {
  scrollY?: number;
  /** Document-space top of each comment. Unchanged by a collapse: only what is
   *  below a collapsing comment moves. */
  tops?: Record<string, number>;
  /** False models a browser with no <details>, where `open` stays undefined. */
  details?: boolean;
  /** False models a browser with no requestAnimationFrame. */
  raf?: boolean;
}

interface Page {
  /** Every scrollBy the script asked for, in order. */
  scrolls: number[];
  /** Event types the script registered on the document. */
  registrations: string[];
  /** Selectors the script looked up. Delegation means it looks up none. */
  selectors: string[];
  /** Callbacks still waiting, to prove the script scheduled nothing. */
  pending: () => number;
  /** Where a comment's top edge now sits relative to the viewport. */
  topOf: (id: string) => number;
  scrollY: () => number;
  find: (selector: string) => NodeLike;
  click: (target: unknown, options?: ClickOptions) => void;
}

function page(opts: PageOptions = {}): Page {
  const { document, Event } = parseHTML(
    `<!doctype html><html><body>${THREAD_HTML}</body></html>`,
  );

  const view = { y: opts.scrollY ?? 0 };
  const tops = opts.tops ?? { c1: 1000, c2: 1400, c3: 1800 };
  const scrolls: number[] = [];
  const registrations: string[] = [];
  const selectors: string[] = [];
  const frames: Array<() => void> = [];
  const timers: Array<() => void> = [];

  for (const node of Array.from(document.querySelectorAll("details.comment"))) {
    const el = node as unknown as DetailsEl;
    const id = el.id;
    el.getBoundingClientRect = () => ({ top: (tops[id] ?? 0) - view.y });
    if (opts.details !== false) el.open = true;
  }

  const doc = document as unknown as {
    addEventListener: (type: string, fn: unknown, capture?: boolean) => void;
    querySelector: (selector: string) => unknown;
    querySelectorAll: (selector: string) => unknown;
  };
  const realAdd = doc.addEventListener.bind(doc);
  const realQuery = doc.querySelector.bind(doc);
  const realQueryAll = doc.querySelectorAll.bind(doc);
  doc.addEventListener = (type, fn, capture) => {
    registrations.push(type);
    realAdd(type, fn, capture);
  };
  doc.querySelector = (selector) => {
    selectors.push(selector);
    return realQuery(selector);
  };
  doc.querySelectorAll = (selector) => {
    selectors.push(selector);
    return realQueryAll(selector);
  };

  const window = {
    /*
     * What getComputedStyle(summary).top resolves to under the real
     * stylesheet: one header height per depth level, with dx repeating d5.
     */
    getComputedStyle(node: unknown) {
      const summary = node as { parentNode: { className: string } };
      const found = /\bd(\d|x)\b/.exec(summary.parentNode.className);
      const level = found ? (found[1] === "x" ? 5 : Number(found[1] ?? 0)) : 0;
      return { top: `${level * CHEAD_H}px` };
    },
    scrollBy(_x: number, y: number) {
      scrolls.push(y);
      view.y += y;
    },
    requestAnimationFrame:
      opts.raf === false
        ? undefined
        : (fn: () => void) => {
            frames.push(fn);
          },
  };

  /*
   * navigator is empty on purpose. The service-worker half of the file has to
   * stay inert while the scroll correction runs, because a browser too old for
   * a worker is exactly the one whose reader most needs their place kept.
   */
  new Function("window", "document", "navigator", "setTimeout", APP_JS)(
    window,
    document,
    {},
    (fn: () => void) => {
      timers.push(fn);
      return 0;
    },
  );

  function ownerDetails(node: NodeLike): DetailsEl | null {
    const start = node.closest ? node : (node.parentNode ?? null);
    if (!start || !start.closest) return null;
    return start.closest("details.comment");
  }

  function flush(): void {
    for (const fn of frames.splice(0).concat(timers.splice(0))) fn();
  }

  return {
    scrolls,
    registrations,
    selectors,
    pending: () => frames.length + timers.length,
    topOf: (id) => (tops[id] ?? 0) - view.y,
    scrollY: () => view.y,
    find: (selector) => {
      const node = realQuery(selector);
      if (!node) throw new Error(`no ${selector} in the rendered thread`);
      return node as NodeLike;
    },
    click: (target, options = {}) => {
      (target as NodeLike).dispatchEvent(new Event("click", { bubbles: true }));

      /* The default action: the browser flips `open` after the handler. */
      if (options.toggles !== false) {
        const el = ownerDetails(target as NodeLike);
        if (el && el.open !== undefined) el.open = !el.open;
      }
      if (options.adjust) options.adjust(view);
      flush();
    },
  };
}

/*
 * The source with its comments removed.
 *
 * The negative assertions below are about what the script *does*, and this
 * file's other half is a long argument about smooth scrolling and
 * preventDefault. Matching on the prose would fail the test for explaining
 * itself. There are no comment delimiters inside any string literal in APP_JS,
 * so stripping block comments is safe here.
 */
const APP_CODE = APP_JS.replace(/\/\*[\s\S]*?\*\//g, "");

describe("APP_JS - scroll correction, as written", () => {
  test("delegates a single click listener from the document", () => {
    // A busy story is several hundred comments; that many registrations is a
    // measurable cost on this hardware for something most readers never tap.
    expect(APP_JS).toContain('document.addEventListener(\n    "click",');
    expect(APP_JS).toContain('closest("summary.chead")');
    expect(APP_CODE).not.toContain("querySelectorAll");
  });

  test("excludes the author link inside the header", () => {
    // The name links to the comment on HN. The browser does not toggle for it,
    // so scrolling the page on the way out would be wrong.
    expect(APP_JS).toContain('closest("a")');
    expect(APP_JS).toContain("summary.contains(link)");
  });

  test("measures the details, never the sticky summary", () => {
    // A pinned summary's rect reports where it is painted, not where it sits
    // in the document, and that difference is the number being recovered.
    expect(APP_JS).toContain("comment.getBoundingClientRect().top");
    expect(APP_CODE).not.toContain("summary.getBoundingClientRect");
  });

  test("reads the pinned offset from the cascade", () => {
    // So the stylesheet stays the single source of truth for the stacking.
    expect(APP_JS).toContain("window.getComputedStyle(summary, null)");
    expect(APP_CODE).not.toContain("--chead-h");
  });

  test("never scrolls smoothly", () => {
    // A smooth scroll on e-ink is a run of full-panel flashes ending where an
    // instant one would have started.
    expect(APP_JS).toContain("window.scrollBy(0, delta)");
    expect(APP_CODE).not.toContain("smooth");
    expect(APP_CODE).not.toContain("scrollIntoView");
  });

  test("cannot break collapsing, because it never collapses anything", () => {
    // The zero-JS behaviour is the product; this listener only reads.
    expect(APP_CODE).not.toContain("preventDefault");
    expect(APP_CODE).not.toMatch(/\.open\s*=[^=]/);
    expect(APP_CODE).not.toContain('setAttribute("open"');
    expect(APP_CODE).not.toContain('removeAttribute("open"');
  });
});

describe("APP_JS - scrollCorrection", () => {
  const build = new Function(
    `${extractFunction(APP_JS, "scrollCorrection")}; return scrollCorrection;`,
  );
  const scrollCorrection = build() as (
    beforeTop: number,
    afterTop: number,
    stickyTop: number,
  ) => number;

  test("leaves a comment that did not move alone", () => {
    expect(scrollCorrection(300, 300, 0)).toBe(0);
    expect(scrollCorrection(300, 300, CHEAD_H)).toBe(0);
  });

  test("puts a comment that was on screen back where it was", () => {
    // Content above it shrank by 300, so the page scrolls up by 300.
    expect(scrollCorrection(500, 200, 0)).toBe(-300);
  });

  test("rests a comment that was scrolled past at its own pinned offset", () => {
    // 2000px into the subtree, at depth 1: the header lands under its parent's.
    expect(scrollCorrection(-2000, -2000, CHEAD_H)).toBe(-2035);
    expect(scrollCorrection(-2000, -2000, CHEAD_H * 2)).toBe(-2070);
  });

  test("treats resting exactly on the offset as visible", () => {
    expect(scrollCorrection(CHEAD_H, CHEAD_H, CHEAD_H)).toBe(0);
    expect(scrollCorrection(CHEAD_H - 1, CHEAD_H - 1, CHEAD_H)).toBe(-1);
  });

  test("never scrolls a top-level comment past the top of the page", () => {
    expect(scrollCorrection(-4000, -4000, 0)).toBe(-4000);
  });
});

describe("APP_JS - stickyOffset", () => {
  const source = extractFunction(APP_JS, "stickyOffset");
  function offsetWith(style: unknown, hasGetComputedStyle = true): number {
    const build = new Function("window", `${source}; return stickyOffset;`);
    const win = hasGetComputedStyle ? { getComputedStyle: () => style } : {};
    return (build(win) as (summary: unknown) => number)({});
  }

  test("reads the resolved px offset", () => {
    expect(offsetWith({ top: "70px" })).toBe(70);
    expect(offsetWith({ top: "0px" })).toBe(0);
  });

  test("treats a browser without position: sticky as pinning nothing", () => {
    // A static element resolves top to "auto", which is not a number.
    expect(offsetWith({ top: "auto" })).toBe(0);
    expect(offsetWith({ top: "" })).toBe(0);
  });

  test("survives a missing or empty computed style", () => {
    expect(offsetWith(null)).toBe(0);
    expect(offsetWith({ top: "35px" }, false)).toBe(0);
  });
});

describe("APP_JS - scroll correction, executed", () => {
  test("the harness pins where the stylesheet pins", () => {
    // Every landing assertion below is in these units, so the fake viewport is
    // only worth anything while this holds. What the offsets are per depth is
    // asserted against SITE_CSS over in web-story.test.ts.
    expect(SITE_CSS).toContain("--chead-h: 1.75rem;");
    expect(SITE_CSS).toContain("font-size: 20px;");
    expect(CHEAD_H).toBe(1.75 * 20);
  });

  test("holds a comment still when it was already on screen", () => {
    // Top-level comment at document y=1000, reader at 700: 300px down the
    // panel. Collapsing it must not move it by a pixel.
    const p = page({ scrollY: 700 });
    p.click(p.find("#c1 > summary.chead"));

    expect(p.scrolls).toEqual([]);
    expect(p.scrollY()).toBe(700);
    expect(p.topOf("c1")).toBe(300);
  });

  test("rests a collapsed ancestor under its pinned ancestors", () => {
    // The bug this exists for: 1600px inside c2's subtree, tapping c2's pinned
    // header. Without the correction the viewport keeps offset 3000, which is
    // now somewhere else entirely.
    const p = page({ scrollY: 3000 });
    p.click(p.find("#c2 > summary.chead"));

    expect(p.scrolls).toEqual([-1635]);
    expect(p.topOf("c2")).toBe(CHEAD_H);
  });

  test("uses the depth's own offset, so the header lands flush", () => {
    const p = page({ scrollY: 3000 });
    p.click(p.find("#c3 > summary.chead"));

    expect(p.topOf("c3")).toBe(CHEAD_H * 2);
  });

  test("composes with a browser that already moved the scroll itself", () => {
    // Scroll anchoring, or the offset clamping at a document that just got
    // shorter. Measuring after layout means the correction absorbs it.
    const p = page({ scrollY: 3000 });
    p.click(p.find("#c2 > summary.chead"), {
      adjust: (view) => {
        view.y = 1800;
      },
    });

    expect(p.topOf("c2")).toBe(CHEAD_H);
  });

  test("corrects a click on the reply count, text node and all", () => {
    // Old WebKit can report a text node as the target of a click, and the
    // reply count is the part of a header worth aiming at.
    const p = page({ scrollY: 3000 });
    const count = p.find("#c2 > summary.chead > span.kidcount");
    p.click((count as unknown as { firstChild: NodeLike }).firstChild);

    expect(p.topOf("c2")).toBe(CHEAD_H);
  });

  test("stays out of the way of the author link", () => {
    // Tapping the name is a navigation to HN. Nothing toggles, so nothing may
    // scroll - and the correction must not even be scheduled.
    const p = page({ scrollY: 3000 });
    p.click(p.find("#c2 > summary.chead > a.who"), { toggles: false });

    expect(p.pending()).toBe(0);
    expect(p.scrolls).toEqual([]);
    expect(p.scrollY()).toBe(3000);
  });

  test("ignores clicks in the comment body", () => {
    const p = page({ scrollY: 3000 });
    p.click(p.find("#c2 > .cbody"), { toggles: false });

    expect(p.pending()).toBe(0);
    expect(p.scrolls).toEqual([]);
  });

  test("abandons the correction when nothing toggled", () => {
    // Something swallowed the default action. Scrolling then would move the
    // reader for no reason.
    const p = page({ scrollY: 3000 });
    p.click(p.find("#c2 > summary.chead"), { toggles: false });

    expect(p.scrolls).toEqual([]);
    expect(p.scrollY()).toBe(3000);
  });

  test("does nothing on a browser with no <details> at all", () => {
    // There `open` is undefined before and after, the element renders expanded
    // and inline, and the native fallback is the whole behaviour.
    const p = page({ scrollY: 3000, details: false });
    p.click(p.find("#c2 > summary.chead"));

    expect(p.scrolls).toEqual([]);
  });

  test("falls back to a timeout where requestAnimationFrame is missing", () => {
    const p = page({ scrollY: 3000, raf: false });
    p.click(p.find("#c2 > summary.chead"));

    expect(p.topOf("c2")).toBe(CHEAD_H);
  });

  test("binds one listener, on the document, and enumerates nothing", () => {
    const p = page();

    expect(p.registrations).toEqual(["click"]);
    expect(p.selectors).toEqual([]);
  });

  test("runs on a browser with no service worker", () => {
    // The harness gives the script an empty navigator throughout, so every
    // test above is also this test. Stated once, explicitly.
    const p = page({ scrollY: 3000 });
    p.click(p.find("#c1 > summary.chead"));

    expect(p.topOf("c1")).toBe(0);
  });
});

describe("APP_JS - scroll correction, missing DOM methods", () => {
  function boot(documentLike: unknown): string[] {
    const registered: string[] = [];
    const doc = Object.assign({ addEventListener: (type: string) => registered.push(type) },
      documentLike);
    new Function("window", "document", "navigator", "setTimeout", APP_JS)({}, doc, {}, () => 0);
    return registered;
  }

  test("binds nothing without closest", () => {
    expect(boot({ documentElement: { getBoundingClientRect: () => ({ top: 0 }) } })).toEqual([]);
  });

  test("binds nothing without getBoundingClientRect", () => {
    expect(boot({ documentElement: { closest: () => null } })).toEqual([]);
  });

  test("binds nothing without a documentElement", () => {
    expect(boot({ documentElement: null })).toEqual([]);
  });
});

describe("webManifest", () => {
  test("is valid JSON", () => {
    expect(() => JSON.parse(webManifest())).not.toThrow();
  });

  test("declares the fields an installed app needs", () => {
    const manifest = JSON.parse(webManifest()) as Record<string, unknown>;
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
  });

  test("its scope covers the worker's scope, or the install is broken", () => {
    const manifest = JSON.parse(webManifest()) as { scope: string; start_url: string };
    expect(manifest.start_url.startsWith(manifest.scope)).toBe(true);
    expect(APP_JS).toContain(`scope: "${manifest.scope}"`);
  });

  test("names itself for a home screen", () => {
    const manifest = JSON.parse(webManifest()) as { name: string; short_name: string };
    expect(manifest.name).toBe("Hacker News Daily");
    // Home screens truncate past roughly twelve characters.
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
  });

  test("is stable across calls", () => {
    expect(webManifest()).toBe(webManifest());
  });
});
