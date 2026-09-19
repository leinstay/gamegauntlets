// pgwheel.js — wheel page logic (ported from legacy/js/pgwheel.js).
//
// Data-layer swap only (see the port task) — the wheel/Winwheel/animation/typewriter code is
// unchanged from legacy. What changed:
//   - Every $.ajax(.../gateway.php) call -> GG.api.* (public/js/gg-api.js), which already speaks the
//     new JSON API and maps results back to the legacy game-object shape.
//   - Gabestore -> GOG (#rgabebtn -> #rgogbtn), Metacritic button relabels itself to "Check on
//     OpenCritic" when the card's critic score source is OpenCritic.
//   - Video/YouTube support removed (no `store_promo_url` from the new backend).
//   - "Average playtime" (#rhlaverage / stsp_mdntime) removed (not in the new data).
//   - Two `.game-char` blocks (ru vs default sizing, ids suffixed "2" on the default block) are both
//     always populated so whichever one CSS/JS shows for the current language is up to date.
//   - Profile block (avatar/name/emoji/login/logout) is rendered from `GG.session.user` (set by
//     gg-boot.js) instead of PHP-rendered session data; login/logout hit the new /api/auth/* routes.
//   - Pio (Neptune) mascot is the new pixi/live2d module (public/js/pio/pio.js) via `GG.pio`, driven
//     with `emit(event, context)` instead of the legacy PaulPio's per-topic methods.

function initWheel(e) {
	$("#aboutg").parent().removeClass("transition hidden"), theWheel = new Winwheel({
		numSegments: sessionStorage.getItem("segments"),
		outerRadius: e,
		innerRadius: 0,
		textFontSize: 35,
		lineWidth: 5,
		strokeStyle: "white",
		textFillStyle: "white",
		dynamicImages: "true" == sessionStorage.getItem("dynamic"),
		alpha: 1,
		fillStyle: "rgba(40, 40, 40, 1)",
		animation: {
			type: "spinToStop",
			easing: "Power2.easeOut"
		}
	}), document.getElementById("spin_button").onclick = resetWheel, theWheel.animation.spins = .5, theWheel.animation.duration = 20, theWheel.startAnimation(), wheelSpinning = !0
}

function reInitWheel(e, t = !1) {
	if (!theWheel) {
		var n = sessionStorage.getItem("gamesdata");
		if (n) {
			if (n = JSON.parse(n), sessionStorage.getItem("segments") == n.numOfSegments) {
				for ((theWheel = new Winwheel({
						numSegments: sessionStorage.getItem("segments"),
						outerRadius: e,
						innerRadius: 0,
						textFontSize: 35,
						lineWidth: 5,
						strokeStyle: "white",
						textFillStyle: "white",
						dynamicImages: "true" == sessionStorage.getItem("dynamic"),
						segments: n.data,
						fillStyle: "rgba(40, 40, 40, 0.8)",
						alpha: 1,
						animation: {
							type: "spinToStop",
							easing: "Power2.easeInOut",
							spins: 1,
							duration: .1,
							callbackFinished: "preDrawWheel()",
							callbackAfter: "drawTriangle()"
						}
					})).alpha = .1, winner = theWheel.segments[n.winnerNum], $("#rdesc").empty(), x = 1; x <= sessionStorage.getItem("segments"); x++) $("#im" + x).attr("src", n.data[x - 1].segpic), $("#im_list" + x).attr("src", n.data[x - 1].segpic);
				$.each(n.data, function (e, t) {
					$("#all" + e).parent().removeClass("visible").addClass("transition hidden"), $("#all" + e).html(t.name)
				}), highlightGame(winner, !0), $(".gtext").parent().transition({
					animation: "fly left in",
					duration: 1100,
					reverse: !1,
					interval: 100,
					onStart: function () {
						$(this).children().attr("id") == "all" + (sessionStorage.getItem("segments") - 1) && (modedGame.removeClass("highlight-list-item"), (modedGame = $("#all" + getSegmentNum(winner)).parent().parent()).addClass("highlight-list-item"), scrollToHighlight(), $("#all" + getSegmentNum(winner)).parent().parent().addClass("winner-list-item"))
					}
				});
				var s = theWheel.getRandomForSegment(n.winnerNum);
				theWheel.animation.stopAngle = s, theWheel.startAnimation(), wheelSpinning = !1
			}
		} else initWheel(e), preDrawWheel();
		theWheel || initWheel(e)
	}
}

function preDrawWheel() {
	theWheel.createPatterns(), theWheel.drawSegments(), theWheel.draw(), drawTriangle()
}

function drawTriangle() {
	if (theWheel.segments[1].name) {
		var e = theWheel.ctx;
		e.strokeStyle = theWheel.strokeStyle, e.fillStyle = "rgba(40, 40, 40, 0.98)", e.lineWidth = 1.5 * theWheel.lineWidth, e.beginPath(), e.lineTo(wheelSize + .1115866268382353 * wheelSize, 11), e.lineTo(wheelSize + .01594094669117647 * wheelSize, .17 * wheelSize), e.lineTo(wheelSize - .07970473345588236 * wheelSize, 11), e.stroke(), e.fill()
	}
}

function resetWheel() {
	theWheel.stopAnimation(!1), theWheel.draw(), drawTriangle(), wheelSpinning = !1, startSpin()
}

