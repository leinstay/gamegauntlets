// undici-based HTTP client: getJson/getText/postJson with a timeout, retries
// with exponential backoff + jitter, and Retry-After support. Never disables
// TLS verification. Every request carries a fixed User-Agent identifying the
// bot, per the crawling etiquette of the sources we scrape.
//
// Optional per-request `proxy` (a `http://[user:pass@]host:port` URL
// string): routes the request through a plain forward proxy — added for
// src/sources/gamefaqs.js, which needs to run on the server but egress
// through a residential IP (see docs/plans, "egress proxy"). This MUST use
// undici's own dispatcher (`ProxyAgent`, passed as `dispatcher` to the same
// `request()` call the non-proxied path already uses) rather than a
// hand-rolled net/tls transport: Cloudflare (fronting gamefaqs.gamespot.com)
// fingerprints the TLS/HTTP client, and a hand-rolled CONNECT+TLS transport
// — even one that reached the same target, through the same proxy, with the
// same headers — got a 403 "Just a moment..." challenge live where undici's
// own ProxyAgent got 200 (confirmed live 2026-09-19). Routing every proxied
// request through undici's `request()` also means retries, error shape and
// the default User-Agent are shared with the non-proxied path by
// construction, not reimplemented. One `ProxyAgent` is cached per distinct
// proxy URL (`getProxyAgent`) rather than built per request.
//
// If the proxy itself can't be reached — ECONNREFUSED/ETIMEDOUT/
// EHOSTUNREACH/ENETUNREACH/ECONNRESET connecting to it, or it answering a
// CONNECT with 502/503/504 (its own upstream/egress is down) — every
// proxied helper throws an Error with `code = 'EPROXY_UNAVAILABLE'`;
// src/worker.js treats that as "egress offline", not a source failure (see
// runSourceJob). A CONNECT 403/407 (bad credentials/ACL — a proxy
// *configuration* problem, not an outage) is left as a normal error instead.

import { request, ProxyAgent } from 'undici';

export const USER_AGENT = 'GameGauntletsBot/1.0 (+https://gamegauntlets.com)';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRIES = 3;
const DEFAULT_RETRY_BASE_MS = 500;
const DEFAULT_RETRY_MAX_MS = 15_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with full jitter, capped at maxMs. Ignored when retryAfterMs is given. */
export function backoffDelay(attempt, { baseMs = DEFAULT_RETRY_BASE_MS, maxMs = DEFAULT_RETRY_MAX_MS, retryAfterMs = null } = {}) {
  if (retryAfterMs != null) return retryAfterMs;
  const cap = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.random() * cap;
}

/** Parse a Retry-After header (seconds, or an HTTP-date) into milliseconds, or null. */
export function parseRetryAfter(headerValue) {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(headerValue);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

function isRetryableStatus(statusCode) {
  return statusCode === 429 || statusCode >= 500;
}

async function drain(res) {
  try {
    await res.body.text();
  } catch {
    // ignore — we only drain to free the underlying socket
  }
}

// ---------------------------------------------------------------------------
// Proxy dispatcher cache + EPROXY_UNAVAILABLE classification.
// ---------------------------------------------------------------------------

// Node 22.20+ bundles OpenSSL 3.5, whose default ClientHello (post-quantum key share + the longer signature
// algorithm list) gets a Cloudflare 403 "Just a moment..." from gamefaqs.gamespot.com even from a residential IP;
// the pre-3.5 lists below get 200 (verified live 2026-09-19: same proxy, same headers, only these two options
// differ). Applied to proxied requests only - the sites fetched directly do not mind the new ClientHello.
export const CLASSIC_TLS = {
  ecdhCurve: 'X25519:prime256v1:secp384r1:secp521r1',
  sigalgs:
    'ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:' +
    'rsa_pkcs1_sha384:rsa_pss_rsae_sha512:rsa_pkcs1_sha512',
};

const proxyAgents = new Map();

/** One cached undici `ProxyAgent` per distinct proxy URL string (credentials embedded in the URL become its `Proxy-Authorization`, per undici). */
function getProxyAgent(proxy) {
  let agent = proxyAgents.get(proxy);
  if (!agent) {
    agent = new ProxyAgent({ uri: proxy, requestTls: CLASSIC_TLS });
    proxyAgents.set(proxy, agent);
  }
  return agent;
}

const PROXY_UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET']);
const PROXY_UNAVAILABLE_CONNECT_STATUSES = new Set([502, 503, 504]);

function proxyUnavailableError(message, cause) {
  const err = new Error(message);
  err.code = 'EPROXY_UNAVAILABLE';
  if (cause) err.cause = cause;
  return err;
}

/** Walk `err`/`err.cause`/... looking for the first node `select` accepts; returns its result or `null`. */
function findInChain(err, select) {
  let current = err;
  const seen = new Set();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const hit = select(current);
    if (hit != null) return hit;
    current = current.cause;
  }
  return null;
}

