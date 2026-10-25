// 21-INBOX increment 1 (plan §6.5): internal notes, conversation tags and saved replies (Customer 360: customer-360.test.ts).
// - Notes are staff-only: never sent (sender job test on a Cloud API channel), never in the customer thread, and they
//   change neither the unread count, the last inbound time (24-hour window) nor the last message.
// - Every endpoint refuses another restaurant, a role without the permission and (where branch-scoped) another branch.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MessagingService } from '../src/modules/connect/messaging.service';
import { ProviderHttp } from '../src/modules/integrations/provider-http';
import { inbound, sandboxChannel, scriptedFetch } from './growth-helpers';
import { addMember, auth, bootTestApp, createTenant, seedMenu, sql, type SeededMenu, type TestApp, type TestTenant, type TestUser } from './helpers';
import { addBranch, placeOrder } from './insights-fixtures';

let t: TestApp;
let tenant: TestTenant;
let other: TestTenant;
let channelId: string;
let north: string;
let northChannelId: string;
let marketer: TestUser;
let waiter: TestUser;
let mainManager: TestUser;
let phoneSeq = 3000;
const nextPhone = () => `+2010034${String(++phoneSeq).padStart(5, '0')}`;
const conn = (o: TestTenant) => `/v1/o/${o.orgId}/connect`;

beforeAll(async () => {
  t = await bootTestApp();
  tenant = await createTenant(t);
  other = await createTenant(t);
  channelId = (await sandboxChannel(t, tenant)).id;
  north = await addBranch(t, tenant, 'North');
  northChannelId = (await sandboxChannel(t, tenant, { displayName: 'North WhatsApp', branchId: north })).id;
  marketer = await addMember(t, tenant, 'marketing');
  waiter = await addMember(t, tenant, 'waiter');
  mainManager = await addMember(t, tenant, 'manager', [tenant.branchId]);
});
afterAll(async () => { await t.close(); });

const note = (u: TestUser, conversationId: string, body: string, key = `note-${Math.random().toString(36).slice(2)}`) =>
  t.http.post(`${conn(tenant)}/conversations/${conversationId}/notes`).set(auth(u)).send({ body, key });

