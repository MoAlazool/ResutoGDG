import { describe, expect, it } from 'vitest';
import { odooAccountingAdapter, type JournalEntry } from './accounting';
import { odooAdapter } from './pos/odoo';
import { assertEgressAllowed, EgressBlockedError, egressFetch, isPublicAddress, withEgressResolver, type HostResolver } from './net';

// Audit INT-02: Odoo POS / Odoo Accounting take their base URL from the tenant. Before the guard, a connection
// pointing at https://169.254.169.254/ (or localhost, a private network) was called and the response body came back
// in the connection's last_error.

const publicDns: HostResolver = async () => [{ address: '93.184.215.14', family: 4 }];
const dns = (map: Record<string, string[]>): HostResolver => async (host) => {
  const a = map[host];
  if (!a) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
  return a.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};
const opts = (resolve: HostResolver = publicDns) => ({ provider: 'odoo', resolve });

describe('isPublicAddress', () => {
  it.each([
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.1',
    '192.0.2.1', '192.168.1.1', '198.18.0.1', '198.51.100.1', '203.0.113.9', '224.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:a9fe:a9fe', '::127.0.0.1', '64:ff9b::a00:1', '2002:c0a8:101::1',
    'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%eth0', 'ff02::1', '2001:db8::1', '2001::1', '100::1', 'not-an-ip',
  ])('%s is not public', (ip) => expect(isPublicAddress(ip)).toBe(false));

  it.each(['8.8.8.8', '1.1.1.1', '93.184.215.14', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '2a00:1450:4001::200e', '::ffff:8.8.8.8', '64:ff9b::808:808'])(
    '%s is public', (ip) => expect(isPublicAddress(ip)).toBe(true));
});

describe('assertEgressAllowed', () => {
  it.each([
    ['http://erp.example.com/', /HTTPS only/],
    ['https://erp.example.com:8069/', /port 8069/],
    ['https://user:pw@erp.example.com/', /credentials/],
    ['https://localhost/', /local host name/],
    ['https://odoo.internal/', /local host name/],
    ['https://metadata.google.internal/', /local host name/],
    ['https://intranet/', /local host name/],
    ['https://169.254.169.254/latest/meta-data', /private or reserved/],
    ['https://2130706433/', /private or reserved/], // decimal 127.0.0.1
    ['https://0x7f.1/', /private or reserved/],
    ['https://[::1]/', /private or reserved/],
    ['https://[::ffff:10.0.0.1]/', /private or reserved/],
    ['https://[fd00::1]/', /private or reserved/],
  ])('refuses %s', async (url, reason) => {
    const err = await assertEgressAllowed(url, opts()).catch((e) => e);
    expect(err).toBeInstanceOf(EgressBlockedError);
    expect(err.message).toMatch(reason);
    expect(err.retryable).toBe(false);
  });

  it('refuses a public-looking name that resolves (even partly) to a private address', async () => {
    const resolve = dns({ 'rebind.example.com': ['93.184.215.14', '10.0.0.5'], 'meta.example.com': ['169.254.169.254'] });
    await expect(assertEgressAllowed('https://rebind.example.com/', opts(resolve))).rejects.toThrow(/resolves to a private/);
    await expect(assertEgressAllowed('https://meta.example.com/', opts(resolve))).rejects.toThrow(/resolves to a private/);
  });

  it('allows a public HTTPS host and reports unresolvable names as retryable', async () => {
    expect((await assertEgressAllowed('https://acme.odoo.com/jsonrpc', opts())).hostname).toBe('acme.odoo.com');
    expect((await assertEgressAllowed('https://8.8.8.8/', opts())).hostname).toBe('8.8.8.8');
    const err = await assertEgressAllowed('https://gone.example.com/', opts(dns({}))).catch((e) => e);
    expect(err).not.toBeInstanceOf(EgressBlockedError);
    expect(err.retryable).toBe(true);
  });
});

