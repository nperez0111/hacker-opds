/**
 * Works out which origin the catalogue should advertise in its links.
 *
 * OPDS feeds carry absolute URLs, so getting this wrong is not cosmetic: an
 * e-reader loads the root feed fine, then follows an entry pointing at
 * `http://localhost:8080` and fails with "connection refused", because on the
 * e-reader `localhost` is the e-reader.
 *
 * The rule is deliberately simple. `PUBLIC_BASE_URL` has a placeholder
 * default, so anything *other* than that default is taken as an intentional
 * deployment setting and wins. Otherwise the origin is derived from the request
 * the reader actually made, which is always reachable by definition - it is the
 * address they just connected to.
 */
import type { H3Event } from "nitro/h3";
import { config } from "~/config";
import { DEFAULTS } from "~/defaults";

const trimSlashes = (value: string): string => value.replace(/\/+$/, "");

/**
 * True when the operator has set a real base URL rather than the placeholder.
 *
 * Both sides are normalised rather than assuming the config layer already
 * stripped the trailing slash, so a value injected directly (as tests do)
 * cannot read as an intentional override just for being punctuated differently.
 */
export function hasExplicitBaseUrl(): boolean {
  return trimSlashes(config().publicBaseUrl) !== trimSlashes(DEFAULTS.publicBaseUrl);
}

/**
 * Origin derived from the request, honouring the headers a reverse proxy adds.
 *
 * `X-Forwarded-*` matters because behind a proxy the socket-level host is an
 * internal address; the reader needs the public one.
 */
export function requestOrigin(event: H3Event): string {
  const headers = event.req.headers;
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (!host) return event.url.origin;

  const proto =
    headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
    event.url.protocol.replace(/:$/, "");

  return `${proto}://${host}`;
}

/**
 * The base URL to build catalogue links from.
 *
 * Explicit configuration wins; otherwise follow the request.
 */
export function resolveBase(event: H3Event): string {
  if (hasExplicitBaseUrl()) return trimSlashes(config().publicBaseUrl);
  return trimSlashes(requestOrigin(event));
}

/**
 * The request headers a feed's body depends on, for `Vary`.
 *
 * Null when an explicit base URL is configured, because then the body genuinely
 * does not vary: every link comes from the config and the request is not
 * consulted at all. Announcing a dependency that does not exist would split one
 * cache entry into several for no reason.
 *
 * `Host` is not listed even though `requestOrigin` reads it. A cache keys on the
 * target URI, which includes the host, so it is already part of the key and
 * naming it again buys nothing. The forwarded pair is different: it is not in
 * the key, and it changes every absolute URL in the body. An intermediary that
 * did not know that could hand a reader a catalogue whose every link points at
 * another deployment - which is precisely the "loads fine, then connection
 * refused" failure this module exists to prevent, arriving by a different road.
 */
export function originVary(): string | null {
  if (hasExplicitBaseUrl()) return null;
  return "X-Forwarded-Host, X-Forwarded-Proto";
}
