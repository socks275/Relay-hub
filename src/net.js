'use strict';

/*
 * Transport-level helpers: content negotiation for compression, stream
 * utilities and safe header writing.
 */

const zlib = require('zlib');
const { Readable } = require('stream');

const MIN_COMPRESS = 1024;
const NO_COMPRESS_TYPES = /^(image|video|audio|font)\/|zip|gzip|compress|octet-stream|woff2?$/i;

/** Pick the best encoding the client accepts. */
function preferredEncoding(req, contentType, size) {
  if (process.env.RELAY_NO_COMPRESS === '1') return null;
  if (size < MIN_COMPRESS) return null;
  if (contentType && NO_COMPRESS_TYPES.test(contentType)) return null;
  const accept = String(req.headers['accept-encoding'] || '').toLowerCase();
  if (!accept) return null;

  const q = (name) => {
    const m = new RegExp('(?:^|,)\\s*' + name + '\\s*(?:;\\s*q=([0-9.]+))?').exec(accept);
    if (!m) return null;
    return m[1] === undefined ? 1 : parseFloat(m[1]);
  };

  const br = q('br');
  const gzip = q('gzip');
  const deflate = q('deflate');
  const identity = q('identity');

  const best = [
    ['br', br === null ? 0 : br],
    ['gzip', gzip === null ? 0 : gzip],
    ['deflate', deflate === null ? 0 : deflate],
  ]
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);

  if (!best.length) return null;
  if (identity !== null && identity === 1 && identity > best[0][1]) return null;
  return best[0][0];
}

/** Buffer + write with optional compression. */
function sendCompressed(req, res, status, headers, buf, opts = {}) {
  if (opts.ct) headers['content-type'] = opts.ct;
  const encoding = preferredEncoding(req, headers['content-type'], buf.length);

  if (encoding) {
    const compressor =
      encoding === 'br'
        ? zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } })
        : encoding === 'gzip'
          ? zlib.gzipSync(buf, { level: 6 })
          : zlib.deflateSync(buf, { level: 6 });

    // Only worth it if it actually saved bytes.
    if (compressor.length < buf.length) {
      headers['content-encoding'] = encoding;
      headers['content-length'] = String(compressor.length);
      headers.vary = appendVary(headers.vary, 'accept-encoding');
      res.writeHead(status, headers);
      if (req.method === 'HEAD') return res.end();
      return res.end(compressor);
    }
  }

  headers['content-length'] = String(buf.length);
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  return res.end(buf);
}

function appendVary(existing, value) {
  if (!existing) return value;
  const parts = String(existing).split(/\s*,\s*/);
  if (parts.some((p) => p.toLowerCase() === value.toLowerCase())) return existing;
  return existing + ', ' + value;
}

/** Convert a web ReadableStream to a Node stream (handles both shapes). */
function fromWeb(stream) {
  if (!stream) return null;
  if (typeof stream.pipe === 'function') return stream;
  if (typeof Readable.fromWeb === 'function') return Readable.fromWeb(stream);
  return Readable.from(stream);
}

/** Wrap a Node stream so we can observe byte counts. */
function counted(stream, onEnd) {
  let bytes = 0;
  stream.on('data', (c) => {
    bytes += c.length;
  });
  stream.on('end', () => onEnd && onEnd(bytes));
  return stream;
}

/** Read a Node stream into a Buffer with a cap. */
function collect(stream, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on('data', (c) => {
      size += c.length;
      if (limit && size > limit) {
        stream.destroy();
        const err = new Error('stream too large');
        err.code = 'ETOOLARGE';
        return reject(err);
      }
      chunks.push(c);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
    stream.on('aborted', () => reject(Object.assign(new Error('aborted'), { code: 'ECONNRESET' })));
  });
}

module.exports = {
  preferredEncoding,
  sendCompressed,
  appendVary,
  fromWeb,
  counted,
  collect,
  MIN_COMPRESS,
};
