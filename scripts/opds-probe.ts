/**
 * OPDS catalogue crawler and validator.
 *
 * Usage:
 *   bun run scripts/opds-probe.ts [baseUrl] [--deep] [--json]
 *
 * Crawls the catalogue from `{baseUrl}/opds`, following feed links breadth
 * first, and validates each feed against OPDS 1.2 plus the invariants that
 * actually break e-readers in the field.
 *
 * The headline check is cross-origin href detection. A catalogue whose feeds
 * are served from one origin but whose links point at another loads fine in a
 * browser (which follows the absolute URL happily) and then fails on a device
 * with "connection refused", because the second origin is unreachable from the
 * reader's network. The root feed loads, every subsequent tap dies. That is
 * exactly the failure this tool exists to catch, so any catalogue-internal link
 * whose origin differs from the crawl origin is a hard error.
 *
 * Links that are *meant* to leave the origin - `rel="alternate"` pointing at
 * the Hacker News discussion or the original article - are deliberately exempt.
 * Flagging those would bury the real signal under one false positive per story.
 *
 * When a cross-origin catalogue link is found the crawl does not follow it to
 * the foreign origin. It rebases the path onto the crawl origin and carries on,
 * so a single misconfiguration produces one finding per bad link rather than
 * truncating the crawl at the root feed.
 *
 * Exit code is 0 when no errors were found and 1 otherwise, so it works in CI.
 */
import { XMLParser, XMLValidator } from "fast-xml-parser";

export const NAVIGATION_KIND = "navigation";
export const ACQUISITION_KIND = "acquisition";
export const EPUB_TYPE = "application/epub+zip";
export const ATOM_TYPE = "application/atom+xml";
export const OPDS_PROFILE = "opds-catalog";
export const ACQUISITION_REL_PREFIX = "http://opds-spec.org/acquisition";

/** Link relations that must resolve to the catalogue's own origin. */
const CATALOG_RELS = new Set([
  "self",
  "start",
  "up",
  "next",
  "previous",
  "prev",
  "first",
  "last",
  "subsection",
  "search",
  "http://opds-spec.org/image",
  "http://opds-spec.org/image/thumbnail",
  "http://opds-spec.org/facet",
  "http://opds-spec.org/crawlable",
  "http://opds-spec.org/featured",
  "http://opds-spec.org/shelf",
  "http://opds-spec.org/subscriptions",
  "http://opds-spec.org/sort/new",
  "http://opds-spec.org/sort/popular",
]);

export type Severity = "error" | "warning";

export type FindingCategory =
  | "cross-origin"
  | "http"
  | "xml"
  | "content-type"
  | "feed-metadata"
  | "entry"
  | "link"
  | "epub";

export interface Finding {
  severity: Severity;
  category: FindingCategory;
  /** URL of the feed (or resource) the problem was observed in. */
  feed: string;
  message: string;
  href?: string;
  rel?: string;
  expected?: string;
  actual?: string;
}

export interface FeedSummary {
  url: string;
  status: number;
  contentType: string | null;
  /** Kind declared by the `Content-Type` header. */
  declaredKind: string | null;
  /** Kind inferred from the entries themselves. */
  inferredKind: string | null;
  entries: number;
  links: number;
  depth: number;
  parent: string | null;
}

export interface EpubCheck {
  url: string;
  status: number;
  contentType: string | null;
  etag: string | null;
  bytes: number | null;
  magicOk: boolean;
  notModifiedOk: boolean | null;
  ok: boolean;
}

export interface ProbeReport {
  ok: boolean;
  baseUrl: string;
  origin: string;
  startedAt: string;
  durationMs: number;
  options: { maxDepth: number; deep: boolean; epubSamples: number };
  stats: {
    feedsCrawled: number;
    entriesSeen: number;
    linksChecked: number;
    crossOriginLinks: number;
    epubsChecked: number;
    errors: number;
    warnings: number;
  };
  findingsByCategory: Record<string, number>;
  feeds: FeedSummary[];
  epubs: EpubCheck[];
  findings: Finding[];
}

