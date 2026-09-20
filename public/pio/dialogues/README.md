# Pio dialogue files

One JSON file per language (`en.json`, `ru.json`, `de.json`, `fr.json`), consumed by
`public/js/pio/dialogue.js` (`createDialogueEngine`). Loaded lazily by `public/js/pio/pio.js` via
`fetch("pio/dialogues/<lang>.json")`, or can be pre-loaded and passed to `createPio({ dialogues: {...} })`.

`public/js/pio/dialogue.js` exports `KNOWN_EVENTS`, `KNOWN_WHEN_KEYS`, `KNOWN_PLACEHOLDERS` and `MOODS` —
`tests/frontend/pio-content.test.js` uses these to validate every file below (unknown event/`when`
key/placeholder/mood, empty text, text over 160 chars, or a `text` sequence longer than 3 all fail the build).
Keep that test green when adding content.

## Shape

```json
{
  "_meta": {
    "units": { "hours": ["hour", "hour", "hours"], "games": ["game", "game", "games"] },
    "error": "Error X_X"
  },
  "<event>": [
    { "text": "...", "mood": "happy", "when": { "scoreMin": 80, "genre": "RPG", "hourFrom": 22, "hourTo": 5 }, "weight": 1, "once": false }
  ]
}
```

- Every top-level key except `_meta` is an **event name** (see below) mapping to an array of candidate phrases.
- A plain string in that array is shorthand for `{ "text": "<string>" }` (mood defaults to `"normal"`, no
  conditions, weight 1) — `dialogue.js`'s `setPool()` normalizes both forms up front. Several pools here
  (`click:head`, `click:body`, `hover:*`) use the plain-string form since those legacy phrases carry no mood or
  condition.
- `text` may also be an **array of 2-3 strings**: a short sequence shown one bubble after another (each timed
  by its own length — see "Engine rules"). `pio.js` chains them automatically; nothing else about the entry
  changes (one `mood`, one `when`, for the whole sequence).
- `mood` must be one of the six Neptune expressions: `normal`, `happy`, `enjoy`, `unhappy`, `kira`, `deformed`
  (see `public/pio/models/neptune/model.json` → `expressions`). Anything else falls back to `normal`.
- `once` (optional, default `false`): when `true`, this phrase is shown at most once per browser session
  (tracked in `sessionStorage`, keyed by event + phrase text) — for lines that would feel repetitive on a
  second viewing ("first time here?"-style jokes, big reveals, etc.).
