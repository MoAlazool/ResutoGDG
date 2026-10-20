'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { CONSENT_SOURCES, type CustomerProfile, type CustomerSummary } from '@resuto/contracts';
import { Badge, DataTable, EmptyState, Field, Modal, Notice, PageHeader, SelectField, Skeleton, Stat, TextareaField, useAction, Phone, Email, Ltr, UserText } from '@resuto/ui';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { LoadError, qs, Section, useBranchName, useFormat, InsightsPage } from '@/components/charts/insights';
import { dateTime } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';

export default function CustomerProfilePage() {
  const { customerId } = useParams<{ customerId: string }>();
  const { t, locale } = useT();
  const { org, can } = useOrg();
  const session = useSession();
  const f = useFormat();
  const branchName = useBranchName();
  const base = `/o/${org.id}/customers/${customerId}`;
  const { data: c, error, reload, setData } = useApi<CustomerProfile>(base);
  const [edit, setEdit] = useState<{ displayName: string; tags: string; notes: string } | null>(null);
  const [consent, setConsent] = useState<{ granted: boolean; source: string; note: string } | null>(null);
  const [anon, setAnon] = useState<{ reason: string; typed: string } | null>(null);
  const [merge, setMerge] = useState<{ q: string; picked: CustomerSummary | null } | null>(null);
  const writable = can('customers:write');

  const saveEdit = useAction(async (e: FormEvent) => {
    e.preventDefault();
    const tags = edit!.tags.split(',').map((x) => x.trim()).filter(Boolean);
    setData(await session.call<CustomerProfile>(base, { method: 'PATCH', body: { displayName: edit!.displayName || null, tags, notes: edit!.notes || null } }));
    setEdit(null);
  });
  const saveConsent = useAction(async (e: FormEvent) => {
    e.preventDefault();
    await session.call(`${base}/consent`, { method: 'POST', body: { granted: consent!.granted, source: consent!.source, note: consent!.note || null } });
    setConsent(null);
    await reload();
  });
  const doAnon = useAction(async (e: FormEvent) => {
    e.preventDefault();
    await session.call(`${base}/anonymise`, { method: 'POST', body: { confirm: true, reason: anon!.reason } });
    setAnon(null);
    await reload();
  });
  const candidates = useApi<{ items: CustomerSummary[] }>(merge && merge.q.trim().length >= 2 ? `/o/${org.id}/customers${qs({ q: merge.q.trim(), limit: 10 })}` : null);
  const [mergeResult, setMergeResult] = useState<{ consentConflict: boolean; moved: Record<string, number> } | null>(null);
  const doMerge = useAction(async () => {
    const res = await session.call<{ consentConflict: boolean; moved: Record<string, number> }>(`${base}/merge`, { method: 'POST', body: { duplicateId: merge!.picked!.id } });
    setMerge(null);
    setMergeResult(res);
    await reload();
  });

  if (error?.code === 'customer_merged') {
    const into = (error.details as { mergedIntoId?: string })?.mergedIntoId;
    return <Notice>{t('insights.profile.merged')} {into && <Link href={`/dashboard/${org.id}/customers/${into}`}>{t('insights.profile.openSurvivor')}</Link>}</Notice>;
  }
  return (
    <ModuleGate module="core" permission="customers:read"><InsightsPage>
      <p><Link href={`/dashboard/${org.id}/customers`} className="fine">← {t('insights.customers.title')}</Link></p>
      <LoadError error={error} retry={reload} />
      {!c && !error && <div className="card"><Skeleton lines={6} /></div>}
      {c && (
        <>
          <PageHeader overline={t('nav.customers')} title={c.displayName ? <UserText>{c.displayName}</UserText> : t('insights.customers.unnamed')}
            subtitle={<span className="row" style={{ gap: 6 }}>
              {c.anonymisedAt && <Badge tone="danger">{t('insights.profile.anonymised')}</Badge>}
              {c.marketingConsent ? <Badge tone="ok">✓ {t('insights.customers.consentGranted')}</Badge> : <Badge>{t('insights.customers.consentNot')}</Badge>}
              {c.tags.map((tg) => <Badge key={tg} tone="info">{tg}</Badge>)}
            </span>}
            actions={writable && !c.anonymisedAt ? <button className="btn" onClick={() => setEdit({ displayName: c.displayName ?? '', tags: c.tags.join(', '), notes: c.notes ?? '' })}>{t('action.edit')}</button> : undefined} />
          {mergeResult && <Notice tone={mergeResult.consentConflict ? 'warn' : 'ok'}>{t('insights.profile.mergeDone', { orders: mergeResult.moved.orders ?? 0 })} {mergeResult.consentConflict && t('insights.profile.consentConflict')}</Notice>}
          <div className="grid grid-4" style={{ marginBlockEnd: 16 }}>
            <Stat label={t('insights.kpi.orders')} value={f.num(c.totals.orderCount)} hint={c.totals.cancelledCount ? t('insights.kpi.cancelled', { count: c.totals.cancelledCount }) : undefined} />
            <Stat label={t('insights.customers.spend')} value={f.money(c.totals.netMinor)} hint={c.totals.refundedMinor ? t('insights.profile.refunded', { value: f.money(c.totals.refundedMinor) }) : undefined} />
            <Stat label={t('insights.kpi.aov')} value={f.money(c.totals.averageOrderMinor)} />
            <Stat label={t('insights.customers.lastOrder')} value={c.lastOrderAt ? dateTime(c.lastOrderAt, locale, org.timezone) : '—'} />
          </div>
          <div className="grid grid-2" style={{ alignItems: 'start' }}>
            <Section title={t('insights.profile.details')}>
              <dl className="stack" style={{ gap: 8, margin: 0 }}>
                <div><dt className="fine">{t('insights.customers.phone')}</dt><dd style={{ margin: 0 }}>{c.phone ? <Phone value={c.phone} link /> : '—'}</dd></div>
                <div><dt className="fine">{t('insights.customers.email')}</dt><dd style={{ margin: 0 }}>{c.email ? <Email value={c.email} link /> : '—'}</dd></div>
                <div><dt className="fine">{t('insights.profile.identities')}</dt><dd style={{ margin: 0 }}>{c.identities.length ? c.identities.map((i) => <Badge key={i.id}>{i.kind}: <Ltr>{i.value}</Ltr></Badge>) : '—'}</dd></div>
                <div><dt className="fine">{t('insights.profile.addresses')}</dt><dd style={{ margin: 0 }}>{c.addresses.length ? c.addresses.map((a) => <div key={a.id}>{[a.label, a.line1, a.area, a.city].filter(Boolean).map((part, n) => <span key={n}>{n > 0 && ' · '}<UserText>{part}</UserText></span>)}</div>) : '—'}</dd></div>
                <div><dt className="fine">{t('insights.profile.notes')}</dt><dd style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{c.notes ? <UserText>{c.notes}</UserText> : '—'}</dd></div>
                <div><dt className="fine">{t('insights.profile.firstSeen')}</dt><dd style={{ margin: 0 }}>{c.firstOrderAt ? dateTime(c.firstOrderAt, locale, org.timezone) : '—'}</dd></div>
              </dl>
            </Section>
            <Section title={t('insights.profile.consent')} actions={writable && !c.anonymisedAt ? (
              <button className="btn btn-sm" onClick={() => setConsent({ granted: !c.marketingConsent, source: 'staff_verbal', note: '' })}>
                {c.marketingConsent ? t('insights.profile.recordRevoke') : t('insights.profile.recordGrant')}</button>) : undefined}>
              <p className="fine">{t('insights.profile.consentHelp')}</p>
              {c.consentHistory.length ? (
                <ol className="stack" style={{ gap: 6, margin: 0, paddingInlineStart: 18 }}>
                  {c.consentHistory.map((e) => (
                    <li key={e.id}><Badge tone={e.granted ? 'ok' : 'neutral'}>{e.granted ? t('insights.profile.granted') : t('insights.profile.revoked')}</Badge>{' '}
                      <span className="fine">{dateTime(e.occurredAt, locale, org.timezone)} · {e.source}{e.note ? ` · ${e.note}` : ''}</span></li>
                  ))}
                </ol>
              ) : <p className="muted">{t('insights.profile.noConsent')}</p>}
            </Section>
          </div>
          <Section title={t('insights.profile.orders')}>
            <DataTable rows={c.orders} rowKey={(o) => o.id} empty={<EmptyState title={t('insights.profile.noOrders')} />} columns={[
              { key: 'n', header: '#', render: (o) => <span className="num">{o.number}</span> },
              { key: 'at', header: t('insights.inventory.when'), render: (o) => <span className="fine">{dateTime(o.placedAt, locale, org.timezone)}</span> },
              { key: 'branch', header: t('insights.branch.label'), render: (o) => branchName(o.branchId) },
              { key: 'ch', header: t('insights.marketing.channel'), render: (o) => `${t(`insights.channel.${o.channel}`)} · ${t(`insights.fulfillment.${o.fulfillment}`)}` },
              { key: 'st', header: t('insights.inventory.status'), render: (o) => <Badge tone={o.status === 'cancelled' ? 'danger' : 'neutral'}>{t(`insights.status.${o.status}`)}</Badge> },
              { key: 'total', header: t('insights.profile.total'), align: 'end', render: (o) => <span className="num">{f.money(o.totalMinor)}{o.refundedMinor ? <span className="fine"> (−{f.money(o.refundedMinor)})</span> : null}</span> },
            ]} />
          </Section>
          <Section title={t('insights.profile.reservations')}>
            <DataTable rows={c.reservations} rowKey={(r) => r.id} empty={<EmptyState title={t('insights.profile.noReservations')} />} columns={[
              { key: 'code', header: t('insights.profile.code'), render: (r) => <span className="num">{r.code}</span> },
              { key: 'at', header: t('insights.inventory.when'), render: (r) => dateTime(r.startsAt, locale, org.timezone) },
              { key: 'party', header: t('insights.profile.party'), align: 'end', render: (r) => r.partySize },
              { key: 'st', header: t('insights.inventory.status'), render: (r) => <Badge>{r.status}</Badge> },
            ]} />
          </Section>
          {writable && !c.anonymisedAt && (
            <Section title={t('insights.profile.danger')}>
              <div className="grid grid-2">
                <div>
                  <h3>{t('insights.profile.merge')}</h3>
                  <p className="fine">{t('insights.profile.mergeHelp')}</p>
                  <button className="btn" onClick={() => setMerge({ q: '', picked: null })}>{t('insights.profile.mergeStart')}</button>
                </div>
                {can('customers:export') && (
                  <div>
                    <h3>{t('insights.profile.anonymise')}</h3>
                    <p className="fine">{t('insights.profile.anonymiseHelp')}</p>
                    <button className="btn btn-danger" onClick={() => setAnon({ reason: '', typed: '' })}>{t('insights.profile.anonymise')}</button>
                  </div>
                )}
              </div>
            </Section>
          )}

          <Modal open={!!edit} onClose={() => setEdit(null)} title={t('action.edit')}>
            {edit && (
              <form onSubmit={saveEdit.run}>
                <Field label={t('insights.customers.name')} value={edit.displayName} maxLength={120} onChange={(e) => setEdit({ ...edit, displayName: e.target.value })} />
                <Field label={t('insights.customers.tags')} value={edit.tags} hint={t('insights.profile.tagsHint')} onChange={(e) => setEdit({ ...edit, tags: e.target.value })} />
                <TextareaField label={t('insights.profile.notes')} value={edit.notes} maxLength={2000} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} />
                {saveEdit.error && <Notice tone="danger">{saveEdit.error}</Notice>}
                <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn btn-primary" disabled={saveEdit.pending}>{t('action.save')}</button></div>
              </form>
            )}
          </Modal>
          <Modal open={!!consent} onClose={() => setConsent(null)} title={consent?.granted ? t('insights.profile.recordGrant') : t('insights.profile.recordRevoke')}>
            {consent && (
              <form onSubmit={saveConsent.run}>
                <p className="fine">{t('insights.profile.consentExplicit')}</p>
                <SelectField label={t('insights.profile.source')} value={consent.source} onChange={(e) => setConsent({ ...consent, source: e.target.value })}>
                  {CONSENT_SOURCES.map((s) => <option key={s} value={s}>{t(`insights.consentSource.${s}`)}</option>)}
                </SelectField>
                <Field label={t('insights.movement.note')} maxLength={300} value={consent.note} onChange={(e) => setConsent({ ...consent, note: e.target.value })} />
                {saveConsent.error && <Notice tone="danger">{saveConsent.error}</Notice>}
                <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn btn-primary" disabled={saveConsent.pending}>{t('action.confirm')}</button></div>
              </form>
            )}
          </Modal>
          <Modal open={!!anon} onClose={() => setAnon(null)} title={t('insights.profile.anonymise')}>
            {anon && (
              <form onSubmit={doAnon.run}>
                <Notice tone="danger">{t('insights.profile.anonymiseWarn')}</Notice>
                <Field label={t('insights.profile.reason')} required minLength={3} value={anon.reason} onChange={(e) => setAnon({ ...anon, reason: e.target.value })} />
                <Field label={t('insights.profile.typeConfirm', { word: 'ANONYMISE' })} value={anon.typed} onChange={(e) => setAnon({ ...anon, typed: e.target.value })} />
                {doAnon.error && <Notice tone="danger">{doAnon.error}</Notice>}
                <div className="row" style={{ justifyContent: 'flex-end' }}>
                  <button className="btn btn-danger" disabled={doAnon.pending || anon.typed !== 'ANONYMISE' || anon.reason.trim().length < 3}>{t('insights.profile.anonymise')}</button>
                </div>
              </form>
            )}
          </Modal>
          <Modal open={!!merge} onClose={() => setMerge(null)} title={t('insights.profile.merge')}>
            {merge && (
              <div>
                <p className="fine">{t('insights.profile.mergeKeep', { name: c.displayName ?? t('insights.customers.unnamed') })}</p>
                <Field label={t('insights.profile.findDuplicate')} type="search" value={merge.q} onChange={(e) => setMerge({ q: e.target.value, picked: null })} />
                <div className="stack" style={{ gap: 6 }}>
                  {(candidates.data?.items ?? []).filter((x) => x.id !== c.id).map((x) => (
                    <label key={x.id} className="check">
                      <input type="radio" name="dup" checked={merge.picked?.id === x.id} onChange={() => setMerge({ ...merge, picked: x })} />
                      {x.displayName ?? t('insights.customers.unnamed')} <span className="fine" dir="ltr">{x.phone ?? x.email ?? ''}</span>
                      <span className="fine">· {t('insights.ordersCount', { count: x.orderCount })}</span>
                    </label>
                  ))}
                </div>
                {merge.picked && <Notice tone="warn">{t('insights.profile.mergeWarn', { name: merge.picked.displayName ?? t('insights.customers.unnamed') })}</Notice>}
                {doMerge.error && <Notice tone="danger">{doMerge.error}</Notice>}
                <div className="row" style={{ justifyContent: 'flex-end', marginBlockStart: 12 }}>
                  <button className="btn btn-primary" disabled={!merge.picked || doMerge.pending} onClick={() => doMerge.run()}>{t('insights.profile.mergeConfirm')}</button>
                </div>
              </div>
            )}
          </Modal>
        </>
      )}
    </InsightsPage></ModuleGate>
  );
}
