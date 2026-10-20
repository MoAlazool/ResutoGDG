'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Card, DataTable, EmptyState, Field, Modal, Notice, PageHeader, SelectField, Skeleton, Tabs, TextareaField, useAction } from '@resuto/ui';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { newIdempotencyKey } from '@/lib/api';
import { dateTime, money } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { statusTone } from './tone';

type Tab = 'payments' | 'links' | 'refunds' | 'reconciliation' | 'cash' | 'alerts';

export default function PaymentsPage() {
  const { t } = useT();
  const { org, can } = useOrg();
  const [tab, setTab] = useState<Tab>('payments');
  const [collect, setCollect] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const branchId = org.branches[0]?.id;
  const config = useApi<any>(branchId && can('payments:read') ? `/o/${org.id}/payments/config?branchId=${branchId}` : null);
  const tabs: Array<{ key: Tab; label: string }> = [
    { key: 'payments', label: t('pay.dash.tab.payments') }, { key: 'links', label: t('pay.dash.tab.links') }, { key: 'refunds', label: t('pay.dash.tab.refunds') },
    ...(can('payments:reconcile') ? [{ key: 'reconciliation' as Tab, label: t('pay.dash.tab.reconciliation') }, { key: 'cash' as Tab, label: t('pay.dash.tab.cash') }] : []),
    { key: 'alerts', label: t('pay.dash.tab.alerts') },
  ];
  return (
    <ModuleGate module="pay">
      <PageHeader title={t('pay.dash.title')} subtitle={t('pay.dash.subtitle')} actions={<>
        {can('payments:collect') && <button className="btn" onClick={() => setLinkOpen(true)}>{t('pay.dash.newLink')}</button>}
        {can('payments:collect') && <button className="btn btn-primary" onClick={() => setCollect(true)}>{t('pay.dash.collect')}</button>}
      </>} />
      {config.data?.mode === 'sandbox' && <div style={{ marginBottom: 16 }}><Notice tone="warn"><Badge tone="sandbox">{t('state.sandbox')}</Badge> {t('pay.dash.mode.sandbox')}</Notice></div>}
      {can('payments:read') ? (
        <>
          <Tabs<Tab> tabs={tabs} value={tab} onChange={setTab} />
          {tab === 'payments' && <PaymentsList />}
          {tab === 'links' && <LinksList />}
          {tab === 'refunds' && <RefundsList />}
          {tab === 'reconciliation' && <Reconciliation providers={(config.data?.providers ?? []).map((p: any) => p.id)} />}
          {tab === 'cash' && <CashCount />}
          {tab === 'alerts' && <Alerts />}
        </>
      ) : <Card><EmptyState title={t('state.locked')}>payments:read</EmptyState></Card>}
      <CollectModal open={collect} onClose={() => setCollect(false)} />
      <LinkModal open={linkOpen} onClose={() => setLinkOpen(false)} />
    </ModuleGate>
  );
}

