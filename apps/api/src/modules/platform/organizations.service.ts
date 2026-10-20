import { Injectable } from '@nestjs/common';
import {
  COUNTRY_DEFAULTS, assignableRoles,
  type BranchInput, type CreateOrganization, type InviteMember, type OrganizationSummary, type Role,
} from '@resuto/contracts';
import type { AuthUser, TenantContext } from '../../common/auth/context';
import { newToken, sha256 } from '../../common/crypto/hash';
import { DbService, type Tx } from '../../common/db/db.service';
import { EntitlementsService } from '../../common/entitlements/entitlements.service';
import { DomainError, conflict, forbidden, invalid, notFound } from '../../common/errors/domain-error';
import { AuditService } from '../../common/platform/audit.service';
import { OutboxService } from '../../common/platform/outbox.service';

const BRANCH_COLUMNS: Record<keyof BranchInput | 'isActive', string> = {
  code: 'code', name: 'name', nameAr: 'name_ar', address: 'address', city: 'city', phone: 'phone',
  latitude: 'latitude', longitude: 'longitude', timezone: 'timezone', acceptsDineIn: 'accepts_dine_in', acceptsPickup: 'accepts_pickup',
  acceptsDelivery: 'accepts_delivery', acceptsReservations: 'accepts_reservations', deliveryFeeMinor: 'delivery_fee_minor',
  deliveryRadiusM: 'delivery_radius_m', minOrderMinor: 'min_order_minor', reservationDurationMin: 'reservation_duration_min',
  reservationBufferMin: 'reservation_buffer_min', reservationDepositMinor: 'reservation_deposit_minor', openingHours: 'opening_hours',
  isActive: 'is_active',
};

export const toOrg = (r: any): OrganizationSummary => ({
  id: r.id, slug: r.slug, name: r.name, nameAr: r.name_ar, country: r.country, currency: r.currency,
  timezone: r.timezone, defaultLocale: r.default_locale, status: r.status, ...(r.role ? { role: r.role } : {}),
});

export const toBranch = (r: any) => ({
  id: r.id, orgId: r.org_id, code: r.code, name: r.name, nameAr: r.name_ar, address: r.address, city: r.city, phone: r.phone,
  latitude: r.latitude === null ? null : Number(r.latitude), longitude: r.longitude === null ? null : Number(r.longitude),
  timezone: r.timezone, isActive: r.is_active, acceptsDineIn: r.accepts_dine_in, acceptsPickup: r.accepts_pickup, acceptsDelivery: r.accepts_delivery,
  acceptsReservations: r.accepts_reservations, deliveryFeeMinor: r.delivery_fee_minor, deliveryRadiusM: r.delivery_radius_m,
  minOrderMinor: r.min_order_minor, reservationDurationMin: r.reservation_duration_min, reservationBufferMin: r.reservation_buffer_min,
  reservationDepositMinor: r.reservation_deposit_minor, openingHours: r.opening_hours, serviceMode: r.service_mode ?? 'tables',
});

