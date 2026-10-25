'use client';
import { useState } from 'react';
import { Badge, Field, Notice, SelectField, Sheet, useAction } from '@resuto/ui';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import type { Channel, Detail } from './types';

/**
 * Staff-only simulator (its own chunk, opened from the Inbox toolbar): injects customer messages into a SANDBOX
 * channel. Nothing reaches WhatsApp.
 */
export default function Simulator({ open, onClose, channels, onSent }: { open: boolean; onClose(): void; channels: Channel[]; onSent(conversationId: string): void }) {
  const { t } = useT();
  const { org } = useOrg();
  const session = useSession();
  const sandbox = channels.filter((c) => c.sandbox && c.status !== 'disabled');
  const [channelId, setChannelId] = useState('');
  const [from, setFrom] = useState('+201000000001');
  const [name, setName] = useState('Test customer');
  const [text, setText] = useState('order');
  const [last, setLast] = useState<Detail | null>(null);
  const sim = useAction(async (msg: Record<string, unknown>) => {
    const res = await session.call<{ conversation: Detail; conversationId: string }>(`/o/${org.id}/connect/sandbox/inbound`,
      { body: { channelId: channelId || sandbox[0]!.id, from, name: name || null, ...msg } });
    setLast(res.conversation);
    onSent(res.conversationId);
  });
  const lastInteractive = [...(last?.messages ?? [])].reverse().find((m) => m.direction === 'outbound' && (m.interactive?.buttons || m.interactive?.sections || m.interactive?.url));
  return (
    <Sheet open={open} onClose={onClose} title={t('connect.sim.title')} description={t('connect.sim.body')} size="md" labels={{ close: t('action.close') }}>
      <div className="stack">
        <Badge tone="sandbox">{t('connect.sandbox.badge')}</Badge>
        {sandbox.length === 0 && <Notice tone="warn">{t('connect.sim.noChannel')}</Notice>}
        {sandbox.length > 0 && <>
          {sandbox.length > 1 && <SelectField label={t('connect.channels.title')} value={channelId} onChange={(e) => setChannelId(e.target.value)}>
            {sandbox.map((c) => <option key={c.id} value={c.id}>{c.displayName}</option>)}</SelectField>}
          <div className="form-row">
            <Field label={t('connect.sim.phone')} value={from} onChange={(e) => setFrom(e.target.value)} dir="ltr" pattern="\+[1-9][0-9]{6,14}" />
            <Field label={t('connect.sim.name')} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <form className="row" onSubmit={(e) => { e.preventDefault(); if (text.trim()) void sim.run({ text: text.trim() }); }}>
            <input className="input inbox-sim-text" value={text} onChange={(e) => setText(e.target.value)} aria-label={t('connect.inbox.message')} />
            <button className="btn btn-ember" disabled={sim.pending}>{t('connect.sim.send')}</button>
          </form>
          {lastInteractive && (
            <div className="stack mbs-10">
              <span className="fine">{t('connect.sim.tapReply')}</span>
              <div className="row gap-6">
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
      </div>
    </Sheet>
  );
}
