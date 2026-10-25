import { describe, expect, it } from 'vitest';
import { socialLinksInput } from './platform';
import { checkSocialLink, SOCIAL_NETWORKS, socialLinksOf } from './social-links';
import { RESERVED_SLUGS, slugProblem } from './slugs';

describe('checkSocialLink (21-ONB)', () => {
  it('accepts https links on each network\'s own hosts and normalizes them', () => {
    const good: Array<[string, string, string]> = [
      ['instagram', 'https://www.instagram.com/onb.cafe', 'https://www.instagram.com/onb.cafe'],
      ['instagram', ' https://instagram.com/onb ', 'https://instagram.com/onb'],
      ['facebook', 'https://m.facebook.com/onb', 'https://m.facebook.com/onb'],
      ['facebook', 'https://fb.me/onb', 'https://fb.me/onb'],
      ['tiktok', 'https://www.tiktok.com/@onb', 'https://www.tiktok.com/@onb'],
      ['x', 'https://twitter.com/onb', 'https://twitter.com/onb'],
      ['x', 'https://X.com/onb', 'https://x.com/onb'],
      ['snapchat', 'https://www.snapchat.com/add/onb', 'https://www.snapchat.com/add/onb'],
      ['whatsapp', 'https://wa.me/201001234567', 'https://wa.me/201001234567'],
      ['whatsapp', 'https://api.whatsapp.com/send?phone=201001234567', 'https://api.whatsapp.com/send?phone=201001234567'],
      ['google_maps', 'https://maps.app.goo.gl/AbC123', 'https://maps.app.goo.gl/AbC123'],
      ['google_maps', 'https://www.google.com/maps/place/Onb', 'https://www.google.com/maps/place/Onb'],
      ['google_maps', 'https://goo.gl/maps/AbC', 'https://goo.gl/maps/AbC'],
      ['website', 'https://onb-cafe.example', 'https://onb-cafe.example/'],
      ['website', 'https://menu.onb.com.eg/ar', 'https://menu.onb.com.eg/ar'],
    ];
    for (const [network, raw, url] of good) expect(checkSocialLink(network, raw), `${network} ${raw}`).toEqual({ ok: true, url });
  });

  it('refuses javascript:, data:, plain http, credentials, whitespace and other networks\' hosts', () => {
    const bad: Array<[string, string, string]> = [
      ['website', 'javascript:alert(1)', 'not_https'],
      ['website', 'JAVASCRIPT:alert(1)', 'not_https'],
      ['website', ' javascript:alert(1)', 'not_https'],
      ['website', 'data:text/html;base64,PHNjcmlwdD4=', 'not_https'],
      ['website', 'vbscript:msgbox(1)', 'not_https'],
      ['website', 'http://onb.example', 'not_https'],
      ['website', 'ftp://onb.example', 'not_https'],
      ['instagram', 'http://instagram.com/onb', 'not_https'],
      ['website', '//onb.example', 'invalid_url'],
      ['website', 'onb.example', 'invalid_url'],
      ['website', 'https://onb .example', 'invalid_url'],
      ['website', 'https://onb.example/\u0000', 'invalid_url'],
      ['website', '', 'invalid_url'],
      ['website', 'https://user:pass@onb.example', 'credentials'],
      ['website', 'https://localhost/', 'wrong_host'],
      ['website', 'https://127.0.0.1/', 'wrong_host'],
      ['website', 'https://[::1]/', 'wrong_host'],
      ['instagram', 'https://facebook.com/onb', 'wrong_host'],
      ['instagram', 'https://instagram.com.evil.example/onb', 'wrong_host'],
      ['instagram', 'https://evilinstagram.com/onb', 'wrong_host'],
      ['x', 'https://xx.com/onb', 'wrong_host'],
      ['whatsapp', 'https://wa.me.evil.example/1', 'wrong_host'],
      ['google_maps', 'https://www.google.com/search?q=onb', 'wrong_host'],
      ['google_maps', 'https://goo.gl/AbC', 'wrong_host'],
      ['website', `https://onb.example/${'a'.repeat(300)}`, 'too_long'],
      ['myspace', 'https://myspace.com/onb', 'unknown_network'],
      ['__proto__', 'https://onb.example', 'unknown_network'],
    ];
    for (const [network, raw, problem] of bad) expect(checkSocialLink(network, raw), `${network} ${raw}`).toEqual({ ok: false, problem });
  });

  it('socialLinksOf keeps only valid known networks, in a fixed order', () => {
    expect(socialLinksOf(null)).toEqual({});
    expect(socialLinksOf([])).toEqual({});
    expect(socialLinksOf({ website: 'javascript:alert(1)', myspace: 'https://myspace.com/x', facebook: 5, instagram: 'https://instagram.com/a' }))
      .toEqual({ instagram: 'https://instagram.com/a' });
    expect(Object.keys(socialLinksOf({ website: 'https://a.example', instagram: 'https://instagram.com/a' }))).toEqual(['instagram', 'website']);
  });
});

describe('socialLinksInput (PUT /o/:orgId/social-links)', () => {
  it('normalizes, drops empty entries and refuses unknown networks', () => {
    expect(socialLinksInput.parse({ instagram: 'https://Instagram.com/onb', facebook: '', x: null }))
      .toEqual({ instagram: 'https://instagram.com/onb', facebook: undefined, x: undefined });
    expect(socialLinksInput.safeParse({ myspace: 'https://myspace.com/onb' }).success).toBe(false);
  });

  it('refuses unsafe links with the network as the issue path', () => {
    const r = socialLinksInput.safeParse({ website: 'javascript:alert(1)' });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]!.path).toEqual(['website']);
    expect(r.error!.issues[0]!.message).toBe('must start with https://');
    expect(socialLinksInput.safeParse({ tiktok: 'http://tiktok.com/@onb' }).success).toBe(false);
    expect(socialLinksInput.safeParse({ snapchat: 'https://snapchat.com.evil.example/x' }).success).toBe(false);
    expect(socialLinksInput.safeParse({ google_maps: 7 }).success).toBe(false);
  });

  it('covers every network', () => {
    expect(Object.keys(socialLinksInput.shape).sort()).toEqual([...SOCIAL_NETWORKS].sort());
  });
});

describe('slugProblem and RESERVED_SLUGS (21-ONB)', () => {
  it('reserves the app\'s routes, infrastructure hosts and official-sounding names', () => {
    for (const w of ['admin', 'api', 'www', 'dashboard', 'order', 'menu', 'pay', 'reserve', 'onboarding', 'login', 'signup', 'mail', 'cdn',
      'staging', 'status', 'resuto', 'support', 'help', 'revalidate']) {
      expect(slugProblem(w), w).toBe('reserved');
    }
  });

  it('allows ordinary restaurant names', () => {
    for (const s of ['the-olive-room', 'koshary-lab', 'cafe-123', 'abc', 'menu-house', 'admin-burger']) expect(slugProblem(s), s).toBeNull();
  });

  it('checks the shape first (3-48 lowercase letters, digits, inner dashes)', () => {
    for (const s of ['ab', 'Abc', '-abc', 'abc-', 'a_b', 'café', 'a b', 'x'.repeat(49), '']) expect(slugProblem(s), s).toBe('invalid');
  });

  it('every reserved word is itself a well-formed slug (otherwise it would be redundant)', () => {
    for (const w of RESERVED_SLUGS) expect(slugProblem(w) === 'reserved', w).toBe(true);
  });
});
