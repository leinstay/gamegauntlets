// GitHub Releases client for the public leinstay/steamdb export (T?? — 2026-09-28 owner decision:
// GitHub keeps every git-lfs object ever pushed forever, so committing the dump files (1.15 GB/night)
// grew the repo without bound. The dump is now published as a GitHub Release instead — the repo itself
// keeps only README.md/LICENSE/.gitignore (see src/pipeline/export-push.js's commitAndPush()) — and only
// the two newest releases are kept (pruneReleases()).
//
// Every exported function takes an injectable `{ fetchImpl, execFileImpl, env }` (all default to the
// real thing) so tests run with zero network/process access — see tests/github-release.test.js.
//
// JSON calls (list/create/delete) use the global `fetch`. Asset upload is the one exception: the dump
// files are up to 615 MB, so `fetch`-with-a-Buffer-body (or anything that reads the file into memory
// first) is a non-starter on a box this size — uploadAsset() shells out to `curl --data-binary @file`
// instead, which streams the file straight from disk. The GitHub token must never appear in a process
// argv (visible to any other user/process via `ps`), so it's passed to curl as a `-K -` config file on
// stdin (`header = "Authorization: token ..."`), never as a `-H` argv flag.
//
// Nothing here logs a response body or header — GitHub error bodies can echo request details back, and
// there is no reason to keep them around in the worker's structured JSON log; every log call below is a
// short fixed message plus a handful of already-known-safe fields (tag, file name, counts).

import { execFile } from 'node:child_process';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../log.js';

const API_BASE = 'https://api.github.com';
const DEFAULT_REPO = 'leinstay/steamdb';
const DEFAULT_KEEP_RELEASES = 2;
const UPLOAD_TIMEOUT_MS = 30 * 60 * 1000; // curl upload of up to ~615 MB
const UPLOAD_MAX_BUFFER = 10 * 1024 * 1024; // curl's stdout is just the small asset JSON, not the file

function repoSlug() {
  return config.export?.githubRepo || DEFAULT_REPO;
}

function keepReleasesCount() {
  return config.export?.keepReleases ?? DEFAULT_KEEP_RELEASES;
}

/** Throws a clear, specific error rather than letting a later 401 from GitHub stand in for it. */
function requireToken(env) {
  const token = env.STEAMDB_GITHUB_TOKEN;
  if (!token) {
    throw new Error('github-release: STEAMDB_GITHUB_TOKEN is not set (required to publish a release)');
  }
  return token;
}

function jsonHeaders(token) {
  return {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'gamegauntlets-export',
  };
}

