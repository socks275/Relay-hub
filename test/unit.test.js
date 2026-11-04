'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  parseIPv4,
  parseIPv6,
  isPrivateIP,
  isPrivateHostname,
  validateTarget,
  rewriteUrl,
  proxify,
  targetFromProxyUrl,
  b64url,
  unb64url,
  decodeTargetSegment,
  looksLikeHost,
} = require('../src/url');

const { rewriteHtml, rewriteCss, decodeEntities } = require('../src/rewrite/html');

/* ------------------------------------------------------------------ */
/*  IP parsing / private range detection                             */
/* ------------------------------------------------------------------ */

test('parseIPv4 handles dotted, short, hex and octal forms', () => {
  assert.strictEqual(parseIPv4('127.0.0.1'), '127.0.0.1');
  assert.strictEqual(parseIPv4('127.1'), '127.0.0.1');
  assert.strictEqual(parseIPv4('10.0.0.1'), '10.0.0.1');
  assert.strictEqual(parseIPv4('0x7f.0.0.1'), '127.0.0.1');
  assert.strictEqual(parseIPv4('0x7f000001'), '127.0.0.1');
  assert.strictEqual(parseIPv4('2130706433'), '127.0.0.1');
  assert.strictEqual(parseIPv4('017700000001'), '127.0.0.1');
  assert.strictEqual(parseIPv4('192.168.1.1'), '192.168.1.1');
  assert.strictEqual(parseIPv4('8.8.8.8'), '8.8.8.8');
  assert.strictEqual(parseIPv4('1.2.3.4.5'), null);
  assert.strictEqual(parseIPv4('not-an-ip'), null);
});

test('loopback in every spelling is refused', () => {
  for (const host of [
    '127.0.0.1',
    '127.1',
    '127.0.1',
    '0x7f.1',
    '2130706433',
    '0x7f000001',
    '017700000001',
    '[::1]',
    '::1',
    '0.0.0.0',
    '0',
  ]) {
    assert.strictEqual(isPrivateHostname(host.replace(/[[\]]/g, '')), true, `expected ${host} blocked`);
  }
});

test('cloud metadata and RFC1918 ranges are refused', () => {
  for (const ip of [
    '169.254.169.254',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '100.64.0.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    'fe80::1',
    'fd00::1',
    'fc00::1',
    'ff02::1',
  ]) {
    assert.strictEqual(isPrivateIP(ip), true, `expected ${ip} private`);
  }
});

test('IPv4-mapped IPv6 is detected as private', () => {
  assert.strictEqual(isPrivateIP('::ffff:127.0.0.1'), true);
  assert.strictEqual(isPrivateIP('::ffff:10.0.0.1'), true);
  assert.strictEqual(isPrivateIP('::ffff:8.8.8.8'), false);
  assert.strictEqual(isPrivateIP('64:ff9b::7f00:1'), true);
});

test('public IPs are allowed', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111']) {
    assert.strictEqual(isPrivateIP(ip), false, `expected ${ip} public`);
  }
});

test('local hostnames are refused', () => {
  for (const h of ['localhost', 'foo.localhost', 'printer.local', 'metadata.google.internal', 'db.internal', 'x.lan']) {
    assert.strictEqual(isPrivateHostname(h), true, `expected ${h} blocked`);
  }
  assert.strictEqual(isPrivateHostname('example.com'), false);
  assert.strictEqual(isPrivateHostname('sub.example.co.uk'), false);
});

test('parseIPv6 expands correctly', () => {
  assert.deepStrictEqual([...parseIPv6('::1').slice(14)], [0, 1]);
  assert.strictEqual(parseIPv6('::').length, 16);
  assert.deepStrictEqual([...parseIPv6('2001:db8::1').slice(0, 2)], [0x20, 0x01]);
  assert.deepStrictEqual([...parseIPv6('::ffff:1.2.3.4').slice(12)], [1, 2, 3, 4]);
  assert.strictEqual(parseIPv6('2001:db8:::1'), null);
});

/* ------------------------------------------------------------------ */
/*  validateTarget                                                    */
/* ------------------------------------------------------------------ */

