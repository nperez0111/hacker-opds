/**
 * Keyed in-flight coalescer.
 *
 * Nitro tasks cannot be used for per-story builds: the runtime dedupes tasks by
 * name only, ignoring the payload, so `story:build{id:1}` and
 * `story:build{id:2}` fired concurrently would collapse into one run and both
 * callers would receive the same result. This map dedupes on the actual key.
 *
 * Two requests for the same artifact therefore share one build; requests for
 * different artifacts proceed independently.
 */

const inflight = new Map<string, Promise<unknown>>();

/**
 * Runs `fn` under `key`, or joins the run already in progress for that key.
 * The entry is removed once the promise settles, so a later call rebuilds.
 */
export function coalesce<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;

  // `fn` may throw synchronously; wrapping in an async IIFE turns that into a
  // rejected promise so the map entry is still cleaned up by `.finally`.
  // The cleanup callback runs on a microtask, never before the `set` below,
  // so there is no window in which a settled build stays registered.
  const started = (async () => fn())().finally(() => {
    inflight.delete(key);
  });

  inflight.set(key, started);
  return started;
}

export function isInflight(key: string): boolean {
  return inflight.has(key);
}

export function inflightCount(): number {
  return inflight.size;
}

export function inflightKeys(): string[] {
  return [...inflight.keys()];
}

/** Test seam. Does not cancel running work, only forgets it. */
export function resetQueueForTests(): void {
  inflight.clear();
}
