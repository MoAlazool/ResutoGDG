'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useT } from '@/lib/i18n/client';
import { navVisible } from '@/lib/nav';
import { useOrg } from '@/lib/org-context';
import { activeSection, type SectionLink } from '@/lib/sections';

/**
 * Sub-navigation between the routes of one area (21-SHELL): Finance, Insights, MCP. One pattern for every area
 * (it replaces the Finance pills, the Intelligence tabs and the MCP tabs); in-page tabs stay `Tabs`. Links the role
 * cannot open are left out; a link whose `group` differs from the previous one starts a new group (a divider).
 * `query` is appended to every link (Finance and Insights keep their period); `active` overrides the section chosen
 * from the URL.
 */
export function SectionNav({ sections, label, query, active }: { sections: SectionLink[]; label: string; query?: string; active?: string }) {
  const { t } = useT();
  const { org, hasModule } = useOrg();
  const pathname = usePathname();
  const base = `/dashboard/${org.id}`;
  const path = pathname.startsWith(base) ? pathname.slice(base.length) : pathname;
  const current = active ?? activeSection(sections, path)?.href;
  const shown = sections.filter((s) => navVisible(s, org.role) && (!s.module || hasModule(s.module)));
  return (
    <nav className="section-nav" aria-label={label}>
      <ul>
        {shown.map((s, i) => (
          <li key={s.href} data-group-start={i > 0 && s.group !== shown[i - 1]!.group ? '' : undefined}>
            <Link href={`${base}${s.href}${query ? `?${query}` : ''}`} aria-current={s.href === current ? 'page' : undefined}>{t(s.label)}</Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
