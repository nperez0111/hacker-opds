import { defineHandler } from "nitro/h3";
import { Shell, pageAttrs } from "~/web/layout";
import { readPreferences } from "~/web/settings";
import { SavedView } from "~/web/views";

/** Only the shell is shared/cacheable; personal data never leaves the device. */
export default defineHandler((event) => {
  const prefs = readPreferences(event);
  return (
    <html {...pageAttrs({ prefs, cacheControl: "public, max-age=86400" })}>
      <Shell title="Saved for later" prefs={prefs} path="/saved">
        <SavedView />
      </Shell>
    </html>
  );
});
