// 21-INT WhatsApp official stepper (plan §6.9): the library templates go through the existing template API, "Send a
// test template to my phone" sends through the outbound queue (sandbox adapter here: nothing reaches Meta), the live
// inbound check sees the reply, and staff routing assigns new conversations. Negative authorization included.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WHATSAPP_TEMPLATE_LIBRARY } from '@resuto/contracts';
import { inbound, sandboxChannel } from './growth-helpers';
import { addMember, auth, bootTestApp, createTenant, sql, type TestApp, type TestTenant } from './helpers';

let t: TestApp;
let tenant: TestTenant;
let channelId: string;
let seq = 3000;
const phone = () => `+2010077${String(++seq).padStart(5, '0')}`;
const api = (tn: TestTenant, p: string) => `/v1/o/${tn.orgId}/connect${p}`;

beforeAll(async () => {
  t = await bootTestApp();
  tenant = await createTenant(t);
  channelId = (await sandboxChannel(t, tenant)).id;
});
afterAll(async () => { await t.close(); });

async function addLibraryTemplate(tn: TestTenant, name: string, language: 'en' | 'ar') {
  const lib = WHATSAPP_TEMPLATE_LIBRARY.find((x) => x.name === name && x.language === language)!;
  const created = await t.http.post(api(tn, '/templates')).set(auth(tn.owner)).send(lib);
  expect(created.status).toBe(201);
  // No live WhatsApp connection: the existing submit marks it a sandbox template (never reviewed by Meta).
  const submitted = await t.http.post(api(tn, `/templates/${created.body.id}/submit`)).set(auth(tn.owner)).send({});
  expect(submitted.body.providerStatus).toBe('sandbox');
  return created.body.id as string;
}

describe('send a test template to my phone', () => {
  it('refuses until the test template exists, then delivers it through the sandbox adapter', async () => {
    const to = phone();
    const early = await t.http.post(api(tenant, `/channels/${channelId}/test-template`)).set(auth(tenant.owner)).send({ phone: to, language: 'en' });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('test_template_not_approved');

    await addLibraryTemplate(tenant, 'resuto_connection_test', 'en');
    const sent = await t.http.post(api(tenant, `/channels/${channelId}/test-template`)).set(auth(tenant.owner)).send({ phone: to, language: 'en' });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ sandbox: true, status: 'delivered', templateName: 'resuto_connection_test', language: 'en' });
    const [m] = await sql(`select m.kind, m.status, m.body, m.payload, m.provider_message_id, m.sent_by, c.external_contact, c.channel_id
      from messages m join conversations c on c.id = m.conversation_id where m.id = $1`, [sent.body.messageId]);
    expect(m).toMatchObject({ kind: 'template', status: 'delivered', external_contact: to.slice(1), channel_id: channelId, sent_by: tenant.owner.userId });
    expect(m.provider_message_id).toMatch(/^sandbox\./);
    expect(m.payload).toMatchObject({ type: 'template', templateName: 'resuto_connection_test', sandbox: true, reason: 'system_connection_test' });
    expect(m.body).toContain('is connected to Resuto');
    const [audit] = await sql(`select action from audit_logs where org_id = $1 and action = 'connect.test_template_sent'`, [tenant.orgId]);
    expect(audit).toBeTruthy();
  });

  it('validates the phone and the channel, and is limited to connect:manage in the organization', async () => {
    const bad = await t.http.post(api(tenant, `/channels/${channelId}/test-template`)).set(auth(tenant.owner)).send({ phone: '01001234567' });
    expect(bad.status).toBe(400);
    const marketing = await addMember(t, tenant, 'marketing');
    // Marketing can reply in the inbox but not manage channels.
    expect((await t.http.post(api(tenant, `/channels/${channelId}/test-template`)).set(auth(marketing)).send({ phone: phone() })).status).toBe(403);
    expect((await t.http.get(api(tenant, `/channels/${channelId}/inbound-check`)).set(auth(marketing))).status).toBe(403);
    const other = await createTenant(t);
    // Another restaurant's owner: its own org route cannot reach this channel; this org's route hides the org.
    expect((await t.http.post(api(other, `/channels/${channelId}/test-template`)).set(auth(other.owner)).send({ phone: phone() })).status).toBe(404);
    expect((await t.http.post(api(tenant, `/channels/${channelId}/test-template`)).set(auth(other.owner)).send({ phone: phone() })).status).toBe(404);
    expect((await t.http.get(api(other, `/channels/${channelId}/inbound-check`)).set(auth(other.owner))).status).toBe(404);
  });

  it('is rate limited per restaurant', async () => {
    const tn = await createTenant(t);
    const ch = (await sandboxChannel(t, tn)).id;
    await addLibraryTemplate(tn, 'resuto_connection_test', 'en');
    for (let i = 0; i < 10; i++) {
      expect((await t.http.post(api(tn, `/channels/${ch}/test-template`)).set(auth(tn.owner)).send({ phone: phone(), language: 'en' })).status).toBe(200);
    }
    const limited = await t.http.post(api(tn, `/channels/${ch}/test-template`)).set(auth(tn.owner)).send({ phone: phone(), language: 'en' });
    expect(limited.status).toBe(429);
  });
});

