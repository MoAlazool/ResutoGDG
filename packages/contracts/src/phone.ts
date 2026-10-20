import { z } from 'zod';
import { toWesternDigits } from './locale-format';

/**
 * Guest phone numbers as people type them (CR-06): the local Egyptian (010 0123 4567) and Saudi (05x xxx xxxx)
 * forms, the 00 international prefix, spaces, dashes, brackets, Arabic-Indic digits and stray direction marks.
 * Legacy Resuto accepted any contact text; the new stack keeps E.164 in the database, so the server normalises with
 * the restaurant's country (organizations.country) before storing anything.
 */
export type PhoneCountry = 'EG' | 'SA';

const DIAL: Record<PhoneCountry, string> = { EG: '20', SA: '966' };
/** Separators and invisible direction marks a pasted or bidi-wrapped number may carry. */
const NOISE = /[\s\-(). ‎‏‪-‮⁦-⁩]/g;

/** Western digits, no separators; keeps a leading '+'. */
export function compactPhone(input: string): string {
  return toWesternDigits(String(input ?? '')).replace(NOISE, '');
}

/**
 * E.164 for a number typed in `country`, or null when it cannot be a phone number there.
 * - +E.164 and 00-prefixed international numbers are kept (any country).
 * - Egypt: 01x mobile (11 digits) and 0-prefixed landlines; also without the trunk 0 or with a bare 20 prefix.
 * - Saudi Arabia: 05x mobile (10 digits) and 01x landlines; also without the trunk 0 or with a bare 966 prefix.
 */
export function normalizePhone(input: string, country: PhoneCountry): string | null {
  let s = compactPhone(input);
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (s.startsWith('+')) return /^\+[1-9][0-9]{6,14}$/.test(s) ? s : null;
  if (!/^[0-9]{7,15}$/.test(s)) return null;
  if (country === 'EG') {
    if (/^01[0125][0-9]{8}$/.test(s)) return `+20${s.slice(1)}`;
    if (/^1[0125][0-9]{8}$/.test(s)) return `+20${s}`;
    if (/^0[2-9][0-9]{7,8}$/.test(s)) return `+20${s.slice(1)}`;
    if (/^201[0125][0-9]{8}$/.test(s)) return `+${s}`;
  } else {
    if (/^05[0-9]{8}$/.test(s)) return `+966${s.slice(1)}`;
    if (/^5[0-9]{8}$/.test(s)) return `+966${s}`;
    if (/^01[1-7][0-9]{7}$/.test(s)) return `+966${s.slice(1)}`;
    if (/^9665[0-9]{8}$/.test(s)) return `+${s}`;
  }
  return null;
}

/** Example local format shown as the field hint, per country. */
export const PHONE_EXAMPLE: Record<PhoneCountry, string> = { EG: '010 0123 4567', SA: '050 123 4567' };
/** International dialling code, per country. */
export const PHONE_DIAL = DIAL;

/**
 * Request field for a guest phone (web order, booking, WhatsApp hand-off): Western digits, separators removed, a
 * plausible length. The country-specific E.164 normalisation happens on the server with the restaurant's country.
 */
export const guestPhone = z.string().transform(compactPhone).pipe(z.string().regex(/^\+?[0-9]{7,15}$/, 'phone_invalid'));
