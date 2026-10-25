// Where each finance figure comes from (21-MONEY, plan §2.7 honest metrics). The finance API computes everything from
// recorded orders, payments and expenses ("ledger"); a figure is "estimated" when the API says its inputs are
// incomplete (sold lines without a cost, a COGS policy derived rather than chosen, provider payments without a fee
// yet), "sandbox" when the restaurant's history is generated demo data, and "unavailable" when it did not load.
import type { ProfitAndLoss } from '@resuto/contracts';
import type { Provenance } from '@resuto/ui';

export interface FeesView { items: Array<{ provider: string; method: string; feesMinor: number; volumeMinor: number; unknownFee: number; test: number }>;
  totalFeesMinor: number; paymentsWithUnknownFee: number; testPayments: number }

/** Order and payment totals (gross, net, VAT, collected): recorded data. */
export function revenueProvenance(loaded: boolean, synthetic = false): Provenance {
  if (!loaded) return 'unavailable';
  return synthetic ? 'sandbox' : 'live';
}

/** Payment fees: estimated while provider payments still have no fee reported. */
export function feesProvenance(fees: Pick<FeesView, 'paymentsWithUnknownFee'> | null | undefined, synthetic = false): Provenance {
  if (!fees) return 'unavailable';
  if (synthetic) return 'sandbox';
  return fees.paymentsWithUnknownFee > 0 ? 'estimated' : 'live';
}

/** Profit lines (gross and operating profit, margins): estimated when the cost side is incomplete. */
export function profitProvenance(pnl: Pick<ProfitAndLoss, 'isSyntheticData' | 'coverage' | 'policy'> | null | undefined): Provenance {
  if (!pnl) return 'unavailable';
  if (pnl.isSyntheticData) return 'sandbox';
  const costed = pnl.policy.cogsMethod !== 'item_cost' || pnl.coverage.linesWithoutCost === 0;
  return costed && pnl.policy.source !== 'derived' && pnl.coverage.paymentsWithUnknownFee === 0 ? 'live' : 'estimated';
}
