// gg-i18n.js — classic script, global `GG.i18n`.
//
// Replaces legacy PHP `__()` (ajax/scripts/translation.php): legacy looked a string up in
// ajax/json/translation/<lang>.json (empty result -> original string). Same lookup here, against
// /i18n/<lang>.json (legacy strings, legacy keys win — see the port's i18n merge).
//
// Also replaces legacy gateway.php's per-field translation of game data (~line 436-450): genres,
// categories, languages, voiceovers and difficulty are single legacy-language strings/labels and are
// translated item-by-item and re-joined; tags/publishers/developers/platforms are joined verbatim
// (legacy never translated those).
(function (window) {
  "use strict";

  var GG = (window.GG = window.GG || {});

  var dict = {};
  var currentLang = "en";

  function t(key) {
    if (key == null) return key;
    var hit = dict[key];
    return hit == null || hit === "" ? key : hit;
  }

  function load(lang) {
    var v = (window.GG && window.GG.version) || "dev";
    return fetch("/i18n/" + lang + ".json?v=" + v)
      .then(function (res) {
        if (!res.ok) throw new Error("GET /i18n/" + lang + ".json failed: " + res.status);
        return res.json();
      })
      .then(function (data) {
        dict = data || {};
        currentLang = lang;
        return dict;
      });
  }

  function applyOne(el) {
    var key = el.getAttribute("data-i18n");
    // data-i18n-prefix / data-i18n-suffix keep the untranslated characters legacy had around the PHP
    // call inside the same element, e.g. <strong>__("Release date"): </strong> or " hour(s)".
    if (key) el.textContent = (el.getAttribute("data-i18n-prefix") || "") + t(key) + (el.getAttribute("data-i18n-suffix") || "");

    // data-i18n-html: like data-i18n, but sets innerHTML instead of textContent. Only meant for a
    // handful of trusted, static, dictionary-authored strings (the wheel intro block's list items
    // carry <b>/<i> markup) — never for anything derived from user or game data.
    var htmlKey = el.getAttribute("data-i18n-html");
    if (htmlKey) el.innerHTML = t(htmlKey);

    var titleKey = el.getAttribute("data-i18n-title");
    if (titleKey) el.setAttribute("title", t(titleKey));

    var placeholderKey = el.getAttribute("data-i18n-placeholder");
    if (placeholderKey) el.setAttribute("placeholder", t(placeholderKey));

    var ariaKey = el.getAttribute("data-i18n-aria-label");
    if (ariaKey) el.setAttribute("aria-label", t(ariaKey));

    var dataPlaceholderKey = el.getAttribute("data-i18n-data-placeholder");
    if (dataPlaceholderKey) el.setAttribute("data-placeholder", t(dataPlaceholderKey));
  }

  function apply(root) {
    root = root || document;
    if (root.nodeType === 1 && (root.hasAttribute("data-i18n") || root.hasAttribute("data-i18n-html") ||
        root.hasAttribute("data-i18n-title") || root.hasAttribute("data-i18n-placeholder") ||
        root.hasAttribute("data-i18n-aria-label") || root.hasAttribute("data-i18n-data-placeholder"))) {
      applyOne(root);
    }
    var all = root.querySelectorAll(
      "[data-i18n], [data-i18n-html], [data-i18n-title], [data-i18n-placeholder], [data-i18n-aria-label], [data-i18n-data-placeholder]"
    );
    for (var i = 0; i < all.length; i++) applyOne(all[i]);
  }

  /** Translate a "a, b, c" legacy comma-joined string item-by-item (genres/categories/languages/voiceovers/difficulty). */
  function translateList(items) {
    if (!items) return items;
    var arr = Array.isArray(items) ? items : String(items).split(",");
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var v = String(arr[i]).trim();
      if (v) out.push(t(v));
    }
    return out.join(", ");
  }

  /** Join a list verbatim (no translation) — legacy behaviour for tags/publishers/developers/platforms. */
  function joinList(items) {
    if (!items) return items;
    var arr = Array.isArray(items) ? items : String(items).split(",");
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var v = String(arr[i]).trim();
      if (v) out.push(v);
    }
    return out.join(", ");
  }

  GG.i18n = {
    load: load,
    apply: apply,
    t: t,
    translateList: translateList,
    joinList: joinList,
    getLang: function () {
      return currentLang;
    },
    getDict: function () {
      return dict;
    },
  };
})(window);
