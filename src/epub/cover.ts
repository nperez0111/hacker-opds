/**
 * Cover generation.
 *
 * Every book this server produces gets a cover, because a library grid without
 * one is a wall of identical grey rectangles with truncated titles under them.
 * On an e-reader the cover is the only thing that distinguishes a shelf of
 * thirty books from the same day.
 *
 * ## What the design is for
 *
 * The target is a 6-inch greyscale panel with no backlight, often shown at
 * 120px wide in a grid. So: pure black on pure white, no greys, no gradients,
 * no photography, one typeface, and a silhouette (two solid bands top and
 * bottom, a keyline frame) that stays recognisable when the text is too small
 * to read. The type is Charis SIL, bold for the headline and regular for the
 * small print - the same face the website sets its body text in, so a book
 * looks like it came from this site.
 *
 * ## How it is drawn
 *
 * An SVG, rasterised by resvg. SVG because the layout is a dozen rectangles and
 * lines of text, and because the same source rasterises to any size, so the
 * thumbnail is re-rendered rather than downscaled - vector text at 250px is
 * sharp where a resampled 1000px bitmap is mush.
 *
 * ## The font cost, which is the whole reason this file is shaped like this
 *
 * `new Resvg(...)` builds a font database, and how it builds it dominates
 * everything else here. Measured on this machine, rasterising one cover:
 *
 *   - system fonts (the default):        ~1100 ms
 *   - `font.fontBuffers` with our TTF:   ~1100 ms  (no better; and the option
 *                                                   is not even in resvg-js
 *                                                   2.6.2's typings)
 *   - `font.fontFiles` with a TTF path:    ~15 ms
 *   - no text in the document at all:      ~0 ms
 *
 * So the font is materialised as a *file* once per process (see `fontPaths`)
 * and passed by path. That is what the "binary cover TTF" note in
 * nitro.config.ts anticipated - except no TTF needs to be checked in or bound
 * through serverAssets, because the repository already ships these faces as
 * WOFF in `~/web/font-files` and `~/epub/sfnt` unpacks them exactly.
 *
 * Rasterised bytes are then cached in the `assets` store under `kind = 'cover'`,
 * so a rebuild of a book costs a `SELECT` rather than a rasterise.
 *
 * ## Determinism
 *
 * Same story, same bytes, forever - the EPUB embedding the cover is
 * content-addressed and served `immutable`, so a cover that varied by host or
 * by run would break the ETag. Nothing here reads the clock or the network; the
 * only inputs are the row and this file. Text is measured from the font's own
 * metrics rather than the host's, and characters the subset cannot draw are
 * replaced deterministically instead of falling back to a system face that
 * differs from machine to machine.
 */
import { Resvg } from "@resvg/resvg-js";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { DateTime } from "luxon";

import { coalesce } from "~/build/queue";
import { blobPath, ensureDirs } from "~/db/client";
import type { StoryRow } from "~/core/edition";
import { readMetrics, woffToSfnt, type FontMetrics } from "~/epub/sfnt";
import { xmlEscape } from "~/epub/xhtml";
import {
  linkEditionAsset,
  linkStoryAsset,
  lookupAsset,
  putAsset,
  type AssetBytes,
} from "~/epub/assets";
import { FONT_FACE_FILES } from "~/web/font-files";

/* ------------------------------------------------------------------ */
/* the font                                                            */
/* ------------------------------------------------------------------ */

/** Faces the covers are set in. Bold for headings, regular for the small print. */
const BOLD_FACE = "charis-700";
const REGULAR_FACE = "charis-400";

export const COVER_FONT_FAMILY = "Charis SIL";

interface LoadedFont {
  /** File name under `blobs/fonts`, fixed by the face and its payload size. */
  file: string;
  sfnt: Uint8Array;
  metrics: FontMetrics;
}

const loaded = new Map<string, LoadedFont>();

