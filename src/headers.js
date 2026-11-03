'use strict';

/*
 * Response-header policy.
 *
 * A rewriting proxy has to undo a lot of what origins send: CSP and SRI would
 * block every rewritten asset, frame options would break our viewer, and HSTS
 * would pin the *proxy's* origin to https incorrectly. Everything hop-by-hop
 * is meaningless across two connections.
 */

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const STRIPPED_RESPONSE = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'strict-transport-security',
  'public-key-pins',
  'public-key-pins-report-only',
  'expect-ct',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'permissions-policy',
  'feature-policy',
  'content-length',
  'content-encoding',
  'set-cookie',
  'alt-svc',
  'report-to',
  'nel',
  'clear-site-data',
]);

function relayHeaders(upstreamHeaders) {
  const out = {};
  for (const [key, value] of Object.entries(upstreamHeaders)) {
    const k = key.toLowerCase();
    if (HOP_BY_HOP.has(k)) continue;
    if (STRIPPED_RESPONSE.has(k)) continue;
    if (k === 'location') continue; // rewritten by the caller
    out[k] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}


module.exports = { relayHeaders, HOP_BY_HOP, STRIPPED_RESPONSE };