function PaymentsList() {
  const { t, locale } = useT();
  const { org } = useOrg();
  const [status, setStatus] = useState('');
  const [method, setMethod] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const qs = new URLSearchParams({ limit: '50', ...(status ? { status } : {}), ...(method ? { method } : {}), ...(cursor ? { cursor } : {}) });
  const { data, error, loading } = useApi<{ items: any[]; nextCursor: string | null }>(`/o/${org.id}/payments?${qs}`);
  return (
    <div className="stack">
      <div className="form-row" style={{ maxWidth: 520 }}>
        <SelectField label={t('pay.dash.filterStatus')} value={status} onChange={(e) => { setStatus(e.target.value); setCursor(null); }}>
          <option value="">{t('pay.dash.all')}</option>
          {['succeeded', 'pending', 'failed', 'partially_refunded', 'refunded', 'cancelled', 'expired'].map((s) => <option key={s} value={s}>{t(`pay.payment.status.${s}`)}</option>)}
        </SelectField>
        <SelectField label={t('pay.dash.filterMethod')} value={method} onChange={(e) => { setMethod(e.target.value); setCursor(null); }}>
          <option value="">{t('pay.dash.all')}</option>
          {['cash', 'card', 'wallet', 'cod', 'instapay', 'bank_transfer', 'deposit_credit'].map((m) => <option key={m} value={m}>{t(`pay.method.${m}`)}</option>)}
        </SelectField>
      </div>
      {error && <Notice tone="danger">{error.message}</Notice>}
      {loading && !data ? <Skeleton lines={6} /> : (
        <DataTable rows={data?.items ?? []} rowKey={(r) => r.id} empty={<EmptyState title={t('pay.dash.empty')} />} columns={[
          { key: 'when', header: t('pay.dash.col.when'), render: (r) => <Link href={`/dashboard/${org.id}/payments/${r.id}`}>{dateTime(r.capturedAt ?? r.createdAt, locale)}</Link> },
          { key: 'amount', header: t('pay.dash.col.amount'), align: 'end', render: (r) => <span className="num" dir="ltr">{money(r.amountMinor, r.currency, locale)}</span> },
          { key: 'method', header: t('pay.dash.col.method'), render: (r) => <>{t(`pay.method.${r.method}`)} {r.isTest && <Badge tone="sandbox">{t('pay.dash.test')}</Badge>}</> },
          { key: 'provider', header: t('pay.dash.col.provider'), render: (r) => r.provider },
          { key: 'orders', header: t('pay.dash.col.orders'), render: (r) => r.orderNumbers ?? '—' },
          { key: 'status', header: t('pay.dash.col.status'), render: (r) => <Badge tone={statusTone(r.status)}>{t(`pay.payment.status.${r.status}`)}</Badge> },
        ]} />
      )}
      {data?.nextCursor && <button className="btn" onClick={() => setCursor(data.nextCursor)}>{t('pay.dash.loadMore')}</button>}
    </div>
  );
}

function LinksList() {
  const { t, locale } = useT();
  const { org, can } = useOrg();
  const { call } = useSession();
  const { data, error, loading, reload } = useApi<{ items: any[] }>(`/o/${org.id}/payments/links`);
  const cancel = useAction(async (id: string) => { await call(`/o/${org.id}/payments/links/${id}/cancel`, { method: 'POST' }); await reload(); });
  if (loading && !data) return <Skeleton lines={5} />;
  return (
    <div className="stack">
      {(error || cancel.error) && <Notice tone="danger">{error?.message ?? cancel.error}</Notice>}
      <DataTable rows={data?.items ?? []} rowKey={(r) => r.id} empty={<EmptyState title={t('pay.dash.emptyLinks')} />} columns={[
        { key: 'purpose', header: t('pay.dash.col.purpose'), render: (r) => <>{t(`pay.purpose.${r.purpose}`)} {r.isTest && <Badge tone="sandbox">{t('pay.dash.test')}</Badge>}</> },
        { key: 'amount', header: t('pay.dash.col.amount'), align: 'end', render: (r) => <span className="num" dir="ltr">{money(r.amountMinor, r.currency, locale)}</span> },
        { key: 'status', header: t('pay.dash.col.status'), render: (r) => <Badge tone={statusTone(r.status)}>{t(`pay.status.${r.status}`)}</Badge> },
        { key: 'expires', header: t('pay.dash.col.expires'), render: (r) => dateTime(r.expiresAt, locale) },
        { key: 'link', header: t('pay.dash.col.link'), render: (r) => r.url ? (
          <div className="row" style={{ gap: 6 }}>
            <button className="btn btn-sm" onClick={() => navigator.clipboard?.writeText(r.url)}>{t('pay.split.copy')}</button>
            {can('payments:collect') && r.status === 'open' && <button className="btn btn-sm btn-ghost" disabled={cancel.pending} onClick={() => cancel.run(r.id)}>{t('pay.link.cancel')}</button>}
          </div>) : '—' },
      ]} />
    </div>
  );
}

