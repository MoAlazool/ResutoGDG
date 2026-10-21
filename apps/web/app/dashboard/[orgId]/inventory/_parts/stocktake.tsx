'use client';
// Bulk stocktake and supplier editing (FT-25): the API had POST /inventory/stocktakes and PATCH /suppliers/:id with no
// screen. A stocktake counts every item of one branch in one go: blank rows are skipped, the variance against the system
// quantity is previewed (quantity and value) before anything is saved, and the whole count is sent once with one
// idempotency key per intent, so a double click or a retry after a timeout never records it twice.
import { useMemo, useRef, useState, type FormEvent } from 'react';
import type { StockLevelView } from '@resuto/contracts';
import { Badge, DataTable, EmptyState, Field, Modal, Notice, SelectField, Skeleton, TextareaField } from '@resuto/ui';
import { LoadError, Section, useFormat } from '@/components/charts/insights';
import { newIdempotencyKey } from '@/lib/api';
import { pick } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { unitLabel } from '@/lib/vocab';
import { varianceOf } from './stocktake-math';

export function StocktakeTab() {
  const { t, locale } = useT();
  const { org, branchId: shellBranch } = useOrg();
  const { call } = useSession();
  const f = useFormat();
  const branches = org.branches.filter((b) => b.isActive);
  const [branchId, setBranchId] = useState(branches.some((b) => b.id === shellBranch) ? shellBranch! : branches[0]?.id ?? '');
  const levels = useApi<{ items: StockLevelView[] }>(branchId ? `/o/${org.id}/inventory/levels?branchId=${branchId}` : null);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ lines: number; varianceValueMinor: number } | null>(null);
  const key = useRef(newIdempotencyKey());

  const rows = useMemo(() => levels.data?.items ?? [], [levels.data]);
  const counted = rows.map((l) => ({ l, v: varianceOf(l.quantity, counts[l.itemId] ?? '') })).filter((x) => x.v !== null);
  const invalid = rows.some((l) => (counts[l.itemId] ?? '').trim() !== '' && varianceOf(l.quantity, counts[l.itemId]!) === null);
  const varianceValue = counted.reduce((a, { l, v }) => a + Math.round(v!.delta * l.costPerUnitMinor), 0);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pending || !counted.length || invalid) return;
    setPending(true); setError(null); setDone(null);
    try {
      const r = await call<{ lines: unknown[]; varianceValueMinor: number }>(`/o/${org.id}/inventory/stocktakes`, {
        body: { branchId, lines: counted.map(({ l, v }) => ({ itemId: l.itemId, countedQuantity: v!.counted })) }, idempotencyKey: key.current,
      });
      setDone({ lines: r.lines.length, varianceValueMinor: r.varianceValueMinor });
      setCounts({});
      key.current = newIdempotencyKey(); // the next stocktake is a new intent
      await levels.reload();
    } catch (err) { setError((err as Error).message); } // same key on retry: the server returns the first result
    finally { setPending(false); }
  };

  return (
    <Section title={t('ops.stock.title')} actions={branches.length > 1 ? (
      <SelectField label={t('insights.branch.label')} value={branchId} onChange={(e) => { setBranchId(e.target.value); setCounts({}); setDone(null); key.current = newIdempotencyKey(); }}>
        {branches.map((b) => <option key={b.id} value={b.id}>{pick(locale, b.name, b.nameAr)}</option>)}
      </SelectField>
    ) : undefined}>
      <p className="fine" style={{ marginTop: 0 }}>{t('ops.stock.hint')}</p>
      <LoadError error={levels.error} retry={levels.reload} />
      {done && <Notice tone="ok">{t('ops.stock.saved', { n: f.num(done.lines), value: f.money(done.varianceValueMinor) })}</Notice>}
      {error && <Notice tone="danger">{error}</Notice>}
      {!levels.data ? <Skeleton lines={6} /> : !rows.length ? <EmptyState title={t('insights.inventory.noItems')}>{t('insights.inventory.noItemsHint')}</EmptyState> : (
        <form onSubmit={submit}>
          <DataTable rows={rows} rowKey={(l) => l.itemId} columns={[
            { key: 'item', header: t('insights.inventory.item'), render: (l) => pick(locale, l.name, l.nameAr) },
            { key: 'system', header: t('ops.stock.system'), align: 'end', render: (l) => <span className="num">{f.num(l.quantity)} {unitLabel(t, l.unit)}</span> },
            { key: 'counted', header: t('ops.stock.counted'), render: (l) => (
              <input className="input stock-count" inputMode="decimal" aria-label={t('ops.stock.countedFor', { item: pick(locale, l.name, l.nameAr) })}
                value={counts[l.itemId] ?? ''} disabled={pending} placeholder="—"
                onChange={(e) => setCounts((c) => ({ ...c, [l.itemId]: e.target.value }))} />) },
            { key: 'variance', header: t('ops.stock.variance'), align: 'end', render: (l) => {
              const v = varianceOf(l.quantity, counts[l.itemId] ?? '');
              if ((counts[l.itemId] ?? '').trim() && !v) return <Badge tone="danger">{t('ops.stock.invalid')}</Badge>;
              if (!v) return <span className="fine">—</span>;
              return <span className="num" data-tone={v.delta < 0 ? 'danger' : v.delta > 0 ? 'ok' : undefined}>{v.delta > 0 ? '+' : ''}{f.num(v.delta)} {unitLabel(t, l.unit)}</span>;
            } },
          ]} />
          <div className="spread stock-footer">
            <span className="fine">{t('ops.stock.preview', { n: f.num(counted.length), value: f.money(varianceValue) })}</span>
            <button className="btn btn-primary" disabled={pending || !counted.length || invalid}>{pending ? t('state.loading') : t('ops.stock.submit')}</button>
          </div>
        </form>
      )}
    </Section>
  );
}

interface Supplier { id: string; name: string; phone: string | null; email: string | null; notes?: string | null }

/** Edit a supplier (PATCH /inventory/suppliers/:id). */
export function SupplierModal({ supplier, onClose, onSaved }: { supplier: Supplier; onClose: () => void; onSaved: () => Promise<void> | void }) {
  const { t } = useT();
  const { org } = useOrg();
  const { call } = useSession();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    const fd = new FormData(e.currentTarget);
    const v = (k: string) => String(fd.get(k) ?? '').trim();
    setPending(true); setError(null);
    try {
      await call(`/o/${org.id}/inventory/suppliers/${supplier.id}`, { method: 'PATCH', body: { name: v('name'), phone: v('phone') || null, email: v('email') || null, notes: v('notes') || null } });
      await onSaved();
    } catch (err) { setError((err as Error).message); } finally { setPending(false); }
  };
  return (
    <Modal open onClose={onClose} title={t('ops.stock.editSupplier')}>
      <form onSubmit={submit}>
        <Field label={t('insights.inventory.supplierName')} name="name" required maxLength={120} defaultValue={supplier.name} />
        <div className="form-row">
          <Field label={t('insights.customers.phone')} name="phone" dir="ltr" maxLength={30} defaultValue={supplier.phone ?? ''} />
          <Field label={t('insights.customers.email')} name="email" type="email" dir="ltr" maxLength={200} defaultValue={supplier.email ?? ''} />
        </div>
        <TextareaField label={t('ops.stock.notes')} name="notes" maxLength={500} defaultValue={supplier.notes ?? ''} />
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>{t('action.cancel')}</button>
          <button className="btn btn-primary" disabled={pending}>{pending ? t('state.loading') : t('action.save')}</button>
        </div>
      </form>
    </Modal>
  );
}
