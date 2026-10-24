// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROVIDER_LOGOS, ProviderLogo, needsOfficialAsset, providerName, type ProviderId } from '../src/provider-logo';
import { $, EASTERN_DIGITS, html, mount } from './dom';

const PUBLIC = join(__dirname, '..', '..', '..', 'apps', 'web', 'public');
const REQUIRED: ProviderId[] = ['meta', 'facebook', 'instagram', 'messenger', 'whatsapp', 'tiktok', 'snapchat', 'foodics', 'stripe', 'paymob',
  'moyasar', 'odoo', 'wafeq', 'qoyod', 'zatca', 'eta', 'google-maps', 'gemini', 'resend', 'twilio', 'vercel'];

describe('ProviderLogo', () => {
  it('covers every provider the integrations surfaces name', () => {
    expect(Object.keys(PROVIDER_LOGOS).sort()).toEqual([...REQUIRED].sort());
  });

  it('points every real mark at a file served by the web app (no third-party request) that is a plain image', () => {
    for (const [id, a] of Object.entries(PROVIDER_LOGOS)) {
      if (!a.src) continue;
      expect(/^\/(brand\/providers|landing)\//.test(a.src), id).toBe(true);
      const file = join(PUBLIC, a.src);
      expect(existsSync(file), `${id}: ${a.src}`).toBe(true);
      if (a.src.endsWith('.svg')) {
        const svg = readFileSync(file, 'utf8');
        expect(svg.trimStart().startsWith('<svg'), id).toBe(true);
        expect(svg).not.toMatch(/<script|on\w+=|href="http|xlink:href="http/i);
      }
    }
  });

  it('draws a neutral monogram (never an invented logo) where no official artwork is available yet', () => {
    expect(needsOfficialAsset.sort()).toEqual(['eta', 'moyasar', 'qoyod', 'twilio', 'wafeq', 'zatca']);
    const out = html(<ProviderLogo provider="zatca" />);
    expect(out).toContain('data-fallback');
    expect(out).toContain('role="img"');
    expect(out).toContain('aria-label="ZATCA"');
    expect(out).not.toContain('<img');
  });

  it('uses the provider name in the page language as alt text, or none when decorative', () => {
    const en = mount(<ProviderLogo provider="whatsapp" size={32} />);
    const img = $<HTMLImageElement>(en.host, 'img');
    expect(img.alt).toBe('WhatsApp');
    expect(img.getAttribute('height')).toBe('32');
    expect(img.getAttribute('loading')).toBe('lazy');
    en.unmount();
    const ar = mount(<ProviderLogo provider="eta" />, 'ar');
    expect($(ar.host, '[role="img"]').getAttribute('aria-label')).toBe('مصلحة الضرائب المصرية');
    expect(ar.host.innerHTML).not.toMatch(EASTERN_DIGITS);
    ar.unmount();
    expect(html(<ProviderLogo provider="stripe" decorative />)).toContain('alt=""');
    expect(providerName('google-maps', 'ar')).toBe('خرائط Google');
  });

  it('keeps wordmarks in proportion', () => {
    const out = html(<ProviderLogo provider="foodics" size={20} />);
    expect(out).toContain('height="20"');
    expect(out).toContain(`width="${Math.round(20 * (194.141 / 26.235))}"`);
  });
});