function RefundsList() {
  const { t, locale } = useT();
  const { org } = useOrg();
  const { data, error, loading } = useApi<{ items: any[] }>(`/o/${org.id}/payments/refunds`);
  if (loading && !data) return <Skeleton lines={5} />;
  return (
    <>
      {error && <Notice tone="danger">{error.message}</Notice>}
      <DataTable rows={data?.items ?? []} rowKey={(r) => r.id} empty={<EmptyState title={t('pay.dash.emptyRefunds')} />} columns={[
        { key: 'when', header: t('pay.dash.col.when'), render: (r) => <Link href={`/dashboard/${org.id}/payments/${r.paymentId}`}>{dateTime(r.createdAt, locale)}</Link> },
        { key: 'amount', header: t('pay.dash.col.amount'), align: 'end', render: (r) => <span className="num" dir="ltr">{money(r.amountMinor, r.currency, locale)}</span> },
        { key: 'method', header: t('pay.dash.col.method'), render: (r) => t(`pay.method.${r.method}`) },
        { key: 'reason', header: t('pay.dash.col.reason'), render: (r) => r.reason },
        { key: 'status', header: t('pay.dash.col.status'), render: (r) => <div className="stack" style={{ gap: 2 }}>
          <Badge tone={r.outcomeUncertain ? 'warn' : statusTone(r.status)}>{t(`pay.refund.status.${r.status}`)}</Badge>
          {r.outcomeUncertain && <span className="fine">{t('pay.refund.uncertain')}</span>}
          {r.source && r.source !== 'resuto' && <span className="fine">{t(`pay.refund.source.${r.source}`)}</span>}</div> },
      ]} />
    </>
  );
}

const isoLocal = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

