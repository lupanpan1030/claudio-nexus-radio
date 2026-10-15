'use strict';
// Preloaded (node --require) by scripts/smoke.mjs before any product module.
// Refuses non-loopback fetch, TCP/TLS connections and Unix sockets, and
// refuses to start child processes (except the esbuild binary tsx may use).
// It fabricates no responses: refused I/O throws, so the product takes its own
// failure path. Records origin/path only (no headers, query or body) to
// CLAUDIO_NETWORK_GUARD_LOG when set. A guard against accidental network use
// by a test process, not an OS sandbox.
const fs = require('node:fs');
const net = require('node:net');
const tls = require('node:tls');
const cp = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');

const logPath = process.env.CLAUDIO_NETWORK_GUARD_LOG;
const append = fs.appendFileSync.bind(fs);
function record(event) {
  if (logPath) append(logPath, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...event }) + '\n');
}
function local(host) {
  return ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(host);
}
function denied(kind, detail) {
  record({ kind, allowed: false, ...detail });
  const error = new Error('ISOLATED_NETWORK_DENIED');
  error.code = 'ISOLATED_NETWORK_DENIED';
  throw error;
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async function guardedFetch(input, init) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const safe = { origin: url.origin, pathname: url.pathname, method: init?.method ?? 'GET' };
  if (!local(url.hostname)) denied('fetch', safe);
  record({ kind: 'fetch', allowed: true, ...safe });
  return originalFetch.call(this, input, init);
};

function socketHost(args) {
  if (Array.isArray(args[0])) args = args[0];
  const first = args[0];
  if (first && typeof first === 'object') return first.path ? 'unix-socket' : String(first.host ?? first.hostname ?? 'localhost');
  if (typeof first === 'number' || /^\d+$/.test(String(first))) return typeof args[1] === 'string' ? args[1] : 'localhost';
  return 'unix-socket';
}

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const host = socketHost(args);
  if (!local(host)) denied('socket', { host });
  record({ kind: 'socket', allowed: true, host });
  return originalConnect.apply(this, args);
};
const originalTls = tls.connect;
tls.connect = function guardedTls(...args) {
  const host = socketHost(args);
  if (!local(host)) denied('tls', { host });
  return originalTls.apply(this, args);
};

for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const original = cp[name];
  cp[name] = function guardedChild(command, ...args) {
    const allowed = String(command).includes('/node_modules/@esbuild/') && String(command).endsWith('/bin/esbuild');
    record({ kind: 'child-process', method: name, command: String(command), allowed });
    if (!allowed) throw new Error('ISOLATED_CHILD_PROCESS_DENIED');
    return original.call(this, command, ...args);
  };
}
syncBuiltinESMExports();
record({ kind: 'guard-installed', cwd: process.cwd(), homePresent: 'HOME' in process.env });
