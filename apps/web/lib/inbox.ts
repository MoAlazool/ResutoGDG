// Inbox workspace logic (21-INBOX increment 2, plan §6.5), framework-free so it is unit tested without a browser:
// the list views and their API query, keyboard triage keys, polling intervals, the reply-time (SLA) timer, day
// separators in the thread, the "/" saved-reply picker and the virtualised list window.
import { dateTimeFormat } from '@resuto/contracts/lite';
import { isTypingTarget, SEQUENCE_MS, type KeyLike } from './shortcuts';

// ---------------------------------------------------------------------------------------------------------------------
// Views and filters
// ---------------------------------------------------------------------------------------------------------------------
export const INBOX_VIEW_KEYS = ['all', 'mine', 'unassigned', 'open', 'leads', 'ordering'] as const;
export type InboxViewKey = (typeof INBOX_VIEW_KEYS)[number];

export interface InboxFilters { view: InboxViewKey; channelId: string | null; tagId: string | null; q: string; unread: boolean }
export const DEFAULT_FILTERS: InboxFilters = { view: 'all', channelId: null, tagId: null, q: '', unread: false };
export const LIST_PAGE = 50;

/** The API query of the conversation list for a view and filters (GET connect/conversations). */
export function listQuery(f: InboxFilters, cursor?: string | null): string {
  const p = new URLSearchParams({ limit: String(LIST_PAGE) });
  if (f.view === 'mine') p.set('assigned', 'me');
  else if (f.view === 'unassigned') p.set('assigned', 'unassigned');
  else if (f.view === 'open') p.set('status', 'open');
  else if (f.view === 'leads' || f.view === 'ordering') p.set('view', f.view);
  if (f.channelId) p.set('channelId', f.channelId);
  if (f.tagId) p.set('tagId', f.tagId);
  if (f.unread) p.set('unread', 'true');
  const q = f.q.trim();
  if (q) p.set('q', q.slice(0, 80));
  if (cursor) p.set('cursor', cursor);
  return p.toString();
}

/** The shell's branch context: a conversation of another branch is hidden; organization-wide channels show everywhere. */
export const inBranch = (item: { branchId?: string | null }, branchId: string | null | undefined) =>
  !branchId || !item.branchId || item.branchId === branchId;

/** Items of the first (polled) page followed by older pages, without duplicates (a conversation that moved up). */
export function mergePages<T extends { id: string }>(first: readonly T[], older: readonly T[]): T[] {
  const seen = new Set(first.map((i) => i.id));
  return [...first, ...older.filter((i) => !seen.has(i.id) && (seen.add(i.id), true))];
}

// ---------------------------------------------------------------------------------------------------------------------
// Keyboard triage: j/k move, r reply, n note, a assign, e close (ignored while typing, in dialogs and after `g`)
// ---------------------------------------------------------------------------------------------------------------------
export type InboxKey = 'next' | 'prev' | 'reply' | 'note' | 'assign' | 'close';
export const INBOX_KEYS: Readonly<Record<string, InboxKey>> = { j: 'next', k: 'prev', r: 'reply', n: 'note', a: 'assign', e: 'close' };
/** Key of each command as the cheat sheet shows it. */
export const KEY_OF: Readonly<Record<InboxKey, string>> = { next: 'j', prev: 'k', reply: 'r', note: 'n', assign: 'a', close: 'e' };

/** The Latin letter of a key press, also on an Arabic keyboard layout (from the physical key). */
function letterOf(e: KeyLike & { code?: string }): string {
  if (/^[a-z]$/i.test(e.key)) return e.key.toLowerCase();
  return /^Key[A-Z]$/.test(e.code ?? '') ? e.code!.slice(3).toLowerCase() : '';
}

/** Inside a dialog, popover, menu or listbox: those widgets own their keys (type-ahead, arrows). */
const inDialog = (target: EventTarget | null | undefined) =>
  !!(target && typeof (target as Element).closest === 'function'
    && (target as Element).closest('dialog[open], [role="dialog"]:not([hidden]), [role="menu"], [role="listbox"]'));

/**
 * A reader of the Inbox's single-key shortcuts. It returns null for anything typed into a field, inside a dialog or
 * popover, with a modifier, held down, and for the key after `g` (that one is the shell's g + letter navigation).
 */
