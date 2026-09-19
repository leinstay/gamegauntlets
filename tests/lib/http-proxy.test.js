// Tests for src/lib/http.js's `proxy` option and `withProxy()` — see that
// file's module comment for why this MUST route through undici's own
// dispatcher (ProxyAgent) rather than a hand-rolled transport (Cloudflare
// fingerprints the TLS/HTTP client and 403s a hand-rolled one live).
//
// `getText`/`getJson`/etc. with `proxy` set are exercised through a REAL
// local forward proxy (`startRelayProxy`, node:http's `connect` event +
// node:net piping) tunnelling to a REAL local HTTP target — i.e. the actual
// undici ProxyAgent CONNECT-tunnel code path, not a mock of it. (ProxyAgent
// tunnels `http:` targets too by default — see the module comment — so a
// plain HTTP target already exercises the same CONNECT mechanics an
// `https:` target would; no TLS certificate is needed.) The
// EPROXY_UNAVAILABLE tests below control the proxy's CONNECT reply directly
// (no relay) since that's what they're testing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { getText, postJson, requestWithRetry, withProxy } from '../../src/lib/http.js';

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function baseUrl(server) {
  return `http://127.0.0.1:${server.address().port}`;
}

function stop(server) {
  return new Promise((resolve) => server.close(resolve));
}

/** A real forward proxy: answers CONNECT by opening a TCP connection to the requested host:port and piping bytes both ways. */
function startRelayProxy() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(400);
      res.end('this fake proxy only relays CONNECT');
    });
    server.on('connect', (req, clientSocket, head) => {
      const [host, portStr] = req.url.split(':');
      const upstream = net.connect(Number(portStr), host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => upstream.destroy());
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** A proxy whose CONNECT reply is controlled directly (no relay) — for the EPROXY_UNAVAILABLE tests. */
function startConnectRespondingProxy(status) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
    server.on('connect', (req, clientSocket) => {
      clientSocket.write(`HTTP/1.1 ${status} Nope\r\n\r\n`);
      clientSocket.end();
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// --- real CONNECT tunnel: full request/response pipeline through the proxy -

test('getText via proxy: real CONNECT tunnel to a local HTTP target', async () => {
  let seenUA;
  const target = await startServer((req, res) => {
    seenUA = req.headers['user-agent'];
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('hello via tunnel');
  });
  const proxy = await startRelayProxy();
  try {
    const text = await getText(baseUrl(target), { proxy: baseUrl(proxy), retries: 0 });
    assert.equal(text, 'hello via tunnel');
    assert.equal(seenUA, 'GameGauntletsBot/1.0 (+https://gamegauntlets.com)'); // shared with the non-proxied path, not reimplemented
  } finally {
    await stop(target);
    await stop(proxy);
  }
});

test('getText via proxy: a body larger than one TCP segment round-trips intact through the tunnel', async () => {
  const payload = 'ab'.repeat(50_000); // 100,000 bytes, several TCP segments
  const target = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(payload);
  });
  const proxy = await startRelayProxy();
  try {
    const text = await getText(baseUrl(target), { proxy: baseUrl(proxy), retries: 0 });
    assert.equal(text, payload);
  } finally {
    await stop(target);
    await stop(proxy);
  }
});

test('postJson via proxy: sends the body/content-type through the tunnel, returns the parsed response', async () => {
  let receivedBody = '';
  let receivedContentType;
  const target = await startServer((req, res) => {
    receivedContentType = req.headers['content-type'];
    req.on('data', (chunk) => { receivedBody += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ echoed: JSON.parse(receivedBody) }));
    });
  });
  const proxy = await startRelayProxy();
  try {
    const data = await postJson(baseUrl(target), { a: 1 }, { proxy: baseUrl(proxy), retries: 0 });
    assert.equal(receivedContentType, 'application/json');
    assert.deepEqual(JSON.parse(receivedBody), { a: 1 });
    assert.deepEqual(data, { echoed: { a: 1 } });
  } finally {
    await stop(target);
    await stop(proxy);
  }
});

