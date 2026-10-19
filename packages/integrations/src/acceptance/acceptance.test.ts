import { describe, expect, it } from 'vitest';
import { redact, runAcceptance, type AcceptanceCheck } from './index';

const check = (over: Partial<AcceptanceCheck> = {}): AcceptanceCheck => ({
  id: 'demo.read', provider: 'demo', capability: 'auth', modes: ['official_test', 'live'], requires: ['DEMO_KEY'], effect: 'read',
  run: async (ctx) => { ctx.evidence('called with key DEMO-SECRET-123', { apiKey: ctx.env.DEMO_KEY, status: 200 }); },
  ...over,
});

describe('provider acceptance runner', () => {
  it('reports not_run with the missing variable names when credentials are not configured', async () => {
    const [r] = await runAcceptance([check()], { mode: 'official_test', env: {} });
    expect(r.status).toBe('not_run');
    expect(r.reason).toBe('not configured: DEMO_KEY');
  });

  it('runs configured checks and redacts credentials from evidence', async () => {
    const [r] = await runAcceptance([check()], { mode: 'official_test', env: { DEMO_KEY: 'DEMO-SECRET-123' } });
    expect(r.status).toBe('passed');
    expect(JSON.stringify(r.evidence)).not.toContain('DEMO-SECRET-123');
    expect(r.evidence[0].data).toEqual({ apiKey: '[redacted]', status: 200 });
  });

  it('blocks live mode without --allow-live and money-spending checks without an explicit allowance', async () => {
    const [live] = await runAcceptance([check()], { mode: 'live', env: { DEMO_KEY: 'x' } });
    expect(live.status).toBe('blocked');
    const [spend] = await runAcceptance([check({ effect: 'spend' })], { mode: 'official_test', env: { DEMO_KEY: 'x' } });
    expect(spend.status).toBe('blocked');
    const [ok] = await runAcceptance([check({ effect: 'spend' })], { mode: 'official_test', env: { DEMO_KEY: 'x' }, allow: ['spend'] });
    expect(ok.status).toBe('passed');
  });

  it('records failures with redacted reasons', async () => {
    const [r] = await runAcceptance([check({ run: async (ctx) => { throw new Error(`401 for ${ctx.env.DEMO_KEY}`); } })],
      { mode: 'official_test', env: { DEMO_KEY: 'DEMO-SECRET-123' } });
    expect(r.status).toBe('failed');
    expect(r.reason).toBe('401 for [redacted]');
  });

  it('redacts secret-looking keys recursively', () => {
    expect(redact({ a: { hmac: 'x', ok: 1 }, list: [{ token: 't' }] }, [])).toEqual({ a: { hmac: '[redacted]', ok: 1 }, list: [{ token: '[redacted]' }] });
  });
});