export function createInboxKeyReader(timeoutMs = SEQUENCE_MS) {
  let gAt: number | null = null;
  return (e: KeyLike & { code?: string }, now = Date.now()): InboxKey | null => {
    if (e.isComposing || isTypingTarget(e.target) || inDialog(e.target) || e.metaKey || e.ctrlKey || e.altKey || e.repeat) { gAt = null; return null; }
    const letter = letterOf(e);
    if (gAt !== null && now - gAt <= timeoutMs) { gAt = null; return null; }
    gAt = letter === 'g' && !e.shiftKey ? now : null;
    if (!letter || e.shiftKey || letter === 'g') return null;
    return INBOX_KEYS[letter] ?? null;
  };
}

/** The conversation j/k moves to (wrapping is not done: the ends stay put). */
export function step(ids: readonly string[], current: string | null, dir: 1 | -1): string | null {
  if (!ids.length) return null;
  const i = current ? ids.indexOf(current) : -1;
  if (i === -1) return dir === 1 ? ids[0]! : ids[ids.length - 1]!;
  return ids[Math.min(ids.length - 1, Math.max(0, i + dir))]!;
}

// ---------------------------------------------------------------------------------------------------------------------
// Polling: the thread every 4 s while the page is visible; slower otherwise (ETag/304 makes an unchanged poll cheap)
// ---------------------------------------------------------------------------------------------------------------------
export const THREAD_POLL_MS = 4_000;
export const HIDDEN_POLL_MS = 60_000;
const LIST_POLL_MS = 4_000;
const LIST_POLL_MAX_MS = 30_000;

/** The open thread: every 4 s while the document is visible and the thread is on screen, else backed off. */
export const threadPollMs = (visible: boolean, shown = true) => (visible && shown ? THREAD_POLL_MS : HIDDEN_POLL_MS);

/**
 * The conversation list: 4 s while visible with no thread open, 8 s while a thread is (its own poll covers it), doubling
 * every 3 unchanged answers up to 30 s; hidden documents back off to a minute (useApi also skips hidden polls).
 */
export function listPollMs({ visible, threadOpen, unchanged }: { visible: boolean; threadOpen: boolean; unchanged: number }): number {
  if (!visible) return HIDDEN_POLL_MS;
  const base = threadOpen ? LIST_POLL_MS * 2 : LIST_POLL_MS;
  return Math.min(LIST_POLL_MAX_MS, base * 2 ** Math.floor(Math.max(0, unchanged) / 3));
}

// ---------------------------------------------------------------------------------------------------------------------
// Reply-time (SLA) timer
// ---------------------------------------------------------------------------------------------------------------------
export const SLA_WARN_MS = 5 * 60_000;
export const SLA_BREACH_MS = 15 * 60_000;

/** When the customer started waiting for a person: their message is the last one and no bot handles the chat. */
export function waitingSince(c: { status: string; lastMessage: { direction: string } | null; lastMessageAt: string | null }): string | null {
  if (c.status === 'closed' || c.status === 'bot' || !c.lastMessage || c.lastMessage.direction !== 'inbound') return null;
  return c.lastMessageAt;
}

export const slaTone = (waitedMs: number): 'ok' | 'warn' | 'danger' => (waitedMs >= SLA_BREACH_MS ? 'danger' : waitedMs >= SLA_WARN_MS ? 'warn' : 'ok');

