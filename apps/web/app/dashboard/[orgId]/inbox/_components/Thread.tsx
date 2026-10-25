'use client';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Menu, Notice, OrderRef, ProviderLogo } from '@resuto/ui';
import { date, money, time } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { relativeDay, threadEntries } from '@/lib/inbox';
import { InboxIcon, type InboxIconName } from './icons';
import { guestKey, providerOf, statusTone, type Assignee, type Detail, type InternalNote, type Message } from './types';

const LIVE_STEPS_DONE = ['completed', 'cancelled', 'expired'];
const DELIVERY_ICON: Record<string, InboxIconName> = { queued: 'clock', sent: 'check', delivered: 'checkCheck', read: 'checkCheck', failed: 'alert' };

export interface ThreadHeaderProps {
  d: Detail;
  orgId: string;
  canReply: boolean;
  canManage: boolean;
  assignees: Assignee[];
  busy: boolean;
  onAssign(userId: string | null): void;
  onAct(path: 'handoff' | 'handoff/resolve' | 'close' | 'reopen' | 'ordering/cancel'): void;
  onBack(): void;
}

/** Who the conversation is with, its channel and state, and the conversation actions (assign, take over, close). */
export function ThreadHeader({ d, orgId, canReply, canManage, assignees, busy, onAssign, onAct, onBack }: ThreadHeaderProps) {
  const { t } = useT();
  const name = d.customer?.name ?? d.contactName ?? d.contact ?? t(guestKey(d.channel.kind));
  const assignee = assignees.find((a) => a.userId === d.assignedTo);
  return (
    <header className="thread-head">
      <button type="button" className="btn btn-sm btn-ghost thread-back" onClick={onBack}><InboxIcon name="back" /> {t('connect.ws.back')}</button>
      <div className="thread-who">
        <h2 className="thread-name"><bdi>{name}</bdi></h2>
        <div className="thread-meta">
          <ProviderLogo provider={providerOf(d.channel.kind)} size={16} decorative />
          <bdi>{d.channel.name}</bdi>
          {d.contact && <span dir="ltr" className="num">{d.contact}</span>}
          <Badge tone={statusTone(d.status)}>{t(`connect.status.${d.status}`)}</Badge>
          {d.channel.sandbox && <Badge tone="sandbox">{t('connect.sandbox.badge')}</Badge>}
          {d.customer && <Badge tone={d.customer.marketingConsent ? 'ok' : 'neutral'}>{t(d.customer.marketingConsent ? 'connect.inbox.consent' : 'connect.inbox.noConsent')}</Badge>}
          <span className="thread-bot">{d.botActive ? t('connect.inbox.botActive') : t('connect.inbox.botPaused')}</span>
        </div>
      </div>
      <div className="thread-actions">
        {canManage ? (
          <Menu label={t('ops.inbox.assignee')} align="end" items={[
            { key: 'none', label: t('ops.inbox.unassigned'), onSelect: () => onAssign(null), disabled: busy || !d.assignedTo },
            ...assignees.map((a) => ({ key: a.userId, label: `${a.name} · ${t(`role.${a.role}`)}`, text: a.name, onSelect: () => onAssign(a.userId), disabled: busy || a.userId === d.assignedTo })),
          ]} trigger={(
            <button type="button" className="btn btn-sm" data-inbox-assign="" aria-keyshortcuts="a">
              {t('ops.inbox.assignee')}: <bdi>{assignee?.name ?? t('ops.inbox.unassigned')}</bdi>
            </button>
          )} />
        ) : d.assignedTo ? <span className="thread-bot">{t('ops.inbox.assignee')}: <bdi>{assignee?.name ?? '—'}</bdi></span> : null}
        {canReply && !d.handoff && d.status !== 'closed' && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onAct('handoff')}>{t('connect.inbox.takeOver')}</button>}
        {canReply && d.handoff && <button type="button" className="btn btn-sm btn-leaf" disabled={busy} onClick={() => onAct('handoff/resolve')}>{t('connect.inbox.resumeBot')}</button>}
        {canReply && d.status !== 'closed' && <button type="button" className="btn btn-sm btn-ghost" disabled={busy} aria-keyshortcuts="e" onClick={() => onAct('close')}>{t('connect.inbox.close')}</button>}
        {canReply && d.status === 'closed' && <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => onAct('reopen')}>{t('connect.inbox.reopen')}</button>}
      </div>
      {d.orderingSession && <OrderCard d={d} orgId={orgId} canReply={canReply} busy={busy} onCancel={() => onAct('ordering/cancel')} />}
    </header>
  );
}

/** The conversation's ordering session (structured WhatsApp ordering) and the order it produced. */
function OrderCard({ d, orgId, canReply, busy, onCancel }: { d: Detail; orgId: string; canReply: boolean; busy: boolean; onCancel(): void }) {
  const { t, locale } = useT();
  const s = d.orderingSession!;
  const live = !LIVE_STEPS_DONE.includes(s.step);
  return (
    <section className="thread-order" aria-label={t('connect.ws.orderCard')}>
      <div className="thread-order-main">
        <strong>{t('connect.ws.orderCard')}</strong>
        <span>{t('connect.inbox.session', { step: t(`connect.step.${s.step}`) })}</span>
        {s.fulfillment && <span className="thread-sub">{t(`insights.fulfillment.${s.fulfillment}`)}</span>}
        {s.totalMinor !== null && s.currency && <span className="thread-sub">{money(s.totalMinor, s.currency, locale)}</span>}
        {s.paymentMethod && <span className="thread-sub">{t(`connect.inbox.pay_${s.paymentMethod}`)}</span>}
        {s.orderNumber && (s.orderId
          ? <Link className="thread-order-link" href={`/dashboard/${orgId}/orders?order=${s.orderId}`}><OrderRef n={s.orderNumber} /></Link>
          : <OrderRef n={s.orderNumber} />)}
      </div>
      {canReply && live && <button type="button" className="btn btn-sm btn-ghost btn-danger" disabled={busy} onClick={onCancel}>{t('connect.inbox.cancelSession')}</button>}
    </section>
  );
}

