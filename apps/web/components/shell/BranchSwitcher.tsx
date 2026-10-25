'use client';
import { initialOf, type MenuItem } from '@resuto/ui';
import { LazyMenu as Menu } from './LazyMenu';
import { pick } from '@/lib/pick';
import { useT } from '@/lib/i18n/client';
import type { OrgInfo } from '@/lib/org-context';
import { UiIcon } from './shell-icons';

/**
 * The restaurant chip as the one branch switcher (21-SHELL): restaurant name, the current branch (or "All branches"
 * while a screen that supports it is open) and a menu of the active branches. With one branch it is a plain chip.
 */
export function BranchSwitcher({ org, branchId, allBranches, allowAll, onChoose, collapsed }: {
  org: OrgInfo; branchId: string | null; allBranches: boolean; allowAll: boolean; onChoose(id: string | null): void; collapsed?: boolean;
}) {
  const { t, locale } = useT();
  const name = pick(locale, org.name, org.nameAr);
  const active = org.branches.filter((b) => b.isActive !== false);
  const branch = org.branches.find((b) => b.id === branchId) ?? null;
  const showAll = allowAll && allBranches && active.length > 1;
  const branchName = showAll ? t('shell.allBranches') : branch ? pick(locale, branch.name, branch.nameAr) : null;
  const chip = (
    <>
      <span className="ws-chip-icon" aria-hidden="true">{initialOf(name)}</span>
      <span className="ws-chip-text">
        <strong><bdi>{name}</bdi></strong>
        {branchName && <small><bdi>{branchName}</bdi></small>}
      </span>
    </>
  );
  if (active.length < 2) return <div className="ws-chip" data-collapsed={collapsed || undefined}>{chip}</div>;
  const items: MenuItem[] = [
    ...(allowAll ? [{ key: 'all', label: <>{t('shell.allBranches')}{showAll && <Current />}</>, text: t('shell.allBranches'), hint: showAll ? <Check /> : undefined, onSelect: () => onChoose(null) }] : []),
    ...active.map((b) => {
      const label = pick(locale, b.name, b.nameAr);
      const current = !showAll && b.id === branchId;
      return { key: b.id, label: <><bdi>{label}</bdi>{current && <Current />}</>, text: label, hint: current ? <Check /> : undefined, onSelect: () => onChoose(b.id) };
    }),
  ];
  return (
    <Menu label={t('shell.switchBranch')} items={items} className="ws-chip-menu"
      trigger={
        <button type="button" className="ws-chip" data-switch="" data-collapsed={collapsed || undefined}
          aria-label={`${t('shell.switchBranch')} · ${branchName ? t('shell.branchNow', { name: branchName }) : name}`}>
          {chip}
          <span className="ws-chip-chev" aria-hidden="true"><UiIcon name="chevron" size={16} /></span>
        </button>
      } />
  );
}

const Check = () => <span aria-hidden="true" className="ws-check">✓</span>;
function Current() {
  const { t } = useT();
  return <span className="sr-only"> · {t('shell.current')}</span>;
}
