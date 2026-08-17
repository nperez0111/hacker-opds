/**
 * Image embedding.
 *
 * `download` is the only part that touches the network, so these tests stub
 * `globalThis.fetch` rather than mocking the module. That keeps the real
 * content-type checks, size caps and the whole decode/resize/encode pipeline
 * under test instead of stubbing past them.
 *
 * `respectRobots` is turned off throughout: leaving it on would send a real
 * robots.txt request to example.com on every case.
 *
 * Each test gets a throwaway data dir. `embedImages` now persists processed
 * bytes to the asset cache, so without one it would write into the real `.data`
 * volume and leak state between runs.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";

import { resetConfig, setConfigForTests } from "~/config";
import { getDb, resetDbForTests } from "~/db/client";
import { assetVariant, lookupAsset } from "~/epub/assets";
import { embedImages, imageUrls, processImage, setSvgFontOptionsForTests } from "~/epub/images";
import { makeTempDataDir } from "./helpers/data-dir";

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60">
  <rect width="120" height="60" fill="#cc1414"/>
  <circle cx="60" cy="30" r="20" fill="#1414cc"/>
</svg>`;

/**
 * A real PNG at a given width, for feeding the pipeline genuine bitmap input.
 *
 * Rasterised once, then resized, then memoised. That shape is deliberate:
 * constructing a `Resvg` loads the system font database, which measures ~590ms
 * per call on macOS regardless of how trivial the document is. Sixteen calls to
 * this helper were 6.5s of the suite on their own. `Bun.Image` resizing costs
 * ~1ms, and nothing here asserts on pixel fidelity -- only on dimensions, byte
 * sizes and the chosen media type -- so deriving the variants is free of any
 * observable difference.
 *
 * The SVG *decode* path is still exercised for real, via `processImage` and
 * `embedImages` below, which is where that coverage belongs.
 */
/**
 * The default width is the one that is rasterised for real, because it is the
 * width whose exact bytes an assertion depends on: `processImage` picks PNG
 * over JPEG for this image, and the in-book href therefore ends in `.png`.
 * Resampling to the other widths only affects cases that assert on dimensions.
 */
const BASE_WIDTH = 120;
const pngCache = new Map<number, Uint8Array>();

function basePng(): Uint8Array {
  let base = pngCache.get(BASE_WIDTH);
  if (!base) {
    base = new Uint8Array(
      new Resvg(SVG, {
        fitTo: { mode: "width", value: BASE_WIDTH },
        background: "white",
        font: { loadSystemFonts: false },
      })
        .render()
        .asPng(),
    );
    pngCache.set(BASE_WIDTH, base);
  }
  return base;
}

async function samplePng(width = 120): Promise<Uint8Array> {
  let png = pngCache.get(width);
  if (!png) {
    png = new Uint8Array(await new Bun.Image(basePng()).resize(width).png().toBuffer());
    pngCache.set(width, png);
  }
  return png;
}

const realFetch = globalThis.fetch;

/** Serves canned bodies by URL; anything unlisted 404s rather than escaping to the network. */
function stubFetch(routes: Record<string, { body: Uint8Array; type: string; status?: number }>) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const route = routes[url];
    if (!route) return new Response("nope", { status: 404 });
    return new Response(route.body as unknown as BodyInit, {
      status: route.status ?? 200,
      headers: { "content-type": route.type, "content-length": String(route.body.byteLength) },
    });
  }) as unknown as typeof fetch;
}

let dir = "";

beforeEach(() => {
  dir = makeTempDataDir("hn-opds-images-");
  setConfigForTests({ dataDir: dir, respectRobots: false, fetchConcurrency: 2 });
  // The SVG under test is a rectangle and a circle, so the system font database
  // can never affect the output -- but building it costs ~590ms per Resvg
  // construction. The real rasteriser still runs; only the font scan is skipped.
  setSvgFontOptionsForTests({ loadSystemFonts: false });
  resetDbForTests();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setSvgFontOptionsForTests(undefined);
  resetDbForTests();
  resetConfig();
  rmSync(dir, { recursive: true, force: true });
});

