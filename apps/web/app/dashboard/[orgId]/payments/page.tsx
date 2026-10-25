'use client';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import {
  Badge, Card, DataTable, DataTableV2, EmptyState, Field, FilterBar, ListPage, Notice, SelectField, Sheet, Skeleton, Tabs, TextareaField, useAction, useConfirm,
  useCursorPagination, type FilterChip,
} from '@resuto/ui';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { newIdempotencyKey } from '@/lib/api';
import { dateTime, money } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useBranchScope, useOrg } from '@/lib/org-context';
import { usePageCommands } from '@/lib/page-commands';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { paymentProviderLabel, reconSourceLabel, reconStatusLabel } from '@/lib/vocab';
import { activeFilters, datesValid, filtersFromParams, filtersToParams, NO_FILTERS, PAYMENT_METHODS, PAYMENT_STATUSES, paymentsQuery, type FilterKey, type PaymentFilters } from './filters';
import styles from './payments.module.css';
import { alertRefundMessageKey, statusTone } from './tone';

// The payment inspector (detail, refund history, refund form) loads when a payment is opened.
const PaymentSheet = dynamic(() => import('./_ui/PaymentSheet').then((m) => m.PaymentSheet), { ssr: false });

type Tab = 'payments' | 'links' | 'refunds' | 'reconciliation' | 'cash' | 'alerts';
const TABS: Tab[] = ['payments', 'links', 'refunds', 'reconciliation', 'cash', 'alerts'];

interface PaymentRow { id: string; amountMinor: number; currency: string; method: string; provider: string; status: string; isTest: boolean; capturedAt: string | null; createdAt: string; orderNumbers: string | null }

function PaymentsPage() {
  const { t } = useT();
  const { org, can } = useOrg();
  const params = useSearchParams();
  const asked = params.get('tab') as Tab | null;
  const [tab, setTab] = useState<Tab>(asked && TABS.includes(asked) ? asked : 'payments');
  const [collect, setCollect] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const { branchId: scoped } = useBranchScope({ allowAll: true });
  const configBranch = scoped || org.branches.find((b) => b.isActive)?.id || org.branches[0]?.id;
  const config = useApi<any>(configBranch && can('payments:read') ? `/o/${org.id}/payments/config?branchId=${configBranch}` : null);
  const tabs: Array<{ key: Tab; label: string }> = [
    { key: 'payments', label: t('pay.dash.tab.payments') }, { key: 'links', label: t('pay.dash.tab.links') }, { key: 'refunds', label: t('pay.dash.tab.refunds') },
    ...(can('payments:reconcile') ? [{ key: 'reconciliation' as Tab, label: t('pay.dash.tab.reconciliation') }, { key: 'cash' as Tab, label: t('pay.dash.tab.cash') }] : []),
    { key: 'alerts', label: t('pay.dash.tab.alerts') },
  ];
  // ⌘K: the page's own actions (21-SHELL page-command registry).
  usePageCommands({ title: t('pay.dash.title'), commands: [
    { id: 'collect', label: t('pay.dash.collect'), keywords: 'record cash payment collect take', enabled: can('payments:collect'), run: () => setCollect(true) },
    { id: 'link', label: t('pay.dash.newLink'), keywords: 'new payment link send pay', enabled: can('payments:collect'), run: () => setLinkOpen(true) },
  ] });
  return (
    <ModuleGate module="pay">
      <ListPage header={{ title: t('pay.dash.title'), subtitle: t('pay.dash.subtitle'), actions: <>
        {can('payments:collect') && <button className="btn" onClick={() => setLinkOpen(true)}>{t('pay.dash.newLink')}</button>}
        {can('payments:collect') && <button className="btn btn-primary" onClick={() => setCollect(true)}>{t('pay.dash.collect')}</button>}
      </> }}>
        {config.data?.mode === 'sandbox' && <div className={styles.notice}><Notice tone="warn"><Badge tone="sandbox">{t('state.sandbox')}</Badge> {t('pay.dash.mode.sandbox')}</Notice></div>}
        {can('payments:read') ? (
          <>
            <Tabs<Tab> tabs={tabs} value={tab} onChange={setTab} />
            {tab === 'payments' && <PaymentsList branchId={scoped} onOpen={setOpen} />}
            {tab === 'links' && <LinksList />}
            {tab === 'refunds' && <RefundsList onOpen={setOpen} />}
            {tab === 'reconciliation' && <Reconciliation providers={(config.data?.providers ?? []).map((p: any) => p.id)} />}
            {tab === 'cash' && <CashCount />}
            {tab === 'alerts' && <Alerts />}
          </>
        ) : <Card><EmptyState title={t('state.locked')}>payments:read</EmptyState></Card>}
      </ListPage>
      <CollectModal open={collect} onClose={() => setCollect(false)} />
      <LinkModal open={linkOpen} onClose={() => setLinkOpen(false)} />
      {open && <PaymentSheet paymentId={open} onClose={() => setOpen(null)} onChanged={() => undefined} />}
    </ModuleGate>
  );
}

