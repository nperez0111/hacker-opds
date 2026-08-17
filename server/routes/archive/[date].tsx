import { defineHandler } from "nitro/h3";
import { getEditionStories, listEditions, today } from "~/core/edition";
import { readFont } from "~/web/fonts";
import { Shell, pageAttrs } from "~/web/layout";
import { longDate } from "~/web/format";
import { rssEditionPath } from "~/rss/channel";
import { EditionView, NotFoundView } from "~/web/views";
import { readTheme } from "~/web/theme";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `GET /archive/<YYYY-MM-DD>` - one past edition.
 *
 * Editions are immutable once built, so this can be cached hard. That is what
 * makes the service worker's cache-first strategy for this path correct rather
 * than merely convenient.
 *
 * A typo returns 404 rather than an empty edition page, so neither a browser
 * nor the worker caches a page for a day that will never exist.
 */
export default defineHandler((event) => {
  const theme = readTheme(event);
  const font = readFont(event);
  const date = event.context.params?.date ?? "";
  const known = DATE.test(date) && listEditions(1000).some((e) => e.date === date);

  if (!known) {
    return (
      <html {...pageAttrs({ theme, font, status: 404, cacheControl: "no-store" })}>
        <Shell title="No such edition" theme={theme} font={font} path="/archive">
          <NotFoundView message={`There is no edition for ${date}.`} />
        </Shell>
      </html>
    );
  }

  const stories = getEditionStories(date);
  return (
    <html
      {...pageAttrs({ theme, font, cacheControl: "public, max-age=86400" })}
    >
      <Shell
        title={longDate(date)}
        theme={theme} font={font}
        path="/archive"
        description={`The top ${stories.length} Hacker News stories of ${longDate(date)}.`}
        feed={{ href: rssEditionPath(date), title: `Hacker News \u2014 ${longDate(date)}` }}
      >
        <EditionView
          date={date}
          today={today()}
          stories={stories}
          subtitle={longDate(date)}
        />
      </Shell>
    </html>
  );
});
