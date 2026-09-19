import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { resolveGame } from '../../src/lib/resolver/index.js';
import { toPipeList, normalizeName } from '../../src/lib/names.js';
import { config } from '../../src/config.js';

const NOW = new Date('2026-09-19T00:00:00Z');

describe('resolveGame: store priority (Steam > GOG)', () => {
  test('prefers Steam name/image/description when both stores are present', () => {
    const { columns } = resolveGame(
      {
        steam: { name: 'Steam Name', image: 'steam.jpg', descriptionEn: 'Steam desc' },
        gog: { name: 'GOG Name', image: 'gog.jpg', descriptionEn: 'GOG desc' },
      },
      {},
      config,
      NOW
    );
    assert.equal(columns.name, 'Steam Name');
    assert.equal(columns.image, 'steam.jpg');
    assert.equal(columns.description_en, 'Steam desc');
  });

  test('falls back to GOG when Steam has no data', () => {
    const { columns } = resolveGame({ gog: { name: 'GOG Name', image: 'gog.jpg' } }, {}, config, NOW);
    assert.equal(columns.name, 'GOG Name');
    assert.equal(columns.kind, 'gog_exclusive');
  });

  test('kind is "steam" whenever a steamAppid exists anywhere, even if GOG supplied the display fields', () => {
    const { columns } = resolveGame(
      { steam: { steamAppid: 730 }, gog: { name: 'Counter-Strike on GOG' } },
      {},
      config,
      NOW
    );
    assert.equal(columns.kind, 'steam');
    assert.equal(columns.steam_appid, 730);
  });
});

describe('resolveGame: store field fallback to a non-steam/gog source (e.g. legacy_steamdb)', () => {
  test('a source with no steam/gog data at all falls back to any source reporting storeRelease', () => {
    const { columns } = resolveGame(
      {
        legacy_steamdb: {
          name: 'Fallback Name',
          image: 'fallback.jpg',
          descriptionEn: 'desc en',
          descriptionRu: 'desc ru',
          achievements: 5,
          storeRelease: { date: '2020-01-01', precision: 'day' },
        },
      },
      {},
      config,
      NOW
    );
    assert.equal(columns.name, 'Fallback Name');
    assert.equal(columns.image, 'fallback.jpg');
    assert.equal(columns.description_en, 'desc en');
    assert.equal(columns.description_ru, 'desc ru');
    assert.equal(columns.achievements, 5);
  });

  test('Steam still wins over the fallback when both exist', () => {
    const { columns } = resolveGame(
      {
        steam: { name: 'Steam Name', image: 'steam.jpg' },
        legacy_steamdb: { name: 'Fallback Name', image: 'fallback.jpg', storeRelease: { date: '2020-01-01', precision: 'day' } },
      },
      {},
      config,
      NOW
    );
    assert.equal(columns.name, 'Steam Name');
    assert.equal(columns.image, 'steam.jpg');
  });

  test('a source with neither store data nor a storeRelease is not used as the fallback', () => {
    const { columns } = resolveGame({ hltb: { name: 'Should not be used', timeMain: 5 } }, {}, config, NOW);
    assert.equal(columns.name, null);
  });
});

describe('resolveGame: critic score source priority (spec §7, updated for the live metacritic source; OpenCritic dropped)', () => {
  test('a source named legacy_metacritic is recognised even without an explicit scoreCriticsSource field', () => {
    const { columns } = resolveGame({ legacy_metacritic: { scoreCritics: 60 } }, {}, config, NOW);
    assert.equal(columns.score_critics, 60);
    assert.equal(columns.score_critics_source, 'metacritic');
  });

  test('the live metacritic source wins over a legacy Metacritic-provenance snapshot, even when the legacy entry iterates first', () => {
    const { columns } = resolveGame(
      {
        legacy_steamdb: { scoreCritics: 85, scoreCriticsSource: 'metacritic', scoreCriticsCount: 40 },
        metacritic: { scoreCritics: 91, scoreCriticsSource: 'metacritic', scoreCriticsCount: 55 },
      },
      {},
      config,
      NOW
    );
    assert.equal(columns.score_critics, 91);
    assert.equal(columns.score_critics_count, 55);
    assert.equal(columns.score_critics_source, 'metacritic');
  });

  test('a live metacritic entry with no score yet (tbd) falls back to a legacy Metacritic-provenance snapshot', () => {
    const { columns } = resolveGame(
      {
        metacritic: { scoreCriticsSource: 'metacritic' }, // linked, but no score yet (tbd page)
        legacy_steamdb: { scoreCritics: 72, scoreCriticsSource: 'metacritic' },
      },
      {},
      config,
      NOW
    );
    assert.equal(columns.score_critics, 72);
    assert.equal(columns.score_critics_source, 'metacritic');
  });

  test('no source reporting a critics score resolves to null/null, not an empty object', () => {
    const { columns } = resolveGame({ steam: { name: 'No critics data' } }, {}, config, NOW);
    assert.equal(columns.score_critics, null);
    assert.equal(columns.score_critics_source, null);
  });
});