describe('internal notes', () => {
  it('are staff-only: kept out of the customer thread, the list preview, unread state and the 24-hour window', async () => {
    const from = nextPhone();
    const { conversationId } = await inbound(t, tenant, channelId, from, { text: 'hi', name: 'Nour' });
    const before = (await sql(`select unread_count, last_inbound_at, last_message_at, status, updated_at from conversations where id = $1`, [conversationId]))[0];
    const lastBefore = (await t.http.get(`${conn(tenant)}/conversations?limit=50`).set(auth(tenant.owner))).body.items.find((c: any) => c.id === conversationId).lastMessage;

    const res = await note(tenant.owner, conversationId, 'VIP: allergic to nuts, call before delivery', 'note-key-1');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ conversationId, body: 'VIP: allergic to nuts, call before delivery', authorId: tenant.owner.userId });
    // Same key, same note (a retried request does not add a second one).
    const replay = await note(tenant.owner, conversationId, 'VIP: allergic to nuts, call before delivery', 'note-key-1');
    expect(replay.body.id).toBe(res.body.id);

    const [row] = await sql(`select direction, kind, status, provider_message_id, next_attempt_at, attempts, is_automated, sent_by from messages where id = $1`, [res.body.id]);
    expect(row).toEqual({ direction: 'internal', kind: 'note', status: 'received', provider_message_id: null, next_attempt_at: null, attempts: 0,
      is_automated: false, sent_by: tenant.owner.userId });
    const after = (await sql(`select unread_count, last_inbound_at, last_message_at, status, updated_at from conversations where id = $1`, [conversationId]))[0];
    expect(after).toEqual(before);
    // No outbox event for a note (nothing downstream may react to it as a message).
    expect((await sql(`select count(*)::int as n from outbox_events where payload->>'messageId' = $1`, [res.body.id]))[0].n).toBe(0);

    const detail = await t.http.get(`${conn(tenant)}/conversations/${conversationId}`).set(auth(tenant.owner));
    expect(detail.body.messages.map((m: any) => m.id)).not.toContain(res.body.id);
    expect(detail.body.messages.every((m: any) => m.kind !== 'note')).toBe(true);
    expect(detail.body.notes).toEqual([expect.objectContaining({ id: res.body.id, body: res.body.body, authorId: tenant.owner.userId })]);
    const list = await t.http.get(`${conn(tenant)}/conversations?limit=50`).set(auth(tenant.owner));
    const item = list.body.items.find((c: any) => c.id === conversationId);
    expect(item.lastMessage).toEqual(lastBefore);
    expect(item.unreadCount).toBe(before.unread_count);

    const notes = await t.http.get(`${conn(tenant)}/conversations/${conversationId}/notes`).set(auth(marketer));
    expect(notes.status).toBe(200);
    expect(notes.body.items.map((n: any) => n.id)).toEqual([res.body.id]);
  });

  it('do not open or extend the 24-hour customer-service window', async () => {
    const { conversationId } = await inbound(t, tenant, channelId, nextPhone(), { text: 'hello' });
    await sql(`update conversations set last_inbound_at = now() - interval '25 hours' where id = $1`, [conversationId]);
    expect((await note(tenant.owner, conversationId, 'Customer asked for a refund by phone')).status).toBe(201);
    const detail = await t.http.get(`${conn(tenant)}/conversations/${conversationId}`).set(auth(tenant.owner));
    expect(detail.body.window.open).toBe(false);
    const reply = await t.http.post(`${conn(tenant)}/conversations/${conversationId}/reply`).set(auth(tenant.owner)).send({ text: 'Still there?', key: 'after-note-1' });
    expect(reply.status).toBe(409);
    expect(reply.body.error.code).toBe('outside_window');
  });

  it('are never sent by the sender job (Cloud API channel), while a queued reply next to them is', async () => {
    const PHONE_ID = '106540352299001';
    const c = await t.http.post(`/v1/o/${tenant.orgId}/integrations/connections`).set(auth(tenant.owner))
      .send({ provider: 'whatsapp_cloud', environment: 'live', credentials: { accessToken: 'EAAG-note-test-token' }, config: { phoneNumberId: PHONE_ID, wabaId: '102290129399001' } });
    expect(c.status).toBe(201);
    const [ch] = await sql(`insert into messaging_channels(org_id, kind, transport, connection_id, display_name, phone_number_id, waba_id, status)
                            values ($1, 'whatsapp', 'meta_cloud', $2, 'Live', $3, '102290129399001', 'connected') returning id`, [tenant.orgId, c.body.id, PHONE_ID]);
    const [conv] = await sql(`insert into conversations(org_id, channel_id, external_contact, status, last_inbound_at, unread_count) values ($1, $2, '201007770001', 'open', now(), 2) returning id`,
      [tenant.orgId, ch.id]);
    const n = await note(tenant.owner, conv.id, 'SECRET-NOTE: do not offer the discount again');
    expect(n.status).toBe(201);
    const reply = await t.http.post(`${conn(tenant)}/conversations/${conv.id}/reply`).set(auth(tenant.owner)).send({ text: 'Your order is on its way', key: 'note-sender-reply' });
    expect(reply.status).toBe(201);

    const sender = t.app.get(MessagingService);
    const http = t.app.get(ProviderHttp);
    const original = http.fetch;
    // Unique provider ids: the sender serves every restaurant in the shared test database (messages_provider_idx is
    // unique), so a leftover queued message of another test must not collide with ours.
    let seq = 0;
    const f = scriptedFetch([() => ({ body: { messages: [{ id: `wamid.NOTE-TEST-${Date.now()}-${++seq}` }] } })]);
    http.fetch = f.fetch;
    try {
      // Run until our reply went out (other restaurants' due messages may share a run), then once more with the note
      // still in place: only this channel's calls are ours.
      for (let i = 0; i < 5; i++) {
        await sender.runSender();
        if ((await sql(`select status from messages where id = $1`, [reply.body.messageId]))[0].status === 'sent') break;
      }
      await sender.runSender();
    } finally {
      http.fetch = original;
    }
    const ours = f.calls.filter((call) => call.url.includes(PHONE_ID));
    expect(ours).toHaveLength(1);
    expect(JSON.parse(ours[0]!.body!)).toMatchObject({ to: '201007770001', text: { body: 'Your order is on its way' } });
    expect(f.calls.some((call) => (call.body ?? '').includes('SECRET-NOTE'))).toBe(false);
    expect((await sql(`select status from messages where id = $1`, [reply.body.messageId]))[0].status).toBe('sent');
    const [noteRow] = await sql(`select status, attempts, provider_message_id, next_attempt_at from messages where id = $1`, [n.body.id]);
    expect(noteRow).toEqual({ status: 'received', attempts: 0, provider_message_id: null, next_attempt_at: null });
    // Even a direct attempt to queue the note is refused by the schema, and "resend" does not know it.
    await expect(sql(`update messages set status = 'queued', next_attempt_at = now() where id = $1`, [n.body.id])).rejects.toThrow(/messages_note_internal/);
    await expect(sql(`update messages set direction = 'outbound', status = 'queued' where id = $1`, [n.body.id])).rejects.toThrow(/messages_note_internal/);
    expect((await sender.claimDue(50)).map((m) => m.id)).not.toContain(n.body.id);
    expect((await t.http.post(`${conn(tenant)}/messages/${n.body.id}/resend`).set(auth(tenant.owner))).status).toBe(404);
    // The note left the conversation's unread count and window alone.
    expect((await sql(`select unread_count from conversations where id = $1`, [conv.id]))[0].unread_count).toBe(0); // the reply read it
  });

  it('refuse other restaurants, roles without the permission and other branches; validate input', async () => {
    const { conversationId } = await inbound(t, tenant, channelId, nextPhone(), { text: 'x' });
    const { conversationId: northConv } = await inbound(t, tenant, northChannelId, nextPhone(), { text: 'north' });
    expect((await note(waiter, conversationId, 'x')).status).toBe(403);
    expect((await t.http.get(`${conn(tenant)}/conversations/${conversationId}/notes`).set(auth(waiter))).status).toBe(403);
    expect((await note(marketer, conversationId, 'Marketing can note (connect:reply)')).status).toBe(201);
    expect((await note(other.owner, conversationId, 'x')).status).toBe(404); // not a member of this restaurant
    const viaOwnOrg = await t.http.post(`${conn(other)}/conversations/${conversationId}/notes`).set(auth(other.owner)).send({ body: 'x', key: 'cross-org-1' });
    expect(viaOwnOrg.status).toBe(404);
    expect((await t.http.get(`${conn(other)}/conversations/${conversationId}/notes`).set(auth(other.owner))).status).toBe(404);
    // A manager of the main branch cannot note (or read notes of) a north conversation: it is invisible to them under
    // RLS, so it is a 404 exactly as the conversation itself is.
    expect((await t.http.get(`${conn(tenant)}/conversations/${northConv}`).set(auth(mainManager))).status).toBe(404);
    expect((await note(mainManager, northConv, 'x')).status).toBe(404);
    expect((await t.http.get(`${conn(tenant)}/conversations/${northConv}/notes`).set(auth(mainManager))).status).toBe(404);
    expect((await sql(`select count(*)::int as n from messages where conversation_id = $1 and kind = 'note'`, [northConv]))[0].n).toBe(0);
    expect((await note(mainManager, conversationId, 'main branch note')).status).toBe(201);
    // Validation: empty, too long, unknown fields, missing key.
    expect((await note(tenant.owner, conversationId, '   ')).status).toBe(400);
    expect((await note(tenant.owner, conversationId, 'x'.repeat(4001))).status).toBe(400);
    expect((await t.http.post(`${conn(tenant)}/conversations/${conversationId}/notes`).set(auth(tenant.owner)).send({ body: 'x' })).status).toBe(400);
    expect((await t.http.post(`${conn(tenant)}/conversations/${conversationId}/notes`).set(auth(tenant.owner)).send({ body: 'x', key: 'k-123456', direction: 'outbound' })).status).toBe(400);
    // Module entitlement (Connect).
    const free = await createTenant(t, { planId: 'free' });
    expect((await t.http.get(`${conn(free)}/tags`).set(auth(free.owner))).status).toBe(402);
  });
});

