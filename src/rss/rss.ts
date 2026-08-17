/**
 * RSS 2.0 serialisation.
 *
 * The same argument as `~/opds/atom`, and reached the same way. RSS 2.0 is a
 * fixed vocabulary of about fifteen elements; the parts that decide whether a
 * reader behaves are the ones a generic library abstracts away - `guid
 * isPermaLink="false"`, the `atom:link rel="self"`, an `enclosure` that is
 * omitted rather than faked when there is no file, and dates in the edition
 * timezone rather than whatever the library picked.
 *
 * The `feed` package was in package.json for this and has been removed, for a
 * reason worth recording rather than restating as taste. It builds RSS through
 * xml-js and wraps every title, description and body in CDATA, and xml-js
 * escapes the terminator with `cdata.replace("]]>", ...)` - a string pattern,
 * so only the *first* occurrence is escaped. A body containing two of them
 * closes its own CDATA section early and the document stops being well-formed.
 * That is not a hypothetical for this feed: the bodies are full articles pulled
 * from arbitrary websites and the titles come from Hacker News. `feed` also
 * emits every date via `toUTCString()` and defaults `lastBuildDate` to the wall
 * clock, both of which this module needs to control. See the `]]>` case in
 * tests/rss.test.ts.
 *
 * So: no CDATA anywhere here. Everything goes through `xmlText`, which escapes
 * with `xmlEscape` from the EPUB layer - the same function the Atom serialiser
 * uses. `content:encoded` carries entity-escaped markup, which is exactly what
 * the module's spec describes and what every reader unescapes.
 */
import { DateTime } from "luxon";
import { config } from "~/config";
import { xmlEscape } from "~/epub/xhtml";

export const RSS_TYPE = "application/rss+xml";

/**
 * Namespaces. `content` carries the full article body, `dc` carries the
 * author (RSS's own `<author>` is specified as an email address, and a
 * validator will say so), `atom` carries the self link.
 */
const NS = [
  'xmlns:content="http://purl.org/rss/1.0/modules/content/"',
  'xmlns:dc="http://purl.org/dc/elements/1.1/"',
  'xmlns:atom="http://www.w3.org/2005/Atom"',
];

export interface RssEnclosure {
  url: string;
  /** Bytes. Required by RSS, and must be true - see `readyStoryEpubBytes`. */
  length: number;
  type: string;
}

export interface RssItem {
  title: string;
  /** Absolute. Where the item lives on this site. */
  link: string;
  /** Stable and permanent; emitted with `isPermaLink="false"`. */
  guid: string;
  /** RFC 822, from `rfc822`. */
  pubDate: string;
  /** Plain text summary. */
  description?: string;
  /** Full article markup for `content:encoded`. */
  content?: string;
  /** `dc:creator`. */
  creator?: string;
  categories?: string[];
  /** URL of the discussion thread. RSS has a dedicated element for this. */
  comments?: string;
  enclosure?: RssEnclosure;
}

export interface RssChannel {
  title: string;
  /** Absolute URL of the HTML page this feed syndicates. */
  link: string;
  description: string;
  /** Absolute URL of the feed itself, for `atom:link rel="self"`. */
  selfUrl: string;
  /**
   * Unix seconds, from the newest item and never from the wall clock.
   *
   * Held as an instant rather than a formatted string because it is needed in
   * two different formats - RFC 822 in the body, IMF-fixdate in the
   * `Last-Modified` header - and formatting it twice from one number is the
   * only way those cannot disagree.
   */
  lastBuild: number;
  language?: string;
  items: RssItem[];
}

/*
 * Characters XML 1.0 forbids outright.
 *
 * There is no escape sequence for these - `&#12;` is as illegal as the raw
 * byte - so stripping is the only repair available. It matters here in a way it
 * does not for the OPDS catalogue: that feed carries titles and one-line
 * summaries, while this one carries whole article bodies extracted from
 * arbitrary web pages, and a single stray form feed inside a <pre> block would
 * take the entire feed from "one odd item" to "does not parse".
 */
const ILLEGAL_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