/** undici's ProxyAgent on a non-200 CONNECT reply: `Error: Proxy response (502) !== 200 when HTTP Tunneling` (code UND_ERR_ABORTED). Returns the status code, or `null`. */
function proxyConnectStatus(err) {
  return findInChain(err, (e) => {
    const m = /Proxy response \((\d+)\) !== 200/.exec(e.message || '');
    return m ? Number(m[1]) : null;
  });
}

/** A Node system error (ECONNREFUSED etc.) whose address:port is the proxy's own — the client only ever dials the proxy directly, so this is "can't reach the proxy", not "target refused". */
function proxyConnectionError(err, proxyUrl) {
  const proxyPort = Number(proxyUrl.port || (proxyUrl.protocol === 'https:' ? 443 : 80));
  return findInChain(err, (e) => {
    if (!PROXY_UNREACHABLE_CODES.has(e.code)) return null;
    const addressKnown = e.address != null || e.port != null;
    if (!addressKnown) return e; // no address info at all to compare — every proxied request dials the proxy, so assume it's that leg
    const addressMatches = e.address == null || e.address === proxyUrl.hostname;
    const portMatches = e.port == null || Number(e.port) === proxyPort;
    return addressMatches && portMatches ? e : null;
  });
}

/**
 * If `err` (thrown by a `dispatcher: getProxyAgent(proxy)` request) indicates
 * the proxy itself is unavailable, return an `EPROXY_UNAVAILABLE` error
 * wrapping it; otherwise return `err` unchanged (e.g. a CONNECT 403/407, or
 * any error unrelated to reaching the proxy).
 */
function classifyProxyError(err, proxy) {
  const connectStatus = proxyConnectStatus(err);
  if (connectStatus != null) {
    return PROXY_UNAVAILABLE_CONNECT_STATUSES.has(connectStatus)
      ? proxyUnavailableError(`Egress proxy ${proxy} answered CONNECT with ${connectStatus}`, err)
      : err;
  }
  const netErr = proxyConnectionError(err, new URL(proxy));
  return netErr ? proxyUnavailableError(`Cannot reach egress proxy ${proxy}: ${netErr.code}`, err) : err;
}

// ---------------------------------------------------------------------------
// Public retry wrapper
// ---------------------------------------------------------------------------

/**
 * Perform one HTTP request with timeout + retry/backoff. Resolves to the raw
 * undici response ({ statusCode, headers, body }) on any status code that
 * isn't a retry-exhausted 429/5xx — callers check statusCode themselves for
 * other 4xx handling. Throws on network errors/timeouts that exhaust retries,
 * or on 429/5xx that exhaust retries. `opts.proxy` (a
 * `http://[user:pass@]host:port` URL string) routes the request through a
 * forward proxy — see the module comment.
 */
