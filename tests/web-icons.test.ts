/**
 * The site's icon: the generated payloads, the asset registry around them, and
 * the manifest entries that point at them.
 *
 * The payloads are hand-built binary containers, and the failure modes they
 * have are all silent. A malformed ICO directory does not error anywhere - the
 * browser renders nothing and the tab keeps its default square. A PNG whose
 * IHDR disagrees with the size the manifest claims is accepted by the decoder
 * and then scaled by the launcher. An SVG that kept a `<text>` element instead
 * of its outlines looks perfect on the machine that generated it, because that
 * machine has Charis SIL installed, and looks like Times New Roman everywhere
 * else. So the containers are parsed here rather than trusted.
 *
 * Nothing in this file touches the network or the filesystem: the icon was
 * drawn into `src/web/icon-files.ts` by `scripts/build-icon.ts` at author time,
 * which is the same bargain `src/web/font-files.ts` makes.
 */
import { describe, expect, test } from "bun:test";

import {
  APPLE_TOUCH_ICON_URL,
  FAVICON_ICO_URL,
  ICON_SVG_URL,
  MANIFEST_URL,
  getWebAsset,
  webAssetNames,
} from "~/web/assets";
import { FAVICON_ICO_BASE64, FAVICON_ICO_BYTES, ICON_FILES, ICON_SVG } from "~/web/icon-files";
import {
  FAVICON_ICO_NAME,
  FAVICON_PATH,
  ICON_SVG_NAME,
  getIconAsset,
  iconUrls,
  manifestIcons,
} from "~/web/icons";
import { webManifest } from "~/web/sw";

const ICO = Uint8Array.from(Buffer.from(FAVICON_ICO_BASE64, "base64"));

/** The registry key behind an `/assets/<name>?v=...` URL. */
function assetNameOf(url: string): string {
  return url.slice("/assets/".length).split("?")[0] as string;
}

/** The eight bytes every PNG file starts with, per the spec's section 5.2. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Width and height out of a PNG's IHDR.
 *
 * IHDR is required to be the first chunk, so its fields sit at fixed offsets:
 * eight bytes of signature, four of chunk length, four of chunk type, then two
 * big-endian 32-bit dimensions.
 */
function pngSize(png: Uint8Array): { width: number; height: number } {
  for (const [i, byte] of PNG_SIGNATURE.entries()) {
    expect(png[i]).toBe(byte);
  }
  expect(String.fromCharCode(...png.subarray(12, 16))).toBe("IHDR");
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}

interface IcoEntry {
  width: number;
  height: number;
  planes: number;
  bitCount: number;
  payload: Uint8Array;
}

/** Reads the ICONDIR and its ICONDIRENTRYs. Byte layout in scripts/build-icon.ts. */
function readIco(ico: Uint8Array): IcoEntry[] {
  const dv = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);
  expect(dv.getUint16(0, true)).toBe(0);
  expect(dv.getUint16(2, true)).toBe(1);
  const count = dv.getUint16(4, true);

  const entries: IcoEntry[] = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16;
    const length = dv.getUint32(at + 8, true);
    const offset = dv.getUint32(at + 12, true);
    entries.push({
      // A zero in the size byte means 256; nothing here is that big, but
      // reading it the way the format defines it keeps the assertion honest.
      width: (ico[at] as number) || 256,
      height: (ico[at + 1] as number) || 256,
      planes: dv.getUint16(at + 4, true),
      bitCount: dv.getUint16(at + 6, true),
      payload: ico.subarray(offset, offset + length),
    });
  }
  return entries;
}

/* ------------------------------------------------------------------ */

