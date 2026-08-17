/**
 * Single source of truth for configuration defaults.
 *
 * Imported by BOTH `nitro.config.ts` (to populate `runtimeConfig`, which is
 * what makes the env overrides work) and `src/config.ts` (as the
 * fallback when running outside the Nitro runtime, e.g. under `bun test` or
 * a one-off script, where `useRuntimeConfig()` returns an empty stub).
 *
 * This file must stay dependency-free so it is cheap to import from the
 * build config.
 */
export const DEFAULTS = {
  publicBaseUrl: "http://localhost:8080",
  dataDir: "./.data",

  editionTz: "Europe/Amsterdam",
  editionLagHours: 6,
  editionStoryLimit: 30,
  retentionDays: 90,

  /**
   * How many stories the site-wide RSS feed carries.
   *
   * Sized against the polling interval rather than the page. An edition is 30
   * stories and lands once a day, so 50 leaves a reader who polls daily most of
   * a second edition of slack before an unseen item scrolls off the end. Every
   * item carries a full article body, so raising this costs real bytes on every
   * poll, and the per-edition feeds are there for anyone who wants further back.
   */
  rssItemLimit: 50,

  /**
   * Results per page of search, in both the website and the OPDS feed.
   *
   * The cost of a page is one snippet extraction per row, which is the
   * expensive part of a search, so this is the knob that trades result density
   * against how long a query takes. 25 is about two screens on a six-inch
   * panel; the query layer refuses to go above 100 whatever this says.
   */
  searchResultLimit: 25,

  commentIndentMaxDepth: 5,
  digestThreadsPerStory: 20,
  digestCommentMaxDepth: 4,

  imageMaxWidth: 800,
  imageQuality: 72,
  maxEpubImageBytes: 4 * 1024 * 1024,

  fetchConcurrency: 4,
  fetchTimeoutMs: 20_000,
  perDomainDelayMs: 1000,
  /**
   * Gap between consecutive HN item-page requests, which are serialized.
   * HN's robots.txt asks for Crawl-delay: 30, but that would put a 30-story
   * edition at 15 minutes. 2s is a deliberate middle ground: slow enough to
   * stay well under the limiter in steady state, fast enough for a nightly
   * prewarm. There is no second source to fall back to, so this is the main
   * lever protecting the pipeline. Raise it if 403s reappear.
   */
  hnRequestDelayMs: 2000,

  /**
   * How long a background build will wait out an HN throttle before giving up
   * and leaving the story for the next prewarm pass. Generous on purpose:
   * nothing needs these EPUBs at a particular moment, and waiting costs only
   * time.
   */
  hnMaxWaitMs: 1_800_000,

  /**
   * The same budget for a build triggered by an actual HTTP request, where a
   * reader is waiting. Past this the route returns 503 with Retry-After.
   */
  hnOnDemandWaitMs: 20_000,
  maxFetchBytes: 5 * 1024 * 1024,
  // Off by default: fetches happen because a reader asked for a specific
  // article they already saw linked on HN, which is user-agent behaviour
  // rather than crawling. robots.txt governs discovery by bots, and this
  // system discovers nothing on its own.
  //
  // Caveat worth knowing: the nightly prewarm task fetches the whole edition
  // before anyone requests it, which *is* closer to crawling. The politeness
  // controls that actually protect sites stay on regardless -- identifying
  // user agent, per-domain delay, concurrency cap, timeouts, size cap.
  //
  // Set RESPECT_ROBOTS=true to restore the previous behaviour.
  respectRobots: false,
  userAgentContact: "",

  // pino level: trace | debug | info | warn | error | fatal | silent
  logLevel: "info",
  // Pretty-printed, human-readable logs. Off by default so production emits
  // NDJSON; the dev script turns it on.
  logPretty: false,
} as const;

export type Config = {
  -readonly [K in keyof typeof DEFAULTS]: (typeof DEFAULTS)[K] extends number
    ? number
    : (typeof DEFAULTS)[K] extends boolean
      ? boolean
      : string;
};
