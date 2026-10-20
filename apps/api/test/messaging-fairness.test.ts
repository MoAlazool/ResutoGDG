// WhatsApp sender reliability and campaign dispatch (PCL-11, PCL-12):
// - the sender claims per organization (transactional first), so one tenant's campaign cannot starve others;
// - an unusable credential fails the message once (it used to retry every 2 minutes forever);
// - retries honour Retry-After and are jittered;
// - campaigns are dispatched in chunks of one transaction each; resumed or concurrent runs never message anyone twice.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { whatsappCloudAdapter } from '@resuto/integrations';
import { DbService } from '../src/common/db/db.service';
import { CAMPAIGN_CHUNK, CampaignsService } from '../src/modules/marketing/campaigns.service';
import { MessagingService, retryDelayMs } from '../src/modules/connect/messaging.service';
import { IntegrationConnectionsService } from '../src/modules/integrations/connections.service';
import { auth, bootTestApp, createTenant, sql, type TestApp, type TestTenant } from './helpers';

let t: TestApp;
let a: TestTenant;
let b: TestTenant;

beforeAll(async () => {
  t = await bootTestApp();
  a = await createTenant(t);
  b = await createTenant(t);
});
afterAll(async () => { await t.close(); });

/** A Cloud API channel with a connection whose stored credentials cannot be decrypted. */
async function cloudConversation(tenant: TestTenant, contact: string) {
  const [conn] = await sql(
    `insert into integration_connections(org_id, provider, category, auth_type, environment, status, enabled, credentials_encrypted)
     values ($1, 'whatsapp_cloud', 'messaging', 'api_key', 'live', 'connected', true, 'v1:not-a-real-ciphertext') returning id`, [tenant.orgId]);
  const [ch] = await sql(
    `insert into messaging_channels(org_id, kind, transport, connection_id, display_name, phone_number_id, status)
     values ($1, 'whatsapp', 'meta_cloud', $2, 'Cloud', $3, 'connected') returning id`, [tenant.orgId, conn.id, `pn-${contact}`]);
  const [conv] = await sql(
    `insert into conversations(org_id, channel_id, external_contact, status, last_inbound_at) values ($1, $2, $3, 'open', now()) returning id`,
    [tenant.orgId, ch.id, contact]);
  return { connectionId: conn.id as string, conversationId: conv.id as string };
}
async function queue(tenant: TestTenant, conversationId: string, n: number, priority: number, reason: string) {
  await sql(
    `insert into messages(org_id, conversation_id, direction, kind, body, payload, status, next_attempt_at, priority)
     select $1, $2, 'outbound', 'text', 'hi', jsonb_build_object('type', 'text', 'body', 'hi', 'reason', $4::text), 'queued', now() - g * interval '1 second', $3
       from generate_series(1, $5) g`, [tenant.orgId, conversationId, priority, reason, n]);
}

