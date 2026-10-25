'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Badge, EmptyState, Notice, ProviderLogo, Skeleton } from '@resuto/ui';
import { formatElapsedMs, formatWhen } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { INBOX_VIEW_KEYS, scrollToRow, slaTone, virtualWindow, waitingSince, type InboxFilters } from '@/lib/inbox';
import { guestKey, providerOf, type Channel, type ConvItem, type ConversationTag } from './types';

/** Fixed row height of the virtualised list (px): three lines plus padding, and a ≥ 44 px target. */
export const ROW_HEIGHT = 88;
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export interface ConversationListProps {
  items: ConvItem[];
  selectedId: string | null;
  onSelect(id: string): void;
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore(): void;
  filters: InboxFilters;
  onFilters(next: InboxFilters): void;
  channels: Channel[];
  tags: ConversationTag[];
  timeZone: string;
  now: number;
}

/** Left pane: search, views, channel chips, tag and unread filters, and the virtualised conversation list. */
export function ConversationList(props: ConversationListProps) {
  const { items, selectedId, onSelect, loading, error, hasMore, loadingMore, onLoadMore, filters, onFilters, channels, tags, timeZone, now } = props;
  const { t, locale } = useT();
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 0 });
  const set = (patch: Partial<InboxFilters>) => onFilters({ ...filters, ...patch });

  // Viewport size and scroll position drive which rows are rendered.
  useIsoLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setView({ top: el.scrollTop, height: el.clientHeight });
    measure();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);
  const selectedIndex = selectedId ? items.findIndex((c) => c.id === selectedId) : -1;
  // Keep the selected conversation in view (j/k), and move the focus with it when the focus was in the list.
  useEffect(() => {
    const el = scroller.current;
    if (!el || selectedIndex < 0) return;
    const next = scrollToRow(el.scrollTop, el.clientHeight || ROW_HEIGHT, selectedIndex, ROW_HEIGHT);
    if (next !== el.scrollTop) { el.scrollTop = next; setView({ top: next, height: el.clientHeight }); }
    if (el.contains(document.activeElement) && document.activeElement !== el) {
      requestAnimationFrame(() => el.querySelector<HTMLElement>(`[data-conversation="${selectedId}"]`)?.focus());
    }
  }, [selectedIndex, selectedId]);

  const win = virtualWindow(view.top, view.height, items.length, ROW_HEIGHT);
  // Near the end of what is loaded: fetch the next page (the button below does the same for keyboard users).
  useEffect(() => { if (hasMore && !loadingMore && items.length > 0 && win.end >= items.length - 2) onLoadMore(); }, [hasMore, loadingMore, items.length, win.end, onLoadMore]);

  const viewLabel = (k: string) => t(`connect.ws.view.${k}`);
  const showChannels = channels.length > 1;
  const filtered = filters.view !== 'all' || !!filters.channelId || !!filters.tagId || filters.unread || !!filters.q.trim();

  return (
    <div className="inbox-list">
      <div className="inbox-filters">
        <input className="input" type="search" placeholder={t('connect.inbox.search')} aria-label={t('connect.inbox.search')} value={filters.q}
          onChange={(e) => set({ q: e.target.value })} maxLength={80} />
        <div className="inbox-chips" data-wrap="" role="group" aria-label={t('connect.ws.views')}>
          {INBOX_VIEW_KEYS.map((k) => (
            <button key={k} type="button" className="inbox-chip" aria-pressed={filters.view === k} onClick={() => set({ view: k })}>{viewLabel(k)}</button>
          ))}
        </div>
        {showChannels && (
          <div className="inbox-chips" role="group" aria-label={t('connect.ws.channels')}>
            <button type="button" className="inbox-chip" aria-pressed={!filters.channelId} onClick={() => set({ channelId: null })}>{t('connect.ws.allChannels')}</button>
            {channels.map((c) => (
              <button key={c.id} type="button" className="inbox-chip" aria-pressed={filters.channelId === c.id} onClick={() => set({ channelId: c.id })}>
                <ProviderLogo provider={providerOf(c.kind)} size={16} decorative /><bdi>{c.displayName}</bdi>
                {c.sandbox && <span className="inbox-chip-note">{t('connect.sandbox.badge')}</span>}
              </button>
            ))}
          </div>
        )}
        <div className="inbox-filter-row">
          {tags.length > 0 && (
            <select className="select inbox-tag-filter" aria-label={t('connect.ws.tagFilter')} value={filters.tagId ?? ''} onChange={(e) => set({ tagId: e.target.value || null })}>
              <option value="">{t('connect.ws.allTags')}</option>
              {tags.map((tg) => <option key={tg.id} value={tg.id}>{tg.name}</option>)}
            </select>
          )}
          <button type="button" className="inbox-chip" aria-pressed={filters.unread} onClick={() => set({ unread: !filters.unread })}>{t('connect.inbox.unread')}</button>
        </div>
      </div>
      {error && <div className="inbox-pad"><Notice tone="danger">{error}</Notice></div>}
      {loading && !items.length && <div className="inbox-pad"><Skeleton lines={6} /></div>}
      {!loading && !error && items.length === 0 && (
        <div className="inbox-pad">{filtered
          ? <EmptyState title={t('connect.ws.emptyView')}>{t('connect.ws.emptyViewBody')}</EmptyState>
          : <EmptyState title={t('connect.inbox.empty')}>{t('connect.inbox.emptyBody')}</EmptyState>}</div>
      )}
      <div ref={scroller} className="inbox-list-scroll" onScroll={(e) => setView({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}>
        {items.length > 0 && (
          <ul className="inbox-rows" aria-label={t('connect.inbox.conversations')}>
            {win.before > 0 && <li aria-hidden="true" className="inbox-spacer" style={{ blockSize: win.before }} />}
            {items.slice(win.start, win.end).map((c, i) => (
              <Row key={c.id} c={c} index={win.start + i} count={items.length} selected={c.id === selectedId} onSelect={onSelect} timeZone={timeZone} now={now} locale={locale} t={t} />
            ))}
            {win.after > 0 && <li aria-hidden="true" className="inbox-spacer" style={{ blockSize: win.after }} />}
          </ul>
        )}
        {hasMore && (
          <div className="inbox-pad">
            <button type="button" className="btn btn-sm btn-ghost inbox-more" disabled={loadingMore} onClick={onLoadMore}>{loadingMore ? t('state.loading') : t('insights.loadMore')}</button>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ c, index, count, selected, onSelect, timeZone, now, locale, t }: {
  c: ConvItem; index: number; count: number; selected: boolean; onSelect(id: string): void; timeZone: string; now: number; locale: 'en' | 'ar';
  t: (k: string, v?: Record<string, string | number>) => string;
}) {
  const waiting = waitingSince(c);
  const waited = waiting ? Math.max(0, now - Date.parse(waiting)) : null;
  const name = c.name ?? c.contact ?? t(guestKey(c.channelKind));
  return (
    <li className="inbox-row" aria-posinset={index + 1} aria-setsize={count}>
      <button type="button" className="inbox-row-btn" data-conversation={c.id} aria-current={selected || undefined} onClick={() => onSelect(c.id)}
        data-unread={c.unreadCount > 0 || undefined}>
        <span className="inbox-row-line">
          <ProviderLogo provider={providerOf(c.channelKind)} size={16} alt={c.channelName} />
          <strong className="inbox-row-name"><bdi>{name}</bdi></strong>
          <span className="inbox-row-time num">{formatWhen(c.lastMessageAt, locale, timeZone, now)}</span>
        </span>
        <span className="inbox-row-preview">
          {c.lastMessage ? <>{c.lastMessage.direction === 'outbound' && <span className="inbox-row-you">{t('connect.ws.you')} </span>}<bdi>{c.lastMessage.body ?? t('connect.inbox.unsupported')}</bdi></> : ' '}
        </span>
        <span className="inbox-row-line inbox-row-badges">
          {c.unreadCount > 0 && <Badge tone="ok"><span className="num">{c.unreadCount}</span><span className="sr-only"> {t('connect.inbox.unread')}</span></Badge>}
          {waited !== null && <span className="inbox-sla" data-tone={slaTone(waited)} title={t('connect.ws.waitingFor', { time: formatElapsedMs(waited, locale) })}>
            <span className="sr-only">{t('connect.ws.waiting')} </span><span className="num">{formatElapsedMs(waited, locale)}</span></span>}
          {c.status === 'handoff' && <Badge tone="warn">{t('connect.status.handoff')}</Badge>}
          {c.orderingStep && <Badge tone="info">{t('connect.ws.ordering')}</Badge>}
          {c.lead && <Badge>{t('connect.ws.lead')}</Badge>}
          {c.sandbox && <Badge tone="sandbox">{t('connect.sandbox.badge')}</Badge>}
          {c.tags.slice(0, 2).map((tg) => <span key={tg.id} className="inbox-tag" data-color={tg.color}><bdi>{tg.name}</bdi></span>)}
        </span>
      </button>
    </li>
  );
}