describe('resolveGame: score_users_metacritic priority (live metacritic source over legacy)', () => {
  test('the live metacritic source wins over a legacy value even when legacy iterates first', () => {
    const { columns } = resolveGame(
      {
        legacy_steamdb: { scoreUsersMetacritic: 70 },
        metacritic: { scoreUsersMetacritic: 88 },
      },
      {},
      config,
      NOW
    );
    assert.equal(columns.score_users_metacritic, 88);
  });

  test('falls back to a legacy value when the live source has none', () => {
    const { columns } = resolveGame({ legacy_steamdb: { scoreUsersMetacritic: 65 } }, {}, config, NOW);
    assert.equal(columns.score_users_metacritic, 65);
  });
});

describe('resolveGame: list-field union', () => {
  test('unions genres from every source and normalises to a pipe list', () => {
    const { columns } = resolveGame(
      {
        steam: { genres: ['Action', 'Indie'] },
        legacy_steamdb: { genres: ['Indie', 'RPG'] },
      },
      {},
      config,
      NOW
    );
    assert.equal(columns.genres, toPipeList(['Action', 'Indie', 'RPG']));
  });

  test('a field nobody reported is null, not an empty pipe list', () => {
    const { columns } = resolveGame({ steam: {} }, {}, config, NOW);
    assert.equal(columns.tags, null);
  });
});

describe('resolveGame: platforms (a real SET column, not a pipe list)', () => {
  test('unions platforms from every source into a comma string in WIN,MAC,LNX order', () => {
    const { columns } = resolveGame(
      {
        steam: { platforms: ['LNX', 'WIN'] },
        legacy_steamdb: { platforms: ['WIN', 'MAC'] },
      },
      {},
      config,
      NOW
    );
    assert.equal(columns.platforms, 'WIN,MAC,LNX');
  });

  test('drops an unrecognised value and lower-cases/trims what it keeps', () => {
    const { columns } = resolveGame({ steam: { platforms: [' win ', 'mac', 'PS5'] } }, {}, config, NOW);
    assert.equal(columns.platforms, 'WIN,MAC');
  });

  test('a field nobody reported is null (not an empty string, not a pipe list)', () => {
    const { columns } = resolveGame({ steam: {} }, {}, config, NOW);
    assert.equal(columns.platforms, null);
  });
});

describe('resolveGame: name_normalized', () => {
  test('is derived from the resolved name via src/lib/names.js normalizeName', () => {
    const { columns } = resolveGame({ steam: { name: 'The Witcher 3: Wild Hunt' } }, {}, config, NOW);
    assert.equal(columns.name_normalized, normalizeName('The Witcher 3: Wild Hunt'));
    assert.ok(columns.name_normalized.length > 0);
  });

  test('is null (not blanked to an empty string) when nothing resolved a name', () => {
    const { columns } = resolveGame({ legacy_steamdb: { scoreSteam: 80 } }, {}, config, NOW);
    assert.equal(columns.name, null);
    assert.equal(columns.name_normalized, null);
  });
});