describe('sender fairness and retries (PCL-12)', () => {
  it('claims at most N per organization per run, transactional before marketing', async () => {
    const ca = await cloudConversation(a, '201000000901');
    const cb = await cloudConversation(b, '201000000902');
    await queue(a, ca.conversationId, 60, 1, 'campaign:x'); // a large campaign, queued earlier
    await queue(a, ca.conversationId, 2, 0, 'order.ready');
    await queue(b, cb.conversationId, 1, 0, 'order.ready');
    const sender = t.app.get(MessagingService);
    const claimed = await sender.claimDue(50, 10);
    const ids = claimed.map((c) => c.id);
    const rows = await sql(`select id, org_id, priority from messages where id = any($1::uuid[])`, [ids]);
    expect(rows.filter((r: any) => r.org_id === a.orgId)).toHaveLength(10);
    expect(rows.filter((r: any) => r.org_id === b.orgId)).toHaveLength(1);
    expect(rows.filter((r: any) => r.org_id === a.orgId && r.priority === 0)).toHaveLength(2);
    // A second worker in the same instant claims none of the leased messages.
    const second = await sender.claimDue(50, 10);
    expect(second.map((c) => c.id).filter((id) => ids.includes(id))).toEqual([]);
    await sql(`delete from messages where id = any($1::uuid[]) or id = any($2::uuid[])`, [ids, second.map((c) => c.id)]);
  });

  it('fails a message whose connection credentials cannot be used, once, and logs it on the connection', async () => {
    await sql(`delete from messages where org_id = $1 and status = 'queued'`, [a.orgId]);
    const [conv] = await sql(`select c.id, ch.connection_id from conversations c join messaging_channels ch on ch.id = c.channel_id where c.org_id = $1`, [a.orgId]);
    await queue(a, conv.id, 1, 0, 'order.ready');
    const sender = t.app.get(MessagingService);
    const r = await sender.runSender(50, 10);
    expect(r).toMatchObject({ failed: 1, retried: 0 });
    const [m] = await sql(`select status, attempts, error, next_attempt_at from messages where conversation_id = $1 order by created_at desc limit 1`, [conv.id]);
    expect(m).toMatchObject({ status: 'failed', attempts: 1, error: 'whatsapp_connection_unavailable', next_attempt_at: null });
    const logs = await sql(`select level, message from integration_logs where connection_id = $1`, [conv.connection_id]);
    expect(logs).toEqual([expect.objectContaining({ level: 'error', message: expect.stringMatching(/credentials are unavailable/) })]);
    expect((await sender.runSender(50, 10)).due).toBe(0); // nothing left looping
  });

  it('jitters backoff and honours Retry-After', () => {
    const lo = retryDelayMs(1, undefined, () => 0);
    const hi = retryDelayMs(1, undefined, () => 1);
    expect([lo, hi]).toEqual([24_000, 36_000]); // 30 s +-20 %
    expect(retryDelayMs(10, undefined, () => 0.5)).toBe(3600_000);
    expect(retryDelayMs(1, 120_000, () => 0)).toBe(120_000); // never earlier than the provider asked
    expect(retryDelayMs(1, 120_000, () => 1)).toBe(144_000);
  });
});

