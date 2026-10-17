'use client';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Badge, Card, DataTable, EmptyState, Field, Notice, PageHeader, SelectField, Skeleton, Tabs, TextareaField, useAction } from '@resuto/ui';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { newIdempotencyKey } from '@/lib/api';
import { dateTime, time } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';

interface Window { open: boolean; closesAt: string | null }
interface ConvItem {
  id: string; channelName: string; sandbox: boolean; contact: string; name: string | null; status: string; unreadCount: number;
  lastMessageAt: string | null; lastMessage: { body: string; direction: string } | null; window: Window; handoffOpen: boolean;
}
interface Message { id: string; direction: 'inbound' | 'outbound'; kind: string; body: string | null; status: string; error: string | null; automated: boolean;
  sandbox: boolean; interactive: any; createdAt: string }
interface Detail {
  id: string; status: string; channel: { id: string; name: string; sandbox: boolean }; contact: string; contactName: string | null; locale: string;
  customer: { id: string; name: string | null; marketingConsent: boolean } | null; window: Window; botActive: boolean;
  handoff: { id: string; reason: string; status: string } | null;
  orderingSession: { step: string; fulfillment: string | null; totalMinor: number | null; currency: string | null; orderNumber: string | null; paymentMethod: string | null } | null;
  messages: Message[];
}
interface Channel { id: string; transport: string; sandbox: boolean; displayName: string; status: string; orderingEnabled: boolean; phoneNumberId: string | null }
interface Template { id: string; name: string; language: string; category: string; body: string; variables: string[]; providerStatus: string; sandbox: boolean }

const statusTone = (s: string) => (s === 'handoff' ? 'warn' : s === 'closed' ? 'neutral' : s === 'bot' ? 'info' : 'ok') as 'warn' | 'neutral' | 'info' | 'ok';

export default function InboxPage() {
  const { t } = useT();
  const [tab, setTab] = useState<'conversations' | 'channels' | 'templates'>('conversations');
  return (
    <ModuleGate module="connect" permission="connect:read">
      <PageHeader title={t('connect.inbox.title')} subtitle={t('connect.inbox.subtitle')} />
      <Tabs value={tab} onChange={setTab} tabs={[
        { key: 'conversations', label: t('connect.inbox.conversations') },
        { key: 'channels', label: t('connect.channels.title') },
        { key: 'templates', label: t('connect.templates.title') },
      ]} />
      {tab === 'conversations' && <Conversations />}
      {tab === 'channels' && <Channels />}
      {tab === 'templates' && <Templates />}
    </ModuleGate>
  );
}

