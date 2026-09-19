import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { getJson, getText, postJson, postText, requestWithRetry, parseRetryAfter, backoffDelay } from '../src/lib/http.js';

// All servers run on 127.0.0.1:0 (ephemeral port) — no internet access.

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function baseUrl(server) {
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('getJson: returns parsed JSON on a 200 response', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ hello: 'world' }));
  });
  try {
    const data = await getJson(`${baseUrl(server)}/ok`, { retries: 0 });
    assert.deepEqual(data, { hello: 'world' });
  } finally {
    await stopServer(server);
  }
});

test('getJson: sends the fixed User-Agent header', async () => {
  let seenUA;
  const server = await startServer((req, res) => {
    seenUA = req.headers['user-agent'];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  try {
    await getJson(`${baseUrl(server)}/ua`, { retries: 0 });
    assert.equal(seenUA, 'GameGauntletsBot/1.0 (+https://gamegauntlets.com)');
  } finally {
    await stopServer(server);
  }
});

test('requestWithRetry: retries on 500 then succeeds, honouring retry count', async () => {
  let requests = 0;
  const server = await startServer((req, res) => {
    requests += 1;
    if (requests < 3) {
      res.writeHead(500);
      res.end('boom');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  try {
    const data = await getJson(`${baseUrl(server)}/flaky`, { retries: 3, retryBaseMs: 1, retryMaxMs: 5 });
    assert.deepEqual(data, { ok: true });
    assert.equal(requests, 3);
  } finally {
    await stopServer(server);
  }
});

test('requestWithRetry: throws after exhausting retries on persistent 500s', async () => {
  let requests = 0;
  const server = await startServer((req, res) => {
    requests += 1;
    res.writeHead(503);
    res.end('nope');
  });
  try {
    await assert.rejects(
      () => getJson(`${baseUrl(server)}/always-down`, { retries: 2, retryBaseMs: 1, retryMaxMs: 5 }),
      (err) => {
        assert.equal(err.statusCode, 503);
        return true;
      },
    );
    assert.equal(requests, 3); // initial attempt + 2 retries
  } finally {
    await stopServer(server);
  }
});

test('requestWithRetry: does not retry a non-retryable 4xx status', async () => {
  let requests = 0;
  const server = await startServer((req, res) => {
    requests += 1;
    res.writeHead(404);
    res.end('not found');
  });
  try {
    await assert.rejects(
      () => getJson(`${baseUrl(server)}/missing`, { retries: 3, retryBaseMs: 1 }),
      (err) => {
        assert.equal(err.statusCode, 404);
        return true;
      },
    );
    assert.equal(requests, 1);
  } finally {
    await stopServer(server);
  }
});

test('requestWithRetry: honours a Retry-After header (seconds) on 429', async () => {
  let requests = 0;
  const timestamps = [];
  const server = await startServer((req, res) => {
    requests += 1;
    timestamps.push(Date.now());
    if (requests === 1) {
      res.writeHead(429, { 'retry-after': '1' });
      res.end('slow down');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  try {
    const data = await getJson(`${baseUrl(server)}/rate-limited`, { retries: 1 });
    assert.deepEqual(data, { ok: true });
    assert.equal(requests, 2);
    const elapsed = timestamps[1] - timestamps[0];
    assert.ok(elapsed >= 950, `expected to wait ~1s for Retry-After, waited ${elapsed}ms`);
  } finally {
    await stopServer(server);
  }
});

test('requestWithRetry: retries on a network/timeout error then gives up', async () => {
  const server = await startServer((req) => {
    // Never respond — forces the client-side timeout to fire.
    req.socket.on('error', () => {});
  });
  try {
    await assert.rejects(
      () => getJson(`${baseUrl(server)}/hangs`, { timeout: 30, retries: 1, retryBaseMs: 1, retryMaxMs: 5 }),
    );
  } finally {
    await stopServer(server);
  }
});

test('getText: returns the raw response body', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('plain text body');
  });
  try {
    const text = await getText(`${baseUrl(server)}/text`, { retries: 0 });
    assert.equal(text, 'plain text body');
  } finally {
    await stopServer(server);
  }
});

test('postJson: sends a JSON body and content-type, returns the parsed response', async () => {
  let receivedBody = '';
  let receivedContentType;
  const server = await startServer((req, res) => {
    receivedContentType = req.headers['content-type'];
    req.on('data', (chunk) => { receivedBody += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ echoed: JSON.parse(receivedBody) }));
    });
  });
  try {
    const data = await postJson(`${baseUrl(server)}/echo`, { a: 1 }, { retries: 0 });
    assert.equal(receivedContentType, 'application/json');
    assert.deepEqual(JSON.parse(receivedBody), { a: 1 });
    assert.deepEqual(data, { echoed: { a: 1 } });
  } finally {
    await stopServer(server);
  }
});

test('postText: sends the raw string body verbatim (no JSON quoting), returns the parsed response', async () => {
  let receivedBody = '';
  let receivedContentType;
  const server = await startServer((req, res) => {
    receivedContentType = req.headers['content-type'];
    req.on('data', (chunk) => { receivedBody += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ id: 1 }]));
    });
  });
  try {
    const data = await postText(`${baseUrl(server)}/apicalypse`, 'fields id,name; where id = 1;', { retries: 0 });
    assert.equal(receivedContentType, 'text/plain');
    assert.equal(receivedBody, 'fields id,name; where id = 1;'); // not JSON-stringified/escaped
    assert.deepEqual(data, [{ id: 1 }]);
  } finally {
    await stopServer(server);
  }
});

test('postText: a header override (e.g. Authorization) is sent alongside the body', async () => {
  let receivedAuth;
  const server = await startServer((req, res) => {
    receivedAuth = req.headers['authorization'];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  try {
    await postText(`${baseUrl(server)}/auth`, 'fields id;', { retries: 0, headers: { Authorization: 'Bearer tok' } });
    assert.equal(receivedAuth, 'Bearer tok');
  } finally {
    await stopServer(server);
  }
});

test('parseRetryAfter: parses seconds and returns null for garbage', () => {
  assert.equal(parseRetryAfter('5'), 5000);
  assert.equal(parseRetryAfter(''), null);
  assert.equal(parseRetryAfter(undefined), null);
  assert.equal(parseRetryAfter('not-a-date'), null);
});

test('backoffDelay: honours retryAfterMs override and otherwise stays within the cap', () => {
  assert.equal(backoffDelay(5, { retryAfterMs: 1234 }), 1234);
  for (let attempt = 0; attempt < 6; attempt++) {
    const delay = backoffDelay(attempt, { baseMs: 100, maxMs: 1000 });
    assert.ok(delay >= 0 && delay <= 1000, `delay ${delay} out of range for attempt ${attempt}`);
  }
});