describe("the SVG master", () => {
  test("is a drawing, not a typographic instruction", () => {
    /*
     * The whole reason scripts/build-icon.ts parses a `glyf` table. A `<text>`
     * element would render in the viewer's fallback face, and the viewers here
     * are browsers, feed readers and unfurlers, none of which have this site's
     * webfonts.
     */
    expect(ICON_SVG).not.toContain("<text");
    expect(ICON_SVG).not.toContain("font-family");
    expect(ICON_SVG).not.toContain("@font-face");
  });

  test("carries real path data for both letters", () => {
    const path = /<path[^>]*\bd="([^"]+)"/.exec(ICON_SVG);
    expect(path).not.toBeNull();
    const d = path![1] as string;
    // Two subpaths, because H and N are one closed contour each and neither
    // letter has a counter that needs a second.
    expect(d.match(/M/g)?.length).toBe(2);
    expect(d).toContain("Q");
    expect(d.endsWith("Z")).toBe(true);
  });

  test("is a square viewBox with no intrinsic colour beyond black and white", () => {
    expect(ICON_SVG).toContain('viewBox="0 0 512 512"');
    const colours = new Set(ICON_SVG.match(/#[0-9a-f]{3,6}/g) ?? []);
    expect([...colours].sort()).toEqual(["#000000", "#ffffff"]);
  });

  test("inverts itself for dark browser chrome", () => {
    expect(ICON_SVG).toContain("prefers-color-scheme:dark");
  });

  test("still draws the light version where CSS is not applied", () => {
    // The dark rule overrides presentation attributes rather than replacing
    // them, so a viewer with no CSS - resvg, which rasterised the PNGs, among
    // them - falls back to a black square with a white mark.
    expect(ICON_SVG).toContain('<rect class="b"');
    expect(ICON_SVG).toContain('fill="#000000"/>');
    expect(ICON_SVG).toContain('<path class="m" fill="#ffffff"');
  });
});

describe("favicon.ico", () => {
  test("declares its own byte count", () => {
    expect(ICO.length).toBe(FAVICON_ICO_BYTES);
  });

  test("is an icon, not a cursor, and holds three images", () => {
    // readIco asserts the reserved word and the type on the way in.
    expect(readIco(ICO)).toHaveLength(3);
  });

  test("packs exactly 16, 32 and 48", () => {
    const entries = readIco(ICO);
    expect(entries.map((e) => e.width)).toEqual([16, 32, 48]);
    // Square, and stated as such: a directory entry carries both dimensions
    // and a browser trusts them over the payload.
    expect(entries.map((e) => e.height)).toEqual([16, 32, 48]);
  });

  test("every directory entry points at a PNG of the size it claims", () => {
    for (const entry of readIco(ICO)) {
      expect(entry.payload.length).toBeGreaterThan(0);
      expect(pngSize(entry.payload)).toEqual({ width: entry.width, height: entry.height });
    }
  });

  test("declares one colour plane and 32 bits per pixel", () => {
    for (const entry of readIco(ICO)) {
      expect(entry.planes).toBe(1);
      expect(entry.bitCount).toBe(32);
    }
  });

  test("the payloads sit inside the file and do not overlap", () => {
    const dv = new DataView(ICO.buffer, ICO.byteOffset, ICO.byteLength);
    const count = dv.getUint16(4, true);
    let cursor = 6 + count * 16;
    for (let i = 0; i < count; i++) {
      const at = 6 + i * 16;
      const length = dv.getUint32(at + 8, true);
      const offset = dv.getUint32(at + 12, true);
      // Offsets are absolute from the start of the file, and an off-by-one in
      // the running total is the one bug a container writer actually makes.
      expect(offset).toBe(cursor);
      cursor += length;
    }
    expect(cursor).toBe(ICO.length);
  });
});

describe("the PNG rasters", () => {
  test("are the four the site ships", () => {
    expect(ICON_FILES.map((f) => f.name)).toEqual([
      "apple-touch-icon.png",
      "icon-192.png",
      "icon-512.png",
      "icon-maskable-512.png",
    ]);
  });

  test("each decodes to the square its record claims", () => {
    for (const file of ICON_FILES) {
      const bytes = Uint8Array.from(Buffer.from(file.base64, "base64"));
      expect(bytes.length).toBe(file.bytes);
      expect(pngSize(bytes)).toEqual({ width: file.size, height: file.size });
    }
  });

  test("iOS gets 180, which is the size it asks for", () => {
    const apple = ICON_FILES.find((f) => f.name === "apple-touch-icon.png");
    expect(apple?.size).toBe(180);
  });

  test("exactly one is maskable, and it is a 512", () => {
    const maskable = ICON_FILES.filter((f) => f.purpose === "maskable");
    expect(maskable).toHaveLength(1);
    expect(maskable[0]?.size).toBe(512);
  });
});

