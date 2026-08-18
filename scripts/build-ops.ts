#!/usr/bin/env bun
/**
 * Bundles the operational scripts into the Nitro output, so a deployed
 * container has something to exec.
 *
 * The runtime image carries `.output` and nothing else - no source tree, no
 * node_modules, no tsconfig.json - which is most of why it is 115MB rather
 * than 220MB. The scripts in this directory import through the `~/` alias and
 * would need all three to run from source, so instead each one is bundled here
 * into a single self-contained file that lands inside `.output` and rides along
 * with the COPY the Dockerfile already does.
 *
 * Where the output goes is load-bearing. Two packages are deliberately left out
 * of the server bundle (read the comment in vite.config.ts for why each one has
 * to be) and Nitro traces them, plus what they require, into
 * `.output/server/node_modules`. These bundles externalise the same two, so
 * they have to be somewhere that resolves to that directory. Node and Bun walk
 * up from the importing file, so `.output/scripts/ingest.mjs` would look in
 * `.output/scripts/node_modules`, `.output/node_modules` and `/app/node_modules`
 * and find none of them, failing at the first cover render or the first
 * markdown conversion. Nesting under `.output/server/` puts the traced
 * directory one level up, which is the first place the walk looks.
 *
 * Not everything in scripts/ belongs here. build-fonts is a source-generation
 * step, and opds-probe is deliberately left out despite being the obvious
 * debugging tool: its headline check is that no catalogue link points off the
 * crawl origin, so pointed at 127.0.0.1 from inside the container it would flag
 * every correctly-formed link on any deployment that sets PUBLIC_BASE_URL.
 * It is a tool to run *at* the deployment, not in it.
 */
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, ".output", "server", "scripts");

/** Kept in step with RUNTIME_EXTERNALS in vite.config.ts. */
const RUNTIME_EXTERNALS = ["@resvg/resvg-js", "turndown"];

const ENTRIES = ["ingest", "reset", "reindex"];

/**
 * `useRuntimeConfig()` is a build-time virtual module in Nitro and a
 * warning-printing stub anywhere else, so the bundles get an env-backed
 * equivalent instead. See scripts/ops-runtime-config.ts.
 */
const runtimeConfigShim = (): Bun.BunPlugin => ({
  name: "hacker-opds:ops-runtime-config",
  setup(build) {
    const shim = join(root, "scripts", "ops-runtime-config.ts");
    build.onResolve({ filter: /^nitro\/runtime-config$/ }, () => ({ path: shim }));
  },
});

// vite build empties .output, so this normally starts clean; clearing anyway
// keeps a second run from leaving orphaned content-hashed chunks behind.
await rm(outDir, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ENTRIES.map((name) => join(root, "scripts", `${name}.ts`)),
  outdir: outDir,
  target: "bun",
  format: "esm",
  // The three entries share the config, database and logging layers, and
  // reset additionally shares the search indexer with reindex. Splitting turns
  // that into one copy; without it reset and reindex cost ~120KB each instead
  // of ~4KB.
  splitting: true,
  external: RUNTIME_EXTERNALS,
  // Identifiers are kept. These run unattended in a container and a stack trace
  // naming `buildStoryEpub` is worth the ~600KB over one naming `e`.
  minify: { whitespace: true, syntax: true, identifiers: false },
  // Explicit .mjs rather than relying on the `type: module` in the package.json
  // Nitro generates for its traced dependencies.
  naming: { entry: "[name].mjs", chunk: "[name]-[hash].mjs" },
  plugins: [runtimeConfigShim()],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const total = result.outputs.reduce((n, o) => n + o.size, 0);
const kb = (n: number) => `${(n / 1024).toFixed(0)}KB`;
for (const name of ENTRIES) {
  console.log(`  .output/server/scripts/${name}.mjs`);
}
console.log(`  ${result.outputs.length} files, ${kb(total)} total`);
