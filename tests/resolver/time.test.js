import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { finalTime, resolveAveragePlaytime } from '../../src/lib/resolver/time.js';

describe('finalTime: source priority (gateway.php ~247-253)', () => {
  test('prefers hltb_single (timeMain) over everything else', () => {
    const result = finalTime({ timeMain: 8, igdbSingle: 20, timeComplete: 15, igdbComplete: 30 });
    assert.equal(result.finalTime, 8);
  });

  test('falls back to igdbSingle when timeMain is empty', () => {
    const result = finalTime({ timeMain: null, igdbSingle: 12, timeComplete: 15, igdbComplete: 30 });
    assert.equal(result.finalTime, 12);
  });

  test('falls back to timeComplete when timeMain and igdbSingle are both empty', () => {
    const result = finalTime({ timeMain: 0, igdbSingle: null, timeComplete: 18, igdbComplete: 30 });
    assert.equal(result.finalTime, 18);
  });

  test('falls back to igdbComplete when only that is present', () => {
    const result = finalTime({ timeMain: null, igdbSingle: null, timeComplete: null, igdbComplete: 40 });
    assert.equal(result.finalTime, 40);
  });

  test('is 0 when nothing is available', () => {
    const result = finalTime({});
    assert.equal(result.finalTime, 0);
    assert.equal(result.timeComplete, 0);
  });
});

describe('finalTime: timeComplete adjustment (gateway.php ~255-258)', () => {
  test('bumps timeComplete to finalTime + 1 when finalTime exceeds it', () => {
    const result = finalTime({ timeMain: 20, timeComplete: 15 });
    assert.equal(result.finalTime, 20);
    assert.equal(result.timeComplete, 21);
  });

  test('leaves timeComplete alone when it already exceeds finalTime', () => {
    const result = finalTime({ timeMain: 10, timeComplete: 25 });
    assert.equal(result.finalTime, 10);
    assert.equal(result.timeComplete, 25);
  });

  test('bumps an empty/zero timeComplete too (PHP null > 0 comparison quirk)', () => {
    const result = finalTime({ timeMain: 5, timeComplete: null });
    assert.equal(result.finalTime, 5);
    assert.equal(result.timeComplete, 6);
  });

  test('falls back to igdbComplete for timeComplete when timeComplete never got a value and finalTime is 0', () => {
    const result = finalTime({ timeMain: null, igdbSingle: null, timeComplete: null, igdbComplete: 33 });
    assert.equal(result.finalTime, 33);
    // finalTime (33) > timeComplete (null/0) -> timeComplete bumped to 34, so igdbComplete fallback never applies here.
    assert.equal(result.timeComplete, 34);
  });

  test('uses igdbComplete for timeComplete only when timeComplete truly stays empty', () => {
    // finalTime derived from igdbComplete itself equals timeComplete's source, but timeComplete raw input is empty
    // and finalTime does not exceed it (both being derived from the same field) -> falls back to round(igdbComplete).
    const result = finalTime({ timeMain: null, igdbSingle: null, timeComplete: 0, igdbComplete: 0 });
    assert.equal(result.finalTime, 0);
    assert.equal(result.timeComplete, 0);
  });
});

describe('finalTime: rounding', () => {
  test('rounds finalTime and timeComplete half away from zero', () => {
    const result = finalTime({ timeMain: 10.5, timeComplete: 10.5 });
    assert.equal(result.finalTime, 11);
    // timeComplete raw (10.5) < finalTime raw (10.5)? equal, not >, so no bump; rounds directly.
    assert.equal(result.timeComplete, 11);
  });
});

