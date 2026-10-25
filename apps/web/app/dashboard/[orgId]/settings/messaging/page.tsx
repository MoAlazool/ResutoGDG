'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Badge, Card, DataTable, EmptyState, Field, Notice, PageHeader, SelectField, Skeleton, Tabs, TextareaField, useAction } from '@resuto/ui';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { SectionNav } from '@/components/shell/SectionNav';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { SETTINGS_SECTIONS } from '@/lib/sections';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { ChannelKindBadge, EmbeddedSignupCard, PageChannelCard, SIGNUP_RELOAD_PARAM, VerifyCell } from './MetaChannels';
import { WhatsAppStepperLauncher } from './WhatsAppStepper';

// Settings › Messaging (21-INBOX increment 2, plan §6.5): the Inbox's Channels and Templates tabs moved here unchanged.
// /inbox?tab=channels and ?tab=templates redirect to this page. WhatsApp Embedded Signup runs here, so this document
// gets Meta's SDK hosts in its Content-Security-Policy (lib/csp.ts META_SDK_PAGE).

interface Channel { id: string; kind: string; transport: string; sandbox: boolean; displayName: string; status: string; orderingEnabled: boolean; phoneNumberId: string | null;
  verified: boolean | null; webhookSubscribed: boolean | null }
interface Template { id: string; name: string; language: string; category: string; body: string; variables: string[]; providerStatus: string; sandbox: boolean }
type Tab = 'channels' | 'templates';

export default function MessagingSettingsPage() {
  const { t } = useT();
  const { org } = useOrg();
  const router = useRouter();
  const params = useSearchParams();
  const [tab, setTab] = useState<Tab>(params.get('tab') === 'templates' ? 'templates' : 'channels');
  // The WhatsApp signup launcher reloads this page (for its Content-Security-Policy) and continues on Channels.
  // 21-INT: the marketplace's "Set up WhatsApp" lands here with ?connect=whatsapp (the stepper opens itself).
  useEffect(() => { if (params.get(SIGNUP_RELOAD_PARAM) === 'whatsapp' || params.get('connect') === 'whatsapp') setTab('channels'); }, [params]);
  const choose = (next: Tab) => {
    setTab(next);
    router.replace(`/dashboard/${org.id}/settings/messaging${next === 'templates' ? '?tab=templates' : ''}`, { scroll: false });
  };
  return (
    <ModuleGate module="connect" permission="connect:read">
      <PageHeader title={t('connect.messaging.title')} subtitle={t('connect.messaging.subtitle')} />
      <SectionNav sections={SETTINGS_SECTIONS} label={t('nav.group.settings')} />
      <Tabs value={tab} onChange={choose} tabs={[
        { key: 'channels', label: t('connect.channels.title') },
        { key: 'templates', label: t('connect.templates.title') },
      ]} />
      {tab === 'channels' && <Channels />}
      {tab === 'templates' && <Templates />}
    </ModuleGate>
  );
}