function wheelLoadData(e) {
	for ($("#all" + getSegmentNum(winner)).parent().parent().removeClass("winner-list-item"), modedGame.removeClass("highlight-list-item"), x = 1; x <= sessionStorage.getItem("segments"); x++) $("#im" + x).attr("src", "");
	for (soundManager.stopAll(), $(".gtext").parent().transition({
			animation: "fly left out",
			duration: 400
		}), x = 1; x <= sessionStorage.getItem("segments"); x++) $("#im_list" + x).hasClass("hidden") || $("#im_list" + x).transition("fly down out");
	for (theWheel = new Winwheel({
			numSegments: sessionStorage.getItem("segments"),
			outerRadius: wheelSize,
			innerRadius: 0,
			textFontSize: 35,
			lineWidth: 5,
			strokeStyle: "white",
			textFillStyle: "white",
			fillStyle: "rgba(40, 40, 40, 1)",
			alpha: 1,
			dynamicImages: "true" == sessionStorage.getItem("dynamic")
		}), drawTriangle(), x = 1; x <= sessionStorage.getItem("segments"); x++) $("#im" + x).attr("src", e[x - 1].segpic), $("#im_list" + x).attr("src", e[x - 1].segpic);
	if ("true" == sessionStorage.getItem("delay") && soundManager.setup({
			onready: function () {
				soundManager.createSound({
					id: "carnage",
					url: "msc/carnage.mp3"
				}).play({
					volume: 5
				})
			}
		}), $.each(e, function (e, t) {
			$("#all" + e).html(t.name)
		}), "true" == sessionStorage.getItem("delay")) {
		var t = 0,
			n = 0;
		timeFVars.startSpinList = setInterval(function () {
			$("#all" + t).parent().transition("fly left in", function () {
				$("#im_list" + (n + 1)).prop("complete") && $("#im_list" + (n + 1)).transition({
					animation: "fly down in",
					duration: 500
				}), n++
			}), ++t > e.length && (clearTimeout(timeFVars.startSpinList), theWheel.createPatterns())
		}, 2500 / sessionStorage.getItem("segments"))
	}
	"false" == sessionStorage.getItem("delay") && $(".gtext").parent().transition({
		animation: "fly left in",
		duration: 1100,
		reverse: !1,
		interval: 100
	})
}

// Builds the /api/wheel body from sessionStorage (legacy kept every sessionStorage key and POSTed it
// wholesale to gateway.php; the new API validates strictly, so this maps the same keys onto the
// {lang, segments, filters} shape it accepts — see the port task item 7 and src/lib/wheel-query.js).
function splitCsv(value) {
	if (!value) return [];
	var out = [];
	String(value).split(",").forEach(function (v) {
		v = v.trim();
		if (v) out.push(v);
	});
	return out;
}

function parseRange(value) {
	if (!value) return null;
	var parts = String(value).split(",");
	if (parts.length !== 2) return null;
	var from = Number(parts[0]),
		to = Number(parts[1]);
	if (isNaN(from) || isNaN(to)) return null;
	return [from, to];
}

var LIST_FILTER_FIELDS = ["genres", "tags", "categories", "languages", "voiceovers", "developers", "publishers"];

// "Use CIS region" toggle -> API `cisPrices` (src/lib/wheel-query.js's regional-availability filter).
// Legacy gated this the same way server-side (gateway.php ~line 68: `$isBackupRegion = ($post['backupRegion']
// == "true" || $post['select']) && (empty($post['language']) || $post['language'] == "ru")`) - the toggle
// itself only exists in the settings UI for ru (public/pages/settings.html's `data-lang="ru"` wrapper,
// stripped for every other language by pgsettings.js). Owner's rule ("Goal B"): it only ever concerns
// Russian and can never be on in any other language, and it's off by default -- sessionStorage("backupRegion")
// defaults to false regardless of language (below), and pgsettings.js forces it back to false the instant
// the language changes away from ru. This function still re-checks the language itself rather than trusting
// the stored flag alone -- defence in depth against a stale/tampered sessionStorage value (src/api/wheel.js
// enforces the same rule server-side, independently).
function cisPricesEnabled() {
	return (!__language || __language === "ru") && "true" == sessionStorage.getItem("backupRegion");
}

function buildWheelRequest() {
	var include = {},
		exclude = {};
	LIST_FILTER_FIELDS.forEach(function (field) {
		var inc = splitCsv(sessionStorage.getItem(field));
		var exc = splitCsv(sessionStorage.getItem(field + "no"));
		if (inc.length) include[field] = inc;
		if (exc.length) exclude[field] = exc;
	});
	var diffInc = splitCsv(sessionStorage.getItem("gfq_difficulty"));
	var diffExc = splitCsv(sessionStorage.getItem("gfq_difficultyno"));
	if (diffInc.length) include.difficulty = diffInc;
	if (diffExc.length) exclude.difficulty = diffExc;

	var filters = {};
	if (Object.keys(include).length) filters.include = include;
	if (Object.keys(exclude).length) filters.exclude = exclude;

	var price = parseRange(sessionStorage.getItem("price"));
	if (price) filters.price = price;
	var score = parseRange(sessionStorage.getItem("score"));
	if (score) filters.score = score;
	// Length (hours): unlike price, src/lib/wheel-query.js has no "slider at max = unlimited" rule for
	// this column (a plain BETWEEN) — legacy never needed one either (gateway.php ~line 263 is a plain
	// >= / <= too), but the settings-page slider tops out at 300h for usability. A game genuinely
	// longer than that would otherwise be silently excluded, so the upper bound is only kept when the
	// slider was actually pulled below its max.
	var length = parseRange(sessionStorage.getItem("length"));
	if (length) {
		if (length[1] >= 300) length[1] = 100000;
		filters.length = length;
	}
	// Release date range: settings page (pgsettings.js) writes plain-date keys "from"/"to"
	// ("YYYY-MM-DD", either may be blank), mirroring legacy sessionStorage keys that were forwarded
	// almost verbatim to gateway.php (which defaulted empty from/to to "1985-01-01"/"2100-01-01" —
	// legacy/ajax/scripts/gateway.php ~line 65-66). The API wants ["YYYY-MM","YYYY-MM"], so this
	// truncates to month and applies the same legacy defaults for whichever side is blank.
	var releasedFrom = sessionStorage.getItem("from");
	var releasedTo = sessionStorage.getItem("to");
	if (releasedFrom || releasedTo) {
		filters.released = [
			releasedFrom ? releasedFrom.slice(0, 7) : "1985-01",
			releasedTo ? releasedTo.slice(0, 7) : "2100-01",
		];
	}

	filters.allowEmpty = "true" == sessionStorage.getItem("empty");
	filters.steamLibrary = "true" == sessionStorage.getItem("steam");
	filters.cisPrices = cisPricesEnabled();

	var presets = sessionStorage.getItem("presets");
	if (presets) {
		var p = parseInt(presets, 10);
		if (!isNaN(p) && p > 0) filters.preset = p;
	}

	var names = sessionStorage.getItem("names");
	if (names) {
		var ids = splitCsv(names)
			.map(Number)
			.filter(function (n) {
				return Number.isInteger(n) && n > 0;
			});
		if (ids.length) filters.names = ids;
	}

	var segments = parseInt(sessionStorage.getItem("segments"), 10) || 12;
	return { lang: __language, segments: segments, filters: filters };
}