test('getText via proxy: still honours retry/backoff on a retryable 500 through the tunnel', async () => {
  let requests = 0;
  const target = await startServer((req, res) => {
    requests += 1;
    if (requests < 3) {
      res.writeHead(500);
      res.end('boom');
      return;
    }
    res.writeHead(200);
    res.end('ok now');
  });
  const proxy = await startRelayProxy();
  try {
    const text = await getText(baseUrl(target), { proxy: baseUrl(proxy), retries: 3, retryBaseMs: 1, retryMaxMs: 5 });
    assert.equal(text, 'ok now');
    assert.equal(requests, 3);
  } finally {
    await stop(target);
    await stop(proxy);
  }
});

test('getText via proxy: a 4xx from the target is a normal ensureOk error, not EPROXY_UNAVAILABLE', async () => {
  const target = await startServer((req, res) => { res.writeHead(404); res.end('missing'); });
  const proxy = await startRelayProxy();
  try {
    await assert.rejects(
      () => getText(baseUrl(target), { proxy: baseUrl(proxy), retries: 0 }),
      (err) => {
        assert.equal(err.statusCode, 404);
        assert.notEqual(err.code, 'EPROXY_UNAVAILABLE');
        return true;
      },
    );
  } finally {
    await stop(target);
    await stop(proxy);
  }
});

test('proxy URL with embedded credentials: a request through it still succeeds (relay does not itself check auth)', async () => {
  const target = await startServer((req, res) => { res.writeHead(200); res.end('ok'); });
  const proxy = await startRelayProxy();
  try {
    const port = proxy.address().port;
    const text = await getText(baseUrl(target), { proxy: `http://user:pass@127.0.0.1:${port}`, retries: 0 });
    assert.equal(text, 'ok');
  } finally {
    await stop(target);
    await stop(proxy);
  }
});

test('proxy URL with embedded credentials: the CONNECT request itself carries a Proxy-Authorization header', async () => {
  let connectHeaders = '';
  const rawProxy = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      connectHeaders = buf.slice(0, idx).toString('latin1');
      socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); // no real upstream needed — we only inspect the CONNECT request
      socket.end();
    });
  });
  await new Promise((resolve) => rawProxy.listen(0, '127.0.0.1', resolve));
  try {
    const port = rawProxy.address().port;
    await assert.rejects(() => getText('http://internal.example/x', { proxy: `http://user:pass@127.0.0.1:${port}`, retries: 0 }));
    assert.match(connectHeaders, /CONNECT internal\.example:80 HTTP\/1\.1/);
    assert.match(connectHeaders, new RegExp(`proxy-authorization:\\s*Basic ${Buffer.from('user:pass').toString('base64')}`, 'i'));
  } finally {
    await new Promise((resolve) => rawProxy.close(resolve));
  }
});

// --- proxy connectivity failures -> EPROXY_UNAVAILABLE ----------------------

test('EPROXY_UNAVAILABLE: proxy connection refused', async () => {
  // Port 1 is a privileged port nothing listens on in this sandbox; connecting fails fast with ECONNREFUSED.
  await assert.rejects(
    () => getText('http://internal.example/plain', { proxy: 'http://127.0.0.1:1', retries: 0, timeout: 2000 }),
    (err) => {
      assert.equal(err.code, 'EPROXY_UNAVAILABLE');
      assert.match(err.message, /127\.0\.0\.1:1/);
      return true;
    },
  );
});

test('EPROXY_UNAVAILABLE: proxy answers CONNECT with 502', async () => {
  const proxy = await startConnectRespondingProxy(502);
  try {
    await assert.rejects(
      () => getText('https://internal.example/plain', { proxy: baseUrl(proxy), retries: 0, timeout: 2000 }),
      (err) => {
        assert.equal(err.code, 'EPROXY_UNAVAILABLE');
        assert.match(err.message, /502/);
        return true;
      },
    );
  } finally {
    await stop(proxy);
  }
});

test('EPROXY_UNAVAILABLE: proxy answers CONNECT with 503 or 504 too', async () => {
  for (const status of [503, 504]) {
    const proxy = await startConnectRespondingProxy(status);
    try {
      await assert.rejects(
        () => getText('https://internal.example/plain', { proxy: baseUrl(proxy), retries: 0, timeout: 2000 }),
        (err) => {
          assert.equal(err.code, 'EPROXY_UNAVAILABLE');
          return true;
        },
      );
    } finally {
      await stop(proxy);
    }
  }
});

