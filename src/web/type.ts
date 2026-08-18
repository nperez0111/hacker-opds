/**
 * Text size and line spacing, the two typographic settings the font choice
 * cannot cover.
 *
 * ## Why these two and not a slider
 *
 * A slider is the obvious control and it is unavailable: it is a form element,
 * it needs scripting to be useful, and this panel is built entirely out of
 * links for reasons `~/web/settings` sets out. What is left is a small closed
 * set of steps, which is a better fit anyway - a reader on an e-ink panel is
 * not fine-tuning, they are finding the one setting that stops the type looking
 * grey, and five options reach that in one tap rather than eleven.
 *
 * ## Why they are one module
 *
 * They are two independent preferences with two cookies, but they are the same
 * twenty lines of registry, guard and CSS generation, and splitting them would
 * duplicate the argument for how a scale is chosen without adding a boundary
 * anyone would ever want to move.
 *
 * ## How a choice becomes type
 *
 * Both follow the pattern `~/web/fonts` established: the cookie value is an
 * id, the id lands on `<html>` as a data attribute, and a generated rule keyed
 * on that attribute sets the property. The two rules are shaped differently and
 * the difference is not cosmetic.
 *
 * `font-size` lives on `html` in the site stylesheet, and `html` and `:root`
 * are the same element, so `:root[data-size="l"]` outranks it directly.
 *
 * `line-height` lives on `body`, and a declaration on `body` beats anything
 * `body` would otherwise inherit from the root no matter how specific the root
 * selector is. So the spacing rule has to match `body` itself -
 * `:root[data-spacing="loose"] body` - which is the same trap the font stack
 * rules document at `~/web/fonts`.
 *
 * ## What a size change moves with it
 *
 * Nearly everything in the stylesheet is expressed in rem, so this scales the
 * whole page rather than just its prose: headings, the rank column, the comment
 * header height in `--chead-h`, and the `--measure` cap on line length. That
 * last one is the point rather than a side effect. `--measure` is 34rem because
 * the limit that matters is characters per line, not millimetres, so a reader
 * who doubles the type keeps the same measure and gets a wider container to
 * hold it. The two things that deliberately do not scale are `--tap`, which is
 * a thumb and does not grow with the type, and the breakpoints, which are in px
 * for reasons the site stylesheet explains.
 */
import type { H3Event } from "nitro/h3";

import { cookieValue, preferenceCookie } from "~/web/cookie";

/* ------------------------------------------------------------------ */
/* text size                                                           */
/* ------------------------------------------------------------------ */

export type TextSize = "xs" | "s" | "m" | "l" | "xl";

export interface TextSizeOption {
  /** Cookie value and `data-size` attribute value. */
  id: TextSize;
  /** Name shown in the settings panel. */
  label: string;
  /**
   * The root font size, in px.
   *
   * Integers, and px rather than a percentage or a rem multiplier, because the
   * whole sheet is rem and this is the one number they all resolve against.
   * Naming it exactly means the resulting sizes are whatever the sheet says
   * times a number that is written down, rather than a product of two ratios.
   */
  px: number;
  /** One line in the settings panel, saying who the option is for. */
  note: string;
}

/**
 * Five steps, roughly a 1.125 ratio apart, centred on the 20px the site has
 * always used.
 *
 * The range is asymmetric on purpose. Below 16px an e-ink panel stops rendering
 * stem contrast and the text turns grey, which is the failure the 20px default
 * exists to avoid, so there is no point offering a step that reintroduces it.
 * Above 26px a 34rem measure is wider than any e-reader panel, so further steps
 * only shrink the characters per line without making anything more legible.
 */
export const TEXT_SIZES: readonly TextSizeOption[] = [
  {
    id: "xs",
    label: "Extra small",
    px: 16,
    note: "The browser default. Sharpest on a backlit screen.",
  },
  { id: "s", label: "Small", px: 18, note: "More words per screen." },
  { id: "m", label: "Medium", px: 20, note: "The default, tuned for e-ink." },
  { id: "l", label: "Large", px: 23, note: "Easier at arm's length." },
  { id: "xl", label: "Extra large", px: 26, note: "For reading without glasses." },
];

export const DEFAULT_TEXT_SIZE: TextSize = "m";

export const TEXT_SIZE_COOKIE = "size";

const SIZE_BY_ID: ReadonlyMap<string, TextSizeOption> = new Map(
  TEXT_SIZES.map((s) => [s.id, s]),
);

/**
 * Map lookup rather than a string comparison, so a cookie of "__proto__" or
 * "constructor" is a miss rather than a hit on an inherited property. Same
 * reasoning as `isFontId`.
 */
export function isTextSize(value: string): value is TextSize {
  return SIZE_BY_ID.has(value);
}

