import { describe, expect, it } from 'vitest';
import {
  conversationTagInput, conversationTagUpdate, CUSTOMER_360_LIMITS, INTERNAL_NOTE_MAX, internalNoteInput, savedReplyInput, savedReplyListQuery,
  savedReplyUpdate,
} from './inbox';
import { inboxConversationFilters } from './connect';

// 21-INBOX contracts: what the API accepts for notes, tags and saved replies.
describe('internal notes', () => {
  it('need a non-empty body up to the limit and an idempotency key, and nothing else', () => {
    expect(internalNoteInput.parse({ body: '  call back at 5  ', key: 'note-key-1' }).body).toBe('call back at 5');
    expect(internalNoteInput.safeParse({ body: '   ', key: 'note-key-1' }).success).toBe(false);
    expect(internalNoteInput.safeParse({ body: 'x'.repeat(INTERNAL_NOTE_MAX + 1), key: 'note-key-1' }).success).toBe(false);
    expect(internalNoteInput.safeParse({ body: 'x' }).success).toBe(false);
    // A client cannot ask for a note to be sent or treated as a message.
    expect(internalNoteInput.safeParse({ body: 'x', key: 'note-key-1', direction: 'outbound' }).success).toBe(false);
  });
});

describe('conversation tags', () => {
  it('accept names in any script with simple punctuation, refuse markup and unknown colours', () => {
    expect(conversationTagInput.parse({ name: ' VIP ' })).toEqual({ name: 'VIP', color: 'neutral' });
    expect(conversationTagInput.parse({ name: 'شكوى', color: 'red' }).name).toBe('شكوى');
    expect(conversationTagInput.safeParse({ name: 'Late #2 / delivery' }).success).toBe(true);
    expect(conversationTagInput.safeParse({ name: '<script>' }).success).toBe(false);
    expect(conversationTagInput.safeParse({ name: 'x'.repeat(41) }).success).toBe(false);
    expect(conversationTagInput.safeParse({ name: 'x', color: 'chartreuse' }).success).toBe(false);
    expect(conversationTagUpdate.safeParse({}).success).toBe(false);
  });

  it('filter the conversation list by a tag id', () => {
    expect(inboxConversationFilters.parse({ tagId: '7f1d8f8e-6a3c-4b7a-9a59-0b8c7e9d1a22' }).tagId).toBeDefined();
    expect(inboxConversationFilters.safeParse({ tagId: 'vip' }).success).toBe(false);
  });

  it('filter the conversation list by a workspace view (leads, ordering)', () => {
    expect(inboxConversationFilters.parse({ view: 'leads' }).view).toBe('leads');
    expect(inboxConversationFilters.parse({ view: 'ordering' }).view).toBe('ordering');
    expect(inboxConversationFilters.parse({}).view).toBeUndefined();
    expect(inboxConversationFilters.safeParse({ view: 'vip' }).success).toBe(false);
    expect(inboxConversationFilters.safeParse({ view: '' }).success).toBe(false);
  });
});

describe('saved replies', () => {
  it('need a body in English or Arabic; shortcuts are lowercased slugs without the slash', () => {
    expect(savedReplyInput.parse({ title: 'Hours', shortcut: 'Hours', bodyAr: 'نفتح ٩ صباحًا' }).shortcut).toBe('hours');
    expect(savedReplyInput.safeParse({ title: 'Hours' }).success).toBe(false);
    expect(savedReplyInput.safeParse({ title: 'Hours', bodyEn: null, bodyAr: null }).success).toBe(false);
    expect(savedReplyInput.safeParse({ title: 'Hours', shortcut: '/hours', bodyEn: 'x' }).success).toBe(false);
    expect(savedReplyInput.safeParse({ title: 'Hours', shortcut: 'two words', bodyEn: 'x' }).success).toBe(false);
    expect(savedReplyInput.safeParse({ title: 'Hours', bodyEn: 'x', orgId: 'x' }).success).toBe(false);
    expect(savedReplyUpdate.safeParse({}).success).toBe(false);
    expect(savedReplyUpdate.parse({ bodyEn: null })).toEqual({ bodyEn: null });
    expect(savedReplyListQuery.parse({ shortcut: 'HOURS' }).shortcut).toBe('hours');
  });
});

describe('Customer 360 limits', () => {
  it('bound every list', () => {
    for (const v of Object.values(CUSTOMER_360_LIMITS)) expect(v).toBeLessThanOrEqual(50);
  });
});