describe('sender lease fence and record step (PCL-11 review)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  /** A Cloud API conversation whose connection loads fine (credentials mocked), with one queued message. */
  async function sendable(contact: string) {
    const tenant = await createTenant(t); // one WhatsApp connection per organization
    const c = await cloudConversation(tenant, contact);
    vi.spyOn(t.app.get(IntegrationConnectionsService), 'loadInTx')
      .mockImplementation(async () => ({ id: c.connectionId, enabled: true, status: 'connected', adapter: { config: {}, credentials: {} } } as any));
    await sql(`delete from messages where org_id = $1 and status = 'queued'`, [tenant.orgId]);
    const [m] = await sql(`insert into messages(org_id, conversation_id, direction, kind, body, payload, status, next_attempt_at, priority)
       values ($1, $2, 'outbound', 'text', 'hi', '{"type":"text","body":"hi"}', 'queued', now() - interval '1 hour', 0) returning id`, [tenant.orgId, c.conversationId]);
    return { id: m.id as string, orgId: tenant.orgId };
  }
  /** Provider mock counting the calls addressed to one contact (other tests' queued messages may share the run). */
  function provider(contact: string, onCall?: (n: number) => Promise<void>) {
    let calls = 0;
    vi.spyOn(whatsappCloudAdapter, 'send').mockImplementation(async (_ctx, payload: any) => {
      if (payload?.to !== contact) return { messageId: `wamid.other.${Math.random()}` };
      calls++;
      await onCall?.(calls);
      return { messageId: `wamid.${contact}.${calls}` };
    });
    return () => calls;
  }
  async function claimOne(sender: MessagingService, id: string) {
    const claim = (await sender.claimDue(200, 200)).find((c) => c.id === id);
    expect(claim).toBeTruthy();
    return claim!;
  }
  /** Moves a claimed message's lease into the past (the clock passing it while its run is still busy). */
  const expireLease = async (id: string) =>
    (await sql(`update messages set next_attempt_at = now() - interval '1 second' where id = $1 returning next_attempt_at::text as lease`, [id]))[0].lease as string;

  it('a run that reaches a message after its lease ran out renews it first; a concurrent run cannot send it again', async () => {
    const contact = '201000000931';
    const { id, orgId } = await sendable(contact);
    const sender = t.app.get(MessagingService);
    await claimOne(sender, id);
    const expired = await expireLease(id);
    // While run A's provider call is in flight, the next scheduled sender run looks for due messages.
    const calls = provider(contact, async (n) => { if (n === 1) await sender.runSender(200, 200); });
    expect(await (sender as any).sendOne(orgId, id, expired)).toBe('sent');
    expect(calls()).toBe(1);
    const [row] = await sql(`select status, provider_message_id, attempts, next_attempt_at from messages where id = $1`, [id]);
    expect(row).toMatchObject({ status: 'sent', provider_message_id: `wamid.${contact}.1`, attempts: 1, next_attempt_at: null });
  });

  it('a run whose expired lease was re-claimed by another run skips the message', async () => {
    const contact = '201000000932';
    const { id, orgId } = await sendable(contact);
    const sender = t.app.get(MessagingService);
    await claimOne(sender, id);
    const expired = await expireLease(id);
    const calls = provider(contact);
    await sender.runSender(200, 200); // re-claims and sends it
    expect(calls()).toBe(1);
    expect(await (sender as any).sendOne(orgId, id, expired)).toBe('sent'); // 'sent' here means already handled
    expect(calls()).toBe(1);
    const [row] = await sql(`select status, provider_message_id from messages where id = $1`, [id]);
    expect(row).toEqual({ status: 'sent', provider_message_id: `wamid.${contact}.1` });
  });

  it('a failure while recording an accepted send never requeues the message as a failed send', async () => {
    const contact = '201000000933';
    const { id, orgId } = await sendable(contact);
    const sender = t.app.get(MessagingService);
    const claim = await claimOne(sender, id);
    const db = t.app.get(DbService);
    const real = db.withTenant.bind(db);
    let n = 0;
    // Step 1 (lease renewal) works; every attempt at step 3 (record) fails, as on a lost connection.
    const spy = vi.spyOn(db, 'withTenant').mockImplementation(((...args: Parameters<DbService['withTenant']>) => {
      if (++n > 1) return Promise.reject(new Error('connection terminated unexpectedly'));
      return real(...args);
    }) as any);
    const calls = provider(contact);
    expect(await (sender as any).sendOne(orgId, id, claim.lease)).toBe('sent');
    expect(n).toBe(4); // renewal + 3 record attempts
    spy.mockRestore();
    const [row] = await sql(`select status, attempts, error, next_attempt_at > now() as leased from messages where id = $1`, [id]);
    // Not recorded as a failure: still under the renewed lease, no attempt spent, no error, so no run re-sends it now.
    expect(row).toEqual({ status: 'queued', attempts: 0, error: null, leased: true });
    await sender.runSender(200, 200);
    expect(calls()).toBe(1);
  });

  it('a transient failure while recording is retried and the send is recorded', async () => {
    const contact = '201000000934';
    const { id, orgId } = await sendable(contact);
    const sender = t.app.get(MessagingService);
    const claim = await claimOne(sender, id);
    const db = t.app.get(DbService);
    const real = db.withTenant.bind(db);
    let n = 0;
    vi.spyOn(db, 'withTenant').mockImplementation(((...args: Parameters<DbService['withTenant']>) => {
      if (++n === 2) return Promise.reject(new Error('could not serialize access'));
      return real(...args);
    }) as any);
    provider(contact);
    expect(await (sender as any).sendOne(orgId, id, claim.lease)).toBe('sent');
    const [row] = await sql(`select status, provider_message_id, attempts from messages where id = $1`, [id]);
    expect(row).toEqual({ status: 'sent', provider_message_id: `wamid.${contact}.1`, attempts: 1 });
  });
});

