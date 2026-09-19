import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ggp } from '../../src/lib/resolver/ggp.js';
import { config } from '../../src/config.js';

const TABLES = config.resolver.ggp;

describe('ggp: defaults when a source is missing (gateway.php ~267)', () => {
  test('all defaults when nothing is provided', () => {
    const { ggp: value, parts } = ggp({}, TABLES);
    // defaults: time 30, score 15, owners 5, difficulty 20 -> sum 70; price < 10000 (missing -> 0) -> multiplier 1
    assert.equal(value, 70);
    assert.deepEqual(
      { time: parts.time, score: parts.score, owners: parts.owners, difficulty: parts.difficulty },
      { time: 30, score: 15, owners: 5, difficulty: 20 }
    );
  });
});

describe('ggp: difficulty table (gateway.php ~270-280)', () => {
  for (const [difficulty, expected] of [
    ['Simple', 0],
    ['Simple-Easy', 5],
    ['Easy', 10],
    ['Easy-Just Right', 15],
    ['Just Right', 20],
    ['Just Right-Tough', 25],
    ['Tough', 30],
    ['Tough-Unforgiving', 35],
    ['Unforgiving', 40],
  ]) {
    test(`'${difficulty}' -> ${expected}`, () => {
      const { parts } = ggp({ difficulty }, TABLES);
      assert.equal(parts.difficulty, expected);
    });
  }

  test('unknown difficulty string keeps the default (20)', () => {
    const { parts } = ggp({ difficulty: 'Not A Real Difficulty' }, TABLES);
    assert.equal(parts.difficulty, 20);
  });
});

describe('ggp: time table (gateway.php ~283-297)', () => {
  test('<=10 hours: linear, 5 points per hour, no bonus', () => {
    assert.equal(ggp({ finalTime: 4 }, TABLES).parts.time, 20);
    assert.equal(ggp({ finalTime: 10 }, TABLES).parts.time, 50);
  });

  for (const [hours, value] of [
    [11, 60],
    [12, 70],
    [13, 80],
    [14, 90],
    [15, 100],
  ]) {
    test(`exactly ${hours} hours -> ${value}, no bonus`, () => {
      const { parts } = ggp({ finalTime: hours }, TABLES);
      assert.equal(parts.time, value);
      assert.equal(parts.timeBonus, 0);
    });
  }

  for (const [hours, bonus] of [
    [16, 10],
    [18, 10],
    [19, 20],
    [21, 20],
    [24, 30],
    [27, 40],
    [28, 50],
    [100, 50],
  ]) {
    test(`${hours} hours -> value 100, bonus ${bonus}`, () => {
      const { parts } = ggp({ finalTime: hours }, TABLES);
      assert.equal(parts.time, 100);
      assert.equal(parts.timeBonus, bonus);
    });
  }

  test('missing finalTime keeps the default (30) and bonus 0', () => {
    const { parts } = ggp({}, TABLES);
    assert.equal(parts.time, 30);
    assert.equal(parts.timeBonus, 0);
  });
});

describe('ggp: score brackets (gateway.php ~300-308)', () => {
  for (const [finalScore, value] of [
    [30, 10],
    [31, 15],
    [39, 15],
    [40, 20],
    [49, 20],
    [50, 25],
    [59, 25],
    [60, 30],
    [69, 30],
    [70, 35],
    [79, 35],
    [80, 40],
    [99, 40],
  ]) {
    test(`finalScore ${finalScore} -> ${value}`, () => {
      const { parts } = ggp({ finalScore }, TABLES);
      assert.equal(parts.score, value);
    });
  }

  test('finalScore exactly 100 matches no bracket and keeps the default (legacy quirk: no `>= 100` branch)', () => {
    const { parts } = ggp({ finalScore: 100 }, TABLES);
    assert.equal(parts.score, 15);
  });

  test('missing finalScore keeps the default (15)', () => {
    const { parts } = ggp({}, TABLES);
    assert.equal(parts.score, 15);
  });

  test('finalScore 0 is PHP-empty too, so it also keeps the default (legacy: `!empty($final_score)`)', () => {
    const { parts } = ggp({ finalScore: 0 }, TABLES);
    assert.equal(parts.score, 15);
  });
});

describe('ggp: owners table (gateway.php ~311-325)', () => {
  for (const [owners, value] of [
    [150000000, 20],
    [75000000, 20],
    [35000000, 20],
    [15000000, 18],
    [7500000, 16],
    [3500000, 14],
    [1500000, 12],
    [750000, 10],
    [350000, 8],
    [150000, 6],
    [75000, 4],
    [35000, 2],
    [10000, 0],
  ]) {
    test(`ownersEstimate ${owners} -> ${value}`, () => {
      const { parts } = ggp({ ownersEstimate: owners }, TABLES);
      assert.equal(parts.owners, value);
    });
  }

  test('a non-bucket owners value keeps the default (5)', () => {
    const { parts } = ggp({ ownersEstimate: 12345 }, TABLES);
    assert.equal(parts.owners, 5);
  });

  test('missing ownersEstimate keeps the default (5)', () => {
    const { parts } = ggp({}, TABLES);
    assert.equal(parts.owners, 5);
  });
});

describe('ggp: price multiplier + bonus ordering (gateway.php ~327-335)', () => {
  test('a missing price behaves like 0 (PHP `null < N` coerces true) and lands in the first bracket', () => {
    const { ggp: value, parts } = ggp({ finalTime: 5, difficulty: 'Just Right', finalScore: 60, ownersEstimate: 35000 }, TABLES);
    assert.equal(parts.priceMultiplier, 1);
    // time(25) + score(30) + owners(2) + difficulty(20) = 77, * 1 = 77, + timeBonus(0) = 77
    assert.equal(value, 77);
  });

  test('price >= 80000 applies no multiplier at all (not even x1) and the sum is used as-is', () => {
    const { parts } = ggp({ finalTime: 5, priceRub: 90000 }, TABLES);
    assert.equal(parts.priceMultiplier, null);
  });

  test('the time-bonus is added AFTER the price multiplier, not multiplied by it', () => {
    const { ggp: value } = ggp({ finalTime: 30, difficulty: 'Simple', finalScore: 10, ownersEstimate: 10000, priceRub: 5000 }, TABLES);
    // time(100)+score(10)+owners(0)+difficulty(0) = 110, *1 (bracket lt 10000) = 110, + bonus(50) = 160
    assert.equal(value, 160);
  });
});
