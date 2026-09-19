// tests/frontend/wheel-plugin.test.js
//
// Verifies the rewritten public/js/plugins/wheel.js (see that file's header for what it keeps/drops)
// without a browser: both the new plugin and the untouched old plugin (copied into
// tests/fixtures/frontend/legacy-wheel/ before the rewrite) are loaded into their own node:vm
// contexts with a fake <canvas> 2D context that just records every call/property-set it receives.
//
// (a) angle/segment math, (b) animation timing/callbacks/easing, (c) hidden-tab fallback are tested
// against the new plugin directly. The differential test at the bottom re-runs the exact same
// drawSegments() scenario against both plugins and asserts the recorded canvas call logs match,
// which is the proof that the customised drawing (segment fill + per-segment cover-image pattern)
// was ported pixel-for-pixel.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NEW_PLUGIN_PATH = path.join(__dirname, '../../public/js/plugins/wheel.js');
const LEGACY_DIR = path.join(__dirname, '../fixtures/frontend/legacy-wheel');

// ---- fake DOM / canvas ----------------------------------------------------------------------

// Records every method call and property assignment made on the 2D context, in order, so two runs
// (old plugin vs new plugin) can be compared call-for-call.
function createRecordingContext() {
	const calls = [];
	const ctx = {};
	const trackedProps = ['lineWidth', 'strokeStyle', 'fillStyle', 'globalAlpha', 'font', 'textAlign', 'textBaseline'];
	trackedProps.forEach((prop) => {
		let value;
		Object.defineProperty(ctx, prop, {
			get() { return value; },
			set(next) { value = next; calls.push({ op: 'set:' + prop, value: next }); },
			enumerable: true,
		});
	});
	['beginPath', 'moveTo', 'lineTo', 'arc', 'fill', 'stroke', 'save', 'restore', 'translate', 'rotate', 'scale', 'clearRect', 'fillText', 'strokeText', 'drawImage'].forEach((method) => {
		ctx[method] = (...args) => { calls.push({ op: method, args }); };
	});
	// A real CanvasPattern isn't comparable across two separate vm realms; return a small tagged
	// object instead so two structurally-identical patterns (same source image, same repetition)
	// compare equal under deepStrictEqual even though they're different object instances.
	ctx.createPattern = (image, repetition) => {
		calls.push({ op: 'createPattern', args: [image && image.id, repetition] });
		return { __fakePattern: true, imageId: image && image.id, repetition };
	};
	ctx.__calls = calls;
	return ctx;
}

function createFakeCanvas(ctx, width, height) {
	return {
		id: 'canvas',
		width,
		height,
		getContext: () => ctx,
		// left/top 0 and width/height matching the canvas keeps windowToCanvas() a straight passthrough
		// so hit-test scenarios stay easy to reason about (the scaled case has its own test).
		getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
	};
}

// A tiny controllable clock shared by requestAnimationFrame/setTimeout so animation tests can
// advance time in exact, deterministic steps instead of waiting on a real timer.
function createClock() {
	let now = 0;
	let nextId = 1;
	let rafQueue = [];
	let timeoutQueue = [];
	return {
		now: () => now,
		requestAnimationFrame(cb) { const id = nextId++; rafQueue.push({ id, cb }); return id; },
		cancelAnimationFrame(id) { rafQueue = rafQueue.filter((x) => x.id !== id); },
		setTimeout(cb, ms) { const id = nextId++; timeoutQueue.push({ id, cb, time: now + ms }); return id; },
		clearTimeout(id) { timeoutQueue = timeoutQueue.filter((x) => x.id !== id); },
		// Advances the clock and runs whatever was pending (one rAF "frame" plus any due timeouts).
		tick(ms) {
			now += ms;
			const raf = rafQueue; rafQueue = [];
			raf.forEach((entry) => entry.cb(now));
			const due = timeoutQueue.filter((x) => x.time <= now);
			timeoutQueue = timeoutQueue.filter((x) => x.time > now);
			due.forEach((entry) => entry.cb());
		},
	};
}

