// GET /api/stats — footer counter (legacy ajax/json/statistic.json). Cached 60s in memory: three
// COUNT(*) queries on every page view isn't worth it for a number nobody needs to the second.
//
// `rolls` must read as the legacy site's all-time counter, not restart from the migrated table:
// only the last 12 months of rolls were carried into `roll_log` (see `retention.rollLogMonths`),
// so `stats.rollsOffset` in config.json makes up the difference. Its value (3,546,988) is the
// legacy all-time total 3,796,693 minus the 249,705 migrated roll_log rows, measured 2026-09-19;
// re-measure at cutover. Defaults to 0 when the config key is missing.

const CACHE_TTL_MS = 60 * 1000;
let cached = null; // { at, data }

// Test-only escape hatch (see src/sources/hltb.js's `_resetCaches` for the same pattern) so
// tests/api/misc.test.js can exercise more than one /api/stats scenario without an earlier test's
// 60s cache leaking into a later one.
export function _resetCacheForTests() {
  cached = null;
}

export default async function statsRoutes(app) {
  app.get('/stats', async () => {
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;

    const [rolls, users, games] = await Promise.all([
      app.db.one('SELECT COUNT(*) AS c FROM roll_log'),
      app.db.one('SELECT COUNT(*) AS c FROM users'),
      app.db.one('SELECT COUNT(*) AS c FROM games'),
    ]);

    const rollsOffset = app.appConfig?.stats?.rollsOffset ?? 0;
    const data = {
      rolls: Number(rolls?.c ?? 0) + rollsOffset,
      users: Number(users?.c ?? 0),
      games: Number(games?.c ?? 0),
    };
    cached = { at: Date.now(), data };
    return data;
  });
}
