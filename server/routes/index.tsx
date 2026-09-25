import { defineHandler } from "nitro/h3";
import { editionExists, getEditionStories, latestEdition, today, yesterday } from "~/core/edition";
import { Shell, pageAttrs } from "~/web/layout";
import { readPreferences } from "~/web/settings";
import { longDate } from "~/web/format";
import { estimateEditionSave } from "~/web/size";
import { EditionView } from "~/web/views";

/**
 * `GET /` - the latest available edition, with its actual date in the heading.
 *
 * Never cached at the edge. The date called yesterday changes daily, and the
 * service worker treats this URL as network-first for the same reason.
 */
export default defineHandler((event) => {
  const prefs = readPreferences(event);
  const requested = yesterday();
  const date = editionExists(requested) ? requested : latestEdition();

  if (!date) {
    return (
      <html {...pageAttrs({ prefs, cacheControl: "no-cache" })}>
        <Shell title="No editions yet" prefs={prefs} path="/">
          <h1 class="page-title">No editions yet</h1>
          <p class="empty">The first edition is being prepared. Check back after the next hourly update.</p>
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
          subtitle={date === requested ? undefined : `Latest available edition: ${longDate(date)}. The edition for ${longDate(requested)} is being prepared.`}
        />
      </Shell>
    </html>
  );
});
