import type { MetadataRoute } from 'next';

const APP_ORIGIN = (process.env.NEXT_PUBLIC_APP_ORIGIN ?? 'http://localhost:3000').replace(/\/$/, '');
const DEMO_SLUG = process.env.NEXT_PUBLIC_DEMO_SLUG ?? 'the-olive-room';

/** Marketing pages. Restaurant websites are discovered through their own canonical URLs. */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    { url: `${APP_ORIGIN}/`, lastModified: now, changeFrequency: 'weekly', priority: 1 },
    { url: `${APP_ORIGIN}/pricing`, lastModified: now, changeFrequency: 'monthly', priority: 0.8 },
    { url: `${APP_ORIGIN}/signup`, lastModified: now, changeFrequency: 'yearly', priority: 0.5 },
    { url: `${APP_ORIGIN}/r/${DEMO_SLUG}`, lastModified: now, changeFrequency: 'weekly', priority: 0.6 },
  ];
}
