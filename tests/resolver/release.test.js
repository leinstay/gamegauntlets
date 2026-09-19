import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { legacyRelease, legacyMonthsDiff, resolveRelease } from '../../src/lib/resolver/release.js';

describe('legacyMonthsDiff: PHP DateInterval-exact (day-of-month borrowing)', () => {
  test('is symmetric', () => {
    assert.equal(legacyMonthsDiff('2020-01-01', '2020-06-01'), legacyMonthsDiff('2020-06-01', '2020-01-01'));
  });

  test('borrows a month when the day-of-month has not been reached', () => {
    // 2020-01-31 -> 2020-03-01: only 1 full calendar month has elapsed (Jan 31 -> Feb 31(doesn't exist)/Mar 1).
    assert.equal(legacyMonthsDiff('2020-01-31', '2020-03-01'), 1);
  });

  test('does not borrow when the day-of-month has been reached or passed', () => {
    assert.equal(legacyMonthsDiff('2020-01-01', '2020-03-01'), 2);
    assert.equal(legacyMonthsDiff('2020-01-01', '2020-03-02'), 2);
  });

  test('handles a year boundary', () => {
    assert.equal(legacyMonthsDiff('2019-11-01', '2020-02-01'), 3);
  });
});

describe('legacyRelease: exact port of gateway.php ~166-189', () => {
  test('non-Steam platform always uses the store date first', () => {
    const date = legacyRelease({
      store_platform: 'GOG',
      published_store: '2015-06-01',
      published_meta: '2015-06-05',
      published_stsp: null,
      published_hltb: null,
    });
    assert.equal(date, '2015-06-01');
  });

  test('all four dates present and three-way agreement within 8 months -> findequaldates wins', () => {
    const date = legacyRelease({
      store_platform: 'Steam',
      published_meta: '2015-01-10',
      published_stsp: '2015-02-10',
      published_hltb: '2015-03-10',
      published_store: '2018-01-01', // far off, but meta/stsp/hltb all agree pairwise
    });
    // meta<->stsp = 1mo, meta<->hltb = 2mo, stsp<->hltb = 1mo: all 3 of those pairs are <=8 -> count=3 -> matches.
    // findequaldates returns the LAST matching $dates[$i] in iteration order (i<j): pairs are (0,1)(0,2)(0,3)(1,2)(1,3)(2,3).
    // (0,1)=meta/stsp match, (0,2)=meta/hltb match, (1,2)=stsp/hltb match; (0,3)/(1,3)/(2,3) all involve the far store date, no match.
    // Last matching pair is (1,2) -> found = dates[1] = stsp.
    assert.equal(date, '2015-02-10');
  });

  test('meta and stsp agree within 8 months -> meta wins (gateway.php d1d2 branch)', () => {
    const date = legacyRelease({
      store_platform: 'Steam',
      published_meta: '2015-01-01',
      published_stsp: '2015-03-01',
      published_hltb: null,
      published_store: '2018-01-01',
    });
    assert.equal(date, '2015-01-01');
  });

  test('meta and hltb agree within 8 months (no stsp) -> meta wins', () => {
    const date = legacyRelease({
      store_platform: 'Steam',
      published_meta: '2015-01-01',
      published_stsp: null,
      published_hltb: '2015-04-01',
      published_store: '2018-01-01',
    });
    assert.equal(date, '2015-01-01');
  });

  test('stsp and hltb agree within 8 months (no meta) -> stsp wins', () => {
    const date = legacyRelease({
      store_platform: 'Steam',
      published_meta: null,
      published_stsp: '2015-01-01',
      published_hltb: '2015-05-01',
      published_store: '2018-01-01',
    });
    assert.equal(date, '2015-01-01');
  });

  test('stsp present and different from store, nothing else agrees -> stsp wins', () => {
    const date = legacyRelease({
      store_platform: 'Steam',
      published_meta: null,
      published_stsp: '2015-01-01',
      published_hltb: null,
      published_store: '2018-01-01',
    });
    assert.equal(date, '2015-01-01');
  });

  test('final fallback priority: meta > hltb > stsp > store', () => {
    assert.equal(
      legacyRelease({ store_platform: 'Steam', published_meta: '2015-01-01', published_stsp: null, published_hltb: null, published_store: null }),
      '2015-01-01'
    );
    assert.equal(
      legacyRelease({ store_platform: 'Steam', published_meta: null, published_stsp: null, published_hltb: '2015-02-01', published_store: null }),
      '2015-02-01'
    );
    assert.equal(
      legacyRelease({ store_platform: 'Steam', published_meta: null, published_stsp: null, published_hltb: null, published_store: '2015-03-01' }),
      '2015-03-01'
    );
  });

  test('nothing at all -> null', () => {
    assert.equal(
      legacyRelease({ store_platform: 'Steam', published_meta: null, published_stsp: null, published_hltb: null, published_store: null }),
      null
    );
  });
});

