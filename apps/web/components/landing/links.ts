// Where the landing page's demo links go. The demo restaurant is a normal tenant
// (seeded by the platform team); its slug is configurable per environment.
export const DEMO_SLUG = process.env.NEXT_PUBLIC_DEMO_SLUG ?? 'the-olive-room';
export const LINKS = {
  demo: `/r/${DEMO_SLUG}`,
  reserve: `/reserve/${DEMO_SLUG}`,
  menu: `/order/${DEMO_SLUG}`,
  signup: '/signup',
  login: '/login',
  pricing: '/pricing',
};
