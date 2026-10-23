import type { MetadataRoute } from 'next';

const APP_ORIGIN = (process.env.NEXT_PUBLIC_APP_ORIGIN ?? 'http://localhost:3000').replace(/\/$/, '');

/** Marketing site and published restaurant websites are indexable; app surfaces are not. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{
      userAgent: '*',
      allow: ['/', '/pricing', '/r/'],
      disallow: ['/dashboard', '/onboarding', '/login', '/signup', '/admin', '/kitchen', '/driver', '/t/', '/v/', '/pay/', '/s/', '/o/', '/invite/'],
    }],
    sitemap: `${APP_ORIGIN}/sitemap.xml`,
    host: APP_ORIGIN,
  };
}
