# Pio dialogue files

One JSON file per language (`en.json`, `ru.json`, `de.json`, `fr.json`), consumed by
`public/js/pio/dialogue.js` (`createDialogueEngine`). Loaded lazily by `public/js/pio/pio.js` via
`fetch("pio/dialogues/<lang>.json")`, or can be pre-loaded and passed to `createPio({ dialogues: {...} })`.

## Shape

```json
{
  "_meta": {
    "units": { "hours": ["hour", "hour", "hours"], "games": ["game", "game", "games"] },
    "error": "Error X_X"
  },
  "<event>": [
    { "text": "...", "mood": "happy", "when": { "scoreMin": 80, "genre": "RPG", "hourFrom": 22, "hourTo": 5 }, "weight": 1 }
  ]
}
```

- Every top-level key except `_meta` is an **event name** (see below) mapping to an array of candidate phrases.
- A plain string in that array is shorthand for `{ "text": "<string>" }` (mood defaults to `"normal"`, no
  conditions, weight 1) — `dialogue.js`'s `setPool()` normalizes both forms up front. Several pools here
  (`click:head`, `click:body`, `hover:*`) use the plain-string form since those legacy phrases carry no mood or
  condition.
- `mood` must be one of the six Neptune expressions: `normal`, `happy`, `enjoy`, `unhappy`, `kira`, `deformed`
  (see `public/pio/models/neptune/model.json` → `expressions`). Anything else falls back to `normal`.
- `when` (optional) restricts a phrase to a context. All present keys must match (AND). Omitting `when` means
  "always eligible". Supported keys:
  | key | matches when |
  |---|---|
  | `scoreMin` / `scoreMax` | `context.score` (number) is >= / <= |
  | `priceMin` / `priceMax` | `context.price` (number) is >= / <= |
  | `yearMin` / `yearMax` | `context.year` (number) is >= / <= |
  | `hoursMin` / `hoursMax` | `context.hours` (number, time-to-beat) is >= / <= |
  | `genre` | `context.genres` (array) or `context.genre` contains it, case-insensitive |
  | `tag` | `context.tags` (array) contains it, case-insensitive |
  | `platform` | `context.platforms` (array) or `context.platform` contains it, case-insensitive |
  | `hourFrom` / `hourTo` | current wall-clock hour (or `context.hour`) falls in `[hourFrom, hourTo)`; wraps past midnight when `hourFrom > hourTo` (e.g. `22`→`5` matches 22:00–04:59) |
  | `returning` | `true`/`false` matches whether `localStorage` shows a previous visit |
  | `respin` | exact match against `context.respin` (used by the legacy-ported "retries" phrases) |
- `weight` (optional, default 1): relative chance among the phrases that still match after filtering. Higher =
  more likely. Used here to make time-of-day greetings show up first on `load` more often than the generic hello.
- No immediate repeats: the engine remembers the last phrase shown *for that event* and excludes it from the next
  pick for the same event (when there is another eligible candidate).
- Placeholders: any `{key}` in `text` is replaced by `context[key]` (left as literal text if the context doesn't
  provide it). `{hours}` and `{goodCount}` are special-cased to pluralize a number via `_meta.units` (ported from
  the legacy `numtitles`/`numgtitles` helpers in `legacy/pio/static/pio.js`) instead of being inserted raw.

## Events

Canonical events from the rewrite spec (`docs/specs/2026-09-19-rewrite-design.md` §9) and plan (task T4):

| Event | Fired by | Typical context |
|---|---|---|
| `load` | `pio.js` on init (twice: immediately, and again ~4s later so a time-greeting is usually followed by the generic "hello") | — |
| `idle` | `pio.js`, after ~45s with no mouse/keyboard/touch activity | — |
| `click:head` | tap/click on the model's head hit area | — |
| `click:body` | tap/click on the model's body/belly hit area | — |
| `spin:start` | host app, when a spin begins | `{ game }` (a segment name, optional) |
| `spin:end` | host app, with the winning GameCard | `{ game, genres, tags, score, hours, price, year, platforms, developers, otherGame }` |
| `empty` | host app, gateway returned no games for the current filters | — |
| `privacy` | host app, gateway reported the user's Steam library is private | — |
| `longSession` | host app, user has been on the wheel page for a long time | — |
| `settings:open` | host app, settings panel opened | — |

Extra events carried over from the legacy `dialog.js` phrase pools that don't have a canonical slot yet (kept
because the task said to port everything; harmless if nothing fires them — the host app can wire them up, drop
them, or repurpose the pool):

| Event | Legacy source | Notes |
|---|---|---|
| `spin:retry` | `dialog.retries`, shown when `respin === 3` | fires when the user keeps re-rolling the exact same result |
| `spin:middle` | `dialog.spin.middle` | legacy fired this at the halfway point of the spin animation, summarizing the current segment set (`{game}` = longest game, `{hours}`, `{goodCount}`) |
| `hover:randomGame` | `dialog.randomgamebutton` | tooltip for the "random game" button |
| `hover:marbles` | `dialog.marblesbutton` | tooltip for the Marbles-on-Stream export |
| `hover:ggPoints` | `dialog.ggpoints` | tooltip for the GG points indicator |
| `hover:profile` | `dialog.profilebutton` | tooltip for the profile button |
| `hover:search` | `dialog.searchbar` | tooltip for the game search bar |
| `hover:gabestore` | `dialog.gabestore` | **UI removed per spec §9** ("Check on GOG" replaces GabeStore) — text kept for data completeness only, nothing fires this event anymore |
| `hover:donations` | `dialog.donationreminder` + `dialog.donations` | **UI removed per spec §9** (no more Patreon link) — same as above, inert |

## What's ported vs. newly written

- `load`, `click:head`, `click:body`, `spin:start`, `spin:retry`, `spin:middle`, `spin:end`, and all `hover:*`
  events are the existing phrases from `legacy/pio/static/dialog.js`, reorganized into this schema (placeholders
  renamed: `{{name}}`→`{game}`, `{{randomname}}`→`{game}`/`{hours}` in `spin:middle`, `{{randomlengths}}`→`{hours}`,
  `{{goodcount}}`→`{goodCount}`, `{{developers}}`→`{developers}`, `{{randomgame}}`→`{otherGame}`). The `tags`
  block (Anime/VR/Nudity flavor lines) was folded into `spin:end` gated by `when.tag`.
- `idle`, `empty`, `privacy`, `longSession`, `settings:open` did not exist in the legacy plugin (the old gateway
  just returned the bare strings `"empty"`/`"privacy"` with no mascot reaction, and there was no idle chatter or
  session-length awareness). These are newly written placeholder phrases — a handful per language, translated by
  the implementer (not a native speaker for de/fr) — so the event isn't silently empty. **This is exactly the set
  the plan expects to be expanded later** ("the owner will later generate many more").

## Adding phrases

Just append objects to the right event array in each of the four files. No code changes needed unless you want a
new condition key (add it to `matchesWhen` in `public/js/pio/dialogue.js`) or a new placeholder with special
formatting (add it to `formatText` in the same file).
