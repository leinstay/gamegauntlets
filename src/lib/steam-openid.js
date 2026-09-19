// Steam OpenID 2.0 login (https://partner.steamgames.com/doc/features/auth#openid) plus the two
// Steam Web API calls the auth/wheel routes need for a logged-in user. Steam is a fixed OpenID 2.0
// provider at a well-known endpoint, so unlike a generic OpenID consumer (see legacy's LightOpenID,
// `legacy/ajax/scripts/openid/openid.php`) there is no discovery step: we build the request by hand
// and verify the callback with a `check_authentication` POST, exactly as LightOpenID's `validate()`
// does (same file, ~line 870).
//
// Every function that talks to the network takes a `fetch` implementation as a parameter instead of
// importing one, so tests can pass a mock (see tests/api/auth.test.js) and `buildApp({ fetch })`
// can inject a real one without this module reaching into config/env itself.

const STEAM_OPENID_ENDPOINT = 'https://steamcommunity.com/openid/login';
const STEAM_OPENID_NS = 'http://specs.openid.net/auth/2.0';
const IDENTIFIER_SELECT = 'http://specs.openid.net/auth/2.0/identifier_select';

// SteamID64s always start with the "7" universe/type/instance prefix bytes legacy also checks for
// (`^https?:\/\/steamcommunity\.com\/openid\/id\/(7[0-9]{15,25}+)$`).
const CLAIMED_ID_RE = /^https?:\/\/steamcommunity\.com\/openid\/id\/(7[0-9]{15,25})$/;

/** Build the URL to redirect the browser to for `GET /api/auth/steam`. */
export function buildAuthUrl({ returnTo, realm }) {
  const params = new URLSearchParams({
    'openid.ns': STEAM_OPENID_NS,
    'openid.mode': 'checkid_setup',
    'openid.return_to': returnTo,
    'openid.realm': realm,
    'openid.identity': IDENTIFIER_SELECT,
    'openid.claimed_id': IDENTIFIER_SELECT,
  });
  return `${STEAM_OPENID_ENDPOINT}?${params.toString()}`;
}

/** Extract the SteamID64 from a `openid.claimed_id`/`openid.identity` URL, or null if malformed. */
export function extractSteamId(claimedId) {
  if (typeof claimedId !== 'string') return null;
  const match = CLAIMED_ID_RE.exec(claimedId);
  return match ? match[1] : null;
}

/**
 * Verify the `GET /api/auth/steam/callback` query string against Steam via `check_authentication`.
 * `query` is the raw query object (Fastify gives us `openid.mode`, `openid.claimed_id`, ... as
 * dotted keys already). `returnTo` must be the exact callback URL used in `buildAuthUrl` — Steam
 * echoes it back as `openid.return_to` and it must match byte-for-byte or the assertion is rejected
 * (this is what stops an attacker replaying an assertion minted for a different callback URL).
 *
 * Returns `{ steamid }` on success, or `null` on any failure — never throws for a bad/forged
 * assertion, only for a network error talking to Steam.
 */
export async function verifyCallback(query, { returnTo, fetch: fetchImpl }) {
  if (!fetchImpl) throw new Error('verifyCallback: fetch is required');
  if (!query || typeof query !== 'object') return null;
  if (query['openid.mode'] !== 'id_res') return null;
  if (query['openid.return_to'] !== returnTo) return null;

  const claimedId = query['openid.claimed_id'] || query['openid.identity'];
  const steamid = extractSteamId(claimedId);
  if (!steamid) return null;

  // Re-send every openid.* field Steam gave us, unchanged, except openid.mode which flips to
  // check_authentication — this is the whole of the verification handshake.
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (key.startsWith('openid.') && typeof value === 'string') params.set(key, value);
  }
  params.set('openid.mode', 'check_authentication');

  const res = await fetchImpl(STEAM_OPENID_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) return null;

  const text = await res.text();
  if (!/is_valid\s*:\s*true/i.test(text)) return null;

  return { steamid };
}

/** `ISteamUser/GetPlayerSummaries` for one steamid → { steamid, name, avatar, profileUrl } or null. */
export async function getPlayerSummary(steamid, { apiKey, fetch: fetchImpl }) {
  if (!fetchImpl) throw new Error('getPlayerSummary: fetch is required');
  const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(apiKey)}&steamids=${encodeURIComponent(steamid)}`;
  const res = await fetchImpl(url);
  if (!res.ok) return null;
  const data = await res.json();
  const player = data?.response?.players?.[0];
  if (!player) return null;
  return {
    steamid,
    name: player.personaname ?? null,
    avatar: player.avatarfull ?? null,
    profileUrl: player.profileurl ?? null,
  };
}

/**
 * `IPlayerService/GetOwnedGames` for one steamid → `{ appids: number[] }`, or `{ error: 'privacy' }`
 * when the profile/games list is private (Steam returns an empty `response` in that case — there is
 * no distinct error code, same as legacy `gateway.php` treats an empty `response.games` as "private").
 */
export async function getOwnedGames(steamid, { apiKey, fetch: fetchImpl }) {
  if (!fetchImpl) throw new Error('getOwnedGames: fetch is required');
  const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${encodeURIComponent(apiKey)}&format=json&steamid=${encodeURIComponent(steamid)}`;

  let data;
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return { error: 'privacy' };
    data = await res.json();
  } catch {
    return { error: 'privacy' };
  }

  const games = data?.response?.games;
  if (!Array.isArray(games) || games.length === 0) return { error: 'privacy' };
  return { appids: games.map((g) => g.appid) };
}
