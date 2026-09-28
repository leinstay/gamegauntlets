// src/pipeline/github-release.js — GitHub Releases client for the public leinstay/steamdb export
// (2026-09-28: the dump files are published as a Release instead of being committed, see that file's
// own header). Every test injects a fake `fetchImpl`/`execFileImpl`/`env` — no real network access, no
// real `curl` process, no real GitHub token.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  listReleases,
  createRelease,
  deleteRelease,
  pruneReleases,
  uploadAsset,
  stripUploadUrlTemplate,
  tagForDate,
  publishDumpRelease,
} from '../src/pipeline/github-release.js';

const TOKEN_ENV = { STEAMDB_GITHUB_TOKEN: 'super-secret-token' };

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/**
 * Fakes Node's callback-style `execFile` (cmd, args, options, callback) -> ChildProcess with a
 * writable `.stdin` — the shape uploadAsset() needs to write its `-K` curl config after the process
 * has already started (see that function's own comment for why it can't use `util.promisify`).
 * Records every call (`args`, and everything written to `stdin`) and completes asynchronously with a
 * canned `stdout`, same as a real `curl` process would via its callback.
 */
function makeFakeExecFile({ stdout = JSON.stringify({ state: 'uploaded' }), err = null } = {}) {
  const calls = [];
  function execFileImpl(cmd, args, options, callback) {
    const stdinChunks = [];
    const call = { cmd, args, options, stdinChunks };
    calls.push(call);
    return {
      stdin: {
        write(chunk) {
          stdinChunks.push(chunk);
        },
        end() {
          process.nextTick(() => callback(err, stdout));
        },
      },
    };
  }
  return { execFileImpl, calls };
}

// --- tagForDate / stripUploadUrlTemplate (pure helpers) -----------------------------------------------

test('tagForDate: "dump-<date>"', () => {
  assert.equal(tagForDate('2026-09-28'), 'dump-2026-09-28');
});

test('stripUploadUrlTemplate: removes the trailing {?name,label} URI template', () => {
  assert.equal(
    stripUploadUrlTemplate('https://uploads.github.com/repos/leinstay/steamdb/releases/10/assets{?name,label}'),
    'https://uploads.github.com/repos/leinstay/steamdb/releases/10/assets',
  );
});

// --- token required -------------------------------------------------------------------------------

test('listReleases: throws a clear error when STEAMDB_GITHUB_TOKEN is missing', async () => {
  await assert.rejects(
    () => listReleases({ fetchImpl: async () => { throw new Error('fetch must not be called'); }, env: {} }),
    /STEAMDB_GITHUB_TOKEN/,
  );
});

test('createRelease: throws a clear error when STEAMDB_GITHUB_TOKEN is missing', async () => {
  await assert.rejects(
    () => createRelease(
      { tag: 'dump-2026-09-28', name: 'Data update 2026-09-28', body: '', target: 'main' },
      { fetchImpl: async () => { throw new Error('fetch must not be called'); }, env: {} },
    ),
    /STEAMDB_GITHUB_TOKEN/,
  );
});

test('uploadAsset: throws when STEAMDB_GITHUB_TOKEN is missing, without ever invoking curl', async () => {
  let invoked = false;
  const execFileImpl = () => {
    invoked = true;
  };
  await assert.rejects(
    () => uploadAsset(
      { upload_url: 'https://uploads.github.com/repos/leinstay/steamdb/releases/1/assets{?name,label}' },
      '/tmp/steamdb.json',
      { execFileImpl, env: {} },
    ),
    /STEAMDB_GITHUB_TOKEN/,
  );
  assert.equal(invoked, false);
});

// --- createRelease ---------------------------------------------------------------------------------

test('createRelease: POSTs tag_name/target_commitish/name/body with draft and prerelease false', async () => {
  let captured;
  const fetchImpl = async (url, opts) => {
    captured = { url, opts };
    return jsonResponse(201, {
      id: 10,
      tag_name: 'dump-2026-09-28',
      upload_url: 'https://uploads.github.com/repos/leinstay/steamdb/releases/10/assets{?name,label}',
    });
  };

  const release = await createRelease(
    { tag: 'dump-2026-09-28', name: 'Data update 2026-09-28', body: 'notes here', target: 'main' },
    { fetchImpl, env: TOKEN_ENV },
  );

  assert.equal(captured.url, 'https://api.github.com/repos/leinstay/steamdb/releases');
  assert.equal(captured.opts.method, 'POST');
  assert.equal(captured.opts.headers.Authorization, 'token super-secret-token');

  const sentBody = JSON.parse(captured.opts.body);
  assert.equal(sentBody.tag_name, 'dump-2026-09-28');
  assert.equal(sentBody.target_commitish, 'main');
  assert.equal(sentBody.name, 'Data update 2026-09-28');
  assert.equal(sentBody.body, 'notes here');
  assert.equal(sentBody.draft, false);
  assert.equal(sentBody.prerelease, false);

  assert.equal(release.id, 10);
});

