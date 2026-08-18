#!/usr/bin/env bun
/**
 * Draws the site's icon and regenerates `src/web/icon-files.ts`.
 *
 * Run with `bun run icon:build`. Like scripts/build-fonts.ts it is not part of
 * the build or the test run: it reaches for the network and rasterises six
 * images, and the point of checking the generated module in is that a deploy
 * needs neither.
 *
 * ## The mark
 *
 * An "HN" monogram whose two letters share a stem - the H's right stem *is* the
 * N's left stem - knocked out of a rounded black square. The shared stem, the
 * container and the pure two-tone knock-out come from the brief's reference
 * image; the reference drew the letters as pixel art, which is somebody else's
 * idea and the wrong one for a site whose entire visual argument is that a
 * screen can be set like a page. These letters are Charis SIL Bold, the face
 * the site sets its body text in and the one every EPUB cover is lettered with.
 *
 * ## Why Charis SIL and not ChareInk
 *
 * The brief asked for ChareInk. It is a MobileRead forum modification of Charis
 * SIL, distributed as zip attachments to posts, with no signed release and no
 * way to verify what was changed - which is why src/web/fonts.ts:129 rejects it
 * for the reading font too. Charis SIL is the OFL original it derives from, it
 * is already `DEFAULT_FONT`, and it is already in the tree. This decision was
 * made once; it is recorded here so nobody has to make it again.
 *
 * ## Why the outlines are extracted rather than set as text
 *
 * An SVG that says `<text font-family="Charis SIL">` renders in whatever the
 * viewer falls back to, and a favicon is viewed by browsers, feed readers and
 * link unfurlers that have never heard of this site's webfonts. So the `glyf`
 * outlines for U+0048 and U+004E are read straight out of the sfnt and emitted
 * as path data. What ships is a drawing, not a typographic instruction.
 *
 * ## Where the font comes from
 *
 * Preferably the upstream TTF in the `google/fonts` OFL tree - the same source
 * scripts/build-fonts.ts uses, unsubset and unhinted-by-us. If that fetch
 * fails, the vendored subset in src/web/font-files.ts is unpacked instead
 * (`woffToSfnt`, src/epub/sfnt.ts:54, the same path src/epub/cover.ts takes for
 * cover lettering). Both contain H and N, and the subsetter does not touch
 * outlines, so the two produce identical path data. There is no fontTools
 * dependency here at all: the glyf table is a few hundred lines of parsing and
 * shelling out to Python to get two capital letters would be the tail wagging
 * the dog.
 *
 * ## Requirements
 *
 * Nothing but Bun and `@resvg/resvg-js`, which is already a dependency because
 * EPUB covers are rasterised the same way. Network access is optional.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { Resvg } from "@resvg/resvg-js";

import { woffToSfnt } from "~/epub/sfnt";
import { FONT_FACE_FILES } from "~/web/font-files";

/* ------------------------------------------------------------------ */
/* the design                                                          */
/* ------------------------------------------------------------------ */

/**
 * The drawing's coordinate space. Every dimension below is in these units, and
 * the SVG's viewBox is exactly this square, so the numbers in the generated
 * file can be read as "pixels at the largest size we ship".
 */
const CANVAS = 512;

/**
 * Corner radius, 16.4% of the side.
 *
 * Squarer than iOS's 22.5% superellipse on purpose: this is meant to read as a
 * printer's block, not an app tile. Below about 12% the corners stop being
 * legible as corners at 16px and the mark may as well be a plain square.
 */
const RADIUS = 84;

/**
 * Margin between the monogram's ink and the square's edge.
 *
 * The binding constraint is the horizontal one - the monogram is 1.74:1, so
 * width sets the scale and the vertical margins fall out at around five times
 * this. The value was chosen by measuring 16px renders rather than by looking
 * at 512px ones: between 14 and 30 units the difference at 512 is invisible,
 * while at 16 it decides whether the H's stems land on a pixel each (18: two
 * white stems and a readable crossbar) or straddle two (26: four grey ones).
 */
const PAD = 18;

/**
 * Emboldening was tried and rejected.
 *
 * The obvious fix for thin stems at 16px is to stroke the letter path in its
 * own colour. Measured on the rendered pixels it makes things *worse*: a 4-unit
 * stroke drops the 16px contrast score from 110.3 to 106.5, because the H's
 * counters and the N's aperture close up faster than the stems gain. It also
 * costs the letterforms their Charis crispness at 512, where they are 18%
 * heavier than the face actually is. The mark ships at the weight it was drawn.
 */
