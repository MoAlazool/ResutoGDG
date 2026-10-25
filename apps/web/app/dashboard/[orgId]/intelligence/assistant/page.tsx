'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AssistantReply } from '@resuto/contracts';
import { Badge, Card, Notice, PageHeader, Skeleton } from '@resuto/ui';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { newIdempotencyKey } from '@/lib/api';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { ApiErrorNotice } from '../_components/intel';
import a from './assistant.module.css';

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
    // Copilot belongs to AI & Apps (21-SHELL), not to the Insights area: its own header, no Insights sub-navigation.
    <ModuleGate module="intelligence" permission="ai:use">
      <PageHeader overline={t('nav.area.apps')} title={t('nav.copilot')} subtitle={t('intelligence.subtitle')} />
      <div className={a.layout}>
        <div className={a.main}>
          <Card title={t('intelligence.tab.assistant')} actions={rules
            ? <Badge tone="sandbox">{t('intelligence.assistant.rulesMode')}</Badge> : <Badge tone="info">{t('intelligence.assistant.geminiMode')}</Badge>}>
            {rules && <div className="mbe-12"><Notice>{t('intelligence.assistant.rulesModeHint')}</Notice></div>}
            <div role="log" aria-live="polite" className={`stack ${a.log}`}>
              {!messages.length && <p className="muted">{t('intelligence.assistant.empty')}</p>}
              {messages.map((m) => (
                <div key={m.id} className={a.message} data-role={m.role === 'user' ? 'user' : 'assistant'}>
                  <div dir="auto" className={a.content}>{m.content}</div>
                  {m.role === 'assistant' && (
                    <div className={`row ${a.sources}`}>
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
            {error && <div className="mbs-10"><ApiErrorNotice error={error} /></div>}
            <form onSubmit={send} className={`row ${a.composer}`}>
              <label className="sr-only" htmlFor="assistant-input">{t('intelligence.assistant.placeholder')}</label>
              <input id="assistant-input" className={`input ${a.input}`} dir="auto" maxLength={1000} value={text}
                placeholder={t('intelligence.assistant.placeholder')} onChange={(e) => setText(e.target.value)} />
              <button className="btn btn-primary" disabled={pending || !text.trim()}>{t('intelligence.assistant.send')}</button>
            </form>
          </Card>
        </div>
        <div className={a.side}>
          <Card title={t('intelligence.assistant.threads')} actions={<button type="button" className="btn btn-sm" onClick={() => { setThreadId(null); setMessages([]); }}>{t('intelligence.assistant.new')}</button>}>
            {threads.loading && !threads.data ? <Skeleton lines={3} /> : (
              <ul className={a.threads}>
                {(threads.data?.items ?? []).map((th) => (
                  <li key={th.id}>
                    <button type="button" className={`btn btn-sm btn-block ${a.thread} ${th.id === threadId ? 'btn-leaf' : 'btn-ghost'}`} dir="auto" onClick={() => open(th.id)}>
                      {th.title ?? '…'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </ModuleGate>
  );
}