test('NOT EPROXY_UNAVAILABLE: proxy answers CONNECT with 403 (a configuration/ACL problem, not an outage)', async () => {
  const proxy = await startConnectRespondingProxy(403);
  try {
    await assert.rejects(
      () => getText('https://internal.example/plain', { proxy: baseUrl(proxy), retries: 0, timeout: 2000 }),
      (err) => {
        assert.notEqual(err.code, 'EPROXY_UNAVAILABLE');
        assert.match(err.message, /403/);
        return true;
      },
    );
  } finally {
    await stop(proxy);
  }
});

test('NOT EPROXY_UNAVAILABLE: proxy answers CONNECT with 407 (bad proxy credentials)', async () => {
  const proxy = await startConnectRespondingProxy(407);
  try {
    await assert.rejects(
      () => getText('https://internal.example/plain', { proxy: baseUrl(proxy), retries: 0, timeout: 2000 }),
      (err) => {
        assert.notEqual(err.code, 'EPROXY_UNAVAILABLE');
        assert.match(err.message, /407/);
        return true;
      },
    );
  } finally {
    await stop(proxy);
  }
});

test('requestWithRetry: EPROXY_UNAVAILABLE still goes through the normal retry loop, then is thrown as-is', async () => {
  let connects = 0;
  const proxy = await startConnectRespondingProxy(503);
  proxy.on('connect', () => { connects += 1; });
  try {
    await assert.rejects(
      () => requestWithRetry('https://internal.example/x', {
        proxy: baseUrl(proxy),
        retries: 2,
        retryBaseMs: 1,
        retryMaxMs: 5,
        timeout: 2000,
      }),
      (err) => {
        assert.equal(err.code, 'EPROXY_UNAVAILABLE');
        return true;
      },
    );
    assert.equal(connects, 3); // initial attempt + 2 retries, same as a network error
  } finally {
    await stop(proxy);
  }
});

// --- withProxy(): per-source wrapping, no per-call changes needed ----------

test('withProxy: defaults opts.proxy on every method, without mutating the original http object', async () => {
  const calls = [];
  const fakeHttp = {
    getText: async (url, opts) => { calls.push(['getText', url, opts]); return 'text'; },
    getJson: async (url, opts) => { calls.push(['getJson', url, opts]); return {}; },
    postJson: async (url, data, opts) => { calls.push(['postJson', url, data, opts]); return {}; },
    postText: async (url, body, opts) => { calls.push(['postText', url, body, opts]); return {}; },
  };

  const wrapped = withProxy(fakeHttp, 'http://127.0.0.1:8118');

  await wrapped.getText('http://a/', { retries: 0 });
  await wrapped.getJson('http://a/');
  await wrapped.postJson('http://a/', { x: 1 }, { headers: { a: 1 } });
  await wrapped.postText('http://a/', 'body text');

  assert.equal(calls[0][2].proxy, 'http://127.0.0.1:8118');
  assert.equal(calls[0][2].retries, 0);
  assert.equal(calls[1][2].proxy, 'http://127.0.0.1:8118');
  assert.equal(calls[2][3].proxy, 'http://127.0.0.1:8118');
  assert.deepEqual(calls[2][3].headers, { a: 1 });
  assert.equal(calls[3][3].proxy, 'http://127.0.0.1:8118');

  // The original client is untouched: calling it directly carries no proxy.
  await fakeHttp.getText('http://a/', {});
  assert.equal(calls[4][2].proxy, undefined);
});

test('withProxy: an explicit opts.proxy on the call wins over the source default', async () => {
  const calls = [];
  const fakeHttp = { getText: async (url, opts) => { calls.push(opts); return 'text'; } };
  const wrapped = withProxy(fakeHttp, 'http://default-proxy:8118');

  await wrapped.getText('http://a/', { proxy: 'http://explicit-proxy:9000' });
  assert.equal(calls[0].proxy, 'http://explicit-proxy:9000');
});

test('withProxy: returns the same http object unchanged when proxy is falsy', () => {
  const fakeHttp = { getText: async () => 'text' };
  assert.equal(withProxy(fakeHttp, null), fakeHttp);
  assert.equal(withProxy(fakeHttp, undefined), fakeHttp);
  assert.equal(withProxy(fakeHttp, ''), fakeHttp);
});