/** GET/POST/DELETE against the GitHub REST API. `body`, when given, is JSON-encoded. Never logs the response. */
async function githubJson(fetchImpl, token, method, urlPath, body) {
  const res = await fetchImpl(`${API_BASE}${urlPath}`, {
    method,
    headers: {
      ...jsonHeaders(token),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return res;
}

// --- releases: list / create / delete / prune ------------------------------------------------------

export async function listReleases({ fetchImpl = fetch, env = process.env } = {}) {
  const token = requireToken(env);
  const res = await githubJson(fetchImpl, token, 'GET', `/repos/${repoSlug()}/releases?per_page=100`);
  if (!res.ok) throw new Error(`github-release: listReleases failed with HTTP ${res.status}`);
  return res.json();
}

export async function createRelease({ tag, name, body, target }, { fetchImpl = fetch, env = process.env } = {}) {
  const token = requireToken(env);
  const res = await githubJson(fetchImpl, token, 'POST', `/repos/${repoSlug()}/releases`, {
    tag_name: tag,
    target_commitish: target,
    name,
    body,
    draft: false,
    prerelease: false,
  });
  if (!res.ok) throw new Error(`github-release: createRelease failed with HTTP ${res.status}`);
  return res.json();
}

/**
 * Delete a release and its tag ref. The tag delete is best-effort: 404 (never existed / already gone)
 * and 422 (GitHub occasionally reports this for a ref it's still tidying up right after the release
 * delete) are both ignored — the release itself is already gone either way, which is what matters.
 */
export async function deleteRelease(release, { fetchImpl = fetch, env = process.env } = {}) {
  const token = requireToken(env);
  const res = await githubJson(fetchImpl, token, 'DELETE', `/repos/${repoSlug()}/releases/${release.id}`);
  if (!res.ok && res.status !== 404) {
    throw new Error(`github-release: deleteRelease failed with HTTP ${res.status}`);
  }
  if (release.tag_name) {
    const tagRes = await githubJson(
      fetchImpl,
      token,
      'DELETE',
      `/repos/${repoSlug()}/git/refs/tags/${encodeURIComponent(release.tag_name)}`,
    );
    if (!tagRes.ok && tagRes.status !== 404 && tagRes.status !== 422) {
      throw new Error(`github-release: deleting tag ref failed with HTTP ${tagRes.status}`);
    }
  }
}

/**
 * Keep the `keep` newest releases (by `created_at`) and delete the rest. Sorts defensively rather than
 * trusting GitHub's own `per_page` ordering (it's already newest-first, but that's not documented as a
 * hard guarantee worth relying on for a destructive operation).
 */
export async function pruneReleases(keep = keepReleasesCount(), opts = {}) {
  const releases = await listReleases(opts);
  const sorted = [...releases].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const toDelete = sorted.slice(keep);
  for (const release of toDelete) {
    await deleteRelease(release, opts);
    log.info('github-release: pruned old release', { tag: release.tag_name });
  }
  return { deleted: toDelete.map((r) => r.tag_name) };
}

// --- asset upload (curl, streamed from disk) --------------------------------------------------------

/** Strip GitHub's `{?name,label}` URI template suffix off a release's `upload_url`. */
export function stripUploadUrlTemplate(uploadUrl) {
  return uploadUrl.replace(/\{[^}]*\}$/, '');
}

/**
 * Upload one file to `release` as a release asset via `curl --data-binary @file` — see the module
 * header for why curl (not `fetch`) and why the token goes in on stdin rather than in argv. `execFileImpl`
 * must have Node's `execFile` callback signature: it's called directly (not through `util.promisify`)
 * because the real implementation needs the synchronously-returned `ChildProcess` to write the `-K`
 * config to its stdin before the callback fires.
 */
export async function uploadAsset(release, filePath, { execFileImpl = execFile, env = process.env } = {}) {
  const token = requireToken(env);
  const name = path.basename(filePath);
  const uploadUrl = `${stripUploadUrlTemplate(release.upload_url)}?name=${encodeURIComponent(name)}`;

  // curl config file (`-K -`): the URL and the Authorization header live here, not in argv — argv is
  // visible to any other process on the box (`ps`), stdin isn't. Double quotes in either value are
  // escaped; neither the token nor a GitHub upload URL is expected to contain one, this is defence in
  // depth only.
  const escape = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const curlConfig = [`url = "${escape(uploadUrl)}"`, `header = "Authorization: token ${escape(token)}"`].join('\n');

  const args = [
    '--fail',
    '--silent',
    '--show-error',
    '-X',
    'POST',
    '-H',
    'Content-Type: application/octet-stream',
    '--data-binary',
    `@${filePath}`,
    '-K',
    '-',
  ];

  const stdout = await new Promise((resolve, reject) => {
    const child = execFileImpl(
      'curl',
      args,
      { timeout: UPLOAD_TIMEOUT_MS, maxBuffer: UPLOAD_MAX_BUFFER },
      (err, out) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(out);
      },
    );
    child.stdin.write(curlConfig);
    child.stdin.end();
  });

  let asset;
  try {
    asset = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`github-release: uploadAsset got non-JSON output from curl for ${name}: ${err.message}`);
  }
  if (asset.state !== 'uploaded') {
    throw new Error(`github-release: uploadAsset for ${name} did not report state "uploaded" (got "${asset.state}")`);
  }
  return asset;
}

// --- orchestration -----------------------------------------------------------------------------------

// The date IS the version: tag and release name are both `YYYY-MM-DD` (owner's wish, 2026-09-28); GitHub marks
// the newest one "Latest" by itself.
export function tagForDate(date) {
  return String(date);
}

/**
 * Publish one night's dump as a GitHub Release: create `<date>` (deleting a same-tag release first
 * — a same-day re-run), upload `files` to it, then prune down to the configured number of kept releases.
 * Throws on any step's failure; the caller (src/pipeline/export-push.js) treats that as the export job
 * failing, same as a git push failure always has.
 */
export async function publishDumpRelease({ date, notes, files, target }, opts = {}) {
  const { fetchImpl = fetch, execFileImpl = execFile, env = process.env } = opts;
  const callOpts = { fetchImpl, execFileImpl, env };
  requireToken(env); // fail before doing anything, not partway through

  const tag = tagForDate(date);
  const name = String(date);

  const existing = await listReleases(callOpts);
  const same = existing.find((r) => r.tag_name === tag);
  if (same) {
    await deleteRelease(same, callOpts);
    log.info('github-release: replaced existing same-day release', { tag });
  }

  const release = await createRelease({ tag, name, body: notes, target }, callOpts);
  log.info('github-release: created release', { tag });

  for (const filePath of files) {
    await uploadAsset(release, filePath, callOpts);
    log.info('github-release: uploaded asset', { tag, name: path.basename(filePath) });
  }

  const { deleted } = await pruneReleases(keepReleasesCount(), callOpts);
  log.info('github-release: publish complete', { tag, prunedCount: deleted.length });

  return { tag, id: release.id, name };
}
