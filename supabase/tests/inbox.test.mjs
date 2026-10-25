// 21-INBOX migration 20261025300001: conversation_tags, conversation_tag_assignments and saved_replies are
// tenant-isolated (staff and tenant roles see and write only their restaurant, including with a forged org),
// branch-scoped staff see saved replies of their branches (plus organization-wide ones) and tag assignments only on
// conversations they can see, a tag or branch of another restaurant can never be attached, client roles see nothing,
// and an internal note (messages.kind 'note') can never be stored in a sendable form.
// Own disposable database (<TEST_DATABASE_URL>_inbox).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate } from '../../scripts/db/migrate.mjs';
import { ensureDatabase } from '../../scripts/db/ensure-db.mjs';

const base = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:54329/resuto_test';
const url = base.replace(/\/([^/?]+)(\?.*)?$/, (_m, db, q = '') => `/${db}_inbox${q}`);
const pool = new pg.Pool({ connectionString: url, max: 4 });
const ids = {};
const TABLES = ['conversation_tags', 'conversation_tag_assignments', 'saved_replies'];

async function as(role, { user, org } = {}, fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    if (user) await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: user, role: 'authenticated' })]);
    if (org) await c.query(`select set_config('app.org_id', $1, true)`, [org]);
    await c.query(`set local role ${role}`);
    return await fn(c);
  } finally {
    await c.query('rollback').catch(() => {});
    c.release();
  }
}

const count = (role, opts, table) => as(role, opts, (c) => c.query(`select count(*)::int as n from ${table}`)).then((r) => r.rows[0].n, (e) => e.message);
const q = (sql, params) => pool.query(sql, params).then((r) => r.rows);

before(async () => {
  await ensureDatabase(url);
  await migrate({ url, reset: true, log: () => {} });
  for (const k of ['A', 'B']) {
    const [u] = await q(`insert into auth.users(email) values ($1) returning id`, [`inbox-owner${k}@example.test`]);
    const [o] = await q(`insert into organizations(slug, name) values ($1, $2) returning id`, [`inbox-${k.toLowerCase()}`, `Inbox ${k}`]);
    const [main] = await q(`insert into branches(org_id, code, name) values ($1, 'main', 'Main') returning id`, [o.id]);
    const [north] = await q(`insert into branches(org_id, code, name) values ($1, 'north', 'North') returning id`, [o.id]);
    await q(`insert into memberships(org_id, user_id, role) values ($1, $2, 'owner')`, [o.id, u.id]);
    const conv = {};
    for (const [name, branch] of [['main', main.id], ['north', north.id]]) {
      const [ch] = await q(`insert into messaging_channels(org_id, branch_id, kind, transport, display_name) values ($1, $2, 'whatsapp', 'sandbox', $3) returning id`,
        [o.id, branch, `WA ${name}`]);
      const [c] = await q(`insert into conversations(org_id, branch_id, channel_id, external_contact, status, last_inbound_at) values ($1, $2, $3, $4, 'open', now()) returning id`,
        [o.id, branch, ch.id, `20100000${k === 'A' ? 1 : 2}${name === 'main' ? 1 : 2}`]);
      conv[name] = c.id;
    }
    const [tag] = await q(`insert into conversation_tags(org_id, name, color) values ($1, 'VIP', 'amber') returning id`, [o.id]);
    for (const c of Object.values(conv)) await q(`insert into conversation_tag_assignments(org_id, conversation_id, tag_id) values ($1, $2, $3)`, [o.id, c, tag.id]);
    await q(`insert into saved_replies(org_id, branch_id, title, shortcut, body_en) values ($1, null, 'Hours', 'hours', 'We open at 9')`, [o.id]);
    await q(`insert into saved_replies(org_id, branch_id, title, shortcut, body_en) values ($1, $2, 'Main parking', 'parking', 'Park behind')`, [o.id, main.id]);
    await q(`insert into saved_replies(org_id, branch_id, title, shortcut, body_ar) values ($1, $2, 'North parking', 'parking', 'اركن خلف المطعم')`, [o.id, north.id]);
    ids[k] = { user: u.id, org: o.id, main: main.id, north: north.id, conv, tag: tag.id };
  }
  // A manager of A restricted to the main branch.
  const [m] = await q(`insert into auth.users(email) values ('inbox-managerA@example.test') returning id`);
  await q(`insert into memberships(org_id, user_id, role, branch_ids) values ($1, $2, 'manager', array[$3::uuid])`, [ids.A.org, m.id, ids.A.main]);
  ids.managerA = m.id;
});

