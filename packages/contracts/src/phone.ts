import { z } from 'zod';
import { compactPhone } from './phone-format';

export * from './phone-format';

/**
 * Request field for a guest phone (web order, booking, WhatsApp hand-off): Western digits, separators removed, a
 * plausible length. The country-specific E.164 normalisation happens on the server with the restaurant's country.
 */
export const guestPhone = z.string().transform(compactPhone).pipe(z.string().regex(/^\+?[0-9]{7,15}$/, 'phone_invalid'));