function Reconciliation({ providers }: { providers: string[] }) {
  const { t, locale } = useT();
  const { org } = useOrg();
  const { call } = useSession();
  const runs = useApi<{ items: any[] }>(`/o/${org.id}/payments/reconciliation/runs`);
  const [provider, setProvider] = useState(providers[0] ?? 'simulated');
  const [source, setSource] = useState<'provider_api' | 'statement_upload'>('provider_api');
  const [from, setFrom] = useState(isoLocal(new Date(Date.now() - 7 * 864e5)));
  const [to, setTo] = useState(isoLocal(new Date()));
  const [csv, setCsv] = useState('');
  const [detail, setDetail] = useState<any>(null);
  const run = useAction(async () => {
    const r = await call<any>(`/o/${org.id}/payments/reconciliation/runs`, { body: { provider, source, from: new Date(from).toISOString(), to: new Date(to).toISOString(), ...(source === 'statement_upload' ? { csv } : {}) } });
    await runs.reload();
    setDetail(await call(`/o/${org.id}/payments/reconciliation/runs/${r.id}`));
  });
  const open = useAction(async (id: string) => setDetail(await call(`/o/${org.id}/payments/reconciliation/runs/${id}`)));
  const resolve = useAction(async (itemId: string, resolution: string) => {
    await call(`/o/${org.id}/payments/reconciliation/items/${itemId}`, { method: 'PATCH', body: { resolution } });
    setDetail(await call(`/o/${org.id}/payments/reconciliation/runs/${detail.id}`));
  });
  const m = (v: number | null) => (v === null || v === undefined ? '—' : money(v, org.currency, locale));
  return (
    <div className="grid grid-2" style={{ alignItems: 'start' }}>
      <Card title={t('pay.recon.title')}>
        <div className="form-row">
          <SelectField label={t('pay.recon.provider')} value={provider} onChange={(e) => setProvider(e.target.value)}>
            {[...new Set([...providers, 'simulated'])].map((p) => <option key={p} value={p}>{p}</option>)}
          </SelectField>
          <SelectField label={t('pay.recon.source')} value={source} onChange={(e) => setSource(e.target.value as any)}>
            <option value="provider_api">{t('pay.recon.api')}</option>
            <option value="statement_upload">{t('pay.recon.upload')}</option>
          </SelectField>
        </div>
        <div className="form-row">
          <Field label={t('pay.recon.from')} type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
          <Field label={t('pay.recon.to')} type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        {source === 'statement_upload' && (
          <>
            <TextareaField label="CSV" hint={t('pay.recon.csvHint')} value={csv} onChange={(e) => setCsv(e.target.value)} dir="ltr" />
            <input type="file" accept=".csv,text/csv" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setCsv(await f.text()); }} />
          </>
        )}
        {run.error && <Notice tone="danger">{run.error}</Notice>}
        <button className="btn btn-primary" style={{ marginTop: 12 }} disabled={run.pending} onClick={() => run.run()}>{t('pay.recon.run')}</button>
        <div className="stack" style={{ marginTop: 18 }}>
          {(runs.data?.items ?? []).length === 0 && <p className="fine">{t('pay.dash.emptyRuns')}</p>}
          {(runs.data?.items ?? []).map((r) => (
            <button key={r.id} className="btn btn-ghost" style={{ justifyContent: 'space-between' }} onClick={() => open.run(r.id)}>
              <span>{r.provider} · {dateTime(r.createdAt, locale)}</span>
              <span>{r.totals.matched}/{r.totals.items} {t('pay.recon.matched')}</span>
            </button>
          ))}
        </div>
      </Card>
      {detail && (
        <Card title={`${detail.provider} · ${detail.source}`}>
          <div className="grid grid-3">
            <div className="stat"><span>{t('pay.recon.expected')}</span><strong dir="ltr">{m(detail.totals.expectedMinor)}</strong></div>
            <div className="stat"><span>{t('pay.recon.actual')}</span><strong dir="ltr">{m(detail.totals.actualMinor)}</strong></div>
            <div className="stat"><span>{t('pay.recon.difference')}</span><strong dir="ltr">{m(detail.totals.differenceMinor)}</strong></div>
          </div>
          <p className="fine">{t('pay.recon.matched')}: {detail.totals.matched} · {t('pay.recon.missingProvider')}: {detail.totals.missingInProvider} · {t('pay.recon.missingResuto')}: {detail.totals.missingInResuto} · {t('pay.recon.amountMismatch')}: {detail.totals.amountMismatch} · {t('pay.recon.statusMismatch')}: {detail.totals.statusMismatch} · {t('pay.recon.fees')}: {m(detail.totals.feesMinor)}</p>
          {resolve.error && <Notice tone="danger">{resolve.error}</Notice>}
          <DataTable rows={detail.items.filter((i: any) => i.status !== 'matched')} rowKey={(i: any) => i.id} empty={<EmptyState title={t('pay.recon.matched')} />} columns={[
            { key: 's', header: t('pay.dash.col.status'), render: (i: any) => <Badge tone={statusTone(i.status)}>{i.status}</Badge> },
            { key: 'ref', header: t('pay.detail.reference'), render: (i: any) => <span dir="ltr" className="fine">{i.providerTxnId ?? i.paymentId?.slice(0, 8) ?? i.dimension?.staffName ?? i.dimension?.method}</span> },
            { key: 'e', header: t('pay.recon.expected'), align: 'end', render: (i: any) => <span dir="ltr">{m(i.expectedMinor)}</span> },
            { key: 'a', header: t('pay.recon.actual'), align: 'end', render: (i: any) => <span dir="ltr">{m(i.actualMinor)}</span> },
            { key: 'r', header: t('pay.recon.resolve'), render: (i: any) => (
              <select className="select" value={i.resolution ?? 'open'} onChange={(e) => resolve.run(i.id, e.target.value)}>
                <option value="open" disabled>—</option>
                {['accepted', 'adjusted', 'escalated'].map((r) => <option key={r} value={r}>{t(`pay.recon.resolution.${r}`)}</option>)}
              </select>) },
          ]} />
        </Card>
      )}
    </div>
  );
}

