/**
 * The settings panel: reading font, text size, line spacing and theme, as
 * links.
 *
 * ## Why it is not a modal in the usual sense
 *
 * The brief called it a modal, and it behaves like one - it is hidden until you
 * ask for it and it takes over your attention when you do - but it is not an
 * overlay. `position: fixed` is banned by this site's stylesheet for a reason
 * that applies here more than anywhere: a fixed layer forces the panel to
 * repaint the region under it, and on e-ink a repaint is a visible flash of the
 * whole screen. So the panel is an ordinary block at the foot of the document,
 * revealed by `:target` when the URL fragment is `#settings`. The browser's own
 * fragment navigation scrolls the reader to it, which costs one paint instead
 * of a stacking context and a scroll lock.
 *
 * ## Why there is no <form>
 *
 * Every option is an `<a>`. E-ink browsers render native form controls badly -
 * a `<select>` on a Kobo opens a picker that is close to unusable, and radio
 * buttons at this DPI are a sub-tap-target dot - and several handle submission
 * of a GET form by reloading into a state the back button cannot leave. Links
 * are the one interactive primitive that every one of these browsers gets
 * right, so the panel is built entirely out of them.
 *
 * ## Degradation
 *
 * With the stylesheet gone, or on a browser too old to know `:target`, this is
 * a heading, four labelled lists of links, and a Close link, sitting after the
 * footer. That is not a broken overlay; it is a settings section, which is what
 * it always was. See the note on `.settings:not(:target)` in `SETTINGS_CSS` for
 * how the "too old to know :target" case is arranged to fail open.
 *
 * The typographic options degrade further than that and it is worth being
 * precise about how: with no stylesheet there is no preview, so each one is a
 * name and a sentence rather than a name and a demonstration. They still set
 * their cookie, and the cookie still has no effect, because the rules that
 * would apply it went with the sheet. Nothing is broken by this that was not
 * already broken by losing the sheet.
 *
 * It is an HTML string rather than a component because it has no dynamic
 * structure worth a renderer, and because a string is assertable from a plain
 * `.ts` test with no JSX runtime in the way. The shell drops it in with
 * mono-jsx's `html()` raw helper, the same way story bodies are injected.
 */
import type { H3Event } from "nitro/h3";

import { FONTS, readFont, type FontId } from "~/web/fonts";
import { readTheme, safeReturnPath, type Theme } from "~/web/theme";
import {
  LINE_SPACINGS,
  readLineSpacing,
  readTextSize,
  TEXT_SIZES,
  type LineSpacing,
  type TextSize,
} from "~/web/type";

/** The fragment that reveals the panel. `<a href="#settings">` opens it. */
export const SETTINGS_ID = "settings";

/**
 * The specimen shown beside each font name.
 *
 * Not a pangram. These are the characters that decide whether a face works on a
 * greyscale panel: the ambiguous quartet `0 O 1 l I`, and enough of
 * "Hamburgefonstiv" to show x-height, stem contrast and the shape of the
 * counters. A reader cannot pick between six serifs from their names alone,
 * which is the entire reason each option is set in its own font.
 */
const SPECIMEN = "Hamburgefonstiv 0O1lI";

/**
 * The specimen shown beside each line spacing.
 *
 * Long enough to wrap, which is the whole point: leading is the gap between
 * lines and a one-line sample shows none of it. The font specimen can be five
 * words because a letterform is visible in one; this cannot.
 */
const SPACING_SPECIMEN =
  "Set at this spacing, so the gap between the lines is something you can see " +
  "here rather than only after the panel is closed.";

interface ThemeOption {
  id: Theme;
  label: string;
  note: string;
}

const THEME_OPTIONS: readonly ThemeOption[] = [
  { id: "auto", label: "Auto", note: "Follow the device setting." },
  { id: "light", label: "Light", note: "Black on white, always." },
  { id: "dark", label: "Dark", note: "White on black, always." },
];

/**
 * Escapes a value for an HTML attribute.
 *
 * `&` matters most here: every option's href carries two query parameters, and
 * a raw ampersand between them is invalid markup that some parsers will read as
 * the start of an entity.
 */