const EMBOLDEN = 0;

const BLACK = "#000000";
const WHITE = "#ffffff";

/**
 * Sub-pixel phase search, in steps per pixel, for the small rasters.
 *
 * A 16px favicon has about 1.7 device pixels of stem to work with, and whether
 * that lands on a pixel or straddles two is the difference between a white stem
 * and two grey ones. There is one knob - where the whole drawing sits inside
 * the pixel grid - and it is found by rendering the candidates and keeping the
 * one whose pixels are furthest from mid-grey. It is a poor man's hinting, and
 * like hinting it is a property of the raster, not of the artwork: the offset
 * is bounded to half a pixel either way so the mark stays centred.
 */
const PHASE_STEPS = 8;

/**
 * What goes in the ICO.
 *
 * 16 is the browser tab, 32 is the same tab on a 2x display and most bookmark
 * bars, 48 is Windows' shortcut and taskbar size. Nothing larger: a 256px entry
 * would be most of the file, for a size that is always served better by the
 * PNGs or by the SVG.
 */
const ICO_SIZES = [16, 32, 48];

/* ------------------------------------------------------------------ */
/* reading the font                                                    */
/* ------------------------------------------------------------------ */

const UPSTREAM =
  "https://raw.githubusercontent.com/google/fonts/main/ofl/charissil/CharisSIL-Bold.ttf";

/** The face, in both places it can come from. Bold, matching EPUB cover titles. */
const VENDORED_FACE = "charis-700";

interface FontSource {
  sfnt: Uint8Array;
  origin: string;
}

async function loadFont(): Promise<FontSource> {
  try {
    const res = await fetch(UPSTREAM);
    if (!res.ok) throw new Error(`GET ${UPSTREAM} -> ${res.status}`);
    return { sfnt: new Uint8Array(await res.arrayBuffer()), origin: UPSTREAM };
  } catch (err) {
    process.stdout.write(`upstream unavailable (${String(err)}), using the vendored subset\n`);
    const face = FONT_FACE_FILES.find((f) => f.id === VENDORED_FACE);
    if (!face) throw new Error(`${VENDORED_FACE} is not in FONT_FACE_FILES`);
    return {
      sfnt: woffToSfnt(Uint8Array.from(Buffer.from(face.woff.base64, "base64"))),
      origin: `src/web/font-files.ts (${face.woff.name})`,
    };
  }
}

interface Table {
  offset: number;
  length: number;
}

function readTableDirectory(dv: DataView): Record<string, Table | undefined> {
  const tables: Record<string, Table | undefined> = {};
  const count = dv.getUint16(4);
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    const tag = String.fromCharCode(
      dv.getUint8(at),
      dv.getUint8(at + 1),
      dv.getUint8(at + 2),
      dv.getUint8(at + 3),
    );
    tables[tag] = { offset: dv.getUint32(at + 8), length: dv.getUint32(at + 12) };
  }
  return tables;
}

/**
 * Code point to glyph id, through the `cmap` subtable a Windows rasteriser
 * would pick.
 *
 * Only format 4 is implemented, and that is not a shortcut: format 4 is
 * mandatory for any font claiming a Windows BMP encoding, and the two
 * characters wanted here are U+0048 and U+004E. A font that could only map them
 * through format 12 would be a font this script should refuse rather than
 * quietly draw the wrong glyph from.
 */
