-- DF-04: explicit accounting policy so the P&L never counts the same cost twice.
--   cogs_method 'item_cost' (default): COGS = recorded item costs of what was sold (recipes / product costs);
--     ingredient purchases recorded as "cogs" expenses are inventory purchases, shown as a memo line, not an expense.
--   cogs_method 'purchases': COGS = ingredient purchases ("cogs" expenses); item costs are shown as a memo only.
--   fees_method 'provider_reports' (default): payment fees = fees reported by the payment providers; "fees" expenses
--     are shown as a memo (they usually duplicate the provider's statement).
--   fees_method 'expenses': payment fees = "fees" expenses; provider-reported fees are a memo.
-- FT-23: provider payouts (money a payment provider settled to the bank) so journals can clear the clearing accounts.
--
-- Reversal: drop table public.finance_payouts, public.finance_settings;

create table public.finance_settings (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  cogs_method text not null default 'item_cost' check (cogs_method in ('item_cost', 'purchases')),
  fees_method text not null default 'provider_reports' check (fees_method in ('provider_reports', 'expenses')),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

create table public.finance_payouts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  provider text not null check (length(provider) between 1 and 40),
  -- Which clearing account the payout settles: card or wallet payments.
  clearing text not null default 'card' check (clearing in ('card', 'wallet')),
  paid_on date not null,
  amount_minor bigint not null check (amount_minor > 0),      -- deposited in the bank
  fee_minor bigint not null default 0 check (fee_minor >= 0),  -- deducted by the provider in this payout (if not already reported per payment)
  currency public.currency_code not null,
  reference text check (reference is null or length(reference) between 1 and 120),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index finance_payouts_org_date_idx on public.finance_payouts(org_id, paid_on);

select app.enable_tenant_rls('public.finance_settings');
select app.enable_tenant_rls('public.finance_payouts', 'branch_id');
select app.lockdown_public_grants();