export function textSizeFromCookieHeader(header: string | null): TextSize {
  const value = cookieValue(header, TEXT_SIZE_COOKIE);
  return value !== null && isTextSize(value) ? value : DEFAULT_TEXT_SIZE;
}

export function readTextSize(event: H3Event): TextSize {
  return textSizeFromCookieHeader(event.req.headers.get("cookie"));
}

export function textSizeCookie(id: TextSize): string {
  return preferenceCookie(TEXT_SIZE_COOKIE, id);
}

/* ------------------------------------------------------------------ */
/* line spacing                                                        */
/* ------------------------------------------------------------------ */

export type LineSpacing = "tight" | "normal" | "loose";

export interface LineSpacingOption {
  /** Cookie value and `data-spacing` attribute value. */
  id: LineSpacing;
  label: string;
  /** Unitless, so nested elements inherit a ratio rather than a fixed height. */
  ratio: number;
  note: string;
}

/**
 * Three steps, not five.
 *
 * Leading is a smaller effect than size and a reader cannot see the difference
 * between adjacent fine steps in a settings list - they can only see it in a
 * paragraph, by which point the panel is closed. Three options are far enough
 * apart to be distinguishable from each other in the preview beside them.
 *
 * The ratios are unitless deliberately. A line-height with a unit computes once
 * on `body` and every descendant inherits the resulting length, so a heading at
 * 1.6rem would get body-sized leading and overlap itself.
 */
export const LINE_SPACINGS: readonly LineSpacingOption[] = [
  {
    id: "tight",
    label: "Tight",
    ratio: 1.35,
    note: "More lines per screen, fewer page turns.",
  },
  { id: "normal", label: "Normal", ratio: 1.55, note: "The default." },
  {
    id: "loose",
    label: "Loose",
    ratio: 1.8,
    note: "Easier to find the start of the next line.",
  },
];

export const DEFAULT_LINE_SPACING: LineSpacing = "normal";

export const LINE_SPACING_COOKIE = "spacing";

const SPACING_BY_ID: ReadonlyMap<string, LineSpacingOption> = new Map(
  LINE_SPACINGS.map((s) => [s.id, s]),
);

export function isLineSpacing(value: string): value is LineSpacing {
  return SPACING_BY_ID.has(value);
}

export function lineSpacingFromCookieHeader(header: string | null): LineSpacing {
  const value = cookieValue(header, LINE_SPACING_COOKIE);
  return value !== null && isLineSpacing(value) ? value : DEFAULT_LINE_SPACING;
}

export function readLineSpacing(event: H3Event): LineSpacing {
  return lineSpacingFromCookieHeader(event.req.headers.get("cookie"));
}

export function lineSpacingCookie(id: LineSpacing): string {
  return preferenceCookie(LINE_SPACING_COOKIE, id);
}

/* ------------------------------------------------------------------ */
/* the generated rules                                                 */
/* ------------------------------------------------------------------ */

/**
 * The bindings, and the previews that go beside each option in the panel.
 *
 * Generated from the registries above rather than written out, so adding a step
 * is one entry and cannot leave a selectable option with no rule behind it -
 * which would present as a setting that reports itself Selected and changes
 * nothing.
 *
 * This goes into the site stylesheet next to the `html` and `body` rules it
 * overrides, not into the font stylesheet. The font sheet is generated bytes
 * whose URL moves whenever a face is rebuilt; these are four lines of static
 * text that change when the layout changes, which is the site sheet's job.
 *
 * The previews set each option's detail line in the size or spacing it names.
 * A reader can no more choose between five sizes from the words "Small" and
 * "Medium" than they can choose between six serifs from their names, which is
 * the argument the font previews already make. They cost nothing: the panel is
 * `display: none` until its fragment is targeted.
 */
export const TYPE_CSS = `
/* ------------------------------------------------------------------ */
/* the reader's type, from the cookies, via data-size and data-spacing  */
/* ------------------------------------------------------------------ */

${TEXT_SIZES.map(
  (s) => `:root[data-size="${s.id}"] {
  font-size: ${s.px}px;
}`,
).join("\n\n")}

/*
 * These match body rather than the root, because SITE_CSS declares line-height
 * on body and an inherited value from the root loses to it whatever the root
 * selector's specificity. Matching body with an extra attribute selector wins
 * without an !important.
 */
${LINE_SPACINGS.map(
  (s) => `:root[data-spacing="${s.id}"] body {
  line-height: ${s.ratio};
}`,
).join("\n\n")}

${TEXT_SIZES.map(
  (s) => `.settings-size-${s.id} .settings-option-detail {
  font-size: ${s.px}px;
}`,
).join("\n\n")}

${LINE_SPACINGS.map(
  (s) => `.settings-spacing-${s.id} .settings-option-detail {
  line-height: ${s.ratio};
}`,
).join("\n\n")}
`;
