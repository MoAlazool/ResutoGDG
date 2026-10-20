// INT-14 (no silent sandbox fallback) and PS-14 (lock before the provider call, Idempotency-Key, recovery).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CampaignsService } from '../src/modules/marketing/campaigns.service';
import { ProviderHttp } from '../src/modules/integrations/provider-http';
import { inbound, sandboxChannel, scriptedFetch } from './growth-helpers';
import { auth, bootTestApp, createTenant, sql, type TestApp, type TestTenant } from './helpers';

let t: TestApp;
let http: ProviderHttp;
let original: typeof fetch;
beforeAll(async () => { t = await bootTestApp(); http = t.app.get(ProviderHttp); original = http.fetch; });
afterEach(() => { http.fetch = original; });
afterAll(async () => { await t.close(); });

const mk = (tenant: TestTenant) => {
  const m = (p: string) => `/v1/o/${tenant.orgId}/marketing${p}`;
  const approved = async (name: string, channel = 'meta_ads') => {
    const id = (await t.http.post(m('/campaigns')).set(auth(tenant.owner)).send({ name, channel, objective: 'acquisition', budgetMinor: 30000 })).body.id as string;
    await t.http.post(m(`/campaigns/${id}/submit`)).set(auth(tenant.owner)).expect(201);
    await t.http.post(m(`/campaigns/${id}/approve`)).set(auth(tenant.owner)).expect(201);
    return id;
  };
  const launch = (id: string, body: Record<string, unknown> = {}, key?: string) => {
    const r = t.http.post(m(`/campaigns/${id}/launch`)).set(auth(tenant.owner));
    if (key) r.set('Idempotency-Key', key);
    return r.send(body);
  };
  return { m, approved, launch };
};
async function liveMeta(tenant: TestTenant, status: 'connected' | 'error' | 'pending' = 'connected') {
  const c = (await t.http.post(`/v1/o/${tenant.orgId}/integrations/connections`).set(auth(tenant.owner))
    .send({ provider: 'meta_ads', environment: 'live', credentials: { accessToken: 'EAAB-live-token-123456' }, config: { adAccountId: '1234567890' } })).body;
  await sql(`update integration_connections set status = $2, last_error = $3 where id = $1`, [c.id, status, status === 'error' ? 'Session has expired' : null]);
  return c.id as string;
}

describe('INT-14: the sandbox is never a silent fallback', () => {
  it('an unhealthy live account is reported (409 with its health) even when the ads sandbox exists', async () => {
    const tenant = await createTenant(t);
    const { approved, launch } = mk(tenant);
    await t.http.post(`/v1/o/${tenant.orgId}/integrations/connections`).set(auth(tenant.owner)).send({ provider: 'ads_sandbox' }).expect(201);
    const connId = await liveMeta(tenant, 'error');
    const id = await approved('Unhealthy');
    const f = scriptedFetch([{ body: {} }]);
    http.fetch = f.fetch;
    const res = await launch(id);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'ad_account_unhealthy', details: { connectionId: connId, status: 'error', lastError: 'Session has expired', reconnect: '/integrations' } });
    expect(f.calls).toHaveLength(0);
    expect((await sql(`select status, is_sandbox, external_campaign_id from campaigns where id = $1`, [id]))[0]).toEqual({ status: 'approved', is_sandbox: true, external_campaign_id: null });
    // A switched-off live account is refused the same way.
    await sql(`update integration_connections set status = 'connected', enabled = false where id = $1`, [connId]);
    expect((await launch(id)).body.error.code).toBe('ad_account_unhealthy');
    // Rehearsing in the sandbox is an explicit choice.
    const sandbox = await launch(id, { mode: 'sandbox' });
    expect(sandbox.body).toMatchObject({ status: 'sent', isSandbox: true, launch: { mode: 'sandbox' } });
  });

  it('without any live account a live launch is refused, and says whether a sandbox rehearsal is possible', async () => {
    const tenant = await createTenant(t);
    const { approved, launch } = mk(tenant);
    const id = await approved('No account');
    expect((await launch(id)).body.error).toMatchObject({ code: 'ad_account_required', details: { sandboxAvailable: false } });
    expect((await launch(id, { mode: 'sandbox' })).body.error.code).toBe('ads_sandbox_required');
    expect((await launch(id, { mode: 'whatever' })).status).toBe(400);
  });
});

