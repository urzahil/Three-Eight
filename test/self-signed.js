// A self-signed certificate made with node:crypto alone (no openssl binary), for tests that serve TLS.
// selfSigned('host.test') -> { cert, key } in PEM. ECDSA P-256 with SHA-256, valid from a day ago for 30 days, or from
// `from` to `to` (Dates).
'use strict';
const crypto = require('node:crypto');

function der(tag, content) {
  const n = content.length;
  const len = n < 0x80 ? Buffer.from([n]) : (() => {
    const bytes = [];
    for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
    return Buffer.from([0x80 | bytes.length, ...bytes]);
  })();
  return Buffer.concat([Buffer.from([tag]), len, content]);
}
const seq = (...items) => der(0x30, Buffer.concat(items));
const set = (...items) => der(0x31, Buffer.concat(items));
const int = (buf) => der(0x02, buf[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf);
const utf8 = (s) => der(0x0c, Buffer.from(s, 'utf8'));
const bits = (buf) => der(0x03, Buffer.concat([Buffer.from([0]), buf]));
function oid(dotted) {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const out = [40 * a + b];
  for (const v of rest) {
    const chunk = [v & 0x7f];
    for (let x = v >> 7; x > 0; x >>= 7) chunk.unshift((x & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return der(0x06, Buffer.from(out));
}
function utcTime(date) {
  const p = (n) => String(n).padStart(2, '0');
  const s = `${p(date.getUTCFullYear() % 100)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
  return der(0x17, Buffer.from(s, 'ascii'));
}

const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));

function selfSigned(commonName, { from = new Date(Date.now() - 86400e3), to = new Date(Date.now() + 30 * 86400e3) } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const name = seq(set(seq(oid('2.5.4.3'), utf8(commonName))));
  const tbs = seq(
    der(0xa0, int(Buffer.from([2]))), // v3
    int(crypto.randomBytes(8)),
    ECDSA_SHA256,
    name,
    seq(utcTime(from), utcTime(to)),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const cert = seq(tbs, ECDSA_SHA256, bits(crypto.sign('sha256', tbs, privateKey)));
  const pem = `-----BEGIN CERTIFICATE-----\n${cert.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  return { cert: pem, key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

module.exports = { selfSigned };
