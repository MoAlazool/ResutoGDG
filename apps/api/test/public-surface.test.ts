// Security regression (lead): every public read endpoint is scanned for secrets.
// The legacy app leaked table QR tokens through /api/public (CURRENT_STATE.md);
// Resuto 2.0 must never return QR tokens, token/key hashes, credentials or costs
// to unauthenticated callers.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { auth, bootTestApp, createTenant, seedMenu, sql, type TestApp, type TestTenant } from './helpers';
import { key, saveFloor, table } from './ops-fixtures';

let t: TestApp;
let tenant: TestTenant;
let secrets: string[] = [];
let branchCode: string;

beforeAll(async () => {
  t = await bootTestApp();
  tenant = await createTenant(t);
  await seedMenu(tenant);
  await saveFloor(t, tenant, [table('W1', 300, 300), table('W2', 600, 300)]);
  [{ code: branchCode }] = await sql(`select code from branches where id = $1`, [tenant.branchId]);
  // Publish the website so the public site endpoints return content.
  const pub = await t.http.post(`/v1/o/${tenant.orgId}/studio/website/publish`).set(auth(tenant.owner)).send({ key: key('pub') });
  expect(pub.status).toBeLessThan(300);
  // Everything below must never appear in public responses.
  const rows = await sql(
    `select qr_token as v from dining_tables where org_id = $1
     union all select guest_token_hash from visits where org_id = $1
     union all select token_hash from checkout_sessions where org_id = $1
     union all select token_hash from ordering_sessions where org_id = $1`, [tenant.orgId]);
  secrets = rows.map((r) => r.v).filter(Boolean);
  expect(secrets.length).toBeGreaterThanOrEqual(3); // seedMenu table + 2 floor tables
});
afterAll(async () => { await t.close(); });

const FORBIDDEN_KEYS = /^(qr_?token|qrToken|token_?hash|tokenHash|key_?hash|keyHash|credentials(_encrypted)?|credentialsEncrypted|guest_token_hash|cost_?minor|costMinor|internal_?notes|internalNotes|stock_?qty|stockQty)$/;

function scan(label: string, body: unknown) {
  const text = JSON.stringify(body);
  for (const s of secrets) expect(text.includes(s), `${label} leaks a secret value`).toBe(false);
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        expect(FORBIDDEN_KEYS.test(k), `${label} exposes field ${path}.${k}`).toBe(false);
        walk(x, `${path}.${k}`);
      }
    }
  };
  walk(body, label);
}

it('public read endpoints expose no QR tokens, hashes, credentials, costs or stock', async () => {
  const endpoints = [
    `/v1/public/menu/${tenant.slug}`,
    `/v1/public/floor/${tenant.slug}/${branchCode}`,
    `/v1/public/order/${tenant.slug}`,
    `/v1/public/sites/${tenant.slug}`,
    `/v1/public/reservations/${tenant.slug}/availability?branchId=${tenant.branchId}&date=2030-01-10&time=19:00&partySize=2`,
    `/v1/public/plans?country=EG&interval=month`,
  ];
  for (const path of endpoints) {
    const res = await t.http.get(path);
    expect(res.status, `${path} → ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`).toBeLessThan(300);
    scan(path, res.body);
  }
});

it('a guest table session returns only its own bearer token, never the QR token', async () => {
  // saveFloor archived seedMenu's table (omitted tables are archived); use a live floor table.
  const [qr] = await sql(`select qr_token from dining_tables where org_id = $1 and is_active and label = 'W1'`, [tenant.orgId]);
  const session = await t.http.post(`/v1/public/tables/${qr.qr_token}/session`);
  expect(session.status).toBeLessThan(300);
  const { token, ...rest } = session.body;
  expect(typeof token).toBe('string');
  scan('table session', rest);
  const current = await t.http.get('/v1/public/visits/current').set('X-Visit-Token', token);
  scan('visit', current.body);
  const bill = await t.http.get('/v1/public/payments/visit/bill').set('X-Visit-Token', token);
  expect(bill.status).toBeLessThan(300);
  scan('bill', bill.body);
});
