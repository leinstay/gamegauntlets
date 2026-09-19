// GET /api/auth/steam (redirect to Steam), GET /api/auth/steam/callback (verify + log in),
// POST /api/auth/logout. See src/lib/steam-openid.js for the OpenID mechanics.
//
// NEEDS REVIEW: legacy (`legacy/ajax/scripts/auth.php`) redirects with a *permanent* 301 after login
// and logout. A 301 on a login/logout endpoint is cacheable by the browser, which can make it keep
// "logging in" or "logging out" from cache without ever hitting the server again — this looks like a
// legacy bug rather than an intentional choice, so this file uses Fastify's default 302 instead.
// Flagging in case there was a reason (e.g. a CDN rule) that isn't visible from the code alone.

import {
  buildAuthUrl,
  verifyCallback,
  getPlayerSummary,
} from '../lib/steam-openid.js';
import { createSessionPayload, signSession, sessionCookieOptions, SESSION_COOKIE } from '../lib/session.js';

function callbackUrl(publicOrigin) {
  return `${publicOrigin}/api/auth/steam/callback`;
}

export default async function authRoutes(app) {
  app.get('/auth/steam', async (req, reply) => {
    const publicOrigin = app.appEnv.PUBLIC_ORIGIN;
    const url = buildAuthUrl({ returnTo: callbackUrl(publicOrigin), realm: publicOrigin });
    reply.redirect(url);
  });

  app.get('/auth/steam/callback', async (req, reply) => {
    const publicOrigin = app.appEnv.PUBLIC_ORIGIN;
    const result = await verifyCallback(req.query, {
      returnTo: callbackUrl(publicOrigin),
      fetch: app.doFetch,
    });

    if (!result) {
      reply.redirect(`${publicOrigin}/`);
      return;
    }

    const { steamid } = result;
    const existing = await app.db.one('SELECT steamid FROM users WHERE steamid = ? LIMIT 1', [steamid]);

    if (!existing) {
      const summary = await getPlayerSummary(steamid, { apiKey: app.appEnv.STEAM_API_KEY, fetch: app.doFetch });
      await app.db.query('INSERT INTO users (steamid, name, avatar, profile_url) VALUES (?, ?, ?, ?)', [
        steamid,
        summary?.name ?? null,
        summary?.avatar ?? null,
        summary?.profileUrl ?? null,
      ]);
    }

    await app.db.query('INSERT INTO user_logins (steamid) VALUES (?)', [steamid]);
    await app.db.query('UPDATE users SET last_login_at = NOW() WHERE steamid = ?', [steamid]);

    // Rotate the session on login (new sid/csrf) rather than reuse the pre-login one, so a session
    // fixed before authentication can't be reused as an authenticated one.
    const session = createSessionPayload({ steamid, lang: req.ggSession?.lang });
    reply.setCookie(SESSION_COOKIE, signSession(session, app.appEnv.SESSION_SECRET), sessionCookieOptions());
    reply.redirect(`${publicOrigin}/`);
  });

  app.post('/auth/logout', async (req, reply) => {
    // Rotate again on logout so the old (authenticated) csrf/sid can't linger anywhere.
    const session = createSessionPayload({ lang: req.ggSession?.lang });
    reply.setCookie(SESSION_COOKIE, signSession(session, app.appEnv.SESSION_SECRET), sessionCookieOptions());
    return { ok: true };
  });
}
