'use strict';

/*
 * Turning upstream failures into something a human can act on.
 *
 * Order matters here: we match on error *codes* before falling back to text,
 * because Node's own messages are misleading. For example a connection reset
 * during a TLS handshake reads "disconnected before secure TLS connection was
 * established" — which a naive /TLS/ test reports as a certificate problem.
 */

const { TargetError } = require('./url');

function friendlyError(err, timeoutMs) {
  if (!err) return 'Something went wrong.\nPlease try again.';

  const code = String(err.code || '');
  const msg = String(err.message || err);
  const cause = err.cause ? String(err.cause.code || err.cause.message || '') : '';
  const all = `${code} ${msg} ${cause}`;

  if (err instanceof TargetError) return err.message;

  // --- Specific error codes first. Order matters: a message like
  // "disconnected before secure TLS connection was established" contains the
  // word "TLS" but is really a reset, so we must classify by code before
  // falling back to fuzzy text matching.
  if (code === 'EPRIVATE' || /Blocked: local\/private/i.test(all)) {
    return 'That address points inside the private network.\nRelay refuses to connect to local, private or cloud-metadata addresses.';
  }
  if (code === 'ENOTFOUND' || code === 'EAI_NODATA') {
    return 'Couldn’t find that domain.\nThe address may be misspelled, or the site no longer exists.';
  }
  if (code === 'EAI_AGAIN') {
    return 'DNS lookup failed.\nThe proxy server couldn’t resolve that hostname right now.';
  }
  if (code === 'ECONNREFUSED') {
    return 'The site refused the connection.\nIt may be down, or firewalled against proxies.';
  }
  if (code === 'ECONNRESET' || code === 'EPIPE') {
    return 'The connection was closed before the site responded.\nThis usually means the site (or a firewall in front of it) is blocking automated access.';
  }
  if (code === 'ETIMEDOUT' || err.name === 'AbortError') {
    return 'The site took too long to respond.\nRelay gives up after ' + Math.round((timeoutMs || 30000) / 1000) + ' seconds — the site may be down or blocking proxies.';
  }
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH' || code === 'EADDRNOTAVAIL') {
    return 'The network is unreachable from this server.\nNo route to that address was available.';
  }
  if (code === 'EREDIRECT') {
    return 'The site redirected too many times.\nIts redirect loop was stopped by the proxy.';
  }
  if (code === 'ETOOLARGE') return 'That response was too large to relay.';
  if (code === 'EBADTARGET') return 'That URL can’t be proxied.\nOnly public http:// and https:// addresses are allowed.';

  // --- TLS problems (only after the codes above are ruled out).
  if (
    code === 'CERT_HAS_EXPIRED' ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' ||
    code === 'ERR_TLS_CERT_ALTNAME_INVALID' ||
    code === 'ERR_SSL_WRONG_VERSION_NUMBER' ||
    code === 'EPROTO' ||
    /certificate|self.signed|verify leaf|issuer cert/i.test(all)
  ) {
    return 'Secure connection failed.\nThe site’s TLS certificate could not be verified by this server.';
  }

  // --- Fall back to text matching.
  if (/getaddrinfo/i.test(all)) {
    return 'Couldn’t find that domain.\nThe address may be misspelled, or the site no longer exists.';
  }
  if (/timeout|timed out/i.test(all)) {
    return 'The site took too long to respond.\nIt may be down or blocking proxies.';
  }
  if (/redirect/i.test(all)) {
    return 'The site redirected too many times.\nIts redirect loop was stopped by the proxy.';
  }

  return msg.replace(/^fetch failed$/i, 'Couldn’t reach that site.\nThe request failed before any response came back.');
}


module.exports = { friendlyError };
