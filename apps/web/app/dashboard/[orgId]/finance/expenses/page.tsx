'use client';
import { Suspense, useState } from 'react';
import { EXPENSE_KINDS } from '@resuto/contracts';
import { Badge, DataTable, EmptyState, Field, Modal, Notice, SelectField, Skeleton, useAction, useConfirm } from '@resuto/ui';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { FinanceFrame, useMoney, usePeriod } from '../_ui/FinanceFrame';

const toMinor = (s: string) => Math.round(Number((s || '0').replace(',', '.')) * 100);

function Expenses() {
  const { t, locale } = useT();
  const { org, can } = useOrg();
  const { call } = useSession();
  const p = usePeriod();
  const m = useMoney();
  const qs = new URLSearchParams({ from: p.from, to: p.to, limit: '200', ...(p.branchId ? { branchId: p.branchId } : {}) });
  const list = useApi<any>(`/o/${org.id}/finance/expenses?${qs}`);
  const cats = useApi<{ items: Array<{ id: string; name: string; nameAr: string | null; kind: string }> }>(`/o/${org.id}/finance/expense-categories`);
  const [editing, setEditing] = useState<any | null>(null);
  const [catOpen, setCatOpen] = useState(false);
  const [confirm, confirmDialog] = useConfirm(locale);
  const remove = useAction(async (id: string) => { if (!(await confirm({ title: t('finance.exp.deleteConfirm'), tone: 'danger', confirmLabel: t('action.delete') }))) return; await call(`/o/${org.id}/finance/expenses/${id}`, { method: 'DELETE' }); await list.reload(); });
  const upload = useAction(async (id: string, file: File) => {
    const fd = new FormData(); fd.append('file', file);
    await call(`/o/${org.id}/finance/expenses/${id}/receipt`, { body: fd });
    await list.reload();
  });
  const catName = (c?: { name: string; nameAr: string | null }) => (c ? (locale === 'ar' && c.nameAr ? c.nameAr : c.name) : '');
  const writable = can('finance:write');
  return (
    <div className="stack">
      {confirmDialog}
      {writable && (
        <div className="row">
          <button className="btn btn-primary" onClick={() => setEditing({})}>{t('finance.exp.add')}</button>
          <button className="btn" onClick={() => setCatOpen(true)}>{t('finance.exp.newCategory')}</button>
        </div>
      )}
      {(list.error || remove.error || upload.error) && <Notice tone="danger">{list.error?.message ?? remove.error ?? upload.error}</Notice>}
      {list.data && <p className="fine">{t('finance.exp.total', { n: list.data.totals.count, amount: m(list.data.totals.amountMinor), net: m(list.data.totals.netMinor) })}</p>}
      {!list.data ? <Skeleton lines={6} /> : (
        <DataTable rows={list.data.items} rowKey={(r: any) => r.id} empty={<EmptyState title={t('finance.exp.empty')} />} columns={[
          { key: 'd', header: t('finance.exp.date'), render: (r: any) => <span dir="ltr">{r.incurredOn}</span> },
          { key: 'c', header: t('finance.exp.category'), render: (r: any) => <>{catName(cats.data?.items.find((c) => c.id === r.categoryId)) || r.categoryName} <Badge>{t(`finance.kind.${r.categoryKind}`)}</Badge>{r.providerSettlement && <> <Badge tone="info">{t('finance.exp.settlementBadge')}</Badge></>}</> },
          { key: 'v', header: t('finance.exp.vendor'), render: (r: any) => r.vendor ?? '—' },
          { key: 'a', header: t('finance.exp.amount'), align: 'end', render: (r: any) => <span dir="ltr" className="num">{m(r.amountMinor)}</span> },
          { key: 't', header: t('finance.exp.tax'), align: 'end', render: (r: any) => <span dir="ltr" className="num">{m(r.taxMinor)}</span> },
          { key: 'r', header: t('finance.exp.receipt'), render: (r: any) => r.receiptUrl ? <a href={r.receiptUrl} target="_blank" rel="noreferrer">{t('finance.exp.viewReceipt')}</a> : writable ? (
            <label className="btn btn-sm cursor-pointer">{t('finance.exp.upload')}
              <input type="file" accept="image/png,image/jpeg,image/webp,application/pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload.run(r.id, f); }} /></label>) : '—' },
          { key: 'x', header: '', render: (r: any) => writable && <div className="row gap-4">
            <button className="btn btn-sm btn-ghost" onClick={() => setEditing(r)}>{t('action.edit')}</button>
            <button className="btn btn-sm btn-ghost btn-danger" onClick={() => remove.run(r.id)}>{t('action.delete')}</button></div> },
        ]} />
      )}
      {editing && <ExpenseModal expense={editing} categories={cats.data?.items ?? []} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void list.reload(); }} />}
      <CategoryModal open={catOpen} onClose={() => setCatOpen(false)} onSaved={() => { setCatOpen(false); void cats.reload(); }} />
    </div>
  );
}

