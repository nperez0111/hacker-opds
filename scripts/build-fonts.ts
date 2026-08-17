/**
 * Regenerates `src/web/font-files.ts` from the canonical upstream font sources.
 *
 * Run with `bun run fonts:build`. It is not part of the build or the test run:
 * it hits the network and shells out to Python, and the whole point of checking
 * the generated module in is that neither of those is needed to ship or test.
 *
 * ## What it does
 *
 * 1. Downloads the upstream TTFs from the `google/fonts` OFL tree, which is the
 *    redistribution channel the foundries themselves publish through.
 * 2. Instances the variable ones at a fixed optical size and weight, so an
 *    e-reader gets a plain static font rather than a variable one its browser
 *    may not support.
 * 3. Subsets each face to Latin + Latin-1 + General Punctuation + the handful of
 *    symbols that actually turn up in Hacker News titles and comments.
 * 4. Emits `woff2` and `woff` for each face and writes them into a TypeScript
 *    module as base64.
 *
 * ## Why subsetting is not optional
 *
 * Charis SIL ships every Latin diacritic SIL's field linguists need: the
 * unsubset regular face is 735 KB. A reader on a Kobo's 2.4 GHz radio in a
 * basement would spend a minute on it. Subset, the same face is 23 KB.
 *
 * ## Requirements
 *
 * `pyftsubset` from fonttools, with the `brotli` and `zopfli` extras (woff2 and
 * a well-compressed woff respectively). If it is not on PATH, point
 * `FONTTOOLS_BIN` at a virtualenv's `bin` directory:
 *
 *     python3 -m venv .venv
 *     .venv/bin/pip install "fonttools[woff]" brotli zopfli
 *     FONTTOOLS_BIN=.venv/bin bun run fonts:build
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/* ------------------------------------------------------------------ */
/* what to build                                                       */
/* ------------------------------------------------------------------ */

interface FaceSpec {
  weight: number;
  style: "normal" | "italic";
  /** Upstream TTF. For a variable family this is the same file every time. */
  url: string;
  /** Axis pins for a variable source. Absent for a static one. */
  instance?: Record<string, number>;
}

interface FamilySpec {
  /** Registry id in `src/web/fonts.ts`. */
  fontId: string;
  /** CSS `font-family` name. Deliberately the real name, so `local()` matches. */
  family: string;
  license: string;
  licenseUrl: string;
  copyright: string;
  /** Where a human goes to verify the licence and the version. */
  source: string;
  faces: FaceSpec[];
}

const GF = "https://raw.githubusercontent.com/google/fonts/main/ofl";

const FAMILIES: FamilySpec[] = [
  {
    /*
     * The default. The brief asked for "ChareInk", which is a MobileRead forum
     * modification of this font distributed as zip attachments to posts - no
     * signed release, no version history, no way to verify what changed. Charis
     * SIL is the OFL original it derives from, published by SIL with a version
     * number, and it was designed for exactly this: long-form reading on a
     * low-resolution display.
     */
    fontId: "charis",
    family: "Charis SIL",
    license: "OFL-1.1",
    licenseUrl: "https://openfontlicense.org/open-font-license-official-text/",
    copyright:
      "Copyright (c) 1997-2022 SIL International (https://www.sil.org/), " +
      "with Reserved Font Name 'Charis' and 'SIL'.",
    source: "https://github.com/google/fonts/tree/main/ofl/charissil",
    faces: [
      { weight: 400, style: "normal", url: `${GF}/charissil/CharisSIL-Regular.ttf` },
      { weight: 700, style: "normal", url: `${GF}/charissil/CharisSIL-Bold.ttf` },
      { weight: 400, style: "italic", url: `${GF}/charissil/CharisSIL-Italic.ttf` },
      { weight: 700, style: "italic", url: `${GF}/charissil/CharisSIL-BoldItalic.ttf` },
    ],
  },
  {
    /*
     * Literata is variable on opsz and wght. It is pinned at opsz=12 - the
     * optical size cut for body text - because shipping the variable font would
     * cost four times the bytes to expose an axis nothing on the page varies.
     * Regular and bold only; the browser synthesises the italic, and a real
     * italic pair would nearly double the family for text that appears in block
     * quotes and little else.
     */
    fontId: "literata",
    family: "Literata",
    license: "OFL-1.1",
    licenseUrl: "https://openfontlicense.org/open-font-license-official-text/",
    copyright:
      "Copyright 2018 The Literata Project Authors " +
      "(https://github.com/googlefonts/literata).",
    source: "https://github.com/google/fonts/tree/main/ofl/literata",
    faces: [
      {
        weight: 400,
        style: "normal",
        url: `${GF}/literata/Literata%5Bopsz%2Cwght%5D.ttf`,
        instance: { opsz: 12, wght: 400 },
      },
      {
        weight: 700,
        style: "normal",
        url: `${GF}/literata/Literata%5Bopsz%2Cwght%5D.ttf`,
        instance: { opsz: 12, wght: 700 },
      },
    ],
  },
  {
    /*
     * Atkinson Hyperlegible pulls apart the character pairs that collapse into
     * each other at low contrast - I/l/1, O/0, b/d. That is the exact failure
     * mode of a greyscale panel with no subpixel rendering, which is why it is
     * offered here rather than a generic sans.
     */
    fontId: "atkinson",
    family: "Atkinson Hyperlegible",
    license: "OFL-1.1",
    licenseUrl: "https://openfontlicense.org/open-font-license-official-text/",
    copyright:
      "Copyright 2020 Braille Institute of America, Inc. " +
      "(https://www.brailleinstitute.org/freefont).",
    source:
      "https://github.com/google/fonts/tree/main/ofl/atkinsonhyperlegible",
    faces: [
      {
        weight: 400,
        style: "normal",
        url: `${GF}/atkinsonhyperlegible/AtkinsonHyperlegible-Regular.ttf`,
      },
      {
        weight: 700,
        style: "normal",
        url: `${GF}/atkinsonhyperlegible/AtkinsonHyperlegible-Bold.ttf`,
      },
    ],
  },
];

