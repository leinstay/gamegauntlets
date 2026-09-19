// gg-api.js — classic script, global `GG.api`. Adapter between the legacy jQuery frontend
// (pgindex.js/pgwheel.js) and the new JSON backend, replacing every `$.ajax(.../gateway.php)` call.
//
// Session caching + CSRF + one retry-on-403 mirrors public/js/api.js (the ES-module version used by
// the rejected redesign) — see that file for the reasoning; duplicated here as a classic script
// because pgwheel.js/pgindex.js are not modules and need a bare global.
(function (window) {
  "use strict";

  var GG = (window.GG = window.GG || {});

  function version() {
    return (window.GG && window.GG.version) || "dev";
  }

  var sessionPromise = null;

  function fetchSession() {
    if (!sessionPromise) {
      sessionPromise = fetch("/api/session", { credentials: "same-origin" })
        .then(function (res) {
          if (!res.ok) throw new Error("GET /api/session failed: " + res.status);
          return res.json();
        })
        .catch(function (err) {
          sessionPromise = null;
          throw err;
        });
    }
    return sessionPromise;
  }

  var WRITE_METHODS = { POST: 1, PUT: 1, DELETE: 1, PATCH: 1 };

  function request(method, path, body, retryOn403) {
    if (retryOn403 === undefined) retryOn403 = true;
    var opts = { method: method, credentials: "same-origin", headers: {} };

    var writePromise = WRITE_METHODS[method]
      ? fetchSession().then(function (session) {
          opts.headers["X-CSRF-Token"] = session.csrf;
          opts.headers["Content-Type"] = "application/json";
          opts.body = JSON.stringify(body || {});
        })
      : Promise.resolve();

    return writePromise
      .then(function () {
        return fetch(path, opts);
      })
      .then(function (res) {
        if (res.status === 403 && WRITE_METHODS[method] && retryOn403) {
          sessionPromise = null;
          return request(method, path, body, false);
        }
        if (!res.ok) {
          var err = new Error(method + " " + path + " failed: " + res.status);
          err.status = res.status;
          throw err;
        }
        var contentType = res.headers.get("content-type") || "";
        if (contentType.indexOf("text/csv") !== -1) return res.blob();
        if (res.status === 204) return null;
        return res.json();
      });
  }

  // ---- legacy-shape mapping (GameCard -> legacy `populateAbout()`/Winwheel segment object) ----

  var MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  var MONTHS_RU_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  var MONTHS_RU_NOM = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];

  /** Format {date, precision} per the current language, matching legacy's strftime-based output. */
  function formatReleaseDate(release, lang) {
    if (!release || !release.date || !release.precision || release.precision === "unknown") return "???";
    var parts = String(release.date).split("-"); // "YYYY-MM-DD" (day precision may omit trailing parts)
    var year = parts[0];
    var month = parts[1] ? parseInt(parts[1], 10) : null;
    var day = parts[2] ? parseInt(parts[2], 10) : null;
    var isRu = lang === "ru";

    switch (release.precision) {
      case "day":
        if (month == null || day == null) return "???";
        return isRu ? day + " " + MONTHS_RU_GEN[month - 1] + " " + year : MONTHS_EN[month - 1] + " " + day + ", " + year;
      case "month":
        if (month == null) return "???";
        return isRu ? MONTHS_RU_NOM[month - 1] + " " + year : MONTHS_EN[month - 1] + " " + year;
      case "quarter":
        if (month == null) return "???";
        var quarter = Math.ceil(month / 3);
        return isRu ? quarter + " квартал " + year : "Q" + quarter + " " + year;
      case "year":
        return String(year);
      default:
        return "???";
    }
  }

  /** Plain text (\n-separated, blank line = paragraph break) -> the HTML legacy's textShowAnimate() expects. */
  function descriptionToHtml(text) {
    if (!text) return "";
    var esc = function (s) {
      return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    };
    var blocks = String(text).split(/\n{2,}/);
    var html = "";
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i].trim();
      if (!block) continue;
      html += '<p style="padding-bottom:10px">' + esc(block).replace(/\n/g, "<br>") + "</p>";
    }
    return html;
  }

  var FALLBACK_IMAGES = ["/img/0.jpg", "/img/1.jpg", "/img/2.jpg", "/img/3.jpg", "/img/4.jpg", "/img/5.jpg", "/img/6.jpg", "/img/7.jpg",
    "/img/8.jpg", "/img/9.jpg", "/img/10.jpg", "/img/11.jpg", "/img/12.jpg", "/img/13.jpg", "/img/14.jpg", "/img/15.jpg"];

  /**
   * `card.scores.steamReviews.{all,recent}` ({percent, votes, label}|null, see src/lib/game-card.js) ->
   * the "<translated label> (12,345)" text the "Steam reviews"/"Recent reviews" card rows show, or null
   * (rendered as "???" by populateAbout(), same as every other unknown field). `label` is already the
   * English string doubling as an i18n key (src/lib/steam-review-label.js) - votes are localized via
   * the native `toLocaleString` so thousands separators match the current UI language.
   */
  function formatSteamReviewBlock(block, t, lang) {
    if (!block || block.votes == null) return null;
    var votesText = Number(block.votes).toLocaleString(lang);
    return block.label ? t(block.label) + " (" + votesText + ")" : votesText;
  }

  /**
   * Map a new-backend GameCard to the legacy-shaped object `populateAbout()` and the Winwheel
   * segments expect (legacy field names on purpose — see docs/plans rewrite-plan "API contract" and
   * legacy/ajax/scripts/gateway.php's bottom third for the original shape).
   * `opts.fallbackIndex` picks one of the legacy placeholder images (/img/0..15.jpg) when the card has
   * no image of its own — legacy never needed this (gateway.php just forwarded `image` verbatim), but
   * an <img> with an empty src is a visible broken-image icon, so this is a deliberate small
   * improvement over the exact legacy behaviour.
   */
  function toLegacyGame(card, opts) {
    opts = opts || {};
    var lang = (window.GG && window.GG.i18n && window.GG.i18n.getLang()) || "en";
    var t = window.GG && window.GG.i18n ? window.GG.i18n.t : function (s) { return s; };
    var translateList = window.GG && window.GG.i18n ? window.GG.i18n.translateList : function (a) { return (a || []).join(", "); };
    var joinList = window.GG && window.GG.i18n ? window.GG.i18n.joinList : function (a) { return (a || []).join(", "); };

    var price = card.price || {};
    var currency = price.currency === "RUB" ? "₽" : "$";
    var kind = card.kind || "steam";
    var isGog = kind === "gog_exclusive";
    var links = card.links || {};

    var criticsIsOpenCritic = card.scores && card.scores.criticsSource === "opencritic" && links.opencritic;

    return {
      id: card.id,
      name: card.name,
      segpic: card.image || FALLBACK_IMAGES[(opts.fallbackIndex || 0) % FALLBACK_IMAGES.length],
      published_date: formatReleaseDate(card.release, lang),
      final_score: card.score != null ? card.score : null,
      ggp: card.ggp != null ? card.ggp : 0,
      gfq_difficulty: card.difficulty ? t(card.difficulty) : null,
      publishers: joinList(card.publishers || []) || null,
      developers: joinList(card.developers || []) || null,
      categories: translateList(card.categories || []) || null,
      genres: translateList(card.genres || []) || null,
      tags: joinList(card.tags || []) || null,
      platforms: joinList(card.platforms || []) || null,
      languages: translateList(card.languages || []) || null,
      voiceovers: translateList(card.voiceovers || []) || null,
      stsp_owners: card.owners != null ? card.owners : null,
      // DECIMAL columns arrive as strings ("0.0", "12.0"): 0 means unknown (legacy printed "???"), and
      // Number() drops the trailing ".0" the legacy integers never had.
      final_time: card.time && Number(card.time.main) > 0 ? Number(card.time.main) : null,
      hltb_complete: card.time && Number(card.time.complete) > 0 ? Number(card.time.complete) : null,
      // Legacy showed an integer hour count (ceil(stsp_mdntime/100), see the rewrite's time_average
      // resolver); Math.round with a floor of 1 keeps "1 hour(s)" instead of "0" for a sub-hour estimate.
      stsp_mdntime: card.time && Number(card.time.average) > 0 ? Math.max(1, Math.round(Number(card.time.average))) : null,
      steam_reviews_all: formatSteamReviewBlock(card.scores && card.scores.steamReviews && card.scores.steamReviews.all, t, lang),
      steam_reviews_recent: formatSteamReviewBlock(card.scores && card.scores.steamReviews && card.scores.steamReviews.recent, t, lang),
      price_final: price.amount != null ? price.amount : 0,
      price_discount: price.final != null ? price.final : 0,
      discount: price.discount || 0,
      price_symbol: currency,
      store_url: isGog ? links.gog : links.steam,
      gog_url: links.gog || null,
      hltb_url: links.hltb || null,
      gfq_url: links.gamefaqs || null,
      igdb_url: links.igdb || null,
      meta_url: criticsIsOpenCritic ? links.opencritic : links.metacritic,
      meta_is_opencritic: !!criticsIsOpenCritic,
      opencritic_url: links.opencritic || null,
      store_platform: isGog ? "GOG" : "Steam",
      description: descriptionToHtml(card.description),
      // Raw (untranslated) facts for the Pio mascot's phrase conditions and placeholders — see pioContext() in pgwheel.js.
      pio: {
        genres: card.genres || [],
        tags: card.tags || [],
        platforms: card.platforms || [],
        developers: (card.developers || []).join(", "),
        year: card.release && card.release.date ? Number(String(card.release.date).slice(0, 4)) : null,
        price: price.final != null ? price.final : price.amount != null ? price.amount : null,
      },
    };
  }

  GG.api = {
    get: function (path) {
      return request("GET", path);
    },
    post: function (path, body) {
      return request("POST", path, body);
    },
    session: fetchSession,

    /** POST /api/wheel from sessionStorage filters -> {data:[legacyGame...]} | "empty" | "privacy". */
    wheel: function (buildRequest) {
      var body = buildRequest();
      return GG.api.post("/api/wheel", body).then(function (res) {
        if (res && res.error) return res.error;
        var games = (res && res.games) || [];
        return { data: games.map(function (g, i) { return toLegacyGame(g, { fallbackIndex: i }); }) };
      });
    },

    /** POST /api/wheel/random -> single legacyGame (legacy called this "first"/Random source). */
    random: function (lang, cisPrices) {
      return GG.api.post("/api/wheel/random", { lang: lang, cisPrices: !!cisPrices }).then(function (res) {
        if (res && res.error) return res.error;
        return toLegacyGame(res.game, { fallbackIndex: 0 });
      });
    },

    /** GET /api/games/:id -> legacyGame (search dropdown onChange). */
    game: function (id, lang) {
      return GG.api
        .get("/api/games/" + encodeURIComponent(id) + "?lang=" + encodeURIComponent(lang))
        .then(function (card) {
          return toLegacyGame(card, { fallbackIndex: 0 });
        });
    },

    /** POST /api/wheel/marbles -> Blob (text/csv), same body shape as wheel(). */
    marbles: function (buildRequest) {
      var body = buildRequest();
      return GG.api.post("/api/wheel/marbles", body);
    },

    toLegacyGame: toLegacyGame,
    formatReleaseDate: formatReleaseDate,
    descriptionToHtml: descriptionToHtml,
  };
})(window);
