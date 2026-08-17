/**
 * Downloads the images an article references and rewrites them to point at
 * copies stored inside the EPUB.
 *
 * Without this an `<img src="https://...">` is simply a dead link: e-readers
 * are usually offline when the book is opened, so the reader sees a blank box
 * or a broken-image glyph. Embedding is the only way an image ever appears.
 *
 * Three transformations happen on the way in, all aimed at e-ink:
 *
 *   - SVG is rasterised first. `Bun.Image` cannot decode SVG at all, and most
 *     e-readers either ignore it or render it badly, so resvg turns it into a
 *     bitmap over a white background (SVG line art is usually drawn in black
 *     with a transparent background, which would otherwise composite to black
 *     on black).
 *   - Everything is desaturated. The screen is greyscale, so colour is wasted
 *     bytes, and letting us do the conversion gives a better result than the
 *     device's own naive channel-averaging.
 *   - Everything is capped at `imageMaxWidth`. A 4000px screenshot costs
 *     megabytes and displays no better than an 800px one on a 300ppi panel.
 *
 * Failure is never fatal. A book with a missing figure is worth far more than
 * no book, so a failed image is dropped from the markup and the build carries
 * on.
 *
 * Processed bytes are cached in the `assets` store, so rebuilding a book (to
 * pick up a template change, say) reuses the earlier download instead of
 * hitting the origin again.
 */
import pLimit from "p-limit";
import { Resvg, type ResvgRenderOptions } from "@resvg/resvg-js";

import { config, userAgent } from "~/config";
import { isAllowed } from "~/core/fetcher";
import { log } from "~/log";
import { assetVariant, linkStoryAssets, lookupAsset, putAsset } from "~/epub/assets";
import type { AssetBytes } from "~/epub/assets";
import type { EpubResource } from "~/epub/package";

/** Cap per book. Pathological pages (image galleries) would otherwise stall a build. */
const MAX_IMAGES = 60;

/**
 * Font options handed to resvg. Undefined in production, which is resvg's
 * default of loading the system font database -- required, because an SVG may
 * render `<text>` and there is no way to know before parsing it.
 *
 * Test seam. Building the font database costs ~590ms per `Resvg` construction
 * on macOS no matter how trivial the document is, which was 1.6s of a 3s test
 * suite. Tests rasterise text-free shapes, so they set `loadSystemFonts: false`
 * and keep the real rasteriser -- and every assertion about it -- intact.
 */
let svgFontOptions: ResvgRenderOptions["font"];

/** Test seam: see `svgFontOptions`. Pass undefined to restore the default. */
export function setSvgFontOptionsForTests(font: ResvgRenderOptions["font"]): void {
  svgFontOptions = font;
}

const IMG_TAG = /<img\b[^>]*>/gi;
const SRC_ATTR = /\bsrc="([^"]*)"/i;

export interface EmbedResult {
  xhtml: string;
  resources: EpubResource[];
  embedded: number;
  failed: number;
}

interface Prepared {
  data: Uint8Array<ArrayBuffer>;
  mediaType: string;
  ext: string;
  width: number | null;
  height: number | null;
}

