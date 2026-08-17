/**
 * The OpenSearch description document.
 *
 * OPDS 1.2 has no search syntax of its own. It says: put a
 * `rel="search"` link on the catalogue root, point it at an OpenSearch 1.1
 * description document, and let the client read the URL template out of that.
 * So a reader needs two documents before it will show a search box, and this is
 * the first of them.
 *
 * Hand-rolled for the same reason the Atom serialiser is (see the note at the
 * top of ~/opds/atom): it is thirty lines of XML whose every detail - the exact
 * `type` on the Url element, the 1-based `indexOffset`, the length limit on
 * ShortName - is the part a general-purpose library gets wrong.
 *
 * The details that are load-bearing on real readers:
 *
 *  - ShortName must be at most 16 characters. Longer and strict clients reject
 *    the whole document, which reads as "this catalogue has no search".
 *  - The Url template must be absolute. The document is often fetched and
 *    cached separately from the feed that linked to it, so there is no reliable
 *    base for a relative template to resolve against.
 *  - `{searchTerms}` is the only placeholder declared. An optional parameter
 *    such as `{startIndex?}` is substituted only by a client that recognises
 *    it, and left verbatim in the URL by one that does not - so declaring it
 *    buys nothing and risks a literal brace in the query string. Paging is
 *    advertised through the `rel="next"` link on the result feed instead, which
 *    is the mechanism readers already follow through the rest of the catalogue.
 */
import { config } from "~/config";
import { xmlEscape } from "~/epub/xhtml";
import { ACQUISITION_TYPE } from "~/opds/atom";

/** Where the description document is served, and what the root feed links to. */
export const OPENSEARCH_PATH = "/opds/opensearch.xml";

/** Where the description document sends the reader. */
export const OPENSEARCH_RESULTS_PATH = "/opds/search";

/** OpenSearch caps this at 16 characters. */
const SHORT_NAME = "Hacker News";

/**
 * `base` is threaded in from the request by the route, exactly as it is for the
 * feeds. The default is read from the config rather than taken from
 * `~/opds/catalog` so that the dependency runs one way - the catalogue links to
 * this document, this document does not know about the catalogue.
 */
export function openSearchDescription(base: string = config().publicBaseUrl): string {
  const template = `${base}${OPENSEARCH_RESULTS_PATH}?q={searchTerms}`;

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">',
    `  <ShortName>${xmlEscape(SHORT_NAME)}</ShortName>`,
    "  <Description>Search the titles and article text of every Hacker News story still held in the archive.</Description>",
    "  <InputEncoding>UTF-8</InputEncoding>",
    "  <OutputEncoding>UTF-8</OutputEncoding>",
    `  <Url type="${xmlEscape(ACQUISITION_TYPE)}"`,
    '       rel="results"',
    `       template="${xmlEscape(template)}"/>`,
    "</OpenSearchDescription>",
    "",
  ].join("\n");
}
