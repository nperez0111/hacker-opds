import { describe, expect, test } from "bun:test";
import JSZip from "jszip";
import { XMLValidator } from "fast-xml-parser";

import { buildEpub, type EpubInput } from "~/epub/package";
import { xhtmlDocument } from "~/epub/xhtml";

const FIXED = new Date("2026-08-17T09:30:00.000Z");

function expectWellFormedXml(xml: string) {
  const result = XMLValidator.validate(xml, { allowBooleanAttributes: false });
  if (result !== true) {
    throw new Error(`${result.err.code}: ${result.err.msg} (line ${result.err.line})`);
  }
}

function page(title: string, body: string) {
  return xhtmlDocument(title, body, { cssHref: "style.css" });
}

function minimalInput(overrides: Partial<EpubInput> = {}): EpubInput {
  return {
    metadata: {
      identifier: "urn:hn:story:44921137",
      title: "Good system design",
      language: "en",
      creator: "seangoedecke",
      publisher: "Hacker News",
      source: "https://seangoedecke.com/good-system-design",
      date: "2026-08-16T07:14:00.000Z",
      series: "Hacker News",
      seriesIndex: "20260816.01",
      custom: {
        "hn:score": "957",
        "hn:comments": "312",
        "hn:domain": "seangoedecke.com",
      },
    },
    resources: [
      {
        id: "css",
        href: "style.css",
        mediaType: "text/css",
        data: "body { font-family: serif; }",
      },
      {
        id: "front",
        href: "frontmatter.xhtml",
        mediaType: "application/xhtml+xml",
        data: page("About", "<h1>Good system design</h1>"),
        spine: true,
      },
      {
        id: "article",
        href: "article.xhtml",
        mediaType: "application/xhtml+xml",
        data: page("Article", "<p>Body text.</p>"),
        spine: true,
      },
    ],
    toc: [
      { href: "frontmatter.xhtml", title: "About this story" },
      { href: "article.xhtml", title: "Article" },
    ],
    ...overrides,
  };
}

async function open(input: EpubInput) {
  const bytes = await buildEpub(input, FIXED);
  const zip = await JSZip.loadAsync(bytes);
  return { bytes, zip };
}

async function text(zip: JSZip, path: string): Promise<string> {
  const file = zip.file(path);
  if (!file) throw new Error(`missing zip entry: ${path}`);
  return file.async("string");
}

