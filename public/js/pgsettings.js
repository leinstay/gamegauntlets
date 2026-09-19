// Settings page (port of legacy js/pgsettings.js). Fed by the static fragment
// public/pages/settings.html; runs after the router has injected that fragment into #content
// and called GG.i18n.apply() on it (static data-i18n strings are already translated by the time
// this file runs). This script only has to deal with content GG.i18n.apply() can't reach:
// language-conditional markup, remotely loaded dropdown options, and dynamic slider/calendar text.
//
// Backend contract: every sessionStorage key this file writes is read by the page shell's wheel
// adapter (task A) and turned into the POST /api/wheel body. Legacy key names/formats are kept
// unless noted below (see the task report for the full key table).
//
// Deviations from legacy (see task report for the full list):
//  - "name" (hand-picked games) is now id-based: sessionStorage.names (csv of ids) +
//    sessionStorage.namesLabels (JSON [{id,name}]), replacing legacy's name-string sessionStorage.name.
//  - "presets" is now id-based: sessionStorage.presets (preset id) + sessionStorage.presetsName
//    (display name), replacing legacy's name-string value.
//  - Dead legacy toggles with no HTML control and no gateway effect (smart, magic, delay -- see
//    .claude/docs/frontend.md "Dead: smart, magic, delay") are dropped instead of ported.
//  - HPG is gone (owner decision): __hpg is always false now, so the old `!__hpg ? a : b` branches
//    are collapsed to their non-HPG value `a`.
//  - The "Game Presets" header no longer links to the GGG rules sheet / GGG wheel / HPG3 (those
//    presets were dropped from the catalog per docs/plans rewrite-plan.md "GGG #1..#6 dropped").
//  - Streamer-specific price button presets are dropped (streamer status/HPG are gone).

if (!window.GG || !GG.i18n || typeof GG.i18n.t !== 'function' || !GG.api || typeof GG.api.get !== 'function') {
	console.error('pgsettings.js: window.GG (GG.i18n.t / GG.api.get) is required but missing -- settings page will not work correctly.');
}

// Safe translation helper: falls back to the raw key if GG isn't available, so a missing global
// degrades to (untranslated) English instead of throwing and aborting the whole script.
function t(key) {
	if (window.GG && GG.i18n && typeof GG.i18n.t === 'function') return GG.i18n.t(key);
	return key;
}

// Language-conditional markup (legacy rendered this server-side based on the session language):
// both variants are in the static HTML tagged data-lang="xx" / data-lang-not="xx"; drop whichever
// one doesn't match the current language before anything else runs.
$('[data-lang]').each(function () {
	if ($(this).attr('data-lang') !== __language) $(this).remove();
});
$('[data-lang-not]').each(function () {
	if ($(this).attr('data-lang-not') === __language) $(this).remove();
});

$('div.checkbox').each(function () {
	if ($(this).find('.question.icon').length) $(this).popup({
		inline: true,
		// the CIS pill sits at the very top of the page: its tooltip opens downwards
		position: this.id === 'backupRegion' ? 'bottom right' : 'top right',
		offset: '1'
	});
});

