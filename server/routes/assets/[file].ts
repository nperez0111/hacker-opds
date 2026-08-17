import { HTTPError, defineHandler } from "nitro/h3";
import { getWebAsset } from "~/web/assets";

/**
 * `/assets/<name>`
 *
 * The site's static files are generated TypeScript modules held in memory
 * rather than a `public/` directory, for the same reason the EPUB stylesheet
 * is (see `nitro.config.ts`): they bundle reliably and stay unit-testable
 * without a Nitro runtime.
 *
 * Two cache policies live here. Hashed assets (`site.css`, `app.js`) are
 * requested with a `?v=` token that changes whenever their bytes do, so they
 * are safe to freeze for a year. The service worker and the manifest are not
 * hashed - a worker's URL *is* its registration identity, so it must stay
 * stable across deploys - and therefore have to be revalidated every time.
 */
export default defineHandler((event) => {
  const name = event.context.params?.file ?? "";
  const asset = getWebAsset(name);
  if (!asset) {
    throw new HTTPError({ status: 404, message: `No asset ${name}` });
  }

  if (event.req.headers.get("if-none-match") === asset.etag) {
    return new Response(null, { status: 304, headers: { etag: asset.etag } });
  }

  const headers: Record<string, string> = {
    "content-type": asset.type,
    etag: asset.etag,
    "cache-control": asset.immutable
      ? "public, max-age=31536000, immutable"
      : "public, max-age=0, must-revalidate",
  };

  // Without this header a worker served from /assets/ may only control
  // /assets/, which would make it useless for caching pages.
  if (name === "sw.js") {
    headers["service-worker-allowed"] = "/";
  }

  return new Response(asset.body, { headers });
});
