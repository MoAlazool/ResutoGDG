import { afterEach, describe, expect, it, vi } from 'vitest';
import { DOMAIN_ERROR_CODES, HTTP_ERROR_CODES, hasEasternDigits } from '@resuto/contracts';
import { api, ApiRequestError } from '../api';
import { ar } from './ar';
import { en } from './en';
import { apiErrorText, localizedErrorMessage } from './index';

// REM-W05: every error code the API can return has English and Arabic text, and Arabic pages show it instead of the
// API's English sentence (otp_locked, otp_reissue_required, sandbox_disabled, run_in_progress, the 429s ...).

const REGISTRY = [...Object.keys(HTTP_ERROR_CODES), ...DOMAIN_ERROR_CODES];
const ARABIC = /[؀-ۿ]/;
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('error-code dictionaries', () => {
  it('cover every registry code in English and Arabic, and nothing else', () => {
    const missingEn = REGISTRY.filter((c) => !en[c]?.trim());
    const missingAr = REGISTRY.filter((c) => !ar[c]?.trim());
    expect(missingEn).toEqual([]);
    expect(missingAr).toEqual([]);
    const known = new Set(REGISTRY);
    expect(Object.keys(en).filter((c) => !known.has(c))).toEqual([]);
    expect(Object.keys(ar).filter((c) => !known.has(c))).toEqual([]);
  });

  it('Arabic text is Arabic with Western digits; English text has no Arabic; both use the same placeholders', () => {
    for (const c of REGISTRY) {
      expect(ar[c], c).toMatch(ARABIC);
      expect(hasEasternDigits(ar[c]!), c).toBe(false);
      expect(en[c], c).not.toMatch(ARABIC);
      expect(placeholders(ar[c]!), c).toEqual(placeholders(en[c]!));
    }
  });

  it('fills {retryAt} from details.retryAfter with Western digits, and drops a sentence whose value is missing', async () => {
    const t = await apiErrorText('run_in_progress', { retryAfter: '2026-10-23T14:05:00Z', retryAfterSeconds: 90 }, 'ar');
    expect(t).toMatch(ARABIC);
    expect(t).toMatch(/\d{1,2}:05/);
    expect(hasEasternDigits(t!)).toBe(false);
    expect(await apiErrorText('run_in_progress', {}, 'ar')).toBeNull();
    expect(await apiErrorText('no_such_code', {}, 'ar')).toBeNull();
  });

  it('English keeps the API sentence; a bare code or a technical word gets the dictionary text', async () => {
    expect(await localizedErrorMessage('otp_locked', null, 'en', 'Too many wrong delivery codes. Ask the restaurant to send a new code.'))
      .toBe('Too many wrong delivery codes. Ask the restaurant to send a new code.');
    expect(await localizedErrorMessage('not_configured', null, 'en', 'implementation_incomplete')).toBe(en.not_configured);
    expect(await localizedErrorMessage('sandbox_disabled', null, 'en', 'sandbox_disabled')).toBe(en.sandbox_disabled);
    expect(await localizedErrorMessage('mystery', null, 'ar', 'Something odd')).toBe('Something odd');
  });
});

describe('api() errors in the page language', () => {
  const reply = (status: number, code: string, message: string, details?: unknown) => vi.fn(async () => new Response(
    JSON.stringify({ error: { code, message, details, requestId: 'req-7' } }), { status, headers: { 'content-type': 'application/json' } }));
  afterEach(() => { vi.unstubAllGlobals(); });

  for (const [status, code, message] of [
    [423, 'otp_locked', 'Too many wrong delivery codes. Ask the restaurant to send a new code.'],
    [400, 'otp_reissue_required', 'Ask the restaurant to send the customer a new delivery code'],
    [403, 'sandbox_disabled', 'Simulated payments are disabled in live mode'],
    [429, 'rate_limited', 'Too many requests'],
  ] as const) {
    it(`${code}: Arabic page shows Arabic, keeps code, status and request id`, async () => {
      vi.stubGlobal('document', { documentElement: { lang: 'ar' } });
      vi.stubGlobal('fetch', reply(status, code, message));
      const e = await api('/x').catch((x) => x) as ApiRequestError;
      expect(e).toBeInstanceOf(ApiRequestError);
      expect(e.message).toBe(ar[code]);
      expect(e).toMatchObject({ status, code, requestId: 'req-7' });
    });
  }

  it('run_in_progress (admin replay 409): Arabic with the retry time; English keeps the API sentence', async () => {
    const details = { retryAfter: '2026-10-23T14:05:00Z', retryAfterSeconds: 90 };
    vi.stubGlobal('document', { documentElement: { lang: 'ar' } });
    vi.stubGlobal('fetch', reply(409, 'run_in_progress', 'A timed-out run may still be in progress; retry after 2026-10-23T14:05:00.000Z', details));
    const arErr = await api('/x').catch((x) => x) as ApiRequestError;
    expect(arErr.message).toMatch(ARABIC);
    expect(arErr.message).toMatch(/\d{1,2}:05/);
    vi.stubGlobal('document', { documentElement: { lang: 'en' } });
    const enErr = await api('/x').catch((x) => x) as ApiRequestError;
    expect(enErr.message).toBe('A timed-out run may still be in progress; retry after 2026-10-23T14:05:00.000Z');
  });
});
