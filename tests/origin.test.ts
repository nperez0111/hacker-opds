import { afterEach, describe, expect, test } from "bun:test";
import type { H3Event } from "nitro/h3";
import { resetConfig, setConfigForTests } from "~/config";
import { DEFAULTS } from "~/defaults";
import { rootFeed } from "~/opds/catalog";
import { hasExplicitBaseUrl, requestOrigin, resolveBase } from "~/opds/origin";

/**
 * `resolveBase` only ever touches `event.req.headers` and `event.url`, so a
 * structural stub is enough and keeps these tests free of a running server.
 */
function evt(url: string, headers: Record<string, string> = {}): H3Event {
  return {
    req: { headers: new Headers(headers) },
    url: new URL(url),
  } as unknown as H3Event;
}

afterEach(() => resetConfig());

describe("requestOrigin", () => {
  test("uses the Host header the client actually sent", () => {
    expect(requestOrigin(evt("http://127.0.0.1:3000/opds", { host: "192.168.1.50:3000" })))
      .toBe("http://192.168.1.50:3000");
  });

  test("falls back to the URL origin when there is no Host header", () => {
    expect(requestOrigin(evt("http://localhost:3000/opds"))).toBe("http://localhost:3000");
  });

  test("honours X-Forwarded-Host and X-Forwarded-Proto behind a proxy", () => {
    const e = evt("http://internal:3000/opds", {
      host: "internal:3000",
      "x-forwarded-host": "hn.example.com",
      "x-forwarded-proto": "https",
    });
    expect(requestOrigin(e)).toBe("https://hn.example.com");
  });

  test("takes the first value when a proxy chain appends protos", () => {
    const e = evt("http://internal/opds", {
      host: "internal",
      "x-forwarded-proto": "https, http",
    });
    expect(requestOrigin(e)).toBe("https://internal");
  });

  test("keeps the request scheme when only the host is forwarded", () => {
    const e = evt("http://internal/opds", {
      host: "internal",
      "x-forwarded-host": "hn.example.com",
    });
    expect(requestOrigin(e)).toBe("http://hn.example.com");
  });
});

describe("hasExplicitBaseUrl", () => {
  test("false for the placeholder default", () => {
    expect(hasExplicitBaseUrl()).toBe(false);
  });

  test("true once configured to something else", () => {
    setConfigForTests({ publicBaseUrl: "https://hn.example.com" });
    expect(hasExplicitBaseUrl()).toBe(true);
  });

  test("false when the default is supplied with a trailing slash", () => {
    // The config layer strips trailing slashes, so this must not read as an
    // intentional override.
    setConfigForTests({ publicBaseUrl: `${DEFAULTS.publicBaseUrl}/` });
    expect(hasExplicitBaseUrl()).toBe(false);
  });
});

describe("resolveBase", () => {
  test("follows the request when the base URL is left at its default", () => {
    expect(resolveBase(evt("http://x/opds", { host: "192.168.1.50:3000" })))
      .toBe("http://192.168.1.50:3000");
  });

  test("explicit configuration wins over the request", () => {
    setConfigForTests({ publicBaseUrl: "https://hn.example.com" });
    expect(resolveBase(evt("http://x/opds", { host: "192.168.1.50:3000" })))
      .toBe("https://hn.example.com");
  });

  test("strips a trailing slash off a derived origin", () => {
    expect(resolveBase(evt("http://x/opds", { host: "h:3000" }))).not.toMatch(/\/$/);
  });
});

describe("regression: catalogue links must be reachable from the client", () => {
  /**
   * The bug this guards: a reader loaded the root feed over the LAN, then
   * followed an entry pointing at `http://localhost:8080` and failed with
   * "connection refused", because on the reader `localhost` is the reader.
   */
  test("every link in the root feed shares the requesting origin", () => {
    const base = resolveBase(evt("http://x/opds", { host: "192.168.1.50:3000" }));
    const feed = rootFeed(0, base);

    const hrefs = [
      ...feed.links.map((l) => l.href),
      ...feed.entries.flatMap((e) => e.links.map((l) => l.href)),
    ];

    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(new URL(href).origin).toBe("http://192.168.1.50:3000");
    }
  });

  test("no catalogue link leaks the placeholder default", () => {
    const base = resolveBase(evt("http://x/opds", { host: "192.168.1.50:3000" }));
    const hrefs = JSON.stringify(rootFeed(0, base));
    expect(hrefs).not.toContain("localhost:8080");
  });
});