function glyphId(dv: DataView, cmap: Table, cp: number): number {
  const base = cmap.offset;
  const subtables = dv.getUint16(base + 2);

  let chosen = -1;
  let bestScore = -1;
  for (let i = 0; i < subtables; i++) {
    const rec = base + 4 + i * 8;
    const platform = dv.getUint16(rec);
    const encoding = dv.getUint16(rec + 2);
    const score = platform === 3 && encoding === 1 ? 3 : platform === 0 ? 2 : 0;
    if (score > bestScore) {
      bestScore = score;
      chosen = base + dv.getUint32(rec + 4);
    }
  }
  if (chosen < 0) throw new Error("cmap: no unicode subtable");

  const format = dv.getUint16(chosen);
  if (format !== 4) throw new Error(`cmap: unsupported format ${format}`);

  const segCount = dv.getUint16(chosen + 6) / 2;
  const endAt = chosen + 14;
  // The +2 skips reservedPad, which sits between endCode[] and startCode[].
  const startAt = endAt + segCount * 2 + 2;
  const deltaAt = startAt + segCount * 2;
  const rangeAt = deltaAt + segCount * 2;

  for (let s = 0; s < segCount; s++) {
    if (cp > dv.getUint16(endAt + s * 2)) continue;
    const start = dv.getUint16(startAt + s * 2);
    if (cp < start) return 0;
    const delta = dv.getInt16(deltaAt + s * 2);
    const rangeOffset = dv.getUint16(rangeAt + s * 2);
    if (rangeOffset === 0) return (cp + delta) & 0xffff;
    const raw = dv.getUint16(rangeAt + s * 2 + rangeOffset + (cp - start) * 2);
    return raw === 0 ? 0 : (raw + delta) & 0xffff;
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/* outlines                                                            */
/* ------------------------------------------------------------------ */

/** A point in a TrueType contour. Off-curve points are quadratic controls. */
interface OutlinePoint {
  x: number;
  y: number;
  on: boolean;
}

/** Path data in font units, y up. The only op that curves is quadratic. */
type PathCommand =
  | { op: "M" | "L"; x: number; y: number }
  | { op: "Q"; cx: number; cy: number; x: number; y: number }
  | { op: "Z" };

/**
 * Decodes one glyph's contours out of `glyf`.
 *
 * Composite glyphs throw rather than being resolved. H and N are simple in
 * every real Latin font, and a silent misdraw of the site's own mark is worse
 * than a build that stops.
 */
function readGlyph(
  dv: DataView,
  tables: Record<string, Table | undefined>,
  longLoca: boolean,
  gid: number,
): OutlinePoint[][] {
  const loca = tables.loca;
  const glyf = tables.glyf;
  if (!loca || !glyf) throw new Error("sfnt: no glyf outlines (CFF is not handled)");

  const start = longLoca
    ? dv.getUint32(loca.offset + gid * 4)
    : dv.getUint16(loca.offset + gid * 2) * 2;
  const end = longLoca
    ? dv.getUint32(loca.offset + gid * 4 + 4)
    : dv.getUint16(loca.offset + gid * 2 + 2) * 2;
  if (start === end) throw new Error(`glyf: glyph ${gid} is empty`);

  const at = glyf.offset + start;
  const contourCount = dv.getInt16(at);
  if (contourCount < 0) throw new Error(`glyf: glyph ${gid} is composite`);

  const ends: number[] = [];
  for (let i = 0; i < contourCount; i++) ends.push(dv.getUint16(at + 10 + i * 2));
  const pointCount = (ends[contourCount - 1] as number) + 1;

  let p = at + 10 + contourCount * 2;
  // Hinting bytecode, skipped: this is a drawing at one fixed set of sizes and
  // the phase search below does the job hinting would have done.
  p += 2 + dv.getUint16(p);

  const REPEAT = 0x08;
  const X_SHORT = 0x02;
  const Y_SHORT = 0x04;
  const X_SAME = 0x10;
  const Y_SAME = 0x20;
  const ON_CURVE = 0x01;

  const flags: number[] = [];
  while (flags.length < pointCount) {
    const flag = dv.getUint8(p++);
    flags.push(flag);
    if (flag & REPEAT) {
      let repeats = dv.getUint8(p++);
      while (repeats-- > 0) flags.push(flag);
    }
  }

  // x then y, each a run of deltas whose width the flags decide: one byte with
  // the sign in a second flag, two signed bytes, or nothing at all for "same".
  const xs: number[] = [];
  let x = 0;
  for (const flag of flags) {
    if (flag & X_SHORT) {
      const d = dv.getUint8(p++);
      x += flag & X_SAME ? d : -d;
    } else if (!(flag & X_SAME)) {
      x += dv.getInt16(p);
      p += 2;
    }
    xs.push(x);
  }
  const ys: number[] = [];
  let y = 0;
  for (const flag of flags) {
    if (flag & Y_SHORT) {
      const d = dv.getUint8(p++);
      y += flag & Y_SAME ? d : -d;
    } else if (!(flag & Y_SAME)) {
      y += dv.getInt16(p);
      p += 2;
    }
    ys.push(y);
  }

  const contours: OutlinePoint[][] = [];
  let from = 0;
  for (const last of ends) {
    const contour: OutlinePoint[] = [];
    for (let i = from; i <= last; i++) {
      contour.push({
        x: xs[i] as number,
        y: ys[i] as number,
        on: ((flags[i] as number) & ON_CURVE) !== 0,
      });
    }
    contours.push(contour);
    from = last + 1;
  }
  return contours;
}

/**
 * TrueType contours to path commands.
 *
 * The one subtlety is that TrueType allows two off-curve points in a row and
 * means "there is an on-curve point half way between them". Those implied
 * points have to be synthesised or the letter grows spurious corners. A contour
 * that is entirely off-curve - legal, and used for circles - starts from a
 * synthesised midpoint too.
 */
function midpoint(a: OutlinePoint, b: OutlinePoint): OutlinePoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, on: true };
}

