// node --test scripts/staging/test/*.test.mjs  (DF-12: the browser check recorded no headers for the 502s it saw)
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { attribute, failureEvidence, pickHeaders, responseEvidence, safePath, summarize } from '../lib/edge-evidence.mjs';

describe('staging edge evidence', () => {
  it('keeps only the allow-listed headers and drops queries from URLs', () => {
    assert.deepEqual(pickHeaders({ Server: 'Vercel', 'X-Vercel-Id': 'iad1::abc', 'Set-Cookie': 'secret', Authorization: 'Bearer x' }), { server: 'Vercel', 'x-vercel-id': 'iad1::abc' });
    assert.equal(safePath('https://web.example/_next/static/chunks/a.js?dpl=dpl_123#x'), 'https://web.example/_next/static/chunks/a.js');
  });

  it('attributes a response to the edge, the origin or a proxy', () => {
    assert.equal(attribute({ server: 'Vercel', 'x-vercel-id': 'fra1::x', 'x-vercel-error': 'EDGE_FUNCTION_INVOCATION_FAILED' }), 'vercel-edge (EDGE_FUNCTION_INVOCATION_FAILED)');
    assert.equal(attribute({ server: 'Vercel', 'x-vercel-id': 'fra1::x', 'x-vercel-cache': 'MISS' }), 'vercel-edge');
    assert.equal(attribute({ 'x-build': 'api@abc', 'x-request-id': 'r' }), 'origin');
    assert.equal(attribute({ server: 'envoy', via: '1.1 egress' }), 'proxy');
    assert.equal(attribute({}), 'unknown');
  });

  it('records 5xx responses and failed requests and summarizes them per hop', () => {
    const a = responseEvidence({ url: 'https://w/_next/static/chunks/4187.js?x=1', status: 502, method: 'GET', resourceType: 'script', headers: { server: 'Vercel', 'x-vercel-id': 'iad1::1', 'content-type': 'text/plain' } });
    const b = failureEvidence({ url: 'https://w/_next/static/chunks/9.js', method: 'GET', resourceType: 'script', failure: 'net::ERR_CONNECTION_RESET' });
    assert.equal(a.url, 'https://w/_next/static/chunks/4187.js');
    assert.equal(a.headers['content-type'], 'text/plain');
    const s = summarize([a, b, a], { HTTPS_PROXY: 'http://proxy' });
    assert.deepEqual(s.byHop, { 'vercel-edge': 2, 'no-response': 1 });
    assert.equal(s.proxied, true);
    assert.deepEqual(s.vercelIds, ['iad1::1']);
  });
});
