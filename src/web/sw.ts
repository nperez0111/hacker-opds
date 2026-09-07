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
import { manifestIcons } from "~/web/icons";
import {
  CACHED_AT_HEADER,
  CACHED_BYTES_HEADER,
  FRESH_FOR_HEADER,
  CACHE_MAX_AGE_MS,
  CACHE_MAX_BYTES,
  CACHE_SWEEP_INTERVAL_MS,
  SWEEP_MARK_URL,
} from "~/web/offline";

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

/*
 * Retention. Every number here comes from ~/web/offline, which is also what
 * the page copy and the marker script read, so the thirty days the edition
 * page promises and the thirty days enforced below cannot drift apart.
 */
var MAX_AGE_MS = ${CACHE_MAX_AGE_MS};
var MAX_BYTES = ${CACHE_MAX_BYTES};
var SWEEP_EVERY_MS = ${CACHE_SWEEP_INTERVAL_MS};
var STAMP_HEADER = ${JSON.stringify(CACHED_AT_HEADER)};
var BYTES_HEADER = ${JSON.stringify(CACHED_BYTES_HEADER)};
var FRESH_FOR_HEADER = ${JSON.stringify(FRESH_FOR_HEADER)};
var SWEEP_MARK = ${JSON.stringify(SWEEP_MARK_URL)};

/*
 * Entries no rule may ever evict: the precache list, plus the sweep's own
 * bookkeeping entry.
 *
 * PRECACHE is the app shell - "/", "/offline", the stylesheet and the script.
 * Ageing those out is the one way this feature could make the site worse than
 * it was: install is the only thing that puts them back, install only runs on
 * a worker update, and a reader whose shell expired while they were out of
 * range gets a browser error page instead of "/offline". They are four entries
 * and about 50 KB against a 64 MB budget, so exempting them costs nothing
 * measurable, and they do not go stale either - "/" is network-first and is
 * rewritten on every online visit, and the other two carry a content hash in
 * the URL, so a change to them is a different URL and a different cache entry.
 *
 * Compared as absolute URLs because that is what cache.keys() hands back.
 *
 * One consequence worth stating: cache.addAll cannot stamp, so the copies
 * install writes carry no byte count and contribute nothing to the size total
 * until something re-stores them - which "/" does on the first online
 * navigation and the two assets do on their first background refresh. The
 * error is at most the shell's own size, on a budget three orders of magnitude
 * larger, and the alternative is replacing addAll's single atomic call with a
 * hand-rolled fetch-and-stamp loop inside install, which is the one place in
 * this file where a failure wedges the worker.
 */
var PROTECTED = PRECACHE.concat([SWEEP_MARK]).map(function (url) {
  return new URL(url, self.location.href).href;
});

function isProtected(url) {
  return PROTECTED.indexOf(url) !== -1;
}

/*
 * Rewrite a response with the three facts eviction needs: when this device
 * stored it, how big it is, and how long the server promised to keep serving
 * the same bytes.
 *
 * The alternative was the response's own Date header, and it is the wrong
 * clock twice - it is the origin's, and for a cache-first page refreshed in
 * the background it says when the server answered rather than when this device
 * wrote the entry. Date is still read as a fallback in cachedAt, for an entry
 * that somehow arrived without a stamp.
 *
 * Headers cannot be set on a response that already exists, so this constructs
 * a new one, which means reading the body. That read is also where the byte
 * count comes from - so the size cap, which would otherwise need a pass that
 * reads every body back, is free.
 *
 * The freshness promise is the origin's own cache-control max-age, copied
 * through. The server sends max-age=86400 on story pages and a year on hashed
 * assets, so honouring it is what lets the cache-first path skip the
 * revalidation fetch it used to make on every hit - which was the cost paid
 * for a page that never changes. An origin that declares nothing gets 0, the
 * conservative reading.
 */
function stamped(response, now) {
  return response.blob().then(function (body) {
    var headers = new Headers(response.headers);
    headers.set(STAMP_HEADER, String(now));
    headers.set(BYTES_HEADER, String(body.size));
    headers.set(FRESH_FOR_HEADER, String(originMaxAge(response)));
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: headers
    });
  });
}

