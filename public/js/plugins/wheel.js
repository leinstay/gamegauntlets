// Wheel plugin — compact rewrite of the site's customised Winwheel.js 2.x fork (was 30 KB minified + 28 KB GSAP
// TweenLite). Classic script, no dependencies; defines the global constructor `Winwheel` with only the API that
// pgwheel.js / pgindex.js use. Drawing is identical to the old plugin call-for-call — proven by the differential
// test tests/frontend/wheel-plugin.test.js against the old files kept in tests/fixtures/frontend/legacy-wheel/.
//
// Things that look odd but are kept on purpose:
//   - every wedge is filled twice: plain `fillStyle` first (also the look of a missing cover), then the cover image
//     as a canvas pattern placed with translate/rotate/scale around the second fill();
//   - `dynamicImages` picks between size-aware cover placement and the fixed placement of the placeholder wheel;
//   - the pointer is always at the top (angle 0).
// Dropped: segment text, image-mode wheels, pins, add/deleteSegment, pause/resume, spinOngoing/spinAndBack,
// anti-clockwise. The spin is a requestAnimationFrame tween (setTimeout while the tab is hidden) with GSAP's
// Power2/Power4 ease formulas; callbacks may be functions or legacy strings like "endWheel()".
(function () {
	'use strict';

	// Matches GSAP TweenLite's "PowerN"/"Linear" eases this site actually uses (see the plugin's old
	// computeAnimation()/registered eases — GSAP's "Power2" is a cubic, "Power4" a quintic).
	var EASE = {
		'Power2.easeOut': function (t) { return 1 - Math.pow(1 - t, 3); },
		'Power2.easeInOut': function (t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; },
		'Power4.easeOut': function (t) { return 1 - Math.pow(1 - t, 5); },
		'Linear.easeNone': function (t) { return t; }
	};

	// Animation callbacks were `eval()`d by the old plugin (site passes them as strings like
	// "endWheel()"); kept working the same way for strings, plus plain functions.
	function runCallback(callback) {
		if (typeof callback === 'function') callback();
		else if (typeof callback === 'string' && callback) Function(callback)();
	}

	// A segment is mostly a plain data holder: startAngle/endAngle are computed by
	// updateSegmentSizes(); everything else (name, segpic, alpha, ...) is copied straight from
	// whatever object the caller passed in — on this site that's the game object returned by the
	// API, plus the optional per-segment `alpha` override used to dim/highlight one wedge without
	// touching the wheel's global alpha.
	function Segment(source) {
		this.startAngle = 0;
		this.endAngle = 0;
		this.size = null;
		this.alpha = null;
		this.fillStyle = null;
		this.strokeStyle = null;
		this.lineWidth = null;
		if (source) {
			for (var key in source) {
				if (Object.prototype.hasOwnProperty.call(source, key)) this[key] = source[key];
			}
		}
	}

	// Only "spinToStop" is implemented — the only animation type any call site uses.
	function Animation(options) {
		options = options || {};
		this.easing = options.easing != null ? options.easing : 'Power4.easeOut';
		this.duration = options.duration != null ? options.duration : 10; // seconds
		this.spins = options.spins != null ? options.spins : 5;
		this.stopAngle = options.stopAngle != null ? options.stopAngle : null;
		this.callbackFinished = options.callbackFinished != null ? options.callbackFinished : null;
		this.callbackAfter = options.callbackAfter != null ? options.callbackAfter : null;
	}

	// Resolves spins/stopAngle into the absolute target value for `rotationAngle`. `stopAngle` is
	// "which angle should end up under the (fixed, top) pointer"; since the wheel always spins
	// clockwise here, landing that angle under the pointer means rotating by 360-stopAngle (plus
	// whole spins). Matches the old plugin's computeAnimation() for spinToStop/clockwise exactly.
	Animation.prototype.computeTarget = function () {
		this._stopAngle = this.stopAngle == null ? Math.floor(Math.random() * 359) : 360 - this.stopAngle;
		this.propertyValue = 360 * this.spins + this._stopAngle;
		return this.propertyValue;
	};

	function Winwheel(options) {
		options = options || {};

		this.numSegments = Number(options.numSegments) || 1;
		this.innerRadius = options.innerRadius != null ? options.innerRadius : 0;
		this.lineWidth = options.lineWidth != null ? options.lineWidth : 1;
		this.strokeStyle = options.strokeStyle != null ? options.strokeStyle : 'black';
		this.fillStyle = options.fillStyle != null ? options.fillStyle : 'rgba(40, 40, 40, 0.2)';
		// Accepted for API compatibility with every call site, but never used: see the file header —
		// segment text is never actually drawn on this site.
		this.textFontSize = options.textFontSize != null ? options.textFontSize : 20;
		this.textFillStyle = options.textFillStyle != null ? options.textFillStyle : 'black';
		this.alpha = options.alpha != null ? options.alpha : 1;
		this.dynamicImages = options.dynamicImages != null ? options.dynamicImages : true;
		this.rotationAngle = 0;

		this.canvas = (typeof document !== 'undefined') ? document.getElementById('canvas') : null;
		this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
		this.centerX = this.canvas ? this.canvas.width / 2 : 0;
		this.centerY = this.canvas ? this.canvas.height / 2 : 0;
		if (options.outerRadius != null) {
			this.outerRadius = options.outerRadius;
		} else if (this.canvas) {
			this.outerRadius = (this.canvas.width < this.canvas.height ? this.canvas.width / 2 : this.canvas.height / 2) - this.lineWidth;
		} else {
			this.outerRadius = 0;
		}

		// 1-based, like the old plugin: segments[0] is unused (kept `null`, not a hole) so `.length`
		// and `.forEach` behave the same as before for code that iterates theWheel.segments directly
		// (pgwheel.js's getSegmentNum()).
		this.segments = [null];
		for (var i = 1; i <= this.numSegments; i++) {
			this.segments[i] = new Segment(options.segments && options.segments[i - 1]);
		}
		this.updateSegmentSizes();

		this.animation = new Animation(options.animation);

		this._patterns = []; // rebuilt by createPatterns(); 1-based like segments

		this.draw();
	}

	Winwheel.prototype.degToRad = function (degrees) {
		return degrees * 0.017453292519943295; // Math.PI / 180
	};

	Winwheel.prototype.updateSegmentSizes = function () {
		var arcUsed = 0, numSet = 0, i;
		for (i = 1; i <= this.numSegments; i++) {
			if (this.segments[i].size != null) {
				arcUsed += this.segments[i].size;
				numSet++;
			}
		}
		var arcLeft = 360 - arcUsed;
		var degreesEach = arcLeft > 0 ? arcLeft / (this.numSegments - numSet) : 0;
		var currentDegree = 0;
		for (i = 1; i <= this.numSegments; i++) {
			this.segments[i].startAngle = currentDegree;
			currentDegree += this.segments[i].size ? this.segments[i].size : degreesEach;
			this.segments[i].endAngle = currentDegree;
		}
	};

	Winwheel.prototype.clearCanvas = function () {
		if (this.ctx) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
	};

	// `clearTheCanvas`: undefined or truthy clears first. No call site on this site ever passes
	// `false` here (the animation loop clears separately and calls drawSegments() directly instead).
	Winwheel.prototype.draw = function (clearTheCanvas) {
		if (!this.ctx) return;
		if (typeof clearTheCanvas === 'undefined' || clearTheCanvas) this.clearCanvas();
		this.drawSegments();
	};

	// Builds one fillable canvas pattern per segment from the <img id="imN"> elements the page keeps
	// pointed at the current games' covers. Must be called again whenever those <img> srcs change.
	Winwheel.prototype.createPatterns = function () {
		this._patterns = [null];
		for (var i = 1; i <= this.numSegments; i++) {
			var img = document.getElementById('im' + i);
			this._patterns[i] = {
				image: this.ctx.createPattern(img, 'no-repeat'),
				width: img.width,
				height: img.height
			};
		}
	};

	// The customised drawing. See the file header for why the transform dance around the second
	// fill() matters even though it never touches the path.
	Winwheel.prototype.drawSegments = function () {
		if (!this.ctx || !this.segments) return;
		var patterns = this._patterns;

		for (var i = 1; i <= this.numSegments; i++) {
			var seg = this.segments[i];
			var alpha = seg.alpha != null ? seg.alpha : this.alpha;
			var fillStyle = seg.fillStyle != null ? seg.fillStyle : this.fillStyle;
			var lineWidth = seg.lineWidth != null ? seg.lineWidth : this.lineWidth;
			var strokeStyle = seg.strokeStyle != null ? seg.strokeStyle : this.strokeStyle;

			this.ctx.lineWidth = lineWidth;
			this.ctx.strokeStyle = strokeStyle;

			if (!strokeStyle && !fillStyle && !alpha) continue;

			this.ctx.beginPath();
			if (!this.innerRadius) this.ctx.moveTo(this.centerX, this.centerY);
			this.ctx.arc(
				this.centerX, this.centerY, this.outerRadius,
				this.degToRad(seg.startAngle + this.rotationAngle - 90),
				this.degToRad(seg.endAngle + this.rotationAngle - 90),
				false
			);
			if (this.innerRadius) {
				this.ctx.arc(
					this.centerX, this.centerY, this.innerRadius,
					this.degToRad(seg.endAngle + this.rotationAngle - 90),
					this.degToRad(seg.startAngle + this.rotationAngle - 90),
					true
				);
			} else {
				this.ctx.lineTo(this.centerX, this.centerY);
			}

			if (fillStyle) {
				this.ctx.fillStyle = fillStyle;
				this.ctx.fill();
			}

			var pattern = patterns && patterns[i];
			this.ctx.save();
			if (this.dynamicImages) {
				this.ctx.translate(this.outerRadius + 5, this.outerRadius + 10);
				this.ctx.rotate(this.degToRad(seg.endAngle - (seg.endAngle - seg.startAngle) / 2 + this.rotationAngle - 90 - 270));
				this.ctx.translate(-this.outerRadius - 5, -this.outerRadius - 10);
				this.ctx.translate(45, -20);
				this.ctx.globalAlpha = alpha;
				if (pattern) {
					if (pattern.width) {
						this.ctx.scale(this.outerRadius / (245 * (pattern.width / 460)), (this.outerRadius - 0.03 * this.outerRadius) / pattern.height);
					}
					this.ctx.fillStyle = pattern.image;
				}
			} else {
				this.ctx.translate(0, 0);
				this.ctx.globalAlpha = alpha;
				if (pattern) {
					if (pattern.width) this.ctx.scale(this.outerRadius / 227, this.outerRadius / 101);
					this.ctx.fillStyle = pattern.image;
				}
			}
			this.ctx.fill();
			this.ctx.restore();

			if (strokeStyle) this.ctx.stroke();
		}
	};

	// Viewport point -> canvas pixel. The canvas is usually shown smaller than its width/height attributes (CSS
	// scaling), so the offset inside the element is scaled up. (The old plugin computed `x - bbox.left * scale`,
	// which sent clicks to the wrong segment whenever the canvas was scaled.)
	Winwheel.prototype.windowToCanvas = function (x, y) {
		var bbox = this.canvas.getBoundingClientRect();
		return {
			x: Math.floor((x - bbox.left) * (this.canvas.width / bbox.width)),
			y: Math.floor((y - bbox.top) * (this.canvas.height / bbox.height))
		};
	};

	Winwheel.prototype.getRotationPosition = function () {
		var rawAngle = this.rotationAngle;
		if (rawAngle >= 0) {
			if (rawAngle > 360) rawAngle -= 360 * Math.floor(rawAngle / 360);
		} else {
			if (rawAngle < -360) rawAngle -= 360 * Math.ceil(rawAngle / 360);
			rawAngle = 360 + rawAngle;
		}
		return rawAngle;
	};

	Winwheel.prototype.getSegmentNumberAt = function (x, y) {
		var loc = this.windowToCanvas(x, y);
		var leftRight, topBottom, adjacent, opposite;

		if (loc.x > this.centerX) { adjacent = loc.x - this.centerX; leftRight = 'R'; }
		else { adjacent = this.centerX - loc.x; leftRight = 'L'; }
		if (loc.y > this.centerY) { opposite = loc.y - this.centerY; topBottom = 'B'; }
		else { opposite = this.centerY - loc.y; topBottom = 'T'; }

		var angleFromAxis = 180 * Math.atan(opposite / adjacent) / Math.PI;
		var hypotenuse = Math.sqrt(opposite * opposite + adjacent * adjacent);

		var locationAngle = 0;
		if (topBottom === 'T' && leftRight === 'R') locationAngle = Math.round(90 - angleFromAxis);
		else if (topBottom === 'B' && leftRight === 'R') locationAngle = Math.round(angleFromAxis + 90);
		else if (topBottom === 'B' && leftRight === 'L') locationAngle = Math.round(90 - angleFromAxis + 180);
		else if (topBottom === 'T' && leftRight === 'L') locationAngle = Math.round(angleFromAxis + 270);

		if (this.rotationAngle !== 0) {
			locationAngle -= this.getRotationPosition();
			if (locationAngle < 0) locationAngle = 360 - Math.abs(locationAngle);
		}

		for (var i = 1; i <= this.numSegments; i++) {
			var seg = this.segments[i];
			if (locationAngle >= seg.startAngle && locationAngle <= seg.endAngle &&
				hypotenuse >= this.innerRadius && hypotenuse <= this.outerRadius) {
				return i;
			}
		}
		return null;
	};

	Winwheel.prototype.getSegmentAt = function (x, y) {
		var segmentNumber = this.getSegmentNumberAt(x, y);
		return segmentNumber !== null ? this.segments[segmentNumber] : null;
	};

	// The pointer is fixed at the top of the wheel (angle 0) on this site — the old plugin's
	// configurable `pointerAngle` always defaulted to 0 here, so it is inlined rather than exposed.
	Winwheel.prototype.getIndicatedSegmentNumber = function () {
		var relativeAngle = Math.floor(0 - this.getRotationPosition());
		if (relativeAngle < 0) relativeAngle = 360 - Math.abs(relativeAngle);
		for (var i = 1; i <= this.numSegments; i++) {
			var seg = this.segments[i];
			if (relativeAngle >= seg.startAngle && relativeAngle <= seg.endAngle) return i;
		}
		return 0;
	};

	Winwheel.prototype.getIndicatedSegment = function () {
		return this.segments[this.getIndicatedSegmentNumber()];
	};

	Winwheel.prototype.getRandomForSegment = function (segmentNumber) {
		if (!segmentNumber || typeof this.segments[segmentNumber] === 'undefined') return 0;
		var seg = this.segments[segmentNumber];
		var range = seg.endAngle - seg.startAngle - 2;
		return range > 0 ? seg.startAngle + 1 + Math.floor(Math.random() * range) : 0;
	};

	// ---- animation --------------------------------------------------------------------------
	// Only one spin ever runs at a time on this site; `active` tracks whichever one is currently
	// ticking so stopAnimation()/a fresh startAnimation() can always cancel it, mirroring the old
	// plugin's single shared ticker.
	var active = null;

	// requestAnimationFrame hands its callback a timestamp; setTimeout does not, so the fallback path
	// has to fetch one itself.
	function now() {
		return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
	}

	function scheduleFrame(fn) {
		if (typeof document !== 'undefined' && document.hidden) {
			return { timeoutId: setTimeout(function () { fn(now()); }, 16) };
		}
		return { rafId: requestAnimationFrame(fn) };
	}

	function cancelFrame(handle) {
		if (!handle) return;
		if (handle.rafId != null) cancelAnimationFrame(handle.rafId);
		if (handle.timeoutId != null) clearTimeout(handle.timeoutId);
	}

	Winwheel.prototype.startAnimation = function () {
		if (active) cancelFrame(active.handle);

		var wheel = this;
		var anim = this.animation;
		var target = anim.computeTarget();
		var start = this.rotationAngle;
		var durationMs = anim.duration * 1000;
		var ease = EASE[anim.easing] || EASE['Power4.easeOut'];
		var startTime = null;
		var state = { handle: null };
		active = state;

		function frame(now) {
			if (startTime === null) startTime = now;
			var elapsed = now - startTime;
			var t = durationMs > 0 ? Math.min(elapsed / durationMs, 1) : 1;

			wheel.rotationAngle = start + (target - start) * ease(t);
			wheel.clearCanvas();
			wheel.drawSegments();
			runCallback(anim.callbackAfter);

			if (t >= 1) {
				if (active === state) active = null;
				runCallback(anim.callbackFinished);
			} else {
				state.handle = scheduleFrame(frame);
			}
		}

		state.handle = scheduleFrame(frame);
	};

	// canCallback: pass false to cancel silently. Every call site on this site (resetWheel(), and
	// page navigation away from the wheel) calls stopAnimation(false) — the spin was abandoned, not
	// finished, so no "wheel stopped" callback should fire.
	Winwheel.prototype.stopAnimation = function (canCallback) {
		if (active) {
			cancelFrame(active.handle);
			active = null;
		}
		if (canCallback !== false && canCallback !== 0 && this.animation.callbackFinished != null) {
			runCallback(this.animation.callbackFinished);
		}
	};

	window.Winwheel = Winwheel;
})();
