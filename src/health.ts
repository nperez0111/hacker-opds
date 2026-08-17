/**
 * Process identity and liveness facts.
 *
 * The point of this module is answering "is the thing I am talking to the
 * thing I just changed?". In dev that means catching a stale process the
 * Vite reload did not actually replace; in production it means knowing which
 * commit is serving before chasing a bug that was already fixed.
 *
 * `STARTED_AT` is captured at module evaluation, which for a server is
 * effectively process start. It is deliberately a module constant rather than
 * a lazily-initialised value: a lazy one would report the time of the first
 * health check, not the time of the boot, and would therefore always look
 * fresh.
 */

import { getDb } from "~/db/client";

/** Wall-clock time this module was first evaluated, i.e. process start. */
export const STARTED_AT = new Date();

/** Milliseconds since {@link STARTED_AT}. */
export function uptimeMs(now = Date.now()): number {
  return now - STARTED_AT.getTime();
}

/**
 * Human-readable uptime. Seconds matter here — the common question is "did
 * this restart just now?", and `0d 0h 0m` cannot answer it.
 */
export function formatUptime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}d ${h}h ${m}m ${s}s`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

let gitCache: string | null | undefined;

/**
 * Commit currently serving, or null when it cannot be determined.
 *
 * Resolution order matters. `GIT_SHA` comes first because a container image
 * has no `.git` directory — the value has to be baked in at image build time
 * (`--build-arg GIT_SHA=$(git rev-parse HEAD)`). Shelling out to git is the
 * dev-machine fallback, and it is allowed to fail silently: a fresh clone with
 * no commits, or a tarball deployment, legitimately has no answer, and a
 * missing version string must never be the reason a health check reports
 * unhealthy.
 *
 * The result is memoised because it cannot change without a restart, and
 * spawning a subprocess per health poll would be absurd.
 */
export function gitSha(): string | null {
  if (gitCache !== undefined) return gitCache;

  const fromEnv = process.env.GIT_SHA?.trim();
  if (fromEnv) {
    gitCache = fromEnv;
    return gitCache;
  }

  try {
    const out = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const sha = out.success ? new TextDecoder().decode(out.stdout).trim() : "";
    gitCache = sha || null;
  } catch {
    gitCache = null;
  }
  return gitCache;
}

/** Test seam: clears the memoised commit so `GIT_SHA` changes take effect. */
export function resetGitShaForTests(): void {
  gitCache = undefined;
}

export interface HealthReport {
  status: "ok" | "degraded";
  startedAt: string;
  uptimeMs: number;
  uptime: string;
  git: string | null;
  gitShort: string | null;
  pid: number;
  editions: number;
  stories: number;
  articles: number;
  builds: { ready: number; failed: number; building: number };
  error?: string;
}

/**
 * Liveness plus a small amount of "what is actually in here" detail.
 *
 * The counts are included because the most common real question after a
 * restart is not "is the process up" but "does it still have data" — an empty
 * volume and a healthy process look identical otherwise.
 *
 * A failed database read downgrades to `degraded` rather than throwing. The
 * endpoint's job is to report state, and a 500 with a stack trace tells a
 * monitoring system less than a 200 saying precisely which part is broken.
 */
export function healthReport(): HealthReport {
  const sha = gitSha();
  const base = {
    startedAt: STARTED_AT.toISOString(),
    uptimeMs: uptimeMs(),
    uptime: formatUptime(uptimeMs()),
    git: sha,
    gitShort: sha ? sha.slice(0, 7) : null,
    pid: process.pid,
  };

  try {
    const db = getDb();
    const one = (sql: string) => db.query<{ n: number }, []>(sql).get()?.n ?? 0;
    return {
      status: "ok",
      ...base,
      editions: one("SELECT count(*) AS n FROM editions"),
      stories: one("SELECT count(*) AS n FROM stories"),
      articles: one("SELECT count(*) AS n FROM articles WHERE state != 'failed'"),
      builds: {
        ready: one("SELECT count(*) AS n FROM builds WHERE state = 'ready'"),
        failed: one("SELECT count(*) AS n FROM builds WHERE state = 'failed'"),
        building: one("SELECT count(*) AS n FROM builds WHERE state = 'building'"),
      },
    };
  } catch (error) {
    return {
      status: "degraded",
      ...base,
      editions: 0,
      stories: 0,
      articles: 0,
      builds: { ready: 0, failed: 0, building: 0 },
      error: (error as Error)?.message ?? String(error),
    };
  }
}
