import { defineHandler } from "nitro/h3";
import { readFont } from "~/web/fonts";
import { Shell, pageAttrs } from "~/web/layout";
import { OfflineView } from "~/web/views";
import { readTheme } from "~/web/theme";

/**
 * `GET /offline` - the service worker's last resort.
 *
 * Precached at install time so it is always available, and reachable directly
 * so it can be styled and proofread like any other page rather than existing
 * only inside a failure path.
 *
 * Cached hard: it must survive precisely the situation where nothing can be
 * fetched, and its content never changes.
 */
export default defineHandler((event) => {
  const theme = readTheme(event);
  const font = readFont(event);
  return (
    <html {...pageAttrs({ theme, font, cacheControl: "public, max-age=86400" })}>
      <Shell title="Offline" theme={theme} font={font} path="/offline">
        <OfflineView />
      </Shell>
    </html>
  );
});
