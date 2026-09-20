// Pio (Neptune) mascot, rendered with PixiJS + pixi-live2d-display on the Cubism 2 model ported from the legacy
// Pio 2.4 plugin (see legacy/pio/static/{pio.js,dialog.js,l2d.js} and legacy/js/pgwheel.js ~647-724 for how the
// old widget was wired up). This module only talks to the DOM, PIXI and the dialogue engine — it knows nothing
// about the wheel/game-card app; callers push events into it with `emit(event, context)`.
//
// Load order required in the host page (see public/vendor/README.md for why):
//   <script src="vendor/live2d/live2d.min.js"></script>
//   <script src="vendor/pixi/pixi.min.js"></script>
//   <script src="vendor/pixi-live2d-display/cubism2.min.js"></script>
//   <script type="module" src="js/pio/pio.js"></script>
//
// Usage:
//   import { createPio } from './js/pio/pio.js';
//   const pio = createPio({ modelUrl: 'pio/models/neptune/model.json', lang: 'en', dialogues: 'pio/dialogues' });
//   pio.emit('spin:start', { game: 'Half-Life' });
//   pio.emit('spin:end', { game: card.name, genres: card.genres, score: card.score.gg, hours: card.time.main,
//                           price: card.price.final, year: Number(card.release.date?.slice(0, 4)),
//                           platforms: card.platforms, tags: card.tags });
//   pio.setLanguage('ru');
//   pio.destroy();
//
// v2 engine rules (see .claude/docs/pio-spec.md, and public/pio/dialogues/README.md "Engine" table for the
// authoritative summary):
//   - Priority: 'spin:end'/'spin:repeatWinner'/'spin:sameGenre'/'empty'/'privacy'/'auth:login'/'konami' are HIGH
//     (interrupt a currently-showing bubble); clicks/list/search/settings-ish events are NORMAL (also interrupt);
//     'ambient'/'idle*'/'hover:*'/'tab:return'/'load' are LOW (never interrupt a bubble that is still showing --
//     dropped, not queued).
//   - A global minimum gap of 1.2s between any two bubbles; 'hover:*' additionally throttled to one bubble per
//     8s; 'ambient' additionally never within 25s of any other bubble (of any priority).
//   - Bubble display time scales with text length (min 3s, +45ms/char, max 9s); a `text` array (sequence) chains
//     automatically, one bubble after another, each timed the same way.
//   - Ambient chatter only ever fires while `document.visibilityState === 'visible'` AND the visitor has been
//     active (mouse/keyboard/touch) within the last 60s, every 90-150s (randomized so it never feels metronomic).
//   - Idle tiers: 'idle' at 45s, 'idle:long' at 3min, 'idle:veryLong' at 10min of no activity; all three reset
//     together on any activity.
//   - 'tab:return' fires when the tab becomes visible again after being hidden >=20s, with `awaySeconds`/
//     `awayMinutes` in the context.
//   - Clicking her (head/body hit areas) 5+ times within 3s fires 'click:spam' instead of the usual click event.
//   - The session spin counter (`sessionStorage`, survives the destroy()/recreate a page navigation does) is
//     bumped on every 'spin:start' and exposed to every phrase's context automatically as `{spins}`/`spinsMin`/
//     `spinsMax`; hitting 5/10/25/50 additionally fires 'spin:streak' shortly after. Likewise 'spin:end' compares
//     the winner against the session's previous winners to fire 'spin:repeatWinner' (same game twice) or
//     'spin:sameGenre' (3rd win in a row sharing a genre) right after the normal reaction.
//   - The visit counter (`localStorage`, persists across sessions) and a few "environment" facts (browser,
//     mobile, logged-in) are injected into every emit()'s context automatically so host call sites stay simple.

import { createDialogueEngine, MOODS } from './dialogue.js?v=dev'; // rewritten at deploy, see pio-global.js

