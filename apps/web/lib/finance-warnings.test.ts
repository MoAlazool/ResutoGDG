import { describe, expect, it } from 'vitest';
import { dictionaries } from './i18n/messages';
import { financeWarningKey } from './finance-warnings';

// The exact sentences apps/api/src/modules/finance/finance.service.ts writes.
const API_WARNINGS = [
  '7 order(s) in this period are not fully paid; revenue counts them, collected amounts do not.',
  'No orders in this period.',
  '4 sold line(s) have no recorded cost; COGS is understated for those items.',
  'Ingredient purchases recorded as COGS expenses are treated as inventory purchases under the item-cost policy (memo line), not as an expense.',
  'Item costs of sales are shown as a memo under the purchases policy; COGS comes from ingredient purchases.',
  '"Fees" expenses are shown as a memo under the provider-reports policy, because provider statements already include them.',
  'Provider-reported payment fees are shown as a memo under the expenses policy.',
  '"Fees" expenses marked as provider settlements are shown as a memo under the provider-reports policy, because the provider-reported fees already include them.',
  'No accounting policy is chosen and no item costs are recorded, so COGS uses ingredient purchases ("cogs" expenses). Choose a policy under Finance → Accounting policy.',
  '2 provider payment(s) have no fee reported yet; run reconciliation to capture fees.',
  '17 sandbox (test) payment(s) are in this period.',
  'Organisation-wide expenses (no branch) are excluded from a single-branch P&L.',
];

describe('finance coverage warnings are localised', () => {
  it('maps every API sentence to a key present in both languages, with its count', () => {
    for (const w of API_WARNINGS) {
      const k = financeWarningKey(w);
      expect(k, w).not.toBeNull();
      expect(dictionaries.en[k!.key], k!.key).toBeTruthy();
      expect(dictionaries.ar[k!.key], k!.key).toBeTruthy();
    }
    expect(financeWarningKey(API_WARNINGS[0]!)!.n).toBe(7);
    expect(financeWarningKey('Something new')).toBeNull();
  });
});
