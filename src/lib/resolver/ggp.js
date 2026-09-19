// GGP ("GG points"). Exact port of gateway.php lines ~266-335. Tables moved to `config.json` -> `resolver.ggp`.
//
// Legacy -> new column mapping:
//   gfq_difficulty -> difficulty     -> input.difficulty
//   final_time     -> final_time     -> input.finalTime   (output of time.js's finalTime())
//   final_score    -> gg_score       -> input.finalScore  (output of score.js's ggScore())
//   stsp_owners    -> owners_estimate -> input.ownersEstimate
//   price_ru       -> price_rub      -> input.priceRub (legacy multiplies by the *base* price_ru, not price_final_ru)

import { phpEmpty, phpRound } from './release.js';

function difficultyScore(difficulty, table, fallback) {
  if (phpEmpty(difficulty)) return fallback;
  const value = table[difficulty];
  return value === undefined ? fallback : value;
}

/**
 * Time bracket lookup (legacy: `<=10` linear, exact integers 11-15, then `<=18/21/24/27` else-chain with a bonus
 * added *after* the price multiplier — see below). Returns `{ value, bonus }`; `bonus` is 0 unless a "long game"
 * bracket applied.
 */
function timeScore(finalTime, table, fallback) {
  if (phpEmpty(finalTime)) return { value: fallback, bonus: 0 };

  const linear = table.linear || { maxTime: 10, multiplier: 5 };
  if (finalTime <= linear.maxTime) return { value: finalTime * linear.multiplier, bonus: 0 };

  const exact = (table.exact || []).find((e) => e.time === finalTime);
  if (exact) return { value: exact.value, bonus: 0 };

  const bracket = (table.longBrackets || []).find((b) => finalTime <= b.max);
  if (bracket) return { value: table.longValue, bonus: bracket.bonus };

  return { value: table.longValue, bonus: table.longElseBonus };
}

function evalBound(value, op, bound) {
  return op === '<=' ? value <= bound : value < bound;
}

function scoreScore(finalScore, brackets, fallback) {
  if (phpEmpty(finalScore)) return fallback;
  for (const b of brackets) {
    if (evalBound(finalScore, b.op, b.bound)) return b.value;
  }
  return fallback;
}

function ownersScore(ownersEstimate, table, fallback) {
  if (phpEmpty(ownersEstimate)) return fallback;
  const value = table[String(ownersEstimate)];
  return value === undefined ? fallback : value;
}

/**
 * `ggp(input, tables) -> { ggp, parts }`.
 *
 * `input`: `{ difficulty, finalTime, finalScore, ownersEstimate, priceRub }`.
 * `tables`: `config.resolver.ggp` (defaults, difficulty/time/score/owners tables, price multiplier brackets).
 */
export function ggp(input = {}, tables = {}) {
  const defaults = tables.defaults || { time: 0, score: 0, owners: 0, difficulty: 0 };

  const difficulty = difficultyScore(input.difficulty, tables.difficulty || {}, defaults.difficulty);
  const time = timeScore(input.finalTime, tables.time || {}, defaults.time);
  const score = scoreScore(input.finalScore, tables.score || [], defaults.score);
  const owners = ownersScore(input.ownersEstimate, tables.owners || {}, defaults.owners);

  let total = time.value + score + owners + difficulty;

  // Legacy multiplies by the *base* price (price_ru), where PHP's `null < N` / `0 < N` comparisons both coerce to
  // true — a missing price behaves exactly like a free (0) game, always landing in the first bracket.
  const priceRub = phpEmpty(input.priceRub) ? 0 : Number(input.priceRub);
  const bracket = (tables.priceMultiplierRub || []).find((b) => priceRub < b.lt);
  let multiplier = null;
  if (bracket) {
    multiplier = bracket.multiplier;
    total = phpRound(total * bracket.multiplier);
  }

  total += time.bonus;

  return {
    ggp: total,
    parts: {
      time: time.value,
      timeBonus: time.bonus,
      score,
      owners,
      difficulty,
      priceMultiplier: multiplier,
    },
  };
}