export default function PaymentsRoute() {
  return <Suspense fallback={<Skeleton lines={6} />}><PaymentsPage /></Suspense>;
}

/**
 * The payment list: FilterBar (status, method, test or live, dates; kept in the URL, removable chips), DataTableV2 with
 * cursor pages, and the payment sheet on a row. The shell's branch (or all branches) scopes it.
 */
function PaymentsList({ branchId, onOpen }: { branchId: string; onOpen: (id: string) => void }) {
  const { t, locale } = useT();
  const { org } = useOrg();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const f = filtersFromParams(params);
  const [dates, setDates] = useState<Pick<PaymentFilters, 'from' | 'to'>>({ from: f.from, to: f.to });
  const pager = useCursorPagination([filtersToParams(f), branchId]);
  const { data, error, loading, pending } = useApi<{ items: PaymentRow[]; nextCursor: string | null }>(`/o/${org.id}/payments?${paymentsQuery(f, { branchId, cursor: pager.cursor })}`);
  const set = (next: Partial<PaymentFilters>) => {
    const q = filtersToParams({ ...f, ...next });
    router.replace(`${pathname}${q ? `?${q}` : ''}`, { scroll: false });
  };
  const label: Record<FilterKey, string> = { status: t('pay.dash.filterStatus'), method: t('pay.dash.filterMethod'), mode: t('pay.dash.filterMode'), from: t('pay.dash.filterFrom'), to: t('pay.dash.filterTo') };
  const value = (k: FilterKey) => k === 'status' ? t(`pay.payment.status.${f.status}`) : k === 'method' ? t(`pay.method.${f.method}`)
    : k === 'mode' ? (f.mode === 'test' ? t('pay.dash.modeTest') : t('pay.dash.modeLive')) : f[k];
  const chips: FilterChip[] = activeFilters(f).map((k) => ({ key: k, label: `${label[k]}: ${value(k)}`, onRemove: () => { if (k === 'from' || k === 'to') setDates((d) => ({ ...d, [k]: '' })); set({ [k]: '' }); } }));
  const datesOk = datesValid(dates);
  return (
    <div className="stack">
      <FilterBar chips={chips} onClearAll={chips.length ? () => { setDates({ from: '', to: '' }); set(NO_FILTERS); } : undefined}
        filters={(
          <div className={`${styles.filterDates} ${styles.filters}`} data-testid="payment-filters">
            <SelectField label={t('pay.dash.filterStatus')} value={f.status} onChange={(e) => set({ status: e.target.value })}>
              <option value="">{t('pay.dash.all')}</option>
              {PAYMENT_STATUSES.map((s) => <option key={s} value={s}>{t(`pay.payment.status.${s}`)}</option>)}
            </SelectField>
            <SelectField label={t('pay.dash.filterMethod')} value={f.method} onChange={(e) => set({ method: e.target.value })}>
              <option value="">{t('pay.dash.all')}</option>
              {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{t(`pay.method.${m}`)}</option>)}
            </SelectField>
            <SelectField label={t('pay.dash.filterMode')} value={f.mode} onChange={(e) => set({ mode: e.target.value as PaymentFilters['mode'] })}>
              <option value="">{t('pay.dash.modeAll')}</option>
              <option value="test">{t('pay.dash.modeTest')}</option>
              <option value="live">{t('pay.dash.modeLive')}</option>
            </SelectField>
            <Field label={t('pay.dash.filterFrom')} type="date" value={dates.from} max={dates.to || undefined}
              onChange={(e) => { const d = { ...dates, from: e.target.value }; setDates(d); if (datesValid(d)) set(d); }} />
            <Field label={t('pay.dash.filterTo')} type="date" value={dates.to} min={dates.from || undefined}
              onChange={(e) => { const d = { ...dates, to: e.target.value }; setDates(d); if (datesValid(d)) set(d); }} />
          </div>
        )} />
      {!datesOk && <p className={styles.dateError} role="alert">{t('pay.dash.datesInvalid')}</p>}
      {error && <Notice tone="danger">{error.message}</Notice>}
      {loading && !data ? <Skeleton lines={6} /> : (
        <DataTableV2 label={t('pay.dash.table')} rows={data?.items ?? []} rowKey={(r) => r.id} busy={pending} empty={<EmptyState title={t('pay.dash.empty')} />}
          onRowClick={(r) => onOpen(r.id)}
          pagination={{ hasNext: !!data?.nextCursor, hasPrev: pager.hasPrev, onNext: () => pager.next(data?.nextCursor), onPrev: pager.prev }}
          columns={[
            { key: 'when', header: t('pay.dash.col.when'), rowHeader: true, render: (r) => <span className="num">{dateTime(r.capturedAt ?? r.createdAt, locale)}</span> },
            { key: 'amount', header: t('pay.dash.col.amount'), align: 'end', render: (r) => <span className="num" dir="ltr">{money(r.amountMinor, r.currency, locale)}</span> },
            { key: 'method', header: t('pay.dash.col.method'), render: (r) => <>{t(`pay.method.${r.method}`)} {r.isTest && <Badge tone="sandbox">{t('pay.dash.test')}</Badge>}</> },
            { key: 'provider', header: t('pay.dash.col.provider'), render: (r) => <bdi>{paymentProviderLabel(t, r.provider)}</bdi> },
            { key: 'orders', header: t('pay.dash.col.orders'), render: (r) => r.orderNumbers ?? '—' },
            { key: 'status', header: t('pay.dash.col.status'), render: (r) => <Badge tone={statusTone(r.status)}>{t(`pay.payment.status.${r.status}`)}</Badge> },
          ]} />
      )}
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
          <div className="row gap-6">
            <button className="btn btn-sm" onClick={() => navigator.clipboard?.writeText(r.url)}>{t('pay.split.copy')}</button>
            {can('payments:collect') && r.status === 'open' && <button className="btn btn-sm btn-ghost" disabled={cancel.pending} onClick={() => cancel.run(r.id)}>{t('pay.link.cancel')}</button>}
          </div>) : '—' },
      ]} />
    </div>
  );
}

