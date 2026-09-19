# Vendored frontend libraries (js/plugins + css/plugins)

> **Lead's correction after browser QA (2026-09-19)** — what is actually shipped differs from the first draft below:
> - **CSS of Semantic stays the site's original Semantic UI 2.4.1 `css/plugins/semantic.css` + `themes/`** — that
>   stylesheet *is* the legacy look. Fomantic's own CSS restyled containers, piled segments, buttons, shadows (computed
>   style diff: 300+ differences), so only Fomantic's **JS** (2.9.4) is used, plus its `components/calendar.min.css`
>   (`css/plugins/calendar.min.css`). `css/compat.css` hides the new `clearable` remove icon.
> - **Font Awesome package removed** (owner's decision) — FA 6 redraws the glyphs, so the five icons in use come from
>   `css/icons.css` + `css/fonts/gg-icons-{solid,brands}.woff2/.woff`: fontTools subsets of FA Free 5.12.1 (same outlines,
>   metrics, code points, class names), ~4 KB instead of 3 MB. Re-subset to add an icon (command in `icons.css`).
> - **ion.rangeSlider 2.5.0 JS** with the ORIGINAL sprite skin ported to the new markup
>   (`css/plugins/ion.rangeSlider.skinNice.css`), `force_edges: true` (the legacy 2.1.2 copy was patched to clamp labels).
> - Visual regression method: `.dev/qa-style-snapshot.js` against `/__base/` (see `.claude/docs/local-dev.md`).


Plain browser files, no bundler, no build step, loaded as classic `<script>`/`<link>` tags from
`public/index.html`. All files below were fetched with `npm pack <pkg>@<version>` from the public npm
registry and copied out of the tarball's `dist`/build output verbatim (only exception noted per file);
nothing is hotlinked from a CDN.

| Library | Version | npm package | File(s) | License | Used by |
|---|---|---|---|---|---|
| jQuery | 3.7.1 | `jquery` | `js/plugins/jquery.js` (`dist/jquery.min.js`) | MIT | Everything |
| jQuery Color | 3.0.0 | `jquery-color` | `js/plugins/jquery.color.js` (`dist/jquery.color.min.js`) | MIT | `pgwheel.js` (`#spin_button` background-color animation) |
| Fomantic UI | 2.9.4 | `fomantic-ui-css` | `js/plugins/semantic/semantic.js` (`semantic.min.js`), `css/plugins/semantic.css` (`semantic.min.css`), `css/plugins/themes/default/assets/fonts/*` | MIT | `pgindex.js`, `pgsettings.js`, `pgwheel.js`, `index.html`, `pages/*.html` |
| Font Awesome Free (5-glyph subset) | 5.12.1 | - (subset with fontTools) | `css/icons.css`, `css/fonts/gg-icons-*.woff2/.woff` | Icons CC BY 4.0, fonts SIL OFL 1.1, CSS MIT | `index.html` (`fas`/`fab` icons), `pages/wheel.html` |
| ion.rangeSlider | 2.5.0 | `ion-rangeslider` | `js/plugins/rangeslider.js` (`js/ion.rangeSlider.min.js`), `css/plugins/ion.rangeSlider.css` (`css/ion.rangeSlider.min.css`) | MIT | `pgsettings.js` (price/score/length/spin/segments/speed sliders) |
| SoundManager2 | n/a (replaced) | - | `js/plugins/soundmanager.js` (own ~120-line shim over `HTMLAudioElement`, see file header) | - | `pgwheel.js`, `pgindex.js` |

## What changed and why

- **jQuery** 3.5 -> 3.7.1 (latest 3.x; 4.0.0 exists on npm but was intentionally not used - Fomantic UI
  2.9.4 predates jQuery 4 and its jQuery-4 compatibility is not verified upstream). Checked every
  jQuery API call in `pgindex.js`/`pgsettings.js`/`pgwheel.js`/`index.html` against 3.x's deprecations:
  `.bind()`/`.unbind()` (`pgindex.js` hashchange handler, `pgwheel.js` scroll/hover handlers) and
  `jQuery.event.special.touchstart` (`index.html`) are all still-supported public jQuery-core APIs, not
  jQuery-UI or removed-in-4.0 APIs - no call-site changes needed. `$.parseJSON`/`.size()` are not used
  anywhere in this codebase.
- **jQuery UI (250KB) dropped.** Usage audit (`grep` over all four JS files) found exactly one jQuery-UI
  feature in use: the `backgroundColor` key in `$("#spin_button").animate({backgroundColor: ...}, 500)`
  (`pgwheel.js`, `startSpin`/`endWheel`) - jQuery core's `.animate()` can't tween colors on its own.
  `.draggable`/`.sortable`/`.datepicker`/`.dialog`/`.slider`/`.resizable`/easing names beyond the
  jQuery-core `swing`/`linear` (both already used as-is in `pgwheel.js`'s scroll animations) are not
  used anywhere. Replaced with the official 6.5KB `jquery-color` plugin, which patches the same
  `$.fn.animate()` to accept color properties - zero call-site changes needed.
- **Semantic UI 2.4.1 -> Fomantic UI 2.9.4** (maintained fork, same `$.fn.dropdown/modal/dimmer/
  transition/popup/checkbox/api/calendar` jQuery-module API). Property-by-property diff of every
  Fomantic selector matching a class combination actually used on this site (dropdown, checkbox/toggle,
  label, segment/segments/piled, statistic, button, header, menu, modal, dimmer, calendar, the
  `::-webkit-scrollbar` rules) against the old vendored `semantic.css` found near-total visual parity;
  see `public/css/compat.css`'s header comment for the one confirmed difference and the fix. Fomantic's
  calendar module (bundled into `semantic.js`/`semantic.css` now) replaces the separate
  `calendar.js`/`calendar.min.css` semantic-ui-calendar plugin; `pgsettings.js`'s two
  `$('#range...').calendar({...})` calls use the same option names (`type`, `endCalendar`/
  `startCalendar`, `text`, `onChange`) and needed no changes. `dropdown()` options used in
  `pgsettings.js`/`pgwheel.js` (`filterRemoteData`, `fullTextSearch`, `clearable`, `saveRemoteData`,
  `apiSettings`/`onResponse`, `message`) are unchanged in Fomantic 2.9; the "`onResponse` gets a JSON
  array as `{"0":...}`" quirk our code already works around (see the comments already in
  `pgwheel.js`/`pgsettings.js`) still applies identically.
- **Font Awesome**: not upgraded and no longer vendored as a package — see the correction note at the top.
- **ion.rangeSlider 2.2 -> 2.5.0** (latest; the task brief said "2.3.1" but 2.5.0 is what's actually
  latest on npm now). 2.3 replaced the sprite-sheet skin system with CSS-only named skins
  (`irs--flat`/`irs--round`/etc., default `flat`) and renamed the handle element class from
  `.irs-slider` to `.irs-handle`; the three-piece track/bar sprite strips
  (`.irs-line-left/-mid/-right`, `.irs-bar-edge`) are gone, `.irs-line`/`.irs-bar` are single elements
  now. `pgsettings.js`'s six `ionRangeSlider({...})` calls now pass `skin: ''` (see the comment above
  the first call) so the library only applies its bare/colorless layout CSS instead of the "flat" skin's
  red accent colors; `css/plugins/ion.rangeSlider.skinNice.css` was ported to the new element name and
  rewritten as flat colors (sampled from the original sprite pixels - see that file's header) since a
  sprite can no longer be sliced across three separate elements. Option names used
  (`type`, `grid`, `min`, `max`, `from`, `to`, `step`, `postfix`, `prefix`, `min_interval`, `onFinish`)
  are unchanged in 2.5.0.
- **SoundManager2 replaced** with `js/plugins/soundmanager.js`, a small same-path shim over
  `HTMLAudioElement` exposing exactly the API surface `pgwheel.js`/`pgindex.js` call: `setup({onready})`,
  `createSound({id,url,volume,multiShot,onfinish,onplay}).play(opts?)`, `getSoundById(id).volume` /
  `.setVolume()`, `play(id)`, `stopAll()`. SM2's 0-100 volume scale is preserved at the API boundary
  (divided/multiplied by 100 against `<audio>`'s native 0.0-1.0 range) so no caller changed.
- **json3.js removed**: obsolete `JSON.stringify`/`JSON.parse` polyfill: every currently supported
  browser (and PHP 8.2/Node 20 tooling used elsewhere in this repo) has native `JSON`.
- **marquee3k.js removed**: dead code. `pgwheel.js` called `Marquee3k.init()` and
  `$(".marquee3k__copy").css(...)`, but no element with a `.marquee3k` (or `.marquee3k__copy`) class
  exists in `index.html` or any `pages/*.html` fragment, so both calls were already no-ops.
