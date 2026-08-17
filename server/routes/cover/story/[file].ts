import { HTTPError, defineHandler } from "nitro/h3";
import { getStory } from "~/core/edition";
import { coverHeaders, storyCover } from "~/epub/cover";

const FILE = /^(\d+)(\.thumb)?\.png$/;

/**
 * `/cover/story/<id>.png` and `/cover/story/<id>.thumb.png`
 *
 * The image an OPDS client shows in its grid, and the one embedded in the book.
 * Two sizes because a catalogue listing thirty entries would otherwise pull
 * thirty full-size covers over an e-reader's radio to draw them at 120px; the
 * thumbnail is a seventh of the bytes and is re-rendered from the same vector
 * source rather than downscaled, so it stays sharp.
 *
 * Generation is deterministic and cached in the asset store, so this is a
 * database lookup and a file read in the steady state. It never touches the
 * network, which is why - unlike the EPUB routes - there is no throttle path.
 */
export default defineHandler(async (event) => {
  const file = event.context.params?.file ?? "";
  const match = FILE.exec(file);
  if (!match) {
    throw new HTTPError({ status: 400, message: "Expected <id>.png or <id>.thumb.png" });
  }

  const id = Number(match[1]);
  const story = getStory(id);
  if (!story) throw new HTTPError({ status: 404, message: `No story ${id}` });

  const asset = await storyCover(story, match[2] ? "thumb" : "full");
  const headers = coverHeaders(asset);

  if (event.req.headers.get("if-none-match") === headers.etag) {
    return new Response(null, { status: 304, headers: { etag: headers.etag as string } });
  }

  return new Response(asset.data, { headers });
});
