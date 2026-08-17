import { defineHandler } from "nitro/h3";
import { getEditionStories, latestEdition, today } from "~/core/edition";
import { readFont } from "~/web/fonts";
import { Shell, pageAttrs } from "~/web/layout";
import { longDate } from "~/web/format";
import { EditionView, NotFoundView } from "~/web/views";
import { readTheme } from "~/web/theme";

/**
 * `GET /` - the most recent edition we hold.
 *
 * Deliberately the latest *built* edition rather than the current calendar
 * day: an edition only closes after `EDITION_LAG_HOURS`, so on a fresh morning
 * "today" does not exist yet and this would otherwise be an empty page.
 *
 * Never cached at the edge. Which edition is newest changes daily, and the
 * service worker treats this URL as network-first for the same reason.
 */
export default defineHandler((event) => {
  const theme = readTheme(event);
  const font = readFont(event);
  const date = latestEdition();

  if (!date) {
    return (
      <html {...pageAttrs({ theme, font, status: 404, cacheControl: "no-cache" })}>
        <Shell title="No editions yet" theme={theme} font={font} path="/">
          <NotFoundView message="No edition has been built yet. Check back shortly." />
        </Shell>
      </html>
    );
  }

  const stories = getEditionStories(date);
  return (
    <html {...pageAttrs({ theme, font, cacheControl: "no-cache" })}>
      <Shell
        title="Today"
        theme={theme} font={font}
        path="/"
        description={`The top ${stories.length} Hacker News stories of ${longDate(date)}, as readable articles with their comments.`}
      >
        <EditionView date={date} today={today()} stories={stories} />
      </Shell>
    </html>
  );
});
