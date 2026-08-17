import { describe, expect, test } from "bun:test";
import { XMLValidator } from "fast-xml-parser";
import { toXhtmlFragment, xhtmlDocument, xmlEscape } from "~/epub/xhtml";

/** Asserts a string is well-formed XML, surfacing the parser error if not. */
function expectWellFormedXml(xml: string): void {
  const result = XMLValidator.validate(xml);
  if (result !== true) {
    throw new Error(
      `not well-formed XML: ${result.err.msg} (line ${result.err.line})\n${xml}`,
    );
  }
}

describe("toXhtmlFragment: well-formedness", () => {
  test("closes void elements", () => {
    const out = toXhtmlFragment("<p>a<br>b</p>");
    expect(out).toContain("<br />");
    expect(out).not.toMatch(/<br>/);
  });

  test("closes img tags", () => {
    const out = toXhtmlFragment('<img src="https://e.com/a.png" alt="x">');
    expect(out).toContain("/>");
    expect(out).not.toMatch(/<img[^>]*[^/]>/);
  });

  test("repairs HN-style unclosed paragraphs", () => {
    // This is exactly what the HN API returns for multi-paragraph comments.
    const out = toXhtmlFragment("<p>first<p>second<p>third");
    expect(out).toBe("<p>first</p><p>second</p><p>third</p>");
  });

  test("never emits named character references", () => {
    // Named entities beyond the XML five are undefined without a DTD. The
    // serialiser resolves them to literal UTF-8 characters, which is valid.
    const out = toXhtmlFragment("<p>a&nbsp;b&mdash;c</p>");
    expect(out).not.toContain("&nbsp;");
    expect(out).not.toContain("&mdash;");
    expect(out).toContain("\u00a0");
    expect(out).toContain("\u2014");
    expectWellFormedXml(`<root>${out}</root>`);
  });

  test("escapes bare ampersands and angle brackets", () => {
    const out = toXhtmlFragment("<p>Tom & Jerry 3 &lt; 5</p>");
    expect(out).toContain("&#x26;");
    expect(out).not.toMatch(/&(?![#a-zA-Z])/);
  });

  test("produces a well-formed XML document from messy input", () => {
    const messy = "<p>a<br>b<p>c<img src='https://e.com/i.png'><ul><li>x<li>y";
    expectWellFormedXml(xhtmlDocument("t", toXhtmlFragment(messy)));
  });

  test("survives a torture case of real-world breakage", () => {
    const nasty = [
      "<p>unclosed",
      "<div><span>crossed</div></span>",
      "<p>bare & ampersand and a < bracket",
      "<img src='https://e.com/a.png'>",
      "<table><tr><td>a<td>b</table>",
      "<p>emoji \u{1F600} and nbsp\u00a0here",
      "<a href='https://e.com/?x=1&y=2'>q</a>",
    ].join("");
    expectWellFormedXml(xhtmlDocument("torture", toXhtmlFragment(nasty)));
  });

  test("escapes ampersands inside attribute values", () => {
    const out = toXhtmlFragment("<a href='https://e.com/?x=1&y=2'>q</a>");
    expect(out).toContain("&#x26;");
    expectWellFormedXml(`<root>${out}</root>`);
  });
});

describe("toXhtmlFragment: sanitisation", () => {
  test("strips script and its contents", () => {
    const out = toXhtmlFragment("<p>keep</p><script>alert(1)</script>");
    expect(out).toBe("<p>keep</p>");
  });

  test("strips style, iframe and form subtrees", () => {
    const out = toXhtmlFragment(
      "<style>p{}</style><iframe src='https://e.com'></iframe>" +
        "<form><input value='x'></form><p>keep</p>",
    );
    expect(out).toBe("<p>keep</p>");
  });

  test("removes javascript: and data: urls", () => {
    const out = toXhtmlFragment(
      "<a href=\"javascript:alert(1)\">x</a><a href=\"data:text/html,x\">y</a>",
    );
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("data:");
  });

  test("removes event handler attributes", () => {
    const out = toXhtmlFragment('<p onclick="alert(1)">hi</p>');
    expect(out).toBe("<p>hi</p>");
  });

  test("keeps ordinary formatting and links", () => {
    const out = toXhtmlFragment(
      '<p>a <i>b</i> <code>c</code> <a href="https://e.com/x">d</a></p>',
    );
    expect(out).toContain("<i>b</i>");
    expect(out).toContain("<code>c</code>");
    expect(out).toContain('href="https://e.com/x"');
  });

  test("keeps blockquote and pre, which HN comments use", () => {
    const out = toXhtmlFragment(
      "<blockquote><p>quoted</p></blockquote><pre><code>x = 1</code></pre>",
    );
    expect(out).toContain("<blockquote>");
    expect(out).toContain("<pre><code>x = 1</code></pre>");
  });
});

describe("toXhtmlFragment: transforms", () => {
  test("resolves relative urls against baseUrl", () => {
    const out = toXhtmlFragment(
      '<a href="/about">a</a><img src="img/x.png" alt="">',
      { baseUrl: "https://example.com/blog/post" },
    );
    expect(out).toContain('href="https://example.com/about"');
    expect(out).toContain('src="https://example.com/blog/img/x.png"');
  });

  test("leaves absolute urls untouched", () => {
    const out = toXhtmlFragment('<a href="https://other.com/x">a</a>', {
      baseUrl: "https://example.com/",
    });
    expect(out).toContain('href="https://other.com/x"');
  });

  test("converts defuddle MathML to inline code with the LaTeX source", () => {
    const out = toXhtmlFragment(
      '<p>see <math data-latex="e^{i\\pi}+1=0"><mi>x</mi></math></p>',
    );
    expect(out).toContain("e^{i\\pi}+1=0");
    expect(out).not.toContain("<math");
    expect(out).not.toContain("<mi>");
  });

  test("drops whitespace-only paragraphs", () => {
    const out = toXhtmlFragment("<p>keep</p><p>   </p><p></p><p>also</p>");
    expect(out).toBe("<p>keep</p><p>also</p>");
  });

  test("keeps paragraphs holding only an image", () => {
    const out = toXhtmlFragment('<p><img src="https://e.com/a.png" alt=""></p>');
    expect(out).toContain("<img");
  });

  test("returns empty string for empty input", () => {
    expect(toXhtmlFragment("")).toBe("");
    expect(toXhtmlFragment("   ")).toBe("");
  });
});

describe("xmlEscape", () => {
  test("escapes all five XML predefined entities", () => {
    expect(xmlEscape(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&apos;");
  });

  test("escapes ampersand first so entities are not double-formed", () => {
    expect(xmlEscape("a & <b>")).toBe("a &amp; &lt;b&gt;");
  });
});

describe("xhtmlDocument", () => {
  test("emits an XML declaration and xhtml namespace", () => {
    const doc = xhtmlDocument("Title", "<p>x</p>");
    expect(doc.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(doc).toContain('xmlns="http://www.w3.org/1999/xhtml"');
    expect(doc).toContain('xmlns:epub="http://www.idpf.org/2007/ops"');
  });

  test("escapes the title", () => {
    const doc = xhtmlDocument('A & B <c>', "<p>x</p>");
    expect(doc).toContain("<title>A &amp; B &lt;c&gt;</title>");
  });

  test("links the stylesheet when given and omits it otherwise", () => {
    expect(xhtmlDocument("t", "", { cssHref: "../style.css" })).toContain(
      'href="../style.css"',
    );
    expect(xhtmlDocument("t", "")).not.toContain("<link");
  });

  test("sets both lang and xml:lang", () => {
    const doc = xhtmlDocument("t", "", { lang: "fr" });
    expect(doc).toContain('lang="fr"');
    expect(doc).toContain('xml:lang="fr"');
  });
});
