/**
 * The font unpacker and its metrics.
 *
 * Everything here runs against the repository's own checked-in WOFF payloads,
 * so there is no network, no fixture and no host font involved.
 *
 * The last case is the one that matters: it renders a string with resvg and
 * compares the measured advance against the ink resvg actually produced. Wrap
 * decisions on a cover are made from `measure`, so a parser that is subtly
 * wrong would not fail loudly - it would silently set headlines through the
 * frame, or two sizes smaller than they needed to be.
 */
import { describe, expect, test } from "bun:test";
import { Resvg } from "@resvg/resvg-js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readMetrics, woffToSfnt } from "~/epub/sfnt";
import { FONT_FACE_FILES } from "~/web/font-files";

function faceBytes(id: string): Uint8Array {
  const face = FONT_FACE_FILES.find((f) => f.id === id);
  if (!face) throw new Error(`no such face: ${id}`);
  return Uint8Array.from(Buffer.from(face.woff.base64, "base64"));
}

const BOLD = woffToSfnt(faceBytes("charis-700"));
const metrics = readMetrics(BOLD);

function tag(bytes: Uint8Array, at: number): string {
  return new TextDecoder().decode(bytes.subarray(at, at + 4));
}

describe("woffToSfnt", () => {
  test("produces a TrueType font, not the WOFF it started from", () => {
    // 0x00010000 is the sfnt version for TrueType outlines; "wOFF" is what the
    // input started with, and a passthrough bug would leave it there.
    expect(Array.from(BOLD.subarray(0, 4))).toEqual([0x00, 0x01, 0x00, 0x00]);
    expect(tag(BOLD, 0)).not.toBe("wOFF");
  });

  test("carries the tables a rasteriser needs, in ascending tag order", () => {
    const numTables = new DataView(BOLD.buffer, BOLD.byteOffset).getUint16(4);
    const tags: string[] = [];
    for (let i = 0; i < numTables; i++) tags.push(tag(BOLD, 12 + i * 16));

    for (const required of ["cmap", "glyf", "head", "hhea", "hmtx", "loca", "maxp"]) {
      expect(tags).toContain(required);
    }
    expect([...tags].sort()).toEqual(tags);
  });

  test("every table record points inside the file", () => {
    const dv = new DataView(BOLD.buffer, BOLD.byteOffset, BOLD.byteLength);
    const numTables = dv.getUint16(4);
    for (let i = 0; i < numTables; i++) {
      const offset = dv.getUint32(12 + i * 16 + 8);
      const length = dv.getUint32(12 + i * 16 + 12);
      expect(offset + length).toBeLessThanOrEqual(BOLD.byteLength);
      // Tables must start on a four-byte boundary.
      expect(offset % 4).toBe(0);
    }
  });

  test("is deterministic", () => {
    const again = woffToSfnt(faceBytes("charis-700"));
    expect(Buffer.from(BOLD).equals(Buffer.from(again))).toBe(true);
  });

  test("rejects something that is not a WOFF", () => {
    expect(() => woffToSfnt(new Uint8Array(64))).toThrow(/signature/);
    expect(() => woffToSfnt(new Uint8Array(4))).toThrow(/truncated/);
  });
});

describe("readMetrics", () => {
  test("reads the design grid", () => {
    expect(metrics.unitsPerEm).toBe(2048);
  });

  test("knows what the subset can and cannot draw", () => {
    expect(metrics.has(0x41)).toBe(true); // A
    expect(metrics.has(0xe9)).toBe(true); // e-acute, in Latin-1
    expect(metrics.has(0x2026)).toBe(true); // ellipsis, used when truncating
    expect(metrics.has(0xfffd)).toBe(true); // replacement mark, used for the rest
    // Deliberately outside the subset - see UNICODES in scripts/build-fonts.ts.
    expect(metrics.has(0x4e2d)).toBe(false);
  });

  test("gives wide letters wider advances", () => {
    expect(metrics.advance(0x57)).toBeGreaterThan(metrics.advance(0x69)); // W > i
    expect(metrics.advance(0x20)).toBeGreaterThan(0); // space is not free
  });

  test("measures proportionally to the type size", () => {
    const at50 = metrics.measure("Hacker News", 50);
    const at100 = metrics.measure("Hacker News", 100);
    expect(at100).toBeCloseTo(at50 * 2, 6);
  });

  test("counts an astral character once", () => {
    // "\u{1D400}" is one code point in two UTF-16 units. Measuring per unit
    // would double-count it.
    const one = metrics.measure("\u{1D400}", 100);
    expect(one).toBe(metrics.advance(0x1d400) * 100 / metrics.unitsPerEm);
  });

  test("adds letter spacing per glyph", () => {
    const plain = metrics.measure("ABC", 100);
    expect(metrics.measure("ABC", 100, 10)).toBeCloseTo(plain + 30, 6);
  });

  test("measures an empty string as nothing", () => {
    expect(metrics.measure("", 100)).toBe(0);
  });
});

describe("measurement against the rasteriser", () => {
  /**
   * Predicted advance versus the ink resvg draws.
   *
   * The two are not the same quantity - a bounding box excludes the last
   * glyph's right side bearing and any kerning resvg applied - so the check is
   * that the prediction is within a few percent and never *under*. Erring
   * narrow is safe (a headline set one size smaller than it had to be); erring
   * wide is not (a headline through the frame).
   */
  test("predicts within a few percent, and never short", () => {
    const dir = mkdtempSync(join(tmpdir(), "hn-opds-sfnt-"));
    const path = join(dir, "bold.ttf");
    writeFileSync(path, BOLD);

    try {
      for (const text of ["Hacker News", "Good system design", "WWWWW", "iiiii"]) {
        const size = 100;
        const svg =
          `<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="400">` +
          `<text x="0" y="200" font-family="Charis SIL" font-weight="700" font-size="${size}">${text}</text></svg>`;
        const bbox = new Resvg(svg, {
          font: { loadSystemFonts: false, fontFiles: [path] },
        }).getBBox();

        expect(bbox).toBeDefined();
        const predicted = metrics.measure(text, size);
        expect(predicted).toBeGreaterThanOrEqual(bbox!.width);
        expect(predicted / bbox!.width).toBeLessThan(1.06);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
