// Restaurant social links (21-ONB, plan §6.2 step 7): organizations.social_links, shown as icons on the digital menu
// and the storefront. Zod-free (exported from '@resuto/contracts/lite' for guest pages); the request schema that uses
// these rules is `socialLinksInput` in ./platform.ts.
//
// Every link is an https URL on the network's own hosts, so a guest tapping the Instagram icon always lands on
// Instagram. `website` is any public https site. The database repeats the coarse rules (known keys, https, no
// whitespace) in organizations_social_links_valid.

export const SOCIAL_NETWORKS = ['instagram', 'facebook', 'tiktok', 'x', 'snapchat', 'whatsapp', 'google_maps', 'website'] as const;
export type SocialNetwork = (typeof SOCIAL_NETWORKS)[number];
export type SocialLinks = Partial<Record<SocialNetwork, string>>;

export const SOCIAL_LINK_MAX_LENGTH = 300;

/**
 * Hosts per network (the host itself or any subdomain of it). Google Maps share links come from maps.app.goo.gl and
 * goo.gl/maps; full links are google.com/maps or maps.google.com.
 */
export const SOCIAL_LINK_HOSTS: Readonly<Record<Exclude<SocialNetwork, 'website'>, readonly string[]>> = {
  instagram: ['instagram.com'],
  facebook: ['facebook.com', 'fb.com', 'fb.me'],
  tiktok: ['tiktok.com'],
  x: ['x.com', 'twitter.com'],
  snapchat: ['snapchat.com'],
  whatsapp: ['wa.me', 'whatsapp.com'],
  google_maps: ['maps.google.com', 'maps.app.goo.gl', 'goo.gl', 'google.com'],
};

export type SocialLinkProblem = 'unknown_network' | 'too_long' | 'invalid_url' | 'not_https' | 'credentials' | 'wrong_host';

const onHost = (host: string, allowed: readonly string[]) => allowed.some((h) => host === h || host.endsWith(`.${h}`));
const isNetwork = (v: string): v is SocialNetwork => (SOCIAL_NETWORKS as readonly string[]).includes(v);

/**
 * The normalized link (URL.href) or why it is refused. Refuses anything that is not https (javascript:, data:, http:),
 * user:password@ URLs, whitespace or control characters, hosts of another network and, for `website`, hosts that are
 * not a public domain name (localhost, bare IP addresses).
 */
export function checkSocialLink(network: string, raw: string): { ok: true; url: string } | { ok: false; problem: SocialLinkProblem } {
  if (!isNetwork(network)) return { ok: false, problem: 'unknown_network' };
  const value = raw.trim();
  if (value.length > SOCIAL_LINK_MAX_LENGTH) return { ok: false, problem: 'too_long' };
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  if (!value || /[\s\u0000-\u001f\u007f]/.test(value)) return { ok: false, problem: 'invalid_url' };
  let url: URL;
  try { url = new URL(value); } catch { return { ok: false, problem: 'invalid_url' }; }
  if (url.protocol !== 'https:') return { ok: false, problem: 'not_https' };
  if (url.username || url.password) return { ok: false, problem: 'credentials' };
  const host = url.hostname.toLowerCase();
  if (network === 'website') {
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(host)) return { ok: false, problem: 'wrong_host' };
  } else {
    if (!onHost(host, SOCIAL_LINK_HOSTS[network])) return { ok: false, problem: 'wrong_host' };
    // google.com and goo.gl serve far more than maps: only their /maps paths count as a map link.
    if (network === 'google_maps' && (host === 'google.com' || host === 'www.google.com' || host === 'goo.gl') && !/^\/maps(?:\/|$)/.test(url.pathname)) {
      return { ok: false, problem: 'wrong_host' };
    }
  }
  if (url.href.length > SOCIAL_LINK_MAX_LENGTH) return { ok: false, problem: 'too_long' };
  return { ok: true, url: url.href };
}

/** The links of a stored value that are still valid, in SOCIAL_NETWORKS order (anything else is dropped). */
export function socialLinksOf(value: unknown): SocialLinks {
  const out: SocialLinks = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const n of SOCIAL_NETWORKS) {
    const v = (value as Record<string, unknown>)[n];
    if (typeof v !== 'string') continue;
    const r = checkSocialLink(n, v);
    if (r.ok) out[n] = r.url;
  }
  return out;
}