export async function requestWithRetry(url, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeout = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    retryBaseMs = DEFAULT_RETRY_BASE_MS,
    retryMaxMs = DEFAULT_RETRY_MAX_MS,
    proxy = null,
  } = opts;

  let attempt = 0;
  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let res;
    let networkErr;

    try {
      res = await request(url, {
        method,
        headers: { 'user-agent': USER_AGENT, ...headers },
        body,
        signal: controller.signal,
        ...(proxy ? { dispatcher: getProxyAgent(proxy) } : {}),
      });
    } catch (err) {
      networkErr = proxy ? classifyProxyError(err, proxy) : err;
    } finally {
      clearTimeout(timer);
    }

    if (!networkErr) {
      if (isRetryableStatus(res.statusCode) && attempt < retries) {
        const retryAfterMs = parseRetryAfter(res.headers['retry-after']);
        await drain(res);
        attempt += 1;
        await sleep(backoffDelay(attempt - 1, { baseMs: retryBaseMs, maxMs: retryMaxMs, retryAfterMs }));
        continue;
      }
      if (isRetryableStatus(res.statusCode)) {
        const bodyText = await res.body.text().catch(() => '');
        const err = new Error(`HTTP ${res.statusCode} for ${url}`);
        err.statusCode = res.statusCode;
        err.body = bodyText;
        throw err;
      }
      return res;
    }

    // Network error or timeout (AbortError) — EPROXY_UNAVAILABLE errors go through this same path.
    if (attempt < retries) {
      attempt += 1;
      await sleep(backoffDelay(attempt - 1, { baseMs: retryBaseMs, maxMs: retryMaxMs }));
      continue;
    }
    throw networkErr;
  }
}

async function ensureOk(res, url) {
  if (res.statusCode >= 400) {
    const text = await res.body.text().catch(() => '');
    const err = new Error(`HTTP ${res.statusCode} for ${url}`);
    err.statusCode = res.statusCode;
    err.body = text;
    throw err;
  }
}

export async function getJson(url, opts = {}) {
  const res = await requestWithRetry(url, { ...opts, method: 'GET' });
  await ensureOk(res, url);
  return res.body.json();
}

export async function getText(url, opts = {}) {
  const res = await requestWithRetry(url, { ...opts, method: 'GET' });
  await ensureOk(res, url);
  return res.body.text();
}

export async function postJson(url, data, opts = {}) {
  const res = await requestWithRetry(url, {
    ...opts,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    body: JSON.stringify(data),
  });
  await ensureOk(res, url);
  return res.body.json();
}

/**
 * POST a raw text body (not JSON.stringify'd) and parse the response as
 * JSON. Added for src/sources/igdb.js: IGDB's `/v4/*` endpoints take an
 * "Apicalypse" query as the literal request body (e.g. `fields id,name;
 * where id = 1;`) — running it through `postJson` would wrap it in an extra
 * layer of JSON-string quoting/escaping and break the query. Every other
 * current source's write paths (`postJson`) are untouched.
 */
export async function postText(url, bodyText, opts = {}) {
  const res = await requestWithRetry(url, {
    ...opts,
    method: 'POST',
    headers: { 'content-type': 'text/plain', ...(opts.headers || {}) },
    body: bodyText,
  });
  await ensureOk(res, url);
  return res.body.json();
}

/**
 * Wrap an `{ getText, getJson, postJson, postText }` client so every call
 * defaults to `opts.proxy = proxy` unless the caller already set one — used
 * to give one source module (e.g. gamefaqs) an egress proxy without touching
 * its call sites (see config.sources.<name>.proxy, src/pipeline/context.js,
 * src/worker.js's ctxForSource). Returns `http` unchanged when `proxy` is
 * falsy.
 */
export function withProxy(http, proxy) {
  if (!proxy) return http;
  return {
    ...http,
    getText: (url, opts = {}) => http.getText(url, { ...opts, proxy: opts.proxy ?? proxy }),
    getJson: (url, opts = {}) => http.getJson(url, { ...opts, proxy: opts.proxy ?? proxy }),
    postJson: (url, data, opts = {}) => http.postJson(url, data, { ...opts, proxy: opts.proxy ?? proxy }),
    postText: (url, bodyText, opts = {}) => http.postText(url, bodyText, { ...opts, proxy: opts.proxy ?? proxy }),
  };
}