describe('live inbound check', () => {
  it('waits for a message after the check started, then reports it', async () => {
    const since = new Date(Date.now() - 1000).toISOString();
    const before = await t.http.get(api(tenant, `/channels/${channelId}/inbound-check`)).query({ since }).set(auth(tenant.owner));
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ channelId, sandbox: true, received: false, inboundSince: 0, verified: null, webhookSubscribed: null });
    await inbound(t, tenant, channelId, phone(), { text: 'hello', name: 'Owner phone' });
    const after = await t.http.get(api(tenant, `/channels/${channelId}/inbound-check`)).query({ since }).set(auth(tenant.owner));
    expect(after.body).toMatchObject({ received: true, inboundSince: 1 });
    expect(Date.parse(after.body.lastInboundAt)).toBeGreaterThan(Date.parse(since));
    expect((await t.http.get(api(tenant, `/channels/${channelId}/inbound-check`)).query({ since: 'yesterday' }).set(auth(tenant.owner))).status).toBe(400);
  });
});

describe('staff routing', () => {
  it('manual by default; round robin assigns new conversations to the least recently assigned member who can reply', async () => {
    const tn = await createTenant(t);
    const ch = (await sandboxChannel(t, tn, { orderingEnabled: false })).id;
    const manual = await inbound(t, tn, ch, phone(), { text: 'hi' });
    expect((await sql(`select assigned_to from conversations where id = $1`, [manual.conversationId]))[0].assigned_to).toBeNull();

    const patched = await t.http.patch(api(tn, `/channels/${ch}`)).set(auth(tn.owner)).send({ routing: 'round_robin' });
    expect(patched.status).toBe(200);
    expect(patched.body.routing).toBe('round_robin');
    expect((await t.http.patch(api(tn, `/channels/${ch}`)).set(auth(tn.owner)).send({ routing: 'random' })).status).toBe(400);
    const marketing = await addMember(t, tn, 'marketing');
    await addMember(t, tn, 'kitchen'); // cannot reply: never routed to
    const owners = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const c = await inbound(t, tn, ch, phone(), { text: `hello ${i}` });
      owners.add((await sql(`select assigned_to from conversations where id = $1`, [c.conversationId]))[0].assigned_to);
    }
    expect([...owners].sort()).toEqual([tn.owner.userId, marketing.userId].sort());
    // A returning customer keeps their conversation's assignee (only new conversations are routed).
    const again = await inbound(t, tn, ch, phone(), { text: 'first' });
    const assignee = (await sql(`select assigned_to from conversations where id = $1`, [again.conversationId]))[0].assigned_to;
    const contact = (await sql(`select external_contact from conversations where id = $1`, [again.conversationId]))[0].external_contact;
    await inbound(t, tn, ch, `+${contact}`, { text: 'second' });
    expect((await sql(`select assigned_to from conversations where id = $1`, [again.conversationId]))[0].assigned_to).toBe(assignee);
  });

  it('by branch prefers the members assigned to the channel\'s branch', async () => {
    const tn = await createTenant(t);
    const ch = (await sandboxChannel(t, tn, { orderingEnabled: false, branchId: tn.branchId })).id;
    expect((await t.http.patch(api(tn, `/channels/${ch}`)).set(auth(tn.owner)).send({ routing: 'by_branch' })).body.routing).toBe('by_branch');
    const local = await addMember(t, tn, 'marketing', [tn.branchId]);
    for (let i = 0; i < 3; i++) {
      const c = await inbound(t, tn, ch, phone(), { text: `branch ${i}` });
      expect((await sql(`select assigned_to from conversations where id = $1`, [c.conversationId]))[0].assigned_to).toBe(local.userId);
    }
  });
});