function startSpin() {
	if (0 == wheelSpinning) {
		clearTimeout(timeFVars.donationremindertimer), document.getElementById("spin_button").onclick = resetWheel, document.getElementById("spin_button").disabled = !0, $("#spin_button").animate({
			backgroundColor: "rgba(210, 210, 210)"
		}, 500), $("#spin_button").html("LOADING"), $("#canvas").css({
			"z-index": "-1"
		});

		respin = ++respin > 3 ? 1 : respin;
		GG.api.wheel(buildWheelRequest).then(function (e) {
			if (gamesData = e, "empty" != e && "privacy" != e) {
				function t() {
					theWheel = new Winwheel({
						numSegments: sessionStorage.getItem("segments"),
						outerRadius: wheelSize,
						innerRadius: 0,
						textFontSize: 35,
						lineWidth: 5,
						strokeStyle: "white",
						textFillStyle: "white",
						dynamicImages: "true" == sessionStorage.getItem("dynamic"),
						segments: e.data,
						fillStyle: "rgba(40, 40, 40, 0.8)",
						alpha: 1,
						animation: {
							type: "spinToStop",
							easing: "Power2.easeInOut",
							spins: sessionStorage.getItem("spin") * sessionStorage.getItem("speed"),
							duration: sessionStorage.getItem("spin"),
							callbackFinished: "endWheel()",
							callbackAfter: "drawTriangle()"
						}
					}), drawTriangle(), "Chowder Magic" == sessionStorage.getItem("presetsName") ? (musIndex == musSrc.length && (musIndex = 0), soundManager.setup({
						onready: function () {
							soundManager.createSound({
								id: "chowd",
								url: "msc/chowd.mp3"
							}).play()
						}
					}), musIndex++) : "true" == sessionStorage.getItem("music") && (musIndex == musSrc.length && (musIndex = 0), soundManager.setup({
						onready: function () {
							soundManager.createSound({
								id: musSrc[musIndex],
								url: musSrc[musIndex],
								multiShot: !1,
								volume: 0,
								onfinish: function () {
									soundManager.play(musSrc[musIndex - 1]), timeFVars.soundFadingOut && clearTimeout(timeFVars.soundFadingOut)
								},
								onplay: function () {
									timeFVars.soundFadingIn = setInterval(sndFadeIn, 100)
								}
							}).play()
						}
					}), musIndex++, timeFVars.soundWheelEnding = setTimeout(function () {
						timeFVars.soundFadingOut = setInterval(sndFadeOut, 100)
					}, 1e3 * sessionStorage.getItem("spin") - 3e3)), theWheel.startAnimation(), wheelSpinning = !0
				}
				if (GG.pio) {
					var pioGames = e.data, pioSpin = Number(sessionStorage.getItem("spin")) || 10;
					GG.pio.emit("spin:start", { game: pioGames[Math.floor(Math.random() * pioGames.length)].name });
					if (respin === 3) GG.pio.emit("spin:retry", { respin: respin });
					// legacy pio.wheel(): halfway through the spin she sums up what is on the wheel
					clearTimeout(timeFVars.pioMiddle), timeFVars.pioMiddle = setTimeout(function () {
						GG.pio && GG.pio.emit("spin:middle", pioWheelSummary(pioGames));
					}, pioSpin / 2 * 1000);
				}
				wheelLoadData(e.data), "true" == sessionStorage.getItem("delay") ? timeFVars.startSpinRoll = setTimeout(function () {
					t()
				}, 2500) : t(); autoScrollList();
			} else soundManager.stopAll(), document.getElementById("spin_button").disabled = !1, $("#spin_button").animate({
				backgroundColor: "rgba(40, 40, 40)"
			}, 500), $("#spin_button").html("START<br>ROLL"), $("#canvas").css({
				"z-index": "0"
			}), wheelSpinning = !1, $("#" + e).modal({
				blurring: !0,
				transition: "fade",
				duration: 800
			}).modal("show");
			if (GG.pio && (e == "empty" || e == "privacy")) GG.pio.emit(e, {});
			$("#spin_button").html("ROLLING")
		}).catch(function (err) {
			console.error("[pgwheel] wheel request failed", err);
			document.getElementById("spin_button").disabled = !1, $("#spin_button").html("START<br>ROLL"), wheelSpinning = !1;
		});
	}
}

function sndFadeOut() {
	timeFVars.soundFadingIn && clearTimeout(timeFVars.soundFadingIn);
	var e = soundManager.getSoundById(musSrc[musIndex - 1]);
	0 < e.volume ? e.setVolume(e.volume - .25) : timeFVars.soundFadingOut && clearTimeout(timeFVars.soundFadingOut)
}