describe('conversation tags', () => {
  it('manage the vocabulary with connect:manage, tag with connect:reply, filter the inbox by tag', async () => {
    const vip = await t.http.post(`${conn(tenant)}/tags`).set(auth(tenant.owner)).send({ name: 'VIP', color: 'amber' });
    expect(vip.status).toBe(201);
    expect(vip.body).toMatchObject({ name: 'VIP', color: 'amber' });
    const dup = await t.http.post(`${conn(tenant)}/tags`).set(auth(tenant.owner)).send({ name: ' vip ' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('tag_name_taken');
    expect((await t.http.post(`${conn(tenant)}/tags`).set(auth(tenant.owner)).send({ name: 'x', color: 'chartreuse' })).status).toBe(400);
    expect((await t.http.post(`${conn(tenant)}/tags`).set(auth(tenant.owner)).send({ name: '<script>' })).status).toBe(400);
    const complaint = await t.http.post(`${conn(tenant)}/tags`).set(auth(tenant.owner)).send({ name: 'شكوى' });
    expect(complaint.status).toBe(201);
    expect(complaint.body.color).toBe('neutral');
    // Marketing (connect:reply) cannot change the vocabulary; waiters cannot even read it.
    expect((await t.http.post(`${conn(tenant)}/tags`).set(auth(marketer)).send({ name: 'Leads' })).status).toBe(403);
    expect((await t.http.patch(`${conn(tenant)}/tags/${vip.body.id}`).set(auth(marketer)).send({ color: 'red' })).status).toBe(403);
    expect((await t.http.delete(`${conn(tenant)}/tags/${vip.body.id}`).set(auth(marketer))).status).toBe(403);
    expect((await t.http.get(`${conn(tenant)}/tags`).set(auth(marketer))).status).toBe(200);
    expect((await t.http.get(`${conn(tenant)}/tags`).set(auth(waiter))).status).toBe(403);

    const a = await inbound(t, tenant, channelId, nextPhone(), { text: 'tag me' });
    const b = await inbound(t, tenant, channelId, nextPhone(), { text: 'not me' });
    const put = await t.http.put(`${conn(tenant)}/conversations/${a.conversationId}/tags/${vip.body.id}`).set(auth(marketer));
    expect(put.status).toBe(200);
    expect(put.body.tags.map((x: any) => x.name)).toEqual(['VIP']);
    // Idempotent.
    expect((await t.http.put(`${conn(tenant)}/conversations/${a.conversationId}/tags/${vip.body.id}`).set(auth(marketer))).body.tags).toHaveLength(1);
    expect((await sql(`select count(*)::int as n from audit_logs where action = 'connect.tag_assigned' and entity_id = $1`, [a.conversationId]))[0].n).toBe(1);

    const filtered = await t.http.get(`${conn(tenant)}/conversations?tagId=${vip.body.id}`).set(auth(tenant.owner));
    expect(filtered.status).toBe(200);
    expect(filtered.body.items.map((c: any) => c.id)).toEqual([a.conversationId]);
    expect(filtered.body.items[0].tags).toEqual([expect.objectContaining({ id: vip.body.id, name: 'VIP', color: 'amber' })]);
    const all = await t.http.get(`${conn(tenant)}/conversations?limit=100`).set(auth(tenant.owner));
    expect(all.body.items.find((c: any) => c.id === b.conversationId).tags).toEqual([]);
    expect((await t.http.get(`${conn(tenant)}/conversations?tagId=not-a-uuid`).set(auth(tenant.owner))).status).toBe(400);
    expect((await t.http.get(`${conn(tenant)}/conversations/${a.conversationId}`).set(auth(tenant.owner))).body.tags.map((x: any) => x.name)).toEqual(['VIP']);

    const renamed = await t.http.patch(`${conn(tenant)}/tags/${vip.body.id}`).set(auth(tenant.owner)).send({ name: 'VVIP' });
    expect(renamed.body.name).toBe('VVIP');
    expect((await t.http.patch(`${conn(tenant)}/tags/${vip.body.id}`).set(auth(tenant.owner)).send({ name: 'شكوى' })).body.error.code).toBe('tag_name_taken');

    const del = await t.http.delete(`${conn(tenant)}/conversations/${a.conversationId}/tags/${vip.body.id}`).set(auth(marketer));
    expect(del.status).toBe(200);
    expect(del.body.tags).toEqual([]);
    await t.http.put(`${conn(tenant)}/conversations/${a.conversationId}/tags/${complaint.body.id}`).set(auth(marketer)).expect(200);
    // Deleting a tag removes it from every conversation.
    expect((await t.http.delete(`${conn(tenant)}/tags/${complaint.body.id}`).set(auth(tenant.owner))).status).toBe(200);
    expect((await sql(`select count(*)::int as n from conversation_tag_assignments where tag_id = $1`, [complaint.body.id]))[0].n).toBe(0);
    expect((await t.http.delete(`${conn(tenant)}/tags/${complaint.body.id}`).set(auth(tenant.owner))).status).toBe(404);
  });

  it('refuse another restaurant\'s tags and conversations, other branches, and too many tags', async () => {
    const mine = (await t.http.post(`${conn(tenant)}/tags`).set(auth(tenant.owner)).send({ name: 'Mine' })).body;
    const theirs = (await t.http.post(`${conn(other)}/tags`).set(auth(other.owner)).send({ name: 'Theirs' })).body;
    const { conversationId } = await inbound(t, tenant, channelId, nextPhone(), { text: 'x' });
    const { conversationId: northConv } = await inbound(t, tenant, northChannelId, nextPhone(), { text: 'north' });
    // Another restaurant's tag on my conversation, my tag through their path, their owner on my routes.
    expect((await t.http.put(`${conn(tenant)}/conversations/${conversationId}/tags/${theirs.id}`).set(auth(tenant.owner))).status).toBe(404);
    expect((await t.http.put(`${conn(other)}/conversations/${conversationId}/tags/${theirs.id}`).set(auth(other.owner))).status).toBe(404);
    expect((await t.http.patch(`${conn(other)}/tags/${mine.id}`).set(auth(other.owner)).send({ name: 'pwned' })).status).toBe(404);
    expect((await t.http.delete(`${conn(other)}/tags/${mine.id}`).set(auth(other.owner))).status).toBe(404);
    expect((await t.http.get(`${conn(tenant)}/tags`).set(auth(other.owner))).status).toBe(404);
    expect((await t.http.get(`${conn(other)}/tags`).set(auth(other.owner))).body.items.map((x: any) => x.name)).toEqual(['Theirs']);
    expect((await t.http.get(`${conn(tenant)}/conversations?tagId=${theirs.id}`).set(auth(tenant.owner))).body.items).toEqual([]);
    // Branch scope: a main-branch manager cannot tag (or untag) a north conversation (invisible to them: 404).
    expect((await t.http.put(`${conn(tenant)}/conversations/${northConv}/tags/${mine.id}`).set(auth(mainManager))).status).toBe(404);
    expect((await t.http.delete(`${conn(tenant)}/conversations/${northConv}/tags/${mine.id}`).set(auth(mainManager))).status).toBe(404);
    expect((await t.http.put(`${conn(tenant)}/conversations/${conversationId}/tags/${mine.id}`).set(auth(mainManager))).status).toBe(200);
    await t.http.put(`${conn(tenant)}/conversations/${northConv}/tags/${mine.id}`).set(auth(tenant.owner)).expect(200);
    expect((await t.http.get(`${conn(tenant)}/conversations?tagId=${mine.id}`).set(auth(mainManager))).body.items.map((c: any) => c.id)).toEqual([conversationId]);
    // At most ten tags per conversation.
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push((await t.http.post(`${conn(tenant)}/tags`).set(auth(tenant.owner)).send({ name: `Bulk ${i}` })).body.id);
    for (const id of ids.slice(0, 9)) await t.http.put(`${conn(tenant)}/conversations/${conversationId}/tags/${id}`).set(auth(tenant.owner)).expect(200);
    const over = await t.http.put(`${conn(tenant)}/conversations/${conversationId}/tags/${ids[9]}`).set(auth(tenant.owner));
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('tag_limit_reached');
  });
});

describe('saved replies', () => {
  it('CRUD with connect:manage; organization-wide and per-branch; one shortcut per scope; search', async () => {
    const hours = await t.http.post(`${conn(tenant)}/saved-replies`).set(auth(tenant.owner))
      .send({ title: 'Opening hours', shortcut: 'Hours', bodyEn: 'We open 9am to 1am.', bodyAr: 'نفتح من ٩ صباحًا حتى ١ صباحًا.' });
    expect(hours.status).toBe(201);
    expect(hours.body).toMatchObject({ shortcut: 'hours', branchId: null, bodyEn: 'We open 9am to 1am.' });
    const dup = await t.http.post(`${conn(tenant)}/saved-replies`).set(auth(tenant.owner)).send({ title: 'Again', shortcut: 'hours', bodyEn: 'x' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('shortcut_taken');
    // The same shortcut is fine in a branch's own scope.
    const northHours = await t.http.post(`${conn(tenant)}/saved-replies`).set(auth(tenant.owner)).send({ title: 'North hours', shortcut: 'hours', bodyAr: 'فرع الشمال يفتح ١٠ صباحًا', branchId: north });
    expect(northHours.status).toBe(201);
    expect((await t.http.post(`${conn(tenant)}/saved-replies`).set(auth(tenant.owner)).send({ title: 'Empty' })).status).toBe(400);
    expect((await t.http.post(`${conn(tenant)}/saved-replies`).set(auth(tenant.owner)).send({ title: 'Bad', shortcut: '/x y', bodyEn: 'x' })).status).toBe(400);
    const unknown = await t.http.post(`${conn(tenant)}/saved-replies`).set(auth(tenant.owner)).send({ title: 'B', bodyEn: 'x', branchId: other.branchId });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe('unknown_branch');

    expect((await t.http.get(`${conn(tenant)}/saved-replies?shortcut=hours`).set(auth(tenant.owner))).body.items.map((r: any) => r.title)).toEqual(['North hours', 'Opening hours']);
    expect((await t.http.get(`${conn(tenant)}/saved-replies?q=1am`).set(auth(tenant.owner))).body.items.map((r: any) => r.title)).toEqual(['Opening hours']);
    expect((await t.http.get(`${conn(tenant)}/saved-replies?q=%25`).set(auth(tenant.owner))).body.items).toEqual([]); // LIKE wildcards are literal
    expect((await t.http.get(`${conn(tenant)}/saved-replies?branchId=${tenant.branchId}`).set(auth(tenant.owner))).body.items.map((r: any) => r.title)).toEqual(['Opening hours']);

    const upd = await t.http.patch(`${conn(tenant)}/saved-replies/${hours.body.id}`).set(auth(tenant.owner)).send({ bodyEn: null });
    expect(upd.status).toBe(200);
    expect(upd.body).toMatchObject({ bodyEn: null, bodyAr: 'نفتح من ٩ صباحًا حتى ١ صباحًا.' });
    const none = await t.http.patch(`${conn(tenant)}/saved-replies/${hours.body.id}`).set(auth(tenant.owner)).send({ bodyAr: null });
    expect(none.status).toBe(422);
    expect(none.body.error.code).toBe('reply_body_required');
    expect((await t.http.patch(`${conn(tenant)}/saved-replies/${northHours.body.id}`).set(auth(tenant.owner)).send({ branchId: null })).body.error.code).toBe('shortcut_taken');

    // Roles: marketing and waiters read (marketing) or nothing (waiter); only connect:manage writes.
    expect((await t.http.get(`${conn(tenant)}/saved-replies`).set(auth(marketer))).status).toBe(200);
    expect((await t.http.get(`${conn(tenant)}/saved-replies`).set(auth(waiter))).status).toBe(403);
    expect((await t.http.post(`${conn(tenant)}/saved-replies`).set(auth(marketer)).send({ title: 'M', bodyEn: 'x' })).status).toBe(403);
    expect((await t.http.patch(`${conn(tenant)}/saved-replies/${hours.body.id}`).set(auth(marketer)).send({ title: 'M' })).status).toBe(403);
    expect((await t.http.delete(`${conn(tenant)}/saved-replies/${hours.body.id}`).set(auth(marketer))).status).toBe(403);

    // Another restaurant sees and changes nothing.
    expect((await t.http.get(`${conn(tenant)}/saved-replies`).set(auth(other.owner))).status).toBe(404);
    expect((await t.http.get(`${conn(other)}/saved-replies`).set(auth(other.owner))).body.items).toEqual([]);
    expect((await t.http.patch(`${conn(other)}/saved-replies/${hours.body.id}`).set(auth(other.owner)).send({ title: 'pwned' })).status).toBe(404);
    expect((await t.http.delete(`${conn(other)}/saved-replies/${hours.body.id}`).set(auth(other.owner))).status).toBe(404);

    expect((await t.http.delete(`${conn(tenant)}/saved-replies/${northHours.body.id}`).set(auth(tenant.owner))).status).toBe(200);
    expect((await t.http.get(`${conn(tenant)}/saved-replies?shortcut=hours`).set(auth(tenant.owner))).body.items).toHaveLength(1);
  });

  it('branch-scoped managers see organization-wide and own-branch replies and write only their own branch\'s', async () => {
    const orgWide = (await t.http.post(`${conn(tenant)}/saved-replies`).set(auth(tenant.owner)).send({ title: 'Wifi', bodyEn: 'Password is on the menu' })).body;
    const northOnly = (await t.http.post(`${conn(tenant)}/saved-replies`).set(auth(tenant.owner)).send({ title: 'North parking', bodyEn: 'Behind the mall', branchId: north })).body;
    const listed = await t.http.get(`${conn(tenant)}/saved-replies?limit=200`).set(auth(mainManager));
    const titles = listed.body.items.map((r: any) => r.title);
    expect(titles).toContain('Wifi');
    expect(titles).not.toContain('North parking');
    expect((await t.http.get(`${conn(tenant)}/saved-replies?branchId=${north}`).set(auth(mainManager))).status).toBe(403);
    // Cannot create one for every branch or for another branch; can for their own.
    expect((await t.http.post(`${conn(tenant)}/saved-replies`).set(auth(mainManager)).send({ title: 'All', bodyEn: 'x' })).status).toBe(403);
    expect((await t.http.post(`${conn(tenant)}/saved-replies`).set(auth(mainManager)).send({ title: 'N', bodyEn: 'x', branchId: north })).status).toBe(403);
    const own = await t.http.post(`${conn(tenant)}/saved-replies`).set(auth(mainManager)).send({ title: 'Main parking', bodyEn: 'Front door', branchId: tenant.branchId });
    expect(own.status).toBe(201);
    // Cannot change the organization-wide reply, cannot see the other branch's at all, cannot move theirs to every branch.
    expect((await t.http.patch(`${conn(tenant)}/saved-replies/${orgWide.id}`).set(auth(mainManager)).send({ title: 'x' })).status).toBe(403);
    expect((await t.http.delete(`${conn(tenant)}/saved-replies/${orgWide.id}`).set(auth(mainManager))).status).toBe(403);
    expect((await t.http.patch(`${conn(tenant)}/saved-replies/${northOnly.id}`).set(auth(mainManager)).send({ title: 'x' })).status).toBe(404);
    expect((await t.http.delete(`${conn(tenant)}/saved-replies/${northOnly.id}`).set(auth(mainManager))).status).toBe(404);
    expect((await t.http.patch(`${conn(tenant)}/saved-replies/${own.body.id}`).set(auth(mainManager)).send({ branchId: null })).status).toBe(403);
    expect((await t.http.patch(`${conn(tenant)}/saved-replies/${own.body.id}`).set(auth(mainManager)).send({ branchId: north })).status).toBe(403);
    expect((await t.http.patch(`${conn(tenant)}/saved-replies/${own.body.id}`).set(auth(mainManager)).send({ title: 'Main parking (front)' })).status).toBe(200);
  });
});

describe('workspace views (increment 2): leads and ordering', () => {
  let menu: SeededMenu;
  const list = (u: TestUser, query: string, o: TestTenant = tenant) => t.http.get(`${conn(o)}/conversations?limit=200&${query}`).set(auth(u));
  const ids = (res: { body: { items: Array<{ id: string }> } }) => res.body.items.map((c) => c.id);
  const item = (res: { body: { items: any[] } }, id: string) => res.body.items.find((c) => c.id === id);
  beforeAll(async () => { menu = await seedMenu(tenant); });

  it('ordering lists conversations with a live ordering session, and each item names its step', async () => {
    const ordering = await inbound(t, tenant, channelId, nextPhone(), { text: 'order', name: 'Salma' });
    const chatting = await inbound(t, tenant, channelId, nextPhone(), { text: 'Do you open on Friday?' });
    const res = await list(tenant.owner, 'view=ordering');
    expect(res.status).toBe(200);
    expect(ids(res)).toContain(ordering.conversationId);
    expect(ids(res)).not.toContain(chatting.conversationId);
    expect(item(res, ordering.conversationId).orderingStep).toEqual(expect.any(String));
    expect(['completed', 'cancelled', 'expired']).not.toContain(item(res, ordering.conversationId).orderingStep);
    expect(item(await list(tenant.owner, ''), chatting.conversationId)).toMatchObject({ orderingStep: null, branchId: null });
    // A cancelled session leaves the view.
    await t.http.post(`${conn(tenant)}/conversations/${ordering.conversationId}/ordering/cancel`).set(auth(tenant.owner)).expect(200);
    expect(ids(await list(tenant.owner, 'view=ordering'))).not.toContain(ordering.conversationId);
    expect(item(await list(tenant.owner, ''), ordering.conversationId).orderingStep).toBeNull();
  });

  it('leads are contacts without a counted order in the caller\'s branch scope; an order makes them a customer', async () => {
    const phone = nextPhone();
    const { conversationId } = await inbound(t, tenant, channelId, phone, { text: 'Price of the family meal?', name: 'Karim' });
    let res = await list(tenant.owner, 'view=leads');
    expect(ids(res)).toContain(conversationId);
    expect(item(res, conversationId).lead).toBe(true);
    await placeOrder(t, tenant, { branchId: north, channel: 'web', fulfillment: 'pickup', lines: [{ productId: menu.products.fries, quantity: 1 }], customer: { phone } });
    res = await list(tenant.owner, 'view=leads');
    expect(ids(res)).not.toContain(conversationId);
    expect(item(await list(tenant.owner, ''), conversationId).lead).toBe(false);
    // The order was at North: for a manager of the main branch the contact has not ordered yet (their branches only).
    const scoped = await list(mainManager, 'view=leads');
    expect(scoped.status).toBe(200);
    expect(ids(scoped)).toContain(conversationId);
    // A cancelled order does not count.
    await sql(`update orders set status = 'cancelled' where customer_id = (select customer_id from conversations where id = $1)`, [conversationId]);
    expect(ids(await list(tenant.owner, 'view=leads'))).toContain(conversationId);
  });

  it('refuse roles without connect:read, other restaurants and unknown views; branch scope still applies', async () => {
    const { conversationId: northConv } = await inbound(t, tenant, northChannelId, nextPhone(), { text: 'order' });
    expect((await list(waiter, 'view=leads')).status).toBe(403);
    expect((await list(waiter, 'view=ordering')).status).toBe(403);
    expect((await list(other.owner, 'view=ordering')).status).toBe(404); // not a member of this restaurant
    const own = await list(other.owner, 'view=ordering', other);
    expect(own.status).toBe(200);
    expect(ids(own)).not.toContain(northConv);
    expect((await list(tenant.owner, 'view=vip')).status).toBe(400);
    expect((await list(tenant.owner, 'view=')).status).toBe(400);
    // North's ordering conversation is invisible to a manager of the main branch, in every view.
    expect(ids(await list(tenant.owner, 'view=ordering'))).toContain(northConv);
    for (const q of ['view=ordering', 'view=leads', '']) expect(ids(await list(mainManager, q))).not.toContain(northConv);
    expect(item(await list(tenant.owner, ''), northConv).branchId).toBe(north);
  });
});