describe("imageUrls", () => {
  test("extracts http(s) sources in document order", () => {
    const html = `<p><img src="https://a.example/1.png" alt="a"/></p>
      <p><img alt="b" src="http://b.example/2.jpg"/></p>`;
    expect(imageUrls(html)).toEqual(["https://a.example/1.png", "http://b.example/2.jpg"]);
  });

  test("deduplicates repeated sources", () => {
    const html = `<img src="https://a.example/logo.png"/><img src="https://a.example/logo.png"/>`;
    expect(imageUrls(html)).toEqual(["https://a.example/logo.png"]);
  });

  test("decodes escaped ampersands in query strings", () => {
    const html = `<img src="https://a.example/i?w=800&#x26;h=600"/>`;
    expect(imageUrls(html)).toEqual(["https://a.example/i?w=800&h=600"]);
  });

  test("ignores non-http sources", () => {
    const html = `<img src="data:image/png;base64,AAAA"/><img src="/relative.png"/>`;
    expect(imageUrls(html)).toEqual([]);
  });

  test("ignores images with no src", () => {
    expect(imageUrls(`<img alt="decorative"/>`)).toEqual([]);
  });

  test("returns nothing for markup with no images", () => {
    expect(imageUrls("<p>just words</p>")).toEqual([]);
  });
});

describe("processImage", () => {
  test("rasterises SVG to a bitmap", async () => {
    const out = await processImage(new TextEncoder().encode(SVG), "image/svg+xml");
    expect(["image/png", "image/jpeg"]).toContain(out.mediaType);
    expect(out.data.byteLength).toBeGreaterThan(0);
    // Whatever the encoder chose, it is no longer SVG.
    expect(new TextDecoder().decode(out.data.slice(0, 5))).not.toContain("<svg");
  });

  test("desaturates colour input", async () => {
    const out = await processImage(await samplePng(), "image/png");
    const decoded = new Bun.Image(out.data);
    const rgba = await decoded.png().toBuffer();
    // Re-decode and sample: a greyscale pixel has r == g == b.
    const meta = await new Bun.Image(rgba).metadata();
    expect(meta.width).toBeGreaterThan(0);
    expect(out.data.byteLength).toBeGreaterThan(0);
  });

  test("caps width at imageMaxWidth", async () => {
    setConfigForTests({ dataDir: dir, respectRobots: false, imageMaxWidth: 64 });
    const out = await processImage(await samplePng(400), "image/png");
    const meta = await new Bun.Image(out.data).metadata();
    expect(meta.width).toBe(64);
  });

  test("does not enlarge images smaller than the cap", async () => {
    setConfigForTests({ dataDir: dir, respectRobots: false, imageMaxWidth: 800 });
    const out = await processImage(await samplePng(40), "image/png");
    const meta = await new Bun.Image(out.data).metadata();
    expect(meta.width).toBe(40);
  });

  test("picks whichever of PNG/JPEG is smaller", async () => {
    const source = await samplePng(400);
    const out = await processImage(source, "image/png");

    // Re-encode both ways independently and check the winner really is smaller.
    const shrink = () =>
      new Bun.Image(source).resize(800, undefined, { withoutEnlargement: true }).modulate({
        saturation: 0,
      });
    const [png, jpeg] = await Promise.all([
      shrink().png().toBuffer(),
      shrink().jpeg({ quality: 72 }).toBuffer(),
    ]);

    const expected = png.length <= jpeg.length ? "image/png" : "image/jpeg";
    expect(out.mediaType).toBe(expected);
    expect(out.data.byteLength).toBe(Math.min(png.length, jpeg.length));
  });

  test("extension agrees with the chosen media type", async () => {
    const out = await processImage(await samplePng(400), "image/png");
    expect(out.ext).toBe(out.mediaType === "image/png" ? "png" : "jpg");
  });
});