function sndFadeIn() {
	var e = soundManager.getSoundById(musSrc[musIndex - 1]);
	return 7 <= e.volume ? (clearInterval("fadingin"), void(timeFVars.soundFadingIn && clearTimeout(timeFVars.soundFadingIn))) : void e.setVolume(e.volume + .25)
}

// Context for the Pio mascot's phrases ({game}, {hours}, {score}, {year}, {developers}, {genre}, {otherGame} and
// the `when` conditions: tag, scoreMin/Max, priceMax, yearMax) — raw values come from game.pio (see gg-api.js).
function pioContext(game, all) {
	var p = game.pio || {}, others = (all || []).filter(function (g) { return g && g.name && g.name !== game.name; });
	return {
		game: game.name,
		genres: p.genres || [],
		genre: (p.genres || [])[0],
		tags: p.tags || [],
		platforms: p.platforms || [],
		developers: p.developers || undefined,
		score: game.final_score != null ? Number(game.final_score) : undefined,
		hours: game.final_time != null ? Number(game.final_time) : undefined,
		price: p.price != null ? p.price : undefined,
		year: p.year || undefined,
		otherGame: others.length ? others[Math.floor(Math.random() * others.length)].name : undefined
	};
}

// legacy pio.wheel() summary: the longest game on the wheel and how many "good" ones (GG score > 60) there are
function pioWheelSummary(games) {
	var good = 0, longest = 0, longestName = "";
	games.forEach(function (g) {
		if (Number(g.final_score) > 60) good++;
		if (Number(g.final_time) >= longest) longest = Number(g.final_time) || 0, longestName = g.name;
	});
	return { game: longestName || (games[0] && games[0].name), hours: longest, goodCount: good };
}

function endWheel() {
	soundManager.stopAll(), document.getElementById("spin_button").disabled = !1, $("#spin_button").animate({
		backgroundColor: "rgba(40, 40, 40)"
	}, 500), $("#spin_button").html("START<br>ROLL"), $("#canvas").css({
		"z-index": "0"
	}), theWheel.alpha = .1, winner = theWheel.getIndicatedSegment(), sessionStorage.setItem("preselectedwinner", winner), highlightGame(winner), scrollToHighlight(), $("#all" + getSegmentNum(winner)).parent().parent().addClass("winner-list-item"), wheelSpinning = !1, gamesData.winnerNum = theWheel.getIndicatedSegmentNumber(), gamesData.data.segments = theWheel.segments, gamesData.numOfSegments = sessionStorage.getItem("segments"), sessionStorage.setItem("gamesdata", JSON.stringify(gamesData)), $(".circular").unbind("mouseover");
	if (GG.pio && winner) GG.pio.emit("spin:end", pioContext(winner, gamesData.data));
}

function getSegmentNum(e) {
	var t;
	return theWheel.segments.forEach(function (n, s) {
		n == e && (t = s)
	}), t - 1
}

// Sets both game-char blocks' spans (ru-sized "#id" and default-sized "#id2" — see public/pages/wheel.html)
// so whichever one CSS shows for the current language is already populated.
function setBoth(id, html) {
	$("#" + id).html(html);
}

function populateAbout(e) {
	if ($('#allgames').val() && $('#allgames').val() != e.name) $('#allgames').dropdown('clear');
	$("#rimage").attr("src", e.segpic).css('background-image', 'url(\'' + e.segpic + '\')'), $("#rname").html(e.name), $("#gjname").val(e.name),
		setBoth("rdate", e.published_date ? e.published_date : "???"),
		setBoth("rrew", e.final_score ? e.final_score : "???"),
		$("#rsteamall").html(e.steam_reviews_all ? e.steam_reviews_all : "???"),
		$("#rsteamrecent").html(e.steam_reviews_recent ? e.steam_reviews_recent : "???"),
		setBoth("rggp", e.ggp ? e.ggp : "0"),
		setBoth("rdiff", e.gfq_difficulty ? e.gfq_difficulty : "???"),
		setBoth("rpub", e.publishers ? e.publishers : "???"),
		setBoth("rdev", e.developers ? e.developers : "???"),
		setBoth("rcat", e.categories ? e.categories : "???"),
		setBoth("rgenre", e.genres ? e.genres : "???"),
		setBoth("rtags", e.tags ? e.tags : "???"),
		setBoth("rplatfrom", e.platforms ? e.platforms : "???"),
		setBoth("rlang", e.languages ? e.languages : "???"),
		setBoth("rvoice", e.voiceovers ? e.voiceovers : "???"),
		setBoth("rowner", e.stsp_owners ? e.stsp_owners : "???"),
		setBoth("rgflength", e.final_time ? e.final_time : "???"),
		setBoth("rhlcomplete", e.hltb_complete ? e.hltb_complete : "???"),
		setBoth("rhlaverage", e.stsp_mdntime ? e.stsp_mdntime : "???"),
		$(".rwords").css("display", "initial"),
		$("#rval").html(0 == e.price_final ? "0 " + e.price_symbol : e.price_final / 100 + " " + e.price_symbol),
		e.discount && 0 != e.discount && $("#rval").html($("#rval").html() + " (" + e.price_discount / 100 + " " + e.price_symbol + " / -" + e.discount + "%)"),
		setBoth("rval", $("#rval").html()),
		$("#rbtn").attr("onclick", "window.open('" + (e.store_url ? e.store_url : "https://www.google.com/search?q=Buy+" + e.name) + "', '_blank')"),
		$("#rgfbtn").attr("onclick", "window.open('" + (e.gfq_url ? e.gfq_url : "https://gamefaqs.gamespot.com/search?game=" + e.name) + "', '_blank')"),
		(e.meta_is_opencritic
			? ($("#rmetabtn").attr("onclick", "window.open('" + (e.opencritic_url || "https://opencritic.com/search?criteria=" + e.name) + "', '_blank')"), $("#rmetabtn").text(GG.i18n.t("Check on OpenCritic")))
			: ($("#rmetabtn").attr("onclick", "window.open('" + (e.meta_url ? e.meta_url : "http://www.metacritic.com/search/game/" + e.name + "/results?plats[3]=1&search_type=advanced") + "', '_blank')"), $("#rmetabtn").text(GG.i18n.t("Check on Metacritic")))),
		$("#rigdbbtn").attr("onclick", "window.open('" + (e.igdb_url ? e.igdb_url : "https://www.igdb.com/") + "', '_blank')"),
		$("#rgogbtn").attr("onclick", "window.open('" + (e.gog_url ? e.gog_url : "https://www.gog.com/games?query=" + e.name) + "', '_blank')"),
		$("#rhltbbtn").attr("onclick", "window.open('" + (e.hltb_url ? e.hltb_url : "https://howlongtobeat.com/") + "', '_blank')"), $("#deskLabel").attr("onclick", "window.open('" + (e.store_url ? e.store_url : "https://www.google.com/search?q=Buy+" + e.name) + "', '_blank')"), $("#deskLabel .label").each(function (e, t) {
			$(t).hide()
		}), "Steam" == e.store_platform && $("#deskLabel div[store='steam']").show(), "GOG" == e.store_platform && $("#deskLabel div[store='gog']").show()
}

