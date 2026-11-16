// Container health check: exits 0 if the server answers GET /healthz with 200, 1 otherwise.
// Uses the same PORT / HOST / TLS_CERT+TLS_KEY settings as server.js, so it keeps working when they change.
// Run as: node server/healthcheck.js
const http = require('node:http');
const https = require('node:https');

const PORT = parseInt(process.env.PORT || '4567', 10);
const BIND = process.env.HOST || '0.0.0.0';
// A wildcard bind address accepts loopback connections; anything else must be dialled as is.
const HOST = BIND === '0.0.0.0' ? '127.0.0.1' : BIND === '::' ? '::1' : BIND;
const TLS = !!(process.env.TLS_CERT && process.env.TLS_KEY);
const TIMEOUT_MS = parseInt(process.env.HEALTHCHECK_TIMEOUT_MS || '2500', 10);

const req = (TLS ? https : http).get({
  host: HOST,
  port: PORT,
  path: '/healthz',
  timeout: TIMEOUT_MS,
  // The certificate is issued for the public host name, not for loopback: only liveness is checked here.
  rejectUnauthorized: false,
}, (res) => {
  res.resume();
  if (res.statusCode === 200) process.exit(0);
  console.error(`healthcheck: /healthz returned ${res.statusCode}`);
  process.exit(1);
});
req.on('timeout', () => req.destroy(new Error(`no answer within ${TIMEOUT_MS} ms`)));
req.on('error', (err) => {
  console.error(`healthcheck: ${err.message}`);
  process.exit(1);
});
