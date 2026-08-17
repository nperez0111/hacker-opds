import { describe, expect, test } from "bun:test";
import { resolveConfig } from "~/config";
import { DEFAULTS } from "~/defaults";
import nitroConfig from "../nitro.config";

describe("resolveConfig", () => {
  test("falls back to DEFAULTS for an empty runtime config", () => {
    expect(resolveConfig({})).toEqual({ ...DEFAULTS });
  });

  test("coerces numeric strings, which is how env overrides arrive", () => {
    const c = resolveConfig({
      editionLagHours: "24",
      imageQuality: "60",
      maxEpubImageBytes: "1048576",
    });
    expect(c.editionLagHours).toBe(24);
    expect(c.imageQuality).toBe(60);
    expect(c.maxEpubImageBytes).toBe(1048576);
  });

  test("coerces boolean strings both ways", () => {
    expect(resolveConfig({ respectRobots: "false" }).respectRobots).toBe(false);
    expect(resolveConfig({ respectRobots: "0" }).respectRobots).toBe(false);
    expect(resolveConfig({ respectRobots: "true" }).respectRobots).toBe(true);
    expect(resolveConfig({ respectRobots: "1" }).respectRobots).toBe(true);
  });

  test("ignores unparseable values rather than producing NaN", () => {
    expect(resolveConfig({ editionLagHours: "abc" }).editionLagHours).toBe(
      DEFAULTS.editionLagHours,
    );
    expect(resolveConfig({ imageQuality: "" }).imageQuality).toBe(
      DEFAULTS.imageQuality,
    );
    expect(resolveConfig({ respectRobots: "maybe" }).respectRobots).toBe(
      DEFAULTS.respectRobots,
    );
  });

  test("accepts zero rather than treating it as absent", () => {
    expect(resolveConfig({ perDomainDelayMs: 0 }).perDomainDelayMs).toBe(0);
    expect(resolveConfig({ perDomainDelayMs: "0" }).perDomainDelayMs).toBe(0);
  });

  test("strips trailing slashes from publicBaseUrl", () => {
    expect(
      resolveConfig({ publicBaseUrl: "https://hn.example.com///" })
        .publicBaseUrl,
    ).toBe("https://hn.example.com");
  });
});

describe("nitro.config runtimeConfig", () => {
  test("declares every DEFAULTS key so env overrides are permitted", () => {
    // Nitro only allows env overrides for keys present in runtimeConfig, so a
    // missing key here silently makes its env variable a no-op.
    const rc = nitroConfig.runtimeConfig as Record<string, unknown>;
    for (const key of Object.keys(DEFAULTS)) {
      expect(rc).toHaveProperty(key);
    }
  });

  test("uses bare env var names (empty prefix)", () => {
    const rc = nitroConfig.runtimeConfig as { nitro?: { envPrefix?: string } };
    expect(rc.nitro?.envPrefix).toBe("");
  });
});
