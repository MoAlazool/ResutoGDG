import { describe, expect, it } from 'vitest';
import { googleReturnUrl, loginUrl, safeNext } from './safe-next';

const ORIGIN = 'http://127.0.0.1:3530';
/** What AuthForm reads: the value of ?next= after the browser's query decoding. */
const fromQuery = (raw: string) => new URLSearchParams(`next=${raw}`).get('next');

describe('safeNext: same-origin paths only (VS-05 open-redirect regression)', () => {
  it('keeps ordinary in-app paths, with query and hash', () => {
    expect(safeNext('/dashboard/o1/orders?x=1', ORIGIN)).toBe('/dashboard/o1/orders?x=1');
    expect(safeNext('/dashboard/o1#top', ORIGIN)).toBe('/dashboard/o1#top');
    expect(safeNext('/kitchen/o1')).toBe('/kitchen/o1');
    expect(safeNext(fromQuery('%2Fdashboard%2Fo1%3Ftab%3Dopen'), ORIGIN)).toBe('/dashboard/o1?tab=open');
  });

  it('rejects tab, newline and carriage-return smuggling that the URL parser turns into //host', () => {
    // new URL('/\t/evil.example', origin) resolves to http://evil.example/ — the reviewer's working exploit.
    for (const raw of ['/%09/evil.example/phish', '/%0A/evil.example', '/%0D/evil.example', '/%09%09/evil.example', '/%0D%0A/evil.example']) {
      const v = fromQuery(raw);
      expect(v, raw).not.toBeNull();
      expect(safeNext(v, ORIGIN), raw).toBeNull();
      expect(safeNext(v), raw).toBeNull();
    }
    expect(safeNext('/\t/evil.example')).toBeNull();
    expect(safeNext('/\n/evil.example')).toBeNull();
    expect(safeNext('/\u0000/evil.example')).toBeNull();
    expect(safeNext('/\u007F/evil.example')).toBeNull();
  });

  it('rejects protocol-relative, backslash and absolute destinations', () => {
    expect(safeNext('//evil.example/x', ORIGIN)).toBeNull();
    expect(safeNext('/\\evil.example', ORIGIN)).toBeNull();
    expect(safeNext('/x\\..\\..\\evil', ORIGIN)).toBeNull();
    expect(safeNext(fromQuery('%2F%5Cevil.example'), ORIGIN)).toBeNull();
    expect(safeNext('https://evil.example', ORIGIN)).toBeNull();
    expect(safeNext(`${ORIGIN}/dashboard`, ORIGIN)).toBeNull();
    expect(safeNext('javascript:alert(1)', ORIGIN)).toBeNull();
    expect(safeNext(' /dashboard', ORIGIN)).toBeNull();
    expect(safeNext('/dashboard ', ORIGIN)).toBeNull();
  });

  it('normalises dot segments and still requires the same origin', () => {
    expect(safeNext('/a/../dashboard', ORIGIN)).toBe('/dashboard');
    expect(safeNext('/a/..//evil.example', ORIGIN)).toBeNull();
  });

  it('never sends the user back to a sign-in page, and ignores empty or oversized values', () => {
    expect(safeNext('/login?next=/x', ORIGIN)).toBeNull();
    expect(safeNext('/signup', ORIGIN)).toBeNull();
    expect(safeNext('/login/', ORIGIN)).toBeNull();
    expect(safeNext('/loginx', ORIGIN)).toBe('/loginx');
    expect(safeNext(null)).toBeNull();
    expect(safeNext(undefined)).toBeNull();
    expect(safeNext('')).toBeNull();
    expect(safeNext(`/${'a'.repeat(3000)}`)).toBeNull();
  });
});

describe('loginUrl and the Google return URL share the check', () => {
  it('drops an unsafe next and keeps a safe one', () => {
    expect(loginUrl('/dashboard/o1/orders?x=1')).toBe('/login?next=%2Fdashboard%2Fo1%2Forders%3Fx%3D1');
    expect(loginUrl('/\t/evil.example')).toBe('/login');
    expect(loginUrl('//evil.example', 'expired')).toBe('/login?reason=expired');
    expect(loginUrl(null, 'expired')).toBe('/login?reason=expired');
  });

  it('returns to this origin only', () => {
    expect(googleReturnUrl(ORIGIN, '/dashboard/o1')).toBe(`${ORIGIN}/login?next=%2Fdashboard%2Fo1`);
    expect(googleReturnUrl(ORIGIN, '/\n/evil.example')).toBe(`${ORIGIN}/login`);
    expect(googleReturnUrl(ORIGIN, null)).toBe(`${ORIGIN}/login`);
  });
});