/** Unpacks a face and reads its metrics. Done once per process, per face. */
function loadFace(id: string): LoadedFont {
  const cached = loaded.get(id);
  if (cached) return cached;

  const face = FONT_FACE_FILES.find((f) => f.id === id);
  if (!face) throw new Error(`cover font face ${id} is not in FONT_FACE_FILES`);

  const sfnt = woffToSfnt(Uint8Array.from(Buffer.from(face.woff.base64, "base64")));
  // The name carries the payload size, so rebuilding the fonts lands on a new
  // path rather than serving a stale file of the same name.
  const entry = {
    file: `${face.id}-${face.woff.bytes}.ttf`,
    sfnt,
    metrics: readMetrics(sfnt),
  };
  loaded.set(id, entry);
  return entry;
}

/**
 * Materialises a face in the data directory and returns its path.
 *
 * The path is recomputed rather than memoised because `dataDir()` is not fixed
 * for the life of the process: tests point it at a throwaway directory per
 * case, and a cached path would outlive the directory it named - handing resvg
 * a font file that no longer exists, which it ignores silently, producing a
 * cover with no text on it. An `existsSync` per cover is free next to the
 * rasterise that follows.
 */
function facePath(id: string): string {
  const face = loadFace(id);
  const path = blobPath("fonts", face.file);
  if (!existsSync(path)) {
    ensureDirs();
    mkdirSync(blobPath("fonts"), { recursive: true });
    writeFileSync(path, face.sfnt);
  }
  return path;
}

/** Both faces, for `font.fontFiles`. */
function fontPaths(): string[] {
  return [facePath(BOLD_FACE), facePath(REGULAR_FACE)];
}

/* ------------------------------------------------------------------ */
/* geometry                                                            */
/* ------------------------------------------------------------------ */

/** 1000x1600 is 1:1.6, the ratio Kindle and Kobo both want. */
export const COVER_WIDTH = 1000;
export const COVER_HEIGHT = 1600;
/** Width of the thumbnail OPDS advertises separately. */
export const THUMB_WIDTH = 250;

const FRAME = 24;
const FRAME_STROKE = 6;
const TOP_BAND = 170;
const BOTTOM_BAND = 120;
/** Left and right text margin inside the frame. */
const PAD = 80;
const TEXT_WIDTH = COVER_WIDTH - PAD * 2;

const BLACK = "#000000";
const WHITE = "#ffffff";

/* ------------------------------------------------------------------ */
/* text fitting                                                        */
/* ------------------------------------------------------------------ */

/**
 * The fitted width is compared against this fraction of the box.
 *
 * Kerning is not in the measurement and resvg applies it, so a measured line is
 * a hair wider than the drawn one; the margin also absorbs the difference
 * between a rounded advance and a rasterised outline. Erring narrow costs a
 * point of type size, erring wide puts a headline through the frame.
 */
const FIT = 0.98;

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = [
  "Monday", "Tuesday", "Wednesday", "Thursday",
  "Friday", "Saturday", "Sunday",
];

/**
 * Replaces characters the subset cannot draw.
 *
 * Falling back to a system font would be the usual answer and is exactly what
 * must not happen: it would make the bytes depend on which fonts the host has
 * installed. A run of undrawable characters collapses to a single replacement
 * mark, so a title in a script this font does not cover degrades to something
 * legibly incomplete rather than a row of empty boxes - and the domain, the
 * date and the bands still identify the book.
 */
export function toDrawable(text: string, metrics: FontMetrics): string {
  const mark = metrics.has(0xfffd) ? "\ufffd" : "?";
  let out = "";
  let dropping = false;
  for (const ch of text.replace(/\s+/g, " ").trim()) {
    const cp = ch.codePointAt(0) as number;
    if (ch === " " || metrics.has(cp)) {
      out += ch;
      dropping = false;
      continue;
    }
    if (!dropping) out += mark;
    dropping = true;
  }
  return out.trim();
}

/**
 * Splits a word that cannot fit on any line into pieces that can.
 *
 * Titles genuinely contain these - a chemical name, a stack trace, a URL with
 * no spaces in it. Left whole, such a word runs off the page; truncated, the
 * cover throws away most of the only words it has. Breaking mid-word without a
 * hyphen is what a newspaper would not do and what a 1000px canvas has no
 * alternative to.
 */
