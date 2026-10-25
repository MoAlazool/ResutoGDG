'use client';
import { useMemo, useState, type FormEvent } from 'react';
import type { AnalyticsMeta, Currency, InventoryItemView, InventoryUnit, StockLevelView, StockMovementView } from '@resuto/contracts';
import { INVENTORY_UNITS, WASTE_REASONS, parseMajor, unitsCompatible } from '@resuto/contracts/lite';
import { Badge, DataTable, EmptyState, Field, Modal, Notice, SelectField, Skeleton, Stat, TextareaField, useAction, Phone, UserText } from '@resuto/ui';
import { BarList } from '@/components/charts';
import { LoadError, MetaPanel, PeriodPicker, presetPeriod, qs, Section, useBranchName, useFormat, type Period } from '@/components/charts/insights';
import { newIdempotencyKey } from '@/lib/api';
import { dateTime, pick } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useBranchScope, useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { unitLabel } from '@/lib/vocab';
import { SupplierModal } from './stocktake';

const majorOf = (minor: number) => (minor / 100).toFixed(2);

function useInv() {
  const { org } = useOrg();
  const session = useSession();
  const base = `/o/${org.id}/inventory`;
  return { base, call: session.call, toMinor: (v: string) => parseMajor(v.replace(/[,\s]/g, '') || '0', org.currency as Currency) };
}

