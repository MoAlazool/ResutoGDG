'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Page } from '@resuto/contracts';
import { EmptyState, Kbd, Notice, Skeleton, WorkspacePage } from '@resuto/ui';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { newIdempotencyKey } from '@/lib/api';
import { APP_ORIGIN } from '@/lib/app-origin';
import { useT } from '@/lib/i18n/client';
import {
  createInboxKeyReader, DEFAULT_FILTERS, inBranch, KEY_OF, listPollMs, listQuery, mergePages, step, threadPollMs, type InboxFilters, type InboxKey,
} from '@/lib/inbox';
import { useBranchScope, useOrg } from '@/lib/org-context';
import { usePageCommands } from '@/lib/page-commands';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { Composer, type ComposerHandle, type ComposerMode, type QuickActions } from './_components/Composer';
import { ContextPane } from './_components/ContextPane';
import { ConversationList } from './_components/ConversationList';
import { Thread, ThreadHeader } from './_components/Thread';
import type { Assignee, Channel, ConvItem, ConversationTag, Detail, SavedReply, Template } from './_components/types';
import './inbox.css';

const Simulator = lazy(() => import('./_components/Simulator'));
const MESSAGING = '/settings/messaging';

/**
 * Inbox workspace (21-INBOX increment 2, plan §6.5): conversations at the reading start, the thread and composer in the
 * centre, the conversation's tags and the customer's 360 at the reading end. Channels and templates live in Settings ›
 * Messaging; the old ?tab= links lead there.
 */
export default function InboxPage() {
  const router = useRouter();
  const { org } = useOrg();
  const params = useSearchParams();
  const tab = params.get('tab');
  const moved = tab === 'channels' || tab === 'templates' || params.get('signup') === 'whatsapp';
  useEffect(() => {
    if (moved) router.replace(`/dashboard/${org.id}${MESSAGING}${tab === 'templates' ? '?tab=templates' : ''}`);
  }, [moved, tab, org.id, router]);
  if (moved) return <Skeleton lines={4} />;
  return (
    <ModuleGate module="connect" permission="connect:read">
      <InboxWorkspace />
    </ModuleGate>
  );
}

function useDocumentVisible() {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const on = () => setVisible(document.visibilityState === 'visible');
    on();
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return visible;
}

function useNarrow(query = '(max-width: 700px)') {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const m = window.matchMedia(query);
    const on = () => setNarrow(m.matches);
    on();
    m.addEventListener?.('change', on);
    return () => m.removeEventListener?.('change', on);
  }, [query]);
  return narrow;
}

function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(id); }, [ms]);
  return now;
}

