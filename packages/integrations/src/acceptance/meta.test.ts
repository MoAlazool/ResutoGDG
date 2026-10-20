import { describe, expect, it } from 'vitest';
import { runAcceptance } from './index';
import { ACCEPTANCE_CHECKS } from './registry';

const meta = () => ACCEPTANCE_CHECKS.filter((c) => ['meta', 'whatsapp_cloud', 'meta_pages', 'meta_ads', 'meta_capi'].includes(c.provider));

describe('Meta acceptance checks (ws7a)', () => {
  it('covers ownership, signatures, sending, ads and the Conversions API; message and spend checks are gated', () => {
    expect(meta().map((c) => c.id).sort()).toEqual([
      'meta.graph_version', 'meta_ads.ad_accounts', 'meta_ads.campaign_create_paused', 'meta_capi.health', 'meta_capi.test_event',
      'meta_pages.ownership', 'meta_pages.send_reply', 'meta_pages.webhook_signature', 'whatsapp.ownership', 'whatsapp.send_template', 'whatsapp.webhook_signature',
    ]);
    for (const c of meta()) {
      expect(c.requires.every((r) => /^[A-Z][A-Z0-9_]+$/.test(r))).toBe(true);
      expect(c.docsUrl).toMatch(/^https:\/\/developers\.facebook\.com\//);
    }
    const effect = Object.fromEntries(meta().map((c) => [c.id, c.effect]));
    expect(effect['whatsapp.send_template']).toBe('message');
    expect(effect['meta_pages.send_reply']).toBe('message');
    expect(effect['meta_ads.campaign_create_paused']).toBe('spend');
    // Writing checks never run live.
    for (const c of meta().filter((x) => x.effect !== 'read')) expect(c.modes).toEqual(['official_test']);
  });

  it('without credentials nothing is called and every check reports not_run; message/spend checks are blocked without --allow', async () => {
    const fetch = (async () => { throw new Error('must not be called'); }) as any;
    const results = await runAcceptance(meta(), { mode: 'official_test', env: {}, fetch });
    const by = Object.fromEntries(results.map((r) => [r.id, r]));
    expect(by['whatsapp.send_template']!.status).toBe('blocked');
    expect(by['meta_ads.campaign_create_paused']!.status).toBe('blocked');
    expect(results.filter((r) => r.status !== 'blocked').every((r) => r.status === 'not_run' && /^not configured: /.test(r.reason ?? ''))).toBe(true);
  });
});