export interface ThreadProps {
  d: Detail;
  timeZone: string;
  canReply: boolean;
  resendBusy: boolean;
  onResend(messageId: string): void;
}

/** The thread: customer messages and internal notes in time order, a separator per day, delivery states. */
export function Thread({ d, timeZone, canReply, resendBusy, onResend }: ThreadProps) {
  const { t, locale } = useT();
  const entries = useMemo(() => threadEntries<Message, InternalNote>(d.messages, d.notes ?? [], timeZone), [d.messages, d.notes, timeZone]);
  const bottom = useRef<HTMLDivElement>(null);
  const [announce, setAnnounce] = useState('');
  const seen = useRef<{ id: string; lastId: string | null; total: number } | null>(null);
  const name = d.customer?.name ?? d.contactName ?? d.contact ?? t(guestKey(d.channel.kind));

  // Scroll to the newest entry when the thread opens or grows; announce new customer messages (not the first load).
  useEffect(() => {
    const prev = seen.current;
    const total = d.messages.length + (d.notes?.length ?? 0);
    const lastId = d.messages[d.messages.length - 1]?.id ?? null;
    if (!prev || prev.id !== d.id || total !== prev.total) bottom.current?.scrollIntoView?.({ block: 'end' });
    if (prev && prev.id === d.id && lastId && lastId !== prev.lastId) {
      const from = prev.lastId ? d.messages.findIndex((m) => m.id === prev.lastId) + 1 : 0;
      const fresh = [...d.messages.slice(from)].reverse().find((m) => m.direction === 'inbound');
      if (fresh) setAnnounce(t('connect.ws.newMessage', { name, text: (fresh.body ?? t('connect.inbox.unsupported')).slice(0, 140) }));
    }
    seen.current = { id: d.id, lastId, total };
  }, [d.id, d.messages, d.notes, name, t]);

  return (
    <div className="thread" aria-label={t('connect.ws.thread', { name })}>
      <ol className="thread-list">
        {entries.map((e) => {
          if (e.type === 'day') {
            const rel = relativeDay(e.at, timeZone);
            return <li key={e.key} className="thread-day"><span>{rel ? t(`connect.ws.${rel}`) : date(e.at, locale, timeZone)}</span></li>;
          }
          if (e.type === 'note') return <NoteEntry key={e.key} n={e.note} timeZone={timeZone} />;
          const m = e.message;
          return (
            <li key={e.key} className="msg" data-dir={m.direction} data-automated={m.automated || undefined}>
              <div className="msg-bubble" dir="auto">
                <MessageBody m={m} />
                {m.interactive?.buttons && <div className="msg-buttons">{m.interactive.buttons.map((b: any) => <Badge key={b.id}><bdi>{b.title}</bdi></Badge>)}</div>}
                {m.interactive?.url && <div className="msg-link"><InboxIcon name="link" size={14} /> <bdi>{m.interactive.displayText}</bdi></div>}
              </div>
              <div className="msg-meta">
                <span className="num">{time(m.createdAt, locale, timeZone)}</span>
                {m.automated && <span>{t('connect.inbox.bot')}</span>}
                {m.direction === 'outbound' && (
                  <span className="msg-state" data-state={m.status}>
                    {DELIVERY_ICON[m.status] && <InboxIcon name={DELIVERY_ICON[m.status]!} size={14} />}{t(`connect.msg.${m.status}`)}
                  </span>
                )}
                {m.sandbox && <span>{t('connect.sandbox.badge')}</span>}
                {m.error && <bdi className="msg-error">{m.error}</bdi>}
                {m.direction === 'outbound' && m.status === 'failed' && canReply && (
                  <button type="button" className="msg-resend" disabled={resendBusy} onClick={() => onResend(m.id)}>{t('ops.inbox.resend')}</button>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {entries.length === 0 && <Notice>{t('connect.ws.noMessages')}</Notice>}
      <div ref={bottom} />
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announce}</div>
    </div>
  );
}

function MessageBody({ m }: { m: Message }) {
  const { t } = useT();
  if (m.kind === 'image') return <span className="msg-media"><InboxIcon name="image" /> {t('connect.ws.photo')}{m.body ? <> · <bdi>{m.body}</bdi></> : null}</span>;
  if (m.kind === 'location') return <span className="msg-media"><InboxIcon name="pin" /> {t('connect.ws.location')}{m.body ? <> · <bdi>{m.body}</bdi></> : null}</span>;
  return m.body ? <bdi>{m.body}</bdi> : <em className="muted">{t('connect.inbox.unsupported')}</em>;
}

/** An internal note: staff-only, never sent, so it has no delivery state and sits apart from the customer's side. */
export function NoteEntry({ n, timeZone }: { n: InternalNote; timeZone: string }) {
  const { t, locale } = useT();
  return (
    <li className="msg msg-note" data-kind="note" aria-label={t('connect.ws.noteLabel')}>
      <div className="msg-note-head"><InboxIcon name="lock" size={14} /> <strong>{t('connect.ws.internalNote')}</strong> · {t('connect.ws.staffOnly')}</div>
      <div className="msg-bubble" dir="auto"><bdi>{n.body}</bdi></div>
      <div className="msg-meta">
        <span className="num">{time(n.createdAt, locale, timeZone)}</span>
        {n.authorName && <bdi>{n.authorName}</bdi>}
        <span>{t('connect.ws.notSent')}</span>
      </div>
    </li>
  );
}