// Month/day names for the calendar popups (lived inside the old semantic-ui-calendar plugin file; Fomantic's
// built-in calendar module takes the same `text` object).
var calendarLanguage = {
	en: { days: ['S', 'M', 'T', 'W', 'T', 'F', 'S'], months: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'], monthsShort: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], today: 'Today', now: 'Now', am: 'AM', pm: 'PM' },
	ru: { days: ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'], months: ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'], monthsShort: ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'], today: 'Сегодня', now: 'Сейчас', am: 'AM', pm: 'PM' }
};

$('#rangestart').calendar({
	type: 'month',
	endCalendar: $('#rangeend'),
	text: (__language == 'ru') ? calendarLanguage['ru'] : calendarLanguage['en'],
	onChange: function (date, text, mode) {
		if (date)
			sessionStorage.setItem('from', date.getFullYear() + "-" + ("0" + (date.getMonth() + 1)).slice(-2) + "-01");
	}
});

$('#rangeend').calendar({
	type: 'month',
	startCalendar: $('#rangestart'),
	text: (__language == 'ru') ? calendarLanguage['ru'] : calendarLanguage['en'],
	onChange: function (date, text, mode) {
		if (date)
			sessionStorage.setItem('to', date.getFullYear() + "-" + ("0" + (date.getMonth() + 1)).slice(-2) + "-31");
	}
});

if (sessionStorage.getItem('from'))
	$('#rangestart').calendar('set date', new Date(sessionStorage.getItem('from').split('-')[0], sessionStorage.getItem('from').split('-')[1] - 1, sessionStorage.getItem('from').split('-')[2]), true, false);
if (sessionStorage.getItem('to'))
	$('#rangeend').calendar('set date', new Date(sessionStorage.getItem('to').split('-')[0], sessionStorage.getItem('to').split('-')[1] - 1, sessionStorage.getItem('to').split('-')[2]), true, false);

$('#rangestart button').click(function () {
	$('#rangestart').calendar('clear');
	sessionStorage.setItem('from', '');
});

$('#rangeend button').click(function () {
	$('#rangeend').calendar('clear');
	sessionStorage.setItem('to', '');
});

// Language switch: legacy POSTed an `actionType=changeLang` request to the settings page endpoint
// then reloaded so the whole page re-rendered server-side in the new language. The new backend has
// no such endpoint; instead, navigating to the localized URL (src/api/pages.js's GET /<lang>/) both
// re-renders the SEO shell in the new language AND persists it on the session, since gg-boot.js's
// detectLangFromQuery() reads the language straight out of the path and passes it to GET
// /api/session?lang=... on the next load -- no separate API call needed here.
//
// The static markup (public/pages/settings.html) only ever hardcoded 4 <div class="item"> languages;
// GG.session.languages (GET /api/session's `languages` field, set by gg-boot.js -- see src/lib/languages.js)
// is now the single source of truth for the full list, so the menu's contents are rebuilt from it here
// instead. Falls back to leaving the static 4-item markup alone if GG.session isn't available for some
// reason (offline/degraded gg-boot.js init -- see its own catch branch).
if (window.GG && GG.session && Array.isArray(GG.session.languages)) {
	var $langMenu = $('#changeLang .scrolling.menu').empty();
	GG.session.languages.forEach(function (lang) {
		$('<div>', { class: 'item', 'data-value': lang.code, text: lang.name }).appendTo($langMenu);
	});
}

$('#changeLang').dropdown({
	action: 'activate',
	onChange: function (value, text) {
		$('#changeLang.dropdown > .text').html(text);
		sessionStorage.setItem('price', '');
		// "Use CIS region" only ever concerns Russian (owner's rule, "Goal B"): turn it off immediately
		// on switching to any other language, before the reload below re-renders the page -- don't wait
		// for the reload to pick this up from the (still ru-scoped) checkbox state.
		if (value !== 'ru') sessionStorage.setItem('backupRegion', false);
		// Keep the current hash route (#wheel/#settings) across the navigation.
		window.location.href = '/' + value + '/' + window.location.hash;
	}
});

if (__language) {
	var currentLangEntry = (window.GG && GG.session && Array.isArray(GG.session.languages)) ?
		GG.session.languages.filter(function (l) { return l.code === __language; })[0] : null;
	var fullName = currentLangEntry ? currentLangEntry.name : $('#changeLang.dropdown .item[data-value=' + __language + ']').text();
	$('#changeLang.dropdown > .text').html(fullName);
}

// Dictionary-backed include/exclude selects (everything except the "name" wheel-builder and
// "presets" selects, handled separately below since they don't come from /api/dictionaries).
//
// `apiField` is the /api/dictionaries/<field> path segment (differs from the sessionStorage/select
// name only for gfq_difficulty -> difficulty). `translate` mirrors legacy's dictionary-file
// generator (cron_scripts/SGG, "json_data" script): it ran every value through the translator
// EXCEPT for developers/publishers/tags (proper nouns / Steam tags, never translated).
var DICTIONARY_FIELDS = {
	publishers: { apiField: 'publishers', translate: false },
	developers: { apiField: 'developers', translate: false },
	categories: { apiField: 'categories', translate: true },
	genres: { apiField: 'genres', translate: true },
	gfq_difficulty: { apiField: 'difficulty', translate: true },
	languages: { apiField: 'languages', translate: true },
	voiceovers: { apiField: 'voiceovers', translate: true },
	tags: { apiField: 'tags', translate: false }
};

var sarray = {};
$("select").each(function () {
	var id = $(this).attr("id");
	if (id === "name" || id === "presets") return; // handled separately below

	var name = $(this).attr("name");
	var contextEl = this;
	var placeholder = $(this).attr('data-placeholder') ? ($(this).attr('data-placeholder')) : "";
	if (name.indexOf("[]") >= 0) name = name.slice(0, -2);
	var vname = name;
	if (name.indexOf("no") >= 0) name = name.slice(0, -2);
	var dict = DICTIONARY_FIELDS[name];
	// maxSelections: 16 everywhere, matching legacy AND the new API's per-list cap
	// (src/api/wheel.js `listFilter.maxItems`) -- no change needed here.
	var mxsel = 16;
	var select = sarray[vname] = $(this).dropdown({
		filterRemoteData: true,
		fullTextSearch: 'exact',
		maxSelections: mxsel,
		clearable: true,
		placeholder: placeholder,
		saveRemoteData: false,
		preserveHTML: false,
		apiSettings: {
			url: '/api/dictionaries/' + dict.apiField + '?lang=' + __language,
			cache: true,
			onResponse: function (result) {
				var data = [];
				if (result) { // Semantic copies a top-level JSON array into {"0":…}: no .length, iterate with $.each
					var searchVal = select.closest('.ui.dropdown').find('input').val().toLowerCase();
					var selected = select.closest('.ui.dropdown').find('select').val() || [];
					$.each(result, function (i, option) {
						var label = dict.translate ? t(option.value) : option.name;
						if ((!searchVal || label.toLowerCase().indexOf(searchVal) >= 0 || String(option.value).toLowerCase().indexOf(searchVal) >= 0) && selected.indexOf(option.value) === -1)
							data.push({ value: option.value, name: label });
					});
					if (data) data = data.slice(0, 50);
				}
				return {
					success: true,
					results: data
				};
			}
		},
		onChange: function (value) {
			// name/presets mutual exclusion is handled in their own dedicated blocks below (they
			// are not part of this generic loop any more).
			sessionStorage.setItem(vname, $(this).val());
		},
		onRemove: function () {
			sessionStorage.setItem(vname, $(this).val());
		},
		message: {
			addResult: __text_result,
			count: __text_count,
			maxSelections: __text_selections,
			noResults: __text_results
		}
	});
	if (sessionStorage.getItem(vname)) {
		var selectValues = sessionStorage.getItem(vname).split(",");
		$.each(selectValues, function (i, sVal) {
			if (!sVal) return;
			// Legacy restored ALL selects (including tags/developers/publishers) through the same
			// blanket __tranlsation_data[sVal] || sVal lookup, regardless of whether that field's
			// live dropdown list was itself translated -- t() falls back to the raw key when there
			// is no translation, so this reproduces that (slightly inconsistent) legacy behaviour.
			var translate = t(sVal);
			$(contextEl).append($('<option>', {
				value: sVal,
				selected: 'selected',
				class: "addition"
			}).text(translate));
		});
	}
});

// Presets select: legacy stored the preset NAME (gateway matched `presets.name`); the new wheel
// API takes a numeric preset id (src/api/wheel.js `filters.preset`), so we store the id plus a
// separate display-name key used only to redraw the dropdown's selected option on reload (see
// task report -- this is a deliberate deviation from "keep the legacy key format").
(function () {
	var placeholder = $('#presets').attr('data-placeholder') || '';
	var presetsSelect = $('#presets').dropdown({
		filterRemoteData: true,
		fullTextSearch: 'exact',
		maxSelections: 1,
		clearable: true,
		placeholder: placeholder,
		saveRemoteData: false,
		preserveHTML: false,
		apiSettings: {
			url: '/api/dictionaries/presets?lang=' + __language,
			cache: true,
			onResponse: function (result) {
				var data = [];
				if (result) { // Semantic copies a top-level JSON array into {"0":…}: no .length, iterate with $.each
					var searchVal = presetsSelect.closest('.ui.dropdown').find('input').val().toLowerCase();
					$.each(result, function (i, option) {
						if (!searchVal || String(option.name).toLowerCase().indexOf(searchVal) >= 0)
							data.push({ value: option.value, name: option.name });
					});
					data = data.slice(0, 50);
				}
				return { success: true, results: data };
			}
		},
		onChange: function (value, text) {
			sessionStorage.setItem('presets', value || '');
			sessionStorage.setItem('presetsName', value ? text : '');
			if (value) {
				$('#name').dropdown('clear');
				sessionStorage.setItem('names', '');
				sessionStorage.setItem('namesLabels', '');
			}
		},
		onRemove: function () {
			sessionStorage.setItem('presets', '');
			sessionStorage.setItem('presetsName', '');
		},
		message: {
			addResult: __text_result,
			count: __text_count,
			maxSelections: __text_selections,
			noResults: __text_results
		}
	});
	if (sessionStorage.getItem('presets')) {
		var presetVal = sessionStorage.getItem('presets');
		var presetLabel = sessionStorage.getItem('presetsName') || presetVal;
		$('#presets').append($('<option>', {
			value: presetVal,
			selected: 'selected',
			class: 'addition'
		}).text(presetLabel));
	}
})();

// Wheel builder ("name") select: legacy loaded the full (6.6 MB) game name dump once and filtered
// client-side; the new API is a live server-side search (GET /api/games/search?q=), so this uses
// Semantic's `{query}` templating instead of a static one-shot fetch. Values are game ids (the new
// wheel filter `filters.names` is `integer[]`, see src/lib/wheel-query.js), with a namesLabels
// side-table so the dropdown can redraw its selected options after a reload without another
// network round-trip.
(function () {
	var placeholder = $('#name').attr('data-placeholder') || '';

	function currentLabels() {
		var labels = [];
		$('#name option:selected').each(function () {
			labels.push({ id: this.value, name: $(this).text() });
		});
		return labels;
	}

	function persist() {
		var ids = $('#name').val() || [];
		sessionStorage.setItem('names', ids.join(','));
		sessionStorage.setItem('namesLabels', JSON.stringify(currentLabels()));
		return ids;
	}

	$('#name').dropdown({
		filterRemoteData: false,
		fullTextSearch: 'exact',
		maxSelections: 16,
		clearable: true,
		placeholder: placeholder,
		saveRemoteData: false,
		preserveHTML: false,
		minCharacters: 2,
		apiSettings: {
			url: '/api/games/search?q={query}&lang=' + __language,
			cache: false,
			onResponse: function (result) {
				var data = [];
				// Semantic hands onResponse a deep COPY of the JSON: a top-level array arrives as {"0":…,"1":…}.
				if (result) {
					$.each(result, function (i, game) {
						if (!game || game.id == null) return;
						data.push({ value: String(game.id), name: game.name });
					});
				}
				return { success: true, results: data };
			}
		},
		onChange: function () {
			var ids = persist();
			if (ids.length) {
				$('#presets').dropdown('clear');
				sessionStorage.setItem('presets', '');
				sessionStorage.setItem('presetsName', '');
			}
		},
		onRemove: function () {
			persist();
		},
		message: {
			addResult: __text_result,
			count: __text_count,
			maxSelections: __text_selections,
			noResults: __text_results
		}
	});

	if (sessionStorage.getItem('names')) {
		var namesLabels = [];
		try {
			namesLabels = JSON.parse(sessionStorage.getItem('namesLabels') || '[]');
		} catch (e) {
			namesLabels = [];
		}
		var ids = sessionStorage.getItem('names').split(',');
		$.each(ids, function (i, id) {
			if (!id) return;
			var found = null;
			for (var j = 0; j < namesLabels.length; j++) {
				if (String(namesLabels[j].id) === String(id)) { found = namesLabels[j]; break; }
			}
			$('#name').append($('<option>', {
				value: id,
				selected: 'selected',
				class: 'addition'
			}).text(found ? found.name : id));
		});
	}
})();

$(".setprice").on('click', function () {
	$("#price").data("ionRangeSlider").update({
		from: $(this).data("min"),
		to: $(this).data("max")
	});
	sessionStorage.setItem('price', $(this).data("min") + ',' + $(this).data("max"));
});

$(".setscore").on('click', function () {
	$("#score").data("ionRangeSlider").update({
		from: $(this).data("min"),
		to: $(this).data("max")
	});
	sessionStorage.setItem('score', $(this).data("min") + ',' + $(this).data("max"));
});

$("#resetSettings").on('click', function () {
	$('#backupRegion').checkbox('uncheck'); // "Use CIS region": off by default (owner's rule, "Goal B")
	$('#empty').checkbox('check');
	$('#steam').checkbox('uncheck');
	$('#music').checkbox('check');
	$('#dynamic').checkbox('uncheck');

	$("select").each(function () {
		$(this).dropdown('clear');
	});
	$("#price").data("ionRangeSlider").update({
		from: 0,
		to: 5000
	});
	$("#score").data("ionRangeSlider").update({
		from: 0,
		to: 100
	});
	$("#length").data("ionRangeSlider").update({
		from: 0,
		to: 300
	});
	$("#spin").data("ionRangeSlider").update({
		from: 10
	});
	$("#speed").data("ionRangeSlider").update({
		from: 0.6
	});
	$("#segments").data("ionRangeSlider").update({
		from: 12
	});

	sessionStorage.setItem('backupRegion', false); // off by default (owner's rule, "Goal B")
	sessionStorage.setItem('empty', true);
	sessionStorage.setItem('steam', false);
	sessionStorage.setItem('music', true);
	sessionStorage.setItem('dynamic', true);
	sessionStorage.setItem('price', '0,5000');
	sessionStorage.setItem('score', '0,100');
	sessionStorage.setItem('length', '0,300');
	sessionStorage.setItem('spin', '10');
	sessionStorage.setItem('speed', '0.6');
	sessionStorage.setItem('segments', '12');
	sessionStorage.setItem('publishers', '');
	sessionStorage.setItem('publishersno', '');
	sessionStorage.setItem('developers', '');
	sessionStorage.setItem('developersno', '');
	sessionStorage.setItem('categories', '');
	sessionStorage.setItem('categoriesno', '');
	sessionStorage.setItem('genres', '');
	sessionStorage.setItem('genresno', '');
	sessionStorage.setItem('gfq_difficulty', '');
	sessionStorage.setItem('gfq_difficultyno', '');
	sessionStorage.setItem('languages', '');
	sessionStorage.setItem('languagesno', '');
	sessionStorage.setItem('voiceovers', '');
	sessionStorage.setItem('voiceoversno', '');
	sessionStorage.setItem('tags', '');
	sessionStorage.setItem('tagsno', '');
	sessionStorage.setItem('names', '');
	sessionStorage.setItem('namesLabels', '');
	sessionStorage.setItem('presets', '');
	sessionStorage.setItem('presetsName', '');
});

$('#publishers_switch').checkbox({
	onChecked: function () {
		sessionStorage.setItem('publishers_switch', true);
		$('#publishers').dropdown().hide();
		$('#publishersno').dropdown().show();
	},
	onUnchecked: function () {
		sessionStorage.setItem('publishers_switch', false);
		$('#publishersno').dropdown().hide();
		$('#publishers').dropdown().show();
	}
});

$('#developers_switch').checkbox({
	onChecked: function () {
		sessionStorage.setItem('developers_switch', true);
		$('#developers').dropdown().hide();
		$('#developersno').dropdown().show();
	},
	onUnchecked: function () {
		sessionStorage.setItem('developers_switch', false);
		$('#developersno').dropdown().hide();
		$('#developers').dropdown().show();
	}
});

$('#categories_switch').checkbox({
	onChecked: function () {
		sessionStorage.setItem('categories_switch', true);
		$('#categories').dropdown().hide();
		$('#categoriesno').dropdown().show();
	},
	onUnchecked: function () {
		sessionStorage.setItem('categories_switch', false);
		$('#categoriesno').dropdown().hide();
		$('#categories').dropdown().show();
	}
});

$('#genres_switch').checkbox({
	onChecked: function () {
		sessionStorage.setItem('genres_switch', true);
		$('#genres').dropdown().hide();
		$('#genresno').dropdown().show();
	},
	onUnchecked: function () {
		sessionStorage.setItem('genres_switch', false);
		$('#genresno').dropdown().hide();
		$('#genres').dropdown().show();
	}
});

$('#gfq_difficulty_switch').checkbox({
	onChecked: function () {
		sessionStorage.setItem('gfq_difficulty_switch', true);
		$('#gfq_difficulty').dropdown().hide();
		$('#gfq_difficultyno').dropdown().show();
	},
	onUnchecked: function () {
		sessionStorage.setItem('gfq_difficulty_switch', false);
		$('#gfq_difficultyno').dropdown().hide();
		$('#gfq_difficulty').dropdown().show();
	}
});

$('#languages_switch').checkbox({
	onChecked: function () {
		sessionStorage.setItem('languages_switch', true);
		$('#languages').dropdown().hide();
		$('#languagesno').dropdown().show();
	},
	onUnchecked: function () {
		sessionStorage.setItem('languages_switch', false);
		$('#languagesno').dropdown().hide();
		$('#languages').dropdown().show();
	}
});

$('#voiceovers_switch').checkbox({
	onChecked: function () {
		sessionStorage.setItem('voiceovers_switch', true);
		$('#voiceovers').dropdown().hide();
		$('#voiceoversno').dropdown().show();
	},
	onUnchecked: function () {
		sessionStorage.setItem('voiceovers_switch', false);
		$('#voiceoversno').dropdown().hide();
		$('#voiceovers').dropdown().show();
	}
});

$('#tags_switch').checkbox({
	onChecked: function () {
		sessionStorage.setItem('tags_switch', true);
		$('#tags').dropdown().hide();
		$('#tagsno').dropdown().show();
	},
	onUnchecked: function () {
		sessionStorage.setItem('tags_switch', false);
		$('#tagsno').dropdown().hide();
		$('#tags').dropdown().show();
	}
});

$('#steam').checkbox({
	onChecked: function () {
		sessionStorage.setItem('steam', true);
	},
	onUnchecked: function () {
		sessionStorage.setItem('steam', false);
	}
});

$('#backupRegion').checkbox({
	onChecked: function () {
		sessionStorage.setItem('backupRegion', true);
	},
	onUnchecked: function () {
		sessionStorage.setItem('backupRegion', false);
	}
});

$('#empty').checkbox({
	onChecked: function () {
		sessionStorage.setItem('empty', true);
	},
	onUnchecked: function () {
		sessionStorage.setItem('empty', false);
	}
});

$('#music').checkbox({
	onChecked: function () {
		sessionStorage.setItem('music', true);
	},
	onUnchecked: function () {
		sessionStorage.setItem('music', false);
	}
});

$('#dynamic').checkbox({
	onChecked: function () {
		sessionStorage.setItem('dynamic', false);
	},
	onUnchecked: function () {
		sessionStorage.setItem('dynamic', true);
	}
});

// Steam-library-only toggle: legacy disabled the checkbox server-side when `$_SESSION['steam']`
// (the logged-in Steam id) wasn't set. The new session is opaque to this static page, so ask the
// API instead; the checked/sessionStorage value itself is left untouched either way (same as
// legacy -- disabling only blocks further interaction, it doesn't clear a previously stored true).
if (window.GG && GG.api && typeof GG.api.get === 'function') {
	GG.api.get('/api/session').then(function (session) {
		if (!session || !session.user) {
			$('#steam').checkbox('disable');
		}
	}).catch(function (err) {
		console.error('pgsettings.js: GET /api/session failed, leaving the Steam-library toggle enabled', err);
	});
} else {
	console.error('pgsettings.js: GG.api.get is unavailable, cannot check Steam login status for the library-only toggle.');
}

if (sessionStorage.getItem('publishers_switch') == "true") {
	$('#publishers_switch').checkbox('check');
	$('#publishers').dropdown().hide();
	$('#publishersno').dropdown().show();
} else {
	$('#publishersno').dropdown().hide();
	$('#publishers').dropdown().show();
}
if (sessionStorage.getItem('developers_switch') == "true") {
	$('#developers_switch').checkbox('check');
	$('#developers').dropdown().hide();
	$('#developersno').dropdown().show();
} else {
	$('#developersno').dropdown().hide();
	$('#developers').dropdown().show();
}
if (sessionStorage.getItem('categories_switch') == "true") {
	$('#categories_switch').checkbox('check');
	$('#categories').dropdown().hide();
	$('#categoriesno').dropdown().show();
} else {
	$('#categoriesno').dropdown().hide();
	$('#categories').dropdown().show();
}
if (sessionStorage.getItem('genres_switch') == "true") {
	$('#genres_switch').checkbox('check');
	$('#genres').dropdown().hide();
	$('#genresno').dropdown().show();
} else {
	$('#genresno').dropdown().hide();
	$('#genres').dropdown().show();
}
if (sessionStorage.getItem('gfq_difficulty_switch') == "true") {
	$('#gfq_difficulty_switch').checkbox('check');
	$('#gfq_difficulty').dropdown().hide();
	$('#gfq_difficultyno').dropdown().show();
} else {
	$('#gfq_difficultyno').dropdown().hide();
	$('#gfq_difficulty').dropdown().show();
}
if (sessionStorage.getItem('languages_switch') == "true") {
	$('#languages_switch').checkbox('check');
	$('#languages').dropdown().hide();
	$('#languagesno').dropdown().show();
} else {
	$('#languagesno').dropdown().hide();
	$('#languages').dropdown().show();
}
if (sessionStorage.getItem('voiceovers_switch') == "true") {
	$('#voiceovers_switch').checkbox('check');
	$('#voiceovers').dropdown().hide();
	$('#voiceoversno').dropdown().show();
} else {
	$('#voiceoversno').dropdown().hide();
	$('#voiceovers').dropdown().show();
}
if (sessionStorage.getItem('tags_switch') == "true") {
	$('#tags_switch').checkbox('check');
	$('#tags').dropdown().hide();
	$('#tagsno').dropdown().show();
} else {
	$('#tagsno').dropdown().hide();
	$('#tags').dropdown().show();
}

if (sessionStorage.getItem('steam') == "true") $('#steam').checkbox('check');
if (sessionStorage.getItem('backupRegion') == "true") $('#backupRegion').checkbox('check');
if (sessionStorage.getItem('empty') == "true") $('#empty').checkbox('check');
if (sessionStorage.getItem('music') == "true") $('#music').checkbox('check');
if (sessionStorage.getItem('dynamic') == "false") $('#dynamic').checkbox('check');
if (!sessionStorage.getItem('price')) sessionStorage.setItem('price', '0,5000');
if (!sessionStorage.getItem('score')) sessionStorage.setItem('score', '0,100');
if (!sessionStorage.getItem('length')) sessionStorage.setItem('length', '0,300');
if (!sessionStorage.getItem('spin')) sessionStorage.setItem('spin', '10');
if (!sessionStorage.getItem('speed')) sessionStorage.setItem('speed', '0.6');
if (!sessionStorage.getItem('segments')) sessionStorage.setItem('segments', '12');

// skin: '' on every ionRangeSlider() call below opts out of ion.rangeSlider 2.5's built-in "flat" skin
// (its default) so the library only applies its bare, colorless layout CSS; the site's own "Nice" look
// (css/plugins/ion.rangeSlider.skinNice.css, ported for the 2.5.0 markup) then styles the bare classes
// exactly like it did against the old, skin-less 2.2 build.
$("#price").ionRangeSlider({
	skin: '',
	force_edges: true, // the legacy 2.1.2 copy was patched to always keep the from/to labels inside the track
	type: "double",
	grid: true,
	min: 0,
	max: (__language == 'ru') ? 5000 : 500,
	step: (__language == 'ru') ? 50 : 1,
	from: sessionStorage.getItem('price').split(",")[0],
	to: sessionStorage.getItem('price').split(",")[1],
	postfix: (__language == 'ru') ? " ₽" : " $",
	prefix: __settings_price,
	min_interval: 1,
	onFinish: function (data) {
		sessionStorage.setItem('price', data.from + ',' + data.to);
	}
});

$("#score").ionRangeSlider({
	skin: '',
	force_edges: true, // the legacy 2.1.2 copy was patched to always keep the from/to labels inside the track
	type: "double",
	grid: true,
	min: 0,
	max: 100,
	from: sessionStorage.getItem('score').split(",")[0],
	to: sessionStorage.getItem('score').split(",")[1],
	postfix: "",
	prefix: __settings_score,
	min_interval: 1,
	onFinish: function (data) {
		sessionStorage.setItem('score', data.from + ',' + data.to);
	}
});

$("#length").ionRangeSlider({
	skin: '',
	force_edges: true, // the legacy 2.1.2 copy was patched to always keep the from/to labels inside the track
	type: "double",
	grid: true,
	min: 0,
	max: 300,
	from: sessionStorage.getItem('length').split(",")[0],
	to: sessionStorage.getItem('length').split(",")[1],
	postfix: __settings_hours,
	prefix: __settings_ttb,
	min_interval: 1,
	onFinish: function (data) {
		sessionStorage.setItem('length', data.from + ',' + data.to);
	}
});

$("#spin").ionRangeSlider({
	skin: '',
	force_edges: true, // the legacy 2.1.2 copy was patched to always keep the from/to labels inside the track
	grid: true,
	min: 10,
	max: 30,
	from: sessionStorage.getItem('spin'),
	step: 10,
	postfix: __settings_seconds,
	prefix: __settings_duration,
	onFinish: function (data) {
		sessionStorage.setItem('spin', data.from);
	}
});

$("#segments").ionRangeSlider({
	skin: '',
	force_edges: true, // the legacy 2.1.2 copy was patched to always keep the from/to labels inside the track
	grid: true,
	min: 6,
	max: 16,
	from: sessionStorage.getItem('segments'),
	step: 1,
	postfix: "",
	prefix: __settings_number,
	onFinish: function (data) {
		sessionStorage.setItem('segments', data.from);
	}
});

$("#speed").ionRangeSlider({
	skin: '',
	force_edges: true, // the legacy 2.1.2 copy was patched to always keep the from/to labels inside the track
	grid: true,
	min: 0.2,
	max: 2,
	from: sessionStorage.getItem('speed'),
	step: 0.2,
	postfix: "",
	prefix: __settings_rotation,
	onFinish: function (data) {
		sessionStorage.setItem('speed', data.from);
	}
});