function highlightGame(e, t) {
	(t = void 0 !== t && t) ? (populateAbout(e), $("#aboutg").parent().transition("stop all").transition({
		animation: "horizontal fly right in",
		duration: 400,
		onComplete: function () {}
	}), calculateResponsiveOnResize()) : $("#aboutg").parent().transition("stop all").transition({
			animation: "horizontal fly left out",
			duration: 400,
			onComplete: function () {
				populateAbout(e), $("#aboutg").parent().transition("stop all").transition({
					animation: "horizontal fly right in",
					duration: 400,
					onComplete: function () {}
				})
			}
		}), textShowAnimate($("#rdesc"), e.description, 0, 0), triggerRefreh && ($("#full-glist .ui.item").hover(function () {
			$(this).find("a").attr("id") == "all" + getSegmentNum(highlitedSegment) || wheelSpinning || $(this).addClass("hover-list-item")
		}, function () {
			$(this).removeClass("hover-list-item")
		}), triggerRefreh = !1), e != winner && (winner.alpha = theWheel.alpha), highlitedSegment && (highlitedSegment.alpha = theWheel.alpha), alphaInterval && window.cancelAnimationFrame(alphaInterval),
		function t() {
			e.alpha += .07, theWheel.clearCanvas(), theWheel.drawSegments(), drawTriangle(), alphaInterval = requestAnimationFrame(t), 1 < e.alpha && window.cancelAnimationFrame(alphaInterval)
		}(), e != winner && (e.alpha = theWheel.alpha), t || (modedGame.removeClass("highlight-list-item"), (modedGame = $("#all" + getSegmentNum(e)).parent().parent()).addClass("highlight-list-item")), highlitedSegment = e
}

function changeText(e) {
	var t = document.createElement("div");
	return t.innerHTML = e, recurseDomChildren(t, !0), t.innerHTML.replace(/!!spfrnt!!/g, "<span>").replace(/!!spback!!/g, "</span>")
}

function recurseDomChildren(e, t) {
	e.childNodes && loopNodeChildren(e.childNodes, t)
}

function loopNodeChildren(e, t) {
	for (var n, s = 0; s < e.length; s++) addSpanToNode(n = e[s]), n.childNodes && recurseDomChildren(n, t)
}

function addSpanToNode(e) {
	if (3 == e.nodeType) {
		for (var t = e.data.split(" "), n = "", s = 0; s < t.length; s++) t[s] && (n += "!!spfrnt!!" + t[s] + "!!spback!! ");
		e.data = n
	}
}

function textShowAnimateFade(e, t, n, s) {
	timeFVars.textShowAnimate && clearTimeout(timeFVars.textShowAnimate), timeFVars.textShowAnimateFade && clearTimeout(timeFVars.textShowAnimateFade);
	var i = 0,
		a = e.html();
	e.empty(), e.append(changeText(a));
	for (var o = $("#" + e[0].id + " span:not(:has(*))"), r = o.length - 1; 0 <= r; r--) $(o[r]).delay(i * (800 / o.length)).fadeOut(100, function () {
		if ($(this).parents("#rdesc > *").length && $(this).is(":first-child")) {
			for (var e = $(this); e.parents("#rdesc > *").length && e.is(":first-child");) e = e.parent();
			e.remove()
		} else $(this).remove()
	}), i++;
	timeFVars.textShowAnimateFade = setTimeout(function () {
		e.empty(), textShowAnimate(e = [e], t, n, s)
	}, o.length * (800 / o.length) + 200)
}

function textShowAnimate(e, t, n, s) {
	if (Array.isArray(e)) {
		Array.isArray(t) || (t = [t]), Array.isArray(n) || (n = [n]);
		var i, a = $.parseHTML(t[s]),
			o = a[n[s]],
			r = 0,
			l = !1;
		n[s] < a.length ? (timeFVars.textShowAnimate && clearTimeout(timeFVars.textShowAnimate), timeFVars.textShowAnimateFade && clearTimeout(timeFVars.textShowAnimateFade), 3 == $(o)[0].nodeType ? (i = o.textContent, o.textContent = "", $(o).appendTo(e[s])) : 0 == $(o)[0].childElementCount ? (i = $(o).text(), $(o).empty().appendTo(e[s])) : (t.push($(o).html()), e.push($(o).empty().appendTo(e[s])), n.push(0), s++, l = !0), l ? textShowAnimate(e, t, n, s) : (e[s].append(o), cHeight = 0, timeFVars.textShowAnimate = setInterval(function () {
			o.textContent = i.substr(0, r), ++r > i.length && (clearTimeout(timeFVars.textShowAnimate), n[s]++, n[s] >= a.length && 0 != s && (n[--s]++, n.pop(), t.pop(), e.pop()), textShowAnimate(e, t, n, s))
		}, 5))) : 0 != s && (n[--s]++, n.pop(), t.pop(), e.pop(), textShowAnimate(e, t, n, s))
	} else textShowAnimateFade(e, t, n, s)
}

