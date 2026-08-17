/**
 * Service worker and its registration shim.
 *
 * The website is server-rendered HTML and works with scripting disabled. This
 * file is the progressive enhancement on top: once the worker installs, pages
 * you have already opened stay openable with the network gone. Nothing here is
 * load-bearing for a first visit.
 *
 * Both scripts are plain ES5-ish source held as strings rather than TypeScript
 * compiled to a bundle. Two reasons:
 *
 *  1. A service worker runs in its own global scope with its own type universe.
 *     Type-checking it alongside the server code needs a separate tsconfig and
 *     the WebWorker lib, which is a lot of build surface for ninety lines.
 *  2. E-reader browsers are old. Shipping exactly the syntax that is written
 *     here, with no transpiler in between, means what is tested is what runs.
 */

/**
 * Caching strategy, and why it is split.
 *
 * Editions are immutable once built: an edition page and every story page
 * beneath it will never change again, so serving them from cache without
 * touching the network is not a staleness risk, it is just correct. The two
 * index pages are different - "today" turns over daily, and the archive list
 * grows - so those go to the network first and fall back to cache.
 *
 * The alternative, stale-while-revalidate everywhere, would show a day-old
 * front page to an online reader and only correct itself on the visit after.
 * That is the wrong trade when the network is right there.
 */
export interface ServiceWorkerOptions {
  /** Cache name suffix. Changing it retires every previous cache on activate. */
  version: string;
  /** URLs fetched during install. Keep this tiny; install blocks on it. */
  precache: string[];
}

