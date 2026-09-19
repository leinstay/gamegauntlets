// GET /api/session — establishes (or reads) the gg_session cookie and hands the client its CSRF
// token, current user (if logged in), and language. This is the first call the frontend makes; every
// subsequent POST needs the csrf value this returns.

import { createSessionPayload, signSession, sessionCookieOptions, SESSION_COOKIE } from '../lib/session.js';

const querySchema = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      lang: { type: 'string', enum: ['en', 'ru', 'de', 'fr'] },
    },
  },
};

export default async function sessionRoutes(app) {
  app.get('/session', { schema: querySchema }, async (req, reply) => {
    let session = req.ggSession;
    let dirty = false;

    if (!session) {
      session = createSessionPayload({ lang: req.query.lang });
      dirty = true;
    } else if (req.query.lang && req.query.lang !== session.lang) {
      session = { ...session, lang: req.query.lang };
      dirty = true;
    }

    if (dirty) {
      reply.setCookie(SESSION_COOKIE, signSession(session, app.appEnv.SESSION_SECRET), sessionCookieOptions());
      req.ggSession = session;
    }

    let user = null;
    if (session.steamid) {
      user = await app.db.one(
        'SELECT steamid, name, avatar, level, status FROM users WHERE steamid = ? LIMIT 1',
        [session.steamid],
      );
      if (user) {
        const admins = app.appConfig.admins || [];
        user = { ...user, admin: admins.includes(String(session.steamid)) };
      }
    }

    return { csrf: session.csrf, user, lang: session.lang || 'en' };
  });
}
