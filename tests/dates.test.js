import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseDate, monthsBetween, comparePrecision } from '../src/lib/dates.js';

describe('parseDate - ISO and numeric formats', () => {
  test('ISO date', () => {
    assert.deepEqual(parseDate('2010-03-05'), { date: '2010-03-05', precision: 'day' });
  });
  test('ISO date-time', () => {
    assert.deepEqual(parseDate('2010-03-05T12:34:56Z'), { date: '2010-03-05', precision: 'day' });
  });
  test('unix seconds (number)', () => {
    // 2010-03-05T00:00:00Z
    assert.deepEqual(parseDate(1267747200), { date: '2010-03-05', precision: 'day' });
  });
  test('unix milliseconds (number)', () => {
    assert.deepEqual(parseDate(1267747200000), { date: '2010-03-05', precision: 'day' });
  });
  test('unix seconds (numeric string)', () => {
    assert.deepEqual(parseDate('1267747200'), { date: '2010-03-05', precision: 'day' });
  });
  test('unix milliseconds (numeric string)', () => {
    assert.deepEqual(parseDate('1267747200000'), { date: '2010-03-05', precision: 'day' });
  });
});

describe('parseDate - English month/day/year orderings', () => {
  test('"Mar 5, 2010" (month day, year)', () => {
    assert.deepEqual(parseDate('Mar 5, 2010'), { date: '2010-03-05', precision: 'day' });
  });
  test('"5 Mar, 2010" (day month, year)', () => {
    assert.deepEqual(parseDate('5 Mar, 2010'), { date: '2010-03-05', precision: 'day' });
  });
  test('"5 March 2010" (day month year)', () => {
    assert.deepEqual(parseDate('5 March 2010'), { date: '2010-03-05', precision: 'day' });
  });
  test('"March 2010" -> month precision, first of month', () => {
    assert.deepEqual(parseDate('March 2010'), { date: '2010-03-01', precision: 'month' });
  });
  test('"Mar 2010" -> month precision', () => {
    assert.deepEqual(parseDate('Mar 2010'), { date: '2010-03-01', precision: 'month' });
  });
});

describe('parseDate - quarters and bare years', () => {
  test('"Q2 2024" -> first day of Q2', () => {
    assert.deepEqual(parseDate('Q2 2024'), { date: '2024-04-01', precision: 'quarter' });
  });
  test('"Q2, 2024" (comma variant)', () => {
    assert.deepEqual(parseDate('Q2, 2024'), { date: '2024-04-01', precision: 'quarter' });
  });
  test('every quarter maps to the correct first month', () => {
    assert.equal(parseDate('Q1 2024').date, '2024-01-01');
    assert.equal(parseDate('Q3 2024').date, '2024-07-01');
    assert.equal(parseDate('Q4 2024').date, '2024-10-01');
  });
  test('"2019" -> year precision, Jan 1st', () => {
    assert.deepEqual(parseDate('2019'), { date: '2019-01-01', precision: 'year' });
  });
});

describe('parseDate - unknown placeholders', () => {
  for (const kw of ['Coming soon', 'TBA', 'To be announced', 'Soon', 'tba', 'COMING SOON']) {
    test(`${JSON.stringify(kw)} -> unknown`, () => {
      assert.deepEqual(parseDate(kw), { date: null, precision: 'unknown' });
    });
  }
  test('null/undefined/empty -> unknown', () => {
    assert.deepEqual(parseDate(null), { date: null, precision: 'unknown' });
    assert.deepEqual(parseDate(undefined), { date: null, precision: 'unknown' });
    assert.deepEqual(parseDate(''), { date: null, precision: 'unknown' });
    assert.deepEqual(parseDate('   '), { date: null, precision: 'unknown' });
  });
  test('unparseable garbage -> unknown', () => {
    assert.deepEqual(parseDate('¯\\_(ツ)_/¯'), { date: null, precision: 'unknown' });
  });
});