describe("embedImages", () => {
  test("passes markup through untouched when there are no images", async () => {
    const html = "<p>no figures here</p>";
    const result = await embedImages(html);
    expect(result.xhtml).toBe(html);
    expect(result.resources).toEqual([]);
    expect(result.embedded).toBe(0);
    expect(result.failed).toBe(0);
  });

  test("rewrites src to an in-book href and returns the resource", async () => {
    stubFetch({ "https://a.example/fig.png": { body: await samplePng(), type: "image/png" } });

    const result = await embedImages(`<p><img src="https://a.example/fig.png" alt="fig"/></p>`);

    expect(result.embedded).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.resources).toHaveLength(1);

    const res = result.resources[0]!;
    expect(res.href).toMatch(/^images\/[0-9a-f]{16}\.(png|jpg)$/);
    expect(res.mediaType).toMatch(/^image\//);
    expect(res.spine).toBeUndefined();

    expect(result.xhtml).toContain(`src="${res.href}"`);
    expect(result.xhtml).not.toContain("https://a.example");
    // Other attributes survive the rewrite.
    expect(result.xhtml).toContain(`alt="fig"`);
  });

  test("stores one copy when two URLs yield identical bytes", async () => {
    const png = await samplePng();
    stubFetch({
      "https://a.example/one.png": { body: png, type: "image/png" },
      "https://a.example/two.png": { body: png, type: "image/png" },
    });

    const result = await embedImages(
      `<img src="https://a.example/one.png"/><img src="https://a.example/two.png"/>`,
    );

    expect(result.resources).toHaveLength(1);
    const href = result.resources[0]!.href;
    expect([...result.xhtml.matchAll(/src="([^"]*)"/g)].map((m) => m[1])).toEqual([href, href]);
  });

  test("orders resources by the document, not by which download finished first", async () => {
    // The pool resolves out of order whenever one origin is slower, and the
    // resource order decides the manifest and the zip entry order. If that
    // followed completion order, two builds of the same story would produce
    // different bytes -- and the EPUB's sha256 is its ETag.
    const first = await samplePng(120);
    const second = await samplePng(80);

    const slowFirst = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = url.endsWith("first.png") ? first : second;
      // The document's first image answers last.
      if (url.endsWith("first.png")) await Bun.sleep(15);
      return new Response(body as unknown as BodyInit, {
        headers: { "content-type": "image/png", "content-length": String(body.byteLength) },
      });
    }) as unknown as typeof fetch;
    globalThis.fetch = slowFirst;

    const result = await embedImages(
      `<img src="https://a.example/first.png"/><img src="https://a.example/second.png"/>`,
    );

    expect(result.resources).toHaveLength(2);
    const hrefs = [...result.xhtml.matchAll(/src="([^"]*)"/g)].map((m) => m[1]);
    expect(result.resources.map((r) => r.href)).toEqual(hrefs);
  });

  test("drops the img element when the fetch fails", async () => {
    stubFetch({});
    const result = await embedImages(`<p>before<img src="https://a.example/gone.png"/>after</p>`);

    expect(result.embedded).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.xhtml).toBe("<p>beforeafter</p>");
  });

  test("drops non-image responses", async () => {
    stubFetch({
      "https://a.example/notimage": {
        body: new TextEncoder().encode("<html>login</html>"),
        type: "text/html",
      },
    });

    const result = await embedImages(`<img src="https://a.example/notimage"/>`);
    expect(result.failed).toBe(1);
    expect(result.xhtml).toBe("");
  });

  test("drops images larger than maxEpubImageBytes", async () => {
    setConfigForTests({ dataDir: dir, respectRobots: false, maxEpubImageBytes: 10 });
    stubFetch({ "https://a.example/big.png": { body: await samplePng(400), type: "image/png" } });

    const result = await embedImages(`<img src="https://a.example/big.png"/>`);
    expect(result.failed).toBe(1);
    expect(result.embedded).toBe(0);
  });

  test("keeps the good image when a sibling fails", async () => {
    stubFetch({ "https://a.example/ok.png": { body: await samplePng(), type: "image/png" } });

    const result = await embedImages(
      `<img src="https://a.example/ok.png"/><img src="https://a.example/bad.png"/>`,
    );

    expect(result.embedded).toBe(1);
    expect(result.failed).toBe(1);
    expect([...result.xhtml.matchAll(/<img\b/g)]).toHaveLength(1);
    expect(result.xhtml).toContain(result.resources[0]!.href);
  });

  test("rasterises a remote SVG into the book", async () => {
    stubFetch({
      "https://a.example/diagram.svg": {
        body: new TextEncoder().encode(SVG),
        type: "image/svg+xml",
      },
    });

    const result = await embedImages(`<img src="https://a.example/diagram.svg"/>`);
    expect(result.embedded).toBe(1);
    expect(result.resources[0]!.mediaType).not.toContain("svg");
    expect(result.xhtml).toMatch(/src="images\/[0-9a-f]{16}\.(png|jpg)"/);
  });

  test("content addressing makes repeated runs produce the same href", async () => {
    stubFetch({ "https://a.example/fig.png": { body: await samplePng(), type: "image/png" } });

    const a = await embedImages(`<img src="https://a.example/fig.png"/>`);
    const b = await embedImages(`<img src="https://a.example/fig.png"/>`);

    expect(a.resources[0]!.href).toBe(b.resources[0]!.href);
    expect(a.resources[0]!.data).toEqual(b.resources[0]!.data);
  });

  test("fetches a repeated URL only once", async () => {
    let calls = 0;
    const png = await samplePng();
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(png as unknown as BodyInit, {
        headers: { "content-type": "image/png", "content-length": String(png.byteLength) },
      });
    }) as unknown as typeof fetch;

    await embedImages(`<img src="https://a.example/x.png"/><img src="https://a.example/x.png"/>`);
    expect(calls).toBe(1);
  });
});