const CANVAS_SIZE = 300; // matches legacy <canvas id="pio" width="300" height="300"> (legacy/ajax/pages/wheel.php)
const KNOWN_MOODS = MOODS;
const TYPE_CHAR_MS = 24;
const VISIBLE_KEY = 'pio.visible';
const SOUND_KEY = 'pio.sound';
// public/pio/dialogues/ only ships en/ru/de/fr.json; every other UI language falls back to this one
// (see ensurePoolWithFallback() below).
const DEFAULT_LANG = 'en';

// --- v2 engine tuning constants (see the file header / public/pio/dialogues/README.md "Engine" table) ---
const GLOBAL_GAP_MS = 1200;
const HOVER_GAP_MS = 8000;
const AMBIENT_GAP_MS = 25000;
const AMBIENT_MIN_MS = 90000;
const AMBIENT_MAX_MS = 150000;
const ACTIVE_WINDOW_MS = 60000;
const IDLE_TIERS = [
  { ms: 45000, event: 'idle' },
  { ms: 180000, event: 'idle:long' },
  { ms: 600000, event: 'idle:veryLong' },
];
const TAB_RETURN_MIN_HIDDEN_MS = 20000;
const CLICK_SPAM_WINDOW_MS = 3000;
const CLICK_SPAM_THRESHOLD = 5;
const SPIN_MILESTONES = [5, 10, 25, 50];
const FOLLOWUP_DELAY_MS = 1600; // > GLOBAL_GAP_MS, so a chained spin:streak/repeatWinner/sameGenre isn't dropped
const BUBBLE_MIN_MS = 3000;
const BUBBLE_MAX_MS = 9000;
const BUBBLE_MS_PER_CHAR = 45;
const KONAMI_SEQUENCE = ['arrowup', 'arrowup', 'arrowdown', 'arrowdown', 'arrowleft', 'arrowright', 'arrowleft', 'arrowright', 'b', 'a'];

const HIGH_PRIORITY_EVENTS = new Set(['spin:end', 'spin:repeatWinner', 'spin:sameGenre', 'empty', 'privacy', 'auth:login', 'konami']);
const LOW_PRIORITY_EVENTS = new Set(['ambient', 'idle', 'idle:long', 'idle:veryLong', 'tab:return', 'load']);

function getPriority(event) {
  if (HIGH_PRIORITY_EVENTS.has(event)) return 'high';
  if (LOW_PRIORITY_EVENTS.has(event) || event.indexOf('hover:') === 0) return 'low';
  return 'normal';
}

function bubbleDurationMs(text) {
  const ms = BUBBLE_MIN_MS + String(text || '').length * BUBBLE_MS_PER_CHAR;
  return Math.min(BUBBLE_MAX_MS, Math.max(BUBBLE_MIN_MS, ms));
}

function readBoolPref(key, fallback) {
  try {
    const v = window.localStorage.getItem(key);
    return v == null ? fallback : v === '1';
  } catch (e) {
    return fallback;
  }
}

function writeBoolPref(key, value) {
  try {
    window.localStorage.setItem(key, value ? '1' : '0');
  } catch (e) {
    /* private mode / storage disabled: preference just won't persist */
  }
}

/** Wraps sessionStorage.getItem/JSON.parse; tolerates a missing/broken/disabled sessionStorage entirely. */
function readSession(key, fallback) {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return fallback;
    const raw = window.sessionStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

function writeSession(key, value) {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return;
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    /* private mode / storage disabled: state just won't persist */
  }
}

function getNavigator() {
  try {
    if (typeof window !== 'undefined' && window.navigator) return window.navigator;
  } catch (e) { /* ignore */ }
  try {
    if (typeof navigator !== 'undefined') return navigator;
  } catch (e) { /* ignore */ }
  return null;
}

/** Chrome/Firefox/Safari/Edge/Opera, or `undefined` when it can't be told apart (host phrases treat this as
 * "placeholder not fillable" and simply won't be picked -- see dialogue.js's pick()). Order matters: Edge and
 * Opera both also match the Chrome/Safari tokens. */
