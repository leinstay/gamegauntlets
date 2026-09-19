function Winwheel(options, drawWheel) {
	defaultOptions = { canvasId: "canvas", centerX: null, centerY: null, outerRadius: null, innerRadius: 0, numSegments: 1, drawMode: "code", rotationAngle: 0, textFontFamily: "Arial", textFontSize: 20, textFontWeight: "bold", textOrientation: "horizontal", textAlignment: "center", textDirection: "normal", textMargin: null, textFillStyle: "black", textStrokeStyle: null, textLineWidth: 1, fillStyle: "rgba(40, 40, 40, 0.2)", strokeStyle: "black", lineWidth: 1, clearTheCanvas: !0, imageOverlay: !1, drawText: !0, pointerAngle: 0, wheelImage: null, imageDirection: "N", alpha: 1, dynamicImages: !0 };
	for (var key in defaultOptions) this[key] = null != options && "undefined" != typeof options[key] ? options[key] : defaultOptions[key];
	if (null != options)
		for (var key in options) "undefined" == typeof this[key] && (this[key] = options[key]);
	for (this.canvasId ? (this.canvas = document.getElementById(this.canvasId), this.canvas ? (null == this.centerX && (this.centerX = this.canvas.width / 2), null == this.centerY && (this.centerY = this.canvas.height / 2), null == this.outerRadius && (this.outerRadius = this.canvas.width < this.canvas.height ? this.canvas.width / 2 - this.lineWidth : this.canvas.height / 2 - this.lineWidth), this.ctx = this.canvas.getContext("2d")) : (this.canvas = null, this.ctx = null)) : (this.cavnas = null, this.ctx = null), this.segments = new Array(null), x = 1; x <= this.numSegments; x++) this.segments[x] = null != options && options.segments && "undefined" != typeof options.segments[x - 1] ? new Segment(options.segments[x - 1]) : new Segment;
	if (this.updateSegmentSizes(), null === this.textMargin && (this.textMargin = this.textFontSize / 1.7), this.animation = null != options && options.animation && "undefined" != typeof options.animation ? new Animation(options.animation) : new Animation, "image" == this.drawMode || "segmentImage" == this.drawMode ? ("undefined" == typeof options.fillStyle && (this.fillStyle = null), "undefined" == typeof options.strokeStyle && (this.strokeStyle = "red"), "undefined" == typeof options.drawText && (this.drawText = !1), "undefined" == typeof options.lineWidth && (this.lineWidth = 1), "undefined" == typeof drawWheel && (drawWheel = !1)) : "undefined" == typeof drawWheel && (drawWheel = !0), this.pointerGuide = null != options && options.pointerGuide && "undefined" != typeof options.pointerGuide ? new PointerGuide(options.pointerGuide) : new PointerGuide, pattern = new Array(null), Winwheel.prototype.createPatterns = function () {
			for (pattern = new Array(null), x = 1; x <= this.numSegments; x++) pattern[x] = new Object(null), pattern[x].image = this.ctx.createPattern(document.getElementById("im" + x), "no-repeat"), pattern[x].width = document.getElementById("im" + x).width, pattern[x].height = document.getElementById("im" + x).height
		}, 1 == drawWheel) this.draw(this.clearTheCanvas);
	else if ("segmentImage" == this.drawMode)
		for (winwheelToDrawDuringAnimation = this, winhweelAlreadyDrawn = !1, y = 1; y <= this.numSegments; y++) null !== this.segments[y].image && (this.segments[y].imgData = new Image, this.segments[y].imgData.onload = winwheelLoadedImage, this.segments[y].imgData.src = this.segments[y].image)
}

function Animation(options) {
	defaultOptions = {
		type: "spinOngoing",
		direction: "clockwise",
		propertyName: null,
		propertyValue: null,
		duration: 10,
		yoyo: !1,
		repeat: 0,
		easing: "power3.easeOut",
		stopAngle: null,
		spins: null,
		clearTheCanvas: null,
		callbackFinished: null,
		callbackBefore: null,
		callbackAfter: null
	};
	for (var key in defaultOptions) this[key] = null != options && "undefined" != typeof options[key] ? options[key] : defaultOptions[key];
	if (null != options)
		for (var key in options) "undefined" == typeof this[key] && (this[key] = options[key])
}

