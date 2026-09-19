// pgindex.js — page router / responsive layout (ported from legacy/js/pgindex.js).
//
// Deviations from legacy (data-layer swap only, not a redesign — see the port task):
//   - loadAjaxPage() fetches "pages/<page>.html?v=..." (static fragments) instead of
//     "ajax/pages/<page>.php" + location.search (no PHP left to receive a query string).
//   - GG.i18n.apply() runs on the freshly injected fragment right after $("#content").html(e) and
//     BEFORE the responsive calculations (legacy had nothing to apply here: strings were already
//     rendered server-side).
//   - Service worker registers "./sw.js" (legacy: "./worker.js").
var mainRequest, musIndex = Math.floor(5 * Math.random()) + 0,
	timeFVars = {},
	currentPage = "wheel",
	screenVersion = "PC",
	reroll = false,
	// Below this width the wheel/settings grids stack to a single column (public/css/layout.css);
	// screenVersion must switch to "Mobile" at the same width so calculateResponsiveOnResize()/
	// calculateLeftHeight()/calculateRightHeight() stop trying to size two side-by-side columns.
	// Was 768 (phones only) before the 768-1023px range also got the stacked layout.
	MOBILE_BREAKPOINT = 1024;

function loadAjaxPage(e) {
	$.each(timeFVars, function (b) {
		clearTimeout(timeFVars[b])
	});
	if (typeof(theWheel) !== 'undefined' && theWheel) theWheel.stopAnimation(false);
	if (window.GG && GG.pio && GG.pio.destroy) { GG.pio.destroy(); GG.pio = null; }
	mainRequest && mainRequest.abort(), void 0 !== e && "#undefined" != e || (e = "wheel");
	var a = "#" == e[0] ? e.substr(1) : e;
	if (a !== "wheel" && a !== "settings") a = "wheel";
	window.stop();
	currentPage = a, $(".header-nav a").removeClass("active").addClass("scrollzer-locked"), $("." + a + "-link").addClass("active"), $("#content-loading").dimmer({
		closable: false
	}).dimmer("show"), soundManager.stopAll(), mainRequest = $.ajax({
		url: "pages/" + a + ".html?v=" + (window.GG ? GG.version : "dev"),
		success: function (e) {
			// Translate the fragment BEFORE it is injected: $.html() runs the fragment's trailing
			// <script src="js/pg*.js"> synchronously, and those scripts read translated text/attributes
			// (dropdown placeholders etc.) exactly like they read PHP-rendered markup in legacy.
			if (window.GG && GG.i18n) {
				var doc = new DOMParser().parseFromString(e, "text/html");
				GG.i18n.apply(doc.body);
				e = doc.body.innerHTML;
			}
			$("#content").html(e);
			checkScreenType(), calculateResponsiveOnLoad(), calculateResponsiveOnResize(), alignFooter(), $("#content-loading").dimmer({
				closable: false
			}).dimmer("hide")
		},
		error: function (e, a, n) {
			$("#content").html(""), $("#content-loading").dimmer({
				closable: false
			}).dimmer("hide")
		}
	})
}

// Footer text lines up with the outer edges of the page's cards (the columns are sized from the window width in
// resizeWheel(), so this cannot be a static CSS offset). Not part of legacy - the owner asked for it.
function alignFooter() {
	var credits = document.getElementById("footer-credits"), links = document.getElementById("footer-links");
	if (!credits || !links) return;
	var left = Infinity, right = -Infinity;
	$("#content .ui.segments:visible, #content .ui.segment:visible").each(function () {
		var b = this.getBoundingClientRect();
		if (b.width < 100 || $(this).parents(".ui.segments").length) return;
		if ($(this).hasClass("vertical")) return;
		left = Math.min(left, b.left), right = Math.max(right, b.right);
	});
	var creditsBox = credits.firstElementChild, linksBox = links.firstElementChild;
	creditsBox.style.position = linksBox.style.position = "relative";
	creditsBox.style.left = linksBox.style.left = "0px";
	if (left === Infinity) return;
	// full-width panels (settings page) reach the window edge: keep the text 14px off it, like the wheel page cards
	left = Math.max(left, 14), right = Math.min(right, document.documentElement.clientWidth - 14);
	creditsBox.style.left = (left - creditsBox.getBoundingClientRect().left) + "px";
	linksBox.style.left = (right - linksBox.getBoundingClientRect().right) + "px";
}

function calculateResponsiveOnLoad() {
    if (currentPage.indexOf('wheel') > -1) {
    	if (!theWheel)
    		reInitWheel(wheelSize);
    	else
    		reInitWheel(wheelSize, true);
    	resizeWheel();
    }
}

