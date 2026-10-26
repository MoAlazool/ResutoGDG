'use client';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type ReactNode } from 'react';
import type { CustomerSummary } from '@resuto/contracts';
import { Badge, DataTableV2, EmptyState, Field, Icon, ListPage, Notice, SelectField, Skeleton, SkeletonTable, Tabs, useAction, Email, Phone, UserText } from '@resuto/ui';
import { CheckIcon, DownloadIcon } from '@/components/icons/glyphs';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { LoadError, qs, useFormat, InsightsPage } from '@/components/charts/insights';
import { API_URL, ApiRequestError } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useBranchScope, useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';

interface Page { items: CustomerSummary[]; nextCursor: string | null; total: number }
const EMPTY = { q: '', tag: '', consent: '', lastOrderBefore: '', lastOrderAfter: '', minOrders: '', minSpend: '', sort: 'last_order' };

type Filters = typeof EMPTY;
/** Filters as they appear in the URL (PCL-20): only non-default values, so plain links stay clean. */
const fromUrl = (sp: URLSearchParams): Filters => {
  const out = { ...EMPTY };
  for (const k of Object.keys(EMPTY) as Array<keyof Filters>) { const v = sp.get(k); if (v !== null) out[k] = v; }
  return out;
};

// 21-CRM: the segment builder (Customers › Segments) loads only when that view is opened.
const SegmentsView = dynamic(() => import('@/components/crm/SegmentBuilder').then((m) => m.SegmentsView),
  { ssr: false, loading: () => <div className="card"><Skeleton lines={6} /></div> });

type View = 'list' | 'segments';

export default function CustomersPage() {
  return <Suspense fallback={<div className="card"><Skeleton lines={6} /></div>}><CustomersRoot /></Suspense>;
}

/** Customers › list (default) or › Segments (?view=segments; roles that can read Marketing). */
function CustomersRoot() {
  const { t } = useT();
  const { can } = useOrg();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const view: View = search.get('view') === 'segments' && can('marketing:read') ? 'segments' : 'list';
  const tabs = can('marketing:read') ? (
    <Tabs<View> label={t('nav.customers')} value={view} onChange={(k) => router.replace(k === 'segments' ? `${pathname}?view=segments` : pathname, { scroll: false })}
      tabs={[{ key: 'list', label: t('crm.view.list') }, { key: 'segments', label: t('crm.view.segments') }]} />
  ) : null;
  if (view === 'segments') {
    return (
      <ModuleGate module="core" permission="customers:read"><InsightsPage>
        <ListPage header={{ eyebrow: t('nav.customers'), title: t('crm.seg.title'), subtitle: t('crm.seg.subtitle') }} filters={tabs}>
          <SegmentsView />
        </ListPage>
      </InsightsPage></ModuleGate>
    );
  }
  return <Customers tabs={tabs} />;
}

