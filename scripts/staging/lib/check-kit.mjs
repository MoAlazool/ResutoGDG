// Shared pieces of the staging flow checks (eid-check.mjs, onboarding-check.mjs): result rows with an honest
// "blocked" state, the exit code, build identity, an HTTP helper, the two auth modes (local dev issuer or Supabase
// Auth), the optional TOTP step-up, a raw Streamable-HTTP MCP client, and pure validators for what the checks read
// back. Everything exported above the "I/O" line is pure and unit-tested in scripts/staging/test/check-kit.test.mjs.
import { createHmac, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

// ---------------------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------------------

/** 0 when every row passed, 1 when any row failed, 3 when nothing failed but a step could not run (blocked). */
export function exitCodeFor(results) {
  if (results.some((r) => r.status === 'fail')) return 1;
  if (results.some((r) => r.status === 'blocked')) return 3;
  return 0;
}

/** Whether a service's reported commit is the expected one (either may be abbreviated). */
export function commitMatches(commit, want) {
  if (!commit || !want) return false;
  const a = String(commit).trim().toLowerCase();
  const b = String(want).trim().toLowerCase();
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * These checks write data. They run against loopback (the local stack) or a host that names itself staging; anything
 * else (production, a typo) is refused unless ALLOW_NON_STAGING=1 says the operator meant it.
 */
export function targetProblem(url, allowOther = false) {
  let u;
  try { u = new URL(url); } catch { return `not a URL: ${url}`; }
  if (['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname)) return null;
  if (/staging|stg/i.test(u.hostname) || allowOther) return null;
  return `${u.hostname} does not look like staging or a local stack (set ALLOW_NON_STAGING=1 to override)`;
}

/** A Streamable-HTTP response body: plain JSON, or SSE `data:` lines holding one JSON-RPC message. */
export function parseMcpBody(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  if (t.startsWith('{') || t.startsWith('[')) return JSON.parse(t);
  const data = t.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean);
  if (!data.length) return null;
  return JSON.parse(data[data.length - 1]);
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Decode(s) {
  const clean = String(s).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits), as Supabase Auth's authenticator factors use. */
export function totp(secretBase32, timeMs = Date.now(), { step = 30, digits = 6 } = {}) {
  const counter = Math.floor(timeMs / 1000 / step);
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const h = createHmac('sha1', base32Decode(secretBase32)).update(msg).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/**
 * Names for throwaway data: `<prefix>-<yyyymmddhhmm>-<4 hex>` (a valid restaurant address: lowercase, digits and
 * dashes, at most 48 characters), so every leftover is found with `slug like '<prefix>-%'` and dated.
 */
export function throwawayId(prefix, date = new Date(), rand = randomBytes(2).toString('hex')) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}`;
  const id = `${prefix}-${stamp}-${rand}`.toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/.test(id)) throw new Error(`throwaway id ${id} is not a valid web address`);
  return id;
}

/** The price guests pay after a percent discount (basis points): the API's own rounding (menu.service discountedPrice). */
export const discountedPrice = (originalMinor, bps) => Math.max(1, Math.round((originalMinor * (10000 - bps)) / 10000));

/** Visible markup only: scripts (the RSC payload), styles and comments removed. */
export const visibleHtml = (html) => String(html ?? '')
  .replace(/<script\b[\s\S]*?<\/script>/gi, '')
  .replace(/<style\b[\s\S]*?<\/style>/gi, '')
  .replace(/<!--[\s\S]*?-->/g, '');

/**
 * Ordering UI on a rendered guest page: the markers the view-only menu's own test forbids (Add / stepper / cart dock
 * classes, an "Add" button, checkout, the ordering assistant) plus links into the ordering routes. Empty = view-only.
 */
export function orderingUiMarkers(html) {
  const v = visibleHtml(html);
  const found = [];
  for (const cls of ['gx-add', 'gx-stepper', 'gx-dock']) if (new RegExp(`class="[^"]*\\b${cls}\\b`).test(v)) found.push(cls);
  if (/>\s*\+?\s*Add\s*</.test(v)) found.push('Add button');
  if (/checkout/i.test(v)) found.push('checkout');
  if (/Help me choose/i.test(v)) found.push('ordering assistant');
  if (/href="[^"]*\/(t|v|order)\/[^"]*"/.test(v)) found.push('link to an ordering route');
  return found;
}

/** What is wrong with a view-only menu QR (GET /o/:orgId/menu-qr) for `slug`; empty when it is right. */
export function menuQrProblems(qr, slug) {
  const p = [];
  if (!qr || typeof qr !== 'object') return ['no QR payload'];
  if (qr.kind !== 'menu') p.push(`kind ${qr.kind}`);
  let path = '';
  try { path = new URL(qr.url).pathname; } catch { p.push(`url ${qr.url} is not absolute`); }
  if (path && path !== `/m/${slug}`) p.push(`opens ${path}, not /m/${slug}`);
  if (/\/t\/|\/v\//.test(String(qr.url))) p.push('url is an ordering (table/venue) link');
  if (typeof qr.svg !== 'string' || !qr.svg.includes('<svg')) p.push('no SVG');
  else if (/\/t\/|\/v\//.test(qr.svg)) p.push('SVG holds an ordering link');
  const png = pngBytes(qr.png);
  if (!png) p.push('no PNG data URL');
  return p;
}

/** The bytes of a `data:image/png;base64,` URL when they really are a PNG (signature), else null. */
export function pngBytes(dataUrl) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/]+=*)$/.exec(String(dataUrl ?? ''));
  if (!m) return null;
  const b = Buffer.from(m[1], 'base64');
  return b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? b : null;
}

/** Capability tokens or secrets that must never appear in a public response. */
const LEAKS = [/sb_secret_/i, /service_role/i, /encrypted_password/, /postgres(ql)?:\/\//i, /"qrToken"|qr_token/i, /sessionToken|visitToken/i, /rmcp_[A-Za-z0-9]/];
export const leaks = (text) => LEAKS.filter((re) => re.test(String(text ?? ''))).map(String);

/** Missing entries of `expected` in `actual`, counting repeats (audit actions may legitimately repeat). */
export function missingInOrder(actual, expected) {
  const pool = [...actual];
  const missing = [];
  for (const e of expected) {
    const i = pool.indexOf(e);
    if (i < 0) missing.push(e); else pool.splice(i, 1);
  }
  return missing;
}

/** Replaces anything that looks like a credential in a detail string before it is printed. */
export const redact = (s) => String(s ?? '')
  .replace(/rmcp_[A-Za-z0-9_-]+/g, 'rmcp_…')
  .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, '<jwt>')
  .replace(/sb_(secret|publishable)_[A-Za-z0-9_-]+/g, 'sb_$1_…');

// ---------------------------------------------------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------------------------------------------------

/** Result rows: ✓ pass, ✗ fail, ⊘ blocked (could not run here, with the reason), · notes. */
export function createReport(title) {
  const results = [];
  const builds = {};
  const notes = [];
  console.log(`${title}\n`);
  return {
    results, builds, notes,
    check(name, ok, detail = '') {
      results.push({ name, status: ok ? 'pass' : 'fail', detail: redact(detail) });
      console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${redact(detail)}` : ''}`);
      return !!ok;
    },
    blocked(name, reason) {
      results.push({ name, status: 'blocked', detail: redact(reason) });
      console.log(`⊘ ${name} — BLOCKED: ${redact(reason)}`);
    },
    note(text) {
      notes.push(redact(text));
      console.log(`· ${redact(text)}`);
    },
    recordBuild(service, r) {
      const b = r?.body?.build ?? {};
      builds[service] = { commit: b.commit ?? null, builtAt: b.builtAt ?? null, header: r?.headers?.get?.('x-build') ?? null, http: r?.status ?? null };
    },
    finish(env = process.env, extra = {}) {
      if (Object.keys(builds).length) {
        console.log('\nDeployed builds:');
        for (const [s, b] of Object.entries(builds)) console.log(`  ${s.padEnd(4)} commit ${b.commit ?? 'unknown'}  built ${b.builtAt ?? 'unknown'}  X-Build ${b.header ?? '-'}`);
        if (env.EXPECT_COMMIT) {
          for (const [s, b] of Object.entries(builds)) this.check(`${s} runs the expected commit ${env.EXPECT_COMMIT.trim().slice(0, 12)}`, commitMatches(b.commit, env.EXPECT_COMMIT), b.commit ?? 'unknown');
        }
      }
      const by = (s) => results.filter((r) => r.status === s).length;
      console.log(`\n${by('pass')}/${results.length} checks passed${by('fail') ? `, ${by('fail')} failed` : ''}${by('blocked') ? `, ${by('blocked')} blocked` : ''}`);
      if (env.SMOKE_REPORT) writeFileSync(env.SMOKE_REPORT, `${JSON.stringify({ at: new Date().toISOString(), title, builds, results, notes, ...extra }, null, 2)}\n`);
      process.exit(exitCodeFor(results));
    },
  };
}

/** fetch with JSON in and out; never throws on HTTP status (network errors become status 0). */
export async function req(method, url, { token, body, headers = {}, raw, timeoutMs = 90_000 } = {}) {
  try {
    const res = await fetch(url, {
      method, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, body: json, text, headers: res.headers };
  } catch (e) {
    return { status: 0, body: null, text: String(e?.message ?? e), headers: new Headers() };
  }
}

export const errCode = (r) => r?.body?.error?.code ?? null;
export const brief = (r) => `HTTP ${r.status}${errCode(r) ? ` ${errCode(r)}` : ''}`;

/**
 * The two ways a check signs people in:
 *  - local:    the API's development issuer (/v1/auth/dev/*, AUTH_DEV_MODE=true; never enabled on staging);
 *  - supabase: Supabase Auth with the publishable key (password grant, signup), plus the Admin Auth API only when
 *              SUPABASE_SERVICE_ROLE_KEY is set (create a confirmed throwaway user, delete it afterwards).
 */
export function makeAuth(env, apiBase) {
  const mode = env.AUTH_MODE === 'local' ? 'local' : 'supabase';
  if (mode === 'local') {
    return {
      mode, hasAdmin: false,
      async signIn(email, password) {
        const r = await req('POST', `${apiBase}/auth/dev/login`, { body: { email, password } });
        return r.status === 200 ? { accessToken: r.body.accessToken, aal: 'aal1' } : null;
      },
      async signUp(email, password, fullName) {
        const r = await req('POST', `${apiBase}/auth/dev/signup`, { body: { email, password, fullName } });
        if (r.status === 200 || r.status === 201) return { session: { accessToken: r.body.accessToken, aal: 'aal1' }, via: 'development issuer (/v1/auth/dev/signup)' };
        return { session: null, error: brief(r) };
      },
      async stepUp() { return null; },
      async disableUser() { return { ok: false, reason: 'the local development issuer has no account lifecycle API' }; },
    };
  }
  const SB = String(env.SUPABASE_URL ?? '').replace(/\/$/, '');
  const pub = { apikey: env.SUPABASE_PUBLISHABLE_KEY };
  const admin = env.SUPABASE_SERVICE_ROLE_KEY ? { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } : null;
  const aalOf = (jwt) => { try { return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()).aal ?? 'aal1'; } catch { return 'aal1'; } };
  const session = (b) => (b?.access_token ? { accessToken: b.access_token, refreshToken: b.refresh_token, userId: b.user?.id ?? null, aal: aalOf(b.access_token) } : null);
  return {
    mode, hasAdmin: !!admin,
    async signIn(email, password) {
      const r = await req('POST', `${SB}/auth/v1/token?grant_type=password`, { headers: pub, body: { email, password } });
      return r.status === 200 ? session(r.body) : null;
    },
    /**
     * Public signup first (what a restaurant owner does). With "Confirm email" on, Supabase returns no session (or
     * refuses an address the built-in sender may not mail); only then, and only with the service-role key, the
     * Admin Auth API creates the same account already confirmed. Without the key the caller reports "blocked".
     */
    async signUp(email, password, fullName) {
      const r = await req('POST', `${SB}/auth/v1/signup`, { headers: pub, body: { email, password, data: { full_name: fullName } } });
      const s = session(r.body);
      if (s) return { session: s, via: 'Supabase public signup (email confirmation off)' };
      const why = r.status === 200 ? 'Supabase requires email confirmation (signup returned no session)' : `Supabase signup refused: ${brief(r)} ${r.body?.msg ?? r.body?.message ?? ''}`.trim();
      if (!admin) return { session: null, error: why };
      const existing = r.status === 200 ? (r.body?.id ?? r.body?.user?.id ?? null) : null;
      const made = existing
        ? await req('PUT', `${SB}/auth/v1/admin/users/${existing}`, { headers: admin, body: { email_confirm: true } })
        : await req('POST', `${SB}/auth/v1/admin/users`, { headers: admin, body: { email, password, email_confirm: true, user_metadata: { full_name: fullName } } });
      if (made.status >= 300) return { session: null, error: `${why}; admin create failed: ${brief(made)}` };
      const signed = await this.signIn(email, password);
      return signed ? { session: signed, via: `Supabase Admin Auth API, confirmed by the check (${why})` } : { session: null, error: `${why}; admin-created user cannot sign in` };
    },
    /** aal2 through a verified TOTP factor, when the account has one and STAGING_CHECK_TOTP_SECRET is set. */
    async stepUp(s, secret) {
      if (!secret) return null;
      const auth = { ...pub, Authorization: `Bearer ${s.accessToken}` };
      const u = await req('GET', `${SB}/auth/v1/user`, { headers: auth });
      const f = (u.body?.factors ?? []).find((x) => x.factor_type === 'totp' && x.status === 'verified');
      if (!f) return null;
      const ch = await req('POST', `${SB}/auth/v1/factors/${f.id}/challenge`, { headers: auth, body: {} });
      if (!ch.body?.id) return null;
      const v = await req('POST', `${SB}/auth/v1/factors/${f.id}/verify`, { headers: auth, body: { challenge_id: ch.body.id, code: totp(secret) } });
      return session(v.body);
    },
    /**
     * Bans the throwaway account for ten years and clears its name (Admin Auth API). Not a delete: the restaurant rows
     * it created still reference the user (created_by and similar keys without ON DELETE), so a delete would fail.
     */
    async disableUser(userId) {
      if (!admin) return { ok: false, reason: 'SUPABASE_SERVICE_ROLE_KEY not set (no admin path)' };
      if (!userId) return { ok: false, reason: 'user id unknown' };
      const r = await req('PUT', `${SB}/auth/v1/admin/users/${userId}`, { headers: admin, body: { ban_duration: '87600h', user_metadata: { full_name: null } } });
      return r.status < 300 ? { ok: true } : { ok: false, reason: brief(r) };
    },
  };
}

/** A raw Streamable-HTTP MCP client (no SDK dependency): initialize, tools/list, tools/call, close. */
export function mcpClient(url, key, { protocolVersion = '2025-06-18', name = 'resuto-staging-check' } = {}) {
  let session = null;
  let id = 0;
  const headers = () => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    ...(session ? { 'mcp-session-id': session, 'mcp-protocol-version': protocolVersion } : {}) });
  async function rpc(method, params, notify = false) {
    const res = await fetch(url, { method: 'POST', headers: headers(), signal: AbortSignal.timeout(90_000),
      body: JSON.stringify(notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++id, method, params }) });
    session = res.headers.get('mcp-session-id') ?? session;
    const text = await res.text();
    let body = null;
    try { body = parseMcpBody(text); } catch { body = null; }
    return { status: res.status, body };
  }
  return {
    get sessionId() { return session; },
    async initialize() {
      const r = await rpc('initialize', { protocolVersion, capabilities: {}, clientInfo: { name, version: '1.0' } });
      if (r.status === 200) await rpc('notifications/initialized', undefined, true);
      return r;
    },
    listTools: () => rpc('tools/list', {}),
    async call(tool, args) {
      const r = await rpc('tools/call', { name: tool, arguments: args });
      const result = r.body?.result ?? null;
      return { status: r.status, error: r.body?.error ?? null, isError: !!result?.isError, out: result?.structuredContent ?? null,
        text: result?.content?.map((c) => c.text).join(' ') ?? '' };
    },
    async close() {
      if (!session) return 0;
      const res = await fetch(url, { method: 'DELETE', headers: headers() }).catch(() => null);
      return res?.status ?? 0;
    },
  };
}
