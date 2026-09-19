// gg-boot.js — classic script, runs last in index.html. Replaces what legacy PHP baked directly into
// index.php: session/CSRF, language detection, the inline `var __whatever = <?php ... ?>;` globals
// block, and the translation dictionary. Everything legacy's jQuery code (pgindex.js/pgwheel.js,
// pgsettings.js) expects as a bare global is defined here BEFORE js/pgindex.js is loaded (appended at
// the very end of init()), so the legacy router only ever starts once those globals exist.
(function (window, document) {
  "use strict";

  // Mirrors src/lib/languages.js's SUPPORTED (config.json site.languages) — kept here only for the
  // bare "?xx" URL query shortcut below, which has to run before the first GET /api/session response
  // (the one place that hands the frontend the authoritative list, exposed as `session.languages` and
  // re-used by pgsettings.js's language dropdown so that list itself isn't duplicated a second time).
  var SUPPORTED_LANGS = ["en", "ru", "de", "fr", "es", "pt", "it", "pl", "tr", "uk", "ja", "ko", "zh"];

  function detectLangFromQuery() {
    // Legacy (`ajax/scripts/init.php` -> getlang()): "?en"/"?ru"/"?de"/"?fr"/... in the URL wins.
    var search = window.location.search.replace(/^\?/, "");
    var candidate = search.split("&")[0];
    return SUPPORTED_LANGS.indexOf(candidate) !== -1 ? candidate : null;
  }

  function levelEmoji(level) {
    switch (level) {
      case 1: return "🐉";
      case 2: return "🦈";
      case 3: return "🐺";
      case 4: return "🐓";
      case 5: return "🦨";
      case 6: return "🐀";
      default: return "🦈";
    }
  }

  function fetchSession(lang) {
    var qs = lang ? "?lang=" + encodeURIComponent(lang) : "";
    return fetch("/api/session" + qs, { credentials: "same-origin" }).then(function (res) {
      if (!res.ok) throw new Error("GET /api/session failed: " + res.status);
      return res.json();
    });
  }

  function fetchStats() {
    return fetch("/api/stats", { credentials: "same-origin" })
      .then(function (res) { return (res.ok ? res.json() : null); })
      .catch(function () { return null; });
  }

  function setGlobals(session) {
    var t = window.GG.i18n.t;
    var user = session.user;

    window.__language = session.lang || "en";
    window.__csrf = session.csrf;
    window.__hpg = false; // streamer-mode fast wheel: retired, always false in the rewrite
    window.__user = "";
    window.__sname = (user && user.name) || "";
    window.__sid = (user && user.steamid) || "";
    window.__tranlsation_data = window.GG.i18n.getDict();

    window.__text_result = t("Add <b>{term}</b>");
    window.__text_count = t("{count} selected");
    window.__text_selections = t("Max {maxCount} selections");
    window.__text_results = t("No results found.");

    window.__settings_price = t("Price") + ": ";
    window.__settings_score = t("SGG Score") + ": ";
    window.__settings_hours = " " + t("hour(s)");
    window.__settings_ttb = t("Time to beat") + ": ";
    window.__settings_seconds = " " + t("seconds");
    window.__settings_duration = t("Duration of rotation") + ": ";
    window.__settings_number = t("Number of games") + ": ";
    window.__settings_rotation = t("Rotation speed") + ": ";

    // GG.session: not a legacy global (nothing in legacy code used this name) — pgwheel.js reads it to
    // render the profile block (avatar/name/emoji/login-logout) that legacy rendered server-side.
    window.GG.session = session;
  }

  function applyProfileChrome(session) {
    var user = session.user;
    var navAdmin = document.getElementById("nav-admin");
    if (navAdmin) navAdmin.style.display = user && user.admin ? "" : "none";
  }

  function init() {
    var requestedLang = detectLangFromQuery();

    fetchSession(requestedLang)
      .then(function (session) {
        var lang = SUPPORTED_LANGS.indexOf(session.lang) !== -1 ? session.lang : "en";
        document.documentElement.lang = lang;

        return window.GG.i18n.load(lang).then(function () {
          setGlobals(session);
          window.GG.i18n.apply(document);
          applyProfileChrome(session);
          return fetchStats();
        });
      })
      .then(function (stats) {
        var el = document.getElementById("roll-count");
        if (el && stats && typeof stats.rolls === "number") el.textContent = String(stats.rolls);
      })
      .catch(function (err) {
        // eslint-disable-next-line no-console
        console.error("[gg-boot] failed to initialise session/i18n, starting router with defaults", err);
        window.__language = "en";
        window.__csrf = "";
        window.__hpg = false;
        window.__user = "";
        window.__sname = "";
        window.__sid = "";
        window.__tranlsation_data = {};
        window.__text_result = "Add <b>{term}</b>";
        window.__text_count = "{count} selected";
        window.__text_selections = "Max {maxCount} selections";
        window.__text_results = "No results found.";
        window.__settings_price = "Price: ";
        window.__settings_score = "SGG Score: ";
        window.__settings_hours = " hour(s)";
        window.__settings_ttb = "Time to beat: ";
        window.__settings_seconds = " seconds";
        window.__settings_duration = "Duration of rotation: ";
        window.__settings_number = "Number of games: ";
        window.__settings_rotation = "Rotation speed: ";
      })
      .then(function () {
        // Legacy router starts only once the globals above exist (pgindex.js reads __hpg, and
        // pgwheel.js/pgsettings.js — loaded per-page — read the rest).
        var script = document.createElement("script");
        script.src = "js/pgindex.js?v=" + window.GG.version;
        document.body.appendChild(script);
      });
  }

  window.GG = window.GG || {};
  window.GG.levelEmoji = levelEmoji;

  init();
})(window, document);