describe('resolveRelease: source-agnostic algorithm (spec 6.1)', () => {
  const opts = { releaseToleranceMonths: 8, oldGameRuleMonths: 12 };

  test('two independent sources agreeing beats the store date, regardless of gap size', () => {
    const result = resolveRelease(
      [
        { source: 'igdb', kind: 'independent', date: '2015-01-01', precision: 'day' },
        { source: 'gamefaqs', kind: 'independent', date: '2015-02-01', precision: 'day' },
        { source: 'steam', kind: 'store', date: '2020-01-01', precision: 'day' },
      ],
      opts
    );
    assert.equal(result.date, '2015-01-01'); // most precise+earliest of the agreeing cluster
    assert.equal(result.conflict, null);
    assert.equal(result.storeDate, '2020-01-01');
  });

  test('a lone independent source far earlier than the store triggers the old-game rule', () => {
    const result = resolveRelease(
      [
        { source: 'igdb', kind: 'independent', date: '2010-01-01', precision: 'day' },
        { source: 'steam', kind: 'store', date: '2022-01-01', precision: 'day' },
      ],
      opts
    );
    assert.equal(result.date, '2010-01-01');
    assert.equal(result.conflict, null);
  });

  test('a lone independent source close to the store date defers to the store (not a strong enough override)', () => {
    const result = resolveRelease(
      [
        { source: 'igdb', kind: 'independent', date: '2020-03-01', precision: 'day' },
        { source: 'steam', kind: 'store', date: '2020-01-01', precision: 'day' },
      ],
      opts
    );
    assert.equal(result.date, '2020-03-01');
    assert.equal(result.conflict, null);
  });

  test('multiple independent sources disagreeing with each other and not old-game vs. store -> conflict, store used', () => {
    const result = resolveRelease(
      [
        { source: 'igdb', kind: 'independent', date: '2019-01-01', precision: 'day' },
        { source: 'gamefaqs', kind: 'independent', date: '2020-06-01', precision: 'day' },
        { source: 'steam', kind: 'store', date: '2019-06-01', precision: 'day' },
      ],
      opts
    );
    assert.equal(result.date, '2019-06-01');
    assert.ok(result.conflict);
    assert.equal(result.conflict.candidates.length, 2);
  });

  test('only a store date available -> low-confidence store date, no conflict', () => {
    const result = resolveRelease([{ source: 'steam', kind: 'store', date: '2021-01-01', precision: 'day' }], opts);
    assert.equal(result.date, '2021-01-01');
    assert.equal(result.confidence, 30);
  });

  test('nothing at all -> unknown, no crash', () => {
    const result = resolveRelease([], opts);
    assert.equal(result.date, null);
    assert.equal(result.precision, 'unknown');
  });

  test('early access is echoed through untouched and excluded from date resolution', () => {
    const result = resolveRelease([{ source: 'steam', kind: 'store', date: '2021-01-01', precision: 'day' }], {
      ...opts,
      earlyAccess: { date: '2020-01-01', precision: 'day' },
    });
    assert.equal(result.earlyAccess, '2020-01-01');
    assert.equal(result.date, '2021-01-01');
  });

  test('more precise date wins inside an agreeing cluster', () => {
    const result = resolveRelease(
      [
        { source: 'igdb', kind: 'independent', date: '2015-01-01', precision: 'year' },
        { source: 'gamefaqs', kind: 'independent', date: '2015-03-15', precision: 'day' },
      ],
      opts
    );
    assert.equal(result.date, '2015-03-15');
    assert.equal(result.precision, 'day');
  });
});
