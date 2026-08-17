import { HTTPError, defineHandler } from "nitro/h3";
import { buildEditionEpub } from "~/build/edition";
import { BuildError } from "~/build/story";
import { EPUB_TYPE } from "~/opds/atom";
import { HnThrottled } from "~/core/hn-html";
import { config } from "~/config";

const FILE = /^(\d{4}-\d{2}-\d{2})\.epub$/;

/**
 * `/epub/edition/<YYYY-MM-DD>.epub`
 *
 * The whole day as one book. Identical contract to the per-story route - the
 * suffix is in the path because several e-readers decide how to handle a
 * download from the URL rather than the content type, the artifact is immutable
 * and content-addressed so it carries a strong ETag, and the build is coalesced
 * upstream so simultaneous requests for a cold edition share one job.
 */
export default defineHandler(async (event) => {
  const file = event.context.params?.file ?? "";
  const match = FILE.exec(file);
  if (!match) {
    throw new HTTPError({ status: 400, message: "Expected <YYYY-MM-DD>.epub" });
  }

  const date = match[1] as string;
  let build;
  try {
    // A reader is waiting, so the same short patience budget the per-story
    // route uses; the background pass builds these long before anyone asks.
    build = await buildEditionEpub(date, { maxWaitMs: config().hnOnDemandWaitMs });
  } catch (err) {
    if (err instanceof BuildError && err.code === "unknown_edition") {
      throw new HTTPError({ status: 404, message: `No edition for ${date}` });
    }
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

  if (!build.path || build.sha256 === null || build.bytes === null) {
    throw new HTTPError({ status: 500, message: `Incomplete build record for ${date}` });
  }

  const etag = `"${build.sha256}"`;
  if (event.req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag } });
  }

  return new Response(Bun.file(build.path).stream(), {
    headers: {
      "content-type": EPUB_TYPE,
      "content-length": String(build.bytes),
      "content-disposition": `attachment; filename="hn-${date}.epub"`,
      "cache-control": "public, max-age=31536000, immutable",
      etag,
    },
  });
});
