'use strict';

/*
 * Security regression tests.
 *
 * These cover the classes of bug that actually get proxies exploited:
 * SSRF via exotic IP notation, DNS rebinding, redirect-to-private,
 * header injection, cookie leakage between visitors, and traversal.
 */

const test = require('node:test');
const assert = require('node:assert');
const dns = require('dns');

const upstream = require('../src/upstream');
const cookies = require('../src/cookies');
const { validateTarget } = require('../src/url');

/* ------------------------------------------------------------------ */
/*  SSRF: connect-time address vetting (DNS rebinding)                */
/* ------------------------------------------------------------------ */

test('resolveSafe refuses a hostname that resolves to a private IP', async () => {
  const original = dns.lookup;
  dns.lookup = function (host, opts, cb) {
    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    }
    if (host === 'rebind.test') {
      return opts && opts.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4);
    }
    if (host === 'rebind-meta.test') {
      return opts && opts.all ? cb(null, [{ address: '169.254.169.254', family: 4 }]) : cb(null, '169.254.169.254', 4);
    }
    return original.call(dns, host, opts, cb);
  };

  try {
    await assert.rejects(() => upstream.resolveSafe('rebind.test'), (e) => e.code === 'EPRIVATE');
    await assert.rejects(() => upstream.resolveSafe('rebind-meta.test'), (e) => e.code === 'EPRIVATE');
  } finally {
    dns.lookup = original;
    upstream.clearDnsCache();
  }
});

test('resolveSafe refuses literal private addresses without a DNS lookup', async () => {
  for (const host of ['127.0.0.1', '169.254.169.254', '10.0.0.1', '[::1]', '::ffff:127.0.0.1', '0x7f000001']) {
    await assert.rejects(
      () => upstream.resolveSafe(host),
      (e) => e.code === 'EPRIVATE',
      `expected ${host} to be refused`
    );
  }
});

/* ------------------------------------------------------------------ */
/*  SSRF: redirect chains                                            */
/* ------------------------------------------------------------------ */

test('a redirect to a private address is refused', async () => {
  // validateTarget is invoked on every hop inside fetchWithRedirects; this
  // asserts the hop-level gate directly.
  assert.throws(
    () => validateTarget('http://169.254.169.254/latest/meta-data/', { selfHosts: [] }),
    /private|blocked|local/i
  );
});

test('redirect handling never exceeds the cap', async () => {
  // Guard against an infinite redirect loop exhausting resources.
  assert.strictEqual(typeof upstream.MAX_REDIRECTS, 'number');
  assert.ok(upstream.MAX_REDIRECTS <= 20);
});

/* ------------------------------------------------------------------ */
/*  Cookie isolation between visitors                                */
/* ------------------------------------------------------------------ */

test('two sessions do not share cookies', () => {
  const url = 'https://shop.example.com/cart';
  cookies.store('session-a', url, ['cart=aaa; Path=/']);
  cookies.store('session-b', url, ['cart=bbb; Path=/']);

  assert.match(cookies.header('session-a', url), /cart=aaa/);
  assert.match(cookies.header('session-b', url), /cart=bbb/);
  assert.ok(!cookies.header('session-a', url).includes('bbb'));

  cookies.clearSession('session-a');
  cookies.clearSession('session-b');
});

test('cookies are scoped by path and domain', () => {
  const url = 'https://example.com/app/page';
  cookies.store('s1', url, ['scoped=1; Path=/app']);
  assert.match(cookies.header('s1', 'https://example.com/app/deep'), /scoped=1/);
  assert.ok(!cookies.header('s1', 'https://example.com/other').includes('scoped'));
  // Not sent to an unrelated domain.
  assert.ok(!cookies.header('s1', 'https://evil.com/app/page').includes('scoped'));
  cookies.clearSession('s1');
});

test('a Domain attribute cannot escape the request origin', () => {
  // example.com must not be able to set a cookie for .com or for evil.com.
  cookies.store('s2', 'https://example.com/', ['x=1; Domain=com']);
  cookies.store('s2', 'https://example.com/', ['y=1; Domain=evil.com']);
  const jar = cookies.list('s2', 'https://example.com');
  const names = jar.map((c) => c.name);
  assert.ok(!names.includes('x'), 'Domain=com must be rejected');
  assert.ok(!names.includes('y'), 'Domain=evil.com must be rejected');
  cookies.clearSession('s2');
});

test('Secure cookies are not sent over plain http', () => {
  cookies.store('s3', 'https://example.com/', ['tok=secret; Secure; Path=/']);
  assert.match(cookies.header('s3', 'https://example.com/'), /tok=secret/);
  assert.ok(!cookies.header('s3', 'http://example.com/').includes('tok=secret'));
  cookies.clearSession('s3');
});

test('Max-Age=0 deletes a cookie', () => {
  const url = 'https://example.com/';
  cookies.store('s4', url, ['gone=1; Path=/']);
  assert.match(cookies.header('s4', url), /gone=1/);
  cookies.store('s4', url, ['gone=1; Path=/; Max-Age=0']);
  assert.ok(!cookies.header('s4', url).includes('gone'));
  cookies.clearSession('s4');
});

test('oversized Set-Cookie headers are dropped', () => {
  const huge = 'big=' + 'x'.repeat(9000);
  cookies.store('s5', 'https://example.com/', [huge]);
  assert.ok(!cookies.header('s5', 'https://example.com/').includes('xxxx'));
  cookies.clearSession('s5');
});

/* ------------------------------------------------------------------ */
/*  Header handling                                                   */
/* ------------------------------------------------------------------ */

test('relayHeaders strips hop-by-hop and proxy-breaking headers', () => {
  const { relayHeaders } = require('../src/headers');
  const out = relayHeaders({
    Connection: 'keep-alive',
    'Content-Security-Policy': "default-src 'none'",
    'X-Frame-Options': 'DENY',
    'Strict-Transport-Security': 'max-age=1',
    'Content-Length': '123',
    'Content-Encoding': 'gzip',
    'Set-Cookie': 'a=b',
    Location: '/next',
    'Content-Type': 'text/html',
    'X-Custom': 'kept',
  });
  // relayHeaders normalises every name to lowercase.
  for (const gone of [
    'connection',
    'content-security-policy',
    'x-frame-options',
    'strict-transport-security',
    'content-length',
    'content-encoding',
    'set-cookie',
  ]) {
    assert.strictEqual(out[gone], undefined, `${gone} should be stripped`);
  }
  assert.strictEqual(out.location, undefined, 'location is rewritten by the caller');
  assert.strictEqual(out['content-type'], 'text/html');
  assert.strictEqual(out['x-custom'], 'kept', 'safe headers survive');
});

test('error pages do not reflect unescaped HTML', () => {
  const { escapeHtml, escapeAttr } = require('../src/rewrite/html');
  const evil = '<script>alert(1)</script>';
  assert.ok(!escapeHtml(evil).includes('<script>'));
  assert.ok(!escapeAttr('" onload="x').includes('"'), 'attr escaping closes the hole');
});