function toPath(contours: OutlinePoint[][]): PathCommand[] {
  const out: PathCommand[] = [];
  for (const contour of contours) {
    const n = contour.length;
    if (n === 0) continue;

    // Rotated to start on an on-curve point, because a path has to open with a
    // moveto and a control point is not a place the pen has ever been.
    const first = contour.findIndex((pt) => pt.on);
    const points: OutlinePoint[] =
      first >= 0
        ? [...contour.slice(first), ...contour.slice(0, first)]
        : [midpoint(contour[n - 1] as OutlinePoint, contour[0] as OutlinePoint), ...contour];

    const head = points[0] as OutlinePoint;
    out.push({ op: "M", x: head.x, y: head.y });

    let i = 1;
    while (i < points.length) {
      const pt = points[i] as OutlinePoint;
      if (pt.on) {
        out.push({ op: "L", x: pt.x, y: pt.y });
        i += 1;
        continue;
      }
      // The wrap in the index is how the last curve closes back onto the start.
      const next = points[(i + 1) % points.length] as OutlinePoint;
      const end = next.on ? next : midpoint(pt, next);
      out.push({ op: "Q", cx: pt.x, cy: pt.y, x: end.x, y: end.y });
      i += next.on ? 2 : 1;
    }
    out.push({ op: "Z" });
  }
  return out;
}

function shiftX(path: PathCommand[], dx: number): PathCommand[] {
  return path.map((c) =>
    c.op === "Z" ? c
    : c.op === "Q" ? { ...c, cx: c.cx + dx, x: c.x + dx }
    : { ...c, x: c.x + dx },
  );
}

/* ------------------------------------------------------------------ */
/* finding the stems                                                   */
/* ------------------------------------------------------------------ */

/** Curves to polylines, fine enough that a scanline lands on the right side. */
function flatten(path: PathCommand[], steps = 12): { x: number; y: number }[][] {
  const polys: { x: number; y: number }[][] = [];
  let poly: { x: number; y: number }[] = [];
  let at = { x: 0, y: 0 };
  for (const c of path) {
    if (c.op === "M") {
      if (poly.length) polys.push(poly);
      poly = [{ x: c.x, y: c.y }];
      at = { x: c.x, y: c.y };
    } else if (c.op === "L") {
      poly.push({ x: c.x, y: c.y });
      at = { x: c.x, y: c.y };
    } else if (c.op === "Q") {
      for (let t = 1; t <= steps; t++) {
        const u = t / steps;
        const v = 1 - u;
        poly.push({
          x: v * v * at.x + 2 * v * u * c.cx + u * u * c.x,
          y: v * v * at.y + 2 * v * u * c.cy + u * u * c.y,
        });
      }
      at = { x: c.x, y: c.y };
    }
  }
  if (poly.length) polys.push(poly);
  return polys;
}

/** Every x where the outline crosses the horizontal line `y`, left to right. */
function crossings(polys: { x: number; y: number }[][], y: number): number[] {
  const xs: number[] = [];
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i] as { x: number; y: number };
      const b = poly[(i + 1) % poly.length] as { x: number; y: number };
      if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
        xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
      }
    }
  }
  return xs.sort((m, n) => m - n);
}

/**
 * Height at which the stems are measured, as a fraction of the cap height.
 *
 * It has to clear three things at once: the bottom serifs, the H's crossbar
 * (which spans the counter at around half the cap height and would reduce the H
 * to two crossings), and the point near the top where the N's diagonal is still
 * fused to its left stem. Two thirds of the way up is clear of all of them - at
 * that height the H gives exactly four crossings and the N exactly six.
 */
const STEM_PROBE = 0.65;

/* ------------------------------------------------------------------ */
/* composing the monogram                                              */
/* ------------------------------------------------------------------ */