after(async () => pool.end());

test('staff see only their own restaurant\'s tags, assignments and saved replies, and nothing with a forged org', async () => {
  const expected = { conversation_tags: 1, conversation_tag_assignments: 2, saved_replies: 3 };
  for (const table of TABLES) {
    assert.equal(await count('resuto_member', { user: ids.A.user, org: ids.A.org }, table), expected[table], `${table} own`);
    assert.equal(await count('resuto_member', { user: ids.A.user, org: ids.B.org }, table), 0, `${table} forged`);
    assert.equal(await count('resuto_tenant', { org: ids.B.org }, table), expected[table], `${table} tenant`);
  }
  const forged = await as('resuto_member', { user: ids.A.user, org: ids.B.org }, (c) => c.query('select id from conversation_tags where id = $1', [ids.B.tag]));
  assert.equal(forged.rowCount, 0);
});

test('a session cannot write into another restaurant (RLS with check), nor change its rows', async () => {
  const own = { user: ids.A.user, org: ids.A.org };
  await assert.rejects(as('resuto_member', own, (c) => c.query(`insert into conversation_tags(org_id, name) values ($1, 'x')`, [ids.B.org])), /row-level security/);
  await assert.rejects(as('resuto_member', own, (c) => c.query(
    `insert into saved_replies(org_id, title, body_en) values ($1, 'x', 'y')`, [ids.B.org])), /row-level security/);
  await assert.rejects(as('resuto_tenant', { org: ids.A.org }, (c) => c.query(
    `insert into conversation_tag_assignments(org_id, conversation_id, tag_id) values ($1, $2, $3)`, [ids.B.org, ids.B.conv.main, ids.B.tag])),
  /row-level security|does not belong/); // the same-org trigger (run first) cannot see B's rows either
  const renamed = await as('resuto_member', own, (c) => c.query(`update conversation_tags set name = 'pwned' where id = $1`, [ids.B.tag]));
  assert.equal(renamed.rowCount, 0);
  const removed = await as('resuto_tenant', { org: ids.A.org }, (c) => c.query(`delete from saved_replies where org_id = $1`, [ids.B.org]));
  assert.equal(removed.rowCount, 0);
  const unassigned = await as('resuto_member', own, (c) => c.query(`delete from conversation_tag_assignments where tag_id = $1`, [ids.B.tag]));
  assert.equal(unassigned.rowCount, 0);
  assert.equal((await q(`select count(*)::int as n from conversation_tag_assignments where tag_id = $1`, [ids.B.tag]))[0].n, 2);
});

test('a tag or branch of another restaurant can never be attached, whoever writes', async () => {
  // Own org_id on the row, but the tag (or the conversation) is restaurant B's: the same-org trigger refuses it,
  // including for the owner connection that bypasses RLS.
  await assert.rejects(as('resuto_member', { user: ids.A.user, org: ids.A.org }, (c) => c.query(
    `insert into conversation_tag_assignments(org_id, conversation_id, tag_id) values ($1, $2, $3)`, [ids.A.org, ids.A.conv.main, ids.B.tag])), /does not belong/);
  await assert.rejects(q(`insert into conversation_tag_assignments(org_id, conversation_id, tag_id) values ($1, $2, $3)`,
    [ids.A.org, ids.B.conv.main, ids.A.tag]), /does not belong/);
  await assert.rejects(q(`update conversation_tag_assignments set tag_id = $2 where tag_id = $1`, [ids.A.tag, ids.B.tag]), /does not belong/);
  await assert.rejects(q(`insert into saved_replies(org_id, branch_id, title, body_en) values ($1, $2, 'x', 'y')`, [ids.A.org, ids.B.main]), /does not belong/);
});