function showGame(e) {
	0 == wheelSpinning && winner && 0 == document.getElementById("spin_button").disabled && !$("#all" + e).parent().parent().hasClass("highlight-list-item") && (highlightGame(theWheel.segments[e + 1]), "Mobile" == screenVersion && $("#content-wrapper").stop().animate({
		scrollTop: $("#aboutg").parent()[0].offsetTop
	}, 1e3))
}

function scrollToHighlight() {
	glist.stop().animate({
		scrollTop: $(".highlight-list-item")[0].offsetTop - 20 > glist[0].scrollHeight - glist.height() ? glist[0].scrollHeight - glist.height() : $(".highlight-list-item")[0].offsetTop - 20
	}, 1e3), "Mobile" == screenVersion && $("#content-wrapper").stop().animate({
		scrollTop: $("#aboutg").parent()[0].offsetTop
	}, 1e3)
}

function autoScrollList() {
	glist.bind("scroll mousedown DOMMouseScroll mousewheel keyup touchstart", function(e) {
		if (e.which > 0 || e.type === "mousedown" || e.type === "mousewheel" || e.type === 'touchstart') {
			glist.stop().unbind('scroll mousedown DOMMouseScroll mousewheel keyup touchstart');
		}
	});

	glist.stop().animate({scrollTop:0}, 1000, 'swing', function() {
		glist.stop().animate({scrollTop:glist[0].scrollHeight}, (parseInt(sessionStorage.getItem("spin"))+((parseInt(sessionStorage.getItem("spin"))/10)*1.5))*1000, 'linear', function() {
			glist.off("scroll mousedown DOMMouseScroll mousewheel keyup touchstart");
		});
	});
}

function shuffle(a) {
    var j, x, i;
    for (i = a.length - 1; i > 0; i--) {
        j = Math.floor(Math.random() * (i + 1));
        x = a[i];
        a[i] = a[j];
        a[j] = x;
    }
    return a;
}

// Render the profile block (avatar/name/emoji/login-logout) from GG.session.user — legacy rendered
// this server-side from $_SESSION['steam_detailed'] (see legacy/ajax/pages/wheel.php ~line 228-271).
function renderProfile() {
	var session = window.GG && GG.session;
	var user = session && session.user;
	if (user) {
		$("#profile-avatar").attr("src", user.avatar || "/img/avatar.jpg");
		$("#profile-name").text(user.name || "Neptunia");
		$("#emoji").text(GG.levelEmoji(user.level));
		$("#loginSteam").hide();
		$("#logoutSteam").show();
	} else {
		$("#profile-avatar").attr("src", "/img/avatar.jpg");
		$("#profile-name").text("Neptunia");
		$("#emoji").text("🦈");
		$("#loginSteam").show();
		$("#logoutSteam").hide();
	}
}

// Shows the game-char block sized for the current language (legacy: PHP `if ($_SESSION['language']
// == "ru")` picked one of two static blocks server-side — see public/pages/wheel.html) and the
// matching intro paragraph in the description panel.
function applyLanguageLayout() {
	var isRu = __language === "ru";
	$(".game-char").css("height", isRu ? "273px" : "290px");
	// The static sample card in the fragment is the legacy RU one; legacy's non-RU block carried English values.
	if (!isRu) $("#aboutg [data-en]").each(function () { $(this).text($(this).attr("data-en")); });
	$(isRu ? "#intro-en" : "#intro-ru").remove();
	$(isRu ? "#intro-ru" : "#intro-en").css("display", "");
}

// Called synchronously on purpose: jQuery 3 runs $(document).ready callbacks asynchronously even when the
// DOM is already loaded, which would reset .game-char's height AFTER pgindex.js calculated it.
applyLanguageLayout();
renderProfile();

window.matchMedia("(display-mode: standalone)").matches || (document.getElementById("mrbls").style.display = "block");

var wheelSpinning = !1, theWheel = null, wheelSize = 250, gamesData = null,
	winner = null, highlitedSegment = null, alphaInterval = null, modedGame = $("#all0").parent().parent(),
	triggerRefreh = !0,
	respin = 0, donationreminder = !1, cHeight = 0, canvas = document.getElementById("canvas"),
	session = !!sessionStorage.getItem("gamesdata"), glist = $("#full-glist .ui.divided.items");

var musSrc = ["/msc/theme1.mp3", "/msc/theme3.mp3", "/msc/theme4.mp3", "/msc/theme6.mp3"];

shuffle(musSrc);

// Swap in the live rotation from the server (files dropped into public/msc/ on the server, see that
// folder's .music note) once it resolves — keeps the hardcoded list above as the fallback for as
// long as the request is pending, fails, or returns nothing. Fire-and-forget: never blocks or breaks
// the spin (musSrc is only read when a spin actually starts, further down this file).
GG.api.music().then(function (tracks) {
	if (tracks && tracks.length) musSrc = tracks, shuffle(musSrc);
}).catch(function (err) {
	console.error("[pgwheel] music list fetch failed", err);
});

