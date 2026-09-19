import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAuthUrl,
  extractSteamId,
  verifyCallback,
  getPlayerSummary,
  getOwnedGames,
} from '../../src/lib/steam-openid.js';

const RETURN_TO = 'https://gamegauntlets.com/api/auth/steam/callback';
const REALM = 'https://gamegauntlets.com';
const STEAMID = '76561198000000010';
const CLAIMED_ID = `https://steamcommunity.com/openid/id/${STEAMID}`;

function validQuery(overrides = {}) {
  return {
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'id_res',
    'openid.op_endpoint': 'https://steamcommunity.com/openid/login',
    'openid.claimed_id': CLAIMED_ID,
    'openid.identity': CLAIMED_ID,
    'openid.return_to': RETURN_TO,
    'openid.response_nonce': '2026-09-19T00:00:00Zabc123',
    'openid.assoc_handle': 'handle123',
    'openid.signed': 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle',
    'openid.sig': 'deadbeef==',
    ...overrides,
  };
}

function fakeFetch(response) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return response;
  };
  fn.calls = calls;
  return fn;
}

test('buildAuthUrl: points at Steam with checkid_setup, return_to and realm', () => {
  const url = buildAuthUrl({ returnTo: RETURN_TO, realm: REALM });
  assert.ok(url.startsWith('https://steamcommunity.com/openid/login?'));
  const params = new URL(url).searchParams;
  assert.equal(params.get('openid.mode'), 'checkid_setup');
  assert.equal(params.get('openid.return_to'), RETURN_TO);
  assert.equal(params.get('openid.realm'), REALM);
  assert.equal(params.get('openid.ns'), 'http://specs.openid.net/auth/2.0');
  assert.equal(params.get('openid.identity'), 'http://specs.openid.net/auth/2.0/identifier_select');
});

test('extractSteamId: valid claimed_id URL, and rejects everything else', () => {
  assert.equal(extractSteamId(CLAIMED_ID), STEAMID);
  assert.equal(extractSteamId('https://steamcommunity.com/openid/id/123'), null); // too short, wrong prefix
  assert.equal(extractSteamId('https://evil.example/openid/id/76561198000000010'), null);
  assert.equal(extractSteamId('not a url'), null);
  assert.equal(extractSteamId(null), null);
  assert.equal(extractSteamId(undefined), null);
});

test('verifyCallback: valid assertion confirmed by Steam returns the steamid', async () => {
  const fetch = fakeFetch({ ok: true, text: async () => 'ns:http://specs.openid.net/auth/2.0\nis_valid:true\n' });
  const result = await verifyCallback(validQuery(), { returnTo: RETURN_TO, fetch });
  assert.deepEqual(result, { steamid: STEAMID });

  // check_authentication must be a POST with openid.mode flipped, everything else preserved.
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].opts.method, 'POST');
  const sentParams = new URLSearchParams(fetch.calls[0].opts.body);
  assert.equal(sentParams.get('openid.mode'), 'check_authentication');
  assert.equal(sentParams.get('openid.sig'), 'deadbeef==');
  assert.equal(sentParams.get('openid.assoc_handle'), 'handle123');
});

test('verifyCallback: Steam saying is_valid:false rejects the assertion', async () => {
  const fetch = fakeFetch({ ok: true, text: async () => 'is_valid:false\n' });
  const result = await verifyCallback(validQuery(), { returnTo: RETURN_TO, fetch });
  assert.equal(result, null);
});

test('verifyCallback: non-OK HTTP response from Steam rejects the assertion', async () => {
  const fetch = fakeFetch({ ok: false, text: async () => '' });
  const result = await verifyCallback(validQuery(), { returnTo: RETURN_TO, fetch });
  assert.equal(result, null);
});

test('verifyCallback: wrong openid.mode is rejected before any network call', async () => {
  const fetch = fakeFetch({ ok: true, text: async () => 'is_valid:true' });
  const result = await verifyCallback(validQuery({ 'openid.mode': 'cancel' }), { returnTo: RETURN_TO, fetch });
  assert.equal(result, null);
  assert.equal(fetch.calls.length, 0);
});

