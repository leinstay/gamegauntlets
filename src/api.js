// Fastify API server. `buildApp({ db, config, env, fetch })` assembles the app without touching the
// network or a real database — tests call it with a fake `db` (see tests/api/*.test.js) and
// `app.inject()`. Running this file directly (`npm run api` / `node src/api.js`) wires up the real
// `src/db.js` pool and `globalThis.fetch`, and listens on 127.0.0.1:PORT.

import { pathToFileURL } from 'node:url';

import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';

import { log } from './log.js';
import { SESSION_COOKIE, verifySession, timingSafeEqualStr } from './lib/session.js';
import { queueFor as realQueueFor, enqueue as realEnqueue, enqueueResolve as realEnqueueResolve } from './queue.js';

import sessionRoutes from './api/session.js';
import wheelRoutes from './api/wheel.js';
import gamesRoutes from './api/games.js';
import dictionariesRoutes from './api/dictionaries.js';
import statsRoutes from './api/stats.js';
import musicRoutes from './api/music.js';
import authRoutes from './api/auth.js';
import adminRoutes from './api/admin.js';

// Methods that require the CSRF + same-origin check in the onRequest hook below. POST covers the
// public wheel/auth endpoints; PUT/DELETE are only used by the admin API (src/api/admin.js), but the
// check is method-based (not route-based) so it applies uniformly to any future route too.
const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

/**
 * @param {object} deps
 * @param {{query: Function, one: Function}} deps.db
 * @param {object} deps.config - parsed config.json
 * @param {object} deps.env - process.env-shaped object (DB_*, SESSION_SECRET, PUBLIC_ORIGIN, STEAM_API_KEY, ...)
 * @param {typeof fetch} [deps.fetch] - injectable fetch, defaults to the global one
 * @param {Function} [deps.queueFor] - src/queue.js queueFor, injectable for tests (admin sources view)
 * @param {Function} [deps.enqueue] - src/queue.js enqueue, injectable for tests (admin refresh action)
 * @param {Function} [deps.enqueueResolve] - src/queue.js enqueueResolve, injectable for tests (admin overrides/resolve)
 */
