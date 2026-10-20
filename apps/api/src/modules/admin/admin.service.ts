import { Injectable } from '@nestjs/common';
import {
  COUNTRY_DEFAULTS, MODULE_KEYS, PLATFORM_ROLE_CAPABILITIES,
  type AdminOperations, type AdminPriceRow, type AdminPrices, type AdminTenantDetail, type AdminTenantRow, type AdminTenantsQuery,
  type GrantOverride, type ModuleKey, type NewModulePrice, type NewPlanPrice, type Page, type PlatformRole,
} from '@resuto/contracts';
import type { AuthPrincipal } from '../../common/auth/context';
import { DbService, type Tx } from '../../common/db/db.service';
import { EntitlementsService } from '../../common/entitlements/entitlements.service';
import { conflict, forbidden, invalid, notFound } from '../../common/errors/domain-error';
import { TenantStatusService } from './tenant-status.service';

export interface PlatformAdminActor { userId: string; role: PlatformRole }

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const encodeCursor = (createdAt: Date, id: string) => Buffer.from(`${new Date(createdAt).toISOString()}|${id}`).toString('base64url');
function decodeCursor(c: string | undefined): [string, string] | [null, null] {
  if (!c) return [null, null];
  const [at, id] = Buffer.from(c, 'base64url').toString('utf8').split('|');
  if (!at || !id || !UUID.test(id) || Number.isNaN(Date.parse(at))) throw invalid('invalid_cursor', 'Invalid cursor');
  return [at, id];
}

const tenantRow = (r: any): AdminTenantRow => ({
  id: r.id, name: r.name, nameAr: r.name_ar, slug: r.slug, country: r.country, status: r.status,
  planId: r.plan_id ?? null, subscriptionStatus: r.sub_status ?? null, createdAt: iso(r.created_at)!, lastOrderAt: iso(r.last_order_at),
  counts: { branches: Number(r.branches), members: Number(r.members), orders30d: Number(r.orders30d) },
});

const TENANT_SELECT = `
  select o.id, o.name, o.name_ar, o.slug, o.country, o.status, o.timezone, o.created_at, s.plan_id, s.status as sub_status,
         (select max(placed_at) from orders where org_id = o.id) as last_order_at,
         (select count(*) from branches b where b.org_id = o.id and b.is_active) as branches,
         (select count(*) from memberships m where m.org_id = o.id and m.status = 'active') as members,
         (select count(*) from orders x where x.org_id = o.id and x.placed_at > now() - interval '30 days') as orders30d
    from organizations o
    left join lateral (select plan_id, status from subscriptions where org_id = o.id
                        order by (status <> 'canceled') desc, created_at desc limit 1) s on true`;

/**
 * Resuto platform administration. Runs in platform context (no tenant RLS)
 * and therefore returns only the summaries listed in the contracts — counts,
 * statuses and health — never tenant business records or credentials. Every
 * mutation is audited with actor_type 'platform_admin' and the target org.
 */
@Injectable()
export class AdminService {
  constructor(private readonly db: DbService, private readonly entitlements: EntitlementsService, private readonly tenantStatus: TenantStatusService) {}

  async actor(principal: AuthPrincipal): Promise<PlatformAdminActor> {
    if (principal.kind !== 'user') throw forbidden('Platform administrators only');
    const row = await this.db.withPlatform((tx) => tx.maybeOne<{ role: PlatformRole }>('select role from platform_admins where user_id = $1', [principal.userId]));
    if (!row) throw forbidden('Platform administrators only');
    return { userId: principal.userId, role: row.role };
  }

  can(actor: PlatformAdminActor, cap: (typeof PLATFORM_ROLE_CAPABILITIES)['superadmin'][number]) {
    return PLATFORM_ROLE_CAPABILITIES[actor.role].includes(cap);
  }