function Channels() {
  const { t } = useT();
  const { org, can } = useOrg();
  const session = useSession();
  const channels = useApi<{ items: Channel[] }>(`/o/${org.id}/connect/channels`);
  const conns = useApi<{ items: Array<{ id: string; provider: string; status: string; environment: string }> }>(can('integrations:manage') ? `/o/${org.id}/integrations/connections?category=messaging` : null);
  const [form, setForm] = useState({ displayName: '', phoneNumberId: '', wabaId: '', displayPhone: '', connectionId: '' });
  const create = useAction(async (body: Record<string, unknown>) => {
    await session.call(`/o/${org.id}/connect/channels`, { body });
    await channels.reload();
  });
  const toggle = useAction(async (c: Channel, patch: Record<string, unknown>) => {
    await session.call(`/o/${org.id}/connect/channels/${c.id}`, { method: 'PATCH', body: patch });
    await channels.reload();
  });
  const wa = (conns.data?.items ?? []).filter((c) => c.provider === 'whatsapp_cloud');
  return (
    <div className="stack">
      {can('connect:manage') && (
        <Card title={t('wa.title')}>
          <p className="fine">{t('wa.subtitle')}</p>
          <WhatsAppStepperLauncher onChanged={() => channels.reload()} />
        </Card>
      )}
      {channels.error && <Notice tone="danger">{channels.error.message}</Notice>}
      {!channels.data ? <Skeleton /> : (
        <DataTable rows={channels.data.items} rowKey={(c) => c.id} empty={<EmptyState title={t('connect.channels.empty')}>{t('connect.channels.emptyBody')}</EmptyState>}
          columns={[
            { key: 'name', header: t('connect.channels.name'), render: (c) => <strong>{c.displayName}</strong> },
            { key: 'transport', header: t('connect.channels.transport'), render: (c) => <ChannelKindBadge c={c} /> },
            { key: 'verified', header: t('connect.channels.ownership'), render: (c) => <VerifyCell c={c} onDone={() => channels.reload()} /> },
            { key: 'status', header: t('connect.channels.status'), render: (c) => <Badge tone={c.status === 'connected' ? 'ok' : c.status === 'error' ? 'danger' : c.status === 'disabled' ? 'neutral' : 'warn'}>{t(`connect.channelStatus.${c.status}`)}</Badge> },
            { key: 'ordering', header: t('connect.channels.ordering'), render: (c) => can('connect:manage')
              ? <label className="check"><input type="checkbox" checked={c.orderingEnabled} onChange={(e) => toggle.run(c, { orderingEnabled: e.target.checked })} /> {t('connect.channels.orderingOn')}</label>
              : (c.orderingEnabled ? '✓' : '—') },
            { key: 'actions', header: '', align: 'end', render: (c) => can('connect:manage') &&
              <button className="btn btn-sm btn-ghost" onClick={() => toggle.run(c, { disabled: c.status !== 'disabled' })}>{c.status === 'disabled' ? t('connect.channels.enable') : t('connect.channels.disable')}</button> },
          ]} />
      )}
      {toggle.error && <Notice tone="danger">{toggle.error}</Notice>}
      {can('connect:manage') && (
        <div className="grid grid-2">
          <Card title={t('connect.channels.addSandbox')}>
            <p className="fine">{t('connect.channels.sandboxBody')}</p>
            <button className="btn btn-primary" disabled={create.pending} onClick={() => create.run({ transport: 'sandbox', displayName: t('connect.channels.sandboxName') })}>{t('connect.channels.addSandbox')}</button>
          </Card>
          <Card title={t('connect.channels.addWhatsApp')}>
            <Notice tone="warn">{t('connect.channels.whatsAppUnverified')}</Notice>
            {wa.length === 0 ? <p className="fine mbs-10">{t('connect.channels.needConnection')} <a href={`/dashboard/${org.id}/integrations`}>{t('nav.integrations')}</a></p> : (
              <form className="mbs-10" onSubmit={(e) => { e.preventDefault(); void create.run({ transport: 'meta_cloud', ...form, connectionId: form.connectionId || wa[0]!.id, displayPhone: form.displayPhone || null }); }}>
                <Field label={t('connect.channels.name')} value={form.displayName} required onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
                <div className="form-row">
                  <Field label={t('connect.channels.phoneNumberId')} value={form.phoneNumberId} required pattern="\d{5,30}" dir="ltr" onChange={(e) => setForm({ ...form, phoneNumberId: e.target.value })} />
                  <Field label={t('connect.channels.wabaId')} value={form.wabaId} required pattern="\d{5,30}" dir="ltr" onChange={(e) => setForm({ ...form, wabaId: e.target.value })} />
                </div>
                <Field label={t('connect.channels.displayPhone')} value={form.displayPhone} dir="ltr" onChange={(e) => setForm({ ...form, displayPhone: e.target.value })} />
                <button className="btn btn-primary" disabled={create.pending}>{t('action.create')}</button>
              </form>
            )}
          </Card>
        </div>
      )}
      {create.error && <Notice tone="danger">{create.error}</Notice>}
      {can('connect:manage') && can('integrations:manage') && (
        <div className="grid grid-2">
          <EmbeddedSignupCard onDone={() => channels.reload()} />
          <PageChannelCard onDone={() => channels.reload()} />
        </div>
      )}
    </div>
  );
}

