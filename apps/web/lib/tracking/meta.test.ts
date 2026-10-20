import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCsp } from '../csp';
import { fbcFromSearch, installPixel, newFbp, PIXEL_SCRIPT, pixelTrack, purchaseEventId, readConsent, readCookie, writeConsent } from './meta';

const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }; };

describe('consent', () => {
  it('is per restaurant and per prompt version; unknown or broken values ask again', () => {
    const s = memory();
    expect(readConsent('olive', 'v1', s)).toBeNull();
    writeConsent('olive', 'v1', 'granted', s);
    expect(readConsent('olive', 'v1', s)).toBe('granted');
    expect(readConsent('olive', 'v2', s)).toBeNull();
    expect(readConsent('other', 'v1', s)).toBeNull();
    writeConsent('olive', 'v1', 'denied', s);
    expect(readConsent('olive', 'v1', s)).toBe('denied');
    s.m.set('resuto.adConsent.olive', '{not json');
    expect(readConsent('olive', 'v1', s)).toBeNull();
    expect(readConsent('olive', 'v1', null)).toBeNull();
  });
});

describe('browser ids (Meta formats)', () => {
  it('_fbp is fb.1.<ms>.<10 digits>; _fbc comes only from an fbclid', () => {
    expect(newFbp(1760961600000, 0.5)).toMatch(/^fb\.1\.1760961600000\.\d{10}$/);
    expect(fbcFromSearch('?fbclid=IwAR1abcdefghijkl&x=1', 1760961600000)).toBe('fb.1.1760961600000.IwAR1abcdefghijkl');
    expect(fbcFromSearch('?utm_source=x', 1)).toBeNull();
    expect(fbcFromSearch('?fbclid=%3Cscript%3E', 1)).toBeNull();
    expect(readCookie('_fbp', 'a=1; _fbp=fb.1.1.2; b=3')).toBe('fb.1.1.2');
  });

  it('the browser Purchase event id equals the server one (apps/api meta-tracking.service purchaseEventId)', async () => {
    const ref = '3f9c2a7b1e0d4c5a6b7c';
    const server = `p.${createHash('sha256').update(`purchase:${ref}`).digest('hex').slice(0, 40)}`;
    expect(await purchaseEventId(ref)).toBe(server);
    expect(server).not.toContain(ref);
  });
});

describe('Pixel loader', () => {
  it('queues calls, adds Meta\'s script once (no inline script) and inits each pixel once; eventID is passed for dedup', () => {
    const appended: Array<{ src: string; async: boolean }> = [];
    const doc = { createElement: () => ({ src: '', async: false }), head: { appendChild: (el: { src: string; async: boolean }) => appended.push(el) } } as unknown as Document;
    const w = {} as Window & { fbq?: any };
    installPixel('1234567890', w, doc);
    installPixel('1234567890', w, doc);
    installPixel('not-a-pixel', w, doc);
    expect(appended).toEqual([{ src: PIXEL_SCRIPT, async: true }]);
    pixelTrack('Purchase', { value: 90, currency: 'EGP' }, 'p.abc', w);
    expect(w.fbq.queue).toEqual([['init', '1234567890'], ['track', 'Purchase', { value: 90, currency: 'EGP' }, { eventID: 'p.abc' }]]);
  });
});

describe('CSP', () => {
  const directive = (csp: string, name: string) => csp.split('; ').find((d) => d.startsWith(`${name} `));
  it('only restaurant website pages may talk to Meta; script-src stays nonce + strict-dynamic', () => {
    const site = buildCsp({ nonce: 'n1', dev: false, apiUrl: 'https://api.resuto.app', metaPixel: true });
    const staff = buildCsp({ nonce: 'n1', dev: false, apiUrl: 'https://api.resuto.app' });
    expect(directive(site, 'connect-src')).toBe("connect-src 'self' https://api.resuto.app https://www.facebook.com https://connect.facebook.net");
    expect(directive(staff, 'connect-src')).toBe("connect-src 'self' https://api.resuto.app");
    expect(directive(site, 'script-src')).toBe("script-src 'self' 'nonce-n1' 'strict-dynamic'");
    expect(directive(site, 'frame-src')).toBe("frame-src 'none'");
  });
  it('only Inbox > Channels may frame and call Meta (WhatsApp Embedded Signup SDK); other staff pages keep frame-src none', () => {
    const inbox = buildCsp({ nonce: 'n1', dev: false, apiUrl: 'https://api.resuto.app', metaSdk: true });
    expect(directive(inbox, 'frame-src')).toBe('frame-src https://www.facebook.com https://web.facebook.com https://connect.facebook.net');
    expect(directive(inbox, 'connect-src')).toContain('https://www.facebook.com');
    expect(directive(inbox, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    const staff = buildCsp({ nonce: 'n1', dev: false, apiUrl: 'https://api.resuto.app' });
    expect(directive(staff, 'frame-src')).toBe("frame-src 'none'");
  });
});

describe('mounting', () => {
  // The Pixel is a guest-site feature: it must never be mounted in staff areas, and guest pages mount it with one line.
  const APP = join(__dirname, '..', '..', 'app');
  const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) ? [p] : []; });
  it('is used only under the restaurant site, web ordering, order tracking and booking routes', () => {
    const users = files(APP).filter((f) => /lib\/tracking\/MetaPixel/.test(readFileSync(f, 'utf8'))).map((f) => f.slice(APP.length + 1)).sort();
    expect(users).toEqual(['order/[slug]/page.tsx', 'order/[slug]/track/[ref]/page.tsx', 'r/[slug]/page.tsx', 'reserve/[slug]/page.tsx']);
  });
});
