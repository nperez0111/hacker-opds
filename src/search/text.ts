/**
 * Turning a stored article into the text that goes into the index.
 *
 * `articles.markdown` is what turndown produced, and it is not what you want to
 * index verbatim. Two measured reasons (210 stories, 2.76 MB of markdown):
 *
 *  - Snippets come out as markup. FTS5 returns a window of the *stored* text,
 *    so a raw-markdown index answers a search for "ploopy" with
 *    "the **A+**. ![](https://cdn.ploopy.co/aplus-media-assets/site-photos/_MG"
 *    - an image URL, presented to the reader as a summary of the article.
 *  - Markup is a third of the corpus. Stripping it took the index from 1301 KB
 *    to 959 KB and the worst-case query (a term present in every document,
 *    where FTS5 has to hunt for the best passage in each hit) from 282 ms to
 *    155 ms.
 *
 * So the body is flattened to prose first. Nothing here tries to be a markdown
 * parser: it is a sequence of deletions whose only job is to leave words behind
 * and take punctuation away. A missed edge case costs a slightly noisier
 * snippet, never a wrong result.
 */

/**
 * How much of an article is indexed.
 *
 * Snippet extraction is linear in document length and it is the dominant cost
 * of a search - it is the difference between a 4 ms query and a 60 ms one. The
 * corpus is long-tailed: the median article flattens to 5.5 KB, the 90th
 * percentile to 21 KB, and the longest single article to 115 KB, so a handful
 * of outliers set the worst case for everybody.
 *
 * Measured across the whole corpus, per cap:
 *
 *   cap        index     worst query   hits for "design"
 *   4 KB       381 KB      24 ms          42
 *   8 KB       583 KB      44 ms          52
 *   16 KB      776 KB      62 ms          56
 *   32 KB      888 KB      77 ms          59
 *   none       959 KB     155 ms          59
 *
 * 16 KB is the knee: it holds the complete text of roughly seven articles in
 * eight, costs 5 % of the recall of an uncapped index, and keeps the worst case
 * bounded as the archive grows. The words that fall off the end are the tail of
 * a long article, which is the least likely part of it to be what someone is
 * searching for.
 */
export const BODY_MAX_CHARS = 16_000;

/**
 * Markdown to indexable prose.
 *
 * Order matters: fenced code goes before inline backticks, and images before
 * links, because an image is a link with a bang in front of it.
 */
export function searchBody(markdown: string | null | undefined): string {
  if (typeof markdown !== "string" || markdown.length === 0) return "";

  const flat = markdown
    // Fenced code blocks. Dropped whole rather than unwrapped: a block of
    // configuration or minified output is a dense mass of tokens that dilutes
    // every real word in the document, and it is never a good snippet.
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    // Images: the alt text is usually absent and the URL is never worth
    // matching on.
    //
    // The label pattern tolerates one level of nested brackets, because real
    // alt text contains them - "Plot of Sin[x]" is what put this here, having
    // shipped the raw "![Plot of Sin[" into a search result. Deeper nesting
    // than that is left alone: the cost is a noisier snippet, not a wrong
    // result, and a regex is the wrong tool for arbitrary depth.
    .replace(/!\[(?:[^[\]]|\[[^\]]*\])*\]\([^)]*\)/g, " ")
    // Links keep their label and lose their target.
    .replace(/\[((?:[^[\]]|\[[^\]]*\])*)\]\([^)]*\)/g, "$1")
    // Reference-style link definitions, and any HTML turndown passed through.
    .replace(/^\s*\[[^\]]*\]:\s*\S+.*$/gm, " ")
    .replace(/<[^>]+>/g, " ")
    // Bare URLs. A reader searching for a domain wants the story list, which is
    // filtered on stories.domain, not a hit inside someone's footnote.
    .replace(/\b(?:https?|ftp|mailto):\S+/gi, " ")
    // Horizontal rules and setext underlines, which are a line of punctuation
    // on their own and read as a row of dashes dropped into a snippet.
    .replace(/^[ \t]*([-*=_])(?:[ \t]*\1){2,}[ \t]*$/gm, " ")
    // Emphasis, headings, quote markers, table pipes.
    .replace(/[#*_>`|~]+/g, " ")
    // List bullets, which are only markup at the start of a line.
    .replace(/^[ \t]*[-+]\s+/gm, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (flat.length <= BODY_MAX_CHARS) return flat;

  // Cut on a word boundary so the last token in the index is a real word
  // rather than a fragment that matches nothing.
  const cut = flat.slice(0, BODY_MAX_CHARS);
  const space = cut.lastIndexOf(" ");
  return space > BODY_MAX_CHARS - 200 ? cut.slice(0, space) : cut;
}
