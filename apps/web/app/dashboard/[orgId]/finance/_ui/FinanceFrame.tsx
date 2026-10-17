'use client';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { Field, PageHeader, SelectField } from '@resuto/ui';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { money } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';

export interface Period { from: string; to: string; branchId: string }

const monthStart = () => { const d = new Date(); return new Date(Date.UTC(d.getFullYear(), d.getMonth(), 1)).toISOString().slice(0, 10); };
const today = () => new Date().toISOString().slice(0, 10);

/** Period from the URL (?from&to&branchId), defaulting to month to date. */
export function usePeriod(): Period & { query: string } {
  const sp = useSearchParams();
  const p = { from: sp.get('from') ?? monthStart(), to: sp.get('to') ?? today(), branchId: sp.get('branchId') ?? '' };
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
  const { t, locale } = useT();
  const { org } = useOrg();
  const router = useRouter();
  const pathname = usePathname();
  const period = usePeriod();
  const [draft, setDraft] = useState(period);
  const base = `/dashboard/${org.id}/finance`;
  const links = [['', 'finance.nav.overview'], ['/pnl', 'finance.nav.pnl'], ['/expenses', 'finance.nav.expenses'], ['/exports', 'finance.nav.exports']] as const;
  return (
    <ModuleGate module="finance" permission="finance:read">
      <PageHeader title={t('finance.title')} subtitle={t('finance.subtitle')} actions={actions} />
      <nav className="row" style={{ gap: 6, marginBottom: 16 }} aria-label={t('finance.title')}>
        {links.map(([href, label]) => {
          const active = href === '' ? pathname === base : pathname.startsWith(base + href);
          return <Link key={href} href={`${base}${href}?${period.query}`} className={`btn btn-sm btn-pill ${active ? 'btn-primary' : 'btn-ghost'}`} aria-current={active ? 'page' : undefined}>{t(label)}</Link>;
        })}
      </nav>
      <form className="card" style={{ marginBottom: 16, paddingBottom: 8 }} onSubmit={(e) => {
        e.preventDefault();
        router.push(`${pathname}?${new URLSearchParams({ from: draft.from, to: draft.to, ...(draft.branchId ? { branchId: draft.branchId } : {}) })}`);
      }}>
        <div className="form-row" style={{ alignItems: 'end' }}>
          <Field label={t('finance.period.from')} type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
          <Field label={t('finance.period.to')} type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
          <SelectField label={t('finance.period.branch')} value={draft.branchId} onChange={(e) => setDraft({ ...draft, branchId: e.target.value })}>
            <option value="">{t('finance.period.allBranches')}</option>
            {org.branches.map((b) => <option key={b.id} value={b.id}>{locale === 'ar' && b.nameAr ? b.nameAr : b.name}</option>)}
          </SelectField>
          <button className="btn" style={{ marginBottom: 14 }}>{t('finance.period.apply')}</button>
        </div>
      </form>
      {children}
    </ModuleGate>
  );
}
