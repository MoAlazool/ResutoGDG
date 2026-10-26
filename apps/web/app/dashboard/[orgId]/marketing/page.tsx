'use client';
import dynamic from 'next/dynamic';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AD_CHANNELS } from '@resuto/contracts';
import { Badge, DataTableV2, DateTimeInput, EmptyState, Field, Icon, ListPage, Notice, SelectField, Sheet, Skeleton, SkeletonTable, Tabs, TextareaField, useAction, useConfirm } from '@resuto/ui';
import { ClockIcon } from '@/components/icons/glyphs';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { createAttemptKeys } from '@/lib/attempt-keys';
import { dateTime } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { QuietHours } from './QuietHours';
import st from './marketing.module.css';

// Parts that are not on the default tab, or open on demand, load as their own chunks.
const MetaTracking = dynamic(() => import('./MetaTracking').then((m) => m.MetaTracking), { ssr: false, loading: () => <Skeleton /> });
const Segments = dynamic(() => import('./OtherTabs').then((m) => m.Segments), { ssr: false, loading: () => <Skeleton /> });
const Promotions = dynamic(() => import('./OtherTabs').then((m) => m.Promotions), { ssr: false, loading: () => <Skeleton /> });
const Links = dynamic(() => import('./OtherTabs').then((m) => m.Links), { ssr: false, loading: () => <Skeleton /> });
const Recommendations = dynamic(() => import('./OtherTabs').then((m) => m.Recommendations), { ssr: false, loading: () => <Skeleton /> });
const ReportModal = dynamic(() => import('./CampaignReport').then((m) => m.ReportModal), { ssr: false });

type TabKey = 'campaigns' | 'segments' | 'promotions' | 'links' | 'recommendations' | 'meta';
interface Segment { id: string; name: string; memberCount: number }
interface Campaign {
  id: string; name: string; objective: string; channel: string; status: string; segmentId: string | null; content: Record<string, any>; utmCampaign: string;
  budgetMinor: number | null; currency: string; scheduledAt: string | null; approvedAt: string | null; sentAt: string | null; isSandbox: boolean; source: string;
  externalCampaignId: string | null;
  /** PS-14: current or last ad launch attempt; token = the [rs:<token>] tag in the provider-side campaign name. */
  launch?: { token: string; startedAt: string | null; mode: 'live' | 'sandbox' | null; error: string | null; inProgress: boolean } | null;
}

export default function MarketingPage() {
  const { t } = useT();
  const [tab, setTab] = useState<TabKey>('campaigns');
  return (
    <ModuleGate module="marketing" permission="marketing:read">
      <ListPage header={{ title: t('marketing.title'), subtitle: t('marketing.subtitle') }}
        filters={<Tabs value={tab} onChange={setTab} tabs={(['campaigns', 'segments', 'promotions', 'links', 'recommendations', 'meta'] as TabKey[]).map((k) => ({ key: k, label: t(`marketing.tab.${k}`) }))} />}>
        {tab === 'campaigns' && <div className="stack gap-16"><Campaigns /><QuietHours /></div>}
        {tab === 'segments' && <Segments />}
        {tab === 'promotions' && <Promotions />}
        {tab === 'links' && <Links />}
        {tab === 'recommendations' && <Recommendations onApplied={() => setTab('campaigns')} />}
        {tab === 'meta' && <MetaTracking />}
      </ListPage>
    </ModuleGate>
  );
}