/* The origin's max-age, in seconds. Anything unparseable is no promise at all. */
function originMaxAge(response) {
  var control = response.headers.get("cache-control") || "";
  var match = /max-age=(\\d+)/.exec(control);
  return match ? Number(match[1]) : 0;
}

/* Seconds this entry stays trustworthy, from its own stamp. */
function freshFor(response) {
  var seconds = response ? Number(response.headers.get(FRESH_FOR_HEADER)) : 0;
  return seconds > 0 ? seconds : 0;
}

/* Epoch milliseconds this entry was stored, or 0 when it cannot be dated. */
function cachedAt(response) {
  if (!response) return 0;
  var stamp = Number(response.headers.get(STAMP_HEADER));
  if (stamp > 0) return stamp;
  var date = Date.parse(response.headers.get("date") || "");
  return date > 0 ? date : 0;
}

function storedBytes(response) {
  var bytes = response ? Number(response.headers.get(BYTES_HEADER)) : 0;
  return bytes > 0 ? bytes : 0;
}

/*
 * An entry that cannot be dated is never expired.
 *
 * The other reading - treat an unknown age as ancient - would turn any future
 * bug in the stamping into the silent deletion of a reader's whole offline
 * library, discovered on a device with no network. This way the failure mode
 * of a broken stamp is a cache that grows, which the size cap still bounds.
 *
 * A clock that went backwards makes the difference negative, which is not
 * greater than the limit, so a device whose time was wrong and got fixed
 * keeps its pages rather than losing all of them at once.
 */
function isStale(at, now) {
  return at > 0 && now - at > MAX_AGE_MS;
}

function isExpired(response, now) {
  return isStale(cachedAt(response), now);
}

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
 *
 * /favicon.ico is here for the /robots.txt reason. It is a root-level
 * non-HTML resource, and a browser that navigates straight to it sends
 * Accept: text/html - which would file an icon in the page cache and, offline,
 * answer an icon request with the /offline document. The copy that matters is
 * cached anyway: every page links the icon at a hashed /assets/ URL, and those
 * are cache-first.
 */