// Builds a fresh vm context with a canvas, `numSegments` fake <img id="imN"> elements
// ({complete:true, width:460, height:215} per the task's fixture spec), a controllable clock, and
// the globals a classic script expects (window/document/requestAnimationFrame/setTimeout/Date...).
function createSandbox({ numSegments = 12, canvasWidth = 700, canvasHeight = 700 } = {}) {
	const recCtx = createRecordingContext();
	const canvas = createFakeCanvas(recCtx, canvasWidth, canvasHeight);
	const clock = createClock();
	const images = {};
	for (let i = 1; i <= numSegments; i++) {
		images['im' + i] = { id: 'im' + i, complete: true, width: 460, height: 215 };
	}
	const documentObj = {
		hidden: false,
		getElementById(id) {
			if (id === 'canvas') return canvas;
			if (images[id]) return images[id];
			return null;
		},
		addEventListener() {},
		removeEventListener() {},
	};

	const RealDate = Date;
	function FakeDate(...args) { return args.length ? new RealDate(...args) : new RealDate(clock.now()); }
	FakeDate.now = () => clock.now();
	FakeDate.prototype = RealDate.prototype;

	const sandbox = {
		document: documentObj,
		console,
		Math,
		Date: FakeDate,
		requestAnimationFrame: (cb) => clock.requestAnimationFrame(cb),
		cancelAnimationFrame: (id) => clock.cancelAnimationFrame(id),
		setTimeout: (cb, ms) => clock.setTimeout(cb, ms),
		clearTimeout: (id) => clock.clearTimeout(id),
		performance: { now: () => clock.now() },
	};
	const context = vm.createContext(sandbox);
	context.window = context;
	context.globalThis = context;
	context.addEventListener = () => {};
	context.removeEventListener = () => {};

	return { context, recCtx, canvas, documentObj, clock, images };
}

function runScript(context, code, filename) {
	new vm.Script(code, { filename }).runInContext(context);
}

const NEW_PLUGIN_CODE = fs.readFileSync(NEW_PLUGIN_PATH, 'utf8');
const LEGACY_TWEENLITE_CODE = fs.readFileSync(path.join(LEGACY_DIR, 'tweenlite.js'), 'utf8');
const LEGACY_WHEEL_CODE = fs.readFileSync(path.join(LEGACY_DIR, 'wheel.js'), 'utf8');

function loadNewWheel(opts) {
	const env = createSandbox(opts);
	runScript(env.context, NEW_PLUGIN_CODE, 'new-wheel.js');
	return env;
}

function loadLegacyWheel(opts) {
	const env = createSandbox(opts);
	runScript(env.context, LEGACY_TWEENLITE_CODE, 'legacy-tweenlite.js');
	runScript(env.context, LEGACY_WHEEL_CODE, 'legacy-wheel.js');
	return env;
}

// A handful of game-shaped segment objects, like the API/gateway would hand the wheel.
function fakeGames(n) {
	const out = [];
	for (let i = 0; i < n; i++) out.push({ name: 'Game ' + i, segpic: '/img/' + i + '.jpg' });
	return out;
}

// ---- (a) angle / segment math -----------------------------------------------------------------

