'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { MODULE_INFO, MODULE_KEYS, type AdminTenantDetail, type ModuleKey } from '@resuto/contracts';
import { Badge, Card, DataTable, EmptyState, Field, Modal, Notice, PageHeader, SelectField, Skeleton, TextareaField } from '@resuto/ui';
import { dateTime, money } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { useAdmin } from '../../AdminShell';
import { ORG_TONE, SUB_TONE } from '../../tones';

/** Lets wide tables scroll inside the page instead of widening it on phones. */
const FIT = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)' } as const;


const inDays = (d: number) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 16);

export default function AdminTenantPage() {
  const { locale } = useT();
  const { s, can } = useAdmin();
  const { orgId } = useParams<{ orgId: string }>();
  const { call } = useSession();
  const t = useApi<AdminTenantDetail>(`/admin/tenants/${orgId}`);
  const [statusOpen, setStatusOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const [grant, setGrant] = useState<{ module: ModuleKey; enabled: boolean; reason: string; expiresAt: string }>({ module: 'pay', enabled: true, reason: '', expiresAt: inDays(30) });
  const [revoking, setRevoking] = useState<{ id: string; module: string } | null>(null);
  const write = can('tenants:write');

  async function run(fn: () => Promise<unknown>, done?: () => void) {
    setBusy(true); setMsg(null);
    try { await fn(); done?.(); await t.reload(); } catch (e) { setMsg({ tone: 'danger', text: (e as Error).message }); } finally { setBusy(false); }
  }

  if (t.error) return <Notice tone="danger">{t.error.status === 404 ? s.noTenants : s.loadError} <button className="btn btn-sm" onClick={() => void t.reload()}>{s.retry}</button></Notice>;
  if (!t.data) return <Card><Skeleton lines={8} /></Card>;
  const d = t.data;
  const suspended = d.status === 'suspended';
  const sub = d.subscription;

  return (
    <div style={FIT}>
      <PageHeader overline={<Link href="/admin">← {s.tenants}</Link>} title={locale === 'ar' && d.nameAr ? d.nameAr : d.name}
        subtitle={<span dir="ltr">{d.slug} · {d.country} · {d.timezone} · {d.id}</span>}
        actions={write && d.status !== 'closed' ? (
          <button className={`btn ${suspended ? 'btn-primary' : 'btn-danger'}`} onClick={() => { setReason(''); setStatusOpen(true); }}>{suspended ? s.reactivate : s.suspend}</button>
        ) : undefined} />
      {!write && <div style={{ marginBlockEnd: 12 }}><Notice>{s.readOnly}</Notice></div>}
      {msg && <div style={{ marginBlockEnd: 12 }}><Notice tone={msg.tone}>{msg.text}</Notice></div>}

      <div className="grid grid-2" style={{ marginBlockEnd: 16 }}>
        <Card title={s.overview}>
          <div className="row" style={{ gap: 8, marginBlockEnd: 12 }}>
            <Badge tone={ORG_TONE[d.status]}>{s[`st_${d.status}` as keyof typeof s] ?? d.status}</Badge>
            {d.planId && <Badge>{d.planId}</Badge>}{d.subscriptionStatus && <Badge tone={SUB_TONE[d.subscriptionStatus]}>{d.subscriptionStatus}</Badge>}
          </div>
          <p className="num" style={{ margin: 0 }}>{s.counts}: {d.counts.branches} · {d.counts.members} · {d.counts.orders30d}</p>
          <p className="fine">{s.created}: {dateTime(d.createdAt, locale)} · {s.lastOrder}: {dateTime(d.lastOrderAt, locale)}</p>
          {d.billingVisible && sub ? (
            <div className="stack" style={{ gap: 6, fontSize: 14 }}>
              <strong>{s.subscription}</strong>
              <span>{s.period}: {dateTime(sub.currentPeriodStart, locale)} – {dateTime(sub.currentPeriodEnd, locale)} ({sub.interval})</span>
              {sub.trialEndsAt && <span>{s.trialEnds}: {dateTime(sub.trialEndsAt, locale)}</span>}
              {sub.graceUntil && <span>{s.graceUntil}: {dateTime(sub.graceUntil, locale)}</span>}
              {sub.cancelAtPeriodEnd && <Badge tone="warn">{s.cancelAtEnd}</Badge>}
              {sub.pendingPlanId && <span>{s.pending}: {sub.pendingPlanId}</span>}
              <span>{s.addons}: {sub.addons.length ? sub.addons.join(', ') : s.none}</span>
              {sub.invoices.length > 0 && (
                <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                  {sub.invoices.map((i) => <li key={i.id} className="num">{i.number} · {money(i.totalMinor, i.currency, locale)} · {i.status}</li>)}
                </ul>
              )}
            </div>
          ) : !d.billingVisible ? <p className="fine">{s.billingHidden}</p> : null}
        </Card>
        {/* breaks the global .card + .card margin inside grids */}<span hidden />
        <Card title={s.modules}>
          <div className="row" style={{ gap: 6 }}>
            {MODULE_KEYS.map((m) => <Badge key={m} tone={d.modules[m] ? 'ok' : 'neutral'}>{d.modules[m] ? '✓' : '—'} {locale === 'ar' ? MODULE_INFO[m].nameAr : MODULE_INFO[m].name}</Badge>)}
          </div>
        </Card>
      </div>

      <Card title={s.overrides}>
        {d.overrides.length ? (
          <DataTable rows={d.overrides} rowKey={(o) => o.id} columns={[
            { key: 'm', header: s.module, render: (o) => <strong>{MODULE_INFO[o.module]?.name ?? o.module}</strong> },
            { key: 'e', header: '', render: (o) => <Badge tone={o.enabled ? 'ok' : 'danger'}>{o.enabled ? s.enabled : s.blocked}</Badge> },
            { key: 'r', header: s.reason, render: (o) => o.reason },
            { key: 'x', header: s.expiresAt, render: (o) => dateTime(o.expiresAt, locale) },
            { key: 'a', header: '', align: 'end', render: (o) => o.active
              ? (write ? <button className="btn btn-sm btn-danger" onClick={() => { setReason(''); setRevoking({ id: o.id, module: o.module }); }}>{s.revoke}</button> : <Badge tone="ok">{s.active}</Badge>)
              : <Badge>{s.expired}</Badge> },
          ]} />
        ) : <EmptyState title={s.noOverrides} />}
        {write && (
          <form style={{ marginBlockStart: 18 }} onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void run(() => call(`/admin/tenants/${orgId}/overrides`, { body: { ...grant, expiresAt: new Date(grant.expiresAt).toISOString() } }),
              () => setGrant((g) => ({ ...g, reason: '' })));
          }}>
            <h3>{s.grant}</h3>
            <div className="form-row">
              <SelectField label={s.module} value={grant.module} onChange={(e) => setGrant({ ...grant, module: e.target.value as ModuleKey })}>
                {MODULE_KEYS.map((m) => <option key={m} value={m}>{MODULE_INFO[m].name}</option>)}
              </SelectField>
              <SelectField label={s.status} value={grant.enabled ? 'on' : 'off'} onChange={(e) => setGrant({ ...grant, enabled: e.target.value === 'on' })}>
                <option value="on">{s.enable}</option><option value="off">{s.disable}</option>
              </SelectField>
              <Field label={s.expiresAt} type="datetime-local" required value={grant.expiresAt} onChange={(e) => setGrant({ ...grant, expiresAt: e.target.value })} />
            </div>
            <Field label={s.reason} required minLength={3} maxLength={500} value={grant.reason} onChange={(e) => setGrant({ ...grant, reason: e.target.value })} />
            <button className="btn btn-primary" disabled={busy}>{s.save}</button>
          </form>
        )}
      </Card>

      <div className="grid grid-2" style={{ marginBlockStart: 16 }}>
        <Card title={s.branches}>
          <DataTable rows={d.branches} rowKey={(b) => b.id} columns={[
            { key: 'n', header: s.branches, render: (b) => <span>{b.name} <span className="fine" dir="ltr">{b.code}</span></span> },
            { key: 'c', header: '', render: (b) => b.city ?? '' },
            { key: 'a', header: '', align: 'end', render: (b) => <Badge tone={b.isActive ? 'ok' : 'warn'}>{b.isActive ? '✓' : '—'}</Badge> },
          ]} />
        </Card>
        {/* breaks the global .card + .card margin inside grids */}<span hidden />
        <Card title={s.integrations}>
          <p className="fine" style={{ marginTop: 0 }}>{s.credentialsNote}</p>
          {d.integrations.length ? (
            <DataTable rows={d.integrations} rowKey={(i) => i.id} columns={[
              { key: 'p', header: s.integrations, render: (i) => <span>{i.provider} <span className="fine">{i.category}</span></span> },
              { key: 'e', header: '', render: (i) => <Badge tone={i.environment === 'live' ? 'ok' : 'sandbox'}>{i.environment}</Badge> },
              { key: 's', header: s.status, render: (i) => <span>{i.status}{i.lastError && <div className="fine" style={{ color: 'var(--danger)' }}>{i.lastError}</div>}</span> },
              { key: 'h', header: '', render: (i) => dateTime(i.lastHealthCheckAt, locale) },
            ]} />
          ) : <EmptyState title={s.noIntegrations} />}
        </Card>
      </div>

      <Card title={s.recentAudit}>
        <DataTable rows={d.recentAudit} rowKey={(a) => String(a.id)} columns={[
          { key: 't', header: '', render: (a) => <span className="num">{dateTime(a.createdAt, locale)}</span> },
          { key: 'w', header: '', render: (a) => <Badge tone={a.actorType === 'platform_admin' ? 'pay' : 'neutral'}>{a.actorType}</Badge> },
          { key: 'a', header: '', render: (a) => <code>{a.action}</code> },
          { key: 'e', header: '', render: (a) => <span className="fine">{a.entityType ?? ''} · {a.source}</span> },
        ]} />
      </Card>

      <Modal open={statusOpen} onClose={() => setStatusOpen(false)} title={suspended ? s.reactivate : s.suspend}
        footer={<><button className="btn" onClick={() => setStatusOpen(false)}>{s.cancel}</button>
          <button className={`btn ${suspended ? 'btn-primary' : 'btn-danger'}`} disabled={busy || reason.trim().length < 3}
            onClick={() => void run(() => call(`/admin/tenants/${orgId}/${suspended ? 'reactivate' : 'suspend'}`, { body: { reason } }), () => setStatusOpen(false))}>{s.confirm}</button></>}>
        {!suspended && <p>{s.suspendBody}</p>}
        <TextareaField label={s.reason} value={reason} required minLength={3} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      </Modal>
      <Modal open={!!revoking} onClose={() => setRevoking(null)} title={`${s.revoke} — ${revoking?.module ?? ''}`}
        footer={<><button className="btn" onClick={() => setRevoking(null)}>{s.cancel}</button>
          <button className="btn btn-danger" disabled={busy || reason.trim().length < 3}
            onClick={() => revoking && void run(() => call(`/admin/tenants/${orgId}/overrides/${revoking.id}/revoke`, { body: { reason } }), () => setRevoking(null))}>{s.confirm}</button></>}>
        <TextareaField label={s.reason} value={reason} required minLength={3} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      </Modal>
    </div>
  );
}