describe("the icon assets", () => {
  test("every icon is registered under the name the site links", () => {
    const names = webAssetNames();
    for (const name of [ICON_SVG_NAME, FAVICON_ICO_NAME, ...ICON_FILES.map((f) => f.name)]) {
      expect(names).toContain(name);
      expect(getIconAsset(name)).not.toBeNull();
    }
  });

  test("declares the content types the consumers actually switch on", () => {
    expect(getWebAsset(ICON_SVG_NAME)!.type).toBe("image/svg+xml; charset=utf-8");
    // Not the registered image/vnd.microsoft.icon - see the note in ~/web/icons.
    expect(getWebAsset(FAVICON_ICO_NAME)!.type).toBe("image/x-icon");
    for (const file of ICON_FILES) {
      expect(getWebAsset(file.name)!.type).toBe("image/png");
    }
  });

  test("the binary ones serve bytes rather than a string", () => {
    // A PNG put through a JS string would be UTF-8 encoded into the Response
    // and every byte above 0x7f would be corrupted.
    for (const name of [FAVICON_ICO_NAME, ...ICON_FILES.map((f) => f.name)]) {
      expect(getWebAsset(name)!.body).toBeInstanceOf(Uint8Array);
    }
    expect(typeof getWebAsset(ICON_SVG_NAME)!.body).toBe("string");
  });

  test("decoding is idempotent, because the body is a lazy getter", () => {
    const asset = getWebAsset(FAVICON_ICO_NAME)!;
    expect(asset.body).toBe(asset.body);
    expect(asset.body.length).toBe(FAVICON_ICO_BYTES);
  });

  test("are immutable, because every URL that names them carries a hash", () => {
    for (const url of iconUrls()) {
      expect(url).toMatch(/^\/assets\/[\w.-]+\?v=[0-9a-f]{8}$/);
      expect(getWebAsset(assetNameOf(url))!.immutable).toBe(true);
    }
  });

  test("no two icons share an ETag, so one cannot be revalidated as another", () => {
    const etags = iconUrls().map((url) => getWebAsset(assetNameOf(url))!.etag);
    expect(new Set(etags).size).toBe(etags.length);
  });

  test("the exported URLs point at the right assets", () => {
    expect(assetNameOf(ICON_SVG_URL)).toBe(ICON_SVG_NAME);
    expect(assetNameOf(FAVICON_ICO_URL)).toBe(FAVICON_ICO_NAME);
    expect(assetNameOf(APPLE_TOUCH_ICON_URL)).toBe("apple-touch-icon.png");
    for (const url of [ICON_SVG_URL, FAVICON_ICO_URL, APPLE_TOUCH_ICON_URL]) {
      expect(iconUrls()).toContain(url);
    }
  });

  test("the root favicon path is not an assets URL", () => {
    // It cannot be. Its whole purpose is to be the path a client guesses.
    expect(FAVICON_PATH).toBe("/favicon.ico");
    expect(FAVICON_PATH).not.toContain("/assets/");
    expect(FAVICON_PATH).not.toContain("?");
  });
});

describe("the manifest's icons", () => {
  const parsed = JSON.parse(getWebAsset(assetNameOf(MANIFEST_URL))!.body as string) as {
    icons: { src: string; sizes: string; type: string; purpose: string }[];
  };

  test("are what manifestIcons() produces", () => {
    expect(parsed.icons).toEqual(manifestIcons());
  });

  test("every entry resolves to a registered asset", () => {
    expect(parsed.icons.length).toBeGreaterThan(0);
    for (const icon of parsed.icons) {
      expect(getWebAsset(assetNameOf(icon.src))).not.toBeNull();
    }
  });

  test("every entry states the size the PNG actually is", () => {
    for (const icon of parsed.icons) {
      const bytes = getWebAsset(assetNameOf(icon.src))!.body as Uint8Array;
      const { width, height } = pngSize(bytes);
      expect(icon.sizes).toBe(`${width}x${height}`);
      expect(icon.type).toBe("image/png");
    }
  });

  test("offers both a plain and a maskable icon", () => {
    /*
     * An installer that finds only `any` icons crops the rounded square through
     * the serifs on a circular launcher; one that finds only `maskable` draws
     * the padded-down variant at full size everywhere and it looks lost.
     */
    expect(parsed.icons.some((i) => i.purpose === "any")).toBe(true);
    expect(parsed.icons.some((i) => i.purpose === "maskable")).toBe(true);
  });

  test("never claims one image is both", () => {
    for (const icon of parsed.icons) {
      expect(icon.purpose).not.toContain(" ");
    }
  });

  test("leaves the apple-touch-icon out", () => {
    // iOS reads no manifest, and the square opaque variant it needs is wrong
    // for a launcher that composites the icon itself.
    for (const icon of parsed.icons) {
      expect(icon.src).not.toContain("apple-touch-icon");
    }
  });

  test("does not disturb the rest of the manifest", () => {
    const manifest = JSON.parse(webManifest()) as Record<string, unknown>;
    expect(manifest.start_url).toBe("/");
    expect(manifest.background_color).toBe("#ffffff");
    expect(manifest.theme_color).toBe("#000000");
  });
});