describe('egressFetch', () => {
  const recorder = (responses: Array<{ status: number; headers?: Record<string, string>; body?: string }>) => {
    const calls: Array<{ url: string; method: string; redirect?: string; body?: unknown }> = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), method: init.method ?? 'GET', redirect: init.redirect, body: init.body });
      const r = responses.shift()!;
      return new Response(r.body ?? '', { status: r.status, headers: r.headers });
    }) as unknown as typeof fetch;
    return { f, calls };
  };

  it('re-checks every redirect target and never follows one into a private network', async () => {
    const { f, calls } = recorder([{ status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data/' } }, { status: 200, body: 'secret' }]);
    await expect(egressFetch(f, opts())('https://erp.example.com/', { method: 'GET' })).rejects.toThrow(EgressBlockedError);
    expect(calls).toEqual([{ url: 'https://erp.example.com/', method: 'GET', redirect: 'manual', body: undefined }]);
  });

  it('follows public redirects (303 switches to GET), up to a limit', async () => {
    const ok = recorder([{ status: 303, headers: { location: '/next' } }, { status: 200, body: '{"ok":true}' }]);
    const res = await egressFetch(ok.f, opts())('https://erp.example.com/start', { method: 'POST', body: '{}' });
    expect(await res.json()).toEqual({ ok: true });
    expect(ok.calls.map((c) => [c.url, c.method, c.body])).toEqual([['https://erp.example.com/start', 'POST', '{}'], ['https://erp.example.com/next', 'GET', undefined]]);
    const loop = recorder(Array.from({ length: 6 }, () => ({ status: 301, headers: { location: 'https://erp.example.com/again' } })));
    await expect(egressFetch(loop.f, opts())('https://erp.example.com/', {})).rejects.toThrow(/too many redirects/);
    expect(loop.calls).toHaveLength(4);
  });

  it('caps the response size', async () => {
    const big = recorder([{ status: 200, body: 'x'.repeat(2048) }]);
    await expect(egressFetch(big.f, { ...opts(), maxResponseBytes: 1024 })('https://erp.example.com/', {})).rejects.toThrow(/too large/);
  });
});

describe('Odoo adapters with a tenant-supplied URL', () => {
  const leaky = () => {
    const calls: string[] = [];
    const f = withEgressResolver((async (url: string) => {
      calls.push(String(url));
      return new Response('{"internal":"secret-data"}', { status: 500 });
    }) as unknown as typeof fetch, dns({ 'erp.example.com': ['93.184.215.14'], 'rebind.example.com': ['10.0.0.8'] }));
    return { f, calls };
  };
  const entry: JournalEntry = { reference: 'r', date: '2026-10-01', currency: 'EGP', memo: 'm',
    lines: [{ role: 'cash', description: 'c', debitMinor: 1, creditMinor: 0 }, { role: 'sales', description: 's', debitMinor: 0, creditMinor: 1 }] };

  it.each(['https://169.254.169.254', 'https://127.0.0.1', 'https://[::ffff:10.0.0.1]', 'https://metadata.google.internal', 'https://rebind.example.com'])(
    'never calls %s', async (url) => {
      const { f, calls } = leaky();
      const pos = await odooAdapter.healthCheck({ environment: 'live', credentials: { apiKey: 'k' }, config: { url }, fetch: f }).catch((e) => e);
      const acct = await odooAccountingAdapter.pushJournalEntry({ environment: 'live', credentials: { url, db: 'd', login: 'l', apiKey: 'k' },
        config: { uid: 1, journalId: 1, accounts: { cash: 1, sales: 2 } }, fetch: f }, entry).catch((e) => e);
      expect(calls).toEqual([]);
      for (const e of [pos, acct]) {
        expect(e).toBeInstanceOf(EgressBlockedError);
        expect(e.message).not.toContain('secret');
      }
    });

  it('does not reflect a public server\'s response body into the error', async () => {
    const { f, calls } = leaky();
    const pos = await odooAdapter.healthCheck({ environment: 'live', credentials: { apiKey: 'k' }, config: { url: 'https://erp.example.com' }, fetch: f }).catch((e) => e);
    expect(calls.length).toBeGreaterThan(0);
    expect(pos.message).toBe('odoo: HTTP 500');
    expect(pos.retryable).toBe(true);
    const rpc = withEgressResolver((async () => new Response(JSON.stringify({ error: { message: 'Odoo Server Error', data: { name: 'odoo.exceptions.AccessDenied', message: 'internal path /srv/odoo leaked' } } }), { status: 200 })) as unknown as typeof fetch, publicDns);
    const acct = await odooAccountingAdapter.pushJournalEntry({ environment: 'live', credentials: { url: 'https://erp.example.com', db: 'd', login: 'l', apiKey: 'k' },
      config: { uid: 1, journalId: 1, accounts: { cash: 1, sales: 2 } }, fetch: rpc }, entry).catch((e) => e);
    expect(acct.message).toBe('odoo_accounting: Odoo rejected the request (AccessDenied)');
  });
});

describe('guardedProviderCall', () => {
  it('reports a redirect into a private network as blocked (not a retryable network error)', async () => {
    const f = withEgressResolver((async () => new Response('', { status: 307, headers: { location: 'https://10.0.0.7/admin' } })) as unknown as typeof fetch, publicDns);
    const err = await odooAdapter.healthCheck({ environment: 'live', credentials: { apiKey: 'k' }, config: { url: 'https://erp.example.com' }, fetch: f }).catch((e) => e);
    expect(err).toBeInstanceOf(EgressBlockedError);
    expect(err.retryable).toBe(false);
  });
});
