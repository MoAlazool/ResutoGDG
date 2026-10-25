'use client';
// Marketing > Meta Pixel (INT-20 diagnostics) and the Custom Audience dry run (INT-22).
import { useState } from 'react';
import { Badge, Card, DataTableV2, EmptyState, Notice, Sheet, Skeleton, StatV2, useAction } from '@resuto/ui';
import { dateTime, money } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import st from './marketing.module.css';

interface CapiEvent {
  id: string; eventName: string; eventId: string; source: 'order' | 'test'; status: 'pending' | 'sent' | 'failed' | 'skipped'; skipReason: string | null;
  testMode: boolean; summary: { basis?: string; valueMinor?: number; currency?: string; matchKeys?: string[]; synthetic?: boolean }; attempts: number;
  eventsReceived: number | null; fbtraceId: string | null; error: string | null; sentAt: string | null; createdAt: string;
}
interface Diagnostics {
  connection: { id: string; environment: string; testMode: boolean; status: string; enabled: boolean; pixelId: string | null; browserPixel: boolean;
    codPurchase: 'on_completion' | 'never'; hasTestEventCode: boolean; lastError: string | null } | null;
  demoTenant: boolean; consentVersion: string;
  last7Days: { sent?: number; failed?: number; skipped?: number; pending?: number; consentedOrders: number };
  events: CapiEvent[];
}

const tone = (s: CapiEvent['status']) => (({ sent: 'ok', failed: 'danger', skipped: 'neutral', pending: 'warn' } as const)[s]);

export function MetaTracking() {
  const { t, locale } = useT();
  const { org, can } = useOrg();
  const session = useSession();
  const diag = useApi<Diagnostics>(`/o/${org.id}/marketing/tracking/meta`);
  const [note, setNote] = useState<string | null>(null);
  const test = useAction(async () => {
    const r = await session.call<{ sent?: boolean; eventsReceived?: number; failed?: string }>(`/o/${org.id}/marketing/tracking/meta/test-event`, { method: 'POST' });
    setNote(r.sent ? t('marketing.meta.testSent', { n: r.eventsReceived ?? 0 }) : t('marketing.meta.testFailed', { error: r.failed ?? '' }));
    await diag.reload();
  });
  if (diag.error) return <Notice tone="danger">{diag.error.message}</Notice>;
  if (!diag.data) return <Skeleton />;
  const d = diag.data;
  const c = d.connection;
  return (
    <div className="stack" data-testid="meta-tracking">
      <Notice>{t('marketing.meta.help')}</Notice>
      {d.demoTenant && <Notice tone="warn">{t('marketing.meta.demo')}</Notice>}
      {!c ? (
        <EmptyState title={t('marketing.meta.notConnected')}>
          {t('marketing.meta.notConnectedBody')} <a href={`/dashboard/${org.id}/integrations`}>{t('nav.integrations')}</a>
        </EmptyState>
      ) : (
        <Card title={t('marketing.meta.connection')}>
          <div className="row gap-8 wrap">
            <Badge tone={c.status === 'connected' && c.enabled ? 'ok' : c.status === 'error' ? 'danger' : 'warn'}>{t(`marketing.meta.status.${c.enabled ? c.status : 'off'}`)}</Badge>
            <Badge tone={c.testMode ? 'sandbox' : 'info'}>{c.testMode ? t('marketing.meta.testMode') : t('marketing.meta.liveMode')}</Badge>
            <span className="fine" dir="ltr">{t('marketing.meta.pixel')}: {c.pixelId ?? '—'}</span>
            <span className="fine">{c.browserPixel ? t('marketing.meta.browserOn') : t('marketing.meta.browserOff')}</span>
            <span className="fine">{t(`marketing.meta.cod.${c.codPurchase}`)}</span>
          </div>
          {c.lastError && <Notice tone="danger">{c.lastError}</Notice>}
          {c.testMode && !c.hasTestEventCode && <Notice tone="warn">{t('marketing.meta.needsCode')}</Notice>}
          {can('integrations:manage') && c.testMode && (
            <button className="btn btn-sm mbs-10" disabled={test.pending} onClick={() => test.run()}>{t('marketing.meta.sendTest')}</button>
          )}
          {note && <Notice tone="info">{note}</Notice>}
          {test.error && <Notice tone="danger">{test.error}</Notice>}
        </Card>
      )}
      <div className="rui-stat-grid">
        <StatV2 label={t('marketing.meta.sent7')} value={d.last7Days.sent ?? 0} />
        <StatV2 label={t('marketing.meta.skipped7')} value={d.last7Days.skipped ?? 0} />
        <StatV2 label={t('marketing.meta.failed7')} value={d.last7Days.failed ?? 0} />
        <StatV2 label={t('marketing.meta.consented7')} value={d.last7Days.consentedOrders} />
      </div>
      <DataTableV2 label={t('marketing.tab.meta')} rows={d.events} rowKey={(e) => e.id} empty={<EmptyState title={t('marketing.meta.noEvents')} />} columns={[
        { key: 'ev', header: t('marketing.meta.event'), render: (e) => <><strong>{e.eventName}</strong> {e.source === 'test' && <Badge tone="sandbox">{t('marketing.meta.synthetic')}</Badge>}
          {e.testMode && e.source !== 'test' && <Badge tone="sandbox">{t('marketing.meta.testMode')}</Badge>}<div className="fine" dir="ltr">{e.eventId}</div></> },
        { key: 'st', header: t('marketing.meta.result'), render: (e) => <><Badge tone={tone(e.status)}>{t(`marketing.meta.evStatus.${e.status}`)}</Badge>
          {e.skipReason && <div className="fine">{t(`marketing.meta.skip.${e.skipReason}`)}</div>}{e.error && <div className="fine">{e.error}</div>}</> },
        { key: 'v', header: t('marketing.meta.value'), align: 'end', render: (e) => e.summary.valueMinor != null && e.summary.currency ? money(e.summary.valueMinor, e.summary.currency, locale) : '—' },
        { key: 'm', header: t('marketing.meta.matchKeys'), render: (e) => <span className="fine" dir="ltr">{(e.summary.matchKeys ?? []).join(', ') || '—'}</span> },
        { key: 'at', header: t('marketing.meta.when'), render: (e) => dateTime(e.sentAt ?? e.createdAt, locale) },
      ]} />
    </div>
  );
}