theWheel && theWheel.stopAnimation(!1);
sessionStorage.getItem("smart") || sessionStorage.setItem("smart", !1);
// "Use CIS region" (owner's rule, "Goal B"): off by default, and it only ever concerns Russian
// (see cisPricesEnabled() above) -- default it to false, not true.
sessionStorage.getItem("backupRegion") || sessionStorage.setItem("backupRegion", !1);
sessionStorage.getItem("empty") || sessionStorage.setItem("empty", !0);
sessionStorage.getItem("steam") || sessionStorage.setItem("steam", !1);
sessionStorage.getItem("music") || sessionStorage.setItem("music", !0);
sessionStorage.getItem("magic") || sessionStorage.setItem("magic", !1);
sessionStorage.getItem("dynamic") || sessionStorage.setItem("dynamic", !0);
sessionStorage.getItem("delay") || sessionStorage.setItem("delay", !1);
sessionStorage.getItem("price") || sessionStorage.setItem("price", "0,5000");
sessionStorage.getItem("score") || sessionStorage.setItem("score", "0,100");
sessionStorage.getItem("length") || sessionStorage.setItem("length", "0,300");
sessionStorage.getItem("spin") || sessionStorage.setItem("spin", '10');
sessionStorage.getItem("speed") || sessionStorage.setItem("speed", "0.6");
sessionStorage.getItem("segments") || sessionStorage.setItem("segments", '12');
sessionStorage.getItem("publishers") || sessionStorage.setItem("publishers", "");
sessionStorage.getItem("publishersno") || sessionStorage.setItem("publishersno", "");
sessionStorage.getItem("developers") || sessionStorage.setItem("developers", "");
sessionStorage.getItem("developersno") || sessionStorage.setItem("developersno", "");
sessionStorage.getItem("categories") || sessionStorage.setItem("categories", "");
sessionStorage.getItem("categoriesno") || sessionStorage.setItem("categoriesno", "");
sessionStorage.getItem("genres") || sessionStorage.setItem("genres", "");
sessionStorage.getItem("genresno") || sessionStorage.setItem("genresno", "");
sessionStorage.getItem("gfq_difficulty") || sessionStorage.setItem("gfq_difficulty", "");
sessionStorage.getItem("gfq_difficultyno") || sessionStorage.setItem("gfq_difficultyno", "");
sessionStorage.getItem("languages") || sessionStorage.setItem("languages", "");
sessionStorage.getItem("languagesno") || sessionStorage.setItem("languagesno", "");
sessionStorage.getItem("voiceovers") || sessionStorage.setItem("voiceovers", "");
sessionStorage.getItem("voiceoversno") || sessionStorage.setItem("voiceoversno", "");
sessionStorage.getItem("tags") || sessionStorage.setItem("tags", "");
sessionStorage.getItem("tagsno") || sessionStorage.setItem("tagsno", "");

$("#mrbls").click(function () {
	$("#mrbls").prop("disabled", !0);
	GG.api.marbles(buildWheelRequest).then(function (blob) {
		var a = document.createElement("a");
		a.href = window.URL.createObjectURL(blob), a.download = "marbles.csv", document.body.appendChild(a), a.click(), document.body.removeChild(a);
		$("#mrbls").prop("disabled", !1);
	}).catch(function (err) {
		console.error("[pgwheel] marbles request failed", err);
		$("#mrbls").prop("disabled", !1);
	});
	if (GG.pio) GG.pio.emit("hover:marbles", {});
});

$("#rndgm").click(function () {
	$("#rndgm").prop("disabled", !0);
	GG.api.random(__language, cisPricesEnabled()).then(function (game) {
		if (game != "empty" && game != "privacy") {
			$("#aboutg").parent().transition("stop all").transition({
				animation: "horizontal fly left out",
				duration: 400,
				onComplete: function () {
					populateAbout(game);
					$("#rimage").off().hide().on("load", function () {
						$("#rimage").off().show();
						$("#aboutg").parent().transition("stop all").transition({
							animation: "horizontal fly right in",
							duration: 400,
							onComplete: function () {}
						});
						textShowAnimate($("#rdesc"), game.description, 0, 0), calculateResponsiveOnResize(), modedGame.removeClass("highlight-list-item"), highlitedSegment && (highlitedSegment.alpha = theWheel.alpha, highlitedSegment = null, preDrawWheel())
						timeFVars.randomGameButtonDisable = setTimeout(function () {
							$("#rndgm").prop("disabled", !1);
						}, 5000);
					})
				}
			});
		} else {
			$("#rndgm").prop("disabled", !1);
		}
	}).catch(function (err) {
		console.error("[pgwheel] random request failed", err);
		$("#rndgm").prop("disabled", !1);
	});
});

for (x = 0; x <= sessionStorage.getItem("segments") - 1; x++)
	$("#all" + x).parent().parent().css("display", "flex");

setInterval(function () { 0 > --respin && (respin = 0) }, 18e4);

soundManager.setup({
  url: '',
  flashVersion: 9,
  preferFlash: false,
  defaultOptions: {
    volume: 2
  }
});

$("#canvas").mousemove(function (e) {
	var t = theWheel.getSegmentAt(e.clientX, e.clientY);
	canvas.style.cursor = t && 0 == wheelSpinning && 0 == document.getElementById("spin_button").disabled && t != highlitedSegment && winner ? "pointer" : ""
}), canvas.onclick = function (e) {
	var t = theWheel.getSegmentAt(e.clientX, e.clientY);
	t && 0 == wheelSpinning && 0 == document.getElementById("spin_button").disabled && t != highlitedSegment && winner && (highlightGame(t), scrollToHighlight())
}, $("#aboutg img").on("load", function () {
	theWheel.createPatterns(), drawTriangle()
}), $(".ui.tiny.image img").on("load", function () {
	"false" == sessionStorage.getItem("delay") ? $(this).hasClass("transition") && !$(this).hasClass("in") && $(this).transition({
		animation: "fly down in",
		duration: 1100
	}) : !$(this).hasClass("visible") && !$(this).hasClass("in") && $(this).parent().parent().find(".middle.aligned.content").hasClass("visible") && $(this).transition({
		animation: "fly down in",
		duration: 500
	}), preDrawWheel()
});

