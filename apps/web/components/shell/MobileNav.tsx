'use client';
import Link from 'next/link';
import { useT } from '@/lib/i18n/client';
import { activeItem, type AreaKey, type NavArea } from '@/lib/nav';
import { ShellIcon, UiIcon } from './shell-icons';
import { relativePath } from './SidebarNav';

/** Bottom-bar slots on phones, in order; each takes the first of its areas the member can see. */
const SLOTS: AreaKey[][] = [['home'], ['operations', 'store'], ['customers'], ['insights']];

/** Up to four areas for the phone tab bar: Home, Operations (Menu & Store on the Free plan), Customers, Insights. */
export function tabAreas(areas: NavArea[]): NavArea[] {
  const primary = areas.filter((a) => a.key !== 'settings');
  const picked: NavArea[] = [];
  for (const slot of SLOTS) {
    const hit = slot.map((k) => primary.find((a) => a.key === k)).find((a) => a && !picked.includes(a));
    if (hit) picked.push(hit);
  }
  for (const a of primary) if (picked.length < 4 && !picked.includes(a)) picked.push(a);
  return picked.slice(0, 4);
}

/**
 * Phone navigation (< 700 px, 21-SHELL): a bottom tab bar with up to four areas and "More", which opens the drawer
 * with the full navigation. Replaces the strip of 28 chips.
 */
export function MobileTabBar({ areas, base, pathname, search = '', onMore, moreOpen }: { areas: NavArea[]; base: string; pathname: string; search?: string; onMore(): void; moreOpen: boolean }) {
  const { t } = useT();
  const tabs = tabAreas(areas);
  const current = activeItem(areas, relativePath(pathname, base), search);
  const inTabs = !!current && tabs.some((a) => a.key === current.area.key);
  return (
    <nav className="ws-tabbar" aria-label={t('shell.mobileNav')}>
      {tabs.map((a) => {
        const here = current?.area.key === a.key;
        return (
          <Link key={a.key} href={base + (here ? current!.item.href : a.items[0]!.href)} className="ws-tab" aria-current={here ? 'page' : undefined}>
            <ShellIcon name={a.icon} size={20} />
            <span className="ws-tab-text">{t(a.label)}</span>
          </Link>
        );
      })}
      <button type="button" className="ws-tab" onClick={onMore} aria-expanded={moreOpen} aria-haspopup="dialog" data-current={(!inTabs && !!current) || undefined}>
        <UiIcon name="more" size={20} />
        <span className="ws-tab-text">{t('shell.more')}</span>
      </button>
    </nav>
  );
}
