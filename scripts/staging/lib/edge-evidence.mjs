// Evidence for failed requests in the staging browser check (audit DF-12): which hop answered a 5xx or broke a
// request — the Vercel edge (x-vercel-id, x-vercel-cache, x-vercel-error), the origin (x-build, x-request-id) or a
// proxy in between (via, a server header that is not Vercel's). Pure: no network, no secrets (query strings and
// fragments are dropped from URLs; only allow-listed headers are kept).

export const EVIDENCE_HEADERS = ['server', 'via', 'x-vercel-id', 'x-vercel-cache', 'x-vercel-error', 'age', 'content-type', 'x-build', 'x-request-id', 'cache-control'];

/** Path of a URL without query or fragment (guest and payment tokens can live in queries). */
export function safePath(url) {
  try { const u = new URL(url); return `${u.origin}${u.pathname}`; } catch { return String(url).split(/[?#]/)[0]; }
}

/** Keeps the allow-listed headers (lower-cased names) of a response. */
export function pickHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) if (EVIDENCE_HEADERS.includes(k.toLowerCase())) out[k.toLowerCase()] = String(v).slice(0, 200);
  return out;
}

/** Which hop most likely produced the response, from its headers. */
export function attribute(h = {}) {
  if (h['x-vercel-error']) return `vercel-edge (${h['x-vercel-error']})`;
  if (h['x-vercel-id'] && /vercel/i.test(h.server ?? '')) return h['x-build'] ? 'origin-via-vercel' : 'vercel-edge';
  if (h['x-build'] || h['x-request-id']) return 'origin';
  if (h.via || (h.server && !/vercel|render|cloudflare/i.test(h.server))) return 'proxy';
  return 'unknown';
}

/** One evidence record for a response with status >= 500. */
export function responseEvidence({ url, status, method, resourceType, headers }) {
  const h = pickHeaders(headers);
  return { kind: 'response', status, method, resourceType, url: safePath(url), headers: h, hop: attribute(h) };
}

/** One evidence record for a request that failed without a response (reset, TLS, DNS, aborted). */
export function failureEvidence({ url, method, resourceType, failure }) {
  return { kind: 'requestfailed', method, resourceType, url: safePath(url), failure: String(failure ?? 'unknown').slice(0, 200), hop: 'no-response' };
}

/** Summary across page loads: counts per hop and per URL, and whether this run went through an egress proxy. */
export function summarize(records, env = {}) {
  const byHop = {}, byUrl = {};
  for (const r of records) {
    byHop[r.hop] = (byHop[r.hop] ?? 0) + 1;
    byUrl[r.url] = (byUrl[r.url] ?? 0) + 1;
  }
  return { total: records.length, proxied: !!(env.HTTPS_PROXY || env.https_proxy), byHop, byUrl, vercelIds: [...new Set(records.map((r) => r.headers?.['x-vercel-id']).filter(Boolean))] };
}