describe('parseDate - Russian formats', () => {
  test('"5 мар. 2010 г." (day abbrev-month year with г. marker)', () => {
    assert.deepEqual(parseDate('5 мар. 2010 г.'), { date: '2010-03-05', precision: 'day' });
  });
  test('"5 марта 2010" (day genitive-month year, no г.)', () => {
    assert.deepEqual(parseDate('5 марта 2010'), { date: '2010-03-05', precision: 'day' });
  });
  test('"март 2010" -> month precision', () => {
    assert.deepEqual(parseDate('март 2010'), { date: '2010-03-01', precision: 'month' });
  });
  test('"март 2010 г." -> month precision (г. stripped)', () => {
    assert.deepEqual(parseDate('март 2010 г.'), { date: '2010-03-01', precision: 'month' });
  });
  test('"2 кв. 2024" -> quarter precision', () => {
    assert.deepEqual(parseDate('2 кв. 2024'), { date: '2024-04-01', precision: 'quarter' });
  });
  test('"2 кв. 2024 г." -> quarter precision', () => {
    assert.deepEqual(parseDate('2 кв. 2024 г.'), { date: '2024-04-01', precision: 'quarter' });
  });
});

describe('parseDate - German and French month names', () => {
  test('German "5. März 2010"', () => {
    assert.deepEqual(parseDate('5. März 2010'), { date: '2010-03-05', precision: 'day' });
  });
  test('German "März 2010" -> month precision', () => {
    assert.deepEqual(parseDate('März 2010'), { date: '2010-03-01', precision: 'month' });
  });
  test('French "5 mars 2010"', () => {
    assert.deepEqual(parseDate('5 mars 2010'), { date: '2010-03-05', precision: 'day' });
  });
  test('French "mars 2010" -> month precision', () => {
    assert.deepEqual(parseDate('mars 2010'), { date: '2010-03-01', precision: 'month' });
  });
});

describe('parseDate - Steam release_date.date shapes', () => {
  test('Steam EN: "5 Mar, 2010"', () => {
    assert.deepEqual(parseDate('5 Mar, 2010'), { date: '2010-03-05', precision: 'day' });
  });
  test('Steam EN unreleased: "Coming soon"', () => {
    assert.deepEqual(parseDate('Coming soon'), { date: null, precision: 'unknown' });
  });
  test('Steam RU: "5 мар. 2010 г."', () => {
    assert.deepEqual(parseDate('5 мар. 2010 г.'), { date: '2010-03-05', precision: 'day' });
  });
});

describe('parseDate - invalid calendar dates are rejected', () => {
  test('Feb 30 is not a real date', () => {
    assert.deepEqual(parseDate('2021-02-30'), { date: null, precision: 'unknown' });
  });
  test('month 13 is not a real month', () => {
    assert.deepEqual(parseDate('2021-13-01'), { date: null, precision: 'unknown' });
  });
});

describe('monthsBetween', () => {
  test('same month is 0', () => {
    assert.equal(monthsBetween('2024-01-05', '2024-01-28'), 0);
  });
  test('counts whole calendar months, order-independent', () => {
    assert.equal(monthsBetween('2024-01-01', '2024-04-01'), 3);
    assert.equal(monthsBetween('2024-04-01', '2024-01-01'), 3);
  });
  test('spans years', () => {
    assert.equal(monthsBetween('2023-11-01', '2024-02-01'), 3);
  });
  test('accepts parseDate results directly', () => {
    const a = parseDate('Q1 2024');
    const b = parseDate('Q2 2024');
    assert.equal(monthsBetween(a, b), 3);
  });
  test('returns null when either side is unresolvable', () => {
    assert.equal(monthsBetween(null, '2024-01-01'), null);
    assert.equal(monthsBetween(parseDate('Coming soon'), '2024-01-01'), null);
  });
});

describe('comparePrecision', () => {
  test('day is more precise than month, quarter, year and unknown', () => {
    assert.ok(comparePrecision('day', 'month') > 0);
    assert.ok(comparePrecision('day', 'quarter') > 0);
    assert.ok(comparePrecision('day', 'year') > 0);
    assert.ok(comparePrecision('day', 'unknown') > 0);
  });
  test('month > quarter > year > unknown', () => {
    assert.ok(comparePrecision('month', 'quarter') > 0);
    assert.ok(comparePrecision('quarter', 'year') > 0);
    assert.ok(comparePrecision('year', 'unknown') > 0);
  });
  test('equal precisions compare as 0', () => {
    assert.equal(comparePrecision('month', 'month'), 0);
  });
  test('can sort a list from most to least precise', () => {
    const items = [{ precision: 'year' }, { precision: 'day' }, { precision: 'quarter' }, { precision: 'unknown' }, { precision: 'month' }];
    items.sort((x, y) => comparePrecision(y.precision, x.precision));
    assert.deepEqual(items.map((i) => i.precision), ['day', 'month', 'quarter', 'year', 'unknown']);
  });
});