function Customers({ tabs }: { tabs: ReactNode }) {
  const { t, locale } = useT();
  const { org, can } = useOrg();
  // The branch comes from the shell's branch switcher (21-SHELL single branch context; "All branches" supported).
  const { branchId } = useBranchScope({ allowAll: true });
  const session = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const f = useFormat();
  const [draft, setDraft] = useState<Filters>(() => fromUrl(new URLSearchParams(search.toString())));
  const [filters, setFilters] = useState<Filters>(draft);
  const [cursor, setCursor] = useState<string | undefined>();
  // Debounce the search box; other filters apply immediately. Applied filters are mirrored into the URL.
  useEffect(() => {
    const h = setTimeout(() => {
      setFilters(draft); setCursor(undefined);
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(draft)) if (v !== EMPTY[k as keyof Filters]) q.set(k, v);
      const next = q.toString() ? `?${q}` : '';
      if (next !== window.location.search) router.replace(`${pathname}${next}`, { scroll: false });
    }, draft.q !== filters.q ? 300 : 0);
    return () => clearTimeout(h);
  }, [draft]); // eslint-disable-line react-hooks/exhaustive-deps
  const params = {
    q: filters.q, tag: filters.tag.trim().toLowerCase(), consent: filters.consent, lastOrderBefore: filters.lastOrderBefore, lastOrderAfter: filters.lastOrderAfter,
    minOrders: filters.minOrders, minSpendMinor: filters.minSpend ? Math.round(Number(filters.minSpend) * 100) : undefined, branchId, sort: filters.sort,
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
      <ListPage header={{ eyebrow: t('nav.customers'), title: t('insights.customers.title'),
        subtitle: data ? t('insights.customers.count', { count: data.total }) : t('state.loading'),
        actions: can('customers:export') ? (
          <button className="btn" disabled={exportCsv.pending} onClick={async () => setTruncated(!!(await exportCsv.run()))}><Icon icon={DownloadIcon} size={16} /> {t('insights.customers.export')}</button>
        ) : undefined }}
        filters={<>
      {tabs}
      {exportCsv.error && <Notice tone="danger">{exportCsv.error}</Notice>}
      {truncated && <Notice tone="warn">{t('insights.customers.truncated')}</Notice>}
      {can('customers:export') && <p className="fine">{t('insights.customers.exportNote')}</p>}
      <section className="card">
        <div className="form-row is-filters">
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
          <summary className="fine cursor-pointer">{t('insights.customers.moreFilters')}</summary>
          <div className="form-row mbs-10">
            <Field label={t('insights.customers.lastOrderAfter')} type="date" value={draft.lastOrderAfter} onChange={set('lastOrderAfter')} />
            <Field label={t('insights.customers.lastOrderBefore')} type="date" value={draft.lastOrderBefore} onChange={set('lastOrderBefore')} hint={t('insights.customers.lapsedHint')} />
            <Field label={t('insights.customers.minOrders')} type="number" min={0} value={draft.minOrders} onChange={set('minOrders')} />
            <Field label={t('insights.customers.minSpend', { currency: org.currency })} type="number" min={0} value={draft.minSpend} onChange={set('minSpend')} />
          </div>
        </details>
        {filtered && <button className="btn btn-sm btn-ghost" onClick={() => setDraft(EMPTY)}>{t('insights.customers.clear')}</button>}
      </section>
      </>}>
      <LoadError error={error} retry={reload} />
      {loading && !data ? <SkeletonTable rows={8} cols={6} /> : data && (
        <>
          <DataTableV2 label={t('insights.customers.title')} rows={data.items} rowKey={(c) => c.id} busy={pending}
            rowHref={(c) => `/dashboard/${org.id}/customers/${c.id}`}
            renderLink={(href, children, className) => <Link href={href} className={className}>{children}</Link>}
            empty={<EmptyState title={filtered ? t('insights.customers.noMatch') : t('insights.customers.none')}>{!filtered && t('insights.customers.noneHint')}</EmptyState>} columns={[
              { key: 'name', header: t('insights.customers.name'), render: (c) => (
                c.displayName ? <UserText>{c.displayName}</UserText> : <span className="muted">{t('insights.customers.unnamed')}</span>) },
              { key: 'contact', header: t('insights.customers.contact'), render: (c) => <span className="fine">{c.phone ? <Phone value={c.phone} /> : c.email ? <Email value={c.email} /> : '—'}</span> },
              { key: 'orders', header: t('insights.kpi.orders'), align: 'end', render: (c) => <span className="num">{c.orderCount}</span> },
              { key: 'spend', header: t('insights.customers.spend'), align: 'end', render: (c) => <span className="num">{f.money(c.totalSpendMinor)}</span> },
              { key: 'last', header: t('insights.customers.lastOrder'), render: (c) => <span className="fine">{c.lastOrderAt ? dateTime(c.lastOrderAt, locale, org.timezone) : '—'}</span> },
              { key: 'consent', header: t('insights.customers.consent'), render: (c) => c.marketingConsent ? <Badge tone="ok"><Icon icon={CheckIcon} size={12} /> {t('insights.customers.consentGranted')}</Badge> : <Badge>{t('insights.customers.consentNot')}</Badge> },
              { key: 'tags', header: t('insights.customers.tags'), render: (c) => c.tags.length ? <span className="row gap-4">{c.tags.slice(0, 3).map((tg) => <Badge key={tg} tone="info">{tg}</Badge>)}</span> : null },
            ]} />
          <div className="row mbs-12">
            {cursor && <button className="btn btn-sm" onClick={() => setCursor(undefined)}>{t('insights.firstPage')}</button>}
            {data.nextCursor && <button className="btn btn-sm" onClick={() => setCursor(data.nextCursor!)}>{t('insights.nextPage')}</button>}
          </div>
        </>
      )}
      </ListPage>
    </InsightsPage></ModuleGate>
  );
}