function calculateResponsiveOnResize() {
    if (currentPage.indexOf('wheel') > -1) {
    	resizeWheel();
		if (screenVersion == 'PC') {
	    	if (0 == $("#rimage")[0].complete) {
		    	$("#rimage").off().on("load", function() {
					calculateLeftHeight();
					calculateRightHeight();
				});
		    } else {
				calculateLeftHeight();
				calculateRightHeight();
		    }
    	} else {
    		$("#descWrapper").height(300);
	    	$("#gListWrapper").height(300);
	    	$(".game-char").css("max-height", "unset");
	    	$(".game-char").height(Math.max($(window).height() - 555, 180));
	    	$("#detailsWrapper").css("height", "unset");
    	}
    }
}

function resizeWheel() {
	if (theWheel) {
		// Mobile mode used to only run <768px, where "window width - 7" stays reasonable. Now that
		// it also runs up to 1023px, cap it at 690px (same cap as the PC formula) so the wheel
		// doesn't become absurdly large around 1000px; #canvas already centers itself (margin:auto
		// in main.css) within its now-full-width column (public/css/layout.css).
		wheelHeight = ((screenVersion == 'Mobile') ? Math.min(690, $(window).width() - 7) : Math.min(690, Math.max($(window).width() / 3.264705882352941, 310)));
		wheelWidth = ((screenVersion == 'Mobile') ? Math.min(690, $(window).width() - 7) : Math.min(690, Math.max($(window).width() / 3.264705882352941, 310)));
		wheelSize = wheelWidth / 2;
		$("#spin_button").css({
	        bottom: wheelWidth / 2 + wheelWidth / 5 / 2 + 10 + "px",
	        width: wheelWidth / 5 + "px",
	        height: wheelWidth / 5 + "px",
	        "font-size": wheelWidth / 39.23076923076923 + "px",
	        "border-width": wheelSize / 60 + "px",
	        "line-height": wheelSize * 0.06 + "px"
		});
		$("#canvas").parent().css({
	        "height": wheelHeight + 33,
	        "min-width": wheelWidth + 48
		});
		$("#canvas").attr({
	        height: wheelHeight + 20,
	        width: wheelWidth + 15
		});
		theWheel.outerRadius = wheelWidth / 2;
		theWheel.centerX = wheelWidth / 2 + 5;
		theWheel.centerY = wheelHeight / 2 + 10;
		theWheel.lineWidth = wheelSize / 60;
		theWheel.createPatterns();
		theWheel.drawSegments();
		theWheel.draw();
		drawTriangle();
	}
}

function calculateLeftHeight() {
	if (screenVersion == 'PC') {
		var e = $(".game-char").css(["top", "overflow", "height"]);
	    $(".game-char").css({
	        top: 0,
	        height: 0,
	        overflow: "scroll"
	    });
	    var h = $(".game-char").prop("scrollHeight");
	    $(".game-char").css(e);
	    $(".game-char").css("max-height", h + "px");
	    $(".game-char").height($('#content-wrapper').height() - $(".game-char").position().top - $("#sourceButtons").height() - 107);
		$("#rimage").css("min-height", 'unset');
	}
}

function calculateRightHeight() {
	if (screenVersion == 'PC') {
		var e = $("#gListWrapper").css(["top", "overflow", "height"]);
	    $("#gListWrapper").css({
	        top: 0,
	        height: 0,
	        overflow: "scroll"
	    });
	    var h = $("#gListWrapper").prop("scrollHeight");
	    $("#gListWrapper").css(e);
	    $("#descWrapper").height(Math.min($(window).height() / 2 - 255, 600));
	    $("#gListWrapper").height(Math.min($(window).height() / 2 - 275, h));
	}
}

function checkScreenType() {
	if ($(window).width() < MOBILE_BREAKPOINT)
	    screenVersion = "Mobile";
	else
	    screenVersion = "PC";
}

$('body').on('click', '#frostmouse', function () {
	$('#content-bg').html('<div id="bg" style="background-color: #009933;"></div>');
	$("#rimage").css("opacity", '0');
	$("#rname").html('');
	$(".highlight-list-item").removeClass("highlight-list-item");
	$(".winner-list-item").removeClass("winner-list-item");
	$(".rwords").css("display", 'none');
	$("#rdesc").html('');
	["", "2"].forEach(function (suf) {
		$("#rdate" + suf).html('');
		$("#rrew" + suf).html('');
		$("#rdiff" + suf).html('');
		$("#rpub" + suf).html('');
		$("#rdev" + suf).html('');
		$("#rcat" + suf).html('');
		$("#rgenre" + suf).html('');
		$("#rtags" + suf).html('');
		$("#rplatfrom" + suf).html('');
		$("#rlang" + suf).html('');
		$("#rvoice" + suf).html('');
		$("#rowner" + suf).html('');
		$("#rgflength" + suf).html('');
		$("#rhlcomplete" + suf).html('');
		$("#rval" + suf).html('');
	});
	$("#gListWrapper .image img").css("opacity", '0');
	$("#gListWrapper .image img").css("border", 'none');
	$("#gListWrapper .gtext").html('');
	$("#rbtn").attr("onclick", "window.open('" + ("https://www.google.com/search?q=Buy+" + '') + "', '_blank')");
	$("#rgfbtn").attr("onclick", "window.open('" + ("https://gamefaqs.gamespot.com/search?game=" + '') + "', '_blank')");
	$("#rmetabtn").attr("onclick", "window.open('" + ("http://www.metacritic.com/search/game/" + '' + "/results?plats[3]=1&search_type=advanced") + "', '_blank')");
	$("#rhltbbtn").attr("onclick", "window.open('" + ("https://howlongtobeat.com/") + "', '_blank')");
	$("#deskLabel").attr("onclick", "window.open('" + ("https://www.google.com/search?q=Buy+" + '') + "', '_blank')");
	$("#deskLabel .label").each(function (i, obj) {
		$(obj).hide()
	});
});

