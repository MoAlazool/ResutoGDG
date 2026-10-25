'use client';
import type { ModuleKey } from '@resuto/contracts';
import { EmptyState, LockedFeature, PageHeader, SkeletonBlock } from '@resuto/ui';
import { useT } from '@/lib/i18n/client';
import { lockedItems, type NavItem } from '@/lib/nav';
import { useOrg } from '@/lib/org-context';

/** Order of the module previews (the operations core first on the Free plan). */
const ORDER: ModuleKey[] = ['core', 'connect', 'pay', 'marketing', 'studio', 'driver', 'finance', 'compliance', 'intelligence', 'mcp'];

/**
 * Explore Resuto (21-SHELL, plan §7 locked-state UX): the modules the plan does not include, as previews with what
 * each adds and an upgrade action, instead of disabled entries in the navigation. Only screens the member's role
 * could use are listed.
 */
export default function ExplorePage() {
  const { t } = useT();
  const { org, modules, plan } = useOrg();
  const locked = lockedItems({ role: org.role, modules, plan, branch: org.branches[0] ?? null });
  const byModule = new Map<ModuleKey, NavItem[]>();
  for (const item of locked) byModule.set(item.module, [...(byModule.get(item.module) ?? []), item]);
  const groups = ORDER.filter((m) => byModule.has(m)).map((m) => ({ module: m, items: byModule.get(m)! }));
  const plansHref = `/dashboard/${org.id}/billing`;
  return (
    <>
      <PageHeader title={t('explore.title')} subtitle={t('explore.subtitle')} />
      {!groups.length ? (
        <div className="card"><EmptyState title={t('explore.none.title')}>{t('explore.none.body')}</EmptyState></div>
      ) : (
        <div className="explore-grid">
          {groups.map((g) => (
            <LockedFeature key={g.module}
              title={t(`explore.module.${g.module}.title`)}
              description={t(`explore.module.${g.module}.desc`)}
              benefits={[1, 2, 3].map((n) => t(`explore.module.${g.module}.b${n}`))}
              cta={{ label: t('explore.cta'), href: plansHref }}
              preview={<ModulePreview items={g.items} />} />
          ))}
        </div>
      )}
    </>
  );
}

/** An inert sketch of the module's screens: their names over placeholder rows (decorative, aria-hidden by LockedFeature). */
function ModulePreview({ items }: { items: NavItem[] }) {
  const { t } = useT();
  return (
    <div className="explore-preview">
      <div className="explore-preview-tabs">{items.map((i) => <span key={i.href} className="badge">{t(i.label)}</span>)}</div>
      <SkeletonBlock height={14} width="60%" />
      <SkeletonBlock height={56} radius={8} />
      <SkeletonBlock height={56} radius={8} />
    </div>
  );
}