function InboxWorkspace() {
  const { t } = useT();
  const { org, can, hasModule } = useOrg();
  const { branchId } = useBranchScope({ allowAll: true });
  const session = useSession();
  const params = useSearchParams();
  const base = `/o/${org.id}/connect`;
  const visible = useDocumentVisible();
  const narrow = useNarrow();
  const now = useNow(30_000);
  const [filters, setFiltersState] = useState<InboxFilters>(DEFAULT_FILTERS);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(() => params.get('c'));
  const [phonePane, setPhonePane] = useState<'list' | 'thread'>(() => (params.get('c') ? 'thread' : 'list'));
  const [mode, setMode] = useState<ComposerMode>('reply');
  const [simOpen, setSimOpen] = useState<boolean | null>(null);
  const [announce, setAnnounce] = useState('');
  const composer = useRef<ComposerHandle>(null);

  // Polls of the list that came back unchanged (it backs off while nothing happens).
  const [unchanged, setUnchanged] = useState(0);
  // Search is debounced; the other filters apply at once.
  useEffect(() => { const h = setTimeout(() => setFiltersState((f) => (f.q === search ? f : { ...f, q: search })), 250); return () => clearTimeout(h); }, [search]);
  const setFilters = (next: InboxFilters) => { setSearch(next.q); setFiltersState((f) => ({ ...next, q: f.q })); setUnchanged(0); };

  // Conversation list: the first page is polled (ETag/304), older pages are fetched on demand.
  const qs = listQuery(filters);
  const list = useApi<Page<ConvItem>>(`${base}/conversations?${qs}`, { pollMs: listPollMs({ visible, threadOpen: !!selectedId, unchanged }) });
  const lastList = useRef<unknown>(null);
  useEffect(() => {
    if (!list.updatedAt) return;
    setUnchanged((u) => (list.data === lastList.current ? u + 1 : 0));
    lastList.current = list.data;
  }, [list.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const [older, setOlder] = useState<{ key: string; items: ConvItem[]; cursor: string | null; loading: boolean }>({ key: '', items: [], cursor: null, loading: false });
  const olderHere = older.key === qs ? older : { key: qs, items: [] as ConvItem[], cursor: null, loading: false };
  const nextCursor = olderHere.items.length ? olderHere.cursor : list.data?.nextCursor ?? null;
  const loadMore = useCallback(() => {
    if (!nextCursor || olderHere.loading) return;
    setOlder({ ...olderHere, loading: true });
    void session.call<Page<ConvItem>>(`${base}/conversations?${listQuery(filters, nextCursor)}`)
      .then((p) => setOlder({ key: qs, items: [...olderHere.items, ...p.items], cursor: p.nextCursor, loading: false }))
      .catch(() => setOlder({ ...olderHere, loading: false }));
  }, [nextCursor, olderHere, session, base, filters, qs]);
  const items = useMemo(() => mergePages(list.data?.items ?? [], olderHere.items).filter((c) => inBranch(c, branchId)), [list.data, olderHere.items, branchId]);
  const ids = useMemo(() => items.map((c) => c.id), [items]);

  // New customer messages in other conversations are announced politely (polls of the same list only, not a new
  // filter or branch, whose rows are not news).
  const unread = useRef<{ key: string; counts: Map<string, number> } | null>(null);
  useEffect(() => {
    if (list.pending) return; // the previous filter's rows, shown while the new ones load
    const prev = unread.current;
    const listKey = `${qs}|${branchId}`;
    if (prev && prev.key === listKey) {
      const fresh = items.find((c) => c.id !== selectedId && c.unreadCount > (prev.counts.get(c.id) ?? 0));
      if (fresh) setAnnounce(t('connect.ws.newMessage', { name: fresh.name ?? fresh.contact ?? t('connect.inbox.guest.other'), text: (fresh.lastMessage?.body ?? '').slice(0, 140) }));
    }
    if (list.data) unread.current = { key: listKey, counts: new Map(items.map((c) => [c.id, c.unreadCount])) };
  }, [items, selectedId, t, qs, branchId, list.data, list.pending]);

  // The open thread: every 4 s while it is on screen and the page is visible (lib/inbox.ts threadPollMs).
  const threadShown = !narrow || phonePane === 'thread';
  const detail = useApi<Detail>(selectedId ? `${base}/conversations/${selectedId}` : null, { pollMs: threadPollMs(visible, threadShown), pauseWhileEditing: false });
  const d = detail.data && detail.data.id === selectedId ? detail.data : undefined;

  const channels = useApi<{ items: Channel[] }>(`${base}/channels`, { staleMs: 5 * 60_000 });
  const branchChannels = useMemo(() => (channels.data?.items ?? []).filter((c) => c.status !== 'disabled' && inBranch(c, branchId)), [channels.data, branchId]);
  const tags = useApi<{ items: ConversationTag[] }>(`${base}/tags`, { staleMs: 60_000 });
  const replies = useApi<{ items: SavedReply[] }>(`${base}/saved-replies${branchId ? `?branchId=${branchId}` : ''}`, { staleMs: 5 * 60_000 });
  const templates = useApi<{ items: Template[] }>(selectedId && can('connect:reply') ? `${base}/templates` : null, { staleMs: 5 * 60_000 });
  const assignees = useApi<{ items: Assignee[] }>(can('connect:manage') ? `${base}/assignees` : null, { staleMs: 5 * 60_000 });

  const select = useCallback((id: string) => {
    setSelectedId(id);
    setPhonePane('thread');
    setMode('reply');
    setUnchanged(0);
    const q = new URLSearchParams(window.location.search);
    q.set('c', id);
    window.history.replaceState(window.history.state, '', `${window.location.pathname}?${q}`);
  }, []);
  // A link to another conversation of the Inbox (?c=, e.g. from the Customer 360 panel) opens it.
  const cParam = params.get('c');
  useEffect(() => { if (cParam && cParam !== selectedId) { setSelectedId(cParam); setPhonePane('thread'); } }, [cParam]); // eslint-disable-line react-hooks/exhaustive-deps
  // Opening a conversation marks it read.
  useEffect(() => {
    if (!selectedId) return;
    void session.call(`${base}/conversations/${selectedId}/read`, { method: 'POST' }).then(() => list.reload()).catch(() => undefined);
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = useCallback(async () => { await Promise.all([detail.reload(), list.reload()]); }, [detail, list]);
  const [busy, setBusy] = useState(false);
  const [actError, setActError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setActError(null);
    try { await fn(); await refresh(); } catch (e) { setActError((e as Error).message); } finally { setBusy(false); }
  };
  const act = (path: string) => run(() => session.call(`${base}/conversations/${selectedId}/${path}`, { method: 'POST', body: {} }));
  const assign = (userId: string | null) => run(() => session.call(`${base}/conversations/${selectedId}/assign`, { body: { userId } }));
  const resend = (messageId: string) => run(() => session.call(`${base}/messages/${messageId}/resend`, { method: 'POST' }));
  const replyKey = useRef(newIdempotencyKey());
  const noteKey = useRef(newIdempotencyKey());
  const onReply = async (body: { text: string } | { templateName: string; variables: string[] }) => {
    await session.call(`${base}/conversations/${selectedId}/reply`, { body: { ...body, key: replyKey.current } });
    replyKey.current = newIdempotencyKey();
    await refresh();
  };
  const onNote = async (body: string) => {
    await session.call(`${base}/conversations/${selectedId}/notes`, { body: { body, key: noteKey.current } });
    noteKey.current = newIdempotencyKey();
    await detail.reload();
  };

  // Quick actions: public links for the conversation's branch (or the shell's), and a payment link for its order.
  const item = items.find((c) => c.id === selectedId);
  const branch = org.branches.find((b) => b.id === (item?.branchId ?? branchId)) ?? org.branches.find((b) => b.isActive) ?? null;
  const usableTemplates = (templates.data?.items ?? []).filter((tp) => tp.providerStatus === 'approved' || (d?.channel.sandbox && tp.providerStatus === 'sandbox'));
  const orderId = d?.orderingSession?.orderId ?? null;
  const quick: QuickActions = {
    orderUrl: branch && (branch.acceptsPickup !== false || branch.acceptsDelivery !== false) ? `${APP_ORIGIN}/order/${org.slug}?branch=${encodeURIComponent(branch.code)}` : null,
    reserveUrl: branch?.acceptsReservations ? `${APP_ORIGIN}/reserve/${org.slug}?branch=${encodeURIComponent(branch.code)}` : null,
    paymentLink: orderId && hasModule('pay') && can('payments:collect') ? async () => {
      const link = await session.call<{ url: string | null }>(`/o/${org.id}/payments/links`, { body: { orderId, key: newIdempotencyKey() } });
      if (!link.url) throw new Error(t('connect.ws.paymentLinkUnavailable'));
      return link.url;
    } : null,
  };

  // Keyboard triage (j/k/r/n/a/e): ignored while typing, in dialogs and menus, and after the shell's `g`.
  const keyAction = (k: InboxKey) => {
    if (k === 'next' || k === 'prev') { const id = step(ids, selectedId, k === 'next' ? 1 : -1); if (id && id !== selectedId) select(id); return !!id; }
    if (!d) return false;
    if (k === 'reply' || k === 'note') { if (!can('connect:reply')) return false; setPhonePane('thread'); composer.current?.focus(k); return true; }
    if (k === 'assign') {
      const btn = document.querySelector<HTMLButtonElement>('[data-inbox-assign]');
      if (!btn) return false;
      btn.focus(); btn.click();
      return true;
    }
    if (k === 'close') { if (!can('connect:reply') || d.status === 'closed') return false; void act('close'); return true; }
    return false;
  };
  const keyRef = useRef(keyAction);
  keyRef.current = keyAction;
  useEffect(() => {
    const read = createInboxKeyReader();
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const k = read(e);
      if (k && keyRef.current(k)) e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // ⌘K actions and the ? cheat sheet list the same commands (lib/page-commands.ts).
  const label: Record<InboxKey, string> = {
    next: t('connect.ws.key.next'), prev: t('connect.ws.key.prev'), reply: t('connect.ws.key.reply'), note: t('connect.ws.key.note'),
    assign: t('connect.ws.key.assign'), close: t('connect.ws.key.close'),
  };
  const words: Record<InboxKey, string> = { next: 'next down conversation', prev: 'previous up conversation', reply: 'reply answer respond message',
    note: 'internal note comment staff', assign: 'assign owner teammate', close: 'close done resolve archive' };
  usePageCommands({
    title: t('connect.inbox.title'),
    commands: (Object.keys(KEY_OF) as InboxKey[]).map((k) => ({
      id: k, key: KEY_OF[k], label: label[k], keywords: words[k], run: () => { keyAction(k); },
      enabled: k === 'next' || k === 'prev' ? ids.length > 0 : k === 'assign' ? !!d && can('connect:manage') : !!d && can('connect:reply'),
    })),
  });

  return (
    <div className="inbox-page" data-pane={phonePane}>
      <div className="inbox-head">
        <h1 className="inbox-title">{t('connect.inbox.title')}</h1>
        <span className="fine inbox-keys-hint" aria-hidden="true"><Kbd>j</Kbd> <Kbd>k</Kbd> {t('connect.ws.keysHint')} <Kbd>?</Kbd></span>
        <div className="inbox-head-actions">
          {can('connect:manage') && branchChannels.some((c) => c.sandbox) && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSimOpen(true)}>{t('connect.sim.title')}</button>
          )}
          <Link className="btn btn-sm btn-ghost" href={`/dashboard/${org.id}${MESSAGING}`}>{t('connect.ws.channelsTemplates')}</Link>
        </div>
      </div>
      <WorkspacePage labels={{ start: t('connect.inbox.conversations'), main: t('connect.ws.threadPane'), end: t('connect.ws.contextPane') }}
        start={(
          <ConversationList items={items} selectedId={selectedId} onSelect={select} loading={list.loading} error={list.error?.message ?? null}
            hasMore={!!nextCursor} loadingMore={olderHere.loading} onLoadMore={loadMore} filters={{ ...filters, q: search }} onFilters={setFilters}
            channels={branchChannels} tags={tags.data?.items ?? []} timeZone={org.timezone} now={now} />
        )}
        end={d ? <ContextPane d={d} tags={tags.data?.items ?? []} onTagsChanged={refresh} /> : undefined}>
        {!selectedId ? (
          <div className="inbox-pad inbox-empty-thread">
            <EmptyState title={t('connect.ws.pick')}>{t('connect.ws.pickBody')}</EmptyState>
          </div>
        ) : !d ? (
          <div className="inbox-pad">{detail.error ? <Notice tone="danger">{detail.error.message}</Notice> : <Skeleton lines={8} />}</div>
        ) : (
          <div className="inbox-main">
            <ThreadHeader d={d} orgId={org.id} canReply={can('connect:reply')} canManage={can('connect:manage')} assignees={assignees.data?.items ?? []}
              busy={busy} onAssign={(u) => void assign(u)} onAct={(p) => void act(p)} onBack={() => setPhonePane('list')} />
            {actError && <div className="inbox-pad"><Notice tone="danger">{actError}</Notice></div>}
            <Thread d={d} timeZone={org.timezone} canReply={can('connect:reply')} resendBusy={busy} onResend={(id) => void resend(id)} />
            <Composer ref={composer} d={d} mode={mode} onMode={setMode} canReply={can('connect:reply')} templates={usableTemplates}
              savedReplies={replies.data?.items ?? []} quick={quick} onReply={onReply} onNote={onNote} />
          </div>
        )}
      </WorkspacePage>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announce}</div>
      {simOpen !== null && (
        <Suspense fallback={null}>
          <Simulator open={simOpen} onClose={() => setSimOpen(false)} channels={branchChannels} onSent={(id) => { void list.reload(); if (id === selectedId) void detail.reload(); else select(id); }} />
        </Suspense>
      )}
    </div>
  );
}
