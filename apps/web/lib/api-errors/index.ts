// Localised text for API error codes (REM-W05). The API answers `{ error: { code, message, details } }` with an
// English sentence; Arabic pages showed that sentence (or, where a screen printed it, the bare code). lib/api.ts
// asks this module for the reader's text when it builds an ApiRequestError, so every screen that shows
// `error.message` (useAction, ErrorState, toasts) gets it in the page language.
//
// The dictionaries are separate chunks per language, loaded the first time an error needs them: no page bundle or
// HTML document carries ~400 messages it rarely shows. English keeps the API's own sentence when there is one (it
// can be more specific than the generic text); Arabic always uses the dictionary.
import { formatTime } from '@resuto/contracts';

export type ErrorLocale = 'en' | 'ar';

const load = (locale: ErrorLocale): Promise<Record<string, string>> =>
  locale === 'ar' ? import('./ar').then((m) => m.ar) : import('./en').then((m) => m.en);

/** Values a message may interpolate, taken from the error's details: {retryAt} is details.retryAfter as a time. */
export function errorVars(details: unknown, locale: ErrorLocale): Record<string, string> {
  const d = details && typeof details === 'object' ? details as Record<string, unknown> : {};
  const vars: Record<string, string> = {};
  if (typeof d.retryAfter === 'string' && !Number.isNaN(Date.parse(d.retryAfter))) vars.retryAt = formatTime(d.retryAfter, locale);
  return vars;
}

const fill = (text: string, vars: Record<string, string>) => text.replace(/\{(\w+)\}/g, (all, k: string) => vars[k] ?? all);

/** The dictionary text for `code` in `locale`, or null when the code has none (unknown codes keep the API's text). */
export async function apiErrorText(code: string, details: unknown, locale: ErrorLocale): Promise<string | null> {
  const dict = await load(locale);
  const text = Object.prototype.hasOwnProperty.call(dict, code) ? dict[code] : undefined;
  if (!text) return null;
  const vars = errorVars(details, locale);
  // A placeholder without its value would show "{retryAt}": use the sentence without the clause instead.
  return /\{\w+\}/.test(fill(text, vars)) ? null : fill(text, vars);
}

/** Words the API sometimes puts in `message` that are not sentences for people. */
const NOT_A_SENTENCE = /^(implementation_incomplete|requires_action|[a-z]+(_[a-z0-9]+)+)$/;

/**
 * The message an ApiRequestError should carry. English: the API's sentence when it is one, else the dictionary.
 * Arabic: the dictionary, else the API's sentence. Never throws (a failed chunk load keeps the API's text).
 */
export async function localizedErrorMessage(code: string, details: unknown, locale: ErrorLocale, serverMessage: string): Promise<string> {
  const usable = !!serverMessage && serverMessage !== code && !NOT_A_SENTENCE.test(serverMessage.trim());
  if (locale === 'en' && usable) return serverMessage;
  try {
    return (await apiErrorText(code, details, locale)) ?? (await (locale === 'ar' ? apiErrorText(code, details, 'en') : null)) ?? serverMessage;
  } catch {
    return serverMessage;
  }
}
