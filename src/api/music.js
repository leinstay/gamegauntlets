// GET /api/music — background-music rotation for the wheel (legacy: hardcoded `musSrc` array in
// public/js/pgwheel.js). Files live only on the server under public/msc/ (gitignored, see that
// folder's .music note) and are never committed or deployed by git — dropping a file there should be
// enough to put it in the rotation, so this route lists the directory instead of reading a config.
//
// Only files matching `theme<anything>.(mp3|ogg|m4a)` are "rotation" tracks: one-off sound effects
// the frontend plays by explicit name (chowd.mp3, carnage.mp3) must stay out of the shuffled list.
// The result is cached in memory for 60s — same reasoning as src/api/stats.js: nobody needs this to
// the second, and it avoids a readdir() on every page load.

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TRACK_PATTERN = /^theme[\w-]*\.(mp3|ogg|m4a)$/i;
const CACHE_TTL_MS = 60 * 1000;

const DEFAULT_MUSIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'msc');

/** Natural sort ("theme2" before "theme10") — String.localeCompare's numeric collation option. */
function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * @param {object} [opts]
 * @param {string} [opts.musicDir] - directory to scan, defaults to <repo>/public/msc. Injectable so
 *   tests can point it at a temp directory instead of the real (gitignored, possibly empty) one.
 * @param {typeof fsp.readdir} [opts.readdir] - injectable for tests that need to spy on/count calls
 *   (e.g. to prove the 60s cache avoids a second filesystem hit) without waiting out the TTL.
 */
export default async function musicRoutes(app, opts = {}) {
  const musicDir = opts.musicDir || DEFAULT_MUSIC_DIR;
  const readdir = opts.readdir || fsp.readdir;

  // Closured per plugin registration (not module-level like stats.js/dictionaries.js) so each test
  // that registers its own instance of this route gets its own cache, with no cross-test leakage.
  let cached = null; // { at, tracks }

  app.get('/music', async (req, reply) => {
    if (!cached || Date.now() - cached.at >= CACHE_TTL_MS) {
      let files;
      try {
        files = await readdir(musicDir);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        files = [];
      }
      const tracks = files
        .filter((name) => TRACK_PATTERN.test(name))
        .sort(naturalCompare)
        .map((name) => `/msc/${name}`);
      cached = { at: Date.now(), tracks };
    }

    reply.header('Cache-Control', 'public, max-age=60');
    return { tracks: cached.tracks };
  });
}
