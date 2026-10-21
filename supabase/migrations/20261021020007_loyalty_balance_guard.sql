-- FT-03 (review): no debit may take a loyalty balance below zero, whichever path writes it. The service re-checks under
-- the account row lock for redeem, negative adjust and expire rows; this constraint backs it in the database.
-- Exempt: reverse_earn (a refund after the points were spent can leave the customer owing points; the next earn
-- repays it) and the customer-merge pair (keys 'merge-out:' / 'merge-in:'), which moves a balance as it is.
--
-- Reversal: alter table public.loyalty_ledger drop constraint loyalty_ledger_no_negative_debit;

alter table public.loyalty_ledger add constraint loyalty_ledger_no_negative_debit
  check (kind not in ('redeem', 'adjust', 'expire') or points > 0 or balance_after >= 0 or idempotency_key like 'merge-%');