/**
 * The character set that survives subsetting.
 *
 * Basic Latin and Latin-1 Supplement cover English plus the accented names and
 * loanwords that turn up in submissions. General Punctuation is where the typed
 * quotes, dashes and ellipsis live, and the extraction pipeline emits those.
 * The stragglers after it are the ones that appear in article body text:
 * currency, the trademark sign, arrows, minus and the division slash.
 *
 * Deliberately absent: Latin Extended-A and beyond. It roughly doubles a Charis
 * face for glyphs that appear in a title a few times a year, and a title that
 * needs them still renders - the browser falls back per character to a system
 * font for anything outside `unicode-range`.
 */
const UNICODES = [
  "U+0000-00FF",
  "U+0131",
  "U+0152-0153",
  "U+02BB-02BC",
  "U+02C6",
  "U+02DA",
  "U+02DC",
  "U+0300-0304",
  "U+0308",
  "U+0329",
  "U+2000-206F",
  "U+2074",
  "U+20AC",
  "U+2122",
  "U+2190-2193",
  "U+2212",
  "U+2215",
  "U+FEFF",
  "U+FFFD",
].join(",");

/**
 * OpenType features kept in the subset.
 *
 * `kern`/`liga`/`clig` are what makes the text look set rather than typed.
 * `ccmp`/`mark`/`mkmk` position combining accents, which matters because the
 * unicode range above includes the combining diacritics block. Everything else
 * - small caps, alternates, the lot - is dropped; nothing on the page asks for
 * it and the layout tables are the expensive part of a font file.
 */
const LAYOUT_FEATURES = "kern,liga,clig,ccmp,mark,mkmk,locl";

/* ------------------------------------------------------------------ */
/* running the tools                                                   */
/* ------------------------------------------------------------------ */

const BIN = process.env.FONTTOOLS_BIN ?? "";
const PYFTSUBSET = BIN ? join(BIN, "pyftsubset") : "pyftsubset";
const PYTHON = BIN ? join(BIN, "python") : "python3";

async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`${cmd[0]} exited ${code}\n${err}`);
  }
}

async function requireTools(): Promise<void> {
  try {
    await run([PYFTSUBSET, "--help"]);
  } catch {
    throw new Error(
      `pyftsubset not found (tried "${PYFTSUBSET}").\n\n` +
        `  python3 -m venv .venv\n` +
        `  .venv/bin/pip install "fonttools[woff]" brotli zopfli\n` +
        `  FONTTOOLS_BIN=.venv/bin bun run fonts:build\n`,
    );
  }
}

/**
 * Names a browser should try as `local()` sources before downloading anything.
 *
 * For a static face these come from the font's own name table, which is exactly
 * what a system font matcher indexes. For an *instanced* face they cannot: the
 * instancer prunes the name table down to the variable font's default names, so
 * the bold instance of Literata still calls itself "Literata Regular" - and a
 * `local("Literata Regular")` in the 700 face would make any device with the
 * family installed render bold text in the regular weight.
 */
function styleSuffix(weight: number, style: "normal" | "italic"): string {
  if (weight >= 700 && style === "italic") return "Bold Italic";
  if (weight >= 700) return "Bold";
  if (style === "italic") return "Italic";
  return "Regular";
}