function Segment(options) {
	defaultOptions = {
		size: null,
		text: "",
		fillStyle: null,
		strokeStyle: null,
		lineWidth: null,
		textFontFamily: null,
		textFontSize: null,
		alpha: null,
		textFontWeight: null,
		textOrientation: null,
		textAlignment: null,
		textDirection: null,
		textMargin: null,
		textFillStyle: null,
		textStrokeStyle: null,
		textLineWidth: null,
		image: null,
		imageDirection: null,
		imgData: null
	};
	for (var key in defaultOptions) this[key] = null != options && "undefined" != typeof options[key] ? options[key] : defaultOptions[key];
	if (null != options)
		for (var key in options) "undefined" == typeof this[key] && (this[key] = options[key]);
	this.startAngle = 0, this.endAngle = 0
}

function PointerGuide(options) {
	defaultOptions = {
		display: !1,
		strokeStyle: "red",
		lineWidth: 3
	};
	for (var key in defaultOptions) this[key] = null != options && "undefined" != typeof options[key] ? options[key] : defaultOptions[key]
}

function winwheelPercentToDegrees(percentValue) {
	var degrees = 0;
	if (percentValue > 0 && 100 >= percentValue) {
		var divider = percentValue / 100;
		degrees = 360 * divider
	}
	return degrees
}

function winwheelAnimationLoop() {
	winwheelToDrawDuringAnimation && (0 != winwheelToDrawDuringAnimation.animation.clearTheCanvas && winwheelToDrawDuringAnimation.ctx.clearRect(0, 0, winwheelToDrawDuringAnimation.canvas.width, winwheelToDrawDuringAnimation.canvas.height), null != winwheelToDrawDuringAnimation.animation.callbackBefore && eval(winwheelToDrawDuringAnimation.animation.callbackBefore), winwheelToDrawDuringAnimation.draw(!1), null != winwheelToDrawDuringAnimation.animation.callbackAfter && eval(winwheelToDrawDuringAnimation.animation.callbackAfter))
}

function winwheelStopAnimation(canCallback) {
	TweenLite.ticker.removeEventListener("tick", winwheelAnimationLoop, this), 0 != canCallback && null != winwheelToDrawDuringAnimation.animation.callbackFinished && eval(winwheelToDrawDuringAnimation.animation.callbackFinished)
}

function winwheelLoadedImage() {
	if (0 == winhweelAlreadyDrawn) {
		var winwheelImageLoadCount = 0;
		for (i = 1; i <= winwheelToDrawDuringAnimation.numSegments; i++) null != winwheelToDrawDuringAnimation.segments[i].imgData && winwheelToDrawDuringAnimation.segments[i].imgData.height && winwheelImageLoadCount++;
		winwheelImageLoadCount == winwheelToDrawDuringAnimation.numSegments && (winhweelAlreadyDrawn = !0, winwheelToDrawDuringAnimation.draw())
	}
}

