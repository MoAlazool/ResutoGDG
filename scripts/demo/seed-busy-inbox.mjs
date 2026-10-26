#!/usr/bin/env node
// BUSY INBOX FIXTURE for local design and load checks of the Inbox workspace (22-INTINBOX). LOCAL ONLY.
//
// Adds a realistic, busy Inbox to the local demo tenant (scripts/demo/load-demo-data.mjs must have run first):
//   * 72 conversations across WhatsApp (the demo's sandbox channel), Messenger and Instagram (two fixture Page channels
//     whose ids are fictional and that are never connected to Meta), in Arabic, English and mixed text;
//   * every state the Inbox shows: unread, waiting for a reply, bot, taken over, closed, assigned, tagged, ordering;
//   * two long threads (96 and 128 entries) with photos, locations, templates, button replies, a failed delivery,
//     internal notes and an order card, spread over four days (day separators).
//
// It writes with SQL because no API back-dates messages (the API always stamps "now"); every row belongs to the demo
// organization and is recognisable (fixture channels carry verification.fixture = 'busy-inbox'; fixture WhatsApp
// contacts use the fictional +20 109 900 xxxx range). Re-running replaces the previous fixture rows, nothing else.
//
// Safety: refuses NODE_ENV=production, DEMO_TARGET=staging and any non-local database host; refuses an organization
// that is not marked as demo data. Nothing leaves the machine: no outbound message is left queued, so no worker
// ever tries to send one.
//
//   DATABASE_URL=postgres://postgres@127.0.0.1:54329/<db> node scripts/demo/seed-busy-inbox.mjs [--slug the-olive-room]
import pg from 'pg';
import { LOCAL_HOSTS } from './lib/safety.mjs';

const FIXTURE = 'busy-inbox';
const WA_PREFIX = '20109900';

export function refuseTarget(env, dbUrl) {
  if (env.NODE_ENV === 'production') return 'refusing to run with NODE_ENV=production';
  if (env.DEMO_TARGET === 'staging' || env.NODE_ENV === 'staging') return 'the busy inbox fixture is local only (staging refused)';
  if (!dbUrl) return 'DATABASE_URL is required';
  let host;
  try { host = new URL(dbUrl).hostname.replace(/^\[|\]$/g, ''); } catch { return 'DATABASE_URL is not a valid URL'; }
  if (!LOCAL_HOSTS.includes(host)) return `refusing non-local database host "${host}" (local only)`;
  return null;
}

