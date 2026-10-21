-- DF-04 (review): only fee expenses that repeat what a payment provider already reports are left out of the P&L under
-- the provider-reports policy. An expense of kind "fees" is a provider settlement when the owner marks it so (for example
-- the monthly Paymob fee invoice whose per-payment fees Resuto already records). Other "fees" expenses (POS terminal
-- rental, bank charges) stay operating costs, and every expense keeps its cash/bank journal line.
--
-- Reversal: alter table public.expenses drop column provider_settlement;

alter table public.expenses add column provider_settlement boolean not null default false;
