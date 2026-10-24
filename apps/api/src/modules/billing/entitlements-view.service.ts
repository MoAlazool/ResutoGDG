import { Injectable } from '@nestjs/common';
import { MODULE_KEYS, type EntitlementSource, type EntitlementsView, type ModuleKey } from '@resuto/contracts';
import type { Tx } from '../../common/db/db.service';
import { UsageService } from './usage.service';

/**
 * Read model explaining entitlement decisions. `enabled` always comes from
 * `app.module_enabled()` (the same function the API guard uses); `source`
 * mirrors that function's precedence: unexpired override → plan module →
 * subscription add-on, and only while the subscription is live
 * (trialing/active, or past_due within its grace period). Without a live
 * subscription the restaurant keeps the free plan's modules (21-ONB: a lapsed
 * plan falls back to Free); those report source 'plan'.
 */
@Injectable()
export class EntitlementsViewService {
  constructor(private readonly usage: UsageService) {}

  async modules(tx: Tx, orgId: string, at: Date = new Date()) {
    const enabled = await tx.query<{ module: ModuleKey; enabled: boolean }>(
      `select m.module, app.module_enabled($1, m.module, $2) as enabled from unnest(enum_range(null::module_key)) as m(module)`, [orgId, at]);
    const overrides = await tx.query<{ module: ModuleKey; enabled: boolean; expires_at: Date | null }>(
      `select distinct on (module) module, enabled, expires_at from entitlement_overrides
        where org_id = $1 and (expires_at is null or expires_at > $2) order by module, created_at desc`, [orgId, at]);
    const sub = await tx.maybeOne<{ id: string; plan_id: string; live: boolean }>(
      `select id, plan_id, (status in ('trialing', 'active') or (status = 'past_due' and grace_until is not null and grace_until > $2)) as live
         from subscriptions where org_id = $1 and status <> 'canceled'`, [orgId, at]);
    const planMods = sub ? (await tx.query<{ module: ModuleKey }>(`select module from plan_modules where plan_id = $1`, [sub.plan_id])).map((r) => r.module) : [];
    const subMods = sub ? await tx.query<{ module: ModuleKey; source: string }>(`select module, source from subscription_modules where subscription_id = $1`, [sub.id]) : [];
    const freeMods = sub?.live ? [] : (await tx.query<{ module: ModuleKey }>(`select module from plan_modules where plan_id = 'free'`)).map((r) => r.module);

    const out: EntitlementsView['modules'] = {};
    for (const key of MODULE_KEYS) {
      const ov = overrides.find((o) => o.module === key);
      let source: EntitlementSource = 'none';
      if (ov) source = 'override';
      else if (sub?.live && planMods.includes(key)) source = 'plan';
      else if (sub?.live) {
        const sm = subMods.find((m) => m.module === key);
        // Modules chosen for "Build Your Resuto" are part of that plan.
        if (sm) source = sm.source === 'custom_plan' ? 'plan' : 'addon';
      } else if (freeMods.includes(key)) source = 'plan';   // the Free floor
      out[key] = { enabled: enabled.find((e) => e.module === key)?.enabled ?? false, source, ...(ov ? { overrideExpiresAt: ov.expires_at ? new Date(ov.expires_at).toISOString() : null } : {}) };
    }
    return out;
  }

  async view(tx: Tx, orgId: string): Promise<EntitlementsView> {
    const sub = await tx.maybeOne<any>(
      `select s.*, p.limits from subscriptions s join plans p on p.id = s.plan_id where s.org_id = $1 and s.status <> 'canceled'`, [orgId]);
    const snap = await this.usage.snapshot(tx, orgId);
    const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
    return {
      planId: sub?.plan_id ?? null,
      status: sub?.status ?? null,
      modules: await this.modules(tx, orgId),
      limits: sub?.limits ?? {},
      usage: snap.usage,
      period: sub ? { start: iso(sub.current_period_start)!, end: iso(sub.current_period_end)! } : null,
      trialEndsAt: iso(sub?.trial_ends_at),
      graceUntil: iso(sub?.grace_until),
      cancelAtPeriodEnd: sub?.cancel_at_period_end ?? false,
      pendingPlanId: sub?.pending_plan_id ?? null,
    };
  }
}