function detectBrowser() {
  const nav = getNavigator();
  const ua = (nav && nav.userAgent) || '';
  if (!ua) return undefined;
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\//.test(ua) || /Opera/.test(ua)) return 'Opera';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return undefined;
}

function detectMobile() {
  const nav = getNavigator();
  const ua = (nav && nav.userAgent) || '';
  return /Mobi|Android|iPhone|iPad|iPod/i.test(ua);
}

function resolveContainer(container) {
  if (!container) {
    const el = document.createElement('div');
    document.body.appendChild(el);
    return el;
  }
  if (typeof container === 'string') {
    const el = document.querySelector(container);
    if (!el) throw new Error(`pio: container "${container}" not found`);
    return el;
  }
  return container;
}

function buildDom(root) {
  root.classList.add('pio-container');
  root.innerHTML = '';

  const canvas = document.createElement('canvas');
  canvas.className = 'pio-canvas';
  canvas.width = CANVAS_SIZE;
  canvas.height = CANVAS_SIZE;
  root.appendChild(canvas);

  const dialog = document.createElement('div');
  dialog.className = 'pio-dialog';
  const dialogText = document.createElement('span');
  dialog.appendChild(dialogText);
  root.appendChild(dialog);

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'pio-toggle';
  toggle.setAttribute('aria-label', 'Toggle Pio');
  toggle.textContent = '\u{1F4AC}';
  root.appendChild(toggle);

  return { canvas, dialog, dialogText, toggle };
}

function typeText(el, text, charDelay, onDone) {
  clearInterval(el._pioTypeTimer);
  let i = 0;
  el.textContent = '';
  el.parentElement.classList.add('pio-typing');
  el._pioTypeTimer = setInterval(() => {
    i += 1;
    el.textContent = text.slice(0, i);
    if (i >= text.length) {
      clearInterval(el._pioTypeTimer);
      el.parentElement.classList.remove('pio-typing');
      if (onDone) onDone();
    }
  }, charDelay);
}

/** Fits a loaded Live2D model into a `size`x`size` box, bottom-aligned (matches the legacy bottom-corner look). */
function fitModel(model, size) {
  const bounds = model.getLocalBounds();
  if (!bounds.width || !bounds.height) return;
  const scale = Math.min(size / bounds.width, size / bounds.height) * 0.95;
  model.scale.set(scale);
  model.x = (size - bounds.width * scale) / 2 - bounds.x * scale;
  model.y = size - bounds.height * scale - bounds.y * scale;
}

/**
 * @param {object} opts
 * @param {HTMLElement|string} [opts.container] mount point (element or CSS selector); a fixed bottom-right
 *   container is created and appended to <body> when omitted.
 * @param {string} opts.modelUrl path to the Cubism 2 model.json (e.g. "pio/models/neptune/model.json").
 * @param {string} [opts.lang] initial language code (default "en").
 * @param {string|Record<string, object>} [opts.dialogues] either a base path such as "pio/dialogues" (files are
 *   fetched lazily as "<base>/<lang>.json") or an already-loaded map { en: {...}, ru: {...}, ... }.
 * @param {boolean} [opts.sound] initial sound-enabled state; defaults to the persisted preference (or true).
 */