window.location.hash.substr(1) && "." != window.location.hash.substr(1)[1] ? ($('.' + window.location.hash.substr(1) + "-link").addClass("active"), loadAjaxPage(window.location.hash.substr(1))) : ($(".wheel-link").addClass("active"), loadAjaxPage("wheel")), $(".header-nav a").on("click", function (e) {
	var a = $(this).attr("href");
	if (a.charAt(0) !== "#") return; // e.g. the Admin nav item links to /admin.html, not a hash route
	e.preventDefault(), location.href = a, (window.navigator.userAgent.indexOf("Trident") > 0 || window.navigator.userAgent.indexOf("MSIE ") > 0) && loadAjaxPage(location.hash)
}), $(window).bind("hashchange", function (e) {
	loadAjaxPage("#" + window.location.href.split("#")[1])
}), "serviceWorker" in navigator && navigator.serviceWorker.register("./sw.js").then(() => navigator.serviceWorker.ready.then(e => {
	e.sync && e.sync.register && e.sync.register("syncdata")
})).catch(e => console.log(e));


window.canUse = function (p) {
	if (!window._canUse)
		window._canUse = document.createElement("div");
	var e = window._canUse.style,
		up = p.charAt(0).toUpperCase() + p.slice(1);
	return p in e || "Moz" + up in e || "Webkit" + up in e || "O" + up in e || "ms" + up in e
};

var $bgs = [];
(function () {
	function t(t) {
		this.el = t;
		for (var n = t.className.replace(/^\s+|\s+$/g, "").split(/\s+/), i = 0; i < n.length; i++)
			e.call(this, n[i])
	}

	function n(t, n, i) {
		Object.defineProperty ? Object.defineProperty(t, n, {
			get: i
		}) : t.__defineGetter__(n, i)
	}
	if (!("undefined" == typeof window.Element || "classList" in document.documentElement)) {
		var i = Array.prototype,
			e = i.push,
			s = i.splice,
			o = i.join;
		t.prototype = {
			add: function (t) {
				this.contains(t) || (e.call(this, t), this.el.className = this.toString())
			},
			contains: function (t) {
				return -1 != this.el.className.indexOf(t)
			},
			item: function (t) {
				return this[t] || null
			},
			remove: function (t) {
				if (this.contains(t)) {
					for (var n = 0; n < this.length && this[n] != t; n++);
					s.call(this, n, 1), this.el.className = this.toString()
				}
			},
			toString: function () {
				return o.call(this, " ")
			},
			toggle: function (t) {
				return this.contains(t) ? this.remove(t) : this.add(t), this.contains(t)
			}
		}, window.DOMTokenList = t, n(Element.prototype, "classList", function () {
			return new t(this)
		})
	}

	var $body = document.getElementById('content-bg');

	var settings = {
		images: {
			'img/dynamic_backgrounds/15.jpg': 'center',
			'img/dynamic_backgrounds/16.jpg': 'center',
			'img/dynamic_backgrounds/17.jpg': 'center',
			'img/dynamic_backgrounds/18.jpg': 'center',
		},
		delay: 15000
	};
	var pos = 0,
		lastPos = 0,
		changePos = 0,
		$wrapper, $bg, k, v;
	$wrapper = document.createElement('div');
	$wrapper.id = 'bg';
	$body.appendChild($wrapper);
	for (k in settings.images) {
		$bg = document.createElement('div');
		$bg.style.backgroundImage = 'url("' + k + '")';
		$bg.style.backgroundPosition = settings.images[k];
		$wrapper.appendChild($bg);
		$bgs.push($bg);
	}
	$bgs[pos].classList.add('visible');
	$bgs[pos].classList.add('top');
	if ($bgs.length == 1 || !canUse('transition'))
		return;
	setInterval(function () {
		lastPos = pos;
		pos++;
		if (pos >= $bgs.length)
			pos = 0;
		changePos = pos + 1;
		if (changePos >= $bgs.length)
			changePos = 0;
		$bgs[lastPos].classList.remove('top');
		$bgs[pos].classList.add('visible');
		$bgs[pos].classList.add('top');
		setTimeout(function () {
			$bgs[lastPos].classList.remove('visible');
		}, settings.delay / 2);
	}, settings.delay);
})();

$(window).resize(function() {
	checkScreenType();
    calculateResponsiveOnResize();
	alignFooter();
});
