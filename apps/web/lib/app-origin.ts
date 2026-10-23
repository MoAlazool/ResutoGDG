// The public origin of the web app (NEXT_PUBLIC_APP_ORIGIN, e.g. https://app.resuto.example), without a trailing
// slash. Used for metadataBase (absolute Open Graph/Twitter image URLs), canonical links, robots and the sitemap.
// Local builds fall back to http://localhost:3000, the same default Next.js would use.
export const APP_ORIGIN = (process.env.NEXT_PUBLIC_APP_ORIGIN ?? 'http://localhost:3000').replace(/\/$/, '');

/** metadataBase for the root layout: every page's relative social image URL resolves against the app origin. */
export const metadataBase = () => new URL(`${APP_ORIGIN}/`);
