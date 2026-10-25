'use client';
import type { ReactNode } from 'react';
import type { Category, Product } from '@resuto/contracts';
import { DataTableV2, Switch, initialOf, type ColumnV2 } from '@resuto/ui';
import { DishStatus, PortionsCell } from '@/components/ops/DishStatus';
import { money, pick } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { allergenLabel, stationLabel } from '@/lib/vocab';
import { branchView, compareAtOf } from './model';

/** Status order for sorting: available first, then out of stock, sold out, not offered. */
const statusRank = (p: Product, branchId: string) => {
  const v = branchView(p, branchId);
  return !v.offered ? 3 : v.soldOut ? 2 : v.outOfStock ? 1 : 0;
};

/**
 * The dishes (DataTableV2): sticky header, sorting, column and density choices, selection for the bulk bar, and the
 * inline availability switch (86 at the shell's branch). A row opens the dish's sheet (click, or Enter when focused).
 */
export function ItemsTable({ rows, categories, branchId, branchName, currency, timezone, selected, onSelectedChange, onOpen, canAvailability,
  selectable, pending, onAvailability, bulkActions, empty, busy, toolbar }: {
  rows: Product[]; categories: Category[]; branchId: string; branchName: string; currency: string; timezone?: string;
  selected: string[]; onSelectedChange: (ids: string[]) => void; onOpen?: (p: Product) => void;
  canAvailability: boolean; selectable: boolean; pending: ReadonlySet<string>; onAvailability: (p: Product, available: boolean) => void;
  bulkActions: (ids: string[], clear: () => void) => ReactNode; empty: ReactNode; busy?: boolean; toolbar?: ReactNode;
}) {
  const { t, locale } = useT();
  const catIndex = new Map(categories.map((c, i) => [c.id, i]));
  const catName = new Map(categories.map((c) => [c.id, pick(locale, c.name, c.nameAr)]));
  const columns: ColumnV2<Product>[] = [
    {
      key: 'item', header: t('ops.menu.col.item'), rowHeader: true, hideable: false,
      sort: (a, b) => pick(locale, a.name, a.nameAr).localeCompare(pick(locale, b.name, b.nameAr), locale),
      render: (p) => (
        <span className="menu-item-cell" data-row-id={p.id}>
          {p.imageUrl ? <img src={p.imageUrl} alt="" width={40} height={40} loading="lazy" /> : <span className="item-initial" aria-hidden="true">{initialOf(pick(locale, p.name, p.nameAr))}</span>}
          <span><strong><bdi>{pick(locale, p.name, p.nameAr)}</bdi></strong>
            <small>{p.allergens.length ? t('ops.menu.contains', { list: p.allergens.map((a) => allergenLabel(t, a)).join(locale === 'ar' ? '، ' : ', ') }) : t('ops.menu.noAllergens')}</small></span>
        </span>
      ),
    },
    {
      key: 'category', header: t('core.menu.category'), sort: (a, b) => (catIndex.get(a.categoryId) ?? 0) - (catIndex.get(b.categoryId) ?? 0) || a.sortOrder - b.sortOrder,
      render: (p) => <bdi>{catName.get(p.categoryId) ?? ''}</bdi>,
    },
    { key: 'station', header: t('core.menu.station'), defaultHidden: true, render: (p) => stationLabel(t, p.station) },
    {
      key: 'price', header: t('ops.menu.col.price'), align: 'end', sort: (a, b) => branchView(a, branchId).priceMinor - branchView(b, branchId).priceMinor,
      render: (p) => {
        const v = branchView(p, branchId);
        const was = v.overrideMinor === null ? compareAtOf(p) : null;
        return (
          <span className="menu-price num">
            {was !== null && <s className="menu-price-was"><span className="sr-only">{t('menu.ws.price.was')} </span>{money(was, currency, locale)}</s>}
            <span>{money(v.priceMinor, currency, locale)}</span>
            {v.overrideMinor !== null && <small className="fine">{t('menu.ws.price.branch')}</small>}
          </span>
        );
      },
    },
    { key: 'portions', header: t('ops.menu.col.portions'), render: (p) => <PortionsCell p={p} branchId={branchId} /> },
    { key: 'status', header: t('ops.menu.col.status'), sort: (a, b) => statusRank(a, branchId) - statusRank(b, branchId), render: (p) => <DishStatus p={p} branchId={branchId} timezone={timezone} /> },
    ...(canAvailability ? [{
      key: 'available', header: t('menu.ws.col.available'), hideable: false,
      render: (p: Product) => {
        const v = branchView(p, branchId);
        if (!v.offered) return <span className="fine">{t('ops.menu.notOffered')}</span>;
        return (
          <Switch className="menu-avail" checked={!v.soldOut} disabled={pending.has(p.id)} onChange={(on) => onAvailability(p, on)}
            label={<span className="sr-only">{t('menu.ws.availableAt', { name: pick(locale, p.name, p.nameAr), branch: branchName })}</span>} />
        );
      },
    }] : []),
  ];

  return (
    <div className="menu-table-v2">
      <DataTableV2 label={t('core.menu.items')} rows={rows} rowKey={(p) => p.id} columns={columns} busy={busy}
        onRowClick={onOpen} selectable={selectable} selected={selected} onSelectedChange={onSelectedChange} bulkActions={bulkActions}
        columnToggle densityToggle stickyHeader maxHeight="calc(100dvh - 260px)" empty={empty} toolbar={toolbar}
        labels={{ select: t('menu.ws.selectDish'), selectAll: t('menu.ws.selectAll') }} />
    </div>
  );
}