describe('segment angle math', () => {
	for (const numSegments of [6, 12, 16]) {
		test(`getIndicatedSegment() matches the segment containing stopAngle (N=${numSegments})`, () => {
			const { context } = loadNewWheel({ numSegments });
			const stopAngles = [0, 1, 15, 44, 45, 90, 179, 180, 200, 270, 300, 359];
			for (const stopAngle of stopAngles) {
				const wheel = new context.Winwheel({
					numSegments,
					outerRadius: 245,
					segments: fakeGames(numSegments),
					animation: { type: 'spinToStop', spins: 3, stopAngle },
				});
				wheel.animation.computeTarget();
				wheel.rotationAngle = wheel.animation.propertyValue;

				const indicated = wheel.getIndicatedSegmentNumber();
				// The segment that geometrically contains `stopAngle` on the un-rotated wheel is the
				// one whose [startAngle, endAngle) range contains it.
				let expected = null;
				for (let i = 1; i <= numSegments; i++) {
					const seg = wheel.segments[i];
					if (stopAngle >= seg.startAngle && stopAngle < seg.endAngle) { expected = i; break; }
				}
				// stopAngle exactly on a boundary (e.g. 45 on a 12-segment wheel) can round to either
				// neighbour once floating point/Math.floor are involved — accept both neighbours only
				// in that edge case, otherwise require an exact match.
				if (expected !== indicated) {
					const seg = wheel.segments[indicated];
					assert.ok(
						stopAngle >= seg.startAngle - 1e-9 && stopAngle <= seg.endAngle + 1e-9,
						`N=${numSegments} stopAngle=${stopAngle}: indicated segment ${indicated} [${seg.startAngle},${seg.endAngle}) does not contain it`
					);
				}
			}
		});
	}

	test('getRandomForSegment() always lies inside the requested segment', () => {
		const { context } = loadNewWheel({ numSegments: 12 });
		const wheel = new context.Winwheel({ numSegments: 12, outerRadius: 245, segments: fakeGames(12) });
		for (let trial = 0; trial < 200; trial++) {
			const segmentNumber = 1 + (trial % 12);
			const angle = wheel.getRandomForSegment(segmentNumber);
			const seg = wheel.segments[segmentNumber];
			assert.ok(angle >= seg.startAngle && angle <= seg.endAngle, `angle ${angle} outside [${seg.startAngle}, ${seg.endAngle}]`);
		}
	});

	// A point at `angleDeg` clockwise from straight up, `radius` px from (centerX, centerY) — matches
	// the screen-space convention getSegmentNumberAt()/windowToCanvas() work in.
	function pointAtAngle(centerX, centerY, radius, angleDeg) {
		const rad = angleDeg * (Math.PI / 180);
		return { x: centerX + radius * Math.sin(rad), y: centerY - radius * Math.cos(rad) };
	}

	test('getSegmentAt() hit-tests known points, including after rotation', () => {
		const numSegments = 12; // 30 degrees per wedge
		const { context } = loadNewWheel({ numSegments, canvasWidth: 500, canvasHeight: 500 });
		const wheel = new context.Winwheel({
			numSegments,
			outerRadius: 200,
			segments: fakeGames(numSegments),
		});
		wheel.centerX = 250;
		wheel.centerY = 250;

		// Mid-segment-1 (15 degrees clockwise from straight up, segment 1 spans [0,30)).
		const midSeg1 = pointAtAngle(250, 250, 100, 15);
		assert.equal(wheel.getSegmentAt(midSeg1.x, midSeg1.y), wheel.segments[1]);

		// Mid-segment-7 (195 degrees, segment 7 spans [180,210)).
		const midSeg7 = pointAtAngle(250, 250, 100, 195);
		assert.equal(wheel.getSegmentAt(midSeg7.x, midSeg7.y), wheel.segments[7]);

		// Outside outerRadius: no hit.
		assert.equal(wheel.getSegmentAt(250, 5), null);

		// Rotating the wheel 90 degrees clockwise shifts every wedge's on-screen position by +90deg,
		// which is the same as subtracting 90 from the screen angle before looking up the segment:
		// the point that used to sit over segment 1 (at 15deg) now sits over whatever wedge covers
		// (15-90) mod 360 = 285deg, i.e. segment 10 ([270,300)).
		wheel.rotationAngle = 90;
		assert.equal(wheel.getSegmentNumberAt(midSeg1.x, midSeg1.y), 10);
	});

	test('getSegmentAt() maps viewport points correctly when the canvas is offset and CSS-scaled', () => {
		const numSegments = 12;
		const { context } = loadNewWheel({ numSegments, canvasWidth: 500, canvasHeight: 500 });
		const wheel = new context.Winwheel({
			numSegments,
			outerRadius: 200,
			segments: fakeGames(numSegments),
		});
		wheel.centerX = 250;
		wheel.centerY = 250;
		// A 500x500 canvas shown as 250x250 with its top-left corner at (300, 120) in the viewport.
		wheel.canvas.getBoundingClientRect = () => ({ left: 300, top: 120, width: 250, height: 250 });
		const toViewport = (p) => ({ x: 300 + p.x / 2, y: 120 + p.y / 2 });

		for (const [angle, expected] of [[15, 1], [105, 4], [195, 7], [285, 10]]) {
			const v = toViewport(pointAtAngle(250, 250, 150, angle));
			assert.equal(wheel.getSegmentNumberAt(v.x, v.y), expected, `angle ${angle}`);
		}
		const outside = toViewport(pointAtAngle(250, 250, 230, 15));
		assert.equal(wheel.getSegmentNumberAt(outside.x, outside.y), null);
	});
});

