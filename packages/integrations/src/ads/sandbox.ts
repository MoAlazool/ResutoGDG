// Sandbox ad account. Records campaign launches locally and NEVER calls an ad
// platform. Its insights are zero-valued rows (no delivery happens in a sandbox);
// Resuto stores them with is_sandbox=true and excludes them from cost/ROAS.
import { randomUUID } from 'node:crypto';
import type { ProviderDescriptor } from '../core';
import type { AdInsightRow, AdsAdapter } from './types';

export const adsSandboxDescriptor: ProviderDescriptor = {
  id: 'ads_sandbox',
  name: 'Ads sandbox (no ad platform)',
  category: 'ads',
  countries: ['EG', 'SA'],
  authType: 'none',
  readiness: 'simulated',
  capabilities: ['campaign_create_recorded', 'zero_insights'],
  activation: [
    'No activation needed. Launches are recorded in Resuto only; nothing is published and no money is spent.',
    'Connect Meta Ads, TikTok Ads or Snapchat Ads with a live ad account to launch real campaigns.',
  ],
};

export const adsSandboxAdapter: AdsAdapter = {
  descriptor: adsSandboxDescriptor,
  buildAuthUrl() {
    throw new Error('The ads sandbox does not use OAuth');
  },
  async exchangeCode() {
    throw new Error('The ads sandbox does not use OAuth');
  },
  async createCampaign() {
    return { externalId: `sandbox_${randomUUID()}`, status: 'SANDBOX_RECORDED' };
  },
  async fetchInsights(_ctx, input): Promise<AdInsightRow[]> {
    const rows: AdInsightRow[] = [];
    const end = new Date(`${input.until}T00:00:00Z`);
    for (let d = new Date(`${input.since}T00:00:00Z`); d <= end && rows.length < 92; d.setUTCDate(d.getUTCDate() + 1)) {
      rows.push({ externalCampaignId: input.externalCampaignId, date: d.toISOString().slice(0, 10), impressions: 0, clicks: 0, spendMinor: 0, currency: input.currency, conversions: 0 });
    }
    return rows;
  },
  async healthCheck() {
    return { ok: true, details: { sandbox: true, note: 'Sandbox ad account: nothing is published.' } };
  },
};
