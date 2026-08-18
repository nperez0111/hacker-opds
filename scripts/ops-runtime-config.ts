/**
 * Environment-backed stand-in for `nitro/runtime-config`, substituted into the
 * operational script bundles by scripts/build-ops.ts.
 *
 * Why this has to exist. `src/config.ts` reads its values through Nitro's
 * `useRuntimeConfig()`, and that function is only real inside a Nitro build:
 * it imports the virtual module `#nitro/virtual/runtime-config`, which outside
 * one resolves to a stub that prints a warning and returns `{app:{},nitro:{}}`.
 * It does not throw, so the try/catch in config.ts never fires - every key
 * silently falls back to DEFAULTS instead. That is invisible when running from
 * a checkout, where DEFAULTS.dataDir ("./.data") is the right answer anyway.
 * In the container it is not: DATA_DIR=/data would be ignored and the script
 * would open a database under /app/.data, a root-owned directory the bun user
 * cannot write. Same for EDITION_TZ, which decides which day an edition is.
 *
 * So the bundled scripts get this instead, and it reproduces exactly what the
 * server does with the same environment: Nitro's applyEnv over the runtimeConfig
 * object, with the NITRO_ prefix and - because nitro.config.ts sets
 * `nitro.envPrefix` to the empty string - the bare snake-cased key as well.
 * Values arrive as strings either way, which is what resolveConfig() already
 * coerces, so an exec'd script and the server it shares a container with read
 * one configuration rather than two.
 *
 * Nothing imports this at runtime from a checkout; the plugin only rewrites the
 * specifier for the ops bundles, so `bun run ingest` locally is unchanged.
 */
import { DEFAULTS } from "~/defaults";

/**
 * scule's snakeCase, narrowed to the key shapes DEFAULTS actually uses. Every
 * key here is plain lowerCamelCase with no consecutive capitals, so a single
 * boundary rule is equivalent: hnRequestDelayMs to HN_REQUEST_DELAY_MS,
 * publicBaseUrl to PUBLIC_BASE_URL.
 */
function envName(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

let cached: Record<string, unknown> | undefined;

export function useRuntimeConfig(): Record<string, unknown> {
  if (cached) return cached;

  const resolved: Record<string, unknown> = { ...DEFAULTS };
  for (const key of Object.keys(resolved)) {
    const name = envName(key);
    // NITRO_ first, matching applyEnv's prefix/altPrefix order.
    const value = process.env[`NITRO_${name}`] ?? process.env[name];
    if (value !== undefined) resolved[key] = value;
  }

  cached = resolved;
  return resolved;
}
