/**
 * EPUB 3 packaging.
 *
 * Hand-rolled rather than delegating to epub-gen so we control the manifest
 * (calibre series metadata, custom `hn:*` fields), emit a per-root-thread
 * navigation tree, and keep byte output deterministic enough to hash.
 *
 * An NCX is emitted alongside the EPUB 3 nav document because Kobo's native
 * reader and several older KOReader builds still fall back to it.
 */
import JSZip from "jszip";
import { xmlEscape } from "~/epub/xhtml";

export interface EpubResource {
  /** Manifest id. Must be unique and a valid XML NCName. */
  id: string;
  /** Path relative to the OEBPS directory. */
  href: string;
  mediaType: string;
  data: string | Uint8Array;
  /** Include in the reading order. */
  spine?: boolean;
  /** Manifest properties, e.g. `cover-image` or `nav`. */
  properties?: string;
}

export interface EpubTocEntry {
  href: string;
  title: string;
  children?: EpubTocEntry[];
}

export interface EpubMetadata {
  /** Stable unique id, e.g. `urn:hn:story:44921137`. */
  identifier: string;
  title: string;
  language: string;
  creator?: string;
  publisher?: string;
  /** Original article URL. */
  source?: string;
  /** ISO 8601 publication date. */
  date?: string;
  description?: string;
  series?: string;
  seriesIndex?: string;
  /** Extra legacy-form meta pairs, e.g. `{ "hn:score": "412" }`. */
  custom?: Record<string, string | number | null | undefined>;
}

export interface EpubInput {
  metadata: EpubMetadata;
  resources: EpubResource[];
  toc: EpubTocEntry[];
  /** Manifest id of the cover image, if any. */
  coverId?: string;
}

const OEBPS = "OEBPS";
const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="${OEBPS}/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;

/** EPUB requires UTC with a literal `Z` and no milliseconds. */
function utcStamp(date = new Date()): string {
  return `${date.toISOString().replace(/\.\d{3}Z$/, "")}Z`;
}

function metaTag(name: string, content: string | number | null | undefined) {
  if (content === null || content === undefined || content === "") return "";
  return `    <meta name="${xmlEscape(name)}" content="${xmlEscape(String(content))}"/>\n`;
}

function dcTag(tag: string, value: string | undefined, attrs = "") {
  if (!value) return "";
  return `    <dc:${tag}${attrs}>${xmlEscape(value)}</dc:${tag}>\n`;
}

function buildOpf(input: EpubInput, modified: string): string {
  const m = input.metadata;

  const manifest = input.resources
    .map(
      (r) =>
        `    <item id="${xmlEscape(r.id)}" href="${xmlEscape(r.href)}" media-type="${xmlEscape(r.mediaType)}"` +
        (r.properties ? ` properties="${xmlEscape(r.properties)}"` : "") +
        `/>`,
    )
    .join("\n");

  const spine = input.resources
    .filter((r) => r.spine)
    .map((r) => `    <itemref idref="${xmlEscape(r.id)}"/>`)
    .join("\n");

  let meta = "";
  meta += dcTag("title", m.title);
  meta += dcTag("language", m.language);
  meta += `    <dc:identifier id="pub-id">${xmlEscape(m.identifier)}</dc:identifier>\n`;
  meta += dcTag("creator", m.creator);
  meta += dcTag("publisher", m.publisher);
  meta += dcTag("source", m.source);
  meta += dcTag("date", m.date);
  meta += dcTag("description", m.description);
  meta += `    <meta property="dcterms:modified">${modified}</meta>\n`;
  meta += metaTag("calibre:series", m.series);
  meta += metaTag("calibre:series_index", m.seriesIndex);
  if (input.coverId) meta += metaTag("cover", input.coverId);
  for (const [k, v] of Object.entries(m.custom ?? {})) meta += metaTag(k, v);

  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="${xmlEscape(m.language)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
${meta}  </metadata>
  <manifest>
${manifest}
  </manifest>
  <spine toc="ncx">
${spine}
  </spine>
</package>
`;
}

function navList(entries: EpubTocEntry[], indent: string): string {
  const items = entries
    .map((e) => {
      const nested = e.children?.length
        ? `\n${navList(e.children, `${indent}    `)}\n${indent}  `
        : "";
      return `${indent}  <li><a href="${xmlEscape(e.href)}">${xmlEscape(e.title)}</a>${nested}</li>`;
    })
    .join("\n");
  return `${indent}<ol>\n${items}\n${indent}</ol>`;
}

function buildNav(input: EpubInput): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${xmlEscape(input.metadata.language)}" xml:lang="${xmlEscape(input.metadata.language)}">
  <head>
    <meta charset="utf-8"/>
    <title>Contents</title>
  </head>
  <body>
    <nav epub:type="toc" id="toc">
      <h1>Contents</h1>
${navList(input.toc, "      ")}
    </nav>
  </body>
</html>
`;
}

