'use client';
import Link from 'next/link';
import { Suspense } from 'react';
import type { AdminTenantRow, Page } from '@resuto/contracts';
import { Badge, DataTableV2, EmptyState, ErrorState, FilterBar, ListPage, SelectField, SkeletonTable, useCursorPagination, type ColumnV2 } from '@resuto/ui';
import { AreaSkeleton } from '@/components/shell/AreaSkeleton';
import { useUrlParam } from '@/components/ops/use-url-state';
import { dateTime } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { pick } from '@/lib/pick';
import { useApi } from '@/lib/use-api';
import { useAdmin } from './AdminShell';
import {
  COUNTRIES, PLAN_IDS, TENANT_STATUSES, byDate, countryLabel, planLabel, statusLabel, subscriptionLabel, tenantFilterChips, tenantsQuery,
  type TenantFilters,
} from './console';
import { fill } from './strings';
import { ORG_TONE, SUB_TONE } from './tones';

const ANY = '';

/** Restaurants (21-ADMIN): ListPage with the filter bar (in the URL), DataTableV2 (row links, sortable page) and keyset pages. */
export default function AdminTenantsPage() {
  return <Suspense fallback={<AreaSkeleton template="list" />}><TenantsList /></Suspense>;
}

function TenantsList() {
  const { locale } = useT();
  const { s } = useAdmin();
  const [q, setQ] = useUrlParam<string>('q', ANY);
  const [status, setStatus] = useUrlParam<string>('status', ANY, [ANY, ...TENANT_STATUSES]);
  const [plan, setPlan] = useUrlParam<string>('plan', ANY, [ANY, ...PLAN_IDS]);
  const [country, setCountry] = useUrlParam<string>('country', ANY, [ANY, ...COUNTRIES]);
  const filters: TenantFilters = { q, status, plan, country };
  const pager = useCursorPagination([q, status, plan, country]);
  const list = useApi<Page<AdminTenantRow>>(`/admin/tenants?${tenantsQuery(filters, pager.cursor)}`);
  const setters: Record<keyof TenantFilters, (v: string) => void> = { q: setQ, status: setStatus, plan: setPlan, country: setCountry };
  const chips = tenantFilterChips(s, filters).map((c) => ({ key: c.key, label: c.text, text: c.text, onRemove: () => setters[c.key](ANY) }));
  const name = (r: AdminTenantRow) => pick(locale, r.name, r.nameAr);

  const columns: ColumnV2<AdminTenantRow>[] = [
    { key: 'name', header: s.restaurant, rowHeader: true, hideable: false, sort: (a, b) => name(a).localeCompare(name(b), locale),
      render: (r) => (
        <span className="admin-tenant-name">
          <strong><bdi>{name(r)}</bdi></strong>
          <span className="fine" dir="ltr">{r.slug} · {r.country}</span>
        </span>
      ) },
    { key: 'status', header: s.status, sort: (a, b) => statusLabel(s, a.status).localeCompare(statusLabel(s, b.status), locale),
      render: (r) => <Badge tone={ORG_TONE[r.status]}>{statusLabel(s, r.status)}</Badge> },
    { key: 'plan', header: s.plan, sort: (a, b) => planLabel(s, a.planId).localeCompare(planLabel(s, b.planId), locale),
      render: (r) => (
        <span className="admin-row">
          <span>{planLabel(s, r.planId)}</span>
          {r.subscriptionStatus && <Badge tone={SUB_TONE[r.subscriptionStatus]}>{subscriptionLabel(s, r.subscriptionStatus)}</Badge>}
        </span>
      ) },
    { key: 'branches', header: s.branches, align: 'end', sort: (a, b) => a.counts.branches - b.counts.branches, render: (r) => <span className="num">{r.counts.branches}</span> },
    { key: 'members', header: s.colMembers, align: 'end', sort: (a, b) => a.counts.members - b.counts.members, render: (r) => <span className="num">{r.counts.members}</span> },
    { key: 'orders', header: s.colOrders, align: 'end', sort: (a, b) => a.counts.orders30d - b.counts.orders30d, render: (r) => <span className="num">{r.counts.orders30d}</span> },
    { key: 'lastOrder', header: s.lastOrder, sort: (a, b) => byDate(a.lastOrderAt, b.lastOrderAt), render: (r) => <span className="num">{dateTime(r.lastOrderAt, locale)}</span> },
    { key: 'created', header: s.created, sort: (a, b) => byDate(a.createdAt, b.createdAt), render: (r) => <span className="num">{dateTime(r.createdAt, locale)}</span> },
  ];

  const rows = list.data?.items ?? [];
  return (
    <ListPage header={{ title: s.tenants, subtitle: s.tenantsSub }}
      filters={
        <FilterBar locale={locale}
          search={{ value: q, onChange: setQ, label: s.search, placeholder: s.search, debounceMs: 250 }}
          chips={chips} onClearAll={chips.length > 1 ? () => { setQ(ANY); setStatus(ANY); setPlan(ANY); setCountry(ANY); } : undefined}
          filters={<>
            <SelectField label={s.status} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value={ANY}>{s.any}</option>
              {TENANT_STATUSES.map((x) => <option key={x} value={x}>{statusLabel(s, x)}</option>)}
            </SelectField>
            <SelectField label={s.plan} value={plan} onChange={(e) => setPlan(e.target.value)}>
              <option value={ANY}>{s.any}</option>
              {PLAN_IDS.map((x) => <option key={x} value={x}>{planLabel(s, x)}</option>)}
            </SelectField>
            <SelectField label={s.country} value={country} onChange={(e) => setCountry(e.target.value)}>
              <option value={ANY}>{s.any}</option>
              {COUNTRIES.map((x) => <option key={x} value={x}>{countryLabel(s, x)}</option>)}
            </SelectField>
          </>} />
      }
      footer={list.data && rows.length > 1 ? <p className="admin-note">{s.sortNote}</p> : undefined}>
      {list.error && !list.data ? (
        <ErrorState locale={locale} error={{ status: list.error.status, code: list.error.code, message: list.error.message, requestId: list.error.requestId }}
          onRetry={list.reload} />
      ) : !list.data ? (
        <div className="panel"><SkeletonTable rows={8} cols={6} /></div>
      ) : (
        <DataTableV2 label={s.tenants} locale={locale} rows={rows} columns={columns} rowKey={(r) => r.id} busy={list.pending}
          rowHref={(r) => `/admin/tenants/${r.id}`}
          renderLink={(href, children, className) => <Link href={href} className={className}>{children}</Link>}
          columnToggle densityToggle
          empty={<EmptyState title={s.noTenants} />}
          pagination={{
            hasNext: !!list.data.nextCursor, hasPrev: pager.hasPrev, onNext: () => pager.next(list.data?.nextCursor), onPrev: pager.prev,
            summary: fill(s.pageOf, { n: pager.page, count: rows.length }),
          }} />
      )}
    </ListPage>
  );
}