function synthesisedLocalNames(family: string, face: FaceSpec): string[] {
  const suffix = styleSuffix(face.weight, face.style);
  const compact = family.replace(/\s+/g, "");
  return [
    `${family} ${suffix}`,
    `${compact}-${suffix.replace(/\s+/g, "")}`,
    ...(suffix === "Regular" ? [family] : []),
  ];
}

/** Full name (nameID 4) and PostScript name (nameID 6), for `local()` sources. */
async function localNames(path: string): Promise<string[]> {
  const proc = Bun.spawn(
    [
      PYTHON,
      "-c",
      "import sys;from fontTools.ttLib import TTFont;" +
        "n=TTFont(sys.argv[1])['name'];" +
        "print('\\n'.join(x for x in [n.getDebugName(4),n.getDebugName(6)] if x))",
      path,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  await proc.exited;
  const out = await new Response(proc.stdout).text();
  const seen = new Set(out.split("\n").map((s) => s.trim()).filter(Boolean));
  return [...seen];
}

async function download(url: string, to: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  writeFileSync(to, new Uint8Array(await res.arrayBuffer()));
}

async function subset(input: string, output: string, flavor: "woff2" | "woff") {
  await run([
    PYFTSUBSET,
    input,
    `--unicodes=${UNICODES}`,
    `--layout-features=${LAYOUT_FEATURES}`,
    // Hinting instructions are a third of a TTF and every target here renders
    // at 212+ ppi with its own greyscale rasteriser, which ignores them.
    "--no-hinting",
    "--desubroutinize",
    "--drop-tables+=DSIG",
    // Keep the copyright, family, version and licence strings. The OFL requires
    // the notice to travel with the font, and stripping the name table would
    // also break `local()` matching on a device that has the font installed.
    "--name-IDs=0,1,2,3,4,5,6,13,14",
    "--notdef-outline",
    "--recalc-bounds",
    `--flavor=${flavor}`,
    // zopfli is a few seconds slower and about 5% smaller. This runs once per
    // release; the reader downloads it on a radio.
    ...(flavor === "woff" ? ["--with-zopfli"] : []),
    `--output-file=${output}`,
  ]);
}

/* ------------------------------------------------------------------ */
/* emitting the module                                                 */
/* ------------------------------------------------------------------ */

interface BuiltFile {
  name: string;
  base64: string;
  bytes: number;
}

interface BuiltFace {
  id: string;
  fontId: string;
  family: string;
  weight: number;
  style: "normal" | "italic";
  local: string[];
  woff2: BuiltFile;
  woff: BuiltFile;
}

function faceId(fontId: string, f: FaceSpec): string {
  return `${fontId}-${f.weight}${f.style === "italic" ? "i" : ""}`;
}

function literal(value: unknown): string {
  return JSON.stringify(value);
}

function emit(faces: BuiltFace[]): string {
  const licenses = FAMILIES.map((fam) => {
    const bytes = faces
      .filter((f) => f.fontId === fam.fontId)
      .reduce((n, f) => n + f.woff2.bytes + f.woff.bytes, 0);
    return { ...fam, bytes };
  });

  const header = licenses
    .map(
      (l) =>
        ` * ${l.family} - ${l.license}\n` +
        ` *   ${l.copyright.replace(/\n/g, " ")}\n` +
        ` *   source:  ${l.source}\n` +
        ` *   licence: ${l.licenseUrl}\n` +
        ` *   shipped: ${l.bytes} bytes across ${
          faces.filter((f) => f.fontId === l.fontId).length
        } faces (woff2 + woff)`,
    )
    .join("\n *\n");

  const facesSrc = faces
    .map(
      (f) => `  {
    id: ${literal(f.id)},
    fontId: ${literal(f.fontId)},
    family: ${literal(f.family)},
    weight: ${f.weight},
    style: ${literal(f.style)},
    local: ${literal(f.local)},
    woff2: { name: ${literal(f.woff2.name)}, bytes: ${f.woff2.bytes}, base64: ${literal(f.woff2.base64)} },
    woff: { name: ${literal(f.woff.name)}, bytes: ${f.woff.bytes}, base64: ${literal(f.woff.base64)} },
  },`,
    )
    .join("\n");

  const licenseSrc = licenses
    .map(
      (l) => `  {
    fontId: ${literal(l.fontId)},
    family: ${literal(l.family)},
    license: ${literal(l.license)},
    licenseUrl: ${literal(l.licenseUrl)},
    copyright: ${literal(l.copyright)},
    source: ${literal(l.source)},
    bytes: ${l.bytes},
  },`,
    )
    .join("\n");

  return `/**
 * Self-hosted webfont payloads. GENERATED - do not edit by hand.
 *
 * Regenerate with \`bun run fonts:build\` (scripts/build-fonts.ts), which
 * fetches the upstream TTFs, subsets them and rewrites this file.
 *
 * Every font here is redistributable under the SIL Open Font License 1.1. The
 * licence text travels with the repository in src/web/fonts/OFL.txt and the
 * per-family notices are in src/web/fonts/NOTICE.md.
 *
${header}
 *
 * ## Why base64 in a module rather than files on disk
 *
 * There is no public/ directory and no serverAssets binding (see the note at
 * nitro.config.ts:28). Everything the website serves is generated from a
 * TypeScript module so it bundles unconditionally and can be asserted on in
 * tests without a filesystem or an HTTP listener. Font binaries are the first
 * genuinely binary asset, and base64 costs 33% in *source* size - not in
 * transfer size, since the bytes are decoded before they reach the wire.
 *
 * The subset total is under 400 KB, which is smaller than several of this
 * server's existing npm dependencies, so it did not seem worth introducing a
 * second asset mechanism to avoid.
 */

export interface FontFile {
  /** Asset name; the last path segment of \`/assets/<name>\`. */
  name: string;
  bytes: number;
  base64: string;
}

export interface FontFaceFiles {
  /** Stable face key, e.g. "charis-700i". */
  id: string;
  /** Registry id in \`src/web/fonts.ts\`. */
  fontId: string;
  /** CSS \`font-family\` name, matching the font's own name table. */
  family: string;
  weight: number;
  style: "normal" | "italic";
  /**
   * Names for \`local()\` sources, from the font's name table. A device that
   * already has the family installed matches one of these and downloads
   * nothing - which on a Kindle or a Boox is the common case.
   */
  local: string[];
  woff2: FontFile;
  woff: FontFile;
}

export interface FontLicense {
  fontId: string;
  family: string;
  license: string;
  licenseUrl: string;
  copyright: string;
  source: string;
  /** Total shipped bytes for the family, both formats, all faces. */
  bytes: number;
}

/**
 * The exact set the faces above were subset to, formatted for the CSS
 * \`unicode-range\` descriptor. Emitted from the build so the stylesheet cannot
 * claim coverage the binaries do not have - a lie here means a browser declines
 * to fall back for a character the font has no glyph for, and the reader gets
 * a row of empty boxes.
 */
export const FONT_UNICODE_RANGE = ${literal(UNICODES.split(",").join(", "))};

export const FONT_FACE_FILES: readonly FontFaceFiles[] = [
${facesSrc}
];

export const FONT_LICENSES: readonly FontLicense[] = [
${licenseSrc}
];
`;
}

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  await requireTools();

  const work = join(tmpdir(), `hn-fonts-${Date.now()}`);
  mkdirSync(work, { recursive: true });

  const cache = new Map<string, string>();
  const built: BuiltFace[] = [];

  try {
    for (const fam of FAMILIES) {
      for (const face of fam.faces) {
        const id = faceId(fam.fontId, face);

        let src = cache.get(face.url);
        if (!src) {
          src = join(work, `src-${cache.size}.ttf`);
          process.stdout.write(`fetch  ${face.url}\n`);
          await download(face.url, src);
          cache.set(face.url, src);
        }

        let input = src;
        if (face.instance) {
          input = join(work, `${id}-instance.ttf`);
          const pins = Object.entries(face.instance).map(([k, v]) => `${k}=${v}`);
          await run([PYTHON, "-m", "fontTools.varLib.instancer", src, ...pins, "-o", input]);
        }

        const w2 = join(work, `${id}.woff2`);
        const w1 = join(work, `${id}.woff`);
        await subset(input, w2, "woff2");
        await subset(input, w1, "woff");

        const b2 = readFileSync(w2);
        const b1 = readFileSync(w1);
        built.push({
          id,
          fontId: fam.fontId,
          family: fam.family,
          weight: face.weight,
          style: face.style,
          local: face.instance
            ? synthesisedLocalNames(fam.family, face)
            : await localNames(input),
          woff2: { name: `${id}.woff2`, bytes: b2.length, base64: b2.toString("base64") },
          woff: { name: `${id}.woff`, bytes: b1.length, base64: b1.toString("base64") },
        });
        process.stdout.write(
          `build  ${id.padEnd(14)} woff2 ${String(b2.length).padStart(7)}  woff ${String(b1.length).padStart(7)}\n`,
        );
      }
    }

    const out = join(import.meta.dir, "..", "src", "web", "font-files.ts");
    writeFileSync(out, emit(built));
    const total = built.reduce((n, f) => n + f.woff2.bytes + f.woff.bytes, 0);
    process.stdout.write(`\nwrote ${out}\ntotal ${total} bytes across ${built.length} faces\n`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

await main();
