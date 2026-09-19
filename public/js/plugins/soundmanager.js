/*
 * Minimal SoundManager2-compatible shim over native HTMLAudioElement.
 *
 * SoundManager2 (schillmania/soundmanager2) is unmaintained and its Flash fallback path is dead weight
 * on any modern browser; every browser this site targets supports <audio> natively. Rather than vendor
 * the ~40KB SM2 library, this file implements only the subset of its API actually called by
 * js/pgwheel.js and js/pgindex.js, so neither of those files (nor the "soundManager" global name, nor
 * this file's own path/script tag) had to change:
 *   soundManager.setup({ onready, ... })                     - onready fires immediately (SM2 after boot)
 *   soundManager.createSound({ id, url, volume, multiShot,
 *                               onfinish, onplay }).play(opts?) - opts.volume optionally overrides
 *   soundManager.getSoundById(id)                              - { volume (0-100), setVolume(v) }
 *   soundManager.play(id)
 *   soundManager.stopAll()
 *
 * SM2 volumes are 0-100; native <audio>.volume is 0.0-1.0, so every volume in/out of this shim is
 * divided/multiplied by 100. All sounds used on this site are single-shot (multiShot never requested as
 * true), so each id maps to exactly one reused <audio> element instead of a pool of overlapping ones.
 */
(function (window) {
	"use strict";

	function clamp01(v) {
		return Math.max(0, Math.min(1, v));
	}

	function Sound(options) {
		options = options || {};
		this.id = options.id;
		this.multiShot = !!options.multiShot;
		this._onfinish = typeof options.onfinish === "function" ? options.onfinish : null;
		this._onplay = typeof options.onplay === "function" ? options.onplay : null;

		var audio = new Audio(options.url);
		audio.preload = "auto";
		var self = this;
		audio.addEventListener("ended", function () {
			if (self._onfinish) self._onfinish();
		});
		audio.addEventListener("play", function () {
			if (self._onplay) self._onplay();
		});
		this._audio = audio;

		// SM2 exposes a numeric 0-100 `.volume` property (not a function); mirror that here.
		// The exact value is kept (not re-derived from audio.volume): pgwheel.js fades the music in steps of 0.25,
		// which any rounding would swallow (the volume would stay at 0 forever).
		this._volume = typeof options.volume === "number" ? options.volume : 100;
		audio.volume = clamp01(this._volume / 100);
		Object.defineProperty(this, "volume", {
			get: function () { return self._volume; },
			set: function (v) { self.setVolume(v); }
		});
	}

	Sound.prototype.play = function (opts) {
		if (opts && typeof opts.volume === "number") this.setVolume(opts.volume);
		if (!this.multiShot) {
			try { this._audio.currentTime = 0; } catch (e) { /* not ready yet, ignore */ }
		}
		var p = this._audio.play();
		if (p && typeof p.catch === "function") p.catch(function () { /* autoplay/user-gesture rejection, ignore */ });
		return this;
	};

	Sound.prototype.setVolume = function (v) {
		this._volume = Math.max(0, Math.min(100, v));
		this._audio.volume = clamp01(this._volume / 100);
	};

	Sound.prototype.stop = function () {
		try {
			this._audio.pause();
			this._audio.currentTime = 0;
		} catch (e) { /* ignore */ }
	};

	function SoundManagerShim() {
		this._sounds = {};
		this._defaults = {};
	}

	SoundManagerShim.prototype.setup = function (options) {
		options = options || {};
		// Synchronous on purpose: once SM2 has booted it runs onready callbacks immediately, and pgwheel.js relies on
		// that ("createSound({id: musSrc[musIndex]}) ... musIndex++" followed by getSoundById(musSrc[musIndex - 1])).
		if (options.defaultOptions) this._defaults = options.defaultOptions; // e.g. { volume: 2 } set once by pgwheel.js
		if (typeof options.onready === "function") options.onready();
		return this;
	};

	SoundManagerShim.prototype.createSound = function (options) {
		var merged = {}, k;
		for (k in this._defaults) merged[k] = this._defaults[k];
		for (k in options) merged[k] = options[k];
		var sound = new Sound(merged);
		if (options && options.id) this._sounds[options.id] = sound;
		return sound;
	};

	SoundManagerShim.prototype.getSoundById = function (id) {
		return this._sounds[id];
	};

	SoundManagerShim.prototype.play = function (id, opts) {
		var sound = this._sounds[id];
		if (sound) sound.play(opts);
	};

	SoundManagerShim.prototype.stopAll = function () {
		for (var id in this._sounds) {
			if (Object.prototype.hasOwnProperty.call(this._sounds, id)) this._sounds[id].stop();
		}
	};

	window.soundManager = new SoundManagerShim();
})(window);
