/**
 * `GET /robots.txt` - keep crawlers out.
 *
 * This site holds the full text of articles it did not write. Republishing them
 * for one reader on one device is the point; letting a crawler mirror them into
 * a search index or a training corpus is not, and a public URL is an open door
 * unless something says otherwise.
 *
 * A blanket `Disallow: /` is the whole policy. The named agents below are
 * redundant against a crawler that reads the wildcard group correctly, and are
 * listed anyway because several of them historically did not - a bot that
 * matches its own name is more reliably stopped than one relying on `*`.
 *
 * Worth being clear about the limit: `Disallow` stops a polite crawler from
 * *fetching* the page, which also stops it from ever seeing the `noindex` meta
 * tag inside. A URL linked from elsewhere can therefore still surface as a bare
 * link. That is why `noindex` ships three ways - here, in every page's head,
 * and as an `X-Robots-Tag` header on every response including the EPUBs, which
 * have no head to put a meta tag in.
 */
import { defineHandler } from "nitro/h3";

/*
 * Named for the same reason a sign is posted on a fence that is already locked.
 * The list is deliberately short: general-purpose search crawlers plus the
 * AI-training fetchers that publish a token to match on. It is not maintained
 * as an exhaustive registry, because the wildcard group is what actually does
 * the work.
 */
const AGENTS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-Web",
  "anthropic-ai",
  "CCBot",
  "Google-Extended",
  "PerplexityBot",
  "Applebot-Extended",
  "Bytespider",
  "Amazonbot",
  "meta-externalagent",
  "FacebookBot",
  "Diffbot",
  "ImagesiftBot",
  "omgili",
  "Timpibot",
  "cohere-ai",
  "YouBot",
];

const BODY = [
  "# This site republishes articles written by other people, for reading on",
  "# e-ink devices. It is not a source. Please crawl the originals instead -",
  "# every page links to the one it came from.",
  "",
  "User-agent: *",
  "Disallow: /",
  "",
  ...AGENTS.flatMap((agent) => [`User-agent: ${agent}`, "Disallow: /", ""]),
].join("\n");

export default defineHandler((event) => {
  event.res.headers.set("content-type", "text/plain; charset=utf-8");
  // A day. Long enough that a crawler is not re-fetching it constantly, short
  // enough that a change to the policy takes effect without a cache purge.
  event.res.headers.set("cache-control", "public, max-age=86400");
  return BODY;
});