function Conversations() {
  const { t, locale } = useT();
  const { org } = useOrg();
  const [filter, setFilter] = useState<{ status: string; unread: boolean; mine: boolean; q: string }>({ status: '', unread: false, mine: false, q: '' });
  const [selected, setSelected] = useState<string | null>(null);
  const qs = new URLSearchParams({ limit: '50', ...(filter.status ? { status: filter.status } : {}), ...(filter.unread ? { unread: 'true' } : {}),
    ...(filter.mine ? { assigned: 'me' } : {}), ...(filter.q.trim() ? { q: filter.q.trim() } : {}) });
  const list = useApi<{ items: ConvItem[] }>(`/o/${org.id}/connect/conversations?${qs}`, { pollMs: 5000 });

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))', gap: 16, alignItems: 'start' }}>
      <section className="card" style={{ padding: 14, minWidth: 0 }} aria-label={t('connect.inbox.conversations')}>
        <div className="stack" style={{ gap: 8, marginBlockEnd: 10 }}>
          <input className="input" placeholder={t('connect.inbox.search')} value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} aria-label={t('connect.inbox.search')} />
          <div className="row" style={{ gap: 6 }}>
            <select className="select" style={{ width: 'auto', minHeight: 34 }} value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })} aria-label={t('connect.inbox.status')}>
              <option value="">{t('connect.inbox.allStatuses')}</option>
              {['bot', 'open', 'handoff', 'closed'].map((s) => <option key={s} value={s}>{t(`connect.status.${s}`)}</option>)}
            </select>
            <label className="check"><input type="checkbox" checked={filter.unread} onChange={(e) => setFilter({ ...filter, unread: e.target.checked })} /> {t('connect.inbox.unread')}</label>
            <label className="check"><input type="checkbox" checked={filter.mine} onChange={(e) => setFilter({ ...filter, mine: e.target.checked })} /> {t('connect.inbox.mine')}</label>
          </div>
        </div>
        {list.loading && !list.data && <Skeleton lines={5} />}
        {list.error && <Notice tone="danger">{list.error.message}</Notice>}
        {list.data && list.data.items.length === 0 && <EmptyState title={t('connect.inbox.empty')}>{t('connect.inbox.emptyBody')}</EmptyState>}
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4 }}>
          {list.data?.items.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => setSelected(c.id)} className="btn btn-ghost" aria-current={selected === c.id}
                style={{ width: '100%', justifyContent: 'space-between', textAlign: 'start', minHeight: 60, padding: '8px 10px', background: selected === c.id ? 'var(--leaf-bg)' : undefined, whiteSpace: 'normal' }}>
                <span style={{ minWidth: 0, display: 'grid', gap: 2 }}>
                  <span className="row" style={{ gap: 6 }}><strong>{c.name ?? c.contact}</strong>{c.sandbox && <Badge tone="sandbox">{t('connect.sandbox.badge')}</Badge>}
                    <Badge tone={statusTone(c.status)}>{t(`connect.status.${c.status}`)}</Badge></span>
                  <span className="fine" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 }}>
                    {c.lastMessage ? `${c.lastMessage.direction === 'outbound' ? '↩ ' : ''}${c.lastMessage.body ?? ''}` : ''}</span>
                </span>
                <span style={{ display: 'grid', justifyItems: 'end', gap: 4 }}>
                  <span className="fine">{time(c.lastMessageAt, locale)}</span>
                  {c.unreadCount > 0 && <Badge tone="ok">{c.unreadCount}</Badge>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      {selected && <ConversationPane id={selected} onClose={() => setSelected(null)} onChanged={() => void list.reload()} />}
      <SandboxSimulator />
    </div>
  );
}

