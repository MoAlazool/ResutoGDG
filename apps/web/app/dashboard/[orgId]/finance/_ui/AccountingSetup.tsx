'use client';
import { JOURNAL_ACCOUNT_ROLES, parseMajor, type Currency, type FinancePayout, type FinancePolicy } from '@resuto/contracts';
import { useEffect, useState, type FormEvent } from 'react';
import { Badge, Card, DataTable, EmptyState, Field, Notice, SelectField, Skeleton, useAction } from '@resuto/ui';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { useMoney, usePeriod } from './FinanceFrame';

/** DF-04: the accounting policy that decides which source each cost comes from (never both). */
export function PolicyCard({ onSaved }: { onSaved?: () => void }) {
  const { t } = useT();
  const { org, can } = useOrg();
  const { call } = useSession();
  const state = useApi<FinancePolicy>(`/o/${org.id}/finance/policy`);
  const [draft, setDraft] = useState<Pick<FinancePolicy, 'cogsMethod' | 'feesMethod'> | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (state.data) setDraft({ cogsMethod: state.data.cogsMethod, feesMethod: state.data.feesMethod }); }, [state.data]);
  const save = useAction(async (e: FormEvent) => {
    e.preventDefault();
    await call(`/o/${org.id}/finance/policy`, { method: 'PUT', body: draft });
    await state.reload();
    setSaved(true);
    onSaved?.();
  });
  const editable = can('finance:write');
  if (!draft) return <Card title={t('finance.policy.title')}><Skeleton lines={4} /></Card>;
  // A policy that was never saved (default or derived from the data) can be confirmed as is.
  const changed = state.data && (draft.cogsMethod !== state.data.cogsMethod || draft.feesMethod !== state.data.feesMethod || (state.data.source ?? 'saved') !== 'saved');
  return (
    <Card title={t('finance.policy.title')}>
      <p className="fine">{t('finance.policy.body')}</p>
      {state.data?.source === 'derived' && <Notice tone="warn">{t('finance.policy.derived')}</Notice>}
      {state.data?.source === 'default' && <p className="fine">{t('finance.policy.notChosen')}</p>}
      <form onSubmit={save.run} className="stack gap-12">
        <fieldset className="stack" style={{ gap: 6, border: 0, padding: 0, margin: 0 }}>
          <legend className="fine">{t('finance.policy.cogs')}</legend>
          {(['item_cost', 'purchases'] as const).map((m) => (
            <label key={m} className="check items-start">
              <input type="radio" name="cogs" disabled={!editable} checked={draft.cogsMethod === m} onChange={() => { setSaved(false); setDraft({ ...draft, cogsMethod: m }); }} />
              <span><strong>{t(`finance.policy.cogs.${m}`)}</strong><br /><small className="fine">{t(`finance.policy.cogs.${m}.help`)}</small></span>
            </label>
          ))}
        </fieldset>
        <fieldset className="stack" style={{ gap: 6, border: 0, padding: 0, margin: 0 }}>
          <legend className="fine">{t('finance.policy.fees')}</legend>
          {(['provider_reports', 'expenses'] as const).map((m) => (
            <label key={m} className="check items-start">
              <input type="radio" name="fees" disabled={!editable} checked={draft.feesMethod === m} onChange={() => { setSaved(false); setDraft({ ...draft, feesMethod: m }); }} />
              <span><strong>{t(`finance.policy.fees.${m}`)}</strong><br /><small className="fine">{t(`finance.policy.fees.${m}.help`)}</small></span>
            </label>
          ))}
        </fieldset>
        {save.error && <Notice tone="danger">{save.error}</Notice>}
        {saved && !changed && <Notice tone="ok">{t('finance.policy.saved')}</Notice>}
        {editable && <div className="row justify-end"><button className="btn btn-primary" disabled={!changed || save.pending}>{t('action.save')}</button></div>}
      </form>
    </Card>
  );
}

interface Connection { id: string; provider: string; status: string; environment: string; mappedRoles: number }
interface Mapping { connectionId: string; provider: string; accounts: Record<string, string>; needed: string[]; missing: string[] }

