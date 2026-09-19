import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  createSessionPayload,
  signSession,
  verifySession,
  timingSafeEqualStr,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
} from '../../src/lib/session.js';

const SECRET = 'test-secret-do-not-use-in-prod';

test('SESSION_COOKIE / SESSION_MAX_AGE_SECONDS constants', () => {
  assert.equal(SESSION_COOKIE, 'gg_session');
  assert.equal(SESSION_MAX_AGE_SECONDS, 30 * 24 * 60 * 60);
});

test('createSessionPayload: has sid and csrf, omits steamid/lang when not given', () => {
  const payload = createSessionPayload();
  assert.equal(typeof payload.sid, 'string');
  assert.ok(payload.sid.length > 0);
  assert.equal(typeof payload.csrf, 'string');
  assert.ok(payload.csrf.length > 0);
  assert.equal('steamid' in payload, false);
  assert.equal('lang' in payload, false);
});

test('createSessionPayload: keeps steamid/lang when given, two calls never collide', () => {
  const a = createSessionPayload({ steamid: '76561198000000000', lang: 'ru' });
  const b = createSessionPayload({ steamid: '76561198000000000', lang: 'ru' });
  assert.equal(a.steamid, '76561198000000000');
  assert.equal(a.lang, 'ru');
  assert.notEqual(a.sid, b.sid);
  assert.notEqual(a.csrf, b.csrf);
});

test('sign + verify: round-trips a payload', () => {
  const payload = createSessionPayload({ steamid: '76561198000000001' });
  const cookie = signSession(payload, SECRET);
  const decoded = verifySession(cookie, SECRET);
  assert.deepEqual(decoded, payload);
});

test('verify: wrong secret is rejected', () => {
  const payload = createSessionPayload();
  const cookie = signSession(payload, SECRET);
  assert.equal(verifySession(cookie, 'a-different-secret'), null);
});

test('verify: tampered payload (bit flipped in the base64url payload segment) is rejected', () => {
  const payload = createSessionPayload({ steamid: '76561198000000002' });
  const cookie = signSession(payload, SECRET);
  const [payloadB64, sig] = cookie.split('.');
  // Flip the payload but keep the original signature — must fail even though both parts still
  // "look" structurally valid.
  const tamperedPayload = payloadB64.slice(0, -1) + (payloadB64.at(-1) === 'A' ? 'B' : 'A');
  assert.equal(verifySession(`${tamperedPayload}.${sig}`, SECRET), null);
});

test('verify: tampered signature is rejected', () => {
  const payload = createSessionPayload();
  const cookie = signSession(payload, SECRET);
  const [payloadB64, sig] = cookie.split('.');
  const tamperedSig = sig.slice(0, -1) + (sig.at(-1) === 'A' ? 'B' : 'A');
  assert.equal(verifySession(`${payloadB64}.${tamperedSig}`, SECRET), null);
});

test('verify: missing dot separator, empty string, non-string, and non-JSON payload all return null', () => {
  assert.equal(verifySession('not-a-valid-cookie', SECRET), null);
  assert.equal(verifySession('', SECRET), null);
  assert.equal(verifySession(undefined, SECRET), null);
  assert.equal(verifySession(null, SECRET), null);
  const bogusPayload = Buffer.from('not json').toString('base64url');
  const sig = signSession({ sid: 'x', csrf: 'y' }, SECRET).split('.')[1];
  assert.equal(verifySession(`${bogusPayload}.${sig}`, SECRET), null);
});

test('verify: payload missing required sid/csrf fields is rejected even with a valid signature', () => {
  const payloadB64 = Buffer.from(JSON.stringify({ foo: 'bar' })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(payloadB64).digest('base64url');
  assert.equal(verifySession(`${payloadB64}.${sig}`, SECRET), null);
});

test('timingSafeEqualStr: equal/unequal/different-length/non-string inputs', () => {
  assert.equal(timingSafeEqualStr('abc', 'abc'), true);
  assert.equal(timingSafeEqualStr('abc', 'abd'), false);
  assert.equal(timingSafeEqualStr('abc', 'abcd'), false);
  assert.equal(timingSafeEqualStr('abc', 123), false);
  assert.equal(timingSafeEqualStr(null, 'abc'), false);
});