function ncxPoints(
  entries: EpubTocEntry[],
  indent: string,
  counter: { n: number },
): string {
  return entries
    .map((e) => {
      const id = `navpoint-${++counter.n}`;
      const order = counter.n;
      const nested = e.children?.length
        ? `\n${ncxPoints(e.children, `${indent}  `, counter)}`
        : "";
      return (
        `${indent}<navPoint id="${id}" playOrder="${order}">\n` +
        `${indent}  <navLabel><text>${xmlEscape(e.title)}</text></navLabel>\n` +
        `${indent}  <content src="${xmlEscape(e.href)}"/>${nested}\n` +
        `${indent}</navPoint>`
      );
    })
    .join("\n");
}

function buildNcx(input: EpubInput): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${xmlEscape(input.metadata.identifier)}"/>
    <meta name="dtb:depth" content="2"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${xmlEscape(input.metadata.title)}</text></docTitle>
  <navMap>
${ncxPoints(input.toc, "    ", { n: 0 })}
  </navMap>
</ncx>
`;
}

/**
 * Assembles the archive. `mimetype` is written first and stored uncompressed,
 * as required by the OCF specification.
 */
export async function buildEpub(
  input: EpubInput,
  now = new Date(),
): Promise<Uint8Array> {
  const zip = new JSZip();
  const modified = utcStamp(now);
  // JSZip stamps entries with the local clock unless told otherwise; pinning it
  // keeps output bytes stable for identical input.
  //
  // `createFolders: false` matters just as much. JSZip otherwise synthesises
  // implicit directory entries (`META-INF/`, `OEBPS/`) for nested paths and
  // stamps *those* with `new Date()`, ignoring the pinned date. Their DOS
  // timestamps have two-second resolution, which made rebuilds differ in
  // exactly four bytes about half the time. OCF does not require directory
  // entries, so the cleanest fix is to not emit them at all.
  const opts = { date: now, createFolders: false } as const;

  zip.file("mimetype", "application/epub+zip", {
    ...opts,
    compression: "STORE",
  });
  zip.file("META-INF/container.xml", CONTAINER_XML, opts);

  const resources: EpubResource[] = [
    // EPUB 3 identifies the cover via `properties="cover-image"` on the manifest
    // item; the caller only has to name the id. The legacy `<meta name="cover">`
    // is emitted separately for EPUB 2 readers.
    ...input.resources.map((r) =>
      r.id === input.coverId && !r.properties ? { ...r, properties: "cover-image" } : r,
    ),
    {
      id: "nav",
      href: "nav.xhtml",
      mediaType: "application/xhtml+xml",
      properties: "nav",
      data: "",
    },
    {
      id: "ncx",
      href: "toc.ncx",
      mediaType: "application/x-dtbncx+xml",
      data: "",
    },
  ];

  const withNav: EpubInput = { ...input, resources };

  for (const r of input.resources) {
    zip.file(`${OEBPS}/${r.href}`, r.data, opts);
  }
  zip.file(`${OEBPS}/nav.xhtml`, buildNav(input), opts);
  zip.file(`${OEBPS}/toc.ncx`, buildNcx(input), opts);
  zip.file(`${OEBPS}/content.opf`, buildOpf(withNav, modified), opts);

  return zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
}