export function serviceWorkerJs(opts: ServiceWorkerOptions): string {
  const cacheName = `hacker-opds-${opts.version}`;
  return `/* hacker-opds service worker */
"use strict";

var CACHE = ${JSON.stringify(cacheName)};
var PRECACHE = ${JSON.stringify(opts.precache)};
var OFFLINE_URL = "/offline";

/* Pages whose content is frozen once published, so cache-first is safe. */
function isImmutablePage(path) {
  return /^\\/story\\/\\d+$/.test(path) || /^\\/archive\\/\\d{4}-\\d{2}-\\d{2}$/.test(path);
}

/* Hashed asset URLs. The hash changes when the bytes do, so never revalidate. */
function isAsset(path) {
  return path.indexOf("/assets/") === 0;
}

/*
 * Requests the worker must not touch at all.
 *
 * EPUBs are multi-megabyte binaries that the browser hands to a download
 * manager; putting them in the page cache would blow the origin quota for no
 * reading benefit. The OPDS feeds belong to the reader app, not the website,
 * and /healthz must always report the live server.
 *
 * /rss is here for the OPDS reason and one of its own. A feed reader is a
 * different application that does its own conditional polling and its own
 * caching, and it is entitled to a live answer. The one of its own: a browser
 * asked to open a feed URL sends Accept: text/html, so without this the worker
 * would classify it as a navigation - which means caching a feed document in
 * the page cache, and, offline, answering a feed request with the /offline HTML
 * page. A feed reader handed HTML reports the subscription as broken.
 *
 * /theme and /settings are state changes that answer 303. Routed through a
 * caching strategy the worker would try to store an opaque redirect, which
 * rejects, and would serve a stale answer to a request whose entire purpose is
 * to change something.
 *
 * /search is deliberately NOT here, even though its response varies by query
 * string. The cache is keyed on the whole URL, so two queries are two entries
 * and never each other's answer; and the strategy it falls into is
 * network-first, so an online reader is served fresh results every time and
 * only sees a cached page when the network is gone. That is the good case, not
 * the bad one: the alternative for a reader who searched something before
 * losing signal is a browser error page instead of the results they just had.
 * It is an idempotent GET returning HTML, which is the same category as / and
 * /archive, not the category /theme is in.
 */
function isBypassed(path) {
  return (
    path.indexOf("/epub/") === 0 ||
    path.indexOf("/opds") === 0 ||
    path.indexOf("/rss") === 0 ||
    path === "/healthz" ||
    path === "/theme" ||
    path === "/settings" ||
    path === "/robots.txt"
  );
}

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches
      .open(CACHE)
      .then(function (cache) {
        return cache.addAll(PRECACHE);
      })
      /*
       * A failed precache must not leave the previous worker wedged in
       * "installing" forever. Runtime caching will pick these up anyway.
       */
      .catch(function () {})
      .then(function () {
        return self.skipWaiting();
      })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys.map(function (key) {
            if (key !== CACHE && key.indexOf("hacker-opds-") === 0) {
              return caches.delete(key);
            }
            return null;
          })
        );
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

/* Store a copy without consuming the response the page is waiting on. */
function put(request, response) {
  if (!response || response.status !== 200 || response.type === "opaque") {
    return response;
  }
  var copy = response.clone();
  caches.open(CACHE).then(function (cache) {
    cache.put(request, copy);
  });
  return response;
}

function cacheFirst(request) {
  return caches.match(request).then(function (hit) {
    if (hit) {
      /*
       * Refresh in the background anyway. The page is immutable, but the
       * server may have gained an article extraction or a cover since, and
       * this costs the reader nothing.
       */
      fetch(request)
        .then(function (res) {
          put(request, res);
        })
        .catch(function () {});
      return hit;
    }
    return fetch(request).then(function (res) {
      return put(request, res);
    });
  });
}

/*
 * Network-first with a deadline.
 *
 * Without the timeout a reader on a captive-portal wifi - the normal state of
 * a device that has wandered out of range - waits for the TCP stack to give
 * up, which can be half a minute. The cached page is right there.
 */
function networkFirst(request, timeoutMs) {
  return new Promise(function (resolve) {
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      caches.match(request).then(function (hit) {
        if (hit && !settled) {
          settled = true;
          resolve(hit);
        }
      });
    }, timeoutMs);

    fetch(request)
      .then(function (res) {
        clearTimeout(timer);
        put(request, res);
        if (!settled) {
          settled = true;
          resolve(res);
        }
      })
      .catch(function () {
        clearTimeout(timer);
        caches.match(request).then(function (hit) {
          if (settled) return;
          settled = true;
          resolve(hit || caches.match(OFFLINE_URL).then(function (page) {
            return page || Response.error();
          }));
        });
      });
  });
}

self.addEventListener("fetch", function (event) {
  var request = event.request;
  if (request.method !== "GET") return;

  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isBypassed(url.pathname)) return;

  if (isAsset(url.pathname)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  var navigation =
    request.mode === "navigate" ||
    (request.headers.get("accept") || "").indexOf("text/html") !== -1;
  if (!navigation) return;

  if (isImmutablePage(url.pathname)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  event.respondWith(networkFirst(request, 3000));
});

/*
 * Bulk save, driven by the "Save for offline" button on an edition page.
 *
 * Sequential on purpose. Thirty parallel requests for pages that each embed a
 * full article and its comment tree is a burst the server has no reason to
 * absorb, and an e-reader radio handles it worse than the server does.
 */
self.addEventListener("message", function (event) {
  var data = event.data || {};
  if (data.type !== "save-urls" || !data.urls || !data.urls.length) return;

  var urls = data.urls;
  var source = event.source;

  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      var done = 0;
      var failed = 0;

      function report(state) {
        if (!source) return;
        source.postMessage({
          type: "save-progress",
          state: state,
          done: done,
          failed: failed,
          total: urls.length
        });
      }

      function step(i) {
        if (i >= urls.length) {
          report("done");
          return null;
        }
        return fetch(urls[i], { credentials: "same-origin" })
          .then(function (res) {
            if (res && res.status === 200) {
              return cache.put(urls[i], res.clone()).then(function () {
                done += 1;
              });
            }
            failed += 1;
            return null;
          })
          .catch(function () {
            failed += 1;
          })
          .then(function () {
            report("progress");
            return step(i + 1);
          });
      }

      report("progress");
      return step(0);
    })
  );
});
`;
}

/**
 * The page-side script.
 *
 * Registers the worker, marks the document so the stylesheet can reveal the
 * offline controls, wires the save button, and keeps your place when a comment
 * collapses. Everything it touches is optional: with scripting off the button
 * never appears, the comment tree still collapses natively, and every page
 * still renders and navigates.
 *
 * Two independent IIFEs rather than one. The first returns immediately on a
 * browser without service workers, and the scroll correction must not be
 * behind that gate - an old reader with no worker support is exactly the device
 * that most needs its place kept.
 */
