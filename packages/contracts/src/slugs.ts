// Restaurant web addresses (21-ONB, plan §6.2 step 3): the slug in /r/<slug>, /m/<slug>, /order/<slug> and, once a
// wildcard domain exists, <slug>.<root domain>. Zod-free (exported from '@resuto/contracts/lite' so the onboarding
// form can check as the owner types); the API checks again on signup and in GET /v1/orgs/slug-availability.

/** Same shape as `slug` in ./common.ts (and the organizations.slug check): 3–48 lowercase letters, digits, dashes. */
export const ORG_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/;

/**
 * Words a restaurant cannot take as its address: the app's own top-level routes, names a subdomain would collide with
 * (www, api, mail …), and names that would let a page pass as Resuto itself or as an official page.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  // App routes and route-like words
  'admin', 'api', 'app', 'apps', 'dashboard', 'driver', 'drivers', 'invite', 'kitchen', 'login', 'logout', 'signin', 'signup',
  'register', 'onboarding', 'order', 'orders', 'pay', 'payment', 'payments', 'pricing', 'reserve', 'reservations', 'legal',
  'privacy', 'terms', 'robots', 'sitemap', 'unsubscribe', 'menu', 'menus', 'table', 'tables', 'checkout', 'cart',
  'account', 'accounts', 'settings', 'billing', 'auth', 'oauth', 'callback', 'webhook', 'webhooks', 'mcp', 'revalidate',
  'public', 'static', 'assets', 'media', 'images', 'img', 'files', 'uploads', 'download', 'downloads',
  // Hosts and infrastructure
  'www', 'mail', 'email', 'smtp', 'imap', 'pop', 'ftp', 'cdn', 'dns', 'ns1', 'ns2', 'status', 'health', 'metrics', 'staging',
  'stage', 'prod', 'production', 'dev', 'development', 'test', 'testing', 'demo', 'beta', 'preview', 'sandbox', 'internal',
  'localhost', 'graphql', 'socket', 'root', 'system', 'null', 'undefined',
  // Resuto and official-sounding pages
  'resuto', 'resuto-app', 'help', 'support', 'docs', 'blog', 'news', 'about', 'contact', 'careers', 'jobs', 'security',
  'official', 'team', 'staff', 'partners', 'developers', 'store', 'shop',
]);

export type SlugProblem = 'invalid' | 'reserved';

/** Why `slug` cannot be a restaurant's address (shape or reserved word), or null when it can (availability aside). */
export function slugProblem(slug: string): SlugProblem | null {
  if (!ORG_SLUG_PATTERN.test(slug)) return 'invalid';
  if (RESERVED_SLUGS.has(slug)) return 'reserved';
  return null;
}