// ---- (b) animation ---------------------------------------------------------------------------

describe('animation', () => {
	test('duration is respected and callbackAfter runs once per frame', () => {
		const { context, clock } = loadNewWheel({ numSegments: 12 });
		let afterCount = 0;
		let finishedCount = 0;
		const wheel = new context.Winwheel({
			numSegments: 12,
			outerRadius: 245,
			segments: fakeGames(12),
			animation: {
				type: 'spinToStop', easing: 'Linear.easeNone', spins: 2, duration: 1, stopAngle: 10,
				callbackAfter: () => afterCount++,
				callbackFinished: () => finishedCount++,
			},
		});
		wheel.startAnimation();

		clock.tick(0); // primes startTime at t=0
		assert.equal(afterCount, 1);
		clock.tick(250);
		assert.equal(afterCount, 2);
		clock.tick(250);
		assert.equal(afterCount, 3);
		assert.equal(finishedCount, 0);
		clock.tick(500); // reaches the 1000ms duration
		assert.equal(afterCount, 4);
		assert.equal(finishedCount, 1);

		// no further frames scheduled after completion
		clock.tick(1000);
		assert.equal(afterCount, 4);
		assert.equal(finishedCount, 1);
	});

	test('stopAnimation(false) cancels without calling callbackFinished', () => {
		const { context, clock } = loadNewWheel({ numSegments: 12 });
		let finishedCount = 0;
		const wheel = new context.Winwheel({
			numSegments: 12,
			outerRadius: 245,
			segments: fakeGames(12),
			animation: {
				type: 'spinToStop', spins: 5, duration: 10, stopAngle: 10,
				callbackFinished: () => finishedCount++,
			},
		});
		wheel.startAnimation();
		clock.tick(0);
		clock.tick(100);
		wheel.stopAnimation(false);
		clock.tick(20000); // nothing left scheduled; should not fire even if it were
		assert.equal(finishedCount, 0);
	});

	test('stopAnimation() (no args) calls callbackFinished, matching the old plugin default', () => {
		const { context, clock } = loadNewWheel({ numSegments: 12 });
		let finishedCount = 0;
		const wheel = new context.Winwheel({
			numSegments: 12,
			outerRadius: 245,
			segments: fakeGames(12),
			animation: { type: 'spinToStop', spins: 1, duration: 10, stopAngle: 10, callbackFinished: () => finishedCount++ },
		});
		wheel.startAnimation();
		clock.tick(0);
		wheel.stopAnimation();
		assert.equal(finishedCount, 1);
	});

	test('callback strings ("name()") are supported like the old eval-based ones', () => {
		const { context, clock } = loadNewWheel({ numSegments: 12 });
		context.finishedFlag = 0;
		new vm.Script('function markFinished() { finishedFlag++; }').runInContext(context);
		const wheel = new context.Winwheel({
			numSegments: 12,
			outerRadius: 245,
			segments: fakeGames(12),
			animation: { type: 'spinToStop', spins: 1, duration: 1, stopAngle: 10, callbackFinished: 'markFinished()' },
		});
		wheel.startAnimation();
		clock.tick(0);
		clock.tick(2000);
		assert.equal(context.finishedFlag, 1);
	});

	const EASE_FORMULAS = {
		'Power2.easeOut': (t) => 1 - Math.pow(1 - t, 3),
		'Power2.easeInOut': (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
		'Power4.easeOut': (t) => 1 - Math.pow(1 - t, 5),
		'Linear.easeNone': (t) => t,
	};

	for (const easing of Object.keys(EASE_FORMULAS)) {
		test(`easing sample values match the formula for ${easing}`, () => {
			const { context, clock } = loadNewWheel({ numSegments: 12 });
			const wheel = new context.Winwheel({
				numSegments: 12,
				outerRadius: 245,
				segments: fakeGames(12),
				animation: { type: 'spinToStop', easing, spins: 4, duration: 10, stopAngle: 33 },
			});
			wheel.startAnimation();
			const target = wheel.animation.propertyValue;
			clock.tick(0); // t=0, startTime established
			for (const fraction of [0.25, 0.5, 0.75]) {
				clock.tick(2500); // +25% of the 10000ms duration each step
				const t = clock.now() / 10000;
				const expected = target * EASE_FORMULAS[easing](Math.min(t, 1));
				assert.ok(Math.abs(wheel.rotationAngle - expected) < 1e-6, `${easing} at t=${fraction}: got ${wheel.rotationAngle}, expected ${expected}`);
			}
		});
	}
});

// ---- (c) hidden tab fallback -------------------------------------------------------------------

test('a spin still completes via setTimeout fallback while the tab is hidden', () => {
	const { context, clock, documentObj } = loadNewWheel({ numSegments: 12 });
	documentObj.hidden = true;
	let finishedCount = 0;
	const wheel = new context.Winwheel({
		numSegments: 12,
		outerRadius: 245,
		segments: fakeGames(12),
		animation: { type: 'spinToStop', spins: 1, duration: 0.5, stopAngle: 10, callbackFinished: () => finishedCount++ },
	});
	wheel.startAnimation();
	clock.tick(0);
	// Drive it forward in 16ms setTimeout-fallback steps, as a hidden tab would.
	for (let i = 0; i < 40 && finishedCount === 0; i++) clock.tick(16);
	assert.equal(finishedCount, 1);
});

// ---- differential test: identical canvas drawing vs the old plugin ----------------------------

describe('differential: drawSegments() matches the old plugin call-for-call', () => {
	// Compares two recorded call logs allowing tiny floating point differences (<1e-9) in numeric
	// arguments/values, since the two implementations may reassociate arithmetic differently.
	function assertCallsMatch(actual, expected, label) {
		assert.equal(actual.length, expected.length, `${label}: different number of canvas calls (${actual.length} vs ${expected.length})`);
		for (let i = 0; i < expected.length; i++) {
			const a = actual[i];
			const e = expected[i];
			assert.equal(a.op, e.op, `${label}: call #${i} op mismatch`);
			const aVals = a.args || [a.value];
			const eVals = e.args || [e.value];
			assert.equal(aVals.length, eVals.length, `${label}: call #${i} (${a.op}) arg count mismatch`);
			for (let j = 0; j < eVals.length; j++) {
				const av = aVals[j];
				const ev = eVals[j];
				if (typeof ev === 'number' && typeof av === 'number') {
					assert.ok(Math.abs(av - ev) < 1e-9, `${label}: call #${i} (${a.op}) arg ${j}: ${av} !== ${ev}`);
				} else {
					assert.deepStrictEqual(av, ev, `${label}: call #${i} (${a.op}) arg ${j} mismatch`);
				}
			}
		}
	}

	// Builds one wheel of each flavour with identical options/state and calls createPatterns() +
	// drawSegments() (the customised drawing method) on each, returning both call logs.
	function drawBoth({ numSegments, outerRadius, lineWidth, alpha, rotationAngle, dynamicImages }) {
		const newEnv = loadNewWheel({ numSegments });
		const legacyEnv = loadLegacyWheel({ numSegments });
		const games = fakeGames(numSegments);

		const options = {
			numSegments,
			outerRadius,
			innerRadius: 0,
			lineWidth,
			strokeStyle: 'white',
			textFillStyle: 'white',
			textFontSize: 35,
			fillStyle: 'rgba(40, 40, 40, 0.8)',
			alpha,
			dynamicImages,
			segments: games,
		};

		const newWheel = new newEnv.context.Winwheel(options);
		const legacyWheel = new legacyEnv.context.Winwheel(options, false); // false: don't auto-draw yet

		newWheel.centerX = legacyWheel.centerX = outerRadius + 10;
		newWheel.centerY = legacyWheel.centerY = outerRadius + 10;
		newWheel.rotationAngle = legacyWheel.rotationAngle = rotationAngle;
		// One highlighted segment at full alpha, as highlightGame()/endWheel() do in pgwheel.js.
		newWheel.segments[3].alpha = legacyWheel.segments[3].alpha = 1;

		newWheel.createPatterns();
		legacyWheel.createPatterns();
		newEnv.recCtx.__calls.length = 0;
		legacyEnv.recCtx.__calls.length = 0;

		newWheel.drawSegments();
		legacyWheel.drawSegments();

		return { newCalls: newEnv.recCtx.__calls, legacyCalls: legacyEnv.recCtx.__calls };
	}

	const scenarios = [];
	for (const alpha of [1, 0.1]) {
		for (const rotationAngle of [0, 137.5]) {
			for (const outerRadius of [245, 150]) {
				scenarios.push({ numSegments: 12, outerRadius, lineWidth: 5, alpha, rotationAngle, dynamicImages: true });
			}
		}
	}
	// Also cover the non-dynamicImages placement branch once.
	scenarios.push({ numSegments: 12, outerRadius: 245, lineWidth: 5, alpha: 1, rotationAngle: 0, dynamicImages: false });

	for (const scenario of scenarios) {
		const label = JSON.stringify(scenario);
		test(`drawSegments() identical for ${label}`, () => {
			const { newCalls, legacyCalls } = drawBoth(scenario);
			assertCallsMatch(newCalls, legacyCalls, label);
		});
	}

	// draw()/the constructor's auto-draw call also run drawSegmentText() in the old plugin. On this
	// site every segment's `.text` is always "" (segments are game objects, they never set `.text`),
	// so the old drawSegmentText() never draws a single character — it only wastes one
	// ctx.save()/ctx.restore() pair per segment. The new plugin drops that dead feature entirely (see
	// the file header), so draw()'s call log is the drawSegments() log without those no-op pairs.
	test('draw() matches drawSegments() plus a clearRect, with the old plugin\'s dead per-segment save/restore pairs intentionally dropped', () => {
		const numSegments = 12;
		const newEnv = loadNewWheel({ numSegments });
		const legacyEnv = loadLegacyWheel({ numSegments });
		const games = fakeGames(numSegments);
		const options = {
			numSegments,
			outerRadius: 245,
			innerRadius: 0,
			lineWidth: 5,
			strokeStyle: 'white',
			fillStyle: 'rgba(40, 40, 40, 0.8)',
			alpha: 1,
			dynamicImages: true,
			segments: games,
		};
		const newWheel = new newEnv.context.Winwheel(options);
		const legacyWheel = new legacyEnv.context.Winwheel(options, false);
		newWheel.createPatterns();
		legacyWheel.createPatterns();

		newEnv.recCtx.__calls.length = 0;
		legacyEnv.recCtx.__calls.length = 0;
		newWheel.draw();
		legacyWheel.draw();

		const legacyWithoutTextNoOps = legacyEnv.recCtx.__calls.filter((call, idx, arr) => {
			// Drop each save()/restore() pair that has nothing between them (drawSegmentText's no-op
			// per-segment save/restore, since seg.text is always "").
			if (call.op === 'save' && arr[idx + 1] && arr[idx + 1].op === 'restore') return false;
			if (call.op === 'restore' && arr[idx - 1] && arr[idx - 1].op === 'save') return false;
			return true;
		});
		assertCallsMatch(newEnv.recCtx.__calls, legacyWithoutTextNoOps, 'draw()');
	});
});