// ---------------------------------------------------------------------------------------------------------------------
// Thread: messages and internal notes in time order, with a separator per day (restaurant time zone)
// ---------------------------------------------------------------------------------------------------------------------
/** Calendar day (YYYY-MM-DD) of an instant in a time zone. */
export function dayKey(iso: string | number | Date, timeZone?: string): string {
  const parts = dateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export type ThreadEntry<M, N> =
  | { type: 'day'; key: string; at: string }
  | { type: 'message'; key: string; at: string; message: M }
  | { type: 'note'; key: string; at: string; note: N };

/** Customer messages and staff notes merged by time, with a day separator before each new day. */
export function threadEntries<M extends { id: string; createdAt: string }, N extends { id: string; createdAt: string }>(
  messages: readonly M[], notes: readonly N[], timeZone?: string,
): Array<ThreadEntry<M, N>> {
  const items = [
    ...messages.map((m) => ({ type: 'message' as const, key: `m:${m.id}`, at: m.createdAt, message: m })),
    ...notes.map((n) => ({ type: 'note' as const, key: `n:${n.id}`, at: n.createdAt, note: n })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.key.localeCompare(b.key));
  const out: Array<ThreadEntry<M, N>> = [];
  let last = '';
  for (const it of items) {
    const day = dayKey(it.at, timeZone);
    if (day !== last) { out.push({ type: 'day', key: `d:${day}`, at: it.at }); last = day; }
    out.push(it);
  }
  return out;
}

/** "today" / "yesterday" relative to `now`, otherwise null (the caller prints the date). */
export function relativeDay(iso: string, timeZone: string | undefined, now = Date.now()): 'today' | 'yesterday' | null {
  const d = dayKey(iso, timeZone);
  if (d === dayKey(now, timeZone)) return 'today';
  if (d === dayKey(now - 864e5, timeZone)) return 'yesterday';
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Saved replies: "/" at the start of the draft or after a space opens the picker
// ---------------------------------------------------------------------------------------------------------------------
export interface SavedReplyLike { id: string; title: string; shortcut: string | null; bodyEn: string | null; bodyAr: string | null }

/** The "/query" being typed just before the caret, or null. */
export function slashQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)\/([^\s/]{0,32})$/u.exec(before);
  if (!m) return null;
  return { start: before.length - m[2]!.length - 1, query: m[2]! };
}

const fold = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ًͯ-ٰٟ]/g, '');

/** Saved replies for a query: shortcut prefix first, then title prefix, a word of the title, then the body text. */
export function matchSavedReplies<R extends SavedReplyLike>(replies: readonly R[], query: string, limit = 8): R[] {
  const q = fold(query.trim());
  if (!q) return replies.slice(0, limit);
  const score = (r: R) => {
    if (r.shortcut && r.shortcut.startsWith(q)) return 4;
    const title = fold(r.title);
    if (title.startsWith(q)) return 3;
    if (title.split(/\s+/).some((w) => w.startsWith(q))) return 2;
    // Body text only from three characters on (one letter is in almost every reply).
    return q.length >= 3 && fold(`${r.bodyEn ?? ''} ${r.bodyAr ?? ''}`).includes(q) ? 1 : 0;
  };
  return replies.map((r, i) => ({ r, i, s: score(r) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.i - b.i).slice(0, limit).map((x) => x.r);
}

/** The reply in the conversation's language, falling back to the other one. */
export const replyBody = (r: SavedReplyLike, locale: string) => (locale === 'ar' ? r.bodyAr ?? r.bodyEn : r.bodyEn ?? r.bodyAr) ?? '';

/** Replaces the "/query" (or inserts at the caret) with the reply; returns the new draft and caret. */
export function insertReply(text: string, caret: number, body: string, slash: { start: number } | null): { text: string; caret: number } {
  const start = slash ? slash.start : caret;
  const next = `${text.slice(0, start)}${body}${text.slice(caret)}`;
  return { text: next, caret: start + body.length };
}

/** Inserts a snippet (a link) at the caret on its own, separated by a space from the text around it. */
export function insertSnippet(text: string, caret: number, snippet: string): { text: string; caret: number } {
  const before = text.slice(0, caret);
  const after = text.slice(caret);
  const pre = before && !/\s$/.test(before) ? ' ' : '';
  const post = after && !/^\s/.test(after) ? ' ' : '';
  const next = `${before}${pre}${snippet}${post}${after}`;
  return { text: next, caret: before.length + pre.length + snippet.length };
}

// ---------------------------------------------------------------------------------------------------------------------
// Virtualised list: only the rows in view (plus a margin) are rendered
// ---------------------------------------------------------------------------------------------------------------------
export function virtualWindow(scrollTop: number, viewport: number, count: number, rowHeight: number, overscan = 6) {
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const last = Math.min(count, Math.ceil((scrollTop + Math.max(viewport, rowHeight)) / rowHeight) + overscan);
  return { start: first, end: last, before: first * rowHeight, after: Math.max(0, (count - last) * rowHeight) };
}

/** The scroll offset that brings row `index` into view (unchanged when it already is). */
export function scrollToRow(scrollTop: number, viewport: number, index: number, rowHeight: number): number {
  const top = index * rowHeight;
  if (top < scrollTop) return top;
  if (top + rowHeight > scrollTop + viewport) return top + rowHeight - viewport;
  return scrollTop;
}
