# Vendored frontend libraries

Plain browser files, no bundler, no build step. Loaded as classic `<script>` tags (not ES modules) in this
exact order, because `cubism2.min.js` checks for `window.Live2D` at parse time and throws if it isn't loaded yet:

```html
<script src="vendor/live2d/live2d.min.js"></script>
<script src="vendor/pixi/pixi.min.js"></script>
<script src="vendor/pixi-live2d-display/cubism2.min.js"></script>
<script type="module" src="js/pio/pio.js"></script>
```

Verified (see `docs/reports/` note in the T4 implementer report): all three files parse under Node's `vm` module
with minimal `window`/`document` stubs, and `PIXI.live2d.Live2DModel` is defined after loading in that order.

## pixi/pixi.min.js

- Package: `pixi.js`, version **6.5.10** (latest 6.x; 7.x/8.x dropped in favor of ESM-first builds and pixi-live2d-display's
  Cubism 2 build targets the `@pixi/*` v6 package family via peerDependencies).
- Source: official npm registry tarball, `npm pack pixi.js@6.5.10` → `dist/browser/pixi.min.js` copied verbatim.
  Registry URL: `https://registry.npmjs.org/pixi.js/-/pixi.js-6.5.10.tgz`.
- License: MIT (Copyright (c) 2013-2017 Mathew Groves, Chad Engler; see the package's own `LICENSE`, reproduced
  below).
- Only change made: stripped the trailing `//# sourceMappingURL=pixi.min.js.map` comment because the `.map` file
  isn't vendored (avoids a harmless but noisy 404 in the browser devtools network tab). No other edits.

## pixi-live2d-display/cubism2.min.js

- Package: `pixi-live2d-display`, version **0.4.0** (latest on npm; 0.5.0-beta targets Pixi 7/8 and wasn't used
  since the rest of the stack is pinned to Pixi 6).
- Source: official npm registry tarball, `npm pack pixi-live2d-display@0.4.0` → `dist/cubism2.min.js` copied
  verbatim (the package also ships `cubism4.min.js` and a combined `index.min.js`; we only need Cubism 2 for the
  Neptune model, so only `cubism2.min.js` is vendored to keep the payload small).
  Registry URL: `https://registry.npmjs.org/pixi-live2d-display/-/pixi-live2d-display-0.4.0.tgz`.
- License: MIT (Copyright (c) 2020 Guan; see the package's own `LICENSE`, reproduced below).
- No changes made to the file.
- API surface used by `public/js/pio/pio.js`: `PIXI.live2d.Live2DModel.from(modelUrl, { autoInteract, autoUpdate })`,
  `model.motion(group, index, priority)`, `model.expression(id)`, `model.on('hit', hitAreaNames => ...)`. Cursor
  following ("follows cursor if supported" in the spec) is the library's built-in `autoInteract` focus controller —
  no extra code needed.

## live2d/live2d.min.js — Cubism 2 core runtime

**This one was NOT downloaded from an official source — it is a verbatim copy of the legacy
`legacy/pio/static/l2d.js`, per the T4 task's explicit fallback instruction.**

Why: pixi-live2d-display's own `core/README.md` (present in the npm package we just vendored) says outright:

> Cubism 2.1 `live2d.min.js` — Cubism 2.1 core library. It's no longer downloadable from the official site, but can
> be found [here](https://github.com/dylanNew/live2d/tree/master/webgl/Live2D/lib).

That mirror (`dylanNew/live2d`) is a community repository, not an official Live2D Inc. or pixi-live2d-display
release, so per the task's rule ("download ONLY from the official npm registry tarballs ... or the projects'
official GitHub releases") it was not fetched. Live2D Inc.'s own site only distributes the Cubism 2 core bundled
inside the (much larger, non-redistributable-as-a-single-file) Cubism 2.1 SDK for Web, which is no longer offered
for download at all.

Instead, `public/vendor/live2d/live2d.min.js` is a byte-for-byte copy of `legacy/pio/static/l2d.js`, which the
current (legacy, PHP) site already serves in production. It is a webpack bundle that combines:

1. The actual Cubism 2 core runtime (`window.Live2D`, `Live2DModelWebGL`, `Live2DMotion`, etc. — originally from
   the community mirror [`journey-ad/live2d_src`](https://github.com/journey-ad/live2d_src), per the credit in
   `legacy/pio/README.md`), which is what `pixi-live2d-display`'s Cubism 2 adapter actually calls into.
2. The old Pio 2.4 plugin's own loader glue (`window.loadlive2d`, hit-area helpers, etc.), which is unused dead
   weight now that `pixi-live2d-display` drives the model, but was left in rather than risk breaking the runtime by
   hand-editing a minified bundle.

**Licensing — NEEDS REVIEW.** `legacy/pio/LICENSE` licenses the whole Pio plugin (including `l2d.js`) under
**GPL-2.0-only** (Dreamer-Paul, 2018). The Cubism 2 core code bundled inside it originates from Live2D Inc.'s
proprietary/freeware Cubism 2.1 SDK (redistributed by the community under an unclear license — `journey-ad/live2d_src`
does not carry its own LICENSE file). Continuing to ship this file means:

- The redistribution is arguably bound by GPL-2.0 terms as applied by Dreamer-Paul to the bundle, which has
  copyleft implications for whatever ships alongside it.
- The underlying Cubism 2 engine code was never officially open-sourced by Live2D Inc.; its redistribution rights
  are murky at best.

This is exactly the situation the current production site is already in (it serves the same file today), so this
change does not make anything worse, but it does not fix it either. The project owner should decide whether to:
(a) accept the status quo, (b) obtain a licensed Cubism 2 SDK copy directly from Live2D Inc. for internal use, or
(c) drop Cubism 2 support and re-export the Neptune model for Cubism 3/4 (which has an official, clearly licensed
core runtime available from live2d.com).

## Licenses

### pixi.js (MIT)

```
The MIT License

Copyright (c) 2013-2017 Mathew Groves, Chad Engler

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### pixi-live2d-display (MIT)

```
MIT License

Copyright (c) 2020 Guan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### live2d.min.js (GPL-2.0-only via the Pio plugin bundle; underlying Cubism 2 core license unclear — see above)

Full text: `legacy/pio/LICENSE` (GNU GPL v2, Copyright (C) 2018 Dreamer-Paul). Not reproduced here for length; see
that file.

