/**
 * Conditional GET for generated bodies.
 *
 * The artifact routes have had this since the beginning, but they get it for
 * free: an EPUB or a cover is content-addressed, so the digest is already in the
 * ledger and the route only has to compare a string. A feed has no such record.
 * It is assembled per request out of rows that no single column dates, so the
 * only honest validator is the bytes themselves.
 *
 * ## Why hashing the body is not the waste it looks like
 *
 * The obvious objection is that a 304 still costs a full render. It does, and it
 * is still worth it, because rendering is not what the request costs. An OPDS
 * feed is a few kilobytes and an RSS feed here is fifty complete articles -
 * close to a megabyte - and feed readers poll on their own schedule, many of
 * them ignoring `Cache-Control` entirely. The expensive part is the body on the
 * wire to a device on a phone hotspot, not the string in memory.
 *
 * The alternative - a validator composed from `MAX(built_at)`, `story_count`
 * and the deployment's git sha - would let a revalidation skip the render, and
 * it would be wrong. `stories` has no `updated_at`, so a re-ingest can rewrite
 * points and comment counts with no timestamp moving anywhere; and an EPUB
 * finishing its build adds an enclosure to an RSS item without touching any
 * date in the feed. Both cases would freeze a reader on a copy that is quietly
 * stale, which is worse than a hash that is merely unglamorous.
 *
 * ## Why this is one module rather than a helper in each feed package
 *
 * `~/rss/respond` and `~/opds/respond` were split on the grounds that both
 * halves of their answer genuinely differed. The caching policy still does. The
 * conditional half no longer does, and two copies of "half a sha256, quoted"
 * are two things that can drift in length, in quoting, or in whether the 304
 * carries the headers - each of which is a bug no test would catch unless it
 * happened to be written twice too.
 */
import type { H3Event } from "nitro/h3";

/**
 * Entity tag over the rendered bytes.
 *
 * Half a sha256 is 128 bits, comfortably past accidental collision and short
 * enough not to bloat a header a reader sends back on every poll. Strong rather
 * than weak (`W/`): the bytes are exactly what is being compared, so claiming
 * only semantic equivalence would understate it and stop a cache from using it
 * for a range request.
 */
export function entityTag(body: string): string {
  return `"${new Bun.CryptoHasher("sha256").update(body).digest("hex").slice(0, 32)}"`;
}

/**
 * A 200 with an entity tag, or a 304 when the reader already has these bytes.
 *
 * The caller owns every other header - content type, cache policy, and whatever
 * else the format needs - and this adds only `etag`. The 304 carries the full
 * set rather than the tag alone, because a validating cache updates its stored
 * headers from the response and dropping `Cache-Control` there would quietly
 * reset the freshness window it was told about the first time.
 *
 * Only `If-None-Match` is honoured. `If-Modified-Since` is deliberately not,
 * here or anywhere else in this codebase: the feeds can change while every
 * timestamp in them stands still, so answering 304 to a date comparison would
 * strand a reader on a copy with no books in it.
 */
export function conditionalResponse(
  event: H3Event,
  body: string,
  headers: Record<string, string>,
): Response {
  const withTag = { ...headers, etag: entityTag(body) };

  if (event.req.headers.get("if-none-match") === withTag.etag) {
    return new Response(null, { status: 304, headers: withTag });
  }

  return new Response(body, { headers: withTag });
}