function Loading() { return <div className="card"><Skeleton lines={5} /></div>; }

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------
export function LevelsTab({ onRecord }: { onRecord?: () => void }) {
  const { t, locale } = useT();
  const f = useFormat();
  const branchName = useBranchName();
  const { base } = useInv();
  const { branchId } = useBranchScope({ allowAll: true }); // the shell's branch switcher (21-SHELL)
  const [onlyLow, setOnlyLow] = useState(false);
  const { data, error, loading, reload } = useApi<{ items: StockLevelView[] }>(`${base}/levels${qs({ branchId })}`);
  const rows = (data?.items ?? []).filter((l) => !onlyLow || l.low);
  return (
    <Section title={t('insights.inventory.tab.levels')} actions={<>
      <label className="check"><input type="checkbox" checked={onlyLow} onChange={(e) => setOnlyLow(e.target.checked)} /> {t('insights.inventory.onlyLow')}</label>
      {onRecord && <button className="btn btn-sm btn-primary" onClick={onRecord}>{t('insights.inventory.record')}</button>}
    </>}>
      <LoadError error={error} retry={reload} />
      {loading && !data ? <Skeleton lines={5} /> : (
        <DataTable rows={rows} rowKey={(l) => `${l.branchId}:${l.itemId}`} empty={<EmptyState title={t('insights.inventory.noItems')}>{t('insights.inventory.noItemsHint')}</EmptyState>} columns={[
          { key: 'item', header: t('insights.inventory.item'), render: (l) => pick(locale, l.name, l.nameAr) },
          { key: 'branch', header: t('insights.branch.label'), render: (l) => branchName(l.branchId) },
          { key: 'qty', header: t('insights.inventory.onHand'), align: 'end', render: (l) => <span className="num">{f.num(l.quantity)} {unitLabel(t, l.unit)}</span> },
          { key: 'reorder', header: t('insights.inventory.reorderLevel'), align: 'end', render: (l) => <span className="num">{l.reorderLevel ? `${f.num(l.reorderLevel)} ${unitLabel(t, l.unit)}` : '—'}</span> },
          { key: 'value', header: t('insights.inventory.value'), align: 'end', render: (l) => <span className="num">{f.money(l.valueMinor)}</span> },
          { key: 'status', header: t('insights.inventory.status'), render: (l) => l.quantity < 0 ? <Badge tone="danger">{t('insights.inventory.negative')}</Badge>
            : l.low ? <Badge tone="warn">{t('insights.inventory.low')}</Badge> : <Badge tone="ok">✓ {t('insights.inventory.ok')}</Badge> },
          { key: 'counted', header: t('insights.inventory.lastCounted'), render: (l) => <span className="fine">{l.lastCountedAt ? dateTime(l.lastCountedAt, locale) : t('insights.inventory.never')}</span> },
        ]} />
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Record a movement
// ---------------------------------------------------------------------------
type Kind = 'purchase' | 'waste' | 'adjustment' | 'transfer' | 'count';

export function MovementTab() {
  const { t, locale } = useT();
  const { org } = useOrg();
  const f = useFormat();
  const { base, call, toMinor } = useInv();
  const items = useApi<{ items: InventoryItemView[] }>(`${base}/items`);
  const suppliers = useApi<{ items: Array<{ id: string; name: string }> }>(`${base}/suppliers`);
  const firstBranch = org.branches.find((b) => b.isActive)?.id ?? '';
  const [kind, setKind] = useState<Kind>('purchase');
  const [form, setForm] = useState({ itemId: '', branchId: firstBranch, toBranchId: '', quantity: '', unit: '', unitCost: '', supplierId: '', reason: 'expired', direction: 'out', note: '' });
  const [key, setKey] = useState(newIdempotencyKey);
  const [result, setResult] = useState<any>(null);
  const item = items.data?.items.find((i) => i.id === form.itemId);
  const units = item ? INVENTORY_UNITS.filter((u) => unitsCompatible(u, item.unit)) : [];
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const action = useAction(async (e: FormEvent) => {
    e.preventDefault();
    const q = Number(form.quantity);
    const unit = (form.unit || item?.unit) as InventoryUnit;
    const common = { itemId: form.itemId, note: form.note || undefined, unit };
    const body = kind === 'purchase' ? { kind, branchId: form.branchId, ...common, quantity: q, unitCostMinor: form.unitCost ? toMinor(form.unitCost) : undefined, supplierId: form.supplierId || undefined }
      : kind === 'waste' ? { kind, branchId: form.branchId, ...common, quantity: q, reason: form.reason }
        : kind === 'adjustment' ? { kind, branchId: form.branchId, ...common, quantityDelta: form.direction === 'out' ? -q : q }
          : kind === 'transfer' ? { kind, fromBranchId: form.branchId, toBranchId: form.toBranchId, ...common, quantity: q }
            : { kind, branchId: form.branchId, ...common, countedQuantity: q };
    const res = await call(`${base}/movements`, { method: 'POST', body, idempotencyKey: key });
    setResult(res);
    setKey(newIdempotencyKey());
    setForm({ ...form, quantity: '', note: '', unitCost: '' });
  });
  if (items.error) return <LoadError error={items.error} retry={items.reload} />;
  if (!items.data) return <Loading />;
  if (!items.data.items.length) return <div className="card"><EmptyState title={t('insights.inventory.noItems')}>{t('insights.inventory.noItemsHint')}</EmptyState></div>;
  const branches = org.branches.filter((b) => b.isActive);
  return (
    <div className="grid grid-2 items-start">
      <Section title={t('insights.inventory.record')}>
        <div role="radiogroup" aria-label={t('insights.inventory.kind')} className="row gap-6 mbe-14">
          {(['purchase', 'waste', 'adjustment', 'transfer', 'count'] as Kind[]).filter((k) => k !== 'transfer' || branches.length > 1).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} className={`btn btn-sm btn-pill ${kind === k ? 'btn-primary' : ''}`} onClick={() => { setKind(k); setResult(null); }}>
              {t(`insights.movement.${k}`)}
            </button>
          ))}
        </div>
        <form onSubmit={action.run}>
          <SelectField label={t('insights.inventory.item')} required value={form.itemId} onChange={(e) => setForm({ ...form, itemId: e.target.value, unit: '' })}>
            <option value="">{t('insights.inventory.chooseItem')}</option>
            {items.data.items.map((i) => <option key={i.id} value={i.id}>{pick(locale, i.name, i.nameAr)} ({unitLabel(t, i.unit)})</option>)}
          </SelectField>
          <div className="form-row">
            <SelectField label={kind === 'transfer' ? t('insights.movement.from') : t('insights.branch.label')} value={form.branchId} onChange={set('branchId')}>
              {branches.map((b) => <option key={b.id} value={b.id}>{pick(locale, b.name, b.nameAr)}</option>)}
            </SelectField>
            {kind === 'transfer' && (
              <SelectField label={t('insights.movement.to')} required value={form.toBranchId} onChange={set('toBranchId')}>
                <option value="">—</option>
                {branches.filter((b) => b.id !== form.branchId).map((b) => <option key={b.id} value={b.id}>{pick(locale, b.name, b.nameAr)}</option>)}
              </SelectField>
            )}
          </div>
          {kind === 'adjustment' && (
            <SelectField label={t('insights.movement.direction')} value={form.direction} onChange={set('direction')}>
              <option value="out">{t('insights.movement.decrease')}</option>
              <option value="in">{t('insights.movement.increase')}</option>
            </SelectField>
          )}
          <div className="form-row">
            <Field label={kind === 'count' ? t('insights.movement.counted') : t('insights.movement.quantity')} type="number" min={0} step="0.001" required
              value={form.quantity} onChange={set('quantity')} />
            <SelectField label={t('insights.inventory.unit')} value={form.unit || item?.unit || ''} onChange={set('unit')} disabled={!item}>
              {units.map((u) => <option key={u} value={u}>{unitLabel(t, u)}</option>)}
            </SelectField>
          </div>
          {kind === 'purchase' && (
            <div className="form-row">
              <Field label={t('insights.movement.unitCost', { unit: item ? unitLabel(t, item.unit) : '', currency: org.currency })} inputMode="decimal" value={form.unitCost} onChange={set('unitCost')}
                placeholder={item ? majorOf(item.costPerUnitMinor) : ''} hint={t('insights.movement.unitCostHint')} />
              <SelectField label={t('insights.inventory.supplier')} value={form.supplierId} onChange={set('supplierId')}>
                <option value="">—</option>
                {(suppliers.data?.items ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </SelectField>
            </div>
          )}
          {kind === 'waste' && (
            <SelectField label={t('insights.movement.reason')} value={form.reason} onChange={set('reason')}>
              {WASTE_REASONS.map((r) => <option key={r} value={r}>{t(`insights.waste.${r}`)}</option>)}
            </SelectField>
          )}
          <TextareaField label={t('insights.movement.note')} maxLength={300} value={form.note} onChange={set('note')} style={{ minHeight: 60 }} />
          {action.error && <Notice tone="danger">{action.error}</Notice>}
          <button className="btn btn-primary" disabled={action.pending || !form.itemId || !form.quantity}>{action.pending ? t('state.loading') : t('insights.movement.save')}</button>
        </form>
      </Section>
      <Section title={t('insights.movement.result')}>
        {!result ? <p className="muted">{t(`insights.movement.help.${kind}`)}</p> : (
          <div className="stack">
            <Notice tone="ok">{t('state.saved')}</Notice>
            {result.kind === 'transfer' ? (
              <p>{t('insights.movement.transferDone', { out: f.num(result.out.quantityAfter), in: f.num(result.in.quantityAfter), unit: unitLabel(t, result.unit) })}</p>
            ) : result.kind === 'count' ? (
              <div className="grid grid-3">
                <Stat label={t('insights.movement.expected')} value={`${f.num(result.expectedQuantity)} ${unitLabel(t, result.unit)}`} />
                <Stat label={t('insights.movement.counted')} value={`${f.num(result.countedQuantity)} ${unitLabel(t, result.unit)}`} />
                <Stat label={t('insights.movement.variance')} value={`${result.variance > 0 ? '+' : ''}${f.num(result.variance)} ${unitLabel(t, result.unit)}`}
                  hint={f.money(result.varianceValueMinor)} tone={result.variance < 0 ? 'danger' : result.variance > 0 ? 'warn' : 'ok'} />
              </div>
            ) : <p>{t('insights.movement.levelNow', { qty: f.num(result.quantityAfter), unit: unitLabel(t, result.unit) })}</p>}
            {result.lowStockAlertsOpened?.length > 0 && <Notice tone="warn">{t('insights.movement.lowOpened')}</Notice>}
          </div>
        )}
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Items & suppliers
// ---------------------------------------------------------------------------
export function ItemsTab() {
  const { t, locale } = useT();
  const { org, can } = useOrg();
  const f = useFormat();
  const { base, call, toMinor } = useInv();
  const [archived, setArchived] = useState(false);
  const items = useApi<{ items: InventoryItemView[] }>(`${base}/items${qs({ includeArchived: archived ? 'true' : undefined })}`);
  const suppliers = useApi<{ items: Array<{ id: string; name: string; phone: string | null; email: string | null; itemCount: number }> }>(`${base}/suppliers`);
  const [editing, setEditing] = useState<InventoryItemView | 'new' | null>(null);
  const [form, setForm] = useState({ name: '', nameAr: '', sku: '', unit: 'kg', cost: '', reorder: '0', supplierId: '' });
  const [supplier, setSupplier] = useState({ name: '', phone: '', email: '' });
  const [editingSupplier, setEditingSupplier] = useState<{ id: string; name: string; phone: string | null; email: string | null } | null>(null);
  const writable = can('inventory:write');
  const open = (i: InventoryItemView | 'new') => {
    setEditing(i);
    setForm(i === 'new' ? { name: '', nameAr: '', sku: '', unit: 'kg', cost: '', reorder: '0', supplierId: '' }
      : { name: i.name, nameAr: i.nameAr ?? '', sku: i.sku ?? '', unit: i.unit, cost: majorOf(i.costPerUnitMinor), reorder: String(i.reorderLevel), supplierId: i.supplierId ?? '' });
  };
  const save = useAction(async (e: FormEvent) => {
    e.preventDefault();
    const body = { name: form.name, nameAr: form.nameAr || null, sku: form.sku || null, costPerUnitMinor: toMinor(form.cost), reorderLevel: Number(form.reorder || 0), supplierId: form.supplierId || null };
    if (editing === 'new') await call(`${base}/items`, { method: 'POST', body: { ...body, unit: form.unit } });
    else if (editing) await call(`${base}/items/${editing.id}`, { method: 'PATCH', body });
    setEditing(null);
    await items.reload();
  });
  const archive = useAction(async (i: InventoryItemView) => {
    await call(`${base}/items/${i.id}`, { method: 'PATCH', body: { isActive: !i.isActive } });
    await items.reload();
  });
  const addSupplier = useAction(async (e: FormEvent) => {
    e.preventDefault();
    await call(`${base}/suppliers`, { method: 'POST', body: { name: supplier.name, phone: supplier.phone || null, email: supplier.email || null } });
    setSupplier({ name: '', phone: '', email: '' });
    await suppliers.reload();
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  return (
    <div className="stack gap-16">
      <Section title={t('insights.inventory.tab.items')} actions={<>
        <label className="check"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> {t('insights.inventory.showArchived')}</label>
        {writable && <button className="btn btn-sm btn-primary" onClick={() => open('new')}>{t('insights.inventory.newItem')}</button>}
      </>}>
        <LoadError error={items.error} retry={items.reload} />
        {archive.error && <Notice tone="danger">{archive.error}</Notice>}
        {!items.data ? <Skeleton lines={4} /> : (
          <DataTable rows={items.data.items} rowKey={(i) => i.id} empty={<EmptyState title={t('insights.inventory.noItems')}>{t('insights.inventory.noItemsHint')}</EmptyState>} columns={[
            { key: 'name', header: t('insights.inventory.item'), render: (i) => <>{pick(locale, i.name, i.nameAr)} {!i.isActive && <Badge>{t('insights.inventory.archived')}</Badge>}</> },
            { key: 'unit', header: t('insights.inventory.unit'), render: (i) => unitLabel(t, i.unit) },
            { key: 'cost', header: t('insights.inventory.costPerUnit'), align: 'end', render: (i) => <span className="num">{f.money(i.costPerUnitMinor)} / {unitLabel(t, i.unit)}</span> },
            { key: 'reorder', header: t('insights.inventory.reorderLevel'), align: 'end', render: (i) => <span className="num">{f.num(i.reorderLevel)}</span> },
            { key: 'total', header: t('insights.inventory.onHandAll'), align: 'end', render: (i) => <span className="num">{f.num(i.totalQuantity)} {unitLabel(t, i.unit)}</span> },
            { key: 'supplier', header: t('insights.inventory.supplier'), render: (i) => i.supplierName ?? '—' },
            ...(writable ? [{ key: 'actions', header: '', align: 'end' as const, render: (i: InventoryItemView) => (
              <span className="row justify-end gap-6">
                <button className="btn btn-sm" onClick={() => open(i)}>{t('action.edit')}</button>
                <button className="btn btn-sm btn-ghost" onClick={() => archive.run(i)}>{i.isActive ? t('insights.inventory.archive') : t('insights.inventory.restore')}</button>
              </span>) }] : []),
          ]} />
        )}
      </Section>
      <Section title={t('insights.inventory.suppliers')}>
        {suppliers.data && (
          <DataTable rows={suppliers.data.items} rowKey={(s) => s.id} onRowClick={writable ? (s) => setEditingSupplier(s) : undefined} empty={<EmptyState title={t('insights.inventory.noSuppliers')} />} columns={[
            { key: 'name', header: t('insights.inventory.supplier'), render: (s) => s.name },
            { key: 'phone', header: t('insights.customers.phone'), render: (s) => <span dir="ltr">{s.phone ?? '—'}</span> },
            { key: 'email', header: t('insights.customers.email'), render: (s) => s.email ?? '—' },
            { key: 'items', header: t('insights.inventory.items'), align: 'end', render: (s) => s.itemCount },
            ...(writable ? [{ key: 'edit', header: '', align: 'end' as const, render: (s: { id: string; name: string; phone: string | null; email: string | null }) => (
              <button type="button" className="btn btn-sm btn-ghost" onClick={(e) => { e.stopPropagation(); setEditingSupplier(s); }}>{t('action.edit')}</button>) }] : []),
          ]} />
        )}
        {editingSupplier && <SupplierModal supplier={editingSupplier} onClose={() => setEditingSupplier(null)} onSaved={async () => { setEditingSupplier(null); await Promise.all([suppliers.reload(), items.reload()]); }} />}
        {writable && (
          <form onSubmit={addSupplier.run} className="form-row mbs-14 items-end">
            <Field label={t('insights.inventory.supplierName')} required value={supplier.name} onChange={(e) => setSupplier({ ...supplier, name: e.target.value })} />
            <Field label={t('insights.customers.phone')} dir="ltr" value={supplier.phone} onChange={(e) => setSupplier({ ...supplier, phone: e.target.value })} />
            <Field label={t('insights.customers.email')} type="email" value={supplier.email} onChange={(e) => setSupplier({ ...supplier, email: e.target.value })} />
            <div className="field"><button className="btn" disabled={addSupplier.pending || !supplier.name}>{t('insights.inventory.addSupplier')}</button></div>
            {addSupplier.error && <Notice tone="danger">{addSupplier.error}</Notice>}
          </form>
        )}
      </Section>
      <Modal open={editing !== null} onClose={() => setEditing(null)} title={editing === 'new' ? t('insights.inventory.newItem') : t('insights.inventory.editItem')}>
        <form onSubmit={save.run}>
          <div className="form-row">
            <Field label={t('insights.inventory.name')} required value={form.name} onChange={set('name')} />
            <Field label={t('insights.inventory.nameAr')} dir="rtl" value={form.nameAr} onChange={set('nameAr')} />
          </div>
          <div className="form-row">
            <SelectField label={t('insights.inventory.unit')} value={form.unit} onChange={set('unit')} disabled={editing !== 'new'} hint={editing !== 'new' ? t('insights.inventory.unitLocked') : t('insights.inventory.unitHint')}>
              {INVENTORY_UNITS.map((u) => <option key={u} value={u}>{t(`insights.unit.${u}`)}</option>)}
            </SelectField>
            <Field label={t('insights.inventory.costPerUnitIn', { unit: unitLabel(t, form.unit), currency: org.currency })} inputMode="decimal" required value={form.cost} onChange={set('cost')} />
          </div>
          <div className="form-row">
            <Field label={t('insights.inventory.reorderLevelIn', { unit: unitLabel(t, form.unit) })} type="number" min={0} step="0.001" value={form.reorder} onChange={set('reorder')} hint={t('insights.inventory.reorderHint')} />
            <Field label="SKU" value={form.sku} onChange={set('sku')} />
          </div>
          <SelectField label={t('insights.inventory.supplier')} value={form.supplierId} onChange={set('supplierId')}>
            <option value="">—</option>
            {(suppliers.data?.items ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </SelectField>
          {save.error && <Notice tone="danger">{save.error}</Notice>}
          <div className="row justify-end">
            <button type="button" className="btn btn-ghost" onClick={() => setEditing(null)}>{t('action.cancel')}</button>
            <button className="btn btn-primary" disabled={save.pending}>{t('action.save')}</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------
interface RecipeRow { productId: string; name: string; nameAr: string | null; priceMinor: number; costMinor: number | null; components: number; recipeCostMinor: number | null }
interface Recipe { productId: string; name: string; priceMinor: number; productCostMinor: number | null; recipeCostMinor: number;
  components: Array<{ itemId: string; name: string; quantity: number; unit: InventoryUnit; costMinor: number }> }

export function RecipesTab() {
  const { t, locale } = useT();
  const { can } = useOrg();
  const f = useFormat();
  const { base, call } = useInv();
  const list = useApi<{ items: RecipeRow[] }>(`${base}/recipes`);
  const items = useApi<{ items: InventoryItemView[] }>(`${base}/items`);
  const [productId, setProductId] = useState<string | null>(null);
  const recipe = useApi<Recipe>(productId ? `${base}/recipes/${productId}` : null);
  const [rows, setRows] = useState<Array<{ itemId: string; quantity: string; unit: InventoryUnit }> | null>(null);
  const writable = can('inventory:write');
  const editRows = rows ?? recipe.data?.components.map((c) => ({ itemId: c.itemId, quantity: String(c.quantity), unit: c.unit })) ?? [];
  const save = useAction(async () => {
    await call(`${base}/recipes/${productId}`, { method: 'PUT', body: { components: editRows.filter((r) => r.itemId).map((r) => ({ itemId: r.itemId, quantity: Number(r.quantity), unit: r.unit })) } });
    setRows(null);
    await Promise.all([recipe.reload(), list.reload()]);
  });
  const itemById = useMemo(() => new Map((items.data?.items ?? []).map((i) => [i.id, i])), [items.data]);
  const update = (i: number, patch: Partial<{ itemId: string; quantity: string; unit: InventoryUnit }>) => {
    const next = editRows.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
    if (patch.itemId) { const it = itemById.get(patch.itemId); if (it && !unitsCompatible(next[i]!.unit, it.unit)) next[i]!.unit = it.unit; }
    setRows(next);
  };
  if (list.error) return <LoadError error={list.error} retry={list.reload} />;
  if (!list.data) return <Loading />;
  return (
    <div className="grid grid-2 items-start">
      <Section title={t('insights.inventory.tab.recipes')}>
        <DataTable rows={list.data.items} rowKey={(r) => r.productId} onRowClick={(r) => { setProductId(r.productId); setRows(null); }}
          empty={<EmptyState title={t('insights.recipes.noProducts')} />} columns={[
            { key: 'name', header: t('insights.products.product'), render: (r) => <strong style={{ fontWeight: r.productId === productId ? 750 : 500 }}>{pick(locale, r.name, r.nameAr)}</strong> },
            { key: 'n', header: t('insights.recipes.ingredients'), align: 'end', render: (r) => r.components || <span className="fine">{t('insights.recipes.none')}</span> },
            { key: 'cost', header: t('insights.recipes.recipeCost'), align: 'end', render: (r) => <span className="num">{r.recipeCostMinor === null ? '—' : f.money(r.recipeCostMinor)}</span> },
            { key: 'price', header: t('insights.recipes.price'), align: 'end', render: (r) => <span className="num">{f.money(r.priceMinor)}</span> },
          ]} />
      </Section>
      <Section title={recipe.data ? recipe.data.name : t('insights.recipes.choose')}>
        {!productId ? <p className="muted">{t('insights.recipes.help')}</p> : !recipe.data ? <Skeleton lines={3} /> : (
          <div className="stack">
            <div className="grid grid-3">
              <Stat label={t('insights.recipes.recipeCost')} value={f.money(recipe.data.recipeCostMinor)} />
              <Stat label={t('insights.recipes.price')} value={f.money(recipe.data.priceMinor)} />
              <Stat label={t('insights.recipes.foodCost')} value={recipe.data.priceMinor ? f.pct(Math.round((recipe.data.recipeCostMinor / recipe.data.priceMinor) * 10000) / 100) : '—'} />
            </div>
            {recipe.data.productCostMinor !== null && recipe.data.productCostMinor !== recipe.data.recipeCostMinor && recipe.data.components.length > 0 && (
              <Notice>{t('insights.recipes.costDiffers', { value: f.money(recipe.data.productCostMinor) })}</Notice>
            )}
            {editRows.map((r, i) => {
              const it = itemById.get(r.itemId);
              return (
                <div key={i} className="row gap-8 items-end">
                  <label className="field" style={{ flex: '2 1 160px', margin: 0 }}><span>{t('insights.inventory.item')}</span>
                    <select className="select" value={r.itemId} disabled={!writable} onChange={(e) => update(i, { itemId: e.target.value })}>
                      <option value="">—</option>
                      {(items.data?.items ?? []).map((x) => <option key={x.id} value={x.id}>{pick(locale, x.name, x.nameAr)}</option>)}
                    </select></label>
                  <label className="field" style={{ flex: '1 1 80px', margin: 0 }}><span>{t('insights.movement.quantity')}</span>
                    <input className="input" type="number" min={0} step="0.001" value={r.quantity} disabled={!writable} onChange={(e) => update(i, { quantity: e.target.value })} /></label>
                  <label className="field" style={{ flex: '0 1 90px', margin: 0 }}><span>{t('insights.inventory.unit')}</span>
                    <select className="select" value={r.unit} disabled={!writable} onChange={(e) => update(i, { unit: e.target.value as InventoryUnit })}>
                      {(it ? INVENTORY_UNITS.filter((u) => unitsCompatible(u, it.unit)) : INVENTORY_UNITS).map((u) => <option key={u} value={u}>{unitLabel(t, u)}</option>)}
                    </select></label>
                  {writable && <button type="button" className="btn btn-sm btn-ghost" aria-label={t('action.delete')} onClick={() => setRows(editRows.filter((_, idx) => idx !== i))}>✕</button>}
                </div>
              );
            })}
            {!editRows.length && <p className="muted">{t('insights.recipes.empty')}</p>}
            {writable && (
              <div className="row">
                <button type="button" className="btn btn-sm" onClick={() => setRows([...editRows, { itemId: '', quantity: '', unit: 'g' }])}>{t('insights.recipes.addIngredient')}</button>
                <button type="button" className="btn btn-sm btn-primary" disabled={save.pending || rows === null} onClick={() => save.run()}>{t('action.save')}</button>
              </div>
            )}
            {save.error && <Notice tone="danger">{save.error}</Notice>}
            <p className="fine">{t('insights.recipes.deductNote')}</p>
          </div>
        )}
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Low stock
// ---------------------------------------------------------------------------
export function AlertsTab() {
  const { t, locale } = useT();
  const f = useFormat();
  const branchName = useBranchName();
  const { base } = useInv();
  const { branchId } = useBranchScope({ allowAll: true }); // the shell's branch switcher (21-SHELL)
  const { data, error, reload } = useApi<{ items: Array<{ id: string; branchId: string; name: string; nameAr: string | null; unit: string; quantity: number; reorderLevel: number; openedAt: string; supplierName: string | null; supplierPhone: string | null }> }>(`${base}/alerts${qs({ branchId })}`, { pollMs: 60_000 });
  return (
    <Section title={t('insights.inventory.tab.alerts')}>
      <LoadError error={error} retry={reload} />
      {!data ? <Skeleton lines={3} /> : (
        <DataTable rows={data.items} rowKey={(a) => a.id} empty={<EmptyState title={t('insights.overview.stockOk')} />} columns={[
          { key: 'item', header: t('insights.inventory.item'), render: (a) => <><Badge tone="warn">!</Badge> {pick(locale, a.name, a.nameAr)}</> },
          { key: 'branch', header: t('insights.branch.label'), render: (a) => branchName(a.branchId) },
          { key: 'qty', header: t('insights.inventory.onHand'), align: 'end', render: (a) => <span className="num">{f.num(a.quantity)} {unitLabel(t, a.unit)}</span> },
          { key: 'reorder', header: t('insights.inventory.reorderLevel'), align: 'end', render: (a) => <span className="num">{f.num(a.reorderLevel)} {unitLabel(t, a.unit)}</span> },
          { key: 'since', header: t('insights.inventory.since'), render: (a) => <span className="fine">{dateTime(a.openedAt, locale)}</span> },
          { key: 'supplier', header: t('insights.inventory.supplier'), render: (a) => a.supplierName ? <><UserText>{a.supplierName}</UserText> {a.supplierPhone && <span className="fine"><Phone value={a.supplierPhone} link /></span>}</> : '—' },
        ]} />
      )}
      <p className="fine mbs-10">{t('insights.inventory.alertsHint')}</p>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Valuation and waste report
// ---------------------------------------------------------------------------
interface Waste {
  totals: { valueMinor: number; entries: number; massKg: number; volumeL: number; pieces: number; purchasesValueMinor: number; wasteToPurchasesPct: number | null };
  byReason: Array<{ reason: string; valueMinor: number }>;
  byItem: Array<{ itemId: string; name: string; nameAr: string | null; unit: string; reason: string; quantity: number; valueMinor: number }>;
  meta: AnalyticsMeta;
}

export function ValueWasteTab() {
  const { t, locale } = useT();
  const { org } = useOrg();
  const f = useFormat();
  const { base } = useInv();
  const { branchId } = useBranchScope({ allowAll: true }); // the shell's branch switcher (21-SHELL)
  const [period, setPeriod] = useState<Period>(() => presetPeriod('30d', org.timezone));
  const valuation = useApi<{ totalValueMinor: number; branches: Array<{ branchId: string; branchName: string; valueMinor: number; itemsInStock: number; negativeLevels: number; itemsWithoutCost: number }>; meta: AnalyticsMeta }>(`${base}/valuation${qs({ branchId })}`);
  const waste = useApi<Waste>(`${base}/waste-report${qs({ from: period.from, to: period.to, branchId })}`);
  return (
    <div className="stack gap-16">
      <Section title={t('insights.inventory.valuation')}>
        <LoadError error={valuation.error} retry={valuation.reload} />
        {!valuation.data ? <Skeleton lines={2} /> : (
          <>
            <div className="grid grid-3">
              <Stat label={t('insights.inventory.totalValue')} value={f.money(valuation.data.totalValueMinor)} />
              {valuation.data.branches.map((b) => <Stat key={b.branchId} label={b.branchName} value={f.money(b.valueMinor)}
                hint={b.negativeLevels ? t('insights.inventory.negativeCount', { count: b.negativeLevels }) : t('insights.inventory.inStock', { count: b.itemsInStock })}
                tone={b.negativeLevels ? 'warn' : undefined} />)}
            </div>
            <MetaPanel meta={valuation.data.meta} />
          </>
        )}
      </Section>
      <Section title={t('insights.inventory.wasteReport')} actions={<PeriodPicker value={period} onChange={setPeriod} />}>
        <LoadError error={waste.error} retry={waste.reload} />
        {!waste.data ? <Skeleton lines={3} /> : waste.data.totals.entries === 0 ? <p className="muted">{t('insights.sust.noWaste')}</p> : (
          <div className="stack">
            <div className="grid grid-4">
              <Stat label={t('insights.sust.wasteValue')} value={f.money(waste.data.totals.valueMinor)} hint={t('insights.sust.entries', { count: waste.data.totals.entries })} />
              <Stat label={t('insights.sust.mass')} value={`${f.num(waste.data.totals.massKg)} kg`} hint={waste.data.totals.volumeL ? `${f.num(waste.data.totals.volumeL)} L` : undefined} />
              <Stat label={t('insights.sust.pieces')} value={f.num(waste.data.totals.pieces)} />
              <Stat label={t('insights.sust.wasteToPurchases')} value={f.pct(waste.data.totals.wasteToPurchasesPct)} />
            </div>
            <div className="grid grid-2">
              <div><h3>{t('insights.inventory.byReason')}</h3>
                <BarList format={f.money} items={waste.data.byReason.map((r) => ({ key: r.reason, label: t(`insights.waste.${r.reason}`), value: r.valueMinor }))} /></div>
              <div><h3>{t('insights.inventory.byItem')}</h3>
                <BarList format={f.money} items={waste.data.byItem.slice(0, 10).map((r) => ({ key: `${r.itemId}:${r.reason}`, label: pick(locale, r.name, r.nameAr), value: r.valueMinor,
                  hint: `${f.num(r.quantity)} ${unitLabel(t, r.unit)} · ${t(`insights.waste.${r.reason}`)}` }))} /></div>
            </div>
          </div>
        )}
        {waste.data && <MetaPanel meta={waste.data.meta} />}
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Movement history
// ---------------------------------------------------------------------------
export function HistoryTab() {
  const { t, locale } = useT();
  const f = useFormat();
  const branchName = useBranchName();
  const { base, call } = useInv();
  const { branchId } = useBranchScope({ allowAll: true }); // the shell's branch switcher (21-SHELL)
  const [reason, setReason] = useState('');
  const first = useApi<{ items: StockMovementView[]; nextCursor: string | null }>(`${base}/movements${qs({ branchId, reason, limit: 50 })}`);
  const [more, setMore] = useState<{ items: StockMovementView[]; nextCursor: string | null } | null>(null);
  const rows = [...(first.data?.items ?? []), ...(more?.items ?? [])];
  const cursor = more ? more.nextCursor : first.data?.nextCursor;
  const loadMore = useAction(async () => {
    const page = await call<{ items: StockMovementView[]; nextCursor: string | null }>(`${base}/movements${qs({ branchId, reason, limit: 50, cursor: cursor ?? undefined })}`);
    setMore({ items: [...(more?.items ?? []), ...page.items], nextCursor: page.nextCursor });
  });
  const reasons = ['purchase', 'sale', 'waste', 'adjustment', 'transfer_in', 'transfer_out', 'count', 'return'];
  return (
    <Section title={t('insights.inventory.tab.history')} actions={<>
      <select className="select" style={{ width: 'auto', minHeight: 38 }} value={reason} aria-label={t('insights.movement.reason')} onChange={(e) => { setReason(e.target.value); setMore(null); }}>
        <option value="">{t('insights.movement.allKinds')}</option>
        {reasons.map((r) => <option key={r} value={r}>{t(`insights.reason.${r}`)}</option>)}
      </select>
    </>}>
      <LoadError error={first.error} retry={first.reload} />
      {!first.data ? <Skeleton lines={5} /> : (
        <DataTable rows={rows} rowKey={(m) => m.id} empty={<EmptyState title={t('insights.inventory.noMovements')} />} columns={[
          { key: 'at', header: t('insights.inventory.when'), render: (m) => <span className="fine">{dateTime(m.createdAt, locale)}</span> },
          { key: 'item', header: t('insights.inventory.item'), render: (m) => m.itemName },
          { key: 'branch', header: t('insights.branch.label'), render: (m) => branchName(m.branchId) },
          { key: 'kind', header: t('insights.movement.reason'), render: (m) => <>{t(`insights.reason.${m.reason}`)}{m.wasteReason && <span className="fine"> · {t(`insights.waste.${m.wasteReason}`)}</span>}</> },
          { key: 'qty', header: t('insights.movement.quantity'), align: 'end', render: (m) => <span className="num" style={{ color: m.quantityDelta < 0 ? 'var(--danger)' : 'var(--ok)' }}>{m.quantityDelta > 0 ? '+' : ''}{f.num(m.quantityDelta)} {unitLabel(t, m.unit)}</span> },
          { key: 'note', header: t('insights.movement.note'), render: (m) => <span className="fine">{m.note ?? (m.referenceType === 'order' ? t('insights.inventory.fromOrder') : '')}</span> },
        ]} />
      )}
      {cursor && <div className="row mbs-12"><button className="btn btn-sm" disabled={loadMore.pending} onClick={() => loadMore.run()}>{t('insights.loadMore')}</button></div>}
    </Section>
  );
}
