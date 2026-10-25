import { describe, expect, it } from 'vitest';
import {
  createInboxKeyReader, DEFAULT_FILTERS, HIDDEN_POLL_MS, inBranch, insertReply, insertSnippet, listPollMs, listQuery, matchSavedReplies, mergePages,
  relativeDay, replyBody, scrollToRow, slaTone, slashQuery, step, threadEntries, threadPollMs, THREAD_POLL_MS, virtualWindow, waitingSince,
} from './inbox';

// 21-INBOX increment 2: the Inbox workspace's logic (views, keyboard triage, polling, SLA, thread days, saved replies,
// list virtualisation), framework-free.

/** A stand-in for a focused element (tag, type, role and its ancestors' `closest`). */
const el = (tag: string, attrs: Record<string, string> = {}, parent?: { closest(s: string): unknown }) => ({
  tagName: tag.toUpperCase(), type: attrs.type, isContentEditable: false, getAttribute: (k: string) => attrs[k] ?? null,
  closest: (s: string) => (parent ? parent.closest(s) : null),
}) as unknown as EventTarget & { closest(s: string): unknown };

describe('views and filters', () => {
  it('map each view to the conversation list query', () => {
    const q = (view: (typeof DEFAULT_FILTERS)['view']) => Object.fromEntries(new URLSearchParams(listQuery({ ...DEFAULT_FILTERS, view })));
    expect(q('all')).toEqual({ limit: '50' });
    expect(q('mine')).toEqual({ limit: '50', assigned: 'me' });
    expect(q('unassigned')).toEqual({ limit: '50', assigned: 'unassigned' });
    expect(q('open')).toEqual({ limit: '50', status: 'open' });
    expect(q('leads')).toEqual({ limit: '50', view: 'leads' });
    expect(q('ordering')).toEqual({ limit: '50', view: 'ordering' });
  });

  it('adds channel, tag, unread, a trimmed search and the cursor', () => {
    const p = new URLSearchParams(listQuery({ view: 'mine', channelId: 'ch1', tagId: 'tg1', unread: true, q: '  mona  ' }, 'cur-1'));
    expect(Object.fromEntries(p)).toEqual({ limit: '50', assigned: 'me', channelId: 'ch1', tagId: 'tg1', unread: 'true', q: 'mona', cursor: 'cur-1' });
    expect(new URLSearchParams(listQuery({ ...DEFAULT_FILTERS, q: 'x'.repeat(100) })).get('q')).toHaveLength(80);
  });

  it('follow the shell branch: other branches are hidden, organization-wide conversations show everywhere', () => {
    expect(inBranch({ branchId: 'b1' }, 'b1')).toBe(true);
    expect(inBranch({ branchId: 'b2' }, 'b1')).toBe(false);
    expect(inBranch({ branchId: null }, 'b1')).toBe(true);
    expect(inBranch({ branchId: 'b2' }, '')).toBe(true); // all branches
  });

  it('merge the polled first page with older pages without duplicates', () => {
    expect(mergePages([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'c' }, { id: 'c' }]).map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('keyboard triage keys', () => {
  const body = el('body');
  it('j k r n a e map to their commands', () => {
    const read = createInboxKeyReader();
    expect(['j', 'k', 'r', 'n', 'a', 'e', 'x'].map((key) => read({ key, target: body }))).toEqual(['next', 'prev', 'reply', 'note', 'assign', 'close', null]);
  });

  it('are ignored while typing (fields, editable content, IME), with modifiers and when held', () => {
    const read = createInboxKeyReader();
    expect(read({ key: 'j', target: el('textarea') })).toBeNull();
    expect(read({ key: 'j', target: el('input', { type: 'search' }) })).toBeNull();
    expect(read({ key: 'j', target: el('div', { role: 'textbox' }) })).toBeNull();
    expect(read({ key: 'j', target: body, isComposing: true })).toBeNull();
    expect(read({ key: 'j', target: body, ctrlKey: true })).toBeNull();
    expect(read({ key: 'j', target: body, metaKey: true })).toBeNull();
    expect(read({ key: 'J', target: body, shiftKey: true })).toBeNull();
    expect(read({ key: 'j', target: body, repeat: true })).toBeNull();
    // A checkbox or a button is not a text field: the shortcut works there.
    expect(read({ key: 'j', target: el('input', { type: 'checkbox' }) })).toBe('next');
  });

  it('are ignored inside dialogs, popovers, menus and listboxes (they own their keys)', () => {
    const read = createInboxKeyReader();
    const inMenu = el('button', {}, { closest: (s: string) => (s.includes('[role="menu"]') ? {} : null) });
    expect(read({ key: 'j', target: inMenu })).toBeNull();
    expect(read({ key: 'e', target: el('button', {}, { closest: () => ({}) }) })).toBeNull();
  });

  it('leave the key after `g` to the shell (g a is Analytics, not Assign)', () => {
    const read = createInboxKeyReader(1500);
    expect(read({ key: 'g', target: body }, 1000)).toBeNull();
    expect(read({ key: 'a', target: body }, 1200)).toBeNull();
    expect(read({ key: 'a', target: body }, 1300)).toBe('assign');
    expect(read({ key: 'g', target: body }, 5000)).toBeNull();
    expect(read({ key: 'j', target: body }, 9000)).toBe('next'); // the `g` expired
  });

  it('work on an Arabic keyboard layout (the physical key)', () => {
    const read = createInboxKeyReader();
    expect(read({ key: 'ت', code: 'KeyJ', target: body } as never)).toBe('next');
    expect(read({ key: 'ق', code: 'KeyE', target: body } as never)).toBe('close');
  });

  it('j/k step through the list and stop at its ends', () => {
    const ids = ['a', 'b', 'c'];
    expect(step(ids, null, 1)).toBe('a');
    expect(step(ids, null, -1)).toBe('c');
    expect(step(ids, 'a', 1)).toBe('b');
    expect(step(ids, 'c', 1)).toBe('c');
    expect(step(ids, 'a', -1)).toBe('a');
    expect(step(ids, 'gone', 1)).toBe('a');
    expect(step([], null, 1)).toBeNull();
  });
});

describe('polling', () => {
  it('polls the thread every 4 s only while it is visible, and backs off otherwise', () => {
    expect(threadPollMs(true)).toBe(THREAD_POLL_MS);
    expect(THREAD_POLL_MS).toBe(4000);
    expect(threadPollMs(false)).toBe(HIDDEN_POLL_MS);
    expect(threadPollMs(true, false)).toBe(HIDDEN_POLL_MS);
  });

  it('polls the list faster without an open thread and backs off while nothing changes, up to 30 s', () => {
    expect(listPollMs({ visible: true, threadOpen: false, unchanged: 0 })).toBe(4000);
    expect(listPollMs({ visible: true, threadOpen: true, unchanged: 0 })).toBe(8000);
    expect(listPollMs({ visible: true, threadOpen: false, unchanged: 3 })).toBe(8000);
    expect(listPollMs({ visible: true, threadOpen: false, unchanged: 6 })).toBe(16000);
    expect(listPollMs({ visible: true, threadOpen: false, unchanged: 60 })).toBe(30000);
    expect(listPollMs({ visible: false, threadOpen: false, unchanged: 0 })).toBe(HIDDEN_POLL_MS);
  });
});

describe('reply-time (SLA) timer', () => {
  it('runs while the customer waits for a person, not for bot chats, closed chats or after our reply', () => {
    const c = (status: string, direction: string | null) => ({ status, lastMessage: direction ? { direction } : null, lastMessageAt: '2026-10-25T10:00:00Z' });
    expect(waitingSince(c('open', 'inbound'))).toBe('2026-10-25T10:00:00Z');
    expect(waitingSince(c('handoff', 'inbound'))).toBe('2026-10-25T10:00:00Z');
    expect(waitingSince(c('open', 'outbound'))).toBeNull();
    expect(waitingSince(c('bot', 'inbound'))).toBeNull();
    expect(waitingSince(c('closed', 'inbound'))).toBeNull();
    expect(waitingSince(c('open', null))).toBeNull();
  });

  it('turns amber after 5 minutes and red after 15', () => {
    expect(slaTone(4 * 60_000)).toBe('ok');
    expect(slaTone(5 * 60_000)).toBe('warn');
    expect(slaTone(15 * 60_000)).toBe('danger');
  });
});

describe('thread', () => {
  it('merges messages and notes by time with one separator per day in the restaurant time zone', () => {
    // 21:30 UTC on the 24th is 00:30 on the 25th in Riyadh (UTC+3): a new day there, the same day in UTC.
    const messages = [
      { id: 'm1', createdAt: '2026-10-24T08:00:00Z' },
      { id: 'm2', createdAt: '2026-10-24T21:30:00Z' },
    ];
    const notes = [{ id: 'n1', createdAt: '2026-10-24T09:00:00Z' }];
    const out = threadEntries(messages, notes, 'Asia/Riyadh');
    expect(out.map((e) => e.key)).toEqual(['d:2026-10-24', 'm:m1', 'n:n1', 'd:2026-10-25', 'm:m2']);
    expect(threadEntries(messages, notes, 'UTC').map((e) => e.key)).toEqual(['d:2026-10-24', 'm:m1', 'n:n1', 'm:m2']);
  });

  it('labels today and yesterday, other days get a date', () => {
    const now = Date.parse('2026-10-25T12:00:00Z');
    expect(relativeDay('2026-10-25T01:00:00Z', 'UTC', now)).toBe('today');
    expect(relativeDay('2026-10-24T23:00:00Z', 'UTC', now)).toBe('yesterday');
    expect(relativeDay('2026-10-20T23:00:00Z', 'UTC', now)).toBeNull();
  });
});

describe('saved replies (the "/" picker)', () => {
  const replies = [
    { id: '1', title: 'Opening hours', shortcut: 'hours', bodyEn: 'We open at 9.', bodyAr: 'نفتح الساعة 9.' },
    { id: '2', title: 'Parking', shortcut: 'park', bodyEn: 'Free parking at the back.', bodyAr: null },
    { id: '3', title: 'Delivery areas', shortcut: null, bodyEn: null, bodyAr: 'نوصل إلى الزمالك والمعادي.' },
  ];

  it('opens on "/" at the start or after a space, not inside a word or a link', () => {
    expect(slashQuery('/', 1)).toEqual({ start: 0, query: '' });
    expect(slashQuery('hi /ho', 6)).toEqual({ start: 3, query: 'ho' });
    expect(slashQuery('and/or', 6)).toBeNull();
    expect(slashQuery('see https://x.y/z', 17)).toBeNull();
    expect(slashQuery('/hours now', 10)).toBeNull();
  });

  it('ranks shortcut prefixes, then titles, then body text; Arabic text matches too', () => {
    expect(matchSavedReplies(replies, '').map((r) => r.id)).toEqual(['1', '2', '3']);
    expect(matchSavedReplies(replies, 'pa').map((r) => r.id)).toEqual(['2']);
    expect(matchSavedReplies(replies, 'h').map((r) => r.id)).toEqual(['1']);
    expect(matchSavedReplies(replies, 'areas').map((r) => r.id)).toEqual(['3']);
    expect(matchSavedReplies(replies, 'المعادي').map((r) => r.id)).toEqual(['3']);
    expect(matchSavedReplies(replies, 'zzz')).toEqual([]);
  });

  it('inserts the reply in the conversation language (falling back to the other one), replacing the "/query"', () => {
    expect(replyBody(replies[0]!, 'ar')).toBe('نفتح الساعة 9.');
    expect(replyBody(replies[1]!, 'ar')).toBe('Free parking at the back.');
    expect(replyBody(replies[2]!, 'en')).toBe('نوصل إلى الزمالك والمعادي.');
    expect(insertReply('Hi! /ho', 7, 'We open at 9.', slashQuery('Hi! /ho', 7))).toEqual({ text: 'Hi! We open at 9.', caret: 17 });
    expect(insertReply('ab', 1, 'X', null)).toEqual({ text: 'aXb', caret: 2 });
  });

  it('puts a link on its own with spaces around it', () => {
    expect(insertSnippet('Order here', 10, 'https://r.example/o')).toEqual({ text: 'Order here https://r.example/o', caret: 30 });
    expect(insertSnippet('', 0, 'https://x')).toEqual({ text: 'https://x', caret: 9 });
    expect(insertSnippet('a b', 1, 'L').text).toBe('a L b');
  });
});

describe('virtualised list', () => {
  it('renders only the rows in view plus a margin, with spacers for the rest', () => {
    const w = virtualWindow(880, 440, 1000, 88, 2);
    expect(w).toEqual({ start: 8, end: 17, before: 704, after: (1000 - 17) * 88 });
    expect(virtualWindow(0, 0, 3, 88)).toEqual({ start: 0, end: 3, before: 0, after: 0 });
  });

  it('scrolls just enough to show a row', () => {
    expect(scrollToRow(0, 440, 2, 88)).toBe(0);
    expect(scrollToRow(0, 440, 10, 88)).toBe(10 * 88 + 88 - 440);
    expect(scrollToRow(880, 440, 3, 88)).toBe(264);
  });
});
