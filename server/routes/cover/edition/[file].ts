import { HTTPError, defineHandler } from "nitro/h3";
import { getEditionStories } from "~/core/edition";
import { coverHeaders, editionCover } from "~/epub/cover";

const FILE = /^(\d{4}-\d{2}-\d{2})(\.thumb)?\.png$/;

/**
 * `/cover/edition/<YYYY-MM-DD>.png` and `.thumb.png`
 *
 * The digest's cover. Same contract as the story cover route; see the note
 * there. The story count is part of the artwork, so an edition with no stories
 * has no cover to draw and answers 404 - which is also the honest answer for a
 * date this archive does not hold.
 */
export default defineHandler(async (event) => {
  const file = event.context.params?.file ?? "";
  const match = FILE.exec(file);
  if (!match) {
    throw new HTTPError({
      status: 400,
      message: "Expected <YYYY-MM-DD>.png or <YYYY-MM-DD>.thumb.png",
    });
  }

  const date = match[1] as string;
  const stories = getEditionStories(date);
  if (stories.length === 0) {
    throw new HTTPError({ status: 404, message: `No edition for ${date}` });
  }

  const asset = await editionCover(date, stories.length, match[2] ? "thumb" : "full");
  const headers = coverHeaders(asset);

  if (event.req.headers.get("if-none-match") === headers.etag) {
    return new Response(null, { status: 304, headers: { etag: headers.etag as string } });
  }

  return new Response(asset.data, { headers });
});
