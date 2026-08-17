/**
 * Just enough OpenType to draw a cover: WOFF unpacking and horizontal metrics.
 *
 * ## Why this exists
 *
 * Covers are SVG rasterised by resvg, and an SVG has no line breaking: text is
 * placed, not flowed. Wrapping a headline therefore needs the advance width of
 * a string *before* it is drawn. resvg will not tell us (it exposes one bounding
 * box for the whole document, and only after a ~15ms construction), so the
 * widths are read out of the font itself.
 *
 * ## Why WOFF rather than a checked-in TTF
 *
 * The repository already ships Charis SIL, subset and OFL-licensed, as base64
 * WOFF in `~/web/font-files` - the same face the website sets its body text in.
 * Adding a second copy of the same typeface as a TTF would be ~40 KB of
 * duplicated binary in source control and a second thing to keep in step with
 * `scripts/build-fonts.ts`.
 *
 * WOFF 1 is a thin wrapper: a header, a table directory, and each table
 * optionally zlib-deflated. Undoing that is the function below and it is
 * exact - the reconstructed sfnt is byte-for-byte the tables the subsetter
 * emitted. (WOFF 2 is not: it re-encodes `glyf`/`loca` and needs a brotli
 * decoder plus a transform reversal, which is why the woff2 payload is left
 * alone here.)
 *
 * Everything in this module is pure and synchronous. Nothing reads the clock,
 * the network or the config, so a cover built from it is reproducible.
 */
import { inflateSync } from "node:zlib";

const WOFF_SIGNATURE = 0x774f4646; // "wOFF"

/** Round up to the next 4-byte boundary, as sfnt table alignment requires. */
function pad4(n: number): number {
  return (n + 3) & ~3;
}

function tag(dv: DataView, at: number): string {
  return String.fromCharCode(
    dv.getUint8(at),
    dv.getUint8(at + 1),
    dv.getUint8(at + 2),
    dv.getUint8(at + 3),
  );
}

/**
 * Rebuilds the original sfnt (TTF/OTF) from a WOFF 1 container.
 *
 * The output is a complete font file, suitable for handing to a rasteriser
 * that only understands sfnt - which is every one of them, resvg included.
 */
export function woffToSfnt(woff: Uint8Array): Uint8Array {
  if (woff.byteLength < 44) throw new Error("woff: truncated header");
  const dv = new DataView(woff.buffer, woff.byteOffset, woff.byteLength);
  if (dv.getUint32(0) !== WOFF_SIGNATURE) throw new Error("woff: bad signature");

  const flavor = dv.getUint32(4);
  const numTables = dv.getUint16(12);

  interface Entry {
    tag: number;
    offset: number;
    compLength: number;
    origLength: number;
    checksum: number;
  }

  const entries: Entry[] = [];
  for (let i = 0; i < numTables; i++) {
    const at = 44 + i * 20;
    if (at + 20 > woff.byteLength) throw new Error("woff: truncated table directory");
    entries.push({
      tag: dv.getUint32(at),
      offset: dv.getUint32(at + 4),
      compLength: dv.getUint32(at + 8),
      origLength: dv.getUint32(at + 12),
      checksum: dv.getUint32(at + 16),
    });
  }
  // The spec already requires ascending tag order, but sorting makes the
  // output independent of a producer that got that wrong.
  entries.sort((a, b) => a.tag - b.tag);

  let total = 12 + numTables * 16;
  for (const e of entries) total += pad4(e.origLength);

  const out = new Uint8Array(total);
  const odv = new DataView(out.buffer);

  // The three search hints are derived, not copied: WOFF drops them and a
  // reader that trusts them needs them consistent with numTables.
  const pow2 = numTables > 0 ? 2 ** Math.floor(Math.log2(numTables)) : 0;
  odv.setUint32(0, flavor);
  odv.setUint16(4, numTables);
  odv.setUint16(6, pow2 * 16);
  odv.setUint16(8, pow2 > 0 ? Math.log2(pow2) : 0);
  odv.setUint16(10, numTables * 16 - pow2 * 16);

  let cursor = 12 + numTables * 16;
  entries.forEach((e, i) => {
    const rec = 12 + i * 16;
    odv.setUint32(rec, e.tag);
    odv.setUint32(rec + 4, e.checksum);
    odv.setUint32(rec + 8, cursor);
    odv.setUint32(rec + 12, e.origLength);

    const raw = woff.subarray(e.offset, e.offset + e.compLength);
    // compLength === origLength means the table was stored, not deflated.
    const data = e.compLength === e.origLength ? raw : new Uint8Array(inflateSync(raw));
    if (data.byteLength !== e.origLength) {
      throw new Error(`woff: table ${e.tag.toString(16)} inflated to the wrong size`);
    }
    out.set(data, cursor);
    cursor += pad4(e.origLength);
  });

  return out;
}

export interface FontMetrics {
  /** Design units per em; advances are in these units. */
  unitsPerEm: number;
  /** True when the font can actually draw this code point. */
  has(cp: number): boolean;
  /** Advance width in font units. Unmapped code points measure as `.notdef`. */
  advance(cp: number): number;
  /**
   * Width of `text` set at `fontSize`, in the same units as `fontSize`.
   *
   * Kerning is not applied. It moves a Charis line by well under a percent,
   * and every caller here compares the result against a box with a margin
   * wider than that.
   */
  measure(text: string, fontSize: number, letterSpacing?: number): number;
}