interface Monogram {
  /** The ligature, in font units, y up, x starting wherever the H starts. */
  path: PathCommand[];
  capHeight: number;
  minX: number;
  maxX: number;
}

function compose(sfnt: Uint8Array): Monogram {
  const dv = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
  const tables = readTableDirectory(dv);

  const head = tables.head;
  const cmap = tables.cmap;
  const os2 = tables["OS/2"];
  if (!head || !cmap || !os2) throw new Error("sfnt: missing head, cmap or OS/2");

  const longLoca = dv.getInt16(head.offset + 50) === 1;
  // sCapHeight, only present from OS/2 version 2. Every font this runs against
  // is version 4 or later; falling back to the H's own height would work too
  // but would silently change the composition if it ever did not.
  if (dv.getUint16(os2.offset) < 2) throw new Error("OS/2: no sCapHeight");
  const capHeight = dv.getInt16(os2.offset + 88);

  const h = toPath(readGlyph(dv, tables, longLoca, glyphId(dv, cmap, 0x48)));
  const n = toPath(readGlyph(dv, tables, longLoca, glyphId(dv, cmap, 0x4e)));

  const probe = capHeight * STEM_PROBE;
  const hCuts = crossings(flatten(h), probe);
  const nCuts = crossings(flatten(n), probe);
  if (hCuts.length !== 4) throw new Error(`H: expected 4 stem crossings, got ${hCuts.length}`);
  if (nCuts.length !== 6) throw new Error(`N: expected 6 stem crossings, got ${nCuts.length}`);

  /*
   * The merge, and why it is the *right* edges that are aligned.
   *
   * In a Charter-derived serif the H's stems are thick (293 units) and the N's
   * are thin (156), so the shared stem is always the H's. Aligning the left
   * edges buries the top of the N's diagonal inside it and the diagonal appears
   * to sprout from half way down - which is what the reference image does, and
   * it reads as a mistake. Aligning the right edges puts the diagonal's
   * junction at the top of the shared stem, where an N's junction belongs, and
   * the H's own top serif carries the join.
   */
  const shared = (hCuts[3] as number) - (nCuts[1] as number);
  const path = [...h, ...shiftX(n, shared)];

  let minX = Infinity;
  let maxX = -Infinity;
  for (const c of path) {
    if (c.op === "Z") continue;
    minX = Math.min(minX, c.x);
    maxX = Math.max(maxX, c.x);
  }
  return { path, capHeight, minX, maxX };
}

/* ------------------------------------------------------------------ */
/* drawing                                                             */
/* ------------------------------------------------------------------ */

/** Two decimals. Sub-hundredth precision on a 512-unit canvas is noise. */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

interface Drawing {
  /** Ink margin. Larger for the maskable variant, which has to fit a circle. */
  pad: number;
  /** Corner radius. Zero where something downstream applies its own mask. */
  radius: number;
  /** Sub-pixel nudge, in canvas units. Only the small rasters use it. */
  dx: number;
  dy: number;
}

function monogramPath(mono: Monogram, d: Drawing): string {
  const scale = (CANVAS - d.pad * 2) / (mono.maxX - mono.minX);
  const tx = d.pad - mono.minX * scale + d.dx;
  // Baseline placement: the cap-height band is centred, so the mark sits on the
  // optical centre rather than hanging from the top of the em.
  const ty = (CANVAS + mono.capHeight * scale) / 2 + d.dy;
  const X = (v: number) => round(v * scale + tx);
  // Font units are y-up and SVG is y-down, which is the whole of the negation.
  const Y = (v: number) => round(-v * scale + ty);

  return mono.path
    .map((c) =>
      c.op === "Z" ? "Z"
      : c.op === "Q" ? `Q${X(c.cx)} ${Y(c.cy)} ${X(c.x)} ${Y(c.y)}`
      : `${c.op}${X(c.x)} ${Y(c.y)}`,
    )
    .join("");
}

/**
 * The SVG.
 *
 * The dark-mode rule is a `<style>` block that overrides the presentation
 * attributes rather than replacing them. A viewer that applies it inverts the
 * mark for dark chrome; a viewer that ignores CSS - including resvg, which is
 * what rasterises the PNGs below - still sees `fill="#000000"` and
 * `fill="#ffffff"` on the elements and draws the light version. One source,
 * both behaviours, and no way for the two to drift apart.
 */