test('validateTarget rejects non-http protocols', () => {
  for (const u of ['file:///etc/passwd', 'ftp://example.com', 'javascript:alert(1)', 'data:text/html,x']) {
    assert.throws(() => validateTarget(u), /http|valid|proxied/i, `expected ${u} rejected`);
  }
});

test('validateTarget rejects private targets', () => {
  for (const u of [
    'http://127.0.0.1/',
    'http://localhost:3000/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://2130706433/',
    'http://10.0.0.1/',
    'http://192.168.1.1/admin',
  ]) {
    assert.throws(() => validateTarget(u), /private|blocked|local/i, `expected ${u} rejected`);
  }
});

test('validateTarget accepts public URLs', () => {
  assert.strictEqual(validateTarget('https://example.com/a?b=1#c'), 'https://example.com/a?b=1#c');
  assert.strictEqual(validateTarget('http://example.com/'), 'http://example.com/');
});

test('validateTarget strips embedded credentials', () => {
  const out = validateTarget('https://user:pass@example.com/');
  assert.strictEqual(out, 'https://example.com/');
});

test('validateTarget refuses proxying itself', () => {
  assert.throws(
    () => validateTarget('https://relay.example.com/fetch?url=https://x.com', { selfHosts: ['relay.example.com'] }),
    /proxy itself|loop/i
  );
});

/* ------------------------------------------------------------------ */
/*  URL mapping                                                       */
/* ------------------------------------------------------------------ */

test('b64url round-trips', () => {
  const url = 'https://example.com/path?a=1&b=2#frag';
  assert.strictEqual(unb64url(b64url(url)), url);
  assert.ok(!b64url(url).includes('='), 'should be unpadded');
  assert.strictEqual(decodeTargetSegment(b64url(url)), url);
});

test('rewriteUrl maps links through the proxy', () => {
  const out = rewriteUrl('https://example.com/page', { base: 'https://example.com/' });
  assert.ok(out.startsWith('/p/'), `expected /p/ URL, got ${out}`);
  const parsed = targetFromProxyUrl(out, 'http://relay.test');
  assert.strictEqual(parsed.target, 'https://example.com/page');
});

test('rewriteUrl resolves relative paths', () => {
  const out = rewriteUrl('/about', { base: 'https://example.com/dir/page.html' });
  const parsed = targetFromProxyUrl(out, 'http://relay.test');
  assert.strictEqual(parsed.target, 'https://example.com/about');
});

test('rewriteUrl preserves fragments', () => {
  const out = rewriteUrl('https://example.com/x#section', { base: 'https://example.com/' });
  assert.ok(out.endsWith('#section'), `expected hash preserved, got ${out}`);
});

test('rewriteUrl leaves non-proxyable schemes alone', () => {
  for (const u of ['#anchor', 'javascript:void(0)', 'mailto:a@b.c', 'tel:+1234', 'data:image/png;base64,AAA', 'blob:https://x/y']) {
    assert.strictEqual(rewriteUrl(u, { base: 'https://example.com/' }), u);
  }
});

test('rewriteUrl does not double-proxy', () => {
  const once = rewriteUrl('https://example.com/a', { base: 'https://example.com/' });
  const twice = rewriteUrl(once, { base: 'https://example.com/' });
  assert.strictEqual(twice, once);
});

test('form targets use the form prefix', () => {
  const out = rewriteUrl('/login', { base: 'https://example.com/', mode: 'form' });
  assert.ok(out.startsWith('/form/'), `got ${out}`);
  const parsed = targetFromProxyUrl(out, 'http://relay.test');
  assert.strictEqual(parsed.target, 'https://example.com/login');
  assert.strictEqual(parsed.form, true);
});

test('tracking redirects are unwrapped', () => {
  const inner = 'https://example.org/real';
  const enc = 'a1' + Buffer.from(inner).toString('base64url');
  const bing = `https://www.bing.com/ck/a?!&u=${enc}`;
  const out = rewriteUrl(bing, { base: 'https://www.bing.com/' });
  const parsed = targetFromProxyUrl(out, 'http://relay.test');
  assert.strictEqual(parsed.target, inner);
});

