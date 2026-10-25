'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Category, MenuEditorView, Product } from '@resuto/contracts';
import { formatNumber } from '@resuto/contracts/lite';
import { EmptyState, FilterBar, Menu, Notice, PageHeading, SelectField, Skeleton, WorkspacePage, useConfirm, usePrompt, type FilterChip } from '@resuto/ui';
import { MenuQrCard } from '@/components/ops/MenuQrCard';
import '@/components/ops/ops.css';
import { useUrlParam } from '@/components/ops/use-url-state';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { pick } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useBranchScope, useOrg } from '@/lib/org-context';
import { usePageCommands } from '@/lib/page-commands';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { CategoryRail } from './_parts/CategoryRail';
import { MenuIcon } from './_parts/icons';
import { ItemsTable } from './_parts/ItemsTable';
import { createMenuKeyReader, stepIndex, type MenuKey } from './_parts/keys';
import { activeCategories, branchView, categoryCounts, filterItems, menuItems, runBulk, type AvailabilityFilter, type BulkResult, type MenuFilters } from './_parts/model';
import './_parts/menu.css';

// The sheets and the import (with its spreadsheet worker) load when they open.
const ItemSheet = lazy(() => import('./_parts/ItemSheet'));
const ImportSheet = lazy(() => import('./_parts/ImportSheet'));
const ModifiersSheet = lazy(() => import('./_parts/ModifiersSheet'));
const BulkPriceSheet = lazy(() => import('./_parts/BulkPriceSheet'));

type LegacyTab = 'items' | 'categories' | 'modifiers' | 'import';
const LEGACY_TABS: readonly LegacyTab[] = ['items', 'categories', 'modifiers', 'import'];
const AVAILABILITY: readonly AvailabilityFilter[] = ['', 'offered', 'not_offered'];
type Flash = { tone: 'ok' | 'warn' | 'danger'; text: string };

/**
 * Menu workspace (21-MENU, plan §5): the category rail (filter, add, rename, archive, reorder by drag or keyboard), the
 * dishes table (DataTableV2: sort, columns, density, selection) with the availability switch at the shell's branch,
 * the bulk bar (sold out / available, move to a category, price change with a preview, archive), the dish sheet, and
 * Import as an action (spreadsheet or pasted CSV here, assisted extraction at /menu-import). Filters live in the URL.
 * Staff edits are direct API calls, as before (no change sets). Keys: j / k, Enter, Space or x, n, i, / (? lists them).
 */
export default function MenuPage() {
  return <Suspense fallback={<Skeleton lines={8} />}><ModuleGate module="core" permission="menu:read"><MenuWorkspace /></ModuleGate></Suspense>;
}