function isBypassed(path) {
  return (
    path.indexOf("/epub/") === 0 ||
    path.indexOf("/opds") === 0 ||
    path.indexOf("/rss") === 0 ||
    path === "/healthz" ||
    path === "/theme" ||
    path === "/settings" ||
    path === "/robots.txt" ||
    path === "/favicon.ico"
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

/*
 * The whole eviction policy, in one pass over the cache index.
 *
 * Two rules, sharing one ordering key - the stamp - because they are the same
 * judgement stated twice. Anything past thirty days goes; if what remains is
 * still over the byte budget, the oldest of it keeps going until it is not.
 *
 * Oldest-first rather than least-recently-used, and the difference is worth
 * being honest about: the Cache API records nothing about reads, so a true LRU
 * would mean rewriting an entry on every hit - a full body copy per page view,
 * on the slowest storage on the device, to reorder a list nobody looks at.
 * Oldest-first is what the stamps already support at zero cost, and on this
 * corpus it is close to the same answer anyway, because an edition is read in
 * the days after it is saved and then never again.
 *
 * cache.match() on each key reads the entry's headers without touching its
 * body, so the cost of a sweep is one index walk and no bytes.
 */
function sweep(now) {
  return caches.open(CACHE).then(function (cache) {
    return cache.keys().then(function (keys) {
      return Promise.all(
        keys.map(function (request) {
          return cache.match(request).then(function (response) {
            return {
              request: request,
              at: cachedAt(response),
              bytes: storedBytes(response),
              keep: isProtected(request.url)
            };
          });
        })
      ).then(function (entries) {
        var drops = [];
        var live = [];
        var total = 0;
        var i;

        for (i = 0; i < entries.length; i++) {
          if (!entries[i].keep && isStale(entries[i].at, now)) {
            drops.push(entries[i].request);
            continue;
          }
          /* Protected entries occupy space even though nothing may take it. */
          total += entries[i].bytes;
          if (!entries[i].keep) live.push(entries[i]);
        }

        /*
         * Undated entries sort to the front and are shed first under pressure,
         * which is the right order: an entry this worker cannot date is one it
         * did not write, and it is the only kind the age rule cannot reach.
         */
        live.sort(function (a, b) {
          return a.at - b.at;
        });
        for (i = 0; i < live.length && total > MAX_BYTES; i++) {
          drops.push(live[i].request);
          total -= live[i].bytes;
        }

        return Promise.all(
          drops.map(function (request) {
            return cache.delete(request);
          })
        ).then(function () {
          return cache.put(
            SWEEP_MARK,
            new Response("", {
              headers: makeStampHeaders(now)
            })
          );
        }).then(function () {
          return drops.length;
        });
      });
    });
  });
}

/* The sweep mark carries no body, so it is stamped by hand rather than read. */
function makeStampHeaders(now) {
  var headers = {};
  headers[STAMP_HEADER] = String(now);
  headers[BYTES_HEADER] = "0";
  return headers;
}

/*
 * At most one sweep per worker instance, and at most one per day across all of
 * them.
 *
 * No timer, deliberately. A service worker is killed within seconds of going
 * idle, so setInterval in one either never fires or holds the worker alive to
 * no purpose - it is the classic mistake. The trigger is instead whatever
 * request happened to wake the worker, gated by a flag that lasts as long as
 * this instance and a timestamp in the cache that outlives it.
 */
var swept = false;

function maybeSweep(now) {
  if (swept) return Promise.resolve(null);
  swept = true;
  return caches
    .match(SWEEP_MARK)
    .then(function (mark) {
      var last = cachedAt(mark);
      if (last > 0 && now - last < SWEEP_EVERY_MS) return null;
      return sweep(now);
    })
    .catch(function () {
      return null;
    });
}

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
        /*
         * Forced rather than throttled. Activate runs once per worker version,
         * which on a quiet month is once, so this is the cheapest guaranteed
         * sweep there is and skipping it because one happened yesterday would
         * trade a certainty for nothing.
         */
        swept = true;
        return sweep(Date.now()).catch(function () {});
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

/* Store a stamped copy without consuming the response the page is waiting on. */
function put(request, response) {
  if (!response || response.status !== 200 || response.type === "opaque") {
    return response;
  }
  var copy = response.clone();
  caches
    .open(CACHE)
    .then(function (cache) {
      return stamped(copy, Date.now()).then(function (entry) {
        return cache.put(request, entry);
      });
    })
    /* One more link in this chain than there used to be, and a rejected
     * cache.put is an unhandled rejection in the worker's console. */
    .catch(function () {});
  return response;
}

function cacheFirst(request) {
  /*
   * A reload asks for new bytes outright, and the browser marks the request
   * "reload" to say so. Honouring it here is what makes the browser's own
   * refresh button work against a cache-first page: without this check the
   * reload would be answered from storage like any other hit, and the reader
   * staring at a stale page has no way out but waiting for the cache to age.
   * Old browsers that do not set .cache fall through to the normal paths.
   */
  var reload = request.cache === "reload";
  return caches.match(request).then(function (hit) {
    if (hit && !reload && !isExpired(hit, Date.now())) {
      if (Date.now() - cachedAt(hit) <= freshFor(hit) * 1000) {
        /*
         * Inside the freshness the origin itself declared, so serving from
         * storage is not a staleness gamble, it is what the server said to
         * do. This gate is the difference between a cache-first page costing
         * a network round trip on every read and costing one a day.
         */
        return hit;
      }
      /*
       * Freshness has run out. Refresh in the background anyway: the page is
       * immutable, but the server may have gained an article extraction or a
       * cover since, and this costs the reader nothing. The refresh re-stamps
       * the entry, so a page that is read regularly never ages out from under
       * its reader. An entry with no freshness stamp at all - the precache,
       * or anything stored by an older worker - is always past its window,
       * so it keeps the old behaviour of revalidating on every read.
       */
      fetch(request)
        .then(function (res) {
          put(request, res);
        })
        .catch(function () {});
      return hit;
    }
    if (hit) {
      /*
       * Past its thirty days, or the reader explicitly asked for new bytes.
       * Deleted here rather than left for the next sweep, because this is the
       * moment the space is known to be reclaimable and the sweep may be a
       * day away.
       *
       * The stale copy is still returned if the network then fails. Losing the
       * radio in the same second a page aged out should not cost the reader
       * the page - the entry is gone from storage either way, which is the
       * part the quota cares about.
       */
      caches
        .open(CACHE)
        .then(function (cache) {
          return cache.delete(request);
        })
        .catch(function () {});
      return fetch(request)
        .then(function (res) {
          return put(request, res);
        })
        .catch(function () {
          return hit;
        });
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

  /*
   * The periodic sweep, hung off whatever request woke the worker.
   *
   * waitUntil rather than a bare call so the browser does not tear the worker
   * down mid-delete, and after the bypass check so an EPUB download or a
   * /healthz poll is not what triggers it. maybeSweep returns an already
   * settled promise every time but the first, so the cost on the normal path
   * is one comparison.
   */
  event.waitUntil(maybeSweep(Date.now()));

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
 * Bulk save, driven by the save button on an edition page.
 *
 * Sequential on purpose. Thirty parallel requests for pages that each embed a
 * full article and its comment tree is a burst the server has no reason to
 * absorb, and an e-reader radio handles it worse than the server does.
 *
 * A page already in the cache and still inside its thirty days is skipped
 * rather than refetched, which is what makes the button's label honest: the
 * pages a reader has already opened were cached as they read them, and this
 * only pays for the rest. On an edition half of which has been read that is
 * half the radio time, and the copy on the page says so.
 *
 * Each stored page is named back to the sender so the list it was launched
 * from can grow its markers as the save walks down it, rather than showing
 * thirty at once on the next navigation.
 */
/*
 * Emptying the cache, on the page's say-so.
 *
 * This is the backstop behind every other freshness rule: the pull gesture on
 * a touch device sends one message, everything the server can still serve is
 * dropped, and the reload that follows shows bytes fetched seconds ago. It
 * exists because no retention policy can anticipate every way a server changes
 * its mind, and "clear the cache" is the fix a reader can be told in one
 * sentence.
 *
 * What survives is deliberate. The precache is the app shell - deleting it
 * leaves a reader offline with a browser error page until the next install,
 * which purge cannot trigger. The hashed assets cannot go stale (a change to
 * them is a different URL), so dropping them only costs re-downloads. The
 * sweep mark is bookkeeping, not content.
 *
 * The dropped count is reported back so the page knows the purge finished
 * before it reloads - reloading on a promise that has not resolved can race
 * the deletions and show the same stale page again.
 */
function purgeCache(cache) {
  return cache.keys().then(function (keys) {
    var drops = [];
    for (var i = 0; i < keys.length; i++) {
      var path = new URL(keys[i].url).pathname;
      if (isProtected(keys[i].url) || isAsset(path)) continue;
      drops.push(keys[i]);
    }
    return Promise.all(
      drops.map(function (request) {
        return cache.delete(request);
      })
    ).then(function () {
      return drops.length;
    });
  });
}

self.addEventListener("message", function (event) {
  var data = event.data || {};
  if (data.type === "purge-cache") {
    var client = event.source;
    event.waitUntil(
      caches.open(CACHE).then(function (cache) {
        return purgeCache(cache).then(function (dropped) {
          if (client) {
            client.postMessage({ type: "cache-purged", dropped: dropped });
          }
        });
      })
    );
    return;
  }
  if (data.type !== "save-urls" || !data.urls || !data.urls.length) return;

  var urls = data.urls;
  var source = event.source;

  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      var done = 0;
      var already = 0;
      var failed = 0;

      function report(state, saved) {
        if (!source) return;
        source.postMessage({
          type: "save-progress",
          state: state,
          done: done,
          already: already,
          failed: failed,
          total: urls.length,
          url: saved || null
        });
      }

      function store(url) {
        return fetch(url, { credentials: "same-origin" })
          .then(function (res) {
            if (!res || res.status !== 200) {
              failed += 1;
              return null;
            }
            return stamped(res, Date.now())
              .then(function (entry) {
                return cache.put(url, entry);
              })
              .then(function () {
                done += 1;
                return url;
              });
          })
          .catch(function () {
            failed += 1;
            return null;
          });
      }

      function step(i) {
        if (i >= urls.length) {
          report("done");
          /*
           * A bulk save is the largest single write this application makes,
           * so it is the one moment the byte budget is most likely to have
           * been crossed. Forced, and after the terminal report, so the
           * reader is told the save finished without waiting on the sweep.
           */
          swept = true;
          return sweep(Date.now()).catch(function () {});
        }
        var url = urls[i];
        return cache
          .match(url)
          .then(function (hit) {
            if (hit && !isExpired(hit, Date.now())) {
              already += 1;
              done += 1;
              return url;
            }
            return store(url);
          })
          .then(function (saved) {
            report("progress", saved);
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
 * offline controls, wires the save button, reveals the marker next to a story
 * that is already on the device, and keeps your place when a comment
 * collapses. Everything it touches is optional: with scripting off the button
 * never appears, no marker is revealed, the comment tree still collapses
 * natively, and every page still renders and navigates.
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
       * Every part of the header toggles, including the author name, which is
       * plain text rather than a link to Hacker News for exactly that reason -
       * see authorName in ~/web/story. There is deliberately no guard for an
       * anchor inside the summary: there is no longer one to guard against, and
       * a dead check describing markup that no longer exists is worse than
       * nothing. The wasOpen comparison below is the real safety net anyway,
       * since anything that swallows the toggle also cancels the correction.
       */
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

  /*
   * The floating control that walks through the discussion.
   *
   * One rule covers every case in each direction. Going forward, from the
   * article every thread is below you, so "the first stop below the top edge"
   * is thread A; from inside the discussion the same phrase means the next
   * thread down. Going back, "the last stop above the top edge" is the thread
   * you just came from wherever you happen to be standing. Writing each
   * direction as a single sentence is why there is no state here - no scroll
   * listener, no index to keep in step with a reader who scrolled by hand or
   * arrived on an anchor.
   *
   * The pixel of slack is what stops a stop you are already parked on from
   * being its own answer, in either direction.
   */
  function threadStop(stops, back) {
    var i;
    if (back) {
      for (i = stops.length - 1; i >= 0; i -= 1) {
        if (stops[i].getBoundingClientRect().top < -1) return stops[i];
      }
      return null;
    }
    for (i = 0; i < stops.length; i += 1) {
      if (stops[i].getBoundingClientRect().top > 1) return stops[i];
    }
    return null;
  }

  var jump = document.querySelector("[data-thread-jump]");
  if (jump && document.querySelectorAll) {
    /*
     * Both halves of the reveal, matching the saved marker: the attribute the
     * markup shipped with comes off, and the root is flagged for the
     * stylesheet. Neither is enough alone - the sheet must still be free to
     * refuse on a device that cannot afford a pinned layer.
     */
    jump.removeAttribute("hidden");
    root.setAttribute("data-thread-jump-ready", "");

    /*
     * Two lists, because the directions do not share their far ends.
     *
     * Forward stops at the block of buttons under the last thread rather than
     * at the thread itself, so the arrow always has somewhere to go and always
     * goes down, and the reader is left looking at Back to top rather than at
     * the tail of an argument.
     *
     * Back stops at the story header, so a reader who came down through a long
     * article can get to the top of it without a hundred page turns - the
     * masthead does not stay on screen and there is no other way up. It does
     * not include the foot block: from the very bottom of the page the useful
     * answer is the last thread, not the buttons a few lines above.
     *
     * Both are collected once. The set of top-level threads is fixed for the
     * life of the page - collapsing a comment changes where they are, not how
     * many there are - so re-querying per tap would walk a few hundred comments
     * to rediscover the same twenty sections. The geometry is read fresh on
     * every tap, which is the part that actually moves.
     */
    var ahead = document.querySelectorAll(".comments .thread, .comments .actions");
    var behind = document.querySelectorAll(".story-head, .comments .thread");

    /*
     * Delegated from the box rather than bound to each button, matching the
     * comment headers above. It is also the only thing that works: the tap
     * lands on the SVG, or on a path inside it, so the handler has to walk up
     * to find which arrow was hit whatever it is attached to.
     */
    jump.addEventListener(
      "click",
      function (event) {
        var target = event.target;
        /* Old WebKit can report a text node as the target of a click. */
        if (target && target.nodeType === 3) target = target.parentNode;
        if (!target || !target.closest) return;

        var arrow = target.closest("[data-thread-jump-to]");
        if (!arrow) return;

        var back = arrow.getAttribute("data-thread-jump-to") === "prev";
        var stop = threadStop(back ? behind : ahead, back);
        if (!stop) return;
        var delta = stop.getBoundingClientRect().top;
        if (delta) window.scrollBy(0, delta);
      },
      false
    );
  }
})();

(function () {
  if (!("serviceWorker" in navigator)) return;

  var SAVED_MAX_AGE_MS = ${CACHE_MAX_AGE_MS};
  var SAVED_STAMP = ${JSON.stringify(CACHED_AT_HEADER)};

  navigator.serviceWorker
    .register("/assets/sw.js", { scope: "/" })
    .then(function () {
      document.documentElement.setAttribute("data-sw", "ready");
    })
    .catch(function () {});

  /*
   * The offline markers.
   *
   * Whether a page is on the device is only knowable from the Cache API, so
   * the marker cannot be server-rendered. It ships in the markup already
   * carrying the hidden attribute and its accessible name, and all this does
   * is take the attribute off the ones that turn out to be cached. A reader
   * with no worker, no scripting or no Cache API sees the page exactly as it
   * was before - which is the only shape this can take, because a marker
   * shown by default would be a claim about storage that is false on a first
   * visit.
   *
   * The stamp is read here rather than the entry's mere presence being taken
   * as proof, so an entry the worker has not swept yet but which is past its
   * thirty days does not get a marker it is about to lose. The two agree
   * because both numbers come out of ~/web/offline.
   */
  function markFor(url) {
    /* The attribute values are site-relative paths this server generated, so
     * there is nothing in them a selector has to be defended against. */
    return document.querySelector('[data-saved-mark="' + url + '"]');
  }

  function reveal(node) {
    if (node) node.removeAttribute("hidden");
  }

  function isSaved(url) {
    return caches
      .match(url)
      .then(function (hit) {
        if (!hit) return false;
        var at = Number(hit.headers.get(SAVED_STAMP));
        /* Undated entries are what the worker also declines to expire. */
        if (!(at > 0)) return true;
        return Date.now() - at <= SAVED_MAX_AGE_MS;
      })
      .catch(function () {
        return false;
      });
  }

  /*
   * How many of the marked pages were found, written into the save button's
   * status line.
   *
   * The glyph on its own says "this one"; this says "and here is how much of
   * the button's work is already done", which is the number that decides
   * whether to press it. Only ever written into an empty status line, so a
   * save already in progress - which speaks through the same element - is
   * never overwritten by a count that arrived late.
   */
  function tally(saved, total) {
    var status = document.querySelector("[data-save-status]");
    if (!status || !saved || status.textContent) return;
    status.textContent =
      saved >= total
        ? "Every story here is already on this device."
        : saved + " of " + total + " already on this device.";
  }

  /*
   * One page at a time. Thirty concurrent Cache API reads on an e-reader is a
   * burst of storage work competing with the render of the page it is
   * annotating, for an annotation nobody is waiting on.
   */
  function scan() {
    if (!window.caches || !document.querySelectorAll) return;
    var nodes = document.querySelectorAll("[data-saved-mark]");
    if (!nodes.length) return;

    var saved = 0;
    function next(i) {
      if (i >= nodes.length) {
        tally(saved, nodes.length);
        return;
      }
      isSaved(nodes[i].getAttribute("data-saved-mark")).then(function (hit) {
        if (hit) {
          reveal(nodes[i]);
          saved += 1;
        }
        next(i + 1);
      });
    }
    next(0);
  }

  /*
   * Pull to refresh, for touch devices.
   *
   * The worker's retention rules are automatic and conservative; this is the
   * manual override, the gesture a reader already knows from every native
   * app. Pull down from the top of a page and the cache is emptied of
   * everything but the app shell, then the page reloads - so a server that
   * changed its mind about something is corrected in one motion, without a
   * settings page to find.
   *
   * Touch only, because a wheel and a scrollbar are a poor proxy for intent:
   * a mouse user who drags a scrollbar to the top has not asked for anything.
   * The indicator is inline-styled from the script rather than the stylesheet
   * so the gesture carries no cost for the majority of pages where scripting
   * is off or the device has no touch screen.
   *
   * The reload waits for the worker's reply, because reloading on a purge
   * that has not finished can race the deletions and re-show the very stale
   * page being purged. Timers bound that wait - the shorter one covers a
   * worker that never replies, the longer one a browser that ignored the
   * first reload - so the gesture can never leave the reader stuck.
   */
  function wirePull() {
    if (!("ontouchstart" in window)) return;

    var THRESHOLD = 96; /* effective pixels of pull before it counts */
    var CAP = 64; /* the indicator stops growing here */
    var RESISTANCE = 0.5; /* half of every dragged pixel */
    var REPLY_MS = 1500; /* how long a purge has to answer */
    var BAIL_MS = 3000; /* reload anyway, whatever else went wrong */
    var BAR_STYLE =
      "position:fixed;top:0;left:0;right:0;background:#000;" +
      "z-index:2147483647;pointer-events:none;height:0;";

    var busy = false;
    var pulling = false;
    var startY = 0;
    var pulled = 0;
    var bar = null;

    function indicator() {
      if (bar) return bar;
      bar = document.createElement("div");
      bar.setAttribute("aria-hidden", "true");
      bar.setAttribute("style", BAR_STYLE);
      document.body.appendChild(bar);
      return bar;
    }

    function grow(amount) {
      var height = amount > CAP ? CAP : amount;
      indicator().setAttribute("style", BAR_STYLE + "height:" + Math.round(height) + "px;");
    }

    function settle() {
      pulling = false;
      pulled = 0;
      if (bar) bar.setAttribute("style", BAR_STYLE);
    }

    function purge() {
      busy = true;
      var reloaded = false;
      function go() {
        if (reloaded) return;
        reloaded = true;
        window.location.reload();
      }
      function onMessage(event) {
        if ((event.data || {}).type !== "cache-purged") return;
        navigator.serviceWorker.removeEventListener("message", onMessage);
        clearTimeout(reply);
        clearTimeout(bail);
        go();
      }
      var reply = setTimeout(go, REPLY_MS);
      var bail = setTimeout(go, BAIL_MS);
      navigator.serviceWorker.addEventListener("message", onMessage);
      navigator.serviceWorker.ready.then(function (registration) {
        var worker = registration.active;
        if (worker) worker.postMessage({ type: "purge-cache" });
      });
    }

    document.addEventListener("touchstart", function (event) {
      if (busy || event.touches.length !== 1) return;
      var top =
        window.pageYOffset || document.documentElement.scrollTop || 0;
      if (top > 0) return;
      startY = event.touches[0].clientY;
      pulling = true;
    });

    document.addEventListener(
      "touchmove",
      function (event) {
        if (!pulling || busy) return;
        var delta = event.touches[0].clientY - startY;
        if (delta <= 0) {
          if (pulled) indicator().setAttribute("style", BAR_STYLE);
          pulled = 0;
          return;
        }
        pulled = delta * RESISTANCE;
        grow(pulled);
        if (event.cancelable) event.preventDefault();
      },
      { passive: false }
    );

    document.addEventListener("touchend", function () {
      if (!pulling) return;
      var amount = pulled;
      settle();
      if (amount >= THRESHOLD && !busy) purge();
    });
  }

  function wire() {
    scan();
    wirePull();

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
      /* Each page the worker stores, marked the moment it lands. */
      if (data.url) reveal(markFor(data.url));
      if (data.state === "done") {
        button.removeAttribute("aria-disabled");
        var already = data.already || 0;
        var fetched = data.done - already;
        if (data.failed) {
          say("Saved " + fetched + " of " + data.total + ", " + data.failed + " failed.");
        } else if (already) {
          say("Saved " + fetched + ", and " + already + " were already here.");
        } else {
          say("Saved " + data.done + " pages for offline reading.");
        }
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
      /*
       * Hashed URLs, from the icon registry rather than written out here. An
       * installed app keeps whatever icon the manifest named at install time,
       * so a literal path that stopped matching the bytes would be a wrong
       * icon on someone's home screen until they reinstalled.
       */
      icons: manifestIcons(),
    },
    null,
    2,
  );
}
