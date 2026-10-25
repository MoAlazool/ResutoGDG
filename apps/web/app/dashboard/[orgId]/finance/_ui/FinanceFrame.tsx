'use client';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { Field, PageHeader } from '@resuto/ui';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { SectionNav } from '@/components/shell/SectionNav';
import { money } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useBranchScope, useOrg } from '@/lib/org-context';
import { FINANCE_SECTIONS } from '@/lib/sections';

export interface Period { from: string; to: string; branchId: string }

const monthStart = () => { const d = new Date(); return new Date(Date.UTC(d.getFullYear(), d.getMonth(), 1)).toISOString().slice(0, 10); };
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Period from the URL (?from&to), defaulting to month to date; the branch is the shell's branch switcher (21-SHELL
 * single branch context, "All branches" supported).
 */
export function usePeriod(): Period & { query: string } {
  const sp = useSearchParams();
  const { branchId } = useBranchScope({ allowAll: true });
  const p = { from: sp.get('from') ?? monthStart(), to: sp.get('to') ?? today(), branchId };
  const query = new URLSearchParams({ from: p.from, to: p.to, ...(p.branchId ? { branchId: p.branchId } : {}) }).toString();
  return { ...p, query };
}

export function useMoney() {
  const { org } = useOrg();
  const { locale } = useT();
  return (v: number | null | undefined) => money(v, org.currency, locale);
}
export const pct = (bp: number | null | undefined) => (bp === null || bp === undefined ? '—' : `${(bp / 100).toFixed(1)}%`);

export function FinanceFrame({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  const { t } = useT();
  const router = useRouter();
  const pathname = usePathname();
  const period = usePeriod();
  const [draft, setDraft] = useState(period);
  const periodQuery = new URLSearchParams({ from: period.from, to: period.to }).toString();
  return (
    <ModuleGate module="finance" permission="finance:read">
      <PageHeader title={t('finance.title')} subtitle={t('finance.subtitle')} actions={actions} />
      <SectionNav sections={FINANCE_SECTIONS} label={t('finance.title')} query={periodQuery} />
      <form className="card" style={{ marginBottom: 16, paddingBottom: 8 }} onSubmit={(e) => {
        e.preventDefault();
        router.push(`${pathname}?${new URLSearchParams({ from: draft.from, to: draft.to })}`);
      }}>
        <div className="form-row items-end">
          <Field label={t('finance.period.from')} type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
          <Field label={t('finance.period.to')} type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
          <button className="btn" style={{ marginBottom: 14 }}>{t('finance.period.apply')}</button>
        </div>
      </form>
      {children}
    </ModuleGate>
  );
}