describe('resolveAveragePlaytime: priority (Steam reviews >= minReviews > SteamSpy median > SteamSpy average > reviews < minReviews > legacy)', () => {
  test('prefers the Steam reviews median once there are at least minReviews reviews, even over SteamSpy', () => {
    const result = resolveAveragePlaytime({
      steamReviewsMedianMinutes: 300,
      steamReviewsCount: 25,
      steamspyMedianMinutes: 600,
      steamspyAverageMinutes: 1200,
      legacyMedianMinutes: 6000,
    });
    assert.deepEqual(result, { hours: 5, source: 'steam_reviews' }); // 300/60
  });

  test('respects a configured minReviews', () => {
    const fields = { steamReviewsMedianMinutes: 300, steamReviewsCount: 5, steamspyMedianMinutes: 600 };
    // Below the default (10) - SteamSpy wins.
    assert.deepEqual(resolveAveragePlaytime(fields), { hours: 10, source: 'steamspy' });
    // A lower configured minReviews (5) makes the same review count enough.
    assert.deepEqual(resolveAveragePlaytime(fields, { minReviews: 5 }), { hours: 5, source: 'steam_reviews' });
  });

  test('falls back to the reviews median with as few as 3 reviews once SteamSpy has nothing at all', () => {
    const result = resolveAveragePlaytime({ steamReviewsMedianMinutes: 120, steamReviewsCount: 3 });
    assert.deepEqual(result, { hours: 2, source: 'steam_reviews' }); // 120/60
  });

  test('does NOT use a reviews median below the 3-review floor - falls through to legacy instead', () => {
    const result = resolveAveragePlaytime({ steamReviewsMedianMinutes: 120, steamReviewsCount: 2, legacyMedianMinutes: 300 });
    assert.deepEqual(result, { hours: 5, source: 'legacy' }); // 300/60, reviews median (2 reviews) is skipped
  });

  test('prefers the SteamSpy median when present and reviews are below minReviews', () => {
    const result = resolveAveragePlaytime({
      steamReviewsMedianMinutes: 300,
      steamReviewsCount: 5,
      steamspyMedianMinutes: 600,
      steamspyAverageMinutes: 1200,
      legacyMedianMinutes: 6000,
    });
    assert.deepEqual(result, { hours: 10, source: 'steamspy' });
  });

  test('falls back to the SteamSpy average when the median is absent', () => {
    const result = resolveAveragePlaytime({ steamspyAverageMinutes: 90, legacyMedianMinutes: 6000 });
    assert.deepEqual(result, { hours: 1.5, source: 'steamspy' });
  });

  test('falls back to the SteamSpy average when the median is exactly 0 (SteamSpy\'s "no data" value)', () => {
    const result = resolveAveragePlaytime({ steamspyMedianMinutes: 0, steamspyAverageMinutes: 90 });
    assert.deepEqual(result, { hours: 1.5, source: 'steamspy' });
  });

  test('falls back to legacyMedianMinutes (stsp_mdntime) when SteamSpy has neither median nor average', () => {
    const result = resolveAveragePlaytime({ legacyMedianMinutes: 300 });
    assert.deepEqual(result, { hours: 5, source: 'legacy' });
  });

  test('null when nothing at all is available', () => {
    assert.equal(resolveAveragePlaytime({}), null);
    assert.equal(resolveAveragePlaytime(), null);
    assert.equal(resolveAveragePlaytime({ steamspyMedianMinutes: 0, steamspyAverageMinutes: 0, legacyMedianMinutes: 0 }), null);
  });
});

describe('resolveAveragePlaytime: minutes -> hours conversion (NOT the legacy /100 quirk)', () => {
  test('divides by 60 and rounds to one decimal place', () => {
    assert.deepEqual(resolveAveragePlaytime({ steamspyMedianMinutes: 100 }), { hours: 1.7, source: 'steamspy' }); // 100/60 = 1.666...
    assert.deepEqual(resolveAveragePlaytime({ steamspyMedianMinutes: 30 }), { hours: 0.5, source: 'steamspy' });
  });

  test('is NOT legacy\'s ceil(minutes/100) - e.g. 599 minutes is ~10 hours, not ceil(599/100)=6', () => {
    const result = resolveAveragePlaytime({ steamspyMedianMinutes: 599 });
    assert.equal(result.hours, 10); // 599/60 = 9.98(3) -> rounds to 10.0
  });
});
