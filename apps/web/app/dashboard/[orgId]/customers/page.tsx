'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { CustomerSummary } from '@resuto/contracts';
import { Badge, DataTable, EmptyState, Field, Notice, PageHeader, SelectField, Skeleton, useAction, Email, Phone, UserText } from '@resuto/ui';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { BranchSelect, LoadError, qs, useFormat, InsightsPage } from '@/components/charts/insights';
import { API_URL, ApiRequestError } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';

interface Page { items: CustomerSummary[]; nextCursor: string | null; total: number }
const EMPTY = { q: '', tag: '', consent: '', lastOrderBefore: '', lastOrderAfter: '', minOrders: '', minSpend: '', branchId: '', sort: 'last_order' };

export default function CustomersPage() {
  const { t, locale } = useT();
  const { org, can } = useOrg();
  const session = useSession();
  const router = useRouter();
  const f = useFormat();
  const [draft, setDraft] = useState(EMPTY);
  const [filters, setFilters] = useState(EMPTY);
  const [cursor, setCursor] = useState<string | undefined>();
  // Debounce the search box; other filters apply immediately.
  useEffect(() => {
    const h = setTimeout(() => { setFilters(draft); setCursor(undefined); }, draft.q !== filters.q ? 300 : 0);
    return () => clearTimeout(h);
  }, [draft]); // eslint-disable-line react-hooks/exhaustive-deps
  const params = {
    q: filters.q, tag: filters.tag.trim().toLowerCase(), consent: filters.consent, lastOrderBefore: filters.lastOrderBefore, lastOrderAfter: filters.lastOrderAfter,
    minOrders: filters.minOrders, minSpendMinor: filters.minSpend ? Math.round(Number(filters.minSpend) * 100) : undefined, branchId: filters.branchId, sort: filters.sort,
  };
  const { data, error, loading, pending, reload } = useApi<Page>(`/o/${org.id}/customers${qs({ ...params, limit: 50, cursor })}`);
  const set = (k: keyof typeof EMPTY) => (e: { target: { value: string } }) => setDraft({ ...draft, [k]: e.target.value });
  const exportCsv = useAction(async () => {
    const res = await fetch(`${API_URL}/v1/o/${org.id}/customers/export.csv${qs(params)}`, { headers: { Authorization: `Bearer ${session.token}` } });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new ApiRequestError(res.status, body?.error?.code ?? 'http_error', body?.error?.message ?? res.statusText);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `customers-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    return res.headers.get('X-Export-Truncated') === 'true';
  });
  const [truncated, setTruncated] = useState(false);
  const filtered = JSON.stringify(filters) !== JSON.stringify(EMPTY);

  return (
    <ModuleGate module="core" permission="customers:read"><InsightsPage>
      <PageHeader overline={t('nav.customers')} title={t('insights.customers.title')}
        subtitle={data ? t('insights.customers.count', { count: data.total }) : t('state.loading')}
        actions={can('customers:export') ? (
          <button className="btn" disabled={exportCsv.pending} onClick={async () => setTruncated(!!(await exportCsv.run()))}>⇩ {t('insights.customers.export')}</button>
        ) : undefined} />
      {exportCsv.error && <Notice tone="danger">{exportCsv.error}</Notice>}
      {truncated && <Notice tone="warn">{t('insights.customers.truncated')}</Notice>}
      {can('customers:export') && <p className="fine">{t('insights.customers.exportNote')}</p>}
      <section className="card" style={{ marginBlockEnd: 16 }}>
        <div className="form-row">
          <Field label={t('action.search')} type="search" placeholder={t('insights.customers.searchHint')} value={draft.q} onChange={set('q')} />
          <Field label={t('insights.customers.tag')} value={draft.tag} onChange={set('tag')} />
          <SelectField label={t('insights.customers.consent')} value={draft.consent} onChange={set('consent')}>
            <option value="">{t('insights.customers.any')}</option>
            <option value="granted">{t('insights.customers.consentGranted')}</option>
            <option value="not_granted">{t('insights.customers.consentNot')}</option>
          </SelectField>
          <SelectField label={t('insights.customers.sort')} value={draft.sort} onChange={set('sort')}>
            {['last_order', 'spend', 'orders', 'name', 'created'].map((s) => <option key={s} value={s}>{t(`insights.customers.sort.${s}`)}</option>)}
          </SelectField>
        </div>
        <details>
          <summary className="fine" style={{ cursor: 'pointer' }}>{t('insights.customers.moreFilters')}</summary>
          <div className="form-row" style={{ marginBlockStart: 10 }}>
            <Field label={t('insights.customers.lastOrderAfter')} type="date" value={draft.lastOrderAfter} onChange={set('lastOrderAfter')} />
            <Field label={t('insights.customers.lastOrderBefore')} type="date" value={draft.lastOrderBefore} onChange={set('lastOrderBefore')} hint={t('insights.customers.lapsedHint')} />
            <Field label={t('insights.customers.minOrders')} type="number" min={0} value={draft.minOrders} onChange={set('minOrders')} />
            <Field label={t('insights.customers.minSpend', { currency: org.currency })} type="number" min={0} value={draft.minSpend} onChange={set('minSpend')} />
            <div className="field"><span>{t('insights.branch.label')}</span><BranchSelect value={draft.branchId} onChange={(v) => setDraft({ ...draft, branchId: v })} /></div>
          </div>
        </details>
        {filtered && <button className="btn btn-sm btn-ghost" onClick={() => setDraft(EMPTY)}>{t('insights.customers.clear')}</button>}
      </section>
      <LoadError error={error} retry={reload} />
      {loading && !data ? <div className="card"><Skeleton lines={6} /></div> : data && (
        <>
          <DataTable rows={data.items} rowKey={(c) => c.id} onRowClick={(c) => router.push(`/dashboard/${org.id}/customers/${c.id}`)} busy={pending}
            empty={<EmptyState title={filtered ? t('insights.customers.noMatch') : t('insights.customers.none')}>{!filtered && t('insights.customers.noneHint')}</EmptyState>} columns={[
              { key: 'name', header: t('insights.customers.name'), render: (c) => (
                <Link href={`/dashboard/${org.id}/customers/${c.id}`} onClick={(e) => e.stopPropagation()}>{c.displayName ? <UserText>{c.displayName}</UserText> : <span className="muted">{t('insights.customers.unnamed')}</span>}</Link>) },
              { key: 'contact', header: t('insights.customers.contact'), render: (c) => <span className="fine">{c.phone ? <Phone value={c.phone} /> : c.email ? <Email value={c.email} /> : '—'}</span> },
              { key: 'orders', header: t('insights.kpi.orders'), align: 'end', render: (c) => <span className="num">{c.orderCount}</span> },
              { key: 'spend', header: t('insights.customers.spend'), align: 'end', render: (c) => <span className="num">{f.money(c.totalSpendMinor)}</span> },
              { key: 'last', header: t('insights.customers.lastOrder'), render: (c) => <span className="fine">{c.lastOrderAt ? dateTime(c.lastOrderAt, locale, org.timezone) : '—'}</span> },
              { key: 'consent', header: t('insights.customers.consent'), render: (c) => c.marketingConsent ? <Badge tone="ok">✓ {t('insights.customers.consentGranted')}</Badge> : <Badge>{t('insights.customers.consentNot')}</Badge> },
              { key: 'tags', header: t('insights.customers.tags'), render: (c) => <span className="row" style={{ gap: 4 }}>{c.tags.slice(0, 3).map((tg) => <Badge key={tg} tone="info">{tg}</Badge>)}</span> },
            ]} />
          <div className="row" style={{ marginBlockStart: 12 }}>
            {cursor && <button className="btn btn-sm" onClick={() => setCursor(undefined)}>{t('insights.firstPage')}</button>}
            {data.nextCursor && <button className="btn btn-sm" onClick={() => setCursor(data.nextCursor!)}>{t('insights.nextPage')}</button>}
          </div>
        </>
      )}
    </InsightsPage></ModuleGate>
  );
}
