'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { MenuEditorView, Product } from '@resuto/contracts';
import { DataTable, EmptyState, Notice, Skeleton } from '@resuto/ui';
import { Section } from '@/components/charts/insights';
import { DishStatus, PortionsCell } from '@/components/ops/DishStatus';
import { branchState } from '@/components/ops/SoldOutDrawer';
import { pick } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';

/**
 * Dish availability (gallery PAR-08): the legacy Inventory page was a per-dish list (dish, portions available,
 * Configure). It is the inventory's first tab again, for the branch chosen in the shell: each dish offered here with
 * its portions (its own count, or what the ingredients on hand make), available or sold out, a one-tap "sold out today"
 * / restore, and Configure in the menu. The stock module (levels, purchases, counts, recipes) stays in the next tabs.
 */
export function AvailabilityTab() {
  const { t, locale } = useT();
  const { org, can, branchId: shellBranch } = useOrg();
  const { call } = useSession();
  const branchId = shellBranch ?? org.branches[0]?.id ?? '';
  const menu = useApi<MenuEditorView>(`/o/${org.id}/menu`);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const m = menu.data;
  const rows = useMemo(() => {
    if (!m) return [];
    const order = new Map(m.categories.map((c, i) => [c.id, i]));
    const live = new Set(m.categories.filter((c) => c.isActive).map((c) => c.id));
    return m.products.filter((p) => p.isActive && live.has(p.categoryId) && branchState(p, branchId).offered)
      .sort((a, b) => (order.get(a.categoryId) ?? 0) - (order.get(b.categoryId) ?? 0) || a.sortOrder - b.sortOrder);
  }, [m, branchId]);

  const toggle = async (p: Product) => {
    if (pending) return;
    const s = branchState(p, branchId);
    setPending(p.id); setError(null);
    try {
      await call(`/o/${org.id}/menu/products/${p.id}/availability`, { body: { branchId, available: s.soldOut, ...(s.soldOut ? {} : { until: 'end_of_day' }) } });
      await menu.reload();
    } catch (e) { setError((e as Error).message); } finally { setPending(null); }
  };

  return (
    <Section title={t('ops.avail.title')}>
      <p className="fine mbs-0">{t('ops.avail.subtitle')}</p>
      {error && <Notice tone="danger">{error}</Notice>}
      {menu.error ? <Notice tone="danger">{menu.error.message}</Notice> : !m ? <Skeleton lines={6} /> : !rows.length ? <EmptyState title={t('core.menu.empty')}>{t('core.menu.emptyHint')}</EmptyState> : (
        <AvailabilityTable rows={rows} branchId={branchId} timezone={org.timezone} pending={pending} onToggle={can('menu:availability') ? (p) => void toggle(p) : undefined}
          configureHref={can('menu:write') ? `/dashboard/${org.id}/menu` : undefined} />
      )}
    </Section>
  );
}

/**
 * The per-dish rows: dish, portions (own count or recipe), status and the one-tap sold-out / Configure actions. A dish
 * whose recipe makes 0 portions reads "Out of ingredients", never "Available" next to a red 0 (review of PAR-08).
 */
export function AvailabilityTable({ rows, branchId, timezone, pending, onToggle, configureHref }: {
  rows: Product[]; branchId: string; timezone?: string; pending?: string | null; onToggle?: (p: Product) => void; configureHref?: string;
}) {
  const { t, locale } = useT();
  return (
    <DataTable rows={rows} rowKey={(p) => p.id} columns={[
      { key: 'dish', header: t('ops.avail.col.dish'), render: (p) => <strong>{pick(locale, p.name, p.nameAr)}</strong> },
      { key: 'portions', header: t('ops.avail.col.available'), render: (p) => <PortionsCell p={p} branchId={branchId} /> },
      { key: 'status', header: t('ops.menu.col.status'), render: (p) => <DishStatus p={p} branchId={branchId} timezone={timezone} /> },
      { key: 'options', header: t('ops.avail.col.options'), align: 'end', render: (p) => {
        const s = branchState(p, branchId);
        return (
          <div className="row gap-6 justify-end">
            {onToggle && (
              <button type="button" className="btn btn-sm" disabled={pending === p.id} onClick={() => onToggle(p)}>
                {s.soldOut ? t('ops.soldOut.restore') : t('ops.menu.soldOutToday')}
              </button>
            )}
            {configureHref && <Link className="btn btn-sm" href={configureHref}>{t('ops.avail.configure')}</Link>}
          </div>
        );
      } },
    ]} />
  );
}
