// GET /api/session — establishes (or reads) the gg_session cookie and hands the client its CSRF
// token, current user (if logged in), and language. This is the first call the frontend makes; every
// subsequent POST needs the csrf value this returns.
//
// Language detection order (owner's spec, "Goal A" item 2): explicit `?lang=` wins outright (also
// covers the legacy bare "?xx" query -- gg-boot.js's detectLangFromQuery() turns that into an
// explicit `lang` before ever calling this endpoint, so this route only ever sees `req.query.lang`)
// -> else, for a session that already exists, its saved language -> else (first visit, no query) the
// first supported match in the Accept-Language header (q-value ordered) -> else 'en'.

import { createSessionPayload, signSession, sessionCookieOptions, SESSION_COOKIE } from '../lib/session.js';
import { SUPPORTED, listLanguages, pickLanguageFromAcceptHeader } from '../lib/languages.js';

function configuredLanguages(app) {
  const languages = app.appConfig?.site?.languages;
  return Array.isArray(languages) && languages.length ? languages : SUPPORTED;
}

function buildQuerySchema(languages) {
  return {
    querystring: {
      type: 'object',
      additionalProperties: false,
      properties: {
        lang: { type: 'string', enum: languages },
      },
    },
  };
}

export default async function sessionRoutes(app) {
  const languages = configuredLanguages(app);
  const querySchema = buildQuerySchema(languages);

  app.get('/session', { schema: querySchema }, async (req, reply) => {
    let session = req.ggSession;
    let dirty = false;

    if (!session) {
      const detected = req.query.lang || pickLanguageFromAcceptHeader(req.headers['accept-language'], languages) || undefined;
      session = createSessionPayload({ lang: detected });
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

    return { csrf: session.csrf, user, lang: session.lang || 'en', languages: listLanguages(languages) };
  });
}
