import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootTestApp, createTenant, seedMenu, sql, type SeededMenu, type TestApp, type TestTenant } from './helpers';
import { VisitsService } from '../src/modules/orders/visits.service';
import { key, qrTokenFor, saveFloor, table } from './ops-fixtures';

// Guest experience (ws4b): read-only QR lookup (CR-03), light table polling and token-keyed read limits (PCL-18),
// local phone formats (CR-06), booking slots in the branch time zone (VP-08, VP-11), deposit resume (FT-11).

let t: TestApp;
let tenant: TestTenant;
let menu: SeededMenu;
let tables: Record<string, { id: string; qr: string }>;

beforeAll(async () => {
  t = await bootTestApp();
  tenant = await createTenant(t, { country: 'EG' });
  menu = await seedMenu(tenant);
  const f = await saveFloor(t, tenant, [
    table('Q1', 150, 200, { capacity: 2 }), table('Q2', 350, 200, { capacity: 4 }), table('Q3', 550, 200, { capacity: 6 }),
    table('Q4', 750, 200, { capacity: 2, reservable: false }),
  ]);
  tables = {};
  for (const tb of f.tables) tables[tb.label] = { id: tb.id, qr: await qrTokenFor(t, tenant, tb.id) };
});
afterAll(async () => { await t.close(); });

const visitHeader = (token: string) => ({ 'X-Visit-Token': token });
const openVisits = async (tableId: string) => (await sql(`select count(*)::int as n from visits where table_id = $1`, [tableId]))[0].n as number;