function ExpenseModal({ expense, categories, onClose, onSaved }: { expense: any; categories: Array<{ id: string; name: string; nameAr: string | null; kind: string }>; onClose: () => void; onSaved: () => void }) {
  const { t, locale } = useT();
  const { org } = useOrg();
  const { call } = useSession();
  const [f, setF] = useState({
    categoryId: expense.categoryId ?? categories[0]?.id ?? '', branchId: expense.branchId ?? '', amount: expense.amountMinor ? String(expense.amountMinor / 100) : '',
    tax: expense.taxMinor ? String(expense.taxMinor / 100) : '', incurredOn: expense.incurredOn ?? new Date().toISOString().slice(0, 10),
    vendor: expense.vendor ?? '', description: expense.description ?? '', paymentMethod: expense.paymentMethod ?? '',
  });
  // DF-04: only fee expenses can be a provider settlement (left out of fees under the provider-reports policy).
  const [settlement, setSettlement] = useState<boolean>(!!expense.providerSettlement);
  const isFees = categories.find((c) => c.id === f.categoryId)?.kind === 'fees';
  const save = useAction(async () => {
    const body = { categoryId: f.categoryId, branchId: f.branchId || null, amountMinor: toMinor(f.amount), taxMinor: toMinor(f.tax), incurredOn: f.incurredOn,
      vendor: f.vendor || null, description: f.description || null, paymentMethod: f.paymentMethod || null, providerSettlement: isFees && settlement };
    if (expense.id) await call(`/o/${org.id}/finance/expenses/${expense.id}`, { method: 'PATCH', body });
    else await call(`/o/${org.id}/finance/expenses`, { body });
    onSaved();
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal open onClose={onClose} title={expense.id ? t('finance.exp.edit') : t('finance.exp.add')} footer={<>
      <button className="btn btn-ghost" onClick={onClose}>{t('action.cancel')}</button>
      <button className="btn btn-primary" disabled={save.pending || !f.categoryId || toMinor(f.amount) <= 0} onClick={() => save.run()}>{t('action.save')}</button></>}>
      <div className="form-row">
        <SelectField label={t('finance.exp.category')} value={f.categoryId} onChange={set('categoryId')}>
          {categories.map((c) => <option key={c.id} value={c.id}>{locale === 'ar' && c.nameAr ? c.nameAr : c.name} · {t(`finance.kind.${c.kind}`)}</option>)}
        </SelectField>
        <SelectField label={t('finance.period.branch')} value={f.branchId} onChange={set('branchId')}>
          <option value="">{t('finance.exp.orgWide')}</option>
          {org.branches.map((b) => <option key={b.id} value={b.id}>{locale === 'ar' && b.nameAr ? b.nameAr : b.name}</option>)}
        </SelectField>
      </div>
      <div className="form-row">
        <Field label={t('finance.exp.amount')} inputMode="decimal" dir="ltr" value={f.amount} onChange={set('amount')} required />
        <Field label={t('finance.exp.tax')} inputMode="decimal" dir="ltr" value={f.tax} onChange={set('tax')} />
        <Field label={t('finance.exp.date')} type="date" value={f.incurredOn} onChange={set('incurredOn')} />
      </div>
      <div className="form-row">
        <Field label={t('finance.exp.vendor')} value={f.vendor} maxLength={120} onChange={set('vendor')} />
        <Field label={t('finance.exp.paymentMethod')} value={f.paymentMethod} maxLength={40} onChange={set('paymentMethod')} />
      </div>
      <Field label={t('finance.exp.description')} value={f.description} maxLength={500} onChange={set('description')} />
      {isFees && (
        <label className="check items-start">
          <input type="checkbox" checked={settlement} onChange={(e) => setSettlement(e.target.checked)} />
          <span>{t('finance.exp.providerSettlement')}<br /><small className="fine">{t('finance.exp.providerSettlementHelp')}</small></span>
        </label>
      )}
      {save.error && <Notice tone="danger">{save.error}</Notice>}
    </Modal>
  );
}

function CategoryModal({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const { t } = useT();
  const { org } = useOrg();
  const { call } = useSession();
  const [name, setName] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [kind, setKind] = useState<string>('other');
  const save = useAction(async () => { await call(`/o/${org.id}/finance/expense-categories`, { body: { name, nameAr: nameAr || null, kind } }); setName(''); setNameAr(''); onSaved(); });
  return (
    <Modal open={open} onClose={onClose} title={t('finance.exp.newCategory')} footer={<>
      <button className="btn btn-ghost" onClick={onClose}>{t('action.cancel')}</button>
      <button className="btn btn-primary" disabled={save.pending || !name.trim()} onClick={() => save.run()}>{t('action.create')}</button></>}>
      <Field label={t('finance.exp.categoryName')} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
      <Field label={`${t('finance.exp.categoryName')} (AR)`} value={nameAr} dir="rtl" maxLength={80} onChange={(e) => setNameAr(e.target.value)} />
      <SelectField label={t('finance.exp.categoryKind')} value={kind} onChange={(e) => setKind(e.target.value)}>
        {EXPENSE_KINDS.map((k) => <option key={k} value={k}>{t(`finance.kind.${k}`)}</option>)}
      </SelectField>
      {save.error && <Notice tone="danger">{save.error}</Notice>}
    </Modal>
  );
}

export default function ExpensesPage() {
  return <Suspense fallback={<Skeleton lines={6} />}><FinanceFrame compare={false}><Expenses /></FinanceFrame></Suspense>;
}
