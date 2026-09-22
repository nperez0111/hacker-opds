import { defineHandler } from "nitro/h3";
import { editionExists, getEditionStories, today, yesterday } from "~/core/edition";
import { Shell, pageAttrs } from "~/web/layout";
import { readPreferences } from "~/web/settings";
import { longDate } from "~/web/format";
import { estimateEditionSave } from "~/web/size";
import { EditionView, NotFoundView } from "~/web/views";

/**
 * `GET /` - yesterday's edition in the configured deployment timezone.
 *
 * Deliberately names the date instead of falling back to the latest row. If
 * ingestion is late, showing a two-day-old edition as though it were yesterday
 * is worse than reporting that yesterday is not ready yet.
 *
 * Never cached at the edge. The date called yesterday changes daily, and the
 * service worker treats this URL as network-first for the same reason.
 */
export default defineHandler((event) => {
  const prefs = readPreferences(event);
  const date = yesterday();

  if (!editionExists(date)) {
    return (
      <html {...pageAttrs({ prefs, status: 404, cacheControl: "no-cache" })}>
        <Shell title="Yesterday is not ready" prefs={prefs} path="/">
          <NotFoundView message={`The edition for yesterday (${date}) is not available yet. Check back shortly.`} />
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
