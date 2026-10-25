// Finance option lists for the finance pages without importing the full '@resuto/contracts' entry (it carries every
// schema and zod, about 44 kB on a route). Typed against the contracts and checked equal to them in kinds.test.ts.
import type { EXPENSE_KINDS as ContractExpenseKinds, EXPORT_KINDS as ContractExportKinds } from '@resuto/contracts';

export const EXPORT_KINDS = ['sales', 'payments', 'expenses', 'pnl', 'tax'] as const satisfies ReadonlyArray<(typeof ContractExportKinds)[number]>;
export const EXPENSE_KINDS = ['cogs', 'labor', 'rent', 'utilities', 'marketing', 'delivery', 'fees', 'maintenance', 'other'] as const satisfies ReadonlyArray<(typeof ContractExpenseKinds)[number]>;
