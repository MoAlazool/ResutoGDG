'use client';
import { preinit } from 'react-dom';

/**
 * Inserts, as stylesheets, the CSS the server could only preload (21-PERF).
 *
 * A staff screen renders on the client once the restaurant is known (the shell shows its skeleton on the server), so
 * the server HTML carries the screen's CSS as `<link rel="preload" as="style">` only. When the screen then renders,
 * React sees stylesheets it does not know to be loaded (Next's flight hints already registered them as preloads, so
 * React never watches the existing preload links) and suspends the screen behind its loading.tsx skeleton, retrying
 * on the Suspense throttle: 300-600 ms of skeleton on a throttled phone with the CSS already in the cache. Preiniting
 * the same hrefs with Next's precedence makes React treat them as inserted stylesheets, so the screen commits as soon
 * as its data is there. The files are already downloaded; inserting them early only applies them a moment sooner.
 */
export function preinitPreloadedStyles(doc: Document = document) {
  for (const link of doc.querySelectorAll<HTMLLinkElement>('link[rel="preload"][as="style"]')) {
    const href = link.getAttribute('href');
    if (href && href.startsWith('/_next/static/css/')) preinit(href, { as: 'style', precedence: 'next' });
  }
}
