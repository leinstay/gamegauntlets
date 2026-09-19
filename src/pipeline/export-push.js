#!/usr/bin/env node
// CLI + worker entry point for the nightly steamdb export (T20). Wraps
// src/pipeline/export.js's pure data pipeline with:
//   - config/env wiring (config.export.steamdbRepoDir, config.export.enabled)
//   - the git add/commit/push step (legacy/ajax/misc/exec.sh's job), with a
//     "skip the commit when nothing changed" check exec.sh never had, plus a
//     `git rm` of any leftover gogdb.* files from before the 2026-09-19
//     one-dump change (see src/pipeline/export.js's header, removeLeftoverGogdbFiles() below)
//   - CLI flags for manual/dry runs: --out <dir>, --no-push, --chunk-size <n>
//
// Dynamically imported by src/pipeline/maintenance.js's runExport() as the
// worker's `maintenance` 'export' job — that call is `main()`/the default
// export with no arguments, so both must work standalone, reading
// config/env themselves. Importing this file must never touch a database
// (mirrors scripts/migrate.js/migrate-legacy.js): src/db.js opens its pool
// at import time, so it is imported lazily, only inside exportAndPush(),
// not at module top level — a maintenance job that never actually runs the
// export (e.g. config.export.enabled is false) never needs DB_HOST/DB_NAME
// to be set at all.
//
// Lead decision (2026-09-19): the legacy site's own exec.sh cron still
// pushes to leinstay/steamdb at 23:48 UTC on the same server the new
// worker's repeatable 'maintenance:export' job runs on, at the same time —
// running both at once would race two pushes to the same repo. So the
// worker-triggered nightly job (main(), below) is a no-op unless
// config.export.enabled is true; a manual CLI run always executes
// regardless of that flag (it's explicitly requested, and --no-push/--out
// make it safe to use for tests/dry runs even before cutover).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import { log } from '../log.js';
import { runFullExport } from './export.js';
import { collectStats, renderReadme } from './export-readme.js';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function humanSize(bytes) {
  if (!Number.isFinite(bytes)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
}

/**
 * `runFullExport()`'s result (a single runExport() result: steamdb.json/.min.json/.min.json.gz) + the
 * files it actually wrote on disk -> the `files` array renderReadme() puts in the README's "Files"
 * table (name, row count, on-disk size). Reads sizes from disk rather than trusting anything computed
 * earlier — the README should describe exactly the bytes sitting next to it in the same commit.
 */
function describeDumpFiles(result) {
  const entries = [
    [result.prettyPath, result.count],
    [result.minPath, result.count],
    [result.gzPath, result.count],
  ];
  return entries.map(([filePath, rows]) => ({
    name: path.basename(filePath),
    rows,
    size: humanSize(fs.statSync(filePath).size),
  }));
}

async function git(dir, args) {
  return execFileAsync('git', args, { cwd: dir, timeout: GIT_TIMEOUT_MS });
}

// steamdb.json/.min.json/.min.json.gz replaced a short-lived second gogdb.* file pair (dropped
// 2026-09-19, see src/pipeline/export.js's header) — a repo checkout from before that change may still
// have gogdb.* tracked. Removed unconditionally, every run, so they disappear from the public repo on
// the first push after this change and stay gone afterwards.
const LEFTOVER_GOGDB_FILES = ['gogdb.json', 'gogdb.min.json', 'gogdb.min.json.gz'];

/**
 * `git rm --ignore-unmatch` the leftover gogdb.* files from `dir` (a no-op, no error, if none of them
 * are tracked — covers both "never existed" and "already removed"). Staged, not committed — the caller
 * commits everything together with the fresh dump/README in one commit, same as always.
 */
async function removeLeftoverGogdbFiles(dir) {
  await git(dir, ['rm', '-f', '--ignore-unmatch', ...LEFTOVER_GOGDB_FILES]);
}

/**
 * `git add -A && git commit -m "Data update <date>" && git push origin
 * main` in `dir`, skipping the commit (and push) entirely when there is
 * nothing to commit. Never logs git's stdout/stderr — `dir` is a checkout
 * with git-lfs and stored credentials (leinstay's ~/.git-credentials); only
 * short, fixed summaries are logged, never command output.
 *
 * Only called when `push` is true (see exportAndPush) — `--no-push`/
 * `push: false` is the dry-run flag and must not touch git at all: `--out`
 * is explicitly for writing to an arbitrary directory for tests/dry runs
 * (per the task), which in general isn't even a git checkout, so this
 * can't be reached to begin with unless a real push was requested.
 */
export async function commitAndPush(dir) {
  await removeLeftoverGogdbFiles(dir);
  const status = await git(dir, ['status', '--porcelain']);
  if (!status.stdout.trim()) {
    log.info('export: no changes, skipping commit', { dir });
    return { committed: false, pushed: false };
  }
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-m', `Data update ${todayUtc()}`]);
  await git(dir, ['push', 'origin', 'main']);
  log.info('export: committed and pushed', { dir });
  return { committed: true, pushed: true };
}

/**
 * Core export used by both the CLI and the worker: run the data pipeline
 * (src/pipeline/export.js's runFullExport — steamdb.json/.min.json/.min.json.gz, both kinds in one
 * dump), regenerate README.md (src/pipeline/export-readme.js) from fresh stats so it always describes
 * exactly the dump files sitting next to it, then commit+push in `dir` unless `push` is false — the
 * dry-run path (`--no-push`, typically paired with `--out <dir>` pointing somewhere that usually isn't
 * even a git checkout) writes files only and never invokes git.
 */
export async function exportAndPush({ outDir, push = true, chunkSize } = {}) {
  const dir = outDir ?? config.export?.steamdbRepoDir;
  if (!dir) throw new Error('export: no output directory (pass --out or set config.export.steamdbRepoDir)');

  const { query } = await import('../db.js');
  const db = { query };
  const result = await runFullExport({ db, log }, { outDir: dir, chunkSize });

  const statsStartedAt = Date.now();
  const stats = await collectStats(db);
  const statsMs = Date.now() - statsStartedAt;
  log.info('export: stats collected', { ms: statsMs });

  stats.files = describeDumpFiles(result);
  // The README's "Example" section is the first row runFullExport() actually wrote (already mapped and
  // in memory — nothing extra read from disk); omitted by renderReadme() when the export was empty.
  stats.example = result.firstRow ?? null;
  const readme = renderReadme(stats, { generatedAt: new Date() });
  fs.writeFileSync(path.join(dir, 'README.md'), readme);

  if (!push) {
    log.info('export: push skipped (--no-push), git untouched', { dir });
    return { ...result, statsMs, committed: false, pushed: false };
  }
  const gitResult = await commitAndPush(dir);
  return { ...result, statsMs, ...gitResult };
}

/**
 * Worker entry point: src/pipeline/maintenance.js dynamically imports this
 * module and calls `main()`/the default export with no arguments. A no-op
 * unless config.export.enabled is true (see file header).
 */
export async function main() {
  if (!config.export?.enabled) {
    log.info('export disabled (config.export.enabled is not true)');
    return { skipped: true, reason: 'disabled' };
  }
  return exportAndPush({});
}

export default main;

// --- CLI ---------------------------------------------------------------

export function parseArgs(argv) {
  const opts = { push: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      opts.outDir = argv[i + 1];
      i += 1;
    } else if (arg === '--no-push') {
      opts.push = false;
    } else if (arg === '--chunk-size') {
      opts.chunkSize = Number(argv[i + 1]);
      i += 1;
    } else {
      throw new Error(`export-steamdb: unknown argument "${arg}"`);
    }
  }
  return opts;
}

async function runCli(argv) {
  const opts = parseArgs(argv);
  const result = await exportAndPush(opts);
  log.info('export: CLI run complete', {
    count: result.count,
    statsMs: result.statsMs,
    committed: result.committed,
    pushed: result.pushed,
    outDir: result.prettyPath && path.dirname(result.prettyPath),
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runCli(process.argv.slice(2))
    .catch((err) => {
      log.error('export: CLI run failed', err);
      process.exitCode = 1;
    })
    // The DB pool keeps the event loop alive; a one-shot CLI run has to close it to exit (the worker, which
    // imports exportAndPush() instead, keeps its pool open on purpose).
    .finally(async () => {
      const { closePool } = await import('../db.js');
      await closePool().catch(() => {});
    });
}