/** FT-23: map each Resuto account role to the account code in the restaurant's accounting system, per connection. */
export function AccountMapping() {
  const { t } = useT();
  const { org, can } = useOrg();
  const { call } = useSession();
  const p = usePeriod();
  const conns = useApi<{ items: Connection[] }>(`/o/${org.id}/finance/accounting/connections`);
  const [id, setId] = useState('');
  useEffect(() => { if (!id && conns.data?.items[0]) setId(conns.data.items[0].id); }, [conns.data, id]);
  const map = useApi<Mapping>(id ? `/o/${org.id}/finance/accounting/connections/${id}/accounts?from=${p.from}&to=${p.to}` : null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (map.data) setDraft(map.data.accounts); setSaved(false); }, [map.data]);
  const save = useAction(async (e: FormEvent) => {
    e.preventDefault();
    await call(`/o/${org.id}/finance/accounting/connections/${id}/accounts`, { method: 'PUT', body: { accounts: draft } });
    await map.reload();
    setSaved(true);
  });
  if (conns.data && !conns.data.items.length) return <Card title={t('finance.map.title')}><EmptyState title={t('finance.map.none')}>{t('finance.map.noneBody')}</EmptyState></Card>;
  const needed = new Set(map.data?.needed ?? []);
  const roles = [...JOURNAL_ACCOUNT_ROLES].sort((a, b) => Number(needed.has(b)) - Number(needed.has(a)));
  return (
    <Card title={t('finance.map.title')}>
      <p className="fine">{t('finance.map.body')}</p>
      {!conns.data ? <Skeleton lines={3} /> : (
        <SelectField label={t('finance.acc.connection')} value={id} onChange={(e) => setId(e.target.value)}>
          {conns.data.items.map((c) => <option key={c.id} value={c.id}>{c.provider} · {c.environment} · {c.status}</option>)}
        </SelectField>
      )}
      {map.data && map.data.missing.length > 0 && <Notice tone="warn">{t('finance.map.missing', { n: map.data.missing.length })}</Notice>}
      {saved && <Notice tone="ok">{t('finance.map.saved')}</Notice>}
      {map.data && (
        <form onSubmit={save.run}>
          <div className="grid grid-2" style={{ gap: '0 12px' }}>
            {roles.map((r) => (
              <Field key={r} label={<>{t(`finance.role.${r}`)} {needed.has(r) && !draft[r] && <Badge tone="warn">{t('finance.map.required')}</Badge>}</> as any}
                dir="ltr" value={draft[r] ?? ''} disabled={!can('finance:write')} maxLength={64}
                onChange={(e) => setDraft({ ...draft, [r]: e.target.value })} />
            ))}
          </div>
          {save.error && <Notice tone="danger">{save.error}</Notice>}
          {can('finance:write') && <div className="row justify-end"><button className="btn btn-primary" disabled={save.pending}>{t('action.save')}</button></div>}
        </form>
      )}
    </Card>
  );
}

/** FT-23: provider payouts (money settled to the bank) so journals clear the card/wallet clearing accounts. */
export function Payouts() {
  const { t, locale } = useT();
  const { org, can } = useOrg();
  const { call } = useSession();
  const p = usePeriod();
  const m = useMoney();
  const currency = org.currency as Currency;
  const list = useApi<{ items: FinancePayout[] }>(`/o/${org.id}/finance/payouts?${p.query}`);
  const [d, setD] = useState({ provider: 'paymob', clearing: 'card' as 'card' | 'wallet', paidOn: p.to, amount: '', fee: '', reference: '' });
  const add = useAction(async (e: FormEvent) => {
    e.preventDefault();
    await call(`/o/${org.id}/finance/payouts`, { body: {
      provider: d.provider.trim(), clearing: d.clearing, paidOn: d.paidOn, amountMinor: parseMajor(d.amount, currency),
      feeMinor: d.fee ? parseMajor(d.fee, currency) : 0, reference: d.reference.trim() || null,
    } });
    setD({ ...d, amount: '', fee: '', reference: '' });
    await list.reload();
  });
  return (
    <Card title={t('finance.payouts.title')}>
      <p className="fine">{t('finance.payouts.body')}</p>
      {can('finance:write') && (
        <form onSubmit={add.run}>
          <div className="form-row">
            <Field label={t('finance.payouts.provider')} required dir="ltr" maxLength={40} value={d.provider} onChange={(e) => setD({ ...d, provider: e.target.value })} />
            <SelectField label={t('finance.payouts.clearing')} value={d.clearing} onChange={(e) => setD({ ...d, clearing: e.target.value as 'card' | 'wallet' })}>
              <option value="card">{t('finance.role.card_clearing')}</option>
              <option value="wallet">{t('finance.role.wallet_clearing')}</option>
            </SelectField>
            <Field label={t('finance.payouts.paidOn')} type="date" required value={d.paidOn} onChange={(e) => setD({ ...d, paidOn: e.target.value })} />
          </div>
          <div className="form-row">
            <Field label={`${t('finance.payouts.amount')} (${currency})`} required inputMode="decimal" value={d.amount} onChange={(e) => setD({ ...d, amount: e.target.value })} />
            <Field label={`${t('finance.payouts.fee')} (${currency})`} inputMode="decimal" value={d.fee} hint={t('finance.payouts.feeHint')} onChange={(e) => setD({ ...d, fee: e.target.value })} />
            <Field label={t('finance.payouts.reference')} dir="ltr" maxLength={120} value={d.reference} onChange={(e) => setD({ ...d, reference: e.target.value })} />
          </div>
          {add.error && <Notice tone="danger">{add.error}</Notice>}
          <div className="row justify-end"><button className="btn" disabled={add.pending || !d.amount}>{t('finance.payouts.add')}</button></div>
        </form>
      )}
      <DataTable rows={list.data?.items ?? []} rowKey={(r) => r.id} busy={list.loading} empty={<EmptyState title={t('finance.payouts.empty')} />} columns={[
        { key: 'd', header: t('finance.payouts.paidOn'), render: (r) => <span dir="ltr">{r.paidOn}</span> },
        { key: 'p', header: t('finance.payouts.provider'), render: (r) => <bdi>{r.provider}</bdi> },
        { key: 'a', header: t('finance.payouts.amount'), align: 'end', render: (r) => <span className="num" dir="ltr">{m(r.amountMinor)}</span> },
        { key: 'f', header: t('finance.payouts.fee'), align: 'end', render: (r) => (r.feeMinor ? <span className="num" dir="ltr">{m(r.feeMinor)}</span> : '—') },
        { key: 'r', header: t('finance.payouts.reference'), render: (r) => (r.reference ? <bdi dir="ltr">{r.reference}</bdi> : '—') },
      ]} />
      <span className="fine" lang={locale}>{t('finance.payouts.journal')}</span>
    </Card>
  );
}
