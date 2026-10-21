// node --test scripts/ui/test/*.test.mjs  (PCL-07: the first-load JS gate CI runs after `next build`)
// Runs the real script against a synthetic .next build: random bytes do not compress, so gzip size ~ file size.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { BUDGETS, ROUTE_RATCHETS } from '../bundle-budget.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bundle-budget.mjs');
const groupKb = (route) => BUDGETS.find((b) => b.test(route)).kb;

/** routes: { '/t/[qr]': kB of page JS }. A shared 20 kB root layout chunk is added to every route. */
function fakeBuild(routes) {
  const dir = mkdtempSync(path.join(tmpdir(), 'budget-'));
  mkdirSync(path.join(dir, 'static/chunks'), { recursive: true });
  const chunk = (name, kb) => { writeFileSync(path.join(dir, 'static/chunks', name), randomBytes(Math.round(kb * 1000))); return `static/chunks/${name}`; };
  const pages = { '/layout': [chunk('layout.js', 20)] };
  Object.entries(routes).forEach(([route, kb], i) => { pages[`${route === '/' ? '' : route}/page`] = [chunk(`p${i}.js`, kb - 20)]; });
  writeFileSync(path.join(dir, 'app-build-manifest.json'), JSON.stringify({ pages }));
  return dir;
}
const run = (dir, ...extra) => spawnSync(process.execPath, [SCRIPT, '--next', dir, ...extra], { encoding: 'utf8' });
/** Every ratchet route at `delta` kB relative to its ratchet. */
const ratchetRoutes = (delta = -3) => Object.fromEntries(Object.entries(ROUTE_RATCHETS).map(([r, kb]) => [r, kb + delta]));

describe('bundle budget gate', () => {
  it('passes when every route is within its budget (the CI state: ratchet routes under their ratchet)', () => {
    const res = run(fakeBuild({ ...ratchetRoutes(), '/order/[slug]': 150, '/dashboard/[orgId]/orders': 200 }));
    assert.equal(res.status, 0, res.stdout + res.stderr);
  });

  it('fails when an ordinary route grows past its group budget', () => {
    const res = run(fakeBuild({ ...ratchetRoutes(), '/order/[slug]': groupKb('/order/x') + 5 }));
    assert.equal(res.status, 1);
    assert.match(res.stdout, /OVER\s+guest .*\/order\/\[slug\]/);
  });

  it('a route ratchet does not loosen the group: another guest route at the ratchet size still fails', () => {
    const res = run(fakeBuild({ ...ratchetRoutes(), '/t/[qr]/pay': ROUTE_RATCHETS['/t/[qr]'] - 1 }));
    assert.equal(res.status, 1);
    assert.match(res.stdout, /OVER\s+guest .*\/t\/\[qr\]\/pay/);
  });

  it('fails when a ratcheted route grows past its own ratchet', () => {
    const res = run(fakeBuild({ ...ratchetRoutes(), '/t/[qr]': ROUTE_RATCHETS['/t/[qr]'] + 2 }));
    assert.equal(res.status, 1);
    assert.match(res.stdout, /OVER\s+guest .*\(route ratchet; group 170\).*\/t\/\[qr\]$/m);
  });

  it('fails on a stale ratchet once the route fits its group budget again, so the exception is removed', () => {
    const res = run(fakeBuild({ ...ratchetRoutes(), '/t/[qr]': groupKb('/t/x') - 10 }));
    assert.equal(res.status, 1);
    assert.match(res.stderr, /no longer needed.*\/t\/\[qr\]/);
  });

  it('--report never fails (local measurement)', () => {
    const res = run(fakeBuild({ ...ratchetRoutes(+10), '/order/[slug]': 400 }), '--report');
    assert.equal(res.status, 0);
  });
});
