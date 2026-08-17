import { useRuntimeConfig } from "nitro/runtime-config";
import { DEFAULTS, type Config } from "~/defaults";

export type { Config };

/**
 * Runtime config values arrive as strings when overridden via env, so every
 * numeric/boolean key is coerced. Nitro only allows env overrides for keys
 * declared in nitro.config.ts, so the key set here is closed.
 */
function num(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return fallback;
}

function str(value: unknown, fallback: string): string {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}

let cached: Config | undefined;
let warned = false;

/**
 * Builds a Config from a raw record. Exported so tests can exercise coercion
 * without standing up a Nitro runtime.
 */
export function resolveConfig(rc: Record<string, unknown>): Config {
  const publicBaseUrl = str(rc.publicBaseUrl, DEFAULTS.publicBaseUrl).replace(
    /\/+$/,
    "",
  );

  return {
    publicBaseUrl,
    dataDir: str(rc.dataDir, DEFAULTS.dataDir),

    editionTz: str(rc.editionTz, DEFAULTS.editionTz),
    editionLagHours: num(rc.editionLagHours, DEFAULTS.editionLagHours),
    editionStoryLimit: num(rc.editionStoryLimit, DEFAULTS.editionStoryLimit),
    retentionDays: num(rc.retentionDays, DEFAULTS.retentionDays),
    rssItemLimit: num(rc.rssItemLimit, DEFAULTS.rssItemLimit),

    searchResultLimit: num(rc.searchResultLimit, DEFAULTS.searchResultLimit),

    commentIndentMaxDepth: num(
      rc.commentIndentMaxDepth,
      DEFAULTS.commentIndentMaxDepth,
    ),
    digestThreadsPerStory: num(
      rc.digestThreadsPerStory,
      DEFAULTS.digestThreadsPerStory,
    ),
    digestCommentMaxDepth: num(
      rc.digestCommentMaxDepth,
      DEFAULTS.digestCommentMaxDepth,
    ),

    imageMaxWidth: num(rc.imageMaxWidth, DEFAULTS.imageMaxWidth),
    imageQuality: num(rc.imageQuality, DEFAULTS.imageQuality),
    maxEpubImageBytes: num(rc.maxEpubImageBytes, DEFAULTS.maxEpubImageBytes),

    fetchConcurrency: num(rc.fetchConcurrency, DEFAULTS.fetchConcurrency),
    fetchTimeoutMs: num(rc.fetchTimeoutMs, DEFAULTS.fetchTimeoutMs),
    perDomainDelayMs: num(rc.perDomainDelayMs, DEFAULTS.perDomainDelayMs),
    hnRequestDelayMs: num(rc.hnRequestDelayMs, DEFAULTS.hnRequestDelayMs),
    hnMaxWaitMs: num(rc.hnMaxWaitMs, DEFAULTS.hnMaxWaitMs),
    hnOnDemandWaitMs: num(rc.hnOnDemandWaitMs, DEFAULTS.hnOnDemandWaitMs),
    maxFetchBytes: num(rc.maxFetchBytes, DEFAULTS.maxFetchBytes),
    respectRobots: bool(rc.respectRobots, DEFAULTS.respectRobots),
    userAgentContact: str(rc.userAgentContact, DEFAULTS.userAgentContact),

    logLevel: str(rc.logLevel, DEFAULTS.logLevel),
    logPretty: bool(rc.logPretty, DEFAULTS.logPretty),
  };
}

export function config(): Config {
  if (cached) return cached;

  // Outside the Nitro runtime (bun test, scripts) this returns an empty stub
  // rather than throwing, so every key falls back to DEFAULTS.
  let rc: Record<string, unknown> = {};
  try {
    rc = useRuntimeConfig() as Record<string, unknown>;
  } catch {
    rc = {};
  }

  cached = resolveConfig(rc);

  if (
    !warned &&
    import.meta.env?.PROD &&
    /^https?:\/\/localhost\b/.test(cached.publicBaseUrl)
  ) {
    warned = true;
    console.warn(
      "[hacker-opds] PUBLIC_BASE_URL is still localhost in production. " +
        "OPDS acquisition links and RSS enclosures will be unreachable from " +
        "other devices. Set PUBLIC_BASE_URL to the externally visible origin.",
    );
  }

  return cached;
}

/** Test seam: override the process-wide config. */
export function setConfigForTests(overrides: Partial<Config>): void {
  cached = { ...resolveConfig({}), ...overrides };
}

/** Test seam: drop the cache so the next config() re-reads runtime config. */
export function resetConfig(): void {
  cached = undefined;
}

export function userAgent(): string {
  const c = config();
  const contact = c.userAgentContact || c.publicBaseUrl;
  return `hacker-opds/0.1 (+${contact}) reader-mode fetcher`;
}
