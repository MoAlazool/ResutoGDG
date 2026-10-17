'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { AdminTenantRow, Page } from '@resuto/contracts';
import { Badge, Card, EmptyState, Field, Notice, PageHeader, SelectField, Skeleton } from '@resuto/ui';
import { dateTime } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useSession } from '@/lib/session';
import { useAdmin } from './AdminShell';
import { ORG_TONE, SUB_TONE } from './tones';

/** Lets wide tables scroll inside the page instead of widening it on phones. */
const FIT = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)' } as const;


export default function AdminTenantsPage() {
  const { locale } = useT();
  const { s } = useAdmin();
  const { call } = useSession();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState('');
  const [plan, setPlan] = useState('');
  const [country, setCountry] = useState('');
  const [rows, setRows] = useState<AdminTenantRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  const load = useCallback(async (after: string | null) => {
    setLoading(true); setError(false);
    try {
      const p = new URLSearchParams({ limit: '50' });
      if (debounced) p.set('q', debounced);
      if (status) p.set('status', status);
      if (plan) p.set('plan', plan);
      if (country) p.set('country', country);
      if (after) p.set('cursor', after);
      const r = await call<Page<AdminTenantRow>>(`/admin/tenants?${p}`);
      setRows((prev) => (after ? [...(prev ?? []), ...r.items] : r.items));
      setCursor(r.nextCursor);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [call, debounced, status, plan, country]);
  useEffect(() => { void load(null); }, [load]);

  return (
    <div style={FIT}>
      <PageHeader title={s.tenants} />
      <Card>
        <div className="form-row">
          <Field label={s.search} value={q} onChange={(e) => setQ(e.target.value)} type="search" />
          <SelectField label={s.status} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">{s.any}</option>
            {(['onboarding', 'active', 'suspended', 'closed'] as const).map((x) => <option key={x} value={x}>{s[`st_${x}`]}</option>)}
          </SelectField>
          <SelectField label={s.plan} value={plan} onChange={(e) => setPlan(e.target.value)}>
            <option value="">{s.any}</option>
            {['free', 'starter', 'growth', 'pro', 'custom'].map((x) => <option key={x} value={x}>{x}</option>)}
          </SelectField>
          <SelectField label={s.country} value={country} onChange={(e) => setCountry(e.target.value)}>
            <option value="">{s.any}</option><option value="EG">EG</option><option value="SA">SA</option>
          </SelectField>
        </div>
      </Card>
      {error && <Notice tone="danger">{s.loadError} <button className="btn btn-sm" onClick={() => void load(null)}>{s.retry}</button></Notice>}
      {!rows ? <Card><Skeleton lines={6} /></Card> : !rows.length ? <Card><EmptyState title={s.noTenants} /></Card> : (
        <div className="table-wrap" style={{ marginBlockStart: 16 }}>
          <table className="data">
            <thead><tr><th>{s.tenants}</th><th>{s.status}</th><th>{s.subscription}</th><th>{s.counts}</th><th>{s.lastOrder}</th><th>{s.created}</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><Link href={`/admin/tenants/${r.id}`}><strong>{locale === 'ar' && r.nameAr ? r.nameAr : r.name}</strong></Link>
                    <div className="fine" dir="ltr">{r.slug} · {r.country}</div></td>
                  <td><Badge tone={ORG_TONE[r.status]}>{s[`st_${r.status}` as keyof typeof s] ?? r.status}</Badge></td>
                  <td>{r.planId ?? '—'} {r.subscriptionStatus && <Badge tone={SUB_TONE[r.subscriptionStatus]}>{r.subscriptionStatus}</Badge>}</td>
                  <td className="num">{r.counts.branches} · {r.counts.members} · {r.counts.orders30d}</td>
                  <td className="num">{dateTime(r.lastOrderAt, locale)}</td>
                  <td className="num">{dateTime(r.createdAt, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {cursor && <div className="row" style={{ justifyContent: 'center', marginBlockStart: 14 }}><button className="btn" disabled={loading} onClick={() => void load(cursor)}>{s.more}</button></div>}
    </div>
  );
}
