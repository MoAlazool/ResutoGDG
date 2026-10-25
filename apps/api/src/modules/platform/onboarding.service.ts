import { Inject, Injectable } from '@nestjs/common';
import {
  EMPTY_ONBOARDING, mergeCompleted, ORG_ONBOARDING_STEPS, slugProblem, socialLinksOf,
  type MenuQr, type OnboardingProgress, type OnboardingProgressInput, type SlugAvailability, type SocialLinks, type SocialLinksResponse,
} from '@resuto/contracts';
import QRCode from 'qrcode';
import type { TenantContext } from '../../common/auth/context';
import { DbService } from '../../common/db/db.service';
import { DomainError, notFound } from '../../common/errors/domain-error';
import { AuditService } from '../../common/platform/audit.service';
import { ENV, type Env } from '../../config/env';

/**
 * Free QR-menu onboarding (21-ONB, plan §6.2): the restaurant's web address check, its social links and the
 * view-only menu QR.
 *
 * The menu QR is not an ordering QR: it opens /m/<slug>, the digital menu with no cart, ordering or table session,
 * and carries no token (the address is the public slug). Ordering QRs (/t/<table token>, /v/<venue token>) are
 * issued only by the floor API.
 */
@Injectable()
export class OnboardingService {
  constructor(private readonly db: DbService, private readonly audit: AuditService, @Inject(ENV) private readonly env: Env) {}

  // --- Wizard progress (increment 2) -----------------------------------------------------
  /**
   * The signed-in person's wizard. Read as that person (DbService.withUser: RLS shows only their own row); a linked
   * restaurant they no longer belong to is reported as none, so the wizard never resumes inside another tenant.
   */
  progress(userId: string): Promise<OnboardingProgress> {
    return this.db.withUser(userId, async (tx) => {
      const row = await tx.maybeOne<any>(
        `select p.*, (p.org_id is not null and app.is_member(p.org_id)) as member from onboarding_progress p where p.user_id = $1`, [userId]);
      return row ? toProgress(row) : { ...EMPTY_ONBOARDING, completed: [...EMPTY_ONBOARDING.completed] };
    });
  }

  /**
   * Saves the wizard after a step: `completed` only grows; `orgId` must be a restaurant the person is an active member
   * of (checked here for a clear error, and again by the RLS write policy); restaurant steps and `done` need one.
   */
  saveProgress(userId: string, input: OnboardingProgressInput): Promise<OnboardingProgress> {
    return this.db.withUser(userId, async (tx) => {
      const existing = await tx.maybeOne<any>('select * from onboarding_progress where user_id = $1 for update', [userId]);
      const before = input.restart ? null : existing;
      const orgId: string | null = input.orgId !== undefined ? input.orgId : before?.org_id ?? null;
      if (orgId) {
        const ok = await tx.one<{ ok: boolean }>('select app.is_member($1::uuid) as ok', [orgId]);
        if (!ok.ok) throw new DomainError('forbidden', 'You are not a member of this restaurant', 403);
      }
      const completed = mergeCompleted(before?.completed ?? ['account'], ['account', ...input.completed]);
      const needsOrg = ORG_ONBOARDING_STEPS.includes(input.step) || completed.some((s) => ORG_ONBOARDING_STEPS.includes(s)) || input.done;
      if (needsOrg && !orgId) throw new DomainError('onboarding_org_required', 'Create the restaurant (choose its web address) first.', 422);
      const draft = input.draft ?? before?.draft ?? {};
      const row = await tx.one<any>(
        `insert into onboarding_progress(user_id, org_id, step, completed, draft, completed_at)
         values ($1, $2, $3, $4, $5, case when $6 then now() end)
         on conflict (user_id) do update set org_id = excluded.org_id, step = excluded.step, completed = excluded.completed,
           draft = excluded.draft,
           completed_at = case when $6 then coalesce(onboarding_progress.completed_at, now())
                               when $7 or excluded.org_id is distinct from onboarding_progress.org_id then null
                               else onboarding_progress.completed_at end
         returning *, (org_id is not null and app.is_member(org_id)) as member`,
        [userId, orgId, input.step, completed, JSON.stringify(draft), input.done === true, input.restart === true]);
      return toProgress(row);
    });
  }

