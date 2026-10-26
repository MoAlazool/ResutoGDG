import { dictionaries } from '@/lib/i18n/messages';
import { CANVAS_MESSAGE_KEYS } from '@/lib/studio-canvas';

export const dynamic = 'force-static';

const pick = (l: 'en' | 'ar') => Object.fromEntries(Object.entries(dictionaries[l]).filter(([k]) => CANVAS_MESSAGE_KEYS.test(k)));

/**
 * The public website copy in both languages for the Studio canvas (22-STUDIO): the editor renders the draft in either
 * language without reloading, so it fetches both once. Only the site renderer's own strings (the same text every
 * published restaurant page shows), built into a static file.
 */
export function GET() {
  return Response.json({ en: pick('en'), ar: pick('ar') }, { headers: { 'Cache-Control': 'public, max-age=3600' } });
}
