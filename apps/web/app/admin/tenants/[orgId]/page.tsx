'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { MODULE_INFO, MODULE_KEYS, type AdminTenantDetail, type ModuleKey } from '@resuto/contracts';
import {
  Badge, DataTableV2, DetailPage, EmptyState, ErrorState, Field, KeyValueList, Notice, Panel, SelectField, Sheet, StatV2,
  usePrompt, type ColumnV2,
} from '@resuto/ui';
import { AreaSkeleton } from '@/components/shell/AreaSkeleton';
import { dateTime, money } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { pick } from '@/lib/pick';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { AdminIcon } from '../../admin-icons';
import { useAdmin } from '../../AdminShell';
import { countryLabel, planLabel, statusLabel, subscriptionLabel } from '../../console';
import { fill } from '../../strings';
import { ORG_TONE, SUB_TONE } from '../../tones';

type Detail = AdminTenantDetail;
const inDays = (d: number) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 16);

/**
 * One restaurant (21-ADMIN): DetailPage with the figures, modules, overrides, branches, integrations (status only,
 * never credentials) and recent activity in the main column; status, identifiers and billing in the inspector.
 * Suspend, reactivate and revoke ask for a recorded reason; grants open a sheet. Writes need tenants:write.
 */
export default function AdminTenantPage() {
  const { locale } = useT();
  const { s, can } = useAdmin();
  const { orgId } = useParams<{ orgId: string }>();
  const { call } = useSession();
  const t = useApi<Detail>(`/admin/tenants/${orgId}`);
  const [prompt, promptDialog] = usePrompt(locale);
  const [grantOpen, setGrantOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const write = can('tenants:write');

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg({ tone: 'ok', text: ok }); await t.reload(); return true; }
    catch (e) { setMsg({ tone: 'danger', text: (e as Error).message }); return false; }
    finally { setBusy(false); }
  }

  if (t.error && !t.data) {
    return t.error.status === 404
      ? <EmptyState title={s.tenantMissing} action={<Link className="btn" href="/admin">{s.tenants}</Link>} />
      : <ErrorState locale={locale} error={{ status: t.error.status, code: t.error.code, message: t.error.message, requestId: t.error.requestId }} onRetry={t.reload} />;
  }
  if (!t.data) return <AreaSkeleton template="detail" />;
  const d = t.data;
  const suspended = d.status === 'suspended';
  const moduleName = (m: string) => (m in MODULE_INFO ? pick(locale, MODULE_INFO[m as ModuleKey].name, MODULE_INFO[m as ModuleKey].nameAr) : m);

  const changeStatus = async () => {
    const reason = await prompt({ title: suspended ? s.reactivate : s.suspend, body: suspended ? undefined : s.suspendBody, label: s.reason,
      minLength: 3, maxLength: 500, multiline: true, confirmLabel: s.confirm, cancelLabel: s.cancel, tone: suspended ? 'default' : 'danger' });
    if (!reason) return;
    await run(() => call(`/admin/tenants/${orgId}/${suspended ? 'reactivate' : 'suspend'}`, { body: { reason } }), suspended ? s.reactivatedDone : s.suspendedDone);
  };
  const revoke = async (o: Detail['overrides'][number]) => {
    const reason = await prompt({ title: fill(s.revokeTitle, { module: moduleName(o.module) }), label: s.reason, minLength: 3, maxLength: 500,
      multiline: true, confirmLabel: s.revoke, cancelLabel: s.cancel, tone: 'danger' });
    if (!reason) return;
    await run(() => call(`/admin/tenants/${orgId}/overrides/${o.id}/revoke`, { body: { reason } }), s.revokedDone);
  };

  const overrideCols: ColumnV2<Detail['overrides'][number]>[] = [
    { key: 'm', header: s.module, rowHeader: true, render: (o) => <strong>{moduleName(o.module)}</strong> },
    { key: 'e', header: s.status, render: (o) => <Badge tone={o.enabled ? 'ok' : 'danger'}>{o.enabled ? s.enabled : s.blocked}</Badge> },
    { key: 'r', header: s.reason, render: (o) => <bdi>{o.reason}</bdi> },
    { key: 'x', header: s.expiresAt, sort: (a, b) => Date.parse(a.expiresAt ?? '9999') - Date.parse(b.expiresAt ?? '9999'), render: (o) => <span className="num">{dateTime(o.expiresAt, locale)}</span> },
    { key: 'a', header: s.active, align: 'end', render: (o) => o.active
      ? (write ? <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => void revoke(o)}>{s.revoke}</button> : <Badge tone="ok">{s.active}</Badge>)
      : <Badge>{s.expired}</Badge> },
  ];
  const branchCols: ColumnV2<Detail['branches'][number]>[] = [
    { key: 'n', header: s.branches, rowHeader: true, render: (b) => <bdi>{b.name}</bdi> },
    { key: 'c', header: s.code, render: (b) => <span className="admin-code" dir="ltr">{b.code}</span> },
    { key: 'city', header: s.city, render: (b) => (b.city ? <bdi>{b.city}</bdi> : '—') },
    { key: 'a', header: s.status, align: 'end', render: (b) => <Badge tone={b.isActive ? 'ok' : 'warn'}>{b.isActive ? s.brActive : s.brInactive}</Badge> },
  ];
  const integrationCols: ColumnV2<Detail['integrations'][number]>[] = [
    { key: 'p', header: s.provider, rowHeader: true, render: (i) => <span><span className="admin-code" dir="ltr">{i.provider}</span> <span className="fine">{i.category}</span></span> },
    { key: 'e', header: s.environment, render: (i) => <Badge tone={i.environment === 'live' ? 'ok' : 'sandbox'}>{i.environment === 'live' ? s.env_live : s.env_sandbox}</Badge> },
    { key: 's', header: s.status, render: (i) => <span>{i.status}{i.lastError && <span className="admin-error-text" dir="auto"><br />{i.lastError}</span>}</span> },
    { key: 'h', header: s.health, render: (i) => <span className="num">{dateTime(i.lastHealthCheckAt, locale)}</span> },
  ];
  const auditCols: ColumnV2<Detail['recentAudit'][number]>[] = [
    { key: 't', header: s.when, render: (a) => <span className="num">{dateTime(a.createdAt, locale)}</span> },
    { key: 'w', header: s.actor, render: (a) => <Badge tone={a.actorType === 'platform_admin' ? 'pay' : 'neutral'}>{a.actorType}</Badge> },
    { key: 'a', header: s.action, rowHeader: true, render: (a) => <span className="admin-code" dir="ltr">{a.action}</span> },
    { key: 'e', header: s.entity, render: (a) => <span className="fine" dir="ltr">{a.entityType ?? ''} · {a.source}</span> },
  ];

  const sub = d.subscription;
  const inspector = (
    <>
      <Panel title={s.status}>
        <div className="admin-stack">
          <div className="admin-row">
            <Badge tone={ORG_TONE[d.status]}>{statusLabel(s, d.status)}</Badge>
            <Badge>{planLabel(s, d.planId)}</Badge>
            {d.subscriptionStatus && <Badge tone={SUB_TONE[d.subscriptionStatus]}>{subscriptionLabel(s, d.subscriptionStatus)}</Badge>}
          </div>
          <KeyValueList items={[
            { key: 'created', label: s.created, value: <span className="num">{dateTime(d.createdAt, locale)}</span> },
            { key: 'last', label: s.lastOrder, value: <span className="num">{dateTime(d.lastOrderAt, locale)}</span> },
          ]} />
        </div>
      </Panel>
      <Panel title={s.identifiers}>
        <KeyValueList items={[
          { key: 'id', label: s.idLabel, value: <span className="admin-code" dir="ltr">{d.id}</span> },
          { key: 'slug', label: s.slugLabel, value: <span className="admin-code" dir="ltr">{d.slug}</span> },
          { key: 'country', label: s.country, value: countryLabel(s, d.country) },
          { key: 'tz', label: s.timezone, value: <span dir="ltr">{d.timezone}</span> },
        ]} />
      </Panel>
      <Panel title={s.subscription}>
        {d.billingVisible && sub ? (
          <div className="admin-stack">
            <KeyValueList items={[
              { key: 'plan', label: s.plan, value: planLabel(s, sub.planId) },
              { key: 'status', label: s.status, value: <Badge tone={SUB_TONE[sub.status]}>{subscriptionLabel(s, sub.status)}</Badge> },
              { key: 'period', label: s.period, value: <span className="num">{dateTime(sub.currentPeriodStart, locale)} – {dateTime(sub.currentPeriodEnd, locale)}</span> },
              { key: 'interval', label: s.interval, value: sub.interval === 'year' ? s.year : sub.interval === 'month' ? s.month : sub.interval },
              ...(sub.trialEndsAt ? [{ key: 'trial', label: s.trialEnds, value: <span className="num">{dateTime(sub.trialEndsAt, locale)}</span> }] : []),
              ...(sub.graceUntil ? [{ key: 'grace', label: s.graceUntil, value: <span className="num">{dateTime(sub.graceUntil, locale)}</span> }] : []),
              ...(sub.pendingPlanId ? [{ key: 'pending', label: s.pending, value: planLabel(s, sub.pendingPlanId) }] : []),
              { key: 'addons', label: s.addons, value: sub.addons.length ? sub.addons.map(moduleName).join(locale === 'ar' ? '، ' : ', ') : s.none },
            ]} />
            {sub.cancelAtPeriodEnd && <Badge tone="warn">{s.cancelAtEnd}</Badge>}
            {sub.invoices.length > 0 && (
              <div>
                <strong className="fine">{s.invoices}</strong>
                <ul className="admin-invoices">
                  {sub.invoices.map((i) => <li key={i.id} className="num"><span dir="ltr">{i.number}</span> · {money(i.totalMinor, i.currency, locale)} · {i.status}</li>)}
                </ul>
              </div>
            )}
          </div>
        ) : <p className="admin-note">{d.billingVisible ? s.none : s.billingHidden}</p>}
      </Panel>
    </>
  );

  return (
    <DetailPage inspectorLabel={s.overview}
      header={{
        eyebrow: <Link href="/admin" className="admin-back"><AdminIcon name="back" size={16} />{s.tenants}</Link>,
        title: <bdi>{pick(locale, d.name, d.nameAr)}</bdi>,
        subtitle: <span dir="ltr">{d.slug} · {d.country} · {d.timezone}</span>,
        actions: write && d.status !== 'closed'
          ? <button type="button" className={`btn ${suspended ? 'btn-primary' : 'btn-danger'}`} disabled={busy} onClick={() => void changeStatus()}>{suspended ? s.reactivate : s.suspend}</button>
          : undefined,
      }}
      inspector={inspector}>
      {promptDialog}
      <div className="admin-stack">
        {!write && <Notice>{s.readOnly}</Notice>}
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        <div className="rui-stat-grid" role="group" aria-label={s.figures}>
          <StatV2 locale={locale} label={s.branches} value={d.counts.branches} provenance="live" />
          <StatV2 locale={locale} label={s.colMembers} value={d.counts.members} provenance="live" />
          <StatV2 locale={locale} label={s.colOrders} value={d.counts.orders30d} provenance="live" />
        </div>
        <Panel title={s.modules}>
          <ul className="admin-modules">
            {MODULE_KEYS.map((m) => (
              <li key={m} className="admin-module" data-on={d.modules[m] ? '' : undefined}>
                <AdminIcon name={d.modules[m] ? 'done' : 'todo'} size={14} />
                <span>{moduleName(m)}</span>
                <span className="sr-only">{d.modules[m] ? s.modOn : s.modOff}</span>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title={s.overrides} actions={write ? <button type="button" className="btn btn-sm" onClick={() => setGrantOpen(true)}>{s.grantOpen}</button> : undefined}>
          <DataTableV2 label={s.overrides} locale={locale} rows={d.overrides} rowKey={(o) => o.id} columns={overrideCols} empty={<EmptyState title={s.noOverrides} />} />
        </Panel>
        <Panel title={s.branches}>
          <DataTableV2 label={s.branches} locale={locale} rows={d.branches} rowKey={(b) => b.id} columns={branchCols} empty={<EmptyState title={s.noBranches} />} />
        </Panel>
        <Panel title={s.integrations} note={s.credentialsNote}>
          <DataTableV2 label={s.integrations} locale={locale} rows={d.integrations} rowKey={(i) => i.id} columns={integrationCols} empty={<EmptyState title={s.noIntegrations} />} />
        </Panel>
        <Panel title={s.recentAudit}>
          <DataTableV2 label={s.recentAudit} locale={locale} rows={d.recentAudit} rowKey={(a) => String(a.id)} columns={auditCols} empty={<EmptyState title={s.noAudit} />} />
        </Panel>
      </div>
      {write && (
        <GrantSheet open={grantOpen} onClose={() => setGrantOpen(false)} busy={busy}
          onSubmit={async (g) => {
            const ok = await run(() => call(`/admin/tenants/${orgId}/overrides`, { body: { ...g, expiresAt: new Date(g.expiresAt).toISOString() } }), s.grantedDone);
            if (ok) setGrantOpen(false);
          }} />
      )}
    </DetailPage>
  );
}

interface Grant { module: ModuleKey; enabled: boolean; reason: string; expiresAt: string }

/** Grant or block one module until a date, with a recorded reason (POST /admin/tenants/:id/overrides). */
function GrantSheet({ open, onClose, onSubmit, busy }: { open: boolean; onClose: () => void; onSubmit: (g: Grant) => Promise<void>; busy: boolean }) {
  const { locale } = useT();
  const { s } = useAdmin();
  const [g, setG] = useState<Grant>({ module: 'pay', enabled: true, reason: '', expiresAt: inDays(30) });
  const formId = 'admin-grant-form';
  return (
    <Sheet open={open} onClose={onClose} title={s.grant} locale={locale} size="sm"
      footer={<div className="admin-form-actions">
        <button type="button" className="btn" onClick={onClose}>{s.cancel}</button>
        <button type="submit" form={formId} className="btn btn-primary" disabled={busy || g.reason.trim().length < 3} aria-busy={busy || undefined}>{s.save}</button>
      </div>}>
      <form id={formId} className="admin-form" onSubmit={(e: FormEvent) => { e.preventDefault(); void onSubmit(g).then(() => setG((x) => ({ ...x, reason: '' }))); }}>
        <SelectField label={s.module} value={g.module} onChange={(e) => setG({ ...g, module: e.target.value as ModuleKey })}>
          {MODULE_KEYS.map((m) => <option key={m} value={m}>{pick(locale, MODULE_INFO[m].name, MODULE_INFO[m].nameAr)}</option>)}
        </SelectField>
        <SelectField label={s.status} value={g.enabled ? 'on' : 'off'} onChange={(e) => setG({ ...g, enabled: e.target.value === 'on' })}>
          <option value="on">{s.enable}</option><option value="off">{s.disable}</option>
        </SelectField>
        <Field label={s.expiresAt} type="datetime-local" required value={g.expiresAt} onChange={(e) => setG({ ...g, expiresAt: e.target.value })} />
        <Field label={s.reason} required minLength={3} maxLength={500} value={g.reason} onChange={(e) => setG({ ...g, reason: e.target.value })} />
      </form>
    </Sheet>
  );
}
