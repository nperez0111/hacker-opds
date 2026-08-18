import { defineHandler } from "nitro/h3";
import { getEditionStories, latestEdition, today } from "~/core/edition";
import { Shell, pageAttrs } from "~/web/layout";
import { readPreferences } from "~/web/settings";
import { longDate } from "~/web/format";
import { estimateEditionSave } from "~/web/size";
import { EditionView, NotFoundView } from "~/web/views";

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
  const prefs = readPreferences(event);
  const date = latestEdition();

  if (!date) {
    return (
      <html {...pageAttrs({ prefs, status: 404, cacheControl: "no-cache" })}>
        <Shell title="No editions yet" prefs={prefs} path="/">
          <NotFoundView message="No edition has been built yet. Check back shortly." />
        </Shell>
      </html>
    );
  }

  const stories = getEditionStories(date);
  return (
    <html {...pageAttrs({ prefs, cacheControl: "no-cache" })}>
      <Shell
        title="Today"
        prefs={prefs}
        path="/"
        description={`The top ${stories.length} Hacker News stories of ${longDate(date)}, as readable articles with their comments.`}
      >
        <EditionView
          date={date}
          today={today()}
          stories={stories}
          save={estimateEditionSave(date)}
        />
      </Shell>
    </html>
  );
});