/** Extracts unique http(s) image URLs, in document order. */
export function imageUrls(xhtml: string): string[] {
  const seen = new Set<string>();
  for (const tag of xhtml.match(IMG_TAG) ?? []) {
    const src = tag.match(SRC_ATTR)?.[1];
    if (!src) continue;
    // `toXhtmlFragment` has already absolutised and protocol-filtered these,
    // so anything else is not something we can fetch.
    if (!/^https?:\/\//i.test(src)) continue;
    seen.add(decodeEntities(src));
  }
  return [...seen];
}

/** The serialiser escapes `&` in attribute values; fetch needs the raw URL. */
function decodeEntities(value: string): string {
  return value
    .replace(/&(?:amp|#x26|#38);/gi, "&")
    .replace(/&(?:lt|#x3c|#60);/gi, "<")
    .replace(/&(?:gt|#x3e|#62);/gi, ">")
    .replace(/&(?:quot|#x22|#34);/gi, '"');
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&#x26;").replace(/"/g, "&#x22;").replace(/</g, "&#x3c;");
}

/**
 * Re-encodes to greyscale at a sane width.
 *
 * Both PNG and JPEG are produced and the smaller wins. The right choice is
 * content-dependent rather than format-dependent: flat line art (the common
 * case for the diagrams articles embed) compresses far better as PNG, while
 * photographs compress far better as JPEG. Guessing from the source format
 * gets it wrong often enough that measuring is worth the extra encode.
 */
export async function processImage(input: Uint8Array, contentType: string): Promise<Prepared> {
  const cfg = config();
  let raw = input;

  if (/svg/i.test(contentType)) {
    const svg = new TextDecoder().decode(input);
    raw = new Resvg(svg, {
      fitTo: { mode: "width", value: cfg.imageMaxWidth },
      background: "white",
      font: svgFontOptions,
    })
      .render()
      .asPng();
  }

  const shrink = () =>
    new Bun.Image(raw)
      .resize(cfg.imageMaxWidth, undefined, { withoutEnlargement: true })
      .modulate({ saturation: 0 });

  const [png, jpeg] = await Promise.all([
    shrink().png().toBuffer(),
    shrink().jpeg({ quality: cfg.imageQuality }).toBuffer(),
  ]);

  const chosen: Prepared =
    png.length <= jpeg.length
      ? { data: new Uint8Array(png), mediaType: "image/png", ext: "png", width: null, height: null }
      : {
          data: new Uint8Array(jpeg),
          mediaType: "image/jpeg",
          ext: "jpg",
          width: null,
          height: null,
        };

  // Dimensions are recorded alongside the cached bytes purely as metadata. A
  // failure to read them must not lose an image we already decoded and
  // re-encoded successfully.
  try {
    const meta = await new Bun.Image(chosen.data).metadata();
    chosen.width = meta.width ?? null;
    chosen.height = meta.height ?? null;
  } catch {
    /* dimensions are optional */
  }

  return chosen;
}

async function download(url: string): Promise<Prepared | null> {
  const cfg = config();

  if (cfg.respectRobots && !(await isAllowed(url))) {
    log("images").debug({ url }, "image disallowed by robots.txt");
    return null;
  }

  const res = await fetch(url, {
    headers: { "user-agent": userAgent(), accept: "image/*" },
    signal: AbortSignal.timeout(cfg.fetchTimeoutMs),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`http ${res.status}`);

  const contentType = res.headers.get("content-type") ?? "";
  if (!/^image\//i.test(contentType)) throw new Error(`not an image: ${contentType || "unknown"}`);

  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > cfg.maxEpubImageBytes) throw new Error(`too large: ${declared} bytes`);

  const body = new Uint8Array(await res.arrayBuffer());
  if (body.byteLength > cfg.maxEpubImageBytes) {
    throw new Error(`too large: ${body.byteLength} bytes`);
  }
  if (body.byteLength === 0) throw new Error("empty body");

  return await processImage(body, contentType);
}

/**
 * Replaces remote image references with in-book ones.
 *
 * Returns the rewritten markup plus the resources to add to the EPUB. Images
 * that could not be fetched or decoded have their `<img>` element removed
 * entirely: a broken-image placeholder is more confusing on an e-reader than
 * simply not showing the figure.
 */
export async function embedImages(xhtml: string, storyId?: number): Promise<EmbedResult> {
  const urls = imageUrls(xhtml).slice(0, MAX_IMAGES);
  if (urls.length === 0) return { xhtml, resources: [], embedded: 0, failed: 0 };

  const cfg = config();
  const variant = assetVariant();
  const limit = pLimit(cfg.fetchConcurrency);
  const prepared = new Map<string, AssetBytes>();
  let failed = 0;
  let cached = 0;

  await Promise.all(
    urls.map((url) =>
      limit(async () => {
        try {
          const hit = await lookupAsset(url, variant);
          if (hit) {
            prepared.set(url, hit);
            cached += 1;
            return;
          }

          const out = await download(url);
          if (!out) {
            failed += 1;
            return;
          }
          prepared.set(url, await putAsset(url, variant, out));
        } catch (error) {
          failed += 1;
          log("images").debug({ url, reason: (error as Error)?.message }, "image fetch failed");
        }
      }),
    ),
  );

  // Content-addressed so a repeated image (a logo in every figure) is stored
  // once, and so identical input always yields identical bytes. The href uses a
  // truncated digest for readability; it is a prefix of the full asset key, so
  // a cache hit and a fresh download always produce the same filename.
  const resources: EpubResource[] = [];
  const hrefs = new Map<string, string>();
  const byDigest = new Map<string, string>();

  // Iterated in document order, not in the order the downloads happened to
  // finish. `prepared` is filled by a concurrent pool, so its insertion order
  // varies run to run - and that order decides the manifest, the spine-adjacent
  // resource list and therefore the zip entry order, which would make an
  // otherwise identical rebuild produce different bytes.
  for (const url of urls) {
    const out = prepared.get(url);
    if (!out) continue;
    const digest = out.sha256.slice(0, 16);
    let href = byDigest.get(digest);
    if (!href) {
      href = `images/${digest}.${out.ext}`;
      byDigest.set(digest, href);
      resources.push({
        id: `img-${digest}`,
        href,
        mediaType: out.mediaType,
        data: out.data,
      });
    }
    hrefs.set(url, href);
  }

  if (storyId !== undefined) {
    linkStoryAssets(storyId, [...new Set([...prepared.values()].map((p) => p.sha256))]);
  }
  if (prepared.size > 0) {
    log("images").debug({ storyId, total: urls.length, cached, failed }, "resolved article images");
  }

  const rewritten = xhtml.replace(IMG_TAG, (tag) => {
    const src = tag.match(SRC_ATTR)?.[1];
    if (!src) return "";
    const href = hrefs.get(decodeEntities(src));
    return href ? tag.replace(SRC_ATTR, `src="${escapeAttr(href)}"`) : "";
  });

  return { xhtml: rewritten, resources, embedded: resources.length, failed };
}