export interface ProbeOptions {
  baseUrl: string;
  deep?: boolean;
  maxDepth?: number;
  epubSamples?: number;
  timeoutMs?: number;
  /**
   * Continue crawling a cross-origin catalogue link by rebasing it onto the
   * crawl origin. On by default; the finding is still reported either way.
   */
  followRebased?: boolean;
  fetchImpl?: typeof fetch;
}

/* -------------------------------------------------------------------------- */
/* parsing helpers                                                            */
/* -------------------------------------------------------------------------- */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Keep everything a string. Otherwise a feed whose entry title happens to be
  // numeric (dates in the archive feed are close enough to trip this) comes
  // back as a number and downstream string checks silently misbehave.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => name === "link" || name === "entry",
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Elements carrying attributes parse to objects, so unwrap the text node. */
function textOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (isRecord(value)) {
    const text = value["#text"];
    if (typeof text === "string") return text;
    if (typeof text === "number") return String(text);
  }
  return undefined;
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export interface ParsedLink {
  rel: string;
  href: string;
  type?: string;
  title?: string;
}

export interface ParsedEntry {
  id?: string;
  title?: string;
  updated?: string;
  links: ParsedLink[];
}

export interface ParsedFeed {
  id?: string;
  title?: string;
  updated?: string;
  links: ParsedLink[];
  entries: ParsedEntry[];
}

function parseLinks(raw: unknown): ParsedLink[] {
  const links: ParsedLink[] = [];
  for (const item of asArray(raw)) {
    if (!isRecord(item)) continue;
    const rel = item["@_rel"];
    const href = item["@_href"];
    if (typeof href !== "string") continue;
    const type = item["@_type"];
    const title = item["@_title"];
    links.push({
      rel: typeof rel === "string" ? rel : "",
      href,
      type: typeof type === "string" ? type : undefined,
      title: typeof title === "string" ? title : undefined,
    });
  }
  return links;
}

export function parseFeedXml(xml: string): ParsedFeed | null {
  const doc: unknown = parser.parse(xml);
  if (!isRecord(doc)) return null;
  const feed = doc.feed;
  if (!isRecord(feed)) return null;

  const entries: ParsedEntry[] = [];
  for (const raw of asArray(feed.entry)) {
    if (!isRecord(raw)) continue;
    entries.push({
      id: textOf(raw.id),
      title: textOf(raw.title),
      updated: textOf(raw.updated),
      links: parseLinks(raw.link),
    });
  }

  return {
    id: textOf(feed.id),
    title: textOf(feed.title),
    updated: textOf(feed.updated),
    links: parseLinks(feed.link),
    entries,
  };
}

export interface ParsedContentType {
  type: string;
  params: Record<string, string>;
}

/**
 * `application/atom+xml;profile=opds-catalog;kind=navigation; charset=utf-8`
 * - note the profile parameters and the charset the server appends.
 */
export function parseContentType(raw: string | null): ParsedContentType | null {
  if (raw === null) return null;
  const parts = raw.split(";");
  const first = parts[0];
  if (first === undefined) return null;

  const params: Record<string, string> = {};
  for (const part of parts.slice(1)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).trim().replace(/^"|"$/g, "");
    if (key) params[key] = value.toLowerCase();
  }
  return { type: first.trim().toLowerCase(), params };
}

/** RFC 3339, which is what Atom's `updated` element requires. */
export function isRfc3339(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return false;
  }
  return !Number.isNaN(new Date(value).getTime());
}

/**
 * Whether a link is part of the catalogue and must therefore stay on the
 * catalogue's origin.
 *
 * `alternate` links to third-party HTML are the deliberate exception: those are
 * supposed to leave the origin.
 */
export function expectsSameOrigin(link: ParsedLink): boolean {
  if (CATALOG_RELS.has(link.rel)) return true;
  if (link.rel.startsWith(ACQUISITION_REL_PREFIX)) return true;
  const type = (link.type ?? "").toLowerCase();
  if (type.startsWith(ATOM_TYPE)) return true;
  if (type === EPUB_TYPE) return true;
  return false;
}