describe('PS-14: one provider call per launch', () => {
  it('two concurrent launches create one external campaign; the other is refused while the first runs', async () => {
    const tenant = await createTenant(t);
    const { approved, launch } = mk(tenant);
    await liveMeta(tenant);
    const id = await approved('Concurrent');
    let calls = 0;
    http.fetch = (async (url: string) => {
      calls++;
      await new Promise((r) => setTimeout(r, 200));
      return new Response(JSON.stringify(String(url).includes('/campaigns') ? { id: `12021000000${calls}` } : {}), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const [a, b] = await Promise.all([launch(id), launch(id)]);
    expect(calls).toBe(1);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.error.code).toBe('launch_in_progress');
    const [row] = await sql(`select status, external_campaign_id, launch_token from campaigns where id = $1`, [id]);
    expect(row).toMatchObject({ status: 'sent', external_campaign_id: '120210000001' });
    expect(row.launch_token).toMatch(/^[a-z0-9]{10}$/);
  });

  it('the provider-side name carries the launch token; a retry with the same Idempotency-Key replays instead of creating again', async () => {
    const tenant = await createTenant(t);
    const { approved, launch } = mk(tenant);
    await liveMeta(tenant);
    const id = await approved('Weekend brunch');
    const f = scriptedFetch([{ body: { id: '120210000000555' } }]);
    http.fetch = f.fetch;
    const first = await launch(id, {}, 'launch-key-0001');
    expect(first.status).toBe(201);
    const name = new URLSearchParams(f.calls[0]!.body!).get('name');
    expect(name).toBe(`Weekend brunch [rs:${first.body.launch.token}]`);
    const again = await launch(id, {}, 'launch-key-0001');
    expect(again.status).toBe(201);
    expect(again.body).toMatchObject({ replayed: true, status: 'sent', externalCampaignId: '120210000000555' });
    expect(f.calls).toHaveLength(1);
    // A different key after success is not a replay: the campaign is no longer approved.
    expect((await launch(id, {}, 'launch-key-0002')).body.error.code).toBe('campaign_not_approved');
  });

  it('a definite provider refusal releases the claim; an unknown outcome keeps it and the recovery job finishes it by its token', async () => {
    const tenant = await createTenant(t);
    const { approved, launch, m } = mk(tenant);
    await liveMeta(tenant);
    const refused = await approved('Refused');
    http.fetch = scriptedFetch([{ status: 400, body: { error: { message: 'Invalid parameter', code: 100 } } }]).fetch;
    const r1 = await launch(refused);
    expect(r1.status).toBe(502);
    expect(r1.body.error.code).toBe('provider_error');
    expect((await sql(`select status, launch_error from campaigns where id = $1`, [refused]))[0]).toMatchObject({ status: 'approved', launch_error: expect.stringMatching(/Invalid parameter/) });

    const unknown = await approved('Timeout');
    http.fetch = scriptedFetch([{ status: 503, body: { error: { message: 'Service temporarily unavailable', code: 2 } } }]).fetch;
    const r2 = await launch(unknown);
    expect(r2.status).toBe(502);
    expect(r2.body.error.code).toBe('launch_outcome_unknown');
    const [stuck] = await sql(`select status, launch_token from campaigns where id = $1`, [unknown]);
    expect(stuck.status).toBe('launching');
    // A second click while the outcome is unknown does not call the provider.
    const f = scriptedFetch([{ body: { id: 'never' } }]);
    http.fetch = f.fetch;
    expect((await launch(unknown)).body.error.code).toBe('launch_in_progress');
    expect(f.calls).toHaveLength(0);
    // Too early to reset by hand.
    expect((await t.http.post(m(`/campaigns/${unknown}/launch/reset`)).set(auth(tenant.owner)).send({ confirmNotCreated: true })).body.error.code).toBe('launch_in_progress');

    // The campaign did get created at Meta: the recovery job finds it by the token and finishes the launch.
    await sql(`update campaigns set launch_started_at = now() - interval '5 minutes' where id = $1`, [unknown]);
    const find = scriptedFetch([{ body: { data: [{ id: '120210000000999', name: `Timeout [rs:${stuck.launch_token}]`, status: 'PAUSED' }] } }]);
    http.fetch = find.fetch;
    expect(await t.app.get(CampaignsService).recoverLaunches(new Date(), { orgId: tenant.orgId })).toMatchObject({ recovered: 1 });
    expect(JSON.parse(new URL(find.calls[0]!.url).searchParams.get('filtering')!)[0]).toMatchObject({ field: 'name', operator: 'CONTAIN', value: `[rs:${stuck.launch_token}]` });
    expect((await sql(`select status, external_campaign_id from campaigns where id = $1`, [unknown]))[0]).toEqual({ status: 'sent', external_campaign_id: '120210000000999' });

    // Not found: it stays launching with a note; the owner may release it after checking.
    const lost = await approved('Lost');
    http.fetch = scriptedFetch([{ status: 504, body: { error: { message: 'timeout', code: 2 } } }]).fetch;
    await launch(lost);
    await sql(`update campaigns set launch_started_at = now() - interval '5 minutes' where id = $1`, [lost]);
    http.fetch = scriptedFetch([{ body: { data: [] } }]).fetch;
    expect(await t.app.get(CampaignsService).recoverLaunches(new Date(), { orgId: tenant.orgId })).toMatchObject({ unresolved: 1 });
    const view = (await t.http.get(m(`/campaigns/${lost}`)).set(auth(tenant.owner))).body;
    expect(view).toMatchObject({ status: 'launching', launch: { inProgress: true, error: expect.stringMatching(/check Meta Ads .* for a campaign tagged \[rs:/) } });
    expect((await t.http.post(m(`/campaigns/${lost}/launch/reset`)).set(auth(tenant.owner)).send({})).status).toBe(400);
    const reset = await t.http.post(m(`/campaigns/${lost}/launch/reset`)).set(auth(tenant.owner)).send({ confirmNotCreated: true });
    expect(reset.body.status).toBe('approved');
  });

  it('send accepts an Idempotency-Key: a retry replays the first result instead of a 409, and nobody is messaged twice', async () => {
    const tenant = await createTenant(t);
    const { m } = mk(tenant);
    const ch = (await sandboxChannel(t, tenant)).id;
    await inbound(t, tenant, ch, '+201000777001', { text: 'hi', name: 'Amal' });
    await sql(`update customers set marketing_consent = true where org_id = $1`, [tenant.orgId]);
    const seg = (await t.http.post(m('/segments')).set(auth(tenant.owner)).send({ name: 'All', definition: { op: 'and', rules: [{ type: 'consent', value: true }] } })).body.id;
    const id = (await t.http.post(m('/campaigns')).set(auth(tenant.owner)).send({ name: 'Hi', channel: 'whatsapp', segmentId: seg, content: { text: 'Hello again' } })).body.id;
    await t.http.post(m(`/campaigns/${id}/submit`)).set(auth(tenant.owner)).expect(201);
    await t.http.post(m(`/campaigns/${id}/approve`)).set(auth(tenant.owner)).expect(201);
    const send = () => t.http.post(m(`/campaigns/${id}/send`)).set(auth(tenant.owner)).set('Idempotency-Key', 'send-key-000001');
    const first = await send();
    expect(first.status).toBe(201);
    const again = await send();
    expect(again.status).toBe(201);
    expect(again.body.delivery).toEqual(first.body.delivery);
    expect((await sql(`select count(*)::int as n from campaign_deliveries where campaign_id = $1`, [id]))[0].n).toBe(first.body.delivery.recipients);
    // Without the key the old rule stands: a sent campaign cannot be sent again.
    expect((await t.http.post(m(`/campaigns/${id}/send`)).set(auth(tenant.owner))).status).toBe(409);
  });
});
