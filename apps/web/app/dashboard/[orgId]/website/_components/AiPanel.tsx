'use client';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRef, useState } from 'react';
import type { ChangeSetView, PublicSite, StudioAiPlan } from '@resuto/contracts';
import { Badge, Notice, Skeleton, useAction } from '@resuto/ui';
import { ChangeSetDiff, RequirementLine, SetStatusBadge } from '@/components/changes/ChangeSetDiff';
import { ApiRequestError, newIdempotencyKey } from '@/lib/api';
import { useT } from '@/lib/i18n/client';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import type { Studio } from './types';

const CreativePanel = dynamic(() => import('./CreativePanel').then((m) => m.CreativePanel), { ssr: false, loading: () => <Skeleton lines={4} /> });

type Outcome = { tone: 'ok' | 'warn' | 'danger' | 'info'; text: string };

/**
 * AI-assisted editing (21-STUDIO): a request in plain words becomes one change set (typed ops) that waits for a
 * person's approval. The canvas shows the draft before and after it; approving it here goes through the same approval
 * as the Approvals inbox (MFA step-up when it changes prices) and applies it to the draft. Nothing is published: the
 * owner publishes after looking at the result.
 */
export function AiPanel({ studio }: { studio: Studio }) {
  const { t, locale } = useT();
  const session = useSession();
  const [prompt, setPrompt] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [tab, setTab] = useState<'edit' | 'copy'>('edit');
  const key = useRef<{ body: string; key: string } | null>(null);
  const products = useApi<{ items: Array<{ id: string; name: string; nameAr: string | null; category: string }> }>(`/o/${studio.orgId}/studio/products`);
  const proposal = studio.proposal;
  const cs = proposal?.changeSet ?? null;

  const loadAfter = async (id: string) => session.call<PublicSite>(`/o/${studio.orgId}/studio/website/preview/change-sets/${id}`).catch(() => null);

  const propose = useAction(async () => {
    setOutcome(null);
    const body = { prompt: prompt.trim(), productIds: picked.length ? picked : undefined, locale };
    // The same request keeps its key, so a retried click returns the first proposal instead of a second one.
    const text = JSON.stringify(body);
    if (key.current?.body !== text) key.current = { body: text, key: newIdempotencyKey() };
    try {
      const res = await session.call<{ changeSet: ChangeSetView; plan: StudioAiPlan }>(`/o/${studio.orgId}/studio/ai/proposals`,
        { body, headers: { 'Idempotency-Key': key.current.key } });
      studio.setProposal({ changeSet: res.changeSet, plan: res.plan, after: await loadAfter(res.changeSet.id) });
    } catch (e) {
      setOutcome({ tone: 'danger', text: (e as Error).message });
    }
  });

  const decide = useAction(async (action: 'approve' | 'reject') => {
    if (!cs) return;
    setOutcome(null);
    try {
      const next = await session.call<ChangeSetView>(`/o/${studio.orgId}/change-sets/${cs.id}/${action}`,
        { body: action === 'approve' && cs.previewDigest ? { previewDigest: cs.previewDigest } : {} });
      if (action === 'reject') {
        studio.setProposal(null);
        setOutcome({ tone: 'ok', text: t('studio.ai.rejected') });
        return;
      }
      if (next.status === 'applied') {
        studio.setProposal(null);
        // The draft changed outside the editor's history (the change set wrote it): undo starts again from here.
        await studio.refresh({ clearHistory: true });
        setOutcome({ tone: 'ok', text: t('studio.ai.applied') });
      } else {
        studio.setProposal({ ...proposal!, changeSet: next });
        setOutcome({ tone: 'info', text: next.status === 'pending_approval' ? t('mcp.inbox.done.recorded') : t('mcp.inbox.done.other', { status: t(`mcp.inbox.status.${next.status}`) }) });
      }
    } catch (e) {
      if (e instanceof ApiRequestError && e.code === 'mfa_required') { setOutcome({ tone: 'info', text: t('mcp.inbox.mfaRequired') }); return; }
      if (e instanceof ApiRequestError && ['change_set_invalidated', 'approval_changed', 'change_set_expired'].includes(e.code)) {
        studio.setProposal(null);
        setOutcome({ tone: 'warn', text: t('mcp.inbox.done.invalidated', { reason: e.message }) });
        return;
      }
      setOutcome({ tone: 'danger', text: (e as Error).message });
    }
  });

  return (
    <div className="stack gap-12">
      <div role="tablist" aria-label={t('studio.ai.title')} className="row gap-6">
        {(['edit', 'copy'] as const).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={`btn btn-sm btn-pill ${tab === k ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab(k)}>
            {t(k === 'edit' ? 'studio.ai.tabEdit' : 'studio.ai.tabCopy')}
          </button>
        ))}
      </div>
      {tab === 'copy' && <CreativePanel orgId={studio.orgId} canWrite={studio.canWrite} />}
      {tab === 'edit' && <>
        <p className="fine m-0">{t('studio.ai.hint')}</p>
        {!cs && studio.canWrite && (
          <form className="stack gap-8" onSubmit={(e) => { e.preventDefault(); void propose.run(); }}>
            <label className="field"><span>{t('studio.ai.prompt')}</span>
              <textarea className="textarea" rows={3} maxLength={600} value={prompt} placeholder={t('studio.ai.placeholder')} onChange={(e) => setPrompt(e.target.value)} />
            </label>
            <fieldset className="ws-loc">
              <legend>{t('studio.ai.dishes')}</legend>
              <p className="fine">{t('studio.ai.dishesHint')}</p>
              {!products.data ? <p className="fine">{t('state.loading')}</p> : (
                <div className="ws-product-list">
                  {products.data.items.map((p) => (
                    <label key={p.id} className="check">
                      <input type="checkbox" checked={picked.includes(p.id)} disabled={!picked.includes(p.id) && picked.length >= 12}
                        onChange={(e) => setPicked(e.target.checked ? [...picked, p.id] : picked.filter((x) => x !== p.id))} />
                      {locale === 'ar' && p.nameAr ? p.nameAr : p.name}
                    </label>
                  ))}
                </div>
              )}
            </fieldset>
            <button type="submit" className="btn btn-primary" disabled={propose.pending || prompt.trim().length < 3}>{propose.pending ? t('state.loading') : t('studio.ai.propose')}</button>
            <p className="fine m-0">{t('studio.ai.planner')}</p>
          </form>
        )}
        {outcome && <Notice tone={outcome.tone}>{outcome.text}</Notice>}
        {cs && (
          <section className="stack gap-8" aria-labelledby="ws-ai-proposal">
            <div className="spread">
              <h3 id="ws-ai-proposal" className="ws-h3 m-0">{cs.title}</h3>
              <SetStatusBadge status={cs.status} />
            </div>
            <span className="row gap-6"><Badge tone="info">{t('studio.ai.rules')}</Badge><RequirementLine cs={cs} /></span>
            {proposal?.plan && <ul className="ws-notes">{proposal.plan.notes.map((n, i) => <li key={i}>{locale === 'ar' ? n.ar : n.en}</li>)}</ul>}
            <p className="fine m-0">{proposal?.after ? t('studio.ai.onCanvas') : t('studio.ai.noPreview')}</p>
            <ChangeSetDiff cs={cs} />
            {cs.status === 'pending_approval' && (
              <div className="row gap-6">
                <button type="button" className="btn btn-primary" disabled={decide.pending} onClick={() => void decide.run('approve')}>{t('studio.ai.approve')}</button>
                <button type="button" className="btn" disabled={decide.pending} onClick={() => void decide.run('reject')}>{t('studio.ai.reject')}</button>
                <Link className="btn btn-ghost" href={`/dashboard/${studio.orgId}/approvals/${cs.id}`}>{t('studio.ai.openApprovals')}</Link>
              </div>
            )}
            <p className="fine m-0">{t('studio.ai.mfaNote')}</p>
          </section>
        )}
        {!cs && outcome?.tone === 'ok' && studio.state.website.hasUnpublishedChanges && studio.canPublish && (
          <button type="button" className="btn btn-primary" onClick={() => void studio.publish()}>{t('studio.ai.publishNow')}</button>
        )}
      </>}
    </div>
  );
}
