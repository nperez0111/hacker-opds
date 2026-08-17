import { HTTPError, defineHandler } from "nitro/h3";
import { BuildError, buildStoryEpub } from "~/build/story";
import { EPUB_TYPE } from "~/opds/atom";
import { HnThrottled } from "~/core/hn-html";
import { config } from "~/config";

/**
 * `/epub/story/<id>.epub`
 *
 * The `.epub` suffix is part of the path rather than a query parameter because
 * several e-readers (Kobo's native browser in particular) decide how to handle
 * a download from the URL, not the content type.
 *
 * Artifacts are immutable and content-addressed, so they carry a strong ETag
 * derived from the sha256 and a one-year immutable cache policy. The build is
 * coalesced upstream, so simultaneous requests for a cold story share one job.
 */
export default defineHandler(async (event) => {
  const file = event.context.params?.file ?? "";
  const match = /^(\d+)\.epub$/.exec(file);
  if (!match) {
    throw new HTTPError({ status: 400, message: "Expected <id>.epub" });
  }

  const id = Number(match[1]);
  let build;
  try {
    // A reader is waiting, so this build gets a much shorter patience budget
    // than the background prewarm does.
    build = await buildStoryEpub(id, { maxWaitMs: config().hnOnDemandWaitMs });
  } catch (err) {
    if (err instanceof BuildError && err.code === "unknown_story") {
      throw new HTTPError({ status: 404, message: `No story ${id}` });
    }
    // Hacker News is throttling us. Say so honestly with a Retry-After rather
    // than serving a book with no comments in it; the nightly prewarm will
    // usually have this built long before anyone asks.
    if (err instanceof HnThrottled) {
      return new Response("Upstream rate limit; try again shortly.\n", {
        status: 503,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "retry-after": String(Math.ceil(err.waitMs / 1000)),
          "cache-control": "no-store",
        },
      });
    }
    throw err;
  }

  // The ledger columns are nullable because a row exists while a build is in
  // flight. A resolved `buildStoryEpub` always fills them, so a null here means
  // the ledger and the blob store have diverged.
  if (!build.path || build.sha256 === null || build.bytes === null) {
    throw new HTTPError({ status: 500, message: `Incomplete build record for ${id}` });
  }

  const etag = `"${build.sha256}"`;
  if (event.req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag } });
  }

  return new Response(Bun.file(build.path).stream(), {
    headers: {
      "content-type": EPUB_TYPE,
      "content-length": String(build.bytes),
      "content-disposition": `attachment; filename="hn-${id}.epub"`,
      "cache-control": "public, max-age=31536000, immutable",
      etag,
    },
  });
});