describe('chunked campaign dispatch (PCL-11)', () => {
  const m = (tenant: TestTenant, path: string) => `/v1/o/${tenant.orgId}/marketing${path}`;
  async function approvedCampaign(tenant: TestTenant, tag: string, recipients: number) {
    await sql(`insert into customers(org_id, display_name, tags, marketing_consent) select $1, 'Guest ' || g, array[$2::text], false from generate_series(1, $3) g`,
      [tenant.orgId, tag, recipients]);
    const seg = (await t.http.post(m(tenant, '/segments')).set(auth(tenant.owner)).send({ name: tag, definition: { op: 'and', rules: [{ type: 'has_tag', tag }] } })).body;
    const c = (await t.http.post(m(tenant, '/campaigns')).set(auth(tenant.owner)).send({ name: tag, channel: 'whatsapp', segmentId: seg.id, content: { text: 'Hello' } })).body;
    await t.http.post(m(tenant, `/campaigns/${c.id}/submit`)).set(auth(tenant.owner)).expect(201);
    await t.http.post(m(tenant, `/campaigns/${c.id}/approve`)).set(auth(tenant.owner)).expect(201);
    return c.id as string;
  }

  it('sends the first chunk in the request and the dispatcher finishes the rest, one delivery per recipient', async () => {
    const id = await approvedCampaign(a, 'bulk1', CAMPAIGN_CHUNK * 2 + 50);
    const sent = await t.http.post(m(a, `/campaigns/${id}/send`)).set(auth(a.owner));
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({ status: 'sending', delivery: { recipients: CAMPAIGN_CHUNK * 2 + 50, skippedNoConsent: CAMPAIGN_CHUNK, pending: CAMPAIGN_CHUNK + 50 } });
    expect((await t.http.post(m(a, `/campaigns/${id}/send`)).set(auth(a.owner))).status).toBe(409); // never twice
    await t.app.get(CampaignsService).dispatchDue();
    const after = (await t.http.get(m(a, `/campaigns/${id}`)).set(auth(a.owner))).body;
    expect(after.status).toBe('sent');
    const [d] = await sql(`select count(*)::int as n, count(distinct customer_id)::int as people from campaign_deliveries where campaign_id = $1`, [id]);
    expect(d).toEqual({ n: CAMPAIGN_CHUNK * 2 + 50, people: CAMPAIGN_CHUNK * 2 + 50 });
    const audit = await sql(`select metadata from audit_logs where entity_id = $1 and action = 'marketing.campaign_sent'`, [id]);
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({ recipients: CAMPAIGN_CHUNK * 2 + 50, skippedNoConsent: CAMPAIGN_CHUNK * 2 + 50, pending: 0 });
  });

  it('concurrent dispatcher runs on a scheduled campaign never duplicate a delivery', async () => {
    const id = await approvedCampaign(b, 'bulk2', CAMPAIGN_CHUNK + 120);
    await t.http.post(m(b, `/campaigns/${id}/schedule`)).set(auth(b.owner)).send({ scheduledAt: new Date(Date.now() + 3600_000).toISOString() }).expect(201);
    await sql(`update campaigns set scheduled_at = now() - interval '1 minute' where id = $1`, [id]);
    const svc = t.app.get(CampaignsService);
    const results = await Promise.allSettled([svc.dispatchDue(), svc.dispatchDue()]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    await svc.dispatchDue(); // whichever run lost the start race finishes nothing twice
    const [c] = await sql(`select status from campaigns where id = $1`, [id]);
    expect(c.status).toBe('sent');
    const [d] = await sql(`select count(*)::int as n, count(distinct customer_id)::int as people from campaign_deliveries where campaign_id = $1`, [id]);
    expect(d).toEqual({ n: CAMPAIGN_CHUNK + 120, people: CAMPAIGN_CHUNK + 120 });
  });
});