function attr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Escapes a value for text content. */
function text(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Everything the reader has chosen, resolved from cookies.
 *
 * One object rather than four parameters because every one of these has to
 * reach both `<html>` and the panel, through a `pageAttrs` call and a `Shell`
 * call, in each of six routes. Threaded individually that is a preference
 * arriving in twenty-four places, and the failure mode is silent: a route that
 * forgets one renders a page that ignores a setting the panel reports as
 * Selected. As one value the compiler cannot be talked out of noticing.
 */
export interface Preferences {
  font: FontId;
  theme: Theme;
  size: TextSize;
  spacing: LineSpacing;
}

/**
 * The whole set, off one request.
 *
 * Four independent cookie lookups over the same header. That is four passes
 * where one would do, and it is not worth fixing: the header is a few hundred
 * bytes and the alternative is a parser that returns a map, which every caller
 * would then have to index with a string instead of a name.
 */
export function readPreferences(event: H3Event): Preferences {
  return {
    font: readFont(event),
    theme: readTheme(event),
    size: readTextSize(event),
    spacing: readLineSpacing(event),
  };
}

export interface SettingsPanelOptions extends Preferences {
  /** Path of the page being rendered. The panel returns the reader here. */
  path: string;
}

function option(opts: {
  href: string;
  className: string;
  label: string;
  detail: string;
  current: boolean;
}): string {
  const { href, className, label, detail, current } = opts;
  /*
   * `aria-current` is the machine-readable half and the "Selected" span is the
   * human-readable half. Both are needed: the CSS marker that shows which
   * option is active is the first thing to disappear if the stylesheet does,
   * and a reader looking at unstyled markup still has to be able to tell what
   * they are currently using.
   */
  return (
    `<li><a class="settings-option ${attr(className)}" href="${attr(href)}" rel="nofollow"` +
    `${current ? ' aria-current="true"' : ""}>` +
    `<span class="settings-option-name">${text(label)}</span>` +
    `<span class="settings-option-detail">${text(detail)}</span>` +
    (current ? `<span class="settings-state">Selected</span>` : "") +
    `</a></li>`
  );
}

/**
 * The panel's markup.
 *
 * Every link round-trips through `/settings`, which sets the cookie and
 * redirects back. The return target keeps the `#settings` fragment so the panel
 * is still open afterwards - a reader comparing six fonts should not have to
 * reopen it five times, and on e-ink each reopen is a page flash.
 */
export function settingsPanelHtml(opts: SettingsPanelOptions): string {
  const path = safeReturnPath(opts.path);
  const to = encodeURIComponent(`${path}#${SETTINGS_ID}`);

  const fontOptions = FONTS.map((font) =>
    option({
      href: `/settings?font=${font.id}&to=${to}`,
      className: `font-${font.id}`,
      label: font.label,
      // The specimen doubles as the option's explanation: the note says who the
      // font is for, the specimen shows what it looks like saying so.
      detail: `${SPECIMEN} \u00b7 ${font.note}`,
      current: font.id === opts.font,
    }),
  ).join("");

  /*
   * The note is the whole detail here, with no specimen prefixed, because the
   * note is already a sentence and the preview class sets it at the size it
   * names. The sentence is the specimen.
   */
  const sizeOptions = TEXT_SIZES.map((s) =>
    option({
      href: `/settings?size=${s.id}&to=${to}`,
      className: `settings-size-${s.id}`,
      label: s.label,
      detail: s.note,
      current: s.id === opts.size,
    }),
  ).join("");

  const spacingOptions = LINE_SPACINGS.map((s) =>
    option({
      href: `/settings?spacing=${s.id}&to=${to}`,
      className: `settings-spacing-${s.id}`,
      label: s.label,
      detail: `${s.note} ${SPACING_SPECIMEN}`,
      current: s.id === opts.spacing,
    }),
  ).join("");

  const themeOptions = THEME_OPTIONS.map((t) =>
    option({
      href: `/settings?theme=${t.id}&to=${to}`,
      className: `settings-theme-${t.id}`,
      label: t.label,
      detail: t.note,
      current: t.id === opts.theme,
    }),
  ).join("");

  /*
   * Font, size, spacing, theme. The three typographic groups sit together
   * because a reader adjusting one has usually just been unsatisfied by
   * another, and theme is last because it is the one choice that is about the
   * room rather than the page.
   */
  return (
    `<section id="${SETTINGS_ID}" class="settings" aria-labelledby="settings-title">` +
    `<h2 class="settings-title" id="settings-title">Settings</h2>` +
    `<p class="settings-intro">Stored in a cookie on this device. No account, no scripting.</p>` +
    `<h3 class="settings-group" id="settings-font-group">Reading font</h3>` +
    `<ul class="settings-options" aria-labelledby="settings-font-group">${fontOptions}</ul>` +
    `<h3 class="settings-group" id="settings-size-group">Text size</h3>` +
    `<ul class="settings-options" aria-labelledby="settings-size-group">${sizeOptions}</ul>` +
    `<h3 class="settings-group" id="settings-spacing-group">Line spacing</h3>` +
    `<ul class="settings-options" aria-labelledby="settings-spacing-group">${spacingOptions}</ul>` +
    `<h3 class="settings-group" id="settings-theme-group">Theme</h3>` +
    `<ul class="settings-options" aria-labelledby="settings-theme-group">${themeOptions}</ul>` +
    `<p class="settings-done">` +
    `<a class="btn btn-primary settings-close" href="${attr(path)}">Close settings</a>` +
    `</p>` +
    `</section>`
  );
}

/**
 * Styles for the panel. Concatenate onto `SITE_CSS`.
 *
 * It belongs with the site stylesheet rather than the font one because it is
 * layout, it is a kilobyte, and it changes when the rest of the layout changes.
 * The font stylesheet is generated bytes that move whenever a font is rebuilt.
 */
export const SETTINGS_CSS = `
/* ------------------------------------------------------------------ */
/* settings panel                                                      */
/* ------------------------------------------------------------------ */

/*
 * One rule hides the panel, and it is written as \`:not(:target)\` rather than
 * the obvious pair - \`.settings { display: none }\` plus \`.settings:target
 * { display: block }\` - for a specific failure mode.
 *
 * A browser drops any rule whose selector it cannot parse. Written the obvious
 * way, a browser that does not understand \`:target\` drops the *reveal* and
 * keeps the *hide*, and the settings become permanently unreachable with no
 * way for the reader to notice or recover. Written this way it drops the
 * *hide*, and the panel degrades to a plain settings section at the foot of
 * the page - visible, usable, and exactly what the markup already says it is.
 *
 * There is no \`position: fixed\` here and no backdrop. Fixed layers repaint
 * the region beneath them, and on e-ink that is a full-panel flash. The
 * browser's fragment navigation does the work instead: it scrolls the reader
 * to the panel, which costs one paint.
 */
.settings:not(:target) {
  display: none;
}

.settings {
  border-top: 4px solid var(--rule);
  margin-top: 2.5rem;
  padding-top: 1rem;
}

.settings-title {
  font-size: 1.3rem;
  font-weight: 700;
  margin: 0 0 0.25rem;
}

.settings-intro {
  font-size: 0.8rem;
  color: var(--fg-soft);
  margin: 0 0 1.5rem;
}

.settings-group {
  font-size: 0.8rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--fg-soft);
  margin: 1.5rem 0 0.5rem;
}

.settings-options {
  list-style: none;
  margin: 0;
  padding: 0;
}

.settings-options > li {
  border-bottom: 2px solid var(--rule-soft);
}

.settings-options > li:first-child {
  border-top: 2px solid var(--rule-soft);
}

/*
 * The whole row is the target, as with the story list. 48px is the floor, but
 * the padding puts these closer to 64px, because a mis-tap here changes a
 * setting rather than merely opening the wrong story.
 */
.settings-option {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0 0.75rem;
  min-height: var(--tap);
  padding: 0.85rem 0;
  text-decoration: none;
}

.settings-option-name {
  font-weight: 700;
  font-size: 1.05rem;
  text-decoration: underline;
  text-decoration-thickness: 2px;
  text-underline-offset: 3px;
}

.settings-option-detail {
  flex: 1 1 100%;
  margin-top: 0.2rem;
  font-size: 0.9rem;
  color: var(--fg-soft);
}

/*
 * A 6px bar rather than a tick or a colour change. At greyscale a tick is a
 * smudge and a colour change is invisible; a bar of this weight survives the
 * dither, and the "Selected" label carries the same information in text for
 * anyone the bar does not reach.
 */
.settings-option[aria-current] {
  padding-left: 0.6rem;
  border-left: 6px solid var(--fg);
}

.settings-state {
  flex: 0 0 auto;
  margin-left: auto;
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.settings-done {
  margin: 1.5rem 0 0;
}

@media print {
  .settings {
    display: none;
  }
}
`;
