// Key under which per-client limits are counted.

'use strict';

const net = require('net');

// The eight 16-bit groups of an IPv6 address (null if it is not one). Handles "::" and a dotted IPv4 tail.
function ipv6Groups(ip) {
  let text = ip;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const b = tail[1].split('.').map(Number);
    text = text.slice(0, tail.index) + ((b[0] << 8) | b[1]).toString(16) + ':' + ((b[2] << 8) | b[3]).toString(16);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill('0'), ...rest].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/**
 * The limiter key for a client address: IPv4 as is, IPv4-mapped IPv6 (::ffff:1.2.3.4) as that IPv4 address, any
 * other IPv6 address as its /64 prefix (one subscriber controls a whole /64, so rotating inside it must not help).
 * Anything that is not an IP address is used unchanged.
 */
function limiterKey(ip) {
  let text = String(ip || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (net.isIPv4(text)) return text;
  if (!net.isIPv6(text)) return String(ip || '');
  const g = ipv6Groups(text);
  if (!g) return String(ip || '');
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  return g.slice(0, 4).map((x) => x.toString(16)).join(':') + '::/64';
}

/**
 * The IP address in a value taken from a forwarding header, or '' when it is not one. A ":port" after an IPv4
 * address and the brackets (with optional ":port") around an IPv6 address are removed first. Anything else
 * (a forged header can hold any text) is refused, so callers fall back to the socket's address.
 */
function forwardedAddress(value) {
  let text = String(value || '').trim();
  if (text.length > 64) return '';
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(text);
  const v4port = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(text);
  if (bracketed) text = bracketed[1];
  else if (v4port) text = v4port[1];
  return net.isIP(text) ? text : '';
}

module.exports = { limiterKey, forwardedAddress };
