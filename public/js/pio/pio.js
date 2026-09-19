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

import { createDialogueEngine } from './dialogue.js';

const CANVAS_SIZE = 300; // matches legacy <canvas id="pio" width="300" height="300"> (legacy/ajax/pages/wheel.php)
const IDLE_MS = 45000;
const KNOWN_MOODS = ['normal', 'happy', 'enjoy', 'unhappy', 'kira', 'deformed'];
const TYPE_CHAR_MS = 24;
const VISIBLE_KEY = 'pio.visible';
const SOUND_KEY = 'pio.sound';
// public/pio/dialogues/ only ships en/ru/de/fr.json; every other UI language falls back to this one
// (see ensurePoolWithFallback() below).
const DEFAULT_LANG = 'en';

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

  function say(text, { mood = 'normal', hold } = {}) {
    if (!text) return;
    setExpression(mood);
    clearTimeout(hideTimer);
    dialog.classList.add('pio-dialog-active');
    typeText(dialogText, text, TYPE_CHAR_MS);
    const displayMs = hold != null ? hold : Math.max(4000, text.length * 120);
    hideTimer = setTimeout(() => dialog.classList.remove('pio-dialog-active'), displayMs);
  }

  function emit(event, context = {}) {
    const picked = dialogueEngine.pick(event, context);
    if (picked) say(picked.text, { mood: picked.mood });
    return picked;
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
      const res = await fetch(`${base}/${lang}.json`);
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

  function onHit(hitAreaNames) {
    const event = hitAreaNames.includes('head') ? 'click:head' : 'click:body';
    emit(event, {});
    playTapMotion();
  }

  function onIdle() {
    emit('idle', {});
    dialogueEngine.watchIdle(IDLE_MS, onIdle);
  }

  function onActivity() {
    dialogueEngine.notifyActivity(IDLE_MS, onIdle);
  }
  document.addEventListener('mousemove', onActivity, { passive: true });
  document.addEventListener('keydown', onActivity);
  document.addEventListener('touchstart', onActivity, { passive: true });

  function playLoadGreeting() {
    const first = emit('load', {});
    if (first) setTimeout(() => emit('load', {}), 4000);
  }

  async function init() {
    const resolvedLang = await ensurePoolWithFallback(initialLang);
    dialogueEngine.setLanguage(resolvedLang);
    dialogueEngine.markVisit();
    setSoundEnabled(opts.sound != null ? opts.sound : readBoolPref(SOUND_KEY, true));

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
    dialogueEngine.watchIdle(IDLE_MS, onIdle);
  }

  init();

  function destroy() {
    destroyed = true;
    document.removeEventListener('mousemove', onActivity);
    document.removeEventListener('keydown', onActivity);
    document.removeEventListener('touchstart', onActivity);
    dialogueEngine.stopIdle();
    clearTimeout(hideTimer);
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
