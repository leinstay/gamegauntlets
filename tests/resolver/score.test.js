import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ggScore } from '../../src/lib/resolver/score.js';
import { config } from '../../src/config.js';

const WEIGHTS = config.resolver.ggScore;
const NOW = new Date('2026-09-19T00:00:00Z');

describe('ggScore: rating average and diminishing (gateway.php ~194-239)', () => {
  test('no ratings at all -> score 0', () => {
    const { score } = ggScore({ releaseDate: '2020-01-01' }, WEIGHTS, NOW);
    assert.equal(score, 0);
  });

  test('a single rating is used as-is when >= 50 minus age penalty (recent game, no diminishing besides missing sources)', () => {
    // Only scoreSteam present -> everything else missing, so diminishing accumulates from every other missing field.
    const { score, parts } = ggScore({ scoreSteam: 90, releaseDate: '2026-01-01' }, WEIGHTS, NOW);
    // missing: igdb(2)+igdbUsers(2)+critics(4)+usersMeta(4)+gamerankings(2)+gamefaqs(2) = 16, age(<=3y)=0, indie=0
    assert.equal(parts.diminishing, 16);
    assert.equal(score, 90 - 16);
  });

  test('multiple ratings are averaged and rounded before diminishing is applied', () => {
    const { score } = ggScore({ scoreSteam: 80, scoreCritics: 81, releaseDate: '2026-01-01' }, WEIGHTS, NOW);
    // average(80,81) = 80.5 -> round -> 81 (half away from zero)
    // missing: igdb(2)+igdbUsers(2)+usersMeta(4)+gamerankings(2)+gamefaqs(2) = 12
    assert.equal(score, 81 - 12);
  });

  test('score below 50 is never reduced by diminishing (legacy: `if ($score >= 50) $score -= $diminishing`)', () => {
    const { score } = ggScore({ scoreSteam: 40, releaseDate: '2026-01-01' }, WEIGHTS, NOW);
    assert.equal(score, 40);
  });

  test('clamps to 0 when diminishing pushes a >=50 score negative', () => {
    // Isolated from the default config's realistic magnitudes: a single huge missing-source penalty is enough to
    // prove the `if (score <= 0) score = 0` clamp fires, without needing to hit it via real-world weight values
    // (under the default weights the maximum diminishing is well below 50, so this branch can't be reached there).
    const weights = { missingPenalty: { scoreSteam: 200 } };
    const { score } = ggScore({ scoreCritics: 55 }, weights, NOW);
    assert.equal(score, 0);
  });

  test('clamps to 100 when a favourable owners bucket pushes an already-maxed average over 100', () => {
    // Every rating maxed out (average = 100, no missing-source penalty) plus the top owners bucket, whose *negative*
    // diminishing (-6) makes the score go *up* instead of down: 100 - (-6) = 106 -> clamped to 100.
    const { score } = ggScore(
      {
        scoreSteam: 100,
        scoreIgdb: 100,
        scoreIgdbUsers: 100,
        scoreCritics: 100,
        scoreUsersMetacritic: 100,
        scoreGamerankings: 100,
        scoreGamefaqs: 5,
        ownersEstimate: 150000000,
        releaseDate: '2026-01-01',
      },
      WEIGHTS,
      NOW
    );
    assert.equal(score, 100);
  });

  test('gfq rating is scaled by 20 before averaging (0..5 -> 0..100)', () => {
    const { score } = ggScore({ scoreSteam: 80, scoreGamefaqs: 4, releaseDate: '2026-01-01' }, WEIGHTS, NOW);
    // average(80, 80) = 80; missing: igdb(2)+igdbUsers(2)+critics(4)+usersMeta(4)+gamerankings(2) = 14
    assert.equal(score, 80 - 14);
  });
});