export function createPio(opts = {}) {
  const initialLang = opts.lang || 'en';
  const dialogueEngine = createDialogueEngine({ lang: initialLang, storageKey: 'pio' });

  const root = resolveContainer(opts.container);
  const { canvas, dialog, dialogText, toggle } = buildDom(root);

  let app = null;
  let model = null;
  let destroyed = false;
  let hideTimer = null;
  let sequenceTimer = null;
  const followUpTimers = new Set();

  // --- bubble scheduling state (priorities/gaps/hover-throttle -- see the file header) ---
  let lastBubbleAt = -Infinity;
  let lastHoverAt = -Infinity;
  let bubbleActiveUntil = 0;

  function setSoundEnabled(enabled) {
    writeBoolPref(SOUND_KEY, enabled);
    try {
      if (window.PIXI && window.PIXI.live2d && window.PIXI.live2d.config) {
        window.PIXI.live2d.config.sound = Boolean(enabled);
      }
    } catch (e) {
      /* pixi-live2d-display not loaded yet; applied again once it is, in init() */
    }
  }

  function applyVisible(visible) {
    root.classList.toggle('pio-hidden', !visible);
    toggle.setAttribute('aria-pressed', String(!visible));
    // Hidden = only this button stays on screen (as a small "bring her back" tab); without it a visitor who
    // closed her once could never get her back, the preference is remembered in localStorage.
    toggle.textContent = visible ? '×' : '💬';
    toggle.title = visible ? 'Hide' : 'Show';
    if (!visible) { try { dialog.classList.remove('pio-dialog-active'); } catch (e) { /* no bubble yet */ } }
  }

  let visible = readBoolPref(VISIBLE_KEY, true);
  applyVisible(visible);
  toggle.addEventListener('click', () => {
    visible = !visible;
    writeBoolPref(VISIBLE_KEY, visible);
    applyVisible(visible);
  });

  function setExpression(mood) {
    if (!model) return;
    const m = KNOWN_MOODS.includes(mood) ? mood : 'normal';
    try {
      model.expression(m);
    } catch (e) {
      /* expression file missing for this model: ignore, keep current pose */
    }
  }

  function playTapMotion() {
    if (!model) return;
    try {
      model.motion('tap_body');
    } catch (e) {
      /* no such motion group on this model */
    }
  }

  /** Shows one bubble, then (if `rest` is non-empty) chains into the next one after its display time. */
  function playSequence(mood, texts) {
    clearTimeout(sequenceTimer);
    const [head, ...rest] = texts;
    if (head == null) return;
    setExpression(mood);
    clearTimeout(hideTimer);
    dialog.classList.add('pio-dialog-active');
    typeText(dialogText, head, TYPE_CHAR_MS);
    const displayMs = bubbleDurationMs(head);
    bubbleActiveUntil = Date.now() + displayMs;
    if (rest.length) {
      sequenceTimer = setTimeout(() => playSequence(mood, rest), displayMs);
    } else {
      hideTimer = setTimeout(() => dialog.classList.remove('pio-dialog-active'), displayMs);
    }
  }

  /** Low-level "just show this text now" — bypasses all priority/gap/throttle bookkeeping (used by emit()). */
  function say(text, { mood = 'normal', sequence } = {}) {
    if (!text) return;
    playSequence(mood, sequence && sequence.length ? [text, ...sequence] : [text]);
  }

  // --- visits / session spin counter / "environment" facts, auto-injected into every emit() context ---

  function isLoggedIn() {
    try {
      return Boolean(window.GG && window.GG.session && window.GG.session.user);
    } catch (e) {
      return false;
    }
  }

  function currentUserName() {
    try {
      const user = window.GG && window.GG.session && window.GG.session.user;
      return (user && user.name) || undefined;
    } catch (e) {
      return undefined;
    }
  }

  function getSpinCount() {
    return readSession('pio.spins', 0);
  }

  function bumpSpinCount() {
    const count = getSpinCount() + 1;
    writeSession('pio.spins', count);
    const fired = readSession('pio.spinMilestones', []);
    let milestone = null;
    if (SPIN_MILESTONES.includes(count) && !fired.includes(count)) {
      milestone = count;
      writeSession('pio.spinMilestones', [...fired, count]);
    }
    return { count, milestone };
  }

  /** Tracks winners this session to detect an exact repeat, or a 3rd win in a row sharing a genre. */
  function recordWinner(context) {
    const name = context && context.game;
    const genre = context && (context.genre || (Array.isArray(context.genres) ? context.genres[0] : undefined));
    const state = readSession('pio.winners', { names: [], genres: [] });
    const isRepeat = Boolean(name) && state.names.includes(name);
    const genres = [genre, ...(state.genres || [])].slice(0, 3);
    const sameGenreStreak = Boolean(genre) && genres.length === 3 && genres.every((g) => g === genre);
    writeSession('pio.winners', { names: [name, ...(state.names || [])].slice(0, 20), genres });
    return { isRepeat, sameGenreStreak };
  }

  function buildAutoContext() {
    return {
      mobile: detectMobile(),
      browser: detectBrowser(),
      loggedIn: isLoggedIn(),
      user: currentUserName(),
      spins: getSpinCount(),
      visits: dialogueEngine.getVisitCount(),
    };
  }

  function scheduleFollowUp(fn, delay) {
    const id = setTimeout(() => {
      followUpTimers.delete(id);
      fn();
    }, delay);
    followUpTimers.add(id);
    return id;
  }

  /**
   * The gate every bubble goes through: priority vs. "a bubble is currently showing", the global 1.2s gap,
   * the hover 8s throttle and the ambient 25s-from-anything rule. Returns the picked `{text, mood, sequence?}`
   * (also what gets displayed) or `null` when nothing was shown (unknown/empty pool, or dropped by a rule).
   */
  function dispatch(event, context) {
    if (destroyed) return null;
    const now = Date.now();
    const priority = getPriority(event);
    const isHover = event.indexOf('hover:') === 0;

    if (isHover && now - lastHoverAt < HOVER_GAP_MS) return null;
    if (event === 'ambient' && now - lastBubbleAt < AMBIENT_GAP_MS) return null;
    if (now - lastBubbleAt < GLOBAL_GAP_MS) return null;
    if (bubbleActiveUntil > now && priority === 'low') return null; // never interrupt, dropped (not queued)

    const merged = Object.assign(buildAutoContext(), context);
    const picked = dialogueEngine.pick(event, merged);
    if (!picked) return null;

    lastBubbleAt = now;
    if (isHover) lastHoverAt = now;
    say(picked.text, { mood: picked.mood, sequence: picked.sequence });
    return picked;
  }

  /**
   * Public entry point. Host apps (pgwheel.js/pgsettings.js) call `emit(event, context)`; this also runs the
   * event-specific bookkeeping ('spin:start' bumps the session spin counter and may chain 'spin:streak',
   * 'spin:end' compares the winner against past winners and may chain 'spin:repeatWinner'/'spin:sameGenre').
   */
  function emit(event, context = {}) {
    context = context || {};
    if (event === 'spin:start') {
      const { count, milestone } = bumpSpinCount();
      const merged = Object.assign({ spins: count }, context);
      const result = dispatch(event, merged);
      if (milestone) scheduleFollowUp(() => dispatch('spin:streak', { spins: milestone }), FOLLOWUP_DELAY_MS);
      return result;
    }
    if (event === 'spin:end') {
      const { isRepeat, sameGenreStreak } = recordWinner(context);
      const result = dispatch(event, context);
      if (isRepeat) scheduleFollowUp(() => dispatch('spin:repeatWinner', context), FOLLOWUP_DELAY_MS);
      else if (sameGenreStreak) scheduleFollowUp(() => dispatch('spin:sameGenre', { genre: context.genre }), FOLLOWUP_DELAY_MS);
      return result;
    }
    return dispatch(event, context);
  }

  async function ensurePool(lang) {
    if (dialogueEngine.hasPool(lang)) return;
    const source = opts.dialogues;
    if (source && typeof source === 'object') {
      if (source[lang]) dialogueEngine.setPool(lang, source[lang]);
      return;
    }
    const base = typeof source === 'string' ? source : 'pio/dialogues';
    try {
      // same release token as every other asset, otherwise browsers keep serving last week's phrases from cache
      const ver = typeof window !== 'undefined' && window.GG && window.GG.version ? `?v=${window.GG.version}` : '';
      const res = await fetch(`${base}/${lang}.json${ver}`);
      if (res.ok) dialogueEngine.setPool(lang, await res.json());
    } catch (e) {
      /* offline or missing file: engine simply has no phrases for this language yet */
    }
  }

  // public/pio/dialogues/ only has en/ru/de/fr.json (owner decision -- no new dialogue files for the
  // other UI languages public/i18n/*.json now supports). Falls back to English's pool -- the one
  // that's guaranteed to exist -- for any language ensurePool() couldn't load a file for, instead of
  // silently leaving the engine on a language with no pool at all (pick() would then always return
  // null and Pio would never say anything). Returns the language whose pool actually ended up active.
  async function ensurePoolWithFallback(lang) {
    await ensurePool(lang);
    if (dialogueEngine.hasPool(lang)) return lang;
    if (lang !== DEFAULT_LANG) await ensurePool(DEFAULT_LANG);
    return DEFAULT_LANG;
  }

  async function setLanguage(lang) {
    const resolved = await ensurePoolWithFallback(lang);
    dialogueEngine.setLanguage(resolved);
  }

  // --- click-spam detection on the model's hit areas ---
  let hitTimestamps = [];
  let spamFlagged = false;
  function onHit(hitAreaNames) {
    playTapMotion();
    const now = Date.now();
    hitTimestamps = hitTimestamps.filter((t) => now - t < CLICK_SPAM_WINDOW_MS);
    hitTimestamps.push(now);
    if (hitTimestamps.length >= CLICK_SPAM_THRESHOLD) {
      if (spamFlagged) return; // already reacted to this burst; stay quiet until it cools down
      spamFlagged = true;
      emit('click:spam', {});
      return;
    }
    spamFlagged = false;
    const event = hitAreaNames.includes('head') ? 'click:head' : 'click:body';
    emit(event, {});
  }

  // --- idle tiers (45s / 3min / 10min) + the "active in the last 60s" flag ambient chatter needs ---
  let lastActivityAt = Date.now();
  let idleTimers = [];
  function clearIdleTimers() {
    idleTimers.forEach(clearTimeout);
    idleTimers = [];
  }
  function scheduleIdleTimers() {
    clearIdleTimers();
    IDLE_TIERS.forEach((tier) => {
      idleTimers.push(setTimeout(() => emit(tier.event, {}), tier.ms));
    });
  }
  function onActivity() {
    lastActivityAt = Date.now();
    scheduleIdleTimers();
  }
  document.addEventListener('mousemove', onActivity, { passive: true });
  document.addEventListener('keydown', onActivity);
  document.addEventListener('touchstart', onActivity, { passive: true });
  scheduleIdleTimers();

  // --- ambient chatter: every 90-150s, only while visible and recently active ---
  let ambientTimer = null;
  function scheduleAmbient() {
    const delay = AMBIENT_MIN_MS + Math.random() * (AMBIENT_MAX_MS - AMBIENT_MIN_MS);
    ambientTimer = setTimeout(() => {
      const visiblePage = typeof document === 'undefined' || document.visibilityState === 'visible';
      const recentlyActive = Date.now() - lastActivityAt < ACTIVE_WINDOW_MS;
      if (visiblePage && recentlyActive) emit('ambient', {});
      scheduleAmbient();
    }, delay);
  }
  scheduleAmbient();

  // --- tab:return: tab hidden for >=20s, then visible again ---
  let hiddenAt = null;
  function onVisibilityChange() {
    if (typeof document === 'undefined') return;
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
    } else if (document.visibilityState === 'visible' && hiddenAt != null) {
      const awaySeconds = Math.round((Date.now() - hiddenAt) / 1000);
      hiddenAt = null;
      if (awaySeconds >= TAB_RETURN_MIN_HIDDEN_MS / 1000) emit('tab:return', { awaySeconds });
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange);

  // --- konami code (↑↑↓↓←→←→BA) ---
  let konamiProgress = 0;
  function onKeydownKonami(e) {
    const key = String((e && e.key) || '').toLowerCase();
    if (key === KONAMI_SEQUENCE[konamiProgress]) {
      konamiProgress += 1;
      if (konamiProgress === KONAMI_SEQUENCE.length) {
        konamiProgress = 0;
        emit('konami', {});
      }
    } else {
      konamiProgress = key === KONAMI_SEQUENCE[0] ? 1 : 0;
    }
  }
  document.addEventListener('keydown', onKeydownKonami);

  // --- copy listener ---
  function onCopy() {
    emit('copy', {});
  }
  document.addEventListener('copy', onCopy);

  function playLoadGreeting() {
    const first = emit('load', {});
    if (first) setTimeout(() => emit('load', {}), 4000);
  }

  // Settings page has no mounted Pio (see pgsettings.js): it queues its last `settings:*` event in
  // sessionStorage instead of emitting directly. Play (and clear) it once, right after mounting, so it
  // isn't lost across the settings -> wheel navigation. Stale entries (>2 minutes old, e.g. the visitor sat
  // on the settings page for a while before coming back) are dropped rather than shown out of context.
  const PENDING_EVENT_KEY = 'pio.pendingEvent';
  const PENDING_EVENT_MAX_AGE_MS = 120000;
  function playPendingSettingsEvent() {
    const pending = readSession(PENDING_EVENT_KEY, null);
    if (!pending || !pending.event) return;
    writeSession(PENDING_EVENT_KEY, null);
    try {
      window.sessionStorage.removeItem(PENDING_EVENT_KEY);
    } catch (e) { /* ignore */ }
    if (typeof pending.ts === 'number' && Date.now() - pending.ts > PENDING_EVENT_MAX_AGE_MS) return;
    emit(pending.event, pending.context || {});
  }

  async function init() {
    const resolvedLang = await ensurePoolWithFallback(initialLang);
    dialogueEngine.setLanguage(resolvedLang);
    dialogueEngine.markVisit();
    dialogueEngine.recordVisit();
    setSoundEnabled(opts.sound != null ? opts.sound : readBoolPref(SOUND_KEY, true));
    playPendingSettingsEvent();

    if (typeof PIXI === 'undefined' || !PIXI.live2d) {
      // eslint-disable-next-line no-console
      console.error('[pio] PIXI / pixi-live2d-display globals not found — check the vendor <script> tags/order.');
      return;
    }

    app = new PIXI.Application({
      view: canvas,
      width: CANVAS_SIZE,
      height: CANVAS_SIZE,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
    });

    try {
      model = await PIXI.live2d.Live2DModel.from(opts.modelUrl, { autoInteract: true, autoUpdate: true });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[pio] failed to load Live2D model', e);
      return;
    }

    if (destroyed) {
      model.destroy();
      return;
    }

    app.stage.addChild(model);
    fitModel(model, CANVAS_SIZE);
    model.on('hit', onHit);

    playLoadGreeting();
  }

  init();

  function destroy() {
    destroyed = true;
    document.removeEventListener('mousemove', onActivity);
    document.removeEventListener('keydown', onActivity);
    document.removeEventListener('touchstart', onActivity);
    document.removeEventListener('keydown', onKeydownKonami);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    document.removeEventListener('copy', onCopy);
    dialogueEngine.stopIdle();
    clearIdleTimers();
    clearTimeout(ambientTimer);
    clearTimeout(hideTimer);
    clearTimeout(sequenceTimer);
    clearInterval(dialogText._pioTypeTimer);
    followUpTimers.forEach(clearTimeout);
    followUpTimers.clear();
    if (model) {
      try {
        model.destroy();
      } catch (e) {
        /* ignore */
      }
      model = null;
    }
    if (app) {
      try {
        app.destroy(true, { children: true });
      } catch (e) {
        /* ignore */
      }
      app = null;
    }
    if (root.parentNode) root.parentNode.removeChild(root);
  }

  return { emit, say, setLanguage, destroy };
}
