/**
 * The in-memory, content-addressed asset registry.
 *
 * Two failure modes are worth locking down, because neither shows up in
 * development and both are permanent for a reader once they happen:
 *
 *  - A stale `PRECACHE` list. The service worker installs against these exact
 *    URLs. If the list drifts from `CSS_URL`/`APP_JS_URL` the worker precaches
 *    a stylesheet nobody requests and misses the one every page links.
 *  - `sw.js` served as immutable. Its URL is the registration identity, so
 *    freezing it freezes the site's client behaviour forever.
 */
import { describe, expect, test } from "bun:test";
import {
  APP_JS_URL,
  CSS_URL,
  MANIFEST_URL,
  PRECACHE_URLS,
  SERVICE_WORKER_VERSION,
  SW_URL,
  getWebAsset,
  webAssetNames,
} from "~/web/assets";
import { fontAssetUrls } from "~/web/fonts";
import { iconUrls } from "~/web/icons";
import { APP_JS } from "~/web/sw";
import { SITE_CSS } from "~/web/styles";

/** The same eight-hex-character token the module derives its URLs from. */
function token(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex").slice(0, 8);
}

/** The registry key behind an `/assets/<name>?v=...` URL. */
function assetNameOf(url: string): string {
  return url.slice("/assets/".length).split("?")[0] as string;
}