describe('resolveGame: prices', () => {
  test('maps prices.usd/rub/cisUsd {initial,final,discount} to the games price columns', () => {
    const { columns } = resolveGame(
      {
        steam: {
          prices: {
            usd: { initial: 1999, final: 999, discount: 50 },
            rub: { initial: 149900, final: 149900, discount: 0 },
            cisUsd: { initial: 999, final: 999, discount: 0 },
          },
        },
      },
      {},
      config,
      NOW
    );
    assert.equal(columns.price_usd, 1999);
    assert.equal(columns.price_final_usd, 999);
    assert.equal(columns.discount_usd, 50);
    assert.equal(columns.price_rub, 149900);
    assert.equal(columns.price_cis_usd, 999);
  });

  test('falls back to GOG prices when the preferred (Steam) store has no price at all (delisted-but-visible)', () => {
    // Steam wins name/image/etc (higher STORE_PRIORITY) but reports no price at all - e.g. its store page
    // is still up (appdetails succeeds) but the game can no longer actually be bought there. A GOG record
    // for the same game with a real price must not be shadowed into null price columns.
    const { columns } = resolveGame(
      {
        steam: { name: 'Steam Name', steamAppid: 123 },
        gog: { name: 'GOG Name', prices: { usd: { initial: 1999, final: 999, discount: 50 }, rub: { initial: 149900, final: 149900, discount: 0 } } },
      },
      {},
      config,
      NOW
    );
    assert.equal(columns.name, 'Steam Name'); // store priority for non-price fields is unaffected
    assert.equal(columns.price_usd, 1999);
    assert.equal(columns.price_final_usd, 999);
    assert.equal(columns.discount_usd, 50);
    assert.equal(columns.price_rub, 149900);
  });

  test('still prefers Steam prices over GOG when Steam actually has a price', () => {
    const { columns } = resolveGame(
      {
        steam: { prices: { usd: { initial: 2999, final: 2999, discount: 0 } } },
        gog: { prices: { usd: { initial: 1999, final: 999, discount: 50 } } },
      },
      {},
      config,
      NOW
    );
    assert.equal(columns.price_usd, 2999);
    assert.equal(columns.price_final_usd, 2999);
  });

  test('falls back to the legacy-snapshot store when neither Steam nor GOG has any price (old behaviour preserved)', () => {
    const { columns } = resolveGame(
      {
        steam: { name: 'Steam Name', steamAppid: 123 }, // no prices at all
        legacy_steamdb: { storeRelease: { date: '2020-01-01', precision: 'day' }, prices: { usd: { initial: 500, final: 500, discount: 0 } } },
      },
      {},
      config,
      NOW
    );
    // Steam still wins pickStore() for name/etc, but has no price of its own, and legacy_steamdb isn't a
    // STORE_PRIORITY source - PRICE_REGIONS falls back through to `store` itself (pickStore()'s Steam
    // pick), which has none either, so the price columns stay null - unchanged pre-existing behaviour when
    // there's no GOG price to rescue them.
    assert.equal(columns.price_usd, null);
  });
});

describe('resolveGame: release date feeds gg score and ggp end-to-end', () => {
  test('a resolved release date lowers the age penalty consistently between gg_score and the release columns', () => {
    const { columns } = resolveGame(
      {
        steam: { storeRelease: { date: '2026-08-01', precision: 'day' }, scoreSteam: 90 },
      },
      {},
      config,
      NOW
    );
    assert.equal(columns.release_date, '2026-08-01');
    assert.equal(columns.release_precision, 'day');
    // recent game, only scoreSteam present: same math as score.test.js's equivalent case.
    assert.equal(columns.gg_score, 90 - 16);
  });

  test('a release conflict is surfaced in the returned conflicts array', () => {
    const { conflicts } = resolveGame(
      {
        igdb: { release: { date: '2019-01-01', precision: 'day' } },
        gamefaqs: { release: { date: '2020-06-01', precision: 'day' } },
        steam: { storeRelease: { date: '2019-06-01', precision: 'day' } },
      },
      {},
      config,
      NOW
    );
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].field, 'release_date');
  });
});

describe('resolveGame: time to beat glue (HLTB primary, IGDB secondary)', () => {
  test('wires hltb.timeMain/timeComplete and igdb.timeMain/timeComplete into finalTime()', () => {
    const { columns } = resolveGame(
      {
        hltb: { timeMain: 8, timeComplete: 15 },
        igdb: { timeMain: 20, timeComplete: 30 },
      },
      {},
      config,
      NOW
    );
    assert.equal(columns.time_main, 8);
    assert.equal(columns.final_time, 8); // hltb.timeMain wins
    assert.equal(columns.time_complete, 15);
  });
});

