// The one font file each locale needs first (REM-W03, PCL-22). The root layout preloads it, so the browser starts the
// download with the document instead of after the stylesheet is parsed and text is laid out. Only the active locale's
// file is preloaded: an English page never pays for an Arabic face and vice versa.
//
// Chosen by measurement (390 px phone, production build, 2026-10-23): every English page renders in Manrope (one
// variable file). Every Arabic page loads Plex Arabic SemiBold, and the largest text painted (LCP: landing and pricing
// leads, guest and web-order headings, sign-in title) is set in it; other weights differ by page (the Arabic landing
// never loads Medium), so preloading them would waste a download on some routes.
//
// Keep in step with the @font-face rules in app/globals.css (fonts carry a content hash in their names; the unit test
// fails when a file is renamed here or there).
import type { Locale } from './i18n';

export const PRIMARY_FONT: Record<Locale, string> = {
  /** --font-body-en: Manrope (weights 200-800 in one file). */
  en: '/fonts/manrope.057a560f.woff2',
  /** --font-body-ar at weight 600: Plex Arabic SemiBold. */
  ar: '/fonts/plex-arabic-semibold.6d6502b5.woff2',
};

/** Options for ReactDOM.preload: fonts are always fetched in CORS mode, so the preload must be too or it is wasted. */
export const FONT_PRELOAD = { as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' } as const;
