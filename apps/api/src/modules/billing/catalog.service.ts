import { Injectable } from '@nestjs/common';
import {
  COUNTRY_DEFAULTS, EXTERNAL_COSTS_NOTE, EXTERNAL_COSTS_NOTE_AR, MODULE_INFO, MODULE_KEYS,
  type ModuleKey, type PriceQuote, type PriceTag, type PublicPlansResponse,
} from '@resuto/contracts';
import type { Tx } from '../../common/db/db.service';
import { invalid } from '../../common/errors/domain-error';

type Country = 'EG' | 'SA';
type Interval = 'month' | 'year';

export interface PlanRow {
  id: string; name: string; name_ar: string | null; description: string | null; description_ar?: string | null; is_custom: boolean; is_public: boolean;
  sort_order: number; limits: Record<string, number>;
}

export interface QuoteInput { planId: string; country: Country; interval: Interval; addons: readonly ModuleKey[] }

const tag = (r: any): PriceTag => ({
  amountMinor: Number(r.amount_minor), currency: r.currency, interval: r.billing_interval, validFrom: new Date(r.valid_from).toISOString(),
});

/**
 * Plans, prices and the subscription price quote. Every amount is read from
 * plan_prices / module_prices (the latest active row with valid_from <= at);
 * nothing here hard-codes a price.
 */
@Injectable()
export class CatalogService {
  async plan(tx: Tx, planId: string, opts: { publicOnly?: boolean } = {}): Promise<PlanRow | null> {
    return tx.maybeOne<PlanRow>(`select * from plans where id = $1 and ($2::boolean is false or is_public)`, [planId, !!opts.publicOnly]);
  }

  async planModules(tx: Tx, planId: string): Promise<ModuleKey[]> {
    const rows = await tx.query<{ module: ModuleKey }>(`select module from plan_modules where plan_id = $1`, [planId]);
    return sortModules(rows.map((r) => r.module));
  }

  /** Current price rows per (plan, interval) for a country. */
  async planPrices(tx: Tx, country: Country, at: Date = new Date()) {
    const rows = await tx.query(
      `select distinct on (plan_id, billing_interval) plan_id, billing_interval, amount_minor, currency, valid_from
         from plan_prices where country = $1 and active and valid_from <= $2
        order by plan_id, billing_interval, valid_from desc`, [country, at]);
    const map = new Map<string, PriceTag>();
    for (const r of rows) map.set(`${r.plan_id}:${r.billing_interval}`, tag(r));
    return map;
  }

  async modulePrices(tx: Tx, country: Country, at: Date = new Date()) {
    const rows = await tx.query(
      `select distinct on (module, billing_interval) module, billing_interval, amount_minor, currency, valid_from
         from module_prices where country = $1 and active and valid_from <= $2
        order by module, billing_interval, valid_from desc`, [country, at]);
    const map = new Map<string, PriceTag>();
    for (const r of rows) map.set(`${r.module}:${r.billing_interval}`, tag(r));
    return map;
  }

  async publicPlans(tx: Tx, country: Country, interval: Interval, at: Date = new Date()): Promise<PublicPlansResponse> {
    const plans = await tx.query<PlanRow>(`select * from plans where is_public order by sort_order, id`);
    const modules = await tx.query<{ plan_id: string; module: ModuleKey }>(`select plan_id, module from plan_modules`);
    const prices = await this.planPrices(tx, country, at);
    const mprices = await this.modulePrices(tx, country, at);
    return {
      country,
      currency: COUNTRY_DEFAULTS[country].currency,
      interval,
      plans: plans.map((p) => ({
        id: p.id, name: p.name, nameAr: p.name_ar, description: p.description, descriptionAr: p.description_ar ?? null, isCustom: p.is_custom, sortOrder: p.sort_order,
        limits: p.limits ?? {},
        modules: sortModules(modules.filter((m) => m.plan_id === p.id).map((m) => m.module)),
        price: prices.get(`${p.id}:${interval}`) ?? null,
        prices: { month: prices.get(`${p.id}:month`) ?? null, year: prices.get(`${p.id}:year`) ?? null },
      })),
      modules: MODULE_KEYS.map((key) => ({
        key, name: MODULE_INFO[key].name, nameAr: MODULE_INFO[key].nameAr, description: MODULE_INFO[key].description,
        price: mprices.get(`${key}:${interval}`) ?? null,
        prices: { month: mprices.get(`${key}:month`) ?? null, year: mprices.get(`${key}:year`) ?? null },
      })),
      externalCostsNote: EXTERNAL_COSTS_NOTE,
      externalCostsNoteAr: EXTERNAL_COSTS_NOTE_AR,
    };
  }

  /**
   * Deterministic quote: the plan's base price plus one line per add-on module.
   * Add-ons already contained in the plan are listed as `included` at 0; `core`
   * is part of every plan. For the custom plan ("Build Your Resuto") the base
   * price covers Core and each chosen module is priced individually.
   */
  async quote(tx: Tx, input: QuoteInput, opts: { publicOnly?: boolean; at?: Date } = {}): Promise<PriceQuote> {
    const at = opts.at ?? new Date();
    const plan = await this.plan(tx, input.planId, { publicOnly: opts.publicOnly ?? true });
    if (!plan) throw invalid('unknown_plan', 'Choose an available plan');
    const included = await this.planModules(tx, plan.id);
    const prices = await this.planPrices(tx, input.country, at);
    const base = prices.get(`${plan.id}:${input.interval}`);
    if (!base) throw invalid('price_unavailable', `No ${input.interval}ly price is published for ${plan.name} in ${input.country}`);
    const mprices = await this.modulePrices(tx, input.country, at);
    const lines: PriceQuote['lines'] = [{ kind: 'plan', key: plan.id, amountMinor: base.amountMinor }];
    const addons = sortModules([...new Set(input.addons)].filter((m) => m !== 'core'));
    for (const m of addons) {
      if (included.includes(m)) { lines.push({ kind: 'module', key: m, amountMinor: 0, included: true }); continue; }
      const p = mprices.get(`${m}:${input.interval}`);
      if (!p) throw invalid('price_unavailable', `No ${input.interval}ly price is published for ${MODULE_INFO[m].name} in ${input.country}`);
      lines.push({ kind: 'module', key: m, amountMinor: p.amountMinor });
    }
    return {
      planId: plan.id, country: input.country, currency: COUNTRY_DEFAULTS[input.country].currency, interval: input.interval,
      lines,
      subtotalMinor: lines.reduce((n, l) => n + l.amountMinor, 0),
      modules: sortModules([...new Set<ModuleKey>(['core', ...included, ...addons])]),
      externalCostsNote: EXTERNAL_COSTS_NOTE,
      externalCostsNoteAr: EXTERNAL_COSTS_NOTE_AR,
    };
  }
}

export const sortModules = (mods: ModuleKey[]) => [...mods].sort((a, b) => MODULE_KEYS.indexOf(a) - MODULE_KEYS.indexOf(b));
