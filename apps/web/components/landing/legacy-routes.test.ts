import { describe, expect, it } from 'vitest';
import { langAlternates, langParam, legacyRedirect } from './legacy-routes';

describe('legacy page URLs (VP-15)', () => {
  it('sends the legacy public pages to the demo restaurant’s pages', () => {
    expect(legacyRedirect('/restaurant')).toEqual({ to: '/r/the-olive-room', permanent: true });
    expect(legacyRedirect('/menu')).toEqual({ to: '/order/the-olive-room', permanent: true });
    expect(legacyRedirect('/order')).toEqual({ to: '/order/the-olive-room', permanent: true });
    expect(legacyRedirect('/reserve/')).toEqual({ to: '/reserve/the-olive-room', permanent: true });
    expect(legacyRedirect('/burger')).toEqual({ to: '/r/the-olive-room/smash-and-co', permanent: true });
  });

  it('sends the legacy staff screens through sign-in to the right screen, not permanently', () => {
    for (const p of ['/manager', '/manager/floor-editor', '/host', '/kitchen', '/account']) expect(legacyRedirect(p)).toEqual({ to: '/dashboard', permanent: false });
    expect(legacyRedirect('/manager/setup')).toEqual({ to: '/onboarding', permanent: false });
  });

  it('leaves every current route alone', () => {
    for (const p of ['/', '/pricing', '/order/the-olive-room', '/reserve/x', '/r/the-olive-room', '/kitchen/org-1', '/dashboard', '/login', '/constructor', '/__proto__', '/toString']) {
      expect(legacyRedirect(p)).toBeNull();
    }
  });
});

describe('?lang links (VP-16)', () => {
  it('accepts only ar and en', () => {
    expect(langParam(new URLSearchParams('lang=ar'))).toBe('ar');
    expect(langParam(new URLSearchParams('lang=EN'))).toBe('en');
    expect(langParam(new URLSearchParams('lang=fr'))).toBeNull();
    expect(langParam(new URLSearchParams('x=1'))).toBeNull();
  });

  it('builds hreflang alternates for a page', () => {
    expect(langAlternates('/')).toEqual({ en: '/?lang=en', ar: '/?lang=ar', 'x-default': '/' });
    expect(langAlternates('https://olive.example/?branch=burger').ar).toBe('https://olive.example/?branch=burger&lang=ar');
  });
});
