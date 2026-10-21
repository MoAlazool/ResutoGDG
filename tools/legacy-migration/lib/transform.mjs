// Pure transformation: legacy state document → rows for the Resuto 2.0 schema.
// No database access here; load.mjs writes the plan in one transaction.
import { createRequire } from 'node:module';
import { legacyName, sha256, uuidv5 } from './ids.mjs';

const require = createRequire(import.meta.url);
const contracts = require('../../../packages/contracts/dist/index.js');
const { LEGACY_ORDER_STATUS, derivePaymentStatus, COUNTRY_DEFAULTS } = contracts;

/** Legacy statuses without a direct 2.0 equivalent. Delivery progress lives in delivery_jobs in 2.0. */
export const EXTRA_ORDER_STATUS = { out_for_delivery: 'ready' };
const FULFILLMENT = { 'dine-in': 'dine_in', counter: 'pickup', pickup: 'pickup', delivery: 'delivery' };
const CHANNEL = { 'dine-in': 'qr', counter: 'qr', pickup: 'web', delivery: 'web' };
const KITCHEN = { awaiting_payment: 'queued', placed: 'queued', accepted: 'queued', preparing: 'preparing', ready: 'ready',
  served: 'served', picked_up: 'served', delivered: 'served', cancelled: 'cancelled' };
const SHAPE = { round: 'round', square: 'square', rectangle: 'rect', rect: 'rect', booth: 'booth', bar: 'bar' };
const RES_STATUS = new Set(['held', 'pending_deposit', 'confirmed', 'seated', 'completed', 'cancelled', 'no_show', 'expired']);
const FULFILLED = new Set(['served', 'picked_up', 'delivered']);

const json = (v) => JSON.stringify(v ?? null);
const ts = (ms) => (ms === undefined || ms === null || ms === '' ? null : new Date(typeof ms === 'number' ? ms : Date.parse(ms)));
const int = (v, d = 0) => (Number.isSafeInteger(v) ? v : d);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const slugify = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
const code = (s) => String(s).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'main';
const businessDate = (d, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

export function normalizePhone(v) {
  if (typeof v !== 'string') return null;
  let p = v.replace(/[\s()-]/g, '');
  if (p.startsWith('00')) p = `+${p.slice(2)}`;
  if (/^01\d{9}$/.test(p)) p = `+20${p.slice(1)}`;      // Egyptian mobile in local format
  return /^\+[1-9]\d{6,14}$/.test(p) ? p : null;
}
export const normalizeEmail = (v) => (typeof v === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim()) ? v.trim().toLowerCase() : null);

/**
 * Photos the legacy Smash & Co storefront showed for its menu items (legacy/public/burger.js PHOTOS): the storefront
 * rendered /assets/smash/<name>.webp for every burger-branch item, so these are that item's photo after cutover.
 */
export const LEGACY_STOREFRONT_PHOTOS = { b0: 'classic-smash', b1: 'double-smash', b2: 'crispy-chicken', b3: 'veggie-smash', b4: 'loaded-fries',
  b5: 'classic-fries', b6: 'onion-rings', b7: 'chocolate-shake', b8: 'cola' };
const MEDIA_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

/**
 * Where a legacy menu item's photo comes from (CR-13), or null when it has none to copy:
 *   { kind: 'media', key }     an upload in the legacy media store (imageMediaKey, or an imageUrl /media/<key>);
 *   { kind: 'asset', path }    a file the legacy app served from public/ (assets/…), including the storefront photos;
 *   { kind: 'inline', data }   a data: URL stored in the document.
 * An https URL is kept as products.image_url and not copied.
 */