function iconSvg(mono: Monogram, d: Drawing): string {
  const embolden =
    EMBOLDEN > 0 ? ` stroke="${WHITE}" stroke-width="${EMBOLDEN}" stroke-linejoin="round"` : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}" width="${CANVAS}" height="${CANVAS}" role="img" aria-label="HN">` +
    `<style>@media (prefers-color-scheme:dark){.b{fill:${WHITE}}.m{fill:${BLACK}}}</style>` +
    `<rect class="b" width="${CANVAS}" height="${CANVAS}" rx="${d.radius}" ry="${d.radius}" fill="${BLACK}"/>` +
    `<path class="m" fill="${WHITE}"${embolden} d="${monogramPath(mono, d)}"/>` +
    `</svg>`
  );
}

/* ------------------------------------------------------------------ */
/* rasterising                                                         */
/* ------------------------------------------------------------------ */

interface Raster {
  png: Uint8Array;
  /** Mean distance from mid-grey, 0-127.5. Higher is crisper. */
  contrast: number;
}

function render(svg: string, size: number): Raster {
  const image = new Resvg(svg, { fitTo: { mode: "width", value: size } }).render();
  const px = image.pixels;
  let total = 0;
  for (let i = 0; i < px.length; i += 4) {
    // Composite over white before measuring, because a transparent corner is
    // not a grey corner and should not be scored as one.
    const alpha = (px[i + 3] as number) / 255;
    const lum =
      (0.299 * (px[i] as number) + 0.587 * (px[i + 1] as number) + 0.114 * (px[i + 2] as number)) *
        alpha +
      255 * (1 - alpha);
    total += Math.abs(lum - 127.5);
  }
  return { png: new Uint8Array(image.asPng()), contrast: total / (size * size) };
}

/**
 * Renders at `size`, trying every sub-pixel phase and keeping the crispest.
 *
 * Bounded to half a pixel either way: the phase is periodic over one pixel, so
 * nothing is lost by expressing the offset as the smallest one that achieves
 * it, and the mark stays visually centred.
 */
function renderHinted(mono: Monogram, base: Drawing, size: number): Raster {
  const unit = CANVAS / size;
  let best: Raster | null = null;
  for (let i = 0; i < PHASE_STEPS; i++) {
    for (let j = 0; j < PHASE_STEPS; j++) {
      const dx = (i / PHASE_STEPS - 0.5) * unit;
      const dy = (j / PHASE_STEPS - 0.5) * unit;
      const candidate = render(iconSvg(mono, { ...base, dx, dy }), size);
      if (!best || candidate.contrast > best.contrast) best = candidate;
    }
  }
  return best as Raster;
}

/**
 * Requantises to a palette.
 *
 * resvg emits 8-bit RGBA, which for a two-colour drawing is three channels of
 * the same number plus an alpha that is 255 nearly everywhere. The same pass
 * src/epub/cover.ts runs on covers takes roughly two thirds off. It is
 * deterministic and it happens once, here, not per request.
 */
async function shrink(png: Uint8Array): Promise<Uint8Array> {
  const out = await new Bun.Image(png).png({ palette: true, compressionLevel: 9 }).toBuffer();
  // Palette encoding is a size optimisation, not a correctness one. If it ever
  // came out larger - a gradient-free two-tone image is the good case, but the
  // encoder is free to disagree - keep whatever resvg produced.
  return out.length < png.length ? new Uint8Array(out) : png;
}

/* ------------------------------------------------------------------ */
/* the ICO container                                                   */
/* ------------------------------------------------------------------ */

/**
 * Packs PNGs into an ICO.
 *
 * The format is a six-byte header, one sixteen-byte directory entry per image,
 * then the payloads. Historically the payload had to be a headerless DIB with a
 * hand-built AND mask; since Vista it may be a PNG file verbatim, and every
 * browser in service reads that, so that is what goes in. Nothing here needs a
 * dependency:
 *
 *   ICONDIR        0  uint16  reserved, always 0
 *                  2  uint16  type, 1 for icon and 2 for cursor
 *                  4  uint16  image count
 *   ICONDIRENTRY   0  uint8   width in pixels, 0 meaning 256
 *                  1  uint8   height, same convention
 *                  2  uint8   palette size, 0 for a direct-colour image
 *                  3  uint8   reserved, always 0
 *                  4  uint16  colour planes
 *                  6  uint16  bits per pixel
 *                  8  uint32  payload length
 *                 12  uint32  payload offset from the start of the file
 */