function CashCount() {
  const { t, locale } = useT();
  const { org } = useOrg();
  const { call } = useSession();
  const [branchId, setBranchId] = useState(org.branches[0]?.id ?? '');
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const [from, setFrom] = useState(isoLocal(startOfDay));
  const [to, setTo] = useState(isoLocal(new Date()));
  const [expected, setExpected] = useState<any>(null);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [result, setResult] = useState<any>(null);
  const range = () => ({ branchId, from: new Date(from).toISOString(), to: new Date(to).toISOString() });
  const load = useAction(async () => { setResult(null); setExpected(await call(`/o/${org.id}/payments/reconciliation/cash/expected?${new URLSearchParams(range())}`)); });
  const key = (g: any) => `${g.method}|${g.staffId ?? ''}|${g.driverId ?? ''}`;
  const save = useAction(async () => {
    const r = await call<any>(`/o/${org.id}/payments/reconciliation/cash`, { body: { ...range(), counts: expected.groups.map((g: any) => ({
      method: g.method, staffId: g.staffId, driverId: g.driverId, countedMinor: Math.round(Number((counts[key(g)] ?? '0').replace(',', '.')) * 100) })) } });
    setResult(await call(`/o/${org.id}/payments/reconciliation/runs/${r.id}`));
  });
  const m = (v: number | null) => (v === null || v === undefined ? '—' : money(v, org.currency, locale));
  return (
    <Card title={t('pay.cash.title')}>
      <div className="form-row">
        <SelectField label={t('pay.cash.branch')} value={branchId} onChange={(e) => setBranchId(e.target.value)}>
          {org.branches.map((b) => <option key={b.id} value={b.id}>{locale === 'ar' && b.nameAr ? b.nameAr : b.name}</option>)}
        </SelectField>
        <Field label={t('pay.recon.from')} type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
        <Field label={t('pay.recon.to')} type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      <button className="btn" disabled={load.pending} onClick={() => load.run()}>{t('pay.cash.load')}</button>
      {(load.error || save.error) && <div style={{ marginTop: 12 }}><Notice tone="danger">{load.error ?? save.error}</Notice></div>}
      {expected && (expected.groups.length === 0 ? <p className="fine" style={{ marginTop: 12 }}>{t('pay.cash.none')}</p> : (
        <div className="stack" style={{ marginTop: 16 }}>
          {expected.groups.map((g: any) => (
            <div key={key(g)} className="form-row" style={{ alignItems: 'end' }}>
              <div><strong>{t(`pay.method.${g.method}`)}</strong><div className="fine">{g.staffName ?? g.driverName ?? '—'} · {g.payments}</div></div>
              <div className="stat"><span>{t('pay.cash.expected')}</span><strong style={{ fontSize: 18 }} dir="ltr">{m(g.expectedMinor)}</strong></div>
              <Field label={t('pay.cash.counted')} inputMode="decimal" dir="ltr" value={counts[key(g)] ?? ''} onChange={(e) => setCounts((c) => ({ ...c, [key(g)]: e.target.value }))} />
            </div>
          ))}
          <button className="btn btn-primary" disabled={save.pending} onClick={() => save.run()}>{t('pay.cash.save')}</button>
        </div>
      ))}
      {result && (
        <div style={{ marginTop: 16 }}>
          <DataTable rows={result.items} rowKey={(i: any) => i.id} columns={[
            { key: 'who', header: t('pay.cash.staff'), render: (i: any) => `${t(`pay.method.${i.dimension.method}`)} · ${i.dimension.staffName ?? i.dimension.driverName ?? '—'}` },
            { key: 'e', header: t('pay.cash.expected'), align: 'end', render: (i: any) => <span dir="ltr">{m(i.expectedMinor)}</span> },
            { key: 'a', header: t('pay.cash.counted'), align: 'end', render: (i: any) => <span dir="ltr">{m(i.actualMinor)}</span> },
            { key: 's', header: t('pay.dash.col.status'), render: (i: any) => <Badge tone={statusTone(i.status)}>{i.status}</Badge> },
          ]} />
        </div>
      )}
    </Card>
  );
}

