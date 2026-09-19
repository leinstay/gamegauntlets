import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { classifyPurchasable } from '../../src/lib/purchasable.js';

const NOW = new Date('2026-09-19T00:00:00Z');

function classify(overrides = {}) {
  return classifyPurchasable({ hasSteamRecord: true, now: NOW, ...overrides });
}

describe('classifyPurchasable: no live store evidence at all', () => {
  test('purchasable = 1 (unknown != unavailable) with neither a steam nor a gog record, whatever the legacy prices say', () => {
    assert.equal(
      classifyPurchasable({ hasSteamRecord: false, hasGogRecord: false, isFree: false, priceUsd: null, priceRub: null, now: NOW }),
      1,
    );
  });

  test('legacy-only game (no live steam/gog record) stays purchasable = 1 even when both legacy prices are empty and it is not free', () => {
    assert.equal(
      classifyPurchasable({
        hasSteamRecord: false,
        hasGogRecord: false,
        isFree: false,
        priceUsd: null,
        priceRub: null,
        priceCisUsd: null,
        steamPurchasable: undefined,
        gogPurchasable: undefined,
        now: NOW,
      }),
      1,
    );
  });
});

describe('classifyPurchasable: global signals win outright', () => {
  test('free game -> 1, even with a live steam record that reports steamPurchasable false', () => {
    assert.equal(classify({ isFree: true, steamPurchasable: false }), 1);
  });

  test('priced in any one region -> 1', () => {
    assert.equal(classify({ priceUsd: 999, steamPurchasable: false }), 1);
    assert.equal(classify({ priceRub: 49900, steamPurchasable: false }), 1);
    assert.equal(classify({ priceCisUsd: 499, steamPurchasable: false }), 1);
  });

  test('a bare 0 price does not count as "priced"', () => {
    assert.equal(classify({ priceUsd: 0, priceRub: 0, steamPurchasable: false }), 0);
  });

  test('coming soon / not released yet -> 1 (release date in the future)', () => {
    assert.equal(classify({ releaseDate: '2026-12-01', steamPurchasable: false }), 1);
  });

  test('a resolved release date in the past does not save an otherwise-unpurchasable game', () => {
    assert.equal(classify({ releaseDate: '2020-01-01', steamPurchasable: false }), 0);
  });
});

describe('classifyPurchasable: Steam package_groups signal', () => {
  test('package_groups non-empty (steamPurchasable true) with no price -> 1', () => {
    assert.equal(classify({ steamPurchasable: true }), 1);
  });

  test('delisted-but-visible: appdetails succeeds, no price, empty package_groups, not free, not coming soon -> 0', () => {
    assert.equal(classify({ steamPurchasable: false }), 0);
  });

  test('old payload without package_groups (steamPurchasable undefined) is tolerated, not treated as unpurchasable', () => {
    assert.equal(classify({ steamPurchasable: undefined }), 1);
  });
});

describe('classifyPurchasable: GOG-only', () => {
  test('GOG-only buyable game (no steam record at all) -> 1', () => {
    assert.equal(
      classifyPurchasable({ hasSteamRecord: false, hasGogRecord: true, gogPurchasable: true, now: NOW }),
      1,
    );
  });

  test('GOG-only, GOG positively says not for sale -> 0', () => {
    assert.equal(
      classifyPurchasable({ hasSteamRecord: false, hasGogRecord: true, gogPurchasable: false, now: NOW }),
      0,
    );
  });

  test('GOG record present but no opinion (old payload) and no steam record -> 1', () => {
    assert.equal(
      classifyPurchasable({ hasSteamRecord: false, hasGogRecord: true, gogPurchasable: undefined, now: NOW }),
      1,
    );
  });
});

describe('classifyPurchasable: both stores present, ANY-of semantics', () => {
  test('Steam says no but GOG says yes -> 1 (any store being buyable is enough)', () => {
    assert.equal(
      classifyPurchasable({ hasSteamRecord: true, hasGogRecord: true, steamPurchasable: false, gogPurchasable: true, now: NOW }),
      1,
    );
  });

  test('both stores positively say no -> 0', () => {
    assert.equal(
      classifyPurchasable({ hasSteamRecord: true, hasGogRecord: true, steamPurchasable: false, gogPurchasable: false, now: NOW }),
      0,
    );
  });

  test('Steam has no opinion, GOG positively says no -> 0', () => {
    assert.equal(
      classifyPurchasable({ hasSteamRecord: true, hasGogRecord: true, steamPurchasable: undefined, gogPurchasable: false, now: NOW }),
      0,
    );
  });
});