describe("OCF container requirements", () => {
  test("starts with the local file header signature", async () => {
    const { bytes } = await open(minimalInput());
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  test("mimetype is the first entry, uncompressed, with exact contents", async () => {
    const { bytes } = await open(minimalInput());

    // Local file header: name length at offset 26, extra length at 28, name at 30.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const compressionMethod = view.getUint16(8, true);
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    const name = new TextDecoder().decode(bytes.slice(30, 30 + nameLength));

    expect(name).toBe("mimetype");
    expect(compressionMethod).toBe(0); // 0 = STORE
    expect(extraLength).toBe(0);

    const start = 30 + nameLength + extraLength;
    const body = new TextDecoder().decode(bytes.slice(start, start + 20));
    expect(body).toBe("application/epub+zip");
  });

  test("container.xml points at the package document", async () => {
    const { zip } = await open(minimalInput());
    const xml = await text(zip, "META-INF/container.xml");
    expectWellFormedXml(xml);
    expect(xml).toContain('full-path="OEBPS/content.opf"');
    expect(xml).toContain('media-type="application/oebps-package+xml"');
  });

  test("all declared entries exist inside OEBPS", async () => {
    const { zip } = await open(minimalInput());
    for (const path of [
      "OEBPS/content.opf",
      "OEBPS/nav.xhtml",
      "OEBPS/toc.ncx",
      "OEBPS/style.css",
      "OEBPS/frontmatter.xhtml",
      "OEBPS/article.xhtml",
    ]) {
      expect(zip.file(path)).not.toBeNull();
    }
  });
});

describe("package document (OPF)", () => {
  test("is well-formed and declares the unique identifier", async () => {
    const { zip } = await open(minimalInput());
    const opf = await text(zip, "OEBPS/content.opf");
    expectWellFormedXml(opf);
    expect(opf).toContain('unique-identifier="pub-id"');
    expect(opf).toContain('<dc:identifier id="pub-id">urn:hn:story:44921137</dc:identifier>');
    expect(opf).toContain('version="3.0"');
  });

  test("carries Dublin Core metadata", async () => {
    const { zip } = await open(minimalInput());
    const opf = await text(zip, "OEBPS/content.opf");
    expect(opf).toContain("<dc:title>Good system design</dc:title>");
    expect(opf).toContain("<dc:creator>seangoedecke</dc:creator>");
    expect(opf).toContain("<dc:publisher>Hacker News</dc:publisher>");
    expect(opf).toContain("<dc:language>en</dc:language>");
    expect(opf).toContain("<dc:source>https://seangoedecke.com/good-system-design</dc:source>");
  });

  test("emits dcterms:modified without milliseconds", async () => {
    const { zip } = await open(minimalInput());
    const opf = await text(zip, "OEBPS/content.opf");
    expect(opf).toContain('<meta property="dcterms:modified">2026-08-17T09:30:00Z</meta>');
    expect(opf).not.toContain(".000Z</meta>");
  });

  test("emits calibre series metadata", async () => {
    const { zip } = await open(minimalInput());
    const opf = await text(zip, "OEBPS/content.opf");
    expect(opf).toContain('<meta name="calibre:series" content="Hacker News"/>');
    expect(opf).toContain('<meta name="calibre:series_index" content="20260816.01"/>');
  });

  test("emits custom hn:* metadata", async () => {
    const { zip } = await open(minimalInput());
    const opf = await text(zip, "OEBPS/content.opf");
    expect(opf).toContain('<meta name="hn:score" content="957"/>');
    expect(opf).toContain('<meta name="hn:comments" content="312"/>');
    expect(opf).toContain('<meta name="hn:domain" content="seangoedecke.com"/>');
  });

  test("manifest includes every resource plus generated nav and ncx", async () => {
    const { zip } = await open(minimalInput());
    const opf = await text(zip, "OEBPS/content.opf");
    expect(opf).toContain('href="style.css"');
    expect(opf).toContain('href="frontmatter.xhtml"');
    expect(opf).toContain('href="article.xhtml"');
    expect(opf).toContain('id="nav" href="nav.xhtml"');
    expect(opf).toContain('id="ncx" href="toc.ncx"');
    expect(opf).toContain('properties="nav"');
  });

  test("spine contains only spine resources, in order, and references the ncx", async () => {
    const { zip } = await open(minimalInput());
    const opf = await text(zip, "OEBPS/content.opf");
    const spine = opf.slice(opf.indexOf("<spine"), opf.indexOf("</spine>"));

    expect(spine).toContain('toc="ncx"');
    expect(spine).not.toContain('idref="css"');

    const front = spine.indexOf('idref="front"');
    const article = spine.indexOf('idref="article"');
    expect(front).toBeGreaterThan(-1);
    expect(article).toBeGreaterThan(front);
  });

  test("escapes XML metacharacters in metadata", async () => {
    const { zip } = await open(
      minimalInput({
        metadata: {
          ...minimalInput().metadata,
          title: 'Tom & Jerry\'s "<script>" guide',
        },
      }),
    );
    const opf = await text(zip, "OEBPS/content.opf");
    expectWellFormedXml(opf);
    expect(opf).not.toContain("<script>");
    expect(opf).toContain("&amp;");
    expect(opf).toContain("&lt;script&gt;");
  });
});

describe("navigation", () => {
  test("nav.xhtml is well-formed and lists the toc entries", async () => {
    const { zip } = await open(minimalInput());
    const nav = await text(zip, "OEBPS/nav.xhtml");
    expectWellFormedXml(nav);
    expect(nav).toContain('epub:type="toc"');
    expect(nav).toContain('href="frontmatter.xhtml"');
    expect(nav).toContain("About this story");
    expect(nav).toContain("Article");
  });

  test("toc.ncx is well-formed with sequential playOrder", async () => {
    const { zip } = await open(minimalInput());
    const ncx = await text(zip, "OEBPS/toc.ncx");
    expectWellFormedXml(ncx);
    expect(ncx).toContain('content="urn:hn:story:44921137"');

    const orders = [...ncx.matchAll(/playOrder="(\d+)"/g)].map((m) => Number(m[1]));
    expect(orders).toEqual([1, 2]);
  });

  test("nested toc entries produce nested lists and continuous playOrder", async () => {
    const input = minimalInput({
      toc: [
        { href: "frontmatter.xhtml", title: "About this story" },
        {
          href: "article.xhtml",
          title: "Article",
          children: [
            { href: "comments-000.xhtml", title: "thread by alice" },
            { href: "comments-001.xhtml", title: "thread by bob" },
          ],
        },
      ],
    });
    input.resources.push(
      {
        id: "c0",
        href: "comments-000.xhtml",
        mediaType: "application/xhtml+xml",
        data: page("t0", "<p>a</p>"),
        spine: true,
      },
      {
        id: "c1",
        href: "comments-001.xhtml",
        mediaType: "application/xhtml+xml",
        data: page("t1", "<p>b</p>"),
        spine: true,
      },
    );

    const { zip } = await open(input);
    const nav = await text(zip, "OEBPS/nav.xhtml");
    const ncx = await text(zip, "OEBPS/toc.ncx");

    expectWellFormedXml(nav);
    expectWellFormedXml(ncx);
    expect(nav).toContain("thread by alice");

    const orders = [...ncx.matchAll(/playOrder="(\d+)"/g)].map((m) => Number(m[1]));
    expect(orders).toEqual([1, 2, 3, 4]);
    expect(ncx.indexOf("thread by alice")).toBeGreaterThan(ncx.indexOf(">Article<"));
  });

  test("escapes XML metacharacters in toc titles", async () => {
    const { zip } = await open(
      minimalInput({
        toc: [{ href: "article.xhtml", title: "Q&A: <b>why</b>" }],
      }),
    );
    expectWellFormedXml(await text(zip, "OEBPS/nav.xhtml"));
    expectWellFormedXml(await text(zip, "OEBPS/toc.ncx"));
  });
});

describe("cover handling", () => {
  test("declares the cover-image property and legacy cover meta", async () => {
    const input = minimalInput({ coverId: "cover-img" });
    input.resources.unshift({
      id: "cover-img",
      href: "images/cover.png",
      mediaType: "image/png",
      data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    });

    const { zip } = await open(input);
    const opf = await text(zip, "OEBPS/content.opf");

    expect(opf).toContain('properties="cover-image"');
    expect(opf).toContain('<meta name="cover" content="cover-img"/>');
    expect(zip.file("OEBPS/images/cover.png")).not.toBeNull();
  });

  test("binary resources round-trip unchanged", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);
    const input = minimalInput();
    input.resources.push({
      id: "img",
      href: "images/a.png",
      mediaType: "image/png",
      data: bytes,
    });

    const { zip } = await open(input);
    const out = await zip.file("OEBPS/images/a.png")!.async("uint8array");
    expect(Array.from(out)).toEqual(Array.from(bytes));
  });
});