const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'main';

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly entitlements: EntitlementsService,
  ) {}

  /**
   * Restaurant signup. Runs in platform context because the creator has no
   * membership until this transaction commits; everything is created atomically.
   */
  async create(user: AuthUser, input: CreateOrganization): Promise<OrganizationSummary & { branchId: string }> {
    const defaults = COUNTRY_DEFAULTS[input.country];
    return this.db.withPlatform(async (tx) => {
      const plan = await tx.maybeOne<{ id: string }>('select id from plans where id = $1 and is_public', [input.planId]);
      if (!plan) throw invalid('unknown_plan', 'Choose an available plan');
      const owned = await tx.one<{ n: number }>(
        `select count(*)::int as n from memberships where user_id = $1 and role = 'owner' and status = 'active'`, [user.userId]);
      if (owned.n >= 10) throw new DomainError('too_many_organizations', 'Contact support to add more restaurants', 429);
      if (await tx.maybeOne('select 1 from organizations where slug = $1', [input.slug])) {
        throw conflict('slug_taken', 'This web address is already taken');
      }
      const org = await tx.one<any>(
        `insert into organizations(slug, name, name_ar, country, currency, timezone, default_locale, status)
         values ($1, $2, $3, $4, $5, $6, $7, 'onboarding') returning *`,
        [input.slug, input.name, input.nameAr ?? null, input.country, defaults.currency, defaults.timezone, input.defaultLocale]);
      await tx.query(`insert into profiles(id, email) values ($1, $2) on conflict (id) do update set email = coalesce(profiles.email, excluded.email)`, [user.userId, user.email]);
      await tx.query(`update profiles set last_org_id = $2 where id = $1`, [user.userId, org.id]);
      await tx.query(`insert into memberships(org_id, user_id, role) values ($1, $2, 'owner')`, [org.id, user.userId]);
      const branch = await this.insertBranch(tx, org.id, input.branch);

      const isFree = input.planId === 'free';
      await tx.query(
        `insert into subscriptions(org_id, plan_id, status, billing_interval, country, currency, current_period_end, trial_ends_at)
         values ($1, $2, $3, $4, $5, $6, now() + $7::interval, $8)`,
        [org.id, input.planId, isFree ? 'active' : 'trialing', input.billingInterval, input.country, defaults.currency,
          input.billingInterval === 'year' ? '1 year' : '1 month', isFree ? null : new Date(Date.now() + 14 * 864e5)]);
      await tx.query(`insert into subscription_events(org_id, event_type, to_plan_id) values ($1, 'created', $2)`, [org.id, input.planId]);

      // Country-aware compliance defaults. Not "validated" until the owner completes them.
      await tx.query(
        `insert into tax_profiles(org_id, country, regime, vat_rate_bp, prices_include_tax) values ($1, $2, $3, $4, true)`,
        [org.id, input.country, defaults.taxRegime, defaults.vatRateBp]);
      await tx.query(`insert into menus(org_id, name, name_ar) values ($1, 'Main menu', 'القائمة الرئيسية')`, [org.id]);
      const site = await tx.one<{ id: string }>(
        `insert into websites(org_id, seo) values ($1, $2) returning id`,
        [org.id, { title: { en: input.name, ar: input.nameAr ?? input.name } }]);
      await tx.query(
        `insert into website_sections(org_id, website_id, kind, sort_order, content) values
           ($1, $2, 'hero', 0, $3), ($1, $2, 'menu_highlights', 1, '{}'), ($1, $2, 'reservations', 2, '{}'),
           ($1, $2, 'ordering', 3, '{}'), ($1, $2, 'location', 4, '{}')`,
        [org.id, site.id, { headline: { en: input.name, ar: input.nameAr ?? input.name } }]);
      await tx.query(
        `insert into expense_categories(org_id, name, name_ar, kind) values
           ($1, 'Ingredients', 'المكونات', 'cogs'), ($1, 'Salaries', 'الرواتب', 'labor'), ($1, 'Rent', 'الإيجار', 'rent'),
           ($1, 'Utilities', 'المرافق', 'utilities'), ($1, 'Marketing', 'التسويق', 'marketing'),
           ($1, 'Delivery', 'التوصيل', 'delivery'), ($1, 'Payment fees', 'رسوم الدفع', 'fees'), ($1, 'Other', 'أخرى', 'other')`,
        [org.id]);

      await tx.query(
        `insert into audit_logs(org_id, actor_type, actor_id, action, entity_type, entity_id, metadata)
         values ($1, 'user', $2, 'organization.created', 'organization', $3, $4)`, [org.id, user.userId, org.id, { plan: input.planId }]);
      await this.outbox.publish(tx, org.id, { type: 'organization.created', aggregateType: 'organization', aggregateId: org.id, payload: { plan: input.planId } });
      return { ...toOrg({ ...org, role: 'owner' }), branchId: branch.id };
    }, `user:${user.userId}`);
  }

  async get(ctx: TenantContext) {
    return this.db.scoped(ctx, async (tx) => {
      const org = await tx.one('select * from organizations where id = $1', [ctx.orgId]);
      const branches = await tx.query('select * from branches where org_id = $1 order by created_at', [ctx.orgId]);
      return { ...toOrg(org), role: ctx.role, legalName: org.legal_name, taxRegistrationNumber: org.tax_registration_number,
        commercialRegistration: org.commercial_registration, onboarding: org.onboarding,
        branches: branches.filter((b) => ctx.canAccessBranch(b.id)).map(toBranch) };
    });
  }

  async update(ctx: TenantContext, patch: Record<string, unknown>) {
    const map: Record<string, string> = { name: 'name', nameAr: 'name_ar', defaultLocale: 'default_locale', legalName: 'legal_name',
      taxRegistrationNumber: 'tax_registration_number', commercialRegistration: 'commercial_registration', timezone: 'timezone' };
    const entries = Object.entries(patch).filter(([k, v]) => map[k] && v !== undefined);
    if (!entries.length) return this.get(ctx);
    await this.db.scoped(ctx, async (tx) => {
      await tx.query(`update organizations set ${entries.map(([k], i) => `${map[k]} = $${i + 2}`).join(', ')} where id = $1`,
        [ctx.orgId, ...entries.map(([, v]) => v)]);
      await this.audit.record(tx, ctx, { action: 'organization.updated', entityType: 'organization', entityId: ctx.orgId, metadata: { fields: entries.map(([k]) => k) } });
    });
    return this.get(ctx);
  }

  async completeOnboardingStep(ctx: TenantContext, step: string) {
    return this.db.scoped(ctx, async (tx) => {
      const org = await tx.one<any>(
        `update organizations set onboarding = onboarding || jsonb_build_object($2::text, now()),
            status = case when status = 'onboarding' and $2 = 'launched' then 'active' else status end
          where id = $1 returning onboarding, status`, [ctx.orgId, step]);
      return { onboarding: org.onboarding, status: org.status };
    });
  }

  // --- Branches --------------------------------------------------------------
  async createBranch(ctx: TenantContext, input: BranchInput) {
    return this.db.scoped(ctx, async (tx) => {
      const limits = await this.planLimits(tx, ctx.orgId);
      const { n } = await tx.one<{ n: number }>('select count(*)::int as n from branches where org_id = $1 and is_active', [ctx.orgId]);
      if (limits.branches !== undefined && n >= limits.branches) {
        throw new DomainError('plan_limit_reached', `Your plan allows ${limits.branches} branch(es). Upgrade to add more.`, 402, { limit: 'branches' });
      }
      const branch = await this.insertBranch(tx, ctx.orgId, input);
      await this.audit.record(tx, ctx, { action: 'branch.created', entityType: 'branch', entityId: branch.id, branchId: branch.id });
      return toBranch(branch);
    });
  }

  async updateBranch(ctx: TenantContext, branchId: string, patch: Partial<BranchInput> & { isActive?: boolean }) {
    ctx.assertBranch(branchId);
    const entries = Object.entries(patch).filter(([k, v]) => v !== undefined && (BRANCH_COLUMNS as any)[k]);
    return this.db.scoped(ctx, async (tx) => {
      if (!entries.length) return toBranch(await tx.one('select * from branches where id = $1', [branchId]));
      const row = await tx.maybeOne(
        `update branches set ${entries.map(([k], i) => `${(BRANCH_COLUMNS as any)[k]} = $${i + 2}`).join(', ')} where id = $1 returning *`,
        [branchId, ...entries.map(([k, v]) => (k === 'openingHours' ? JSON.stringify(v) : v))]);
      if (!row) throw notFound('Branch');
      await this.audit.record(tx, ctx, { action: 'branch.updated', entityType: 'branch', entityId: branchId, branchId, metadata: { fields: entries.map(([k]) => k) } });
      return toBranch(row);
    });
  }

  private async insertBranch(tx: Tx, orgId: string, input: BranchInput) {
    const code = input.code ?? slugify(input.name);
    const branch = await tx.one<any>(
      `insert into branches(org_id, code, name, name_ar, address, city, phone, latitude, longitude,
          accepts_dine_in, accepts_pickup, accepts_delivery, accepts_reservations, delivery_fee_minor, delivery_radius_m,
          min_order_minor, reservation_duration_min, reservation_buffer_min, reservation_deposit_minor, opening_hours, timezone)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, coalesce($10, true), coalesce($11, true), coalesce($12, false), coalesce($13, true),
          coalesce($14, 0), $15, coalesce($16, 0), coalesce($17, 90), coalesce($18, 15), coalesce($19, 0), coalesce($20, '[]'::jsonb), $21)
       returning *`,
      [orgId, code, input.name, input.nameAr ?? null, input.address ?? null, input.city ?? null, input.phone ?? null,
        input.latitude ?? null, input.longitude ?? null, input.acceptsDineIn ?? null, input.acceptsPickup ?? null,
        input.acceptsDelivery ?? null, input.acceptsReservations ?? null, input.deliveryFeeMinor ?? null, input.deliveryRadiusM ?? null,
        input.minOrderMinor ?? null, input.reservationDurationMin ?? null, input.reservationBufferMin ?? null,
        input.reservationDepositMinor ?? null, input.openingHours ? JSON.stringify(input.openingHours) : null, input.timezone ?? null]);
    await tx.query(`insert into floor_layouts(org_id, branch_id) values ($1, $2)`, [orgId, branch.id]);
    await tx.query(`insert into order_counters(branch_id, org_id) values ($1, $2)`, [branch.id, orgId]);
    return branch;
  }

  async planLimits(tx: Tx, orgId: string): Promise<Record<string, number>> {
    const row = await tx.maybeOne<{ limits: Record<string, number> }>(
      `select p.limits from subscriptions s join plans p on p.id = s.plan_id where s.org_id = $1 and s.status <> 'canceled'`, [orgId]);
    return row?.limits ?? {};
  }

  // --- Members ---------------------------------------------------------------
  async listMembers(ctx: TenantContext) {
    return this.db.scoped(ctx, async (tx) => {
      const members = await tx.query(
        `select m.id, m.user_id, m.role, m.branch_ids, m.status, m.created_at, p.full_name, p.email
           from memberships m left join profiles p on p.id = m.user_id
          where m.org_id = $1 order by m.created_at`, [ctx.orgId]);
      const invitations = await tx.query(
        `select id, email, phone, role, branch_ids, status, expires_at from invitations where org_id = $1 and status = 'pending' order by created_at`, [ctx.orgId]);
      return {
        members: members.map((m) => ({ id: m.id, userId: m.user_id, role: m.role, branchIds: m.branch_ids, status: m.status, fullName: m.full_name, email: m.email })),
        invitations: invitations.map((i) => ({ id: i.id, email: i.email, phone: i.phone, role: i.role, branchIds: i.branch_ids, expiresAt: i.expires_at })),
      };
    });
  }

  /**
   * Branch access a caller may grant (audit PS-09): an all-branch caller grants anything that exists; a
   * branch-restricted admin grants only a subset of their own branches, and "all branches" (null) narrows to
   * exactly their branches (the same rule as MCP keys).
   */
  private async grantableBranches(tx: Tx, ctx: TenantContext, branchIds: string[] | null | undefined): Promise<string[] | null> {
    if (!branchIds) return ctx.branchFilter;
    const unique = [...new Set(branchIds)];
    if (!unique.length) return []; // no branch: within anyone's scope
    if (!unique.every((b) => ctx.canAccessBranch(b))) throw forbidden('You can only give access to your own branches');
    const { n: valid } = await tx.one<{ n: number }>('select count(*)::int as n from branches where org_id = $1 and id = any($2)', [ctx.orgId, unique]);
    if (valid !== unique.length) throw invalid('unknown_branch', 'One or more branches do not exist');
    return unique;
  }

  /** A branch-restricted admin manages only people whose access lies within their own branches. */
  private assertWithinScope(ctx: TenantContext, branchIds: string[] | null) {
    if (ctx.branchFilter === null) return;
    if (branchIds === null || !branchIds.every((b) => ctx.canAccessBranch(b))) {
      throw forbidden('This person has access beyond your branches; ask an owner or an all-branch admin');
    }
  }

  async invite(ctx: TenantContext, input: InviteMember) {
    if (!assignableRoles(ctx.role).includes(input.role as Role)) throw forbidden(`A ${ctx.role} cannot invite a ${input.role}`);
    const token = newToken(32);
    return this.db.scoped(ctx, async (tx) => {
      const limits = await this.planLimits(tx, ctx.orgId);
      const { n } = await tx.one<{ n: number }>(
        `select (select count(*) from memberships where org_id = $1 and status = 'active' and role <> 'driver')
              + (select count(*) from invitations where org_id = $1 and status = 'pending' and role <> 'driver') as n`, [ctx.orgId]);
      if (input.role !== 'driver' && limits.staff !== undefined && Number(n) >= limits.staff) {
        throw new DomainError('plan_limit_reached', `Your plan allows ${limits.staff} staff accounts`, 402, { limit: 'staff' });
      }
      const branchIds = input.branchIds?.length || ctx.branchFilter !== null ? await this.grantableBranches(tx, ctx, input.branchIds) : (input.branchIds ?? null);
      const row = await tx.one<{ id: string; expires_at: string }>(
        `insert into invitations(org_id, email, phone, role, branch_ids, token_hash, expires_at, invited_by)
         values ($1, $2, $3, $4, $5, $6, now() + interval '7 days', $7) returning id, expires_at`,
        [ctx.orgId, input.email ?? null, input.phone ?? null, input.role, branchIds, sha256(token), ctx.userId]);
      await this.audit.record(tx, ctx, { action: 'member.invited', entityType: 'invitation', entityId: row.id, metadata: { role: input.role, branchIds } });
      await this.outbox.publish(tx, ctx.orgId, { type: 'member.invited', aggregateType: 'invitation', aggregateId: row.id, payload: { role: input.role, email: input.email ?? null } });
      // The token is returned once so the inviter can share the link; only its hash is stored.
      return { id: row.id, token, expiresAt: row.expires_at };
    });
  }

  async acceptInvitation(user: AuthUser, token: string) {
    return this.db.withPlatform(async (tx) => {
      const inv = await tx.maybeOne<any>(
        `select * from invitations where token_hash = $1 for update`, [sha256(token)]);
      if (!inv || inv.status !== 'pending' || new Date(inv.expires_at) < new Date()) throw invalid('invitation_invalid', 'This invitation is invalid or has expired');
      // An emailed invitation binds to that address: a session without an email (phone-only, anonymous) cannot use it
      // either (audit PS-25: the check was skipped when the token carried no email).
      if (inv.email && (!user.email || inv.email.toLowerCase() !== user.email.toLowerCase())) {
        throw forbidden('This invitation was sent to a different email address');
      }
      await tx.query(`insert into profiles(id, email) values ($1, $2) on conflict (id) do update set email = coalesce(profiles.email, excluded.email)`, [user.userId, user.email]);
      await tx.query(
        `insert into memberships(org_id, user_id, role, branch_ids, invited_by) values ($1, $2, $3, $4, $5)
         on conflict (org_id, user_id) do update set role = excluded.role, branch_ids = excluded.branch_ids, status = 'active'`,
        [inv.org_id, user.userId, inv.role, inv.branch_ids, inv.invited_by]);
      await tx.query(`update invitations set status = 'accepted', accepted_by = $2 where id = $1`, [inv.id, user.userId]);
      if (inv.role === 'driver') {
        await tx.query(
          `insert into drivers(org_id, user_id, display_name, phone_e164, branch_ids, status)
           values ($1, $2, coalesce((select full_name from profiles where id = $2), $3, 'Driver'), $4, $5, 'active')
           on conflict (org_id, user_id) do update set status = 'active'`,
          [inv.org_id, user.userId, user.email, inv.phone, inv.branch_ids]);
      }
      await tx.query(
        `insert into audit_logs(org_id, actor_type, actor_id, action, entity_type, entity_id) values ($1, 'user', $2, 'member.joined', 'membership', $3)`,
        [inv.org_id, user.userId, user.userId]);
      await this.outbox.publish(tx, inv.org_id, { type: 'member.joined', aggregateType: 'membership', aggregateId: user.userId, payload: { role: inv.role } });
      return { orgId: inv.org_id, role: inv.role };
    }, `user:${user.userId}`);
  }

  async updateMember(ctx: TenantContext, membershipId: string, patch: { role?: Role; branchIds?: string[] | null; status?: string }) {
    return this.db.scoped(ctx, async (tx) => {
      const m = await tx.maybeOne<any>('select * from memberships where id = $1 for update', [membershipId]);
      if (!m) throw notFound('Member');
      if (m.role === 'owner') throw forbidden('The owner cannot be changed here');
      if (m.user_id === ctx.userId) throw forbidden('You cannot change your own access');
      const allowed = assignableRoles(ctx.role);
      if (!allowed.includes(m.role) || (patch.role && !allowed.includes(patch.role))) throw forbidden();
      this.assertWithinScope(ctx, m.branch_ids);
      const branchIds = patch.branchIds === undefined ? undefined
        : ctx.branchFilter === null && patch.branchIds === null ? null : await this.grantableBranches(tx, ctx, patch.branchIds);
      const row = await tx.one<any>(
        `update memberships set role = coalesce($2, role), branch_ids = case when $3 then $4 else branch_ids end, status = coalesce($5, status)
          where id = $1 returning id, role, branch_ids, status`,
        [membershipId, patch.role ?? null, branchIds !== undefined, branchIds ?? null, patch.status ?? null]);
      await this.audit.record(tx, ctx, { action: 'member.updated', entityType: 'membership', entityId: membershipId, metadata: patch as any });
      return { id: row.id, role: row.role, branchIds: row.branch_ids, status: row.status };
    });
  }

  async revokeInvitation(ctx: TenantContext, invitationId: string) {
    return this.db.scoped(ctx, async (tx) => {
      const inv = await tx.maybeOne<{ role: Role; status: string; branch_ids: string[] | null }>('select role, status, branch_ids from invitations where id = $1 for update', [invitationId]);
      if (!inv) throw notFound('Invitation');
      if (!assignableRoles(ctx.role).includes(inv.role)) throw forbidden();
      this.assertWithinScope(ctx, inv.branch_ids);
      if (inv.status !== 'pending') throw conflict('invitation_not_pending', `This invitation is already ${inv.status}`);
      await tx.query(`update invitations set status = 'revoked' where id = $1`, [invitationId]);
      await this.audit.record(tx, ctx, { action: 'member.invitation_revoked', entityType: 'invitation', entityId: invitationId, metadata: { role: inv.role } });
      return { id: invitationId, status: 'revoked' as const };
    });
  }

  async removeMember(ctx: TenantContext, membershipId: string) {
    return this.updateMember(ctx, membershipId, { status: 'removed' } as any);
  }

  /** Invalidates cached entitlements after billing changes. */
  invalidateEntitlements(orgId: string) {
    this.entitlements.invalidate(orgId);
  }
}