interface DryRun {
  counts: { segment: number; withConsent: number; matchable: number; excludedNoConsent: number; excludedNoIdentifier: number };
  batches: Array<{ rows: number }>; adAccountConnected: boolean; notes: string[]; create: { path: string };
}

/** INT-22: what a Meta Custom Audience upload of a segment would contain. Nothing is sent to Meta. */
export function AudienceDryRunButton({ segmentId }: { segmentId: string }) {
  const { t, locale } = useT();
  const { org } = useOrg();
  const session = useSession();
  const [plan, setPlan] = useState<DryRun | null>(null);
  const run = useAction(async () => setPlan(await session.call<DryRun>(`/o/${org.id}/marketing/segments/${segmentId}/meta-audience/dry-run`, { method: 'POST' })));
  return (
    <>
      <button className="btn btn-sm btn-ghost" disabled={run.pending} onClick={() => run.run()}>{t('marketing.audience.dryRun')}</button>
      {run.error && <Notice tone="danger">{run.error}</Notice>}
      {plan && (
        <Sheet open title={t('marketing.audience.title')} onClose={() => setPlan(null)} locale={locale}>
          <Notice tone="info">{t('marketing.audience.notSent')}</Notice>
          <div className={`rui-stat-grid ${st.dryRunStats}`}>
            <StatV2 label={t('marketing.audience.segment')} value={plan.counts.segment} />
            <StatV2 label={t('marketing.audience.consented')} value={plan.counts.withConsent} />
            <StatV2 label={t('marketing.audience.matchable')} value={plan.counts.matchable} />
          </div>
          <p className="fine">{t('marketing.audience.excluded', { noConsent: plan.counts.excludedNoConsent, noId: plan.counts.excludedNoIdentifier })}</p>
          <p className="fine">{t('marketing.audience.batches', { n: plan.batches.length })}</p>
          {!plan.adAccountConnected && <Notice tone="warn">{t('marketing.audience.noAccount')}</Notice>}
          <p className="fine">{t('marketing.audience.deferred')}</p>
        </Sheet>
      )}
    </>
  );
}