  // ---------------------------------------------------------------------------
  // Tenants
  // ---------------------------------------------------------------------------
  async listTenants(q: AdminTenantsQuery): Promise<Page<AdminTenantRow>> {
    const [cAt, cId] = decodeCursor(q.cursor);
    const term = q.q ? `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
    return this.db.withPlatform(async (tx) => {
      const rows = await tx.query(
        `${TENANT_SELECT}
          where ($1::text is null or o.name ilike $1 or o.slug::text ilike $1 or coalesce(o.name_ar, '') ilike $1 or o.id::text = $2)
            and ($3::text is null or o.status = $3)
            and ($4::text is null or s.plan_id = $4)
            and ($5::country_code is null or o.country = $5)
            and ($6::timestamptz is null or (o.created_at, o.id) < ($6::timestamptz, $7::uuid))
          order by o.created_at desc, o.id desc limit $8`,
        [term, q.q ?? '', q.status ?? null, q.plan ?? null, q.country ?? null, cAt, cId, q.limit]);
      const items = rows.map(tenantRow);
      const last = rows[rows.length - 1];
      return { items, nextCursor: rows.length === q.limit && last ? encodeCursor(last.created_at, last.id) : null };
    });
  }

  async tenant(actor: PlatformAdminActor, orgId: string): Promise<AdminTenantDetail> {
    if (!UUID.test(orgId)) throw notFound('Restaurant');
    const billingVisible = this.can(actor, 'billing:read');
    return this.db.withPlatform(async (tx) => {
      const org = await tx.maybeOne(`${TENANT_SELECT} where o.id = $1`, [orgId]);
      if (!org) throw notFound('Restaurant');
      const branches = await tx.query(`select id, code, name, city, is_active from branches where org_id = $1 order by created_at`, [orgId]);
      const overrides = await tx.query(
        `select id, module, enabled, reason, expires_at, created_at, (expires_at is null or expires_at > now()) as active
           from entitlement_overrides where org_id = $1 order by created_at desc limit 100`, [orgId]);
      const modules = await tx.query<{ module: string; enabled: boolean }>(
        `select m.module, app.module_enabled($1, m.module) as enabled from unnest(enum_range(null::module_key)) as m(module)`, [orgId]);
      // Explicit column list: credentials_encrypted / webhook_secret_hash are never selected.
      const integrations = await tx.query(
        `select id, provider, category, environment, status, health, last_health_check_at, last_error, connected_at
           from integration_connections where org_id = $1 order by provider`, [orgId]);
      const audit = await tx.query(
        `select id, actor_type, action, entity_type, source, created_at from audit_logs where org_id = $1 order by id desc limit 25`, [orgId]);
      let subscription: AdminTenantDetail['subscription'] = null;
      if (billingVisible) {
        const s = await tx.maybeOne(`select * from subscriptions where org_id = $1 order by (status <> 'canceled') desc, created_at desc limit 1`, [orgId]);
        if (s) {
          const addons = await tx.query<{ module: ModuleKey }>(`select module from subscription_modules where subscription_id = $1 order by module`, [s.id]);
          const invoices = await tx.query(
            `select id, number, status, currency, total_minor, period_start, period_end from platform_invoices where subscription_id = $1 order by period_start desc limit 12`, [s.id]);
          subscription = {
            id: s.id, planId: s.plan_id, status: s.status, interval: s.billing_interval, currentPeriodStart: iso(s.current_period_start)!,
            currentPeriodEnd: iso(s.current_period_end)!, trialEndsAt: iso(s.trial_ends_at), graceUntil: iso(s.grace_until),
            cancelAtPeriodEnd: s.cancel_at_period_end, pendingPlanId: s.pending_plan_id, addons: addons.map((a) => a.module),
            invoices: invoices.map((i) => ({ id: i.id, number: i.number, status: i.status, currency: i.currency, totalMinor: Number(i.total_minor),
              periodStart: iso(i.period_start)!, periodEnd: iso(i.period_end)! })),
          };
        }
      }
      return {
        ...tenantRow(org), timezone: org.timezone,
        branches: branches.map((b) => ({ id: b.id, code: b.code, name: b.name, city: b.city, isActive: b.is_active })),
        subscription, billingVisible,
        overrides: overrides.map((o) => ({ id: o.id, module: o.module, enabled: o.enabled, reason: o.reason, expiresAt: iso(o.expires_at), active: o.active, createdAt: iso(o.created_at)! })),
        modules: Object.fromEntries(modules.map((m) => [m.module, m.enabled])),
        integrations: integrations.map((i) => ({ id: i.id, provider: i.provider, category: i.category, environment: i.environment, status: i.status,
          health: i.health ?? {}, lastHealthCheckAt: iso(i.last_health_check_at), lastError: i.last_error, connectedAt: iso(i.connected_at) })),
        recentAudit: audit.map((a) => ({ id: Number(a.id), actorType: a.actor_type, action: a.action, entityType: a.entity_type, source: a.source, createdAt: iso(a.created_at)! })),
      };
    });
  }

  async setStatus(actor: PlatformAdminActor, orgId: string, to: 'suspended' | 'active', reason: string) {
    if (!UUID.test(orgId)) throw notFound('Restaurant');
    const result = await this.db.withPlatform(async (tx) => {
      const org = await tx.maybeOne<{ status: string; onboarding: Record<string, unknown> }>(`select status, onboarding from organizations where id = $1 for update`, [orgId]);
      if (!org) throw notFound('Restaurant');
      if (org.status === 'closed') throw conflict('organization_closed', 'Closed organizations cannot change status here');
      if (to === 'suspended' && org.status === 'suspended') throw conflict('already_suspended', 'This restaurant is already suspended');
      if (to === 'active' && org.status !== 'suspended') throw conflict('not_suspended', 'This restaurant is not suspended');
      const next = to === 'suspended' ? 'suspended' : org.onboarding?.launched ? 'active' : 'onboarding';
      await tx.query(`update organizations set status = $2 where id = $1`, [orgId, next]);
      await this.audit(tx, actor, orgId, to === 'suspended' ? 'admin.organization_suspended' : 'admin.organization_reactivated', 'organization', orgId,
        { reason, from: org.status, to: next });
      return { id: orgId, status: next };
    }, `platform_admin:${actor.userId}`);
    this.tenantStatus.invalidate(orgId);
    this.entitlements.invalidate(orgId);
    return result;
  }

  async grantOverride(actor: PlatformAdminActor, orgId: string, input: GrantOverride) {
    if (!UUID.test(orgId)) throw notFound('Restaurant');
    if (new Date(input.expiresAt).getTime() <= Date.now()) throw invalid('expiry_in_past', 'The override must expire in the future');
    const row = await this.db.withPlatform(async (tx) => {
      if (!(await tx.maybeOne(`select 1 from organizations where id = $1`, [orgId]))) throw notFound('Restaurant');
      const o = await tx.one(
        `insert into entitlement_overrides(org_id, module, enabled, reason, expires_at, created_by) values ($1, $2, $3, $4, $5, $6)
         returning id, module, enabled, reason, expires_at, created_at`, [orgId, input.module, input.enabled, input.reason, input.expiresAt, actor.userId]);
      await this.audit(tx, actor, orgId, 'admin.entitlement_override_granted', 'entitlement_override', o.id,
        { module: input.module, enabled: input.enabled, reason: input.reason, expiresAt: input.expiresAt });
      return o;
    }, `platform_admin:${actor.userId}`);
    this.entitlements.invalidate(orgId);
    return { id: row.id, module: row.module, enabled: row.enabled, reason: row.reason, expiresAt: iso(row.expires_at), active: true, createdAt: iso(row.created_at)! };
  }

  async revokeOverride(actor: PlatformAdminActor, orgId: string, overrideId: string, reason: string) {
    if (!UUID.test(orgId) || !UUID.test(overrideId)) throw notFound('Override');
    const row = await this.db.withPlatform(async (tx) => {
      const o = await tx.maybeOne(
        `update entitlement_overrides set expires_at = now() where id = $1 and org_id = $2 and (expires_at is null or expires_at > now())
         returning id, module`, [overrideId, orgId]);
      if (!o) throw notFound('Active override');
      await this.audit(tx, actor, orgId, 'admin.entitlement_override_revoked', 'entitlement_override', o.id, { module: o.module, reason });
      return o;
    }, `platform_admin:${actor.userId}`);
    this.entitlements.invalidate(orgId);
    return { id: row.id, revoked: true };
  }

  // ---------------------------------------------------------------------------
  // Prices — append-only: a change is a NEW row with its own valid_from.
  // ---------------------------------------------------------------------------
  async prices(country?: 'EG' | 'SA'): Promise<AdminPrices> {
    return this.db.withPlatform(async (tx) => {
      const load = async (table: 'plan_prices' | 'module_prices', key: 'plan_id' | 'module') => {
        const rows = await tx.query(
          `select p.*, p.id = c.id as current from ${table} p
             left join lateral (select id from ${table} x where x.${key} = p.${key} and x.country = p.country and x.billing_interval = p.billing_interval
                                 and x.active and x.valid_from <= now() order by x.valid_from desc limit 1) c on true
            where ($1::country_code is null or p.country = $1)
            order by p.${key}, p.country, p.billing_interval, p.valid_from desc`, [country ?? null]);
        return rows.map((r): AdminPriceRow => ({ id: r.id, key: r[key], country: r.country, currency: r.currency, interval: r.billing_interval,
          amountMinor: Number(r.amount_minor), active: r.active, validFrom: iso(r.valid_from)!, current: !!r.current }));
      };
      return { plans: await load('plan_prices', 'plan_id'), modules: await load('module_prices', 'module') };
    });
  }

  async addPlanPrice(actor: PlatformAdminActor, input: NewPlanPrice) {
    const validFrom = this.validFrom(input.validFrom);
    return this.db.withPlatform(async (tx) => {
      if (!(await tx.maybeOne(`select 1 from plans where id = $1`, [input.planId]))) throw invalid('unknown_plan', 'Unknown plan');
      const row = await this.insertPrice(tx, 'plan_prices', 'plan_id', input.planId, input, validFrom);
      await this.audit(tx, actor, null, 'admin.plan_price_added', 'plan_price', row.id,
        { planId: input.planId, country: input.country, interval: input.interval, amountMinor: input.amountMinor, validFrom: validFrom.toISOString() });
      return row;
    }, `platform_admin:${actor.userId}`);
  }

  async addModulePrice(actor: PlatformAdminActor, input: NewModulePrice) {
    if (!MODULE_KEYS.includes(input.module)) throw invalid('unknown_module', 'Unknown module');
    const validFrom = this.validFrom(input.validFrom);
    return this.db.withPlatform(async (tx) => {
      const row = await this.insertPrice(tx, 'module_prices', 'module', input.module, input, validFrom);
      await this.audit(tx, actor, null, 'admin.module_price_added', 'module_price', row.id,
        { module: input.module, country: input.country, interval: input.interval, amountMinor: input.amountMinor, validFrom: validFrom.toISOString() });
      return row;
    }, `platform_admin:${actor.userId}`);
  }

  private validFrom(v: string | undefined): Date {
    const d = v ? new Date(v) : new Date();
    // A small allowance for clock skew; anything earlier would rewrite history.
    if (d.getTime() < Date.now() - 60_000) throw invalid('price_in_past', 'Prices can only take effect now or in the future');
    return d;
  }

  private async insertPrice(tx: Tx, table: 'plan_prices' | 'module_prices', keyCol: 'plan_id' | 'module', key: string,
    input: { country: 'EG' | 'SA'; interval: 'month' | 'year'; amountMinor: number }, validFrom: Date) {
    const currency = COUNTRY_DEFAULTS[input.country].currency;
    const r = await tx.maybeOne(
      `insert into ${table}(${keyCol}, country, currency, billing_interval, amount_minor, valid_from) values ($1, $2, $3, $4, $5, $6)
       on conflict do nothing returning *`, [key, input.country, currency, input.interval, input.amountMinor, validFrom]);
    if (!r) throw conflict('price_exists', 'A price already starts at this exact time');
    return { id: r.id, key: r[keyCol], country: r.country, currency: r.currency, interval: r.billing_interval, amountMinor: Number(r.amount_minor),
      active: r.active, validFrom: iso(r.valid_from)!, current: new Date(r.valid_from).getTime() <= Date.now() } satisfies AdminPriceRow;
  }

  // ---------------------------------------------------------------------------
  // Operations
  // ---------------------------------------------------------------------------
  async operations(): Promise<AdminOperations> {
    return this.db.withPlatform(async (tx) => {
      const outbox = await tx.one(
        `select count(*) filter (where published_at is null)::int as unpublished,
                min(created_at) filter (where published_at is null) as oldest,
                count(*) filter (where published_at is null and attempts > 0)::int as retrying
           from outbox_events where published_at is null`);
      const eh = await tx.one(`select count(*) filter (where status = 'failed')::int as failed, count(*) filter (where status = 'dead')::int as dead,
          count(*) filter (where status = 'running' and lease_until < now())::int as stuck
          from event_handlings where status in ('failed', 'dead', 'running')`);
      // Dead letters, failures awaiting retry and runs whose worker stopped (lease expired); each can be replayed.
      const ehRecent = await tx.query(
        `select h.event_id, h.handler, h.status, h.attempts, h.last_error, h.updated_at, e.event_type, e.org_id
           from event_handlings h join outbox_events e on e.id = h.event_id
          where h.status in ('failed', 'dead') or (h.status = 'running' and h.lease_until < now())
          order by h.updated_at desc limit 25`);
      const wh = await tx.one(`select count(*) filter (where status = 'failed')::int as failed, count(*) filter (where status = 'rejected')::int as rejected from webhook_inbox`);
      // Payloads and headers are never returned: provider metadata only.
      const whRecent = await tx.query(
        `select id, provider, status, attempts, error, org_id, received_at from webhook_inbox
          where status in ('failed', 'rejected') order by received_at desc limit 25`);
      const jobs = await tx.query(`select id, job, status, started_at, finished_at, error, stats from job_runs order by id desc limit 40`);
      const usage = await tx.query(
        `select metric, sum(quantity)::bigint as quantity, count(distinct org_id)::int as tenants from usage_events
          where occurred_at > now() - interval '30 days' group by metric order by metric`);
      return {
        generatedAt: new Date().toISOString(),
        outbox: { unpublished: outbox.unpublished, oldestUnpublishedAt: iso(outbox.oldest), retrying: outbox.retrying },
        eventHandlings: { failed: eh.failed, dead: eh.dead, stuck: eh.stuck, recent: ehRecent.map((r) => ({ eventId: r.event_id, handler: r.handler, status: r.status,
          attempts: r.attempts, lastError: r.last_error, eventType: r.event_type, orgId: r.org_id, updatedAt: iso(r.updated_at)! })) },
        webhooks: { failed: wh.failed, rejected: wh.rejected, recent: whRecent.map((r) => ({ id: r.id, provider: r.provider, status: r.status,
          attempts: r.attempts, error: r.error, orgId: r.org_id, receivedAt: iso(r.received_at)! })) },
        jobs: jobs.map((j) => ({ id: Number(j.id), job: j.job, status: j.status, startedAt: iso(j.started_at)!, finishedAt: iso(j.finished_at), error: j.error, stats: j.stats })),
        usage30d: usage.map((u) => ({ metric: u.metric, quantity: Number(u.quantity), tenants: u.tenants })),
      };
    });
  }

  /**
   * Re-queues one handler run of an outbox event (dead letter, failed or stuck after its worker stopped) with a fresh
   * retry budget. The dispatcher then runs it like any other delivery; the replay is audited (audit PCL-13).
   */
  async replayHandling(actor: PlatformAdminActor, eventId: string, handler: string, reason: string) {
    if (!UUID.test(eventId) || !/^[A-Za-z0-9._:-]{1,120}$/.test(handler)) throw notFound('Handler run');
    return this.db.withPlatform(async (tx) => {
      const h = await tx.maybeOne<{ status: string; attempts: number; stuck: boolean; org_id: string | null; event_type: string }>(
        `select h.status, h.attempts, (h.status = 'running' and h.lease_until < now()) as stuck, e.org_id, e.event_type
           from event_handlings h join outbox_events e on e.id = h.event_id
          where h.event_id = $1 and h.handler = $2 for update of h`, [eventId, handler]);
      if (!h) throw notFound('Handler run');
      if (!(h.status === 'dead' || h.status === 'failed' || h.stuck)) {
        throw conflict('not_replayable', 'Only dead-lettered, failed or stuck handler runs can be replayed');
      }
      await tx.query(
        `update event_handlings set status = 'failed', attempts = 0, next_attempt_at = now(), lease_until = null, claim_token = null, updated_at = now()
          where event_id = $1 and handler = $2`, [eventId, handler]);
      await tx.query(`update outbox_events set published_at = null, available_at = now(), claim_token = null where id = $1`, [eventId]);
      await this.audit(tx, actor, h.org_id, 'admin.event_handler_replayed', 'event_handling', `${eventId}:${handler}`,
        { eventType: h.event_type, handler, previousStatus: h.stuck ? 'stuck' : h.status, previousAttempts: h.attempts, reason });
      return { eventId, handler, status: 'queued' as const };
    });
  }

  private async audit(tx: Tx, actor: PlatformAdminActor, orgId: string | null, action: string, entityType: string, entityId: string, metadata: Record<string, unknown>) {
    await tx.query(
      `insert into audit_logs(org_id, actor_type, actor_id, action, entity_type, entity_id, source, metadata)
       values ($1, 'platform_admin', $2, $3, $4, $5, 'api', $6)`,
      [orgId, actor.userId, action, entityType, entityId, { ...metadata, platformRole: actor.role }]);
  }
}

