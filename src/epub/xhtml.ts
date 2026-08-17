import rehypeParse from "rehype-parse";
import { unified } from "unified";
import { defaultSchema, sanitize, type Schema } from "hast-util-sanitize";
import { toHtml } from "hast-util-to-html";
import { visit } from "unist-util-visit";
import type { Element, Root, RootContent } from "hast";

/**
 * EPUB requires well-formed XHTML. Two inputs violate that:
 *   - defuddle emits HTML5 (void elements unclosed, named entities)
 *   - HN comment HTML uses unclosed <p> and bare <i>, and is not a tree
 *
 * Parsing with rehype repairs the structure, sanitize drops anything an
 * e-reader cannot handle, and toHtml serialises back with self-closing tags
 * and numeric character references (named refs like &nbsp; are undefined in
 * XHTML without a DTD and will fail validation).
 */

const ALLOWED_TAGS = [
  "a", "abbr", "b", "blockquote", "br", "caption", "cite", "code", "col",
  "colgroup", "dd", "del", "dfn", "div", "dl", "dt", "em", "figcaption",
  "figure", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "ins",
  "kbd", "li", "mark", "ol", "p", "pre", "q", "s", "samp", "section",
  "small", "span", "strong", "sub", "sup", "table", "tbody", "td", "tfoot",
  "th", "thead", "tr", "u", "ul", "var", "wbr",
];

/** Elements whose entire subtree is meaningless in an offline e-book. */
const DROP_SUBTREE = new Set([
  "script", "style", "noscript", "iframe", "object", "embed", "form",
  "input", "button", "select", "textarea", "svg", "canvas", "template",
  "video", "audio", "map", "area", "dialog", "menu",
]);

export const EPUB_SANITIZE_SCHEMA: Schema = {
  ...defaultSchema,
  tagNames: ALLOWED_TAGS,
  attributes: {
    ...defaultSchema.attributes,
    a: ["href", "title", "id"],
    img: ["src", "alt", "title", "width", "height"],
    code: ["className", "dataLang"],
    pre: ["className"],
    div: ["className", "id", "dataCallout"],
    span: ["className", "id"],
    section: ["className", "id"],
    li: ["className", "id"],
    sup: ["className", "id"],
    td: ["colSpan", "rowSpan"],
    th: ["colSpan", "rowSpan", "scope"],
    "*": ["id"],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: ["http", "https", "mailto"],
    src: ["http", "https"],
  },
  clobber: [],
  strip: [...DROP_SUBTREE],
};

function isElement(node: RootContent): node is Element {
  return node.type === "element";
}

/** Rewrites relative hrefs/srcs to absolute so links work offline. */
function absolutise(tree: Root, baseUrl?: string): void {
  if (!baseUrl) return;
  visit(tree, "element", (node: Element) => {
    for (const attr of ["href", "src"] as const) {
      const value = node.properties?.[attr];
      if (typeof value !== "string") continue;
      try {
        node.properties![attr] = new URL(value, baseUrl).toString();
      } catch {
        delete node.properties![attr];
      }
    }
  });
}

/**
 * defuddle converts MathJax/KaTeX to MathML carrying the original LaTeX in
 * data-latex. Full MathML is inconsistently supported across e-readers, so the
 * LaTeX source is rendered as inline code instead -- readable everywhere and
 * always valid XHTML.
 */
function mathToCode(tree: Root): void {
  visit(tree, "element", (node: Element, index, parent) => {
    if (node.tagName !== "math" || !parent || index === undefined) return;
    const latex = node.properties?.dataLatex;
    const replacement: Element = {
      type: "element",
      tagName: "code",
      properties: { className: ["math"] },
      children: [{ type: "text", value: typeof latex === "string" ? latex : "" }],
    };
    parent.children[index] = replacement;
  });
}

/** Drops paragraphs and divs that contain nothing but whitespace. */
function dropEmpty(tree: Root): void {
  const prune = (nodes: RootContent[]): RootContent[] =>
    nodes.filter((node) => {
      if (!isElement(node)) return true;
      node.children = prune(node.children) as typeof node.children;
      if (node.tagName !== "p" && node.tagName !== "div") return true;
      if (node.children.length === 0) return false;
      return node.children.some(
        (c) => c.type !== "text" || c.value.trim() !== "",
      );
    });
  tree.children = prune(tree.children);
}

export interface XhtmlOptions {
  /** Absolute base for resolving relative links. */
  baseUrl?: string;
}

/**
 * Parses a loose HTML fragment and returns a sanitized, well-formed XHTML
 * fragment (no wrapper element).
 */
export function toXhtmlFragment(html: string, opts: XhtmlOptions = {}): string {
  if (!html || !html.trim()) return "";

  const tree = unified()
    .use(rehypeParse, { fragment: true })
    .parse(html) as Root;

  mathToCode(tree);
  absolutise(tree, opts.baseUrl);

  const clean = sanitize(tree, EPUB_SANITIZE_SCHEMA) as Root;
  dropEmpty(clean);

  return toHtml(clean, {
    // XHTML serialisation: <br /> not <br>, and numeric entities only.
    closeSelfClosing: true,
    closeEmptyElements: true,
    tightSelfClosing: false,
    characterReferences: { useNamedReferences: false },
    allowDangerousHtml: false,
  });
}

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

/** Escapes a string for use in XML text or an attribute value. */
export function xmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => XML_ESCAPES[ch]!);
}

/** Wraps a fragment in a complete XHTML document for inclusion in an EPUB. */
export function xhtmlDocument(
  title: string,
  body: string,
  opts: { cssHref?: string; lang?: string } = {},
): string {
  const css = opts.cssHref
    ? `\n    <link rel="stylesheet" type="text/css" href="${xmlEscape(opts.cssHref)}" />`
    : "";
  const lang = opts.lang || "en";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${xmlEscape(lang)}" xml:lang="${xmlEscape(lang)}">
  <head>
    <meta charset="utf-8" />
    <title>${xmlEscape(title)}</title>${css}
  </head>
  <body>
${body}
  </body>
</html>
`;
}