describe('ggScore: owners diminishing bucket', () => {
  test('exact bucket match adjusts diminishing (150000000 -> -6, i.e. a bonus)', () => {
    const withOwners = ggScore({ scoreSteam: 90, ownersEstimate: 150000000, releaseDate: '2026-01-01' }, WEIGHTS, NOW);
    const withoutOwners = ggScore({ scoreSteam: 90, releaseDate: '2026-01-01' }, WEIGHTS, NOW);
    assert.equal(withOwners.score, withoutOwners.score + 6);
  });

  test('a non-bucket owners value has no effect', () => {
    const result = ggScore({ scoreSteam: 90, ownersEstimate: 12345, releaseDate: '2026-01-01' }, WEIGHTS, NOW);
    assert.equal(result.parts.ownersAdjustment, 0);
  });
});

describe('ggScore: age penalty (gateway.php ~221-229, DateTime::diff()->y)', () => {
  test('<=3 years old: no penalty', () => {
    const { parts } = ggScore({ scoreSteam: 90, releaseDate: '2024-09-19' }, WEIGHTS, NOW);
    assert.equal(parts.agePenalty, 0);
  });

  test('exactly at a bracket boundary uses the calendar year, not a raw 365-day count', () => {
    // 6 years earlier, later month/day => still "<=6" bracket (calendar years elapsed = 5, since day not yet reached).
    const { parts } = ggScore({ scoreSteam: 90, releaseDate: '2020-09-20' }, WEIGHTS, NOW);
    assert.equal(parts.agePenalty, 2);
  });

  test('>24 years old uses the default/else penalty (6)', () => {
    const { parts } = ggScore({ scoreSteam: 90, releaseDate: '1990-01-01' }, WEIGHTS, NOW);
    assert.equal(parts.agePenalty, 6);
  });

  test('no release date at all falls back to defaultAgePenalty', () => {
    const { parts } = ggScore({ scoreSteam: 90 }, WEIGHTS, NOW);
    assert.equal(parts.agePenalty, WEIGHTS.defaultAgePenalty);
  });
});

describe('ggScore: Indie genre penalty', () => {
  test('adds the indie penalty when genres contains "Indie"', () => {
    const withIndie = ggScore({ scoreSteam: 90, genres: '|Action|Indie|', releaseDate: '2026-01-01' }, WEIGHTS, NOW);
    const withoutIndie = ggScore({ scoreSteam: 90, genres: '|Action|', releaseDate: '2026-01-01' }, WEIGHTS, NOW);
    assert.equal(withIndie.score, withoutIndie.score - 8);
  });

  test('accepts genres as an array too', () => {
    const { parts } = ggScore({ scoreSteam: 90, genres: ['Action', 'Indie'], releaseDate: '2026-01-01' }, WEIGHTS, NOW);
    assert.equal(parts.indiePenalty, 8);
  });
});

describe('ggScore: vote-count weighting (new, off by default)', () => {
  test('is disabled by default: default config output equals the plain average', () => {
    const { score } = ggScore({ scoreSteam: 60, scoreCritics: 90, scoreSteamVotes: 5, releaseDate: '2026-01-01' }, WEIGHTS, NOW);
    // average(60,90)=75, round=75; missing igdb(2)+igdbUsers(2)+usersMeta(4)+gamerankings(2)+gamefaqs(2)=12
    assert.equal(score, 75 - 12);
  });

  test('when enabled, a low-vote score is weighted down relative to a high-vote one', () => {
    const weights = { ...WEIGHTS, voteWeighting: { enabled: true, logBase: 10, offset: 10, minWeight: 1 } };
    const lowVotesFirst = ggScore(
      { scoreSteam: 20, scoreSteamVotes: 1, scoreCritics: 90, scoreCriticsCount: 100000, releaseDate: '2026-01-01' },
      weights,
      NOW
    );
    const plainAverage = ggScore(
      { scoreSteam: 20, scoreCritics: 90, releaseDate: '2026-01-01' },
      { ...WEIGHTS, voteWeighting: { enabled: false } },
      NOW
    );
    // Weighted result should lean toward the high-vote (90) score, i.e. be higher than the unweighted average (55).
    assert.ok(lowVotesFirst.score > plainAverage.score);
  });
});
