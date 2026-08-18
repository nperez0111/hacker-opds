/**
 * The offline cache's retention policy, in one place.
 *
 * Four separate pieces of the site have to agree about how long a saved page
 * lives: the service worker that stamps and evicts it (`~/web/sw`), the
 * page-side script that decides whether to show a `\u2193` next to a story
 * (also `~/web/sw`, in `APP_JS`), the copy on the edition page that promises
 * the reader thirty days (`~/web/views`), and the tests. Three of those four
 * are *strings* - the worker and the shim are emitted as source text, not
 * compiled - so nothing would catch a number that drifted in one of them and
 * not the others. A reader would simply be told thirty days and get twelve, or
 * be shown a marker for a page the worker had already thrown away.
 *
 * Hence this module. It exports numbers, not behaviour; the worker
 * interpolates them into its source and the views read them for their prose,
 * so there is exactly one place to change and no way to change it halfway.
 *
 * ## Why an age cap at all
 *
 * Until now nothing in the cache was ever evicted. `activate` drops caches
 * belonging to *previous* worker versions and that is the entire eviction
 * story, so within one version the cache only grows. Measured against this
 * project's own database, a story page averages 141 KB and reaches 654 KB, so
 * one edition saved through the button is roughly 4.2 MB. A reader who saves
 * an edition a day is adding that much a day, indefinitely. The end of that
 * road is not a slow site: it is the browser deciding this origin is over its
 * quota and evicting *the whole origin*, app shell included, which turns the
 * site into a blank page on precisely the device that has no network to
 * recover from.
 *
 * ## Why thirty days rather than the server's ninety
 *
 * `retentionDays` (`src/defaults.ts:19`) is how long the *server* keeps an
 * edition, and it is ninety because disk on a server is cheap and the archive
 * is the product. A reader's device is the opposite of that: storage is a few
 * gigabytes shared with their books, and a page they last opened three months
 * ago is not something they are about to go back to. Thirty days is a month of
 * reading - long enough that a saved edition survives a holiday with no signal,
 * short enough that the steady state is bounded at about a tenth of what
 * ninety days would settle on.
 */

/** The promise made to the reader, in the units the copy states it in. */
export const CACHE_MAX_AGE_DAYS = 30;

export const CACHE_MAX_AGE_MS = CACHE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

/**
 * Ceiling on the bytes the page cache may hold, enforced oldest-first.
 *
 * The age cap alone does not bound the cache, it only bounds how *old* the
 * contents are: a reader who saves every edition for thirty days is holding
 * thirty times 4.2 MB, or about 126 MB, which is a real risk of origin
 * eviction on an e-reader. 64 MB is fifteen saved editions - a fortnight of
 * the heaviest plausible use - and comfortably inside any quota a browser has
 * ever granted an origin.
 *
 * This is affordable to enforce only because every entry is stamped with its
 * own byte count when it is stored (see `CACHED_BYTES_HEADER`), so a sweep
 * knows the total without reading a single body back.
 */
export const CACHE_MAX_BYTES = 64 * 1024 * 1024;

/**
 * How often a full sweep is worth doing.
 *
 * Not a timer. A service worker is killed within seconds of going idle, so
 * `setInterval` in one is either dead code or a leak - the classic mistake.
 * The interval is enforced by comparing against a timestamp persisted in the
 * cache itself (`SWEEP_MARK_URL`), so it survives the worker being torn down
 * and costs nothing while nothing is happening.
 *
 * A day is the right period because the thing being bounded moves on a scale
 * of days: an entry can be at most one day over its thirty before it is
 * collected, which is 3% of slack on a promise that was never meant to be
 * read to the second.
 */
export const CACHE_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * When this client stored this entry, in epoch milliseconds.
 *
 * A response usually arrives with a `Date` header, and using that instead
 * would save a header. It is the wrong number twice over: it is the *origin's*
 * clock rather than the device's, and for a cache-first page that the worker
 * refreshes in the background it names when the server answered rather than
 * when this device wrote the entry. Stamping means the age is measured in the
 * only clock that the expiry is ever compared against.
 *
 * Setting a header means constructing a new `Response`, which means reading
 * the body - so this costs one buffer copy per cached page. The byte count
 * below is free once that is paid, which is what makes the size cap possible
 * at all.
 */
export const CACHED_AT_HEADER = "x-hopds-cached";

/** Body length of the stored entry, taken from the blob the stamp already read. */
export const CACHED_BYTES_HEADER = "x-hopds-bytes";

/**
 * Cache key holding the last sweep's timestamp.
 *
 * Under `/__hopds/` rather than a plausible-looking path so it can never
 * collide with a page the site actually serves, and so a human reading a cache
 * dump can see it is bookkeeping. It is stored in the same cache as everything
 * else - a second cache would need its own name, its own retirement rule in
 * `activate`, and would be one more thing to get wrong for one timestamp.
 */
export const SWEEP_MARK_URL = "/__hopds/swept";
