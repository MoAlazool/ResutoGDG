'use client';
import Link, { useLinkStatus } from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { NavBadge, RouteProgress } from '@resuto/ui';
import { useT } from '@/lib/i18n/client';
import { activeItem, itemPath, type AreaKey, type NavArea, type NavItem } from '@/lib/nav';
import { ShellIcon, UiIcon } from './shell-icons';

/** Path relative to the restaurant ("/dashboard/o1/orders" → "/orders"). */
export const relativePath = (pathname: string, base: string) => (pathname === base ? '' : pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : pathname);

/**
 * The areas and their secondary lists (21-SHELL). Each area is a disclosure: the area of the current page opens by
 * itself, the others open and close on demand. Collapsed to icons, an area is a single link to its first page (its
 * name is the link's label and tooltip); the full lists stay one click away (expand) or one ⌘K away.
 */
export function SidebarNav({ areas, base, pathname, search = '', collapsed = false, openOrders, label, onNavigate }: {
  areas: NavArea[]; base: string; pathname: string;
  /** The current query: an item that is a tab of a page (/website?tab=domains) is active only on that tab. */
  search?: string;
  collapsed?: boolean; openOrders?: number | null; label: string; onNavigate?: () => void;
}) {
  const { t } = useT();
  const path = relativePath(pathname, base);
  const current = activeItem(areas, path, search);
  const [toggled, setToggled] = useState<Partial<Record<AreaKey, boolean>>>({});
  // A new page in another area opens that area (an area closed by hand stays closed until then).
  useEffect(() => { if (current) setToggled((s) => (s[current.area.key] === false ? { ...s, [current.area.key]: undefined } : s)); }, [current?.area.key]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <nav className="ws-nav" aria-label={label} data-collapsed={collapsed || undefined}>
      {areas.map((area) => {
        const isCurrent = current?.area.key === area.key;
        const open = !collapsed && (toggled[area.key] ?? isCurrent);
        const badge = area.items.some((i) => i.href === '/orders') ? openOrders ?? null : null;
        return collapsed
          ? <CollapsedArea key={area.key} area={area} base={base} current={isCurrent} badge={badge} onNavigate={onNavigate} />
          : (
            <AreaGroup key={area.key} area={area} base={base} open={open} current={isCurrent} activeHref={isCurrent ? current!.item.href : null}
              badge={badge} onToggle={() => setToggled((s) => ({ ...s, [area.key]: !open }))} onNavigate={onNavigate}
              pagesLabel={t('shell.areaPages', { area: t(area.label) })} />
          );
      })}
    </nav>
  );
}

function AreaGroup({ area, base, open, current, activeHref, badge, onToggle, onNavigate, pagesLabel }: {
  area: NavArea; base: string; open: boolean; current: boolean; activeHref: string | null; badge: number | null;
  onToggle(): void; onNavigate?: () => void; pagesLabel: string;
}) {
  const { t } = useT();
  const id = useId();
  return (
    <div className="ws-area" data-open={open || undefined} data-current={current || undefined}>
      <button type="button" className="ws-area-btn" aria-expanded={open} aria-controls={`${id}-list`} onClick={onToggle}>
        <ShellIcon name={area.icon} />
        <span className="ws-nav-text">{t(area.label)}</span>
        {!open && <NavBadge count={badge} label={badge ? t('shell.openOrders', { n: badge }) : undefined} />}
        <span className="ws-area-chev" aria-hidden="true"><UiIcon name="chevron" size={16} /></span>
      </button>
      <ul className="ws-sub" id={`${id}-list`} hidden={!open} aria-label={pagesLabel}>
        {area.items.map((item) => (
          <li key={item.href}>
            <NavEntry item={item} base={base} active={item.href === activeHref} badge={item.href === '/orders' ? badge : null} onNavigate={onNavigate} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function CollapsedArea({ area, base, current, badge, onNavigate }: { area: NavArea; base: string; current: boolean; badge: number | null; onNavigate?: () => void }) {
  const { t } = useT();
  const first = area.items[0]!;
  const name = t(area.label);
  return (
    <Link href={base + first.href} className="ws-area-btn ws-area-icon" aria-label={name} title={name} aria-current={current ? 'location' : undefined} onClick={onNavigate}>
      <ShellIcon name={area.icon} />
      {badge ? <span className="ws-dot-badge" aria-hidden="true" /> : null}
      <NavPending />
    </Link>
  );
}

function NavEntry({ item, base, active, badge, onNavigate }: { item: NavItem; base: string; active: boolean; badge: number | null; onNavigate?: () => void }) {
  const { t } = useT();
  return (
    <Link href={base + item.href} className="ws-nav-link" aria-current={active ? 'page' : undefined} onClick={onNavigate}
      data-path={itemPath(item.href) || '/'}>
      <span className="ws-nav-text">{t(item.label)}</span>
      <NavBadge count={badge} label={badge ? t('shell.openOrders', { n: badge }) : undefined} />
      <NavPending />
    </Link>
  );
}

/** Pending state for a navigation: marks the clicked link and shows the top progress bar until the page is ready. */
export function NavPending() {
  const { pending } = useLinkStatus();
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const link = ref.current?.closest('a');
    if (!link) return;
    if (pending) link.setAttribute('data-pending', ''); else link.removeAttribute('data-pending');
  }, [pending]);
  return <span ref={ref} hidden={!pending}><RouteProgress active={pending} /></span>;
}
