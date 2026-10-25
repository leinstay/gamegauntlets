# Game Gauntlets

Backend and static frontend for [gamegauntlets.com](https://gamegauntlets.com), a random-game wheel. You pick filters, spin, and land on a game from a catalog of about 200,000 titles aggregated from Steam, GOG, SteamSpy, GameFAQs, Metacritic, IGDB, HowLongToBeat, Wikidata and GameRankings.

The public catalog export for third parties is published nightly at [leinstay/steamdb](https://github.com/leinstay/steamdb).

## How it works

```
src/worker.js   source workers (Steam, GOG, IGDB, ...) fetch and parse
      |         BullMQ queues on Redis
src/pipeline/   resolve conflicting values, compute gg_score, purge non-games
      |         MariaDB `gg` schema
src/api.js      Fastify API: wheel, games, stats, Steam OpenID login, admin
      |
public/         static frontend, service worker, Live2D mascot
```

The nightly export in `src/pipeline/export*.js` writes the JSON dump and its README and uploads them as a release to the steamdb repository.

## Requirements

Node.js 20 or newer, MariaDB and Redis. You also need a Steam Web API key, Twitch OAuth credentials for IGDB, and a GameFAQs session cookie for scraping.

## Installation

```bash
git clone https://github.com/leinstay/gamegauntlets.git
cd gamegauntlets
npm install
cp .env.example .env
```

Fill in `.env` with the database and Redis connection, `SESSION_SECRET`, `STEAM_API_KEY`, `IGDB_CLIENT_ID` and `IGDB_CLIENT_SECRET`. Every key is documented inside `.env.example`. Site-wide settings such as languages, wheel limits and score weights live in `config.json`, and local overrides go to `config.local.json`.

## Running

```bash
npm run api      # Fastify server on PORT (default 3000), serves public/
npm run worker   # source workers, resolver and maintenance jobs
npm test
```

`WORKER_SOURCES` and `WORKER_EXCLUDE_SOURCES` in `.env` limit which source workers a process runs, so a satellite machine can take a single slow source such as GameFAQs.

Pushes to `main` deploy to production through `.github/workflows/deploy.yml` on a self-hosted runner. The workflow runs the tests, syncs the tree to `/opt/gg` and restarts the `gg-api` and `gg-worker` services.

## Layout

```
src/api.js, src/api/     Fastify routes for the wheel, games, stats, auth, admin and pages
src/worker.js            queue consumers and scheduling
src/sources/             one module per data source
src/pipeline/            resolve, maintenance, export, GitHub release
src/lib/                 shared helpers (dates, names, resolver, session, Steam OpenID)
src/config.js, src/db.js, src/queue.js, src/log.js
public/                  frontend pages, css, js, i18n, vendor libraries, Pio mascot
tests/                   node --test suites and fixtures
```

## License and credits

MIT License, see [LICENSE](LICENSE). The mascot widget is based on [Pio](https://github.com/Dreamer-Paul/Pio) by Dreamer-Paul (GPL-2.0) and rendered with [pixi-live2d-display](https://github.com/guansss/pixi-live2d-display) (MIT) on [PixiJS](https://pixijs.com) (MIT) and the Live2D Cubism 2 runtime by Live2D Inc. The Live2D model in `public/pio/models/neptune` depicts Neptune from Hyperdimension Neptunia (Idea Factory / Compile Heart). It is fan content, is not covered by this repository's license, and all rights belong to the respective owners. Frontend libraries and their licenses are listed in `public/js/plugins/README.md` and `public/vendor/README.md`.
