/**
 * The finance API explains data coverage in English sentences (P&L and overview "warnings"). These patterns turn the
 * known ones into dictionary keys so the Arabic UI never shows English; an unknown sentence is shown as it came.
 */
const PATTERNS: Array<[RegExp, string]> = [
  [/^(\d+) order\(s\) in this period are not fully paid/, 'finance.warn.unpaid'],
  [/^No orders in this period\.$/, 'finance.warn.noOrders'],
  [/^(\d+) sold line\(s\) have no recorded cost/, 'finance.warn.linesWithoutCost'],
  [/^Ingredient purchases recorded as COGS expenses are treated as inventory purchases/, 'finance.warn.purchasesMemo'],
  [/^Item costs of sales are shown as a memo under the purchases policy/, 'finance.warn.itemCostMemo'],
  [/^"Fees" expenses are shown as a memo under the provider-reports policy/, 'finance.warn.feeExpensesMemo'],
  [/^"Fees" expenses marked as provider settlements are shown as a memo/, 'finance.warn.settlementMemo'],
  [/^No accounting policy is chosen and no item costs are recorded/, 'finance.warn.derivedPolicy'],
  [/^Provider-reported payment fees are shown as a memo under the expenses policy/, 'finance.warn.providerFeesMemo'],
  [/^(\d+) provider payment\(s\) have no fee reported yet/, 'finance.warn.unknownFees'],
  [/^(\d+) sandbox \(test\) payment\(s\) are in this period/, 'finance.warn.testPayments'],
  [/^Organisation-wide expenses \(no branch\) are excluded/, 'finance.warn.branchOnly'],
];

/** The dictionary key and count for a known warning, or null. */
export function financeWarningKey(text: string): { key: string; n: number } | null {
  for (const [re, key] of PATTERNS) {
    const m = re.exec(text);
    if (m) return { key, n: m[1] ? Number(m[1]) : 0 };
  }
  return null;
}

export function financeWarningText(text: string, t: (key: string, vars?: Record<string, string | number>) => string): string {
  const k = financeWarningKey(text);
  return k ? t(k.key, { n: k.n }) : text;
}