function isFeedLink(link: ParsedLink): boolean {
  return (link.type ?? "").toLowerCase().startsWith(ATOM_TYPE);
}

function isAcquisitionLink(link: ParsedLink): boolean {
  return (
    link.rel.startsWith(ACQUISITION_REL_PREFIX) &&
    (link.type ?? "").toLowerCase() === EPUB_TYPE
  );
}

/** Entries carrying an acquisition link make the feed an acquisition feed. */
function inferKind(feed: ParsedFeed): string | null {
  if (feed.entries.length === 0) return null;
  const hasAcquisition = feed.entries.some((entry) =>
    entry.links.some((link) => link.rel.startsWith(ACQUISITION_REL_PREFIX)),
  );
  return hasAcquisition ? ACQUISITION_KIND : NAVIGATION_KIND;
}

/* -------------------------------------------------------------------------- */
/* crawl                                                                      */
/* -------------------------------------------------------------------------- */

interface CrawlTask {
  url: string;
  depth: number;
  parent: string | null;
  /** `type` the referring link advertised, for cross-checking. */
  advertised?: string | undefined;
}

interface AcquisitionTarget {
  url: string;
  feed: string;
}

export async function probe(options: ProbeOptions): Promise<ProbeReport> {
  const deep = options.deep ?? false;
  const maxDepth = options.maxDepth ?? (deep ? 6 : 3);
  const epubSamples = options.epubSamples ?? 3;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const followRebased = options.followRebased ?? true;
  const doFetch = options.fetchImpl ?? fetch;

  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const origin = new URL(baseUrl).origin;

  const findings: Finding[] = [];
  const feeds: FeedSummary[] = [];
  const epubs: EpubCheck[] = [];
  const acquisitionTargets: AcquisitionTarget[] = [];

  let entriesSeen = 0;
  let linksChecked = 0;
  let crossOriginLinks = 0;

  const started = Date.now();
  const startedAt = new Date(started).toISOString();

  const add = (finding: Finding): void => {
    findings.push(finding);
  };

  const visited = new Set<string>();
  const queue: CrawlTask[] = [{ url: `${baseUrl}/opds`, depth: 0, parent: null }];

  while (queue.length > 0) {
    const task = queue.shift();
    if (task === undefined) break;
    if (task.depth > maxDepth) continue;

    // Fragments never change what the server returns, so normalise them away
    // before the visited check to avoid re-fetching the same feed.
    const normalised = (() => {
      const u = new URL(task.url);
      u.hash = "";
      return u.toString();
    })();
    if (visited.has(normalised)) continue;
    visited.add(normalised);

    let response: Response;
    try {
      response = await doFetch(normalised, {
        headers: { accept: `${ATOM_TYPE}, */*` },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      add({
        severity: "error",
        category: "http",
        feed: task.parent ?? normalised,
        href: normalised,
        message: `request failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    if (!response.ok) {
      add({
        severity: "error",
        category: "http",
        feed: task.parent ?? normalised,
        href: normalised,
        message: `expected 200, got ${response.status} ${response.statusText}`,
        expected: "200",
        actual: String(response.status),
      });
      continue;
    }

    const rawContentType = response.headers.get("content-type");
    const body = await response.text();

    /* --- well-formedness ------------------------------------------------- */
    const valid = XMLValidator.validate(body);
    if (valid !== true) {
      add({
        severity: "error",
        category: "xml",
        feed: normalised,
        message: `not well-formed XML: ${valid.err.msg} (line ${valid.err.line}, col ${valid.err.col})`,
      });
      continue;
    }

    const feed = parseFeedXml(body);
    if (feed === null) {
      add({
        severity: "error",
        category: "xml",
        feed: normalised,
        message: "document has no <feed> root element",
      });
      continue;
    }

    /* --- content type ---------------------------------------------------- */
    const contentType = parseContentType(rawContentType);
    let declaredKind: string | null = null;

    if (contentType === null) {
      add({
        severity: "error",
        category: "content-type",
        feed: normalised,
        message: "response has no Content-Type header",
      });
    } else {
      declaredKind = contentType.params.kind ?? null;
      if (contentType.type !== ATOM_TYPE) {
        add({
          severity: "error",
          category: "content-type",
          feed: normalised,
          message: `unexpected media type "${contentType.type}"`,
          expected: ATOM_TYPE,
          actual: contentType.type,
        });
      }
      if (contentType.params.profile !== OPDS_PROFILE) {
        add({
          severity: "error",
          category: "content-type",
          feed: normalised,
          message: `Content-Type is missing profile=${OPDS_PROFILE}`,
          expected: `profile=${OPDS_PROFILE}`,
          actual: rawContentType ?? "(none)",
        });
      }
      if (declaredKind !== NAVIGATION_KIND && declaredKind !== ACQUISITION_KIND) {
        add({
          severity: "error",
          category: "content-type",
          feed: normalised,
          message: `Content-Type declares no valid kind parameter`,
          expected: `kind=${NAVIGATION_KIND}|${ACQUISITION_KIND}`,
          actual: rawContentType ?? "(none)",
        });
      }
    }

    const inferred = inferKind(feed);
    if (inferred !== null && declaredKind !== null && inferred !== declaredKind) {
      add({
        severity: "error",
        category: "content-type",
        feed: normalised,
        message: `feed declares kind=${declaredKind} but its entries are ${inferred}`,
        expected: `kind=${inferred}`,
        actual: `kind=${declaredKind}`,
      });
    }

    // A link that advertised one kind but resolves to another makes readers
    // render the wrong UI, so it is worth surfacing even though the feed
    // itself is internally consistent.
    if (task.advertised !== undefined && declaredKind !== null) {
      const advertisedKind = parseContentType(task.advertised)?.params.kind;
      if (advertisedKind !== undefined && advertisedKind !== declaredKind) {
        add({
          severity: "warning",
          category: "content-type",
          feed: task.parent ?? normalised,
          href: normalised,
          message: `link advertised kind=${advertisedKind} but the feed serves kind=${declaredKind}`,
          expected: `kind=${advertisedKind}`,
          actual: `kind=${declaredKind}`,
        });
      }
    }

    /* --- required feed metadata ------------------------------------------ */
    for (const field of ["id", "title", "updated"] as const) {
      if (feed[field] === undefined || feed[field] === "") {
        add({
          severity: "error",
          category: "feed-metadata",
          feed: normalised,
          message: `feed is missing <${field}>`,
        });
      }
    }

    if (feed.updated !== undefined && !isRfc3339(feed.updated)) {
      add({
        severity: "error",
        category: "feed-metadata",
        feed: normalised,
        message: `feed <updated> is not a valid RFC 3339 date`,
        actual: feed.updated,
      });
    }

    const selfLink = feed.links.find((link) => link.rel === "self");
    if (selfLink === undefined) {
      add({
        severity: "error",
        category: "feed-metadata",
        feed: normalised,
        message: 'feed has no <link rel="self">',
      });
    } else {
      try {
        const selfUrl = new URL(selfLink.href, normalised);
        if (selfUrl.pathname !== new URL(normalised).pathname) {
          add({
            severity: "warning",
            category: "feed-metadata",
            feed: normalised,
            href: selfLink.href,
            rel: "self",
            message: "rel=self points at a different path than the feed was fetched from",
            expected: new URL(normalised).pathname,
            actual: selfUrl.pathname,
          });
        }
      } catch {
        /* reported by the link walk below */
      }
    }

    /* --- entries ---------------------------------------------------------- */
    const seenEntryIds = new Set<string>();
    for (const entry of feed.entries) {
      entriesSeen += 1;

      if (entry.id === undefined || entry.id === "") {
        add({
          severity: "error",
          category: "entry",
          feed: normalised,
          message: "entry is missing <id>",
        });
      } else if (seenEntryIds.has(entry.id)) {
        add({
          severity: "error",
          category: "entry",
          feed: normalised,
          message: `duplicate entry <id> within the feed`,
          actual: entry.id,
        });
      } else {
        seenEntryIds.add(entry.id);
      }

      if (entry.title === undefined || entry.title === "") {
        add({
          severity: "error",
          category: "entry",
          feed: normalised,
          message: `entry ${entry.id ?? "(no id)"} is missing <title>`,
        });
      }

      if (entry.updated === undefined || entry.updated === "") {
        add({
          severity: "error",
          category: "entry",
          feed: normalised,
          message: `entry ${entry.id ?? "(no id)"} is missing <updated>`,
        });
      } else if (!isRfc3339(entry.updated)) {
        add({
          severity: "error",
          category: "entry",
          feed: normalised,
          message: `entry ${entry.id ?? "(no id)"} has a non-RFC 3339 <updated>`,
          actual: entry.updated,
        });
      }

      if (inferred === ACQUISITION_KIND) {
        const openAccess = entry.links.find(
          (link) =>
            link.rel === `${ACQUISITION_REL_PREFIX}/open-access` &&
            (link.type ?? "").toLowerCase() === EPUB_TYPE,
        );
        if (openAccess === undefined) {
          add({
            severity: "error",
            category: "entry",
            feed: normalised,
            message: `entry ${entry.id ?? "(no id)"} has no open-access ${EPUB_TYPE} acquisition link`,
            expected: `rel="${ACQUISITION_REL_PREFIX}/open-access" type="${EPUB_TYPE}"`,
          });
        }
      }
    }

    /* --- link walk -------------------------------------------------------- */
    const allLinks: ParsedLink[] = [
      ...feed.links,
      ...feed.entries.flatMap((entry) => entry.links),
    ];

    for (const link of allLinks) {
      linksChecked += 1;

      let resolved: URL;
      try {
        resolved = new URL(link.href, normalised);
      } catch {
        add({
          severity: "error",
          category: "link",
          feed: normalised,
          href: link.href,
          rel: link.rel,
          message: "href is not a resolvable URL",
        });
        continue;
      }

      if (link.rel === "") {
        add({
          severity: "warning",
          category: "link",
          feed: normalised,
          href: link.href,
          message: "link has no rel attribute",
        });
      }

      if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
        add({
          severity: "warning",
          category: "link",
          feed: normalised,
          href: link.href,
          rel: link.rel,
          message: `non-HTTP href scheme "${resolved.protocol}"`,
        });
        continue;
      }

      const sameOrigin = resolved.origin === origin;
      const mustBeSameOrigin = expectsSameOrigin(link);

      /* ---- the headline check ---- */
      if (mustBeSameOrigin && !sameOrigin) {
        crossOriginLinks += 1;
        add({
          severity: "error",
          category: "cross-origin",
          feed: normalised,
          href: link.href,
          rel: link.rel,
          message: `catalogue link points at a different origin than the catalogue is served from; an e-reader on another network cannot resolve it`,
          expected: origin,
          actual: resolved.origin,
        });
      }

      // Foreign origins are never fetched. Rebasing keeps the crawl going so a
      // single bad base URL does not hide every other defect behind it.
      const target = (() => {
        if (sameOrigin) return resolved;
        if (!mustBeSameOrigin || !followRebased) return null;
        return new URL(resolved.pathname + resolved.search, origin);
      })();
      if (target === null) continue;

      if (isAcquisitionLink(link)) {
        acquisitionTargets.push({ url: target.toString(), feed: normalised });
        continue;
      }

      if (isFeedLink(link) && task.depth < maxDepth) {
        queue.push({
          url: target.toString(),
          depth: task.depth + 1,
          parent: normalised,
          advertised: link.type,
        });
      }
    }

    feeds.push({
      url: normalised,
      status: response.status,
      contentType: rawContentType,
      declaredKind,
      inferredKind: inferred,
      entries: feed.entries.length,
      links: allLinks.length,
      depth: task.depth,
      parent: task.parent,
    });
  }

  /* --- EPUB sampling ----------------------------------------------------- */
  if (deep && acquisitionTargets.length > 0) {
    for (const url of sampleAcross(acquisitionTargets, epubSamples)) {
      const check = await checkEpub(url, doFetch, timeoutMs);
      epubs.push(check);
      const parent =
        acquisitionTargets.find((t) => t.url === url)?.feed ?? baseUrl;

      if (check.status !== 200) {
        add({
          severity: "error",
          category: "epub",
          feed: parent,
          href: url,
          message: `expected 200, got ${check.status}`,
        });
        continue;
      }
      if (!check.magicOk) {
        add({
          severity: "error",
          category: "epub",
          feed: parent,
          href: url,
          message: "response body does not start with the PK\\x03\\x04 zip magic bytes",
        });
      }
      if ((check.contentType ?? "").toLowerCase() !== EPUB_TYPE) {
        add({
          severity: "error",
          category: "epub",
          feed: parent,
          href: url,
          message: `unexpected Content-Type`,
          expected: EPUB_TYPE,
          actual: check.contentType ?? "(none)",
        });
      }
      if (check.etag === null) {
        add({
          severity: "error",
          category: "epub",
          feed: parent,
          href: url,
          message: "no ETag header, so readers cannot revalidate and will re-download every time",
        });
      } else if (check.notModifiedOk === false) {
        add({
          severity: "error",
          category: "epub",
          feed: parent,
          href: url,
          message: "conditional request with If-None-Match did not return 304",
        });
      }
    }
  }

  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.length - errors;

  const findingsByCategory: Record<string, number> = {};
  for (const finding of findings) {
    const key = `${finding.severity}:${finding.category}`;
    findingsByCategory[key] = (findingsByCategory[key] ?? 0) + 1;
  }

  return {
    ok: errors === 0,
    baseUrl,
    origin,
    startedAt,
    durationMs: Date.now() - started,
    options: { maxDepth, deep, epubSamples },
    stats: {
      feedsCrawled: feeds.length,
      entriesSeen,
      linksChecked,
      crossOriginLinks,
      epubsChecked: epubs.length,
      errors,
      warnings,
    },
    findingsByCategory,
    feeds,
    epubs,
    findings,
  };
}

/**
 * Take `count` URLs spread across as many distinct feeds as possible, so a
 * sample of three does not come entirely from the first acquisition feed.
 */
function sampleAcross(targets: AcquisitionTarget[], count: number): string[] {
  const byFeed = new Map<string, string[]>();
  for (const target of targets) {
    const bucket = byFeed.get(target.feed);
    if (bucket === undefined) byFeed.set(target.feed, [target.url]);
    else bucket.push(target.url);
  }

  const picked: string[] = [];
  const seen = new Set<string>();
  let round = 0;
  let progressed = true;

  while (picked.length < count && progressed) {
    progressed = false;
    for (const bucket of byFeed.values()) {
      if (picked.length >= count) break;
      const url = bucket[round];
      if (url === undefined || seen.has(url)) continue;
      seen.add(url);
      picked.push(url);
      progressed = true;
    }
    round += 1;
  }
  return picked;
}

/**
 * Fetch just enough of an EPUB to prove it is real, then revalidate it.
 *
 * Only the first chunk is read - the magic bytes are in the first four - so a
 * deep run does not pull megabytes per book.
 */
async function checkEpub(
  url: string,
  doFetch: typeof fetch,
  timeoutMs: number,
): Promise<EpubCheck> {
  const base: EpubCheck = {
    url,
    status: 0,
    contentType: null,
    etag: null,
    bytes: null,
    magicOk: false,
    notModifiedOk: null,
    ok: false,
  };

  let response: Response;
  try {
    response = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return base;
  }

  base.status = response.status;
  base.contentType = response.headers.get("content-type");
  base.etag = response.headers.get("etag");
  const length = response.headers.get("content-length");
  base.bytes = length === null ? null : Number(length);

  if (response.body === null) {
    await response.arrayBuffer().catch(() => undefined);
    return base;
  }

  const reader = response.body.getReader();
  try {
    const { value } = await reader.read();
    if (value !== undefined && value.length >= 4) {
      base.magicOk =
        value[0] === 0x50 && value[1] === 0x4b && value[2] === 0x03 && value[3] === 0x04;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  if (base.etag !== null) {
    try {
      const conditional = await doFetch(url, {
        headers: { "if-none-match": base.etag },
        signal: AbortSignal.timeout(timeoutMs),
      });
      base.notModifiedOk = conditional.status === 304;
      await conditional.arrayBuffer().catch(() => undefined);
    } catch {
      base.notModifiedOk = false;
    }
  }

  base.ok =
    base.status === 200 &&
    base.magicOk &&
    (base.contentType ?? "").toLowerCase() === EPUB_TYPE &&
    base.etag !== null &&
    base.notModifiedOk !== false;

  return base;
}

/* -------------------------------------------------------------------------- */
/* reporting                                                                  */
/* -------------------------------------------------------------------------- */

const CATEGORY_LABEL: Record<FindingCategory, string> = {
  "cross-origin": "Cross-origin links (unreachable from another device)",
  http: "HTTP",
  xml: "XML well-formedness",
  "content-type": "Content-Type / OPDS profile",
  "feed-metadata": "Required feed metadata",
  entry: "Entries",
  link: "Links",
  epub: "EPUB acquisition",
};

/** Order matters: the most damaging class of defect is printed first. */
const CATEGORY_ORDER: FindingCategory[] = [
  "cross-origin",
  "http",
  "xml",
  "content-type",
  "feed-metadata",
  "entry",
  "epub",
  "link",
];

interface FormatOptions {
  color?: boolean;
  /** Findings shown per feed before collapsing into a count. */
  maxPerGroup?: number;
}

export function formatReport(report: ProbeReport, options: FormatOptions = {}): string {
  const color = options.color ?? false;
  const maxPerGroup = options.maxPerGroup ?? 5;

  const paint = (code: string, text: string): string =>
    color ? `\u001b[${code}m${text}\u001b[0m` : text;
  const red = (t: string): string => paint("31", t);
  const yellow = (t: string): string => paint("33", t);
  const green = (t: string): string => paint("32", t);
  const bold = (t: string): string => paint("1", t);
  const dim = (t: string): string => paint("2", t);

  const out: string[] = [];
  out.push("");
  out.push(bold(`OPDS probe  ${report.baseUrl}`));
  out.push(
    dim(
      `  depth<=${report.options.maxDepth}  deep=${report.options.deep}  ${report.durationMs}ms`,
    ),
  );
  out.push("");

  out.push(bold("Crawled"));
  for (const feed of report.feeds) {
    const kind = feed.declaredKind ?? "?";
    const path = new URL(feed.url).pathname;
    out.push(
      `  ${"  ".repeat(feed.depth)}${path}  ${dim(`[${kind}] ${feed.entries} entries, ${feed.links} links`)}`,
    );
  }
  out.push("");

  if (report.epubs.length > 0) {
    out.push(bold("EPUB samples"));
    for (const epub of report.epubs) {
      const mark = epub.ok ? green("ok") : red("FAIL");
      const bits = [
        `${epub.status}`,
        epub.magicOk ? "PK magic" : red("bad magic"),
        epub.etag !== null ? "etag" : red("no etag"),
        epub.notModifiedOk === true
          ? "304 revalidate"
          : epub.notModifiedOk === false
            ? red("no 304")
            : dim("no revalidate"),
        epub.bytes !== null ? `${epub.bytes}B` : "",
      ].filter(Boolean);
      out.push(`  ${mark}  ${new URL(epub.url).pathname}  ${dim(bits.join(", "))}`);
    }
    out.push("");
  }

  const errors = report.findings.filter((f) => f.severity === "error");
  const warnings = report.findings.filter((f) => f.severity === "warning");

  const renderGroup = (title: string, findings: Finding[], tint: (t: string) => string): void => {
    if (findings.length === 0) return;
    out.push(bold(title));

    for (const category of CATEGORY_ORDER) {
      const inCategory = findings.filter((f) => f.category === category);
      if (inCategory.length === 0) continue;

      out.push(`  ${tint(CATEGORY_LABEL[category])} ${dim(`(${inCategory.length})`)}`);

      // Group by the feed the problem was seen in, because "which feed" is the
      // first question anyone debugging this asks.
      const byFeed = new Map<string, Finding[]>();
      for (const finding of inCategory) {
        const bucket = byFeed.get(finding.feed);
        if (bucket === undefined) byFeed.set(finding.feed, [finding]);
        else bucket.push(finding);
      }

      for (const [feed, group] of byFeed) {
        out.push(`    in ${feed}`);
        for (const finding of group.slice(0, maxPerGroup)) {
          out.push(`      - ${finding.message}`);
          if (finding.href !== undefined) {
            const rel = finding.rel !== undefined ? ` rel="${finding.rel}"` : "";
            out.push(dim(`          href:${rel} ${finding.href}`));
          }
          if (finding.expected !== undefined || finding.actual !== undefined) {
            out.push(
              dim(
                `          expected: ${finding.expected ?? "-"}   actual: ${finding.actual ?? "-"}`,
              ),
            );
          }
        }
        if (group.length > maxPerGroup) {
          out.push(dim(`      ... and ${group.length - maxPerGroup} more in this feed`));
        }
      }
    }
    out.push("");
  };

  renderGroup(`Errors (${errors.length})`, errors, red);
  renderGroup(`Warnings (${warnings.length})`, warnings, yellow);

  const s = report.stats;
  out.push(bold("Summary"));
  out.push(
    `  ${s.feedsCrawled} feeds, ${s.entriesSeen} entries, ${s.linksChecked} links checked, ${s.epubsChecked} EPUBs sampled`,
  );
  if (s.crossOriginLinks > 0) {
    out.push(
      red(
        `  ${s.crossOriginLinks} cross-origin catalogue links - readers on another host will fail to follow these`,
      ),
    );
  }
  out.push(
    report.ok
      ? green(`  PASS - no errors (${s.warnings} warnings)`)
      : red(`  FAIL - ${s.errors} errors, ${s.warnings} warnings`),
  );
  out.push("");

  return out.join("\n");
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

const USAGE = `
Usage: bun run scripts/opds-probe.ts [baseUrl] [options]

  baseUrl              Catalogue origin to crawl (default http://localhost:3000)

Options:
  --deep               Raise the crawl depth and sample EPUB downloads
  --json               Emit a machine-readable report instead of a summary
  --depth=N            Maximum crawl depth (default 3, or 6 with --deep)
  --samples=N          EPUBs to download with --deep (default 3)
  --timeout=MS         Per-request timeout (default 30000)
  --no-rebase          Do not continue crawling cross-origin links
  -h, --help           Show this message

Exit code is 0 when no errors were found, 1 otherwise.
`;

function parseArgs(argv: string[]): { options: ProbeOptions; json: boolean } | null {
  let baseUrl = "http://localhost:3000";
  let deep = false;
  let json = false;
  let maxDepth: number | undefined;
  let epubSamples: number | undefined;
  let timeoutMs: number | undefined;
  let followRebased = true;

  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") return null;
    else if (arg === "--deep") deep = true;
    else if (arg === "--json") json = true;
    else if (arg === "--no-rebase") followRebased = false;
    else if (arg.startsWith("--depth=")) maxDepth = Number(arg.slice(8));
    else if (arg.startsWith("--samples=")) epubSamples = Number(arg.slice(10));
    else if (arg.startsWith("--timeout=")) timeoutMs = Number(arg.slice(10));
    else if (!arg.startsWith("-")) baseUrl = arg;
  }

  if (!/^https?:\/\//.test(baseUrl)) baseUrl = `http://${baseUrl}`;

  return {
    json,
    options: { baseUrl, deep, maxDepth, epubSamples, timeoutMs, followRebased },
  };
}

if (import.meta.main) {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === null) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const report = await probe(parsed.options);

  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(formatReport(report, { color: process.stdout.isTTY === true }));
  }

  process.exit(report.ok ? 0 : 1);
}