// --- uploadAsset -------------------------------------------------------------------------------------

test('uploadAsset: the token never appears in curl argv; the URL and Authorization header go through stdin', async () => {
  const { execFileImpl, calls } = makeFakeExecFile();
  const release = { upload_url: 'https://uploads.github.com/repos/leinstay/steamdb/releases/10/assets{?name,label}' };

  const asset = await uploadAsset(release, '/tmp/out/steamdb.json', { execFileImpl, env: TOKEN_ENV });

  assert.equal(asset.state, 'uploaded');
  assert.equal(calls.length, 1);
  const { cmd, args, stdinChunks } = calls[0];
  assert.equal(cmd, 'curl');

  const argvString = args.join(' ');
  assert.ok(!argvString.includes('super-secret-token'), `token must not appear in argv: ${argvString}`);
  assert.ok(!argvString.includes('uploads.github.com'), `upload URL must go through stdin, not argv: ${argvString}`);
  assert.ok(args.includes('--data-binary'));
  assert.ok(args.includes('@/tmp/out/steamdb.json'));
  assert.ok(args.includes('-K'));

  const stdin = stdinChunks.join('');
  assert.match(stdin, /header = "Authorization: token super-secret-token"/);
  assert.match(
    stdin,
    /url = "https:\/\/uploads\.github\.com\/repos\/leinstay\/steamdb\/releases\/10\/assets\?name=steamdb\.json"/,
  );
});

test('uploadAsset: throws when curl\'s JSON output does not report state "uploaded"', async () => {
  const { execFileImpl } = makeFakeExecFile({ stdout: JSON.stringify({ state: 'starter' }) });
  await assert.rejects(
    () => uploadAsset(
      { upload_url: 'https://uploads.github.com/repos/leinstay/steamdb/releases/10/assets{?name,label}' },
      '/tmp/steamdb.json',
      { execFileImpl, env: TOKEN_ENV },
    ),
    /state "uploaded"/,
  );
});

test('uploadAsset: propagates a curl process failure (e.g. --fail on a non-2xx response)', async () => {
  const curlError = new Error('Command failed: curl ...');
  const { execFileImpl } = makeFakeExecFile({ err: curlError });
  await assert.rejects(
    () => uploadAsset(
      { upload_url: 'https://uploads.github.com/repos/leinstay/steamdb/releases/10/assets{?name,label}' },
      '/tmp/steamdb.json',
      { execFileImpl, env: TOKEN_ENV },
    ),
    /Command failed/,
  );
});

// --- pruneReleases -----------------------------------------------------------------------------------

