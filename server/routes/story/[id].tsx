import { defineHandler } from "nitro/h3";
import { config } from "~/config";
import { getComments, groupThreads } from "~/core/comments";
import { getStory } from "~/core/edition";
import { getArticle } from "~/core/extract";
import { snippet } from "~/epub/render";
import { readFont } from "~/web/fonts";
import { Shell, pageAttrs } from "~/web/layout";
import { HN_ITEM } from "~/web/story";
import { StoryView, NotFoundView } from "~/web/views";
import { readTheme } from "~/web/theme";

/**
 * `GET /story/<id>` - the readable article plus its comment tree.
 *
 * The same content the EPUB carries, rendered as a page. Both come from the
 * same extraction and the same helpers in ~/epub/render, so a story cannot
 * read one way in the book and another way here.
 *
 * Cached for a day. A story's article text never changes once extracted, and
 * while its comment tree can still grow, an edition is only built after it has
 * gone quiet. Serving a slightly stale comment count is a fair trade for a page
 * that opens instantly from a service worker cache on a device with no radio.
 */
export default defineHandler((event) => {
  const theme = readTheme(event);
  const font = readFont(event);
  const raw = event.context.params?.id ?? "";
  const id = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  const story = Number.isFinite(id) ? getStory(id) : null;

  if (!story) {
    return (
      <html {...pageAttrs({ theme, font, status: 404, cacheControl: "no-store" })}>
        <Shell title="No such story" theme={theme} font={font} path="/">
          <NotFoundView message="That story is not in any edition we hold." />
        </Shell>
      </html>
    );
  }

  const article = getArticle(story.id);
  const threads = groupThreads(getComments(story.id));
  // Drawn from the extracted article rather than written by hand, so it
  // describes what the page actually contains. Omitted when extraction failed,
  // rather than padded out with the story title a second time.
  const description =
    article && article.xhtml ? snippet(article.xhtml, 180) : undefined;

  return (
    <html {...pageAttrs({ theme, font, cacheControl: "public, max-age=86400" })}>
      <Shell
        title={story.title}
        theme={theme}
        font={font}
        path="/"
        description={description}
        meta={{
          // The article's own URL, so this page never claims to be the origin.
          // A text post has no elsewhere to point at, so its canonical is the
          // Hacker News thread that is in fact the original.
          canonical: story.url ?? HN_ITEM + story.id,
          type: "article",
          siteName: story.domain ?? "Hacker News",
          // Taken from the article's own metadata where the publisher supplied
          // it, not from when Hacker News happened to see it.
          published: article?.published ?? undefined,
          author: article?.author ?? undefined,
          discussion: HN_ITEM + story.id,
        }}
      >
        <StoryView
          story={story}
          article={article}
          threads={threads}
          indentMaxDepth={config().commentIndentMaxDepth}
        />
      </Shell>
    </html>
  );
});