test('branch-scoped staff see organization-wide and own-branch replies, and assignments only on conversations they can see', async () => {
  const mgr = { user: ids.managerA, org: ids.A.org };
  const replies = await as('resuto_member', mgr, (c) => c.query(`select title from saved_replies order by title`));
  assert.deepEqual(replies.rows.map((r) => r.title), ['Hours', 'Main parking']);
  const assigned = await as('resuto_member', mgr, (c) => c.query(`select conversation_id from conversation_tag_assignments`));
  assert.deepEqual(assigned.rows.map((r) => r.conversation_id), [ids.A.conv.main]);
  // Writes into the other branch are refused by the same policies.
  await assert.rejects(as('resuto_member', mgr, (c) => c.query(
    `insert into saved_replies(org_id, branch_id, title, body_en) values ($1, $2, 'x', 'y')`, [ids.A.org, ids.A.north])), /row-level security|does not belong/);
  const tag2 = (await q(`insert into conversation_tags(org_id, name) values ($1, 'Late') returning id`, [ids.A.org]))[0].id;
  await assert.rejects(as('resuto_member', mgr, (c) => c.query(
    `insert into conversation_tag_assignments(org_id, conversation_id, tag_id) values ($1, $2, $3)`, [ids.A.org, ids.A.conv.north, tag2])),
  /row-level security|does not belong/);
  const otherBranch = await as('resuto_member', mgr, (c) => c.query(`delete from conversation_tag_assignments where conversation_id = $1`, [ids.A.conv.north]));
  assert.equal(otherBranch.rowCount, 0);
  const northReply = await as('resuto_member', mgr, (c) => c.query(`update saved_replies set title = 'x' where branch_id = $1`, [ids.A.north]));
  assert.equal(northReply.rowCount, 0);
  // Their own branch works.
  const ok = await as('resuto_member', mgr, async (c) => {
    await c.query(`insert into conversation_tag_assignments(org_id, conversation_id, tag_id) values ($1, $2, $3)`, [ids.A.org, ids.A.conv.main, tag2]);
    return c.query(`insert into saved_replies(org_id, branch_id, title, body_en) values ($1, $2, 'Main menu', 'Here') returning id`, [ids.A.org, ids.A.main]);
  });
  assert.equal(ok.rowCount, 1);
});

test('client roles (anon, authenticated) can neither read nor write the inbox tables', async () => {
  for (const table of TABLES) {
    assert.match(String(await count('anon', {}, table)), /permission denied/);
    assert.match(String(await count('authenticated', { user: ids.A.user, org: ids.A.org }, table)), /permission denied/);
  }
});

test('an internal note can never be stored in a form a sender could pick up', async () => {
  const conv = ids.A.conv.main;
  const note = (cols) => q(`insert into messages(org_id, conversation_id, direction, kind, body, status${cols.extra ? ', ' + cols.extra : ''})
                            values ($1, $2, $3, 'note', 'call back at 5', $4${cols.extraVal ? ', ' + cols.extraVal : ''}) returning id`,
  [ids.A.org, conv, cols.direction, cols.status]);
  const [ok] = await note({ direction: 'internal', status: 'received' });
  assert.ok(ok.id);
  for (const bad of [
    { direction: 'outbound', status: 'queued' },
    { direction: 'internal', status: 'queued' },
    { direction: 'outbound', status: 'received' },
    { direction: 'internal', status: 'received', extra: 'next_attempt_at', extraVal: 'now()' },
    { direction: 'internal', status: 'received', extra: 'provider_message_id', extraVal: `'wamid.note'` },
    { direction: 'internal', status: 'received', extra: 'is_automated', extraVal: 'true' },
  ]) {
    await assert.rejects(note(bad), /messages_note_internal|violates check constraint/, JSON.stringify(bad));
  }
  await assert.rejects(q(`update messages set status = 'queued', next_attempt_at = now() where id = $1`, [ok.id]), /messages_note_internal/);
  await assert.rejects(q(`update messages set direction = 'outbound' where id = $1`, [ok.id]), /messages_note_internal/);
  // Only notes are internal: a customer message cannot hide as internal either.
  await assert.rejects(q(`insert into messages(org_id, conversation_id, direction, kind, body, status) values ($1, $2, 'internal', 'text', 'x', 'received')`,
    [ids.A.org, conv]), /messages_note_internal/);
  // Staff of another restaurant cannot read it.
  const seen = await as('resuto_member', { user: ids.B.user, org: ids.A.org }, (c) => c.query(`select id from messages where id = $1`, [ok.id]));
  assert.equal(seen.rowCount, 0);
});