test('looksLikeHost recognises bare domains', () => {
  assert.strictEqual(looksLikeHost('example.com'), 'https://example.com');
  assert.strictEqual(looksLikeHost('example.com/a/b'), 'https://example.com/a/b');
  assert.strictEqual(looksLikeHost('localhost:3000'), 'https://localhost:3000');
  assert.strictEqual(looksLikeHost('hello world'), null);
  assert.strictEqual(looksLikeHost('how do i cook rice'), null);
  assert.strictEqual(looksLikeHost('1.1.1.1'), 'https://1.1.1.1');
});

/* ------------------------------------------------------------------ */
/*  HTML rewriting                                                    */
/* ------------------------------------------------------------------ */

test('decodeEntities handles named and numeric entities', () => {
  assert.strictEqual(decodeEntities('&amp;&lt;&gt;&quot;&#39;'), '&<>"\'');
  assert.strictEqual(decodeEntities('&#x41;&#66;'), 'AB');
  assert.strictEqual(decodeEntities('&unknown;'), '&unknown;');
});

test('rewrites href/src/action/poster', () => {
  const doc = `<!doctype html><html><head></head><body>
    <a href="/a">a</a><img src="i.png"><form action="/go"></form><video poster="p.jpg"></video>
  </body></html>`;
  const out = rewriteHtml(doc, { url: 'https://example.com/dir/page.html' });
  assert.ok(out.includes('/p/'), 'links should be proxied');
  assert.ok(!/href="\/a"/.test(out), 'raw href should be gone');
  assert.ok(/action="\/form\//.test(out), 'form action should use /form/');
});

test('rewrites srcset and inline styles', () => {
  const doc = `<img srcset="a.png 1x, b.png 2x" style="background:url('bg.png')">`;
  const out = rewriteHtml(doc, { url: 'https://example.com/' });
  assert.ok(!/srcset="a\.png 1x/.test(out), 'srcset candidate should be rewritten');
  assert.ok(out.includes('/raw?url='), 'inline style url should be proxied');
});

test('strips CSP meta, integrity, base and target=_blank', () => {
  const doc = `<html><head><base href="https://cdn.example.com/">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'">
    <script src="a.js" integrity="sha384-xyz" crossorigin="anonymous"></script>
    </head><body><a href="/x" target="_blank">x</a></body></html>`;
  const out = rewriteHtml(doc, { url: 'https://example.com/' });
  assert.ok(!/content-security-policy/i.test(out), 'CSP meta should go');
  assert.ok(!/integrity=/i.test(out), 'integrity should go');
  assert.ok(!/<base\b/i.test(out), 'base should go');
  assert.ok(!/target="_blank"/i.test(out), 'target=_blank should go');
});

test('honours <base href> when resolving relative URLs', () => {
  const doc = `<html><head><base href="https://cdn.example.com/assets/"></head><body><img src="pic.png"></body></html>`;
  const out = rewriteHtml(doc, { url: 'https://example.com/' });
  const m = /src="(\/p\/[^"]+)"/.exec(out);
  assert.ok(m, 'img should be proxied');
  const parsed = targetFromProxyUrl(m[1], 'http://relay.test');
  assert.strictEqual(parsed.target, 'https://cdn.example.com/assets/pic.png');
});

test('does not touch URLs inside script or textarea', () => {
  const doc = `<html><head><script>var u="https://example.com/x";</script></head>
    <body><textarea><a href="/not-a-link"></a></textarea></body></html>`;
  const out = rewriteHtml(doc, { url: 'https://example.com/' });
  assert.ok(out.includes('var u="https://example.com/x"'), 'script body untouched');
  assert.ok(out.includes('<a href="/not-a-link">'), 'textarea untouched');
});

test('reader mode removes scripts and event handlers', () => {
  const doc = `<html><body><script>alert(1)</script><p onclick="x()">hi</p><img src="a.png" onerror="y()"></body></html>`;
  const out = rewriteHtml(doc, { url: 'https://example.com/', reader: true });
  assert.ok(!out.includes('alert(1)'), 'page script removed');
  assert.ok(!/onclick=/i.test(out), 'inline handler removed');
  assert.ok(!/onerror=/i.test(out), 'img handler removed');
});