/** Deterministic pseudo-random numbers (mulberry32), so every run builds the same Inbox. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = [
  'Mona Adel', 'منى عادل', 'Karim Said', 'كريم سعيد', 'Youssef El-Masry', 'يوسف المصري', 'Nour Hassan', 'نور حسن', 'Salma Farouk',
  'سلمى فاروق', 'Omar Khaled', 'عمر خالد', 'Laila Mostafa', 'ليلى مصطفى', 'Ahmed Tarek', 'أحمد طارق', 'Hana Ibrahim', 'هنا إبراهيم',
  'Mariam Gamal', 'مريم جمال', 'Ziad Hamdy', 'زياد حمدي', 'Farida Nabil', 'فريدة نبيل', 'Tamer Ashraf', 'تامر أشرف', 'Dina Samir',
  'دينا سمير', 'Hassan Abdel-Rahman El-Sayed (catering, Zamalek office)', 'عبد الرحمن محمد عبد العزيز الشناوي', 'Rana Wael', 'رنا وائل',
  'Khaled Mansour', 'خالد منصور', 'Yasmin Lotfy', 'ياسمين لطفي',
];
const INBOUND = [
  'Is the terrace open tonight?', 'هل التراس مفتوح الليلة؟', 'Do you deliver to Maadi?', 'بتوصلوا المعادي؟', 'Can I book a table for 6 at 9 pm?',
  'عايز أحجز ترابيزة لـ 6 أشخاص الساعة 9', 'What time do you close on Friday?', 'المنيو فيها أكل نباتي؟', 'My order is 20 minutes late, any update?',
  'الطلب وصل بارد للأسف 😕', 'Thanks, the food was amazing!', 'شكراً جداً الأكل كان تحفة', 'Do you have gluten-free bread?',
  'Can I pay by card on delivery?', 'ممكن أدفع فيزا عند الاستلام؟', 'Hi! Is the Smash burger available with a vegan patty?',
  'هل عندكم عروض لرمضان؟', 'I would like to order the mixed grill platter for pickup at 8:30', 'Need catering for 40 people next Thursday, office lunch in Zamalek',
  'ممكن أغير العنوان؟ الشقة في الدور الخامس مش التالت', 'Order #1042 — I got fries instead of onion rings', 'كام سعر الـ family meal؟',
  'Ok perfect 👍', 'تمام شكراً', 'Is parking available near the Zamalek branch?', 'Do you have a kids menu? My son is allergic to sesame — سمسم',
];
const OUTBOUND = [
  'Hi! Yes, the terrace is open from 6 pm until midnight.', 'أهلاً بيك! أيوه التراس مفتوح من 6 لنص الليل.', 'We deliver to Maadi within 45–60 minutes.',
  'بنوصل المعادي في خلال 45 لـ 60 دقيقة.', 'Your table for 6 at 9 pm is booked. See you tonight!', 'تم الحجز ✅ مستنيينك الساعة 9',
  'So sorry about the delay — the driver is 5 minutes away.', 'آسفين جداً على التأخير، السواق قدامه 5 دقايق.', 'Yes, all our burgers can be made with a plant-based patty.',
  'We will send a replacement right away and refund the onion rings.', 'هنبعتلك بديل حالاً ونرجعلك تمن الـ onion rings.', 'You can pay by card or cash on delivery.',
];
const NOTES = [
  'VIP regular — always offer the corner table.', 'عميل دائم، بيحب الترابيزة اللي جنب الشباك', 'Allergic to nuts: call the kitchen before confirming.',
  'Refund approved by the manager (onion rings, 45 EGP).', 'Catering lead — send the group menu PDF tomorrow morning.', 'اتصلت بيه وأكد العنوان الجديد',
];
const LONG_THREAD_EN = [
  'Hi, I want to plan a birthday dinner for my wife next Thursday', 'Of course! How many guests, and what time works best?',
  'We will be 8 adults and 2 kids, around 8:30 pm', 'Perfect. We can seat you on the terrace or in the private room upstairs.',
  'The private room sounds great. Is there a minimum spend?', 'The private room has a minimum spend of 6,000 EGP for parties of 8 or more.',
  'OK that works. Can we bring our own cake?', 'Yes — there is no cake fee, and we can keep it in the fridge until dessert.',
  'Amazing. Do you have a set menu for groups?', 'We have two set menus: Mediterranean (850 EGP) and Grill (1,100 EGP) per person.',
  'Can we mix? Some of us do not eat red meat', 'Absolutely, you can choose per person. I will send both menus now.',
];
const LONG_THREAD_AR = [
  'مساء الخير، عايزة أسأل عن حجز عيد ميلاد', 'مساء النور! أكيد، العدد كام والمعاد إمتى؟', 'هنكون 10 أشخاص يوم الخميس الساعة 8 ونص',
  'تمام، عندنا الأوضة الخاصة فوق أو التراس', 'الأوضة الخاصة أحسن عشان الأطفال', 'ممكن نجيب التورتة معانا؟', 'أكيد مفيش أي رسوم على التورتة 🎂',
  'ممتاز، والأكل؟ في menu للمجموعات؟', 'في اتنين set menus، هبعتهم لحضرتك دلوقتي', 'One of my friends is vegetarian — هل في اختيارات نباتي؟',
  'Yes! The Mediterranean menu has a full vegetarian option — طبق مشويات خضار وفلافل', 'تمام جداً، هنأكد بكرة إن شاء الله',
];

function pick(r, arr) { return arr[Math.floor(r() * arr.length)]; }
const hasArabic = (s) => /[؀-ۿ]/.test(s);

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  const refused = refuseTarget(process.env, dbUrl);
  if (refused) { console.error(`seed-busy-inbox: ${refused}`); process.exit(2); }
  const slugArg = process.argv.indexOf('--slug');
  const slug = slugArg > 0 ? process.argv[slugArg + 1] : 'the-olive-room';
  const db = new pg.Client({ connectionString: dbUrl });
  await db.connect();
  const q = async (sql, params = []) => (await db.query(sql, params)).rows;
  try {
    const [org] = await q(`select id, coalesce((onboarding->>'demo')::boolean, false) as demo from organizations where slug = $1`, [slug]);
    if (!org) throw new Error(`no organization "${slug}": run scripts/demo/load-demo-data.mjs first`);
    if (!org.demo) throw new Error(`organization "${slug}" is not marked as demo data; refusing to touch it`);
    const orgId = org.id;
    const [wa] = await q(`select id, branch_id from messaging_channels where org_id = $1 and kind = 'whatsapp' and transport = 'sandbox' order by created_at limit 1`, [orgId]);
    if (!wa) throw new Error('the demo WhatsApp sandbox channel is missing: run scripts/demo/load-demo-data.mjs first');
    const branches = await q(`select id from branches where org_id = $1 order by created_at`, [orgId]);
    const staff = await q(`select m.user_id from memberships m where m.org_id = $1 and m.role in ('owner', 'manager', 'cashier', 'marketing') order by m.role, m.created_at`, [orgId]);
    const customers = await q(`select id, display_name, phone_e164 from customers where org_id = $1 and phone_e164 is not null and display_name not ilike '%guest%' order by created_at limit 30`, [orgId]);
    const orders = await q(`select id, number from orders where org_id = $1 and number is not null order by created_at desc limit 20`, [orgId]);

    await db.query('begin');
    // Replace the previous fixture (only rows this script made).
    await q(`delete from conversations where org_id = $1 and channel_id = $2 and external_contact like $3`, [orgId, wa.id, `${WA_PREFIX}%`]);
    await q(`delete from messaging_channels where org_id = $1 and verification->>'fixture' = $2`, [orgId, FIXTURE]);
    await q(`delete from conversation_tags where org_id = $1 and name = any($2::text[])
               and not exists (select 1 from conversation_tag_assignments a where a.tag_id = conversation_tags.id)`, [orgId, ['VIP', 'Delivery issue', 'Catering', 'Complaint', 'عميل دائم', 'Allergy']]);

    const pageChannel = async (kind, name, n) => (await q(
      `insert into messaging_channels(org_id, branch_id, kind, transport, display_name, status, external_account_id, page_id, verification)
       values ($1, $2, $3, 'meta_page', $4, 'connected', $5, $6, $7) returning id`,
      [orgId, branches[0]?.id ?? null, kind, name, `99000000000${n}`, `99000000001${n}`, { fixture: FIXTURE }]))[0].id;
    const channels = {
      whatsapp: wa.id,
      messenger: await pageChannel('messenger', 'Olive Room Messenger (demo)', 1),
      instagram: await pageChannel('instagram', '@theoliveroom (demo)', 2),
    };

    const tagDefs = [['VIP', 'amber'], ['Delivery issue', 'red'], ['Catering', 'blue'], ['Complaint', 'red'], ['عميل دائم', 'green'], ['Allergy', 'purple']];
    const tags = [];
    for (const [name, color] of tagDefs) {
      const [row] = await q(`insert into conversation_tags(org_id, name, color) values ($1, $2, $3)
                             on conflict (org_id, lower(name)) do update set color = excluded.color returning id`, [orgId, name, color]);
      tags.push(row.id);
    }

    const r = rng(2210);
    const now = Date.now();
    const MIN = 60_000;
    let msgCount = 0;
    const insertMessage = async (convId, m) => {
      msgCount++;
      await q(`insert into messages(org_id, conversation_id, direction, kind, body, payload, provider_message_id, status, error, attempts, sent_by, is_automated, created_at)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [orgId, convId, m.direction, m.kind ?? 'text', m.body, m.payload ?? {}, m.direction === 'internal' ? null : `${FIXTURE}.${convId}.${msgCount}`,
          m.status ?? (m.direction === 'inbound' || m.direction === 'internal' ? 'received' : 'read'), m.error ?? null,
          m.direction === 'outbound' ? 1 : 0, m.sentBy ?? null, !!m.automated, new Date(m.at)]);
    };

    const TOTAL = 72;
    const plan = [];
    for (let i = 0; i < TOTAL; i++) {
      const kind = i % 4 === 1 ? 'messenger' : i % 4 === 3 ? 'instagram' : 'whatsapp';
      // The newest few minutes ago, then spread back over six days.
      const ageMin = i < 6 ? 2 + i * 7 : Math.round(45 + (i - 6) * (6 * 24 * 60 / TOTAL) * (0.6 + r() * 0.8));
      plan.push({ i, kind, ageMin });
    }
    let longIds = [];
    for (const p of plan) {
      const r2 = rng(1000 + p.i);
      const name = NAMES[p.i % NAMES.length];
      const arabic = hasArabic(name);
      const long = p.i === 1 || p.i === 4; // two long threads near the top of the list
      const contact = p.kind === 'whatsapp' ? `${WA_PREFIX}${String(1000 + p.i).padStart(4, '0')}` : `7${String(100000000000 + p.i * 7919)}`;
      const customer = p.kind === 'whatsapp' && p.i % 3 !== 2 ? customers[p.i % Math.max(1, customers.length)] ?? null : null;
      const status = p.i % 9 === 5 ? 'handoff' : p.i % 7 === 6 ? 'closed' : p.i % 5 === 0 ? 'bot' : 'open';
      const lastAt = now - p.ageMin * MIN;
      const entries = long ? (p.i === 1 ? 96 : 128) : 3 + Math.floor(r2() * 9);
      const span = long ? 4 * 24 * 60 : Math.min(p.ageMin + 60 * 6, 180 + r2() * 900);
      const unread = p.i < 14 && p.i % 2 === 0 ? 1 + Math.floor(r2() * 4) : p.i === 1 ? 3 : 0;
      const lastInbound = (p.i % 3 !== 1) || long;
      const [conv] = await q(
        `insert into conversations(org_id, branch_id, channel_id, customer_id, external_contact, contact_name, status, assigned_to, last_message_at,
                                   last_inbound_at, unread_count, locale, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
        [orgId, branches[p.i % Math.max(1, branches.length)]?.id ?? null, channels[p.kind], customer?.id ?? null, contact, customer ? null : name, status,
          p.i % 4 === 2 && staff.length ? staff[p.i % staff.length].user_id : null, new Date(lastAt),
          new Date(lastInbound ? lastAt : lastAt - 3 * MIN), unread, arabic ? 'ar' : 'en', new Date(lastAt - span * MIN - MIN)]);
      if (long) longIds.push(conv.id);
      // Entries, oldest first, evenly back from the last message.
      for (let k = 0; k < entries; k++) {
        const at = lastAt - Math.round((entries - 1 - k) * (span * MIN) / Math.max(1, entries - 1));
        const last = k === entries - 1;
        const inbound = last ? lastInbound : k % 2 === 0;
        const script = arabic ? LONG_THREAD_AR : LONG_THREAD_EN;
        if (long && k > 0 && k % 17 === 0) { await insertMessage(conv.id, { direction: 'internal', kind: 'note', body: pick(r2, NOTES), sentBy: staff[0]?.user_id ?? null, at }); continue; }
        if (long && k % 23 === 5) { await insertMessage(conv.id, { direction: 'inbound', kind: 'image', body: arabic ? 'صورة الطلب' : 'Photo of the receipt', payload: { type: 'image' }, at }); continue; }
        if (long && k % 31 === 9) { await insertMessage(conv.id, { direction: 'inbound', kind: 'location', body: '26th of July St, Zamalek, Cairo', payload: { type: 'location' }, at }); continue; }
        if (long && k % 29 === 12 && p.kind === 'whatsapp') {
          await insertMessage(conv.id, { direction: 'outbound', kind: 'template', body: arabic ? 'أهلاً! حجزك يوم الخميس الساعة 8:30 مؤكد. نشوفك قريب 🌿' : 'Hello! Your booking on Thursday at 8:30 pm is confirmed. See you soon 🌿',
            payload: { type: 'template', templateName: 'booking_confirmation', language: arabic ? 'ar' : 'en', params: [] }, automated: true, at });
          continue;
        }
        if (long && k % 19 === 3) {
          await insertMessage(conv.id, { direction: 'outbound', kind: 'interactive', body: arabic ? 'تحب تستلم الطلب إزاي؟' : 'How would you like to get your order?',
            payload: { type: 'buttons', buttons: [{ id: 'delivery', title: arabic ? 'توصيل' : 'Delivery' }, { id: 'pickup', title: arabic ? 'استلام' : 'Pickup' }] }, automated: true, at });
          continue;
        }
        if (long && k === entries - 6) { await insertMessage(conv.id, { direction: 'outbound', body: OUTBOUND[k % OUTBOUND.length], status: 'failed', error: '131047 Re-engagement message', at }); continue; }
        const body = long ? (k % 7 === 6 ? `${script[k % script.length]}\n\n${pick(r2, inbound ? INBOUND : OUTBOUND)}` : script[k % script.length]) : pick(r2, inbound ? INBOUND : OUTBOUND);
        await insertMessage(conv.id, { direction: inbound ? 'inbound' : 'outbound', body, status: inbound ? 'received' : last ? 'delivered' : k % 5 === 0 ? 'sent' : 'read',
          automated: !inbound && status === 'bot' && k % 3 === 0, sentBy: !inbound && staff.length ? staff[k % staff.length].user_id : null, at });
      }
      if (!long && p.i % 6 === 3) await insertMessage(conv.id, { direction: 'internal', kind: 'note', body: pick(r2, NOTES), sentBy: staff[0]?.user_id ?? null, at: lastAt - 2 * MIN });
      // Tags on about half the conversations (up to three).
      const nTags = p.i % 2 === 0 ? 1 + (p.i % 3) : long ? 3 : 0;
      for (let tg = 0; tg < nTags; tg++) {
        await q(`insert into conversation_tag_assignments(org_id, conversation_id, tag_id) values ($1, $2, $3) on conflict do nothing`, [orgId, conv.id, tags[(p.i + tg) % tags.length]]);
      }
      if (status === 'handoff') await q(`insert into handoffs(org_id, conversation_id, reason, status) values ($1, $2, 'customer_request', 'requested')`, [orgId, conv.id]);
      // Order cards: a finished order for the long threads, live ordering sessions on a few others.
      const order = orders[p.i % Math.max(1, orders.length)];
      if ((long || p.i % 8 === 2) && p.kind === 'whatsapp') {
        const done = long && order;
        await q(`insert into ordering_sessions(org_id, conversation_id, customer_id, branch_id, channel, step, state, token_hash, order_id, expires_at)
                 values ($1, $2, $3, $4, 'whatsapp', $5, $6, $7, $8, $9)`,
          [orgId, conv.id, customer?.id ?? null, branches[0]?.id ?? null, done ? 'completed' : 'review',
            { fulfillment: p.i % 2 ? 'pickup' : 'delivery', paymentMethod: p.i % 2 ? 'online' : 'cod', quote: { totalMinor: 48500 + p.i * 1250, currency: 'EGP' },
              ...(done ? { order: { number: order.number } } : {}) },
            `${FIXTURE}-${conv.id}`, done ? order.id : null, new Date(now + 6 * 60 * MIN)]);
      }
    }
    await db.query('commit');
    console.log(`busy inbox: ${TOTAL} conversations (WhatsApp, Messenger, Instagram), ${msgCount} messages and notes; long threads ${longIds.join(', ')}`);
  } catch (e) {
    await db.query('rollback').catch(() => {});
    console.error(`seed-busy-inbox: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