function Templates() {
  const { t } = useT();
  const { org, can } = useOrg();
  const session = useSession();
  const list = useApi<{ items: Template[] }>(`/o/${org.id}/connect/templates`);
  const [form, setForm] = useState({ name: 'order_update', language: 'en', category: 'utility', body: 'Update on your order {{1}}: {{2}}', variables: 'order_number, status' });
  const [note, setNote] = useState<string | null>(null);
  const placeholders = useMemo(() => new Set([...form.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1])).size, [form.body]);
  const create = useAction(async (e: FormEvent) => {
    e.preventDefault();
    await session.call(`/o/${org.id}/connect/templates`, { body: { ...form, variables: form.variables.split(',').map((v) => v.trim()).filter(Boolean) } });
    await list.reload();
  });
  const act = useAction(async (tp: Template, action: 'submit' | 'delete') => {
    const res = await session.call<{ note?: string }>(`/o/${org.id}/connect/templates/${tp.id}${action === 'submit' ? '/submit' : ''}`, { method: action === 'submit' ? 'POST' : 'DELETE' });
    setNote(res?.note ?? null);
    await list.reload();
  });
  const tone = (s: string) => (s === 'approved' ? 'ok' : s === 'rejected' ? 'danger' : s === 'sandbox' ? 'sandbox' : s === 'submitted' ? 'info' : 'neutral') as any;
  return (
    <div className="stack">
      <Notice>{t('connect.templates.help')}</Notice>
      {note && <Notice tone="warn">{note}</Notice>}
      {!list.data ? <Skeleton /> : (
        <DataTable rows={list.data.items} rowKey={(x) => x.id} empty={<EmptyState title={t('connect.templates.empty')} />} columns={[
          { key: 'name', header: t('connect.templates.name'), render: (x) => <><strong>{x.name}</strong> <span className="fine">{x.language} · {t(`connect.templates.cat_${x.category}`)}</span></> },
          { key: 'body', header: t('connect.templates.body'), render: (x) => <span className="fine">{x.body}</span> },
          { key: 'status', header: t('connect.channels.status'), render: (x) => <Badge tone={tone(x.providerStatus)}>{t(`connect.templates.status_${x.providerStatus}`)}</Badge> },
          { key: 'a', header: '', align: 'end', render: (x) => can('connect:manage') && <div className="row gap-4 justify-end">
            {['draft', 'rejected'].includes(x.providerStatus) && <button className="btn btn-sm" disabled={act.pending} onClick={() => act.run(x, 'submit')}>{t('connect.templates.submit')}</button>}
            <button className="btn btn-sm btn-ghost btn-danger" disabled={act.pending} onClick={() => act.run(x, 'delete')}>{t('action.delete')}</button></div> },
        ]} />
      )}
      {act.error && <Notice tone="danger">{act.error}</Notice>}
      {can('connect:manage') && (
        <Card title={t('connect.templates.new')}>
          <form onSubmit={create.run}>
            <div className="form-row">
              <Field label={t('connect.templates.name')} value={form.name} pattern="[a-z0-9_]{1,512}" required dir="ltr" onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <SelectField label={t('connect.templates.language')} value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })}>
                <option value="en">English</option><option value="ar">العربية</option></SelectField>
              <SelectField label={t('connect.templates.category')} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                {['utility', 'marketing', 'authentication'].map((c) => <option key={c} value={c}>{t(`connect.templates.cat_${c}`)}</option>)}</SelectField>
            </div>
            <TextareaField label={t('connect.templates.body')} value={form.body} maxLength={1024} required onChange={(e) => setForm({ ...form, body: e.target.value })}
              hint={t('connect.templates.placeholders', { n: placeholders })} />
            <Field label={t('connect.templates.variables')} value={form.variables} onChange={(e) => setForm({ ...form, variables: e.target.value })} dir="ltr" />
            {create.error && <Notice tone="danger">{create.error}</Notice>}
            <button className="btn btn-primary" disabled={create.pending}>{t('action.create')}</button>
          </form>
        </Card>
      )}
    </div>
  );
}
