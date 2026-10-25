import type { Metadata } from 'next';
import { dictionaries } from '@/lib/i18n/messages';
import { CanvasClient } from './CanvasClient';

export const metadata: Metadata = { title: 'Studio canvas', robots: { index: false, follow: false } };

/** The site copy the renderer needs, in both languages (the canvas switches language without a reload). */
const SITE_KEYS = /^(studio\.site\.|studio\.kind\.|core\.guest\.social\.)/;
const siteMessages = (l: 'en' | 'ar') => Object.fromEntries(Object.entries(dictionaries[l]).filter(([k]) => SITE_KEYS.test(k)));

/**
 * The Studio canvas (21-STUDIO): the restaurant website renderer (SiteView) inside the editor's sandboxed iframe. It
 * holds no data of its own and makes no API calls: the editor posts it the draft to render (lib/studio-canvas.ts),
 * and it posts back which section was clicked. Loaded only inside the editor (frame-ancestors 'self'), never indexed.
 */
export default function StudioCanvasPage() {
  return <CanvasClient messages={{ en: siteMessages('en'), ar: siteMessages('ar') }} />;
}
