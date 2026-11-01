import type { MetadataRoute } from 'next';

export const dynamic = 'force-static';

export default function sitemap(): MetadataRoute.Sitemap {
  const modified = new Date('2026-11-01');
  return ['', 'pricing', 'contact', 'about', 'privacy', 'terms'].map((path) => ({
    url: `https://resuto.app/${path}${path ? '/' : ''}`,
    lastModified: modified,
    changeFrequency: path === '' || path === 'pricing' ? 'weekly' : 'monthly',
    priority: path === '' ? 1 : path === 'pricing' ? 0.9 : 0.6,
  }));
}
