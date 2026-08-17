import { config, userAgent } from "~/config";
import { errFields, log } from "~/log";

/**
 * Algolia's HN search index.
 *
 * Used only for story *selection*. Its `/items/:id` comment-tree endpoint used
 * to back comment fetching and was removed: it silently omits a large share of
 * live comments (55% missing on one story, 40% on another), because it mirrors
 * what HN renders un-collapsed. Comment trees now come from `~/core/hn-html`.
 */
const BASE = "https://hn.algolia.com/api/v1";

export interface AlgoliaStoryHit {
  objectID: string;
  title: string | null;
  url: string | null;
  author: string | null;
  points: number | null;
  num_comments: number | null;
  created_at_i: number;
  story_text: string | null;
  _tags?: string[];
}

const MAX_ATTEMPTS = 5;

/** Exponential backoff with jitter, so parallel builds do not retry in lockstep. */
function backoff(attempt: number): number {
  return 500 * 2 ** attempt + Math.random() * 250;
}

async function getJson<T>(url: string, attempt = 0): Promise<T> {
  const timeoutMs = config().fetchTimeoutMs;
  let res: Response;

  try {
    res = await fetch(url, {
      headers: { "user-agent": userAgent(), accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // A timeout or connection reset rejects rather than returning a status, so
    // the status-based retry below never saw it. That gap is why transient
    // blips failed whole story builds with a bare "The operation timed out."
    // Comment trees for popular stories are large and genuinely slow, which
    // makes this the most common failure in the pipeline.
    if (attempt + 1 < MAX_ATTEMPTS) {
      const wait = backoff(attempt);
      log("algolia").warn(
        { url, attempt: attempt + 1, waitMs: Math.round(wait), ...errFields(error) },
        "algolia request failed, retrying",
      );
      await Bun.sleep(wait);
      return getJson<T>(url, attempt + 1);
    }
    log("algolia").error(
      { url, attempts: MAX_ATTEMPTS, timeoutMs, ...errFields(error) },
      "algolia request failed, giving up",
    );
    throw new Error(
      `algolia request failed after ${MAX_ATTEMPTS} attempts for ${url}`,
      { cause: error },
    );
  }

  // 429/5xx are transient; Algolia's public tier throttles aggressively.
  if ((res.status === 429 || res.status >= 500) && attempt + 1 < MAX_ATTEMPTS) {
    const wait = backoff(attempt);
    log("algolia").warn(
      { url, status: res.status, attempt: attempt + 1, waitMs: Math.round(wait) },
      "algolia returned a transient status, retrying",
    );
    await Bun.sleep(wait);
    return getJson<T>(url, attempt + 1);
  }
  if (!res.ok) {
    log("algolia").error({ url, status: res.status }, "algolia request rejected");
    throw new Error(`algolia ${res.status} ${res.statusText} for ${url}`);
  }
  return (await res.json()) as T;
}

/**
 * Top stories *posted* within [startUnix, endUnix), ranked by points desc.
 *
 * An empty query makes Algolia fall back to its custom ranking, which for the
 * HN index is points descending -- this is exactly hackerdaily's selection in a
 * single request. The `>` / `<` in numericFilters must be percent-encoded;
 * URLSearchParams handles that.
 */
export async function searchTopStories(
  startUnix: number,
  endUnix: number,
  limit: number,
): Promise<AlgoliaStoryHit[]> {
  const params = new URLSearchParams({
    tags: "story",
    numericFilters: `created_at_i>=${startUnix},created_at_i<${endUnix}`,
    hitsPerPage: String(limit),
  });
  const data = await getJson<{ hits: AlgoliaStoryHit[] }>(
    `${BASE}/search?${params}`,
  );
  return data.hits ?? [];
}
