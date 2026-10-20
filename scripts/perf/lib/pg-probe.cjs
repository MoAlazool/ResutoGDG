// Perf-only preload for the API process: counts database statements and their time per HTTP request and reports
// them in an `X-Perf-Db` response header ("q=<statements>;app=<non-bookkeeping statements>;ms=<db time>;tx=<begins>").
// db time is the union of the intervals during which at least one statement of the request was outstanding, so
// statements queued behind each other on one connection (Promise.all inside a transaction) are not double counted.
// pg_stat_statements is not loadable on a shared local cluster (needs shared_preload_libraries), so the harness
// counts at the driver instead. Loaded only by scripts/perf/api-latency.mjs when it spawns the API
// (NODE_OPTIONS=--require .../pg-probe.cjs); never part of the application build.
'use strict';
const http = require('node:http');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createRequire } = require('node:module');

const als = new AsyncLocalStorage();
const apiRequire = createRequire(path.resolve(process.env.PERF_PROBE_API_DIR || path.join(__dirname, '../../../apps/api'), 'package.json'));
const pg = apiRequire('pg');

const BOOKKEEPING = /^\s*(begin|commit|rollback|set local|select set_config\(|savepoint|release savepoint)/i;
const original = pg.Client.prototype.query;
pg.Client.prototype.query = function probedQuery(config, values, callback) {
  const store = als.getStore();
  if (!store) return original.call(this, config, values, callback);
  const text = typeof config === 'string' ? config : config && config.text ? config.text : '';
  store.q++;
  if (/^\s*begin/i.test(text)) store.tx++;
  if (!BOOKKEEPING.test(text)) store.app++;
  const started = process.hrtime.bigint();
  if (store.open++ === 0) store.since = started;
  const done = () => { if (--store.open === 0) store.ns += process.hrtime.bigint() - store.since; };
  const result = original.call(this, config, values, callback);
  if (result && typeof result.then === 'function') result.then(done, done);
  return result;
};

const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function probedEmit(event, req, res) {
  if (event !== 'request' || !res || typeof res.writeHead !== 'function') return emit.apply(this, arguments);
  const store = { q: 0, app: 0, tx: 0, ns: 0n, open: 0, since: 0n };
  const writeHead = res.writeHead;
  res.writeHead = function probedWriteHead() {
    if (!res.headersSent) {
      try { res.setHeader('X-Perf-Db', `q=${store.q};app=${store.app};ms=${(Number(store.ns) / 1e6).toFixed(2)};tx=${store.tx}`); } catch { /* headers already sent */ }
    }
    return writeHead.apply(this, arguments);
  };
  const args = arguments;
  return als.run(store, () => emit.apply(this, args));
};