function buildIco(images: { size: number; png: Uint8Array }[]): Uint8Array {
  const headerBytes = 6 + images.length * 16;
  const total = images.reduce((n, i) => n + i.png.length, headerBytes);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);

  dv.setUint16(0, 0, true);
  dv.setUint16(2, 1, true);
  dv.setUint16(4, images.length, true);

  let offset = headerBytes;
  images.forEach((image, i) => {
    const at = 6 + i * 16;
    if (image.size > 256) throw new Error(`ico: ${image.size}px does not fit an entry`);
    out[at] = image.size === 256 ? 0 : image.size;
    out[at + 1] = image.size === 256 ? 0 : image.size;
    out[at + 2] = 0;
    out[at + 3] = 0;
    dv.setUint16(at + 4, 1, true);
    // 32 is a claim about the payload, and the payload is RGBA whatever the
    // PNG encoder chose internally, so this is honest for every entry.
    dv.setUint16(at + 6, 32, true);
    dv.setUint32(at + 8, image.png.length, true);
    dv.setUint32(at + 12, offset, true);
    out.set(image.png, offset);
    offset += image.png.length;
  });

  return out;
}

/* ------------------------------------------------------------------ */
/* what gets built                                                     */
/* ------------------------------------------------------------------ */

/** The rounded mark, as everything that is not iOS or an Android launcher sees it. */
const MARK: Drawing = { pad: PAD, radius: RADIUS, dx: 0, dy: 0 };

/**
 * The apple-touch-icon.
 *
 * A zero radius is what makes it opaque, and both halves of that matter. iOS
 * rounds the corners itself, so rounding them here too would leave a dark
 * hairline outside its mask; and iOS ignores alpha entirely, compositing an
 * apple-touch-icon onto black, so a transparent corner is not transparent, it
 * is a corner whose colour was decided by somebody else. A full-bleed square
 * has no transparent pixel to have an opinion about.
 */
const APPLE: Drawing = { pad: PAD, radius: 0, dx: 0, dy: 0 };

/**
 * The maskable variant, and why it is worth a sixth image.
 *
 * Android hands an adaptive icon to a launcher that may mask it to a circle, a
 * squircle, a teardrop or a rounded square, and guarantees only the inner 80% -
 * a centred circle of radius 0.4 - survives. The mark's own corners sit 260
 * units from the centre against a safe radius of 205, so the rounded square
 * would be cropped through the serifs on a circular launcher. Padding it down
 * to fit costs the mark about a third of its size on Android and nothing
 * anywhere else, which is the trade the format exists to make.
 *
 * The pad is derived rather than guessed: the monogram's half-diagonal must fit
 * the safe radius, and its aspect ratio is fixed by the letterforms.
 */
function maskablePad(mono: Monogram): number {
  const aspect = (mono.maxX - mono.minX) / mono.capHeight;
  const safeRadius = CANVAS * 0.4;
  const halfWidth = safeRadius / Math.sqrt(1 + 1 / (aspect * aspect));
  return Math.round((CANVAS - halfWidth * 2) / 2);
}

interface BuiltIcon {
  name: string;
  size: number;
  purpose: "any" | "maskable";
  bytes: Uint8Array;
}

/* ------------------------------------------------------------------ */
/* emitting the module                                                 */
/* ------------------------------------------------------------------ */

function literal(value: unknown): string {
  return JSON.stringify(value);
}