// Pio (Neptune): mount into the legacy in-DOM position (.pio-container under the wheel canvas — see
// public/pages/wheel.html and public/pio/pio.css's ".column .pio-container" override) instead of the
// module's default fixed bottom-right floating widget. Destroyed on page change (pgindex.js).
(function mountPio() {
	function create() {
		var container = document.querySelector(".pio-container");
		if (!container || !window.GGPio) return;
		GG.pio = GGPio.createPio({
			container: container,
			modelUrl: "pio/models/neptune/model.json",
			lang: __language,
			dialogues: "pio/dialogues",
		});
	}
	if (window.GGPio) create();
	else document.addEventListener("ggpio:ready", create, { once: true });
})();

var pioevents = function () {
	var e = !1;
	$(".circular").mouseenter(function () {
		timeFVars.spintimer = setTimeout(function () {
			e || (GG.pio && GG.pio.emit("hover:spin", {})), e = !0
		}, 200)
	}).mouseleave(function () {
		clearTimeout(timeFVars.spintimer)
	});
	var t = !1;
	$("#rndgm").mouseenter(function () {
		timeFVars.randomgametimer = setTimeout(function () {
			t || (GG.pio && GG.pio.emit("hover:randomGame", {})), t = !0
		}, 500)
	}).mouseleave(function () {
		clearTimeout(timeFVars.randomgametimer)
	});
	var n = !1;
	$("#mrbls").mouseenter(function () {
		timeFVars.marblestimer = setTimeout(function () {
			n || (GG.pio && GG.pio.emit("hover:marbles", {})), n = !0
		}, 500)
	}).mouseleave(function () {
		clearTimeout(timeFVars.marblestimer)
	});
	var s = !1;
	$(".ggptt").mouseenter(function () {
		timeFVars.ggpointstimer = setTimeout(function () {
			s || (GG.pio && GG.pio.emit("hover:ggPoints", {})), s = !0
		}, 300)
	}).mouseleave(function () {
		clearTimeout(timeFVars.ggpointstimer)
	});
	var i = !1;
	$("#profile").mouseenter(function () {
		timeFVars.profiletimer = setTimeout(function () {
			i || (GG.pio && GG.pio.emit("hover:profile", {})), i = !0
		}, 300)
	}).mouseleave(function () {
		clearTimeout(timeFVars.profiletimer)
	});
	var a = !1;
	$("#searchtt").mouseenter(function () {
		timeFVars.searchbartimer = setTimeout(function () {
			a || (GG.pio && GG.pio.emit("hover:search", {})), a = !0
		}, 500)
	}).mouseleave(function () {
		clearTimeout(timeFVars.searchbartimer)
	});
	var o = !1;
	$("#rgogbtn").mouseenter(function () {
		timeFVars.gogtimer = setTimeout(function () {
			o || (GG.pio && GG.pio.emit("hover:gabestore", {})), o = !0
		}, 500)
	}).mouseleave(function () {
		clearTimeout(timeFVars.gogtimer)
	});
}; 1 == session ? pioevents() : setTimeout(pioevents, 6e3);

$("#allgames").dropdown({
	placeholder: $("#allgames").attr("data-placeholder"),
	saveRemoteData: !1,
	preserveHTML: !1,
	forceSelection: false,
	clearable: !0,
	filterRemoteData: false, // the server already filtered and ranked the results
	fullTextSearch: 'exact',
	selectOnKeydown: false,
	allowTab: false,
	apiSettings: {
		url: '/api/games/search?q={query}&lang=' + __language,
		cache: false,
		onResponse: function (result) {
			var data = [];
			if (result && result.success !== false) {
				// Semantic hands onResponse a deep COPY of the JSON: a top-level array arrives as {"0":…,"1":…}.
				$.each(result.results || result, function (i, game) {
					if (!game || game.id == null) return;
					data.push({ name: game.name, value: String(game.id), text: game.name });
				});
			}
			return {
				success: true,
				results: data
			};
		}
	},
	onChange: function (e) {
		if (e) {
			GG.api.game(e, __language).then(function (game) {
				$("#aboutg").parent().transition("stop all").transition({
					animation: "horizontal fly left out",
					duration: 400,
					onComplete: function () {
						populateAbout(game);
						$("#rimage").off().hide().on("load", function () {
							$("#rimage").off().show();
							$("#aboutg").parent().transition("stop all").transition({
								animation: "horizontal fly right in",
								duration: 400,
								onComplete: function () {}
							});
							textShowAnimate($("#rdesc"), game.description, 0, 0), calculateResponsiveOnResize(), modedGame.removeClass("highlight-list-item"), highlitedSegment && (highlitedSegment.alpha = theWheel.alpha, highlitedSegment = null, preDrawWheel())
						})
					}
				});
			}).catch(function (err) {
				console.error("[pgwheel] game lookup failed", err);
			});
		}
	},
	message: {
		addResult: __text_result,
		count: __text_count,
		maxSelections: __text_selections,
		noResults: __text_results
	}
});

window.matchMedia("(display-mode: standalone)").matches && (document.getElementById("rigdbbtn").style.fontSize = "16px", document.getElementById("rgfbtn").style.fontSize = "16px", document.getElementById("rhltbbtn").style.fontSize = "16px", document.getElementById("rmetabtn").style.fontSize = "16px", document.getElementById("rgogbtn").style.fontSize = "16px", document.getElementById("rbtn").style.fontSize = "16px");

// Marquee3k.init() + $(".marquee3k__copy").css(...) removed: no ".marquee3k" element exists in any page
// fragment (public/pages/*.html, public/index.html), so both calls were already dead code; marquee3k.js
// and its <script> tag were dropped as part of the library upgrade cleanup (see js/plugins/README.md).

$("#loginSteam").click(function () { location.href = "/api/auth/steam"; });
$("#logoutSteam").click(function () {
	GG.api.post("/api/auth/logout").then(function () { location.reload(); }).catch(function () { location.reload(); });
});