const statusTone = (s: string) => (({ draft: 'neutral', pending_approval: 'warn', approved: 'info', scheduled: 'info', sending: 'pay', launching: 'pay', sent: 'ok', cancelled: 'neutral', failed: 'danger' } as const)[s] ?? 'neutral');

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------
function Campaigns() {
  const { t, locale } = useT();
  const [confirm, confirmDialog] = useConfirm(locale);
  const { org, can } = useOrg();
  const session = useSession();
  const list = useApi<{ items: Campaign[] }>(`/o/${org.id}/marketing/campaigns`, { pollMs: 15000 });
  const segments = useApi<{ items: Segment[] }>(`/o/${org.id}/marketing/segments`);
  const templates = useApi<{ items: Array<{ name: string; language: string; providerStatus: string }> }>(`/o/${org.id}/connect/templates`);
  const [editing, setEditing] = useState(false);
  const [report, setReport] = useState<Campaign | null>(null);
  const [form, setForm] = useState({ name: '', channel: 'whatsapp', objective: 'retention', segmentId: '', text: '', templateName: '', budget: '', subject: '' });
  const [note, setNote] = useState<string | null>(null);
  const [scheduleFor, setScheduleFor] = useState<Record<string, string>>({});
  // "Next actions" on the overview (21-HOME) link here with ?draft=campaign&objective=…&name=…: the editor opens with
  // those values filled in. Nothing is saved until the member presses "Save draft"; the link is used once.
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => {
    if (search.get('draft') !== 'campaign' || !can('marketing:write')) return;
    const objective = search.get('objective') ?? '';
    setForm((f) => ({ ...f, name: (search.get('name') ?? '').slice(0, 120),
      objective: ['retention', 'reactivation', 'acquisition', 'upsell', 'awareness', 'reservations'].includes(objective) ? objective : f.objective }));
    setEditing(true);
    router.replace(pathname, { scroll: false });
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = useAction(async (e: FormEvent) => {
    e.preventDefault();
    const isAd = AD_CHANNELS.includes(form.channel as any);
    await session.call(`/o/${org.id}/marketing/campaigns`, { body: {
      name: form.name, channel: form.channel, objective: form.objective, segmentId: form.segmentId || null,
      content: isAd ? {} : { ...(form.text.trim() ? { text: form.text.trim() } : {}), ...(form.templateName && form.channel === 'whatsapp' ? { templateName: form.templateName } : {}),
        ...(form.channel === 'email' && form.subject.trim() ? { subject: form.subject.trim() } : {}) },
      budgetMinor: isAd && form.budget ? Math.round(Number(form.budget) * 100) : null,
    } });
    setEditing(false);
    setForm({ ...form, name: '', text: '' });
    await list.reload();
  });
  // PS-14: launches and sends carry an Idempotency-Key that stays the same while the same attempt is retried (same
  // campaign, action, mode and status), so a retried click replays instead of acting twice.
  const attempts = useRef(createAttemptKeys()).current;
  const act = useAction(async (c: Campaign, action: string, body?: unknown, idempotent = false) => {
    const scope = `${c.id}:${action}:${(body as { mode?: string } | undefined)?.mode ?? ''}:${c.status}`;
    const res = await session.call<any>(`/o/${org.id}/marketing/campaigns/${c.id}/${action}`, { method: 'POST', body: body ?? {},
      ...(idempotent ? { idempotencyKey: attempts.key(scope) } : {}) });
    if (idempotent) attempts.settled(scope);
    setNote(res?.note ?? (res?.delivery ? t('marketing.camp.sentSummary', res.delivery) : res?.imported !== undefined ? t('marketing.camp.imported', { n: res.imported }) : null));
    await list.reload();
  });
  const isAd = (c: { channel: string }) => AD_CHANNELS.includes(c.channel as any);

  return (
    <div className="stack">
      {confirmDialog}
      <div className="spread"><Notice>{t('marketing.camp.flow')}</Notice>
        {can('marketing:write') && <button className="btn btn-primary" onClick={() => setEditing(true)}>{t('marketing.camp.new')}</button>}</div>
      {note && <Notice tone="ok">{note}</Notice>}
      {act.error && <Notice tone="danger">{act.error}</Notice>}
      {!list.data ? <SkeletonTable rows={4} cols={4} /> : (
        <DataTableV2 label={t('marketing.tab.campaigns')} rows={list.data.items} rowKey={(c) => c.id} empty={<EmptyState title={t('marketing.camp.empty')}>{t('marketing.camp.emptyBody')}</EmptyState>} columns={[
          { key: 'name', header: t('marketing.camp.name'), render: (c) => <><strong>{c.name}</strong><div className="fine">{t(`marketing.channel.${c.channel}`)} · {t(`marketing.objective.${c.objective}`)}</div></> },
          { key: 'status', header: t('marketing.camp.status'), render: (c) => <div className="row gap-4"><Badge tone={statusTone(c.status)}>{t(`marketing.status.${c.status}`)}</Badge>
            {c.isSandbox && ['sent', 'sending'].includes(c.status) && <Badge tone="sandbox">{t('connect.sandbox.badge')}</Badge>}
            {c.source !== 'manual' && <Badge>{t(`marketing.source.${c.source}`)}</Badge>}
            {c.status === 'launching' && <span className={`fine ${st.fullRow}`}>{c.launch?.error ? <bdi dir="ltr">{c.launch.error}</bdi> : t('marketing.camp.launchingNote')}</span>}</div> },
          { key: 'when', header: t('marketing.camp.when'), render: (c) => <span className={`fine ${st.when}`}>{c.sentAt ? dateTime(c.sentAt, locale) : c.scheduledAt ? <><Icon icon={ClockIcon} size={14} label={t('marketing.camp.scheduleAt')} />{dateTime(c.scheduledAt, locale)}</> : '—'}</span> },
          { key: 'a', header: '', align: 'end', render: (c) => (
            <div className="row gap-4 justify-end">
              {c.status === 'draft' && can('marketing:write') && <button className="btn btn-sm" disabled={act.pending} onClick={() => act.run(c, 'submit')}>{t('marketing.camp.submit')}</button>}
              {c.status === 'pending_approval' && can('marketing:approve') && <>
                <button className="btn btn-sm btn-leaf" disabled={act.pending} onClick={() => act.run(c, 'approve')}>{t('marketing.camp.approve')}</button>
                <button className="btn btn-sm btn-ghost" disabled={act.pending} onClick={() => act.run(c, 'reject', {})}>{t('marketing.camp.reject')}</button></>}
              {['approved', 'scheduled'].includes(c.status) && !isAd(c) && can('marketing:write') && <>
                <span className={st.schedule}><DateTimeInput type="datetime-local" aria-label={t('marketing.camp.scheduleAt')}
                  value={scheduleFor[c.id] ?? ''} onChange={(e) => setScheduleFor({ ...scheduleFor, [c.id]: e.target.value })} /></span>
                <button className="btn btn-sm" disabled={act.pending || !scheduleFor[c.id]} onClick={() => act.run(c, 'schedule', { scheduledAt: new Date(scheduleFor[c.id]!).toISOString() })}>{t('marketing.camp.schedule')}</button>
                <button className="btn btn-sm btn-primary" disabled={act.pending} onClick={async () => { if (await confirm({ title: t('marketing.camp.sendConfirm'), confirmLabel: t('marketing.camp.sendNow') })) void act.run(c, 'send', undefined, true); }}>{t('marketing.camp.sendNow')}</button></>}
              {c.status === 'approved' && isAd(c) && can('marketing:write') && <>
                <button className="btn btn-sm btn-primary" disabled={act.pending} onClick={() => act.run(c, 'launch', { mode: 'live' }, true)}>{t('marketing.camp.launch')}</button>
                <button className="btn btn-sm btn-ghost" disabled={act.pending} onClick={() => act.run(c, 'launch', { mode: 'sandbox' }, true)}>{t('marketing.camp.launchSandbox')}</button></>}
              {c.status === 'launching' && c.launch?.error && can('marketing:approve') && <button className="btn btn-sm btn-ghost" disabled={act.pending}
                onClick={async () => { if (await confirm({ title: t('marketing.camp.launchResetConfirm', { tag: `[rs:${c.launch!.token}]` }), confirmLabel: t('marketing.camp.launchReset') })) void act.run(c, 'launch/reset', { confirmNotCreated: true }); }}>{t('marketing.camp.launchReset')}</button>}
              {c.status === 'sent' && isAd(c) && can('marketing:write') && <button className="btn btn-sm" disabled={act.pending}
                onClick={() => { const until = new Date().toISOString().slice(0, 10); const since = new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10); void act.run(c, 'insights/sync', { since, until }); }}>{t('marketing.camp.importResults')}</button>}
              {['draft', 'pending_approval', 'approved', 'scheduled'].includes(c.status) && can('marketing:write') && <button className="btn btn-sm btn-ghost" disabled={act.pending} onClick={() => act.run(c, 'cancel')}>{t('action.cancel')}</button>}
              <button className="btn btn-sm btn-ghost" onClick={() => setReport(c)}>{t('marketing.camp.report')}</button>
            </div>) },
        ]} />
      )}
      <Sheet open={editing} onClose={() => setEditing(false)} title={t('marketing.camp.new')} locale={locale}>
        <form onSubmit={create.run}>
          <Field label={t('marketing.camp.name')} value={form.name} required maxLength={120} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <div className="form-row">
            <SelectField label={t('marketing.camp.channel')} value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })}>
              {['whatsapp', 'meta_ads', 'tiktok_ads', 'snapchat_ads', 'organic', 'sms', 'email'].map((c) => <option key={c} value={c}>{t(`marketing.channel.${c}`)}</option>)}</SelectField>
            <SelectField label={t('marketing.camp.objective')} value={form.objective} onChange={(e) => setForm({ ...form, objective: e.target.value })}>
              {['retention', 'reactivation', 'acquisition', 'upsell', 'awareness', 'reservations'].map((o) => <option key={o} value={o}>{t(`marketing.objective.${o}`)}</option>)}</SelectField>
          </div>
          {(form.channel === 'sms' || form.channel === 'email') && <Notice>{t('marketing.camp.outboundProvider', { provider: form.channel === 'email' ? 'Resend' : 'Twilio' })}</Notice>}
          {AD_CHANNELS.includes(form.channel as any) ? (
            <Field label={t('marketing.camp.budget', { currency: org.currency })} type="number" min={0} step="0.01" value={form.budget} onChange={(e) => setForm({ ...form, budget: e.target.value })}
              hint={t('marketing.camp.adHint')} />
          ) : form.channel !== 'organic' && <>
            <SelectField label={t('marketing.camp.segment')} value={form.segmentId} onChange={(e) => setForm({ ...form, segmentId: e.target.value })}>
              <option value="">—</option>{segments.data?.items.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.memberCount})</option>)}</SelectField>
            {form.channel === 'email' && <Field label={t('marketing.camp.subject')} value={form.subject} maxLength={200} onChange={(e) => setForm({ ...form, subject: e.target.value })} />}
            <TextareaField label={t('marketing.camp.text')} value={form.text} maxLength={1024} onChange={(e) => setForm({ ...form, text: e.target.value })} hint={t('marketing.camp.textHint')} />
            {form.channel === 'whatsapp' && <SelectField label={t('marketing.camp.template')} value={form.templateName} onChange={(e) => setForm({ ...form, templateName: e.target.value })}>
              <option value="">—</option>{templates.data?.items.filter((x) => ['approved', 'sandbox'].includes(x.providerStatus)).map((x) => <option key={`${x.name}-${x.language}`} value={x.name}>{x.name} ({x.language}) · {x.providerStatus}</option>)}
            </SelectField>}
            <p className="fine">{t('marketing.camp.consentNote')}</p>
          </>}
          {create.error && <Notice tone="danger">{create.error}</Notice>}
          <button className="btn btn-primary" disabled={create.pending}>{t('marketing.camp.saveDraft')}</button>
        </form>
      </Sheet>
      {report && <ReportModal campaign={report} onClose={() => setReport(null)} />}
    </div>
  );
}
