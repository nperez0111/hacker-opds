import pLimit from "p-limit";
import robotsParser from "robots-parser";
import { config, userAgent } from "~/config";

export type FetchErrorCode =
  | "robots_disallowed"
  | "timeout"
  | "network_error"
  | "too_many_redirects"
  | "unsupported_content_type"
  | "too_large"
  | `http_${number}`;

export class FetchFailure extends Error {
  constructor(
    readonly code: FetchErrorCode,
    readonly status?: number,
  ) {
    super(code);
  }
}

const HTML_TYPES = ["text/html", "application/xhtml+xml"];
const MAX_REDIRECTS = 5;

let limiter: ReturnType<typeof pLimit> | undefined;
function limit() {
  return (limiter ??= pLimit(config().fetchConcurrency));
}

/** Per-host serialisation: each host waits out perDomainDelayMs between hits. */
const hostChain = new Map<string, Promise<void>>();
function politeSlot<T>(host: string, fn: () => Promise<T>): Promise<T> {
  const prev = hostChain.get(host) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  hostChain.set(
    host,
    run.then(
      () => Bun.sleep(config().perDomainDelayMs),
      () => Bun.sleep(config().perDomainDelayMs),
    ),
  );
  return run;
}

const robotsCache = new Map<string, Promise<ReturnType<typeof robotsParser> | null>>();

async function robotsFor(origin: string) {
  let p = robotsCache.get(origin);
  if (!p) {
    p = (async () => {
      try {
        const url = `${origin}/robots.txt`;
        const res = await fetch(url, {
          headers: { "user-agent": userAgent() },
          signal: AbortSignal.timeout(10_000),
        });
        // 4xx means no restrictions; 5xx is ambiguous, treat as permissive.
        if (!res.ok) return null;
        return robotsParser(url, await res.text());
      } catch {
        return null;
      }
    })();
    robotsCache.set(origin, p);
  }
  return p;
}

export async function isAllowed(url: string): Promise<boolean> {
  if (!config().respectRobots) return true;
  try {
    const u = new URL(url);
    const robots = await robotsFor(u.origin);
    return robots?.isAllowed(url, userAgent()) !== false;
  } catch {
    return true;
  }
}

export interface FetchedPage {
  html: string;
  finalUrl: string;
  status: number;
  contentType: string;
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new FetchFailure("too_large");
    }
    chunks.push(value);
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(joined);
}

/**
 * Fetches an HTML page under the project's politeness rules. Redirects are
 * followed manually so the hop count is bounded and robots.txt is re-checked
 * against the final origin.
 */
export async function fetchPage(rawUrl: string): Promise<FetchedPage> {
  const c = config();
  return limit()(async () => {
    let url = rawUrl;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!(await isAllowed(url))) throw new FetchFailure("robots_disallowed");

      const host = new URL(url).host;
      const res = await politeSlot(host, () =>
        fetch(url, {
          redirect: "manual",
          headers: {
            "user-agent": userAgent(),
            accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
            "accept-language": "en",
          },
          signal: AbortSignal.timeout(c.fetchTimeoutMs),
        }),
      ).catch((err: unknown) => {
        const name = (err as Error)?.name;
        throw new FetchFailure(
          name === "TimeoutError" || name === "AbortError"
            ? "timeout"
            : "network_error",
        );
      });

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        await res.body?.cancel();
        if (!loc) throw new FetchFailure(`http_${res.status}`, res.status);
        url = new URL(loc, url).toString();
        continue;
      }

      if (!res.ok) {
        await res.body?.cancel();
        throw new FetchFailure(`http_${res.status}`, res.status);
      }

      const contentType = res.headers.get("content-type") ?? "";
      if (!HTML_TYPES.some((t) => contentType.includes(t))) {
        await res.body?.cancel();
        throw new FetchFailure("unsupported_content_type", res.status);
      }

      return {
        html: await readCapped(res, c.maxFetchBytes),
        finalUrl: res.url || url,
        status: res.status,
        contentType,
      };
    }
    throw new FetchFailure("too_many_redirects");
  });
}