function splitLongWord(
  word: string,
  metrics: FontMetrics,
  fontSize: number,
  maxWidth: number,
): string[] {
  const pieces: string[] = [];
  let piece = "";
  for (const ch of word) {
    if (piece && metrics.measure(piece + ch, fontSize) > maxWidth) {
      pieces.push(piece);
      piece = ch;
    } else {
      piece += ch;
    }
  }
  if (piece) pieces.push(piece);
  return pieces;
}

/** Greedy line breaking on spaces, falling back to mid-word breaks. */
export function wrapText(
  text: string,
  metrics: FontMetrics,
  fontSize: number,
  maxWidth: number,
): string[] {
  const words = text
    .split(" ")
    .filter(Boolean)
    .flatMap((word) =>
      metrics.measure(word, fontSize) <= maxWidth
        ? [word]
        : splitLongWord(word, metrics, fontSize, maxWidth),
    );

  const lines: string[] = [];
  let line = "";

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (!line || metrics.measure(candidate, fontSize) <= maxWidth) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Shortens a single line until it fits, marking the cut with an ellipsis. */
export function truncateToWidth(
  text: string,
  metrics: FontMetrics,
  fontSize: number,
  maxWidth: number,
): string {
  if (metrics.measure(text, fontSize) <= maxWidth) return text;
  const ellipsis = metrics.has(0x2026) ? "\u2026" : "...";
  let cut = text;
  while (cut.length > 1 && metrics.measure(cut + ellipsis, fontSize) > maxWidth) {
    cut = cut.slice(0, -1);
  }
  return cut.trimEnd() + ellipsis;
}

export interface FittedText {
  size: number;
  lines: string[];
}

/**
 * Largest size from `sizes` (descending) at which the text wraps into at most
 * `maxLines`. Falls back to the smallest size with the overflow truncated, so
 * a pathological title still produces a cover.
 */
export function fitText(
  text: string,
  metrics: FontMetrics,
  opts: { sizes: number[]; maxWidth: number; maxLines: number },
): FittedText {
  const box = opts.maxWidth * FIT;
  for (const size of opts.sizes) {
    const lines = wrapText(text, metrics, size, box);
    if (lines.length <= opts.maxLines && lines.every((l) => metrics.measure(l, size) <= box)) {
      return { size, lines };
    }
  }

  const size = opts.sizes[opts.sizes.length - 1] as number;
  const lines = wrapText(text, metrics, size, box).slice(0, opts.maxLines);
  const last = lines.length - 1;
  if (last >= 0) {
    lines[last] = truncateToWidth(`${lines[last]}\u2026`, metrics, size, box);
  }
  return { size, lines };
}

/* ------------------------------------------------------------------ */
/* SVG pieces                                                          */
/* ------------------------------------------------------------------ */

interface TextOpts {
  x: number;
  y: number;
  size: number;
  fill?: string;
  weight?: 400 | 700;
  anchor?: "start" | "middle" | "end";
  tracking?: number;
}

function svgText(text: string, o: TextOpts): string {
  const attrs = [
    `x="${o.x}"`,
    `y="${o.y}"`,
    `font-family="${COVER_FONT_FAMILY}"`,
    `font-weight="${o.weight ?? 700}"`,
    `font-size="${o.size}"`,
    `fill="${o.fill ?? BLACK}"`,
  ];
  if (o.anchor && o.anchor !== "start") attrs.push(`text-anchor="${o.anchor}"`);
  if (o.tracking) attrs.push(`letter-spacing="${o.tracking}"`);
  return `  <text ${attrs.join(" ")}>${xmlEscape(text)}</text>`;
}

function band(y: number, height: number): string {
  return `  <rect x="${FRAME}" y="${y}" width="${COVER_WIDTH - FRAME * 2}" height="${height}" fill="${BLACK}"/>`;
}

function rule(y: number): string {
  return `  <rect x="${PAD}" y="${y}" width="${TEXT_WIDTH}" height="5" fill="${BLACK}"/>`;
}

/** Top of the white area between the bands. */
const BODY_TOP = FRAME + TOP_BAND;
/** Bottom of it. */
const BODY_BOTTOM = COVER_HEIGHT - FRAME - BOTTOM_BAND;

/**
 * `y0` that centres a block of `height` between the bands.
 *
 * Slightly above the true middle: a block placed at exactly 50% reads as
 * sagging, which is why book title pages have used an optical centre for five
 * centuries. The same 0.42 applies to both covers so they look like a set.
 */
function centreBlock(height: number): number {
  return Math.round(BODY_TOP + (BODY_BOTTOM - BODY_TOP - height) * 0.42);
}

/**
 * The shell every cover shares: the page, the two bands, their labels and the
 * keyline.
 *
 * Everything sits inside the frame, including the bands, so the whole design is
 * one bordered block on a white page - which is what survives being shrunk to a
 * 120px thumbnail, long after the type has stopped being readable. The frame is
 * drawn last so it overprints the bands instead of being swallowed by them.
 */
function shell(topLabel: string, bottom: string, body: string[], metrics: FontMetrics): string {
  const inset = FRAME + FRAME_STROKE / 2;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${COVER_WIDTH}" height="${COVER_HEIGHT}" viewBox="0 0 ${COVER_WIDTH} ${COVER_HEIGHT}">`,
    `  <rect width="${COVER_WIDTH}" height="${COVER_HEIGHT}" fill="${WHITE}"/>`,
    band(FRAME, TOP_BAND),
    band(BODY_BOTTOM, BOTTOM_BAND),
    svgText(topLabel, {
      x: COVER_WIDTH / 2,
      y: FRAME + TOP_BAND / 2 + 20,
      size: 54,
      fill: WHITE,
      anchor: "middle",
      tracking: 12,
    }),
    ...body,
    svgText(truncateToWidth(bottom, metrics, 40, TEXT_WIDTH), {
      x: COVER_WIDTH / 2,
      y: BODY_BOTTOM + BOTTOM_BAND / 2 + 14,
      size: 40,
      fill: WHITE,
      anchor: "middle",
      weight: 400,
      tracking: 4,
    }),
    `  <rect x="${inset}" y="${inset}" width="${COVER_WIDTH - inset * 2}" height="${COVER_HEIGHT - inset * 2}" fill="none" stroke="${BLACK}" stroke-width="${FRAME_STROKE}"/>`,
    `</svg>`,
    ``,
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* the two covers                                                      */
/* ------------------------------------------------------------------ */

/** Title sizes tried in turn. The floor still reads at thumbnail size. */
const TITLE_SIZES = [104, 92, 82, 74, 66, 58, 52];
const TITLE_LINES = 6;
/** Type size of the source line under the rule. */
const SOURCE_SIZE = 48;
/** Distance from the rule down to the source line's baseline. */
const SOURCE_DROP = 78;

/**
 * A story cover: the headline, then the source it came from.
 *
 * The title is set as large as it will go and the domain sits under a rule
 * beneath it, because those are the two facts that tell a reader which book
 * this is - the score and the comment count belong in the book, not on the
 * spine.
 */
export function storyCoverSvg(story: StoryRow): string {
  const bold = loadFace(BOLD_FACE).metrics;
  const regular = loadFace(REGULAR_FACE).metrics;

  const title = fitText(toDrawable(story.title, bold), bold, {
    sizes: TITLE_SIZES,
    maxWidth: TEXT_WIDTH,
    maxLines: TITLE_LINES,
  });

  // Laid out relative to a floating top edge and then centred as a whole, so a
  // two-word headline and a six-line one both sit optically in the same place.
  const lineHeight = Math.round(title.size * 1.18);
  const ascent = Math.round(title.size * 0.8);
  const lastBaseline = ascent + (title.lines.length - 1) * lineHeight;
  const ruleOffset = lastBaseline + Math.round(title.size * 0.55);
  const sourceOffset = ruleOffset + SOURCE_DROP;
  const top = centreBlock(sourceOffset + Math.round(SOURCE_SIZE * 0.3));

  const body = title.lines.map((line, i) =>
    svgText(line, { x: PAD, y: top + ascent + i * lineHeight, size: title.size }),
  );
  body.push(rule(top + ruleOffset));

  const source = toDrawable(story.domain ?? "news.ycombinator.com", regular);
  body.push(
    svgText(truncateToWidth(source, regular, SOURCE_SIZE, TEXT_WIDTH), {
      x: PAD,
      y: top + sourceOffset,
      size: SOURCE_SIZE,
      weight: 400,
    }),
  );

  return shell(
    "HACKER NEWS",
    `${story.edition_date}   \u00b7   No. ${story.rank}`,
    body,
    regular,
  );
}

/**
 * An edition digest cover: the date, big, and nothing competing with it.
 *
 * A digest has no title of its own - it is a day - so the day is the artwork.
 */
export function editionCoverSvg(date: string, storyCount: number): string {
  const bold = loadFace(BOLD_FACE).metrics;
  const regular = loadFace(REGULAR_FACE).metrics;

  const dt = DateTime.fromISO(date, { zone: "UTC" });
  // Names come from a table rather than from Intl: a locale-dependent month
  // name would make the bytes differ between hosts.
  const weekday = dt.isValid ? (WEEKDAYS[dt.weekday - 1] as string) : "";
  const dayMonth = dt.isValid ? `${dt.day} ${MONTHS[dt.month - 1] as string}` : date;
  const year = dt.isValid ? String(dt.year) : "";

  const centre = COVER_WIDTH / 2;
  const headline = fitText(dayMonth, bold, {
    sizes: [136, 120, 108, 96, 88],
    maxWidth: TEXT_WIDTH,
    maxLines: 1,
  });

  // Offsets from the top of the block; the block is centred afterwards.
  const weekdayAt = 44;
  const headlineAt = weekdayAt + 150;
  const yearAt = headlineAt + 130;
  const ruleAt = yearAt + 70;
  const countAt = ruleAt + 80;
  const top = centreBlock(countAt + 20);

  const body: string[] = [];
  if (weekday) {
    body.push(
      svgText(weekday.toUpperCase(), {
        x: centre,
        y: top + weekdayAt,
        size: 56,
        anchor: "middle",
        weight: 400,
        tracking: 10,
      }),
    );
  }
  body.push(
    svgText(headline.lines[0] ?? date, {
      x: centre,
      y: top + headlineAt,
      size: headline.size,
      anchor: "middle",
    }),
  );
  if (year) {
    body.push(svgText(year, { x: centre, y: top + yearAt, size: 108, anchor: "middle" }));
  }
  body.push(rule(top + ruleAt));
  body.push(
    svgText(`${storyCount} ${storyCount === 1 ? "story" : "stories"}, with comments`, {
      x: centre,
      y: top + countAt,
      size: 50,
      anchor: "middle",
      weight: 400,
    }),
  );

  return shell("HACKER NEWS", "COMPLETE EDITION", body, regular);
}

/* ------------------------------------------------------------------ */
/* rasterising and caching                                             */
/* ------------------------------------------------------------------ */

/**
 * SVG to PNG at a given pixel width.
 *
 * `loadSystemFonts: false` is not an optimisation here, it is the determinism
 * guarantee: with it off, a family this document does not ship simply does not
 * render, so a cover can never quietly pick up a host font.
 *
 * resvg hands back 8-bit RGBA, which for a two-colour drawing is three channels
 * of nothing: 98 KB for a full-size cover. Requantising to a palette costs one
 * pass and takes the same image to 33 KB, which is a third of the bytes an
 * e-reader pulls over its radio for a cover it is going to display in
 * greyscale anyway. The pass is deterministic and it happens once, before the
 * result is cached.
 */
export async function rasteriseCover(
  svg: string,
  width: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const rgba = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
    font: {
      loadSystemFonts: false,
      fontFiles: fontPaths(),
      defaultFontFamily: COVER_FONT_FAMILY,
    },
  })
    .render()
    .asPng();

  const out = await new Bun.Image(rgba)
    .modulate({ saturation: 0 })
    .png({ palette: true, compressionLevel: 9 })
    .toBuffer();
  return new Uint8Array(out);
}

