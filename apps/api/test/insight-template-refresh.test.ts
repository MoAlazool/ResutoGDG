// REM-A07: a stock episode opened before insight templates existed kept refreshing without one (the refresh updated
// params but not template_key), so the card stayed English-only for Arabic readers. The refresh now sets the template,
// and no insight a producer writes is left without one.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantContext } from '../src/common/auth/context';
import { InsightsService } from '../src/modules/intelligence/insights.service';
import { bootTestApp, createTenant, sql, type TestApp, type TestTenant } from './helpers';

let t: TestApp;
let tenant: TestTenant;

beforeAll(async () => {
  t = await bootTestApp();
  tenant = await createTenant(t, { country: 'EG' });
});
afterAll(async () => { await t.close(); });

describe('insight templates on refresh', () => {
  it('a legacy open stock episode gets its template when the breach is refreshed; nothing is stored without one', async () => {
    const [item] = await sql(`insert into inventory_items(org_id, name, name_ar, unit, reorder_level) values ($1, 'Beef patty', 'شريحة لحم', 'pcs', 40) returning id`, [tenant.orgId]);
    await sql(`insert into stock_levels(org_id, branch_id, item_id, quantity) values ($1, $2, $3, 5)`, [tenant.orgId, tenant.branchId, item.id]);
    const episode = `low_stock:${tenant.branchId}:${item.id}`;
    // Stored the way the producer did before 20261021020001: English text, no template.
    await sql(`insert into ai_insights(org_id, branch_id, kind, severity, title, body, evidence, method, episode_key)
               values ($1, $2, 'inventory', 'warning', 'Beef patty is below its reorder level', 'legacy', '{"rule":"inventory_below_reorder_level"}', 'deterministic', $3)`,
      [tenant.orgId, tenant.branchId, episode]);

    await t.app.get(InsightsService).generateForOrg(TenantContext.system(tenant.orgId, 'test'));

    const rows = await sql(`select template_key, template_params, refreshed_at from ai_insights where org_id = $1 and episode_key = $2`, [tenant.orgId, episode]);
    expect(rows).toHaveLength(1);
    expect(rows[0].refreshed_at).not.toBeNull();
    expect(rows[0].template_key).toBe('low_stock');
    expect(rows[0].template_params).toMatchObject({ item: { en: 'Beef patty', ar: 'شريحة لحم' }, quantity: 5, reorderLevel: 40, unit: 'pcs' });
    expect((await sql(`select count(*)::int as n from ai_insights where org_id = $1 and template_key is null`, [tenant.orgId]))[0].n).toBe(0);
  });
});
