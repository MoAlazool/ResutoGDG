// INT-23: TikTok and Snap Pixels on restaurant websites (consent-gated loaders, dedup ids, CSP scope).
import { describe, expect, it } from 'vitest';
import { buildCsp } from '../csp';
import { partnersOf } from './partners';
import { installSnapPixel, scClickIdFromSearch, SNAP_SCRIPT, snapPurchase } from './snap';
import { installTiktokPixel, TIKTOK_SCRIPT, tiktokTrack, ttclidFromSearch } from './tiktok';

const fakeDoc = () => {
  const appended: Array<{ src: string; async: boolean }> = [];
  const doc = { createElement: () => ({ src: '', async: false }), head: { appendChild: (el: { src: string; async: boolean }) => appended.push(el) } } as unknown as Document;
  return { doc, appended };
};

describe('TikTok Pixel loader', () => {
  it('adds events.js once per pixel with sdkid (no inline script), queues page() and passes event_id for dedup', () => {
    const { doc, appended } = fakeDoc();
    const w = {} as any;
    expect(installTiktokPixel('C4ABCDEF1234567890AB', w, doc)).toBe(true);
    expect(installTiktokPixel('C4ABCDEF1234567890AB', w, doc)).toBe(true);
    expect(installTiktokPixel('bad code!', w, doc)).toBe(false);
    expect(appended).toEqual([{ src: `${TIKTOK_SCRIPT}?sdkid=C4ABCDEF1234567890AB&lib=ttq`, async: true }]);
    tiktokTrack('CompletePayment', { value: 90, currency: 'EGP' }, 'p.abc', w);
    expect([...w.ttq]).toEqual([['page'], ['track', 'CompletePayment', { value: 90, currency: 'EGP' }, { event_id: 'p.abc' }]]);
    expect(w.ttq._i.C4ABCDEF1234567890AB._u).toBe(TIKTOK_SCRIPT);
  });
  it('reads ttclid only from a well-formed ad click parameter', () => {
    expect(ttclidFromSearch('?ttclid=E.C.P.abcdefgh12')).toBe('E.C.P.abcdefgh12');
    expect(ttclidFromSearch('?ttclid=%3Cscript%3E')).toBeNull();
    expect(ttclidFromSearch('?x=1')).toBeNull();
  });
});

describe('Snap Pixel loader', () => {
  it('adds scevent.min.js once, inits each pixel once, and PURCHASE carries the shared id as client_dedup_id and transaction_id', () => {
    const { doc, appended } = fakeDoc();
    const w = {} as any;
    installSnapPixel('0f3c1c4e-1111-2222-3333-444455556666', w, doc);
    installSnapPixel('0f3c1c4e-1111-2222-3333-444455556666', w, doc);
    expect(installSnapPixel('not-a-uuid', w, doc)).toBe(false);
    expect(appended).toEqual([{ src: SNAP_SCRIPT, async: true }]);
    snapPurchase(90, 'EGP', 'p.abc', w);
    expect(w.snaptr.queue).toEqual([['init', '0f3c1c4e-1111-2222-3333-444455556666'], ['track', 'PAGE_VIEW'],
      ['track', 'PURCHASE', { price: 90, currency: 'EGP', transaction_id: 'p.abc', client_dedup_id: 'p.abc' }]]);
    expect(scClickIdFromSearch('?ScCid=abcdef123456')).toBe('abcdef123456');
  });
});

describe('consent prompt partners', () => {
  it('names exactly the connected platforms', () => {
    const p = { pixelId: 'x', testMode: false };
    expect(partnersOf({ meta: p, tiktok: p, snap: null, consentVersion: 'v' })).toBe('Meta, TikTok');
    expect(partnersOf({ meta: null, snap: p, consentVersion: 'v' })).toBe('Snapchat');
  });
});

describe('CSP for the TikTok and Snap Pixels', () => {
  const directive = (csp: string, name: string) => csp.split('; ').find((d) => d.startsWith(`${name} `));
  it('adds only their event hosts, only when asked (guest pages), and keeps script-src nonce + strict-dynamic', () => {
    const site = buildCsp({ nonce: 'n1', dev: false, apiUrl: 'https://api.resuto.app', metaPixel: true, tiktokPixel: true, snapPixel: true });
    expect(directive(site, 'connect-src')).toBe("connect-src 'self' https://api.resuto.app https://api.pwnedpasswords.com https://www.facebook.com https://connect.facebook.net "
      + 'https://analytics.tiktok.com https://sc-static.net https://tr.snapchat.com');
    expect(directive(site, 'script-src')).toBe("script-src 'self' 'nonce-n1' 'strict-dynamic'");
    const staff = buildCsp({ nonce: 'n1', dev: false, apiUrl: 'https://api.resuto.app' });
    expect(directive(staff, 'connect-src')).toBe("connect-src 'self' https://api.resuto.app https://api.pwnedpasswords.com"); // AUTH-01 breach check
  });
});