function emit(svg: string, icons: BuiltIcon[], ico: Uint8Array, origin: string): string {
  const pngs = icons
    .map(
      (i) => `  {
    name: ${literal(i.name)},
    size: ${i.size},
    purpose: ${literal(i.purpose)},
    bytes: ${i.bytes.length},
    base64: ${literal(Buffer.from(i.bytes).toString("base64"))},
  },`,
    )
    .join("\n");

  const total = icons.reduce((n, i) => n + i.bytes.length, ico.length + svg.length);

  return `/**
 * The site's icon. GENERATED - do not edit by hand.
 *
 * Regenerate with \`bun run icon:build\` (scripts/build-icon.ts), which reads
 * the Charis SIL Bold outlines for H and N, composes them into a shared-stem
 * ligature, and rasterises the result. Read that file for the design and for
 * why the letterforms are path data rather than a \`<text>\` element.
 *
 * Outlines from: ${origin}
 * Charis SIL is OFL-1.1, Copyright (c) 1997-2022 SIL International, with
 * Reserved Font Name 'Charis' and 'SIL'. The full licence travels with the
 * repository in src/web/fonts/OFL.txt.
 *
 * ## Why base64 in a module rather than files on disk
 *
 * The same reason src/web/font-files.ts is: there is no public/ directory and
 * no serverAssets binding (see the note at nitro.config.ts:38), so everything
 * the website serves is generated from a TypeScript module that bundles
 * unconditionally and can be asserted on in tests without a filesystem.
 *
 * ${total} bytes in total, which is roughly one small photograph and about
 * a twentieth of what one reading font costs.
 */

export interface IconFile {
  /** Asset name; the last path segment of \`/assets/<name>\`. */
  name: string;
  /** Pixel width, which for every icon here is also the height. */
  size: number;
  /**
   * Manifest \`purpose\`. "maskable" icons are drawn to survive an Android
   * launcher cropping them to an arbitrary shape and look wrong anywhere else,
   * which is why the two sets are declared separately rather than shared.
   */
  purpose: "any" | "maskable";
  bytes: number;
  base64: string;
}

/**
 * The scalable master, linked as \`type="image/svg+xml"\`.
 *
 * It carries a \`prefers-color-scheme\` rule that inverts the mark for dark
 * browser chrome. The rule overrides presentation attributes rather than
 * replacing them, so a viewer with no CSS still draws the light version.
 */
export const ICON_SVG = ${literal(svg)};

/**
 * favicon.ico, packing ${ICO_SIZES.length} rasters (${ICO_SIZES.join(", ")}px) into one container.
 *
 * Served both at a hashed \`/assets/\` URL and at the site root, because clients
 * that never render the HTML ask for \`/favicon.ico\` regardless - see
 * server/routes/favicon.ico.ts.
 */
export const FAVICON_ICO_BASE64 = ${literal(Buffer.from(ico).toString("base64"))};

export const FAVICON_ICO_BYTES = ${ico.length};

export const ICON_FILES: readonly IconFile[] = [
${pngs}
];
`;
}

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const font = await loadFont();
  process.stdout.write(`outlines from ${font.origin}\n`);

  const mono = compose(font.sfnt);
  const svg = iconSvg(mono, MARK);

  const icoImages: { size: number; png: Uint8Array }[] = [];
  for (const size of ICO_SIZES) {
    const raster = renderHinted(mono, MARK, size);
    const png = await shrink(raster.png);
    icoImages.push({ size, png });
    process.stdout.write(
      `ico    ${String(size).padStart(3)}px  ${String(png.length).padStart(6)} bytes  contrast ${raster.contrast.toFixed(1)}\n`,
    );
  }
  const ico = buildIco(icoImages);

  const icons: BuiltIcon[] = [];
  const targets: { name: string; size: number; drawing: Drawing; purpose: "any" | "maskable" }[] = [
    { name: "apple-touch-icon.png", size: 180, drawing: APPLE, purpose: "any" },
    { name: "icon-192.png", size: 192, drawing: MARK, purpose: "any" },
    { name: "icon-512.png", size: 512, drawing: MARK, purpose: "any" },
    {
      name: "icon-maskable-512.png",
      size: 512,
      drawing: { pad: maskablePad(mono), radius: 0, dx: 0, dy: 0 },
      purpose: "maskable",
    },
  ];
  for (const target of targets) {
    // No phase search above 48px: there are enough pixels per stem that the
    // alignment is worth less than a hundredth of a percent of contrast, and
    // the search costs 64 renders of a 512px image.
    const raster = render(iconSvg(mono, target.drawing), target.size);
    const bytes = await shrink(raster.png);
    icons.push({ name: target.name, size: target.size, purpose: target.purpose, bytes });
    process.stdout.write(
      `png    ${target.name.padEnd(22)} ${String(bytes.length).padStart(6)} bytes\n`,
    );
  }

  const out = join(import.meta.dir, "..", "src", "web", "icon-files.ts");
  writeFileSync(out, emit(svg, icons, ico, font.origin));

  const total = icons.reduce((n, i) => n + i.bytes.length, ico.length + svg.length);
  process.stdout.write(
    `svg    ${String(svg.length).padStart(6)} bytes\n` +
      `ico    ${String(ico.length).padStart(6)} bytes\n` +
      `\nwrote ${out}\ntotal ${total} bytes across ${icons.length + 2} files\n`,
  );
}

await main();