  /** Whether a restaurant could take `slug` as its address right now (shape, reserved words, another restaurant). */
  async slugAvailability(raw: string): Promise<SlugAvailability> {
    const slug = raw.trim().toLowerCase();
    const problem = slugProblem(slug);
    if (problem) return { slug, available: false, reason: problem };
    const taken = await this.db.withPlatform((tx) => tx.maybeOne('select 1 from organizations where slug = $1', [slug]));
    return { slug, available: !taken, reason: taken ? 'taken' : null };
  }

  socialLinks(ctx: TenantContext): Promise<SocialLinksResponse> {
    return this.db.scoped(ctx, async (tx) => {
      const row = await tx.one<{ social_links: unknown }>('select social_links from organizations where id = $1', [ctx.orgId]);
      return { socialLinks: socialLinksOf(row.social_links) };
    });
  }

  /** Replaces the whole set (validated and normalized by socialLinksInput); audited as an organization update. */
  setSocialLinks(ctx: TenantContext, input: Record<string, string | undefined>): Promise<SocialLinksResponse> {
    const links: SocialLinks = socialLinksOf(Object.fromEntries(Object.entries(input).filter(([, v]) => typeof v === 'string')));
    return this.db.scoped(ctx, async (tx) => {
      const before = await tx.one<{ social_links: unknown }>('select social_links from organizations where id = $1 for update', [ctx.orgId]);
      await tx.query('update organizations set social_links = $2 where id = $1', [ctx.orgId, JSON.stringify(links)]);
      await this.audit.record(tx, ctx, {
        action: 'organization.updated', entityType: 'organization', entityId: ctx.orgId,
        metadata: { fields: ['socialLinks'], networks: Object.keys(links), previous: Object.keys(socialLinksOf(before.social_links)) },
      });
      return { socialLinks: links };
    });
  }

  /** The view-only menu QR (SVG and PNG) for the restaurant or one of its branches. */
  async menuQr(ctx: TenantContext, branchCode?: string): Promise<MenuQr> {
    const { slug, code } = await this.db.scoped(ctx, async (tx) => {
      const org = await tx.one<{ slug: string }>('select slug from organizations where id = $1', [ctx.orgId]);
      if (!branchCode) return { slug: org.slug, code: null };
      const b = await tx.maybeOne<{ id: string; code: string }>('select id, code from branches where org_id = $1 and code = $2 and is_active', [ctx.orgId, branchCode]);
      if (!b || !ctx.canAccessBranch(b.id)) throw notFound('Branch');
      return { slug: org.slug, code: b.code };
    });
    const url = `${this.env.APP_ORIGIN.replace(/\/$/, '')}/m/${encodeURIComponent(slug)}${code ? `?branch=${encodeURIComponent(code)}` : ''}`;
    const [svg, png] = await Promise.all([
      QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }),
      QRCode.toDataURL(url, { type: 'image/png', width: 1024, margin: 2, errorCorrectionLevel: 'M' }),
    ]);
    return { kind: 'menu', url, branchCode: code, svg, png };
  }
}

function toProgress(r: any): OnboardingProgress {
  const orgId = r.member ? r.org_id : null;
  const completed = mergeCompleted(r.completed ?? [], []);
  return {
    // Without (access to) the restaurant the wizard resumes where the restaurant is chosen.
    step: orgId || !ORG_ONBOARDING_STEPS.includes(r.step) ? r.step : 'address',
    completed: orgId ? completed : completed.filter((s) => !ORG_ONBOARDING_STEPS.includes(s)),
    orgId,
    draft: r.draft ?? {},
    completedAt: orgId && r.completed_at ? new Date(r.completed_at).toISOString() : null,
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  };
}
