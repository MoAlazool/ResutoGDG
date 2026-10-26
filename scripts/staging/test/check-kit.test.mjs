// node --test scripts/staging/test/*.test.mjs  (pure helpers of the Eid and onboarding staging checks)
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  base32Decode, commitMatches, discountedPrice, exitCodeFor, leaks, menuQrProblems, missingInOrder, orderingUiMarkers, parseMcpBody, pngBytes,
  redact, targetProblem, throwawayId, totp, visibleHtml,
} from '../lib/check-kit.mjs';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('staging check kit', () => {
  it('exits 1 on a failure, 3 when only blocked, 0 when all passed', () => {
    assert.equal(exitCodeFor([{ status: 'pass' }]), 0);
    assert.equal(exitCodeFor([{ status: 'pass' }, { status: 'blocked' }]), 3);
    assert.equal(exitCodeFor([{ status: 'blocked' }, { status: 'fail' }]), 1);
    assert.equal(exitCodeFor([]), 0);
  });

  it('matches abbreviated commits both ways and refuses unknown ones', () => {
    assert.equal(commitMatches('e4d5bb0a1b2c3d4e', 'e4d5bb0'), true);
    assert.equal(commitMatches('e4d5bb0', 'E4D5BB0A1B2C'), true);
    assert.equal(commitMatches('e4d5bb0', 'f00'), false);
    assert.equal(commitMatches(null, 'e4d5bb0'), false);
  });

  it('runs only against loopback or a staging host unless overridden', () => {
    assert.equal(targetProblem('http://127.0.0.1:4681'), null);
    assert.equal(targetProblem('http://localhost:3681'), null);
    assert.equal(targetProblem('https://resuto-2-staging-api.onrender.com'), null);
    assert.match(targetProblem('https://api.resuto.app'), /does not look like staging/);
    assert.equal(targetProblem('https://api.resuto.app', true), null);
    assert.match(targetProblem('not a url'), /not a URL/);
  });

  it('reads Streamable HTTP bodies as JSON or SSE', () => {
    assert.deepEqual(parseMcpBody('{"jsonrpc":"2.0","id":1,"result":{}}'), { jsonrpc: '2.0', id: 1, result: {} });
    assert.deepEqual(parseMcpBody('event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n'), { jsonrpc: '2.0', id: 2, result: { ok: true } });
    assert.equal(parseMcpBody(''), null);
    assert.equal(parseMcpBody('event: ping\n\n'), null);
  });

  it('computes RFC 6238 TOTP codes (SHA-1 test vectors, 6 digits)', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // "12345678901234567890"
    assert.equal(base32Decode(secret).toString(), '12345678901234567890');
    assert.equal(totp(secret, 59_000), '287082');
    assert.equal(totp(secret, 1_111_111_109_000), '081804');
    assert.equal(totp(secret, 1_234_567_890_000), '005924');
    assert.equal(totp('gezd gnbv gy3t qojq gezd gnbv gy3t qojq', 59_000), '287082');
    assert.throws(() => base32Decode('not-base32!'), /invalid base32/);
  });

  it('names throwaways as valid, dated, prefixed web addresses', () => {
    const id = throwawayId('stg-onb', new Date(Date.UTC(2026, 9, 26, 7, 5)), 'ab12');
    assert.equal(id, 'stg-onb-202610260705-ab12');
    assert.match(throwawayId('stg-check-eid'), /^stg-check-eid-\d{12}-[0-9a-f]{4}$/);
    assert.throws(() => throwawayId('x'.repeat(40)), /not a valid web address/);
  });

  it('rounds discounts like the API', () => {
    assert.equal(discountedPrice(9500, 1500), 8075);
    assert.equal(discountedPrice(4500, 1500), 3825);
    assert.equal(discountedPrice(18500, 1500), 15725);
    assert.equal(discountedPrice(1, 9000), 1);
  });

  it('finds ordering UI on a rendered page, ignoring scripts', () => {
    assert.deepEqual(orderingUiMarkers('<main><h2>Menu</h2><p>This menu is for browsing</p><script>self.__next_f.push(["checkout gx-dock"])</script></main>'), []);
    assert.deepEqual(orderingUiMarkers('<button class="gx-btn gx-add">+ Add</button>'), ['gx-add', 'Add button']);
    assert.deepEqual(orderingUiMarkers('<div class="gx-dock"><a href="/order/abc">Checkout</a></div>'), ['gx-dock', 'checkout', 'link to an ordering route']);
    assert.deepEqual(orderingUiMarkers('<a href="https://x.test/t/tok123">Table</a>'), ['link to an ordering route']);
    assert.equal(visibleHtml('<p>a</p><!-- checkout --><style>.gx-add{}</style>'), '<p>a</p>');
  });

  it('accepts only a view-only menu QR for the slug', () => {
    const good = { kind: 'menu', url: 'https://web.test/m/stg-onb-1', svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>', png: PNG };
    assert.deepEqual(menuQrProblems(good, 'stg-onb-1'), []);
    assert.deepEqual(menuQrProblems({ ...good, url: 'https://web.test/t/abc' }, 'stg-onb-1'), ['opens /t/abc, not /m/stg-onb-1', 'url is an ordering (table/venue) link']);
    assert.deepEqual(menuQrProblems({ ...good, kind: 'table', png: 'data:image/png;base64,AAAA' }, 'stg-onb-1'), ['kind table', 'no PNG data URL']);
    assert.deepEqual(menuQrProblems(null, 'x'), ['no QR payload']);
    assert.equal(pngBytes(PNG).length, 70);
    assert.equal(pngBytes('data:image/png;base64,R0lGODlhAQABAAAAACw='), null);
  });

  it('spots tokens and secrets in public responses', () => {
    assert.deepEqual(leaks('{"name":"Menu","priceMinor":100}'), []);
    assert.equal(leaks('{"qrToken":"abc"}').length, 1);
    assert.equal(leaks('{"key":"rmcp_abcdef"}').length, 1);
  });

  it('counts repeated audit actions', () => {
    assert.deepEqual(missingInOrder(['a', 'b', 'b', 'c'], ['a', 'b', 'b']), []);
    assert.deepEqual(missingInOrder(['a', 'b', 'c'], ['a', 'b', 'b', 'd']), ['b', 'd']);
  });

  it('redacts keys, JWTs and Supabase keys from printed details', () => {
    assert.equal(redact('key rmcp_ABCdef123_x ok'), 'key rmcp_… ok');
    assert.equal(redact('Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig'), 'Bearer <jwt>');
    assert.equal(redact('sb_secret_abc123 and sb_publishable_xyz'), 'sb_secret_… and sb_publishable_…');
  });
});