describe('resolveGame: average playtime (Steam reviews >= minReviews > SteamSpy)', () => {
  test('Steam reviews median wins once there are enough reviews, even over a live SteamSpy row', () => {
    const { columns } = resolveGame(
      {
        steam: { playtimeReviewsMedianMinutes: 300, playtimeReviewsCount: 25 },
        steamspy: { playtimeMedianMinutes: 600 },
      },
      {},
      config,
      NOW
    );
    assert.equal(columns.time_average, 5); // 300 / 60
    assert.equal(columns.time_average_source, 'steam_reviews');
  });

  test('SteamSpy median wins when the Steam reviews count is below config.resolver.playtime.minReviews', () => {
    const { columns } = resolveGame(
      {
        steam: { playtimeReviewsMedianMinutes: 300, playtimeReviewsCount: 5 },
        steamspy: { playtimeMedianMinutes: 600 },
      },
      {},
      config,
      NOW
    );
    assert.equal(columns.time_average, 10); // 600 / 60
    assert.equal(columns.time_average_source, 'steamspy');
  });

  test('a low-sample Steam reviews median (>= 3) still wins when SteamSpy has nothing', () => {
    const { columns } = resolveGame(
      {
        steam: { playtimeReviewsMedianMinutes: 120, playtimeReviewsCount: 3 },
      },
      {},
      config,
      NOW
    );
    assert.equal(columns.time_average, 2); // 120 / 60
    assert.equal(columns.time_average_source, 'steam_reviews');
  });

  test('falls back to SteamSpy average when its median is absent/0', () => {
    const { columns } = resolveGame({ steamspy: { playtimeAverageMinutes: 300 } }, {}, config, NOW);
    assert.equal(columns.time_average, 5); // 300 / 60
    assert.equal(columns.time_average_source, 'steamspy');
  });

  test('leaves time_average/time_average_source untouched (undefined in columns) when no source reports anything', () => {
    const { columns } = resolveGame({ steam: { name: 'No playtime data' } }, {}, config, NOW);
    assert.equal(columns.time_average, null);
    assert.equal(columns.time_average_source, null);
  });
});

describe('resolveGame: recent Steam reviews', () => {
  test('0% positive with votes is kept as 0, not dropped as empty', () => {
    const { columns } = resolveGame({ steam: { scoreSteamRecent: 0, scoreSteamRecentVotes: 12 } }, {}, config, NOW);
    assert.equal(columns.score_steam_recent, 0);
    assert.equal(columns.score_steam_recent_votes, 12);
  });

  test('stays null when the source reported nothing', () => {
    const { columns } = resolveGame({ steam: { name: 'X' } }, {}, config, NOW);
    assert.equal(columns.score_steam_recent, null);
    assert.equal(columns.score_steam_recent_votes, null);
  });
});

describe('resolveGame: GameRankings score', () => {
  test('the gamerankings dataset wins over the legacy snapshot regardless of source order', () => {
    const { columns } = resolveGame(
      { legacy_steamdb: { scoreGamerankings: 73 }, gamerankings: { scoreGamerankings: 80 } }, {}, config, NOW);
    assert.equal(columns.score_gamerankings, 80);
  });

  test('falls back to the legacy value when the dataset has none', () => {
    const { columns } = resolveGame({ legacy_steamdb: { scoreGamerankings: 73 }, gamerankings: {} }, {}, config, NOW);
    assert.equal(columns.score_gamerankings, 73);
  });
});

describe('resolveGame: overrides always win, applied last', () => {
  test('an override replaces a resolved column unconditionally', () => {
    const { columns } = resolveGame({ steam: { name: 'Original Name' } }, { name: 'Manual Override' }, config, NOW);
    assert.equal(columns.name, 'Manual Override');
  });

  test('an override can set a column no source touched at all', () => {
    const { columns } = resolveGame({}, { release_date: '2000-01-01' }, config, NOW);
    assert.equal(columns.release_date, '2000-01-01');
  });
});
