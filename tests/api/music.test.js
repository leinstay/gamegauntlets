import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Fastify from 'fastify';

import musicRoutes from '../../src/api/music.js';

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-music-test-'));
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function touch(dir, name) {
  fs.writeFileSync(path.join(dir, name), '');
}

function buildApp(opts) {
  const app = Fastify();
  app.register(musicRoutes, opts);
  return app;
}

test('GET /api/music: lists theme*.mp3 files as /msc/<name>, naturally sorted (theme2 before theme10)', async () => {
  await withTempDir(async (dir) => {
    touch(dir, 'theme10.mp3');
    touch(dir, 'theme2.mp3');
    touch(dir, 'theme1.mp3');

    const app = buildApp({ musicDir: dir });
    const res = await app.inject({ method: 'GET', url: '/music' });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
      tracks: ['/msc/theme1.mp3', '/msc/theme2.mp3', '/msc/theme10.mp3'],
    });
  });
});

test('GET /api/music: also picks up .ogg and .m4a rotation tracks', async () => {
  await withTempDir(async (dir) => {
    touch(dir, 'themeBoss.ogg');
    touch(dir, 'theme-alt.m4a');

    const app = buildApp({ musicDir: dir });
    const res = await app.inject({ method: 'GET', url: '/music' });

    assert.deepEqual(new Set(JSON.parse(res.body).tracks), new Set(['/msc/themeBoss.ogg', '/msc/theme-alt.m4a']));
  });
});

test('GET /api/music: excludes one-off sound effects and non-matching files', async () => {
  await withTempDir(async (dir) => {
    touch(dir, 'theme1.mp3');
    touch(dir, 'chowd.mp3');
    touch(dir, 'carnage.mp3');
    touch(dir, 'theme1.mp3.bak');
    touch(dir, 'readme.txt');

    const app = buildApp({ musicDir: dir });
    const res = await app.inject({ method: 'GET', url: '/music' });

    assert.deepEqual(JSON.parse(res.body), { tracks: ['/msc/theme1.mp3'] });
  });
});

test('GET /api/music: missing folder returns an empty list instead of erroring', async () => {
  const app = buildApp({ musicDir: path.join(os.tmpdir(), 'gg-music-does-not-exist-' + Date.now()) });
  const res = await app.inject({ method: 'GET', url: '/music' });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { tracks: [] });
});

test('GET /api/music: sets a 60s Cache-Control header', async () => {
  await withTempDir(async (dir) => {
    touch(dir, 'theme1.mp3');
    const app = buildApp({ musicDir: dir });
    const res = await app.inject({ method: 'GET', url: '/music' });
    assert.equal(res.headers['cache-control'], 'public, max-age=60');
  });
});

test('GET /api/music: result is cached (second call within 60s does not hit the filesystem again)', async () => {
  await withTempDir(async (dir) => {
    touch(dir, 'theme1.mp3');

    let calls = 0;
    const realReaddir = (await import('node:fs')).promises.readdir;
    const spyReaddir = async (...args) => {
      calls++;
      return realReaddir(...args);
    };

    const app = buildApp({ musicDir: dir, readdir: spyReaddir });

    await app.inject({ method: 'GET', url: '/music' });
    await app.inject({ method: 'GET', url: '/music' });

    assert.equal(calls, 1);
  });
});

test('GET /api/music: cache is per plugin registration, not shared module state across apps', async () => {
  await withTempDir(async (dirA) => {
    await withTempDir(async (dirB) => {
      touch(dirA, 'theme1.mp3');
      touch(dirB, 'theme9.mp3');

      const appA = buildApp({ musicDir: dirA });
      const appB = buildApp({ musicDir: dirB });

      const resA = await appA.inject({ method: 'GET', url: '/music' });
      const resB = await appB.inject({ method: 'GET', url: '/music' });

      assert.deepEqual(JSON.parse(resA.body), { tracks: ['/msc/theme1.mp3'] });
      assert.deepEqual(JSON.parse(resB.body), { tracks: ['/msc/theme9.mp3'] });
    });
  });
});