export function mediaSourceOf(m, { storefrontPhotos = true } = {}) {
  const url = [m.imageMediaKey && `/media/${m.imageMediaKey}`, m.imageUrl, m.image].find((v) => typeof v === 'string' && v);
  if (url) {
    if (/^https:\/\//.test(url)) return null;
    const media = /^\/media\/([A-Za-z0-9._-]{1,200})$/.exec(url);
    if (media) return { kind: 'media', key: media[1], ext: media[1].split('.').pop().toLowerCase() };
    const asset = /^\/?(assets\/[A-Za-z0-9/._-]{1,200}\.(png|jpe?g|webp|gif))$/i.exec(url);
    if (asset && !asset[1].includes('..')) return { kind: 'asset', path: asset[1], ext: asset[2].toLowerCase() };
    const inline = /^data:(image\/(png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(url);
    if (inline) return { kind: 'inline', data: inline[3], ext: inline[2] === 'jpeg' ? 'jpg' : inline[2] };
    return { kind: 'unsupported', url: url.slice(0, 120) };
  }
  const branches = Array.isArray(m.branchIds) ? m.branchIds : [];
  if (storefrontPhotos && branches.includes('burger') && LEGACY_STOREFRONT_PHOTOS[m.id]) {
    return { kind: 'asset', path: `assets/smash/${LEGACY_STOREFRONT_PHOTOS[m.id]}.webp`, ext: 'webp', storefront: true };
  }
  return null;
}

/** Accepts the SQLite `state` JSON, a Firestore `restaurants/{id}/private/state` export ({state, revision, updatedAt}), or the fixture wrapper. */
export function readDocument(doc) {
  if (!doc || typeof doc !== 'object') throw new Error('Input is not a JSON object');
  const state = doc.state && typeof doc.state === 'object' && Array.isArray(doc.state.menu) ? doc.state : doc;
  if (!Array.isArray(state.menu) || !Array.isArray(state.tables) || !state.settings) throw new Error('Input does not look like a legacy Resuto state document');
  const meta = { ...(doc.restaurant ?? {}), ...(doc._fixture ?? {}) };
  return { state, meta };
}

/** Timestamp fields of the legacy state (epoch ms or ISO strings), per collection. */
export const LEGACY_TIME_FIELDS = {
  orders: ['created', 'fulfilledAt', 'cancelledAt', 'updated'], visits: ['created', 'closedAt'], reservations: ['start', 'end', 'expires', 'created'],
  payments: ['at'], requests: ['created', 'resolvedAt'], audit: ['at'],
};
const LEGACY_ACTIVE_ORDER = new Set(['awaiting_payment', 'placed', 'accepted', 'preparing', 'ready', 'out_for_delivery']);
const LEGACY_FULFILLED = { 'dine-in': 'served', counter: 'served', pickup: 'picked_up', delivery: 'delivered' };
const msOf = (v) => (v === undefined || v === null || v === '' ? null : typeof v === 'number' ? v : Date.parse(v));

/** The latest activity in the document (bookings in the future are not activity). Used as the anchor for --retime. */
export function lastActivity(s) {
  let max = null;
  for (const [kind, fields] of Object.entries(LEGACY_TIME_FIELDS)) {
    for (const x of s[kind] ?? []) for (const f of fields) {
      if (kind === 'reservations' && f !== 'expires' && f !== 'created') continue;
      const t = msOf(x[f]);
      if (Number.isFinite(t) && (max === null || t > max)) max = t;
    }
  }
  return max;
}

/**
 * Optional demo/rehearsal adjustments, applied to a COPY of the legacy state (the document is never modified and the
 * reconciliation still compares against the original):
 *   retimeTo (Date)            shifts every legacy timestamp by one offset so the latest activity lands at retimeTo;
 *                              relative spacing, weekdays-of-history and future bookings keep their shape.
 *   closeStaleAfterHours (n)   in-progress work older than n hours (relative to `now`) is imported as closed history:
 *                              a fully paid order is fulfilled, an unpaid one is cancelled, open visits close after their
 *                              last order, open calls are resolved, past bookings that never arrived become no-shows
 *                              (held/awaiting-deposit ones expire). Every change is reported as a warning.
 */
export function adjustLegacyState(s, { now = new Date(), retimeTo = null, closeStaleAfterHours = null } = {}, warnings = []) {
  const out = structuredClone(s);
  if (retimeTo) {
    const anchor = lastActivity(out);
    if (anchor !== null) {
      const delta = retimeTo.getTime() - anchor;
      for (const [kind, fields] of Object.entries(LEGACY_TIME_FIELDS)) {
        for (const x of out[kind] ?? []) for (const f of fields) {
          const t = msOf(x[f]);
          if (Number.isFinite(t)) x[f] = t + delta;
        }
      }
      warnings.push(`retimed: every legacy timestamp shifted by ${Math.round(delta / 3_600_000)} h (latest activity now ${new Date(anchor + delta).toISOString()})`);
    }
  }
  if (closeStaleAfterHours === null || closeStaleAfterHours === undefined) return out;
  const cutoff = now.getTime() - closeStaleAfterHours * 3_600_000;
  const stale = (t) => Number.isFinite(t) && t < cutoff;
  const paidFor = (visitId) => (out.payments ?? []).filter((p) => p.kind === 'bill' && p.visitId === visitId).reduce((n, p) => n + int(p.amount), 0);
  for (const v of out.visits ?? []) {
    const orders = out.orders.filter((o) => o.visitId === v.id);
    const due = orders.filter((o) => o.status !== 'cancelled').reduce((n, o) => n + int(o.total), 0) + (v.type === 'delivery' ? int(v.fee) : 0);
    const settled = int(v.credit) + paidFor(v.id) >= due;
    for (const o of orders) {
      if (!LEGACY_ACTIVE_ORDER.has(o.status) || !stale(msOf(o.created))) continue;
      const created = msOf(o.created);
      if (settled) {
        const to = LEGACY_FULFILLED[o.type ?? v.type] ?? 'served';
        warnings.push(`order ${o.id}: "${o.status}" for ${Math.round((now - created) / 3_600_000)} h → imported as ${to} (paid) history`);
        o.status = to; o.fulfilledAt = created + 45 * 60_000;
      } else {
        warnings.push(`order ${o.id}: "${o.status}" for ${Math.round((now - created) / 3_600_000)} h → imported as cancelled (unpaid, never completed)`);
        o.status = 'cancelled'; o.cancelledAt = created + 60 * 60_000;
        o.notes = [o.notes, 'Closed at migration: stale in-progress legacy order.'].filter(Boolean).join(' ');
      }
    }
    if (v.status === 'open' && !v.undone && stale(msOf(v.created))) {
      const last = Math.max(msOf(v.created), ...orders.map((o) => msOf(o.fulfilledAt) ?? msOf(o.cancelledAt) ?? msOf(o.created) ?? 0));
      v.status = 'closed'; v.closedAt = last + 30 * 60_000;
      warnings.push(`visit ${v.id}: open since ${new Date(msOf(v.created)).toISOString()} → imported as closed`);
    }
  }
  for (const o of out.orders) {          // orders without a visit
    if (o.visitId || !LEGACY_ACTIVE_ORDER.has(o.status) || !stale(msOf(o.created))) continue;
    warnings.push(`order ${o.id}: "${o.status}" without a visit → imported as cancelled`);
    o.status = 'cancelled'; o.cancelledAt = msOf(o.created) + 60 * 60_000;
  }
  for (const r of out.requests ?? []) {
    if (r.status !== 'open' || !stale(msOf(r.created))) continue;
    r.status = 'resolved'; r.resolvedAt = msOf(r.created) + 10 * 60_000;
    warnings.push(`request ${r.id}: open → imported as resolved`);
  }
  for (const r of out.reservations ?? []) {
    if (!['held', 'pending_deposit', 'confirmed'].includes(r.status) || !stale(msOf(r.start))) continue;
    const seated = (out.visits ?? []).some((v) => v.reservationId === r.id);
    const to = seated ? 'completed' : r.status === 'confirmed' ? 'no_show' : 'expired';
    warnings.push(`reservation ${r.id}: "${r.status}" after its start → imported as ${to}`);
    r.status = to;
  }
  return out;
}

/**
 * Builds the full migration plan. `options`: restaurantId, slug, name, nameAr, categoryNamesAr ({ English: Arabic }),
 * planId, subscriptionStatus ('trialing' | 'active'), ownerUserId, now (Date), retimeTo (Date), closeStaleAfterHours.
 */
export function buildPlan(doc, options = {}) {
  const { state: original, meta: docMeta } = readDocument(doc);
  const now = options.now ?? new Date();
  const meta = { ...docMeta, ...(options.nameAr ? { nameAr: options.nameAr } : {}) };
  const preWarnings = [];
  const s = adjustLegacyState(original, { now, retimeTo: options.retimeTo ?? null, closeStaleAfterHours: options.closeStaleAfterHours ?? null }, preWarnings);
  const restaurantId = options.restaurantId ?? meta.restaurantId ?? meta.id ?? slugify(s.settings?.name) ?? 'legacy';
  const id = (entity, legacyId) => uuidv5(legacyName(restaurantId, entity, legacyId));
  const country = 'EG';                                // legacy is EGP-only
  const { currency, timezone, vatRateBp, taxRegime } = COUNTRY_DEFAULTS[country];
  const warnings = [...preWarnings];
  const rows = {};
  const idMap = [];
  const after = [];
  const add = (table, row, map) => {
    (rows[table] ??= []).push(row);
    if (map) idMap.push({ entity: map[0], legacyId: String(map[1]), newId: row.id });
    return row;
  };

  // --- Organization ------------------------------------------------------------
  const orgId = id('organization', restaurantId);
  const slug = options.slug ?? meta.slug ?? slugify(s.settings?.name ?? restaurantId);
  const name = options.name ?? meta.name ?? s.settings?.name ?? 'Migrated restaurant';
  const stamp = now.toISOString();
  add('organizations', {
    id: orgId, slug, name, name_ar: meta.nameAr ?? null, country, currency, timezone, default_locale: s.profile?.language === 'ar' ? 'ar' : 'en',
    status: 'active', legacy_id: restaurantId,
    onboarding: json({ profile: stamp, branch: stamp, menu: stamp, floor: stamp, launched: stamp, migrated: stamp }),
  }, ['organization', restaurantId]);

  // --- Branches ----------------------------------------------------------------
  const legacyBranches = Array.isArray(s.branches) && s.branches.length ? s.branches
    : [{ id: 'main', name: s.settings?.branch ?? 'Main branch', active: true, pickup: true, delivery: !!s.settings?.deliveryEnabled, reservations: true }];
  const branchId = new Map();
  const usedCodes = new Set();
  for (const b of legacyBranches) {
    let c = code(b.id);
    while (usedCodes.has(c)) c = `${c.slice(0, 36)}-${usedCodes.size}`;
    usedCodes.add(c);
    const row = add('branches', {
      id: id('branch', b.id), org_id: orgId, code: c, name: String(b.name ?? b.id).slice(0, 120), name_ar: b.nameAr ?? null,
      address: b.address ?? (b.id === 'main' ? s.settings?.branch ?? null : null), phone: b.phone ?? null, is_active: b.active !== false,
      accepts_dine_in: b.id === 'main' ? s.settings?.serviceMode !== 'delivery' : s.tables.some((t) => (t.branchId ?? 'main') === b.id),
      accepts_pickup: !!b.pickup, accepts_delivery: !!b.delivery, accepts_reservations: !!b.reservations,
      delivery_fee_minor: b.delivery ? Math.max(0, int(s.settings?.deliveryFee)) : 0,
      reservation_duration_min: clamp(int(s.settings?.duration, 90), 15, 600), reservation_buffer_min: clamp(int(s.settings?.buffer, 15), 0, 240),
      reservation_deposit_minor: b.reservations ? Math.max(0, int(s.settings?.deposit)) : 0, legacy_id: b.id,
    }, ['branch', b.id]);
    branchId.set(b.id, row.id);
  }
  const mainBranch = branchId.get('main') ?? rows.branches[0].id;
  const branchOf = (legacy) => branchId.get(legacy ?? 'main') ?? mainBranch;

  // --- Subscription and the defaults OrganizationsService.create provides --------------
  const planId = options.planId ?? meta.plan ?? 'free';
  const paid = planId !== 'free';
  const status = options.subscriptionStatus ?? (paid ? 'trialing' : 'active');
  const subId = id('subscription', 'current');
  const periodEnd = new Date(now); periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);
  add('subscriptions', {
    id: subId, org_id: orgId, plan_id: planId, status, billing_interval: 'month', country, currency,
    current_period_start: now, current_period_end: periodEnd, trial_ends_at: status === 'trialing' ? new Date(now.getTime() + 14 * 864e5) : null,
  }, ['subscription', 'current']);
  add('subscription_events', { _parent: subId, org_id: orgId, subscription_id: subId, event_type: 'created', to_plan_id: planId,
    details: json({ source: 'legacy-migration', status, ...(options.subscriptionNote ? { note: options.subscriptionNote } : {}) }) });
  add('tax_profiles', { id: id('tax_profile', 'current'), org_id: orgId, country, regime: taxRegime, vat_rate_bp: vatRateBp, prices_include_tax: true });
  const websiteId = id('website', 'current');
  add('websites', { id: websiteId, org_id: orgId, seo: json({ title: { en: name, ar: meta.nameAr ?? name } }) });
  ['hero', 'menu_highlights', 'reservations', 'ordering', 'location'].forEach((kind, i) => add('website_sections', {
    id: id('website_section', kind), org_id: orgId, website_id: websiteId, kind, sort_order: i,
    content: json(kind === 'hero' ? { headline: { en: name, ar: meta.nameAr ?? name } } : {}),
  }));
  [['Ingredients', 'المكونات', 'cogs'], ['Salaries', 'الرواتب', 'labor'], ['Rent', 'الإيجار', 'rent'], ['Utilities', 'المرافق', 'utilities'],
    ['Marketing', 'التسويق', 'marketing'], ['Delivery', 'التوصيل', 'delivery'], ['Payment fees', 'رسوم الدفع', 'fees'], ['Other', 'أخرى', 'other']]
    .forEach(([n, ar, kind]) => add('expense_categories', { id: id('expense_category', kind), org_id: orgId, name: n, name_ar: ar, kind }));
  if (options.ownerUserId) {
    add('memberships', { id: id('membership', `owner:${options.ownerUserId}`), org_id: orgId, user_id: options.ownerUserId, role: 'owner' });
  }

  // --- Catalog -------------------------------------------------------------------
  const menuId = add('menus', { id: id('menu', 'main'), org_id: orgId, name: 'Main menu', name_ar: 'القائمة الرئيسية' }, ['menu', 'main']).id;
  const categoryId = new Map();
  const productId = new Map();
  const media = [];              // legacy photos to copy into tenant storage (CR-13), written by load.mjs
  const groupFor = new Map();     // `${item}:${modifier}` → { groupId, optionId, group }
  s.menu.forEach((m, index) => {
    const cat = String(m.category ?? 'Menu').trim() || 'Menu';
    if (!categoryId.has(cat)) {
      categoryId.set(cat, add('menu_categories', { id: id('category', cat), org_id: orgId, menu_id: menuId, name: cat.slice(0, 80),
        name_ar: options.categoryNamesAr?.[cat] ?? m.categoryAr ?? null, default_station: m.station ?? null,
        sort_order: categoryId.size }, ['category', cat]).id);
    }
    const pid = add('products', {
      id: id('product', m.id), org_id: orgId, category_id: categoryId.get(cat), name: String(m.name).slice(0, 120), name_ar: m.nameAr || null,
      description: m.description ? String(m.description).slice(0, 1000) : null, description_ar: m.descriptionAr ? String(m.descriptionAr).slice(0, 1000) : null,
      price_minor: Math.max(0, int(m.price)), currency, station: m.station || 'Kitchen',
      prep_minutes: Number.isSafeInteger(m.prepMinutes) ? clamp(m.prepMinutes, 0, 600) : null, spice_level: clamp(int(m.spice), 0, 3),
      dietary: m.dietary ?? (m.vegetarian ? ['vegetarian'] : []), allergens: m.allergens ?? [], ingredients: m.ingredients ?? [],
      image_url: [m.imageUrl, m.image].find((v) => typeof v === 'string' && /^https:\/\//.test(v)) ?? null,
      is_active: true, track_stock: Number.isSafeInteger(m.stock), sort_order: index, legacy_id: m.id, version: int(m.version),
    }, ['product', m.id]).id;
    productId.set(m.id, pid);
    const source = mediaSourceOf(m, { storefrontPhotos: options.storefrontPhotos !== false });
    if (source?.kind === 'unsupported') warnings.push(`menu item ${m.id}: legacy image "${source.url}" is not a media key, asset or https URL; not copied`);
    else if (source) {
      const ext = MEDIA_TYPES[source.ext] ? source.ext : 'webp';
      media.push({ id: id('media', `menu:${m.id}`), productId: pid, legacyItem: m.id, source, contentType: MEDIA_TYPES[ext],
        objectPath: `${orgId}/menu/legacy-${m.id}.${ext === 'jpeg' ? 'jpg' : ext}`, alt: String(m.name).slice(0, 200) });
    }
    const listed = Array.isArray(m.branchIds) && m.branchIds.length ? m.branchIds : ['main'];
    for (const lb of legacyBranches) {
      const inBranch = listed.includes(lb.id);
      // Legacy stock is one tenant-wide number: it goes to the first listed branch.
      add('product_branch_settings', { org_id: orgId, product_id: pid, branch_id: branchOf(lb.id), is_available: inBranch && m.available !== false,
        stock_qty: inBranch && lb.id === listed[0] && Number.isSafeInteger(m.stock) ? Math.max(0, m.stock) : null });
    }
    if (listed.length > 1 && Number.isSafeInteger(m.stock)) warnings.push(`menu item ${m.id}: tenant-wide stock assigned to branch "${listed[0]}" only`);
    const mods = Array.isArray(m.modifiers) ? m.modifiers : [];
    const optional = mods.filter((x) => !x.required);
    const groups = [];
    if (optional.length) groups.push({ key: `${m.id}:options`, name: 'Options', nameAr: 'الخيارات', min: 0, max: optional.length, items: optional });
    for (const r of mods.filter((x) => x.required)) groups.push({ key: `${m.id}:required:${r.id}`, name: r.name, nameAr: r.nameAr ?? null, min: 1, max: 1, items: [r] });
    groups.forEach((g, gi) => {
      const gid = add('modifier_groups', { id: id('modifier_group', g.key), org_id: orgId, name: g.name, name_ar: g.nameAr, min_select: g.min, max_select: g.max }, ['modifier_group', g.key]).id;
      add('product_modifier_groups', { org_id: orgId, product_id: pid, group_id: gid, sort_order: gi });
      g.items.forEach((o, oi) => {
        const oid = add('modifier_options', { id: id('modifier_option', `${m.id}:${o.id}`), org_id: orgId, group_id: gid, name: o.name, name_ar: o.nameAr ?? null,
          price_delta_minor: Math.max(0, int(o.price)), is_available: o.available !== false, sort_order: oi }, ['modifier_option', `${m.id}:${o.id}`]).id;
        groupFor.set(`${m.id}:${o.id}`, { groupId: gid, optionId: oid, group: g.name });
      });
    });
    if ((m.variants?.length ?? 0) || (m.addons?.length ?? 0)) warnings.push(`menu item ${m.id}: legacy variants/addons are not mapped (none in the demo data)`);
  });

  // --- Floor and tables ------------------------------------------------------------
  const floor = s.floor ?? {};
  for (const b of legacyBranches) {
    const isMain = b.id === (legacyBranches.find((x) => x.id === 'main')?.id ?? legacyBranches[0].id);
    add('floor_layouts', {
      id: id('floor_layout', b.id), org_id: orgId, branch_id: branchOf(b.id), schema_version: 2, revision: isMain ? int(floor.revision) : 0,
      width: isMain ? int(floor.width, 1200) : 1200, height: isMain ? int(floor.height, 800) : 800,
      background: json(isMain ? floor.background ?? {} : {}), zones: json(isMain ? floor.zones ?? [] : []), objects: json(isMain ? floor.objects ?? [] : []),
    }, ['floor_layout', b.id]);
  }
  const openVisitTables = new Set(s.visits.filter((v) => v.status === 'open' && v.tableId && !v.undone).map((v) => v.tableId));
  const tableId = new Map();
  for (const t of s.tables) {
    if (typeof t.qr !== 'string' || t.qr.length < 16) throw new Error(`table ${t.id}: QR token missing or too short — refusing to invent one`);
    const row = add('dining_tables', {
      id: id('table', t.id), org_id: orgId, branch_id: branchOf(t.branchId), label: String(t.label).slice(0, 20), capacity: clamp(int(t.capacity, 2), 1, 50),
      zone: t.zone ?? null, shape: SHAPE[t.shape] ?? 'square', cx: Number(t.cx ?? (t.x ?? 50) * 12), cy: Number(t.cy ?? (t.y ?? 50) * 8),
      width: Number(t.width ?? 110), height: Number(t.height ?? 110), rotation: Number(t.rotation ?? 0), features: t.features ?? [],
      is_reservable: t.reservable !== false, min_spend_minor: Number.isSafeInteger(t.minimumSpend) && t.minimumSpend > 0 ? t.minimumSpend : null,
      is_premium: !!t.premium, internal_notes: t.internalNotes || null,
      qr_token: t.qr,                                   // verbatim: printed QR codes keep working
      status: t.active === false ? 'out_of_service' : t.cleaning ? 'cleaning' : openVisitTables.has(t.id) ? 'occupied' : 'available',
      is_active: t.active !== false, archived_at: t.active === false ? now : null, legacy_id: t.id, version: int(t.version),
    }, ['table', t.id]);
    tableId.set(t.id, row.id);
  }
  // The legacy venue QR (printed counter codes: <origin>/t/<venueQr>) maps to the main branch; the public venue route
  // (FT-07, GET /v1/public/venue/:token) resolves it to that branch's ordering page, so printed codes keep working.
  if (s.settings?.venueQr) idMap.push({ entity: 'venue_qr', legacyId: s.settings.venueQr, newId: mainBranch });

  // --- Customers (derived from contacts) ---------------------------------------------------------
  const customers = new Map();
  const customerFor = (contact, displayName, seen) => {
    const at = seen && seen > now ? now : seen;     // a booking in the future is not a visit in the future
    const phone = normalizePhone(contact);
    const email = phone ? null : normalizeEmail(contact);
    if (!phone && !email) return null;
    const key = phone ?? email;
    let c = customers.get(key);
    if (!c) {
      c = add('customers', { id: id('customer', key), org_id: orgId, display_name: displayName ? String(displayName).slice(0, 120) : null,
        phone_e164: phone, email, first_seen_at: at ?? now, last_seen_at: at ?? now, legacy_id: `contact:${key}` }, ['customer', key]);
      add('customer_identities', { id: id('customer_identity', key), org_id: orgId, customer_id: c.id, kind: phone ? 'phone' : 'email', value: key });
      customers.set(key, c);
    } else if (at) {
      if (at < c.first_seen_at) c.first_seen_at = at;
      if (at > c.last_seen_at) c.last_seen_at = at;
    }
    return c.id;
  };

  // --- Reservations --------------------------------------------------------------------------
  const duration = clamp(int(s.settings?.duration, 90), 15, 600);
  const reservationId = new Map();
  const depositPaid = new Set(s.payments.filter((p) => p.kind === 'deposit' && p.reservationId).map((p) => p.reservationId));
  for (const r of s.reservations) {
    const starts = ts(r.start);
    const blocked = ts(r.end) ?? new Date(starts.getTime() + (duration + int(s.settings?.buffer, 15)) * 60000);
    const ends = new Date(Math.min(starts.getTime() + duration * 60000, blocked.getTime()));
    const st = RES_STATUS.has(r.status) ? r.status : (warnings.push(`reservation ${r.id}: unknown status "${r.status}" → cancelled`), 'cancelled');
    const table = s.tables.find((t) => t.id === r.tableId);
    const visit = s.visits.find((v) => v.reservationId === r.id);
    const deposit = Math.max(0, int(r.deposit));
    const depositStatus = !deposit ? 'none' : !depositPaid.has(r.id) ? 'required' : visit && visit.credit > 0 ? 'applied' : 'paid';
    const row = add('reservations', {
      id: id('reservation', r.id), org_id: orgId, branch_id: branchOf(table?.branchId), table_id: tableId.get(r.tableId) ?? null,
      customer_id: customerFor(r.contact, r.name, starts),
      code: `L${sha256(`${restaurantId}:${r.id}`).slice(0, 7).toUpperCase()}`, access_token_hash: r.token ? sha256(r.token) : null,
      guest_name: String(r.name ?? 'Guest').slice(0, 100) || 'Guest', guest_phone: normalizePhone(r.contact), guest_email: normalizeEmail(r.contact),
      party_size: clamp(int(r.party, 1), 1, 50), starts_at: starts, ends_at: ends, blocked_until: blocked, status: st,
      hold_expires_at: st === 'held' ? ts(r.expires) : null, deposit_minor: deposit, deposit_status: depositStatus, source: 'legacy',
      notes: r.notes ? String(r.notes).slice(0, 500) : null, legacy_id: r.id,
    }, ['reservation', r.id]);
    reservationId.set(r.id, row.id);
  }

  // --- Visits (table sessions) ----------------------------------------------------------------
  const visitId = new Map();
  const visitRows = new Map();
  for (const v of s.visits) {
    if (!v.tableId || !tableId.has(v.tableId)) continue;    // pickup/delivery/counter "visits" become order fields
    const closed = v.status !== 'open' || !!v.undone;
    const reservation = v.reservationId ? s.reservations.find((r) => r.id === v.reservationId) : null;
    const row = add('visits', {
      id: id('visit', v.id), org_id: orgId, branch_id: branchOf(v.branchId), table_id: tableId.get(v.tableId), reservation_id: reservationId.get(v.reservationId) ?? null,
      customer_id: reservation ? customerFor(reservation.contact, reservation.name, ts(v.created)) : null, party_size: reservation ? clamp(int(reservation.party, 1), 1, 100) : null,
      status: closed ? 'closed' : 'open', guest_token_hash: sha256(v.token ?? `legacy-visit:${v.id}`), opened_at: ts(v.created) ?? now,
      closed_at: closed ? ts(v.closedAt) ?? ts(v.created) ?? now : null, credit_minor: Math.max(0, int(v.credit)), credit_used_minor: 0, legacy_id: v.id,
    }, ['visit', v.id]);
    visitId.set(v.id, row.id);
    visitRows.set(v.id, row);
    if (row.reservation_id) after.push({ sql: 'update reservations set seated_visit_id = $1 where id = $2 and seated_visit_id is null', params: [row.id, row.reservation_id] });
  }

  // --- Orders ---------------------------------------------------------------------------------------
  const orderRows = new Map();
  const ordersByVisit = new Map();
  const feeTaken = new Set();
  for (const o of [...s.orders].sort((a, b) => (a.created ?? 0) - (b.created ?? 0) || String(a.id).localeCompare(String(b.id)))) {
    const v = s.visits.find((x) => x.id === o.visitId);
    const type = o.type ?? v?.type ?? 'dine-in';
    const legacyStatus = o.status;
    const status = LEGACY_ORDER_STATUS[legacyStatus] ?? EXTRA_ORDER_STATUS[legacyStatus];
    if (!status) throw new Error(`order ${o.id}: unknown legacy status "${legacyStatus}"`);
    if (EXTRA_ORDER_STATUS[legacyStatus]) warnings.push(`order ${o.id}: status "${legacyStatus}" mapped to "${status}" (delivery progress is tracked by ResutoDriver in 2.0)`);
    let fulfillment = FULFILLMENT[type] ?? 'pickup';
    const tId = tableId.get(o.tableId ?? v?.tableId) ?? null;
    if (fulfillment === 'dine_in' && !tId) { fulfillment = 'pickup'; warnings.push(`order ${o.id}: dine-in without a table → pickup`); }
    const placed = ts(o.created) ?? now;
    const fee = v && !feeTaken.has(v.id) && fulfillment === 'delivery' ? Math.max(0, int(v.fee)) : 0;
    if (fee) feeTaken.add(v.id);
    const lines = (o.lines ?? []).map((l, i) => {
      const options = Array.isArray(l.options) ? l.options : [];
      const modsTotal = options.reduce((n, x) => n + Math.max(0, int(x.price)), 0);
      const qty = clamp(int(l.qty, 1), 1, 99);
      const unit = Math.max(0, int(l.price) - modsTotal);
      if (!productId.has(l.id)) warnings.push(`order ${o.id}: line ${i} references unknown menu item "${l.id}" (snapshot kept, product unlinked)`);
      return {
        id: id('order_line', `${o.id}:${i}`), org_id: orgId, order_id: id('order', o.id), product_id: productId.get(l.id) ?? null,
        name: String(l.name ?? 'Item').slice(0, 200), name_ar: l.nameAr ?? null, unit_price_minor: unit, quantity: qty,
        modifiers: json(options.map((x) => {
          const g = groupFor.get(`${l.id}:${x.id}`);
          return { groupId: g?.groupId ?? null, group: g?.group ?? 'Options', optionId: g?.optionId ?? null, option: x.name, optionAr: null, priceDeltaMinor: Math.max(0, int(x.price)) };
        })),
        modifiers_total_minor: modsTotal, line_total_minor: (unit + modsTotal) * qty, station: l.station || 'Kitchen',
        kitchen_status: KITCHEN[status], created_at: placed,
      };
    });
    const subtotal = lines.reduce((n, l) => n + l.line_total_minor, 0);
    if (subtotal !== int(o.total, subtotal)) warnings.push(`order ${o.id}: legacy total ${o.total} differs from its lines (${subtotal}); lines win`);
    const contact = v?.contact ?? o.contact;
    const row = add('orders', {
      id: id('order', o.id), org_id: orgId, branch_id: branchOf(o.branchId ?? v?.branchId), number: String(o.number ?? s.orders.indexOf(o) + 1),
      business_date: businessDate(placed, timezone), public_ref: sha256(`${restaurantId}:order:${o.id}`).slice(0, 18),
      channel: CHANNEL[type] ?? 'web', fulfillment, status, payment_status: 'unpaid', visit_id: visitId.get(o.visitId) ?? null, table_id: tId,
      customer_id: customerFor(contact, o.name ?? v?.name, placed), customer_name: o.name ? String(o.name).slice(0, 120) : null,
      customer_phone: normalizePhone(contact), delivery_address: fulfillment === 'delivery' ? json({ line1: v?.address || 'Address not recorded (legacy)', area: v?.area ?? null }) : null,
      currency, subtotal_minor: subtotal, discount_minor: 0, delivery_fee_minor: fee, service_charge_minor: 0, tax_minor: 0, tax_inclusive: true,
      total_minor: subtotal + fee, paid_minor: 0, refunded_minor: 0, notes: o.notes ? String(o.notes).slice(0, 500) : null,
      placed_at: placed, fulfilled_at: FULFILLED.has(status) ? ts(o.fulfilledAt) ?? placed : null,
      cancelled_at: status === 'cancelled' ? ts(o.cancelledAt) ?? placed : null, legacy_id: o.id, version: int(o.version),
      attribution: json({ legacy: { status: legacyStatus, type } }),
    }, ['order', o.id]);
    lines.forEach((l, i) => add('order_lines', l, ['order_line', `${o.id}:${i}`]));
    add('order_events', { _parent: row.id, org_id: orgId, order_id: row.id, event_type: 'migrated', from_status: null, to_status: status, actor_type: 'system',
      actor_id: 'legacy-migration', details: json({ legacyStatus, legacyNumber: o.number ?? null }), created_at: placed });
    orderRows.set(o.id, row);
    const key = o.visitId ?? `order:${o.id}`;
    if (!ordersByVisit.has(key)) ordersByVisit.set(key, []);
    ordersByVisit.get(key).push(row);
  }
  for (const a of s.audit ?? []) {
    const order = orderRows.get(a.entity);
    if (order) {
      add('order_events', { _parent: order.id, org_id: orgId, order_id: order.id, event_type: 'legacy_audit', actor_type: 'system', actor_id: 'legacy',
        details: json({ message: a.type, legacyAuditId: a.id }), created_at: ts(a.at) ?? now });
    } else {
      add('audit_logs', { _parent: orgId, org_id: orgId, actor_type: 'system', actor_id: 'legacy', action: `legacy.${slugify(a.type).replace(/-/g, '_') || 'event'}`,
        entity_type: 'legacy', entity_id: a.entity ? String(a.entity) : null, source: 'migration', metadata: json({ message: a.type, legacyAuditId: a.id }), created_at: ts(a.at) ?? now });
    }
  }

  // --- Payments, allocations, refunds ------------------------------------------------------------------
  const due = (o) => o.total_minor - o.paid_minor;
  const allocate = (payment, targets) => {
    let remaining = payment.amount_minor;
    for (const o of targets.filter((x) => x.status !== 'cancelled')) {
      if (!remaining) break;
      const take = Math.min(remaining, due(o));
      if (take <= 0) continue;
      remaining -= take;
      o.paid_minor += take;
      add('payment_allocations', { _parent: payment.id, org_id: orgId, payment_id: payment.id, order_id: o.id, amount_minor: take, kind: 'payment', created_at: payment.created_at });
    }
    if (remaining) warnings.push(`payment ${payment.legacy_id}: ${remaining} could not be allocated to an order (legacy overpayment)`);
  };
  const paymentBase = (p, extra) => ({
    org_id: orgId, currency, status: 'succeeded', refunded_minor: 0, captured_at: ts(p.at) ?? now, created_at: ts(p.at) ?? now, legacy_id: p.id,
    raw: json({ legacy: { kind: p.kind, provider: p.provider ?? null, providerId: p.providerId ?? null, shareId: p.shareId ?? null } }), ...extra,
  });
  const methodOf = (p) => (['stripe', 'paymob'].includes(p.provider)
    ? { method: 'card', provider: p.provider, is_test: false }
    : { method: 'test', provider: 'simulated', is_test: true });   // legacy demo / test payments never moved money
  const depositPayment = new Map();

  // Deposit credit applied to table bills (legacy: visit.credit counts toward the bill before other payments).
  for (const v of s.visits) {
    const row = visitRows.get(v.id);
    if (!row || !(row.credit_minor > 0)) continue;
    const orders = ordersByVisit.get(v.id) ?? [];
    const total = orders.filter((o) => o.status !== 'cancelled').reduce((n, o) => n + o.total_minor, 0);
    const used = Math.min(row.credit_minor, total);
    row.credit_used_minor = used;
    const resRow = rows.reservations?.find((r) => r.id === row.reservation_id);
    if (resRow) resRow.deposit_credit_used_minor = Math.min(used, resRow.deposit_minor);
    if (!used) continue;
    const p = add('payments', { id: id('payment', `credit:${v.id}`), branch_id: row.branch_id, visit_id: row.id, reservation_id: row.reservation_id,
      method: 'deposit_credit', provider: 'deposit_credit', amount_minor: used, is_test: true,
      ...paymentBase({ id: `credit:${v.id}`, at: v.created, kind: 'deposit_credit' }, {}) }, ['payment', `credit:${v.id}`]);
    allocate(p, orders);
  }
  for (const p of [...s.payments].sort((a, b) => (a.at ?? 0) - (b.at ?? 0))) {
    if (!(int(p.amount) > 0)) { warnings.push(`payment ${p.id}: non-positive amount skipped`); continue; }
    if (p.kind === 'deposit') {
      const r = s.reservations.find((x) => x.id === p.reservationId);
      const table = r && s.tables.find((t) => t.id === r.tableId);
      if (!r || !reservationId.has(r.id)) { warnings.push(`payment ${p.id}: deposit for unknown reservation`); continue; }
      const row = add('payments', { id: id('payment', p.id), branch_id: branchOf(table?.branchId), reservation_id: reservationId.get(r.id), amount_minor: int(p.amount),
        ...methodOf(p), provider_payment_id: p.providerId ?? null, ...paymentBase(p, {}) }, ['payment', p.id]);
      depositPayment.set(r.id, row);
      continue;
    }
    if (p.kind === 'test-refund') {
      const v = s.visits.find((x) => x.id === p.visitId);
      const dep = v?.reservationId ? depositPayment.get(v.reservationId) : null;
      if (!dep) { warnings.push(`payment ${p.id}: refund without a migrated deposit`); continue; }
      const amount = Math.min(int(p.amount), dep.amount_minor - dep.refunded_minor);
      dep.refunded_minor += amount;
      dep.status = dep.refunded_minor >= dep.amount_minor ? 'refunded' : 'partially_refunded';
      add('refunds', { id: id('refund', p.id), org_id: orgId, payment_id: dep.id, amount_minor: amount, reason: 'Unused reservation deposit credit (legacy simulated refund)',
        status: 'succeeded', idempotency_key: `legacy:${p.id}`, created_at: ts(p.at) ?? now, completed_at: ts(p.at) ?? now }, ['refund', p.id]);
      continue;
    }
    // bill
    const v = s.visits.find((x) => x.id === p.visitId);
    const targets = ordersByVisit.get(p.visitId) ?? [];
    const vRow = visitRows.get(p.visitId);
    if (!v || (!vRow && !targets.length)) { warnings.push(`payment ${p.id}: bill payment for unknown visit`); continue; }
    const row = add('payments', { id: id('payment', p.id), branch_id: vRow?.branch_id ?? targets[0].branch_id, visit_id: vRow?.id ?? null,
      order_id: vRow ? null : targets.length === 1 ? targets[0].id : targets[0].id, amount_minor: int(p.amount), ...methodOf(p),
      provider_payment_id: p.providerId ?? null, ...paymentBase(p, {}) }, ['payment', p.id]);
    allocate(row, targets);
  }
  for (const o of orderRows.values()) o.payment_status = derivePaymentStatus(o.total_minor, o.paid_minor, o.refunded_minor);

  // --- Service requests ------------------------------------------------------------------------------
  for (const r of s.requests ?? []) {
    const v = visitRows.get(r.visitId);
    if (!v) { warnings.push(`request ${r.id}: visit not migrated (not a table visit)`); continue; }
    const kind = ['waiter', 'bill', 'help'].includes(r.type) ? r.type : 'help';
    const resolved = r.status !== 'open' || v.status === 'closed';
    add('service_requests', { id: id('service_request', r.id), org_id: orgId, branch_id: v.branch_id, visit_id: v.id, kind,
      status: resolved ? 'resolved' : 'open', created_at: ts(r.created) ?? now, resolved_at: resolved ? ts(r.resolvedAt) ?? ts(r.created) ?? now : null }, ['service_request', r.id]);
  }

  // --- Order counters: continue numbering today without colliding with migrated numbers -------------------
  const today = businessDate(now, timezone);
  for (const b of rows.branches) {
    const todays = (rows.orders ?? []).filter((o) => o.branch_id === b.id && o.business_date === today).map((o) => Number(o.number)).filter(Number.isSafeInteger);
    add('order_counters', { branch_id: b.id, org_id: orgId, day: today, value: todays.length ? Math.max(...todays) : 0 });
  }

  for (const kind of ['splits', 'shares', 'ratings', 'checkouts', 'salesInquiries']) {
    const n = Array.isArray(s[kind]) ? s[kind].length : 0;
    if (n) warnings.push(`${n} legacy ${kind} not migrated (no 2.0 equivalent in this tool yet)`);
  }
  add('audit_logs', { _parent: orgId, org_id: orgId, actor_type: 'system', actor_id: 'legacy-migration', action: 'organization.migrated', entity_type: 'organization',
    entity_id: orgId, source: 'migration', metadata: json({ restaurantId, warnings: warnings.length }), created_at: now });

  const legacy = legacyMetrics(original, { tableId, visitRows });
  legacy.media = media.length;
  legacy.venue_qr_tokens = s.settings?.venueQr ? [s.settings.venueQr] : [];
  return { orgId, restaurantId, slug, rows, idMap, after, warnings, media, legacy };
}

/** Totals computed directly from the legacy document, used for reconciliation. */
export function legacyMetrics(s, ctx) {
  const sum = (xs, f) => xs.reduce((n, x) => n + f(x), 0);
  const visitTotal = (v) => sum(s.orders.filter((o) => o.visitId === v.id && o.status !== 'cancelled'), (o) => int(o.total));
  const bills = s.payments.filter((p) => p.kind === 'bill');
  const deposits = s.payments.filter((p) => p.kind === 'deposit');
  const refunds = s.payments.filter((p) => p.kind === 'test-refund');
  const visitsWithOrders = s.visits.filter((v) => s.orders.some((o) => o.visitId === v.id));
  // Legacy bill: total = Σ non-cancelled orders + fee; settled = min(total, credit + Σ bill payments).
  const settled = sum(visitsWithOrders, (v) => {
    const fee = v.type === 'delivery' ? int(v.fee) : 0;
    return Math.min(visitTotal(v) + fee, int(v.credit) + sum(bills.filter((p) => p.visitId === v.id), (p) => int(p.amount)));
  });
  const contacts = new Set();
  const orderContacts = s.orders.map((o) => s.visits.find((v) => v.id === o.visitId)?.contact ?? o.contact);
  for (const c of [...s.reservations.map((r) => r.contact), ...orderContacts]) {
    const k = normalizePhone(c) ?? normalizeEmail(c);
    if (k) contacts.add(k);
  }
  const deliveryFees = sum(visitsWithOrders.filter((v) => v.type === 'delivery'), (v) => int(v.fee));
  return {
    branches: (s.branches?.length || 1),
    menu_categories: new Set(s.menu.map((m) => String(m.category ?? 'Menu').trim() || 'Menu')).size,
    products: s.menu.length,
    modifier_options: sum(s.menu, (m) => (m.modifiers ?? []).length),
    tables: s.tables.length,
    qr_tokens: s.tables.map((t) => t.qr).sort(),
    floor_zones: (s.floor?.zones ?? []).length,
    floor_objects: (s.floor?.objects ?? []).length,
    visits: s.visits.filter((v) => v.tableId && ctx.tableId.has(v.tableId)).length,
    orders: s.orders.length,
    order_lines: sum(s.orders, (o) => (o.lines ?? []).length),
    order_items_minor: sum(s.orders, (o) => int(o.total)),
    order_totals_minor: sum(s.orders, (o) => int(o.total)) + deliveryFees,
    orders_settled_minor: settled,
    bill_payments: bills.length,
    bill_payments_minor: sum(bills, (p) => int(p.amount)),
    deposit_payments: deposits.length,
    deposit_payments_minor: sum(deposits, (p) => int(p.amount)),
    deposit_refunds_minor: sum(refunds, (p) => int(p.amount)),
    provider_references: bills.concat(deposits).filter((p) => p.providerId).map((p) => p.providerId).sort(),
    reservations: s.reservations.length,
    reservation_deposits_minor: sum(s.reservations, (r) => Math.max(0, int(r.deposit))),
    service_requests: (s.requests ?? []).filter((r) => ctx.visitRows.has(r.visitId)).length,
    customers: contacts.size,
  };
}