test('injects the client runtime exactly once', () => {
  const doc = `<html><head></head><body>hi</body></html>`;
  const out = rewriteHtml(doc, { url: 'https://example.com/', nonce: 'abc123' });
  const count = (out.match(/data-relay-runtime/g) || []).length;
  assert.strictEqual(count, 1, 'runtime injected once');
  assert.ok(out.includes('abc123'), 'nonce embedded');
});

test('meta refresh is rewritten', () => {
  const doc = `<html><head><meta http-equiv="refresh" content="0; url=/next"></head></html>`;
  const out = rewriteHtml(doc, { url: 'https://example.com/a' });
  assert.ok(/url=(\/p\/|\/fetch)/.test(out), 'refresh target proxied');
});

test('CSS url() and @import are rewritten', () => {
  const css = `body{background:url(/bg.png)} @import "/extra.css"; .x{background:url(data:image/png;base64,AA)}`;
  const out = rewriteCss(css, 'https://example.com/css/main.css');
  assert.ok(out.includes('/raw?url='), 'url() rewritten');
  assert.ok(out.includes('@import url("/raw?url='), '@import rewritten');
  assert.ok(out.includes('data:image/png;base64,AA'), 'data URI untouched');
});

test('xlink:href and formaction are rewritten', () => {
  const doc = `<svg><use xlink:href="/sprite.svg#icon"></use></svg>
    <button formaction="/submit">go</button>`;
  const out = rewriteHtml(doc, { url: 'https://example.com/' });
  assert.ok(!out.includes('xlink:href="/sprite.svg'), 'xlink rewritten');
  assert.ok(!out.includes('formaction="/submit"'), 'formaction rewritten');
});

test('srcdoc iframes are rewritten recursively', () => {
  const doc = `<iframe srcdoc="&lt;a href=&quot;/inner&quot;&gt;x&lt;/a&gt;"></iframe>`;
  const out = rewriteHtml(doc, { url: 'https://example.com/' });
  assert.ok(!out.includes('/inner&quot;'), 'nested href rewritten');
});

test('rewrites <style> blocks', () => {
  const doc = `<html><head><style>body{background:url(/x.png)}</style></head></html>`;
  const out = rewriteHtml(doc, { url: 'https://example.com/' });
  assert.ok(out.includes('/raw?url='), 'style block rewritten');
});

test('survives malformed markup without throwing', () => {
  const bad = ['<a href="', '<<<>>>', '<div style="', '<!-- unterminated', '<script>never closed'];
  for (const doc of bad) {
    assert.doesNotThrow(() => rewriteHtml(doc, { url: 'https://example.com/' }), `threw on ${doc}`);
  }
});

/* ------------------------------------------------------------------ */
/*  Error classification                                              */
/* ------------------------------------------------------------------ */

test('a TLS-worded connection reset is not reported as a certificate error', () => {
  const { friendlyError } = require('../src/errors');
  // Node's own message for a RST during handshake contains "TLS", which used
  // to be misclassified as a certificate failure.
  const err = Object.assign(
    new Error('Client network socket disconnected before secure TLS connection was established'),
    { code: 'ECONNRESET' }
  );
  const msg = friendlyError(err, 30000);
  assert.ok(!/certificate/i.test(msg), `should not mention certificates, got: ${msg}`);
  assert.match(msg, /closed before the site responded/i);
});

test('genuine certificate failures are still recognised', () => {
  const { friendlyError } = require('../src/errors');
  for (const code of [
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'CERT_HAS_EXPIRED',
    'ERR_TLS_CERT_ALTNAME_INVALID',
  ]) {
    const msg = friendlyError(Object.assign(new Error('handshake failed'), { code }), 30000);
    assert.match(msg, /certificate/i, `${code} should be a certificate error`);
  }
});

test('DNS, refused, timeout and loop errors are classified distinctly', () => {
  const { friendlyError } = require('../src/errors');
  const cases = [
    ['ENOTFOUND', /find that domain/i],
    ['ECONNREFUSED', /refused/i],
    ['ETIMEDOUT', /too long to respond/i],
    ['EREDIRECT', /redirect/i],
    ['EPRIVATE', /private network/i],
  ];
  for (const [code, re] of cases) {
    const msg = friendlyError(Object.assign(new Error('x'), { code }), 30000);
    assert.match(msg, re, `${code} misclassified: ${msg}`);
  }
});
