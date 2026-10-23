#!/usr/bin/env node
// Guest first-paint guard (PERF-01): the guest ordering page (/order/<slug>) and the QR table page (/t/<qr>) must
// carry their heading and menu in the server HTML itself, not behind a streamed Suspense boundary. When the content
// streams in after a loading fallback, React reveals it with a batched timer that a repeat visit's cached JavaScript
// can delay until hydration has finished (~1.3 s on the lab mobile profile instead of ~0.3 s).
//
//   node scripts/perf/guest-shell.mjs --web http://127.0.0.1:3997 --accounts <demo-accounts.json> [--json]
//
// For each page it fetches the HTML (twice: the first request fills the server's shared cache) and checks, in the
// order the browser parses it, that:
//   - the <h1> and at least one dish card are present;
//   - neither sits inside a hidden streamed segment (<div hidden id="S:…">, revealed later by script) and nothing is
//     painted in their place first: no Suspense fallback (<template id="B:…"> followed by fallback markup) and no
//     loading shell (gx-loading) before them. Next's empty metadata boundary (inside a hidden div) does not count.
// Exits 1 when a check fails. Local or staging only.
import { readFileSync } from 'node:fs';
import { args, assertLocalUrl } from './lib/guard.mjs';
import { inspectGuestShell } from './lib/guest-shell.mjs';

const a = args();
const WEB = String(a.web ?? 'http://127.0.0.1:3570').replace(/\/$/, '');
assertLocalUrl(WEB);
const acct = JSON.parse(readFileSync(a.accounts ?? '', 'utf8'));

const pages = [
  ['web-order', `/order/${acct.slug}`, 'en'],
  ['guest-qr', `/t/${acct.qr.qrToken}`, 'ar'],
];
const results = [];
for (const [id, path, locale] of pages) {
  let html = '';
  let status = 0;
  for (let i = 0; i < 2; i++) {
    const res = await fetch(WEB + path, { headers: { cookie: `resuto_locale=${locale}`, accept: 'text/html' } });
    status = res.status;
    html = await res.text();
  }
  results.push({ id, path: path.replace(acct.qr.qrToken, '<qr>'), status, ...inspectGuestShell(html) });
}
if (a.json) console.log(JSON.stringify(results, null, 1));
else for (const r of results) console.log(`${r.ok && r.status === 200 ? 'ok  ' : 'FAIL'} ${r.id} (${r.status}, ${r.bytes} B): h1@${r.h1} dish@${r.dish} hiddenSegment@${r.firstHiddenSegment} fallback@${r.firstFallback} loading@${r.loading}${r.problems.length ? ` - ${r.problems.join('; ')}` : ''}`);
process.exit(results.every((r) => r.ok && r.status === 200) ? 0 : 1);