test('verifyCallback: return_to mismatch is rejected before any network call (replay protection)', async () => {
  const fetch = fakeFetch({ ok: true, text: async () => 'is_valid:true' });
  const result = await verifyCallback(validQuery({ 'openid.return_to': 'https://evil.example/callback' }), {
    returnTo: RETURN_TO,
    fetch,
  });
  assert.equal(result, null);
  assert.equal(fetch.calls.length, 0);
});

test('verifyCallback: forged claimed_id (wrong host) is rejected before any network call', async () => {
  const fetch = fakeFetch({ ok: true, text: async () => 'is_valid:true' });
  const forged = 'https://steamcommunity.evil.com/openid/id/76561198000000010';
  const result = await verifyCallback(validQuery({ 'openid.claimed_id': forged, 'openid.identity': forged }), {
    returnTo: RETURN_TO,
    fetch,
  });
  assert.equal(result, null);
  assert.equal(fetch.calls.length, 0);
});

test('verifyCallback: forged claimed_id (not a "7" SteamID64) is rejected', async () => {
  const fetch = fakeFetch({ ok: true, text: async () => 'is_valid:true' });
  const forged = 'https://steamcommunity.com/openid/id/12345';
  const result = await verifyCallback(validQuery({ 'openid.claimed_id': forged, 'openid.identity': forged }), {
    returnTo: RETURN_TO,
    fetch,
  });
  assert.equal(result, null);
  assert.equal(fetch.calls.length, 0);
});

test('verifyCallback: even a "successful" is_valid response is ignored if the mode/return_to/claimed_id checks fail first', async () => {
  // Steam would never actually say is_valid:true for a request check_authentication was never sent
  // for, but this pins that we check *before* trusting any network response.
  const fetch = fakeFetch({ ok: true, text: async () => 'is_valid:true' });
  const result = await verifyCallback({}, { returnTo: RETURN_TO, fetch });
  assert.equal(result, null);
  assert.equal(fetch.calls.length, 0);
});

test('getPlayerSummary: maps the Steam API player summary shape', async () => {
  const fetch = fakeFetch({
    ok: true,
    json: async () => ({
      response: { players: [{ personaname: 'Tester', avatarfull: 'https://avatar', profileurl: 'https://profile' }] },
    }),
  });
  const summary = await getPlayerSummary(STEAMID, { apiKey: 'k', fetch });
  assert.deepEqual(summary, { steamid: STEAMID, name: 'Tester', avatar: 'https://avatar', profileUrl: 'https://profile' });
});

test('getPlayerSummary: missing/empty player list returns null', async () => {
  const fetch = fakeFetch({ ok: true, json: async () => ({ response: { players: [] } }) });
  assert.equal(await getPlayerSummary(STEAMID, { apiKey: 'k', fetch }), null);
});

test('getOwnedGames: normal library returns appids', async () => {
  const fetch = fakeFetch({ ok: true, json: async () => ({ response: { game_count: 2, games: [{ appid: 10 }, { appid: 20 }] } }) });
  const result = await getOwnedGames(STEAMID, { apiKey: 'k', fetch });
  assert.deepEqual(result, { appids: [10, 20] });
});

test('getOwnedGames: private profile (empty response) reports the privacy error', async () => {
  const fetch = fakeFetch({ ok: true, json: async () => ({ response: {} }) });
  const result = await getOwnedGames(STEAMID, { apiKey: 'k', fetch });
  assert.deepEqual(result, { error: 'privacy' });
});

test('getOwnedGames: non-OK HTTP response also reports the privacy error rather than throwing', async () => {
  const fetch = fakeFetch({ ok: false, json: async () => ({}) });
  const result = await getOwnedGames(STEAMID, { apiKey: 'k', fetch });
  assert.deepEqual(result, { error: 'privacy' });
});

test('getOwnedGames: network error also reports the privacy error rather than throwing', async () => {
  const fetch = async () => {
    throw new Error('boom');
  };
  const result = await getOwnedGames(STEAMID, { apiKey: 'k', fetch });
  assert.deepEqual(result, { error: 'privacy' });
});