function Alerts() {
  const { t, locale } = useT();
  const { org, can } = useOrg();
  const { call } = useSession();
  const { data, error, loading, reload } = useApi<{ items: any[] }>(`/o/${org.id}/payments/alerts`);
  const resolve = useAction(async (id: string) => { await call(`/o/${org.id}/payments/alerts/${id}/resolve`, { method: 'POST' }); await reload(); });
  // PAY-08: one-click provider refund of a capture Resuto never applied; the API replays a repeated click.
  const [refunded, setRefunded] = useState<string | null>(null);
  const refundAtProvider = useAction(async (a: any) => {
    const amount = a.details?.amountMinor ?? a.details?.received?.amountMinor;
    if (!window.confirm(t('pay.alert.refundConfirm', { amount: amount != null ? money(amount, a.details?.currency ?? org.currency, locale) : '', provider: a.provider ?? '' }))) return;
    await call(`/o/${org.id}/payments/alerts/${a.id}/refund`, { body: { key: `alert-${a.id}` } });
    setRefunded(a.id);
    await reload();
  });
  const refundable = (a: any) => a.status === 'open' && a.details?.refundable === true && ['late_success', 'duplicate_capture', 'overpayment_conflict', 'deposit_not_due'].includes(a.kind);
  const actionText = (a: any) => { const k = `pay.alert.action.${a.kind}`; const v = t(k); return v === k ? a.details?.action ?? null : v; };
  if (loading && !data) return <Skeleton lines={4} />;
  if (error) return <Notice tone="danger">{error.message}</Notice>;
  if (!data?.items.length) return <Card><EmptyState title={t('pay.dash.emptyAlerts')} /></Card>;
  return (
    <div className="stack">
      {refundAtProvider.error && <Notice tone="danger">{refundAtProvider.error}</Notice>}
      {data.items.map((a) => (
        <Card key={a.id}>
          <div className="spread">
            <div>
              <strong>{t(`pay.alert.${a.kind}`)}</strong>
              <div className="fine"><bdi>{a.provider}</bdi> · {dateTime(a.createdAt, locale)}{a.paymentId && <> · <Link href={`/dashboard/${org.id}/payments/${a.paymentId}`}><bdi dir="ltr">{a.paymentId.slice(0, 8)}</bdi></Link></>}</div>
              {actionText(a) && <p className="fine" style={{ margin: 0 }}>{actionText(a)}</p>}
              {refunded === a.id && <p className="fine" style={{ margin: 0 }}>{t('pay.alert.refundSent')}</p>}
            </div>
            <div className="row" style={{ gap: 6 }}>
              {refundable(a) && can('payments:refund') && <button className="btn btn-sm btn-danger" disabled={refundAtProvider.pending} onClick={() => refundAtProvider.run(a)}>{t('pay.alert.refundAtProvider')}</button>}
              {can('payments:reconcile') && <button className="btn btn-sm" disabled={resolve.pending} onClick={() => resolve.run(a.id)}>{t('pay.alert.resolve')}</button>}
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

function CollectModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, locale } = useT();
  const { org } = useOrg();
  const { call } = useSession();
  const [target, setTarget] = useState<'orderId' | 'visitId'>('orderId');
  const [id, setId] = useState('');
  const [method, setMethod] = useState('cash');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [due, setDue] = useState<number | null>(null);
  const [key, setKey] = useState(newIdempotencyKey());
  const [done, setDone] = useState(false);
  const lookup = useAction(async () => { const r = await call<any>(`/o/${org.id}/payments/due?${target}=${encodeURIComponent(id.trim())}`); setDue(r.dueMinor); if (!amount) setAmount(String(r.dueMinor / 100)); });
  const save = useAction(async () => {
    await call(`/o/${org.id}/payments/collect`, { body: { [target]: id.trim(), method, amountMinor: Math.round(Number(amount.replace(',', '.')) * 100), reference: reference || null, note: note || null, key } });
    setDone(true); setKey(newIdempotencyKey());
  });
  const close = () => { setDone(false); setDue(null); setAmount(''); setId(''); onClose(); };
  return (
    <Modal open={open} onClose={close} title={t('pay.collect.title')} footer={done ? <button className="btn btn-primary" onClick={close}>{t('action.close')}</button> : <>
      <button className="btn btn-ghost" onClick={close}>{t('action.cancel')}</button>
      <button className="btn btn-primary" disabled={save.pending || !id || !amount} onClick={() => save.run()}>{t('pay.collect.save')}</button></>}>
      {done ? <Notice tone="ok">{t('pay.collect.done')}</Notice> : (
        <>
          <div className="form-row">
            <SelectField label={t('pay.collect.target')} value={target} onChange={(e) => setTarget(e.target.value as any)}>
              <option value="orderId">{t('pay.collect.order')}</option><option value="visitId">{t('pay.collect.visit')}</option>
            </SelectField>
            <Field label="ID" value={id} dir="ltr" onChange={(e) => { setId(e.target.value); setDue(null); }} />
          </div>
          <button className="btn btn-sm" disabled={!id || lookup.pending} onClick={() => lookup.run()}>{t('pay.collect.lookup')}</button>
          {due !== null && <p className="fine">{t('pay.collect.due', { amount: money(due, org.currency, locale) })}</p>}
          <div className="form-row" style={{ marginTop: 12 }}>
            <SelectField label={t('pay.dash.col.method')} value={method} onChange={(e) => setMethod(e.target.value)}>
              {['cash', 'cod', 'instapay', 'bank_transfer', 'card'].map((m) => <option key={m} value={m}>{t(`pay.method.${m}`)}</option>)}
            </SelectField>
            <Field label={t('pay.dash.col.amount')} inputMode="decimal" dir="ltr" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          {method !== 'cash' && method !== 'cod' && <Field label={t('pay.collect.reference')} value={reference} required onChange={(e) => setReference(e.target.value)} />}
          <Field label={t('pay.collect.note')} value={note} onChange={(e) => setNote(e.target.value)} />
          {(lookup.error || save.error) && <Notice tone="danger">{lookup.error ?? save.error}</Notice>}
        </>
      )}
    </Modal>
  );
}

function LinkModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useT();
  const { org } = useOrg();
  const { call } = useSession();
  const [target, setTarget] = useState<'orderId' | 'visitId'>('orderId');
  const [id, setId] = useState('');
  const [amount, setAmount] = useState('');
  const [minutes, setMinutes] = useState('1440');
  const [description, setDescription] = useState('');
  const [url, setUrl] = useState<string | null>(null);
  const create = useAction(async () => {
    const r = await call<any>(`/o/${org.id}/payments/links`, { body: { [target]: id.trim(), ...(amount ? { amountMinor: Math.round(Number(amount.replace(',', '.')) * 100) } : {}),
      expiresInMinutes: Number(minutes) || 1440, description: description || null, key: newIdempotencyKey() } });
    setUrl(r.url);
  });
  const close = () => { setUrl(null); setId(''); setAmount(''); onClose(); };
  return (
    <Modal open={open} onClose={close} title={t('pay.link.title')} footer={url ? <button className="btn btn-primary" onClick={close}>{t('action.close')}</button> : <>
      <button className="btn btn-ghost" onClick={close}>{t('action.cancel')}</button>
      <button className="btn btn-primary" disabled={create.pending || !id} onClick={() => create.run()}>{t('action.create')}</button></>}>
      {url ? (
        <div className="stack"><Notice tone="ok">{t('pay.link.created')}</Notice><Field label={t('pay.dash.col.link')} value={url} readOnly dir="ltr" onFocus={(e) => e.target.select()} />
          <button className="btn" onClick={() => navigator.clipboard?.writeText(url)}>{t('pay.split.copy')}</button></div>
      ) : (
        <>
          <div className="form-row">
            <SelectField label={t('pay.collect.target')} value={target} onChange={(e) => setTarget(e.target.value as any)}>
              <option value="orderId">{t('pay.collect.order')}</option><option value="visitId">{t('pay.collect.visit')}</option>
            </SelectField>
            <Field label="ID" value={id} dir="ltr" onChange={(e) => setId(e.target.value)} />
          </div>
          <div className="form-row">
            <Field label={t('pay.dash.col.amount')} hint={t('pay.link.amountHint')} inputMode="decimal" dir="ltr" value={amount} onChange={(e) => setAmount(e.target.value)} />
            <Field label={t('pay.link.expires')} type="number" min={5} max={10080} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
          </div>
          <Field label={t('pay.link.description')} value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} />
          {create.error && <Notice tone="danger">{create.error}</Notice>}
        </>
      )}
    </Modal>
  );
}