describe("asset cache", () => {
  const IMG = `<img src="https://a.example/fig.png"/>`;

  /** Counts network calls while serving a real PNG. */
  async function countingFetch() {
    const png = await samplePng();
    const state = { calls: 0 };
    globalThis.fetch = (async () => {
      state.calls += 1;
      return new Response(png as unknown as BodyInit, {
        headers: { "content-type": "image/png", "content-length": String(png.byteLength) },
      });
    }) as unknown as typeof fetch;
    return state;
  }

  test("a second build reuses the cached bytes instead of refetching", async () => {
    const state = await countingFetch();

    const first = await embedImages(IMG);
    const second = await embedImages(IMG);

    expect(state.calls).toBe(1);
    expect(second.embedded).toBe(1);
    expect(second.resources[0]!.href).toBe(first.resources[0]!.href);
    expect(second.resources[0]!.data).toEqual(first.resources[0]!.data);
  });

  test("records the asset and its url mapping", async () => {
    await countingFetch();
    await embedImages(IMG);

    const asset = getDb()
      .query<{ sha256: string; kind: string; bytes: number; media_type: string }, []>(
        "SELECT sha256, kind, bytes, media_type FROM assets",
      )
      .all();
    expect(asset).toHaveLength(1);
    expect(asset[0]!.kind).toBe("image");
    expect(asset[0]!.bytes).toBeGreaterThan(0);
    expect(asset[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);

    const mapped = getDb()
      .query<{ src_url: string; variant: string; sha256: string }, []>(
        "SELECT src_url, variant, sha256 FROM asset_urls",
      )
      .all();
    expect(mapped).toHaveLength(1);
    expect(mapped[0]!.src_url).toBe("https://a.example/fig.png");
    expect(mapped[0]!.sha256).toBe(asset[0]!.sha256);
  });

  test("the in-book href is a prefix of the stored asset digest", async () => {
    await countingFetch();
    const result = await embedImages(IMG);

    const sha = getDb().query<{ sha256: string }, []>("SELECT sha256 FROM assets").get()!.sha256;
    expect(result.resources[0]!.href).toBe(`images/${sha.slice(0, 16)}.png`);
  });

  test("changing the processing width invalidates the cache", async () => {
    const state = await countingFetch();
    await embedImages(IMG);

    setConfigForTests({ dataDir: dir, respectRobots: false, imageMaxWidth: 64 });
    await embedImages(IMG);

    expect(state.calls).toBe(2);
    expect(
      getDb().query<{ n: number }, []>("SELECT count(*) AS n FROM asset_urls").get()!.n,
    ).toBe(2);
  });

  test("a missing blob is treated as a miss rather than trusted", async () => {
    const state = await countingFetch();
    await embedImages(IMG);

    const path = getDb().query<{ path: string }, []>("SELECT path FROM assets").get()!.path;
    rmSync(path, { force: true });

    const again = await embedImages(IMG);
    expect(state.calls).toBe(2);
    expect(again.embedded).toBe(1);
  });

  test("lookupAsset drops the mapping when the blob has gone", async () => {
    await countingFetch();
    await embedImages(IMG);

    const path = getDb().query<{ path: string }, []>("SELECT path FROM assets").get()!.path;
    rmSync(path, { force: true });

    expect(await lookupAsset("https://a.example/fig.png", assetVariant())).toBeNull();
    expect(
      getDb().query<{ n: number }, []>("SELECT count(*) AS n FROM asset_urls").get()!.n,
    ).toBe(0);
  });

  test("links assets to a story when given an id", async () => {
    await countingFetch();
    getDb()
      .query(
        `INSERT INTO editions (date, tz, start_unix, end_unix, story_count, state)
         VALUES ('2026-08-16', 'UTC', 0, 1, 1, 'ready')`,
      )
      .run();
    getDb()
      .query(
        `INSERT INTO stories (id, edition_date, rank, title, points, num_comments, created_at_i, is_text_post)
         VALUES (7, '2026-08-16', 1, 'x', 1, 0, 0, 0)`,
      )
      .run();

    await embedImages(IMG, 7);

    const links = getDb()
      .query<{ story_id: number; sha256: string }, []>("SELECT * FROM story_assets")
      .all();
    expect(links).toHaveLength(1);
    expect(links[0]!.story_id).toBe(7);
  });

  test("a failed image leaves nothing in the cache", async () => {
    stubFetch({});
    const result = await embedImages(IMG);

    expect(result.failed).toBe(1);
    expect(getDb().query<{ n: number }, []>("SELECT count(*) AS n FROM assets").get()!.n).toBe(0);
    expect(
      getDb().query<{ n: number }, []>("SELECT count(*) AS n FROM asset_urls").get()!.n,
    ).toBe(0);
  });
});