describe('read-only table lookup (CR-03)', () => {
  it('describes the table behind a QR code without opening anything; unknown codes are a real 404', async () => {
    const before = await openVisits(tables.Q1!.id);
    const res = await t.http.get(`/v1/public/tables/${tables.Q1!.qr}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      org: { name: 'Test Restaurant', nameAr: null, slug: tenant.slug, currency: 'EGP' },
      branch: { id: tenant.branchId, code: expect.any(String), name: 'Main branch', nameAr: null },
      table: { label: 'Q1' }, accepting: true, reason: null, cover: null,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/token|visit/i);
    expect(await openVisits(tables.Q1!.id)).toBe(before); // no session side effects
    // A staff-seated-only table says why, still without side effects.
    const seated = await t.http.get(`/v1/public/tables/${tables.Q4!.qr}`);
    expect(seated.body).toMatchObject({ accepting: false, reason: 'staff_seating' });
    expect((await t.http.get('/v1/public/tables/not-a-real-qr-token-123456')).status).toBe(404);
    expect((await t.http.get('/v1/public/tables/short')).status).toBe(404);
  });
});

describe('guest cover photo (VP-07 review)', () => {
  const media = async (orgId: string, name: string, type = 'image/webp') => (await sql(
    `insert into media_assets(org_id, path, content_type, byte_size) values ($1, $2, $3, 1000) returning id`, [orgId, `${orgId}/${name}`, type]))[0].id as string;
  const site = async (orgId: string, status: 'draft' | 'published', heroMediaId: string | null) => {
    const w = (await sql(`insert into websites(org_id, status) values ($1, $2)
      on conflict (org_id) do update set status = excluded.status returning id`, [orgId, status]))[0].id as string;
    const next = (await sql('select coalesce(max(revision), 0) + 1 as n from website_revisions where website_id = $1', [w]))[0].n as number;
    await sql(`insert into website_revisions(org_id, website_id, revision, snapshot) values ($1, $2, $3, $4)`,
      [orgId, w, next, { template: 'olive', theme: { heroMediaId }, seo: {}, sections: [] }]);
  };
  const covers = async () => [
    (await t.http.get(`/v1/public/tables/${tables.Q1!.qr}`).expect(200)).body.cover as string | null,
    (await t.http.get(`/v1/public/order/${tenant.slug}`).expect(200)).body.cover as string | null,
  ];

  it('is the restaurant\'s own published website hero, never another restaurant\'s photo, else none', async () => {
    // No website: no photo (the page keeps its plain brand panel).
    expect(await covers()).toEqual([null, null]);
    // Another restaurant's hero is never served, even if its id ends up in this restaurant's site.
    const other = await createTenant(t, { country: 'EG' });
    const foreign = await media(other.orgId, 'olive-room-interior.webp');
    await site(tenant.orgId, 'published', foreign);
    expect(await covers()).toEqual([null, null]);
    // A draft (unpublished) hero is not public yet; a non-image asset is never a cover.
    const own = await media(tenant.orgId, 'our-dining-room.webp');
    await site(tenant.orgId, 'draft', own);
    expect(await covers()).toEqual([null, null]);
    await site(tenant.orgId, 'published', await media(tenant.orgId, 'menu.pdf', 'application/pdf'));
    expect(await covers()).toEqual([null, null]);
    // Published: both guest pages show this restaurant's photo through a signed media URL.
    await site(tenant.orgId, 'published', own);
    const [table, web] = await covers();
    for (const url of [table, web]) expect(url).toMatch(new RegExp(`/v1/media/${encodeURIComponent(`${tenant.orgId}/our-dining-room.webp`)}\\?exp=\\d+&sig=`));
  });
});

describe('table polling (PCL-18)', () => {
  it('returns order timelines in the visit view and answers unchanged polls in a few bytes', async () => {
    const scan = await t.http.post(`/v1/public/tables/${tables.Q2!.qr}/session`).expect(200);
    const token = scan.body.token as string;
    const first = await t.http.get('/v1/public/visits/current').set(visitHeader(token)).expect(200);
    expect(first.body).toMatchObject({ orders: [], rated: false, version: expect.stringMatching(/^[0-9a-f]{16}$/) });
    const same = await t.http.get(`/v1/public/visits/current?v=${first.body.version}`).set(visitHeader(token)).expect(200);
    expect(same.body).toEqual({ unchanged: true, version: first.body.version });

    const quote = await t.http.post('/v1/public/visits/current/quote').set(visitHeader(token)).send({ lines: [{ productId: menu.products.fries, quantity: 1 }] });
    await t.http.post('/v1/public/visits/current/orders').set(visitHeader(token)).set('Idempotency-Key', key('poll'))
      .send({ lines: [{ productId: menu.products.fries, quantity: 1 }], expectedTotalMinor: quote.body.totalMinor }).expect(201);
    const changed = await t.http.get(`/v1/public/visits/current?v=${first.body.version}`).set(visitHeader(token)).expect(200);
    expect(changed.body.version).not.toBe(first.body.version);
    expect(changed.body.orders[0]).toMatchObject({ status: 'placed', fulfillment: 'dine_in', timeline: [{ status: 'placed', at: expect.any(String) }] });
    // A malformed version is rejected rather than ignored.
    expect((await t.http.get('/v1/public/visits/current?v=zz').set(visitHeader(token))).status).toBe(400);
  });

  it('a busy table behind one address is not throttled; guessing tokens is', async () => {
    const scan = await t.http.post(`/v1/public/tables/${tables.Q3!.qr}/session`).expect(200);
    // Eight phones polling every 3 s for a minute, all sharing the table token and the restaurant Wi-Fi: 160 reads.
    const statuses = new Set<number>();
    for (let i = 0; i < 160; i++) statuses.add((await t.http.get('/v1/public/visits/current').set(visitHeader(scan.body.token))).status);
    expect([...statuses]).toEqual([200]);
    // Unknown tokens count against a strict per-address budget.
    const bogus = Array.from({ length: 61 }, (_, i) => `bogus-token-${i}-0123456789abcdef`);
    const codes: number[] = [];
    for (const b of bogus) codes.push((await t.http.get('/v1/public/visits/current').set(visitHeader(b))).status);
    expect(codes.slice(0, 60).every((c) => c === 401)).toBe(true);
    expect(codes[60]).toBe(429);
    // Once the budget is spent, a correct guess gains nothing: a real token this address has never used is refused
    // before it is looked up...
    const unseen = await t.app.get(VisitsService).tableSession(tables.Q1!.qr);
    const guessed = await t.http.get('/v1/public/visits/current').set(visitHeader(unseen.token));
    expect(guessed.status).toBe(429);
    expect(guessed.body.error.code).toBe('rate_limited');
    // ...while the phones already seated here keep polling, and a phone that scans in now can start at once.
    expect((await t.http.get('/v1/public/visits/current').set(visitHeader(scan.body.token))).status).toBe(200);
    const fresh = await t.http.post(`/v1/public/tables/${tables.Q1!.qr}/session`).expect(200);
    expect((await t.http.get('/v1/public/visits/current').set(visitHeader(fresh.body.token))).status).toBe(200);
  });
});

describe('guest phone numbers in local formats (CR-06)', () => {
  it('web orders accept 01x and Arabic-Indic digits and store E.164; nonsense is refused with a code', async () => {
    const m = await t.http.get(`/v1/public/order/${tenant.slug}`).expect(200);
    const lines = [{ productId: menu.products.fries, quantity: 1 }];
    const quote = await t.http.post(`/v1/public/order/${tenant.slug}/quote`).send({ branchId: m.body.branch.id, fulfillment: 'pickup', lines }).expect(200);
    const order = (phone: string) => t.http.post(`/v1/public/order/${tenant.slug}/orders`).set('Idempotency-Key', key('phone'))
      .send({ branchId: m.body.branch.id, fulfillment: 'pickup', payment: 'pay_at_pickup', lines, expectedTotalMinor: quote.body.totalMinor,
        customer: { name: 'منى Adel', phone, marketingConsent: false } });
    for (const [typed, stored] of [['010 1234 5678', '+201012345678'], ['٠١١٢٣٤٥٦٧٨٩', '+201123456789'], ['+20 122 333 4444', '+201223334444']]) {
      const res = await order(typed!);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const [c] = await sql(`select c.phone_e164 as phone, o.customer_phone from orders o join customers c on c.id = o.customer_id where o.id = $1`, [res.body.order.id]);
      expect(c).toEqual({ phone: stored, customer_phone: stored });
    }
    const bad = await order('12345678901234');
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('phone_invalid');
    expect((await order('call me')).status).toBe(400);
  });

  it('booking holds normalise the guest phone the same way', async () => {
    const day = (await sql(`select ((now() at time zone 'Africa/Cairo')::date + 3)::text as d`))[0].d;
    const res = await t.http.post(`/v1/public/reservations/${tenant.slug}/holds`).send({
      branchId: tenant.branchId, date: day, time: '20:00', partySize: 2, guestName: 'Nour', guestPhone: '٠١٠-٠٠٠٠-١١١١', key: key('hold'),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const [r] = await sql(`select guest_phone from reservations where id = $1`, [res.body.reservation.id]);
    expect(r.guest_phone).toBe('+201000001111');
  });

  it('the per-number abuse limit counts one phone once, however it is spelled', async () => {
    const spellings = ['01009998877', '1009998877', '201009998877', '+201009998877', '00201009998877'];
    const day = (await sql(`select ((now() at time zone 'Africa/Cairo')::date + 12)::text as d`))[0].d; // away from the slot tests' days
    const hold = (guestPhone: string, i: number) => t.http.post(`/v1/public/reservations/${tenant.slug}/holds`).send({
      branchId: tenant.branchId, date: day, time: `${String(12 + (i % 10)).padStart(2, '0')}:00`, partySize: 2, guestName: 'Limit', guestPhone, key: key(`lim${i}`),
    });
    for (let i = 0; i < 10; i++) expect((await hold(spellings[i % 5]!, i)).status).not.toBe(429);
    const over = await hold(spellings[2]!, 10);
    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe('rate_limited');
    expect((await hold('01007776655', 11)).status).not.toBe(429); // another number is unaffected

    const m = await t.http.get(`/v1/public/order/${tenant.slug}`).expect(200);
    const lines = [{ productId: menu.products.fries, quantity: 1 }];
    const quote = await t.http.post(`/v1/public/order/${tenant.slug}/quote`).send({ branchId: m.body.branch.id, fulfillment: 'pickup', lines }).expect(200);
    const order = (phone: string, i: number) => t.http.post(`/v1/public/order/${tenant.slug}/orders`).set('Idempotency-Key', key(`wlim${i}`))
      .send({ branchId: m.body.branch.id, fulfillment: 'pickup', payment: 'pay_at_pickup', lines, expectedTotalMinor: quote.body.totalMinor,
        customer: { name: 'Limit', phone, marketingConsent: false } });
    for (let i = 0; i < 10; i++) expect((await order(spellings[i % 5]!, i)).status).toBe(201);
    expect((await order(spellings[4]!, 10)).status).toBe(429);
  });
});

describe('booking slots in the branch time zone (VP-08, VP-11)', () => {
  it('lists a service with free tables per sitting, today being today where the restaurant is', async () => {
    const [{ today, tomorrow }] = await sql(`select (now() at time zone 'Africa/Cairo')::date::text as today, ((now() at time zone 'Africa/Cairo')::date + 1)::text as tomorrow`);
    const res = await t.http.get(`/v1/public/reservations/${tenant.slug}/slots?partySize=2`).expect(200);
    expect(res.body).toMatchObject({ timeZone: 'Africa/Cairo', today, durationMin: 90, currency: 'EGP' });
    expect([today, tomorrow]).toContain(res.body.date);
    expect(res.body.slots.length).toBeGreaterThan(0);
    // Every sitting listed is still ahead (at least ten minutes from now, in Cairo).
    for (const s of res.body.slots) {
      const [{ ahead }] = await sql(`select ((($1::date + $2::time) at time zone 'Africa/Cairo') > now() + interval '9 minutes') as ahead`, [res.body.date, s.time]);
      expect(ahead, s.time).toBe(true);
    }

    const day = (await sql(`select ((now() at time zone 'Africa/Cairo')::date + 5)::text as d`))[0].d;
    const lunch = await t.http.get(`/v1/public/reservations/${tenant.slug}/slots?partySize=4&date=${day}&service=lunch`).expect(200);
    expect(lunch.body.slots.map((s: any) => s.time)).toEqual(['12:00', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00']);
    const freeAt = (b: any, time: string) => b.slots.find((s: any) => s.time === time).free;
    expect(freeAt(lunch.body, '13:00')).toBe(2); // Q2 (4) and Q3 (6) fit four; Q1 is too small, Q4 is not reservable
    // Booking Q2 at 13:00 blocks it for 90 + 15 minutes either side of overlapping sittings.
    await t.http.post(`/v1/public/reservations/${tenant.slug}/holds`).send({
      branchId: tenant.branchId, tableId: tables.Q2!.id, date: day, time: '13:00', partySize: 4, guestName: 'Lina', guestPhone: '01000002222', key: key('hold'),
    }).expect(201);
    const after = await t.http.get(`/v1/public/reservations/${tenant.slug}/slots?partySize=4&date=${day}&service=lunch`).expect(200);
    expect(freeAt(after.body, '13:00')).toBe(1);
    expect(freeAt(after.body, '12:00')).toBe(1);
    expect(freeAt(after.body, '15:00')).toBe(2);
    expect((await t.http.get(`/v1/public/reservations/no-such-place/slots`)).status).toBe(404);
  });
});

describe('resuming an unpaid reservation deposit (FT-11)', () => {
  it('reissues the open deposit checkout from the manage link after the guest abandoned it', async () => {
    await sql(`update branches set reservation_deposit_minor = 15000 where id = $1`, [tenant.branchId]);
    try {
      const day = (await sql(`select ((now() at time zone 'Africa/Cairo')::date + 4)::text as d`))[0].d;
      const held = await t.http.post(`/v1/public/reservations/${tenant.slug}/holds`).send({
        branchId: tenant.branchId, date: day, time: '21:00', partySize: 2, guestName: 'Sara', guestPhone: '01000003333', key: key('hold'),
      }).expect(201);
      const token = held.body.manageToken as string;
      const confirm = await t.http.post('/v1/public/reservations/manage/confirm').set({ 'X-Reservation-Token': token }).send({ key: key('confirm') }).expect(200);
      expect(confirm.body.reservation.status).toBe('pending_deposit');
      const firstUrl = confirm.body.checkout.url as string;
      // The guest closes the tab. Later the manage link shows the pending deposit with its expiry...
      const view = await t.http.get('/v1/public/reservations/manage').set({ 'X-Reservation-Token': token }).expect(200);
      expect(view.body.reservation).toMatchObject({ status: 'pending_deposit', depositStatus: 'required', holdExpiresAt: expect.any(String) });
      expect(view.body.branch.timeZone).toBe('Africa/Cairo'); // times on the manage page are the restaurant's (VP-11)
      // ...and "Pay deposit" resumes the same open checkout instead of creating a second one.
      const resume = await t.http.post(`/v1/public/payments/reservations/${view.body.reservation.code}/checkout`).send({ token }).expect(200);
      expect(resume.body.url).toBe(firstUrl);
      expect(resume.body.amountMinor).toBe(15000);
      expect((await sql(`select count(*)::int as n from checkout_sessions where reservation_id = $1`, [held.body.reservation.id]))[0].n).toBe(1);
      // A wrong token never reaches the checkout.
      expect((await t.http.post(`/v1/public/payments/reservations/${view.body.reservation.code}/checkout`).send({ token: `${token}x` })).status).toBe(404);
    } finally {
      await sql(`update branches set reservation_deposit_minor = 0 where id = $1`, [tenant.branchId]);
    }
  });
});
