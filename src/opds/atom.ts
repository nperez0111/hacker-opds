/**
 * OPDS 1.2 Atom serialisation.
 *
 * OPDS 1.2 is plain Atom (RFC 4287) with a profile parameter on the content
 * type and a small vocabulary of link relations. There is no library for this
 * worth taking on: the whole format is a few hundred bytes of XML and the
 * details that matter (exact `type` parameters, `rel` URIs, self/start links)
 * are precisely the things a generic Atom library gets wrong.
 *
 * Everything is escaped through `xmlEscape` from the EPUB layer so the output
 * is guaranteed well-formed XML.
 */
import { xmlEscape } from "~/epub/xhtml";

/** Content type for a feed whose entries are other feeds. */
export const NAVIGATION_TYPE =
  "application/atom+xml;profile=opds-catalog;kind=navigation";

/** Content type for a feed whose entries are downloadable publications. */
export const ACQUISITION_TYPE =
  "application/atom+xml;profile=opds-catalog;kind=acquisition";

export const EPUB_TYPE = "application/epub+zip";

/**
 * Content type of an OpenSearch description document.
 *
 * OPDS 1.2 does not define a search mechanism of its own; it points at
 * OpenSearch 1.1, and this is the type a reader looks for on the `rel="search"`
 * link before it will offer a search box for the catalogue.
 */
export const OPENSEARCH_TYPE = "application/opensearchdescription+xml";

/** OPDS link relations used by this catalog. */
export const REL = {
  self: "self",
  start: "start",
  up: "up",
  next: "next",
  prev: "previous",
  search: "search",
  /** Free download. OPDS distinguishes this from borrow/buy relations. */
  acquisition: "http://opds-spec.org/acquisition/open-access",
  image: "http://opds-spec.org/image",
  thumbnail: "http://opds-spec.org/image/thumbnail",
  alternate: "alternate",
} as const;

export interface AtomLink {
  rel: string;
  href: string;
  type?: string;
  title?: string;
}

export interface AtomEntry {
  /** Stable, globally unique. Use a `urn:` so it never collides with a URL. */
  id: string;
  title: string;
  /** RFC 3339. */
  updated: string;
  links: AtomLink[];
  authors?: string[];
  /** Plain text; escaped on output. */
  summary?: string;
  /** RFC 3339, when the underlying thing was first published. */
  published?: string;
  categories?: string[];
}

/**
 * OpenSearch's paging elements, which a search result feed carries and no other
 * feed does.
 *
 * Without them a reader has no way to tell "these are the 25 results" from
 * "these are the first 25 of 300": Atom has no notion of a result count, and
 * `rel="next"` alone says there is more without saying how much. `startIndex`
 * is 1-based, which is the OpenSearch default and what the `indexOffset`
 * attribute in the description document declares.
 */
export interface OpenSearchPage {
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
}

export interface AtomFeed {
  id: string;
  title: string;
  updated: string;
  links: AtomLink[];
  entries: AtomEntry[];
  subtitle?: string;
  author?: { name: string; uri?: string };
  opensearch?: OpenSearchPage;
}

function linkTag(link: AtomLink): string {
  const parts = [`rel="${xmlEscape(link.rel)}"`, `href="${xmlEscape(link.href)}"`];
  if (link.type) parts.push(`type="${xmlEscape(link.type)}"`);
  if (link.title) parts.push(`title="${xmlEscape(link.title)}"`);
  return `  <link ${parts.join(" ")}/>`;
}

function entryTag(entry: AtomEntry): string {
  const lines = [
    "  <entry>",
    `    <id>${xmlEscape(entry.id)}</id>`,
    `    <title>${xmlEscape(entry.title)}</title>`,
    `    <updated>${xmlEscape(entry.updated)}</updated>`,
  ];

  if (entry.published) {
    lines.push(`    <published>${xmlEscape(entry.published)}</published>`);
  }

  for (const name of entry.authors ?? []) {
    lines.push("    <author>", `      <name>${xmlEscape(name)}</name>`, "    </author>");
  }

  for (const term of entry.categories ?? []) {
    lines.push(`    <category term="${xmlEscape(term)}"/>`);
  }

  for (const link of entry.links) {
    lines.push(`  ${linkTag(link)}`);
  }

  // `type="text"` keeps readers from trying to parse the body as markup. The
  // summary is plain text by construction, so this avoids double-escaping
  // problems on readers that are lax about the distinction.
  if (entry.summary) {
    lines.push(`    <summary type="text">${xmlEscape(entry.summary)}</summary>`);
  }

  lines.push("  </entry>");
  return lines.join("\n");
}

/** Serialise a feed. Callers pick the content type to send it under. */
export function renderFeed(feed: AtomFeed): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom"',
    '      xmlns:dc="http://purl.org/dc/terms/"',
    // Declared on every feed rather than only on the one that uses it. A
    // namespace declaration costs 60 bytes and is inert where nothing is in it,
    // whereas a feed that emits a prefixed element without the declaration is
    // not well-formed XML - which is a failure mode worth making impossible
    // rather than conditional.
    '      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"',
    '      xmlns:opds="http://opds-spec.org/2010/catalog">',
    `  <id>${xmlEscape(feed.id)}</id>`,
    `  <title>${xmlEscape(feed.title)}</title>`,
    `  <updated>${xmlEscape(feed.updated)}</updated>`,
  ];

  if (feed.subtitle) lines.push(`  <subtitle>${xmlEscape(feed.subtitle)}</subtitle>`);

  if (feed.opensearch) {
    const page = feed.opensearch;
    lines.push(
      `  <opensearch:totalResults>${Math.max(0, Math.trunc(page.totalResults))}</opensearch:totalResults>`,
      `  <opensearch:startIndex>${Math.max(1, Math.trunc(page.startIndex))}</opensearch:startIndex>`,
      `  <opensearch:itemsPerPage>${Math.max(1, Math.trunc(page.itemsPerPage))}</opensearch:itemsPerPage>`,
    );
  }

  if (feed.author) {
    lines.push("  <author>", `    <name>${xmlEscape(feed.author.name)}</name>`);
    if (feed.author.uri) lines.push(`    <uri>${xmlEscape(feed.author.uri)}</uri>`);
    lines.push("  </author>");
  }

  for (const link of feed.links) lines.push(linkTag(link));
  for (const entry of feed.entries) lines.push(entryTag(entry));

  lines.push("</feed>", "");
  return lines.join("\n");
}

/** RFC 3339 with second precision. Atom rejects the millisecond form on some readers. */
export function rfc3339(input: Date | number): string {
  const date = typeof input === "number" ? new Date(input * 1000) : input;
  return `${date.toISOString().replace(/\.\d{3}Z$/, "")}Z`;
}