interface TableMap {
  [tagName: string]: { offset: number; length: number } | undefined;
}

function readTables(dv: DataView): TableMap {
  const numTables = dv.getUint16(4);
  const tables: TableMap = {};
  for (let i = 0; i < numTables; i++) {
    const at = 12 + i * 16;
    tables[tag(dv, at)] = { offset: dv.getUint32(at + 8), length: dv.getUint32(at + 12) };
  }
  return tables;
}

/**
 * Character-to-glyph map, expanded eagerly into a plain `Map`.
 *
 * Eager expansion is only reasonable because the fonts loaded here are the
 * repository's own subsets - a few hundred code points each. The cap keeps a
 * hostile or unexpectedly complete font from allocating unboundedly.
 */
const MAX_CMAP_ENTRIES = 65_536;

function readCmap(dv: DataView, base: number): Map<number, number> {
  const map = new Map<number, number>();
  const numSubtables = dv.getUint16(base + 2);

  let best = -1;
  let bestScore = -1;
  for (let i = 0; i < numSubtables; i++) {
    const rec = base + 4 + i * 8;
    const platform = dv.getUint16(rec);
    const encoding = dv.getUint16(rec + 2);
    const offset = dv.getUint32(rec + 4);
    // Windows full-repertoire first, then Windows BMP, then anything Unicode.
    const score =
      platform === 3 && encoding === 10 ? 4
      : platform === 3 && encoding === 1 ? 3
      : platform === 0 ? 2
      : 0;
    if (score > bestScore) {
      bestScore = score;
      best = base + offset;
    }
  }
  if (best < 0) return map;

  const format = dv.getUint16(best);
  if (format === 4) {
    const segCount = dv.getUint16(best + 6) / 2;
    const endAt = best + 14;
    const startAt = endAt + segCount * 2 + 2;
    const deltaAt = startAt + segCount * 2;
    const rangeAt = deltaAt + segCount * 2;
    for (let s = 0; s < segCount; s++) {
      const end = dv.getUint16(endAt + s * 2);
      const start = dv.getUint16(startAt + s * 2);
      const delta = dv.getInt16(deltaAt + s * 2);
      const rangeOffset = dv.getUint16(rangeAt + s * 2);
      if (start > end) continue;
      for (let cp = start; cp <= end && cp !== 0xffff; cp++) {
        if (map.size >= MAX_CMAP_ENTRIES) return map;
        let gid: number;
        if (rangeOffset === 0) {
          gid = (cp + delta) & 0xffff;
        } else {
          const at = rangeAt + s * 2 + rangeOffset + (cp - start) * 2;
          if (at + 1 >= dv.byteLength) continue;
          const raw = dv.getUint16(at);
          if (raw === 0) continue;
          gid = (raw + delta) & 0xffff;
        }
        if (gid !== 0) map.set(cp, gid);
      }
    }
    return map;
  }

  if (format === 12) {
    const numGroups = dv.getUint32(best + 12);
    for (let g = 0; g < numGroups; g++) {
      const at = best + 16 + g * 12;
      const start = dv.getUint32(at);
      const end = dv.getUint32(at + 4);
      const startGid = dv.getUint32(at + 8);
      for (let cp = start; cp <= end; cp++) {
        if (map.size >= MAX_CMAP_ENTRIES) return map;
        map.set(cp, startGid + (cp - start));
      }
    }
    return map;
  }

  // Formats 0, 6 and 13 exist but none of the subsetter's output uses them; an
  // empty map degrades to "no glyph for anything", which the caller detects.
  return map;
}

/**
 * Reads `head`, `hhea`, `hmtx` and `cmap` out of an sfnt.
 *
 * Deliberately not a font parser: no outlines, no layout tables, no shaping.
 * The one question asked of a font here is "how wide is this string", and the
 * answer only needs the horizontal metrics.
 */
export function readMetrics(sfnt: Uint8Array): FontMetrics {
  const dv = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
  const tables = readTables(dv);

  const head = tables.head;
  const hhea = tables.hhea;
  const hmtx = tables.hmtx;
  const cmap = tables.cmap;
  if (!head || !hhea || !hmtx || !cmap) throw new Error("sfnt: missing a required table");

  const unitsPerEm = dv.getUint16(head.offset + 18) || 1000;
  const numHMetrics = dv.getUint16(hhea.offset + 34);
  const chars = readCmap(dv, cmap.offset);

  const advanceOf = (gid: number): number => {
    // Past `numberOfHMetrics` every glyph shares the last advance; that is how
    // hmtx compresses monospaced tails such as a subset's CJK ideographs.
    const index = Math.min(gid, Math.max(0, numHMetrics - 1));
    const at = hmtx.offset + index * 4;
    if (at + 1 >= sfnt.byteLength) return 0;
    return dv.getUint16(at);
  };

  const notdef = advanceOf(0);

  return {
    unitsPerEm,
    has: (cp) => chars.has(cp),
    advance: (cp) => {
      const gid = chars.get(cp);
      return gid === undefined ? notdef : advanceOf(gid);
    },
    measure(text, fontSize, letterSpacing = 0) {
      let units = 0;
      let glyphs = 0;
      // Iterating the string yields code points, not UTF-16 units, so an
      // astral character is measured once rather than twice.
      for (const ch of text) {
        units += this.advance(ch.codePointAt(0) as number);
        glyphs += 1;
      }
      return (units * fontSize) / unitsPerEm + letterSpacing * glyphs;
    },
  };
}
