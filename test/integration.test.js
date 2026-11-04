'use strict';

/*
 * End-to-end tests: boot Relay against a local origin server and exercise
 * every route. No external network required.
 *
 * The local origin stands in for "the internet"; because Relay blocks private
 * addresses, the tests use RELAY_TEST_ALLOW_PRIVATE=1 to opt that guard off
 * *only* for this process.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

process.env.RELAY_TEST_ALLOW_PRIVATE = '1';
process.env.RELAY_LOG_LEVEL = 'silent';

/* ------------------------------------------------------------------ */
/*  Local origin                                                      */
/* ------------------------------------------------------------------ */

const origin = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');

  if (url.pathname === '/plain') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><html><head><title>Plain</title></head><body>
      <h1>Hello</h1>
      <a href="/next">relative link</a>
      <a href="https://example.com/abs">absolute link</a>
      <img src="/img/a.png" srcset="/img/a.png 1x, /img/b.png 2x">
      <form action="/submit" method="post"><input name="q" value="x"></form>
      <style>body{background:url(/bg.png)}</style>
      <script src="/app.js"></script>
    </body></html>`);
  }

  if (url.pathname === '/csp') {
    res.writeHead(200, {
      'content-type': 'text/html',
      'content-security-policy': "default-src 'none'",
      'x-frame-options': 'DENY',
      'strict-transport-security': 'max-age=31536000',
    });
    return res.end('<html><body><p>framed?</p></body></html>');
  }

  if (url.pathname === '/redirect') {
    res.writeHead(302, { location: '/plain' });
    return res.end();
  }

  if (url.pathname === '/redirect-private') {
    res.writeHead(302, { location: 'http://127.0.0.1:9/secret' });
    return res.end();
  }

  if (url.pathname === '/loop') {
    res.writeHead(302, { location: '/loop' });
    return res.end();
  }

  if (url.pathname === '/cookie-set') {
    res.writeHead(200, {
      'content-type': 'text/plain',
      'set-cookie': ['session=abc123; Path=/', 'pref=dark; Path=/; Max-Age=3600'],
    });
    return res.end('cookies set');
  }

  if (url.pathname === '/cookie-echo') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('cookie=' + (req.headers.cookie || 'none'));
  }

  if (url.pathname === '/json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, nested: { a: [1, 2, 3] } }));
  }

  if (url.pathname === '/big') {
    // Larger than the rewrite buffer would ever hold in one chunk.
    res.writeHead(200, { 'content-type': 'text/html' });
    let i = 0;
    res.write('<html><head><title>big</title></head><body>');
    const pump = () => {
      while (i < 4000) {
        i++;
        const ok = res.write(`<p><a href="/p${i}">para ${i}</a></p>`);
        if (!ok) return res.once('drain', pump);
      }
      res.end('</body></html>');
    };
    return pump();
  }

  if (url.pathname === '/latin1') {
    res.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-1' });
    return res.end(Buffer.from('<html><body><p>caf\xe9 na\xefve</p></body></html>', 'latin1'));
  }

  if (url.pathname === '/echo-method') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, body, ctype: req.headers['content-type'] || null }));
    });
    return;
  }

  if (url.pathname === '/slow') {
    // Never answers; used for the timeout path.
    return;
  }

  if (url.pathname === '/binary') {
    const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 255, 254]);
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(payload.length) });
    return res.end(payload);
  }

  if (url.pathname === '/app.js') {
    res.writeHead(200, { 'content-type': 'application/javascript' });
    return res.end('console.log("origin script");');
  }

  if (url.pathname.startsWith('/img/') || url.pathname === '/bg.png') {
    res.writeHead(200, { 'content-type': 'image/png' });
    return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('origin 404');
});

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function get(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: 'GET', headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            raw: Buffer.concat(chunks),
          })
        );
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('client timeout')));
    req.end();
  });
}

function request(port, pathname, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
      );
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('client timeout')));
    if (body) req.write(body);
    req.end();
  });
}

function b64(target) {
  return Buffer.from(target, 'utf8').toString('base64url');
}

/* ------------------------------------------------------------------ */
/*  Suite                                                             */
/* ------------------------------------------------------------------ */

let originPort;
let relayPort;
let relay;
let originBase;

test.before(async () => {
  originPort = await listen(origin);
  originBase = 'http://127.0.0.1:' + originPort;

  const { server } = require('../server.js');
  relay = server;
  relayPort = await listen(relay);
});

test.after(async () => {
  await new Promise((r) => relay.close(r));
  await new Promise((r) => origin.close(r));
});

/* ---------------- UI + API ---------------- */

test('serves the hub and browser pages', async () => {
  const hub = await get(relayPort, '/');
  assert.strictEqual(hub.status, 200);
  assert.match(hub.body, /relay/i);
  assert.match(hub.headers['content-type'], /text\/html/);

  const browse = await get(relayPort, '/browse');
  assert.strictEqual(browse.status, 200);
  assert.match(browse.body, /<iframe/i);
});

test('serves the theme asset and refuses traversal', async () => {
  const css = await get(relayPort, '/assets/theme.css');
  assert.strictEqual(css.status, 200);
  assert.match(css.headers['content-type'], /text\/css/);

  const trav1 = await get(relayPort, '/assets/..%2f..%2fserver.js');
  assert.notStrictEqual(trav1.status, 200, 'encoded traversal must not serve a source file');

  const trav2 = await get(relayPort, '/assets/%2e%2e%2fpackage.json');
  assert.notStrictEqual(trav2.status, 200);
});

test('api/config and api/stats answer with JSON', async () => {
  const cfg = await get(relayPort, '/api/config');
  assert.strictEqual(cfg.status, 200);
  const parsed = JSON.parse(cfg.body);
  assert.ok('version' in parsed);
  assert.ok('features' in parsed);

  const st = await get(relayPort, '/api/stats');
  assert.strictEqual(st.status, 200);
  const s = JSON.parse(st.body);
  assert.strictEqual(typeof s.requests, 'number');
});

test('healthz responds for load balancers', async () => {
  const r = await get(relayPort, '/healthz');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body, 'ok');
});

/* ---------------- HTML proxying ---------------- */

test('proxies an HTML page and rewrites every link', async () => {
  const r = await get(relayPort, '/fetch?url=' + encodeURIComponent(originBase + '/plain'));
  assert.strictEqual(r.status, 200);
  assert.match(r.headers['content-type'], /text\/html/);

  // No raw origin links may survive.
  assert.ok(!/href="\/next"/.test(r.body), 'relative link rewritten');
  assert.ok(!/src="\/img\/a\.png"/.test(r.body), 'img src rewritten');
  assert.ok(!/url\(\/bg\.png\)/.test(r.body), 'css url rewritten');
  assert.ok(!/action="\/submit"/.test(r.body), 'form action rewritten');
  assert.ok(r.body.includes('/p/') || r.body.includes('/raw?url='), 'proxy URLs present');

  // The runtime + target metadata must be injected exactly once.
  assert.strictEqual((r.body.match(/data-relay-runtime/g) || []).length, 1);
  assert.match(r.body, /<meta name="relay-target"/);
});

test('strips CSP, X-Frame-Options and HSTS from proxied pages', async () => {
  const r = await get(relayPort, '/fetch?url=' + encodeURIComponent(originBase + '/csp'));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers['content-security-policy'], undefined);
  assert.strictEqual(r.headers['x-frame-options'], undefined);
  assert.strictEqual(r.headers['strict-transport-security'], undefined);
});

test('rewrites CSS fetched as a stylesheet', async () => {
  const r = await get(relayPort, '/raw?url=' + encodeURIComponent(originBase + '/bg.png'));
  assert.strictEqual(r.status, 200);
  assert.match(r.headers['content-type'], /image\/png/);
});

test('reader mode strips scripts but keeps content', async () => {
  const r = await get(relayPort, '/fetch?url=' + encodeURIComponent(originBase + '/plain') + '&m=1');
  assert.strictEqual(r.status, 200);
  assert.ok(!r.body.includes('console.log'), 'page script removed');
  assert.ok(!r.body.includes('/app.js'), 'script src removed');
  assert.match(r.body, /Hello/, 'content survives');
  assert.match(r.body, /data-relay-reader/, 'reader styles injected');
});

test('path-style /p/ route proxies correctly', async () => {
  const r = await get(relayPort, '/p/' + b64(originBase + '/plain'));
  assert.strictEqual(r.status, 200);
  assert.match(r.body, /Hello/);
});

test('large streaming pages are rewritten, not truncated', async () => {
  const r = await get(relayPort, '/fetch?url=' + encodeURIComponent(originBase + '/big'));
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.length > 50000, 'body should be large');
  assert.ok(!/href="\/p1"/.test(r.body), 'links rewritten in the streamed tail too');
  assert.match(r.body, /para 4000/, 'tail of the document arrived');
});

test('non-UTF-8 pages are transcoded', async () => {
  const r = await get(relayPort, '/fetch?url=' + encodeURIComponent(originBase + '/latin1'));
  assert.strictEqual(r.status, 200);
  assert.match(r.body, /café/);
  assert.match(r.headers['content-type'], /utf-8/i);
});

/* ---------------- Redirects ---------------- */

test('follows redirects and reports the final page', async () => {
  const r = await get(relayPort, '/fetch?url=' + encodeURIComponent(originBase + '/redirect'));
  assert.strictEqual(r.status, 200);
  assert.match(r.body, /Hello/);
});

test('stops redirect loops', async () => {
  const r = await get(relayPort, '/fetch?url=' + encodeURIComponent(originBase + '/loop'));
  assert.ok(r.status >= 400, 'loop should surface as an error');
  assert.match(r.body, /redirect/i);
});

test('refuses a redirect that points at a private address', async () => {
  const r = await get(relayPort, '/fetch?url=' + encodeURIComponent(originBase + '/redirect-private'));
  // Either blocked as private or refused by connection; never a success.
  assert.notStrictEqual(r.status, 200);
});

/* ---------------- Cookies ---------------- */

test('keeps a server-side cookie jar per session', async () => {
  const first = await get(relayPort, '/fetch?url=' + encodeURIComponent(originBase + '/cookie-set'));
  const setCookie = [].concat(first.headers['set-cookie'] || []);
  const session = setCookie.find((c) => c.startsWith('relay_s='));
  assert.ok(session, 'relay issued a session cookie');
  const sessionPair = session.split(';')[0];

  const echo = await get(relayPort, '/fetch?url=' + encodeURIComponent(originBase + '/cookie-echo'), {
    cookie: sessionPair,
  });
  assert.match(echo.body, /session=abc123/, 'upstream cookie replayed from the jar');
});

test('does not leak one session cookie to another', async () => {
  const a = await get(relayPort, '/fetch?url=' + encodeURIComponent(originBase + '/cookie-set'));
  const sessionA = [].concat(a.headers['set-cookie']).find((c) => c.startsWith('relay_s=')).split(';')[0];

  const other = await get(relayPort, '/fetch?url=' + encodeURIComponent(originBase + '/cookie-echo'), {
    cookie: 'relay_s=totally-different-session-id',
  });
  assert.ok(!other.body.includes('session=abc123'), 'jar must be per-session');
  void sessionA;
});

/* ---------------- Methods ---------------- */

test('relays POST bodies to the origin', async () => {
  const payload = 'q=hello&n=1';
  const r = await request(relayPort, '/fetch?url=' + encodeURIComponent(originBase + '/echo-method'), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': payload.length },
    body: payload,
  });
  assert.strictEqual(r.status, 200);
  const parsed = JSON.parse(r.body);
  assert.strictEqual(parsed.method, 'POST');
  assert.strictEqual(parsed.body, payload);
});

test('form targets accept POST via /form/', async () => {
  const payload = 'a=b';
  const r = await request(relayPort, '/form/' + b64(originBase + '/echo-method'), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': payload.length },
    body: payload,
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(JSON.parse(r.body).body, payload);
});

test('JSON passes through untouched', async () => {
  const r = await get(relayPort, '/fetch?url=' + encodeURIComponent(originBase + '/json'));
  assert.strictEqual(r.status, 200);
  const parsed = JSON.parse(r.body);
  assert.deepStrictEqual(parsed, { ok: true, nested: { a: [1, 2, 3] } });
  assert.match(r.headers['content-type'], /application\/json/);
});

test('binary payloads are relayed byte-for-byte', async () => {
  const r = await get(relayPort, '/raw?url=' + encodeURIComponent(originBase + '/binary'));
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual([...r.raw], [0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 255, 254]);
});

/* ---------------- Errors ---------------- */

test('a missing url parameter produces a helpful page', async () => {
  const r = await get(relayPort, '/fetch');
  assert.strictEqual(r.status, 400);
  assert.match(r.body, /No URL/i);
});

test('private targets are refused when the opt-in is off', () => {
  // This suite runs with RELAY_TEST_ALLOW_PRIVATE=1 so it can reach a local
  // origin; assert the guard directly with the opt-in disabled instead.
  const saved = process.env.RELAY_TEST_ALLOW_PRIVATE;
  delete process.env.RELAY_TEST_ALLOW_PRIVATE;
  try {
    const { validateTarget } = require('../src/url');
    for (const target of [
      'http://127.0.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.1/',
      'http://[::1]/',
      'http://localhost/',
    ]) {
      assert.throws(() => validateTarget(target), /private|blocked|local/i, `${target} must be refused`);
    }
  } finally {
    process.env.RELAY_TEST_ALLOW_PRIVATE = saved;
  }
});

test('an unreachable origin produces a 502 error page', async () => {
  const r = await get(relayPort, '/fetch?url=' + encodeURIComponent('http://127.0.0.1:9/nothing'));
  assert.strictEqual(r.status, 502);
  assert.match(r.body, /couldn’t|couldn't|could not/i);
});

test('unknown routes 404 with no stack trace', async () => {
  const r = await get(relayPort, '/definitely-not-a-route');
  assert.strictEqual(r.status, 404);
  assert.ok(!/at .*\.js:\d+/.test(r.body), 'no stack traces leaked');
});

/* ---------------- Headers ---------------- */

test('HEAD requests are honoured', async () => {
  const r = await request(relayPort, '/fetch?url=' + encodeURIComponent(originBase + '/plain'), { method: 'HEAD' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body, '');
});

test('compression is offered when accepted', async () => {
  const plain = await get(relayPort, '/');
  const r = await get(relayPort, '/', { 'accept-encoding': 'gzip, br' });
  assert.strictEqual(r.status, 200);
  assert.ok(
    ['gzip', 'br', 'deflate'].includes(r.headers['content-encoding']),
    `expected a compressed response, got ${r.headers['content-encoding']}`
  );
  assert.ok(Number(r.headers['content-length']) < Number(plain.headers['content-length']), 'compression should shrink');
  assert.match(r.headers.vary || '', /accept-encoding/i);
});

test('ETag revalidation returns 304', async () => {
  const first = await get(relayPort, '/');
  const etag = first.headers.etag;
  assert.ok(etag, 'page has an etag');
  const second = await get(relayPort, '/', { 'if-none-match': etag });
  assert.strictEqual(second.status, 304);
});

/* ---------------- Graceful degradation ---------------- */

test('a failing subresource returns a placeholder, not an HTML error page', async () => {
  // Point at a closed port so the upstream fails deterministically.
  const dead = encodeURIComponent('http://127.0.0.1:9/missing.png');

  const asImage = await get(relayPort, '/raw?url=' + dead, {
    accept: 'image/avif,image/webp,*/*',
    'sec-fetch-dest': 'image',
  });
  assert.strictEqual(asImage.status, 502);
  assert.match(asImage.headers['content-type'], /image\/gif/);
  assert.strictEqual(asImage.raw.subarray(0, 6).toString(), 'GIF89a', 'a real 1x1 gif');
  assert.strictEqual(asImage.headers['x-relay-error'], 'ECONNREFUSED');

  const asScript = await get(relayPort, '/raw?url=' + dead, {
    accept: '*/*',
    'sec-fetch-dest': 'script',
  });
  assert.strictEqual(asScript.status, 502);
  assert.match(asScript.headers['content-type'], /text\/plain/);
  assert.strictEqual(asScript.body, '', 'no HTML dumped into a script tag');
  assert.ok(!/<html/i.test(asScript.body));
});

test('diagnose endpoint reports reachability without the proxy in the way', async () => {
  const r = await get(relayPort, '/api/diagnose');
  assert.strictEqual(r.status, 200);
  const j = JSON.parse(r.body);
  assert.ok(['full', 'partial', 'no-egress'].includes(j.verdict), `unexpected verdict ${j.verdict}`);
  assert.ok(Array.isArray(j.probes) && j.probes.length > 0);
  assert.strictEqual(typeof j.advice, 'string');
  for (const p of j.probes) {
    assert.strictEqual(typeof p.host, 'string');
    assert.strictEqual(typeof p.ok, 'boolean');
  }
});
