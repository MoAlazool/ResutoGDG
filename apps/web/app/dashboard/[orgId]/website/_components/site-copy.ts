'use client';
// The public website copy in both languages (app/api/studio/site-messages), fetched once per editor session: the canvas
// renders the draft in either language without a reload, and the Optimize checks render both.
export type SiteCopy = { en: Record<string, string>; ar: Record<string, string> };
let once: Promise<SiteCopy> | null = null;
export function loadSiteCopy(): Promise<SiteCopy> {
  once ??= fetch('/api/studio/site-messages', { credentials: 'same-origin' }).then((r) => {
    if (!r.ok) throw new Error(`site copy ${r.status}`);
    return r.json() as Promise<SiteCopy>;
  }).catch((e) => { once = null; throw e; });
  return once;
}
