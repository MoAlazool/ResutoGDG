// Backwards-compatible entry point. Prefer importing constants from './locale' in client code and using
// useT() (lib/i18n/client.tsx) for strings; `dictionaries`/`translate` load every dictionary in both locales.
export { LOCALE_COOKIE, isRtl, type Locale, type Messages } from './locale';
export { dictionaries, translate, messagesFor, type MessageScope } from './messages';
export { formatMessage } from './format-message';