function RefundsList({ onOpen }: { onOpen: (paymentId: string) => void }) {
  const { t, locale } = useT();
  const { org } = useOrg();
  const { data, error, loading } = useApi<{ items: any[] }>(`/o/${org.id}/payments/refunds`);
  if (loading && !data) return <Skeleton lines={5} />;
  return (
    <>
      {error && <Notice tone="danger">{error.message}</Notice>}
      <DataTableV2 label={t('pay.dash.tab.refunds')} rows={data?.items ?? []} rowKey={(r) => r.id} empty={<EmptyState title={t('pay.dash.emptyRefunds')} />} onRowClick={(r) => onOpen(r.paymentId)} columns={[
        { key: 'when', header: t('pay.dash.col.when'), rowHeader: true, render: (r) => <span className="num">{dateTime(r.createdAt, locale)}</span> },
        { key: 'amount', header: t('pay.dash.col.amount'), align: 'end', render: (r) => <span className="num" dir="ltr">{money(r.amountMinor, r.currency, locale)}</span> },
        { key: 'method', header: t('pay.dash.col.method'), render: (r) => t(`pay.method.${r.method}`) },
        { key: 'reason', header: t('pay.dash.col.reason'), render: (r) => r.reason },
        { key: 'status', header: t('pay.dash.col.status'), render: (r) => <div className={styles.refundNotes}>
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
    <div className="grid grid-2 items-start">
      <Card title={t('pay.recon.title')}>
        <div className="form-row">
          <SelectField label={t('pay.recon.provider')} value={provider} onChange={(e) => setProvider(e.target.value)}>
            {[...new Set([...providers, 'simulated'])].map((p) => <option key={p} value={p}>{paymentProviderLabel(t, p)}</option>)}
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
        <button className="btn btn-primary mbs-12" disabled={run.pending} onClick={() => run.run()}>{t('pay.recon.run')}</button>
        <div className={styles.runs}>
          {(runs.data?.items ?? []).length === 0 && <p className="fine">{t('pay.dash.emptyRuns')}</p>}
          {(runs.data?.items ?? []).map((r) => (
            <button key={r.id} className={`btn btn-ghost ${styles.run}`} onClick={() => open.run(r.id)}>
              <span><bdi>{paymentProviderLabel(t, r.provider)}</bdi> · <bdi>{dateTime(r.createdAt, locale)}</bdi></span>
              <span><bdi dir="ltr">{r.totals.matched}/{r.totals.items}</bdi> {t('pay.recon.matched')}</span>
            </button>
          ))}
        </div>
      </Card>
      {detail && (
        <Card title={`${paymentProviderLabel(t, detail.provider)} · ${reconSourceLabel(t, detail.source)}`}>
          <div className="grid grid-3">
            <div className="stat"><span>{t('pay.recon.expected')}</span><strong dir="ltr">{m(detail.totals.expectedMinor)}</strong></div>
            <div className="stat"><span>{t('pay.recon.actual')}</span><strong dir="ltr">{m(detail.totals.actualMinor)}</strong></div>
            <div className="stat"><span>{t('pay.recon.difference')}</span><strong dir="ltr">{m(detail.totals.differenceMinor)}</strong></div>
          </div>
          <p className="fine">{t('pay.recon.matched')}: {detail.totals.matched} · {t('pay.recon.missingProvider')}: {detail.totals.missingInProvider} · {t('pay.recon.missingResuto')}: {detail.totals.missingInResuto} · {t('pay.recon.amountMismatch')}: {detail.totals.amountMismatch} · {t('pay.recon.statusMismatch')}: {detail.totals.statusMismatch} · {t('pay.recon.fees')}: {m(detail.totals.feesMinor)}</p>
          {resolve.error && <Notice tone="danger">{resolve.error}</Notice>}
          <DataTable rows={detail.items.filter((i: any) => i.status !== 'matched')} rowKey={(i: any) => i.id} empty={<EmptyState title={t('pay.recon.matched')} />} columns={[
            { key: 's', header: t('pay.dash.col.status'), render: (i: any) => <Badge tone={statusTone(i.status)}>{reconStatusLabel(t, i.status)}</Badge> },
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
      {(load.error || save.error) && <div className="mbs-12"><Notice tone="danger">{load.error ?? save.error}</Notice></div>}
      {expected && (expected.groups.length === 0 ? <p className="fine mbs-12">{t('pay.cash.none')}</p> : (
        <div className="stack mbs-16">
          {expected.groups.map((g: any) => (
            <div key={key(g)} className="form-row items-end">
              <div><strong>{t(`pay.method.${g.method}`)}</strong><div className="fine">{g.staffName ?? g.driverName ?? '—'} · {g.payments}</div></div>
              <div className="stat"><span>{t('pay.cash.expected')}</span><strong className={styles.statValue} dir="ltr">{m(g.expectedMinor)}</strong></div>
              <Field label={t('pay.cash.counted')} inputMode="decimal" dir="ltr" value={counts[key(g)] ?? ''} onChange={(e) => setCounts((c) => ({ ...c, [key(g)]: e.target.value }))} />
            </div>
          ))}
          <button className="btn btn-primary" disabled={save.pending} onClick={() => save.run()}>{t('pay.cash.save')}</button>
        </div>
      ))}
      {result && (
        <div className="mbs-16">
          <DataTable rows={result.items} rowKey={(i: any) => i.id} columns={[
            { key: 'who', header: t('pay.cash.staff'), render: (i: any) => `${t(`pay.method.${i.dimension.method}`)} · ${i.dimension.staffName ?? i.dimension.driverName ?? '—'}` },
            { key: 'e', header: t('pay.cash.expected'), align: 'end', render: (i: any) => <span dir="ltr">{m(i.expectedMinor)}</span> },
            { key: 'a', header: t('pay.cash.counted'), align: 'end', render: (i: any) => <span dir="ltr">{m(i.actualMinor)}</span> },
            { key: 's', header: t('pay.dash.col.status'), render: (i: any) => <Badge tone={statusTone(i.status)}>{reconStatusLabel(t, i.status)}</Badge> },
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
  // PAY-08: one-click provider refund of a capture Resuto never applied. The API replays a pending or succeeded refund
  // and starts a new attempt after a definite failure; the message follows the refund status it returns (F4).
  const [refunded, setRefunded] = useState<{ id: string; status: string } | null>(null);
  const [refundError, setRefundError] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm(locale);
  const refundAtProvider = useAction(async (a: any) => {
    const amount = a.details?.amountMinor ?? a.details?.received?.amountMinor;
    const ok = await confirm({
      title: t('pay.alert.refundConfirm', { amount: amount != null ? money(amount, a.details?.currency ?? org.currency, locale) : '', provider: paymentProviderLabel(t, a.provider) }),
      tone: 'danger',
    });
    if (!ok) return;
    setRefunded(null);
    setRefundError(null);
    try {
      const r = await call<{ status: string }>(`/o/${org.id}/payments/alerts/${a.id}/refund`, { body: { key: `alert-${a.id}` } });
      setRefunded({ id: a.id, status: r?.status ?? 'failed' });
    } catch (e: any) {
      const k = `pay.alert.refundError.${e?.code ?? ''}`;
      if (t(k) === k) throw e;
      setRefundError(t(k));
    }
    await reload();
  });
  const refundable = (a: any) => a.status === 'open' && a.details?.refundable === true && ['late_success', 'duplicate_capture', 'overpayment_conflict', 'deposit_not_due'].includes(a.kind);
  const actionText = (a: any) => { const k = `pay.alert.action.${a.kind}`; const v = t(k); return v === k ? a.details?.action ?? null : v; };
  if (loading && !data) return <Skeleton lines={4} />;
  if (error) return <Notice tone="danger">{error.message}</Notice>;
  if (!data?.items.length) return <Card><EmptyState title={t('pay.dash.emptyAlerts')} /></Card>;
  return (
    <div className="stack">
      {confirmDialog}
      {refundAtProvider.error && <Notice tone="danger">{refundAtProvider.error}</Notice>}
      {refundError && <Notice tone="danger">{refundError}</Notice>}
      {data.items.map((a) => (
        <Card key={a.id}>
          <div className="spread">
            <div>
              <strong>{t(`pay.alert.${a.kind}`)}</strong>
              <div className="fine"><bdi>{paymentProviderLabel(t, a.provider)}</bdi> · <bdi>{dateTime(a.createdAt, locale)}</bdi>{a.paymentId && <> · <Link href={`/dashboard/${org.id}/payments/${a.paymentId}`}><bdi dir="ltr">{a.paymentId.slice(0, 8)}</bdi></Link></>}</div>
              {actionText(a) && <p className="fine m-0">{actionText(a)}</p>}
              {refunded && refunded.id === a.id && (() => { const m = alertRefundMessageKey(refunded.status); return <Notice tone={m.tone}>{t(m.key)}</Notice>; })()}
            </div>
            <div className="row gap-6">
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
    <Sheet open={open} onClose={close} title={t('pay.collect.title')} size="sm" footer={done ? <button className="btn btn-primary" onClick={close}>{t('action.close')}</button> : <>
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
          <div className="form-row mbs-12">
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
    </Sheet>
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
    <Sheet open={open} onClose={close} title={t('pay.link.title')} size="sm" footer={url ? <button className="btn btn-primary" onClick={close}>{t('action.close')}</button> : <>
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
    </Sheet>
  );
}
