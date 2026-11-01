// Where the landing page's demo links go. The demo restaurant is a normal tenant
// (seeded by the platform team); its slug is configurable per environment.
export const DEMO_SLUG = process.env.NEXT_PUBLIC_DEMO_SLUG ?? 'the-olive-room';
export const LINKS = {
  demo: '/contact/?subject=request-access',
  reserve: '/contact/?subject=request-access',
  menu: '/contact/?subject=request-access',
  signup: '/contact/?subject=request-access',
  login: '/contact/?subject=request-access',
  pricing: '/pricing',
};