/** Cache key for a rendered cover. */
function coverVariant(svg: string, width: number): string {
  // Hashing the SVG rather than enumerating the inputs means every change that
  // could alter a pixel - an edited title, a moved rule, a new size ladder -
  // is a cache miss by construction, and nothing that cannot alter a pixel is.
  return `cover-w${width}-${Bun.CryptoHasher.hash("sha256", svg, "hex").slice(0, 16)}`;
}

/**
 * Rasterises `svg` at `width`, or returns the copy already in the asset store.
 *
 * `urn` identifies the subject (`cover:story:44921137`), not the bytes; the
 * variant identifies the bytes. That is the same split `~/epub/assets` uses for
 * downloaded images, so covers ride the existing store, the existing blob
 * layout and the existing orphan sweep.
 */
export function renderCover(urn: string, svg: string, width: number): Promise<AssetBytes> {
  const variant = coverVariant(svg, width);
  // Coalesced on the same key an artifact build would use: a cold story hit by
  // a catalogue and a browser at once should rasterise once, not twice. The
  // queue is a leaf utility with no dependencies of its own, which is why an
  // EPUB-layer module can reach for it without dragging the build layer in.
  return coalesce(`${urn}:w${width}`, async () => {
    const hit = await lookupAsset(urn, variant);
    if (hit) return hit;

    const data = await rasteriseCover(svg, width);
    return await putAsset(urn, variant, {
      data,
      mediaType: "image/png",
      ext: "png",
      kind: "cover",
      width,
      height: Math.round((width * COVER_HEIGHT) / COVER_WIDTH),
    });
  });
}

