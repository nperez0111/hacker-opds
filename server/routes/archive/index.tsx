import { defineHandler } from "nitro/h3";
import { listEditions, today } from "~/core/edition";
import { readFont } from "~/web/fonts";
import { Shell, pageAttrs } from "~/web/layout";
import { ArchiveView } from "~/web/views";
import { readTheme } from "~/web/theme";

/**
 * `GET /archive` - every edition still inside the retention window.
 *
 * Unpaginated on purpose: retention is 90 days, so this list has a hard
 * ceiling of 90 rows. Pagination would add a control surface for a page that
 * cannot grow past one comfortable scroll.
 */
export default defineHandler((event) => {
  const theme = readTheme(event);
  const font = readFont(event);
  const editions = listEditions(1000);

  return (
    <html {...pageAttrs({ theme, font, cacheControl: "no-cache" })}>
      <Shell
        title="Archive"
        theme={theme} font={font}
        path="/archive"
        description="Past daily editions of the top Hacker News stories."
      >
        <ArchiveView editions={editions} today={today()} />
      </Shell>
    </html>
  );
});