/**
 * Text destined for XML: illegal characters removed, metacharacters escaped.
 *
 * Escaping itself is `xmlEscape` from the EPUB layer rather than a second
 * implementation of the same five replacements.
 */
export function xmlText(value: string): string {
  return xmlEscape(value.replace(ILLEGAL_XML, ""));
}

/**
 * RFC 822 date, as RSS requires, rendered in the edition timezone.
 *
 * The input is a unix timestamp, which is an absolute instant - the timezone
 * only decides how it is labelled. Labelling it in the edition zone is what
 * makes a feed reader agree with the rest of the site about which day a story
 * belongs to, right up to the boundary: a story submitted at 00:30 Amsterdam
 * time belongs to that edition and should not read as 22:30 the previous day.
 *
 * luxon's `toRFC2822` is used rather than a format string because it pins the
 * locale to en-US internally. RFC 822 day and month names are not translatable,
 * so a format string would be one `LANG` away from emitting "dim." for Sunday
 * and being rejected.
 */
export function rfc822(input: Date | number, tz = config().editionTz): string {
  const dt =
    typeof input === "number"
      ? DateTime.fromSeconds(input, { zone: tz })
      : DateTime.fromJSDate(input, { zone: tz });
  // An invalid zone yields an invalid DateTime and a null string; falling back
  // to UTC keeps a misconfigured EDITION_TZ from emptying every date in the
  // feed.
  return dt.toRFC2822() ?? DateTime.fromJSDate(new Date(0)).toUTC().toRFC2822()!;
}

function itemTag(item: RssItem): string {
  const lines = [
    "    <item>",
    `      <title>${xmlText(item.title)}</title>`,
    `      <link>${xmlText(item.link)}</link>`,
    // isPermaLink="false" is not optional here. Left at its default of true, a
    // reader is entitled to treat the guid as a URL and fetch it, and ours is a
    // urn. It is the same identifier the OPDS entry and the EPUB's
    // dc:identifier use, so the three surfaces name a story identically.
    `      <guid isPermaLink="false">${xmlText(item.guid)}</guid>`,
    `      <pubDate>${xmlText(item.pubDate)}</pubDate>`,
  ];

  if (item.creator) {
    lines.push(`      <dc:creator>${xmlText(item.creator)}</dc:creator>`);
  }

  for (const category of item.categories ?? []) {
    lines.push(`      <category>${xmlText(category)}</category>`);
  }

  if (item.comments) {
    lines.push(`      <comments>${xmlText(item.comments)}</comments>`);
  }

  if (item.enclosure) {
    lines.push(
      `      <enclosure url="${xmlText(item.enclosure.url)}"` +
        ` length="${item.enclosure.length}"` +
        ` type="${xmlText(item.enclosure.type)}"/>`,
    );
  }

  if (item.description) {
    lines.push(`      <description>${xmlText(item.description)}</description>`);
  }

  if (item.content) {
    lines.push(
      `      <content:encoded>${xmlText(item.content)}</content:encoded>`,
    );
  }

  lines.push("    </item>");
  return lines.join("\n");
}

/** Serialise a channel as an RSS 2.0 document. */
export function renderRss(channel: RssChannel): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<rss version="2.0" ${NS.join("\n     ")}>`,
    "  <channel>",
    `    <title>${xmlText(channel.title)}</title>`,
    `    <link>${xmlText(channel.link)}</link>`,
    `    <description>${xmlText(channel.description)}</description>`,
    `    <language>${xmlText(channel.language ?? "en")}</language>`,
    `    <lastBuildDate>${xmlText(rfc822(channel.lastBuild))}</lastBuildDate>`,
    // Required by the RSS Board's validator for any feed served over HTTP, and
    // the only thing that tells a reader which URL to poll after the feed has
    // been passed around as a file.
    `    <atom:link rel="self" type="${RSS_TYPE}" href="${xmlText(channel.selfUrl)}"/>`,
    "    <generator>hacker-opds</generator>",
  ];

  for (const item of channel.items) lines.push(itemTag(item));

  lines.push("  </channel>", "</rss>", "");
  return lines.join("\n");
}
