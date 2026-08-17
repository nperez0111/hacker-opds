/**
 * `X-Robots-Tag` on every response.
 *
 * The `<meta name="robots">` tag in the page head only exists in HTML. This
 * server's most copyable output is not HTML - it is the EPUBs, which contain
 * the full text of other people's articles, and the OPDS feeds that list them.
 * A header is the only way to attach the same instruction to a zip file.
 *
 * Set before `next()` because materialising the Response freezes its headers,
 * and mutating them afterwards throws in dev but not in production.
 *
 * The RSS feeds are covered too, and that is a decision rather than an
 * oversight. The tempting argument is that a feed exists to be subscribed to,
 * so telling robots to stay away is self-defeating - but it is not: no feed
 * reader treats `X-Robots-Tag` as permission to fetch, because a reader is a
 * user-directed client rather than a crawler, and none of them will refuse a
 * subscription over it. What the header does affect is aggregators and indexers
 * that ingest feeds and republish them, and the feed is the single most
 * copyable thing this server emits - fifty complete articles in one request,
 * already extracted and cleaned. Dropping the header there would remove the
 * signal from exactly the representation that most needs it.
 */
import { defineMiddleware } from "nitro/h3";

/*
 * `noai` and `noimageai` are not part of any standard. They are honoured by a
 * handful of crawlers and ignored by the rest, which is exactly the value of
 * including them: they cost one header and they remove the "we were never told
 * not to" defence.
 */
const DIRECTIVES =
  "noindex, nofollow, noarchive, nosnippet, noimageindex, noai, noimageai";

export default defineMiddleware((event, next) => {
  event.res.headers.set("x-robots-tag", DIRECTIVES);
  return next();
});
