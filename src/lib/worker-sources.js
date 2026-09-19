// Pure helper for src/worker.js: decides, from two env vars, which source
// modules the current process should start a BullMQ Worker for.
//
// - `WORKER_SOURCES=a,b`         -> run ONLY these sources ("only" mode).
// - `WORKER_EXCLUDE_SOURCES=a,b` -> run every registered source EXCEPT these
//   ("exclude" mode).
// - Both unset                   -> run every registered source ("all" mode,
//   today's behaviour).
// - Both set                     -> WORKER_SOURCES wins; a warning is
//   reported (never thrown) via the injected `warn`.
// - An unknown name (not a registered source, case-insensitive) is reported
//   via `warn` and otherwise ignored — it never appears in the result and
//   never makes the whole value invalid.
//
// No I/O: `env` and `availableNames` are passed in explicitly so this is
// trivially unit-testable and safe to call at module-eval time.

/** Split a `WORKER_SOURCES`-style value on commas, trimming whitespace and
 * dropping empty entries. `undefined`/`''` yields `[]`. */
function parseList(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Resolve `names` (raw, possibly mixed-case/whitespace-padded) against
 * `availableNames` case-insensitively. Returns the set of matched canonical
 * names (in `availableNames`'s own casing); calls `warn` once per name that
 * doesn't match anything.
 */
function matchNames(names, availableNames, warn) {
  const byLowerCase = new Map(availableNames.map((name) => [name.toLowerCase(), name]));
  const matched = new Set();
  for (const name of names) {
    const canonical = byLowerCase.get(name.toLowerCase());
    if (!canonical) {
      warn(`worker-sources: unknown source "${name}", ignoring`, { name });
      continue;
    }
    matched.add(canonical);
  }
  return matched;
}

/**
 * @param {object} env - process.env (or a fake), read for WORKER_SOURCES /
 *   WORKER_EXCLUDE_SOURCES only.
 * @param {string[]} availableNames - every registered source's `name`
 *   (e.g. `sources.map((mod) => mod.name)` from src/sources/index.js).
 * @param {{ warn?: (msg: string, meta?: object) => void }} [options] - `warn`
 *   defaults to a no-op so callers that don't care about diagnostics don't
 *   need to pass one.
 * @returns {{ mode: 'all'|'only'|'exclude', names: string[] }} `names` is
 *   always a subset of `availableNames`, in `availableNames`'s order.
 */
export function resolveWorkerSources(env, availableNames, { warn = () => {} } = {}) {
  const only = parseList(env.WORKER_SOURCES);
  const exclude = parseList(env.WORKER_EXCLUDE_SOURCES);

  if (only.length > 0 && exclude.length > 0) {
    warn('worker-sources: both WORKER_SOURCES and WORKER_EXCLUDE_SOURCES set; WORKER_SOURCES takes precedence', {
      WORKER_SOURCES: env.WORKER_SOURCES,
      WORKER_EXCLUDE_SOURCES: env.WORKER_EXCLUDE_SOURCES,
    });
  }

  if (only.length > 0) {
    const wanted = matchNames(only, availableNames, warn);
    return { mode: 'only', names: availableNames.filter((name) => wanted.has(name)) };
  }

  if (exclude.length > 0) {
    const unwanted = matchNames(exclude, availableNames, warn);
    return { mode: 'exclude', names: availableNames.filter((name) => !unwanted.has(name)) };
  }

  return { mode: 'all', names: [...availableNames] };
}