export const APP_JS = `/* hacker-opds */
"use strict";

/*
 * Keeping your place when a comment is collapsed.
 *
 * Collapsing is native <details>, and stays native: this listener never
 * toggles anything and never calls preventDefault, so with scripting off - or
 * with any of the DOM methods below missing - the reader loses the scroll
 * correction and nothing else.
 *
 * The problem it fixes. Comment headers are sticky and stack by depth, so
 * while you are deep inside a subtree the ancestor headers are pinned across
 * the top of the panel and any of them can be tapped. Tapping one removes
 * every pixel between it and you from the flow, and the viewport lands on
 * whatever now occupies that scroll offset - typically a different thread
 * entirely, or the end of the document once the scroll clamps. On e-ink that
 * is a full-panel flash to somewhere you did not ask to be.
 *
 * The fix is to measure the comment before the toggle, measure it again after,
 * and scroll by the difference. Two subtleties:
 *
 *  - Measure the <details>, never the <summary>. The summary is sticky, so
 *    while pinned its rect reports where it is painted rather than where it
 *    sits in the document, and the difference is precisely the number we are
 *    trying to recover. The <details> is not sticky and does not lie.
 *
 *  - The default action - flipping the open attribute - runs after this
 *    handler returns, so the second measurement happens in the next frame.
 *
 * Scroll anchoring (overflow-anchor) is left at its default rather than turned
 * off over the comment tree, for two reasons.
 *
 * It barely applies here. The anchor node a browser picks is the content at the
 * top of the viewport, which in the case this fixes is inside the subtree that
 * just stopped being rendered, and an anchor that stops being rendered
 * suppresses the adjustment. Where it does apply it cannot fight the
 * correction, because the second measurement happens after layout has settled:
 * whatever the browser moved the scroll offset by is already in "afterTop", and
 * the correction is computed from there. Where anchoring got it exactly right
 * the correction comes out as zero.
 *
 * And disabling it would be a cost with no matching benefit - it would take the
 * browser's own protection off the no-JS path, which is the path that has to
 * keep working.
 */
(function () {
  var root = document.documentElement;
  /* No closest, no delegation, no feature. Native collapsing is untouched. */
  if (!root || !root.closest || !root.getBoundingClientRect) return;

  /*
   * Where this comment's own header comes to rest once it is pinned, which is
   * one header height per ancestor level.
   *
   * Read from the cascade rather than recomputed from the d1..d5/dx class, so
   * the stylesheet stays the single source of truth for the stacking offsets.
   * A browser without position: sticky drops the whole declaration, leaving a
   * static element whose resolved top is "auto"; that parses to NaN and means
   * nothing is pinned, so the resting place is the top of the viewport.
   */
  function stickyOffset(summary) {
    if (!window.getComputedStyle) return 0;
    var style = window.getComputedStyle(summary, null);
    if (!style) return 0;
    var top = parseFloat(style.top);
    return top === top ? top : 0;
  }

  /*
   * How far to scroll so the toggled comment does not move under the reader.
   *
   * Two cases, which differ only in where the comment should end up:
   *
   *  - It was on screen at or below its pinned offset. It was being looked at,
   *    so it stays exactly where it was: target is beforeTop.
   *  - It was above its pinned offset, meaning the reader was somewhere inside
   *    the subtree that just disappeared. There is no "where it was" to return
   *    to, so it comes to rest at its own sticky offset - flush under its
   *    pinned ancestors - and the header just tapped is what the reader is
   *    looking at.
   *
   * Scrolling down by d moves every rect up by d, so landing the comment on
   * target means scrolling by afterTop - target.
   */
  function scrollCorrection(beforeTop, afterTop, stickyTop) {
    var target = beforeTop < stickyTop ? stickyTop : beforeTop;
    return afterTop - target;
  }

  /*
   * Run once the toggle has been applied.
   *
   * The other candidate was the element's own "toggle" event, which fires
   * after the open attribute flips and would need no guard. It is not usable
   * here: toggle does not bubble, so hearing it means one listener on every
   * <details> on the page - several hundred on a busy story - which is the
   * exact cost delegating from the document exists to avoid.
   *
   * So: the next frame. requestAnimationFrame runs its callbacks before the
   * frame is painted, so the correction and the collapse land in the same
   * paint - one e-ink flash rather than two. setTimeout is the fallback for
   * browsers old enough to lack it, at the cost of possibly painting the
   * uncorrected position first. Either way the measurement is taken after the
   * default action has run, which is the only thing that has to be true.
   */
  function nextFrame(fn) {
    if (window.requestAnimationFrame) window.requestAnimationFrame(fn);
    else setTimeout(fn, 0);
  }

  /*
   * One listener on the document, not one per header. A busy story is several
   * hundred comments, and that many registrations is a measurable cost on a
   * device this slow for something most readers never tap.
   */
  document.addEventListener(
    "click",
    function (event) {
      var target = event.target;
      /* Old WebKit can report a text node as the target of a click. */
      if (target && target.nodeType === 3) target = target.parentNode;
      if (!target || !target.closest) return;

      var summary = target.closest("summary.chead");
      if (!summary) return;

      /*
       * The author name links to the comment on Hacker News. A tap on it is a
       * navigation and the browser does not toggle the details, so there is
       * nothing to correct and scrolling the page on the way out would be
       * wrong.
       */
      var link = target.closest("a");
      if (link && summary.contains(link)) return;

      var comment = summary.parentNode;
      if (!comment || comment.nodeName !== "DETAILS") return;
      if (!comment.getBoundingClientRect) return;

      /*
       * Recorded so the correction can be abandoned if the toggle did not
       * actually happen - another handler called preventDefault, or the
       * browser does not implement details at all and rendered it as an
       * unknown element. In the second case open is undefined both times, which
       * compares equal, so the very browsers that need the native fallback are
       * the ones this leaves alone.
       */
      var wasOpen = comment.open;
      var stickyTop = stickyOffset(summary);
      var beforeTop = comment.getBoundingClientRect().top;

      nextFrame(function () {
        if (comment.open === wasOpen) return;
        var afterTop = comment.getBoundingClientRect().top;
        var delta = scrollCorrection(beforeTop, afterTop, stickyTop);
        /*
         * Two-argument scrollBy, never the options form with behavior:
         * "smooth". A smooth scroll on e-ink is a sequence of full-panel
         * flashes ending where an instant one would have started.
         */
        if (delta) window.scrollBy(0, delta);
      });
    },
    false
  );
})();

(function () {
  if (!("serviceWorker" in navigator)) return;

  navigator.serviceWorker
    .register("/assets/sw.js", { scope: "/" })
    .then(function () {
      document.documentElement.setAttribute("data-sw", "ready");
    })
    .catch(function () {});

  function wire() {
    var button = document.querySelector("[data-save-edition]");
    if (!button) return;

    var status = document.querySelector("[data-save-status]");
    var urls;
    try {
      urls = JSON.parse(button.getAttribute("data-save-edition") || "[]");
    } catch (err) {
      return;
    }
    if (!urls.length) return;

    function say(text) {
      if (status) status.textContent = text;
    }

    navigator.serviceWorker.addEventListener("message", function (event) {
      var data = event.data || {};
      if (data.type !== "save-progress") return;
      if (data.state === "done") {
        button.removeAttribute("aria-disabled");
        say(
          data.failed
            ? "Saved " + data.done + " of " + data.total + ", " + data.failed + " failed."
            : "Saved " + data.done + " stories for offline reading."
        );
        return;
      }
      say("Saving " + (data.done + data.failed) + " of " + data.total + "...");
    });

    button.addEventListener("click", function () {
      if (button.getAttribute("aria-disabled") === "true") return;
      navigator.serviceWorker.ready.then(function (registration) {
        var worker = registration.active;
        if (!worker) return;
        button.setAttribute("aria-disabled", "true");
        say("Saving...");
        worker.postMessage({ type: "save-urls", urls: urls });
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();
`;

/** Web app manifest. Small, and deliberately monochrome. */
export function webManifest(): string {
  return JSON.stringify(
    {
      name: "Hacker News Daily",
      short_name: "HN Daily",
      description: "Top Hacker News stories of the day, with comments.",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#ffffff",
      theme_color: "#000000",
    },
    null,
    2,
  );
}