- `when` (optional) restricts a phrase to a context. All present keys must match (AND). Omitting `when` means
  "always eligible". Supported keys:

  | key | matches when |
  |---|---|
  | `scoreMin` / `scoreMax` | `context.score` (number) is >= / <= |
  | `priceMin` / `priceMax` | `context.price` (number, **dollars/rubles, not cents**) is >= / <= |
  | `yearMin` / `yearMax` | `context.year` (number) is >= / <= |
  | `hoursMin` / `hoursMax` | `context.hours` (number, time-to-beat) is >= / <= |
  | `genre` | `context.genres` (array) or `context.genre` contains it, case-insensitive |
  | `tag` | `context.tags` (array) or `context.tag` contains it, case-insensitive |
  | `platform` | `context.platforms` (array) or `context.platform` contains it, case-insensitive |
  | `hourFrom` / `hourTo` | current wall-clock hour (or `context.hour`) falls in `[hourFrom, hourTo)`; wraps past midnight when `hourFrom > hourTo` (e.g. `22`→`5` matches 22:00–04:59) |
  | `returning` | `true`/`false` matches whether `localStorage` shows a previous visit |
  | `respin` | exact match against `context.respin` (used by the legacy-ported "retries" phrases) |
  | `visitsMin` / `visitsMax` | visit count in `localStorage` (first visit = 1) is >= / <= |
  | `spinsMin` / `spinsMax` | spins so far this browser session (`pio.js`'s session spin counter) is >= / <= |
  | `dayOfWeek` | current local day of week (0 = Sunday) equals this number, or is in this array |
  | `date` | current local date as `"MM-DD"` equals this string, or is in this array |
  | `noScore` | `true`/`false` matches whether `context.noScore` is truthy (the game has no score at all) |
  | `free` | `true`/`false` matches whether `context.free` is truthy (price is 0) |
  | `difficulty` | exact match against `context.difficulty` (English GameFAQs label: `Simple`, `Easy`, `Just Right`, `Tough`, `Unforgiving`) |
  | `reviewsMin` / `reviewsMax` | `context.reviews` (Steam all-time review percent) is >= / <= |
  | `awayMin` / `awayMax` | `context.awaySeconds` (how long the tab was hidden, for `tab:return`) is >= / <= |
  | `loggedIn` | `true`/`false` matches whether a Steam session is active |
  | `mobile` | `true`/`false` matches a mobile-looking `navigator.userAgent` |

- `weight` (optional, default 1): relative chance among the phrases that still match after filtering. Higher =
  more likely. Used here to make time-of-day greetings show up first on `load` more often than the generic hello.
- No immediate repeats: the engine remembers the last phrase shown *for that event* and excludes it from the next
  pick for the same event (when there is another eligible candidate) — and separately remembers the last **8**
  phrases shown for *any* event (`sessionStorage`) so the same joke doesn't resurface right after a different
  event happened to pick it, subject to the same "only if an alternative exists" rule.
- Placeholders: any `{key}` in `text` is replaced by `context[key]` (left as literal text if the context doesn't
  provide it). `{hours}` and `{goodCount}` are special-cased to pluralize a number via `_meta.units` (ported from
  the legacy `numtitles`/`numgtitles` helpers in `legacy/pio/static/pio.js`) instead of being inserted raw.
  `{price}` is special-cased to append `context.priceSymbol` (defaults to `$`). `{awayMinutes}` is derived
  automatically from `context.awaySeconds` when not given explicitly. `{hour}`/`{time}`/`{dayOfWeek}`/`{date}`
  are filled in automatically from the current wall clock when not given explicitly (same as the existing
  `hourFrom`/`hourTo` behaviour) — a phrase using `{time}` is therefore always eligible, it never needs the host
  to pass it in. See `KNOWN_PLACEHOLDERS` in `dialogue.js` for the full list:
  `game`, `otherGame`, `genre`, `tag`, `developer`, `developers`, `year`, `score`, `price`, `hours`, `goodCount`,
  `longGame`, `user`, `spins`, `visits`, `awayMinutes`, `browser`, `time`.

## Events

Canonical events, originally from the rewrite spec (`docs/specs/2026-09-19-rewrite-design.md` §9) and plan
(task T4), extended by the v2 mascot spec (`.claude/docs/pio-spec.md`, 2026-09-20 — kept outside git on
purpose, ask the lead if you need it). See `KNOWN_EVENTS` in `dialogue.js` for the exact list a content
file is validated against.

| Event | Fired by | Typical context |
|---|---|---|
| `load` | `pio.js` on init (twice: immediately, and again ~4s later so a time-greeting is usually followed by the generic "hello") | `visits` |
| `ambient` | `pio.js`, every 90-150s while `document.visibilityState === 'visible'` AND the visitor was active in the last 60s | `hour`, `spins`, `visits` |
| `idle` | `pio.js`, after ~45s with no mouse/keyboard/touch activity | — |
| `idle:long` | `pio.js`, after ~3min of no activity | — |
| `idle:veryLong` | `pio.js`, after ~10min of no activity | — |
| `tab:return` | `pio.js`, tab becomes visible again after being hidden >=20s | `awaySeconds`, `awayMinutes` |
| `click:head` | tap/click on the model's head hit area | — |
| `click:body` | tap/click on the model's body/belly hit area | — |
| `click:spam` | `pio.js`, 5+ clicks on either hit area within 3s (replaces the normal `click:head`/`click:body` reaction for that burst) | — |
| `spin:start` | host app, when a spin begins | `{ game }` (a segment name, optional), `spins` |
| `spin:retry` | host app, shown when `respin === 3` | `respin` |
| `spin:streak` | `pio.js`, session spin count (from `spin:start`) hits 5/10/25/50 | `spins` |
| `spin:middle` | host app, halfway through the spin animation | `game` (longest on the wheel), `hours`, `goodCount` |
| `spin:end` | host app, with the winning game's full `pioContext()` | `game, genres, genre, tags, tag, developers, developer, score, noScore, hours, price, priceSymbol, free, difficulty, reviews, year, longGame, otherGame` |
| `spin:repeatWinner` | `pio.js`, the same game wins again this session | `game` |
| `spin:sameGenre` | `pio.js`, 3rd winner in a row sharing a genre | `genre` |
| `list:select` | host app, user picks another game from the list or clicks a wheel segment | full `pioContext()` |
| `random:game` | host app, "Random game" button result | full `pioContext()` (no `otherGame`/`longGame`, single game) |
| `search:pick` | host app, user picked a game in the search box | full `pioContext()` |
| `click:store` / `click:gog` / `click:metacritic` / `click:hltb` / `click:gamefaqs` / `click:igdb` | host app, the matching "Check on …" button | full `pioContext()` of the currently displayed game |
| `empty` | host app, gateway returned no games for the current filters | — |
| `privacy` | host app, gateway reported the user's Steam library is private | — |
| `longSession` | host app, user has been on the wheel page for a long time | — |
| `settings:open` | settings page opened | — |
| `settings:change` | settings page, any filter changed, throttled to one reaction per 20s (queued — see "Settings page" below) | — |
| `settings:reset` | settings page, "Reset" button (queued) | — |
| `settings:language` | settings page, language switched (queued) | — |
| `settings:music:on` / `settings:music:off` | settings page, music toggle (queued) | — |
| `auth:login` | host app (wheel page), first mount of Pio in this session while a Steam session is active | `user` |
| `konami` | `pio.js`, ↑↑↓↓←→←→BA | — |
| `copy` | `pio.js`, the visitor copies text on the page | — |
| `hover:randomGame` / `hover:marbles` / `hover:ggPoints` / `hover:profile` / `hover:search` / `hover:gog` / `hover:spin` | tooltip-style hovers on the matching wheel-page control, throttled to one bubble per 8s across all `hover:*` | — |
| `hover:donations` | **UI removed per spec §9** (no more Patreon link) — text kept for data completeness only, nothing fires this event |

`hover:gog` was `hover:gabestore` before the GOG rename (`#rgabebtn` → `#rgogbtn`); if you're grepping old
branches/content for that key, it's the same tooltip.

### Settings page: queued events

Pio is only ever mounted on the wheel page (`.pio-container` lives in `public/pages/wheel.html`; the settings
page has no such element). `public/js/pgsettings.js` therefore never has a `GG.pio` to call — instead, every
`settings:*` event it wants to fire calls a small helper that writes `{ event, context, ts }` to
`sessionStorage["pio.pendingEvent"]` (overwriting any previous entry — only the **last** one survives). When
Pio next mounts (typically right after navigating back to the wheel page, or after a language switch's full
page reload), `pio.js`'s `init()` reads and clears that key and plays the event once, unless it's older than
2 minutes (in which case it's dropped as stale/out of context). If a future change ever mounts Pio on the
settings page too, the same helper calls `GG.pio.emit()` directly instead of queuing.

## Engine rules

- **Priority**: `spin:end`, `spin:repeatWinner`, `spin:sameGenre`, `empty`, `privacy`, `auth:login`, `konami`
  are HIGH and interrupt a currently-showing bubble. Clicks/list/search/settings-ish events are NORMAL (also
  interrupt). `ambient`, `idle`/`idle:long`/`idle:veryLong`, `hover:*`, `tab:return`, `load` are LOW: they never
  interrupt a bubble that is still showing — dropped, not queued.
- **Gaps**: a global minimum of 1.2s between any two bubbles; `hover:*` additionally throttled to one bubble
  per 8s (shared across every `hover:*` event); `ambient` additionally never fires within 25s of any other
  bubble (of any priority).
- **Bubble duration**: scales with text length — `max(3000, min(9000, 3000 + 45 * text.length))` ms. A `text`
  array (sequence) chains automatically: each item gets its own duration before the next one shows.
- **No immediate repeats** (per-event, exists) **+ 8-phrase cross-event memory** (`sessionStorage`) — see
  "No immediate repeats" above.
- **`once`**: a phrase marked `once: true` is shown at most once per browser session, tracked separately from
  the repeat/recency memory (a `once` phrase is filtered out entirely once shown, not just deprioritized).
- **Eligibility**: a phrase is only a candidate when every `{placeholder}` it uses can be filled from the
  context (unchanged) — she must never say a literal `{game}`.
- **Idle tiers**: `idle` (45s) / `idle:long` (3min) / `idle:veryLong` (10min) all reset together on any
  mouse/keyboard/touch activity.
- **Session counters**: `pio.js` tracks a session spin counter (`sessionStorage`, bumped on every `spin:start`)
  and a persistent visit counter (`localStorage`, bumped once per page load) and injects both into every
  event's context automatically as `spins`/`visits` — host call sites never need to compute or pass them.
- Unknown event or empty pool → silently nothing. Languages without their own file fall back to `en` (exists).

## What's ported vs. newly written

- `load`, `click:head`, `click:body`, `spin:start`, `spin:retry`, `spin:middle`, `spin:end`, and all `hover:*`
  events are the existing phrases from `legacy/pio/static/dialog.js`, reorganized into this schema (placeholders
  renamed: `{{name}}`→`{game}`, `{{randomname}}`→`{game}`/`{hours}` in `spin:middle`, `{{randomlengths}}`→`{hours}`,
  `{{goodcount}}`→`{goodCount}`, `{{developers}}`→`{developers}`, `{{randomgame}}`→`{otherGame}`). The `tags`
  block (Anime/VR/Nudity flavor lines) was folded into `spin:end` gated by `when.tag`.
- `idle`, `empty`, `privacy`, `longSession`, `settings:open` did not exist in the legacy plugin (the old gateway
  just returned the bare strings `"empty"`/`"privacy"` with no mascot reaction, and there was no idle chatter or
  session-length awareness). These are newly written placeholder phrases — a handful per language, translated by
  the implementer (not a native speaker for de/fr) — so the event isn't silently empty.
- Every event marked ★ in the v2 spec (`ambient`, `idle:long`, `idle:veryLong`, `tab:return`, `click:spam`,
  `spin:streak`, `spin:repeatWinner`, `spin:sameGenre`, `list:select`, `random:game`, `search:pick`,
  `click:store`/`click:gog`/`click:metacritic`/`click:hltb`/`click:gamefaqs`/`click:igdb`, `settings:change`,
  `settings:reset`, `settings:language`, `settings:music:on`/`off`, `auth:login`, `konami`, `copy`) only has
  1-2 English placeholder lines in `en.json` for now (enough to exercise the engine/tests) — `ru.json`/`de.json`/
  `fr.json` don't have these keys yet. **This is the set other agents are expected to flesh out** (the spec asks
  for double-digit phrase counts per event, kaomoji, sequences, `once` one-shots, etc.) — run
  `node --test tests/frontend/pio-content.test.js` after adding content, it validates events/`when` keys/
  placeholders/moods/length/sequence-length across all four files.

## Adding phrases

Just append objects to the right event array in each of the four files. No code changes needed unless you want a
new condition key (add it to `matchesWhen` in `public/js/pio/dialogue.js`, and to `KNOWN_WHEN_KEYS`) or a new
placeholder with special formatting (add it to `formatText` in the same file, and to `KNOWN_PLACEHOLDERS`) — a
plain pass-through placeholder (the host just puts a string/number in the context) needs no engine change at
all, only a `KNOWN_PLACEHOLDERS` entry so the content validator doesn't flag it as unknown.
