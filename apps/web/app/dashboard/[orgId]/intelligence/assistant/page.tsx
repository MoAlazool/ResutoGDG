'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AssistantReply } from '@resuto/contracts';
import { Badge, Card, Notice, Skeleton } from '@resuto/ui';
import { newIdempotencyKey } from '@/lib/api';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { ApiErrorNotice, IntelShell } from '../_components/IntelShell';

interface Msg { id: string; role: 'user' | 'assistant' | 'tool'; content: string; toolCalls?: any; provider?: string | null; grounded?: boolean; citations?: string[] }
interface Thread { id: string; title: string | null; lastMessageAt: string | null }

export default function AssistantPage() {
  const { t, locale } = useT();
  const { org } = useOrg();
  const { call } = useSession();
  const status = useApi<{ assistant: { mode: 'gemini' | 'rules' } }>(`/o/${org.id}/intelligence/status`);
  const threads = useApi<{ items: Thread[] }>(`/o/${org.id}/intelligence/assistant/threads`);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const rules = status.data?.assistant.mode !== 'gemini';

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [messages]);

  async function open(id: string) {
    setThreadId(id);
    setError(null);
    try {
      const r = await call<{ items: Msg[] }>(`/o/${org.id}/intelligence/assistant/threads/${id}/messages`);
      setMessages(r.items.filter((m) => m.role !== 'tool').map((m) => ({ ...m, citations: Array.isArray(m.toolCalls) ? m.toolCalls.filter((c: any) => c.ok).map((c: any) => c.name) : [] })));
    } catch (e) { setError(e as Error); }
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    const message = text.trim();
    if (!message || pending) return;
    setPending(true);
    setError(null);
    setMessages((m) => [...m, { id: `local-${Date.now()}`, role: 'user', content: message }]);
    setText('');
    try {
      const r = await call<AssistantReply>(`/o/${org.id}/intelligence/assistant`, {
        body: { message, locale, ...(threadId ? { threadId } : {}) }, idempotencyKey: newIdempotencyKey(),
      });
      setThreadId(r.threadId);
      setMessages((m) => [...m, { id: r.messageId, role: 'assistant', content: r.answer, provider: r.mode, grounded: r.grounded, citations: r.citations }]);
      void threads.reload();
    } catch (err) {
      setError(err as Error);
    } finally {
      setPending(false);
    }
  }

  return (
    <IntelShell>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0, flex: '2 1 420px' }}>
          <Card title={t('intelligence.tab.assistant')} actions={rules
            ? <Badge tone="sandbox">{t('intelligence.assistant.rulesMode')}</Badge> : <Badge tone="info">{t('intelligence.assistant.geminiMode')}</Badge>}>
            {rules && <div style={{ marginBlockEnd: 12 }}><Notice>{t('intelligence.assistant.rulesModeHint')}</Notice></div>}
            <div role="log" aria-live="polite" className="stack" style={{ minHeight: 240, maxHeight: '55dvh', overflowY: 'auto', paddingInlineEnd: 4 }}>
              {!messages.length && <p className="muted">{t('intelligence.assistant.empty')}</p>}
              {messages.map((m) => (
                <div key={m.id} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '88%',
                  background: m.role === 'user' ? 'var(--leaf-bg)' : 'var(--surface-warm)', borderRadius: 12, padding: '10px 14px' }}>
                  <div dir="auto" style={{ whiteSpace: 'pre-wrap' }}>{m.content}</div>
                  {m.role === 'assistant' && (
                    <div className="row" style={{ gap: 6, marginBlockStart: 6 }}>
                      {!!m.citations?.length && <span className="fine">{t('intelligence.assistant.sources')}:</span>}
                      {m.citations?.map((c) => <Badge key={c}>{c}</Badge>)}
                      {m.provider === 'rules' && <Badge tone="sandbox">{t('intelligence.assistant.rulesMode')}</Badge>}
                    </div>
                  )}
                  {m.grounded === false && <p className="fine">{t('intelligence.assistant.ungrounded')}</p>}
                </div>
              ))}
              {pending && <Skeleton lines={2} />}
              <div ref={endRef} />
            </div>
            {error && <div style={{ marginBlockStart: 10 }}><ApiErrorNotice error={error} /></div>}
            <form onSubmit={send} className="row" style={{ marginBlockStart: 14, flexWrap: 'nowrap' }}>
              <label className="sr-only" htmlFor="assistant-input">{t('intelligence.assistant.placeholder')}</label>
              <input id="assistant-input" className="input" style={{ flex: 1, minWidth: 0 }} dir="auto" maxLength={1000} value={text}
                placeholder={t('intelligence.assistant.placeholder')} onChange={(e) => setText(e.target.value)} />
              <button className="btn btn-primary" disabled={pending || !text.trim()}>{t('intelligence.assistant.send')}</button>
            </form>
          </Card>
        </div>
        <div style={{ minWidth: 0, flex: '1 1 240px' }}>
          <Card title={t('intelligence.assistant.threads')} actions={<button type="button" className="btn btn-sm" onClick={() => { setThreadId(null); setMessages([]); }}>{t('intelligence.assistant.new')}</button>}>
            {threads.loading && !threads.data ? <Skeleton lines={3} /> : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
                {(threads.data?.items ?? []).map((th) => (
                  <li key={th.id}>
                    <button type="button" className={`btn btn-sm btn-block ${th.id === threadId ? 'btn-leaf' : 'btn-ghost'}`} style={{ justifyContent: 'flex-start' }} dir="auto" onClick={() => open(th.id)}>
                      {th.title ?? '…'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </IntelShell>
  );
}