/**
 * Response headers for serving a cover.
 *
 * Here rather than in the routes so the two of them cannot disagree, and as
 * plain data so this module stays free of the HTTP layer. The ETag is the
 * content digest the asset store already computed, and the policy matches the
 * EPUB artifacts: the bytes behind a given digest can never change.
 */
export function coverHeaders(asset: AssetBytes): Record<string, string> {
  return {
    "content-type": asset.mediaType,
    "content-length": String(asset.data.byteLength),
    "cache-control": "public, max-age=31536000, immutable",
    etag: `"${asset.sha256}"`,
  };
}

export type CoverSize = "full" | "thumb";

const WIDTHS: Record<CoverSize, number> = {
  full: COVER_WIDTH,
  thumb: THUMB_WIDTH,
};

/**
 * Test seam, and the same bargain `setSvgFontOptionsForTests` strikes in
 * `~/epub/images`.
 *
 * Rasterising and requantising a 1000x1600 cover costs about 115 ms, and the
 * EPUB suites build a couple of dozen books - which turned a 3 s test run into
 * a 6 s one for no additional coverage, because cost here is a function of
 * pixel count and nothing else. Suites that build books set a small scale and
 * exercise every line of this module at a size that renders in a couple of
 * milliseconds; `tests/cover.test.ts` leaves it at 1 and asserts the real
 * dimensions.
 */
