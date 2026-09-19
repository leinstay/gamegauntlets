import { test } from 'node:test';
import assert from 'node:assert/strict';

import { steamReviewLabel } from '../../src/lib/steam-review-label.js';

test('steamReviewLabel: null under 10 votes regardless of percent', () => {
  assert.equal(steamReviewLabel(100, 0), null);
  assert.equal(steamReviewLabel(100, 9), null);
  assert.equal(steamReviewLabel(0, 9), null);
});

test('steamReviewLabel: Overwhelmingly Positive needs both >=95% and >=500 votes', () => {
  assert.equal(steamReviewLabel(95, 500), 'Overwhelmingly Positive');
  assert.equal(steamReviewLabel(100, 10000), 'Overwhelmingly Positive');
  // >=95% but not enough votes -> falls through to Very Positive (>=80 & >=50).
  assert.equal(steamReviewLabel(95, 499), 'Very Positive');
});

test('steamReviewLabel: Very Positive needs both >=80% and >=50 votes', () => {
  assert.equal(steamReviewLabel(80, 50), 'Very Positive');
  assert.equal(steamReviewLabel(94, 499), 'Very Positive');
  // >=80% but under 50 votes -> falls through to plain Positive.
  assert.equal(steamReviewLabel(80, 49), 'Positive');
});

test('steamReviewLabel: Positive is >=80% regardless of vote count (once past the 10-vote floor)', () => {
  assert.equal(steamReviewLabel(80, 10), 'Positive');
  assert.equal(steamReviewLabel(99, 10), 'Positive');
});

test('steamReviewLabel: Mostly Positive is 70..79%', () => {
  assert.equal(steamReviewLabel(70, 10), 'Mostly Positive');
  assert.equal(steamReviewLabel(79, 10), 'Mostly Positive');
});

test('steamReviewLabel: Mixed is 40..69%', () => {
  assert.equal(steamReviewLabel(40, 10), 'Mixed');
  assert.equal(steamReviewLabel(69, 10), 'Mixed');
});

test('steamReviewLabel: Mostly Negative is 20..39%', () => {
  assert.equal(steamReviewLabel(20, 10), 'Mostly Negative');
  assert.equal(steamReviewLabel(39, 10), 'Mostly Negative');
});

test('steamReviewLabel: below 20% splits by vote count (Overwhelmingly/Very/plain Negative)', () => {
  assert.equal(steamReviewLabel(19, 500), 'Overwhelmingly Negative');
  assert.equal(steamReviewLabel(0, 500), 'Overwhelmingly Negative');
  assert.equal(steamReviewLabel(19, 50), 'Very Negative');
  assert.equal(steamReviewLabel(19, 499), 'Very Negative');
  assert.equal(steamReviewLabel(19, 10), 'Negative');
  assert.equal(steamReviewLabel(0, 49), 'Negative');
});

test('steamReviewLabel: boundary exactness at every threshold (one below each cutoff falls to the next bucket down)', () => {
  assert.equal(steamReviewLabel(94, 500), 'Very Positive'); // just under 95%
  assert.equal(steamReviewLabel(79, 1000), 'Mostly Positive'); // just under 80%, plenty of votes
  assert.equal(steamReviewLabel(69, 1000), 'Mixed'); // just under 70%
  assert.equal(steamReviewLabel(39, 1000), 'Mostly Negative'); // just under 40%
  assert.equal(steamReviewLabel(19, 1000), 'Overwhelmingly Negative'); // just under 20%, lots of votes
});

test('steamReviewLabel: non-finite/missing input is null', () => {
  assert.equal(steamReviewLabel(null, 100), null);
  assert.equal(steamReviewLabel(undefined, 100), null);
  assert.equal(steamReviewLabel(NaN, 100), null);
  assert.equal(steamReviewLabel(80, null), null);
  assert.equal(steamReviewLabel(80, undefined), null);
});
