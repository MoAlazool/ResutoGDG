import { createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACCEPTANCE_CHECKS } from './registry';
import { runAcceptance } from './index';

const payments = () => ACCEPTANCE_CHECKS.filter((c) => ['stripe', 'paymob', 'moyasar'].includes(c.provider));

describe('payment provider acceptance checks (INT-15)', () => {
  it('registers auth, checkout, webhook signature, status query and refund checks for each provider', () => {
    for (const provider of ['stripe', 'paymob', 'moyasar']) {
      const caps = new Set(payments().filter((c) => c.provider === provider).map((c) => c.capability));
      expect([...caps].sort()).toEqual(['checkout', 'health_check', 'refunds', 'status_query', 'webhooks']);
    }
    for (const c of payments()) {
      expect(c.requires.length).toBeGreaterThan(0);
      expect(c.requires.every((r) => /^[A-Z][A-Z0-9_]+$/.test(r))).toBe(true);
      expect(c.modes).toEqual(['official_test']); // nothing here runs against live money
      expect(['read', 'write_test']).toContain(c.effect);
      if (c.capability === 'refunds' || c.capability === 'checkout') expect(c.effect).toBe('write_test');
    }
  });

  it('reports not_run with the missing variable names when no credentials are configured', async () => {
    const results = await runAcceptance(payments(), { mode: 'official_test', env: {}, fetch: (async () => { throw new Error('must not be called'); }) as any });
    expect(results.length).toBe(payments().length);
    expect(results.every((r) => r.status === 'not_run' && /^not configured: /.test(r.reason ?? ''))).toBe(true);
    const live = await runAcceptance(payments(), { mode: 'live', env: {}, allowLive: true });
    expect(live.every((r) => r.status === 'not_run')).toBe(true);
  });

  it('runs a configured check end to end (scripted transport) and never records the key', async () => {
    const fetch = (async (url: string) => {
      expect(String(url)).toBe('https://api.stripe.com/v1/account');
      return new Response(JSON.stringify({ id: 'acct_x', country: 'AE', charges_enabled: true }), { status: 200 });
    }) as any;
    const [r] = await runAcceptance(payments().filter((c) => c.id === 'stripe.account'), {
      mode: 'official_test', env: { STRIPE_TEST_SECRET_KEY: 'sk_test_secretvalue123', STRIPE_TEST_WEBHOOK_SECRET: 'whsec_secretvalue123' }, fetch });
    expect(r.status).toBe('passed');
    expect(JSON.stringify(r)).not.toContain('secretvalue123');
  });

  it('verifies a captured provider event with the merchant secret (documented scheme computed independently)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'acc-'));
    const raw = '{"id":"evt_1","type":"checkout.session.completed","livemode":false,"data":{"object":{"id":"cs_test_1","amount_total":100,"currency":"usd","payment_status":"paid"}}}';
    writeFileSync(path.join(dir, 'event.json'), raw);
    const t = 1_760_000_000;
    const sig = `t=${t},v1=${createHmac('sha256', 'whsec_acc').update(`${t}.${raw}`).digest('hex')}`;
    const [r] = await runAcceptance(payments().filter((c) => c.id === 'stripe.webhook_signature'), {
      mode: 'official_test', env: { STRIPE_TEST_WEBHOOK_SECRET: 'whsec_acc', STRIPE_TEST_EVENT_FILE: path.join(dir, 'event.json'), STRIPE_TEST_EVENT_SIGNATURE: sig } });
    expect(r.status, r.reason).toBe('passed');
    const [bad] = await runAcceptance(payments().filter((c) => c.id === 'stripe.webhook_signature'), {
      mode: 'official_test', env: { STRIPE_TEST_WEBHOOK_SECRET: 'whsec_other', STRIPE_TEST_EVENT_FILE: path.join(dir, 'event.json'), STRIPE_TEST_EVENT_SIGNATURE: sig } });
    expect(bad.status).toBe('failed');
  });
});