describe("webAssetNames", () => {
  test("lists the four files the site itself serves", () => {
    // toContain rather than toEqual: the registry also carries the generated
    // font faces, whose names move whenever a font is rebuilt. Pinning the full
    // list here would make every font rebuild a test failure.
    const names = webAssetNames();
    for (const name of ["app.js", "manifest.webmanifest", "site.css", "sw.js"]) {
      expect(names).toContain(name);
    }
  });

  test("every listed name resolves", () => {
    for (const name of webAssetNames()) {
      const asset = getWebAsset(name);
      expect(asset).not.toBeNull();
      expect(asset!.body.length).toBeGreaterThan(0);
      /*
       * The invariant is about the body, not about a list of names. A text
       * body must declare its charset or a browser guesses latin-1 and mangles
       * the specimens; a binary body must declare a binary media type and must
       * *not* declare a charset, because a charset on bytes is a claim that
       * they are text and is exactly the header that makes a proxy feel
       * entitled to transcode them.
       *
       * Stated this way it holds for the fonts, for the icon PNGs and for the
       * ICO, and it will hold for whatever binary asset comes next.
       */
      if (typeof asset!.body === "string") {
        expect(asset!.type).toContain("charset=utf-8");
      } else {
        expect(asset!.type).toMatch(/^(?:font|image)\//);
        expect(asset!.type).not.toContain("charset");
      }
      expect(asset!.etag).toMatch(/^"[0-9a-f]{8}"$/);
    }
  });
});

describe("getWebAsset", () => {
  test("returns null for a name that does not exist", () => {
    expect(getWebAsset("nope.css")).toBeNull();
    expect(getWebAsset("")).toBeNull();
    expect(getWebAsset("../config.ts")).toBeNull();
  });

  test("returns null for inherited Object properties", () => {
    // A plain `ASSETS[name]` lookup would hand back Object.prototype members
    // here, and the route would try to serve a function as a stylesheet.
    expect(getWebAsset("constructor")).toBeNull();
    expect(getWebAsset("toString")).toBeNull();
    expect(getWebAsset("__proto__")).toBeNull();
  });

  test("declares the right content type for each asset", () => {
    expect(getWebAsset("site.css")!.type).toBe("text/css; charset=utf-8");
    expect(getWebAsset("app.js")!.type).toBe("text/javascript; charset=utf-8");
    expect(getWebAsset("sw.js")!.type).toBe("text/javascript; charset=utf-8");
    expect(getWebAsset("manifest.webmanifest")!.type).toBe(
      "application/manifest+json; charset=utf-8",
    );
  });

  test("serves the stylesheet and page script the modules define", () => {
    expect(getWebAsset("site.css")!.body).toBe(SITE_CSS);
    expect(getWebAsset("app.js")!.body).toBe(APP_JS);
  });
});

describe("etags", () => {
  test("are stable across calls", () => {
    for (const name of webAssetNames()) {
      expect(getWebAsset(name)!.etag).toBe(getWebAsset(name)!.etag);
    }
  });

  test("differ between assets, so one cannot be revalidated as another", () => {
    const etags = webAssetNames().map((n) => getWebAsset(n)!.etag);
    expect(new Set(etags).size).toBe(etags.length);
  });

  test("are quoted, which is what the route compares if-none-match against", () => {
    for (const name of webAssetNames()) {
      const etag = getWebAsset(name)!.etag;
      expect(etag.startsWith('"')).toBe(true);
      expect(etag.endsWith('"')).toBe(true);
    }
  });

  test("are derived from the asset's own bytes", () => {
    const asset = getWebAsset("site.css")!;
    expect(asset.etag).toBe(`"${token(asset.body)}"`);
  });
});

describe("cache immutability", () => {
  test("hashed assets are immutable", () => {
    // Their URLs carry the content hash, so the bytes at that URL cannot change.
    expect(getWebAsset("site.css")!.immutable).toBe(true);
    expect(getWebAsset("app.js")!.immutable).toBe(true);
  });

  test("the service worker is never immutable", () => {
    // The browser detects a worker update by refetching this exact URL. Caching
    // it hard would freeze the site's client behaviour permanently.
    expect(getWebAsset("sw.js")!.immutable).toBe(false);
  });

  test("the manifest is never immutable", () => {
    expect(getWebAsset("manifest.webmanifest")!.immutable).toBe(false);
  });

  test("exactly the hashed URLs are the immutable ones", () => {
    /*
     * Both directions of the implication matter, which is why this compares
     * two sets rather than checking one flag per asset. An immutable asset
     * whose URL carries no hash is frozen in every reader's cache forever; a
     * hashed URL pointing at a mutable asset makes every deploy refetch bytes
     * that were already correct.
     *
     * The URL list is assembled from the modules that publish them rather than
     * enumerated here, so a new asset joins this test by existing.
     */
    const hashed = new Set(
      [CSS_URL, APP_JS_URL, ...fontAssetUrls(), ...iconUrls()].map((url) =>
        assetNameOf(url),
      ),
    );
    for (const name of webAssetNames()) {
      expect(getWebAsset(name)!.immutable).toBe(hashed.has(name));
    }
  });
});

describe("asset URLs", () => {
  test("carry the content hash of what they point at", () => {
    expect(CSS_URL).toBe(`/assets/site.css?v=${token(SITE_CSS)}`);
    expect(APP_JS_URL).toBe(`/assets/app.js?v=${token(APP_JS)}`);
  });

  test("the hash is eight hex characters", () => {
    expect(CSS_URL).toMatch(/^\/assets\/site\.css\?v=[0-9a-f]{8}$/);
    expect(APP_JS_URL).toMatch(/^\/assets\/app\.js\?v=[0-9a-f]{8}$/);
  });

  test("differ from each other, so one cannot be cached as the other", () => {
    expect(CSS_URL.split("=")[1]).not.toBe(APP_JS_URL.split("=")[1]);
  });

  test("the unhashed URLs are bare paths under /assets/", () => {
    expect(SW_URL).toBe("/assets/sw.js");
    expect(MANIFEST_URL).toBe("/assets/manifest.webmanifest");
    expect(SW_URL).not.toContain("?");
    expect(MANIFEST_URL).not.toContain("?");
  });

  test("every URL resolves back to a real asset", () => {
    for (const url of [CSS_URL, APP_JS_URL, SW_URL, MANIFEST_URL]) {
      expect(getWebAsset(assetNameOf(url))).not.toBeNull();
    }
  });
});

describe("PRECACHE_URLS", () => {
  test("is exactly the four entries install can afford to block on", () => {
    expect(PRECACHE_URLS).toEqual(["/", "/offline", CSS_URL, APP_JS_URL]);
  });

  /**
   * The regression this exists for: someone edits the stylesheet, `CSS_URL`
   * moves, and a hardcoded precache entry stays behind. The worker then
   * installs a stylesheet no page ever requests.
   */
  test("its asset entries match the URLs pages actually link", () => {
    expect(PRECACHE_URLS).toContain(CSS_URL);
    expect(PRECACHE_URLS).toContain(APP_JS_URL);
  });

  test("every asset entry resolves to a registered asset", () => {
    for (const url of PRECACHE_URLS.filter((u) => u.startsWith("/assets/"))) {
      expect(getWebAsset(assetNameOf(url))).not.toBeNull();
    }
  });

  test("holds the two pages that make an offline first paint possible", () => {
    expect(PRECACHE_URLS).toContain("/");
    expect(PRECACHE_URLS).toContain("/offline");
  });

  test("does not precache the worker or the manifest", () => {
    // The worker cannot cache itself, and the manifest is not needed to render.
    expect(PRECACHE_URLS).not.toContain(SW_URL);
    expect(PRECACHE_URLS).not.toContain(MANIFEST_URL);
  });

  test("contains no duplicates and no relative entries", () => {
    expect(new Set(PRECACHE_URLS).size).toBe(PRECACHE_URLS.length);
    for (const url of PRECACHE_URLS) expect(url.startsWith("/")).toBe(true);
  });
});

describe("service worker version", () => {
  test("is an eight-hex-character token", () => {
    expect(SERVICE_WORKER_VERSION).toMatch(/^[0-9a-f]{8}$/);
  });

  test("names the cache the worker opens", () => {
    // Everything the worker does keys off this name, and `activate` deletes
    // every other `hacker-opds-` cache it finds.
    expect(getWebAsset("sw.js")!.body).toContain(`"hacker-opds-${SERVICE_WORKER_VERSION}"`);
  });

  test("the served worker precaches exactly PRECACHE_URLS", () => {
    const body = getWebAsset("sw.js")!.body;
    expect(body).toContain(`var PRECACHE = ${JSON.stringify(PRECACHE_URLS)};`);
  });
});

describe("manifest asset", () => {
  test("is the JSON the manifest module produces", () => {
    const parsed = JSON.parse(getWebAsset("manifest.webmanifest")!.body) as {
      start_url: string;
    };
    expect(parsed.start_url).toBe("/");
  });
});
