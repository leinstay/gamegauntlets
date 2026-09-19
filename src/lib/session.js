// Signed session cookie: base64url(JSON payload) + '.' + HMAC-SHA256(payload, SESSION_SECRET).
// No server-side store — the cookie itself is the session. Payload shape:
// { sid, csrf, steamid?, lang? }. `sid` only identifies the session for logging/debugging
// (nothing is looked up by it); `csrf` is the token the client must echo back in
// X-CSRF-Token on every POST /api/*; `steamid` is set after a successful Steam login.

import crypto from 'node:crypto';

export const SESSION_COOKIE = 'gg_session';
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days

function base64urlEncode(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sign(payloadB64, secret) {
  return crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

/** Constant-time string comparison (equal-length requirement is checked first, which is safe:
 * it leaks only the length, never the content, and every value compared here has a fixed
 * expected length in practice — a session csrf/signature — so no useful timing signal escapes). */
export function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

/** Build a fresh session payload. Keeps `steamid`/`lang` when given, omits them otherwise
 * (never serialize explicit `undefined` into the JSON). */
export function createSessionPayload({ steamid, lang } = {}) {
  const payload = {
    sid: crypto.randomBytes(16).toString('hex'),
    csrf: crypto.randomBytes(24).toString('base64url'),
  };
  if (steamid) payload.steamid = String(steamid);
  if (lang) payload.lang = lang;
  return payload;
}

/** Sign a payload object into the `gg_session` cookie value. */
export function signSession(payload, secret) {
  if (!secret) throw new Error('signSession: secret is required');
  const payloadB64 = base64urlEncode(JSON.stringify(payload));
  return `${payloadB64}.${sign(payloadB64, secret)}`;
}

/**
 * Verify and decode a `gg_session` cookie value. Returns the payload object on success,
 * or null on any failure (missing, malformed, bad signature, tampered/invalid JSON) —
 * callers always get either "a trustworthy payload" or "nothing", never a half-checked value.
 */
export function verifySession(cookieValue, secret) {
  if (!secret) throw new Error('verifySession: secret is required');
  if (typeof cookieValue !== 'string' || !cookieValue) return null;

  const dot = cookieValue.lastIndexOf('.');
  if (dot === -1) return null;

  const payloadB64 = cookieValue.slice(0, dot);
  const sig = cookieValue.slice(dot + 1);
  const expectedSig = sign(payloadB64, secret);
  if (!timingSafeEqualStr(sig, expectedSig)) return null;

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    if (typeof payload.sid !== 'string' || typeof payload.csrf !== 'string') return null;
    return payload;
  } catch {
    return null;
  }
}

/** Cookie attributes shared by every place that sets `gg_session`. */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}