export function buildApp({
  db,
  config,
  env,
  fetch: fetchImpl,
  queueFor: queueForImpl,
  enqueue: enqueueImpl,
  enqueueResolve: enqueueResolveImpl,
} = {}) {
  if (!db) throw new Error('buildApp: db is required');
  if (!config) throw new Error('buildApp: config is required');
  if (!env) throw new Error('buildApp: env is required');
  if (!env.SESSION_SECRET) throw new Error('buildApp: env.SESSION_SECRET is required');
  if (!env.PUBLIC_ORIGIN) throw new Error('buildApp: env.PUBLIC_ORIGIN is required');

  const doFetch = fetchImpl || globalThis.fetch;
  if (!doFetch) throw new Error('buildApp: no fetch implementation available (Node < 18?)');

  const app = Fastify({
    logger: false,
    // Only trust X-Forwarded-For when the direct connection is our own nginx on the loopback
    // interface — this is also what makes @fastify/rate-limit key on the real client IP instead of
    // 127.0.0.1 for every request once nginx is in front of the app.
    trustProxy: (address) => address === '127.0.0.1',
    // Fastify's default AJV options silently *strip* properties a schema doesn't declare
    // (`removeAdditional: true`) instead of rejecting the request, which would make every
    // `additionalProperties: false` in our route schemas a no-op. Turn that off so an unexpected
    // field actually fails validation (400) instead of being quietly dropped.
    ajv: { customOptions: { removeAdditional: false } },
  });

  app.decorate('db', db);
  app.decorate('appConfig', config);
  app.decorate('appEnv', env);
  app.decorate('doFetch', doFetch);
  app.decorate('queueFor', queueForImpl || realQueueFor);
  app.decorate('enqueue', enqueueImpl || realEnqueue);
  app.decorate('enqueueResolve', enqueueResolveImpl || realEnqueueResolve);
  app.decorateRequest('ggSession', null);

  app.register(fastifyCookie);
  // Default 300/min per IP on every /api route; wheel routes override to 60/min (see src/api/wheel.js)
  // — both keyed on req.ip, which respects the trustProxy rule above.
  app.register(fastifyRateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip,
  });

  const previewOrigins = Array.isArray(config?.site?.previewOrigins) ? config.site.previewOrigins : [];
  const allowedOrigins = new Set([env.PUBLIC_ORIGIN, ...previewOrigins]);

  // Runs for every request: decode the session cookie (if any) onto req.ggSession, then — for every
  // state-changing call — enforce same-origin + CSRF per the API contract ("Every POST requires
  // header X-CSRF-Token = session csrf and same-origin Origin (or Referer) = PUBLIC_ORIGIN (plus the
  // preview origin ... when NODE_ENV!=='production' || config.site.previewOrigins)"). GET routes
  // (including the two Steam OpenID browser-navigation routes, which cannot carry a custom header at
  // all) are read-only or self-establish the session and are exempt. PUT/DELETE are included in
  // STATE_CHANGING_METHODS alongside POST because the admin API (src/api/admin.js) uses them for
  // preset/user/override mutations, which need the same protection as any other state change.
  app.addHook('onRequest', async (req, reply) => {
    const cookieValue = req.cookies?.[SESSION_COOKIE];
    req.ggSession = cookieValue ? verifySession(cookieValue, env.SESSION_SECRET) : null;

    if (!STATE_CHANGING_METHODS.has(req.method) || !req.url.startsWith('/api/')) return;

    const origin = req.headers.origin;
    const referer = req.headers.referer;
    let sameOrigin = false;
    if (origin) {
      sameOrigin = allowedOrigins.has(origin);
    } else if (referer) {
      sameOrigin = [...allowedOrigins].some((o) => referer.startsWith(`${o}/`) || referer === o);
    }
    if (!sameOrigin) {
      reply.code(403).send({ error: 'forbidden_origin' });
      return reply;
    }

    const csrfHeader = req.headers['x-csrf-token'];
    if (!req.ggSession || typeof csrfHeader !== 'string' || !timingSafeEqualStr(csrfHeader, req.ggSession.csrf)) {
      reply.code(403).send({ error: 'forbidden_csrf' });
      return reply;
    }
  });

  app.addHook('onResponse', async (req, reply) => {
    log.info('request', { method: req.method, url: req.url, statusCode: reply.statusCode });
  });

  app.setErrorHandler((err, req, reply) => {
    if (err.validation) {
      reply.code(400).send({ error: 'invalid_request', details: err.message });
      return;
    }
    // Framework-level errors that already carry an intentional 4xx (e.g. @fastify/rate-limit's 429)
    // keep their status and message instead of being masked as a 500.
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      reply.code(err.statusCode).send({ error: err.message || 'request_error' });
      return;
    }
    log.error('unhandled_error', err);
    reply.code(500).send({ error: 'internal_error' });
  });

  app.register(sessionRoutes, { prefix: '/api' });
  app.register(wheelRoutes, { prefix: '/api' });
  app.register(gamesRoutes, { prefix: '/api' });
  app.register(dictionariesRoutes, { prefix: '/api' });
  app.register(statsRoutes, { prefix: '/api' });
  app.register(musicRoutes, { prefix: '/api' });
  app.register(authRoutes, { prefix: '/api' });
  app.register(adminRoutes, { prefix: '/api' });

  return app;
}

async function main() {
  const { env, config } = await import('./config.js');
  const { query, one, closePool } = await import('./db.js');

  const app = buildApp({ db: { query, one }, config, env, fetch: globalThis.fetch });
  const port = Number(env.PORT || 3000);

  try {
    await app.listen({ host: '127.0.0.1', port });
    log.info('api_listening', { port });
  } catch (err) {
    log.error('api_listen_failed', err);
    process.exit(1);
  }

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('api_shutting_down', { signal });
    try {
      await app.close();
      await closePool();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Only boot the server when this file is run directly (`node src/api.js`), not when imported by
// tests or other modules. Compared as file:// URLs (via pathToFileURL) so this also works with
// Windows drive-letter paths.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