Winwheel.prototype.updateSegmentSizes = function () {
	if (this.segments) {
		var arcUsed = 0,
			numSet = 0;
		for (x = 1; x <= this.numSegments; x++) null !== this.segments[x].size && (arcUsed += this.segments[x].size, numSet++);
		var arcLeft = 360 - arcUsed,
			degreesEach = 0;
		arcLeft > 0 && (degreesEach = arcLeft / (this.numSegments - numSet));
		var currentDegree = 0;
		for (x = 1; x <= this.numSegments; x++) this.segments[x].startAngle = currentDegree, currentDegree += this.segments[x].size ? this.segments[x].size : degreesEach, this.segments[x].endAngle = currentDegree
	}
}, Winwheel.prototype.clearCanvas = function () {
	this.ctx && this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
}, Winwheel.prototype.draw = function (clearTheCanvas) {
	this.ctx && ("undefined" != typeof clearTheCanvas ? 1 == clearTheCanvas && this.clearCanvas() : this.clearCanvas(), "image" == this.drawMode ? (this.drawWheelImage(), 1 == this.drawText && this.drawSegmentText(), 1 == this.imageOverlay && this.drawSegments()) : "segmentImage" == this.drawMode ? (this.drawSegmentImages(), 1 == this.drawText && this.drawSegmentText(), 1 == this.imageOverlay && this.drawSegments()) : (this.drawSegments(), 1 == this.drawText && this.drawSegmentText()), 1 == this.pointerGuide.display && this.drawPointerGuide())
}, Winwheel.prototype.drawPointerGuide = function () {
	this.ctx && (this.ctx.save(), this.ctx.translate(this.centerX, this.centerY), this.ctx.rotate(this.degToRad(this.pointerAngle)), this.ctx.translate(-this.centerX, -this.centerY), this.ctx.strokeStyle = this.pointerGuide.strokeStyle, this.ctx.lineWidth = this.pointerGuide.lineWidth, this.ctx.beginPath(), this.ctx.moveTo(this.centerX, this.centerY), this.ctx.lineTo(this.centerX, -(this.outerRadius / 4)), this.ctx.stroke(), this.ctx.restore())
}, Winwheel.prototype.drawWheelImage = function () {
	if (null != this.wheelImage) {
		var imageLeft = this.centerX - this.wheelImage.height / 2,
			imageTop = this.centerY - this.wheelImage.width / 2;
		this.ctx.save(), this.ctx.translate(this.centerX, this.centerY), this.ctx.rotate(this.degToRad(this.rotationAngle)), this.ctx.translate(-this.centerX, -this.centerY), this.ctx.drawImage(this.wheelImage, imageLeft, imageTop), this.ctx.restore()
	}
}, Winwheel.prototype.drawSegmentImages = function () {
	if (this.ctx && this.segments)
		for (x = 1; x <= this.numSegments; x++)
			if (seg = this.segments[x], seg.imgData.height) {
				var imageLeft = 0,
					imageTop = 0,
					imageAngle = 0,
					imageDirection = "";
				imageDirection = null !== seg.imageDirection ? seg.imageDirection : this.imageDirection, "S" == imageDirection ? (imageLeft = this.centerX - seg.imgData.width / 2, imageTop = this.centerY, imageAngle = seg.startAngle + 180 + (seg.endAngle - seg.startAngle) / 2) : "E" == imageDirection ? (imageLeft = this.centerX, imageTop = this.centerY - seg.imgData.height / 2, imageAngle = seg.startAngle + 270 + (seg.endAngle - seg.startAngle) / 2) : "W" == imageDirection ? (imageLeft = this.centerX - seg.imgData.width, imageTop = this.centerY - seg.imgData.height / 2, imageAngle = seg.startAngle + 90 + (seg.endAngle - seg.startAngle) / 2) : (imageLeft = this.centerX - seg.imgData.width / 2, imageTop = this.centerY - seg.imgData.height, imageAngle = seg.startAngle + (seg.endAngle - seg.startAngle) / 2), this.ctx.save(), this.ctx.translate(this.centerX, this.centerY), this.ctx.rotate(this.degToRad(this.rotationAngle + imageAngle)), this.ctx.translate(-this.centerX, -this.centerY), this.ctx.drawImage(seg.imgData, imageLeft, imageTop), this.ctx.restore()
			} else console.log("Segment " + x + " imgData is not loaded")
}, Winwheel.prototype.drawSegments = function () {
	if (this.ctx && this.segments)
		for (x = 1; x <= this.numSegments; x++) {
			seg = this.segments[x];
			var alpha, fillStyle, lineWidth, strokeStyle, dynamicImages = this.dynamicImages;
			fillStyle = null !== seg.fillStyle ? seg.fillStyle : this.fillStyle, alpha = null !== seg.alpha ? seg.alpha : this.alpha, lineWidth = null !== seg.lineWidth ? seg.lineWidth : this.lineWidth, this.ctx.lineWidth = lineWidth, strokeStyle = null !== seg.strokeStyle ? seg.strokeStyle : this.strokeStyle, this.ctx.strokeStyle = strokeStyle, (strokeStyle || fillStyle || alpha) && (this.ctx.beginPath(), this.innerRadius || this.ctx.moveTo(this.centerX, this.centerY), this.ctx.arc(this.centerX, this.centerY, this.outerRadius, this.degToRad(seg.startAngle + this.rotationAngle - 90), this.degToRad(seg.endAngle + this.rotationAngle - 90), !1), this.innerRadius ? this.ctx.arc(this.centerX, this.centerY, this.innerRadius, this.degToRad(seg.endAngle + this.rotationAngle - 90), this.degToRad(seg.startAngle + this.rotationAngle - 90), !0) : this.ctx.lineTo(this.centerX, this.centerY), fillStyle && (this.ctx.fillStyle = fillStyle, this.ctx.fill()), dynamicImages ? (this.ctx.save(), this.ctx.translate(this.outerRadius + 5, this.outerRadius + 10), this.ctx.rotate(this.degToRad(seg.endAngle - (seg.endAngle - seg.startAngle) / 2 + this.rotationAngle - 90 - 270)), this.ctx.translate(-this.outerRadius - 5, -this.outerRadius - 10), this.ctx.translate(45, -20), this.ctx.globalAlpha = alpha, pattern[x] && (pattern[x].width && this.ctx.scale(this.outerRadius / (245 * (pattern[x].width / 460)), (this.outerRadius - .03 * this.outerRadius) / pattern[x].height), this.ctx.fillStyle = pattern[x].image), this.ctx.fill(), this.ctx.restore()) : (this.ctx.save(), this.ctx.translate(0, 0), this.ctx.globalAlpha = alpha, pattern[x] && (pattern[x].width && this.ctx.scale(this.outerRadius / 227, this.outerRadius / 101), this.ctx.fillStyle = pattern[x].image), this.ctx.fill(), this.ctx.restore()), strokeStyle && this.ctx.stroke())
		}
}, Winwheel.prototype.drawSegmentText = function () {
	if (this.ctx) {
		var fontFamily, fontSize, fontWeight, orientation, alignment, direction, margin, fillStyle, strokeStyle, lineWidth, fontSetting;
		for (x = 1; x <= this.numSegments; x++) {
			if (this.ctx.save(), seg = this.segments[x], seg.text)
				if (fontFamily = null !== seg.textFontFamily ? seg.textFontFamily : this.textFontFamily, fontSize = null !== seg.textFontSize ? seg.textFontSize : this.textFontSize, fontWeight = null !== seg.textFontWeight ? seg.textFontWeight : this.textFontWeight, orientation = null !== seg.textOrientation ? seg.textOrientation : this.textOrientation, alignment = null !== seg.textAlignment ? seg.textAlignment : this.textAlignment, direction = null !== seg.textDirection ? seg.textDirection : this.textDirection, margin = null !== seg.textMargin ? seg.textMargin : this.textMargin, fillStyle = null !== seg.textFillStyle ? seg.textFillStyle : this.textFillStyle, strokeStyle = null !== seg.textStrokeStyle ? seg.textStrokeStyle : this.textStrokeStyle, lineWidth = null !== seg.textLineWidth ? seg.textLineWidth : this.textLineWidth, fontSetting = "", null != fontWeight && (fontSetting += fontWeight + " "), null != fontSize && (fontSetting += fontSize + "px "), null != fontFamily && (fontSetting += fontFamily), this.ctx.font = fontSetting, this.ctx.fillStyle = fillStyle, this.ctx.strokeStyle = strokeStyle, this.ctx.lineWidth = lineWidth, "reversed" == direction) {
					if ("horizontal" == orientation) {
						this.ctx.textAlign = "inner" == alignment ? "right" : "outer" == alignment ? "left" : "center", this.ctx.textBaseline = "middle";
						var textAngle = this.degToRad(seg.endAngle - (seg.endAngle - seg.startAngle) / 2 + this.rotationAngle - 90 - 180);
						this.ctx.save(), this.ctx.translate(this.centerX, this.centerY), this.ctx.rotate(textAngle), this.ctx.translate(-this.centerX, -this.centerY), "inner" == alignment ? (fillStyle && this.ctx.fillText(seg.text, this.centerX - this.innerRadius - margin, this.centerY), strokeStyle && this.ctx.strokeText(seg.text, this.centerX - this.innerRadius - margin, this.centerY)) : "outer" == alignment ? (fillStyle && this.ctx.fillText(seg.text, this.centerX - this.outerRadius + margin, this.centerY), strokeStyle && this.ctx.strokeText(seg.text, this.centerX - this.outerRadius + margin, this.centerY)) : (fillStyle && this.ctx.fillText(seg.text, this.centerX - this.innerRadius - (this.outerRadius - this.innerRadius) / 2 - margin, this.centerY), strokeStyle && this.ctx.strokeText(seg.text, this.centerX - this.innerRadius - (this.outerRadius - this.innerRadius) / 2 - margin, this.centerY)), this.ctx.restore()
					} else if ("vertical" == orientation) {
						this.ctx.textAlign = "center", this.ctx.textBaseline = "inner" == alignment ? "top" : "outer" == alignment ? "bottom" : "middle";
						var textAngle = seg.endAngle - (seg.endAngle - seg.startAngle) / 2 - 180;
						if (textAngle += this.rotationAngle, this.ctx.save(), this.ctx.translate(this.centerX, this.centerY), this.ctx.rotate(this.degToRad(textAngle)), this.ctx.translate(-this.centerX, -this.centerY), "outer" == alignment) var yPos = this.centerY + this.outerRadius - margin;
						else if ("inner" == alignment) var yPos = this.centerY + this.innerRadius + margin;
						var yInc = fontSize - fontSize / 9;
						if ("outer" == alignment)
							for (var c = seg.text.length - 1; c >= 0; c--) character = seg.text.charAt(c), fillStyle && this.ctx.fillText(character, this.centerX, yPos), strokeStyle && this.ctx.strokeText(character, this.centerX, yPos), yPos -= yInc;
						else if ("inner" == alignment)
							for (var c = 0; c < seg.text.length; c++) character = seg.text.charAt(c), fillStyle && this.ctx.fillText(character, this.centerX, yPos), strokeStyle && this.ctx.strokeText(character, this.centerX, yPos), yPos += yInc;
						else if ("center" == alignment) {
							var centerAdjustment = 0;
							seg.text.length > 1 && (centerAdjustment = yInc * (seg.text.length - 1) / 2);
							for (var yPos = this.centerY + this.innerRadius + (this.outerRadius - this.innerRadius) / 2 + centerAdjustment + margin, c = seg.text.length - 1; c >= 0; c--) character = seg.text.charAt(c), fillStyle && this.ctx.fillText(character, this.centerX, yPos), strokeStyle && this.ctx.strokeText(character, this.centerX, yPos), yPos -= yInc
						}
						this.ctx.restore()
					} else if ("curved" == orientation) {
						var radius = 0;
						"inner" == alignment ? (radius = this.innerRadius + margin, this.ctx.textBaseline = "top") : "outer" == alignment ? (radius = this.outerRadius - margin, this.ctx.textBaseline = "bottom") : "center" == alignment && (radius = this.innerRadius + margin + (this.outerRadius - this.innerRadius) / 2, this.ctx.textBaseline = "middle");
						var anglePerChar = 0,
							drawAngle = 0;
						for (seg.text.length > 1 ? (this.ctx.textAlign = "left", anglePerChar = 4 * (fontSize / 10), radiusPercent = 100 / radius, anglePerChar *= radiusPercent, totalArc = anglePerChar * seg.text.length, drawAngle = seg.startAngle + ((seg.endAngle - seg.startAngle) / 2 - totalArc / 2)) : (drawAngle = seg.startAngle + (seg.endAngle - seg.startAngle) / 2, this.ctx.textAlign = "center"), drawAngle += this.rotationAngle, drawAngle -= 180, c = seg.text.length; c >= 0; c--) this.ctx.save(), character = seg.text.charAt(c), this.ctx.translate(this.centerX, this.centerY), this.ctx.rotate(this.degToRad(drawAngle)), this.ctx.translate(-this.centerX, -this.centerY), strokeStyle && this.ctx.strokeText(character, this.centerX, this.centerY + radius), fillStyle && this.ctx.fillText(character, this.centerX, this.centerY + radius), drawAngle += anglePerChar, this.ctx.restore()
					}
				} else if ("horizontal" == orientation) {
				this.ctx.textAlign = "inner" == alignment ? "left" : "outer" == alignment ? "right" : "center", this.ctx.textBaseline = "middle";
				var textAngle = this.degToRad(seg.endAngle - (seg.endAngle - seg.startAngle) / 2 + this.rotationAngle - 90);
				this.ctx.save(), this.ctx.translate(this.centerX, this.centerY), this.ctx.rotate(textAngle), this.ctx.translate(-this.centerX, -this.centerY), "inner" == alignment ? (fillStyle && this.ctx.fillText(seg.text, this.centerX + this.innerRadius + margin, this.centerY), strokeStyle && this.ctx.strokeText(seg.text, this.centerX + this.innerRadius + margin, this.centerY)) : "outer" == alignment ? (fillStyle && this.ctx.fillText(seg.text, this.centerX + this.outerRadius - margin, this.centerY), strokeStyle && this.ctx.strokeText(seg.text, this.centerX + this.outerRadius - margin, this.centerY)) : (fillStyle && this.ctx.fillText(seg.text, this.centerX + this.innerRadius + (this.outerRadius - this.innerRadius) / 2 + margin, this.centerY), strokeStyle && this.ctx.strokeText(seg.text, this.centerX + this.innerRadius + (this.outerRadius - this.innerRadius) / 2 + margin, this.centerY)), this.ctx.restore()
			} else if ("vertical" == orientation) {
				this.ctx.textAlign = "center", this.ctx.textBaseline = "inner" == alignment ? "bottom" : "outer" == alignment ? "top" : "middle";
				var textAngle = seg.endAngle - (seg.endAngle - seg.startAngle) / 2;
				if (textAngle += this.rotationAngle, this.ctx.save(), this.ctx.translate(this.centerX, this.centerY), this.ctx.rotate(this.degToRad(textAngle)), this.ctx.translate(-this.centerX, -this.centerY), "outer" == alignment) var yPos = this.centerY - this.outerRadius + margin;
				else if ("inner" == alignment) var yPos = this.centerY - this.innerRadius - margin;
				var yInc = fontSize - fontSize / 9;
				if ("outer" == alignment)
					for (var c = 0; c < seg.text.length; c++) character = seg.text.charAt(c), fillStyle && this.ctx.fillText(character, this.centerX, yPos), strokeStyle && this.ctx.strokeText(character, this.centerX, yPos), yPos += yInc;
				else if ("inner" == alignment)
					for (var c = seg.text.length - 1; c >= 0; c--) character = seg.text.charAt(c), fillStyle && this.ctx.fillText(character, this.centerX, yPos), strokeStyle && this.ctx.strokeText(character, this.centerX, yPos), yPos -= yInc;
				else if ("center" == alignment) {
					var centerAdjustment = 0;
					seg.text.length > 1 && (centerAdjustment = yInc * (seg.text.length - 1) / 2);
					for (var yPos = this.centerY - this.innerRadius - (this.outerRadius - this.innerRadius) / 2 - centerAdjustment - margin, c = 0; c < seg.text.length; c++) character = seg.text.charAt(c), fillStyle && this.ctx.fillText(character, this.centerX, yPos), strokeStyle && this.ctx.strokeText(character, this.centerX, yPos), yPos += yInc
				}
				this.ctx.restore()
			} else if ("curved" == orientation) {
				var radius = 0;
				"inner" == alignment ? (radius = this.innerRadius + margin, this.ctx.textBaseline = "bottom") : "outer" == alignment ? (radius = this.outerRadius - margin, this.ctx.textBaseline = "top") : "center" == alignment && (radius = this.innerRadius + margin + (this.outerRadius - this.innerRadius) / 2, this.ctx.textBaseline = "middle");
				var anglePerChar = 0,
					drawAngle = 0;
				for (seg.text.length > 1 ? (this.ctx.textAlign = "left", anglePerChar = 4 * (fontSize / 10), radiusPercent = 100 / radius, anglePerChar *= radiusPercent, totalArc = anglePerChar * seg.text.length, drawAngle = seg.startAngle + ((seg.endAngle - seg.startAngle) / 2 - totalArc / 2)) : (drawAngle = seg.startAngle + (seg.endAngle - seg.startAngle) / 2, this.ctx.textAlign = "center"), drawAngle += this.rotationAngle, c = 0; c < seg.text.length; c++) this.ctx.save(), character = seg.text.charAt(c), this.ctx.translate(this.centerX, this.centerY), this.ctx.rotate(this.degToRad(drawAngle)), this.ctx.translate(-this.centerX, -this.centerY), strokeStyle && this.ctx.strokeText(character, this.centerX, this.centerY - radius), fillStyle && this.ctx.fillText(character, this.centerX, this.centerY - radius), drawAngle += anglePerChar, this.ctx.restore()
			}
			this.ctx.restore()
		}
	}
}, Winwheel.prototype.degToRad = function (d) {
	return .017453292519943295 * d
}, Winwheel.prototype.setCenter = function (x, y) {
	this.centerX = x, this.centerY = y
}, Winwheel.prototype.addSegment = function (options, position) {
	newSegment = new Segment(options), this.numSegments++;
	var segmentPos;
	if ("undefined" != typeof position) {
		for (var x = this.numSegments; x > position; x--) this.segments[x] = this.segments[x - 1];
		this.segments[position] = newSegment, segmentPos = position
	} else this.segments[this.numSegments] = newSegment, segmentPos = this.numSegments;
	return this.updateSegmentSizes(), this.segments[segmentPos]
}, Winwheel.prototype.setCanvasId = function (canvasId) {
	canvasId ? (this.canvasId = canvasId, this.canvas = document.getElementById(this.canvasId), this.canvas && (this.ctx = this.canvas.getContext("2d"))) : (this.canvasId = null, this.ctx = null, this.canvas = null)
}, Winwheel.prototype.deleteSegment = function (position) {
	if (this.numSegments > 1) {
		if ("undefined" != typeof position)
			for (var x = position; x < this.numSegments; x++) this.segments[x] = this.segments[x + 1];
		this.segments[this.numSegments] = void 0, this.numSegments--, this.updateSegmentSizes()
	}
}, Winwheel.prototype.windowToCanvas = function (x, y) {
	var bbox = this.canvas.getBoundingClientRect();
	return {
		x: Math.floor(x - bbox.left * (this.canvas.width / bbox.width)),
		y: Math.floor(y - bbox.top * (this.canvas.height / bbox.height))
	}
}, Winwheel.prototype.getSegmentAt = function (x, y) {
	var foundSegment = null,
		segmentNumber = this.getSegmentNumberAt(x, y);
	return null !== segmentNumber && (foundSegment = this.segments[segmentNumber]), foundSegment
}, Winwheel.prototype.getSegmentNumberAt = function (x, y) {
	var topBottom, leftRight, adjacentSideLength, oppositeSideLength, hypotenuseSideLength, loc = this.windowToCanvas(x, y);
	loc.x > this.centerX ? (adjacentSideLength = loc.x - this.centerX, leftRight = "R") : (adjacentSideLength = this.centerX - loc.x, leftRight = "L"), loc.y > this.centerY ? (oppositeSideLength = loc.y - this.centerY, topBottom = "B") : (oppositeSideLength = this.centerY - loc.y, topBottom = "T");
	var tanVal = oppositeSideLength / adjacentSideLength,
		result = 180 * Math.atan(tanVal) / Math.PI,
		locationAngle = 0;
	if (hypotenuseSideLength = Math.sqrt(oppositeSideLength * oppositeSideLength + adjacentSideLength * adjacentSideLength), "T" == topBottom && "R" == leftRight ? locationAngle = Math.round(90 - result) : "B" == topBottom && "R" == leftRight ? locationAngle = Math.round(result + 90) : "B" == topBottom && "L" == leftRight ? locationAngle = Math.round(90 - result + 180) : "T" == topBottom && "L" == leftRight && (locationAngle = Math.round(result + 270)), 0 != this.rotationAngle) {
		var rotatedPosition = this.getRotationPosition();
		locationAngle -= rotatedPosition, 0 > locationAngle && (locationAngle = 360 - Math.abs(locationAngle))
	}
	for (var foundSegmentNumber = null, x = 1; x <= this.numSegments; x++)
		if (locationAngle >= this.segments[x].startAngle && locationAngle <= this.segments[x].endAngle && hypotenuseSideLength >= this.innerRadius && hypotenuseSideLength <= this.outerRadius) {
			foundSegmentNumber = x;
			break
		}
	return foundSegmentNumber
}, Winwheel.prototype.getIndicatedSegment = function () {
	var prizeNumber = this.getIndicatedSegmentNumber();
	return this.segments[prizeNumber]
}, Winwheel.prototype.getIndicatedSegmentNumber = function () {
	var indicatedPrize = 0,
		rawAngle = this.getRotationPosition(),
		relativeAngle = Math.floor(this.pointerAngle - rawAngle);
	for (0 > relativeAngle && (relativeAngle = 360 - Math.abs(relativeAngle)), x = 1; x < this.segments.length; x++)
		if (relativeAngle >= this.segments[x].startAngle && relativeAngle <= this.segments[x].endAngle) {
			indicatedPrize = x;
			break
		}
	return indicatedPrize
}, Winwheel.prototype.getRotationPosition = function () {
	var rawAngle = this.rotationAngle;
	if (rawAngle >= 0) {
		if (rawAngle > 360) {
			var timesPast360 = Math.floor(rawAngle / 360);
			rawAngle -= 360 * timesPast360
		}
	} else {
		if (-360 > rawAngle) {
			var timesPast360 = Math.ceil(rawAngle / 360);
			rawAngle -= 360 * timesPast360
		}
		rawAngle = 360 + rawAngle
	}
	return rawAngle
}, TweenLite.ticker.fps(60), Winwheel.prototype.startAnimation = function (hash) {
	if (this.animation) {
		TweenLite.ticker.frame = 0, TweenLite.ticker.time = 0, this.computeAnimation(), winwheelToDrawDuringAnimation = this, TweenLite.ticker.addEventListener("tick", winwheelAnimationLoop, this);
		var properties = new Array(null);
		properties[this.animation.propertyName] = this.animation.propertyValue, properties.yoyo = this.animation.yoyo, properties.repeat = this.animation.repeat, properties.ease = this.animation.easing, properties.onComplete = winwheelStopAnimation, this.tween = TweenLite.to(this, this.animation.duration, properties)
	}
}, Winwheel.prototype.stopAnimation = function (canCallback) {
	winwheelToDrawDuringAnimation.tween.kill(), winwheelToDrawDuringAnimation = this, winwheelStopAnimation(canCallback)
}, Winwheel.prototype.pauseAnimation = function () {
	this.tween && this.tween.pause()
}, Winwheel.prototype.resumeAnimation = function () {
	this.tween && this.tween.play()
}, Winwheel.prototype.computeAnimation = function () {
	this.animation && ("spinOngoing" == this.animation.type ? (this.animation.propertyName = "rotationAngle", null == this.animation.spins && (this.animation.spins = 5), null == this.animation.repeat && (this.animation.repeat = -1), null == this.animation.easing && (this.animation.easing = "Linear.easeNone"), null == this.animation.yoyo && (this.animation.yoyo = !1), this.animation.propertyValue = 360 * this.animation.spins, "anti-clockwise" == this.animation.direction && (this.animation.propertyValue = 0 - this.animation.propertyValue)) : "spinToStop" == this.animation.type ? (this.animation.propertyName = "rotationAngle", null == this.animation.spins && (this.animation.spins = 5), null == this.animation.repeat && (this.animation.repeat = 0), null == this.animation.easing && (this.animation.easing = "Power4.easeOut"), this.animation._stopAngle = null == this.animation.stopAngle ? Math.floor(359 * Math.random()) : 360 - this.animation.stopAngle, null == this.animation.yoyo && (this.animation.yoyo = !1), this.animation.propertyValue = 360 * this.animation.spins, "anti-clockwise" == this.animation.direction ? (this.animation.propertyValue = 0 - this.animation.propertyValue, this.animation.propertyValue -= 360 - this.animation._stopAngle) : this.animation.propertyValue += this.animation._stopAngle) : "spinAndBack" == this.animation.type ? (this.animation.propertyName = "rotationAngle", null == this.animation.spins && (this.animation.spins = 5), null == this.animation.repeat && (this.animation.repeat = 1), null == this.animation.easing && (this.animation.easing = "Power2.easeInOut"), null == this.animation.yoyo && (this.animation.yoyo = !0), this.animation._stopAngle = null == this.animation.stopAngle ? 0 : 360 - this.animation.stopAngle, this.animation.propertyValue = 360 * this.animation.spins, "anti-clockwise" == this.animation.direction ? (this.animation.propertyValue = 0 - this.animation.propertyValue, this.animation.propertyValue -= 360 - this.animation._stopAngle) : this.animation.propertyValue += this.animation._stopAngle) : "custom" == this.animation.type)
}, Winwheel.prototype.getRandomForSegment = function (segmentNumber) {
	var stopAngle = 0;
	if (segmentNumber && "undefined" != typeof this.segments[segmentNumber]) {
		var startAngle = this.segments[segmentNumber].startAngle,
			endAngle = this.segments[segmentNumber].endAngle,
			range = endAngle - startAngle - 2;
		range > 0 && (stopAngle = startAngle + 1 + Math.floor(Math.random() * range))
	}
	return stopAngle
}, Segment.prototype.changeImage = function (image, imageDirection) {
	this.image = image, this.imgData = null, imageDirection && (this.imageDirection = imageDirection), winhweelAlreadyDrawn = !1, this.imgData = new Image, this.imgData.onload = winwheelLoadedImage, this.imgData.src = this.image
};

var winwheelToDrawDuringAnimation = null,
	winhweelAlreadyDrawn = !1;
	
window.addEventListener("blur", function () {
	TweenLite.ticker.useRAF(!1)
}, !1), window.addEventListener("focus", function () {
	TweenLite.ticker.useRAF(!0)
}, !1);