function ConversationPane({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { t, locale } = useT();
  const { org, can } = useOrg();
  const session = useSession();
  const detail = useApi<Detail>(`/o/${org.id}/connect/conversations/${id}`, { pollMs: 4000 });
  const templates = useApi<{ items: Template[] }>(`/o/${org.id}/connect/templates`);
  const [text, setText] = useState('');
  const [templateName, setTemplateName] = useState('');
  const [vars, setVars] = useState<string[]>([]);
  const keyRef = useRef(newIdempotencyKey());
  const bottom = useRef<HTMLDivElement>(null);
  const d = detail.data;

  useEffect(() => { if (d?.id && d.messages.length) bottom.current?.scrollIntoView({ block: 'end' }); }, [d?.id, d?.messages.length]);
  useEffect(() => { void session.call(`/o/${org.id}/connect/conversations/${id}/read`, { method: 'POST' }).then(onChanged).catch(() => undefined); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = useAction(async (path: string, body?: unknown) => {
    await session.call(`/o/${org.id}/connect/conversations/${id}/${path}`, { method: 'POST', body: body ?? {} });
    await detail.reload();
    onChanged();
  });
  const send = useAction(async (e: FormEvent) => {
    e.preventDefault();
    const body = templateName ? { templateName, variables: vars, key: keyRef.current } : { text: text.trim(), key: keyRef.current };
    await session.call(`/o/${org.id}/connect/conversations/${id}/reply`, { body });
    keyRef.current = newIdempotencyKey();
    setText(''); setTemplateName(''); setVars([]);
    await detail.reload();
    onChanged();
  });
  const usable = (templates.data?.items ?? []).filter((tp) => tp.providerStatus === 'approved' || (d?.channel.sandbox && tp.providerStatus === 'sandbox'));
  const chosen = usable.find((tp) => tp.name === templateName);

  if (!d) return <section className="card">{detail.error ? <Notice tone="danger">{detail.error.message}</Notice> : <Skeleton lines={6} />}</section>;
  return (
    <section className="card" style={{ padding: 0, display: 'flex', flexDirection: 'column', minHeight: 520, minWidth: 0 }} aria-label={d.contactName ?? d.contact}>
      <header style={{ padding: 14, borderBlockEnd: '1px solid var(--line-soft)' }} className="spread">
        <div>
          <div className="row" style={{ gap: 6 }}><strong>{d.customer?.name ?? d.contactName ?? d.contact}</strong>
            <span className="fine" dir="ltr">{d.contact}</span>
            {d.channel.sandbox && <Badge tone="sandbox">{t('connect.sandbox.badge')}</Badge>}
            <Badge tone={statusTone(d.status)}>{t(`connect.status.${d.status}`)}</Badge>
            {d.customer && <Badge tone={d.customer.marketingConsent ? 'ok' : 'neutral'}>{t(d.customer.marketingConsent ? 'connect.inbox.consent' : 'connect.inbox.noConsent')}</Badge>}
          </div>
          <div className="fine">{d.botActive ? t('connect.inbox.botActive') : t('connect.inbox.botPaused')} · {d.channel.name}</div>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {can('connect:reply') && !d.handoff && d.status !== 'closed' && <button className="btn btn-sm" disabled={act.pending} onClick={() => act.run('handoff', {})}>{t('connect.inbox.takeOver')}</button>}
          {can('connect:reply') && d.handoff && <button className="btn btn-sm btn-leaf" disabled={act.pending} onClick={() => act.run('handoff/resolve')}>{t('connect.inbox.resumeBot')}</button>}
          {can('connect:reply') && d.status !== 'closed' && <button className="btn btn-sm btn-ghost" disabled={act.pending} onClick={() => act.run('close')}>{t('connect.inbox.close')}</button>}
          {can('connect:reply') && d.status === 'closed' && <button className="btn btn-sm btn-ghost" disabled={act.pending} onClick={() => act.run('reopen')}>{t('connect.inbox.reopen')}</button>}
          <button className="btn btn-sm btn-ghost" onClick={onClose} aria-label={t('action.close')}>✕</button>
        </div>
      </header>
      {act.error && <div style={{ padding: '8px 14px' }}><Notice tone="danger">{act.error}</Notice></div>}
      {d.orderingSession && (
        <div style={{ padding: '8px 14px', background: 'var(--surface-warm)' }} className="spread">
          <span className="fine">{t('connect.inbox.session', { step: t(`connect.step.${d.orderingSession.step}`) })}
            {d.orderingSession.orderNumber ? ` · #${d.orderingSession.orderNumber}` : ''}
            {d.orderingSession.paymentMethod ? ` · ${t(`connect.inbox.pay_${d.orderingSession.paymentMethod}`)}` : ''}</span>
          {can('connect:reply') && !['completed', 'cancelled', 'expired'].includes(d.orderingSession.step) &&
            <button className="btn btn-sm btn-ghost btn-danger" disabled={act.pending} onClick={() => act.run('ordering/cancel')}>{t('connect.inbox.cancelSession')}</button>}
        </div>
      )}
      <div style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'grid', gap: 8, maxHeight: 520, alignContent: 'start' }}>
        {d.messages.map((msg) => (
          <div key={msg.id} style={{ justifySelf: msg.direction === 'outbound' ? 'end' : 'start', maxWidth: '82%' }}>
            <div dir="auto" style={{ padding: '8px 12px', borderRadius: 14, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              background: msg.direction === 'outbound' ? (msg.automated ? 'var(--info-bg)' : 'var(--leaf-bg)') : '#fff', border: '1px solid var(--line-soft)' }}>
              {msg.body ?? <em className="muted">{t('connect.inbox.unsupported')}</em>}
              {msg.interactive?.buttons && <div className="row" style={{ gap: 4, marginBlockStart: 6 }}>{msg.interactive.buttons.map((b: any) => <Badge key={b.id}>{b.title}</Badge>)}</div>}
              {msg.interactive?.url && <div className="fine" style={{ marginBlockStart: 4 }}>🔗 {msg.interactive.displayText}</div>}
            </div>
            <div className="fine" style={{ textAlign: msg.direction === 'outbound' ? 'end' : 'start' }}>
              {time(msg.createdAt, locale)}{msg.automated ? ` · ${t('connect.inbox.bot')}` : ''}{msg.direction === 'outbound' ? ` · ${t(`connect.msg.${msg.status}`)}` : ''}
              {msg.sandbox ? ` · ${t('connect.sandbox.badge')}` : ''}{msg.error ? ` · ${msg.error}` : ''}
            </div>
          </div>
        ))}
        <div ref={bottom} />
      </div>
      {can('connect:reply') && (
        <form onSubmit={send.run} style={{ padding: 14, borderBlockStart: '1px solid var(--line-soft)' }} className="stack">
          <div className="row" style={{ gap: 6 }}>
            <Badge tone={d.window.open ? 'ok' : 'warn'}>{d.window.open ? t('connect.window.open', { until: dateTime(d.window.closesAt, locale) }) : t('connect.window.closed')}</Badge>
          </div>
          {!d.window.open && <Notice tone="warn">{t('connect.window.templateOnly')}</Notice>}
          <SelectField label={t('connect.inbox.template')} value={templateName} onChange={(e) => { setTemplateName(e.target.value); setVars([]); }}>
            <option value="">{d.window.open ? t('connect.inbox.freeText') : t('connect.inbox.chooseTemplate')}</option>
            {usable.map((tp) => <option key={tp.id} value={tp.name}>{tp.name} ({tp.language}){tp.sandbox ? ` · ${t('connect.sandbox.badge')}` : ''}</option>)}
          </SelectField>
          {chosen ? chosen.variables.map((v, i) => (
            <Field key={v} label={v} value={vars[i] ?? ''} onChange={(e) => { const n = [...vars]; n[i] = e.target.value; setVars(n); }} required />
          )) : <TextareaField label={t('connect.inbox.message')} value={text} onChange={(e) => setText(e.target.value)} maxLength={4096} disabled={!d.window.open} rows={3} />}
          {send.error && <Notice tone="danger">{send.error}</Notice>}
          <button className="btn btn-primary" disabled={send.pending || (chosen ? chosen.variables.some((_, i) => !vars[i]) : !text.trim() || !d.window.open)}>{t('connect.inbox.send')}</button>
        </form>
      )}
    </section>
  );
}

/** Staff-only simulator: injects customer messages into a SANDBOX channel. Nothing reaches WhatsApp. */
function SandboxSimulator() {
  const { t } = useT();
  const { org, can } = useOrg();
  const session = useSession();
  const channels = useApi<{ items: Channel[] }>(`/o/${org.id}/connect/channels`);
  const sandbox = (channels.data?.items ?? []).filter((c) => c.sandbox && c.status !== 'disabled');
  const [channelId, setChannelId] = useState('');
  const [from, setFrom] = useState('+201000000001');
  const [name, setName] = useState('Test customer');
  const [text, setText] = useState('order');
  const [last, setLast] = useState<Detail | null>(null);
  const sim = useAction(async (msg: Record<string, unknown>) => {
    const res = await session.call<{ conversation: Detail }>(`/o/${org.id}/connect/sandbox/inbound`, { body: { channelId: channelId || sandbox[0]!.id, from, name: name || null, ...msg } });
    setLast(res.conversation);
  });
  if (!can('connect:manage')) return null;
  const lastInteractive = [...(last?.messages ?? [])].reverse().find((m) => m.direction === 'outbound' && (m.interactive?.buttons || m.interactive?.sections || m.interactive?.url));
  return (
    <section className="card" style={{ border: '1px dashed #d8aa4a', background: '#fffaf0', gridColumn: '1 / -1' }} aria-label={t('connect.sim.title')}>
      <div className="spread"><h2 style={{ margin: 0 }}>{t('connect.sim.title')}</h2><Badge tone="sandbox">{t('connect.sandbox.badge')}</Badge></div>
      <p className="fine">{t('connect.sim.body')}</p>
      {channels.data && sandbox.length === 0 && <Notice tone="warn">{t('connect.sim.noChannel')}</Notice>}
      {sandbox.length > 0 && <>
        {sandbox.length > 1 && <SelectField label={t('connect.channels.title')} value={channelId} onChange={(e) => setChannelId(e.target.value)}>
          {sandbox.map((c) => <option key={c.id} value={c.id}>{c.displayName}</option>)}</SelectField>}
        <div className="form-row">
          <Field label={t('connect.sim.phone')} value={from} onChange={(e) => setFrom(e.target.value)} dir="ltr" pattern="\+[1-9][0-9]{6,14}" />
          <Field label={t('connect.sim.name')} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (text.trim()) void sim.run({ text: text.trim() }); }}>
          <input className="input" style={{ flex: 1, minWidth: 160 }} value={text} onChange={(e) => setText(e.target.value)} aria-label={t('connect.inbox.message')} />
          <button className="btn btn-ember" disabled={sim.pending}>{t('connect.sim.send')}</button>
        </form>
        {lastInteractive && (
          <div className="stack" style={{ marginBlockStart: 10 }}>
            <span className="fine">{t('connect.sim.tapReply')}</span>
            <div className="row" style={{ gap: 6 }}>
              {(lastInteractive.interactive.buttons ?? lastInteractive.interactive.sections?.flatMap((s: any) => s.rows) ?? []).map((b: any) => (
                <button key={b.id} type="button" className="btn btn-sm" disabled={sim.pending} onClick={() => sim.run({ reply: { id: b.id, title: b.title } })}>{b.title}</button>
              ))}
              {lastInteractive.interactive.url && <a className="btn btn-sm btn-leaf" href={lastInteractive.interactive.url} target="_blank" rel="noreferrer">{lastInteractive.interactive.displayText}</a>}
              {lastInteractive.interactive.type === 'location_request' && (
                <button type="button" className="btn btn-sm" disabled={sim.pending} onClick={() => sim.run({ location: { latitude: 30.0444, longitude: 31.2357, name: 'Tahrir Square', address: 'Tahrir Square, Cairo' } })}>
                  {t('connect.sim.shareLocation')}</button>
              )}
            </div>
          </div>
        )}
        {sim.error && <Notice tone="danger">{sim.error}</Notice>}
      </>}
    </section>
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
      {channels.error && <Notice tone="danger">{channels.error.message}</Notice>}
      {!channels.data ? <Skeleton /> : (
        <DataTable rows={channels.data.items} rowKey={(c) => c.id} empty={<EmptyState title={t('connect.channels.empty')}>{t('connect.channels.emptyBody')}</EmptyState>}
          columns={[
            { key: 'name', header: t('connect.channels.name'), render: (c) => <strong>{c.displayName}</strong> },
            { key: 'transport', header: t('connect.channels.transport'), render: (c) => c.sandbox ? <Badge tone="sandbox">{t('connect.sandbox.badge')}</Badge> : <Badge tone="info">WhatsApp Cloud API</Badge> },
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
            {wa.length === 0 ? <p className="fine" style={{ marginBlockStart: 10 }}>{t('connect.channels.needConnection')} <a href={`/dashboard/${org.id}/integrations`}>{t('nav.integrations')}</a></p> : (
              <form onSubmit={(e) => { e.preventDefault(); void create.run({ transport: 'meta_cloud', ...form, connectionId: form.connectionId || wa[0]!.id, displayPhone: form.displayPhone || null }); }} style={{ marginBlockStart: 10 }}>
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
          { key: 'a', header: '', align: 'end', render: (x) => can('connect:manage') && <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
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