describe("determinism", () => {
  test("identical input produces byte-identical output", async () => {
    const a = await buildEpub(minimalInput(), FIXED);
    const b = await buildEpub(minimalInput(), FIXED);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  // Regression guard. JSZip synthesises implicit directory entries for nested
  // paths (`META-INF/`, `OEBPS/`) and stamps them with `new Date()`, ignoring
  // the pinned date passed to `zip.file()`. DOS timestamps have two-second
  // resolution, so rebuilds differed in exactly four bytes about half the
  // time. OCF does not require directory entries, so we emit none.
  test("emits no directory entries", async () => {
    const zip = await JSZip.loadAsync(await buildEpub(minimalInput(), FIXED));
    const dirs = Object.values(zip.files)
      .filter((f) => f.dir)
      .map((f) => f.name);
    expect(dirs).toEqual([]);
  });

  test("every entry carries the pinned timestamp", async () => {
    const zip = await JSZip.loadAsync(await buildEpub(minimalInput(), FIXED));
    for (const entry of Object.values(zip.files)) {
      // DOS timestamps round to two-second resolution.
      const drift = Math.abs(entry.date.getTime() - FIXED.getTime());
      expect(drift).toBeLessThanOrEqual(2000);
    }
  });

  // The bug the two tests above guard against only appeared when the wall
  // clock advanced between builds, which the fixed-clock test cannot see.
  // The clock is advanced by substituting `Date` rather than by sleeping. DOS
  // timestamps have two-second resolution, so a real sleep would have to be
  // >2s of dead wall time, and it would only *probably* cross a boundary.
  // Forcing the offset makes the crossing certain as well as free.
  test("output is stable when the wall clock advances between builds", async () => {
    const a = await buildEpub(minimalInput(), FIXED);

    const RealDate = Date;
    const OFFSET_MS = 30_000;

    // A Proxy rather than a subclass so that every other construction form
    // (`new Date(ms)`, `new Date(iso)`, `new Date(y, m, d)`) keeps its exact
    // arity and behaviour. Only the zero-argument call -- the one JSZip makes
    // for its implicit directory entries -- is redirected.
    const ShiftedDate = new Proxy(RealDate, {
      construct: (target, args) =>
        Reflect.construct(target, args.length === 0 ? [RealDate.now() + OFFSET_MS] : args),
      get: (target, prop, receiver) =>
        prop === "now"
          ? () => RealDate.now() + OFFSET_MS
          : Reflect.get(target, prop, receiver) as unknown,
    });

    let b: Uint8Array;
    let observedShiftMs = 0;
    globalThis.Date = ShiftedDate;
    try {
      observedShiftMs = new Date().getTime() - RealDate.now();
      b = await buildEpub(minimalInput(), FIXED);
    } finally {
      globalThis.Date = RealDate;
    }

    // Guard the setup: if the substitution stopped working this test would
    // silently degrade into a duplicate of the fixed-clock case above.
    expect(observedShiftMs).toBeGreaterThan(2000);

    expect(Array.from(a)).toEqual(Array.from(b));
  });
});