function MenuWorkspace() {
  const { t, locale } = useT();
  const { org, can } = useOrg();
  const { call } = useSession();
  const { branchId } = useBranchScope(); // the shell's one branch context (21-SHELL); never a per-page branch select
  const menu = useApi<MenuEditorView>(`/o/${org.id}/menu`);
  const m = menu.data;
  const write = can('menu:write');
  const canAvail = can('menu:availability');
  const currency = (m?.currency ?? org.currency) as 'EGP' | 'SAR';
  const branch = org.branches.find((b) => b.id === branchId);
  const branchName = pick(locale, branch?.name, branch?.nameAr);
  const [confirm, confirmDialog] = useConfirm(locale);
  const [prompt, promptDialog] = usePrompt(locale);

  // Filters (URL, so a reload or a shared link keeps them: PCL-20).
  const [category, setCategory] = useUrlParam<string>('cat', '');
  const [q, setQ] = useUrlParam<string>('q', '');
  const [availability, setAvailability] = useUrlParam<AvailabilityFilter>('avail', '', AVAILABILITY);
  const [soldOutParam, setSoldOut] = useUrlParam<'' | '1'>('soldout', '', ['', '1']);
  const [trackedParam, setTracked] = useUrlParam<'' | '1'>('tracked', '', ['', '1']);
  const [legacyTab, setLegacyTab] = useUrlParam<LegacyTab>('tab', 'items', LEGACY_TABS);
  const filters: MenuFilters = { category, q, availability, soldOut: soldOutParam === '1', tracked: trackedParam === '1' };

  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [pricing, setPricing] = useState<string[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Flash | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  const lastRow = useRef<string | null>(null);

  // Old links: ?tab=import opens the import, ?tab=modifiers the option groups (the former tabs of this page).
  useEffect(() => {
    if (legacyTab === 'items') return;
    if (legacyTab === 'import' && write) setImporting(true);
    if (legacyTab === 'modifiers' && write) setGroupsOpen(true);
    setLegacyTab('items');
  }, [legacyTab, write, setLegacyTab]);
  // A dish found in the command palette opens in its sheet (`?product=<id>`), once the menu has loaded.
  const productParam = useSearchParams().get('product');
  const openedProduct = useRef<string | null>(null);
  useEffect(() => {
    const found = productParam && write && openedProduct.current !== productParam ? m?.products.find((p) => p.id === productParam) : undefined;
    if (found) { openedProduct.current = productParam; setEditing(found); }
  }, [m, write, productParam]);

  const categories = useMemo(() => activeCategories(m?.categories ?? []), [m]);
  const items = useMemo(() => menuItems(m?.products ?? [], m?.categories ?? []), [m]);
  const counts = useMemo(() => categoryCounts(items), [items]);
  const rows = useMemo(() => filterItems(items, filters, branchId), [items, branchId, filters.category, filters.q, filters.availability, filters.soldOut, filters.tracked]); // eslint-disable-line react-hooks/exhaustive-deps
  const rowIds = useMemo(() => new Set(rows.map((r) => r.id)), [rows]);
  const shownSelection = selected.filter((id) => rowIds.has(id));
  const selectedProducts = (ids: string[]) => items.filter((p) => ids.includes(p.id));
  useEffect(() => { if (category && m && !categories.some((c) => c.id === category)) setCategory(''); }, [category, categories, m, setCategory]);

  const report = (r: BulkResult, okKey: string, vars: Record<string, string | number> = {}) => {
    if (!r.failed) setNotice({ tone: 'ok', text: t(okKey, { n: r.ok, ...vars }) });
    else setNotice({ tone: r.ok ? 'warn' : 'danger', text: t('menu.ws.bulk.partial', { ok: formatNumber(r.ok, locale), failed: formatNumber(r.failed, locale), error: r.firstError ?? '' }) });
  };
  /** One bulk change at a time: the menu reloads after it, and the selection clears. */
  const bulk = async (ids: string[], fn: (p: Product) => Promise<unknown>, okKey: string, vars?: Record<string, string | number>, filter?: (p: Product) => boolean) => {
    if (busy) return;
    const targets = selectedProducts(ids).filter(filter ?? (() => true));
    if (!targets.length) { setNotice({ tone: 'warn', text: t('menu.ws.bulk.none') }); return; }
    setBusy(true); setNotice(null);
    const r = await runBulk(targets, fn);
    await menu.reload();
    setBusy(false);
    setSelected([]);
    report(r, okKey, vars);
  };
  const setAvailable = (ids: string[], available: boolean) => bulk(ids,
    (p) => call(`/o/${org.id}/menu/products/${p.id}/availability`, { body: { branchId, available, ...(available ? {} : { until: 'end_of_day' }) } }),
    available ? 'menu.ws.bulk.madeAvailable' : 'menu.ws.bulk.madeSoldOut', { branch: branchName },
    (p) => { const v = branchView(p, branchId); return v.offered && v.soldOut !== !available; });
  const moveTo = (ids: string[], c: Category) => bulk(ids,
    (p) => call(`/o/${org.id}/menu/products/${p.id}`, { method: 'PATCH', body: { categoryId: c.id, version: p.version } }),
    'menu.ws.bulk.moved', { category: pick(locale, c.name, c.nameAr) }, (p) => p.categoryId !== c.id);
  const archiveMany = async (ids: string[]) => {
    if (!(await confirm({ title: t('menu.ws.bulk.archiveTitle', { n: ids.length }), body: t('core.menu.archiveItem'), tone: 'danger', confirmLabel: t('core.menu.archive') }))) return;
    await bulk(ids, (p) => call(`/o/${org.id}/menu/products/${p.id}`, { method: 'DELETE' }), 'menu.ws.bulk.archived');
  };

  /** The inline switch: sold out (86) until the end of the branch's day, or available again. */
  const toggleAvailability = async (p: Product, available: boolean) => {
    if (pending.has(p.id)) return;
    setPending((s) => new Set(s).add(p.id)); setNotice(null);
    try {
      await call(`/o/${org.id}/menu/products/${p.id}/availability`, { body: { branchId, available, ...(available ? {} : { until: 'end_of_day' }) } });
      await menu.reload();
    } catch (e) { setNotice({ tone: 'danger', text: (e as Error).message }); } finally {
      setPending((s) => { const n = new Set(s); n.delete(p.id); return n; });
    }
  };

  // Categories (the rail).
  const runCat = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setNotice(null);
    try { await fn(); await menu.reload(); } catch (e) { setNotice({ tone: 'danger', text: (e as Error).message }); } finally { setBusy(false); }
  };
  const addCategory = async () => {
    const name = await prompt({ title: t('menu.ws.rail.add'), label: t('core.menu.categoryName'), maxLength: 80, confirmLabel: t('action.create') });
    if (name?.trim()) await runCat(() => call(`/o/${org.id}/menu/categories`, { body: { name: name.trim() } }));
  };
  const renameCategory = async (c: Category) => {
    const name = await prompt({ title: t('menu.ws.rail.rename'), label: t('core.menu.categoryName'), defaultValue: c.name, maxLength: 80, confirmLabel: t('action.save') });
    if (name?.trim() && name.trim() !== c.name) await runCat(() => call(`/o/${org.id}/menu/categories/${c.id}`, { method: 'PATCH', body: { name: name.trim() } }));
  };
  const archiveCategory = async (c: Category) => {
    if (!(await confirm({ title: t('core.menu.archiveCategory'), body: <bdi>{pick(locale, c.name, c.nameAr)}</bdi>, tone: 'danger', confirmLabel: t('core.menu.archive') }))) return;
    await runCat(() => call(`/o/${org.id}/menu/categories/${c.id}`, { method: 'DELETE' }));
  };
  const reorder = async (ids: string[]) => {
    setNotice(null);
    try { await call(`/o/${org.id}/menu/categories/reorder`, { body: { ids } }); await menu.reload(); }
    catch (e) { setNotice({ tone: 'danger', text: (e as Error).message }); throw e; }
  };

  // Keyboard (lib/page-commands.ts lists these in ⌘K and the ? cheat sheet).
  // Rows in the order the table shows them (it may be sorted by a column): each row's dish id is on its item cell.
  const rowEls = () => Array.from(tableRef.current?.querySelectorAll<HTMLTableRowElement>('tbody tr.rui-dt-clickable') ?? []);
  const idOf = (el: Element | undefined) => el?.querySelector<HTMLElement>('[data-row-id]')?.dataset.rowId ?? null;
  const focusedIndex = (els: HTMLTableRowElement[]) => {
    const active = document.activeElement;
    const i = els.findIndex((el) => el === active || el.contains(active));
    return i >= 0 ? i : lastRow.current ? els.findIndex((el) => idOf(el) === lastRow.current) : -1;
  };
  const act = useCallback((k: MenuKey) => {
    const els = rowEls();
    if (k === 'next' || k === 'prev') {
      const i = stepIndex(focusedIndex(els), els.length, k === 'next' ? 1 : -1);
      if (i >= 0) { els[i]!.focus(); els[i]!.scrollIntoView?.({ block: 'nearest' }); lastRow.current = idOf(els[i]); }
      return true;
    }
    if (k === 'open' || k === 'select') {
      const id = idOf(els[focusedIndex(els)]);
      const p = id ? rows.find((r) => r.id === id) : undefined;
      if (!p) return false;
      if (k === 'open' && write) setEditing(p);
      if (k === 'select' && (write || canAvail)) setSelected((s) => (s.includes(p.id) ? s.filter((x) => x !== p.id) : [...s, p.id]));
      return true;
    }
    if (k === 'add' && write && categories.length) { setEditing('new'); return true; }
    if (k === 'import' && write) { setImporting(true); return true; }
    if (k === 'search') { searchRef.current?.querySelector<HTMLInputElement>('input')?.focus(); return true; }
    return false;
  }, [rows, write, canAvail, categories.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const read = createMenuKeyReader();
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as Element | null;
      // Keys on a row of another table (or anything outside the page) are not ours.
      if (target instanceof HTMLTableRowElement && !tableRef.current?.contains(target)) return;
      const k = read(e);
      if (!k) return;
      if (act(k)) { e.preventDefault(); e.stopPropagation(); }
    };
    document.addEventListener('keydown', onKey, true); // capture: Space on a row selects before the table opens it
    return () => document.removeEventListener('keydown', onKey, true);
  }, [act]);
  usePageCommands({
    title: t('nav.menu'),
    commands: [
      { id: 'next', key: 'j', label: t('menu.ws.key.next'), keywords: 'next down dish item row', enabled: rows.length > 0, run: () => { act('next'); } },
      { id: 'prev', key: 'k', label: t('menu.ws.key.prev'), keywords: 'previous up dish item row', enabled: rows.length > 0, run: () => { act('prev'); } },
      { id: 'open', key: 'Enter', label: t('menu.ws.key.open'), keywords: 'open edit dish item sheet', enabled: write && rows.length > 0, run: () => { if (!act('open') && rows[0] && write) setEditing(rows[0]); } },
      { id: 'select', key: 'x', label: t('menu.ws.key.select'), keywords: 'select bulk space', enabled: (write || canAvail) && rows.length > 0, run: () => { act('select'); } },
      { id: 'add', key: 'n', label: t('ops.menu.add'), keywords: 'new add dish item create', enabled: write && categories.length > 0, run: () => { act('add'); } },
      { id: 'import', key: 'i', label: t('menu.ws.import.title'), keywords: 'import csv excel xlsx spreadsheet upload', enabled: write, run: () => { act('import'); } },
      { id: 'search', key: '/', label: t('menu.ws.key.search'), keywords: 'search find filter', run: () => { act('search'); } },
    ],
  });

  const chips: FilterChip[] = [
    ...(category ? [{ key: 'cat', label: pick(locale, categories.find((c) => c.id === category)?.name, categories.find((c) => c.id === category)?.nameAr), onRemove: () => setCategory('') }] : []),
    ...(q.trim() ? [{ key: 'q', label: `“${q.trim()}”`, onRemove: () => setQ('') }] : []),
    ...(availability ? [{ key: 'avail', label: t(`menu.ws.filter.${availability}`, { branch: branchName }), onRemove: () => setAvailability('') }] : []),
    ...(filters.soldOut ? [{ key: 'soldout', label: t('menu.ws.filter.soldOut'), onRemove: () => setSoldOut('') }] : []),
    ...(filters.tracked ? [{ key: 'tracked', label: t('menu.ws.filter.tracked'), onRemove: () => setTracked('') }] : []),
  ];
  const clearAll = () => { setCategory(''); setQ(''); setAvailability(''); setSoldOut(''); setTracked(''); };

  const bulkActions = (ids: string[]) => (
    <>
      {canAvail && <>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void setAvailable(ids, false)}>{t('ops.menu.soldOutToday')}</button>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void setAvailable(ids, true)}>{t('menu.ws.bulk.available')}</button>
      </>}
      {write && <>
        <Menu label={t('menu.ws.bulk.move')} items={categories.map((c) => ({ key: c.id, label: <bdi>{pick(locale, c.name, c.nameAr)}</bdi>, text: pick(locale, c.name, c.nameAr), onSelect: () => void moveTo(ids, c) }))}
          trigger={<button type="button" className="btn btn-sm" disabled={busy}>{t('menu.ws.bulk.move')}</button>} />
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setPricing(ids)}>{t('menu.ws.bulk.price')}</button>
        <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => void archiveMany(ids)}>{t('core.menu.archive')}</button>
      </>}
    </>
  );

  const header = (
    <PageHeading title={t('ops.menu.title')} subtitle={t('ops.menu.subtitle')}
      actions={write && <>
        <button type="button" className="btn" onClick={() => setImporting(true)}><MenuIcon name="upload" /> {t('core.menu.import')}</button>
        <button type="button" className="btn" onClick={() => setGroupsOpen(true)}>{t('core.menu.modifiers')}</button>
        {can('integrations:manage') && <Link className="btn" href={`/dashboard/${org.id}/integrations`}>{t('ops.menu.sync')}</Link>}
        <button type="button" className="btn btn-primary" disabled={!categories.length} onClick={() => setEditing('new')}><MenuIcon name="plus" /> {t('ops.menu.add')}</button>
      </>} />
  );

  return (
    <div className="menu-ws">
      {header}
      {confirmDialog}{promptDialog}
      {menu.error && <Notice tone="danger">{menu.error.message}</Notice>}
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      {!m ? <Skeleton lines={8} /> : !categories.length ? (
        <section className="panel">
          <EmptyState title={t('core.menu.empty')} action={write ? <span className="row">
            <button type="button" className="btn btn-primary" onClick={() => void addCategory()}>{t('menu.ws.rail.add')}</button>
            <button type="button" className="btn" onClick={() => setImporting(true)}>{t('core.menu.import')}</button>
          </span> : undefined}>{t('core.menu.emptyHint')}</EmptyState>
        </section>
      ) : (
        <WorkspacePage labels={{ start: t('ops.menu.categories'), main: t('core.menu.items') }}
          start={<CategoryRail categories={categories} counts={counts} total={items.length} selected={category} onSelect={(id) => { setCategory(id); setSelected([]); }}
            writable={write} busy={busy} onAdd={() => void addCategory()} onRename={(c) => void renameCategory(c)} onArchive={(c) => void archiveCategory(c)} onReorder={reorder} />}>
          <div className="menu-main">
            <div ref={searchRef}>
              <FilterBar search={{ value: q, onChange: setQ, label: t('menu.ws.search'), placeholder: t('menu.ws.search'), debounceMs: 200 }}
                chips={chips} onClearAll={chips.length > 1 ? clearAll : undefined}
                filters={<>
                  <SelectField label={t('menu.ws.filter.availability', { branch: branchName })} value={availability} onChange={(e) => setAvailability(e.target.value as AvailabilityFilter)}>
                    <option value="">{t('menu.ws.filter.all')}</option>
                    <option value="offered">{t('menu.ws.filter.offered', { branch: branchName })}</option>
                    <option value="not_offered">{t('menu.ws.filter.not_offered', { branch: branchName })}</option>
                  </SelectField>
                  <button type="button" className="rui-view-chip menu-chip" aria-pressed={filters.soldOut} onClick={() => setSoldOut(filters.soldOut ? '' : '1')}>{t('menu.ws.filter.soldOut')}</button>
                  <button type="button" className="rui-view-chip menu-chip" aria-pressed={filters.tracked} onClick={() => setTracked(filters.tracked ? '' : '1')}>{t('menu.ws.filter.tracked')}</button>
                </>} />
            </div>
            <div ref={tableRef}>
              <ItemsTable rows={rows} categories={categories} branchId={branchId} branchName={branchName} currency={currency} timezone={org.timezone}
                selected={shownSelection} onSelectedChange={setSelected} onOpen={write ? (p) => { lastRow.current = p.id; setEditing(p); } : undefined}
                canAvailability={canAvail} selectable={write || canAvail} pending={pending} onAvailability={(p, on) => void toggleAvailability(p, on)}
                bulkActions={bulkActions} busy={busy}
                empty={<EmptyState title={t('menu.ws.noMatch')} action={chips.length ? <button type="button" className="btn" onClick={clearAll}>{t('menu.ws.clearFilters')}</button> : undefined}>{t('menu.ws.noMatchHint')}</EmptyState>} />
            </div>
            <p className="fine menu-keys-hint" aria-hidden="true">{t('menu.ws.keysHint')}</p>
          </div>
        </WorkspacePage>
      )}
      {/* 21-ONB: the view-only menu QR (/m/<slug>) for the branch in view; ordering QRs stay on the floor pages. */}
      {m && <MenuQrCard orgId={org.id} orgSlug={org.slug} restaurantName={pick(locale, org.name, org.nameAr)} branchCode={branch?.code ?? null} />}
      <Suspense fallback={null}>
        {editing && m && <ItemSheet menu={m} product={editing === 'new' ? null : editing} branchId={branchId} defaultCategory={category || undefined}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void menu.reload(); }} />}
        {importing && <ImportSheet orgId={org.id} currency={currency} onClose={() => setImporting(false)} onImported={() => menu.reload()} />}
        {groupsOpen && m && <ModifiersSheet orgId={org.id} menu={m} reload={() => menu.reload()} onClose={() => setGroupsOpen(false)} />}
        {pricing && m && <BulkPriceSheet orgId={org.id} products={selectedProducts(pricing)} branchId={branchId} currency={currency} onClose={() => setPricing(null)}
          onDone={async (r) => { setPricing(null); setSelected([]); await menu.reload(); report(r, 'menu.ws.bulk.repriced'); }} />}
      </Suspense>
    </div>
  );
}
