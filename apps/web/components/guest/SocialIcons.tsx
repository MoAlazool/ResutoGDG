// A restaurant's social links as icons (21-ONB): on the view-only menu (/m), the restaurant site (/r) and its branch
// storefronts. Server- and client-safe (no hooks). The marks are files served from Resuto's own origin (Simple Icons
// path data, see docs/ui/DESIGN_SYSTEM.md "Provider logos"); the link text for screen readers is the network's name.
// Links are re-checked here (socialLinksOf: https on the network's own hosts) even though the API already did.
import { SOCIAL_NETWORKS, socialLinksOf, type SocialNetwork } from '@resuto/contracts/lite';
import './social-icons.css';

export const SOCIAL_ICON_SRC: Record<SocialNetwork, string> = {
  instagram: '/brand/providers/instagram.svg',
  facebook: '/brand/providers/facebook.svg',
  tiktok: '/brand/providers/tiktok.svg',
  x: '/brand/providers/x.svg',
  snapchat: '/brand/providers/snapchat.svg',
  whatsapp: '/brand/providers/whatsapp.svg',
  google_maps: '/brand/providers/google-maps.svg',
  website: '/brand/social/website.svg',
};

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The valid links, in the fixed network order. */
export function socialEntries(value: unknown): Array<[SocialNetwork, string]> {
  const links = socialLinksOf(value);
  return SOCIAL_NETWORKS.filter((n) => links[n]).map((n) => [n, links[n]!]);
}

export function SocialIcons({ links, t, className = '', showTitle = true, withNames = false }: {
  links: unknown; t: T; className?: string; showTitle?: boolean;
  /** Show the network's name beside its icon (the menu page's pills). */
  withNames?: boolean;
}) {
  const entries = socialEntries(links);
  if (!entries.length) return null;
  return (
    <nav className={`social-icons${withNames ? ' with-names' : ''} ${className}`.trim()} aria-label={t('core.guest.social.title')}>
      {showTitle && <h2 className="social-icons-title">{t('core.guest.social.title')}</h2>}
      <ul>
        {entries.map(([n, href]) => (
          <li key={n}>
            <a href={href} target="_blank" rel="noopener noreferrer nofollow" data-network={n}
              aria-label={t('core.guest.social.open', { network: t(`core.guest.social.${n}`) })}>
              <img src={SOCIAL_ICON_SRC[n]} alt="" width={20} height={20} loading="lazy" decoding="async" />
              {withNames && <span>{t(`core.guest.social.${n}`)}</span>}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
