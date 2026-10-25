'use client';
// Row 5 "Next actions": the open insights of the intelligence module, each with one link that opens the screen (or a
// prefilled draft) that resolves it. Links only: nothing is created, sent or changed until the member saves there.
// The "ask the AI manager" box that was on the old overview stays here. Loaded on demand (page.tsx): it uses the
// full contracts entry (insight templates), which the overview's first load does not need.
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { renderInsight, type AssistantReply, type Insight } from '@resuto/contracts';
import { Badge, Notice, ProvenanceBadge, type Tone } from '@resuto/ui';
import { newIdempotencyKey } from '@/lib/api';
import { useT } from '@/lib/i18n/client';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { insightAction, insightProvenance, openInsights, type HomeAccess } from './model';
import s from './home.module.css';

const SEVERITY_TONE: Record<Insight['severity'], Tone> = { info: 'info', opportunity: 'ok', warning: 'warn', critical: 'danger' };

export function NextActions({ orgId, branchId, access }: { orgId: string; branchId: string | null; access: HomeAccess }) {
  const { t, locale } = useT();
  const list = useApi<{ items: Insight[] }>(`/o/${orgId}/intelligence/insights?limit=50`, { pollMs: 5 * 60_000 });
  const items = openInsights(list.data?.items ?? []);
  const names = { winBack: t('home.act.winBackName'), promote: (dish: string) => t('home.act.promoteName', { name: dish }) };
  return (
    <div className="stack">
      {list.error && <Notice tone="danger">{list.error.message}</Notice>}
      {list.loading ? <div className="skeleton" aria-hidden="true" /> : items.length ? (
        <ul className={s.insights}>
          {items.map((i) => {
            const r = renderInsight(i.templateKey, i.params, locale === 'ar' ? 'ar' : 'en');
            const action = insightAction(i, access, names, locale === 'ar' ? 'ar' : 'en');
            return (
              <li key={i.id} className={s.insight}>
                <div className="row gap-8">
                  <Badge tone={SEVERITY_TONE[i.severity]}>{t(`intelligence.severity.${i.severity}`)}</Badge>
                  <ProvenanceBadge provenance={insightProvenance(i.method)} />
                </div>
                <p className={s.insightTitle} dir="auto">{r?.title ?? i.title}</p>
                <p className={s.insightBody} dir="auto">{r?.body ?? i.body}</p>
                {action && (
                  <div className={s.actions}>
                    <Link className="btn btn-sm btn-primary" href={`/dashboard/${orgId}${action.href}`}>{t(`home.act.${action.kind}`)}</Link>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : <p className={s.allClear}>{t('home.act.empty')}</p>}
      <p className={s.sectionNote}>{t('home.act.note')} <Link href={`/dashboard/${orgId}/intelligence`}>{t('home.act.all')}</Link></p>
      <Ask orgId={orgId} branchId={branchId} />
    </div>
  );
}

function Ask({ orgId, branchId }: { orgId: string; branchId: string | null }) {
  const { t, locale } = useT();
  const { call } = useSession();
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<AssistantReply | null>(null);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ask = async (e: FormEvent) => {
    e.preventDefault();
    const message = question.trim();
    if (!message || asking) return;
    setAsking(true); setError(null);
    try {
      setAnswer(await call<AssistantReply>(`/o/${orgId}/intelligence/assistant`, { body: { message, locale, ...(branchId ? { branchId } : {}) }, idempotencyKey: newIdempotencyKey() }));
    } catch (err) { setError((err as Error).message); } finally { setAsking(false); }
  };
  return (
    <form className="ops-ask" onSubmit={ask}>
      <label className="sr-only" htmlFor="home-ask">{t('ops.overview.askLabel')}</label>
      <input id="home-ask" className="input" maxLength={1000} value={question} placeholder={t('ops.overview.askPlaceholder')} onChange={(e) => setQuestion(e.target.value)} />
      <button className="btn" disabled={asking || !question.trim()}>{asking ? t('state.loading') : t('ops.overview.ask')}</button>
      {error && <Notice tone="danger">{error}</Notice>}
      {answer && (
        <div className="ops-answer" aria-live="polite">
          <p><bdi>{answer.answer}</bdi></p>
          <small>{answer.grounded ? t('ops.overview.grounded') : t('ops.overview.notGrounded')}</small>
        </div>
      )}
      <small className="fine">{t('ops.overview.noClaims')}</small>
    </form>
  );
}
