'use client';
import Link from 'next/link';
import { lazy, Suspense, useState, type FormEvent } from 'react';
import { Menu, Notice, Skeleton, useAction } from '@resuto/ui';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import type { ConversationTag, Detail } from './types';

// The Customer 360 panel is its own chunk: it loads when a conversation with a customer profile is open.
const Customer360Panel = lazy(() => import('@/components/customers/Customer360Panel'));

export interface ContextPaneProps {
  d: Detail;
  tags: ConversationTag[];
  onTagsChanged(): Promise<void> | void;
}

/** Right pane: this conversation's tags, then the customer's 360 (or why there is none). */
export function ContextPane({ d, tags, onTagsChanged }: ContextPaneProps) {
  const { t } = useT();
  const { org, can } = useOrg();
  return (
    <div className="inbox-context">
      <ConversationTags d={d} tags={tags} canReply={can('connect:reply')} canManage={can('connect:manage')} onChanged={onTagsChanged} />
      {d.customer && can('customers:read') ? (
        <section className="inbox-context-sec" aria-labelledby="inbox-c360">
          <div className="inbox-context-head">
            <h2 id="inbox-c360" className="inbox-context-title">{t('connect.ws.customer360')}</h2>
            <Link className="inbox-context-link" href={`/dashboard/${org.id}/customers/${d.customer.id}`}>{t('connect.ws.openProfile')}</Link>
          </div>
          <Suspense fallback={<Skeleton lines={6} />}>
            <Customer360Panel customerId={d.customer.id} currentConversationId={d.id} />
          </Suspense>
        </section>
      ) : (
        <section className="inbox-context-sec" aria-labelledby="inbox-c360">
          <h2 id="inbox-c360" className="inbox-context-title">{t('connect.ws.customer360')}</h2>
          <p className="fine m-0">{t(d.customer ? 'connect.ws.no360Permission' : 'connect.ws.noCustomer')}</p>
        </section>
      )}
    </div>
  );
}

function ConversationTags({ d, tags, canReply, canManage, onChanged }: { d: Detail; tags: ConversationTag[]; canReply: boolean; canManage: boolean; onChanged(): Promise<void> | void }) {
  const { t } = useT();
  const { org } = useOrg();
  const session = useSession();
  const [name, setName] = useState('');
  const applied = d.tags ?? [];
  const appliedIds = new Set(applied.map((x) => x.id));
  const base = `/o/${org.id}/connect`;
  const toggle = useAction(async (tagId: string, on: boolean) => {
    await session.call(`${base}/conversations/${d.id}/tags/${tagId}`, { method: on ? 'PUT' : 'DELETE' });
    await onChanged();
  });
  const create = useAction(async (e: FormEvent) => {
    e.preventDefault();
    const tag = await session.call<ConversationTag>(`${base}/tags`, { body: { name: name.trim() } });
    setName('');
    await session.call(`${base}/conversations/${d.id}/tags/${tag.id}`, { method: 'PUT' });
    await onChanged();
  });
  const available = tags.filter((x) => !appliedIds.has(x.id));
  return (
    <section className="inbox-context-sec" aria-labelledby="inbox-tags">
      <div className="inbox-context-head">
        <h2 id="inbox-tags" className="inbox-context-title">{t('connect.ws.tags')}</h2>
        {canReply && available.length > 0 && (
          <Menu label={t('connect.ws.addTag')} align="end" items={available.map((x) => ({ key: x.id, label: x.name, onSelect: () => void toggle.run(x.id, true), disabled: toggle.pending }))}
            trigger={<button type="button" className="btn btn-sm" data-inbox-add-tag="">{t('connect.ws.addTag')}</button>} />
        )}
      </div>
      {applied.length ? (
        <ul className="inbox-tags" aria-label={t('connect.ws.tags')}>
          {applied.map((x) => (
            <li key={x.id} className="inbox-tag" data-color={x.color}>
              <bdi>{x.name}</bdi>
              {canReply && <button type="button" className="inbox-tag-remove" disabled={toggle.pending} aria-label={t('connect.ws.removeTag', { name: x.name })}
                onClick={() => void toggle.run(x.id, false)}>×</button>}
            </li>
          ))}
        </ul>
      ) : <p className="fine m-0">{t('connect.ws.noTags')}</p>}
      {canManage && (
        <form className="inbox-tag-new" onSubmit={create.run}>
          <label className="sr-only" htmlFor="inbox-tag-name">{t('connect.ws.newTag')}</label>
          <input id="inbox-tag-name" className="input" value={name} maxLength={40} placeholder={t('connect.ws.newTag')} onChange={(e) => setName(e.target.value)} />
          <button className="btn btn-sm" disabled={create.pending || !name.trim()}>{t('action.create')}</button>
        </form>
      )}
      {(toggle.error || create.error) && <Notice tone="danger">{toggle.error ?? create.error}</Notice>}
    </section>
  );
}
