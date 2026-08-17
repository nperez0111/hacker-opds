import { defineConfig } from "nitro";
// The `.ts` extension is required: Nitro loads this file through c12, whose
// resolver does not probe extensions the way the bundler does. Without it the
// dev server dies with "Cannot find module .../src/defaults".
import { DEFAULTS } from "./src/defaults.ts";

export default defineConfig({
  preset: "bun",
  compatibilityDate: "2026-08-17",

  // Packages left out of the bundle by the plugin in vite.config.ts (read the
  // comment there for why each one has to be). Listing them here is what makes
  // Nitro trace them into .output/server/node_modules instead of emitting an
  // import of something that is not in the artefact - externalising and
  // shipping are separate decisions, and only the second one is this option.
  // Tracing follows their own requires, which is how turndown drags in
  // @mixmark-io/domino, the package whose absence broke every story page.
  traceDeps: ["@resvg/resvg-js", "turndown"],

  // Nitro v3 defaults serverDir to `false`, which silently disables scanning of
  // routes/ middleware/ plugins/ tasks/. It must be set explicitly.
  serverDir: "./server",

  experimental: {
    tasks: true,
  },


  // No timezone option exists on scheduledTasks; cron is evaluated in process
  // local time. The container sets TZ, and the tasks themselves are idempotent
  // and self-determining so an hourly tick is DST-safe and catches up after
  // downtime.
  scheduledTasks: {
    "0 * * * *": ["prewarm"],
    "30 4 * * *": ["retention"],
  },

  // NOTE: still no serverAssets, and now deliberately none. The EPUB stylesheet
  // is inlined as a TS module (src/epub/styles.ts) so it bundles reliably and is
  // testable without the Nitro runtime.
  //
  // The cover TTF this was reserved for turned out not to need a binding: cover
  // rasterisation needs a font *file on disk* (resvg-js is ~70x slower given
  // font buffers than a path - see the measurements in src/epub/cover.ts), and
  // the faces are already in the tree as base64 WOFF in src/web/font-files.ts.
  // src/epub/sfnt.ts unpacks one into the data directory on first use, so there
  // is one asset mechanism in this codebase rather than two.

  // Defaults come from src/defaults.ts so they cannot drift from the fallbacks
  // used when running outside the Nitro runtime. Only keys declared here can be
  // overridden by env vars.
  //
  // An empty envPrefix means the bare name is used: `publicBaseUrl` is set by
  // PUBLIC_BASE_URL, not HN_PUBLIC_BASE_URL. Nitro's `??` chain preserves the
  // empty string rather than falling back to its `_` default. The NITRO_ prefix
  // still works too, since that one is applied unconditionally.
  runtimeConfig: {
    nitro: { envPrefix: "" },
    ...DEFAULTS,
  },
});
