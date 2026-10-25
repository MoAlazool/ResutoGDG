'use client';
import { useMemo, useState } from 'react';
import type { StockLevelView } from '@resuto/contracts';
import { Badge, DataTableV2, EmptyState, FilterBar, Skeleton, type FilterChip } from '@resuto/ui';
import { LoadError, qs, useBranchName, useFormat } from '@/components/charts/insights';
import { dateTime, pick } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { isMultiBranch, useBranchScope, useOrg } from '@/lib/org-context';
import { useApi } from '@/lib/use-api';
import { unitLabel } from '@/lib/vocab';
import { lowCount, lowStockFirst, matchesStock, stockRank } from './stock-order';

/**
 * Stock levels (21-OPS ListPage): what needs attention first (below zero, then low, emptiest first), a search over
 * both names, a "Low stock" filter, and the stocktake and record actions in the filter bar. The branch is the shell's
 * (All branches lists every branch with a branch column).
 */
export function LevelsList({ onRecord, onStocktake }: { onRecord?: () => void; onStocktake?: () => void }) {
  const { t, locale } = useT();
  const f = useFormat();
  const { org } = useOrg();
  const branchName = useBranchName();
  const { branchId, allBranches } = useBranchScope({ allowAll: true }); // the shell's branch switcher (21-SHELL)
  const [onlyLow, setOnlyLow] = useState(false);
  const [q, setQ] = useState('');
  const { data, error, loading, reload } = useApi<{ items: StockLevelView[] }>(`/o/${org.id}/inventory/levels${qs({ branchId })}`, { pollMs: 60_000 });
  const all = useMemo(() => lowStockFirst(data?.items ?? [], locale), [data, locale]);
  const rows = all.filter((l) => (!onlyLow || stockRank(l) < 2) && matchesStock(l, q));
  const attention = lowCount(all);
  const chips: FilterChip[] = [
    ...(onlyLow ? [{ key: 'low', label: t('insights.inventory.onlyLow'), onRemove: () => setOnlyLow(false) }] : []),
    ...(q.trim() ? [{ key: 'q', label: `“${q.trim()}”`, onRemove: () => setQ('') }] : []),
  ];
  return (
    <div className="stack inventory-levels">
      <FilterBar search={{ value: q, onChange: setQ, label: t('ops.inv.search'), placeholder: t('ops.inv.search') }} chips={chips}
        filters={(
          <button type="button" className="rui-view-chip inventory-low-chip" aria-pressed={onlyLow} onClick={() => setOnlyLow(!onlyLow)}>
            {t('insights.inventory.onlyLow')} <span className="num">{f.num(attention)}</span>
          </button>
        )}
        actions={<>
          {onStocktake && <button type="button" className="btn btn-sm" onClick={onStocktake}>{t('ops.stock.title')}</button>}
          {onRecord && <button type="button" className="btn btn-sm btn-primary" onClick={onRecord}>{t('insights.inventory.record')}</button>}
        </>} />
      <LoadError error={error} retry={reload} />
      {loading && !data ? <Skeleton lines={5} /> : (
        <DataTableV2 label={t('insights.inventory.tab.levels')} rows={rows} rowKey={(l) => `${l.branchId}:${l.itemId}`} columnToggle densityToggle
          empty={<EmptyState title={t('insights.inventory.noItems')}>{t('insights.inventory.noItemsHint')}</EmptyState>}
          columns={[
            { key: 'item', header: t('insights.inventory.item'), rowHeader: true, render: (l) => pick(locale, l.name, l.nameAr) },
            { key: 'status', header: t('insights.inventory.status'), render: (l) => l.quantity < 0 ? <Badge tone="danger">{t('insights.inventory.negative')}</Badge>
              : l.low ? <Badge tone="warn">{t('insights.inventory.low')}</Badge> : <Badge tone="ok">{t('insights.inventory.ok')}</Badge>,
              sort: (a, b) => stockRank(a) - stockRank(b) },
            ...(allBranches && isMultiBranch(org) ? [{ key: 'branch', header: t('insights.branch.label'), render: (l: StockLevelView) => branchName(l.branchId) }] : []),
            { key: 'qty', header: t('insights.inventory.onHand'), align: 'end' as const, render: (l) => <span className="num">{f.num(l.quantity)} {unitLabel(t, l.unit)}</span>, sort: (a, b) => a.quantity - b.quantity },
            { key: 'reorder', header: t('insights.inventory.reorderLevel'), align: 'end' as const, render: (l) => <span className="num">{l.reorderLevel ? `${f.num(l.reorderLevel)} ${unitLabel(t, l.unit)}` : '—'}</span> },
            { key: 'value', header: t('insights.inventory.value'), align: 'end' as const, render: (l) => <span className="num">{f.money(l.valueMinor)}</span>, sort: (a, b) => a.valueMinor - b.valueMinor },
            { key: 'counted', header: t('insights.inventory.lastCounted'), defaultHidden: false, render: (l) => <span className="fine num">{l.lastCountedAt ? dateTime(l.lastCountedAt, locale) : t('insights.inventory.never')}</span> },
          ]} />
      )}
    </div>
  );
}
