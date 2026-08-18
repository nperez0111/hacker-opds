import { defineHandler } from "nitro/h3";
import { Shell, pageAttrs } from "~/web/layout";
import { readPreferences } from "~/web/settings";
import { OfflineView } from "~/web/views";

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
  const prefs = readPreferences(event);
  return (
    <html {...pageAttrs({ prefs, cacheControl: "public, max-age=86400" })}>
      <Shell title="Offline" prefs={prefs} path="/offline">
        <OfflineView />
      </Shell>
    </html>
  );
});
