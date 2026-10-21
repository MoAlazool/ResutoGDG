import type { FinancePolicy } from '@resuto/contracts';
import type { Tx } from '../../common/db/db.service';

/**
 * DF-04: the organisation's accounting policy, shared by the P&L and the accounting journals so both count each cost
 * once in the same way. Without a saved choice the default is item-cost COGS and provider-reported fees, except that a
 * restaurant which records ingredient purchases ("cogs" expenses) but no item costs at all gets the purchases method,
 * so its COGS is not silently zero (source 'derived', with a warning on the P&L).
 */
export async function loadFinancePolicy(tx: Tx, orgId: string): Promise<FinancePolicy> {
  const r = await tx.maybeOne<{ cogs_method: FinancePolicy['cogsMethod']; fees_method: FinancePolicy['feesMethod']; updated_at: Date }>(
    'select cogs_method, fees_method, updated_at from finance_settings where org_id = $1', [orgId]);
  if (r) return { cogsMethod: r.cogs_method, feesMethod: r.fees_method, updatedAt: new Date(r.updated_at).toISOString(), source: 'saved' };
  const { purchases, costs } = await tx.one<{ purchases: boolean; costs: boolean }>(
    `select exists (select 1 from expenses e join expense_categories c on c.id = e.category_id where e.org_id = $1 and c.kind = 'cogs') as purchases,
            exists (select 1 from order_lines l where l.org_id = $1 and l.cost_minor is not null) as costs`, [orgId]);
  const derived = purchases && !costs;
  return { cogsMethod: derived ? 'purchases' : 'item_cost', feesMethod: 'provider_reports', updatedAt: null, source: derived ? 'derived' : 'default' };
}