test('pruneReleases: keeps the `keep` newest releases by created_at, deletes the rest', async () => {
  const releases = [
    { id: 1, tag_name: 'dump-2026-09-26', created_at: '2026-09-26T23:48:00Z' },
    { id: 2, tag_name: 'dump-2026-09-27', created_at: '2026-09-27T23:48:00Z' },
    { id: 3, tag_name: 'dump-2026-09-28', created_at: '2026-09-28T23:48:00Z' },
  ];
  const deletedReleaseIds = [];
  const deletedTagRefs = [];

  const fetchImpl = async (url, opts) => {
    const method = opts.method || 'GET';
    if (method === 'GET' && url.includes('/releases?per_page=100')) return jsonResponse(200, releases);
    if (method === 'DELETE' && /\/releases\/\d+$/.test(url)) {
      deletedReleaseIds.push(Number(url.split('/').pop()));
      return jsonResponse(204, {});
    }
    if (method === 'DELETE' && url.includes('/git/refs/tags/')) {
      deletedTagRefs.push(decodeURIComponent(url.split('/git/refs/tags/')[1]));
      return jsonResponse(204, {});
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  };

  const { deleted } = await pruneReleases(2, { fetchImpl, env: TOKEN_ENV });

  assert.deepEqual(deleted, ['dump-2026-09-26']);
  assert.deepEqual(deletedReleaseIds, [1]);
  assert.deepEqual(deletedTagRefs, ['dump-2026-09-26']);
});

test('pruneReleases: a 404 deleting the tag ref is ignored (release is already gone)', async () => {
  const releases = [
    { id: 1, tag_name: 'dump-2026-09-26', created_at: '2026-09-26T23:48:00Z' },
    { id: 2, tag_name: 'dump-2026-09-27', created_at: '2026-09-27T23:48:00Z' },
  ];
  const fetchImpl = async (url, opts) => {
    const method = opts.method || 'GET';
    if (method === 'GET' && url.includes('/releases?per_page=100')) return jsonResponse(200, releases);
    if (method === 'DELETE' && /\/releases\/\d+$/.test(url)) return jsonResponse(204, {});
    if (method === 'DELETE' && url.includes('/git/refs/tags/')) return jsonResponse(404, { message: 'not found' });
    throw new Error(`unexpected fetch ${method} ${url}`);
  };
  const { deleted } = await pruneReleases(1, { fetchImpl, env: TOKEN_ENV });
  assert.deepEqual(deleted, ['dump-2026-09-26']);
});

// --- deleteRelease -------------------------------------------------------------------------------

test('deleteRelease: a 404 deleting the release itself is tolerated', async () => {
  const fetchImpl = async (url, opts) => {
    const method = opts.method || 'GET';
    if (method === 'DELETE' && url.endsWith('/releases/5')) return jsonResponse(404, {});
    if (method === 'DELETE' && url.includes('/git/refs/tags/')) return jsonResponse(204, {});
    throw new Error(`unexpected fetch ${method} ${url}`);
  };
  await assert.doesNotReject(() => deleteRelease({ id: 5, tag_name: 'dump-2026-09-20' }, { fetchImpl, env: TOKEN_ENV }));
});

test('deleteRelease: a non-404 error deleting the release throws', async () => {
  const fetchImpl = async (url, opts) => {
    if ((opts.method || 'GET') === 'DELETE' && url.endsWith('/releases/5')) return jsonResponse(500, {});
    throw new Error('git/refs/tags must not be reached when the release delete itself fails');
  };
  await assert.rejects(
    () => deleteRelease({ id: 5, tag_name: 'dump-2026-09-20' }, { fetchImpl, env: TOKEN_ENV }),
    /HTTP 500/,
  );
});

// --- publishDumpRelease (orchestration) ---------------------------------------------------------------

test('publishDumpRelease: deletes an existing same-day release before creating the new one', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const method = opts.method || 'GET';
    calls.push({ method, url });
    if (method === 'GET' && url.includes('/releases?per_page=100')) {
      return jsonResponse(200, [{ id: 9, tag_name: 'dump-2026-09-28', created_at: '2026-09-27T00:00:00Z' }]);
    }
    if (method === 'DELETE' && url.endsWith('/releases/9')) return jsonResponse(204, {});
    if (method === 'DELETE' && url.includes('/git/refs/tags/')) return jsonResponse(204, {});
    if (method === 'POST' && url.endsWith('/releases')) {
      return jsonResponse(201, {
        id: 10,
        tag_name: 'dump-2026-09-28',
        upload_url: 'https://uploads.github.com/repos/leinstay/steamdb/releases/10/assets{?name,label}',
      });
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  };
  const { execFileImpl } = makeFakeExecFile();

  const result = await publishDumpRelease(
    { date: '2026-09-28', notes: 'release notes', files: ['/tmp/steamdb.json'], target: 'main' },
    { fetchImpl, execFileImpl, env: TOKEN_ENV },
  );

  assert.equal(result.tag, 'dump-2026-09-28');
  const deleteIndex = calls.findIndex((c) => c.method === 'DELETE' && c.url.endsWith('/releases/9'));
  const createIndex = calls.findIndex((c) => c.method === 'POST' && c.url.endsWith('/releases'));
  assert.ok(deleteIndex !== -1 && createIndex !== -1, 'both the delete and the create must happen');
  assert.ok(deleteIndex < createIndex, 'the existing same-day release must be deleted before the new one is created');
});

test('publishDumpRelease: uploads every file in `files`, in order', async () => {
  let createdRelease;
  const fetchImpl = async (url, opts) => {
    const method = opts.method || 'GET';
    if (method === 'GET' && url.includes('/releases?per_page=100')) return jsonResponse(200, []);
    if (method === 'POST' && url.endsWith('/releases')) {
      createdRelease = {
        id: 11,
        tag_name: 'dump-2026-09-28',
        upload_url: 'https://uploads.github.com/repos/leinstay/steamdb/releases/11/assets{?name,label}',
      };
      return jsonResponse(201, createdRelease);
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  };
  const { execFileImpl, calls } = makeFakeExecFile();

  await publishDumpRelease(
    {
      date: '2026-09-28',
      notes: 'notes',
      files: ['/tmp/steamdb.json', '/tmp/steamdb.min.json', '/tmp/steamdb.min.json.gz'],
      target: 'main',
    },
    { fetchImpl, execFileImpl, env: TOKEN_ENV },
  );

  assert.equal(calls.length, 3);
  const uploadedNames = calls.map((c) => {
    const stdin = c.stdinChunks.join('');
    return /url = "[^"]*\?name=([^"]+)"/.exec(stdin)[1];
  });
  assert.deepEqual(uploadedNames, ['steamdb.json', 'steamdb.min.json', 'steamdb.min.json.gz']);
});