let coverScale = 1;

export function setCoverScaleForTests(scale: number): void {
  coverScale = scale;
}

function widthFor(size: CoverSize): number {
  return Math.max(40, Math.round(WIDTHS[size] * coverScale));
}

/**
 * The cover for a story, at either size.
 *
 * The asset is referenced from the story as it is produced, rather than by
 * whoever asked for it. Both sizes are reachable from the catalogue, and an
 * unreferenced asset is one that retention's orphan sweep deletes tonight and
 * something redraws tomorrow - so the reference belongs wherever the bytes are
 * created, not in one of the several callers.
 */
export async function storyCover(
  story: StoryRow,
  size: CoverSize = "full",
): Promise<AssetBytes> {
  const asset = await renderCover(
    `cover:story:${story.id}`,
    storyCoverSvg(story),
    widthFor(size),
  );
  linkStoryAsset(story.id, asset.sha256);
  return asset;
}

/** The digest's cover, referenced from the edition. See `storyCover`. */
export async function editionCover(
  date: string,
  storyCount: number,
  size: CoverSize = "full",
): Promise<AssetBytes> {
  const asset = await renderCover(
    `cover:edition:${date}`,
    editionCoverSvg(date, storyCount),
    widthFor(size),
  );
  linkEditionAsset(date, asset.sha256);
  return asset;
}
